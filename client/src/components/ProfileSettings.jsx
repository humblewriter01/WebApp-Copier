import React, { useState } from 'react';
import AccountDeletionSettings from './AccountDeletionSettings.jsx';
import { PASSWORD_RESET_SENT, sendPasswordResetEmail } from '../lib/password-reset.js';

const ROLE_LABELS = { admin: 'Workspace administrator', user: 'Workspace owner' };

/**
 * Who this workspace is signed in as, and the two things worth doing about it.
 *
 * Identity here is read-only on purpose: the name and email are the account's, and the only credential
 * a workspace changes itself is the password - which is not stored here at all, so changing it has to go
 * through the emailed link the sign-in screen already uses. The Danger Zone sits at the bottom of this
 * page rather than under the trading settings, because deleting a workspace used to be two rows below the
 * field that sizes a live position.
 */
export default function ProfileSettings({ user, token, onDeleted, readOnly = false }) {
  const [state, setState] = useState('idle'); // idle | sending | sent | error
  const [error, setError] = useState('');
  const email = String(user?.email || '');

  const sendResetLink = async () => {
    setState('sending'); setError('');
    try {
      await sendPasswordResetEmail(email);
      setState('sent');
    } catch (sendError) {
      setError(sendError?.message || 'We could not send a reset link right now. Please try again.');
      setState('error');
    }
  };

  const joined = user?.createdAt ? new Date(user.createdAt) : null;

  return (
    <div className="profile-settings">
      <section className="panel profile-identity-panel" aria-labelledby="profile-identity-title">
        <div className="panel-heading"><div><p className="eyebrow">PROFILE</p><h2 id="profile-identity-title">Your account</h2></div></div>
        <dl className="profile-facts">
          <div className="profile-fact"><dt>Name</dt><dd>{user?.name || '—'}</dd></div>
          <div className="profile-fact"><dt>Email</dt><dd>{email || '—'}</dd></div>
          <div className="profile-fact"><dt>Role</dt><dd>{ROLE_LABELS[user?.role] || 'Workspace owner'}</dd></div>
          <div className="profile-fact"><dt>Workspace created</dt><dd>{joined && !Number.isNaN(joined.getTime()) ? joined.toLocaleDateString() : '—'}</dd></div>
        </dl>
        <p className="field-help">The name and email on this row are the ones Signal Desk signs you in with, and they are not editable from inside the workspace: a change to either is a change to the account, not to a setting. Ask support if any of it is wrong.</p>
      </section>

      <section className="panel profile-password-panel" aria-labelledby="profile-password-title">
        <div className="panel-heading"><div><p className="eyebrow">SECURITY</p><h2 id="profile-password-title">Password</h2></div></div>
        <p className="muted">Signal Desk never stores your password, so it cannot change it for you here. Sending a reset link emails a single-use address that opens a page to choose a new password; it expires, and nothing changes until you use it.</p>
        {readOnly
          ? <p className="field-help">You are looking at another workspace through a support session, so no reset link can be sent from it.</p>
          : <>
            {state === 'sent'
              ? <div className="alert alert-success" role="status">{PASSWORD_RESET_SENT}</div>
              : <p className="field-help profile-password-target">A link will be sent to <strong>{email || 'your sign-in address'}</strong>.</p>}
            {error ? <div className="alert alert-error" role="alert">{error}</div> : null}
            <button type="button" className="button button-primary" onClick={sendResetLink} disabled={state === 'sending' || !email}>
              {state === 'sending' ? 'Sending reset link…' : state === 'sent' ? 'Send another link' : 'Change password'}
            </button>
            <p className="field-help">Signed in on a shared device? Sign out from the bottom of the navigation when you have finished, and turn Auto-Trading off on Advanced Settings first if you do not want new orders while you are away.</p>
          </>}
      </section>

      {readOnly
        ? <section className="panel account-danger-zone" aria-labelledby="profile-danger-title">
          <div className="panel-heading"><div><p className="eyebrow">DANGER ZONE</p><h2 id="profile-danger-title">Delete My Account</h2></div></div>
          <p className="muted">A support session is read-only, so this workspace cannot be deleted from it, and its settings cannot be changed from it either.</p>
        </section>
        : <AccountDeletionSettings token={token} onDeleted={onDeleted} />}
    </div>
  );
}
