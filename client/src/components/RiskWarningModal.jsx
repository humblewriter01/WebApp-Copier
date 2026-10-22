import React from 'react';

/**
 * The one place the live-money warning is written down. It is shown as a decision, in a modal, the
 * first time a workspace switches Auto-Trading on - and it is never shown again once the answer has
 * been stored, because a warning everybody has already agreed to is decoration, not information.
 */
export const RISK_WARNING_COPY = Object.freeze({
  title: 'Before you trade live',
  body: 'Warning: Enabling Auto-Trading will execute live trades on your connected broker account. You are fully responsible for any financial losses.',
  points: [
    'Use a demo account while you are testing. A live account places real orders with real money.',
    'An order that has already reached the broker cannot be recalled from Signal Desk - close it in your trading terminal.',
    'You can turn Auto-Trading off at any time, and no new signals will be sent while it is off.',
  ],
  confirm: 'I Understand',
  cancel: 'Cancel',
});

/** A subtle, permanent reminder - the opposite of a wall of red that everybody learns to ignore. */
export const RISK_REMINDER = 'Auto-Trading executes live orders. Trade at your own risk.';

/**
 * Whether the acknowledgement has to be asked for. Only an *increase* to Auto-Trading needs it, and
 * a workspace that has already confirmed never sees the dialog again - including after it switches
 * trading off and back on, which is a decision they have already made once, knowingly.
 */
export function needsRiskAcknowledgement(settings) {
  return settings?.autoTradingEnabled !== true && settings?.hasAcceptedRiskWarning !== true;
}

export default function RiskWarningModal({ open = false, onCancel, onConfirm, saving = false }) {
  const confirmRef = React.useRef(null);

  React.useEffect(() => {
    if (!open) return undefined;
    const previous = document.activeElement;
    confirmRef.current?.focus?.();
    const onKeyDown = (event) => {
      // Escape is Cancel: closing the dialog must never be the thing that enables trading.
      if (event.key === 'Escape') {
        event.preventDefault();
        if (!saving) onCancel?.();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      if (previous && typeof previous.focus === 'function' && document.contains(previous)) previous.focus();
    };
  }, [open, saving, onCancel]);

  if (!open) return null;
  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !saving) onCancel?.();
      }}
    >
      <div className="panel modal risk-warning-modal" role="alertdialog" aria-modal="true" aria-labelledby="risk-warning-title" aria-describedby="risk-warning-body">
        <h3 id="risk-warning-title">{RISK_WARNING_COPY.title}</h3>
        <p className="risk-warning-body" id="risk-warning-body">{RISK_WARNING_COPY.body}</p>
        <ul className="risk-warning-points">
          {RISK_WARNING_COPY.points.map((point) => <li key={point}>{point}</li>)}
        </ul>
        <div className="modal-actions">
          <button type="button" className="button button-secondary" onClick={onCancel} disabled={saving}>{RISK_WARNING_COPY.cancel}</button>
          <button type="button" className="button button-primary risk-warning-confirm" ref={confirmRef} onClick={onConfirm} disabled={saving}>{RISK_WARNING_COPY.confirm}</button>
        </div>
      </div>
    </div>
  );
}
