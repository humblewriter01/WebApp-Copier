// server/websocket/connection.js
import jwt from 'jsonwebtoken';
import { logger } from '../utils/logger.js';
import { handleTelegramEvents } from './telegram.js';
import { handleTradingEvents } from './trading.js';
import { handleDashboardEvents } from './dashboard.js';

const connectedUsers = new Map(); // userId -> socket

export function setupWebSocket(io) {
  // Authentication middleware
  io.use((socket, next) => {
    try {
      const token = socket.handshake.auth.token;
      
      if (!token) {
        return next(new Error('Authentication error'));
      }

      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      socket.userId = decoded.userId;
      socket.userEmail = decoded.email;
      
      next();
    } catch (error) {
      logger.error('WebSocket auth error', { error: error.message });
      next(new Error('Authentication error'));
    }
  });

  // Connection handler
  io.on('connection', (socket) => {
    const userId = socket.userId;
    
    logger.info('WebSocket client connected', {
      userId,
      socketId: socket.id,
    });

    // Store connection
    connectedUsers.set(userId, socket);

    // Join user-specific room
    socket.join(`user:${userId}`);

    // Send initial connection success
    socket.emit('connected', {
      message: 'Connected to server',
      userId,
    });

    /* ================================
       TELEGRAM EVENTS
    ================================ */
    handleTelegramEvents(socket, io);

    /* ================================
       TRADING EVENTS
    ================================ */
    handleTradingEvents(socket, io);

    /* ================================
       DASHBOARD EVENTS
    ================================ */
    handleDashboardEvents(socket, io);

    /* ================================
       DISCONNECTION
    ================================ */
    socket.on('disconnect', (reason) => {
      logger.info('WebSocket client disconnected', {
        userId,
        socketId: socket.id,
        reason,
      });

      connectedUsers.delete(userId);
    });

    /* ================================
       ERROR HANDLING
    ================================ */
    socket.on('error', (error) => {
      logger.error('WebSocket error', {
        userId,
        socketId: socket.id,
        error: error.message,
      });
    });
  });

  return io;
}

/* ================================
   UTILITY FUNCTIONS
================================ */

// Send message to specific user
export function sendToUser(userId, event, data) {
  const socket = connectedUsers.get(userId);
  if (socket) {
    socket.emit(event, data);
    return true;
  }
  return false;
}

// Broadcast to all connected users
export function broadcast(event, data) {
  connectedUsers.forEach((socket) => {
    socket.emit(event, data);
  });
}

// Check if user is connected
export function isUserConnected(userId) {
  return connectedUsers.has(userId);
}

// Get connected user count
export function getConnectedUserCount() {
  return connectedUsers.size;
}
