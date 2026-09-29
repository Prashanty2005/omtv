require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const twilio = require('twilio');
const { createClient } = require('redis');
const { createAdapter } = require('@socket.io/redis-adapter');

const app = express();
const server = http.createServer(app);

// TURN Server API
app.get('/api/turn', async (req, res) => {
  // Allow cross-origin requests for the frontend
  res.setHeader('Access-Control-Allow-Origin', process.env.FRONTEND_URL || '*');
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
    origin: process.env.FRONTEND_URL || "*", // In production, provide your Vercel URL here
    methods: ["GET", "POST"]
  }
});

// --- REDIS SETUP ---
const pubClient = createClient({ url: process.env.REDIS_URL });
const subClient = pubClient.duplicate();
const stateClient = pubClient.duplicate();

Promise.all([
  pubClient.connect(),
  subClient.connect(),
  stateClient.connect()
]).then(() => {
  io.adapter(createAdapter(pubClient, subClient));
  console.log("Redis clients connected and socket adapter attached.");
}).catch(err => {
  console.error("Redis connection error:", err);
});

// Concurrency note: In a true production environment with millions of users,
// we would use Redis Lua scripts or Redlock for atomic matchmaking.
// However, for this portfolio implementation, standard async/await Redis operations are sufficient.

io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);

  // ==========================================
  // 1. MATCHMAKING LOGIC (THE "NEXT" BUTTON)
  // ==========================================
  socket.on('find-partner', async (data) => {
    try {
      // 1. If the user is already in a conversation, remove them from it first
      const currentPartner = await stateClient.hGet('connected_peers', socket.id);
      if (currentPartner) {
        // Notify the partner that this user skipped
        io.to(currentPartner).emit('partner-disconnected');
        // Break the link
        await stateClient.hDel('connected_peers', socket.id);
        await stateClient.hDel('connected_peers', currentPartner);
      }

      // Also remove from waiting_queue if they hit Next while already searching
      const queueList = await stateClient.lRange('waiting_queue', 0, -1);
      for (const itemStr of queueList) {
        try {
          const item = JSON.parse(itemStr);
          if (item.socketId === socket.id) {
            await stateClient.lRem('waiting_queue', 0, itemStr);
          }
        } catch(e) {
          console.error("Error parsing waiting_queue item", e);
        }
      }

      const userInterests = (data && Array.isArray(data.interests)) ? data.interests : [];
      let matchedItemStr = null;
      let sharedInterests = [];
      let parsedPartnerItem = null;

      // 2. Fetch queue of waiting users to find a match
      const currentQueue = await stateClient.lRange('waiting_queue', 0, -1);

      // Try finding an interest match first
      if (userInterests.length > 0) {
        for (const itemStr of currentQueue) {
          try {
            const waiter = JSON.parse(itemStr);
            if (waiter.interests && waiter.interests.length > 0) {
              const common = waiter.interests.filter(i => userInterests.includes(i));
              if (common.length > 0) {
                matchedItemStr = itemStr;
                parsedPartnerItem = waiter;
                sharedInterests = common;
                break;
              }
            }
          } catch(e) {}
        }
      }

      // If no interest match, or user has no interests, fallback
      if (!matchedItemStr && currentQueue.length > 0) {
        // Find someone with NO interests
        for (const itemStr of currentQueue) {
          try {
             const waiter = JSON.parse(itemStr);
             if (!waiter.interests || waiter.interests.length === 0) {
                matchedItemStr = itemStr;
                parsedPartnerItem = waiter;
                break;
             }
          } catch(e) {}
        }

        // If everyone in the queue has interests but no match, just pick the first person
        if (!matchedItemStr) {
           matchedItemStr = currentQueue[0];
           parsedPartnerItem = JSON.parse(matchedItemStr);
        }
      }

      // 3. Process the match or add to queue
      if (matchedItemStr) {
        // Found a match! Try to remove them from the list atomically
        // LREM returns the number of removed elements
        const removedCount = await stateClient.lRem('waiting_queue', 1, matchedItemStr);
        
        if (removedCount > 0) {
          // Successfully claimed the match
          const partnerId = parsedPartnerItem.socketId;

          // Link them together in our Redis Hash
          await stateClient.hSet('connected_peers', socket.id, partnerId);
          await stateClient.hSet('connected_peers', partnerId, socket.id);

          console.log(`Matched! ${socket.id} is talking to ${partnerId}`);

          // Notify both users that they found a match.
          io.to(socket.id).emit('matched', { initiator: true, sharedInterests });
          io.to(partnerId).emit('matched', { initiator: false, sharedInterests });
        } else {
          // Someone else already matched with them, just push ourselves to queue
          const newItemStr = JSON.stringify({ socketId: socket.id, interests: userInterests });
          await stateClient.rPush('waiting_queue', newItemStr);
          console.log(`User ${socket.id} added to waiting queue with interests: ${userInterests}`);
        }
      } else {
        // No one is available to match. Add this user to the queue.
        const newItemStr = JSON.stringify({ socketId: socket.id, interests: userInterests });
        await stateClient.rPush('waiting_queue', newItemStr);
        console.log(`User ${socket.id} added to waiting queue with interests: ${userInterests}`);
      }

    } catch (error) {
      console.error('Matchmaking error:', error);
    }
  });

  // ==========================================
  // 2. PRIVATE SIGNALING (ROUTING WEBRTC DATA)
  // ==========================================
  // Instead of broadcasting to everyone, we look up the partner's ID in Redis.

  socket.on('offer', async (offer) => {
    try {
      const partnerId = await stateClient.hGet('connected_peers', socket.id);
      if (partnerId) {
        io.to(partnerId).emit('offer', offer);
      }
    } catch (error) {
       console.error("Signaling error (offer):", error);
    }
  });

  socket.on('answer', async (answer) => {
    try {
      const partnerId = await stateClient.hGet('connected_peers', socket.id);
      if (partnerId) {
        io.to(partnerId).emit('answer', answer);
      }
    } catch (error) {
       console.error("Signaling error (answer):", error);
    }
  });

  socket.on('candidate', async (candidate) => {
    try {
      const partnerId = await stateClient.hGet('connected_peers', socket.id);
      if (partnerId) {
        io.to(partnerId).emit('candidate', candidate);
      }
    } catch (error) {
       console.error("Signaling error (candidate):", error);
    }
  });

  // ==========================================
  // 3. HANDLING DISCONNECTIONS (CLOSING TAB)
  // ==========================================
  socket.on('disconnect', async () => {
    console.log(`User disconnected: ${socket.id}`);

    try {
      // Remove from queue if they were waiting
      const queueList = await stateClient.lRange('waiting_queue', 0, -1);
      for (const itemStr of queueList) {
        try {
          const item = JSON.parse(itemStr);
          if (item.socketId === socket.id) {
            await stateClient.lRem('waiting_queue', 0, itemStr);
          }
        } catch(e) {}
      }

      // If they were talking to someone, notify the partner
      const partnerId = await stateClient.hGet('connected_peers', socket.id);
      if (partnerId) {
        io.to(partnerId).emit('partner-disconnected');
        // Clean up the Redis Hash
        await stateClient.hDel('connected_peers', partnerId);
        await stateClient.hDel('connected_peers', socket.id);
      }
    } catch (error) {
      console.error('Disconnect error:', error);
    }
  });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`Signaling server running on port ${PORT}`);
});