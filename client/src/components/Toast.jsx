import React from 'react';

export default function Toast({ toast, onDismiss }) {
  if (!toast) return null;
  const isError = toast.tone === 'error';
  return <div className={`toast toast-${toast.tone || 'success'}`} role={isError ? 'alert' : 'status'} aria-live={isError ? 'assertive' : 'polite'}>
    <span className="toast-mark" aria-hidden="true">{isError ? '!' : '✓'}</span>
    <span className="toast-message">{toast.message}</span>
    <button className="toast-close" type="button" aria-label="Dismiss notification" onClick={onDismiss}>×</button>
  </div>;
}
