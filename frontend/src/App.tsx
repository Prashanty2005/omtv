import { useState } from 'react';
import './App.css';
import { useSignaling } from './hooks/useSignaling';
import { useWebRTC } from './hooks/useWebRTC';

function App() {
  const {
    socket,
    appState,
    setAppState,
    sharedInterests,
    setSharedInterests,
    findPartner,
    stopChat
  } = useSignaling();

  const {
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
  } = useWebRTC(socket, setAppState, setSharedInterests);

  const [chatInput, setChatInput] = useState('');
  const [isDarkMode, setIsDarkMode] = useState(true);
  const [interestsInput, setInterestsInput] = useState('');

  const handleSendMessage = (e: React.FormEvent) => {
    e.preventDefault();
    if (!chatInput.trim()) return;
    sendMessage(chatInput);
    setChatInput('');
  };

  const handleFindPartner = () => {
    cleanupConnection();
    const parsedArray = interestsInput
      .split(',')
      .map(i => i.trim())
      .filter(i => i !== '');
    findPartner(parsedArray);
  };

  const handleStopChat = () => {
    cleanupConnection();
    stopChat();
  };

  // ==========================================
  // RENDER UI
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
                <button className={`icon-btn ${!isMicOn ? 'danger' : ''}`} onClick={toggleMic}>
                  {isMicOn ? '🎙️' : '🔇'}
                </button>
                <button className={`icon-btn ${!isCamOn ? 'danger' : ''}`} onClick={toggleCam}>
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
              <button onClick={handleFindPartner} className="btn primary pill pulse-hover">🚀 Start Chat</button>
            </div>
          )}

          {appState === 'waiting' && (
            <button disabled className="btn secondary pill loading">Searching...</button>
          )}

          {appState === 'connected' && (
            <div className="action-buttons">
              <button onClick={handleStopChat} className="btn danger pill shadow">⏹ Stop</button>
              <button onClick={handleFindPartner} className="btn primary pill shadow">⏭ Next Stranger</button>
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

            <form className="chat-input-area" onSubmit={handleSendMessage}>
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