'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { logger } from '@/lib/logger';

export type WebSocketStatus = 'connecting' | 'connected' | 'disconnected' | 'error';

interface UseWebSocketOptions<T> {
  url: string;
  onMessage?: (data: T) => void;
  onError?: (error: Event) => void;
  onConnect?: () => void;
  onDisconnect?: () => void;
  reconnect?: boolean;
  reconnectInterval?: number;
  reconnectAttempts?: number;
  parseMessage?: (data: string) => T;
}

interface UseWebSocketReturn<T> {
  status: WebSocketStatus;
  lastMessage: T | null;
  error: Event | null;
  reconnectCount: number;
  send: (data: string | object) => void;
  disconnect: () => void;
  connect: () => void;
}

export function useWebSocket<T = unknown>({
  url,
  onMessage,
  onError,
  onConnect,
  onDisconnect,
  reconnect = true,
  reconnectInterval = 3000,
  reconnectAttempts = 5,
  parseMessage = (data: string) => JSON.parse(data) as T,
}: UseWebSocketOptions<T>): UseWebSocketReturn<T> {
  const [status, setStatus] = useState<WebSocketStatus>('disconnected');
  const [lastMessage, setLastMessage] = useState<T | null>(null);
  const [error, setError] = useState<Event | null>(null);
  const [reconnectCount, setReconnectCount] = useState(0);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const manualDisconnect = useRef(false);

  const clearReconnectTimeout = useCallback(() => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
  }, []);

  const disconnect = useCallback(() => {
    manualDisconnect.current = true;
    clearReconnectTimeout();
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    setStatus('disconnected');
  }, [clearReconnectTimeout]);

  const connect = useCallback(() => {
    // Clean up existing connection
    if (wsRef.current) {
      wsRef.current.close();
    }
    clearReconnectTimeout();
    manualDisconnect.current = false;

    setStatus('connecting');
    logger.info('WebSocket', `Connecting to ${url}`);

    try {
      const ws = new WebSocket(url);

      ws.onopen = () => {
        logger.info('WebSocket', 'Connected', { url });
        setStatus('connected');
        setError(null);
        setReconnectCount(0);
        onConnect?.();
      };

      ws.onmessage = (event) => {
        try {
          const data = parseMessage(event.data);
          setLastMessage(data);
          onMessage?.(data);
        } catch (e) {
          logger.error('WebSocket', 'Failed to parse message', { error: String(e) });
        }
      };

      ws.onerror = (event) => {
        logger.error('WebSocket', 'Error occurred', { url });
        setError(event);
        setStatus('error');
        onError?.(event);
      };

      ws.onclose = () => {
        logger.info('WebSocket', 'Disconnected', { url, manualDisconnect: manualDisconnect.current });
        setStatus('disconnected');
        onDisconnect?.();

        // Attempt reconnection if enabled and not manually disconnected
        if (reconnect && !manualDisconnect.current && reconnectCount < reconnectAttempts) {
          const delay = reconnectInterval * Math.pow(1.5, reconnectCount); // Exponential backoff
          logger.info('WebSocket', `Reconnecting in ${delay}ms (attempt ${reconnectCount + 1}/${reconnectAttempts})`);

          reconnectTimeoutRef.current = setTimeout(() => {
            setReconnectCount(prev => prev + 1);
            connect();
          }, delay);
        }
      };

      wsRef.current = ws;
    } catch (e) {
      logger.error('WebSocket', 'Failed to create connection', { error: String(e) });
      setStatus('error');
    }
  }, [url, reconnect, reconnectInterval, reconnectAttempts, reconnectCount, onMessage, onError, onConnect, onDisconnect, parseMessage, clearReconnectTimeout]);

  const send = useCallback((data: string | object) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      const message = typeof data === 'string' ? data : JSON.stringify(data);
      wsRef.current.send(message);
    } else {
      logger.warn('WebSocket', 'Cannot send message - not connected');
    }
  }, []);

  // Connect on mount
  useEffect(() => {
    connect();

    return () => {
      manualDisconnect.current = true;
      clearReconnectTimeout();
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, [url]); // Only reconnect if URL changes

  return {
    status,
    lastMessage,
    error,
    reconnectCount,
    send,
    disconnect,
    connect,
  };
}

// Specialized hook for Binance WebSocket streams
export function useBinanceStream<T = unknown>(
  streams: string[],
  onMessage?: (data: T) => void
) {
  const url = streams.length > 0
    ? `wss://stream.binance.com:9443/stream?streams=${streams.join('/')}`
    : '';

  return useWebSocket<{ stream: string; data: T }>({
    url,
    onMessage: (msg) => {
      if (msg.data) {
        onMessage?.(msg.data);
      }
    },
    reconnect: true,
    reconnectAttempts: 10,
    reconnectInterval: 2000,
  });
}

export default useWebSocket;
