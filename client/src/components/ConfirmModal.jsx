import React from 'react';
import { createPortal } from 'react-dom';

/**
 * The one control that stands between a click and an irreversible delete.
 *
 * Removal from the signal history cannot be undone from the panel, so it is never a single click: the
 * modal states what is removed, what is deliberately kept (a trade and its profit and loss always
 * outlive the message that produced it), and how many rows the last count saw. Escape and the backdrop
 * cancel, the confirm button takes focus, and while the request is in flight both buttons are held so
 * a double click cannot ask for the same deletion twice - the second one would have been a 404 with a
 * scary message for something that already worked.
 *
 * It shares its two structural decisions with `AdminActionModal`, and for the same reason: the open/close
 * wiring is keyed on `open` alone so a parent re-render never re-runs it, and the dialog is portal-rendered
 * into `document.body` so nothing that happens to the panel underneath it - a refresh, a tab swap, a
 * loading state - can take the confirmation away while an administrator is reading it. A delete that
 * vanishes mid-confirmation is worse than no dialog at all, because the click that opened it is the one
 * thing that must not be repeated from memory.
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
  const boxRef = React.useRef(null);
  const live = React.useRef({ busy, onCancel });
  live.current = { busy, onCancel };
  const restoreTo = React.useRef(null);
  const pressedOnBackdrop = React.useRef(false);

  React.useEffect(() => {
    if (!open) return undefined;
    restoreTo.current = document.activeElement;
    if (!boxRef.current?.contains?.(document.activeElement)) confirmRef.current?.focus?.();
    // Escape cancels. It is the only key this dialog answers to on purpose: a confirmation that permanently
    // deletes must never be dismissible - or provable - by whichever key a keyboard happens to be resting on.
    const onKey = (event) => { if (event.key === 'Escape' && !live.current.busy) live.current.onCancel?.(); };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      const previous = restoreTo.current;
      restoreTo.current = null;
      if (previous?.isConnected && typeof previous.focus === 'function') previous.focus();
    };
  }, [open]);

  if (!open) return null;
  const dialog = (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => { pressedOnBackdrop.current = event.target === event.currentTarget; }}
      onMouseUp={(event) => {
        const armed = pressedOnBackdrop.current;
        pressedOnBackdrop.current = false;
        if (armed && event.target === event.currentTarget && !busy) onCancel?.();
      }}
    >
      <div ref={boxRef} className="panel modal confirm-modal" role="alertdialog" aria-modal="true" aria-labelledby="confirm-modal-title">
        <h3 id="confirm-modal-title">{title}</h3>
        <div className="confirm-modal-body">{children}</div>
        <div className="modal-actions">
          <button type="button" className="button button-secondary" onClick={() => onCancel?.()} disabled={busy}>{cancelLabel}</button>
          <button type="button" className={`button ${tone === 'danger' ? 'button-danger' : 'button-primary'}`} ref={confirmRef} onClick={() => onConfirm?.()} disabled={busy}>{busy ? 'Working…' : confirmLabel}</button>
        </div>
      </div>
    </div>
  );
  return typeof document === 'undefined' ? dialog : createPortal(dialog, document.body);
}
