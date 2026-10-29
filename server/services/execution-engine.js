/* The three layers that sit between "a signal was captured" and "an order reaches the broker": quote
 * freshness, the workspace's own exposure caps, and what a broker failure actually proves. All of it is
 * decided in `execution-defense.js` rather than inline here, so each guard is a function a test can call
 * with the numbers a real MetaAPI account produces and read the answer off.
 */
import {
  MAX_ORDER_ATTEMPTS, MAX_QUOTE_AGE_MS, RETRY_BASE_DELAY_MS, RETRY_MAX_DELAY_MS, STALE_QUOTE_MESSAGE,
  buildClientId, canRetry, classifyBrokerFailure, guardExposure, guardQuote, quoteAgeMs, retryDelayMs,
} from './execution-defense.js';
import { countSignalEntryDeals as countDailySignalEntryDeals, resolveBrokerSymbol } from './signal-parser.js';
import { applySafetyNets, safetyNote } from './signal-safety.js';
import { interpretCancelResponse, marketSlippage, pendingOrderOutcome, pendingOrderPlan, resolveOrderExpiry, ORDER_TYPES } from './order-routing.js';
import { planScaleOutLevels, resolveCloseVolume, selectTarget, targetReached } from './scale-out.js';
import { isPaidSubscriber, PAID_STATUSES } from './plan-limits.js';
import { signalStatusForJobStatus } from './signal-outcome.js';
import { FRIENDLY_NOTES, friendlySignalNote } from './signal-wording.js';

const MAX_SIGNAL_AGE_MS = 120_000;
/* A row with no posting time cannot be aged at all, which is a different fact from "it is old", so it gets its
   own sentence: the trader has to be able to tell "we refused to guess" from "the market moved on". */
export const NO_POSTING_TIME_MESSAGE = 'This signal arrived without a posting time, so it was not executed.';
const UTC_DAY_MS = 24 * 60 * 60 * 1000;

function utcDate(now) {
  return new Date(now).toISOString().slice(0, 10);
}

function safeText(value, secrets = []) {
  let message = String(value || 'Execution could not be completed.')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/(https?:\/\/)[^/\s?#]*@([^/\s?#]*)/gi, '$1[redacted]@$2')
    .replace(/(authorization|auth[-_ ]?token|access[-_ ]?token|api[-_ ]?token|password|secret)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
    .replace(/\s+/g, ' ')
    .trim();
  for (const secret of secrets) if (secret && secret.length >= 4) message = message.replaceAll(secret, '[redacted]');
  return message.slice(0, 1000);
}

export const countSignalEntryDeals = countDailySignalEntryDeals;

function countPositionsAndOrders(positions, orders) {
  if (!Array.isArray(positions) || !Array.isArray(orders)) throw new Error('MetaAPI did not provide synchronized positions and pending orders.');
  return positions.length + orders.length;
}

function volumePrecision(step) {
  const text = String(step);
  return text.includes('.') ? text.length - text.indexOf('.') - 1 : 0;
}

export function calculateOrderVolume({ mode, fixedLotSize, balance, riskPercent, side, entryPrice, stopLoss, specification, price }) {
  const min = Number(specification?.minVolume);
  const max = Number(specification?.maxVolume);
  const step = Number(specification?.volumeStep);
  const tickSize = Number(specification?.tickSize);
  if (![min, max, step, tickSize].every(Number.isFinite) || min <= 0 || max < min || step <= 0 || tickSize <= 0) {
    throw new Error('The broker did not provide valid minimum, maximum, step, and tick-size trading rules.');
  }

  let rawVolume;
  if (mode === 'fixed') {
    rawVolume = Number(fixedLotSize);
    if (!Number.isFinite(rawVolume) || rawVolume < min || rawVolume > max) throw new Error(`Fixed lot size must be between ${min} and ${max} lots for this symbol.`);
    const increments = (rawVolume - min) / step;
    if (Math.abs(increments - Math.round(increments)) > 1e-7) throw new Error(`Fixed lot size must use the broker's ${step} lot volume step.`);
  } else if (mode === 'risk_based') {
    const accountBalance = Number(balance);
    const risk = Number(riskPercent);
    const lossTickValue = Number(price?.lossTickValue);
    if (!Number.isFinite(accountBalance) || accountBalance <= 0 || !Number.isFinite(risk) || risk <= 0 || !Number.isFinite(lossTickValue) || lossTickValue <= 0) {
      throw new Error('Current account balance, risk percentage, or losing tick value is unavailable.');
    }
    if (!Number.isFinite(entryPrice) || !Number.isFinite(stopLoss)) throw new Error('A valid market price and stop loss are required for risk-based sizing.');
    const stopDistance = side === 'buy' ? entryPrice - stopLoss : stopLoss - entryPrice;
    if (!Number.isFinite(stopDistance) || stopDistance <= 0) throw new Error('Stop loss is on the wrong side of the market price.');
    const lossPerLot = (stopDistance / tickSize) * lossTickValue;
    if (!Number.isFinite(lossPerLot) || lossPerLot <= 0) throw new Error('The account-currency loss per lot could not be calculated safely.');
    rawVolume = (accountBalance * risk / 100) / lossPerLot;
    if (rawVolume < min) throw new Error('Risk-based size is below the broker minimum lot for this symbol.');
    rawVolume = min + Math.floor((rawVolume - min + step * 1e-9) / step) * step;
    const maxAligned = min + Math.floor((max - min + step * 1e-9) / step) * step;
    rawVolume = Math.min(rawVolume, maxAligned);
    rawVolume = Number(rawVolume.toFixed(volumePrecision(step)));
    if (!Number.isFinite(rawVolume) || rawVolume < min) throw new Error('Risk-based size is below the broker minimum lot for this symbol.');
  } else {
    throw new Error('Choose a supported lot size mode.');
  }

  return Number(rawVolume.toFixed(volumePrecision(step)));
}

function safeProviderResponse(result, token = null) {
  if (!result || typeof result !== 'object') return null;
  const allowed = ['stringCode', 'numericCode', 'orderId', 'positionId'];
  const output = {};
  for (const key of allowed) {
    const value = result[key];
    if ((typeof value === 'string' || typeof value === 'number') && String(value).length <= 120) output[key] = value;
  }
  const providerMessage = result.message || result.description || result.comment;
  if (typeof providerMessage === 'string' && providerMessage.trim()) output.message = safeText(providerMessage, [token]);
  return output;
}

function noChangeReported(result) {
  return /TRADE_RETCODE_NO_CHANGES/.test(String(result?.stringCode || '').toUpperCase());
}

function successfulTradeResponse(result) {
  const code = String(result?.stringCode || '').toUpperCase();
  const numeric = Number(result?.numericCode);
  return /TRADE_RETCODE_(?:DONE|PLACED|DONE_PARTIAL)/.test(code) || [10008, 10009, 10010].includes(numeric);
}

/* --------------------------- Break even and trailing stop ---------------------------
 * Moves the stop loss of a position Signal Desk itself opened to (entry + a small
 * offset) once the market has travelled a configured distance in favour of the
 * trade, so a reversal can no longer turn the position into a loss. With a trailing
 * stop switched on instead of or alongside break even, the same sweep keeps ratcheting
 * that stop in the trade's favour at the user's distance for as long as the position
 * is open - one sweep, one set of guarantees, never a second decision path.
 *
 * Rules that never bend:
 *  - a stop is only ever moved in the direction that reduces risk (never widened), so a
 *    retracing market never pulls a trailed stop back down;
 *  - the decision uses a fresh, synchronized quote, the live position from the
 *    synchronized terminal state, and the symbol's own tick/stops/freeze rules;
 *  - Auto-Trading off, a changed account, an undeployed account, or a missing
 *    specification all stop the request from ever reaching the broker;
 *  - an ambiguous transport failure is recorded as `unknown` and never retried,
 *    because the broker may already have applied the modification.
 */
export const BREAK_EVEN_MAX_ATTEMPTS = 10;
export const BREAK_EVEN_DEFERRED_RETRY_MS = 15_000;
export const BREAK_EVEN_FAILED_RETRY_MS = 60_000;
export const BREAK_EVEN_TRACKING_DAYS = 30;
export const BREAK_EVEN_SWEEP_LIMIT = 20;
/** How many resting orders one pass of the expiry sweep will look at. */
export const EXPIRY_SWEEP_LIMIT = 50;

/**
 * MetaTrader trade return codes that describe a *condition* rather than a refusal:
 * the same request can succeed a moment later, so the move is deferred and retried.
 * 10016 TRADE_RETCODE_INVALID_STOPS (stop too close to the market price) and MT4's
 * 130 ERR_INVALID_STOPS are the common ones; the string codes cover the rest so no
 * numeric value has to be guessed for platforms that report names only.
 */
const BREAK_EVEN_DEFER_CODES = new Set([10016, 130]);
const BREAK_EVEN_DEFER_TEXT = /(?:invalid|too small) stops|too close|stops level|freeze|requote|price (?:changed|off)|no prices|too many requests|being modified|market (?:is )?closed/i;

/**
 * A trail is a distance behind the market, so it needs a real distance to mean anything:
 * zero would ask the broker to park a stop on the live price, and an absurd value is refused
 * rather than clamped, because a clamped number is a number the user never chose.
 */
/** What the user and the admin panel are told when the platform switch is engaged. */
export const PLATFORM_PAUSE_MESSAGE = 'Automatic execution is paused by Signal Desk. New orders are not being submitted right now.';

export const TRAILING_MIN_DISTANCE_POINTS = 1;
export const TRAILING_MAX_DISTANCE_POINTS = 100_000;

/** Codes that mean the request may or may not have reached the broker. */
const BREAK_EVEN_AMBIGUOUS_CODES = new Set([10012, 7]);
const BREAK_EVEN_AMBIGUOUS_TEXT = /timed? ?out|socket hang ?up|network|fetch failed|ECONNRESET|ETIMEDOUT|connection/i;

function finiteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function priceDecimals(step) {
  const text = String(step);
  return text.includes('.') ? text.length - text.indexOf('.') - 1 : 0;
}

/**
 * Aligns a price onto the broker's tick grid, towards (down) or away (up) from the
 * market. The epsilon absorbs binary floating-point noise only (1.1 / 0.0001 evaluates
 * to 10999.999999999998), so an exact tick multiple stays where it is while a
 * genuinely unaligned price is still moved conservatively.
 */
function alignPriceToTick(value, tickSize, direction) {
  const steps = value / tickSize;
  const aligned = direction === 'down' ? Math.floor(steps + 1e-6) : Math.ceil(steps - 1e-6);
  return Number((aligned * tickSize).toFixed(priceDecimals(tickSize)));
}

export function normalizePositionSide(value) {
  const text = String(value ?? '').toLowerCase();
  if (text.includes('buy')) return 'buy';
  if (text.includes('sell')) return 'sell';
  return null;
}

/**
 * Break-even-only entry point to `calculateStopGuard`, kept as the named contract the
 * settings, sweeps, and tests speak in. It decides what to do with one open position:
 *   wait          the market has not travelled far enough yet (check again later)
 *   already_beyond the current stop is already at least this protective (terminal here;
 *                 a trailing stop turns the same finding into a `wait`, since a trail is
 *                 a standing instruction rather than a one-off job)
 *   blocked       a safety input is missing or unusable (never send a request)
 *   defer         the broker rules forbid this exact price right now (retry later)
 *   move          send `stopLoss` to the broker
 */
export function calculateBreakEvenStop({ side, openPrice, bid, ask, stopLoss, triggerPoints, offsetPoints, tickSize, stopsLevelPoints = 0, freezeLevelPoints = 0 }) {
  return calculateStopGuard({
    side, openPrice, bid, ask, stopLoss, tickSize, stopsLevelPoints, freezeLevelPoints,
    breakEven: { triggerPoints, offsetPoints },
  });
}

/**
 * A true trailing stop: the stop keeps the user's distance from the market for as long as
 * the position is open, ratcheting in the trade's favour and never releasing it back.
 */
export function calculateTrailingStop({ side, openPrice, bid, ask, stopLoss, distancePoints, tickSize, stopsLevelPoints = 0, freezeLevelPoints = 0, breakEven = null }) {
  return calculateStopGuard({
    side, openPrice, bid, ask, stopLoss, tickSize, stopsLevelPoints, freezeLevelPoints,
    breakEven, trailing: { distancePoints },
  });
}

/**
 * One decision for both protections, because they must never disagree about safety.
 *
 *  - break even moves the stop to entry + offset once the market has travelled the trigger;
 *  - a trailing stop holds the stop `distancePoints` from the market and keeps tightening it;
 *  - when both are on, the more protective target wins, so turning trailing on can only
 *    improve break even and turning break even on can never stall a trail.
 *
 * Returns `wait` (nothing to do yet), `already_beyond` (stop is at least this protective),
 * `blocked` (a safety input is missing or unusable, so no request is ever built), `defer`
 * (the broker forbids this price right now, retry later), or `move` (send `stopLoss`).
 */
export function calculateStopGuard({ side, openPrice, bid, ask, stopLoss, tickSize, stopsLevelPoints = 0, freezeLevelPoints = 0, breakEven = null, trailing = null }) {
  const direction = normalizePositionSide(side);
  if (!direction) return { action: 'blocked', reason: 'position-direction', message: 'MetaAPI did not report whether this position is a buy or a sell.' };

  const entry = finiteNumber(openPrice);
  const marketBid = finiteNumber(bid);
  const marketAsk = finiteNumber(ask);
  const tick = finiteNumber(tickSize);
  if (![entry, marketBid, marketAsk].every((value) => Number.isFinite(value) && value > 0) || marketBid >= marketAsk) {
    return { action: 'blocked', reason: 'quote-unavailable', message: 'A fresh, valid bid and ask price are required before a stop can be moved.' };
  }
  if (!Number.isFinite(tick) || tick <= 0) {
    return { action: 'blocked', reason: 'specification-unavailable', message: 'The broker did not provide a valid tick size for this symbol.' };
  }

  const marketPrice = direction === 'buy' ? marketBid : marketAsk;
  const travelled = direction === 'buy' ? marketPrice - entry : entry - marketPrice;
  const travelledPoints = travelled / tick;
  const targets = [];

  if (breakEven) {
    const trigger = finiteNumber(breakEven.triggerPoints);
    const offset = finiteNumber(breakEven.offsetPoints) ?? 0;
    if (!Number.isFinite(trigger) || trigger < 0 || trigger > 100_000) {
      return { action: 'blocked', reason: 'invalid-trigger', message: 'The break-even trigger distance must be between 0 and 100000 points.' };
    }
    if (!Number.isFinite(offset) || offset < 0 || offset > 10_000) {
      return { action: 'blocked', reason: 'invalid-offset', message: 'The break-even offset must be between 0 and 10000 points.' };
    }
    if (travelled + tick * 1e-6 >= trigger * tick) {
      targets.push({ label: 'break-even', price: direction === 'buy' ? entry + offset * tick : entry - offset * tick });
    }
  }
  if (trailing) {
    const distance = finiteNumber(trailing.distancePoints);
    if (!Number.isFinite(distance) || distance < TRAILING_MIN_DISTANCE_POINTS || distance > TRAILING_MAX_DISTANCE_POINTS) {
      return { action: 'blocked', reason: 'invalid-distance', message: `The trailing distance must be between ${TRAILING_MIN_DISTANCE_POINTS} and ${TRAILING_MAX_DISTANCE_POINTS} points.` };
    }
    targets.push({ label: 'trailing', price: direction === 'buy' ? marketPrice - distance * tick : marketPrice + distance * tick, distance });
  }

  if (!targets.length) {
    if (!breakEven) return { action: 'wait', reason: 'nothing-configured', travelledPoints };
    return { action: 'wait', reason: 'trigger-not-reached', travelledPoints, requiredPoints: finiteNumber(breakEven.triggerPoints) };
  }

  // The more protective target wins - higher for a buy, lower for a sell. Choosing between
  // two protective prices can never loosen anything, because both were computed to tighten.
  const chosen = targets.reduce((best, item) => {
    if (direction === 'buy') return item.price > best.price ? item : best;
    return item.price < best.price ? item : best;
  });

  const decision = guardStopMove({
    direction, marketBid, marketAsk, currentStop: finiteNumber(stopLoss), target: chosen.price,
    tick, stopsLevelPoints, freezeLevelPoints, travelledPoints, label: chosen.label,
  });

  // A trail is a standing instruction, so "there is nothing tighter yet" is a wait until the
  // market travels further - never the terminal `already_beyond` that ends break-even tracking.
  if (decision.action === 'already_beyond' && trailing) {
    return { action: 'wait', reason: 'trail-not-tighter', travelledPoints, stopLoss: decision.stopLoss, attemptedStopLoss: decision.attemptedStopLoss };
  }
  if (decision.action !== 'move') return { ...decision, source: chosen.label };

  const { stopPrice, previousStopLoss } = decision;
  return {
    action: 'move',
    stopLoss: stopPrice,
    previousStopLoss,
    openPrice: entry,
    travelledPoints: Number(travelledPoints.toFixed(2)),
    lockedPoints: Number((direction === 'buy' ? (stopPrice - entry) / tick : (entry - stopPrice) / tick).toFixed(2)),
    source: chosen.label,
    // The first trailing move off a broker-supplied stop is the start of a ratchet chain,
    // which is what the ledger's move_count tracks and what the UI labels as trailing.
    ratcheted: chosen.label === 'trailing' && previousStopLoss !== null,
    trailingDistancePoints: chosen.distance ?? null,
    improvementPoints: previousStopLoss === null ? null
      : Number((direction === 'buy' ? (stopPrice - previousStopLoss) / tick : (previousStopLoss - stopPrice) / tick).toFixed(2)),
  };
}

/**
 * The rules that make a stop move safe, shared by both protections so neither can drift:
 *  - the price is aligned onto the broker's tick grid, towards the market, so a stop never
 *    lands beyond the price the user asked for;
 *  - a stop that is already at least this protective is never touched again - a move is only
 *    ever in the direction that reduces risk;
 *  - the stop must stay on the correct side of the live quote that produced it;
 *  - `stopsLevel` and `freezeLevel` are honoured, and a violation defers the move rather than
 *    failing it, because it clears on its own as the price travels.
 * `label` shapes the explanation the user sees, never the decision.
 */
function guardStopMove({ direction, marketBid, marketAsk, currentStop, target, tick, stopsLevelPoints, freezeLevelPoints, travelledPoints, label }) {
  const stopPrice = alignPriceToTick(target, tick, direction === 'buy' ? 'down' : 'up');
  const hasStop = Number.isFinite(currentStop) && currentStop > 0;

  if (hasStop) {
    const alreadyProtected = direction === 'buy' ? currentStop >= stopPrice : currentStop <= stopPrice;
    if (alreadyProtected) {
      return { action: 'already_beyond', reason: 'stop-already-protective', stopLoss: currentStop, attemptedStopLoss: stopPrice };
    }
  }

  const marketPrice = direction === 'buy' ? marketBid : marketAsk;
  if (direction === 'buy' ? stopPrice >= marketBid : stopPrice <= marketAsk) {
    return { action: 'defer', reason: 'stop-side-of-market', message: `The ${label} price is on the wrong side of the current market price.`, travelledPoints };
  }

  const stopsLevel = Math.max(0, finiteNumber(stopsLevelPoints) ?? 0);
  const distanceToMarket = direction === 'buy' ? marketBid - stopPrice : stopPrice - marketAsk;
  if (distanceToMarket + tick * 1e-6 < stopsLevel * tick) {
    return { action: 'defer', reason: 'broker-stop-distance', message: `The broker requires stops to sit at least ${stopsLevel} points from the market price.`, travelledPoints };
  }

  const freezeLevel = Math.max(0, finiteNumber(freezeLevelPoints) ?? 0);
  if (hasStop && freezeLevel > 0) {
    const distanceFromStop = Math.abs(marketPrice - currentStop);
    if (distanceFromStop + tick * 1e-6 < freezeLevel * tick) {
      return { action: 'defer', reason: 'broker-freeze-distance', message: `The broker freezes changes within ${freezeLevel} points of the current stop.`, travelledPoints };
    }
  }

  return { action: 'move', stopPrice, previousStopLoss: hasStop ? currentStop : null };
}

/**
 * Turns a provider or transport failure into the right follow-up: retry soon for a
 * temporary broker condition, retry a few times for a real rejection, and never
 * retry when it is unknown whether the broker applied the change.
 */
export function classifyBreakEvenFailure(error) {
  const numeric = Number(error?.numericCode);
  const code = String(error?.stringCode || '').toUpperCase();
  const message = String(error?.message || '');
  const hasProviderCode = code.startsWith('TRADE_RETCODE_') || code.startsWith('ERR_') || Number.isInteger(numeric);
  // MetaApi reports a numeric MetaTrader retcode, a machine-readable code name, or
  // both, so the code name is matched alongside the message before deciding how to follow up.
  const signature = `${code} ${message}`.trim();
  if (BREAK_EVEN_AMBIGUOUS_CODES.has(numeric) || (!hasProviderCode && BREAK_EVEN_AMBIGUOUS_TEXT.test(message))) {
    return { status: 'unknown', retry: false, message: message || 'The broker did not confirm whether the stop was changed, so Signal Desk will not send the request again automatically.' };
  }
  if (BREAK_EVEN_DEFER_CODES.has(numeric) || BREAK_EVEN_DEFER_TEXT.test(signature)) {
    return { status: 'deferred', retry: true, message: message || 'The broker will not accept this stop price yet.' };
  }
  return { status: 'failed', retry: true, message: message || 'The broker rejected the stop-loss change.' };
}

/**
 *
 * @typedef {Object} ExecutionEngineDeps
 * @property {PoolLike} [pool]
 * @property {Record<string, any>} [trading]
 * @property {Function} [resolveToken]
 * @property {boolean} [runtimeEnabled]
 * @property {Function} [isTradingPaused]
 * @property {Function} [now]
 * @property {number} [breakEvenIntervalMs]
 * @property {number} [takeProfitSweepIntervalMs]
 * @property {number} [breakEvenMaxAttempts]
 * @property {number} [quoteMaxAgeMs]
 * @property {number} [expirySweepIntervalMs]
 * @property {number} [maxOrderAttempts]
 * @property {number} [retryBaseMs]
 * @property {number} [retryMaxMs]
 * @property {LoggerMethods} [logger]
 */
export function createExecutionEngine(/** @type {ExecutionEngineDeps} */ { pool, trading, resolveToken, runtimeEnabled = false, isTradingPaused = async () => false, now = () => Date.now(), breakEvenIntervalMs = 5_000, takeProfitSweepIntervalMs = 5_000, breakEvenMaxAttempts = BREAK_EVEN_MAX_ATTEMPTS, quoteMaxAgeMs = MAX_QUOTE_AGE_MS, expirySweepIntervalMs = 60_000, maxOrderAttempts = MAX_ORDER_ATTEMPTS, retryBaseMs = RETRY_BASE_DELAY_MS, retryMaxMs = RETRY_MAX_DELAY_MS, logger = console } = {}) {
  if (!pool?.query || !trading?.getAccountState || !trading?.createMarketOrder || typeof resolveToken !== 'function') {
    throw new TypeError('Execution engine dependencies are incomplete.');
  }

  /**
   * The platform kill switch, asked again on every call rather than cached. It is a database
   * read because only a database read can be felt by every worker process the moment an
   * administrator flips it; a process flag would need a deploy. Anything other than a clear
   * "not paused" answer is treated as paused, including a failing dependency.
   */
  async function tradingPaused() {
    try {
      return (await isTradingPaused()) !== false;
    } catch (error) {
      logger?.error?.(JSON.stringify({ level: 'error', message: 'The platform auto-trading switch could not be read; execution stays blocked', error: safeText(error?.message || error) }));
      return true;
    }
  }

  let lastBaselineSweep = 0;
  async function captureUtcDayBaselines() {
    const timestamp = now();
    const elapsed = timestamp - Date.parse(`${utcDate(timestamp)}T00:00:00.000Z`);
    if (elapsed < 0 || elapsed > 2 * 60_000 || timestamp - lastBaselineSweep < 60_000) return { attempted: 0 };
    lastBaselineSweep = timestamp;
    const day = utcDate(timestamp);
    const { rows } = await pool.query(
      `SELECT st.user_id AS "userId",st.execution_account_id AS "accountId"
       FROM settings st JOIN metaapi_accounts ma ON ma.user_id=st.user_id AND ma.metaapi_account_id=st.execution_account_id
       WHERE st.auto_trading_enabled=TRUE AND st.execution_account_id IS NOT NULL AND UPPER(COALESCE(ma.state,''))='DEPLOYED'
         AND NOT EXISTS (SELECT 1 FROM daily_equity_snapshots ds WHERE ds.user_id=st.user_id AND ds.metaapi_account_id=st.execution_account_id AND ds.utc_date=$1)`,
      [day],
    );
    let captured = 0;
    for (const row of rows) {
      try { await captureDailyBaseline(row.userId, row.accountId); captured += 1; } catch { /* Missing safety data blocks execution later. */ }
    }
    return { attempted: rows.length, captured };
  }

  async function captureDailyBaseline(userId, accountId) {
    const { rows } = await pool.query(
      `SELECT managed_by_app,state FROM metaapi_accounts WHERE user_id=$1 AND metaapi_account_id=$2`,
      [userId, accountId],
    );
    if (!rows[0] || String(rows[0].state).toUpperCase() !== 'DEPLOYED') throw new Error('Select an owned, deployed trading account before enabling Auto-Trading.');
    const token = await resolveToken(userId, accountId, rows[0].managed_by_app);
    if (!token) throw new Error('The trading account access token is unavailable.');
    const state = await trading.getAccountState({ token, accountId });
    const equity = Number(state?.accountInformation?.equity);
    const day = utcDate(now());
    await pool.query(
      `INSERT INTO daily_equity_snapshots(user_id,metaapi_account_id,utc_date,baseline_equity,captured_at)
       VALUES($1,$2,$3,$4,NOW()) ON CONFLICT(user_id,metaapi_account_id,utc_date) DO NOTHING`,
      [userId, accountId, day, equity],
    );
    return { day, equity };
  }

  /* A job that has been decided has no scheduled retry waiting behind it, so `next_attempt_at` is cleared
     on every terminal write rather than left to be noticed later: a finished signal that comes back to
     life because a timestamp outlived its status is the worst kind of bug to discover on a live account. */
  const JOB_SETTLE_SQL = `UPDATE execution_jobs SET status=$1,error_message=$2,locked_at=NULL,next_attempt_at=NULL,updated_at=NOW() WHERE id=$3 AND user_id=$4`;
  const JOB_DEFER_SQL = `UPDATE execution_jobs SET status='queued',error_message=$2,locked_at=NULL,next_attempt_at=NOW()+($3::text || ' milliseconds')::interval,updated_at=NOW() WHERE id=$1 AND user_id=$4`;
  /* The signal row is what a user reads and the job row is what the admin history reads, so the mirror carries
     two sentences: one a trader can act on, and the provider's own words in a column no user-facing SELECT
     reads. A broker response is written for whoever has to debug it, which is why it cannot be shown as-is. */
  const SIGNAL_MIRROR_SQL = `UPDATE signals SET status=$1,execution_note=$2,technical_note=COALESCE($3,technical_note) WHERE id=(SELECT signal_id FROM execution_jobs WHERE id=$4 AND user_id=$5)`;
  /* The note an account carries when it cannot trade at all. It lives on the account and not on the
     signal because the fault is not the signal's: every workspace row would otherwise repeat the same
     sentence, and the one place a user goes to look at a trading account is where the answer belongs. */
  const ACCOUNT_NOTE_SQL = `UPDATE metaapi_accounts SET execution_note=$3,execution_note_at=NOW() WHERE user_id=$1 AND metaapi_account_id=$2`;
  const ACCOUNT_NOTE_CLEAR_SQL = `UPDATE metaapi_accounts SET execution_note=NULL,execution_note_at=NULL WHERE user_id=$1 AND metaapi_account_id=$2 AND execution_note IS NOT NULL`;

  async function updateJob(jobId, userId, status, errorMessage, note = null) {
    await pool.query(JOB_SETTLE_SQL, [status, errorMessage || null, jobId, userId]);
    // The job table and the signal table describe one event in different words: a skipped job is a
    // signal the workspace reads as unexecuted, and the reason travels with it so the panel never
    // has to guess why nothing reached the broker.
    /* Which endings put a sentence on the row. `rejected` is in the list because a declined order is the one
       outcome a reader absolutely has to be told about, and the provider's words for it - a retcode, a numeric
       code, an HTTP status when the trading server was behind a proxy - are exactly what the filter below
       exists to turn into "the broker declined this order". */
    const rawNote = note ? safeText(note) : (['skipped', 'expired', 'unknown', 'failed', 'rejected'].includes(status) ? safeText(errorMessage) || null : null);
    // An ending with nothing to say stays blank: a signal that reached the broker must not inherit the fallback
    // sentence as though something had gone wrong with reading it.
    const shown = rawNote ? friendlySignalNote(rawNote, { fallback: FRIENDLY_NOTES.generic }) : { text: null, original: null };
    await pool.query(
      SIGNAL_MIRROR_SQL,
      [signalStatusForJobStatus(status), shown.text || null, shown.original, jobId, userId],
    );
  }

  /**
   * Hand the job back to the queue with a wait on it. The signal row deliberately goes back to `queued`
   * with no note: a job waiting its turn is in flight, not blocked, and the difference is one the user
   * can act on. The reason for the wait stays on the job, where the admin panel reads it.
   */
  async function deferJob(job, { delayMs, message }) {
    const delay = String(Math.max(0, Math.round(Number(delayMs) || 0)));
    await pool.query(JOB_DEFER_SQL, [job.id, safeText(message), delay, job.user_id]);
    await pool.query(SIGNAL_MIRROR_SQL, [signalStatusForJobStatus('queued'), null, null, job.id, job.user_id]);
  }

  /**
   * What a retry has to clear before it sends anything: whether the earlier attempt is already at the
   * broker. MetaAPI publishes no unique constraint on `clientId`, so a duplicate is not refused for us -
   * it is *found* here, by position, pending order or deal carrying the id this job invented, and
   * reconciled instead of re-sent. An adapter that cannot answer is an answer of "unknown", and nothing is
   * sent on an unknown: the safe response to a question nobody can answer is not to ask it with money.
   */
  async function reconcilePriorAttempt({ job, token, accountId, clientId, tradeId }) {
    const userId = job.user_id;
    const blockAsUnknown = async (reason) => {
      const message = safeText(reason);
      await pool.query('UPDATE trades SET status=$1,error_message=$2 WHERE id=$3 AND user_id=$4', ['unknown', message, tradeId, userId]).catch(() => {});
      await updateJob(job.id, userId, 'unknown', message).catch(() => {});
      return { handled: true, status: 'unknown', message };
    };
    if (typeof trading.findOrderByClientId !== 'function') {
      return blockAsUnknown('A retry needs the account to be searched for the earlier attempt, and this service cannot do that. The order was not sent again; reconcile the broker account before retrying.');
    }
    let found = null;
    try {
      found = await trading.findOrderByClientId({ token, accountId, clientId });
    } catch (error) {
      return blockAsUnknown(`The account could not be searched for the earlier attempt (${safeText(error?.message || error)}). The order was not sent again; reconcile the broker account before retrying.`);
    }
    if (!found) return { handled: false };
    /* The first attempt did reach the broker. Recording what it produced is the whole job from here: the
       position exists, the trade row gets its ids, and the signal is executed - by another route than the
       order that was never sent, to the same end state, with no second trade in it. */
    await pool.query(
      `UPDATE trades SET status='executed',provider_response=$1,broker_order_id=$2,broker_position_id=$3,executed_at=NOW() WHERE id=$4 AND user_id=$5`,
      [safeProviderResponse(found, token), found.orderId ? String(found.orderId) : null, found.positionId ? String(found.positionId) : null, tradeId, userId],
    );
    const message = 'An earlier attempt already reached your broker; the order was matched by its client id and was not sent again.';
    await updateJob(job.id, userId, 'executed', null, message);
    return { handled: true, status: 'executed', message };
  }

  /** Best-effort by design: a note is a courtesy, and losing one must never fail an order. */
  async function noteAccount(userId, accountId, note) {
    if (!accountId || !note) return;
    await pool.query(ACCOUNT_NOTE_SQL, [userId, accountId, safeText(note)]).catch(() => {});
  }

  async function clearAccountNote(userId, accountId) {
    if (!accountId) return;
    await pool.query(ACCOUNT_NOTE_CLEAR_SQL, [userId, accountId]).catch(() => {});
  }

  /**
   * One row per swept target, so that a partial close is a fact the database holds rather than a
   * sequence the next restart has to re-derive. `UNIQUE(trade_id,level_index)` is what makes a retry of
   * this write harmless, and the break-even flag travels on the first level because the instruction to
   * protect the ride belongs to the moment the first piece was taken off, not to a setting.
   */
  async function recordScaleOutPlan({ userId, tradeId, accountId, brokerPositionId, symbol, side, plan }) {
    for (const level of plan.levels) {
      await pool.query(
        `INSERT INTO trade_tp_levels(
           user_id,trade_id,metaapi_account_id,broker_position_id,symbol,side,level_index,target_price,
           close_percent,planned_volume,break_even,status)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'pending')
         ON CONFLICT(trade_id,level_index) DO NOTHING`,
        [userId, tradeId, accountId, brokerPositionId, symbol || null, side || null, level.level, level.price,
          level.closePercent, level.volume, level.breakEven === true],
      );
    }
    await pool.query('UPDATE trades SET remaining_volume=$1 WHERE id=$2 AND user_id=$3', [Number(plan.rideVolume) + plan.levels.reduce((sum, item) => sum + Number(item.volume), 0), tradeId, userId]);
    const parts = plan.levels.map((level) => `${level.closePercent}% at ${level.price}`);
    parts.push(`${plan.ridePercent}% rides to ${plan.takeProfit}`);
    const dropped = plan.dropped?.length
      ? ` ${plan.dropped.length} level(s) the message named could not be traded and were left out (${plan.dropped[0].reason}).`
      : '';
    return `Scale-out plan: ${parts.join(', ')}.${dropped}`;
  }

  async function stop(job, status, message) {
    const reason = safeText(message);
    await updateJob(job.id, job.user_id, status, reason);
    return { status, message: reason };
  }

  async function processJob(job) {
    if (!job?.id || !job?.user_id) throw new TypeError('A durable execution job is required.');
    let tradeId = null;
    let orderSubmitted = false;
    let token = null;
    // Hoisted because the failure paths need them and the success path is not where they are written:
    // `attempt` decides whether a retry is still available, and `accountId` is where an account-level
    // fault has to be recorded - both of which are decided in the catch block below.
    let accountId = null;
    let attempt = 1;
    let expiresAt = Number.NaN;
    /* A retry is only worth scheduling if the signal still has time to be traded. The window is the
       engine's own freshness bound, and it is the reason a stale signal expires instead of being executed
       half a minute late on a price nobody quoted. */
    const retryWindowOpen = (delayMs) => !(Number.isFinite(expiresAt) && expiresAt - now() <= Number(delayMs || 0));
    try {
      const { rows } = await pool.query(
        `SELECT ej.id AS job_id,ej.user_id,ej.status AS job_status,ej.attempt_count AS "attemptCount",ej.expires_at,
                s.id AS signal_id,s.source,COALESCE(s.sent_at, s.created_at) AS signal_created_at,s.symbol,s.side,s.entry_price,s.stop_loss,s.take_profit,
                (s.sent_at IS NULL AND s.source = 'telegram') AS "sentAtMissing",
                s.execution_ready,s.parse_error,s.needs_review,s.stop_loss_pips,s.take_profit_pips,
                s.order_type AS "orderType",s.order_type_stated AS "orderTypeStated",s.is_scalping AS "isScalping",
                st.auto_trading_enabled,st.lot_size_mode,st.fixed_lot_size,st.risk_percent,st.max_open_positions,
                st.max_daily_trades,st.daily_loss_limit,st.execution_account_id,st.block_execution_without_stop_loss,
                st.block_execution_without_take_profit,st.fallback_stop_loss_points,st.fallback_take_profit_points,
                st.multiple_target_handling AS "multipleTargetHandling",s.take_profit_levels AS "takeProfitLevels",s.entry_range AS "entryRange",
                st.limit_order_expiry_value AS "limitOrderExpiryValue",st.limit_order_expiry_unit AS "limitOrderExpiryUnit",
                st.max_slippage_points AS "maxSlippagePoints",
                ma.metaapi_account_id,ma.managed_by_app,ma.state AS account_state,
                u.subscription_status,u.subscription_plan
         FROM execution_jobs ej
         JOIN signals s ON s.id=ej.signal_id AND s.user_id=ej.user_id
         JOIN settings st ON st.user_id=ej.user_id
         JOIN users u ON u.id=ej.user_id
         LEFT JOIN metaapi_accounts ma ON ma.user_id=ej.user_id AND ma.metaapi_account_id=st.execution_account_id
         WHERE ej.id=$1 AND ej.user_id=$2 LIMIT 1`,
        [job.id, job.user_id],
      );
      const item = rows[0];
      if (!item) return stop(job, 'skipped', 'Execution settings, signal, or selected account are unavailable.');
      /* A row flagged for review is not traded, whatever else is true about it. The job should not exist for
         a signal like this, and the queue is gated upstream - but a workspace that changed its Safety
         settings between capture and execution, or a row written by an older version of the parser, must not
         be able to reach the broker on the strength of a queue entry alone. This is the one place the flag is
         enforced against a live order, so it is checked before a quote is fetched or a lot is sized. */
      if (item.needs_review === true) return stop(job, 'skipped', 'This signal was saved for review, so it was not traded.');
      accountId = item.metaapi_account_id || null;
      attempt = Number(item.attemptCount || 1);
      expiresAt = Date.parse(String(item.expires_at || ''));
      if (!runtimeEnabled) return stop(job, 'skipped', 'Automatic execution is unavailable on this service.');
      // Checked before any work on the order: while the platform switch is engaged no workspace
      // can trade, and the signal is skipped rather than executed or lost in the queue.
      if (await tradingPaused()) return stop(job, 'skipped', PLATFORM_PAUSE_MESSAGE);
      if (item.auto_trading_enabled !== true) return stop(job, 'skipped', 'Auto-Trading is off.');
      if (item.source !== 'telegram' || item.execution_ready !== true) return stop(job, 'skipped', item.parse_error || 'This message is not eligible for automatic execution.');
      // Free is signal review only: no plan, no execution. This is also what makes the
      // free tier's zero trading-account limit mean something, because a link that
      // predates the change can still be selected but can no longer trade.
      if (!isPaidSubscriber({ subscription_status: item.subscription_status })) {
        return stop(job, 'skipped', 'Automatic execution needs a paid plan, so this signal was saved for review only.');
      }
      /* Age is measured from when the *channel* posted, not from when we got round to storing it. A session
         that was briefly deaf and then caught up has a row written seconds ago describing a price from minutes
         ago, and the two-minute bound exists precisely so that price is not traded: ageing it from `created_at`
         would hand a five-minute-late entry to a live market and call it fresh. */
      /* The bound below can only be measured against a posting time, and `sent_at` is nullable on purpose: the
         capture never invents one from the wall clock, because a fabricated send time would defeat the column.
         The COALESCE above is there for rows written before that column existed, whose `created_at` genuinely is
         the moment the signal arrived. A Telegram capture with no send time is the opposite case - the row was
         written seconds ago and describes a post of unknown age - which is exactly what this bound exists to
         refuse. So the missing clock is decided here, before a token is resolved and before a quote is asked. */
      if (item.sentAtMissing === true) return stop(job, 'expired', NO_POSTING_TIME_MESSAGE);

      const createdAt = new Date(item.signal_created_at).getTime();
      if (!Number.isFinite(createdAt) || now() - createdAt > MAX_SIGNAL_AGE_MS || now() < createdAt - 30_000) return stop(job, 'expired', 'This signal was too old to execute safely.');
      if (!item.execution_account_id || item.execution_account_id !== item.metaapi_account_id) return stop(job, 'skipped', 'Select an owned connected trading account in Execution Settings.');
      if (String(item.account_state || '').toUpperCase() !== 'DEPLOYED') return stop(job, 'skipped', 'The selected MetaAPI account is not deployed.');
      token = await resolveToken(job.user_id, item.metaapi_account_id, item.managed_by_app);
      if (!token) return stop(job, 'skipped', 'The selected trading account access token is unavailable.');

      const state = await trading.getAccountState({ token, accountId: item.metaapi_account_id, symbol: item.symbol });
      if (state?.account?.state && String(state.account.state).toUpperCase() !== 'DEPLOYED') return stop(job, 'skipped', 'The selected MetaAPI account is not deployed.');
      const account = state?.accountInformation;
      const balance = Number(account?.balance);
      const equity = Number(account?.equity);
      if (![balance, equity].every((value) => Number.isFinite(value) && value > 0)) return stop(job, 'skipped', 'MetaAPI did not provide valid current account balance and equity.');

      /* Layer 1, before anything is decided from the snapshot: the quote has to be *current*, not merely
         present. A broker link that stopped delivering keeps positions and equity frozen along with the
         price, so every number below would be measured against yesterday. The adapter's own freshness rule
         is deliberately looser (15s) because a protection move on a slightly aged price still beats leaving
         a position naked; opening a NEW position is the case where acting late costs money, so the tight
         bound is applied here rather than inside the connection. */
      const quote = state.price;
      const freshness = guardQuote({ price: quote, link: state.link, now: now(), maxAgeMs: quoteMaxAgeMs });
      if (!freshness.ok) return stop(job, 'skipped', freshness.message);

      /* Layer 2: the caps the workspace set for itself, read off the live terminal state rather than this
         app's own bookkeeping, because a position the user opened on their phone is a position this engine
         has to see. `guardExposure` holds the arithmetic and the sentences; the history and baseline reads
         stay here because they are database work, not judgement. */
      if (!Array.isArray(state.deals)) return stop(job, 'skipped', 'MetaAPI daily trade history is unavailable.');
      const providerDailyTrades = countSignalEntryDeals(state.deals);
      const utcDay = utcDate(now());
      const { rows: baselineRows } = await pool.query(
        'SELECT baseline_equity FROM daily_equity_snapshots WHERE user_id=$1 AND metaapi_account_id=$2 AND utc_date=$3 LIMIT 1',
        [job.user_id, item.metaapi_account_id, utcDay],
      );
      if (!baselineRows[0]) {
        return stop(job, 'skipped', 'The daily loss baseline is missing. Auto-Trading remains blocked until a safe baseline is captured.');
      }
      const baseline = Number(baselineRows[0].baseline_equity);
      if (!Number.isFinite(baseline) || baseline <= 0) return stop(job, 'skipped', 'The daily account-equity baseline is invalid.');

      const { rows: localTrades } = await pool.query(
        `SELECT COUNT(*)::int AS count FROM trades
         WHERE user_id=$1 AND metaapi_account_id=$2 AND created_at >= date_trunc('day', NOW() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
           AND status IN ('submitting','pending','executed','unknown','filled')`,
        [job.user_id, item.metaapi_account_id],
      );
      const dailyTrades = Math.max(providerDailyTrades, Number(localTrades[0]?.count || 0));
      const exposure = guardExposure({
        openTrades: countPositionsAndOrders(state.positions, state.orders),
        maxOpenPositions: item.max_open_positions,
        dailyTrades,
        maxDailyTrades: item.max_daily_trades,
        equity,
        baselineEquity: baseline,
        dailyLossLimit: item.daily_loss_limit,
      });
      if (!exposure.ok) return stop(job, 'skipped', exposure.message);

      const resolved = resolveBrokerSymbol(item.symbol, state.specification ? [state.specification] : []);
      if (!resolved.symbol) return stop(job, 'skipped', resolved.error);
      const bid = Number(quote?.bid);
      const ask = Number(quote?.ask);
      const marketPrice = item.side === 'buy' ? ask : item.side === 'sell' ? bid : NaN;
      if (![bid, ask, marketPrice].every((value) => Number.isFinite(value) && value > 0)) return stop(job, 'skipped', 'MetaAPI did not provide a valid market quote.');
      /* ---------------- the order the channel asked for, and whether the market still allows it ----------------
       *
       * This block used to be four lines that refused any market order whose quote was worse than the signal's
       * price, and every signal was a market order. Three rules live here now, and they share one idea: the
       * published price means something different depending on the kind of order it was published for.
       *
       *  - A market order at a *better* price than published is not a violation to be refused, it is the same
       *    trade on better terms. That was the bug this replaces: `BUY NOW 4110` with the ask at 4109 used to
       *    be cancelled while a user's screen said "executed" for the signals that were unlucky enough to be
       *    quoted exactly.
       *  - A market order at a *worse* price is the workspace's decision, held in `max_slippage_points` - the
       *    Price Drift Guard. Blank means zero, which is the strict behaviour every existing workspace has.
       *  - A limit or stop is not priced against the current quote at all: it is an order to rest at a level.
       *    `pendingOrderPlan` asks the one question that decides everything downstream - is that level still
       *    resting, or has the market reached it? - and a level already reached becomes a market order, which
       *    is then judged by the drift guard like any other. That is also the whole of the scalping rule, so
       *    a scalp gets no special path: it has a two-minute fuse instead of the workspace's expiry.
       */
      const orderType = ORDER_TYPES.includes(item.orderType) ? item.orderType : 'market';
      const statedEntry = item.entry_price == null ? null : Number(item.entry_price);
      let plan = { kind: 'market', reason: 'order-type-market' };
      if (orderType !== 'market') {
        plan = pendingOrderPlan({
          orderType,
          entryPrice: statedEntry,
          side: item.side,
          bid,
          ask,
          stopsLevelPoints: state.specification?.stopsLevel,
          tickSize: state.specification?.tickSize,
          // An entry the channel published as a zone carries its other bound for one reason: the far edge is
          // where the setup ends. `pendingOrderPlan` asks that before it asks whether the level would fill,
          // so a market that has run through the whole zone is refused instead of taken as a bargain.
          entryRange: item.entryRange,
        });
        if (plan.kind === 'skip') return stop(job, 'skipped', plan.message);
      }
      const resting = plan.kind === 'pending';
      /* The drift guard is consulted for anything that goes to the market now - a market order, and a resting
         order whose level the market has already reached, which is the same event from the other side. */
      const drift = marketSlippage({
        side: item.side,
        desired: statedEntry,
        bid,
        ask,
        maxSlippagePoints: item.maxSlippagePoints,
        tickSize: state.specification?.tickSize,
      });
      if (!resting && drift.action === 'skip') return stop(job, 'skipped', drift.message);
      const expiry = resolveOrderExpiry({
        value: item.limitOrderExpiryValue,
        unit: item.limitOrderExpiryUnit,
        isScalping: item.isScalping === true,
        pendingOrder: resting,
        now: now(),
      });
      /* The price the order carries, and therefore the price its legs are measured from. A resting buy limit
         at 4011 with a 500-point fallback stop means a stop at 4006, not a stop 500 points under whatever the
         market happens to be doing at the moment the order was written down - and the wrong-side tests below
         have to be asked against the same number, or a correct pending order is refused for being nothing like
         the current quote, which is the entire point of a pending order. */
      const orderPrice = resting ? plan.price : marketPrice;
      const legBid = resting ? orderPrice : bid;
      const legAsk = resting ? orderPrice : ask;
      if (plan.note) {
        logger?.info?.(JSON.stringify({ level: 'info', message: plan.note, userId: job.user_id, jobId: job.id, signalId: item.signal_id }));
      }
      /* A signal with no stop arrives here as SQL NULL, and `Number(null)` is 0 - a number that is on
         the correct side of any price, so the old check read it as a stop at zero and sent 0 to both the
         trade row and the broker. Null and 0 are told apart before anything is decided. */
      const signalStopLoss = item.stop_loss == null ? null : Number(item.stop_loss);
      const signalTakeProfit = item.take_profit == null ? null : Number(item.take_profit);
      /* The safety nets, in one place: the signal's own legs always win; a leg the channel did not state
         is completed from the workspace's fallback distance, measured from the price this order goes out
         at and aligned onto the broker's tick grid; and only when there is no net to apply does the
         block-or-override decision run. Doing the arithmetic here, against a live quote and the symbol's
         own rules, is what turns a distance into a price - and what lets a net that cannot be honoured
         (no tick size, a stop inside `stopsLevel`, a leg on the wrong side of the spread) be refused out
         loud rather than quietly ignored. */
      const safety = applySafetyNets({
        side: item.side,
        marketPrice: orderPrice,
        bid: legBid,
        ask: legAsk,
        tickSize: state.specification?.tickSize,
        stopsLevelPoints: state.specification?.stopsLevel,
        stopLoss: Number.isFinite(signalStopLoss) ? signalStopLoss : null,
        takeProfit: Number.isFinite(signalTakeProfit) ? signalTakeProfit : null,
        // A distance the channel stated in pips, handed over as a distance: this is the moment the broker's
        // own tick size exists in the same scope as the number, which is the only honest place to convert.
        stopLossPips: item.stop_loss_pips == null ? null : Number(item.stop_loss_pips),
        takeProfitPips: item.take_profit_pips == null ? null : Number(item.take_profit_pips),
        symbol: resolved.symbol,
        fallbackStopLossPoints: item.fallback_stop_loss_points,
        fallbackTakeProfitPoints: item.fallback_take_profit_points,
        blockExecutionWithoutStopLoss: item.block_execution_without_stop_loss,
        blockExecutionWithoutTakeProfit: item.block_execution_without_take_profit,
        lotSizeMode: item.lot_size_mode,
      });
      if (safety.blocking) return stop(job, 'skipped', safety.reason);
      for (const warning of safety.warnings) {
        // An override has to stay findable afterwards, on the account it happened to.
        logger?.warn?.(JSON.stringify({
          level: 'warn',
          message: warning.message,
          userId: job.user_id,
          jobId: job.id,
          signalId: item.signal_id,
          symbol: resolved.symbol,
          account: item.metaapi_account_id,
        }));
      }
      const stopLoss = safety.stopLoss;
      const hasStopLoss = stopLoss !== null && Number.isFinite(stopLoss);
      const takeProfit = safety.takeProfit;
      if (hasStopLoss && Number.isFinite(signalStopLoss) && (item.side === 'buy' ? stopLoss >= legBid : stopLoss <= legAsk)) {
        return stop(job, 'skipped', 'The signal stop loss is on the wrong side of the market.');
      }
      const safetyNoteText = safetyNote(safety.sources, {
        stopLoss: item.fallback_stop_loss_points,
        takeProfit: item.fallback_take_profit_points,
      }, item.side);
      if (takeProfit != null && (!Number.isFinite(takeProfit) || (item.side === 'buy' ? takeProfit <= legAsk : takeProfit >= legBid))) return stop(job, 'skipped', 'The signal take profit is on the wrong side of the market.');

      const volume = calculateOrderVolume({
        mode: item.lot_size_mode,
        fixedLotSize: item.fixed_lot_size,
        balance,
        riskPercent: item.risk_percent,
        side: item.side,
        entryPrice: orderPrice,
        stopLoss: hasStopLoss ? stopLoss : null,
        specification: state.specification,
        price: quote,
      });
      /* Which of the channel's prices the position itself carries, and whether the rest of the ladder
         becomes a plan. Both are decided from the stored level list rather than by re-reading the
         message, so a parser change can never move the target of a signal somebody had already reviewed. */
      const target = selectTarget({ mode: item.multipleTargetHandling, takeProfit, levels: item.takeProfitLevels });
      let scaleOut = /** @type {ScaleOutPlan} */ ({ eligible: false, reason: resting ? 'pending-order' : 'mode' });
      /* Scale-out starts from the first target and only moves the exit out once the plan is known to be
         tradeable, because the plan needs the volume the sizing just produced. That order matters: if the
         position is too small to split, a workspace that asked to scale out is left holding the *earlier*
         exit rather than a target nobody will be swept into. */
      let sendTakeProfit = target.mode === 'scale_out' ? takeProfit : target.takeProfit;
      if (target.mode === 'scale_out' && takeProfit != null && !resting) {
        scaleOut = planScaleOutLevels({
          levels: item.takeProfitLevels,
          side: item.side,
          bid,
          ask,
          volume,
          specification: state.specification,
        });
        if (scaleOut.eligible) sendTakeProfit = scaleOut.takeProfit;
        else logger?.info?.(JSON.stringify({ level: 'info', message: `Scale-out plan not usable (${scaleOut.reason}); the trade carries its first target`, userId: job.user_id, jobId: job.id }));
      }
      // The price the position will actually exit at has to clear the same test the channel's first
      // target cleared: a final target is only an exit if the market can be reached from this side.
      if (sendTakeProfit != null && (!Number.isFinite(sendTakeProfit) || (item.side === 'buy' ? sendTakeProfit <= legAsk : sendTakeProfit >= legBid))) {
        return stop(job, 'skipped', 'The signal take profit is on the wrong side of the market.');
      }
      const { rows: latestSettings } = await pool.query(
        'SELECT auto_trading_enabled AS "autoTradingEnabled",execution_account_id AS "executionAccountId" FROM settings WHERE user_id=$1 LIMIT 1',
        [job.user_id],
      );
      if (latestSettings[0]?.autoTradingEnabled !== true || latestSettings[0]?.executionAccountId !== item.metaapi_account_id) {
        return stop(job, 'skipped', 'Auto-Trading was turned off or the selected account changed before order submission.');
      }
      // Asked again immediately before the trade is recorded and the order is sent: everything
      // above this point reads broker state and can take seconds, which is long enough for an
      // administrator to engage the switch mid-job.
      if (await tradingPaused()) return stop(job, 'skipped', `${PLATFORM_PAUSE_MESSAGE} The order was stopped before it reached the broker.`);
      /* The quote has aged while everything above ran - the safety nets, the sizing and several database
         reads are fast but not instant - and this is the last point at which a stale price can still be
         refused without touching the broker. Same question, same sentence, one more time. */
      const ageAtSubmit = quoteAgeMs(quote, now());
      if (ageAtSubmit === null || Math.abs(ageAtSubmit) > quoteMaxAgeMs) return stop(job, 'skipped', STALE_QUOTE_MESSAGE);

      /* One client id for the whole life of the job, deliberately not one per attempt: it is what makes a
         second send of the same order recognisable as the same order. */
      const clientId = buildClientId({ jobId: job.id, symbol: resolved.symbol });
      /* A resting order's deadline is stored the moment it is computed, on both rows: on the trade because it
         is what the sweeper compares against, and on the signal because that is the row a reader looks at when
         they want to know why nothing happened. A market entry has no deadline of its own - the job's window
         already bounds it - unless the signal was a scalp, in which case the two minutes the channel asked for
         is a fact worth keeping on the row. */
      const expiryStamp = resting || item.isScalping === true ? new Date(expiry.expiresAt) : null;
      const { rows: tradeRows } = await pool.query(
        `INSERT INTO trades(user_id,signal_id,execution_job_id,metaapi_account_id,symbol,side,quantity,entry_price,stop_loss,take_profit,status,client_id,order_type,expiry_timestamp,drift_points)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'submitting',$11,$12,$13,$14)
         ON CONFLICT(execution_job_id) WHERE execution_job_id IS NOT NULL DO NOTHING
         RETURNING id`,
        [job.user_id, item.signal_id, job.id, item.metaapi_account_id, resolved.symbol, item.side, volume, orderPrice, hasStopLoss ? stopLoss : null, sendTakeProfit, clientId, orderType, expiryStamp, drift.driftPoints ?? null],
      );
      if (tradeRows[0]) {
        tradeId = tradeRows[0].id;
      } else {
        /* A row already exists for this job, which since retries exist has two very different meanings:
           the previous attempt provably never reached the trading server (its row is still 'submitting',
           and that is only possible because anything less certain is recorded as 'unknown' instead), or
           nobody can say what the previous attempt did. Only the first may continue, and it continues on
           the same row with the same client id. */
        // The claim and the re-stamp are one statement: only a row still at 'submitting' is taken over, and
        // it is updated to the size and legs *this* attempt will send, because a market that moved in the
        // meantime would otherwise leave the trade describing a trade nobody is placing.
        const { rows: prior } = await pool.query(
          `UPDATE trades SET symbol=$3,side=$4,quantity=$5,entry_price=$6,stop_loss=$7,take_profit=$8,client_id=$9,order_type=$10,expiry_timestamp=$11,drift_points=$12
           WHERE execution_job_id=$1 AND user_id=$2 AND status='submitting'
           RETURNING id`,
          [job.id, job.user_id, resolved.symbol, item.side, volume, orderPrice, hasStopLoss ? stopLoss : null, sendTakeProfit, clientId, orderType, expiryStamp, drift.driftPoints ?? null],
        );
        if (!prior[0]) return stop(job, 'unknown', 'A trade record already exists for this job; automatic retry was blocked for safety.');
        tradeId = prior[0].id;
      }
      if (attempt > 1) {
        const reconciled = await reconcilePriorAttempt({ job, token, accountId: item.metaapi_account_id, clientId, tradeId });
        if (reconciled.handled) return { status: reconciled.status, message: reconciled.message, tradeId };
      }

      orderSubmitted = true;
      /* A broker refusal arrives here as a *thrown* `TradeError` far more often than as a returned object -
         that is how the SDK documents every order method - so both shapes are collected and read together.
         Nothing about the submission is re-thrown past this point: from here on the outcome is recorded,
         whatever it is, because a job that dies with an exception in flight is a job whose broker state
         nobody can reconstruct. */
      let result = null;
      let rejection = null;
      try {
        result = resting
          ? await trading.createPendingOrder({
              token,
              accountId: item.metaapi_account_id,
              kind: orderType,
              side: item.side,
              symbol: resolved.symbol,
              volume,
              price: orderPrice,
              stopLoss: hasStopLoss ? stopLoss : undefined,
              takeProfit: sendTakeProfit,
              expiration: expiry.brokerExpiration,
              clientId,
            })
          : await trading.createMarketOrder({ token, accountId: item.metaapi_account_id, side: item.side, symbol: resolved.symbol, volume, stopLoss: hasStopLoss ? stopLoss : undefined, takeProfit: sendTakeProfit, clientId });
      } catch (error) {
        rejection = error;
      }
      const providerResponse = safeProviderResponse(result || rejection, token);
      if (rejection || !successfulTradeResponse(result)) {
        const failure = classifyBrokerFailure({ result: rejection ? null : result, error: rejection, submitted: true });
        const detail = safeText(failure.message || `MetaAPI rejected the ${resting ? `${orderType} order at ${orderPrice}` : 'market order'} (${failure.code || 'unknown provider code'}).`, [token]);
        const message = failure.code ? `${detail} (${failure.code})` : detail;

        if (failure.kind === 'ambiguous') {
          /* The request may have become an order. Nothing downstream may be assumed about a position that
             might exist, so this stays the one outcome with no automatic action at all - not a retry, not a
             rejection, and not an account note blaming the user for a broker that merely stopped talking. */
          const note = `${message} The order may already have been applied; reconcile the broker account before retrying.`;
          await pool.query('UPDATE trades SET status=$1,provider_response=$2,error_message=$3 WHERE id=$4 AND user_id=$5', ['unknown', providerResponse, note, tradeId, job.user_id]);
          await updateJob(job.id, job.user_id, 'unknown', note);
          return { status: 'unknown', message: note, failure: failure.kind };
        }
        if (failure.accountFault && failure.note) await noteAccount(job.user_id, item.metaapi_account_id, failure.note);
        if (canRetry({ attempt, maxAttempts: maxOrderAttempts, retriable: failure.retriable })) {
          const delayMs = retryDelayMs({ attempt, baseMs: retryBaseMs, maxMs: retryMaxMs }) ?? 0;
          if (!retryWindowOpen(delayMs)) return stop(job, 'expired', `${message} There was no time left in the signal's window to try again.`);
          logger?.info?.(JSON.stringify({
            level: 'info',
            message: 'Execution deferred: the order never reached the trading server, so it will be attempted again.',
            userId: job.user_id,
            jobId: job.id,
            attempt,
            code: failure.code,
            retryInMs: delayMs,
          }));
          // The trade row stays 'submitting' on purpose: the retry continues on this row, and a row that
          // was rewritten for every attempt is a row whose history nobody can trust.
          await deferJob(job, { delayMs, message: `${message} Retrying: the request never reached the trading server.` });
          return { status: 'queued', message, retryInMs: delayMs, failure: failure.kind };
        }
        const status = failure.accountFault ? 'failed' : 'rejected';
        await pool.query('UPDATE trades SET status=$1,provider_response=$2,error_message=$3 WHERE id=$4 AND user_id=$5', ['rejected', providerResponse, message, tradeId, job.user_id]);
        await updateJob(job.id, job.user_id, status, message);
        return { status, message, failure: failure.kind };
      }
      if (resting) {
        /* No position id, no executed_at, and the entry price the row already holds is the *level*, not a
           fill. This row is now a promise the broker is keeping for us, and the only thing that can be said
           about it is when it stops being one. */
        await pool.query(
          `UPDATE trades SET status='pending',provider_response=$1,broker_order_id=$2,expiry_timestamp=$3 WHERE id=$4 AND user_id=$5`,
          [providerResponse, result?.orderId != null ? String(result.orderId) : null, new Date(expiry.expiresAt), tradeId, job.user_id],
        );
        if (expiryStamp) await pool.query('UPDATE signals SET expiry_timestamp=$2 WHERE id=$1', [item.signal_id, new Date(expiry.expiresAt)]).catch(() => {});
      } else {
        await pool.query(
          `UPDATE trades SET status='executed',provider_response=$1,broker_order_id=$2,broker_position_id=$3,executed_at=NOW() WHERE id=$4 AND user_id=$5`,
          [providerResponse, result?.orderId ? String(result.orderId) : null, result?.positionId ? String(result.positionId) : null, tradeId, job.user_id],
        );
        if (expiryStamp) await pool.query('UPDATE signals SET expiry_timestamp=$2 WHERE id=$1', [item.signal_id, expiryStamp]).catch(() => {});
      }
      /* A filled order is the proof that whatever was wrong with this account is not wrong now, so the
         sentence saying so has to leave with it - a stale "check your credentials" under a trading account
         that is trading is a false alarm the user cannot un-see. */
      await clearAccountNote(job.user_id, item.metaapi_account_id);
      /* Only now is the ladder written down: a trade that was never opened owns no plan, and a rejected
         order must not leave pending closes for a position that does not exist. A rejected plan write
         cannot undo the order either, so it is logged and the sweep simply has nothing to act on. */
      let planNote = null;
      if (scaleOut.eligible && result?.positionId) {
        try {
          planNote = await recordScaleOutPlan({
            userId: job.user_id, tradeId, accountId: item.metaapi_account_id,
            brokerPositionId: String(result.positionId), symbol: resolved.symbol, side: item.side, plan: scaleOut,
          });
        } catch (error) {
          logger?.error?.(JSON.stringify({ level: 'error', message: 'Scale-out plan could not be recorded', userId: job.user_id, jobId: job.id, error: safeText(error?.message || error) }));
        }
      }
      // A completed order normally clears the row's note; when a leg came from the workspace rather than
      // from the channel, that is the one thing worth leaving on the signal for the reader to find later.
      /* What the reader of this signal is owed, in one sentence each: the price the fill was taken at when it
         was not the published one, and the deadline when the order is resting. A "better price" is not a
         warning, so it is a note and not an error; a limit order that will be cancelled at 14:32 is neither,
         so it is a note too. */
      const notes = [safetyNoteText, planNote];
      const zoneClause = plan.zone ? ` (the ${item.side === 'buy' ? 'upper' : 'lower'} edge of a ${plan.zone.low} - ${plan.zone.high} entry zone)` : '';
      if (resting) {
        const minutes = Math.round(expiry.windowMs / 60_000);
        const from = expiry.source === 'scalping' ? 'the two-minute scalping window' : (expiry.source === 'default' ? 'the default 30-minute expiry' : `your ${minutes}-minute expiry setting`);
        notes.push(`${orderType === 'stop' ? 'Stop' : 'Limit'} order placed at ${orderPrice}${zoneClause}, valid for ${minutes} minutes (${from}); it will be cancelled automatically if it has not filled by ${new Date(expiry.expiresAt).toISOString().slice(11, 16)} UTC.`);
      } else {
        /* A zone that needed no waiting says so on the row, and then says what the fill cost - the two
           sentences answer different questions ("why is this a market trade when a range was published?" and
           "was the price I was offered respected?"), so neither replaces the other. */
        if (plan.readerNote) notes.push(plan.readerNote);
        if (drift.favourable === true && Number(drift.driftPoints) > 0) {
          notes.push(`Filled ${drift.driftPoints} points better than the signal price of ${statedEntry}.`);
        } else if (drift.reason === 'within-drift-guard') {
          notes.push(drift.message);
        }
      }
      await updateJob(job.id, job.user_id, resting ? 'pending' : 'executed', null, notes.filter(Boolean).join(' ') || null);
      // Executing for a user counts as activity, so an account that is trading is never
      // swept up by the inactivity policy.
      await pool.query('UPDATE users SET last_active_at=NOW() WHERE id=$1', [job.user_id]).catch(() => {});
      return { status: resting ? 'pending' : 'executed', tradeId, providerResponse, orderType, expiryTimestamp: resting ? new Date(expiry.expiresAt).toISOString() : null };
    } catch (error) {
      const message = safeText(error?.message || error, [token]);
      const failure = classifyBrokerFailure({ error, submitted: orderSubmitted });
      if (tradeId) {
        const status = orderSubmitted ? 'unknown' : 'rejected';
        await pool.query('UPDATE trades SET status=$1,error_message=$2 WHERE id=$3 AND user_id=$4', [status, message, tradeId, job.user_id]).catch(() => {});
        await updateJob(job.id, job.user_id, status, message).catch(() => {});
        return { status, message };
      }
      /* Nothing was written and nothing reached the broker, which makes this the half of a failure where
         acting is free: an account that cannot be reached at all is worth saying so about once, on the
         account itself, and a request that provably never left here may be sent again shortly. */
      if (failure.accountFault) {
        if (failure.note) await noteAccount(job.user_id, accountId, failure.note);
        await updateJob(job.id, job.user_id, 'failed', message).catch(() => {});
        return { status: 'failed', message, failure: failure.kind };
      }
      if (canRetry({ attempt, maxAttempts: maxOrderAttempts, retriable: failure.retriable })) {
        const delayMs = retryDelayMs({ attempt, baseMs: retryBaseMs, maxMs: retryMaxMs }) ?? 0;
        if (!retryWindowOpen(delayMs)) return stop(job, 'expired', `${message} There was no time left in the signal's window to try again.`);
        await deferJob(job, { delayMs, message: `${message} Retrying: the request never reached the broker.` });
        return { status: 'queued', message, retryInMs: delayMs, failure: failure.kind };
      }
      await updateJob(job.id, job.user_id, 'skipped', message).catch(() => {});
      return { status: 'skipped', message };
    }
  }

  /* --------------------- break-even and trailing stop sweep --------------------- */
  let lastBreakEvenSweep = 0;

  async function candidates() {
    const { rows } = await pool.query(
      `SELECT t.id AS trade_id,t.user_id,t.metaapi_account_id,t.broker_position_id,t.symbol,t.side,
              t.entry_price,t.stop_loss,
              s.break_even_enabled AS break_even_enabled,
              s.break_even_trigger_points AS trigger_points,s.break_even_offset_points AS offset_points,
              s.trailing_stop_enabled AS trailing_enabled,s.trailing_stop_distance_points AS trailing_distance_points,
              ma.managed_by_app
       FROM trades t
       JOIN settings s ON s.user_id=t.user_id
       JOIN users u ON u.id=t.user_id
       JOIN metaapi_accounts ma ON ma.user_id=t.user_id AND ma.metaapi_account_id=t.metaapi_account_id
       LEFT JOIN break_even_moves m
         ON m.user_id=t.user_id AND m.metaapi_account_id=t.metaapi_account_id AND m.broker_position_id=t.broker_position_id
       WHERE t.status='executed' AND t.broker_position_id IS NOT NULL
         AND (s.break_even_enabled=TRUE OR s.trailing_stop_enabled=TRUE)
         AND s.auto_trading_enabled=TRUE AND s.execution_account_id=t.metaapi_account_id
         AND UPPER(COALESCE(ma.state,''))='DEPLOYED'
         AND u.subscription_status = ANY($4::text[])
         AND t.created_at >= NOW() - ($1::text || ' days')::interval
         AND (m.id IS NULL
              OR (m.status IN ('deferred','failed')
                  AND m.attempt_count < $2
                  AND (m.next_attempt_at IS NULL OR m.next_attempt_at <= NOW()))
              -- A trail is not finished by one move, so a handled position stays a candidate
              -- while trailing is on. 'closed' and 'unknown' are excluded for good: the first is
              -- gone and the second needs a human, so neither may be re-sent.
              OR (s.trailing_stop_enabled=TRUE AND m.status IN ('moved','already_beyond')))
       -- A position that has never been protected outranks a trail already running, so a
       -- workspace with more open trades than the sweep limit cannot starve a fresh move;
       -- inside each class the row touched longest ago goes first, which rotates the trails
       -- instead of letting one position hold the queue.
       ORDER BY CASE WHEN m.id IS NULL THEN 0
                     WHEN m.status IN ('deferred','failed') THEN 1
                     ELSE 2 END,
                COALESCE(m.updated_at, t.created_at) ASC, t.created_at ASC
       LIMIT $3`,
      [String(BREAK_EVEN_TRACKING_DAYS), Number(breakEvenMaxAttempts) || BREAK_EVEN_MAX_ATTEMPTS, BREAK_EVEN_SWEEP_LIMIT, [...PAID_STATUSES]],
    );
    return rows;
  }

  /** What the ledger records about the settings a decision was made under. */
  function moveLedger(candidate) {
    const trailingOn = candidate.trailing_enabled === true;
    return {
      triggerPoints: candidate.trigger_points,
      offsetPoints: candidate.offset_points,
      trailingDistancePoints: trailingOn ? candidate.trailing_distance_points : null,
      // Only a trail may revisit a row a previous sweep already settled, and only to tighten.
      ratchet: trailingOn,
    };
  }

  /** Persisted so a position is never sent twice, and so the UI can explain any outcome. */
  async function recordMove(candidate, patch) {
    const {
      status, stopLoss = null, previousStopLoss = null, openPrice = null, message = null,
      providerResponse = null, retryInMs = null, marketBid = null, marketAsk = null,
      triggerPoints = null, offsetPoints = null, trailingDistancePoints = null,
      incrementAttempt = true, ratchet = false,
    } = patch;
    await pool.query(
      `INSERT INTO break_even_moves(
         user_id,trade_id,metaapi_account_id,broker_position_id,symbol,side,open_price,trigger_points,offset_points,
         previous_stop_loss,stop_loss,status,attempt_count,market_bid,market_ask,provider_response,error_message,next_attempt_at,updated_at,
         move_count,trailing_distance_points)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,1,$14,$15,$16,$17,
               CASE WHEN $18::text IS NULL THEN NULL ELSE NOW() + ($18::text || ' milliseconds')::interval END,NOW(),
               CASE WHEN $12 = 'moved' THEN 1 ELSE 0 END,$20)
       ON CONFLICT(user_id,metaapi_account_id,broker_position_id) DO UPDATE SET
         symbol=EXCLUDED.symbol,side=EXCLUDED.side,open_price=EXCLUDED.open_price,trigger_points=EXCLUDED.trigger_points,
         offset_points=EXCLUDED.offset_points,previous_stop_loss=EXCLUDED.previous_stop_loss,stop_loss=EXCLUDED.stop_loss,
         status=EXCLUDED.status,
         attempt_count=break_even_moves.attempt_count + CASE WHEN $13::text = 'true' THEN 1 ELSE 0 END,
         market_bid=EXCLUDED.market_bid,market_ask=EXCLUDED.market_ask,provider_response=EXCLUDED.provider_response,
         error_message=EXCLUDED.error_message,next_attempt_at=EXCLUDED.next_attempt_at,updated_at=NOW(),
         trailing_distance_points=EXCLUDED.trailing_distance_points,
         move_count=break_even_moves.move_count + CASE WHEN EXCLUDED.status = 'moved' THEN 1 ELSE 0 END
       WHERE break_even_moves.status NOT IN ('moved','already_beyond','closed','unknown')
          -- A ratchet write is the trail tightening the stop again; only it may revisit a row
          -- that a previous sweep already settled, and never one that is closed or unconfirmed.
          OR ($19::text = 'true' AND break_even_moves.status IN ('moved','already_beyond'))`,
      [candidate.user_id, candidate.trade_id || null, candidate.metaapi_account_id, candidate.broker_position_id,
        candidate.symbol || null, candidate.side || null, openPrice, triggerPoints, offsetPoints,
        previousStopLoss, stopLoss, status, String(incrementAttempt), marketBid, marketAsk, providerResponse,
        message ? safeText(message) : null, retryInMs == null ? null : String(retryInMs),
        String(Boolean(ratchet)), trailingDistancePoints == null ? null : String(trailingDistancePoints)],
    );
  }

  /**
   * Re-read immediately before any broker write, so a switch flipped mid-sweep takes effect at
   * once. Either protection being on is enough to act, because both move the same stop under
   * the same rules; Auto-Trading off still means nothing reaches the broker. This is also what
   * makes "off" trustworthy as a safety statement rather than a UI detail.
   */
  async function stopGuardEligible(userId, accountId) {
    const { rows } = await pool.query(
      `SELECT s.auto_trading_enabled AS "autoTradingEnabled",s.break_even_enabled AS "breakEvenEnabled",
              s.trailing_stop_enabled AS "trailingStopEnabled",
              s.execution_account_id AS "executionAccountId"
       FROM settings s WHERE s.user_id=$1 LIMIT 1`,
      [userId],
    );
    const latest = rows[0];
    if (!latest || latest.autoTradingEnabled !== true || latest.executionAccountId !== accountId) return false;
    return latest.breakEvenEnabled === true || latest.trailingStopEnabled === true;
  }

  async function sweepBreakEven() {
    const summary = { attempted: 0, moved: 0, ratcheted: 0, deferred: 0, failed: 0, closed: 0, skipped: 0 };
    if (!runtimeEnabled) return { ...summary, reason: 'runtime-disabled' };
    if (typeof trading.modifyPosition !== 'function') return { ...summary, reason: 'provider-unsupported' };
    const timestamp = now();
    const intervalMs = Math.max(1_000, Number(breakEvenIntervalMs) || 5_000);
    if (timestamp - lastBreakEvenSweep < intervalMs) return { ...summary, reason: 'throttled' };
    lastBreakEvenSweep = timestamp;

    let rows;
    try {
      rows = await candidates();
    } catch (error) {
      logger.error?.(JSON.stringify({ level: 'error', message: 'Break-even candidates could not be read', error: safeText(error?.message || error) }));
      return { ...summary, reason: 'candidates-unavailable' };
    }
    if (!rows.length) return summary;

    const groups = new Map();
    for (const row of rows) {
      const key = `${row.user_id}|${row.metaapi_account_id}|${row.symbol || ''}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    }

    for (const group of groups.values()) {
      const [{ user_id: userId, metaapi_account_id: accountId, symbol }] = group;
      let state = null;
      let token = null;
      try {
        const { rows: accountRows } = await pool.query(
          'SELECT managed_by_app,state FROM metaapi_accounts WHERE user_id=$1 AND metaapi_account_id=$2 LIMIT 1',
          [userId, accountId],
        );
        if (!accountRows[0] || String(accountRows[0].state || '').toUpperCase() !== 'DEPLOYED') {
          for (const candidate of group) summary.skipped += 1;
          continue;
        }
        token = await resolveToken(userId, accountId, accountRows[0].managed_by_app);
        if (!token) throw new Error('The trading account access token is unavailable.');
        state = await trading.getAccountState({ token, accountId, symbol });
      } catch (error) {
        const message = safeText(error?.message || error, [token]);
        for (const candidate of group) {
          summary.deferred += 1;
          // Not being able to *look* is not the broker refusing anything, so it must
          // not consume an attempt: protection should resume as soon as the account
          // synchronizes again rather than resting forever after ten bad minutes.
          await recordMove(candidate, { ...moveLedger(candidate), status: 'deferred', message: `Account data was not available: ${message}`, retryInMs: BREAK_EVEN_FAILED_RETRY_MS, incrementAttempt: false }).catch(() => {});
        }
        continue;
      }

      for (const candidate of group) {
        summary.attempted += 1;
        const ledger = moveLedger(candidate);
        // Which protection this workspace has switched on decides which targets the decision
        // may consider. A row can only be here because at least one of them is on.
        const guardMode = {
          breakEven: candidate.break_even_enabled === true
            ? { triggerPoints: candidate.trigger_points, offsetPoints: candidate.offset_points }
            : null,
          trailing: candidate.trailing_enabled === true
            ? { distancePoints: candidate.trailing_distance_points }
            : null,
        };
        try {
          const position = (state.positions || []).find((item) => String(item.id) === String(candidate.broker_position_id));
          if (!position) {
            summary.closed += 1;
            await recordMove(candidate, { status: 'closed', message: 'The position is no longer open on the broker account.', triggerPoints: candidate.trigger_points, offsetPoints: candidate.offset_points, incrementAttempt: false });
            continue;
          }
          // The quote, the position, and the symbol specification below all come from this one
          // account read, so a price can never be paired with a stop or a spec from another
          // moment, and nothing is remembered from a previous sweep to act on instead.
          const decision = calculateStopGuard({
            side: position.type ?? candidate.side,
            openPrice: position.openPrice ?? candidate.entry_price,
            bid: state.price?.bid,
            ask: state.price?.ask,
            stopLoss: position.stopLoss,
            tickSize: state.specification?.tickSize,
            stopsLevelPoints: state.specification?.stopsLevel,
            freezeLevelPoints: state.specification?.freezeLevel,
            ...guardMode,
          });

          if (decision.action === 'wait') { summary.skipped += 1; continue; }
          if (decision.action === 'already_beyond') {
            await recordMove(candidate, { ...ledger, status: 'already_beyond', stopLoss: decision.stopLoss, openPrice: position.openPrice ?? null, incrementAttempt: false });
            summary.skipped += 1;
            continue;
          }
          if (decision.action === 'blocked') {
            summary.deferred += 1;
            await recordMove(candidate, { ...ledger, status: 'deferred', message: decision.message, retryInMs: BREAK_EVEN_FAILED_RETRY_MS, incrementAttempt: false });
            continue;
          }
          if (decision.action === 'defer') {
            summary.deferred += 1;
            await recordMove(candidate, { ...ledger, status: 'deferred', message: decision.message, retryInMs: BREAK_EVEN_DEFERRED_RETRY_MS, marketBid: state.price?.bid ?? null, marketAsk: state.price?.ask ?? null, incrementAttempt: false });
            continue;
          }

          if (!(await stopGuardEligible(userId, accountId))) {
            summary.skipped += 1;
            continue;
          }

          const result = await trading.modifyPosition({ token, accountId, positionId: String(candidate.broker_position_id), stopLoss: decision.stopLoss });
          const providerResponse = safeProviderResponse(result, token);
          if (noChangeReported(result)) {
            await recordMove(candidate, { ...ledger, status: 'already_beyond', stopLoss: decision.stopLoss, previousStopLoss: decision.previousStopLoss ?? null, openPrice: decision.openPrice ?? null, marketBid: state.price?.bid ?? null, marketAsk: state.price?.ask ?? null, providerResponse, incrementAttempt: false });
            summary.skipped += 1;
            continue;
          }
          if (!successfulTradeResponse(result)) {
            const message = safeText(result?.message || `MetaAPI rejected the stop-loss change (${result?.stringCode || result?.numericCode || 'unknown provider code'}).`, [token]);
            summary.failed += 1;
            await recordMove(candidate, { ...ledger, status: 'failed', message, providerResponse, retryInMs: BREAK_EVEN_FAILED_RETRY_MS, marketBid: state.price?.bid ?? null, marketAsk: state.price?.ask ?? null });
            continue;
          }
          await recordMove(candidate, {
            ...ledger, status: 'moved', stopLoss: decision.stopLoss, previousStopLoss: decision.previousStopLoss, openPrice: decision.openPrice,
            marketBid: state.price?.bid ?? null, marketAsk: state.price?.ask ?? null, providerResponse, incrementAttempt: false,
          });
          await pool.query('UPDATE trades SET stop_loss=$1 WHERE id=$2 AND user_id=$3', [decision.stopLoss, candidate.trade_id, userId]);
          summary.moved += 1;
          // A ratchet is a trail tightening an already-protected stop, which is the outcome
          // worth counting separately: it is exactly why a 'moved' row stays in the sweep.
          if (decision.ratcheted) summary.ratcheted += 1;
        } catch (error) {
          const outcome = classifyBreakEvenFailure(error);
          const message = safeText(outcome.message || error?.message || error, [token]);
          if (outcome.status === 'unknown') summary.failed += 1; else summary.deferred += 1;
          await recordMove(candidate, {
            ...ledger,
            status: outcome.status === 'unknown' ? 'unknown' : 'deferred',
            message: outcome.status === 'unknown'
              ? `${message} Reconcile the position on the broker account before changing the break-even settings.`
              : message,
            retryInMs: outcome.retry && outcome.status !== 'unknown' ? BREAK_EVEN_FAILED_RETRY_MS : null,
            marketBid: state.price?.bid ?? null, marketAsk: state.price?.ask ?? null,
            incrementAttempt: outcome.status !== 'deferred',
          }).catch(() => {});
          // The order itself filled, so the trade keeps its execution status: only the
          // stop move is unconfirmed, and that is recorded on the move row.
        }
      }
    }
    return summary;
  }

  /* --------------------- scale-out: closing a piece of the trade at each named target ---------------------
   * The sweep reads one account snapshot per account and symbol, the same discipline the stop sweep
   * uses, so a price is never paired with a position size from a different moment. Three properties
   * carry the whole risk of this feature:
   *  - a close is claimed in the database before it reaches the broker, so two sweeps, or a sweep and
   *    a restart, cannot both take the same piece out;
   *  - a refusal that is the broker's own rule (a stop distance, a size it will not hold) is deferred
   *    or skipped with the reason kept, never retried into a loop;
   *  - an ambiguous transport failure is `unknown` and stops, because the broker may already have
   *    closed the volume and a second close would be a trade nobody asked for.
   * A platform pause stops new orders, not this: taking profit and moving a stop to entry reduce
   * exposure, which is the same reasoning that keeps break-even moves running while paused.
   */
  let lastTakeProfitSweep = 0;
  const TP_LEVEL_TRACKING_DAYS = 30;
  const TP_LEVEL_SWEEP_LIMIT = 20;
  const TP_CLAIM_STALE_MS = 5 * 60_000;

  async function levelCandidates() {
    const { rows } = await pool.query(
      `SELECT l.id,l.status,l.user_id,l.trade_id,l.metaapi_account_id,l.broker_position_id,l.symbol,l.side,
              l.level_index,l.target_price,l.close_percent,l.planned_volume,l.closed_volume,
              l.break_even,l.break_even_status,l.attempt_count,
              t.entry_price,t.quantity,t.remaining_volume,t.user_id AS trade_user_id,
              s.break_even_enabled AS break_even_enabled,s.break_even_offset_points AS offset_points,
              s.trailing_stop_enabled AS trailing_enabled,s.trailing_stop_distance_points AS trailing_distance_points,
              ma.managed_by_app
       FROM trade_tp_levels l
       JOIN trades t ON t.id=l.trade_id
       JOIN settings s ON s.user_id=l.user_id
       JOIN users u ON u.id=l.user_id
       JOIN metaapi_accounts ma ON ma.user_id=l.user_id AND ma.metaapi_account_id=l.metaapi_account_id
       WHERE (
               (l.status IN ('pending','deferred','failed')
                 AND (l.next_attempt_at IS NULL OR l.next_attempt_at <= NOW())
                 AND l.attempt_count < $2)
               OR (l.status='filled' AND l.break_even=TRUE
                   AND (l.break_even_status IS NULL OR l.break_even_status IN ('pending','deferred'))
                   AND l.break_even_attempts < $2)
             )
         AND t.status='executed' AND t.broker_position_id IS NOT NULL
         AND s.auto_trading_enabled=TRUE AND s.execution_account_id=l.metaapi_account_id
         AND UPPER(COALESCE(ma.state,''))='DEPLOYED'
         AND u.subscription_status = ANY($3::text[])
         AND t.created_at >= NOW() - ($1::text || ' days')::interval
       ORDER BY t.created_at ASC,l.level_index ASC
       LIMIT $4`,
      [String(TP_LEVEL_TRACKING_DAYS), Number(breakEvenMaxAttempts) || BREAK_EVEN_MAX_ATTEMPTS, [...PAID_STATUSES], TP_LEVEL_SWEEP_LIMIT],
    );
    return rows;
  }

  /** Re-read immediately before a write, in the sweep's own terms: the plan belongs to this account. */
  async function planStillArmed(userId, accountId) {
    const { rows } = await pool.query(
      'SELECT auto_trading_enabled AS "autoTradingEnabled",execution_account_id AS "executionAccountId" FROM settings WHERE user_id=$1 LIMIT 1',
      [userId],
    );
    const latest = rows[0];
    return Boolean(latest && latest.autoTradingEnabled === true && latest.executionAccountId === accountId);
  }

  async function settleLevel(levelId, patch) {
    const {
      status, closedVolume = null, remainingVolume = null, message = null, providerResponse = null,
      retryInMs = null, marketBid = null, marketAsk = null,
    } = patch;
    await pool.query(
      `UPDATE trade_tp_levels SET status=$2,closed_volume=CASE WHEN $3::numeric IS NULL THEN closed_volume ELSE $3 END,
              remaining_volume=COALESCE($4,remaining_volume),provider_response=COALESCE($5,provider_response),
              error_message=$6,market_bid=COALESCE($7,market_bid),market_ask=COALESCE($8,market_ask),
              filled_at=CASE WHEN $2='filled' THEN NOW() ELSE filled_at END,
              next_attempt_at=CASE WHEN $9::text IS NULL THEN NULL ELSE NOW() + ($9::text || ' milliseconds')::interval END,
              updated_at=NOW()
       WHERE id=$1`,
      [levelId, status, closedVolume, remainingVolume, providerResponse, message ? safeText(message) : null,
        marketBid, marketAsk, retryInMs == null ? null : String(retryInMs)],
    );
  }

  /**
   * Break even, forced by the plan rather than by the workspace's trigger distance: the moment a piece of
   * the trade is banked, the ride must not be able to give it all back. `triggerPoints: 0` is what says
   * "now", and every other rule - never widen, honour the symbol's stop and freeze distances, defer
   * rather than force - is the same function the break-even sweep uses, so the two can never disagree
   * about what a safe stop is.
   */
  async function applyPlanBreakEven(candidate, context) {
    const { state, spec, position, token, accountId, logger } = context;
    const offsetPoints = candidate.break_even_enabled === true ? candidate.offset_points : 0;
    const decision = calculateStopGuard({
      side: position.type ?? candidate.side,
      openPrice: position.openPrice ?? candidate.entry_price,
      bid: state.price?.bid,
      ask: state.price?.ask,
      stopLoss: position.stopLoss,
      tickSize: spec?.tickSize,
      stopsLevelPoints: spec?.stopsLevel,
      freezeLevelPoints: spec?.freezeLevel,
      breakEven: { triggerPoints: 0, offsetPoints: Number(offsetPoints) || 0 },
      trailing: candidate.trailing_enabled === true ? { distancePoints: candidate.trailing_distance_points } : null,
    });
    const ledger = {
      user_id: candidate.user_id, trade_id: candidate.trade_id, metaapi_account_id: candidate.metaapi_account_id,
      broker_position_id: candidate.broker_position_id, symbol: candidate.symbol, side: candidate.side,
    };
    if (decision.action === 'already_beyond') {
      await pool.query(`UPDATE trade_tp_levels SET break_even_status='already_beyond',break_even_stop_loss=COALESCE($2,break_even_stop_loss),updated_at=NOW() WHERE id=$1`, [candidate.id, decision.stopLoss ?? null]);
      return 'already_beyond';
    }
    if (decision.action !== 'move') {
      await pool.query(
        `UPDATE trade_tp_levels SET break_even_status='deferred',break_even_attempts=break_even_attempts+1,
                break_even_error=$2,updated_at=NOW() WHERE id=$1`,
        [candidate.id, safeText(decision.message || 'The stop could not be moved to break yet.')],
      );
      await recordMove(ledger, { triggerPoints: 0, offsetPoints: Number(offsetPoints) || 0, ratchet: false, status: 'deferred', message: `Scale-out break even: ${decision.message || 'the price is not usable yet'}`, retryInMs: BREAK_EVEN_FAILED_RETRY_MS, incrementAttempt: false }).catch(() => {});
      return 'deferred';
    }
    if (!(await planStillArmed(candidate.user_id, candidate.metaapi_account_id))) return 'skipped';
    const result = await trading.modifyPosition({ token, accountId, positionId: String(candidate.broker_position_id), stopLoss: decision.stopLoss });
    const providerResponse = safeProviderResponse(result, token);
    if (noChangeReported(result)) {
      await pool.query(`UPDATE trade_tp_levels SET break_even_status='already_beyond',break_even_stop_loss=$2,updated_at=NOW() WHERE id=$1`, [candidate.id, decision.stopLoss]);
      return 'already_beyond';
    }
    if (!successfulTradeResponse(result)) {
      const message = safeText(result?.message || `MetaAPI rejected the break-even move (${result?.stringCode || result?.numericCode || 'unknown provider code'}).`, [token]);
      await pool.query(`UPDATE trade_tp_levels SET break_even_status='deferred',break_even_attempts=break_even_attempts+1,break_even_error=$2,updated_at=NOW() WHERE id=$1`, [candidate.id, message]);
      await recordMove(ledger, { triggerPoints: 0, offsetPoints: Number(offsetPoints) || 0, ratchet: false, status: 'failed', message: `Scale-out break even refused: ${message}`, providerResponse, retryInMs: BREAK_EVEN_FAILED_RETRY_MS }).catch(() => {});
      return 'failed';
    }
    await pool.query(
      `UPDATE trade_tp_levels SET break_even_status='moved',break_even_stop_loss=$2,break_even_error=NULL,updated_at=NOW() WHERE id=$1`,
      [candidate.id, decision.stopLoss],
    );
    await pool.query('UPDATE trades SET stop_loss=$1 WHERE id=$2 AND user_id=$3', [decision.stopLoss, candidate.trade_id, candidate.user_id]);
    await recordMove(ledger, {
      triggerPoints: 0, offsetPoints: Number(offsetPoints) || 0, ratchet: candidate.trailing_enabled === true,
      status: 'moved', stopLoss: decision.stopLoss, previousStopLoss: decision.previousStopLoss,
      openPrice: decision.openPrice, marketBid: state.price?.bid ?? null, marketAsk: state.price?.ask ?? null,
      providerResponse, incrementAttempt: false, message: 'Break even applied by the scale-out plan when its first target was reached.',
    }).catch(() => {});
    logger?.info?.(JSON.stringify({ level: 'info', message: 'Scale-out stop moved to break even', userId: candidate.user_id, levelId: candidate.id, stopLoss: decision.stopLoss }));
    return 'moved';
  }

  async function sweepTakeProfitLevels() {
    const summary = { attempted: 0, closed: 0, deferred: 0, failed: 0, skipped: 0, waited: 0, breakEvenMoved: 0 };
    if (!runtimeEnabled) return { ...summary, reason: 'runtime-disabled' };
    if (typeof trading.closePositionPartially !== 'function') return { ...summary, reason: 'provider-unsupported' };
    const timestamp = now();
    const intervalMs = Math.max(1_000, Number(takeProfitSweepIntervalMs) || 5_000);
    if (timestamp - lastTakeProfitSweep < intervalMs) return { ...summary, reason: 'throttled' };
    lastTakeProfitSweep = timestamp;

    // A close that was claimed and never settled means this process died mid-call. Recording it as
    // unknown is the only honest answer: the broker may have closed the volume, and a retry could take
    // out the same piece twice.
    await pool.query(
      `UPDATE trade_tp_levels SET status='unknown',
              error_message='The sweep stopped while a partial close may have been in progress. Reconcile the position on the broker account before changing this plan.',
              updated_at=NOW()
       WHERE status='submitting' AND updated_at < NOW() - ($1::text || ' milliseconds')::interval`,
      [String(TP_CLAIM_STALE_MS)],
    ).catch(() => {});

    let rows;
    try {
      rows = await levelCandidates();
    } catch (error) {
      logger.error?.(JSON.stringify({ level: 'error', message: 'Scale-out plan rows could not be read', error: safeText(error?.message || error) }));
      return { ...summary, reason: 'candidates-unavailable' };
    }
    if (!rows.length) return summary;

    const groups = new Map();
    for (const row of rows) {
      const key = `${row.user_id}|${row.metaapi_account_id}|${row.symbol || ''}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    }

    for (const group of groups.values()) {
      const [{ user_id: userId, metaapi_account_id: accountId, symbol }] = group;
      let state = null;
      let token = null;
      try {
        const { rows: accountRows } = await pool.query(
          'SELECT managed_by_app,state FROM metaapi_accounts WHERE user_id=$1 AND metaapi_account_id=$2 LIMIT 1',
          [userId, accountId],
        );
        if (!accountRows[0] || String(accountRows[0].state || '').toUpperCase() !== 'DEPLOYED') {
          for (const candidate of group) summary.skipped += 1;
          continue;
        }
        token = await resolveToken(userId, accountId, accountRows[0].managed_by_app);
        if (!token) throw new Error('The trading account access token is unavailable.');
        state = await trading.getAccountState({ token, accountId, symbol });
      } catch (error) {
        const message = safeText(error?.message || error, [token]);
        for (const candidate of group) {
          // Inability to look is not the broker refusing a close, so no attempt is consumed and the
          // plan resumes as soon as the account synchronizes again.
          summary.deferred += 1;
          await settleLevel(candidate.id, { status: 'deferred', message: `Account data was not available: ${message}`, retryInMs: BREAK_EVEN_FAILED_RETRY_MS }).catch(() => {});
        }
        continue;
      }

      const spec = state.specification;
      for (const candidate of group) {
        const position = (state.positions || []).find((item) => String(item.id) === String(candidate.broker_position_id));
        if (!position) {
          summary.skipped += 1;
          await settleLevel(candidate.id, { status: 'closed', message: 'The position is no longer open on the broker account.' });
          continue;
        }
        const context = { state, spec, position, token, accountId, logger };
        summary.attempted += 1;
        // Set the moment a close is recorded as filled: from then on nothing may rewrite the level's
        // status from an error handler, because the volume really has left the position and a later
        // failure belongs to the stop move alone.
        let closeSettled = false;
        try {
          if (candidate.status !== 'filled') {
            const side = normalizePositionSide(position.type ?? candidate.side);
            const reached = targetReached({ side, bid: state.price?.bid, ask: state.price?.ask, target: candidate.target_price });
            if (!reached.reached) {
              summary.waited += 1;
              if (reached.reason === 'price-unavailable') {
                await settleLevel(candidate.id, { status: 'deferred', message: 'A fresh quote was not available for this symbol.', retryInMs: BREAK_EVEN_DEFERRED_RETRY_MS });
              }
              continue;
            }
            const sizing = resolveCloseVolume({
              plannedVolume: candidate.planned_volume,
              liveVolume: position.volume,
              minVolume: spec?.minVolume,
              volumeStep: spec?.volumeStep,
            });
            if (sizing.reason === 'position-gone') {
              summary.skipped += 1;
              await settleLevel(candidate.id, { status: 'closed', message: 'The position had no volume left to close.' });
              continue;
            }
            if (sizing.error) {
              // A level the broker cannot honour is settled, not retried: nothing about waiting for a
              // better quote changes a minimum lot size, and the ride keeps the volume instead.
              summary.skipped += 1;
              await settleLevel(candidate.id, { status: 'skipped', message: sizing.error, marketBid: state.price?.bid ?? null, marketAsk: state.price?.ask ?? null });
              continue;
            }
            const { rows: claimed } = await pool.query(
              `UPDATE trade_tp_levels SET status='submitting',attempt_count=attempt_count+1,market_bid=$2,market_ask=$3,updated_at=NOW()
               WHERE id=$1 AND status IN ('pending','deferred','failed') RETURNING id`,
              [candidate.id, state.price?.bid ?? null, state.price?.ask ?? null],
            );
            if (!claimed[0]) { summary.skipped += 1; continue; }
            if (!(await planStillArmed(userId, accountId))) {
              await settleLevel(candidate.id, { status: 'pending', message: 'Auto-Trading was switched off or the account changed before the close was sent.' });
              summary.skipped += 1;
              continue;
            }
            const result = await trading.closePositionPartially({
              token, accountId, positionId: String(candidate.broker_position_id), volume: sizing.volume,
              clientId: stableClientId(`${candidate.id}:${candidate.level_index}`, candidate.symbol),
            });
            const providerResponse = safeProviderResponse(result, token);
            if (!successfulTradeResponse(result)) {
              const message = safeText(result?.message || `MetaAPI rejected the partial close (${result?.stringCode || result?.numericCode || 'unknown provider code'}).`, [token]);
              summary.failed += 1;
              await settleLevel(candidate.id, { status: 'deferred', message, providerResponse, retryInMs: BREAK_EVEN_FAILED_RETRY_MS, marketBid: state.price?.bid ?? null, marketAsk: state.price?.ask ?? null });
              continue;
            }
            const filled = Number(result?.filledVolume);
            const closedVolume = Number.isFinite(filled) && filled > 0 ? Math.min(filled, Number(position.volume)) : sizing.volume;
            const remaining = Math.max(0, Number((Number(position.volume) - closedVolume).toFixed(8)));
            summary.closed += 1;
            await settleLevel(candidate.id, {
              status: 'filled', closedVolume, remainingVolume: remaining, providerResponse,
              message: sizing.note ? `Closed ${closedVolume} lots (${sizing.note}).` : null,
              marketBid: state.price?.bid ?? null, marketAsk: state.price?.ask ?? null,
            });
            closeSettled = true;
            await pool.query(
              'UPDATE trades SET remaining_volume=$1 WHERE id=$2 AND user_id=$3 AND (remaining_volume IS NULL OR remaining_volume > $1)',
              [remaining, candidate.trade_id, userId],
            );
          }
          if (candidate.break_even === true && (candidate.break_even_status === null || candidate.break_even_status === undefined || candidate.break_even_status === 'pending' || candidate.break_even_status === 'deferred')) {
            const moved = await applyPlanBreakEven(candidate, context);
            if (moved === 'moved') summary.breakEvenMoved += 1;
            if (moved === 'deferred' || moved === 'failed') summary.deferred += 1;
          }
        } catch (error) {
          const outcome = classifyBreakEvenFailure(error);
          const message = safeText(outcome.message || error?.message || error, [token]);
          if (closeSettled || candidate.status === 'filled' || candidate.break_even_status === 'pending') {
            // The volume is already out of the position; only the stop move is in question, and the
            // level row itself stays settled so no close is ever re-sent.
            summary.deferred += 1;
            await pool.query(
              `UPDATE trade_tp_levels SET break_even_status=$2,break_even_attempts=break_even_attempts+1,break_even_error=$3,updated_at=NOW()
               WHERE id=$1`,
              [candidate.id, outcome.status === 'unknown' ? 'unknown' : 'deferred', outcome.status === 'unknown' ? `${message} Reconcile the position before changing this plan.` : message],
            ).catch(() => {});
            continue;
          }
          if (outcome.status === 'unknown') {
            summary.failed += 1;
            await settleLevel(candidate.id, { status: 'unknown', message: `${message} The partial close may already have been applied; reconcile the position on the broker account before retrying this plan.` });
            continue;
          }
          summary.deferred += 1;
          await settleLevel(candidate.id, { status: 'deferred', message, retryInMs: BREAK_EVEN_FAILED_RETRY_MS });
        }
      }
    }
    return summary;
  }

  /* --------------------- resting orders: expiry, fills, and the ones the user deleted ---------------------
   *
   * Two failures live in this one sweep, and they are opposite. The first is an order that outlives its
   * setup: a limit order left on the book overnight fills at 03:00 against a market the signal meant nothing
   * about, and the user's account is holding a position their copier never traded. The second is the ghost:
   * the order is gone from the broker - deleted by hand, or expired by the platform's own clock - while this
   * app's row still reads `pending`, so the panel keeps promising a trade that will never arrive and nobody
   * has to do anything about the lie.
   *
   * So one pass reads the broker's book once per account and answers both: expired here, cancel it; gone
   * from the book, find out whether it became a position before calling it cancelled.
   *
   * Two rules about *when it acts* are worth stating, because both cut against a rule elsewhere in the file:
   *
   *  - It reads whatever accounts are reachable, without asking whether auto-trading is on. A row's status
   *    is a statement of fact about the user's account, and turning the copier off is not a reason to let it
   *    go on asserting something false.
   *  - It cancels even when auto-trading is off, as long as the runtime is up and the platform is not paused.
   *    "Auto-trading off" means *stop opening trades for me*; it cannot mean *leave the ones you already
   *    promised waiting to fill*. Refusing to cancel here would be the safe-looking choice and the less safe
   *    one, which is why it is written down rather than inferred.
   */
  let lastExpirySweep = 0;

  /** Which resting orders this app is holding a promise about, oldest deadline first. */
  async function restingCandidates() {
    const { rows } = await pool.query(
      `SELECT t.id AS trade_id,t.user_id,t.execution_job_id,t.signal_id,t.metaapi_account_id,
              t.broker_order_id,t.client_id,t.symbol,t.side,t.entry_price,t.quantity,t.order_type,t.status,
              t.expiry_timestamp,t.created_at,t.error_message
       FROM trades t
       JOIN settings st ON st.user_id=t.user_id AND st.execution_account_id=t.metaapi_account_id
       LEFT JOIN metaapi_accounts ma ON ma.user_id=t.user_id AND ma.metaapi_account_id=t.metaapi_account_id
       WHERE t.status='pending'
         AND UPPER(COALESCE(ma.state,''))='DEPLOYED'
       ORDER BY t.expiry_timestamp NULLS LAST,t.created_at ASC
       LIMIT $1`,
      [EXPIRY_SWEEP_LIMIT],
    );
    return rows;
  }

  /**
   * Whether a record on the broker's book is the order this row is about.
   *
   * MetaAPI copies a `clientId` into the order comment rather than storing it as a constraint, so a match on
   * the id is checked in both places, and an order's own id is compared against the position's `orderId` -
   * which is how a filled limit is recognised: the pending order is gone and a position exists that names it.
   */
  function sameBrokerRecord(candidate, { orderId, clientId }) {
    if (!candidate) return false;
    const id = orderId == null ? null : String(orderId);
    if (id && (String(candidate.orderId ?? '') === id || String(candidate.id ?? '') === id || String(candidate.positionId ?? '') === id)) return true;
    const client = clientId == null ? null : String(clientId);
    if (!client) return false;
    return String(candidate.clientId ?? '') === client || String(candidate.comment ?? '').includes(client);
  }

  /**
   * One row, one answer, one write. `settleRestingOrder` is the only place a resting trade changes status
   * outside the engine's own submission, so the guard `AND status='pending'` sits on it: a sweep that runs
   * twice, or runs while a manual fix is being made, must not overwrite what somebody else decided first.
   */
  async function settleRestingOrder(trade, { status, note, position = null, providerResponse = null, signalStatus = null }) {
    const message = note ? safeText(note) : null;
    const { rows } = await pool.query(
      `UPDATE trades SET status=$2,
              error_message=COALESCE($3,error_message),
              broker_position_id=COALESCE($4,broker_position_id),
              entry_price=CASE WHEN $5::numeric IS NULL THEN entry_price ELSE $5 END,
              quantity=CASE WHEN $6::numeric IS NULL THEN quantity ELSE $6 END,
              executed_at=CASE WHEN $2='executed' AND executed_at IS NULL THEN NOW() ELSE executed_at END,
              provider_response=COALESCE($7,provider_response),
              expiry_timestamp=NULL
       WHERE id=$1 AND status='pending'
       RETURNING id,signal_id,execution_job_id`,
      [trade.trade_id, status, message, position?.positionId ?? position?.id ?? null,
        position ? Number(position.openPrice ?? position.price ?? NaN) || null : null,
        position ? Number(position.volume ?? NaN) || null : null,
        providerResponse],
    );
    if (!rows[0]) return false;
    // The signal row is what the panel reads, and the job row is what the admin history reads. Both are
    // told, best-effort and in that order: a signal whose row moved while the job did not is a stale status,
    // which is a smaller wrong than a trade written as expired that the user's own row still calls pending.
    if (trade.signal_id) {
      const shown = message ? friendlySignalNote(message, { fallback: FRIENDLY_NOTES.generic }) : { text: null, original: null };
      await pool.query('UPDATE signals SET status=COALESCE($2,status),execution_note=COALESCE($3,execution_note),technical_note=COALESCE($4,technical_note) WHERE id=$1', [trade.signal_id, signalStatus, shown.text || null, shown.original || message]).catch(() => {});
    }
    if (trade.execution_job_id) {
      await pool.query('UPDATE execution_jobs SET status=$2,error_message=COALESCE($3,error_message),updated_at=NOW() WHERE id=$1 AND status=$4', [trade.execution_job_id, status, message, 'pending']).catch(() => {});
    }
    return true;
  }

  async function sweepExpiredOrders() {
    const summary = { attempted: 0, expired: 0, cancelled: 0, filled: 0, deferred: 0, waiting: 0, failed: 0, skipped: 0 };
    if (!runtimeEnabled) return { ...summary, reason: 'runtime-disabled' };
    if (typeof trading.getAccountState !== 'function') return { ...summary, reason: 'provider-unsupported' };
    const timestamp = now();
    const intervalMs = Math.max(1_000, Number(expirySweepIntervalMs) || 60_000);
    if (timestamp - lastExpirySweep < intervalMs) return { ...summary, reason: 'throttled' };
    lastExpirySweep = timestamp;

    let rows;
    try {
      rows = await restingCandidates();
    } catch (error) {
      logger.error?.(JSON.stringify({ level: 'error', message: 'Resting order candidates could not be read', error: safeText(error?.message || error) }));
      return { ...summary, reason: 'candidates-unavailable' };
    }
    if (!rows.length) return summary;

    const groups = new Map();
    for (const row of rows) {
      const key = `${row.user_id}|${row.metaapi_account_id || ''}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    }

    // Cancellation is a broker write, so the platform switch is asked once for the whole pass rather than
    // between rows: an administrator engaging it halfway through a sweep must not have it half-applied.
    const mayCancel = !(await tradingPaused());
    for (const group of groups.values()) {
      const [{ user_id: userId, metaapi_account_id: accountId }] = group;
      let state = null;
      let token = null;
      let readOk = false;
      try {
        const { rows: accountRows } = await pool.query(
          'SELECT managed_by_app,state FROM metaapi_accounts WHERE user_id=$1 AND metaapi_account_id=$2 LIMIT 1',
          [userId, accountId],
        );
        if (!accountRows[0] || String(accountRows[0].state || '').toUpperCase() !== 'DEPLOYED') throw new Error('not deployed');
        token = await resolveToken(userId, accountId, accountRows[0].managed_by_app);
        if (!token) throw new Error('token unavailable');
        state = await trading.getAccountState({ token, accountId });
        readOk = Array.isArray(state?.orders) && Array.isArray(state?.positions) && state?.link?.connectedToBroker !== false;
      } catch (error) {
        // An account that cannot be read is not an account whose orders have vanished: every row in the group
        // is left exactly as it is, which is the only answer that cannot cancel a live order by accident.
        summary.deferred += group.length;
        logger.warn?.(JSON.stringify({ level: 'warn', message: 'Resting orders left untouched: the account could not be read', userId, account: accountId, error: safeText(error?.message || error) }));
        continue;
      }

      for (const trade of group) {
        summary.attempted += 1;
        const expiryReached = trade.expiry_timestamp != null && timestamp >= Date.parse(String(trade.expiry_timestamp));
        if (!trade.broker_order_id && !trade.client_id) {
          summary.failed += 1;
          await settleRestingOrder(trade, {
            status: 'unknown',
            signalStatus: 'unknown',
            note: 'This resting order has no broker reference to match it against, so it could not be checked against your account. Confirm it on the platform, then update this trade.',
          }).catch(() => {});
          continue;
        }
        const openOrder = state.orders.find((order) => sameBrokerRecord(order, { orderId: trade.broker_order_id, clientId: trade.client_id }));
        const position = state.positions.find((candidate) => sameBrokerRecord(candidate, { orderId: trade.broker_order_id, clientId: trade.client_id }));
        const deal = (Array.isArray(state.deals) ? state.deals : []).find((candidate) => sameBrokerRecord(candidate, { orderId: trade.broker_order_id, clientId: trade.client_id }));
        let decision = pendingOrderOutcome({
          readOk,
          orderStillOpen: Boolean(openOrder),
          positionFound: Boolean(position),
          dealFound: Boolean(deal),
          expiryReached,
          position: position || null,
          deal: deal || null,
        });
        if (decision.action === 'wait' && expiryReached) {
          if (!mayCancel || typeof trading.cancelOrder !== 'function') {
            summary.waiting += 1;
            continue;
          }
          let cancel = { result: null, error: null };
          try {
            cancel = await trading.cancelOrder({ token, accountId, orderId: openOrder?.id ?? openOrder?.orderId ?? trade.broker_order_id });
          } catch (error) {
            cancel = { result: null, error };
          }
          const interpreted = interpretCancelResponse(cancel);
          if (interpreted.kind === 'rejected' || interpreted.kind === 'unknown') {
            summary.failed += 1;
            // The order stays `pending` and says why, so the next pass tries again and the user can read
            // this without knowing that a cancel was ever attempted.
            await pool.query('UPDATE trades SET error_message=$2 WHERE id=$1', [trade.trade_id, safeText(`The order had passed its expiry but your broker refused to cancel it: ${interpreted.message}`)]).catch(() => {});
            logger.warn?.(JSON.stringify({ level: 'warn', message: 'Expired order could not be cancelled', userId, tradeId: trade.trade_id, error: safeText(interpreted.message) }));
            continue;
          }
          decision = pendingOrderOutcome({
            readOk: true,
            orderStillOpen: false,
            positionFound: Boolean(position),
            dealFound: Boolean(deal),
            expiryReached,
            cancelConfirmed: interpreted.kind === 'cancelled',
            position: position || null,
            deal: deal || null,
          });
          // 10025 means the broker took the cancellation; "already gone" means something else happened first,
          // and the row has to describe *that* instead - which is why the answer is recomputed rather than
          // assumed, so an order the broker filled a moment before our cancel arrives is recorded as a fill.
        }

        if (decision.action === 'defer') { summary.deferred += 1; continue; }
        if (decision.action === 'wait') { summary.waiting += 1; continue; }
        if (decision.action === 'filled') {
          const filledAt = Number(decision.entryPrice);
          await settleRestingOrder(trade, {
            status: 'executed',
            signalStatus: 'executed',
            position: { positionId: decision.positionId, openPrice: Number.isFinite(filledAt) ? filledAt : null, volume: Number(decision.volume) || null },
            note: `Your ${trade.order_type || 'limit'} order at ${trade.entry_price} filled${Number.isFinite(filledAt) ? ` at ${filledAt}` : ''}. Break-even and scale-out were not set up for it: a resting order carries the stop and target it was placed with.`,
          });
          summary.filled += 1;
          continue;
        }
        const expired = decision.action === 'expired';
        await settleRestingOrder(trade, {
          status: expired ? 'expired' : 'cancelled',
          signalStatus: expired ? 'expired' : 'cancelled',
          note: expired
            ? `Cancelled ${new Date(timestamp).toISOString().slice(0, 16).replace('T', ' ')} UTC: the order had passed the expiry it was placed with (${trade.order_type === 'stop' ? 'stop' : 'limit'} at ${trade.entry_price}), so it was taken off your broker account. Nothing was opened.`
            : `This order is no longer on your broker account and never became a position, so it was recorded as cancelled rather than left waiting. If you removed it yourself, nothing further is needed.`,
        });
        if (expired) summary.expired += 1; else summary.cancelled += 1;
      }
    }
    return summary;
  }

  return { processJob, captureDailyBaseline, captureUtcDayBaselines, sweepBreakEven, sweepTakeProfitLevels, sweepExpiredOrders, runtimeEnabled: Boolean(runtimeEnabled) };
}

export function stableClientId(seed, symbol = null) {
  /* One id per *intent*, derived from the durable row rather than a random value, so that a retry of a
     close the broker may already have applied is findable instead of becoming a second close. The builder
     is shared with the entry order for a reason: MetaAPI stores this id inside the order comment, so both
     have to fit the same budget, and a hand-rolled 26-character id next to a 2-character comment is over
     the limit the broker documents. */
  return buildClientId({ jobId: seed, symbol });
}
