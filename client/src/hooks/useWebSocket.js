import { useRef, useEffect, useCallback } from 'react';

export function useWebSocket({ onSearchResult, onSearchComplete, onSearchError }) {
  const wsRef = useRef(null);
  const callbacksRef = useRef({ onSearchResult, onSearchComplete, onSearchError });

  useEffect(() => {
    callbacksRef.current = { onSearchResult, onSearchComplete, onSearchError };
  });

  useEffect(() => {
    // Set on unmount so closing the socket doesn't schedule a reconnect.
    let disposed = false;
    let retryTimer = null;

    const connect = () => {
      const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${wsProtocol}//${window.location.host}`;
      const ws = new WebSocket(wsUrl);

      ws.onopen = () => console.log('Search WebSocket connected.');

      ws.onmessage = (event) => {
        const message = JSON.parse(event.data);
        const cbs = callbacksRef.current;
        switch (message.type) {
          case 'search_result':
            cbs.onSearchResult?.(message.data);
            break;
          case 'search_complete':
            cbs.onSearchComplete?.();
            break;
          case 'search_error':
            cbs.onSearchError?.(message.message);
            break;
        }
      };

      ws.onclose = () => {
        if (!disposed) retryTimer = setTimeout(connect, 3000);
      };

      ws.onerror = () => ws.close();

      wsRef.current = ws;
    };

    connect();
    return () => {
      disposed = true;
      clearTimeout(retryTimer);
      if (wsRef.current) wsRef.current.close();
    };
  }, []);

  const startSearch = useCallback((query, drive) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'start_search', query, drive }));
      return true;
    }
    return false;
  }, []);

  const stopSearch = useCallback(() => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'stop_search' }));
    }
  }, []);

  return { startSearch, stopSearch };
}
