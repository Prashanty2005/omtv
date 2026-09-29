import { useState, useCallback } from 'react';
import { io, Socket } from 'socket.io-client';

export type AppState = 'idle' | 'waiting' | 'connected';

export interface MatchedPayload {
  initiator: boolean;
  sharedInterests: string[];
}

export interface Message {
  sender: 'me' | 'stranger';
  text: string;
}

// Connect to the Node.js signaling server
const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:5001';
const socket: Socket = io(BACKEND_URL);

export function useSignaling() {
  const [appState, setAppState] = useState<AppState>('idle');
  const [sharedInterests, setSharedInterests] = useState<string[]>([]);

  const findPartner = useCallback((interests: string[]) => {
    setAppState('waiting');
    socket.emit('find-partner', { interests });
  }, []);

  const stopChat = useCallback(() => {
    setAppState('idle');
    // Emitting this while connected tells the server to skip us
    socket.emit('find-partner', { interests: [] });
  }, []);

  return {
    socket,
    appState,
    setAppState,
    sharedInterests,
    setSharedInterests,
    findPartner,
    stopChat
  };
}
