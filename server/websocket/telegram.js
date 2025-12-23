// server/websocket/telegram.js
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { logger } from '../utils/logger.js';
import { User } from '../models/User.js';
import { Channel } from '../models/Channel.js';
import { processSignal } from '../services/signal.service.js';

const userClients = new Map(); // userId -> TelegramClient

export function handleTelegramEvents(socket, io) {
  const userId = socket.userId;

  /* ================================
     CLIENT-SIDE TELEGRAM AUTH
     User initiates auth on their device
  ================================ */

  // Request phone number (user enters on their device)
  socket.on('telegram:requestCode', async ({ phoneNumber }) => {
    try {
      logger.info('Telegram code requested', { userId, phoneNumber });

      // Create client session on server (managed per user)
      const client = new TelegramClient(
        new StringSession(''),
        parseInt(process.env.API_ID),
        process.env.API_HASH,
        { connectionRetries: 5 }
      );

      await client.connect();

      // Send code to user's phone
      const result = await client.sendCode(
        {
          apiId: parseInt(process.env.API_ID),
          apiHash: process.env.API_HASH,
        },
        phoneNumber
      );

      // Store client temporarily
      userClients.set(userId, { client, phoneCodeHash: result.phoneCodeHash });

      socket.emit('telegram:codeRequested', {
        success: true,
        phoneCodeHash: result.phoneCodeHash,
        message: 'Code sent to your phone',
      });
    } catch (error) {
      logger.error('Telegram request code error', { userId, error: error.message });
      socket.emit('telegram:error', { error: 'Failed to request code' });
    }
  });

  // Complete auth with code
  socket.on('telegram:login', async ({ phoneNumber, code, phoneCodeHash }) => {
    try {
      const clientData = userClients.get(userId);
      if (!clientData) {
        return socket.emit('telegram:error', { error: 'Session expired' });
      }

      const { client } = clientData;

      // Sign in with code
      await client.invoke(
        new Api.auth.SignIn({
          phoneNumber,
          phoneCodeHash,
          phoneCode: code,
        })
      );

      // Save session string
      const sessionString = client.session.save();

      // Store in database
      await User.findByIdAndUpdate(userId, {
        telegramSession: sessionString,
        telegramConnected: true,
      });

      userClients.set(userId, { client, sessionString });

      socket.emit('telegram:loginSuccess', {
        success: true,
        message: 'Telegram connected successfully',
      });

      logger.info('Telegram login successful', { userId });

      // Start listening to channels
      startChannelListeners(userId, client, socket);
    } catch (error) {
      logger.error('Telegram login error', { userId, error: error.message });
      socket.emit('telegram:error', { error: 'Login failed' });
    }
  });

  // Restore session on reconnect
  socket.on('telegram:restore', async () => {
    try {
      const user = await User.findById(userId);
      
      if (!user.telegramSession) {
        return socket.emit('telegram:notConnected');
      }

      // Restore client from session
      const client = new TelegramClient(
        new StringSession(user.telegramSession),
        parseInt(process.env.API_ID),
        process.env.API_HASH,
        { connectionRetries: 5 }
      );

      await client.connect();

      if (!(await client.checkAuthorization())) {
        return socket.emit('telegram:sessionExpired');
      }

      userClients.set(userId, { client, sessionString: user.telegramSession });

      socket.emit('telegram:restored', {
        success: true,
        message: 'Telegram session restored',
      });

      // Start listening to channels
      startChannelListeners(userId, client, socket);
    } catch (error) {
      logger.error('Telegram restore error', { userId, error: error.message });
      socket.emit('telegram:error', { error: 'Failed to restore session' });
    }
  });

  // Get joined channels
  socket.on('telegram:getChannels', async () => {
    try {
      const clientData = userClients.get(userId);
      if (!clientData) {
        return socket.emit('telegram:error', { error: 'Not connected' });
      }

      const { client } = clientData;
      const dialogs = await client.getDialogs({ limit: 100 });

      const channels = dialogs
        .filter(d => d.isChannel || d.isGroup)
        .map(d => ({
          id: d.id.toString(),
          title: d.title,
          username: d.entity.username || null,
        }));

      socket.emit('telegram:channels', { channels });
    } catch (error) {
      logger.error('Get channels error', { userId, error: error.message });
      socket.emit('telegram:error', { error: 'Failed to get channels' });
    }
  });

  // Subscribe to channel
  socket.on('telegram:subscribeChannel', async ({ channelId, channelTitle }) => {
    try {
      // Save channel to database
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

      logger.info('Channel subscribed', { userId, channelId, title: channelTitle });
    } catch (error) {
      logger.error('Subscribe channel error', { userId, error: error.message });
      socket.emit('telegram:error', { error: 'Failed to subscribe' });
    }
  });

  // Disconnect Telegram
  socket.on('telegram:disconnect', async () => {
    try {
      const clientData = userClients.get(userId);
      if (clientData) {
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
}

/* ================================
   CHANNEL MESSAGE LISTENER
================================ */
async function startChannelListeners(userId, client, socket) {
  try {
    const channels = await Channel.find({ userId, enabled: true });

    for (const channel of channels) {
      // Add event handler for new messages
      client.addEventHandler(async (event) => {
        if (event.message && event.message.chatId.toString() === channel.channelId) {
          const messageText = event.message.message;

          logger.info('Signal received', { userId, channel: channel.title });

          // Emit to client for display
          socket.emit('signal:received', {
            channelId: channel.channelId,
            channelTitle: channel.title,
            message: messageText,
            timestamp: new Date(),
          });

          // Process signal on server
          await processSignal(userId, channel, messageText, socket);
        }
      });
    }

    logger.info('Channel listeners started', { userId, count: channels.length });
  } catch (error) {
    logger.error('Start listeners error', { userId, error: error.message });
  }
}
