import { useState, useEffect, useRef } from 'react';
import { io, Socket } from 'socket.io-client';
import './App.css';

// --- TYPES & INTERFACES ---
type AppState = 'idle' | 'waiting' | 'connected';

interface MatchedPayload {
  initiator: boolean;
}

interface Message {
  sender: 'me' | 'stranger';
  text: string;
}

// Connect to the Node.js signaling server
const socket: Socket = io('http://localhost:5000'); 

const iceServers: RTCConfiguration = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' } // Use public STUN server for ICE
  ]
};

function App() {
  // --- UI STATE ---
  const [appState, setAppState] = useState<AppState>('idle'); 
  const [messages, setMessages] = useState<Message[]>([]);
  const [chatInput, setChatInput] = useState('');

  // --- WEBRTC REFS ---
  // Strongly typing our refs to HTML elements and WebRTC interfaces
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
  // 2. SOCKET.IO SIGNALING LISTENERS
  // ==========================================
  useEffect(() => {
    // --- WE ARE MATCHED! ---
    socket.on('matched', async (data: MatchedPayload) => {
      setAppState('connected');
      createPeerConnection(data.initiator);

      // If the server told us we are the initiator, we create the Offer
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

    // --- RECEIVE OFFER ---
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

    // --- RECEIVE ANSWER ---
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

    // --- RECEIVE ICE CANDIDATE ---
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

    // --- PARTNER DISCONNECTED / SKIPPED ---
    socket.on('partner-disconnected', () => {
      cleanupConnection();
      setAppState('idle');
      alert("Stranger disconnected.");
    });

    // Cleanup listeners on unmount
    return () => {
      socket.off('matched');
      socket.off('offer');
      socket.off('answer');
      socket.off('candidate');
      socket.off('partner-disconnected');
    };
  }, []);

  // ==========================================
  // 3. WEBRTC HELPER FUNCTIONS
  // ==========================================
  const setupDataChannel = (dc: RTCDataChannel) => {
    dataChannelRef.current = dc;
    dc.onopen = () => console.log('Data channel opened');
    dc.onclose = () => console.log('Data channel closed');
    dc.onmessage = (event) => {
      setMessages((prev) => [...prev, { sender: 'stranger', text: event.data }]);
    };
  };

  const createPeerConnection = (isInitiator: boolean) => {
    const pc = new RTCPeerConnection(iceServers);
    peerConnectionRef.current = pc;

    if (isInitiator) {
      const dc = pc.createDataChannel('chat');
      setupDataChannel(dc);
    } else {
      pc.ondatachannel = (event) => {
        setupDataChannel(event.channel);
      };
    }

    // Add our camera tracks to the connection
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(track => {
        // Assert localStreamRef.current is not null here for TS
        pc.addTrack(track, localStreamRef.current as MediaStream);
      });
    }

    // When we get the stranger's video, attach it to the remote video tag
    pc.ontrack = (event: RTCTrackEvent) => {
      if (remoteVideoRef.current && event.streams[0]) {
        remoteVideoRef.current.srcObject = event.streams[0];
      }
    };

    // Send our network routes to the stranger
    pc.onicecandidate = (event: RTCPeerConnectionIceEvent) => {
      if (event.candidate) {
        socket.emit('candidate', event.candidate);
      }
    };
  };

  const cleanupConnection = () => {
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
    pendingCandidates.current = [];
  };

  const sendMessage = (e: React.FormEvent) => {
    e.preventDefault();
    if (!chatInput.trim()) return;

    if (!dataChannelRef.current) {
      alert("Chat connection is not established yet.");
      return;
    }

    if (dataChannelRef.current.readyState !== 'open') {
      alert(`Chat connection is ${dataChannelRef.current.readyState}. Please wait a moment for the connection to fully establish.`);
      console.warn("Data channel state:", dataChannelRef.current.readyState);
      return;
    }

    dataChannelRef.current.send(chatInput);
    setMessages((prev) => [...prev, { sender: 'me', text: chatInput }]);
    setChatInput('');
  };

  // ==========================================
  // 4. BUTTON ACTIONS
  // ==========================================
  const findPartner = () => {
    cleanupConnection(); // Clear any old connection just in case
    setAppState('waiting');
    socket.emit('find-partner');
  };

  const stopChat = () => {
    cleanupConnection();
    setAppState('idle');
    // Emitting this while connected tells the server to skip us
    socket.emit('find-partner'); 
  };

  // ==========================================
  // 5. RENDER UI
  // ==========================================
  return (
    <div className="app-container">
      <h1>Omegle Clone</h1>
      
      <div className="video-grid">
        <div className="video-box local">
          <video ref={localVideoRef} autoPlay muted playsInline />
          <span className="label">You</span>
        </div>
        
        <div className="video-box remote">
          {appState === 'waiting' && <div className="overlay-text">Looking for someone...</div>}
          {appState === 'idle' && <div className="overlay-text">Click Start to find a stranger</div>}
          <video ref={remoteVideoRef} autoPlay playsInline />
          <span className="label">Stranger</span>
        </div>
      </div>

      <div className="controls">
        {appState === 'idle' && (
          <button onClick={findPartner} className="btn-start">Start Chat</button>
        )}
        
        {appState === 'waiting' && (
          <button disabled className="btn-waiting">Searching...</button>
        )}

        {appState === 'connected' && (
          <>
            <button onClick={stopChat} className="btn-stop">Stop</button>
            <button onClick={findPartner} className="btn-next">Next Stranger</button>
          </>
        )}
      </div>

      {appState === 'connected' && (
        <div className="chat-container">
          <div className="chat-messages">
            {messages.map((msg, index) => (
              <div key={index} className={`message ${msg.sender}`}>
                {msg.text}
              </div>
            ))}
          </div>
          <form className="chat-input-area" onSubmit={sendMessage}>
            <input 
              type="text" 
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              placeholder="Type a message..."
            />
            <button type="submit">Send</button>
          </form>
        </div>
      )}
    </div>
  );
}

export default App;