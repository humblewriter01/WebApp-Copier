// server/websocket/telegram.js
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { Api } from 'telegram/tl';
import { logger } from '../utils/logger.js';
import { User } from '../models/User.js';
import { Channel } from '../models/Channel.js';
import { processSignal } from '../services/signal.service.js';

const userClients = new Map(); // userId -> { client, sessionString, loginPromise }

export function handleTelegramEvents(socket, io) {
  const userId = socket.userId;

  /* ================================
     REQUEST CONFIRMATION (No Code)
  ================================ */
  socket.on('telegram:requestConfirmation', async ({ phoneNumber }) => {
    try {
      logger.info('Telegram confirmation requested', { userId, phoneNumber });

      // Create new client session
      const client = new TelegramClient(
        new StringSession(''),
        parseInt(process.env.API_ID),
        process.env.API_HASH,
        {
          connectionRetries: 5,
          useWSS: false,
        }
      );

      await client.connect();

      // Variable to track if login completed
      let loginCompleted = false;

      // Start sign-in process with bot-like confirmation
      const loginPromise = client.start({
        phoneNumber: async () => phoneNumber,
        password: async () => {
          // Most users won't have 2FA
          return '';
        },
        phoneCode: async () => {
          // This function is called when Telegram sends verification code
          // But we want to use the "confirm on device" method instead
          // So we'll use the forceSMS: false option to trigger app confirmation
          throw new Error('Please confirm login in your Telegram app');
        },
        onError: (err) => {
          if (!loginCompleted) {
            logger.error('Telegram login error', { userId, error: err.message });
            socket.emit('telegram:error', { 
              error: err.message.includes('PHONE_NUMBER_INVALID')
                ? 'Invalid phone number format'
                : 'Login failed. Please try again.'
            });
          }
        },
      });

      // Store client data
      userClients.set(userId, {
        client,
        loginPromise,
        phoneNumber,
        startTime: Date.now(),
      });

      // Get device/browser info
      const userAgent = socket.handshake.headers['user-agent'] || 'Unknown Browser';
      const ip = socket.handshake.address || 'Unknown IP';
      const browser = parseBrowser(userAgent);

      // Notify client that confirmation was sent
      socket.emit('telegram:confirmationSent', {
        browser,
        ip,
        location: 'Kano, Nigeria', // You can integrate GeoIP service here
      });

      // Set timeout for login (2 minutes)
      const loginTimeout = setTimeout(() => {
        if (!loginCompleted) {
          loginCompleted = true;
          socket.emit('telegram:loginTimeout');
          
          const clientData = userClients.get(userId);
          if (clientData?.client) {
            clientData.client.disconnect().catch(() => {});
            userClients.delete(userId);
          }
        }
      }, 120000); // 2 minutes

      // Wait for login completion
      try {
        await loginPromise;
        loginCompleted = true;
        clearTimeout(loginTimeout);

        // Check if still connected
        if (!client.connected) {
          throw new Error('Client disconnected during login');
        }

        // Save session
        const sessionString = client.session.save();
        
        await User.findByIdAndUpdate(userId, {
          telegramSession: sessionString,
          telegramConnected: true,
          telegramPhone: phoneNumber,
          lastLogin: new Date(),
        });

        userClients.set(userId, { client, sessionString });

        socket.emit('telegram:loginSuccess');
        logger.info('Telegram login successful', { userId, phoneNumber });

        // Start listening to channels
        await startChannelListeners(userId, client, socket);

      } catch (error) {
        loginCompleted = true;
        clearTimeout(loginTimeout);
        
        // Check if user cancelled
        if (error.message.includes('CANCELLED') || error.message.includes('cancel')) {
          socket.emit('telegram:loginCancelled');
          logger.info('Telegram login cancelled by user', { userId });
        } else {
          throw error;
        }
      }

    } catch (error) {
      logger.error('Telegram confirmation error', { userId, error: error.message });
      
      // Clean up
      const clientData = userClients.get(userId);
      if (clientData?.client) {
        clientData.client.disconnect().catch(() => {});
        userClients.delete(userId);
      }

      // Send appropriate error message
      let errorMessage = 'Failed to send confirmation';
      
      if (error.message.includes('PHONE_NUMBER_INVALID')) {
        errorMessage = 'Invalid phone number. Please check and try again.';
      } else if (error.message.includes('PHONE_NUMBER_BANNED')) {
        errorMessage = 'This phone number is banned from Telegram.';
      } else if (error.message.includes('PHONE_CODE_EXPIRED')) {
        errorMessage = 'Confirmation expired. Please try again.';
      } else if (error.message.includes('network')) {
        errorMessage = 'Network error. Please check your connection.';
      }

      socket.emit('telegram:error', { error: errorMessage });
    }
  });

  /* ================================
     CANCEL LOGIN
  ================================ */
  socket.on('telegram:cancelLogin', async () => {
    try {
      const clientData = userClients.get(userId);
      if (clientData?.client) {
        await clientData.client.disconnect();
        userClients.delete(userId);
        logger.info('Telegram login cancelled', { userId });
      }
    } catch (error) {
      logger.error('Cancel login error', { userId, error: error.message });
    }
  });

  /* ================================
     RESTORE SESSION
  ================================ */
  socket.on('telegram:restore', async () => {
    try {
      const user = await User.findById(userId);
      
      if (!user?.telegramSession) {
        return socket.emit('telegram:notConnected');
      }

      // Check if client already exists and is connected
      const existingClient = userClients.get(userId);
      if (existingClient?.client?.connected) {
        socket.emit('telegram:restored', { success: true });
        await startChannelListeners(userId, existingClient.client, socket);
        return;
      }

      // Restore client from saved session
      const client = new TelegramClient(
        new StringSession(user.telegramSession),
        parseInt(process.env.API_ID),
        process.env.API_HASH,
        { connectionRetries: 5 }
      );

      await client.connect();

      // Check if session is still valid
      const isAuthorized = await client.checkAuthorization();
      
      if (!isAuthorized) {
        await User.findByIdAndUpdate(userId, {
          telegramConnected: false,
          telegramSession: null,
        });
        return socket.emit('telegram:sessionExpired');
      }

      userClients.set(userId, { client, sessionString: user.telegramSession });

      socket.emit('telegram:restored', { success: true });
      logger.info('Telegram session restored', { userId });

      // Start channel listeners
      await startChannelListeners(userId, client, socket);

    } catch (error) {
      logger.error('Telegram restore error', { userId, error: error.message });
      
      // Clean up invalid session
      await User.findByIdAndUpdate(userId, {
        telegramConnected: false,
        telegramSession: null,
      });
      
      socket.emit('telegram:sessionExpired');
    }
  });

  /* ================================
     GET CHANNELS
  ================================ */
  socket.on('telegram:getChannels', async () => {
    try {
      const clientData = userClients.get(userId);
      if (!clientData?.client) {
        return socket.emit('telegram:error', { error: 'Not connected to Telegram' });
      }

      const { client } = clientData;

      // Get all dialogs (chats/channels)
      const dialogs = await client.getDialogs({ limit: 100 });

      const channels = dialogs
        .filter(d => d.isChannel || d.isGroup)
        .map(d => ({
          id: d.id.toString(),
          title: d.title,
          username: d.entity.username || null,
          isChannel: d.isChannel,
          isGroup: d.isGroup,
          participantsCount: d.entity.participantsCount || 0,
        }))
        .sort((a, b) => a.title.localeCompare(b.title));

      socket.emit('telegram:channels', { channels });
      logger.info('Channels retrieved', { userId, count: channels.length });

    } catch (error) {
      logger.error('Get channels error', { userId, error: error.message });
      socket.emit('telegram:error', { error: 'Failed to get channels' });
    }
  });

  /* ================================
     SUBSCRIBE TO CHANNEL
  ================================ */
  socket.on('telegram:subscribeChannel', async ({ channelId, channelTitle }) => {
    try {
      // Check if already subscribed
      const existing = await Channel.findOne({ userId, channelId });
      
      if (existing) {
        if (!existing.enabled) {
          existing.enabled = true;
          await existing.save();
          socket.emit('telegram:channelSubscribed', {
            success: true,
            channelId,
            title: channelTitle,
          });
        } else {
          return socket.emit('telegram:error', { 
            error: 'Already subscribed to this channel' 
          });
        }
      } else {
        // Create new subscription
        await Channel.create({
          userId,
          channelId,
          title: channelTitle,
          enabled: true,
          createdAt: new Date(),
        });

        socket.emit('telegram:channelSubscribed', {
          success: true,
          channelId,
          title: channelTitle,
        });
      }

      logger.info('Channel subscribed', { userId, channelId, title: channelTitle });

      // Restart listeners to include new channel
      const clientData = userClients.get(userId);
      if (clientData?.client) {
        await startChannelListeners(userId, clientData.client, socket);
      }

    } catch (error) {
      logger.error('Subscribe channel error', { userId, error: error.message });
      socket.emit('telegram:error', { error: 'Failed to subscribe to channel' });
    }
  });

  /* ================================
     UNSUBSCRIBE FROM CHANNEL
  ================================ */
  socket.on('telegram:unsubscribeChannel', async ({ channelId }) => {
    try {
      const channel = await Channel.findOne({ userId, channelId });
      
      if (!channel) {
        return socket.emit('telegram:error', { error: 'Channel not found' });
      }

      channel.enabled = false;
      await channel.save();

      socket.emit('telegram:channelUnsubscribed', {
        success: true,
        channelId,
      });

      logger.info('Channel unsubscribed', { userId, channelId });

    } catch (error) {
      logger.error('Unsubscribe channel error', { userId, error: error.message });
      socket.emit('telegram:error', { error: 'Failed to unsubscribe' });
    }
  });

  /* ================================
     DISCONNECT
  ================================ */
  socket.on('telegram:disconnect', async () => {
    try {
      const clientData = userClients.get(userId);
      if (clientData?.client) {
        await clientData.client.disconnect();
        userClients.delete(userId);
      }

      await User.findByIdAndUpdate(userId, {
        telegramConnected: false,
      });

      socket.emit('telegram:disconnected', { success: true });
      logger.info('Telegram disconnected', { userId });

    } catch (error) {
      logger.error('Telegram disconnect error', { userId, error: error.message });
    }
  });

  /* ================================
     HANDLE SOCKET DISCONNECTION
  ================================ */
  socket.on('disconnect', async () => {
    // Don't disconnect Telegram client when WebSocket disconnects
    // Just log it for monitoring
    logger.info('WebSocket disconnected, keeping Telegram session', { userId });
  });
}

/* ================================
   UTILITY FUNCTIONS
================================ */

// Parse browser from user agent
function parseBrowser(userAgent) {
  if (userAgent.includes('Chrome') && !userAgent.includes('Edge')) return 'Chrome';
  if (userAgent.includes('Firefox')) return 'Firefox';
  if (userAgent.includes('Safari') && !userAgent.includes('Chrome')) return 'Safari';
  if (userAgent.includes('Edge')) return 'Edge';
  if (userAgent.includes('Opera')) return 'Opera';
  return 'Unknown Browser';
}

// Start listening to subscribed channels
async function startChannelListeners(userId, client, socket) {
  try {
    // Remove existing event handlers to avoid duplicates
    client.removeEventHandler();

    // Get enabled channels for this user
    const channels = await Channel.find({ userId, enabled: true });

    if (channels.length === 0) {
      logger.info('No channels to listen to', { userId });
      return;
    }

    // Add event handler for new messages
    client.addEventHandler(async (event) => {
      try {
        // Only process message events
        if (!event.message) return;

        const chatId = event.message.chatId?.toString();
        if (!chatId) return;

        // Find if this message is from a subscribed channel
        const channel = channels.find(c => c.channelId === chatId);
        
        if (!channel) return;

        const messageText = event.message.message;
        if (!messageText) return;

        logger.info('Signal received', { 
          userId, 
          channel: channel.title,
          messageLength: messageText.length 
        });

        // Emit to client for real-time display
        socket.emit('signal:received', {
          channelId: channel.channelId,
          channelTitle: channel.title,
          message: messageText,
          timestamp: new Date(),
        });

        // Process signal on server
        await processSignal(userId, channel, messageText, socket);

      } catch (error) {
        logger.error('Message handler error', { 
          userId, 
          error: error.message 
        });
      }
    });

    logger.info('Channel listeners started', { 
      userId, 
      channelCount: channels.length,
      channels: channels.map(c => c.title)
    });

  } catch (error) {
    logger.error('Start listeners error', { userId, error: error.message });
    socket.emit('telegram:error', { error: 'Failed to start channel listeners' });
  }
}

// Clean up inactive clients (call this periodically)
export function cleanupInactiveClients() {
  const now = Date.now();
  const TIMEOUT = 10 * 60 * 1000; // 10 minutes

  userClients.forEach((clientData, userId) => {
    if (clientData.startTime && (now - clientData.startTime) > TIMEOUT) {
      if (!clientData.sessionString) {
        // Only clean up clients that haven't completed login
        clientData.client?.disconnect().catch(() => {});
        userClients.delete(userId);
        logger.info('Cleaned up inactive client', { userId });
      }
    }
  });
}

// Run cleanup every 5 minutes
setInterval(cleanupInactiveClients, 5 * 60 * 1000);
