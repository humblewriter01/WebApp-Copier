import React from 'react';

/**
 * The one control that stands between a click and an irreversible delete.
 *
 * Removal from the signal history cannot be undone from the panel, so it is never a single click: the
 * modal states what is removed, what is deliberately kept (a trade and its profit and loss always
 * outlive the message that produced it), and how many rows the last count saw. Escape and the backdrop
 * cancel, the confirm button takes focus, and while the request is in flight both buttons are held so
 * a double click cannot ask for the same deletion twice - the second one would have been a 404 with a
 * scary message for something that already worked.
 */
export default function ConfirmModal({
  open = false,
  title,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  busy = false,
  tone = 'danger',
  onConfirm,
  onCancel,
  children,
}) {
  const confirmRef = React.useRef(null);
  React.useEffect(() => {
    if (!open) return undefined;
    const onKey = (event) => { if (event.key === 'Escape' && !busy) onCancel?.(); };
    window.addEventListener('keydown', onKey);
    confirmRef.current?.focus?.();
    return () => window.removeEventListener('keydown', onKey);
  }, [open, busy, onCancel]);
  if (!open) return null;
  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onCancel?.(); }}
    >
      <div className="panel modal confirm-modal" role="alertdialog" aria-modal="true" aria-labelledby="confirm-modal-title">
        <h3 id="confirm-modal-title">{title}</h3>
        <div className="confirm-modal-body">{children}</div>
        <div className="modal-actions">
          <button type="button" className="button button-secondary" onClick={() => onCancel?.()} disabled={busy}>{cancelLabel}</button>
          <button type="button" className={`button ${tone === 'danger' ? 'button-danger' : 'button-primary'}`} ref={confirmRef} onClick={() => onConfirm?.()} disabled={busy}>{busy ? 'Working…' : confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}
