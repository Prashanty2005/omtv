<div align="center">
  <h1>📺 Omtv</h1>
  <p><strong>A Modern, Horizontally Scalable Omegle Clone</strong></p>
  
  [![React](https://img.shields.io/badge/React-20232A?style=for-the-badge&logo=react&logoColor=61DAFB)](#)
  [![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?style=for-the-badge&logo=typescript&logoColor=white)](#)
  [![Node.js](https://img.shields.io/badge/Node.js-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)](#)
  [![Express.js](https://img.shields.io/badge/Express.js-000000?style=for-the-badge&logo=express&logoColor=white)](#)
  [![Socket.io](https://img.shields.io/badge/Socket.io-010101?style=for-the-badge&logo=socketdotio&logoColor=white)](#)
  [![WebRTC](https://img.shields.io/badge/WebRTC-333333?style=for-the-badge&logo=webrtc&logoColor=white)](#)
  [![Redis](https://img.shields.io/badge/Redis-DC382D?style=for-the-badge&logo=redis&logoColor=white)](#)
  [![Twilio](https://img.shields.io/badge/Twilio-F22F46?style=for-the-badge&logo=twilio&logoColor=white)](#)
</div>

<hr>

## 🚀 What is Omtv?

**Omtv** is a feature-rich, high-performance random video and text chatting application built to emulate the core functionality of Omegle. Utilizing **WebRTC** for real-time peer-to-peer media streaming and **Socket.io** for low-latency signaling, the app connects strangers across the globe instantly. 

Omtv is designed to be **horizontally scalable** from day one. By using **Redis** to maintain the matchmaking queue and active connection state, the backend can safely be distributed across multiple server instances without state desynchronization.

## ✨ Key Features

- **P2P Video & Audio Calling:** Direct, high-quality peer-to-peer media streaming powered by WebRTC.
- **Zero-Latency Text Chat:** Integrated WebRTC `RTCDataChannel` allows users to text instantly without routing messages through the central server.
- **Interest-Based Matchmaking:** Connects users based on shared topics/interests before falling back to a completely random queue.
- **Secure TURN API Integration:** Uses Twilio's reliable STUN/TURN servers to guarantee connection establishment across restrictive firewalls and NATs.
- **Horizontally Scalable State:** Redis adapter integration moves state (like waiting queues and connected peers) out of Node's memory, permitting multi-instance clustering.
- **Glassmorphism UI:** A sleek, modern, and engaging user interface built with advanced CSS techniques for a premium look and feel.

## 🏗️ Architecture & Workflow

### The "Two Restaurants" Analogy (Redis & Horizontal Scaling)
Imagine the application as a restaurant chain. If user queue state was held in standard local server memory (like `let waitingQueue = []`), it's like a receptionist holding a paper list at a single restaurant. If a user connects to "Restaurant A" and their perfect match connects to "Restaurant B", they will never meet because the receptionists don't talk to each other.

By introducing **Redis**, we've replaced the paper lists with a **centralized, synchronized digital cloud list**. No matter which Node.js instance (Restaurant A, B, or C) a user connects to via Socket.io, the server queries the shared Redis database. This ensures matchmaking is instant, seamless, and completely cluster-safe.

### Matchmaking & WebRTC Signaling Flow
1. **Connection:** Client connects to the backend via WebSocket (`Socket.io`).
2. **Matchmaking:** The user is added to a Redis queue. The server looks for another available user (filtering by interests if provided).
3. **Signaling (The Handshake):** 
   - When a match is found, one user creates a WebRTC **Offer** and sends it to the server.
   - The server relays this Offer to the partner.
   - The partner replies with a WebRTC **Answer**, relayed back through the server.
   - Both clients exchange **ICE Candidates** (network routing information) via the server.
4. **P2P Connection Established:** The server steps back. Video, audio, and text chat now flow directly peer-to-peer.

## 📂 Folder Structure

Omtv uses a clean monorepo architecture separating the client-side React app and the server-side Node environment. 
*Note: We utilize custom React hooks on the frontend to completely decouple complex WebRTC logic from our UI components.*

```text
omtv/
├── backend/
│   ├── package.json
│   └── src/
│       └── server.js         # Entry point: Express, Socket.io, & Redis matchmaking
└── frontend/
    ├── package.json
    ├── vite.config.ts
    └── src/
        ├── App.tsx           # Main UI Component (Glassmorphism design)
        ├── App.css           # Styling
        └── hooks/
            ├── useSignaling.ts # Manages Socket.io lifecycle & signaling events
            └── useWebRTC.ts    # Manages RTCPeerConnection, media streams & data channels
