/**
 * What the execution engine does with an order type, a price that moved, and a deadline.
 *
 * These run the real job: the message text is parsed by the real parser, the parsed row is fed through the
 * engine as the queue would feed it, and the assertions are read off what the mocked broker adapter was
 * *called with* and what the fake pool was *asked to write*. Nothing here tests a SQL string in isolation,
 * because the failure mode of this feature is not a wrong query - it is an order that should not have been
 * sent, or one that should have been cancelled and was not.
 *
 * Five behaviours are the contract, and each has a test named for it:
 *   a market order at a better price is taken, not refused;
 *   a market order at a worse price is judged by the workspace's drift guard;
 *   a scalp is executed immediately when the market is already at its level, and its order lives two minutes;
 *   a limit order past its expiry is cancelled through the broker and recorded as expired;
 *   an order the user deleted on the platform is recorded as cancelled, not left as a ghost.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { parseSignal } from '../services/signal-parser.js';
import { createExecutionEngine } from '../services/execution-engine.js';

/** A clock the tests can pin, so "two minutes" is a number they can assert rather than race. */
const AT = Date.parse('2026-10-25T12:00:00.000Z');
const clock = () => AT;

const SPEC = { symbol: 'XAUUSD', minVolume: 0.01, maxVolume: 100, volumeStep: 0.01, tickSize: 0.01, stopsLevel: 10 };
const GOLD = { bid: 4109, ask: 4109.2, time: null };

/* The quote is stamped with the pinned clock, not the wall clock: an engine told it is noon and handed a
   quote timestamped "now" correctly refuses to trade on it, and a fixture that is stale is not a test of
   anything except the fixture. */
const quoteAt = (bid, ask = bid + 0.2) => ({ bid, ask, time: new Date(AT).toISOString() });
const goldQuote = (bid, ask) => quoteAt(bid, ask ?? bid + 0.2);

/** The row `saveSignal` would have written, derived from the real parse of the real message. */
function signalItem(message, over = {}) {
  const parsed = parseSignal(message);
  if (parsed.parseError && !over.parse_error) throw new Error(`the fixture message is not executable: ${parsed.parseError}`);
  return {
    job_id: 'job-1', user_id: 'user-1', job_status: 'processing', attemptCount: 1,
    // Every timestamp on the fixture is pinned to the clock the engine is given below: a signal "created" at
    // the real wall clock while the engine believes it is noon is read as arriving from the future, and the
    // engine's own rule for that is to refuse it. A fixture must not be able to fail for being a fixture.
    expires_at: new Date(AT + 120_000).toISOString(),
    signal_id: 'signal-1', source: 'telegram', signal_created_at: new Date(AT),
    symbol: parsed.symbol, side: parsed.side,
    entry_price: parsed.entryPrice, stop_loss: parsed.stopLoss, take_profit: parsed.takeProfit,
    orderType: parsed.orderType, orderTypeStated: parsed.orderTypeStated, isScalping: parsed.isScalping,
    execution_ready: true, parse_error: null, needs_review: false,
    stop_loss_pips: parsed.stopLossPips, take_profit_pips: parsed.takeProfitPips,
    auto_trading_enabled: true, lot_size_mode: 'fixed', fixed_lot_size: 0.01, risk_percent: 1,
    block_execution_without_stop_loss: true, block_execution_without_take_profit: false,
    fallback_stop_loss_points: null, fallback_take_profit_points: null,
    max_open_positions: 3, max_daily_trades: 10, daily_loss_limit: 5,
    execution_account_id: 'account-1', metaapi_account_id: 'account-1', managed_by_app: true,
    account_state: 'DEPLOYED', subscription_status: 'active', subscription_plan: 'pro',
    multipleTargetHandling: 'first_target', takeProfitLevels: parsed.takeProfitLevels,
    limitOrderExpiryValue: 30, limitOrderExpiryUnit: 'minutes', maxSlippagePoints: null,
    ...over,
  };
}

function fakePool(item, { trades = [] } = {}) {
  const calls = [];
  return {
    calls,
    find: (needle) => calls.find((call) => call.sql.includes(needle)),
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes('SELECT ej.id AS job_id')) return { rows: [item] };
      if (sql.includes('SELECT baseline_equity')) return { rows: [{ baseline_equity: 1000 }] };
      if (sql.includes('SELECT COUNT(*)::int AS count FROM trades')) return { rows: [{ count: 0 }] };
      if (sql.includes('SELECT auto_trading_enabled AS "autoTradingEnabled"')) return { rows: [{ autoTradingEnabled: true, executionAccountId: 'account-1' }] };
      if (sql.includes('INSERT INTO trades')) return { rows: [{ id: 'trade-1' }] };
      if (sql.includes("WHERE t.status='pending'")) return { rows: trades };
      if (sql.includes('SELECT managed_by_app,state FROM metaapi_accounts')) return { rows: [{ managed_by_app: true, state: 'DEPLOYED' }] };
      if (sql.includes('UPDATE trades SET status=$2,')) return { rows: [{ id: 'trade-1', signal_id: 'signal-1', execution_job_id: 'job-1' }] };
      return { rows: [], rowCount: 1 };
    },
  };
}

/**
 * A broker that answers like MetaAPI: one list of open orders, one of positions, and a trade response with a
 * retcode. `orders` and `positions` are what the sweep reads, so a test says "this order is still on the book"
 * by putting it in the array rather than by mocking a method.
 */
function fakeAdapter({ price, orders = [], positions = [], deals = [], link = { connectedToBroker: true, synchronized: true } } = {}) {
  const calls = [];
  return {
    calls,
    marketOrders: () => calls.filter((call) => call.kind === 'market').map((call) => call.args),
    pendingOrders: () => calls.filter((call) => call.kind === 'pending').map((call) => call.args),
    cancels: () => calls.filter((call) => call.kind === 'cancel').map((call) => call.args),
    async getAccountState() {
      if (price === null) throw new Error('MetaAPI account is not connected to the broker.');
      return {
        account: { state: 'DEPLOYED' },
        accountInformation: { balance: 1000, equity: 1000 },
        positions, orders, deals, specification: SPEC,
        price: price || goldQuote(4109, 4109.2),
        link,
      };
    },
    async createMarketOrder(args) {
      calls.push({ kind: 'market', args });
      return { stringCode: 'TRADE_RETCODE_DONE', numericCode: 10009, orderId: 'order-1', positionId: 'position-1' };
    },
    async createPendingOrder(args) {
      calls.push({ kind: 'pending', args });
      return { stringCode: 'TRADE_RETCODE_PLACED', numericCode: 10009, orderId: 'resting-1' };
    },
    async cancelOrder(args) {
      calls.push({ kind: 'cancel', args });
      // The real adapter answers `{ result, error }`, because a refusal to cancel is an outcome the sweep has
      // to read rather than an exception it has to survive. A fake that answered in a different shape would be
      // testing a broker that does not exist.
      return { result: { stringCode: 'TRADE_RETCODE_DONE', numericCode: 10025 }, error: null };
    },
    async findOrderByClientId() { return null; },
  };
}

function runEngine({ message, item, adapterOptions = {}, over = {} }) {
  const parsed = item ? null : parseSignal(message);
  const row = item || signalItem(message, over);
  const pool = fakePool(row, adapterOptions.pool || {});
  const adapter = fakeAdapter({ price: adapterOptions.price ?? goldQuote(4109, 4109.2), ...adapterOptions });
  const engine = createExecutionEngine({
    pool,
    trading: adapter,
    resolveToken: async () => 'fake-token',
    runtimeEnabled: true,
    isTradingPaused: async () => false,
    now: clock,
    logger: { info() {}, warn() {}, error() {} },
  });
  return { pool, adapter, engine, parsed, result: () => engine.processJob({ id: 'job-1', user_id: 'user-1' }) };
}

const updateFor = (pool, needle) => pool.calls.filter((call) => call.sql.includes(needle));

/**
 * The sentence the engine left on the signal row. `updateJob` writes the job and mirrors the note onto the
 * signal in two statements, and the note - not the job's error column - is the half a user reads, so the
 * assertions below look for the mirror rather than guessing at which of the two carries it.
 */
const signalNote = (pool) => {
  const mirror = pool.calls.find((call) => call.sql.includes('UPDATE signals SET status=$1,execution_note=$2'));
  return { status: mirror?.params[0] ?? null, note: mirror?.params[1] ?? '' };
};

/* ----------------------------------------------------- 1. a better price is never a reason to refuse ----------------------------------------------------- */

test('BUY NOW 4110 with the ask at 4109 is executed at 4109, not cancelled', async () => {
  const run = runEngine({ message: 'BUY GOLD NOW 4110 SL 4100 TP 4130', adapterOptions: { price: goldQuote(4109, 4109) } });
  const result = await run.result();
  assert.equal(result.status, 'executed', 'the trade is taken: the channel was given a better price, not a broken one');
  const [order] = run.adapter.marketOrders();
  assert.equal(order.side, 'buy');
  assert.equal(run.adapter.pendingOrders().length, 0, 'and it is a market order, because the message said NOW');
  const inserted = run.pool.calls.find((call) => call.sql.includes('INSERT INTO trades'));
  assert.equal(inserted.params[7], 4109, 'the trade is booked at the price the order went out at, not at the published one');
  assert.equal(inserted.params[11], 'market', 'the order type the row was captured with is the one written to the trade');
  const executed = updateFor(run.pool, "UPDATE trades SET status='executed'");
  assert.equal(executed.length, 1, 'and the trade is settled as executed');
  const { status: signalStatus, note } = signalNote(run.pool);
  assert.equal(signalStatus, 'executed');
  assert.match(note, /Filled 100 points better than the signal price of 4110/, 'the reader is told the price moved in their favour, in points');
});

/* ----------------------------------------------------- 2. a worse price belongs to the workspace ----------------------------------------------------- */

test('BUY NOW 4110 with the ask at 4115 is skipped when no drift is allowed', async () => {
  const run = runEngine({ message: 'BUY GOLD NOW 4110 SL 4100 TP 4130', adapterOptions: { price: goldQuote(4115, 4115) } });
  const result = await run.result();
  assert.equal(result.status, 'skipped');
  assert.equal(run.adapter.calls.length, 0, 'nothing reaches the broker');
  assert.match(result.message, /the ask is 500 points above the signal price of 4110/);
  assert.match(result.message, /allows no drift at all/);
});

test('the same trade is taken when the workspace allows that much drift', async () => {
  const run = runEngine({ message: 'BUY GOLD NOW 4110 SL 4100 TP 4130', over: { maxSlippagePoints: 600 }, adapterOptions: { price: goldQuote(4115, 4115) } });
  const result = await run.result();
  assert.equal(result.status, 'executed', '600 points of allowance covers 500 points of drift');
  const inserted = run.pool.calls.find((call) => call.sql.includes('INSERT INTO trades'));
  assert.equal(inserted.params[13], 500, 'the drift the entry was taken at is stored on the trade');
  assert.equal(inserted.params[7], 4115, 'and the trade records the price it actually went out at');
});

test('for a sell, higher is better and lower is worse - the guard is not symmetric by accident', async () => {
  const better = runEngine({ message: 'SELL GOLD NOW 4110 SL 4120 TP 4090', adapterOptions: { price: goldQuote(4115, 4115.2) } });
  assert.equal((await better.result()).status, 'executed', 'a sell at 4115 when 4110 was published is a better fill');

  const worse = runEngine({ message: 'SELL GOLD NOW 4110 SL 4120 TP 4090', adapterOptions: { price: goldQuote(4100, 4100.2) } });
  const refused = await worse.result();
  assert.equal(refused.status, 'skipped');
  assert.match(refused.message, /the bid is 1000 points below the signal price of 4110/);

  const allowed = runEngine({ message: 'SELL GOLD NOW 4110 SL 4120 TP 4090', over: { maxSlippagePoints: 1000 }, adapterOptions: { price: goldQuote(4100, 4100.2) } });
  assert.equal((await allowed.result()).status, 'executed', 'exactly at the allowance, the trade stands');
});

/* ----------------------------------------------------- 3. scalping ----------------------------------------------------- */

test('GOLD SELL NOW (SCALPING) is executed at once when the market is already at the level', async () => {
  const run = runEngine({ message: 'GOLD SELL NOW (SCALPING) Entry 4109 SL 4120 TP 4090', adapterOptions: { price: goldQuote(4109, 4109.2) } });
  const result = await run.result();
  assert.equal(result.status, 'executed', 'a scalp with the price in reach is taken, not rested');
  assert.equal(run.adapter.pendingOrders().length, 0, 'no pending order is placed for a signal that can be filled now');
  const written = run.pool.calls.find((call) => call.sql.includes('UPDATE signals SET expiry_timestamp=$2'));
  assert.ok(written, 'the two-minute bound the channel asked for is stored on the signal');
  assert.equal(Date.parse(written.params[1].toISOString()), AT + 120_000, 'two minutes from now, whatever the workspace has set');
});

test('a scalp that cannot be filled rests for two minutes, not for the workspace expiry', async () => {
  const run = runEngine({
    message: 'GOLD SELL SCALPING Entry 4120 SL 4130 TP 4090',
    over: { limitOrderExpiryValue: 8, limitOrderExpiryUnit: 'hours' },
    adapterOptions: { price: goldQuote(4109, 4109.2) },
  });
  const result = await run.result();
  assert.equal(result.status, 'pending');
  const [order] = run.adapter.pendingOrders();
  assert.equal(order.expiration.type, 'ORDER_TIME_SPECIFIED');
  assert.equal(order.expiration.time.getTime() - AT, 120_000, 'the user asked for 8 hours; a scalp gets 2 minutes');
});

/* ----------------------------------------------------- 4. a limit order is a real pending order ----------------------------------------------------- */

test('a limit order is placed on the broker with the signal legs and the workspace expiry', async () => {
  const run = runEngine({ message: 'BUY GOLD LIMIT 4011 SL 4005 TP 4030', adapterOptions: { price: goldQuote(4020, 4020.2) } });
  const result = await run.result();
  assert.equal(result.status, 'pending');
  const [order] = run.adapter.pendingOrders();
  assert.equal(run.adapter.marketOrders().length, 0, 'nothing is bought at the market price');
  assert.equal(order.kind, 'limit');
  assert.equal(order.side, 'buy');
  assert.equal(order.price, 4011);
  assert.equal(order.stopLoss, 4005);
  assert.equal(order.takeProfit, 4030);
  assert.equal(order.expiration.time.getTime() - AT, 30 * 60_000, 'the default half hour, sent to the platform as well as stored');
  assert.match(order.clientId, /^SD_XAUUSD_/);

  const settled = run.pool.calls.find((call) => call.sql.includes("UPDATE trades SET status='pending'"));
  assert.equal(settled.params[1], 'resting-1', 'the order id the broker returned is the one later sweeps act on');
  assert.equal(settled.params[2].getTime(), AT + 30 * 60_000);
  const job = run.pool.calls.find((call) => call.sql.includes('UPDATE execution_jobs SET status=$1'));
  assert.equal(job.params[0], 'pending', 'the job waits, it does not finish');
  assert.equal(job.params[1], null, 'a resting order is not an error, so nothing is written in the error column');
  const { status: signalStatus, note } = signalNote(run.pool);
  assert.equal(signalStatus, 'pending', 'and the signal row says the same thing the job does');
  assert.match(note, /Limit order placed at 4011, valid for 30 minutes/);
  assert.match(note, /your 30-minute expiry setting/);
  assert.match(note, /cancelled automatically if it has not filled by 12:30 UTC/);
});

test('a resting order measures its fallback legs from the order price, not from the live quote', async () => {
  const run = runEngine({
    message: 'BUY GOLD LIMIT 4011 SL 4005',
    over: { fallback_take_profit_points: 500 },
    adapterOptions: { price: goldQuote(4020, 4020.2) },
  });
  await run.result();
  const [order] = run.adapter.pendingOrders();
  assert.equal(order.takeProfit, 4016, '500 points above 4011, the price the order waits at - not 4025.2, which would be measured from the market');
});

test('a limit whose level the market has already passed becomes a market order', async () => {
  const run = runEngine({ message: 'BUY GOLD LIMIT 4011 SL 4005 TP 4030', adapterOptions: { price: goldQuote(4010, 4010.2) } });
  const result = await run.result();
  assert.equal(result.status, 'executed', 'the level is already available, so it is taken now rather than rested');
  assert.equal(run.adapter.pendingOrders().length, 0);
  assert.equal(run.adapter.marketOrders().length, 1);
  assert.match(signalNote(run.pool).note, /Filled 80 points better than the signal price of 4011/, 'and the note says a fill was taken at a better price');
});

test('a stop level too close to the market for the broker is refused with the number named', async () => {
  // 4010.25 is 5 points above the ask, and this broker will not accept a pending order within 10 of it.
  // The direction word sits directly in front of STOP because that is what makes it an order type rather than
  // a stop-loss shorthand; with a symbol in between, `STOP 4010.25` is read as a protective leg instead.
  const run = runEngine({ message: 'BUY STOP 4010.25 GOLD SL 4005 TP 4030', adapterOptions: { price: goldQuote(4010, 4010.2) } });
  const result = await run.result();
  assert.equal(result.status, 'skipped');
  assert.match(result.message, /requires pending orders at least 10 points away/);
  assert.equal(run.adapter.calls.length, 0);
});

test('a resting order does not get a scale-out plan, because there is no position yet', async () => {
  const run = runEngine({
    message: 'BUY GOLD LIMIT 4011 SL 4005 TP1 4020 TP2 4030',
    over: { multipleTargetHandling: 'scale_out', limitOrderExpiryValue: 1, limitOrderExpiryUnit: 'hours' },
    adapterOptions: { price: goldQuote(4020, 4020.2) },
  });
  await run.result();
  assert.equal(run.pool.calls.some((call) => call.sql.includes('INSERT INTO trade_tp_levels')), false, 'no closes are planned for a position that does not exist');
  const [order] = run.adapter.pendingOrders();
  assert.equal(order.takeProfit, 4020, 'and the order still carries the first target the channel named');
});

/* ----------------------------------------------------- 5. the sweep: expiry, fills and ghosts ----------------------------------------------------- */

const pendingTradeRow = (over = {}) => ({
  trade_id: 'trade-1', user_id: 'user-1', execution_job_id: 'job-1', signal_id: 'signal-1',
  metaapi_account_id: 'account-1', broker_order_id: 'resting-1', client_id: 'SD_XAUUSD_job1',
  symbol: 'XAUUSD', side: 'buy', entry_price: 4011, quantity: 0.01, order_type: 'limit', status: 'pending',
  expiry_timestamp: new Date(AT + 30 * 60_000).toISOString(), created_at: new Date(AT).toISOString(),
  error_message: null,
  ...over,
});

function runSweep({ trades, adapterOptions = {}, at = AT }) {
  const pool = fakePool(null, { trades });
  const adapter = fakeAdapter({ price: null, ...adapterOptions });
  const engine = createExecutionEngine({
    pool,
    trading: adapter,
    resolveToken: async () => 'fake-token',
    runtimeEnabled: true,
    isTradingPaused: async () => false,
    now: () => at,
    expirySweepIntervalMs: 0,
    logger: { info() {}, warn() {}, error() {} },
  });
  return { pool, adapter, engine, sweep: () => engine.sweepExpiredOrders() };
}

test('a limit order 31 minutes old is cancelled through the broker and recorded as expired', async () => {
  // The order was placed at noon with the default half hour on it; the sweep is running at 12:31.
  const run = runSweep({
    trades: [pendingTradeRow()],
    at: AT + 31 * 60_000,
    adapterOptions: { orders: [{ id: 'resting-1', symbol: 'XAUUSD', clientId: 'SD_XAUUSD_job1' }], price: goldQuote(4011) },
  });
  const summary = await run.sweep();
  assert.equal(summary.expired, 1);
  const [cancel] = run.adapter.cancels();
  assert.equal(cancel.orderId, 'resting-1', 'the broker is told which order to take off the book');
  const settled = run.pool.calls.find((call) => call.sql.includes('UPDATE trades SET status=$2,'));
  assert.equal(settled.params[1], 'expired');
  assert.match(settled.params[2], /2026-10-25 12:31 UTC: the order had passed the expiry it was placed with \(limit at 4011\)/);
  assert.equal(settled.params[3], null, 'a cancelled order owns no position id');
  const signal = run.pool.calls.find((call) => call.sql.includes('UPDATE signals SET status=COALESCE'));
  assert.equal(signal.params[1], 'expired', 'and the signal row stops promising a trade');
  const job = run.pool.calls.find((call) => call.sql.includes('UPDATE execution_jobs SET status=$2'));
  assert.equal(job.params[1], 'expired', 'the job history agrees with both');
});

test('an order the user deleted on the platform becomes cancelled here, not a ghost', async () => {
  const run = runSweep({ trades: [pendingTradeRow()], adapterOptions: { orders: [], positions: [], deals: [], price: goldQuote(4011) } });
  const summary = await run.sweep();
  assert.equal(summary.cancelled, 1);
  assert.equal(run.adapter.cancels().length, 0, 'there is nothing to cancel: it is already gone, so no cancel is sent for an order we did not remove');
  const settled = run.pool.calls.find((call) => call.sql.includes('UPDATE trades SET status=$2,'));
  assert.equal(settled.params[1], 'cancelled');
  assert.match(settled.params[2], /no longer on your broker account and never became a position/);
});

test('an order that became a position is booked as executed at the fill price', async () => {
  const run = runSweep({
    trades: [pendingTradeRow()],
    adapterOptions: {
      price: goldQuote(4011),
      orders: [],
      positions: [{ positionId: 'pos-77', orderId: 'resting-1', openPrice: 4010.8, volume: 0.02 }],
    },
  });
  const summary = await run.sweep();
  assert.equal(summary.filled, 1);
  const settled = run.pool.calls.find((call) => call.sql.includes('UPDATE trades SET status=$2,'));
  assert.equal(settled.params[1], 'executed');
  assert.equal(settled.params[3], 'pos-77', 'the position the order became is the trade now');
  assert.equal(settled.params[4], 4010.8, 'booked at the price it filled at, not at the level it waited at');
  assert.equal(settled.params[5], 0.02, 'and at the size it filled at, which a partial fill can move');
  assert.match(settled.params[2], /Break-even and scale-out were not set up for it/);
});

test('an account that cannot be read leaves every resting order exactly as it is', async () => {
  const run = runSweep({ trades: [pendingTradeRow({ expiry_timestamp: new Date(AT - 60_000).toISOString() })], adapterOptions: { price: null } });
  const summary = await run.sweep();
  assert.equal(summary.deferred, 1);
  assert.equal(summary.expired, 0, 'an outage is not evidence that the order is gone');
  assert.equal(run.adapter.cancels().length, 0);
  assert.equal(run.pool.calls.some((call) => call.sql.includes('UPDATE trades SET status=$2,')), false);
});

test('a resting order before its deadline is left alone, and one already gone is not cancelled twice', async () => {
  const waiting = runSweep({ trades: [pendingTradeRow()], adapterOptions: { orders: [{ id: 'resting-1', clientId: 'SD_XAUUSD_job1' }], price: goldQuote(4011) } });
  const summary = await waiting.sweep();
  assert.equal(summary.waiting, 1);
  assert.equal(waiting.adapter.cancels().length, 0);

  const gone = runSweep({
    trades: [pendingTradeRow({ expiry_timestamp: new Date(AT - 1000).toISOString() })],
    // The broker answered "already gone" to the cancel, so the row has to describe what really happened
    // rather than repeat our own reason back. With a deal on the order it is a fill.
    adapterOptions: { orders: [], deals: [{ orderId: 'resting-1', positionId: 'pos-88', price: 4010.5, volume: 0.01 }], price: goldQuote(4011) },
  });
  assert.equal((await gone.sweep()).filled, 1, 'an order whose deadline passed and that the broker no longer lists, but which produced a deal, is a fill and not an expiry');
});

test('a row with nothing to match it against is reported as unknown rather than guessed at', async () => {
  const run = runSweep({ trades: [pendingTradeRow({ broker_order_id: null, client_id: null })], adapterOptions: { orders: [], price: goldQuote(4011) } });
  const summary = await run.sweep();
  assert.equal(summary.failed, 1);
  const settled = run.pool.calls.find((call) => call.sql.includes('UPDATE trades SET status=$2,'));
  assert.equal(settled.params[1], 'unknown');
  assert.match(settled.params[2], /no broker reference to match it against/);
});

test('the sweep throttles itself, so the worker can call it every second it is awake', async () => {
  const pool = fakePool(null, { trades: [pendingTradeRow()] });
  const adapter = fakeAdapter({ price: goldQuote(4011), orders: [{ id: 'resting-1', clientId: 'SD_XAUUSD_job1' }] });
  let nowMs = AT;
  const engine = createExecutionEngine({
    pool, trading: adapter, resolveToken: async () => 'fake-token', runtimeEnabled: true,
    now: () => nowMs, expirySweepIntervalMs: 60_000, logger: { info() {}, warn() {}, error() {} },
  });
  const first = await engine.sweepExpiredOrders();
  assert.equal(first.attempted, 1);
  nowMs += 1_200;
  const second = await engine.sweepExpiredOrders();
  assert.deepEqual({ ...second, reason: undefined }, { ...first, reason: undefined, attempted: 0, waiting: 0 }, 'the second call inside the window does no work at all');
  assert.equal(second.reason, 'throttled');
  nowMs += 60_000;
  assert.equal((await engine.sweepExpiredOrders()).attempted, 1, 'and it resumes when the minute is up');
});

test('a resting order counts against the workspace while it waits', async () => {
  // The daily trade counter is the one that decides `max_daily_trades`; an order on the book that is not
  // counted is a channel of ten signals turning into eleven trades.
  const source = await import('node:fs').then(({ readFileSync }) => readFileSync(new URL('../services/execution-engine.js', import.meta.url), 'utf8'));
  assert.match(source, /AND status IN \('submitting','pending','executed','unknown','filled'\)/);
});
