const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const twilio = require('twilio');

const app = express();
const server = http.createServer(app);

// TURN Server API
app.get('/api/turn', async (req, res) => {
  // Allow cross-origin requests for the frontend
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    const token = await client.tokens.create({ ttl: 3600 });
    res.json(token.iceServers);
  } catch (error) {
    console.error("Error generating TURN token:", error);
    res.status(500).json({ error: "Failed to generate TURN token" });
  }
});

// Enable CORS so your future React frontend can connect to this server
const io = new Server(server, {
  cors: {
    origin: "*", // In production, change this to your React app's URL
    methods: ["GET", "POST"]
  }
});

// --- STATE MANAGEMENT ---
// This array holds the users waiting for a match
// Format: { socketId: 'abc', interests: ['coding', 'music'] }
let waitingQueue = [];

// This dictionary keeps track of who is talking to whom.
// Format: { 'userA_id': 'userB_id', 'userB_id': 'userA_id' }
const connectedPeers = {};

io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);

  // ==========================================
  // 1. MATCHMAKING LOGIC (THE "NEXT" BUTTON)
  // ==========================================
  socket.on('find-partner', (data) => {
    // If the user is already in a conversation, remove them from it first
    if (connectedPeers[socket.id]) {
      const currentPartner = connectedPeers[socket.id];
      // Notify the partner that this user skipped
      io.to(currentPartner).emit('partner-disconnected');
      // Break the link
      delete connectedPeers[socket.id];
      delete connectedPeers[currentPartner];
    }

    // Also remove from waitingQueue if they hit Next while already searching
    waitingQueue = waitingQueue.filter(user => user.socketId !== socket.id);

    const userInterests = (data && Array.isArray(data.interests)) ? data.interests : [];
    let matchIndex = -1;
    let sharedInterests = [];

    // 1. Try finding an interest match first
    if (userInterests.length > 0) {
      matchIndex = waitingQueue.findIndex(waiter => {
        if (!waiter.interests || waiter.interests.length === 0) return false;
        const common = waiter.interests.filter(i => userInterests.includes(i));
        if (common.length > 0) {
          sharedInterests = common;
          return true;
        }
        return false;
      });
    }

    // 2. If no interest match, or user has no interests, fallback
    if (matchIndex === -1 && waitingQueue.length > 0) {
      // Find someone with NO interests
      matchIndex = waitingQueue.findIndex(waiter => !waiter.interests || waiter.interests.length === 0);

      // If everyone in the queue has interests but no match, just pick the first person
      if (matchIndex === -1) {
        matchIndex = 0;
      }
    }

    // 3. Process the match or add to queue
    if (matchIndex !== -1) {
      // Found a match!
      const matchedPartner = waitingQueue.splice(matchIndex, 1)[0];
      const partnerId = matchedPartner.socketId;

      // Link them together in our dictionary
      connectedPeers[socket.id] = partnerId;
      connectedPeers[partnerId] = socket.id;

      console.log(`Matched! ${socket.id} is talking to ${partnerId}`);

      // Notify both users that they found a match.
      io.to(socket.id).emit('matched', { initiator: true, sharedInterests });
      io.to(partnerId).emit('matched', { initiator: false, sharedInterests });
    } else {
      // No one is available to match. Add this user to the queue.
      waitingQueue.push({ socketId: socket.id, interests: userInterests });
      console.log(`User ${socket.id} added to waiting queue with interests: ${userInterests}`);
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
    waitingQueue = waitingQueue.filter(user => user.socketId !== socket.id);

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