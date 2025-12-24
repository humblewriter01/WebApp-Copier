// ============================================
// CLIENT: TelegramAuth.jsx
// ============================================
// client/src/components/Auth/TelegramAuth.jsx

import React, { useState, useEffect } from 'react';
import { useWebSocket } from '../../hooks/useWebSocket';
import { toast } from 'react-hot-toast';
import { FaTelegram, FaCheckCircle, FaSpinner, FaArrowLeft } from 'react-icons/fa';

export default function TelegramAuth({ onSuccess }) {
  const { connected, emit, on, off } = useWebSocket();
  const [step, setStep] = useState('phone'); // phone | waiting | connected
  const [phoneNumber, setPhoneNumber] = useState('');
  const [loading, setLoading] = useState(false);
  const [deviceInfo, setDeviceInfo] = useState(null);

  useEffect(() => {
    if (!connected) return;

    // Check if already connected
    emit('telegram:restore');

    // Event listeners
    const handlers = {
      'telegram:restored': ({ success }) => {
        if (success) {
          setStep('connected');
          toast.success('Telegram session restored');
          onSuccess?.();
        }
      },

      'telegram:notConnected': () => {
        setStep('phone');
      },

      'telegram:sessionExpired': () => {
        setStep('phone');
        toast.error('Session expired. Please login again.');
      },

      'telegram:confirmationSent': ({ browser, ip, location }) => {
        setDeviceInfo({ browser, ip, location });
        setStep('waiting');
        setLoading(false);
        toast.success('Check your Telegram app to confirm login');
      },

      'telegram:loginSuccess': () => {
        setStep('connected');
        setLoading(false);
        toast.success('Telegram connected successfully!');
        onSuccess?.();
      },

      'telegram:loginCancelled': () => {
        setStep('phone');
        setLoading(false);
        toast.error('Login cancelled. Please try again.');
      },

      'telegram:loginTimeout': () => {
        setStep('phone');
        setLoading(false);
        toast.error('Login timeout. Please try again.');
      },

      'telegram:error': ({ error }) => {
        setLoading(false);
        setStep('phone');
        toast.error(error || 'An error occurred');
      }
    };

    // Register all handlers
    Object.entries(handlers).forEach(([event, handler]) => {
      on(event, handler);
    });

    // Cleanup
    return () => {
      Object.keys(handlers).forEach(event => off(event));
    };
  }, [connected, emit, on, off, onSuccess]);

  const handleSendConfirmation = (e) => {
    e.preventDefault();
    
    if (!phoneNumber.trim()) {
      toast.error('Please enter your phone number');
      return;
    }

    // Validate phone format (basic)
    if (!phoneNumber.startsWith('+')) {
      toast.error('Phone number must include country code (e.g., +1234567890)');
      return;
    }

    setLoading(true);
    emit('telegram:requestConfirmation', { phoneNumber });
  };

  const handleCancel = () => {
    emit('telegram:cancelLogin');
    setStep('phone');
    setLoading(false);
    setDeviceInfo(null);
  };

  const handleDisconnect = () => {
    if (confirm('Are you sure you want to disconnect Telegram?')) {
      emit('telegram:disconnect');
      setStep('phone');
      setPhoneNumber('');
      toast.success('Telegram disconnected');
    }
  };

  if (!connected) {
    return (
      <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-6 text-center">
        <FaSpinner className="animate-spin text-yellow-600 text-3xl mx-auto mb-2" />
        <p className="text-yellow-800">Connecting to server...</p>
      </div>
    );
  }

  // ============================================
  // CONNECTED STATE
  // ============================================
  if (step === 'connected') {
    return (
      <div className="bg-gradient-to-br from-green-50 to-emerald-50 border border-green-200 rounded-xl p-6 shadow-sm">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div className="relative">
              <FaTelegram className="text-[#0088cc] text-4xl" />
              <div className="absolute -bottom-1 -right-1 w-4 h-4 bg-green-500 rounded-full border-2 border-white animate-pulse"></div>
            </div>
            <div>
              <h3 className="font-semibold text-green-900 text-lg">Telegram Connected</h3>
              <p className="text-sm text-green-700">Your session is active</p>
            </div>
          </div>
          <button
            onClick={handleDisconnect}
            className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition font-medium"
          >
            Disconnect
          </button>
        </div>
      </div>
    );
  }

  // ============================================
  // WAITING FOR CONFIRMATION STATE
  // ============================================
  if (step === 'waiting') {
    return (
      <div className="bg-white border border-gray-200 rounded-xl p-8 shadow-sm">
        {/* Header */}
        <div className="text-center mb-6">
          <div className="relative inline-block mb-4">
            <FaTelegram className="text-[#0088cc] text-6xl mx-auto" />
            <div className="absolute -top-2 -right-2 w-6 h-6 bg-blue-500 rounded-full animate-ping"></div>
          </div>
          <h3 className="text-2xl font-bold text-gray-900 mb-2">
            Check Your Telegram
          </h3>
          <p className="text-gray-600">
            We sent a login confirmation to your Telegram app
          </p>
        </div>

        {/* Device Info Card */}
        {deviceInfo && (
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 mb-6">
            <p className="text-sm text-gray-700 mb-3 font-medium">
              Login request details:
            </p>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-gray-600">Browser:</span>
                <span className="font-medium text-gray-900">{deviceInfo.browser}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-600">IP Address:</span>
                <span className="font-medium text-gray-900">{deviceInfo.ip}</span>
              </div>
              {deviceInfo.location && (
                <div className="flex justify-between">
                  <span className="text-gray-600">Location:</span>
                  <span className="font-medium text-gray-900">{deviceInfo.location}</span>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Instructions */}
        <div className="bg-gray-50 rounded-lg p-4 mb-6">
          <p className="text-sm text-gray-700 mb-3 font-medium">
            To complete login:
          </p>
          <ol className="space-y-2 text-sm text-gray-600">
            <li className="flex items-start gap-2">
              <span className="font-bold text-blue-600">1.</span>
              <span>Open your Telegram app</span>
            </li>
            <li className="flex items-start gap-2">
              <span className="font-bold text-blue-600">2.</span>
              <span>Check for a message from <strong>Telegram</strong></span>
            </li>
            <li className="flex items-start gap-2">
              <span className="font-bold text-blue-600">3.</span>
              <span>Tap the <strong>"Confirm"</strong> button</span>
            </li>
          </ol>
        </div>

        {/* Loading Animation */}
        <div className="flex justify-center items-center gap-2 mb-6">
          <div className="w-3 h-3 bg-blue-500 rounded-full animate-bounce" style={{ animationDelay: '0ms' }}></div>
          <div className="w-3 h-3 bg-blue-500 rounded-full animate-bounce" style={{ animationDelay: '150ms' }}></div>
          <div className="w-3 h-3 bg-blue-500 rounded-full animate-bounce" style={{ animationDelay: '300ms' }}></div>
        </div>

        {/* Cancel Button */}
        <button
          onClick={handleCancel}
          className="w-full flex items-center justify-center gap-2 text-gray-600 hover:text-gray-900 py-2 transition"
        >
          <FaArrowLeft />
          <span>Cancel and try different number</span>
        </button>
      </div>
    );
  }

  // ============================================
  // PHONE NUMBER INPUT STATE
  // ============================================
  return (
    <div className="bg-white border border-gray-200 rounded-xl p-8 shadow-sm">
      {/* Header */}
      <div className="text-center mb-8">
        <FaTelegram className="text-[#0088cc] text-6xl mx-auto mb-4" />
        <h3 className="text-2xl font-bold text-gray-900 mb-2">
          Connect Telegram
        </h3>
        <p className="text-gray-600">
          Enter your phone number to receive a confirmation in your Telegram app
        </p>
      </div>

      {/* Form */}
      <form onSubmit={handleSendConfirmation} className="space-y-6">
        <div>
          <label className="block text-sm font-semibold text-gray-700 mb-2">
            Phone Number
          </label>
          <div className="relative">
            <input
              type="tel"
              value={phoneNumber}
              onChange={(e) => setPhoneNumber(e.target.value)}
              placeholder="+1234567890"
              className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent text-lg"
              disabled={loading}
              required
              autoFocus
            />
          </div>
          <p className="text-xs text-gray-500 mt-2 flex items-center gap-1">
            <span>💡</span>
            <span>Include country code (e.g., +234 for Nigeria, +1 for US)</span>
          </p>
        </div>

        {/* Info Box */}
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
          <p className="text-sm text-blue-800">
            <strong>How it works:</strong> After submitting your number, you'll receive a login confirmation in your Telegram app. Simply tap "Confirm" to complete the connection - no code needed!
          </p>
        </div>

        {/* Submit Button */}
        <button
          type="submit"
          disabled={loading}
          className="w-full bg-[#0088cc] text-white py-3 rounded-lg hover:bg-[#0077b3] transition font-semibold disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
        >
          {loading ? (
            <>
              <FaSpinner className="animate-spin" />
              <span>Sending...</span>
            </>
          ) : (
            <>
              <FaTelegram />
              <span>Send Confirmation</span>
            </>
          )}
        </button>
      </form>

      {/* Footer */}
      <div className="mt-6 text-center">
        <p className="text-xs text-gray-500">
          Your Telegram session will run securely on your device
        </p>
      </div>
    </div>
  );
}


// ============================================
// SERVER: telegram.js (WebSocket Handler)
// ============================================
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

      // Start sign-in process (this sends the confirmation to Telegram app)
      const loginPromise = client.signInUserWithQrCode(
        { apiId: parseInt(process.env.API_ID), apiHash: process.env.API_HASH },
        {
          phoneNumber: async () => phoneNumber,
          password: async () => '', // No password for most users
          phoneCode: async () => {
            // This won't be called with QR/confirmation method
            throw new Error('Code not supported');
          },
          onError: (err) => {
            logger.error('Telegram login error', { userId, error: err.message });
            socket.emit('telegram:error', { error: err.message });
          },
        }
      );

      // Store client data
      userClients.set(userId, {
        client,
        loginPromise,
        phoneNumber,
      });

      // Get device/browser info
      const userAgent = socket.handshake.headers['user-agent'] || 'Unknown Browser';
      const ip = socket.handshake.address;
      const browser = parseBrowser(userAgent);

      // Notify client that confirmation was sent
      socket.emit('telegram:confirmationSent', {
        browser,
        ip,
        location: 'Kano, Nigeria', // You can use a GeoIP service for accuracy
      });

      // Wait for user confirmation in Telegram app (with timeout)
      const loginTimeout = setTimeout(() => {
        socket.emit('telegram:loginTimeout');
        userClients.delete(userId);
        client.disconnect();
      }, 120000); // 2 minutes timeout

      // Wait for login completion
      try {
        await loginPromise;
        clearTimeout(loginTimeout);

        // Save session
        const sessionString = client.session.save();
        await User.findByIdAndUpdate(userId, {
          telegramSession: sessionString,
          telegramConnected: true,
          telegramPhone: phoneNumber,
        });

        userClients.set(userId, { client, sessionString });

        socket.emit('telegram:loginSuccess');
        logger.info('Telegram login successful', { userId });

        // Start listening to channels
        startChannelListeners(userId, client, socket);
      } catch (error) {
        clearTimeout(loginTimeout);
        if (error.message.includes('CANCELLED')) {
          socket.emit('telegram:loginCancelled');
        } else {
          throw error;
        }
      }
    } catch (error) {
      logger.error('Telegram confirmation error', { userId, error: error.message });
      socket.emit('telegram:error', { 
        error: error.message.includes('PHONE_NUMBER_INVALID') 
          ? 'Invalid phone number. Please check and try again.' 
          : 'Failed to send confirmation' 
      });
    }
  });

  /* ================================
     CANCEL LOGIN
  ================================ */
  socket.on('telegram:cancelLogin', async () => {
    const clientData = userClients.get(userId);
    if (clientData?.client) {
      await clientData.client.disconnect();
      userClients.delete(userId);
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

      // Restore client from saved session
      const client = new TelegramClient(
        new StringSession(user.telegramSession),
        parseInt(process.env.API_ID),
        process.env.API_HASH,
        { connectionRetries: 5 }
      );

      await client.connect();

      // Check if session is still valid
      if (!(await client.checkAuthorization())) {
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
      startChannelListeners(userId, client, socket);
    } catch (error) {
      logger.error('Telegram restore error', { userId, error: error.message });
      socket.emit('telegram:error', { error: 'Failed to restore session' });
    }
  });

  /* ================================
     GET CHANNELS
  ================================ */
  socket.on('telegram:getChannels', async () => {
    try {
      const clientData = userClients.get(userId);
      if (!clientData) {
        return socket.emit('telegram:error', { error: 'Not connected' });
      }

      const dialogs = await clientData.client.getDialogs({ limit: 100 });

      const channels = dialogs
        .filter(d => d.isChannel || d.isGroup)
        .map(d => ({
          id: d.id.toString(),
          title: d.title,
          username: d.entity.username || null,
          isChannel: d.isChannel,
          isGroup: d.isGroup,
        }));

      socket.emit('telegram:channels', { channels });
    } catch (error) {
      logger.error('Get channels error', { userId, error: error.message });
      socket.emit('telegram:error', { error: 'Failed to get channels' });
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
}

/* ================================
   UTILITY FUNCTIONS
================================ */

// Parse browser from user agent
function parseBrowser(userAgent) {
  if (userAgent.includes('Chrome')) return 'Chrome';
  if (userAgent.includes('Firefox')) return 'Firefox';
  if (userAgent.includes('Safari')) return 'Safari';
  if (userAgent.includes('Edge')) return 'Edge';
  return 'Unknown Browser';
}

// Start listening to subscribed channels
async function startChannelListeners(userId, client, socket) {
  try {
    const channels = await Channel.find({ userId, enabled: true });

    client.addEventHandler(async (event) => {
      if (!event.message) return;

      const chatId = event.message.chatId?.toString();
      const channel = channels.find(c => c.channelId === chatId);

      if (channel) {
        const messageText = event.message.message;

        logger.info('Signal received', { 
          userId, 
          channel: channel.title,
          messagePreview: messageText.substring(0, 50) 
        });

        // Emit to client
        socket.emit('signal:received', {
          channelId: channel.channelId,
          channelTitle: channel.title,
          message: messageText,
          timestamp: new Date(),
        });

        // Process signal
        await processSignal(userId, channel, messageText, socket);
      }
    });

    logger.info('Channel listeners started', { userId, channelCount: channels.length });
  } catch (error) {
    logger.error('Start listeners error', { userId, error: error.message });
  }
}
