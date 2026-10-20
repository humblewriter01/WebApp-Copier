import React, { useEffect, useState } from 'react';
import { request } from '../lib/api.js';
import { supabase } from '../lib/supabase.js';

export default function UpdatePasswordPage() {
  const [session, setSession] = useState(null);
  const [checking, setChecking] = useState(true);
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [complete, setComplete] = useState(false);
  const [syncNotice, setSyncNotice] = useState('');

  useEffect(() => {
    if (!supabase) { setChecking(false); return undefined; }
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, currentSession) => {
      if (currentSession) setSession(currentSession);
    });
    supabase.auth.getSession().then(({ data, error: sessionError }) => {
      if (sessionError) setError(sessionError.message);
      setSession(data?.session || null);
      setChecking(false);
    }).catch(() => {
      setError('This password reset link could not be verified. Request a new link and try again.');
      setChecking(false);
    });
    return () => subscription.unsubscribe();
  }, []);

  const submit = async (event) => {
    event.preventDefault();
    setError('');
    if (password.length < 10) { setError('Use at least 10 characters for your new password.'); return; }
    if (password !== confirmPassword) { setError('The passwords do not match.'); return; }
    setBusy(true);
    try {
      const { data: currentData, error: currentError } = await supabase.auth.getSession();
      if (currentError) throw currentError;
      const recoverySession = currentData?.session || session;
      if (!recoverySession?.access_token) throw new Error('This reset link has expired. Request a new password reset link.');
      const { data: updateData, error: updateError } = await supabase.auth.updateUser({ password });
      if (updateError) throw updateError;

      try {
        await request('/api/auth/sync-password', updateData?.session?.access_token || recoverySession.access_token, {
          method: 'POST',
          body: { password },
        });
      } catch {
        // Login also verifies against Supabase and repairs the local hash if this one-time sync fails.
        setSyncNotice('Your password was changed. If your next sign-in does not work, request another reset link and try again.');
      }

      try { await supabase.auth.signOut({ scope: 'local' }); } catch {}
      try { localStorage.removeItem('signal-token'); } catch {}
      try { sessionStorage.removeItem('signal-token'); } catch {}
      setComplete(true);
    } catch (submitError) {
      setError(submitError?.message || 'We could not update your password. Request a new reset link and try again.');
    } finally { setBusy(false); }
  };

  return <main className="auth-shell">
    <div className="auth-brand"><div className="brand-mark"><img src="/icons/signal-desk-icon-192.png" alt="" /></div><span>Signal Desk</span></div>
    <section className="auth-card" aria-labelledby="update-password-title">
      <p className="eyebrow">ACCOUNT SECURITY</p>
      <h1 id="update-password-title">{complete ? 'Password updated' : 'Choose a new password'}</h1>
      {complete ? <>
        <p className="muted">Your password has been updated. Sign in with your new password to continue.</p>
        {syncNotice && <div className="alert alert-info" role="status">{syncNotice}</div>}
        <a className="button button-primary button-wide auth-link-button" href="/">Return to sign in</a>
      </> : checking ? <div className="loading-shell inline-loading"><div className="spinner" /><span>Verifying your reset link…</span></div> : !supabase ? <>
        <p className="muted">Password recovery is not configured for this workspace yet.</p>
        <a className="button button-secondary button-wide auth-link-button" href="/">Return to sign in</a>
      </> : !session ? <>
        <p className="muted">This reset link is invalid or has expired. Request a new link from the sign-in page.</p>
        {error && <div className="alert alert-error" role="alert">{error}</div>}
        <a className="button button-secondary button-wide auth-link-button" href="/">Return to sign in</a>
      </> : <>
        <p className="muted">Use a new password with at least 10 characters.</p>
        <form onSubmit={submit} className="form-stack">
          <label>New password<input type="password" autoComplete="new-password" value={password} onChange={event => setPassword(event.target.value)} minLength={10} required /></label>
          <label>Confirm new password<input type="password" autoComplete="new-password" value={confirmPassword} onChange={event => setConfirmPassword(event.target.value)} minLength={10} required /></label>
          {error && <div className="alert alert-error" role="alert">{error}</div>}
          <button className="button button-primary button-wide" disabled={busy}>{busy ? 'Updating…' : 'Update password'}</button>
        </form>
      </>}
    </section>
  </main>;
}
