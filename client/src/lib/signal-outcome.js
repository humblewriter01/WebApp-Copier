/**
 * One reading of what happened to a captured signal. The server records the outcome and the reason;
 * this file only turns them into words, and never into an assumption: a signal with no note is
 * described by its status alone, because inventing a reason here is how a UI ends up reassuring
 * somebody about a trade that never happened.
 */
const OUTCOMES = {
  received: { label: 'Saved for review', tone: 'muted' },
  unparsed: { label: 'No clear signal', tone: 'muted' },
  queued: { label: 'Sent for execution', tone: 'busy' },
  submitting: { label: 'Sending to broker', tone: 'busy' },
  unexecuted: { label: 'Not executed', tone: 'warn' },
  skipped: { label: 'Not executed', tone: 'warn' },
  expired: { label: 'Too old to execute', tone: 'warn' },
  unknown: { label: 'Unconfirmed', tone: 'bad' },
  rejected: { label: 'Rejected by broker', tone: 'bad' },
  executed: { label: 'Executed', tone: 'good' },
  filled: { label: 'Filled', tone: 'good' },
};

/**
 * A free or unlinked workspace still captures every message; what it sees is an outcome that names
 * the missing piece. Upgrade wording is recognised so the panel can offer the way forward instead of
 * leaving the user to conclude that Signal Desk ignored them.
 */
export function signalOutcomeView(signal) {
  const status = String(signal?.status || 'received');
  const note = typeof signal?.executionNote === 'string' && signal.executionNote.trim()
    ? signal.executionNote.trim()
    : '';
  const known = OUTCOMES[status];
  const upgradeRequired = /upgrade to|paid plan/i.test(note);
  return {
    status,
    label: known?.label || status.replace(/_/g, ' '),
    tone: known?.tone || 'muted',
    note,
    upgradeRequired,
    showNote: Boolean(note),
  };
}

/** Whether a list of captured signals needs a word of explanation above it. */
export function signalsAwaitingUpgrade(signals) {
  return Array.isArray(signals) && signals.some((signal) => signalOutcomeView(signal).upgradeRequired);
}
