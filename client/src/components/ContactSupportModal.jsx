import React, { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { request } from '../lib/api.js';

const SENT_MESSAGE = 'Your message has been sent. We will reply to your email within 24 hours.';

/** One support form shared by the sidebar and dashboard footer, with one submission and success state. */
export default function ContactSupportModal({ open = false, token, onClose }) {
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState(false);
  const formRef = useRef(null);
  const titleId = useId();
  const live = useRef({ busy, onClose });
  live.current = { busy, onClose };
  const restoreTo = useRef(null);
  const pressedOnBackdrop = useRef(false);

  useEffect(() => {
    if (!open) return undefined;
    setSubject('');
    setMessage('');
    setError('');
    setSent(false);
    restoreTo.current = document.activeElement;
    const field = formRef.current?.querySelector?.('input:not([disabled]),textarea:not([disabled])');
    if (field && !formRef.current.contains(document.activeElement)) field.focus?.();
    const onKey = (event) => { if (event.key === 'Escape' && !live.current.busy) live.current.onClose?.(); };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      const previous = restoreTo.current;
      restoreTo.current = null;
      if (previous?.isConnected && typeof previous.focus === 'function') previous.focus();
    };
  }, [open]);

  if (!open) return null;

  const close = () => {
    if (busy) return;
    onClose?.();
  };

  const submit = async (event) => {
    event.preventDefault();
    if (busy || sent) return;
    setBusy(true);
    setError('');
    try {
      await request('/api/support/contact', token, {
        method: 'POST',
        body: { subject: subject.trim(), message: message.trim() },
      });
      setSent(true);
    } catch (sendError) {
      setError(sendError.message || 'Your message could not be sent. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const dialog = (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => { pressedOnBackdrop.current = event.target === event.currentTarget; }}
      onMouseUp={(event) => {
        const armed = pressedOnBackdrop.current;
        pressedOnBackdrop.current = false;
        if (armed && event.target === event.currentTarget && !busy) close();
      }}
    >
      <form
        ref={formRef}
        className="panel modal admin-action-modal contact-support-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onSubmit={(event) => { void submit(event); }}
      >
        <h2 id={titleId}>Contact Support</h2>
        <p className="admin-action-modal-intro">Send a message to the Signal Desk support team. We will reply to the email address on your account.</p>
        {sent ? <div className="alert alert-success" role="status" aria-live="polite">{SENT_MESSAGE}</div> : <>
          <div className="admin-action-modal-body">
            <label htmlFor="support-contact-subject">Subject
              <input
                id="support-contact-subject"
                type="text"
                value={subject}
                onChange={(event) => setSubject(event.target.value)}
                maxLength={200}
                required
                placeholder="What can we help with?"
              />
            </label>
            <label htmlFor="support-contact-message">Message
              <textarea
                id="support-contact-message"
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                maxLength={10000}
                rows={8}
                required
                placeholder="Describe the issue or question in a few sentences."
              />
            </label>
          </div>
          {error ? <div className="alert alert-error" role="alert">{error}</div> : null}
        </>}
        <div className="modal-actions">
          {!sent ? <button type="button" className="button button-secondary" onClick={close} disabled={busy}>Cancel</button> : null}
          {sent
            ? <button type="button" className="button button-primary" onClick={close}>Close</button>
            : <button type="submit" className="button button-primary" disabled={busy}>{busy ? 'Sending…' : 'Send Message'}</button>}
        </div>
      </form>
    </div>
  );

  return typeof document === 'undefined' ? dialog : createPortal(dialog, document.body);
}
