import React, { useCallback, useEffect, useState } from 'react';
import { request } from '../lib/api.js';
import Toast from './Toast.jsx';

function normalizePhone(value) {
  return value.replace(/[\s().-]/g, '');
}

function isValidPhone(value) {
  return /^\+[1-9]\d{7,14}$/.test(normalizePhone(value));
}

function friendlyTelegramError(error) {
  const message = error?.message || 'Telegram could not complete the request. Please try again.';
  if (/credentials are not configured|API ID and API hash|not configured on the service/i.test(message)) {
    return 'Telegram sign-in is temporarily unavailable. Please try again later or contact your administrator.';
  }
  const code = error?.telegramErrorCode;
  return code && !message.includes(code) ? `${message} (${code})` : message;
}

export default function TelegramConnect({ token, channels, onRefresh }) {
  const [status, setStatus] = useState({ connected: false });
  const [chats, setChats] = useState([]);
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [step, setStep] = useState('phone');
  const [busy, setBusy] = useState(false);
  const [loadingChats, setLoadingChats] = useState(false);
  const [toast, setToast] = useState(null);

  const notify = useCallback((message, tone = 'success') => {
    setToast({ message, tone, id: Date.now() });
  }, []);

  useEffect(() => {
    if (!toast) return undefined;
    const timeout = window.setTimeout(() => setToast(null), toast.tone === 'error' ? 7000 : 4500);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  const checkStatus = useCallback(async () => {
    const current = await request('/api/telegram/status', token);
    setStatus(current);
    return current;
  }, [token]);

  const completeLogin = async () => {
    setStep('phone');
    setPhone('');
    setCode('');
    setPassword('');
    await checkStatus();
    await onRefresh();
    notify('Telegram is connected to your workspace.');
  };

  const loadChats = useCallback(async () => {
    setLoadingChats(true);
    try {
      const result = await request('/api/telegram/chats', token);
      setChats(result.chats || []);
    } catch (error) {
      notify(friendlyTelegramError(error), 'error');
    } finally {
      setLoadingChats(false);
    }
  }, [notify, token]);

  useEffect(() => {
    checkStatus().catch((error) => notify(friendlyTelegramError(error), 'error'));
  }, [checkStatus, notify]);

  useEffect(() => {
    if (status.connected) loadChats();
  }, [status.connected, loadChats]);

  const sendCode = async (event) => {
    event.preventDefault();
    const phoneNumber = normalizePhone(phone);
    if (!/^\+[1-9]\d{7,14}$/.test(phoneNumber)) {
      notify('Enter a valid international phone number, including the country code (for example, +15551234567).', 'error');
      return;
    }
    setBusy(true);
    setToast(null);
    try {
      await request('/api/telegram/request-code', token, { method: 'POST', body: { phoneNumber } });
      setPhone(phoneNumber);
      setCode('');
      setStep('code');
      notify('Telegram sent a login code. Enter the code to continue.');
    } catch (error) {
      notify(friendlyTelegramError(error), 'error');
    } finally {
      setBusy(false);
    }
  };

  const resendCode = async () => {
    const phoneNumber = normalizePhone(phone);
    if (!/^\+[1-9]\d{7,14}$/.test(phoneNumber)) {
      notify('Enter a valid international phone number before requesting a new code.', 'error');
      return;
    }
    setBusy(true);
    setToast(null);
    try {
      await request('/api/telegram/request-code', token, { method: 'POST', body: { phoneNumber } });
      setPhone(phoneNumber);
      setCode('');
      setStep('code');
      notify('A fresh Telegram login code was sent. Use the newest code.');
    } catch (error) {
      notify(friendlyTelegramError(error), 'error');
    } finally {
      setBusy(false);
    }
  };

  const verifyCode = async (event) => {
    event.preventDefault();
    const oneTimeCode = code.replace(/\s/g, '');
    if (!/^\d{3,10}$/.test(oneTimeCode)) {
      notify('Enter the numeric login code from Telegram.', 'error');
      return;
    }
    setBusy(true);
    setToast(null);
    try {
      const result = await request('/api/telegram/verify-code', token, { method: 'POST', body: { code: oneTimeCode } });
      if (result.requiresPassword) {
        setPassword('');
        setStep('password');
        notify(result.message || 'This account requires its Telegram two-step verification password.');
        return;
      }
      if (!result.connected) {
        notify(result.message || 'Telegram could not verify that code. Please try again.', 'error');
        return;
      }
      await completeLogin();
    } catch (error) {
      notify(friendlyTelegramError(error), 'error');
    } finally {
      setBusy(false);
    }
  };

  const verifyPassword = async (event) => {
    event.preventDefault();
    if (!password) {
      notify('Enter your Telegram two-step verification password.', 'error');
      return;
    }
    setBusy(true);
    setToast(null);
    try {
      const result = await request('/api/telegram/verify-password', token, { method: 'POST', body: { password } });
      if (!result.connected) {
        notify(result.message || 'Telegram could not verify that password. Please try again.', 'error');
        return;
      }
      await completeLogin();
    } catch (error) {
      notify(friendlyTelegramError(error), 'error');
    } finally {
      setBusy(false);
    }
  };

  const changeNumber = () => {
    setCode('');
    setPassword('');
    setStep('phone');
    setToast(null);
  };

  const disconnect = async () => {
    if (!window.confirm('Disconnect Telegram and remove the saved session?')) return;
    setBusy(true);
    try {
      await request('/api/telegram/disconnect', token, { method: 'POST', body: {} });
      setStatus((previous) => ({ ...previous, connected: false }));
      setChats([]);
      setPhone('');
      setCode('');
      setPassword('');
      setStep('phone');
      await onRefresh();
      notify('Telegram has been disconnected.');
    } catch (error) {
      notify(friendlyTelegramError(error), 'error');
    } finally {
      setBusy(false);
    }
  };

  const addChannel = async (chat) => {
    setBusy(true);
    try {
      await request('/api/channels', token, { method: 'POST', body: chat });
      await onRefresh();
      notify(`${chat.title} was added to monitored sources.`);
    } catch (error) {
      notify(friendlyTelegramError(error), 'error');
    } finally {
      setBusy(false);
    }
  };

  const removeChannel = async (id) => {
    setBusy(true);
    try {
      await request(`/api/channels/${id}`, token, { method: 'DELETE' });
      await onRefresh();
      notify('Monitoring stopped for the selected Telegram chat.');
    } catch (error) {
      notify(friendlyTelegramError(error), 'error');
    } finally {
      setBusy(false);
    }
  };

  return <div className="panel-grid">
    <section className="panel" aria-labelledby="telegram-connection-title">
      <div className="panel-heading">
        <div><p className="eyebrow">SOURCE ACCOUNT</p><h2 id="telegram-connection-title">Telegram connection</h2></div>
        <span className={`status-pill ${status.connected ? 'online' : ''}`} aria-live="polite">{status.connected ? 'Connected' : 'Not connected'}</span>
      </div>
      {status.connected ? <>
        <p className="muted">Your Telegram session is stored encrypted. Only the groups and channels you choose are monitored.</p>
        <div className="button-row">
          <button className="button button-secondary" type="button" disabled={loadingChats} onClick={loadChats}>{loadingChats ? 'Refreshing…' : 'Refresh groups & channels'}</button>
          <button className="button button-danger" type="button" disabled={busy} onClick={disconnect}>{busy ? 'Disconnecting…' : 'Disconnect'}</button>
        </div>
        <h3 className="section-title">Available groups &amp; channels</h3>
        <p className="field-help">Choose which Telegram chats to monitor. You can stop monitoring any time.</p>
        {loadingChats && !chats.length ? <p className="muted" role="status">Loading Telegram chats…</p> : !chats.length ? <div className="empty-state compact-empty"><strong>No groups or channels found</strong><span>Refresh the list after joining a Telegram group or channel.</span></div> : <div className="chat-list">{chats.map((chat) => {
          const selected = channels.find((channel) => String(channel.channelId) === String(chat.channelId));
          return <div className="chat-row" key={chat.channelId}><div><strong>{chat.title}</strong><small>{chat.type || 'Group or channel'} · {chat.username ? `@${chat.username}` : chat.channelId}</small></div><button className="button button-small" type="button" aria-label={selected ? `Stop monitoring ${chat.title}` : `Monitor ${chat.title}`} aria-pressed={Boolean(selected)} disabled={busy} onClick={() => selected ? removeChannel(selected.id) : addChannel(chat)}>{busy ? (selected ? 'Updating…' : 'Adding…') : (selected ? 'Stop monitoring' : 'Monitor')}</button></div>;
        })}</div>}
      </> : <>
        <p className="muted">Connect with your phone number and Telegram login code. If two-step verification is enabled, Telegram will also ask for your password.</p>
        {step === 'phone' ? <form className="form-stack telegram-form" onSubmit={sendCode} aria-busy={busy}>
          <label htmlFor="telegram-phone">Phone number
            <input id="telegram-phone" type="tel" inputMode="tel" autoComplete="tel" placeholder="+15551234567" value={phone} onChange={(event) => setPhone(event.target.value)} aria-describedby="telegram-phone-help" aria-invalid={Boolean(phone) && !isValidPhone(phone)} required />
          </label>
          <small id="telegram-phone-help" className="field-help">Include the country code, for example +15551234567.</small>
          {phone && !isValidPhone(phone) && <small className="field-error" role="alert">Enter a valid international phone number with its country code.</small>}
          <button className="button button-primary" type="submit" disabled={busy || !isValidPhone(phone)}>{busy ? 'Sending…' : 'Send Telegram code'}</button>
        </form> : step === 'code' ? <form className="form-stack telegram-form" onSubmit={verifyCode} aria-busy={busy}>
          <p className="code-destination">Enter the code sent to <strong>{phone}</strong>.</p>
          <label htmlFor="telegram-code">Telegram login code
            <input id="telegram-code" type="text" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]{3,10}" maxLength={10} placeholder="Enter the code" value={code} onChange={(event) => setCode(event.target.value)} aria-describedby="telegram-code-help" required />
          </label>
          <small id="telegram-code-help" className="field-help">Enter the numeric code from your Telegram app or SMS.</small>
          <button className="button button-primary" type="submit" disabled={busy || !/^\d{3,10}$/.test(code.replace(/\s/g, ''))}>{busy ? 'Verifying…' : 'Verify code'}</button>
          <button className="text-button change-number" type="button" disabled={busy} onClick={resendCode}>{busy ? 'Sending…' : 'Resend code'}</button>
          <button className="text-button change-number" type="button" disabled={busy} onClick={changeNumber}>Use a different phone number</button>
        </form> : <form className="form-stack telegram-form" onSubmit={verifyPassword} aria-busy={busy}>
          <p className="code-destination">Your code was accepted. Enter the password for Telegram two-step verification.</p>
          <label htmlFor="telegram-two-step-password">Telegram two-step verification password
            <input id="telegram-two-step-password" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} aria-describedby="telegram-password-help" required />
          </label>
          <small id="telegram-password-help" className="field-help">This password is sent to Telegram to finish signing in and is not saved in this form.</small>
          <button className="button button-primary" type="submit" disabled={busy || !password}>{busy ? 'Verifying…' : 'Verify password'}</button>
          <button className="text-button change-number" type="button" disabled={busy} onClick={changeNumber}>Use a different phone number</button>
        </form>}
      </>}
      <Toast toast={toast} onDismiss={() => setToast(null)} />
    </section>
    <section className="panel" aria-labelledby="monitored-sources-title">
      <div className="panel-heading"><div><p className="eyebrow">MONITORED SOURCES</p><h2 id="monitored-sources-title">Monitored groups &amp; channels</h2></div><span className="count-badge">{channels.length}</span></div>
      {!channels.length ? <div className="empty-state"><span className="empty-icon" aria-hidden="true">⌁</span><strong>No chats selected</strong><span>Connect Telegram and choose which groups or channels to monitor.</span></div> : <div className="chat-list">{channels.map((channel) => <div className="chat-row" key={channel.id}><div><strong>{channel.title}</strong><small>{channel.enabled ? 'Monitoring enabled' : 'Paused'}</small></div><button className="button button-small button-secondary" type="button" aria-label={`Stop monitoring ${channel.title}`} disabled={busy} onClick={() => removeChannel(channel.id)}>Stop monitoring</button></div>)}</div>}
      <div className="note-box">Only new posts received while the service is awake are captured. A free Render web service may sleep; continuous monitoring requires an always-on deployment.</div>
    </section>
  </div>;
}
