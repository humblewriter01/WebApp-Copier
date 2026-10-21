import React, { useState } from 'react';
import { request } from '../lib/api.js';
import { supabaseReady } from '../lib/supabase.js';

export default function AccountDeletionSettings({ token, onDeleted }) {
  const [confirming, setConfirming] = useState(false);
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const cancel = () => {
    setConfirming(false);
    setPassword('');
    setConfirmation('');
    setError('');
  };

  const submit = async (event) => {
    event.preventDefault();
    setError('');
    if (confirmation.trim() !== 'DELETE') { setError('Type DELETE exactly to confirm.'); return; }
    setBusy(true);
    try {
      await request('/api/auth/account', token, {
        method: 'DELETE',
        body: { password, confirmation: confirmation.trim() },
      });
      try { const client = await supabaseReady(); await client?.auth.signOut({ scope: 'global' }); } catch {}
      onDeleted();
    } catch (submitError) {
      setError(submitError.message || 'We could not delete your account. Please try again.');
    } finally { setBusy(false); }
  };

  return <section className="panel account-danger-zone" aria-labelledby="delete-account-heading">
    <div className="panel-heading"><div><p className="eyebrow">ACCOUNT</p><h2 id="delete-account-heading">Delete My Account</h2></div></div>
    <p className="muted">Permanently delete your Signal Desk profile and stored workspace data, including Telegram sessions, channels, signals, notes, connected-account records, settings, and execution history. Auto-Trading will be turned off first. Trading accounts this workspace created through MetaAPI are removed from MetaAPI as well, so they stop accruing provider charges. This does not close your broker account, close open broker positions, cancel orders already sent, or delete a MetaAPI account you added with your own MetaAPI token.</p>
    {!confirming ? <button type="button" className="button button-danger" onClick={() => setConfirming(true)}>Delete My Account</button> : <form className="form-stack deletion-confirm-form" onSubmit={submit}>
      <div className="alert alert-error deletion-warning" role="alert">This action cannot be undone. Confirm your current password and type DELETE to proceed.</div>
      <label>Current password<input type="password" autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} required /></label>
      <label>Type DELETE to confirm<input type="text" autoComplete="off" value={confirmation} onChange={event => setConfirmation(event.target.value)} required /></label>
      {error && <div className="alert alert-error" role="alert">{error}</div>}
      <div className="deletion-actions"><button type="button" className="button button-secondary" onClick={cancel} disabled={busy}>Cancel</button><button type="submit" className="button button-danger" disabled={busy || !password || confirmation.trim() !== 'DELETE'}>{busy ? 'Deleting…' : 'Permanently delete account'}</button></div>
    </form>}
  </section>;
}
