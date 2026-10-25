import React from 'react';
import { createPortal } from 'react-dom';

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
 *
 * ## Why the effects here are written the way they are
 *
 * Every keystroke in one of these forms is a `setState` in the *parent*, and the parent passes this dialog
 * fresh `onCancel` and `busy` props each time. An effect that listed either as a dependency therefore ran
 * its cleanup and setup again per character typed - which used to mean the first field was re-focused on
 * every keystroke. In the Adjust-plan dialog that moves the caret out of the Reason input into the plan
 * `<select>`, and on a phone it closes the soft keyboard as it does so: the form stops accepting what the
 * administrator is typing, which reads as the dialog breaking. So the effect is keyed on `open` alone and
 * reads the live values through a ref, and focus is placed once per opening, and only when the browser has
 * not already put the caret inside this dialog.
 *
 * The dialog is also rendered into `document.body` rather than left in the panel's own subtree. A dialog
 * that lives inside a parent's conditional rendering is a dialog that parent can close by re-rendering -
 * the admin panel refreshes its list, swaps a tab, or shows a loading shell, and the form the user was
 * typing into is gone with it. Its *state* still belongs to the caller (the panel needs the reason to send
 * it), but its place in the tree does not.
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
  // Read at event time, never captured: these two change on every parent render, and nothing may re-bind
  // per keystroke - neither the keydown listener nor the focus call below.
  const live = React.useRef({ busy, onCancel });
  live.current = { busy, onCancel };
  const restoreTo = React.useRef(null);
  // A backdrop press that *started* inside the dialog can never dismiss it. On a phone, closing the keyboard
  // shifts the layout under the finger, and the browser then reports the release - and sometimes a whole
  // synthetic click - at coordinates that have since moved to the backdrop.
  const pressedOnBackdrop = React.useRef(false);

  React.useEffect(() => {
    if (!open) return undefined;
    restoreTo.current = document.activeElement;
    const field = formRef.current?.querySelector?.('input:not([disabled]),select:not([disabled]),textarea');
    if (field && !formRef.current.contains(document.activeElement)) field.focus?.();
    const onKey = (event) => { if (event.key === 'Escape' && !live.current.busy) live.current.onCancel?.(); };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      const previous = restoreTo.current;
      restoreTo.current = null;
      // The row the button lived in may have been re-rendered or paged away while the dialog was open, in
      // which case the node is gone and focus has to stay where the browser left it.
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
  // `renderToStaticMarkup` has no DOM to portal into, and React's server renderer does not support portals
  // at all; the component tests that read this dialog's markup render it where it stands.
  return typeof document === 'undefined' ? dialog : createPortal(dialog, document.body);
}
