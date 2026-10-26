/**
 * The safety nets between a captured signal and an order.
 *
 * A provider that forgets a stop loss is not a reason to trade naked, and refusing the trade outright
 * was the only alternative until now. So a workspace may state its own distance - in broker **points**,
 * the same unit as the break-even and trailing settings - and that distance is applied to whichever
 * side of the trade the signal did not provide:
 *
 *   - the signal's own value always wins; nothing here overrides what the channel actually said;
 *   - a missing stop or target uses the workspace's fallback distance, measured from the price the
 *     order is sent at (not from the signal's stale entry), and aligned onto the symbol's tick grid
 *     *away* from the market so a rounding step can never tighten risk or trip the broker's
 *     `stopsLevel`;
 *   - with no fallback configured, the block toggles decide: refuse (the default) or send the order
 *     without that leg, which is a deliberate override and is logged as one;
 *   - a fallback that cannot be computed for this symbol - no tick size, a stop inside the broker's
 *     minimum distance, a price at or below zero - is never silently ignored. It is reported, and the
 *     block rule then applies to the leg as if no net existed.
 *
 * Two functions, both pure: `captureSafety` answers "is this message eligible at all?" at the moment the
 * row is written, and `applySafetyNets` answers "what prices go on this order?" at the moment a live
 * quote and the broker's symbol rules are known. They share the rules above, so a signal is never stored
 * as executable and then refused for the same reason, nor stored as refused and then traded.
 */

/** The narrowest fallback distance that can be entered, in broker points. */
export const MIN_FALLBACK_POINTS = 1;
/** The widest one, so a typo cannot become a stop forty charts away. */
export const MAX_FALLBACK_POINTS = 1_000_000;

export const STOP_REQUIRED_MESSAGE = 'The signal has no stop loss, and your workspace requires one before an order is sent.';
export const TARGET_REQUIRED_MESSAGE = 'Your Safety settings require a take-profit target, and this signal does not carry one.';
export const SIZING_REQUIRES_STOP_MESSAGE = 'Risk-based sizing is calculated from the stop loss, so a signal without one cannot be sized safely.';
/** The sentence an override is logged under. It names the reason a trade is unprotected. */
export const NAKED_STOP_WARNING = 'Trade executed without Stop Loss (User Override).';
export const NAKED_TARGET_WARNING = 'Trade executed without Take Profit (User Override).';

function points(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/**
 * Whether a leg states a price at all. A column that came back as `''` is not a price of zero - and
 * `Number('')` would happily say otherwise, which is how a missing stop once read as a stop at zero and
 * no fallback was ever applied to it.
 */
function statesPrice(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string' && value.trim() === '') return false;
  return points(value) !== null;
}

/**
 * A route reading: unset stays unset (no net), a usable whole number is stored, anything else is an
 * error naming what arrived. A distance is never clamped into validity - `0` and `1e9` are mistakes, and
 * guessing which one the reader meant is how a trade ends up with the wrong stop.
 */
export function readFallbackPoints(value, label = 'The fallback distance') {
  if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) return { value: null, error: null };
  // Only a number or a string can be a distance. `true` would otherwise read as 1 point and an array of
  // one element as that number - a request body that does not mean what it appears to say.
  if (typeof value !== 'number' && typeof value !== 'string') return { value: null, error: `${label} must be a whole number of points between ${MIN_FALLBACK_POINTS} and ${MAX_FALLBACK_POINTS}, or blank for no fallback.` };
  const number = points(value);
  if (number === null || !Number.isInteger(number) || number < MIN_FALLBACK_POINTS || number > MAX_FALLBACK_POINTS) {
    return { value: null, error: `${label} must be a whole number of points between ${MIN_FALLBACK_POINTS} and ${MAX_FALLBACK_POINTS}, or blank for no fallback.` };
  }
  return { value: number, error: null };
}

/**
 * What one pip is worth on this instrument, or `null` when the question has no honest answer.
 *
 * A pip is only a defined distance where the market quotes in decimals a pip can be read out of: four
 * places for a currency pair, two for one quoted in yen. On gold, an index or a crypto asset brokers write
 * "points", and a point is whatever that server decides it is - so `null` here is deliberate. Returning a
 * confident guess would turn `TP 50 pips` into a price that nobody can check, which is the failure this
 * whole file is arranged against; refusing says so in a sentence the trader can act on.
 */
const NOT_A_CURRENCY_PAIR = /^(?:XAU|XAG|XPT|XPD|BTC|ETH|LTC|XRP|SOL|DOGE|USOIL|UKOIL|WTI|BRENT|CFD)/;

export function pipSizeFor(symbol) {
  const code = String(symbol ?? '').toUpperCase().replace(/[^A-Z]/g, '');
  // `XAUUSD` is six letters and no more a currency pair than `BTCUSD` is, so the metal and coin codes are
  // excluded by name: reading a gold "pip" as 0.0001 would put a stop four decimal places from the price and
  // the broker would refuse the order - or accept it, which is worse.
  if (!/^[A-Z]{6}$/.test(code) || NOT_A_CURRENCY_PAIR.test(code)) return null;
  return code.endsWith('JPY') ? 0.01 : 0.0001;
}

/** The same reading for a value already in the database: a bad row means "no net", never a guess. */
function storedPoints(value) {
  const number = points(value);
  if (number === null) return null;
  const whole = Math.trunc(number);
  return whole >= MIN_FALLBACK_POINTS && whole <= MAX_FALLBACK_POINTS ? whole : null;
}

function priceDecimals(step) {
  const text = String(step);
  return text.includes('.') ? text.length - text.indexOf('.') - 1 : 0;
}

/** The engine's tick-grid alignment, restated here: `down` for a buy's stop, `up` for a sell's. */
function alignPrice(value, tickSize, direction) {
  const steps = value / tickSize;
  const aligned = direction === 'down' ? Math.floor(steps + 1e-6) : Math.ceil(steps - 1e-6);
  return Number((aligned * tickSize).toFixed(priceDecimals(tickSize)));
}

function distanceInPoints(price, marketPrice, tickSize) {
  return Math.abs(marketPrice - price) / (tickSize || 1);
}

/**
 * Whether a captured message may be treated as executable, given what the workspace has asked for.
 *
 * It never invents a price - the fallback is only a distance until a live quote exists. What it decides
 * is whether the *missing leg* is still a reason to refuse the signal: it is, unless a net is configured
 * to cover it or the workspace has deliberately allowed that leg to be absent.
 */
export function captureSafety({ parsed, source = 'telegram', settings = {}, review = null } = {}) {
  /* A row the pipeline will not stand behind is never rescued by a fallback distance, and this is the
     place that decides it, because this is the moment `execution_ready` is written. The order matters
     against the other rules: a net that can supply a leg is normally the end of the argument, and here the
     argument is not about a missing leg but about whether anyone should be trusting the numbers at all. A
     message the AI reader had to interpret, or could not, has already had its price levels verified against
     the text - what is being refused is the *provenance*, and no distance in a settings panel changes
     where a number came from. */
  if (review?.required) {
    return {
      executionReady: false,
      parseError: review.reason || 'This signal was saved for review and is not eligible for automatic execution.',
      fallbacks: { stopLoss: null, takeProfit: null },
      override: { stopLoss: false, takeProfit: false },
      problems: [{ code: 'review-required', message: review.reason || 'Saved for review.' }],
      reviewRequired: true,
    };
  }
  const blockers = parsed?.blockers ?? [];
  const codes = new Set(blockers.map((blocker) => blocker.code));
  const telegram = source === 'telegram';
  const stopNet = storedPoints(settings.fallbackStopLossPoints);
  const targetNet = storedPoints(settings.fallbackTakeProfitPoints);
  const blockStop = settings.blockExecutionWithoutStopLoss !== false;
  const blockTarget = settings.blockExecutionWithoutTakeProfit !== false;
  const fixedLot = String(settings.lotSizeMode || 'fixed') === 'fixed';
  // The manual-entry path never queues an order, so its row is described by the parser alone: telling a
  // user their own note is "unsafe" because it has no target would be noise about a thing that cannot trade.
  const governed = telegram;
  const resolved = new Set();
  const problems = [];

  /* A message with no price anywhere in it is not an under-specified trade, it is an announcement, and no
     distance in a settings panel may turn it into one: `BUY GOLD` with a 500-point fallback would be an
     order placed on a sentiment. The legs stay missing, the nets stay furled, and the row says why. */
  const priceless = governed && parsed?.hasPriceLevel === false;
  /* A message read as market news or as trade management carries its own reason already, and it is not "a
     direction with no price": it stated no direction either, so no policy problem belongs on top of a message
     that asked for nothing. */
  if (priceless && parsed?.newsOnly !== true && parsed?.managementUpdate !== true && (codes.has('stop-loss-missing') || parsed?.missing?.takeProfit === true)) {
    problems.push({ code: 'no-price-level', message: 'The signal states a direction but no price, so the fallback distances were not applied and nothing was executed.' });
  }

  if (governed && !priceless && codes.has('stop-loss-missing')) {
    if (stopNet !== null) resolved.add('stop-loss-missing');
    else if (!blockStop && fixedLot) resolved.add('stop-loss-missing');
    // The code is what the client keys its badge on, so it names the reason, not just the leg: an order
    // refused because the block is up and one refused because there is no stop to size a lot from are
    // two different things a reader can act on.
    else if (!blockStop) problems.push({ code: 'stop-loss-sizing', message: SIZING_REQUIRES_STOP_MESSAGE });
    else problems.push({ code: 'stop-loss-required', message: STOP_REQUIRED_MESSAGE });
  }
  // A missing target is not a parser failure at all - it is a fact about the row - so it is only ever a
  // problem when the workspace has asked for it to be one.
  // A message that named several exits has a target (`missing.takeProfit` is false), so this branch is
  // only ever reached when the channel stated no price at all - which is what the switch is about.
  if (governed && !priceless && parsed?.missing?.takeProfit === true && !codes.has('take-profit-range') && !codes.has('take-profit-invalid')) {
    if (targetNet !== null) resolved.add('take-profit-missing');
    else if (!blockTarget) resolved.add('take-profit-missing');
    else problems.push({ code: 'take-profit-required', message: TARGET_REQUIRED_MESSAGE });
  }

  const remaining = blockers.filter((blocker) => !resolved.has(blocker.code));
  const executionReady = telegram ? (remaining.length === 0 && problems.length === 0) : (parsed?.executionReady === true && problems.length === 0);
  /* Which sentence the row quotes. The workspace's own rule is the more useful one when the two say the
     same thing about the same leg - "your Safety settings require a take-profit target" explains the
     refusal, "a stop loss is required" only restates the field - so a policy problem outranks the parser
     blocker it answers. A failure the policy has nothing to say about (no direction, an unknown symbol)
     still leads, because no fallback distance fixes that. A rescued leg leaves nothing behind, so a
     signal that has become eligible quotes no error at all. */
  const ANSWERED_BY = { 'take-profit-required': 'take-profit-missing', 'no-price-level': 'stop-loss-missing' };
  const answered = new Set(problems.map((problem) => ANSWERED_BY[problem.code] ?? 'stop-loss-missing'));
  const otherBlocker = remaining.find((blocker) => !resolved.has(blocker.code) && !answered.has(blocker.code)) ?? null;
  const parseError = otherBlocker?.message ?? (problems[0]?.message ?? null);
  return {
    executionReady,
    parseError,
    fallbacks: {
      stopLoss: governed && !priceless && stopNet !== null && codes.has('stop-loss-missing') ? stopNet : null,
      takeProfit: governed && !priceless && targetNet !== null && parsed?.missing?.takeProfit === true ? targetNet : null,
    },
    override: {
      stopLoss: resolved.has('stop-loss-missing') && stopNet === null && governed,
      takeProfit: resolved.has('take-profit-missing') && targetNet === null && governed,
    },
    problems,
  };
}

/**
 * The prices that go on the order, and what had to be decided to get them.
 *
 * `sources` says where each leg came from - `signal`, `net`, `none` - which is what the trade's note and
 * the warning log are written from. `problems` names a net that exists but cannot be used for this
 * symbol, and is what the refusal says instead of a bare "no stop loss".
 */
export function applySafetyNets({
  side,
  marketPrice,
  bid,
  ask,
  tickSize,
  stopsLevelPoints,
  stopLoss,
  takeProfit,
  stopLossPips = null,
  takeProfitPips = null,
  symbol = null,
  fallbackStopLossPoints,
  fallbackTakeProfitPoints,
  blockExecutionWithoutStopLoss = true,
  blockExecutionWithoutTakeProfit = true,
  lotSizeMode = 'fixed',
} = {}) {
  const problems = [];
  const sources = { stopLoss: 'signal', takeProfit: 'signal' };
  const warnings = [];
  const price = points(marketPrice);
  const tick = points(tickSize);
  const stopsLevel = Math.max(0, points(stopsLevelPoints) ?? 0);
  /* The trap this codebase has now been caught in twice: `Number(null)` is `0`, which is a finite
     number and on the correct side of any price, so a leg the signal never stated would read as a stop
     at zero. Absent and zero are told apart before anything is decided. */
  const hasStop = statesPrice(stopLoss);
  const hasTarget = statesPrice(takeProfit);
  const stopNet = storedPoints(fallbackStopLossPoints);
  const targetNet = storedPoints(fallbackTakeProfitPoints);
  // A stop is judged against the price the position is valued at (bid for a buy, ask for a sell), while
  // a target is judged against the price it must beat (ask for a buy, bid for a sell). Getting that
  // backwards makes a correct target look like a wrong-side stop.
  const stopReference = side === 'buy' ? points(bid) : side === 'sell' ? points(ask) : null;
  const targetReference = side === 'buy' ? points(ask) : side === 'sell' ? points(bid) : null;

  /** One leg: measured from the order price, aligned away from the market, then held to the broker's own distance. */
  const net = (requested, direction, kind) => {
    if (price === null || price <= 0) return { error: 'no valid market price to measure from' };
    if (tick === null || tick <= 0) return { error: 'the broker did not report a tick size for this symbol' };
    const offset = requested * tick;
    let candidate = alignPrice(direction === 'down' ? price - offset : price + offset, tick, direction);
    if (!Number.isFinite(candidate) || candidate <= 0) return { error: 'the fallback distance would put the price at or below zero' };
    // `stopsLevel` is a minimum distance from the market; aligning away from it can only satisfy it, so
    // a shortfall here means the configured distance is simply smaller than the broker allows.
    if (stopsLevel > 0 && distanceInPoints(candidate, price, tick) < stopsLevel - 1e-9) {
      return { error: `the broker requires stops at least ${stopsLevel} points from the market, and the fallback distance is ${requested}` };
    }
    // A leg on the wrong side of the market is not that leg: a buy's stop must sit under the bid or the
    // position opens already triggering, and a buy's target must sit above the ask or it closes the
    // trade the instant it fills. A distance smaller than the spread is the common way to hit this.
    const reference = kind === 'stop' ? stopReference : targetReference;
    if (reference !== null && (kind === 'stop' ? (side === 'buy' ? candidate >= reference : candidate <= reference) : (side === 'buy' ? candidate <= reference : candidate >= reference))) {
      return { error: `the fallback distance is smaller than the current spread, so a ${kind === 'stop' ? 'stop' : 'target'} cannot sit on the correct side of the market` };
    }
    return { value: candidate };
  };

  /* A leg the channel stated as a distance is that leg, not a missing one: it is computed here, against the
     live quote and the symbol's own precision, and it outranks the workspace's fallback - the trader's 30
     pips is a better answer than the platform's default 500 points. Where a pip has no definition for the
     instrument, the distance cannot be honoured: that is reported, and the leg falls to the workspace's own
     rule with the reason attached, rather than silently becoming someone else's number. */
  const pip = pipSizeFor(symbol);
  const pipLeg = (distance, direction, kind) => {
    const pips = points(distance);
    if (pips === null || pips <= 0) return { skipped: true };
    if (pip === null) return { error: `pips are not a defined distance for ${symbol || 'this symbol'}, so "${pips} pips" cannot be turned into a price` };
    if (price === null || price <= 0) return { error: 'no valid market price to measure from' };
    const offset = pips * pip;
    const candidate = alignPrice(direction === 'down' ? price - offset : price + offset, tick && tick > 0 ? tick : pip, direction);
    if (!Number.isFinite(candidate) || candidate <= 0) return { error: 'that distance would put the price at or below zero' };
    const reference = kind === 'stop' ? stopReference : targetReference;
    if (reference !== null && (kind === 'stop' ? (side === 'buy' ? candidate >= reference : candidate <= reference) : (side === 'buy' ? candidate <= reference : candidate >= reference))) {
      return { error: 'the distance is smaller than the current spread, so the level cannot sit on the correct side of the market' };
    }
    return { value: candidate };
  };

  let resolvedStop = hasStop ? points(stopLoss) : null;
  if (!hasStop && statesPrice(stopLossPips)) {
    const outcome = pipLeg(stopLossPips, side === 'buy' ? 'down' : 'up', 'stop');
    if (outcome.value !== undefined) { resolvedStop = outcome.value; sources.stopLoss = 'signal-pips'; }
    else if (outcome.error) problems.push({ leg: 'stopLoss', code: 'stop-loss-pips-unusable', message: `The stop loss was given in pips and could not be read: ${outcome.error}.` });
  }
  if (!hasStop && resolvedStop === null) {
    sources.stopLoss = 'none';
    if (stopNet !== null) {
      const outcome = net(stopNet, side === 'buy' ? 'down' : 'up', 'stop');
      if (outcome.value !== undefined) { resolvedStop = outcome.value; sources.stopLoss = 'net'; }
      else problems.push({ leg: 'stopLoss', code: 'stop-loss-net-unusable', message: `The fallback stop loss could not be applied: ${outcome.error}.` });
    }
    if (sources.stopLoss === 'none') {
      const riskBased = String(lotSizeMode) !== 'fixed';
      const refused = problems.find((problem) => problem.leg === 'stopLoss') || null;
      if (blockExecutionWithoutStopLoss !== false) {
        problems.push({ leg: 'stopLoss', code: 'stop-loss-required', message: refused ? `${STOP_REQUIRED_MESSAGE} ${refused.message}` : STOP_REQUIRED_MESSAGE });
      } else if (riskBased) {
        problems.push({ leg: 'stopLoss', code: 'stop-loss-sizing', message: SIZING_REQUIRES_STOP_MESSAGE });
      } else {
        warnings.push({ code: 'naked-stop', level: 'warn', message: `${NAKED_STOP_WARNING} No fallback distance is configured${refused ? ` and the configured one could not be used: ${refused.message}` : ''}.` });
      }
    }
  }

  let resolvedTarget = hasTarget ? points(takeProfit) : null;
  if (!hasTarget && statesPrice(takeProfitPips)) {
    const outcome = pipLeg(takeProfitPips, side === 'buy' ? 'up' : 'down', 'target');
    if (outcome.value !== undefined) { resolvedTarget = outcome.value; sources.takeProfit = 'signal-pips'; }
    else if (outcome.error) problems.push({ leg: 'takeProfit', code: 'take-profit-pips-unusable', message: `The take profit was given in pips and could not be read: ${outcome.error}.` });
  }
  if (!hasTarget && resolvedTarget === null) {
    sources.takeProfit = 'none';
    if (targetNet !== null) {
      const outcome = net(targetNet, side === 'buy' ? 'up' : 'down', 'target');
      if (outcome.value !== undefined) { resolvedTarget = outcome.value; sources.takeProfit = 'net'; }
      else problems.push({ leg: 'takeProfit', code: 'take-profit-net-unusable', message: `The fallback take-profit target could not be applied: ${outcome.error}.` });
    }
    if (sources.takeProfit === 'none') {
      const refused = problems.find((problem) => problem.leg === 'takeProfit') || null;
      if (blockExecutionWithoutTakeProfit === false) {
        warnings.push({ code: 'naked-target', level: 'warn', message: `${NAKED_TARGET_WARNING} No fallback distance is configured${refused ? ` and the configured one could not be used: ${refused.message}` : ''}.` });
      } else if (!problems.some((problem) => problem.code === 'take-profit-required')) {
        problems.push({ leg: 'takeProfit', code: 'take-profit-required', message: refused ? `${TARGET_REQUIRED_MESSAGE} ${refused.message}` : TARGET_REQUIRED_MESSAGE });
      }
    }
  }

  const blocker = problems.find((problem) => problem.code === 'stop-loss-required'
    || problem.code === 'stop-loss-sizing'
    || problem.code === 'take-profit-required') || null;
  return {
    stopLoss: resolvedStop,
    takeProfit: resolvedTarget,
    sources,
    problems,
    warnings,
    // The one sentence a skipped job is answered with: the leg that cannot be completed, with any
    // detail about a fallback that exists but could not be used already appended to it.
    reason: blocker ? blocker.message : null,
    blocking: blocker !== null,
  };
}

/**
 * The sentence recorded on a signal that was completed by the workspace rather than by the channel.
 * It names the direction of each leg for the side actually traded, because "3000 points below" is only
 * true of a buy - and a reader checking a sell's numbers against this note must not have to flip it.
 */
export function safetyNote(sources = {}, nets = {}, side = 'buy') {
  const sell = side === 'sell';
  const applied = [];
  if (sources.stopLoss === 'net' && nets.stopLoss) applied.push(`stop loss ${nets.stopLoss} points ${sell ? 'above' : 'below'} the order price`);
  if (sources.takeProfit === 'net' && nets.takeProfit) applied.push(`target ${nets.takeProfit} points ${sell ? 'below' : 'above'} it`);
  if (!applied.length) return null;
  return `Your Safety fallback distances were used because the signal did not carry them: ${applied.join(' and ')}.`;
}
