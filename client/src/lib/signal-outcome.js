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
  // The order is on the broker's book and this app is watching it: neither a trade nor a refusal.
  pending: { label: 'Waiting at your price', tone: 'busy' },
  cancelled: { label: 'Cancelled', tone: 'muted' },
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
 * Whether the row carries a number that could be a price - as a level or as a distance.
 *
 * This is the client's copy of the server's `hasPriceLevel`, and it is the line between "the channel asked
 * for a trade and forgot a leg" and "this message is not about a trade". It is recomputed from the stored
 * legs rather than shipped as a flag, because it is a question with one honest answer: a row has a price if
 * its price columns are not all null.
 */
export function signalStatesAPrice(signal) {
  return signal?.entryPrice != null
    || signal?.stopLoss != null
    || signal?.takeProfit != null
    || signal?.stopLossPips != null
    || signal?.takeProfitPips != null;
}

/**
 * The entry a zone signal shows: the range the channel published, with the bound in force named on hover.
 *
 * A row that reads `Entry 4026` for `BUY GOLD ZONE 4016 - 4026` is half wrong twice. The channel never offered
 * one number, and the number displayed is deliberately the *worst* edge of the range - that is what lets a fill
 * anywhere inside the zone be taken without ever looking worse than what was published. Both halves are facts
 * the reader is owed, so the meta line widens to the zone and the hover text names the credited edge and what
 * the order does at each position of the market relative to it.
 *
 * Returns null for a row with no zone, or one whose stored range is not a range: the single-price display is
 * then left exactly as it was, rather than showing `Entry undefined - undefined` for a corrupt column.
 */
export function entryZoneView(signal) {
  const range = signal?.entryRange;
  if (!range || typeof range !== 'object') return null;
  const low = Number(range.low);
  const high = Number(range.high);
  if (!Number.isFinite(low) || !Number.isFinite(high) || !(low < high)) return null;
  const credited = Number(signal?.entryPrice);
  const hasCredited = Number.isFinite(credited) && credited > 0;
  const selling = String(signal?.side || '').toLowerCase() === 'sell';
  const edge = hasCredited
    ? `The order is credited with ${credited}, the ${selling ? 'lower' : 'upper'} edge - the bound worst for a ${selling ? 'sell' : 'buy'} - so a fill anywhere inside the zone is never reported as a worse price than the channel published.`
    : 'No bound is credited, because the message stated no direction to pick one with.';
  const orderType = String(signal?.orderType || 'market').toLowerCase();
  const resting = orderType === 'limit' || orderType === 'stop';
  const behaviour = resting
    ? 'Above the zone the order rests at that edge and waits for the market to come to it; inside the zone it is taken at once; past the far edge it is refused, because a market that ran through the whole range is a dead setup rather than a bargain.'
    : 'This row does not wait for the zone - the message asked to be filled at the market - so the range is shown for context.';
  return {
    low,
    high,
    credited: hasCredited ? credited : null,
    text: `${low} - ${high}`,
    title: `Entry zone as published: ${low} - ${high}. ${edge} ${behaviour}`,
  };
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
  /* A row with no order type is not a row of unknown type: the column is NOT NULL with a default, and every
     signal captured before it existed was, in fact, a market order. Defaulting to that reading is the honest
     one, and it is what keeps history from losing its badge. */
  const orderType = String(signal?.orderType || 'market').toLowerCase();
  const telegram = signal?.source === 'telegram';
  /* Which kind of order the message asks for, and - just as importantly - whether it asked or we inferred.
     A channel that wrote `LIMIT 4011` wants an order on the book; a channel that wrote a price and nothing
     else gets one because a price that was published is a price the trader meant to be filled at. The second
     case wears a warning tone because it is this product making a choice on the reader's behalf, and the
     sentence says exactly how to overrule it. */
  const resting = orderType === 'limit' || orderType === 'stop';
  if (telegram && resting) {
    const level = signal?.entryPrice;
    const zoneForBadge = entryZoneView(signal);
    badges.push({
      key: 'order-type',
      label: orderType === 'stop' ? 'Stop Order' : 'Limit Order',
      tone: signal?.orderTypeStated === true ? 'busy' : 'warn',
      title: signal?.orderTypeStated === true
        ? `The channel asked for this trade to rest at ${level ?? 'its price'} rather than be filled at the market. Signal Desk places it as a pending order on your broker account, and takes it off when its expiry passes.`
        : (zoneForBadge
          // A zone is the one case where resting the order is not a choice made *instead* of reading the
          // message - the range is the message - so the sentence says what the order does at each side of it.
          ? `Nothing in this message said LIMIT or STOP, and it published a zone rather than a price. The order waits at ${level ?? 'the bound worst for this side'} until the market comes into ${zoneForBadge.text}, is taken at the market if the price is already inside the zone, and is refused once the market has moved past the far edge. Write NOW or CMP in the channel if you want it taken immediately.`
          : `Nothing in this message said LIMIT or STOP. It published ${level ?? 'an entry price'} without asking to be filled at the market, so an order is rested at that price instead of paying whatever the market is doing. Write NOW or CMP in the channel if you want it taken immediately.`),
    });
  }
  /* The one market case worth a pill is the one that otherwise reads as a gap: a telegram signal whose entry
     line is empty looks like a signal that forgot its price, when it is a signal that refused to name one.
     A market order that *did* publish a price needs no badge, because nearly every signal is one, and a pill
     on it would teach nobody to read it. */
  if (!resting && telegram && signal?.entryPrice == null && signalStatesAPrice(signal)) {
    badges.push({ key: 'market', label: 'Market', tone: 'muted', title: 'The message did not name an entry price, so it is not waiting for one: it goes to the broker as a market order, filled at the current ask for a buy or the current bid for a sell.' });
  }
  if (signal?.isScalping === true) {
    badges.push({ key: 'scalping', label: 'Scalping', tone: 'muted', title: 'The message was marked as a scalp. An order for it lives for two minutes instead of your Limit Order Expiry setting, and if the market is already at the level it is taken at once rather than waited for.' });
  }
  /* A stop given as `SL 30 pips` is not a missing stop, and saying it is would point the reader at a Safety
     setting they do not need to touch - the distance is there, it is only in the unit only the broker can
     turn into a price. So every "missing" badge is checked against both forms of the leg. */
  /* The missing-leg pills are advice, and advice has to be earned: "your signal has no stop" is true of a
     message that named an entry and a target, and noise on a message that was never about a trade. The card
     in the screenshot wearing `Missing SL` and `Missing TP` over "Should I release more setups, guys?" was
     the second case - two pills telling a user to fix a signal that did not exist. */
  const missingLegs = signal?.source === 'telegram' && signalStatesAPrice(signal);
  if (signal?.stopLoss == null && signal?.stopLossPips == null && missingLegs) {
    badges.push({ key: 'missing-stop', label: 'Missing SL', tone: 'warn', title: 'No stop loss in the message. A fallback distance in your Safety settings can supply one; otherwise nothing is sent while the stop-loss block is on, and with that block off the trade goes out unprotected, which is recorded as an override.' });
  }
  if (signal?.takeProfit == null && signal?.takeProfitPips == null && missingLegs) {
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
