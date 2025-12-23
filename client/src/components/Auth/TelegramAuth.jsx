// client/src/components/Auth/TelegramAuth.jsx
import React, { useState, useEffect } from 'react';
import { useWebSocket } from '../../hooks/useWebSocket';
import { toast } from 'react-hot-toast';

export default function TelegramAuth({ onSuccess }) {
  const { connected, emit, on, off } = useWebSocket();
  const [step, setStep] = useState('phone'); // phone | code | connected
  const [phoneNumber, setPhoneNumber] = useState('');
  const [code, setCode] = useState('');
  const [phoneCodeHash, setPhoneCodeHash] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!connected) return;

    // Check if already connected
    emit('telegram:restore');

    // Listen for events
    on('telegram:restored', ({ success }) => {
      if (success) {
        setStep('connected');
        toast.success('Telegram session restored');
        onSuccess?.();
      }
    });

    on('telegram:notConnected', () => {
      setStep('phone');
    });

    on('telegram:sessionExpired', () => {
      setStep('phone');
      toast.error('Session expired. Please login again.');
    });

    on('telegram:codeRequested', ({ phoneCodeHash: hash }) => {
      setPhoneCodeHash(hash);
      setStep('code');
      setLoading(false);
      toast.success('Code sent to your phone');
    });

    on('telegram:loginSuccess', () => {
      setStep('connected');
      setLoading(false);
      toast.success('Telegram connected successfully!');
      onSuccess?.();
    });

    on('telegram:error', ({ error }) => {
      setLoading(false);
      toast.error(error);
    });

    return () => {
      off('telegram:restored');
      off('telegram:notConnected');
      off('telegram:sessionExpired');
      off('telegram:codeRequested');
      off('telegram:loginSuccess');
      off('telegram:error');
    };
  }, [connected, emit, on, off, onSuccess]);

  const handleRequestCode = (e) => {
    e.preventDefault();
    if (!phoneNumber.trim()) {
      toast.error('Please enter your phone number');
      return;
    }

    setLoading(true);
    emit('telegram:requestCode', { phoneNumber });
  };

  const handleLogin = (e) => {
    e.preventDefault();
    if (!code.trim()) {
      toast.error('Please enter the verification code');
      return;
    }

    setLoading(true);
    emit('telegram:login', {
      phoneNumber,
      code,
      phoneCodeHash,
    });
  };

  const handleDisconnect = () => {
    if (confirm('Are you sure you want to disconnect Telegram?')) {
      emit('telegram:disconnect');
      setStep('phone');
      setPhoneNumber('');
      setCode('');
      toast.success('Telegram disconnected');
    }
  };

  if (!connected) {
    return (
      <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-6 text-center">
        <p className="text-yellow-800">Connecting to server...</p>
      </div>
    );
  }

  if (step === 'connected') {
    return (
      <div className="bg-green-50 border border-green-200 rounded-lg p-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-3 h-3 bg-green-500 rounded-full animate-pulse"></div>
            <div>
              <h3 className="font-semibold text-green-900">Telegram Connected</h3>
              <p className="text-sm text-green-700">Session running on your device</p>
            </div>
          </div>
          <button
            onClick={handleDisconnect}
            className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition"
          >
            Disconnect
          </button>
        </div>
      </div>
    );
  }

  if (step === 'phone') {
    return (
      <div className="bg-white border rounded-lg p-6">
        <h3 className="text-lg font-semibold mb-4">Connect Telegram</h3>
        <p className="text-sm text-gray-600 mb-4">
          Your Telegram session runs on your device. Enter your phone number to receive a verification code.
        </p>
        <form onSubmit={handleRequestCode}>
          <div className="mb-4">
            <label className="block text-sm font-medium mb-2">
              Phone Number
            </label>
            <input
              type="tel"
              value={phoneNumber}
              onChange={(e) => setPhoneNumber(e.target.value)}
              placeholder="+1234567890"
              className="w-full px-4 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500"
              disabled={loading}
              required
            />
            <p className="text-xs text-gray-500 mt-1">
              Include country code (e.g., +1 for US)
            </p>
          </div>
          <button
            type="submit"
            disabled={loading}
            className="w-full bg-blue-600 text-white py-2 rounded-lg hover:bg-blue-700 transition disabled:opacity-50"
          >
            {loading ? 'Sending...' : 'Send Code'}
          </button>
        </form>
      </div>
    );
  }

  if (step === 'code') {
    return (
      <div className="bg-white border rounded-lg p-6">
        <h3 className="text-lg font-semibold mb-4">Enter Verification Code</h3>
        <p className="text-sm text-gray-600 mb-4">
          We sent a code to <strong>{phoneNumber}</strong>. Check your Telegram app.
        </p>
        <form onSubmit={handleLogin}>
          <div className="mb-4">
            <label className="block text-sm font-medium mb-2">
              Verification Code
            </label>
            <input
              type="text"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="12345"
              className="w-full px-4 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 text-center text-2xl tracking-widest"
              disabled={loading}
              maxLength={5}
              required
              autoFocus
            />
          </div>
          <button
            type="submit"
            disabled={loading}
            className="w-full bg-blue-600 text-white py-2 rounded-lg hover:bg-blue-700 transition disabled:opacity-50"
          >
            {loading ? 'Verifying...' : 'Verify & Connect'}
          </button>
          <button
            type="button"
            onClick={() => setStep('phone')}
            className="w-full mt-2 text-sm text-gray-600 hover:text-gray-900"
          >
            ← Back to phone number
          </button>
        </form>
      </div>
    );
  }
}
