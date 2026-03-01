import { useEffect, useRef, useSyncExternalStore } from 'react';
import type { DevToolsPluginMessage } from '@rozenite/mcp-shared';

type Subscription = {
  remove: () => void;
};

type MessageListener = (payload: unknown) => void;

export type DirectWebSocketClient<
  TEventMap extends Record<string, unknown> = Record<string, unknown>
> = {
  send: <TType extends keyof TEventMap>(
    type: TType,
    payload: TEventMap[TType]
  ) => void;
  onMessage: <TType extends keyof TEventMap>(
    type: TType,
    listener: (payload: TEventMap[TType]) => void
  ) => Subscription;
  close: () => void;
};

const WS_PATH = '/rozenite-mcp';
const DEFAULT_PORT = 8081;

// ── Shared singleton connection ────────────────────────────────────────

interface SharedConnection {
  ws: WebSocket | null;
  pluginId: string;
  deviceId: string;
  listeners: Map<string, Set<MessageListener>>;
  storeListeners: Set<() => void>;
  refCount: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  backoff: number;
  client: DirectWebSocketClient<Record<string, unknown>> | null;
}

const connections = new Map<string, SharedConnection>();

function createClient(conn: SharedConnection): DirectWebSocketClient<Record<string, unknown>> {
  return {
    send: (type, payload) => {
      if (conn.ws && conn.ws.readyState === WebSocket.OPEN) {
        const message: DevToolsPluginMessage = {
          pluginId: conn.pluginId,
          type: type as string,
          payload,
        };
        conn.ws.send(JSON.stringify(message));
      }
    },
    onMessage: (type, listener) => {
      const key = type as string;
      const typeListeners = conn.listeners.get(key) ?? new Set();
      typeListeners.add(listener as MessageListener);
      conn.listeners.set(key, typeListeners);
      return {
        remove: () => typeListeners.delete(listener as MessageListener),
      };
    },
    close: () => { /* no-op: connection is shared */ },
  };
}

function getOrCreateConnection(pluginId: string): SharedConnection {
  let conn = connections.get(pluginId);
  if (conn) {
    conn.refCount++;
    return conn;
  }

  conn = {
    ws: null,
    pluginId,
    deviceId: `device-${Math.random().toString(36).substring(2, 11)}`,
    listeners: new Map(),
    storeListeners: new Set(),
    refCount: 1,
    reconnectTimer: null,
    backoff: 1000,
    client: null,
  };
  connections.set(pluginId, conn);
  connectWebSocket(conn);
  return conn;
}

function releaseConnection(pluginId: string): void {
  const conn = connections.get(pluginId);
  if (!conn) return;

  conn.refCount--;
  if (conn.refCount <= 0) {
    if (conn.reconnectTimer) clearTimeout(conn.reconnectTimer);
    if (conn.ws) conn.ws.close();
    conn.listeners.clear();
    conn.storeListeners.clear();
    conn.client = null;
    connections.delete(pluginId);
  }
}

function notifyStoreListeners(conn: SharedConnection): void {
  conn.storeListeners.forEach((listener) => listener());
}

function connectWebSocket(conn: SharedConnection): void {
  const url = `ws://localhost:${DEFAULT_PORT}${WS_PATH}`;
  const ws = new WebSocket(url);
  conn.ws = ws;

  ws.onopen = () => {
    conn.backoff = 1000;

    // Send device/connect handshake
    ws.send(JSON.stringify({
      type: 'device/connect',
      deviceId: conn.deviceId,
      deviceName: 'React Native (MCP Bridge)',
    }));

    // Create a stable client reference for this connection
    conn.client = createClient(conn);
    notifyStoreListeners(conn);
  };

  ws.onmessage = (event: MessageEvent) => {
    try {
      const message = JSON.parse(
        typeof event.data === 'string' ? event.data : String(event.data)
      ) as DevToolsPluginMessage;

      if (message.pluginId !== conn.pluginId) return;

      const typeListeners = conn.listeners.get(message.type);
      if (typeListeners) {
        typeListeners.forEach((listener) => listener(message.payload));
      }
    } catch {
      // Ignore malformed messages
    }
  };

  ws.onclose = () => {
    conn.ws = null;
    conn.client = null;
    notifyStoreListeners(conn);

    // Reconnect if still referenced
    if (conn.refCount > 0) {
      conn.reconnectTimer = setTimeout(() => {
        if (conn.refCount > 0) {
          connectWebSocket(conn);
          conn.backoff = Math.min(conn.backoff * 2, 10000);
        }
      }, conn.backoff);
    }
  };

  ws.onerror = () => {
    // onclose fires after onerror — reconnection handled there
  };
}

// ── React hook ─────────────────────────────────────────────────────────

export function useDirectWebSocketClient<
  TEventMap extends Record<string, unknown> = Record<string, unknown>
>({ pluginId }: { pluginId: string }): DirectWebSocketClient<TEventMap> | null {

  const connRef = useRef<SharedConnection | null>(null);

  // Manage connection lifecycle (ref-counted)
  useEffect(() => {
    const conn = getOrCreateConnection(pluginId);
    connRef.current = conn;
    return () => {
      connRef.current = null;
      releaseConnection(pluginId);
    };
  }, [pluginId]);

  // Subscribe to connection state changes and return the stable client ref
  return useSyncExternalStore(
    (onStoreChange) => {
      const conn = connRef.current ?? connections.get(pluginId);
      if (!conn) return () => {};
      conn.storeListeners.add(onStoreChange);
      return () => { conn.storeListeners.delete(onStoreChange); };
    },
    () => {
      const conn = connRef.current ?? connections.get(pluginId);
      return (conn?.client ?? null) as DirectWebSocketClient<TEventMap> | null;
    },
  );
}
