import test from 'node:test';
import assert from 'node:assert/strict';
import { createExecutionEngine } from '../services/execution-engine.js';

const baseItem = {
  job_id: 'job-1', user_id: 'user-1', job_status: 'processing', expires_at: new Date(Date.now() + 120000),
  signal_id: 'signal-1', source: 'telegram', signal_created_at: new Date(), symbol: 'EURUSD', side: 'buy',
  entry_price: null, stop_loss: 1.09, take_profit: 1.12, execution_ready: true, parse_error: null,
  auto_trading_enabled: true, lot_size_mode: 'fixed', fixed_lot_size: 0.01, risk_percent: 1,
  max_open_positions: 3, max_daily_trades: 10, daily_loss_limit: 5, execution_account_id: 'account-1',
  metaapi_account_id: 'account-1', managed_by_app: true, account_state: 'DEPLOYED',
  subscription_status: 'active', subscription_plan: 'pro',
};

function fakePool({ baseline = 1000, localTrades = 0, disableBeforeSubmit = false, subscriptionStatus = 'active' } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes('SELECT ej.id AS job_id')) return { rows: [{ ...baseItem, subscription_status: subscriptionStatus }] };
      if (sql.includes('SELECT baseline_equity')) return { rows: [{ baseline_equity: baseline }] };
      if (sql.includes('SELECT COUNT(*)::int AS count FROM trades')) return { rows: [{ count: localTrades }] };
      if (sql.includes('SELECT auto_trading_enabled AS "autoTradingEnabled"')) return { rows: [{ autoTradingEnabled: !disableBeforeSubmit, executionAccountId: 'account-1' }] };
      if (sql.includes('INSERT INTO trades')) return { rows: [{ id: 'trade-1' }] };
      return { rows: [], rowCount: 1 };
    },
  };
}

function fakeTrading() {
  const calls = [];
  return {
    calls,
    async getAccountState() {
      calls.push('snapshot');
      return {
        account: { state: 'DEPLOYED' }, accountInformation: { balance: 1000, equity: 1000 },
        positions: [], orders: [], deals: [],
        specification: { symbol: 'EURUSD', minVolume: 0.01, maxVolume: 20, volumeStep: 0.01, tickSize: 0.0001 },
        price: { bid: 1.1, ask: 1.1002, lossTickValue: 1, time: new Date().toISOString() },
      };
    },
    async createMarketOrder(order) {
      calls.push({ order });
      return { stringCode: 'TRADE_RETCODE_DONE', numericCode: 10009, orderId: 'broker-order-1', positionId: 'broker-position-1' };
    },
  };
}

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
