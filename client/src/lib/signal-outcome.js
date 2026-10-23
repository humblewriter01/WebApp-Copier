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

/** Whether the message said anything about a trade at all, whatever became of it. */
export function signalHasTradingData(signal) {
  return Boolean(signal?.symbol
    || signal?.side
    || signal?.entryPrice != null
    || signal?.stopLoss != null
    || signal?.takeProfit != null);
}

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
  // "No clear signal" is a claim about the message, not about the parser's mood, so it is only made
  // when nothing usable came out of it. A readable note that is missing a piece says "Needs review"
  // and quotes the server's own sentence underneath.
  const unclear = status === 'unparsed' && !signalHasTradingData(signal);
  const upgradeRequired = /upgrade to|paid plan/i.test(note);
  return {
    status,
    label: unclear ? 'No clear signal'
      : (status === 'unparsed' ? 'Needs review' : (known?.label || status.replace(/_/g, ' '))),
    tone: known?.tone || 'muted',
    note,
    upgradeRequired,
    showNote: Boolean(note),
  };
}

/**
 * The small facts about a captured message that its status does not carry.
 *
 * A badge is only ever a label for something the row already says: a direction that had to be inferred,
 * or a price the channel did not provide. Nothing here guesses at why a signal was or was not traded -
 * that is what the note under it is for, in the server's own words.
 */
export function signalBadges(signal) {
  const badges = [];
  if (signal?.directionInferred === true) {
    badges.push({ key: 'inferred', label: 'Inferred', tone: 'warn', title: 'The message did not say BUY or SELL; the direction was read from the entry and target prices. It is saved for review and never traded on that basis.' });
  }
  if (signal?.stopLoss == null && signal?.source === 'telegram') {
    badges.push({ key: 'missing-stop', label: 'Missing SL', tone: 'warn', title: 'No stop loss in the message. Nothing is sent unless your Risk settings allow a trade without one.' });
  }
  if (signal?.takeProfit == null && signal?.source === 'telegram') {
    badges.push({ key: 'missing-target', label: 'Missing TP', tone: 'muted', title: 'No target in the message. A target is shown for reading only, so this alone never stopped an order.' });
  }
  return badges;
}

/** Whether a list of captured signals needs a word of explanation above it. */
export function signalsAwaitingUpgrade(signals) {
  return Array.isArray(signals) && signals.some((signal) => signalOutcomeView(signal).upgradeRequired);
}
