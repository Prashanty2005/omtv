const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

// Enable CORS so your future React frontend can connect to this server
const io = new Server(server, {
  cors: {
    origin: "*", // In production, change this to your React app's URL
    methods: ["GET", "POST"]
  }
});

// --- STATE MANAGEMENT ---
// This array holds the socket IDs of users waiting for a match
let waitingQueue = []; 

// This dictionary keeps track of who is talking to whom.
// Format: { 'userA_id': 'userB_id', 'userB_id': 'userA_id' }
const connectedPeers = {}; 

io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);

  // ==========================================
  // 1. MATCHMAKING LOGIC (THE "NEXT" BUTTON)
  // ==========================================
  socket.on('find-partner', () => {
    // If the user is already in a conversation, remove them from it first
    if (connectedPeers[socket.id]) {
      const currentPartner = connectedPeers[socket.id];
      // Notify the partner that this user skipped
      io.to(currentPartner).emit('partner-disconnected'); 
      // Break the link
      delete connectedPeers[socket.id];
      delete connectedPeers[currentPartner];
    }

    // Is there someone waiting in the queue?
    if (waitingQueue.length > 0) {
      // Yes! Remove the first person from the queue
      const partnerId = waitingQueue.shift();

      // Make sure we aren't matching the user with themselves
      if (partnerId !== socket.id) {
        // Link them together in our dictionary
        connectedPeers[socket.id] = partnerId;
        connectedPeers[partnerId] = socket.id;

        console.log(`Matched! ${socket.id} is talking to ${partnerId}`);

        // Notify both users that they found a match.
        // We tell User A to act as the "Caller" (create the WebRTC Offer)
        io.to(socket.id).emit('matched', { initiator: true });
        // We tell User B to wait for the Offer
        io.to(partnerId).emit('matched', { initiator: false });
      }
    } else {
      // No one is waiting. Add this user to the queue.
      if (!waitingQueue.includes(socket.id)) {
        waitingQueue.push(socket.id);
        console.log(`User ${socket.id} added to waiting queue.`);
      }
    }
  });

  // ==========================================
  // 2. PRIVATE SIGNALING (ROUTING WEBRTC DATA)
  // ==========================================
  // Instead of broadcasting to everyone, we look up the partner's ID and send it ONLY to them.

  socket.on('offer', (offer) => {
    const partnerId = connectedPeers[socket.id];
    if (partnerId) {
      io.to(partnerId).emit('offer', offer);
    }
  });

  socket.on('answer', (answer) => {
    const partnerId = connectedPeers[socket.id];
    if (partnerId) {
      io.to(partnerId).emit('answer', answer);
    }
  });

  socket.on('candidate', (candidate) => {
    const partnerId = connectedPeers[socket.id];
    if (partnerId) {
      io.to(partnerId).emit('candidate', candidate);
    }
  });

  // ==========================================
  // 3. HANDLING DISCONNECTIONS (CLOSING TAB)
  // ==========================================
  socket.on('disconnect', () => {
    console.log(`User disconnected: ${socket.id}`);

    // Remove from queue if they were waiting
    waitingQueue = waitingQueue.filter(id => id !== socket.id);

    // If they were talking to someone, notify the partner
    const partnerId = connectedPeers[socket.id];
    if (partnerId) {
      io.to(partnerId).emit('partner-disconnected');
      // Clean up the dictionary
      delete connectedPeers[partnerId];
      delete connectedPeers[socket.id];
    }
  });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`Signaling server running on port ${PORT}`);
});