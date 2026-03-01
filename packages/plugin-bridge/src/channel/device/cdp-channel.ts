import { isWeb } from '../../web.js';
import { Channel } from '../types.js';
import { UnsupportedPlatformError } from '../../errors.js';

export type CdpMessageListener = (message: unknown) => void;

export type CdpDomain = {
  name: string;
  sendMessage: (message: unknown) => void;
  onMessage: {
    addEventListener: (listener: CdpMessageListener) => void;
    removeEventListener: (listener: CdpMessageListener) => void;
  };
  close: () => void;
};

const DOMAIN_NAME = 'rozenite';

const initDomain = (): CdpDomain => {
  const dispatcher = global.__FUSEBOX_REACT_DEVTOOLS_DISPATCHER__;
  return dispatcher.initializeDomain(DOMAIN_NAME);
};

const getCdpDomainProxy = async (): Promise<Channel> => {
  const eventListeners = new Set<CdpMessageListener>();
  let instance: CdpDomain;

  try {
    instance = initDomain();
  } catch {
    // Domain initialization may fail if the dispatcher isn't ready yet.
    // Wait for it via onDomainInitialization event.
    instance = await new Promise((resolve) => {
      const dispatcher = global.__FUSEBOX_REACT_DEVTOOLS_DISPATCHER__;
      const handler = (domain: CdpDomain) => {
        if (domain.name === DOMAIN_NAME) {
          dispatcher.onDomainInitialization.removeEventListener(handler);
          // setTimeout required — without it the promise never resolves (Hermes bug?)
          setTimeout(() => resolve(domain));
        }
      };
      dispatcher.onDomainInitialization.addEventListener(handler);

      // Retry initialization periodically in case the dispatcher becomes ready later
      const pollId = setInterval(() => {
        try {
          const domain = initDomain();
          clearInterval(pollId);
          dispatcher.onDomainInitialization.removeEventListener(handler);
          setTimeout(() => resolve(domain));
        } catch {
          // Not ready yet, keep polling
        }
      }, 500);
    });
  }

  const getDomain = (): CdpDomain => instance;

  const reinitHandler = (domain: CdpDomain) => {
    if (domain.name === DOMAIN_NAME) {
      // Remove listeners from the old instance
      if (instance) {
        eventListeners.forEach((listener) => {
          instance.onMessage.removeEventListener(listener);
        });
      }

      instance = domain;

      // Re-attach listeners to the new instance
      eventListeners.forEach((listener) => {
        domain.onMessage.addEventListener(listener);
      });
    }
  };

  global.__FUSEBOX_REACT_DEVTOOLS_DISPATCHER__.onDomainInitialization.addEventListener(
    reinitHandler
  );

  const close = () => {
    global.__FUSEBOX_REACT_DEVTOOLS_DISPATCHER__.onDomainInitialization.removeEventListener(
      reinitHandler
    );
  };

  return {
    send: (message: unknown) => {
      getDomain().sendMessage(message);
    },
    onMessage(listener: CdpMessageListener) {
      // Promises creating in listeners behave in weird way when not wrapped in setTimeout.
      const delayedListener = (message: unknown) => {
        setTimeout(() => {
          listener(message);
        });
      };

      eventListeners.add(delayedListener);
      getDomain().onMessage.addEventListener(delayedListener);

      return {
        remove: () => {
          eventListeners.delete(delayedListener);
          getDomain().onMessage.removeEventListener(delayedListener);
        },
      };
    },
    close,
  };
};

export const getCdpChannel = async (): Promise<Channel> => {
  if (isWeb()) {
    throw new UnsupportedPlatformError('web');
  }

  return getCdpDomainProxy();
};
