import React, { useState } from 'react';
import { PASSWORD_RESET_SENT, sendPasswordResetEmail } from '../lib/password-reset.js';
import { request } from '../lib/api.js';

export default function AuthScreen({ onAuthenticated, installPrompt, onInstall, initialMode = 'login', onBackToOverview = null }) {
  // Which door the visitor came through, so the landing page's "Log in" opens the card on the form
  // they asked for instead of whatever the default happens to be.
  const [mode, setMode] = useState(initialMode);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [resetSent, setResetSent] = useState(false);
  const [rememberMe, setRememberMe] = useState(true);
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const submit = async (event) => {
    event.preventDefault(); setBusy(true); setError('');
    try {
      if (mode === 'forgot') {
        await sendPasswordResetEmail(form.email);
        setResetSent(true);
        return;
      }
      const data = await request(`/api/auth/${mode === 'login' ? 'login' : 'register'}`, null, { method: 'POST', body: { ...form, rememberMe } });
      onAuthenticated(data, rememberMe);
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  };
  const changeMode = (nextMode) => { setMode(nextMode); setError(''); setResetSent(false); };
  return <main className="auth-shell">
    <div className="auth-brand"><div className="brand-mark"><img src="/icons/signal-desk-icon-192.png" alt="" /></div><span>Signal Desk</span></div>
    <section className="auth-card">
      <p className="eyebrow">{mode === 'forgot' ? 'ACCOUNT RECOVERY' : 'AUTOMATED SIGNAL EXECUTION'}</p>
      <h1>{mode === 'login' ? 'Welcome back' : mode === 'register' ? 'Create your workspace' : resetSent ? 'Check your email' : 'Reset your password'}</h1>
      <p className="muted">{mode === 'forgot' ? 'Enter the email address for your Signal Desk account. If it exists, we will send a secure reset link.' : 'Automate your trading by executing Telegram signals directly to your broker.'}</p>
      {onBackToOverview && <button type="button" className="landing-link auth-back" onClick={onBackToOverview}>Back to the overview</button>}
      {mode === 'forgot' && resetSent ? <>
        <div className="alert alert-success" role="status">{PASSWORD_RESET_SENT}</div>
        <button type="button" className="button button-secondary button-wide auth-mode-button" onClick={() => changeMode('login')}>Back to sign in</button>
      </> : <form onSubmit={submit} className="form-stack">
        {mode === 'register' && <label>Your name<input autoComplete="name" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} required maxLength={100} /></label>}
        <label>Email<input type="email" autoComplete="email" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} required /></label>
        {mode !== 'forgot' && <label>Password<input type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} required minLength={mode === 'register' ? 10 : 1} />{mode === 'register' && <small>Use at least 10 characters.</small>}</label>}
        {mode === 'login' && <div className="forgot-password-row"><button type="button" className="text-button" onClick={() => changeMode('forgot')}>Forgot Password?</button></div>}
        {mode === 'login' && <><label className="remember-session"><input type="checkbox" checked={rememberMe} onChange={(event) => setRememberMe(event.target.checked)} /><span>Keep me signed in for 30 days</span></label><small className="remember-hint">Leave checked on your personal device. Uncheck it on shared devices.</small></>}
        {error && <div className="alert alert-error" role="alert">{error}</div>}
        <button className="button button-primary button-wide" disabled={busy}>{busy ? (mode === 'forgot' ? 'Sending…' : 'Please wait…') : mode === 'login' ? 'Sign in' : mode === 'register' ? 'Create account' : 'Send reset link'}</button>
        {mode === 'forgot' && <button type="button" className="button button-secondary button-wide auth-mode-button" onClick={() => changeMode('login')}>Back to sign in</button>}
      </form>}
      {mode !== 'forgot' && <p className="auth-switch">{mode === 'login' ? 'New to Signal Desk?' : 'Already have an account?'} <button type="button" className="text-button" onClick={() => changeMode(mode === 'login' ? 'register' : 'login')}>{mode === 'login' ? 'Create account' : 'Sign in'}</button></p>}
      <p className="fine-print">Auto-Trading is OFF by default for new workspaces. You will be asked to review your Risk Settings and explicitly confirm a live-trading warning before any orders can be placed. You can turn it off at any time.</p>
      {installPrompt && <button type="button" className="button button-primary button-wide install-button" onClick={onInstall}>Install Signal Desk</button>}
    </section>
  </main>;
}
