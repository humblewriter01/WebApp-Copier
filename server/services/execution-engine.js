import crypto from 'node:crypto';
import { countSignalEntryDeals as countDailySignalEntryDeals, resolveBrokerSymbol } from './signal-parser.js';
import { isPaidSubscriber, PAID_STATUSES } from './plan-limits.js';
import { signalStatusForJobStatus } from './signal-outcome.js';

const MAX_SIGNAL_AGE_MS = 120_000;
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

export function createExecutionEngine({ pool, trading, resolveToken, runtimeEnabled = false, isTradingPaused = async () => false, now = () => Date.now(), breakEvenIntervalMs = 5_000, breakEvenMaxAttempts = BREAK_EVEN_MAX_ATTEMPTS, logger = console } = {}) {
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

  async function updateJob(jobId, userId, status, errorMessage) {
    await pool.query(
      `UPDATE execution_jobs SET status=$1,error_message=$2,locked_at=NULL,updated_at=NOW() WHERE id=$3 AND user_id=$4`,
      [status, errorMessage || null, jobId, userId],
    );
    // The job table and the signal table describe one event in different words: a skipped job is a
    // signal the workspace reads as unexecuted, and the reason travels with it so the panel never
    // has to guess why nothing reached the broker.
    await pool.query(
      `UPDATE signals SET status=$1,execution_note=$2 WHERE id=(SELECT signal_id FROM execution_jobs WHERE id=$3 AND user_id=$4)`,
      [signalStatusForJobStatus(status), ['skipped', 'expired', 'unknown'].includes(status) ? safeText(errorMessage) || null : null, jobId, userId],
    );
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
    try {
      const { rows } = await pool.query(
        `SELECT ej.id AS job_id,ej.user_id,ej.status AS job_status,ej.expires_at,
                s.id AS signal_id,s.source,s.created_at AS signal_created_at,s.symbol,s.side,s.entry_price,s.stop_loss,s.take_profit,
                s.execution_ready,s.parse_error,
                st.auto_trading_enabled,st.lot_size_mode,st.fixed_lot_size,st.risk_percent,st.max_open_positions,
                st.max_daily_trades,st.daily_loss_limit,st.execution_account_id,st.block_execution_without_stop_loss,
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

      const openTrades = countPositionsAndOrders(state.positions, state.orders);
      if (openTrades >= Number(item.max_open_positions)) return stop(job, 'skipped', 'Maximum open trades has been reached.');
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
      const lossPercent = Math.max(0, ((baseline - equity) / baseline) * 100);
      if (lossPercent >= Number(item.daily_loss_limit)) return stop(job, 'skipped', 'The daily loss limit has been reached.');

      const { rows: localTrades } = await pool.query(
        `SELECT COUNT(*)::int AS count FROM trades
         WHERE user_id=$1 AND metaapi_account_id=$2 AND created_at >= date_trunc('day', NOW() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
           AND status IN ('submitting','executed','unknown','filled')`,
        [job.user_id, item.metaapi_account_id],
      );
      const dailyTrades = Math.max(providerDailyTrades, Number(localTrades[0]?.count || 0));
      if (dailyTrades >= Number(item.max_daily_trades)) return stop(job, 'skipped', 'Maximum daily trades has been reached.');

      const resolved = resolveBrokerSymbol(item.symbol, state.specification ? [state.specification] : []);
      if (!resolved.symbol) return stop(job, 'skipped', resolved.error);
      const quote = state.price;
      const bid = Number(quote?.bid);
      const ask = Number(quote?.ask);
      const marketPrice = item.side === 'buy' ? ask : item.side === 'sell' ? bid : NaN;
      if (![bid, ask, marketPrice].every((value) => Number.isFinite(value) && value > 0)) return stop(job, 'skipped', 'MetaAPI did not provide a valid market quote.');
      if (item.entry_price != null) {
        const desired = Number(item.entry_price);
        if (!Number.isFinite(desired) || (item.side === 'buy' && ask > desired) || (item.side === 'sell' && bid < desired)) return stop(job, 'skipped', 'The current market price is worse than the signal entry price.');
      }
      /* A signal with no stop arrives here as SQL NULL, and `Number(null)` is 0 - a number that is on
         the correct side of any price, so the old check read it as a stop at zero and sent 0 to both
         the trade row and the broker. Null and 0 are now told apart before anything is decided. */
      const stopLoss = item.stop_loss == null ? null : Number(item.stop_loss);
      const hasStopLoss = stopLoss !== null && Number.isFinite(stopLoss);
      const takeProfit = item.take_profit == null ? null : Number(item.take_profit);
      /* A signal without a stop is refused here unless the workspace switched its own Advanced Safety
         guard off, and even then only where a size can be computed without one: risk-based sizing is
         arithmetic on the distance to a stop that does not exist. Each refusal names which rule applied,
         because after the fact "no stop loss" and "you allowed no stop loss" are different sentences. */
      if (!hasStopLoss && item.block_execution_without_stop_loss !== false) {
        return stop(job, 'skipped', 'The signal has no stop loss, and your workspace requires one before an order is sent.');
      }
      if (hasStopLoss && (item.side === 'buy' ? stopLoss >= bid : stopLoss <= ask)) {
        return stop(job, 'skipped', 'The signal stop loss is on the wrong side of the market.');
      }
      if (!hasStopLoss && String(item.lot_size_mode) !== 'fixed') {
        return stop(job, 'skipped', 'Risk-based sizing is calculated from the stop loss, so a signal without one cannot be sized safely.');
      }
      if (takeProfit != null && (!Number.isFinite(takeProfit) || (item.side === 'buy' ? takeProfit <= ask : takeProfit >= bid))) return stop(job, 'skipped', 'The signal take profit is on the wrong side of the market.');

      const volume = calculateOrderVolume({
        mode: item.lot_size_mode,
        fixedLotSize: item.fixed_lot_size,
        balance,
        riskPercent: item.risk_percent,
        side: item.side,
        entryPrice: marketPrice,
        stopLoss: hasStopLoss ? stopLoss : null,
        specification: state.specification,
        price: quote,
      });
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
      const clientId = `SD${String(job.id).replaceAll('-', '').slice(0, 24)}`;
      const { rows: tradeRows } = await pool.query(
        `INSERT INTO trades(user_id,signal_id,execution_job_id,metaapi_account_id,symbol,side,quantity,entry_price,stop_loss,take_profit,status,client_id)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'submitting',$11)
         ON CONFLICT(execution_job_id) WHERE execution_job_id IS NOT NULL DO NOTHING
         RETURNING id`,
        [job.user_id, item.signal_id, job.id, item.metaapi_account_id, resolved.symbol, item.side, volume, marketPrice, hasStopLoss ? stopLoss : null, takeProfit, clientId],
      );
      if (!tradeRows[0]) return stop(job, 'unknown', 'A trade record already exists for this job; automatic retry was blocked for safety.');
      tradeId = tradeRows[0].id;

      orderSubmitted = true;
      const result = await trading.createMarketOrder({ token, accountId: item.metaapi_account_id, side: item.side, symbol: resolved.symbol, volume, stopLoss: hasStopLoss ? stopLoss : undefined, takeProfit, clientId });
      const providerResponse = safeProviderResponse(result, token);
      if (!successfulTradeResponse(result)) {
        const message = safeText(result?.message || result?.description || `MetaAPI rejected the order (${result?.stringCode || result?.numericCode || 'unknown provider code'}).`, [token]);
        await pool.query('UPDATE trades SET status=$1,provider_response=$2,error_message=$3 WHERE id=$4 AND user_id=$5', ['rejected', providerResponse, message, tradeId, job.user_id]);
        await updateJob(job.id, job.user_id, 'rejected', message);
        return { status: 'rejected', message };
      }
      await pool.query(
        `UPDATE trades SET status='executed',provider_response=$1,broker_order_id=$2,broker_position_id=$3,executed_at=NOW() WHERE id=$4 AND user_id=$5`,
        [providerResponse, result?.orderId ? String(result.orderId) : null, result?.positionId ? String(result.positionId) : null, tradeId, job.user_id],
      );
      await updateJob(job.id, job.user_id, 'executed', null);
      // Executing for a user counts as activity, so an account that is trading is never
      // swept up by the inactivity policy.
      await pool.query('UPDATE users SET last_active_at=NOW() WHERE id=$1', [job.user_id]).catch(() => {});
      return { status: 'executed', tradeId, providerResponse };
    } catch (error) {
      const message = safeText(error?.message || error, [token]);
      if (tradeId) {
        const status = orderSubmitted ? 'unknown' : 'rejected';
        await pool.query('UPDATE trades SET status=$1,error_message=$2 WHERE id=$3 AND user_id=$4', [status, message, tradeId, job.user_id]).catch(() => {});
        await updateJob(job.id, job.user_id, status, message).catch(() => {});
        return { status, message };
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

  return { processJob, captureDailyBaseline, captureUtcDayBaselines, sweepBreakEven, runtimeEnabled: Boolean(runtimeEnabled) };
}

export function stableClientId(jobId) {
  return `SD${crypto.createHash('sha256').update(String(jobId)).digest('hex').slice(0, 24)}`;
}
