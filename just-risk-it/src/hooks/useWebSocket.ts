import { useEffect, useRef, useState, useCallback } from 'react';

export interface GameUpdate {
  currentValue: number;
  bar: {
    open: number;
    high: number;
    low: number;
    close: number;
    time: {
      year: number;
      month: number;
      day: number;
    };
  };
  timestamp: number; // Unix timestamp in seconds
  gameState: number; // 1 = BETTING, 2 = RUNNING, 3 = CRASHED
  nextGameNoMoreBetsAt: number;
}

export interface StatusMessage {
  type: 'status';
  status: 'preparing_game' | 'prepared' | 'game_started' | 'revealed' | 'betting_open';
  roundId?: number;
  message?: string;
  serverSeed?: string;
  txHash?: string;
  bettingCloseTime?: number; // Unix timestamp when betting closes
}

export interface ChatMessage {
  type: 'chat_message';
  id: string;
  user: string;
  address: string;
  message: string;
  timestamp: number;
}

export interface StateSnapshot {
  type: 'state_snapshot';
  roundId: number | null;
  gameState: 'preparing' | 'betting' | 'prepared' | 'running' | 'ended';
  currentMultiplier: number;
  bettingCloseTime: number | null;
  latestUpdate: UpdateMessage | null;
  recentChatMessages?: ChatMessage[];
  recentRounds?: Array<{ roundId: number; multiplier: number }>;
}

export interface CashOutResponse {
  type: 'cash_out_response';
  success: boolean;
  roundId?: number;
  multiplier?: number;
  payout?: number;
  error?: string;
}

export interface UpdateMessage {
  type: 'update';
  currentValue: number;
  bar: GameUpdate['bar'];
  timestamp: number; // Unix timestamp in seconds
  gameState: number;
  nextGameNoMoreBetsAt: number;
}

type WebSocketMessage = StatusMessage | UpdateMessage | CashOutResponse | StateSnapshot | ChatMessage;

interface UseWebSocketOptions {
  url: string;
  onStatus?: (status: StatusMessage) => void;
  onUpdate?: (update: UpdateMessage) => void;
  onCashOutResponse?: (response: CashOutResponse) => void;
  onStateSnapshot?: (snapshot: StateSnapshot) => void;
  onChatMessage?: (message: ChatMessage) => void;
  onError?: (error: Event) => void;
  onOpen?: () => void;
  onClose?: () => void;
  reconnect?: boolean;
  maxRetries?: number;
  retryDelay?: number;
}

export function useWebSocket({
  url,
  onStatus,
  onUpdate,
  onCashOutResponse,
  onStateSnapshot,
  onChatMessage,
  onError,
  onOpen,
  onClose,
  reconnect = true,
  maxRetries = 30,
  retryDelay = 2000,
}: UseWebSocketOptions) {
  const [isConnected, setIsConnected] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<'disconnected' | 'connecting' | 'connected'>('disconnected');
  const wsRef = useRef<WebSocket | null>(null);
  const retryCountRef = useRef(0);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  
  // Store callbacks in refs to avoid recreating connect on every render
  const onStatusRef = useRef(onStatus);
  const onUpdateRef = useRef(onUpdate);
  const onCashOutResponseRef = useRef(onCashOutResponse);
  const onStateSnapshotRef = useRef(onStateSnapshot);
  const onChatMessageRef = useRef(onChatMessage);
  const onErrorRef = useRef(onError);
  const onOpenRef = useRef(onOpen);
  const onCloseRef = useRef(onClose);

  // Update refs when callbacks change
  useEffect(() => {
    onStatusRef.current = onStatus;
    onUpdateRef.current = onUpdate;
    onCashOutResponseRef.current = onCashOutResponse;
    onStateSnapshotRef.current = onStateSnapshot;
    onChatMessageRef.current = onChatMessage;
    onErrorRef.current = onError;
    onOpenRef.current = onOpen;
    onCloseRef.current = onClose;
  }, [onStatus, onUpdate, onCashOutResponse, onStateSnapshot, onChatMessage, onError, onOpen, onClose]);

  // Store connect function in ref to avoid circular dependency
  const connectRef = useRef<() => void>(() => {});

  const performConnect = useCallback(() => {
    // Prevent multiple connections
    if (wsRef.current?.readyState === WebSocket.OPEN || wsRef.current?.readyState === WebSocket.CONNECTING) {
      return;
    }

    // Clear any existing reconnect timeout
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }

    // Use setTimeout to defer setState call outside of effect
    setTimeout(() => {
      setConnectionStatus('connecting');
    }, 0);
    
    try {
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        setIsConnected(true);
        setConnectionStatus('connected');
        retryCountRef.current = 0;
        onOpenRef.current?.();
      };

      ws.onmessage = (event) => {
        try {
          const message: WebSocketMessage = JSON.parse(event.data);
          
          if (message.type === 'status') {
            onStatusRef.current?.(message as StatusMessage);
          } else if (message.type === 'update') {
            onUpdateRef.current?.(message as UpdateMessage);
          } else if (message.type === 'cash_out_response') {
            onCashOutResponseRef.current?.(message as CashOutResponse);
          } else if (message.type === 'state_snapshot') {
            onStateSnapshotRef.current?.(message as StateSnapshot);
          } else if (message.type === 'chat_message') {
            onChatMessageRef.current?.(message as ChatMessage);
          }
        } catch (error) {
          console.error('Error parsing WebSocket message:', error);
        }
      };

      ws.onerror = (error) => {
        onErrorRef.current?.(error);
      };

      ws.onclose = () => {
        setIsConnected(false);
        setConnectionStatus('disconnected');
        onCloseRef.current?.();

        // Only reconnect if we haven't exceeded max retries
        if (reconnect && retryCountRef.current < maxRetries) {
          retryCountRef.current++;
          reconnectTimeoutRef.current = setTimeout(() => {
            console.log(`Reconnecting... (attempt ${retryCountRef.current}/${maxRetries})`);
            connectRef.current();
          }, retryDelay);
        } else if (retryCountRef.current >= maxRetries) {
          console.error('Max reconnection attempts reached');
          // Stop trying to reconnect
          reconnectTimeoutRef.current = null;
        }
      };
    } catch (error) {
      console.error('Error creating WebSocket:', error);
      setTimeout(() => {
        setConnectionStatus('disconnected');
      }, 0);
    }
  }, [url, reconnect, maxRetries, retryDelay]);

  // Update connect ref when performConnect changes
  useEffect(() => {
    connectRef.current = performConnect;
  }, [performConnect]);

  // Establish WebSocket connection on mount
  // Establish WebSocket connection on mount without calling setState synchronously
  useEffect(() => {
    performConnect();

    return () => {
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [performConnect]);

  const disconnect = useCallback(() => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
    }
    wsRef.current?.close();
  }, []);

  const connect = useCallback(() => {
    performConnect();
  }, [performConnect]);

  const sendMessage = useCallback((message: Record<string, unknown>) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(message));
      return true;
    }
    return false;
  }, []);

  return {
    isConnected,
    connectionStatus,
    connect,
    disconnect,
    sendMessage,
  };
}

