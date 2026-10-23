/**
 * The scale-out sweep, against a mocked MetaAPI adapter.
 *
 * A partial close spends the trade, so these tests are written around what must never happen: the same
 * piece of a position being closed twice, a stop move that re-closes volume on its way to being retried,
 * a broker that refused a close being answered with another close, or a plan that touches a position
 * the workspace no longer owns. Every one of those is a call-count assertion on the fake adapter rather
 * than a description of behaviour, because a count is the only thing that proves "exactly once".
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createExecutionEngine } from '../services/execution-engine.js';
import { createExecutionWorker } from '../services/execution-worker.js';

const SPEC = { symbol: 'EURUSD', minVolume: 0.01, maxVolume: 20, volumeStep: 0.01, tickSize: 0.0001 };

/** The signal row a buy with a three-target ladder looks like, as the engine reads it. */
const buyItem = {
  job_id: 'job-1', user_id: 'user-1', job_status: 'processing', expires_at: new Date(Date.now() + 120_000),
  signal_id: 'signal-1', source: 'telegram', signal_created_at: new Date(), symbol: 'EURUSD', side: 'buy',
  entry_price: null, stop_loss: 1.09, take_profit: 1.12, takeProfitLevels: [1.12, 1.15, 1.18],
  execution_ready: true, parse_error: null,
  auto_trading_enabled: true, lot_size_mode: 'fixed', fixed_lot_size: 0.1, risk_percent: 1,
  block_execution_without_stop_loss: true, block_execution_without_take_profit: true,
  fallback_stop_loss_points: null, fallback_take_profit_points: null, multipleTargetHandling: 'scale_out',
  max_open_positions: 3, max_daily_trades: 10, daily_loss_limit: 5, execution_account_id: 'account-1',
  metaapi_account_id: 'account-1', managed_by_app: true, account_state: 'DEPLOYED',
  subscription_status: 'active', subscription_plan: 'pro',
};

function levelRow(overrides = {}) {
  return {
    id: 'level-1', status: 'pending', user_id: 'user-1', trade_id: 'trade-1',
    metaapi_account_id: 'account-1', broker_position_id: 'broker-position-1',
    symbol: 'EURUSD', side: 'buy', level_index: 1, target_price: '1.12', close_percent: 50,
    planned_volume: '0.05', closed_volume: '0', break_even: true, break_even_status: null, attempt_count: 0,
    entry_price: '1.1', quantity: '0.1', remaining_volume: null,
    break_even_enabled: false, offset_points: '0', trailing_enabled: false, trailing_distance_points: '10',
    managed_by_app: true,
    ...overrides,
  };
}

function fakePool({ item = {}, levels = [], claimFails = false, armed = true } = {}) {
  const calls = [];
  return {
    calls,
    /** Every statement this test file asserts on, in the order the engine sent them. */
    find(fragment) { return calls.find((call) => call.sql.includes(fragment)); },
    all(fragment) { return calls.filter((call) => call.sql.includes(fragment)); },
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes('SELECT ej.id AS job_id')) return { rows: [{ ...buyItem, ...item }] };
      if (sql.includes('SELECT baseline_equity')) return { rows: [{ baseline_equity: 1000 }] };
      if (sql.includes('SELECT COUNT(*)::int AS count FROM trades')) return { rows: [{ count: 0 }] };
      if (sql.includes('FROM trade_tp_levels l') && sql.startsWith('SELECT')) return { rows: levels };
      if (sql.includes("SET status='submitting',attempt_count=attempt_count+1")) return { rows: claimFails ? [] : [{ id: params[0] }] };
      if (sql.includes('SELECT managed_by_app,state FROM metaapi_accounts')) return { rows: [{ managed_by_app: true, state: 'DEPLOYED' }] };
      if (sql.includes('SELECT auto_trading_enabled AS "autoTradingEnabled",execution_account_id AS "executionAccountId"')) {
        return { rows: [{ autoTradingEnabled: armed, executionAccountId: 'account-1' }] };
      }
      if (sql.includes('INSERT INTO trades')) return { rows: [{ id: 'trade-1' }] };
      if (sql.includes('INSERT INTO trade_tp_levels')) return { rows: [{ id: 'level-1' }] };
      return { rows: [], rowCount: 1 };
    },
  };
}

/**
 * The adapter is the seam: it records what reached the broker and answers however the test needs, so no
 * part of this file depends on MetaAPI being reachable.
 */
function fakeBroker({ price, positions = [], closeResult, closeError, modifyResult, modifyError, quote = price } = {}) {
  const calls = [];
  /* MetaAPI stamps every price it delivers with a `time`, and the engine now refuses to open a NEW position
     against a quote it cannot date. The fixture supplies the field the way a real account does, in the one
     place all four order-path tests share; a test that cares about quote age passes its own `time`. */
  const priced = quote && !quote.time ? { ...quote, time: new Date().toISOString() } : quote;
  const state = {
    account: { state: 'DEPLOYED' }, accountInformation: { balance: 1000, equity: 1000 },
    positions, orders: [], deals: [], specification: SPEC, price: priced,
  };
  return {
    calls,
    state,
    async getAccountState() { calls.push({ getAccountState: true }); return state; },
    async createMarketOrder(order) {
      calls.push({ order });
      return { stringCode: 'TRADE_RETCODE_DONE', numericCode: 10009, orderId: 'broker-order-1', positionId: 'broker-position-1' };
    },
    async closePositionPartially(args) {
      calls.push({ close: args });
      if (closeError) throw closeError;
      return closeResult ?? { stringCode: 'TRADE_RETCODE_DONE_PARTIAL', numericCode: 10010, positionId: args.positionId, filledVolume: args.volume };
    },
    async modifyPosition(args) {
      calls.push({ modify: args });
      if (modifyError) throw modifyError;
      return modifyResult ?? { stringCode: 'TRADE_RETCODE_DONE', numericCode: 10009 };
    },
  };
}

const closes = (broker) => broker.calls.filter((call) => call.close);
const modifies = (broker) => broker.calls.filter((call) => call.modify);

function engineFor({ pool, broker, now = () => Date.now() }) {
  return createExecutionEngine({
    pool, trading: broker, resolveToken: async () => 'fake-token', runtimeEnabled: true,
    isTradingPaused: async () => false, now, takeProfitSweepIntervalMs: 0, breakEvenIntervalMs: 0,
    logger: { info() {}, warn() {}, error() {} },
  });
}

/* =============================== opening the trade the plan describes =============================== */

test('scale-out opens the full size at the final target and records one row per swept level', async () => {
  const pool = fakePool();
  const broker = fakeBroker({ price: { bid: 1.1001, ask: 1.1, lossTickValue: 1 } });
  const result = await engineFor({ pool, broker }).processJob({ id: 'job-1', user_id: 'user-1' });
  assert.equal(result.status, 'executed', JSON.stringify(result));

  const order = broker.calls.find((call) => call.order).order;
  assert.equal(order.volume, 0.1, 'the whole size is opened, not a fraction of it');
  assert.equal(order.takeProfit, 1.18, 'the position rides to the final target, which is the only leg the broker holds');
  assert.equal(order.stopLoss, 1.09, 'the channel stop is untouched by the plan');
  const inserted = pool.find('INSERT INTO trades');
  assert.equal(inserted.params[9], 1.18, 'the trade row states the exit the broker was given');

  const plans = pool.all('INSERT INTO trade_tp_levels');
  assert.deepEqual(plans.map((call) => call.params.slice(6, 11)), [
    [1, 1.12, 50, 0.05, true],
    [2, 1.15, 30, 0.03, false],
  ], 'level, price, share, lots, and which one moves the stop');
  assert.equal(plans[0].params[3], 'broker-position-1', 'the plan is bound to the position it must act on');
  const remaining = pool.find('UPDATE trades SET remaining_volume=');
  assert.equal(remaining.params[0], 0.1, 'nothing has been closed yet, so the whole trade is still open');
  const note = pool.all('UPDATE signals SET status=$1,execution_note=$2').at(-1);
  assert.match(note.params[1], /Scale-out plan: 50% at 1\.12, 30% at 1\.15, 20% rides to 1\.18\./, 'the row says what will happen to it later');
});

test('the other two modes change which price the order carries and write no plan', async () => {
  const finalOnly = fakePool({ item: { multipleTargetHandling: 'final_target' } });
  const finalBroker = fakeBroker({ price: { bid: 1.1001, ask: 1.1, lossTickValue: 1 } });
  await engineFor({ pool: finalOnly, broker: finalBroker }).processJob({ id: 'job-1', user_id: 'user-1' });
  assert.equal(finalBroker.calls.find((call) => call.order).order.takeProfit, 1.18);
  assert.equal(finalOnly.all('INSERT INTO trade_tp_levels').length, 0, 'nothing is left to sweep: the trade is one target');

  const firstOnly = fakePool({ item: { multipleTargetHandling: 'first_target' } });
  const firstBroker = fakeBroker({ price: { bid: 1.1001, ask: 1.1, lossTickValue: 1 } });
  await engineFor({ pool: firstOnly, broker: firstBroker }).processJob({ id: 'job-1', user_id: 'user-1' });
  assert.equal(firstBroker.calls.find((call) => call.order).order.takeProfit, 1.12, 'the behaviour every workspace had before this setting exists');
  assert.equal(firstOnly.all('INSERT INTO trade_tp_levels').length, 0);
});

test('a position too small to halve is traded as a single target rather than split into dust', async () => {
  const pool = fakePool({ item: { fixed_lot_size: 0.01 } });
  const broker = fakeBroker({ price: { bid: 1.1001, ask: 1.1, lossTickValue: 1 } });
  const result = await engineFor({ pool, broker }).processJob({ id: 'job-1', user_id: 'user-1' });
  assert.equal(result.status, 'executed', 'the signal is still tradeable, only the plan is not');
  assert.equal(broker.calls.find((call) => call.order).order.takeProfit, 1.12, 'so it carries its first target');
  assert.equal(pool.all('INSERT INTO trade_tp_levels').length, 0);
  assert.equal(pool.all('UPDATE trades SET remaining_volume=').length, 0, 'and no partial close is ever owed on it');
});

test('no plan row is written when the order never reached the broker', async () => {
  const pool = fakePool();
  const broker = fakeBroker({ price: { bid: 1.1001, ask: 1.1, lossTickValue: 1 } });
  broker.createMarketOrder = async (order) => { broker.calls.push({ order }); return { stringCode: 'TRADE_RETCODE_REJECT', numericCode: 10006, message: 'Broker is busy' }; };
  const result = await engineFor({ pool, broker }).processJob({ id: 'job-1', user_id: 'user-1' });
  assert.equal(result.status, 'rejected');
  assert.equal(pool.all('INSERT INTO trade_tp_levels').length, 0, 'a trade that does not exist owns no closes');
});

/* ================================= the sweep, one target at a time ================================= */

test('a reached target closes its share once and moves the stop to entry in the same pass', async () => {
  const pool = fakePool({ levels: [levelRow()] });
  const broker = fakeBroker({
    price: { bid: 1.1205, ask: 1.1207, lossTickValue: 1 },
    positions: [{ id: 'broker-position-1', type: 'POSITION_TYPE_BUY', volume: 0.1, stopLoss: 1.09, openPrice: 1.1 }],
  });
  const summary = await engineFor({ pool, broker }).sweepTakeProfitLevels();
  assert.equal(summary.closed, 1);
  assert.equal(summary.breakEvenMoved, 1);

  assert.equal(closes(broker).length, 1, 'exactly once - a second close would take out volume nobody asked to leave');
  assert.equal(closes(broker)[0].close.volume, 0.05);
  assert.equal(closes(broker)[0].close.positionId, 'broker-position-1');
  assert.match(closes(broker)[0].close.clientId, /^SD/, 'the close carries a stable id so the broker can see a retry for what it is');

  const settled = pool.find('UPDATE trade_tp_levels SET status=$2,closed_volume=');
  assert.equal(settled.params[1], 'filled');
  assert.equal(settled.params[2], 0.05);
  assert.equal(settled.params[3], 0.05, 'the ride is half the trade');
  assert.equal(pool.find('UPDATE trades SET remaining_volume=').params[0], 0.05);

  const modify = modifies(broker)[0].modify;
  assert.equal(modify.stopLoss, 1.1, 'break even at the price the trade was opened at, immediately');
  assert.equal(pool.find('UPDATE trades SET stop_loss=$1').params[0], 1.1);
  const ledger = pool.find('INSERT INTO break_even_moves(');
  assert.ok(ledger, 'the stop move lands in the same ledger the panel reads, so it is not a private write');
  assert.equal(ledger.params[11], 'moved');
  assert.equal(pool.find("SET break_even_status='moved'").params[1], 1.1);
});

test('a target the market has not reached costs nothing: no claim, no attempt, no close', async () => {
  const pool = fakePool({ levels: [levelRow({ target_price: '1.13' })] });
  const broker = fakeBroker({ price: { bid: 1.1205, ask: 1.1207 }, positions: [{ id: 'broker-position-1', type: 'buy', volume: 0.1, stopLoss: 1.09, openPrice: 1.1 }] });
  const summary = await engineFor({ pool, broker }).sweepTakeProfitLevels();
  assert.equal(summary.waited, 1);
  assert.equal(closes(broker).length, 0);
  assert.equal(pool.all("SET status='submitting',attempt_count=attempt_count+1").length, 0, 'waiting is not an attempt, so a slow market cannot exhaust a plan');
  assert.equal(modifies(broker).length, 0, 'nothing is protected before anything is banked');
});

test('a sell is measured at the ask, so a target between the two sides is not a fill', async () => {
  const positions = [{ id: 'broker-position-1', type: 'POSITION_TYPE_SELL', volume: 0.1, stopLoss: 1.15, openPrice: 1.13 }];
  const missed = fakePool({ levels: [levelRow({ side: 'sell', target_price: '1.12' })] });
  const missedBroker = fakeBroker({ price: { bid: 1.115, ask: 1.1201 }, positions });
  await engineFor({ pool: missed, broker: missedBroker }).sweepTakeProfitLevels();
  assert.equal(closes(missedBroker).length, 0, 'the bid was under the target, but a sell exits at the ask');

  const hit = fakePool({ levels: [levelRow({ side: 'sell', target_price: '1.12' })] });
  const hitBroker = fakeBroker({ price: { bid: 1.115, ask: 1.1199 }, positions });
  await engineFor({ pool: hit, broker: hitBroker }).sweepTakeProfitLevels();
  assert.equal(closes(hitBroker).length, 1);
  assert.equal(modifies(hitBroker)[0].modify.stopLoss, 1.13, 'and break even for a sell is the entry from above');
});

test('a position that is no longer there settles the level instead of chasing it', async () => {
  const pool = fakePool({ levels: [levelRow()] });
  const broker = fakeBroker({ price: { bid: 1.1205, ask: 1.1207 }, positions: [] });
  const summary = await engineFor({ pool, broker }).sweepTakeProfitLevels();
  assert.equal(closes(broker).length, 0);
  assert.equal(pool.find('UPDATE trade_tp_levels SET status=$2,closed_volume=').params[1], 'closed');
  assert.match(pool.find('UPDATE trade_tp_levels SET status=$2,closed_volume=').params[5], /no longer open/, 'the reason is kept on the row a reader will ask about');
});

test('a refused close defers the level and never touches the stop', async () => {
  const pool = fakePool({ levels: [levelRow()] });
  const broker = fakeBroker({
    price: { bid: 1.1205, ask: 1.1207 },
    positions: [{ id: 'broker-position-1', type: 'buy', volume: 0.1, stopLoss: 1.09, openPrice: 1.1 }],
    closeResult: { stringCode: 'TRADE_RETCODE_REJECT', numericCode: 10006, message: 'Broker is busy' },
  });
  const summary = await engineFor({ pool, broker }).sweepTakeProfitLevels();
  assert.equal(summary.failed, 1);
  assert.equal(modifies(broker).length, 0, 'a stop is only moved once the profit is actually taken');
  const settled = pool.find('UPDATE trade_tp_levels SET status=$2,closed_volume=');
  assert.equal(settled.params[1], 'deferred');
  assert.match(settled.params[5], /Broker is busy/);
  assert.equal(settled.params[8], '60000', 'with a minute of rest, and the plan resumes on its own');
  assert.equal(pool.all('UPDATE trades SET remaining_volume=').length, 0, 'no volume left the position, so the trade is still whole');
});

test('an unconfirmed close is recorded as unknown and never sent again', async () => {
  const pool = fakePool({ levels: [levelRow()] });
  const broker = fakeBroker({
    price: { bid: 1.1205, ask: 1.1207 },
    positions: [{ id: 'broker-position-1', type: 'buy', volume: 0.1, stopLoss: 1.09, openPrice: 1.1 }],
    closeError: new Error('socket hang up'),
  });
  const summary = await engineFor({ pool, broker }).sweepTakeProfitLevels();
  assert.equal(closes(broker).length, 1);
  assert.equal(summary.failed, 1);
  const settled = pool.find('UPDATE trade_tp_levels SET status=$2,closed_volume=');
  assert.equal(settled.params[1], 'unknown');
  assert.match(settled.params[5], /may already have been applied; reconcile the position/);
  assert.equal(modifies(broker).length, 0, 'the stop is not moved on the strength of a call nobody heard an answer to');
  // The candidate query is what makes the refusal to retry true: an unknown row is not a candidate.
  const candidates = pool.find('FROM trade_tp_levels l').sql;
  assert.match(candidates, /l\.status IN \('pending','deferred','failed'\)/, 'a level is only re-attempted while it is still an open question');
});

test('a level another sweep has already claimed is left alone', async () => {
  const pool = fakePool({ levels: [levelRow()], claimFails: true });
  const broker = fakeBroker({
    price: { bid: 1.1205, ask: 1.1207 },
    positions: [{ id: 'broker-position-1', type: 'buy', volume: 0.1, stopLoss: 1.09, openPrice: 1.1 }],
  });
  const summary = await engineFor({ pool, broker }).sweepTakeProfitLevels();
  assert.equal(summary.skipped, 1);
  assert.equal(closes(broker).length, 0, 'the claim is the lock: whoever does not hold it does not trade');
  assert.equal(pool.all('UPDATE trade_tp_levels SET status=$2,closed_volume=').length, 0);
});

test('a close whose volume would leave an illegal remainder is skipped with the reason, not retried forever', async () => {
  // The user trimmed the trade by hand: 0.05 lots are open and the plan asks for 0.04 of them, which
  // would leave 0.01 - under the 0.03 minimum this symbol requires. Closing everything would be a
  // larger action than the plan described, so the level is settled as skipped instead.
  const pool = fakePool({ levels: [levelRow({ target_price: '1.12', planned_volume: '0.04' })] });
  const broker = fakeBroker({
    price: { bid: 1.1205, ask: 1.1207 },
    positions: [{ id: 'broker-position-1', type: 'buy', volume: 0.05, stopLoss: 1.09, openPrice: 1.1, minVolume: 0.03 }],
  });
  broker.state.specification = { ...SPEC, minVolume: 0.03 };
  const summary = await engineFor({ pool, broker }).sweepTakeProfitLevels();
  assert.equal(summary.skipped, 1);
  assert.equal(closes(broker).length, 0);
  const settled = pool.find('UPDATE trade_tp_levels SET status=$2,closed_volume=');
  assert.equal(settled.params[1], 'skipped');
  assert.match(settled.params[5], /below this symbol's 0\.03 lot minimum/);
});

test('the stop move alone is retried on the next pass, without closing any volume again', async () => {
  const pool = fakePool({
    levels: [levelRow({ status: 'filled', break_even: true, break_even_status: 'deferred', closed_volume: '0.05', remaining_volume: '0.05', modifyRetry: true })],
  });
  const broker = fakeBroker({
    price: { bid: 1.1205, ask: 1.1207 },
    positions: [{ id: 'broker-position-1', type: 'buy', volume: 0.05, stopLoss: 1.09, openPrice: 1.1 }],
    // The first attempt at the stop was refused because the price sat inside the symbol's stop distance;
    // by the next pass there is room, and the protection still has to happen.
    modifyResult: { stringCode: 'TRADE_RETCODE_DONE', numericCode: 10009 },
  });
  const summary = await engineFor({ pool, broker }).sweepTakeProfitLevels();
  assert.equal(closes(broker).length, 0, 'the profit is already banked; a retry may not bank it twice');
  assert.equal(summary.breakEvenMoved, 1);
  assert.equal(modifies(broker)[0].modify.stopLoss, 1.1);
});

test('a workspace that switched Auto-Trading off mid-sweep has its claim returned, not spent', async () => {
  const pool = fakePool({ levels: [levelRow()], armed: false });
  const broker = fakeBroker({
    price: { bid: 1.1205, ask: 1.1207 },
    positions: [{ id: 'broker-position-1', type: 'buy', volume: 0.1, stopLoss: 1.09, openPrice: 1.1 }],
  });
  const summary = await engineFor({ pool, broker }).sweepTakeProfitLevels();
  assert.equal(closes(broker).length, 0);
  assert.equal(summary.skipped, 1);
  const released = pool.find("UPDATE trade_tp_levels SET status=$2,closed_volume=");
  assert.equal(released.params[1], 'pending', 'the level stays an open question, so switching back on resumes the plan');
  assert.match(released.params[5], /switched off or the account changed/);
});

test('a claim left in flight by a crashed sweep is recorded as unknown, and a bare adapter says why nothing runs', async () => {
  const pool = fakePool({ levels: [] });
  const broker = fakeBroker({ price: { bid: 1.1, ask: 1.1001 } });
  await engineFor({ pool, broker }).sweepTakeProfitLevels();
  const swept = pool.find("WHERE status='submitting' AND updated_at < NOW()");
  assert.ok(swept, 'abandoned claims are settled before anything else runs');
  assert.equal(swept.params[0], '300000');

  const plain = fakePool({ levels: [levelRow()] });
  const noPartial = { getAccountState: async () => ({}), createMarketOrder: async () => ({}), modifyPosition: async () => ({}) };
  const summary = await engineFor({ pool: plain, broker: noPartial }).sweepTakeProfitLevels();
  assert.equal(summary.reason, 'provider-unsupported');
  assert.equal(plain.all('FROM trade_tp_levels l').length, 0, 'no candidate is even read while the platform cannot close a piece of a position');
});

test('a plan is not a new order, so it is not held by the platform pause - but it does need the runtime', async () => {
  const pool = fakePool({ levels: [levelRow()] });
  const broker = fakeBroker({ price: { bid: 1.1205, ask: 1.1207 }, positions: [{ id: 'broker-position-1', type: 'buy', volume: 0.1, stopLoss: 1.09, openPrice: 1.1 }] });
  const paused = createExecutionEngine({
    pool, trading: broker, resolveToken: async () => 'fake-token', runtimeEnabled: true,
    isTradingPaused: async () => true, takeProfitSweepIntervalMs: 0, logger: { info() {}, warn() {}, error() {} },
  });
  await paused.sweepTakeProfitLevels();
  assert.equal(closes(broker).length, 1, 'taking profit and moving the stop to entry reduce exposure, which a pause on new orders must not prevent');

  const idle = createExecutionEngine({ pool: fakePool({ levels: [levelRow()] }), trading: broker, resolveToken: async () => 'fake-token', runtimeEnabled: false });
  assert.equal(idle.sweepTakeProfitLevels && (await idle.sweepTakeProfitLevels()).reason, 'runtime-disabled');
});

/* =============================== the loop that runs it =============================== */

test('the worker loop banks a reached target next to the stop moves, and never before a queued order', async () => {
  const order = [];
  const engine = {
    async captureUtcDayBaselines() {},
    async processJob() { order.push('job'); },
    async sweepBreakEven() { order.push('stops'); return { moved: 1 }; },
    async sweepTakeProfitLevels() { order.push('levels'); return { closed: 1 }; },
  };
  const idle = { async connect() { return { async query() { return { rows: [] }; }, release() {} }; }, async query() { return { rows: [] }; } };
  await createExecutionWorker({ pool: idle, engine, logger: { error() {}, info() {} } }).runOnce();
  assert.deepEqual(order, ['stops', 'levels'], 'on an idle queue the plan is swept right after the stops, in the same pass');

  order.length = 0;
  let claimed = 0;
  const busy = {
    async connect() { return { async query() { claimed += 1; return { rows: [{ id: `job-${claimed}`, user_id: 'user-1', signal_id: `signal-${claimed}` }] }; }, release() {} }; },
    async query() { return { rows: [] }; },
  };
  const busyWorker = createExecutionWorker({ pool: busy, engine, logger: { error() {}, info() {} } });
  await busyWorker.runOnce();
  assert.deepEqual(order, ['job'], 'a signal waiting to be placed outranks protecting one already open');
  for (let index = 0; index < 5; index += 1) await busyWorker.runOnce();
  assert.deepEqual(order.slice(1), ['job', 'job', 'job', 'job', 'stops', 'levels', 'job'], 'and a stream of signals cannot starve the plan either: the fifth order in a row is followed by both sweeps');

  order.length = 0;
  const broken = {
    ...engine,
    async sweepTakeProfitLevels() { throw new Error('plan sweep exploded access_token=super-secret-9'); },
  };
  const seen = [];
  await createExecutionWorker({ pool: idle, engine: broken, logger: { error: (line) => seen.push(line), info() {} } }).runOnce();
  assert.equal(seen.length, 1, 'the loop logged it and carried on');
  assert.match(seen[0], /plan sweep exploded/);
  assert.equal(seen[0].includes('super-secret-9'), false, 'and never logged the token that was in the message');
});
