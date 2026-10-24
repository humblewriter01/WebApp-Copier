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
  // Not "rejected": the account itself was refused, so the next signal will not fare better until the
  // workspace fixes what the note on this row says to fix.
  failed: { label: 'Blocked by a broker error', tone: 'bad' },
  executed: { label: 'Executed', tone: 'good' },
  filled: { label: 'Filled', tone: 'good' },
};

/** Whether the message said anything about a trade at all, whatever became of it. */
export function signalHasTradingData(signal) {
  return Boolean(signal?.symbol
    || signal?.side
    || signal?.entryPrice != null
    || signal?.stopLoss != null
    || signal?.takeProfit != null
    // A distance is a price the channel stated, just not in price units, so it counts here too.
    || signal?.stopLossPips != null
    || signal?.takeProfitPips != null);
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
  /* The review flag is stated separately from the status because it answers a different question. "unparsed"
     means nothing usable came out of the message; needs-review means something *did*, and the platform will
     not act on it without a person. A row can be complete, well-formed, and still be one a human has to
     look at - which is precisely the case an automated trade must not be made from. */
  const needsReview = signal?.needsReview === true;
  const upgradeRequired = /upgrade to|paid plan/i.test(note);
  return {
    status,
    label: needsReview ? 'Needs Review'
      : (unclear ? 'No clear signal'
        : (status === 'unparsed' ? 'Needs review' : (known?.label || status.replace(/_/g, ' ')))),
    tone: needsReview ? 'warn' : (known?.tone || 'muted'),
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
  /* A message that names a level but not the entry is not missing the entry: it asked to be filled at the
     market. Without this the row's meta line simply has no "Entry" in it, and an absent leg and an unstated
     one look identical. Deliberately keyed off a *stated* price rather than `signalHasTradingData`, which
     also answers true for a row that only yielded a word for a symbol - that one has nothing to be a market
     order about, and it already wears a "Missing SL" badge. */
  const statesDistance = signal?.stopLossPips != null || signal?.takeProfitPips != null;
  if (signal?.entryPrice == null && signal?.source === 'telegram' && (signal?.stopLoss != null || signal?.takeProfit != null || statesDistance)) {
    badges.push({ key: 'market', label: 'Market', tone: 'muted', title: 'The message did not name an entry price, so it is not waiting for one: it goes to the broker as a market order, filled at the current ask for a buy or the current bid for a sell.' });
  }
  /* A stop given as `SL 30 pips` is not a missing stop, and saying it is would point the reader at a Safety
     setting they do not need to touch - the distance is there, it is only in the unit only the broker can
     turn into a price. So every "missing" badge is checked against both forms of the leg. */
  if (signal?.stopLoss == null && signal?.stopLossPips == null && signal?.source === 'telegram') {
    badges.push({ key: 'missing-stop', label: 'Missing SL', tone: 'warn', title: 'No stop loss in the message. A fallback distance in your Safety settings can supply one; otherwise nothing is sent while the stop-loss block is on, and with that block off the trade goes out unprotected, which is recorded as an override.' });
  }
  if (signal?.takeProfit == null && signal?.takeProfitPips == null && signal?.source === 'telegram') {
    badges.push({ key: 'missing-target', label: 'Missing TP', tone: 'muted', title: 'No target in the message. Your Safety settings decide whether that stops an order: a fallback distance can supply a target, and with the take-profit block off the position is opened with nothing planned to close it.' });
  }
  /* Provenance, on the face of the row. Two of these legs came from a model, and a number a model reported
     deserves to look different from a number a channel wrote, even when both are correct: it is the one
     difference a reader cannot reconstruct afterwards from the price itself. */
  if (signal?.llmUsed === true && signal?.parsedBy === 'llm') {
    const confidence = Number(signal?.parseConfidence);
    badges.push({
      key: 'ai',
      label: 'AI Parsed',
      tone: 'ai',
      title: `Part of this signal was too garbled for the built-in reader, so an AI reading assistant finished it${Number.isFinite(confidence) ? ` (it reported ${Math.round(confidence * 100)}% confidence)` : ''}. Every price it supplied was checked against the digits in the message; what it had to interpret is what the badge is for.`,
    });
  }
  for (const [key, label, leg, title] of [
    ['pips-stop', 'Pips SL', signal?.stopLossPips, 'The stop loss was written as a distance in pips rather than a price, so it is measured from the market price at the moment the order goes out, using the broker\'s own price step.'],
    ['pips-target', 'Pips TP', signal?.takeProfitPips, 'The target was written as a distance in pips rather than a price, so it is measured from the market price at the moment the order goes out, using the broker\'s own price step.'],
  ]) {
    if (leg == null) continue;
    badges.push({ key, label: `${label} ${leg}`, tone: 'muted', title });
  }
  return badges;
}

/** Whether a list of captured signals needs a word of explanation above it. */
export function signalsAwaitingUpgrade(signals) {
  return Array.isArray(signals) && signals.some((signal) => signalOutcomeView(signal).upgradeRequired);
}
