import { useState, useEffect, useRef } from 'react';
import { io, Socket } from 'socket.io-client';
import './App.css';

// --- TYPES & INTERFACES ---
type AppState = 'idle' | 'waiting' | 'connected';

interface MatchedPayload {
  initiator: boolean;
  sharedInterests: string[];
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
  const [isDarkMode, setIsDarkMode] = useState(true);
  const [isMicOn, setIsMicOn] = useState(true);
  const [isCamOn, setIsCamOn] = useState(true);

  // Custom Interests State
  const [interestsInput, setInterestsInput] = useState('');
  const [sharedInterests, setSharedInterests] = useState<string[]>([]);

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

      // Store our mutual interests
      if (data.sharedInterests) {
        setSharedInterests(data.sharedInterests);
      } else {
        setSharedInterests([]);
      }

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
  // HARDWARE TOGGLES (MIC & CAMERA)
  // ==========================================

  // Watch for changes to the Microphone state
  useEffect(() => {
    if (localStreamRef.current) {
      // Get the audio track from the stream
      const audioTracks = localStreamRef.current.getAudioTracks();
      if (audioTracks.length > 0) {
        // Enable or disable the track based on state
        audioTracks[0].enabled = isMicOn;
      }
    }
  }, [isMicOn]); // This runs every time isMicOn changes

  // Watch for changes to the Camera state
  useEffect(() => {
    if (localStreamRef.current) {
      // Get the video track from the stream
      const videoTracks = localStreamRef.current.getVideoTracks();
      if (videoTracks.length > 0) {
        // Enable or disable the track based on state
        videoTracks[0].enabled = isCamOn;
      }
    }
  }, [isCamOn]); // This runs every time isCamOn changes
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
    setSharedInterests([]);
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

    // Parse interests
    const parsedArray = interestsInput
      .split(',')
      .map(i => i.trim())
      .filter(i => i !== '');

    socket.emit('find-partner', { interests: parsedArray });
  };

  const stopChat = () => {
    cleanupConnection();
    setAppState('idle');
    // Emitting this while connected tells the server to skip us
    socket.emit('find-partner', { interests: [] });
  };

  // ==========================================
  // 5. RENDER UI
  // ==========================================
  return (
    <div className={`app-wrapper ${isDarkMode ? 'dark-theme' : 'light-theme'}`}>
      <div className="app-container glass">

        {/* HEADER */}
        <header className="app-header">
          <h1>OmTV <span className="live-badge">LIVE</span></h1>
          <div className="header-actions">
            {appState === 'connected' && <span className="timer">02:14</span>}
            <button className="icon-btn" onClick={() => setIsDarkMode(!isDarkMode)}>
              {isDarkMode ? '☀️' : '🌙'}
            </button>
          </div>
        </header>

        {/* INTERESTS BANNER */}
        {appState === 'connected' && (
          <div className="interests-banner slide-down">
            ✨ {sharedInterests && sharedInterests.length > 0
              ? `You both like: ${sharedInterests.join(', ')}`
              : 'Talking to a random stranger'}
          </div>
        )}

        {/* VIDEO GRID */}
        <div className={`video-grid ${appState === 'connected' ? 'connected-glow' : ''}`}>

          <div className="video-box local">
            <video ref={localVideoRef} autoPlay muted playsInline />
            <div className="video-overlay">
              <span className="label">You</span>
              <div className="media-controls">
                <button className={`icon-btn ${!isMicOn ? 'danger' : ''}`} onClick={() => setIsMicOn(!isMicOn)}>
                  {isMicOn ? '🎙️' : '🔇'}
                </button>
                <button className={`icon-btn ${!isCamOn ? 'danger' : ''}`} onClick={() => setIsCamOn(!isCamOn)}>
                  {isCamOn ? '📷' : '🚫'}
                </button>
              </div>
            </div>
          </div>

          <div className="video-box remote">
            {appState === 'waiting' && (
              <div className="status-overlay waiting">
                <div className="spinner"></div>
                <p>Searching the globe...</p>
              </div>
            )}
            {appState === 'idle' && (
              <div className="status-overlay idle">
                <p>Click Start to meet someone new</p>
              </div>
            )}
            <video ref={remoteVideoRef} autoPlay playsInline className={appState !== 'connected' ? 'blur' : ''} />
            <div className="video-overlay">
              <span className="label">
                Stranger
                {appState === 'connected' && <span className="status-dot green"></span>}
              </span>
              {appState === 'connected' && (
                <button className="icon-btn tooltip" data-tooltip="Fullscreen">⛶</button>
              )}
            </div>
          </div>
        </div>

        {/* MAIN CONTROLS */}
        <div className="main-controls">
          {appState === 'idle' && (
            <div className="interest-input-container">
              <input
                type="text"
                placeholder="Add interests (e.g. anime, coding)"
                value={interestsInput}
                onChange={(e) => setInterestsInput(e.target.value)}
                className="glass-input"
              />
              <button onClick={findPartner} className="btn primary pill pulse-hover">🚀 Start Chat</button>
            </div>
          )}

          {appState === 'waiting' && (
            <button disabled className="btn secondary pill loading">Searching...</button>
          )}

          {appState === 'connected' && (
            <div className="action-buttons">
              <button onClick={stopChat} className="btn danger pill shadow">⏹ Stop</button>
              <button onClick={findPartner} className="btn primary pill shadow">⏭ Next Stranger</button>
            </div>
          )}
        </div>

        {/* CHAT SECTION */}
        {appState === 'connected' && (
          <div className="chat-container glass slide-up">
            <div className="chat-header">
              <span>Live Chat</span>
              <button className="icon-btn text-sm" onClick={() => setMessages([])}>🗑️ Clear</button>
            </div>

            <div className="chat-messages">
              {messages.map((msg, index) => (
                <div key={index} className={`message-wrapper ${msg.sender}`}>
                  <div className={`message ${msg.sender} pop-in`}>
                    {msg.text}
                  </div>
                  <span className="timestamp">Now</span>
                </div>
              ))}
            </div>

            <form className="chat-input-area" onSubmit={sendMessage}>
              <button type="button" className="icon-btn emoji-btn">😀</button>
              <input
                type="text"
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                placeholder="Type a message..."
                className="glass-input"
              />
              <button type="submit" className="send-btn">➤</button>
            </form>
          </div>
        )}
      </div>
    </div>
  );
}

export default App;