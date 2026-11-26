import React, { useEffect, useRef, useState } from 'react';

/** Long messages are transferred only after an explicit request, never on render or polling. */
export default function SignalMessage({ signal, onLoadMessage }) {
  const [message, setMessage] = useState(null);
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const mounted = useRef(false);
  const pending = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const toggle = async () => {
    if (pending.current) return;
    if (message !== null) { setExpanded((value) => !value); return; }
    pending.current = true;
    setLoading(true);
    setError('');
    try {
      const detail = await onLoadMessage(signal.id);
      if (typeof detail?.message !== 'string') throw new Error('The full message is unavailable.');
      if (mounted.current) { setMessage(detail.message); setExpanded(true); }
    } catch (cause) {
      if (mounted.current) setError(cause.message || 'Could not load the full message. Please try again.');
    } finally {
      pending.current = false;
      if (mounted.current) setLoading(false);
    }
  };

  return <>
    <p className="signal-message">{expanded ? message : signal.message}{!expanded && signal.messageTruncated ? '…' : ''}</p>
    {signal.messageTruncated && onLoadMessage ? <button className="text-button" type="button" disabled={loading} aria-expanded={expanded} onClick={toggle}>{loading ? 'Loading message…' : expanded ? 'Show preview' : 'Show full message'}</button> : null}
    {error ? <p className="alert alert-error" role="alert">{error}</p> : null}
  </>;
}
