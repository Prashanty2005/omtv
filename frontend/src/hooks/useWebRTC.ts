import { useState, useEffect, useRef, useCallback } from 'react';
import { Socket } from 'socket.io-client';
import type { AppState, MatchedPayload, Message } from './useSignaling';

const fetchIceServers = async (): Promise<RTCIceServer[]> => {
  try {
    const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:5001';
    const response = await fetch(`${BACKEND_URL}/api/turn`);
    if (!response.ok) {
      throw new Error(`Failed to fetch TURN servers: ${response.status}`);
    }
    return await response.json();
  } catch (error) {
    console.error("Error fetching ICE servers, using STUN fallback:", error);
    return [{ urls: 'stun:stun.l.google.com:19302' }];
  }
};

export function useWebRTC(
  socket: Socket,
  setAppState: React.Dispatch<React.SetStateAction<AppState>>,
  setSharedInterests: React.Dispatch<React.SetStateAction<string[]>>
) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isMicOn, setIsMicOn] = useState(true);
  const [isCamOn, setIsCamOn] = useState(true);

  // --- WEBRTC REFS ---
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const dataChannelRef = useRef<RTCDataChannel | null>(null);
  const pendingCandidates = useRef<RTCIceCandidateInit[]>([]);

  // ==========================================
  // 1. INITIALIZE CAMERA ON LOAD
  // ==========================================
  useEffect(() => {
    const startCamera = async () => {
      try {
        const stream: MediaStream = await navigator.mediaDevices.getUserMedia({
          video: true,
          audio: true
        });
        localStreamRef.current = stream;

        if (localVideoRef.current) {
          localVideoRef.current.srcObject = stream;
        }
      } catch (err) {
        console.error("Camera access denied:", err);
      }
    };

    startCamera();

    // Cleanup camera tracks when component unmounts
    return () => {
      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach(track => track.stop());
      }
    };
  }, []);

  // ==========================================
  // HARDWARE TOGGLES (MIC & CAMERA)
  // ==========================================
  useEffect(() => {
    if (localStreamRef.current) {
      const audioTracks = localStreamRef.current.getAudioTracks();
      if (audioTracks.length > 0) {
        audioTracks[0].enabled = isMicOn;
      }
    }
  }, [isMicOn]);

  useEffect(() => {
    if (localStreamRef.current) {
      const videoTracks = localStreamRef.current.getVideoTracks();
      if (videoTracks.length > 0) {
        videoTracks[0].enabled = isCamOn;
      }
    }
  }, [isCamOn]);

  const toggleMic = useCallback(() => setIsMicOn(prev => !prev), []);
  const toggleCam = useCallback(() => setIsCamOn(prev => !prev), []);

  // ==========================================
  // 2. WEBRTC HELPER FUNCTIONS
  // ==========================================
  const setupDataChannel = useCallback((dc: RTCDataChannel) => {
    dataChannelRef.current = dc;
    dc.onopen = () => console.log('Data channel opened');
    dc.onclose = () => console.log('Data channel closed');
    dc.onmessage = (event) => {
      setMessages((prev) => [...prev, { sender: 'stranger', text: event.data }]);
    };
  }, []);

  const createPeerConnection = useCallback(async (isInitiator: boolean) => {
    const iceServersList = await fetchIceServers();
    const pc = new RTCPeerConnection({ iceServers: iceServersList });
    peerConnectionRef.current = pc;

    if (isInitiator) {
      const dc = pc.createDataChannel('chat');
      setupDataChannel(dc);
    } else {
      pc.ondatachannel = (event) => {
        setupDataChannel(event.channel);
      };
    }

    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(track => {
        pc.addTrack(track, localStreamRef.current as MediaStream);
      });
    }

    pc.ontrack = (event: RTCTrackEvent) => {
      if (remoteVideoRef.current && event.streams[0]) {
        remoteVideoRef.current.srcObject = event.streams[0];
      }
    };

    pc.onicecandidate = (event: RTCPeerConnectionIceEvent) => {
      if (event.candidate) {
        socket.emit('candidate', event.candidate);
      }
    };
  }, [socket, setupDataChannel]);

  const cleanupConnection = useCallback(() => {
    if (dataChannelRef.current) {
      dataChannelRef.current.close();
      dataChannelRef.current = null;
    }
    if (peerConnectionRef.current) {
      peerConnectionRef.current.close();
      peerConnectionRef.current = null;
    }
    if (remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = null;
    }
    setMessages([]);
    setSharedInterests([]);
    pendingCandidates.current = [];
  }, [setSharedInterests]);

  const sendMessage = useCallback((chatInputText: string) => {
    if (!dataChannelRef.current) {
      alert("Chat connection is not established yet.");
      return;
    }

    if (dataChannelRef.current.readyState !== 'open') {
      alert(`Chat connection is ${dataChannelRef.current.readyState}. Please wait a moment for the connection to fully establish.`);
      console.warn("Data channel state:", dataChannelRef.current.readyState);
      return;
    }

    dataChannelRef.current.send(chatInputText);
    setMessages((prev) => [...prev, { sender: 'me', text: chatInputText }]);
  }, []);

  // ==========================================
  // 3. SOCKET.IO WEBRTC SIGNALING LISTENERS
  // ==========================================
  useEffect(() => {
    socket.on('matched', async (data: MatchedPayload) => {
      setAppState('connected');

      // Store our mutual interests
      if (data.sharedInterests) {
        setSharedInterests(data.sharedInterests);
      } else {
        setSharedInterests([]);
      }

      await createPeerConnection(data.initiator);

      if (data.initiator && peerConnectionRef.current) {
        try {
          const offer: RTCSessionDescriptionInit = await peerConnectionRef.current.createOffer();
          await peerConnectionRef.current.setLocalDescription(offer);
          socket.emit('offer', offer);
        } catch (err) {
          console.error("Error creating offer:", err);
        }
      }
    });

    socket.on('offer', async (offer: RTCSessionDescriptionInit) => {
      if (!peerConnectionRef.current) return;

      try {
        await peerConnectionRef.current.setRemoteDescription(offer);
        const answer: RTCSessionDescriptionInit = await peerConnectionRef.current.createAnswer();
        await peerConnectionRef.current.setLocalDescription(answer);
        socket.emit('answer', answer);

        // Process any buffered candidates
        pendingCandidates.current.forEach(async (c) => {
          try {
            await peerConnectionRef.current?.addIceCandidate(new RTCIceCandidate(c));
          } catch (err) {
            console.error("Error adding buffered ice candidate", err);
          }
        });
        pendingCandidates.current = [];
      } catch (err) {
        console.error("Error handling offer:", err);
      }
    });

    socket.on('answer', async (answer: RTCSessionDescriptionInit) => {
      if (peerConnectionRef.current) {
        try {
          await peerConnectionRef.current.setRemoteDescription(answer);

          // Process any buffered candidates
          pendingCandidates.current.forEach(async (c) => {
            try {
              await peerConnectionRef.current?.addIceCandidate(new RTCIceCandidate(c));
            } catch (err) {
              console.error("Error adding buffered ice candidate", err);
            }
          });
          pendingCandidates.current = [];
        } catch (err) {
          console.error("Error setting remote description from answer:", err);
        }
      }
    });

    socket.on('candidate', async (candidate: RTCIceCandidateInit) => {
      if (peerConnectionRef.current) {
        try {
          if (peerConnectionRef.current.remoteDescription) {
            await peerConnectionRef.current.addIceCandidate(new RTCIceCandidate(candidate));
          } else {
            pendingCandidates.current.push(candidate);
          }
        } catch (err) {
          console.error("Error adding received ice candidate", err);
        }
      }
    });

    socket.on('partner-disconnected', () => {
      cleanupConnection();
      setAppState('idle');
      alert("Stranger disconnected.");
    });

    return () => {
      socket.off('matched');
      socket.off('offer');
      socket.off('answer');
      socket.off('candidate');
      socket.off('partner-disconnected');
    };
  }, [socket, setAppState, setSharedInterests, createPeerConnection, cleanupConnection]);

  return {
    localVideoRef,
    remoteVideoRef,
    messages,
    setMessages,
    isMicOn,
    toggleMic,
    isCamOn,
    toggleCam,
    sendMessage,
    cleanupConnection
  };
}
