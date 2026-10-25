/**
 * What kind of order a signal asks for, how long it stays alive, and what the market has to look like
 * before it is worth sending.
 *
 * Three decisions used to be made in three different places, and each of them touches money:
 *
 *  - the *type* of order a message asks for (read in `signal-parser.js`, honoured here);
 *  - whether the live price is close enough to the price the channel published to be worth taking at all;
 *  - how long a resting order stays on the broker's book before it is a liability instead of an entry.
 *
 * They live together because they are the same question asked three times: *is the trade the channel
 * described still the trade on offer?* A limit order whose level has been passed is not a limit order any
 * more; a market order 40 points through the published price is a different trade with the same symbol; and
 * an order left on the book for three days after the setup expired is a bill the user has to go and cancel
 * on a platform this app cannot see.
 *
 * Everything here is pure. The engine supplies live facts and obeys the answer, which is what makes each
 * rule testable without a broker - and what keeps a future change to one rule from silently rewriting
 * another.
 */

export const ORDER_TYPES = Object.freeze(['market', 'limit', 'stop']);
export const EXPIRY_UNITS = Object.freeze(['minutes', 'hours', 'days']);
/** The ceiling the UI and the API both enforce, in days. */
export const MAX_EXPIRY_DAYS = 30;
/** A scalping signal's resting order lives two minutes. Not a preference - a scalp that has not filled in
 * two minutes is a different trade, and the user chose `SCALPING` precisely because the level is fleeting. */
export const SCALP_EXPIRY_MS = 2 * 60_000;
export const DEFAULT_EXPIRY = Object.freeze({ value: 30, unit: 'minutes' });

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export function expiryUnitMs(unit) {
  if (unit === 'hours') return HOUR_MS;
  if (unit === 'days') return DAY_MS;
  if (unit === 'minutes' || unit === null || unit === undefined || unit === '') return MINUTE_MS;
  return null;
}

/**
 * The absolute deadline for an order, and the broker-side expiry that goes with it.
 *
 * `pendingOrder` decides whether the deadline is *sent* to the broker: a market order cannot carry an
 * expiration (MT4/MT5 reject one), so its deadline exists only to expire the queued job and to tell the
 * reader that the setup is time-boxed. A resting order gets both, because the broker's own expiry is the
 * only guarantee that survives this service being asleep, and the sweeper is the guarantee that survives
 * the broker ignoring the field.
 */
export function resolveOrderExpiry({ value = null, unit = null, isScalping = false, pendingOrder = false, now = Date.now() } = {}) {
  const scalp = isScalping === true;
  const requested = scalp ? SCALP_EXPIRY_MS : expiryWindowMs({ value, unit });
  const explicit = isUsableExpiry({ value, unit });
  // A window is clamped rather than refused: a stored setting can predate this limit, and a deadline that
  // quietly means "never" is worse for the user than one that means "thirty days".
  const bounded = Math.min(Math.max(requested, MINUTE_MS), MAX_EXPIRY_DAYS * DAY_MS);
  return {
    windowMs: bounded,
    expiresAt: Number(now) + bounded,
    // Only a resting order tells the broker when to forget about it. `ORDER_TIME_SPECIFIED` is the one
    // expiration type both platforms support (MT4 has nothing else), and an absolute timestamp is what the
    // sweeper compares against, so the two halves of the system cannot disagree about the deadline.
    brokerExpiration: pendingOrder === true ? { type: 'ORDER_TIME_SPECIFIED', time: new Date(Number(now) + bounded) } : null,
    // Which knob the deadline came from, so a trade's note can say so instead of inventing a number.
    source: scalp ? 'scalping' : (explicit ? 'setting' : 'default'),
    clamped: bounded !== requested,
  };
}

const DEFAULT_WINDOW_MS = DEFAULT_EXPIRY.value * MINUTE_MS;

/** The workspace's own number and unit, in milliseconds, or the default when either is unusable. */
export function isUsableExpiry({ value = null, unit = null } = {}) {
  const perUnit = expiryUnitMs(unit);
  const number = Number(value);
  return perUnit !== null && Number.isFinite(number) && number > 0;
}

/**
 * The settings route's validator for the expiry, and the engine's reader of the same value.
 *
 * One function decides what a legal expiry is, because the two answers cannot be allowed to drift: a route
 * that accepted 45 days while the engine clamped to 30 would store a number the panel keeps showing and the
 * orders keep ignoring, which is a lie in the settings and a surprise on the book.
 *
 * Blank is not an error - it is "the workspace never chose", which resolves to the documented default. A
 * value that is present and unusable is refused with the limit in the sentence, so the fix is obvious from
 * the message rather than from this file.
 */
export function readExpirySetting({ value = null, unit = null } = {}) {
  const blank = (candidate) => candidate === null || candidate === undefined || (typeof candidate === 'string' && candidate.trim() === '');
  if (blank(value) && blank(unit)) return { value: DEFAULT_EXPIRY.value, unit: DEFAULT_EXPIRY.unit, error: null };
  const chosenUnit = blank(unit) ? DEFAULT_EXPIRY.unit : String(unit).trim().toLowerCase();
  if (!EXPIRY_UNITS.includes(chosenUnit)) {
    return { value: null, unit: null, error: `Limit order expiry unit must be one of: ${EXPIRY_UNITS.join(', ')}.` };
  }
  if (typeof value !== 'number' && typeof value !== 'string') {
    return { value: null, unit: null, error: `Limit order expiry must be a whole number of ${chosenUnit} between 1 and ${expiryCeiling(chosenUnit)}.` };
  }
  const number = Number(String(value).trim());
  if (!Number.isInteger(number) || number < 1) {
    return { value: null, unit: null, error: `Limit order expiry must be a whole number of ${chosenUnit} between 1 and ${expiryCeiling(chosenUnit)}.` };
  }
  if (number * expiryUnitMs(chosenUnit) > MAX_EXPIRY_DAYS * DAY_MS) {
    return { value: null, unit: null, error: `A limit order can stay open for at most ${MAX_EXPIRY_DAYS} days.` };
  }
  return { value: number, unit: chosenUnit, error: null };
}

export function expiryCeiling(unit) {
  if (unit === 'hours') return MAX_EXPIRY_DAYS * 24;
  if (unit === 'days') return MAX_EXPIRY_DAYS;
  return MAX_EXPIRY_DAYS * 24 * 60;
}

/**
 * The drift guard. Blank and zero mean the same thing and both are kept: a workspace that left the field
 * alone and one that deliberately wrote 0 both get "never pay more than the published price", which is the
 * behaviour every existing workspace already has. A negative or non-integer is refused rather than clamped,
 * because a clamped guard is a guard nobody voted for.
 */
export function readSlippageSetting(value = null) {
  if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) return { value: null, error: null };
  if (typeof value !== 'number' && typeof value !== 'string') {
    return { value: null, error: 'The price drift guard must be a whole number of points, or blank to refuse any unfavourable fill.' };
  }
  const number = Number(String(value).trim());
  if (!Number.isInteger(number) || number < 0 || number > MAX_SLIPPAGE_POINTS) {
    return { value: null, error: `The price drift guard must be a whole number of points between 0 and ${MAX_SLIPPAGE_POINTS}, or blank to refuse any unfavourable fill.` };
  }
  return { value: number, error: null };
}

export const MAX_SLIPPAGE_POINTS = 100_000;

export function expiryWindowMs({ value = null, unit = null } = {}) {
  const perUnit = expiryUnitMs(unit);
  const number = Number(value);
  if (perUnit === null || !Number.isFinite(number) || number <= 0) return DEFAULT_WINDOW_MS;
  return Math.round(number) * perUnit;
}

/**
 * The slippage answer for a market order. This is the rule the whole feature turns on, so it is stated in
 * full before the code:
 *
 *   Better than the published price is never a reason to skip. A channel that says `BUY NOW 4110` is asking
 *   to be in at or about 4110; filling at 4109 is the same trade on better terms, and cancelling a trade
 *   because the user was given a discount is the bug this replaces.
 *
 *   Worse than the published price is the workspace's decision, not the parser's. The allowance is
 *   `max_slippage_points`, measured in the broker's own point size (the same `tickSize` the fallback
 *   distances use, so "points" means one thing everywhere in this product). Unset means zero, which is the
 *   behaviour every existing workspace already has: never fill worse than the price that was published.
 *
 * `driftPoints` is always reported, so a refusal can name the number the user has to widen, and an
 * acceptance can be written into the trade's note as the fact it is: a price that moved was a price that moved.
 */
export function marketSlippage({ side = null, desired = null, bid = null, ask = null, maxSlippagePoints = null, tickSize = null } = {}) {
  const marketPrice = side === 'buy' ? Number(ask) : side === 'sell' ? Number(bid) : NaN;
  const wanted = Number(desired);
  if (!Number.isFinite(marketPrice) || marketPrice <= 0) {
    return { action: 'skip', reason: 'no-quote', message: 'MetaAPI did not provide a valid market quote.' };
  }
  if (!Number.isFinite(wanted) || wanted <= 0) {
    // Nothing was published to compare against, so there is no drift to guard: the market order goes out on
    // the channel's own instruction to be in now. This is the `SELL GOLD` with a stop and no entry case.
    return { action: 'execute', favourable: null, driftPoints: 0, marketPrice, reason: 'no-stated-price', message: null };
  }
  const favourable = side === 'buy' ? marketPrice <= wanted : marketPrice >= wanted;
  const perPoint = Number(tickSize) > 0 ? Number(tickSize) : null;
  const distance = Math.abs(marketPrice - wanted);
  const driftPoints = perPoint ? Math.round(distance / perPoint) : null;
  if (favourable) {
    return { action: 'execute', favourable: true, driftPoints: driftPoints ?? 0, marketPrice, reason: 'better-price', message: null };
  }
  const allowance = Number.isFinite(Number(maxSlippagePoints)) && Number(maxSlippagePoints) > 0 ? Math.round(Number(maxSlippagePoints)) : 0;
  if (driftPoints === null) {
    /* Without a tick size there is no honest way to convert points to price, and "we could not measure the
       drift" is not the same as "the drift is acceptable". Refused, and said plainly. */
    return {
      action: 'skip',
      reason: 'drift-unmeasurable',
      driftPoints: null,
      marketPrice,
      message: `The market is ${distance.toPrecision(4)} away from the signal price and this symbol has no tick size to measure that in points, so the drift guard could not be applied. Set a tick size on the broker symbol or accept the trade manually.`,
    };
  }
  if (driftPoints <= allowance) {
    return {
      action: 'execute',
      favourable: false,
      driftPoints,
      marketPrice,
      allowance,
      reason: 'within-drift-guard',
      message: driftPoints > 0 ? `Entered ${driftPoints} point${driftPoints === 1 ? '' : 's'} worse than the signal price, inside your ${allowance}-point drift guard.` : null,
    };
  }
  return {
    action: 'skip',
    favourable: false,
    driftPoints,
    marketPrice,
    allowance,
    reason: 'drift-exceeded',
    message: allowance > 0
      ? `Skipped: the ${side === 'buy' ? 'ask' : 'bid'} is ${driftPoints} points ${side === 'buy' ? 'above' : 'below'} the signal price of ${wanted}, and your Price Drift Guard allows ${allowance}. Nothing was sent to your broker.`
      : `Skipped: the ${side === 'buy' ? 'ask' : 'bid'} is ${driftPoints} points ${side === 'buy' ? 'above' : 'below'} the signal price of ${wanted}, and this workspace allows no drift at all. Raise the Price Drift Guard in Advanced Settings to accept a worse fill.`,
  };
}

/**
 * The two bounds of an entry zone, or null when the row states no zone.
 *
 * `signals.entry_range` is jsonb written from the parse, and a maintenance script, an old row, or a hand edit
 * can each leave it in a shape that is not one. Refusing to read a malformed range is the conservative answer:
 * the entry price the row already holds is a real level, and a corrupt zone must not be allowed to refuse a
 * trade the message itself asked for.
 */
export function entryRangeBounds(value) {
  const source = typeof value === 'string' ? (() => { try { return JSON.parse(value); } catch { return null; } })() : value;
  if (!source || typeof source !== 'object') return null;
  const low = Number(source.low);
  const high = Number(source.high);
  if (!Number.isFinite(low) || !Number.isFinite(high) || low <= 0 || high <= 0 || !(low < high)) return null;
  return { low, high };
}

/**
 * Does this level still describe a resting order, or has the market already reached it?
 *
 * A pending order is a request to be filled at a *specific* price, and both platforms refuse one whose price
 * is on the wrong side of the current quote (a buy limit at or above the ask is not a limit, it is a market
 * order the server will reject). Refusing to send it and telling the user why is the whole job here. The
 * answer is deliberately not "skip": a level already passed is a signal the channel wants entered now, so it
 * becomes a market order, and `marketSlippage` then decides whether the price is still acceptable. That is
 * also exactly the scalping rule, applied to everything - `isScalping` does not get a special path, it just
 * has a shorter fuse.
 *
 * An entry published as a **limit against a zone** is the case where "already passed" is not the whole
 * question, so `entryRange` is asked first. A buy zone of 4016 - 4026 with the ask at 4010 has not been offered a bargain:
 * the market has fallen through the entire range the channel described, and a trade taken there is a trade
 * nobody published. That is a refusal. The other two answers fall out of the arithmetic below once the far
 * edge has been ruled out - above the zone the credited bound is still on the resting side of the quote, so
 * the order waits at it, and inside the zone the quote has already reached it, so the trade is taken now.
 */
export function pendingOrderPlan({ orderType = null, entryPrice = null, side = null, bid = null, ask = null, stopsLevelPoints = null, tickSize = null, entryRange = null } = {}) {
  if (!ORDER_TYPES.includes(orderType)) return { kind: 'market', reason: 'not-a-resting-order' };
  // Stated before the arithmetic rather than left to the caller's guard: a market order has no level to be
  // on the right or wrong side of, and reading `market` through the stop branch would rest one at the price.
  if (orderType === 'market') return { kind: 'market', reason: 'channel asked for the market' };
  const level = Number(entryPrice);
  if (!Number.isFinite(level) || level <= 0) {
    return { kind: 'market', reason: 'no-level-to-rest-at', note: 'This signal states no entry price, so there is nothing to rest an order at - it is sent as a market order.' };
  }
  const market = side === 'buy' ? Number(ask) : Number(bid);
  if (!Number.isFinite(market) || market <= 0) return { kind: 'skip', reason: 'no-quote', message: 'A live quote is needed to decide how to send this order.' };
  /* Only a **limit** is measured against the range. A stop entry waits for the market to break *through* its
     level, so a price on the far side of a zone is exactly what that order is for, and refusing it would
     remove the one case where being early is the plan. */
  const zone = orderType === 'limit' ? entryRangeBounds(entryRange) : null;
  if (zone) {
    /* The far edge of a zone is the end of the setup, not a better price. Asked before the resting test on
       purpose: a market that has gone through the whole zone also "fills immediately" by the arithmetic below,
       and answering that with a market entry is exactly the mistake being refused here. */
    const pastTheZone = side === 'buy' ? market < zone.low : market > zone.high;
    if (pastTheZone) {
      return {
        kind: 'skip',
        reason: 'zone-past-far-edge',
        message: `The market has moved past the entire entry zone. The ${side === 'buy' ? 'ask' : 'bid'} is ${market} and this ${side === 'buy' ? 'buy' : 'sell'} zone ran ${zone.low} to ${zone.high}, so the setup the channel published has already been and gone. Nothing was sent to your broker.`,
      };
    }
  }
  const resting = orderType === 'limit'
    ? (side === 'buy' ? level < market : level > market)
    : (side === 'buy' ? level > market : level < market);
  if (!resting) {
    return {
      kind: 'market',
      reason: 'level-would-fill-now',
      note: zone
        ? `The market is already inside the entry zone (${zone.low} - ${zone.high}), so this is taken at the current price rather than waited for.`
        : `The market is already at a price where your ${orderType} level of ${level} fills immediately, so this is sent as a market entry rather than rested.`,
      /* A market fill against a signal that published a range has to be explained on the row and not only in
         the log: the range was honoured, the market simply happened to already be inside it. */
      ...(zone ? { readerNote: `The market was already inside the ${zone.low} - ${zone.high} entry zone, so the trade was taken at the current price instead of waited for.`, zone } : {}),
    };
  }
  const perPoint = Number(tickSize) > 0 ? Number(tickSize) : null;
  const minimum = Number(stopsLevelPoints) > 0 ? Number(stopsLevelPoints) : 0;
  const distance = perPoint ? Math.round(Math.abs(level - market) / perPoint) : null;
  if (minimum > 0 && distance !== null && distance < minimum) {
    // A *limit* that close to the market would fill on the next tick anyway, so it is sent as a market order;
    // a *stop* that close is the broker's definition of an invalid price, and it is refused rather than
    // quietly moved - moving it would be choosing an entry the channel did not publish.
    if (orderType === 'limit') return { kind: 'market', reason: 'level-too-close', note: `The ${orderType} level is ${distance} points from the market and the broker keeps ${minimum}, so it is taken now instead of rested.` };
    return {
      kind: 'skip',
      reason: 'level-inside-stops-level',
      message: `Skipped: the ${orderType} price of ${level} is ${distance} points from the market and this broker requires pending orders at least ${minimum} points away. Nothing was sent to your broker.`,
    };
  }
  return { kind: 'pending', reason: 'level-resting', price: level, ...(zone ? { zone } : {}) };
}

/**
 * What a resting order on the broker's book has become since we last looked.
 *
 * The failure this prevents is the ghost: a user deletes a pending order in MT4, this app goes on showing
 * "pending", and the next person who reads the panel believes there is an order waiting to spend their money.
 *
 * The rule that keeps it honest is that *only a good read counts*. A disconnected account, an unsynchronized
 * terminal or a failed request leaves the row exactly as it is, because "I cannot see it" is not "it is gone"
 * - inferring a cancellation from an outage would cancel live orders the next sweep around.
 */
export function pendingOrderOutcome({ readOk = false, orderStillOpen = false, positionFound = false, dealFound = false, expiryReached = false, cancelConfirmed = false, position = null, deal = null } = {}) {
  if (readOk !== true) {
    return { action: 'defer', reason: 'account-unreadable', message: 'The broker account could not be read, so this order was left as it is.' };
  }
  if (orderStillOpen === true) return { action: 'wait', reason: 'still-on-book' };
  if (positionFound === true || dealFound === true) {
    return {
      action: 'filled',
      reason: 'order-became-a-position',
      positionId: position?.positionId ?? position?.id ?? deal?.positionId ?? null,
      entryPrice: Number(position?.openPrice ?? position?.price ?? deal?.price ?? NaN),
      volume: Number(position?.volume ?? deal?.volume ?? NaN),
    };
  }
  /* Our own cancellation, at or after the deadline, is an expiry by any name: the row has to say what made
     the order leave the book, and what made it leave was the clock. A cancel we sent *before* the deadline is
     the other case, and it does not exist yet in this app - which is why it is answered rather than omitted. */
  if (expiryReached === true) {
    return { action: 'expired', reason: cancelConfirmed === true ? 'expiry-passed-and-cancelled-here' : 'expiry-passed-and-order-gone' };
  }
  if (cancelConfirmed === true) return { action: 'cancelled', reason: 'cancel-accepted' };
  // Not on the book, not filled, and not something we cancelled: the user took it off the account.
  return { action: 'cancelled', reason: 'removed-at-broker' };
}

/**
 * Whether a `cancel` reply from the broker means the order is gone.
 *
 * MetaAPI reports a rejection as a thrown `TradeError` far more often than as a returned code, and the two
 * codes that matter here mean opposite things: `10025` (done) is a cancellation, while `TRADE_RETCODE_ORDER_STATE_INVALID`/`10023`
 * ("already dealing" / order no longer there) means the order left the book by itself - which is the same
 * outcome for the row, but is *not* a fill, so the caller has to look for the position before deciding what
 * the trade became.
 */
export function interpretCancelResponse({ error = null, result = null } = {}) {
  const code = error?.stringCode ?? error?.code ?? result?.stringCode ?? result?.code ?? null;
  const numeric = Number(error?.numericCode ?? error?.retcode ?? result?.numericCode ?? result?.retcode ?? NaN);
  const message = String(error?.message ?? result?.message ?? '').slice(0, 300);
  if (numeric === 10025 || /order_cancel|trade_retcode_done/i.test(String(code || ''))) return { kind: 'cancelled', message };
  if (numeric === 10023 || numeric === 10024 || /not found|no order|does not exist|already (been )?(closed|cancelled|dealt)|order state|invalid price/i.test(message)) {
    return { kind: 'gone', message };
  }
  // Only after the two readings that mean something: MetaAPI throws far more often than it returns a code, so
  // an error carrying prose and no number is "we cannot tell", not "refused".
  if (error && !Number.isFinite(numeric) && !code) return { kind: 'unknown', message: message || 'The broker did not answer the cancellation.' };
  return { kind: 'rejected', message: message || `The broker refused the cancellation (${code || numeric || 'unknown code'}).` };
}
