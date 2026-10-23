import test from 'node:test';
import assert from 'node:assert/strict';
import { createExecutionEngine } from '../services/execution-engine.js';

const baseItem = {
  job_id: 'job-1', user_id: 'user-1', job_status: 'processing', expires_at: new Date(Date.now() + 120000),
  signal_id: 'signal-1', source: 'telegram', signal_created_at: new Date(), symbol: 'EURUSD', side: 'buy',
  entry_price: null, stop_loss: 1.09, take_profit: 1.12, execution_ready: true, parse_error: null,
  auto_trading_enabled: true, lot_size_mode: 'fixed', fixed_lot_size: 0.01, risk_percent: 1,
  block_execution_without_stop_loss: true, block_execution_without_take_profit: true,
  fallback_stop_loss_points: null, fallback_take_profit_points: null,
  max_open_positions: 3, max_daily_trades: 10, daily_loss_limit: 5, execution_account_id: 'account-1',
  metaapi_account_id: 'account-1', managed_by_app: true, account_state: 'DEPLOYED',
  subscription_status: 'active', subscription_plan: 'pro',
};

function fakePool({ baseline = 1000, localTrades = 0, disableBeforeSubmit = false, subscriptionStatus = 'active', item = {} } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes('SELECT ej.id AS job_id')) return { rows: [{ ...baseItem, subscription_status: subscriptionStatus, ...item }] };
      if (sql.includes('SELECT baseline_equity')) return { rows: [{ baseline_equity: baseline }] };
      if (sql.includes('SELECT COUNT(*)::int AS count FROM trades')) return { rows: [{ count: localTrades }] };
      if (sql.includes('SELECT auto_trading_enabled AS "autoTradingEnabled"')) return { rows: [{ autoTradingEnabled: !disableBeforeSubmit, executionAccountId: 'account-1' }] };
      if (sql.includes('INSERT INTO trades')) return { rows: [{ id: 'trade-1' }] };
      return { rows: [], rowCount: 1 };
    },
  };
}

/** The account snapshot is not an order: only `createMarketOrder` may be counted as reaching the broker. */
function orderCalls(trading) {
  return trading.calls.filter((call) => call?.order);
}

/** `stopsLevel` is only ever set by the tests that need a broker with a minimum stop distance. */
function fakeTrading({ stopsLevel, quote, specification, symbol = 'EURUSD', tickSize = 0.0001, lossTickValue = 1 } = {}) {
  const calls = [];
  return {
    calls,
    async getAccountState() {
      calls.push('snapshot');
      return {
        account: { state: 'DEPLOYED' }, accountInformation: { balance: 1000, equity: 1000 },
        positions: [], orders: [], deals: [],
        specification: { symbol, minVolume: 0.01, maxVolume: 20, volumeStep: tickSize === 0.0001 ? 0.01 : 0.01, tickSize, ...(stopsLevel ? { stopsLevel } : {}), ...(specification || {}) },
        price: quote || { bid: 1.1, ask: 1.1002, lossTickValue, time: new Date().toISOString() },
      };
    },
    async createMarketOrder(order) {
      calls.push({ order });
      return { stringCode: 'TRADE_RETCODE_DONE', numericCode: 10009, orderId: 'broker-order-1', positionId: 'broker-position-1' };
    },
  };
}

/* Advanced Safety: whether a signal with no stop loss may be sent at all is the workspace's decision,
   and each of the three answers has to read differently - "your guard refused it", "it went out with no
   stop because you allowed that", and "risk-based sizing needs the stop to exist" are not the same
   sentence, and they used to be one. */
test('a signal with no stop loss is refused while the workspace guard is on', async () => {
  const pool = fakePool({ item: { stop_loss: null, block_execution_without_stop_loss: true } });
  const trading = fakeTrading();
  const engine = createExecutionEngine({ pool, trading, resolveToken: async () => 'fake-token', runtimeEnabled: true });
  const result = await engine.processJob({ id: 'job-1', user_id: 'user-1' });
  assert.equal(result.status, 'skipped');
  assert.match(result.message, /requires one before an order is sent/);
  assert.equal(orderCalls(trading).length, 0, 'nothing reaches the broker while the guard is on');
});

test('with the guard off a fixed-lot order goes out without a stop, and the row records that', async () => {
  const pool = fakePool({ item: { stop_loss: null, block_execution_without_stop_loss: false } });
  const trading = fakeTrading();
  const engine = createExecutionEngine({ pool, trading, resolveToken: async () => 'fake-token', runtimeEnabled: true });
  const result = await engine.processJob({ id: 'job-1', user_id: 'user-1' });
  assert.equal(result.status, 'executed');
  const order = trading.calls.find((call) => call?.order)?.order;
  assert.equal(order.stopLoss, undefined, 'the stop is omitted from the order, not sent as 0 or NaN');
  const inserted = pool.calls.find(({ sql }) => sql.includes('INSERT INTO trades'));
  assert.ok(inserted.params.includes(null), 'the stored trade says it has no stop loss');
  assert.equal(inserted.params.some((value) => Number.isNaN(value)), false, 'NaN never reaches a numeric column');
});

test('the guard cannot be switched off into risk-based sizing, which is calculated from the stop', async () => {
  const pool = fakePool({ item: { stop_loss: null, block_execution_without_stop_loss: false, lot_size_mode: 'risk_based' } });
  const trading = fakeTrading();
  const engine = createExecutionEngine({ pool, trading, resolveToken: async () => 'fake-token', runtimeEnabled: true });
  const result = await engine.processJob({ id: 'job-1', user_id: 'user-1' });
  assert.equal(result.status, 'skipped');
  assert.match(result.message, /cannot be sized safely/);
  assert.equal(orderCalls(trading).length, 0);
});

/* The take-profit block, the second half of the same idea: a provider that forgot a target used to be
   able to leave a filled position running with nothing to close it. */
test('a signal with no take-profit target is refused while the workspace guard is on', async () => {
  const pool = fakePool({ item: { take_profit: null, block_execution_without_stop_loss: true, block_execution_without_take_profit: true } });
  const trading = fakeTrading();
  const engine = createExecutionEngine({ pool, trading, resolveToken: async () => 'fake-token', runtimeEnabled: true });
  const result = await engine.processJob({ id: 'job-1', user_id: 'user-1' });
  assert.equal(result.status, 'skipped');
  assert.match(result.message, /require a take-profit target/);
  assert.equal(orderCalls(trading).length, 0, 'a position with nothing to close it is not sent because the stop is fine');
});

test('the target block is independent of the stop block', async () => {
  // The stop is present, the target is not, and only the second one is switched off: the order goes out
  // protected on the side the signal stated and naked on the side the user chose to allow.
  const pool = fakePool({ item: { take_profit: null, block_execution_without_stop_loss: true, block_execution_without_take_profit: false } });
  const trading = fakeTrading();
  const engine = createExecutionEngine({ pool, trading, resolveToken: async () => 'fake-token', runtimeEnabled: true });
  const result = await engine.processJob({ id: 'job-1', user_id: 'user-1' });
  assert.equal(result.status, 'executed');
  const order = trading.calls.find((call) => call?.order)?.order;
  assert.equal(order.stopLoss, 1.09, 'the signal\'s own stop still goes out');
  // `null` is what the order carries for a leg that does not exist, which the broker adapter turns into
  // an omitted field. Neither is allowed to become 0, the number that means "stop at zero".
  assert.equal(order.takeProfit, null, 'a missing target is never sent as 0');
});

test('a missing leg is completed from the workspace fallback distance', async () => {
  // 100 points under the order price and 200 above it, measured from the quote this order is sent at
  // (ask 1.1002) on a 0.0001 tick - not from the signal's entry price, which may be hours old.
  const pool = fakePool({ item: { stop_loss: null, take_profit: null, fallback_stop_loss_points: 100, fallback_take_profit_points: 200 } });
  const trading = fakeTrading();
  const engine = createExecutionEngine({ pool, trading, resolveToken: async () => 'fake-token', runtimeEnabled: true });
  const result = await engine.processJob({ id: 'job-1', user_id: 'user-1' });
  assert.equal(result.status, 'executed', 'a fallback is a stop, so the block is satisfied rather than overridden');
  const order = trading.calls.find((call) => call?.order)?.order;
  assert.equal(order.stopLoss, 1.0902);
  assert.equal(order.takeProfit, 1.1202);
  const inserted = pool.calls.find(({ sql }) => sql.includes('INSERT INTO trades'));
  assert.ok(inserted.params.includes(1.0902) && inserted.params.includes(1.1202), 'the trade row stores the legs that were actually sent');
  const mirrored = pool.calls.find(({ sql }) => sql.includes('UPDATE signals SET status='));
  assert.ok(mirrored.params.some((value) => String(value).includes('Your Safety fallback distances were used')), 'the signal explains where its stop came from');
  assert.match(mirrored.params.find((value) => String(value).startsWith('Your Safety')), /stop loss 100 points below the order price and target 200 points above it\./);
});

test("the signal's own levels win over the fallback", async () => {
  const pool = fakePool({ item: { fallback_stop_loss_points: 1, fallback_take_profit_points: 1 } });
  const trading = fakeTrading();
  const engine = createExecutionEngine({ pool, trading, resolveToken: async () => 'fake-token', runtimeEnabled: true });
  const result = await engine.processJob({ id: 'job-1', user_id: 'user-1' });
  assert.equal(result.status, 'executed');
  const order = trading.calls.find((call) => call?.order)?.order;
  assert.equal(order.stopLoss, 1.09, 'a provider that stated its stop is never overwritten by the workspace');
  assert.equal(order.takeProfit, 1.12);
  const mirrored = pool.calls.find(({ sql }) => sql.includes('UPDATE signals SET status='));
  assert.equal(mirrored.params.includes(null), true, 'nothing was borrowed, so nothing is explained on the row');
  assert.equal(mirrored.params.some((value) => String(value).includes('fallback')), false);
});

test('a fallback the broker would refuse stops the order instead of being dropped', async () => {
  /* Sending a 10-point stop to a symbol whose broker demands 50 is how a request comes back
     INVALID_STOPS - or, worse, fills and is closed by a level nobody chose. The distance is reported as
     unusable and the block applies to the leg as if no fallback existed. */
  const pool = fakePool({ item: { stop_loss: null, block_execution_without_stop_loss: true, fallback_stop_loss_points: 10 } });
  const trading = fakeTrading({ stopsLevel: 50 });
  const engine = createExecutionEngine({ pool, trading, resolveToken: async () => 'fake-token', runtimeEnabled: true });
  const result = await engine.processJob({ id: 'job-1', user_id: 'user-1' });
  assert.equal(result.status, 'skipped');
  assert.match(result.message, /requires stops at least 50 points from the market, and the fallback distance is 10/);
  assert.equal(orderCalls(trading).length, 0);
});

test('an override is logged as one, with the account it happened on', async () => {
  const warnings = [];
  const pool = fakePool({ item: { stop_loss: null, take_profit: null, block_execution_without_stop_loss: false, block_execution_without_take_profit: false } });
  const trading = fakeTrading();
  const engine = createExecutionEngine({
    pool, trading, resolveToken: async () => 'fake-token', runtimeEnabled: true,
    logger: { warn: (line) => warnings.push(JSON.parse(line)), error: () => {}, info: () => {} },
  });
  const result = await engine.processJob({ id: 'job-1', user_id: 'user-1' });
  assert.equal(result.status, 'executed');
  assert.deepEqual(warnings.map((warning) => warning.message), [
    'Trade executed without Stop Loss (User Override). No fallback distance is configured.',
    'Trade executed without Take Profit (User Override). No fallback distance is configured.',
  ]);
  assert.equal(warnings[0].userId, 'user-1');
  assert.equal(warnings[0].jobId, 'job-1');
  assert.equal(warnings[0].symbol, 'EURUSD');
  assert.equal(warnings.every((warning) => warning.level === 'warn'), true);
});

test('runtime OFF is a hard gate and cannot call the broker adapter', async () => {
  const pool = fakePool();
  const trading = fakeTrading();
  const engine = createExecutionEngine({ pool, trading, resolveToken: async () => 'fake-token', runtimeEnabled: false });
  const result = await engine.processJob({ id: 'job-1', user_id: 'user-1' });
  assert.equal(result.status, 'skipped');
  assert.equal(trading.calls.length, 0);
  assert.ok(pool.calls.some(({ sql }) => sql.includes('UPDATE execution_jobs')));
});

test('fully gated test signal sends only to the injected fake adapter and persists a sanitized execution result', async () => {
  const pool = fakePool();
  const trading = fakeTrading();
  const engine = createExecutionEngine({ pool, trading, resolveToken: async () => 'fake-token', runtimeEnabled: true });
  const result = await engine.processJob({ id: 'job-1', user_id: 'user-1' });
  assert.equal(result.status, 'executed');
  const orderCall = trading.calls.find((call) => typeof call === 'object');
  const order = orderCall?.order;
  assert.deepEqual({ side: order.side, symbol: order.symbol, volume: order.volume, stopLoss: order.stopLoss, takeProfit: order.takeProfit }, {
    side: 'buy', symbol: 'EURUSD', volume: 0.01, stopLoss: 1.09, takeProfit: 1.12,
  });
  const insert = pool.calls.find(({ sql }) => sql.includes('INSERT INTO trades'));
  assert.ok(insert, 'trade row is created before submitting the market order');
  assert.ok(pool.calls.some(({ sql }) => sql.includes("SET status='executed'")));
  assert.ok(pool.calls.some(({ sql }) => sql.includes('UPDATE users SET last_active_at=NOW()')), 'a executed signal keeps the workspace active');
});

test('a signal for a user without a paid plan is never sent to the broker', async () => {
  for (const status of ['free', 'canceled', 'expired', 'past_due']) {
    const pool = fakePool({ subscriptionStatus: status });
    const trading = fakeTrading();
    const engine = createExecutionEngine({ pool, trading, resolveToken: async () => 'fake-token', runtimeEnabled: true });
    const result = await engine.processJob({ id: 'job-1', user_id: 'user-1' });
    assert.equal(result.status, 'skipped', `${status} must not execute`);
    assert.match(result.message, /paid plan/i);
    assert.equal(trading.calls.length, 0, 'no MetaAPI call at all');
    assert.equal(pool.calls.some(({ sql }) => sql.includes('INSERT INTO trades')), false, 'no trade row');
  }
});

test('a newly turned-off setting blocks queued work before any MetaAPI order call', async () => {
  const pool = fakePool({ disableBeforeSubmit: true });
  const trading = fakeTrading();
  const engine = createExecutionEngine({ pool, trading, resolveToken: async () => 'fake-token', runtimeEnabled: true });
  const result = await engine.processJob({ id: 'job-1', user_id: 'user-1' });
  assert.equal(result.status, 'skipped');
  assert.match(result.message, /turned off/i);
  assert.equal(trading.calls.filter((call) => typeof call === 'object').length, 0);
  assert.equal(pool.calls.some(({ sql }) => sql.includes('INSERT INTO trades')), false);
});

/* ------------------------- platform kill switch -------------------------
 * The switch is an operator's last resort, so the questions it has to answer are narrow: does it
 * stop the order, does it stop it before anything touches the broker, and does an unreadable
 * switch fail towards "no trade" rather than "trade".
 */
test('an engaged kill switch skips the job without touching MetaAPI at all', async () => {
  const pool = fakePool();
  const trading = fakeTrading();
  let asked = 0;
  const engine = createExecutionEngine({
    pool, trading, resolveToken: async () => 'fake-token', runtimeEnabled: true,
    isTradingPaused: async () => { asked += 1; return true; },
  });
  const result = await engine.processJob({ id: 'job-1', user_id: 'user-1' });
  assert.equal(result.status, 'skipped');
  assert.match(result.message, /paused by Signal Desk/i);
  assert.equal(asked, 1, 'the switch is asked first, before any expensive work');
  assert.equal(trading.calls.length, 0, 'not even the account snapshot is fetched');
  assert.equal(pool.calls.some(({ sql }) => sql.includes('INSERT INTO trades')), false, 'no trade row is opened');
  assert.ok(pool.calls.some(({ sql }) => sql.includes('UPDATE execution_jobs')), 'the skip is recorded for the user to read');
});

test('a switch engaged while a job is in flight stops it at the last gate before the order', async () => {
  const pool = fakePool();
  const trading = fakeTrading();
  let calls = 0;
  const engine = createExecutionEngine({
    pool, trading, resolveToken: async () => 'fake-token', runtimeEnabled: true,
    // released for the gates, engaged by the time the order is about to be sent
    isTradingPaused: async () => { calls += 1; return calls > 1; },
  });
  const result = await engine.processJob({ id: 'job-1', user_id: 'user-1' });
  assert.equal(result.status, 'skipped');
  assert.match(result.message, /before it reached the broker/i);
  assert.equal(calls, 2, 'checked once per job AND once more immediately before the trade');
  assert.equal(trading.calls.filter((call) => typeof call === 'object').length, 0, 'createMarketOrder was never reached');
  assert.equal(pool.calls.some(({ sql }) => sql.includes('INSERT INTO trades')), false);
});

test('a released switch is asked twice per job and never blocks the trade', async () => {
  const pool = fakePool();
  const trading = fakeTrading();
  let calls = 0;
  const engine = createExecutionEngine({
    pool, trading, resolveToken: async () => 'fake-token', runtimeEnabled: true,
    isTradingPaused: async () => { calls += 1; return false; },
  });
  assert.equal((await engine.processJob({ id: 'job-1', user_id: 'user-1' })).status, 'executed');
  assert.equal(calls, 2);
  assert.equal(trading.calls.filter((call) => typeof call === 'object').length, 1);
});

test('a kill switch that cannot be read stops trading instead of guessing', async () => {
  const pool = fakePool();
  const trading = fakeTrading();
  const logged = [];
  const engine = createExecutionEngine({
    pool, trading, runtimeEnabled: true, logger: { error: (line) => logged.push(line) },
    resolveToken: async () => 'fake-token',
    isTradingPaused: async () => { throw Object.assign(new Error('connection terminated'), { code: '08006' }); },
  });
  const result = await engine.processJob({ id: 'job-1', user_id: 'user-1' });
  assert.equal(result.status, 'skipped');
  assert.match(result.message, /paused by Signal Desk/i);
  assert.equal(trading.calls.length, 0);
  assert.equal(JSON.parse(logged[0]).message, 'The platform auto-trading switch could not be read; execution stays blocked');
});

test('an engine built without the switch still trades, and the flag is never trusted from the job payload', async () => {
  const pool = fakePool();
  const trading = fakeTrading();
  const engine = createExecutionEngine({ pool, trading, resolveToken: async () => 'fake-token', runtimeEnabled: true });
  assert.equal((await engine.processJob({ id: 'job-1', user_id: 'user-1', tradingPaused: true })).status, 'executed');
});

/* ---------------------------------------------------------------------------------------------
 * One real message, end to end. The text below is a post exactly as a channel writes it - the metal
 * named in words, the entry as a zone, three numbered targets with the last one left open, and a
 * disclaimer underneath - because that is the shape the reader has to survive, and every one of those
 * four features used to cost a signal somewhere: the metal was no symbol, the zone was no entry, and
 * each "TP n" line contributed its index as a price.
 * ------------------------------------------------------------------------------------------- */

const GOLD_TEXT = `GOLD SELL NOW IN ZONE  4031.50-4138.60

(SCALPING)

TP 1 : 4029.50

TP 2 : 4027.50

TP 3 : OPEN

SL :  4041.50

Use Proper Money Management. Past Profits do not predict future earnings. Consistency is`;

const goldItem = {
  symbol: 'XAUUSD', side: 'sell', entry_price: 4031.5, stop_loss: 4041.5, take_profit: 4029.5,
  execution_ready: true, parse_error: null,
};
const goldQuote = { bid: 4032.1, ask: 4032.6, lossTickValue: 100, time: new Date().toISOString() };
const goldSpec = { symbol: 'XAUUSD', tickSize: 0.01, minVolume: 0.01, maxVolume: 100, volumeStep: 0.01 };

test('the gold zone message is executed as a market sell with the channel’s own stop and first target', async () => {
  const { parseSignal } = await import('../services/signal-parser.js');
  const parsed = parseSignal(GOLD_TEXT);
  // The row the listener would write, straight from the text: no invented price, no dropped one.
  assert.deepEqual(
    { symbol: parsed.symbol, side: parsed.side, entry: parsed.entryPrice, stop: parsed.stopLoss, target: parsed.takeProfit },
    { symbol: 'XAUUSD', side: 'sell', entry: 4031.5, stop: 4041.5, target: 4029.5 },
  );

  const pool = fakePool({ item: goldItem });
  const trading = fakeTrading({ quote: goldQuote, specification: goldSpec, symbol: 'XAUUSD', tickSize: 0.01 });
  const engine = createExecutionEngine({ pool, trading, resolveToken: async () => 'fake-token', runtimeEnabled: true });
  const result = await engine.processJob({ id: 'job-1', user_id: 'user-1' });
  assert.equal(result.status, 'executed', JSON.stringify(result));
  const order = trading.calls.find((call) => call?.order)?.order;
  assert.equal(order.side, 'sell');
  assert.equal(order.symbol, 'XAUUSD', 'the canonical symbol is what the account’s own list confirmed');
  assert.equal(order.stopLoss, 4041.5, 'the channel’s stop, not a fallback distance');
  assert.equal(order.takeProfit, 4029.5, 'TP1 is the exit, and the order is not held open for TP3');
  assert.equal(order.volume, 0.01, 'fixed-lot sizing needs nothing from the signal');
  assert.equal('entryPrice' in order, false, 'the zone never becomes a limit price: this is a market order');
  const inserted = pool.calls.find(({ sql }) => sql.includes('INSERT INTO trades'));
  assert.equal(inserted.params[7], 4032.1, 'recorded at the price a sell is really sent at - the bid - not at the zone');
  assert.equal(inserted.params[9], 4029.5);
});

test('a market that has already run past the zone is refused, and the sentence says which bound failed', async () => {
  // A sell below the bottom of its entry zone is a worse trade than the channel described, and the
  // conservative bound is what makes that visible: 4030.00 is inside the zone's text but under its low.
  const pool = fakePool({ item: goldItem });
  const trading = fakeTrading({ quote: { ...goldQuote, bid: 4030.0, ask: 4030.5 }, specification: goldSpec, symbol: 'XAUUSD', tickSize: 0.01 });
  const engine = createExecutionEngine({ pool, trading, resolveToken: async () => 'fake-token', runtimeEnabled: true });
  const result = await engine.processJob({ id: 'job-1', user_id: 'user-1' });
  assert.equal(result.status, 'skipped');
  assert.match(result.message, /worse than the signal entry price/);
  assert.equal(orderCalls(trading).length, 0, 'nothing reaches the broker on the wrong side of the zone');
});
