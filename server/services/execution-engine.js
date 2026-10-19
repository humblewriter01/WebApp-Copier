import crypto from 'node:crypto';
import { countSignalEntryDeals as countDailySignalEntryDeals, resolveBrokerSymbol } from './signal-parser.js';

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

function successfulTradeResponse(result) {
  const code = String(result?.stringCode || '').toUpperCase();
  const numeric = Number(result?.numericCode);
  return /TRADE_RETCODE_(?:DONE|PLACED|DONE_PARTIAL)/.test(code) || [10008, 10009, 10010].includes(numeric);
}

export function createExecutionEngine({ pool, trading, resolveToken, runtimeEnabled = false, now = () => Date.now() }) {
  if (!pool?.query || !trading?.getAccountState || !trading?.createMarketOrder || typeof resolveToken !== 'function') {
    throw new TypeError('Execution engine dependencies are incomplete.');
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
    await pool.query('UPDATE signals SET status=$1 WHERE id=(SELECT signal_id FROM execution_jobs WHERE id=$2 AND user_id=$3)', [status, jobId, userId]);
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
                st.max_daily_trades,st.daily_loss_limit,st.execution_account_id,
                ma.metaapi_account_id,ma.managed_by_app,ma.state AS account_state
         FROM execution_jobs ej
         JOIN signals s ON s.id=ej.signal_id AND s.user_id=ej.user_id
         JOIN settings st ON st.user_id=ej.user_id
         LEFT JOIN metaapi_accounts ma ON ma.user_id=ej.user_id AND ma.metaapi_account_id=st.execution_account_id
         WHERE ej.id=$1 AND ej.user_id=$2 LIMIT 1`,
        [job.id, job.user_id],
      );
      const item = rows[0];
      if (!item) return stop(job, 'skipped', 'Execution settings, signal, or selected account are unavailable.');
      if (!runtimeEnabled) return stop(job, 'skipped', 'Automatic execution is unavailable on this service.');
      if (item.auto_trading_enabled !== true) return stop(job, 'skipped', 'Auto-Trading is off.');
      if (item.source !== 'telegram' || item.execution_ready !== true) return stop(job, 'skipped', item.parse_error || 'This message is not eligible for automatic execution.');
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
      const stopLoss = Number(item.stop_loss);
      const takeProfit = item.take_profit == null ? null : Number(item.take_profit);
      if (!Number.isFinite(stopLoss) || (item.side === 'buy' ? stopLoss >= bid : stopLoss <= ask)) return stop(job, 'skipped', 'The signal stop loss is missing or on the wrong side of the market.');
      if (takeProfit != null && (!Number.isFinite(takeProfit) || (item.side === 'buy' ? takeProfit <= ask : takeProfit >= bid))) return stop(job, 'skipped', 'The signal take profit is on the wrong side of the market.');

      const volume = calculateOrderVolume({
        mode: item.lot_size_mode,
        fixedLotSize: item.fixed_lot_size,
        balance,
        riskPercent: item.risk_percent,
        side: item.side,
        entryPrice: marketPrice,
        stopLoss,
        specification: state.specification,
        price: quote,
      });
      const clientId = `SD${String(job.id).replaceAll('-', '').slice(0, 24)}`;
      const { rows: tradeRows } = await pool.query(
        `INSERT INTO trades(user_id,signal_id,execution_job_id,metaapi_account_id,symbol,side,quantity,entry_price,stop_loss,take_profit,status,client_id)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'submitting',$11)
         ON CONFLICT(execution_job_id) WHERE execution_job_id IS NOT NULL DO NOTHING
         RETURNING id`,
        [job.user_id, item.signal_id, job.id, item.metaapi_account_id, resolved.symbol, item.side, volume, marketPrice, stopLoss, takeProfit, clientId],
      );
      if (!tradeRows[0]) return stop(job, 'unknown', 'A trade record already exists for this job; automatic retry was blocked for safety.');
      tradeId = tradeRows[0].id;

      orderSubmitted = true;
      const result = await trading.createMarketOrder({ token, accountId: item.metaapi_account_id, side: item.side, symbol: resolved.symbol, volume, stopLoss, takeProfit, clientId });
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

  return { processJob, captureDailyBaseline, captureUtcDayBaselines, runtimeEnabled: Boolean(runtimeEnabled) };
}

export function stableClientId(jobId) {
  return `SD${crypto.createHash('sha256').update(String(jobId)).digest('hex').slice(0, 24)}`;
}
