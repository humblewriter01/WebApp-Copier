import React from 'react';

/**
 * An administrator's form, opened over the panel instead of squeezed into the row that held its button.
 *
 * Three tools used to render inside `<tr><td colSpan>` cells: a whole support-session explanation and a
 * three-field plan adjustment in a column-width box, which on a phone meant a form nobody could read. The
 * dialog fixes the geometry once - centred, scrollable, full width on a small screen - and keeps what the
 * row already knew: Escape and a click outside cancel, focus lands on the first field so typing starts
 * immediately, and while the request is in flight both buttons are held so a double click cannot submit
 * the same change twice. The form element is here rather than in each caller, so Enter submits and the
 * Cancel button cannot accidentally be given `type="submit"`.
 */
export default function AdminActionModal({
  open = false,
  title,
  intro,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  busy = false,
  tone = 'primary',
  onCancel,
  onSubmit,
  children,
}) {
  const formRef = React.useRef(null);
  const titleId = React.useId();
  React.useEffect(() => {
    if (!open) return undefined;
    const onKey = (event) => { if (event.key === 'Escape' && !busy) onCancel?.(); };
    window.addEventListener('keydown', onKey);
    const field = formRef.current?.querySelector?.('input,select,textarea');
    field?.focus?.();
    return () => window.removeEventListener('keydown', onKey);
  }, [open, busy, onCancel]);
  if (!open) return null;
  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onCancel?.(); }}
    >
      <form
        ref={formRef}
        className="panel modal admin-action-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onSubmit={(event) => { event.preventDefault(); void onSubmit?.(); }}
      >
        <h3 id={titleId}>{title}</h3>
        {intro ? <p className="admin-action-modal-intro">{intro}</p> : null}
        <div className="admin-action-modal-body">{children}</div>
        <div className="modal-actions">
          <button type="button" className="button button-secondary" onClick={() => onCancel?.()} disabled={busy}>{cancelLabel}</button>
          <button type="submit" className={`button ${tone === 'danger' ? 'button-danger' : 'button-primary'}`} disabled={busy}>{busy ? 'Working…' : confirmLabel}</button>
        </div>
      </form>
    </div>
  );
}
