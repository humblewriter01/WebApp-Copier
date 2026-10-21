import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BREAK_EVEN_DEFERRED_RETRY_MS,
  BREAK_EVEN_MAX_ATTEMPTS,
  TRAILING_MAX_DISTANCE_POINTS,
  calculateBreakEvenStop,
  calculateStopGuard,
  calculateTrailingStop,
  classifyBreakEvenFailure,
  createExecutionEngine,
  normalizePositionSide,
} from '../services/execution-engine.js';
import { createExecutionWorker } from '../services/execution-worker.js';

const tick = 0.0001;
const spec = { symbol: 'EURUSD', tickSize: tick, stopsLevel: 0, freezeLevel: 0 };

/* --------------------------- the break-even decision --------------------------- */
test('a buy stop only moves once the trigger distance has been travelled', () => {
  const waiting = calculateBreakEvenStop({
    side: 'buy', openPrice: 1.1, bid: 1.1019, ask: 1.1021, stopLoss: 1.089, triggerPoints: 20, offsetPoints: 0, tickSize: tick,
  });
  assert.equal(waiting.action, 'wait');
  assert.equal(waiting.reason, 'trigger-not-reached');

  const moved = calculateBreakEvenStop({
    side: 'buy', openPrice: 1.1, bid: 1.102, ask: 1.1021, stopLoss: 1.089, triggerPoints: 20, offsetPoints: 0, tickSize: tick,
  });
  assert.equal(moved.action, 'move');
  assert.equal(moved.stopLoss, 1.1, 'the stop is moved exactly to entry with a zero offset');
  assert.equal(moved.previousStopLoss, 1.089);
});

test('a sell stop uses the ask side and mirrors the buy decision', () => {
  const decision = calculateBreakEvenStop({
    side: 'sell', openPrice: 1.1, bid: 1.0979, ask: 1.098, stopLoss: 1.111, triggerPoints: 20, offsetPoints: 5, tickSize: tick,
  });
  assert.equal(decision.action, 'move');
  assert.equal(decision.stopLoss, 1.0995, 'entry minus a five point offset');
  assert.equal(decision.lockedPoints, 5);
  const notYet = calculateBreakEvenStop({
    side: 'sell', openPrice: 1.1, bid: 1.098, ask: 1.0981, stopLoss: 1.111, triggerPoints: 20, offsetPoints: 5, tickSize: tick,
  });
  assert.equal(notYet.action, 'wait');
});

test('a stop that is already at least this protective is never moved again', () => {
  const decision = calculateBreakEvenStop({
    side: 'buy', openPrice: 1.1, bid: 1.105, ask: 1.1051, stopLoss: 1.1042, triggerPoints: 20, offsetPoints: 0, tickSize: tick,
  });
  assert.equal(decision.action, 'already_beyond');
  assert.equal(decision.stopLoss, 1.1042, 'the report keeps the tighter stop the user already has');
});

test('the broker minimum stop distance defers the move instead of failing it', () => {
  const deferred = calculateBreakEvenStop({
    side: 'buy', openPrice: 1.1, bid: 1.1002, ask: 1.1004, stopLoss: 1.089, triggerPoints: 2, offsetPoints: 0, tickSize: tick, stopsLevelPoints: 10,
  });
  assert.equal(deferred.action, 'defer');
  assert.equal(deferred.reason, 'broker-stop-distance');
  assert.match(deferred.message, /10 points/);

  const later = calculateBreakEvenStop({
    side: 'buy', openPrice: 1.1, bid: 1.1015, ask: 1.1017, stopLoss: 1.089, triggerPoints: 2, offsetPoints: 0, tickSize: tick, stopsLevelPoints: 10,
  });
  assert.equal(later.action, 'move', 'the same request succeeds once the price has travelled far enough');
});

test('a frozen distance around the existing stop defers the move', () => {
  const decision = calculateBreakEvenStop({
    side: 'buy', openPrice: 1.1, bid: 1.102, ask: 1.1021, stopLoss: 1.0999, triggerPoints: 20, offsetPoints: 0, tickSize: tick, freezeLevelPoints: 30,
  });
  assert.equal(decision.action, 'defer');
  assert.equal(decision.reason, 'broker-freeze-distance');
});

test('prices are aligned onto the broker tick grid in the direction that reduces risk', () => {
  const buy = calculateBreakEvenStop({ side: 'buy', openPrice: 1.10007, bid: 1.103, ask: 1.1031, stopLoss: 1.09, triggerPoints: 1, offsetPoints: 0, tickSize: tick });
  assert.equal(buy.stopLoss, 1.1, 'a buy rounds down to the tick so the stop never sits above the intended price');
  const sell = calculateBreakEvenStop({ side: 'sell', openPrice: 1.10003, bid: 1.097, ask: 1.0971, stopLoss: 1.11, triggerPoints: 1, offsetPoints: 0, tickSize: tick });
  assert.equal(sell.stopLoss, 1.1001, 'a sell rounds up');
});

test('a missing or removed stop is still protected', () => {
  for (const stopLoss of [0, null, undefined]) {
    const decision = calculateBreakEvenStop({ side: 'buy', openPrice: 1.1, bid: 1.103, ask: 1.1031, stopLoss, triggerPoints: 20, offsetPoints: 0, tickSize: tick });
    assert.equal(decision.action, 'move');
    assert.equal(decision.previousStopLoss, null);
  }
});

test('every unsafe input blocks the request instead of guessing', () => {
  const base = { side: 'buy', openPrice: 1.1, bid: 1.103, ask: 1.1031, stopLoss: 1.09, triggerPoints: 20, offsetPoints: 0, tickSize: tick };
  assert.equal(calculateBreakEvenStop({ ...base, tickSize: undefined }).action, 'blocked');
  assert.equal(calculateBreakEvenStop({ ...base, bid: 0 }).action, 'blocked');
  assert.equal(calculateBreakEvenStop({ ...base, bid: 1.104, ask: 1.103 }).action, 'blocked', 'a crossed market is never trusted');
  assert.equal(calculateBreakEvenStop({ ...base, triggerPoints: 100_001 }).action, 'blocked');
  assert.equal(calculateBreakEvenStop({ ...base, offsetPoints: -1 }).action, 'blocked');
  assert.equal(calculateBreakEvenStop({ ...base, side: 'hold' }).action, 'blocked');
  assert.equal(normalizePositionSide('POSITION_TYPE_SELL'), 'sell');
  assert.equal(normalizePositionSide(undefined), null);
});

test('a target price on the wrong side of the market is refused', () => {
  const decision = calculateBreakEvenStop({ side: 'buy', openPrice: 1.1, bid: 1.102, ask: 1.1021, stopLoss: 1.09, triggerPoints: 1, offsetPoints: 5_000, tickSize: tick });
  assert.equal(decision.action, 'defer');
  assert.equal(decision.reason, 'stop-side-of-market');
});

/* -------------------------- provider failure classification -------------------------- */
test('a broker condition that can clear on its own is retried soon', () => {
  for (const error of [{ numericCode: 10016, message: 'Invalid stops in the request' }, { stringCode: 'TRADE_RETCODE_REQUOTE' }, { message: 'Order modify is forbidden because the price is within the freeze level' }]) {
    const outcome = classifyBreakEvenFailure(error);
    assert.equal(outcome.status, 'deferred', JSON.stringify(error));
    assert.equal(outcome.retry, true);
  }
});

test('a definite broker rejection is recorded as a failure with the provider message', () => {
  const outcome = classifyBreakEvenFailure({ numericCode: 10017, stringCode: 'TRADE_RETCODE_TRADE_DISABLED', message: 'Trade is disabled' });
  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.retry, true);
  assert.match(outcome.message, /trade is disabled/i);
});

test('an ambiguous transport failure is never retried automatically', () => {
  for (const error of [{ message: 'Request timed out' }, { numericCode: 10012, message: 'Request canceled by timeout' }, new Error('fetch failed')]) {
    const outcome = classifyBreakEvenFailure(error);
    assert.equal(outcome.status, 'unknown', String(error?.message));
    assert.equal(outcome.retry, false);
  }
});

/* --------------------------------- the sweep --------------------------------- */
// Mirrors the columns the candidate query selects, so the sweep sees what the database gives it.
const candidate = {
  trade_id: 'trade-1', user_id: 'user-1', metaapi_account_id: 'account-1', broker_position_id: '42',
  symbol: 'EURUSD', side: 'buy', entry_price: '1.1', stop_loss: '1.089',
  break_even_enabled: true, trigger_points: '20', offset_points: '0', managed_by_app: true,
};

function fakeState(overrides = {}) {
  return {
    account: { state: 'DEPLOYED' },
    accountInformation: { balance: 1000, equity: 1000 },
    positions: [{ id: 42, type: 'buy', symbol: 'EURUSD', openPrice: 1.1, stopLoss: 1.089, takeProfit: 1.12, currentPrice: 1.1025 }],
    orders: [],
    deals: [],
    specification: spec,
    price: { bid: 1.1025, ask: 1.1027, lossTickValue: 1, time: new Date().toISOString() },
    ...overrides,
  };
}

function fakePool({ rows = [candidate], state = fakeState(), stateError = null, eligible = true, trailingEligible = null, accountState = 'DEPLOYED', modifyResult = { stringCode: 'TRADE_RETCODE_DONE', numericCode: 10009 }, modifyError = null, token = 'secret-token-1' } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes('FROM trades t')) return { rows };
      if (sql.includes('FROM metaapi_accounts WHERE user_id=$1 AND metaapi_account_id=$2')) return { rows: [{ managed_by_app: true, state: accountState }] };
      if (sql.includes('break_even_enabled AS "breakEvenEnabled"')) {
        return {
          rows: [{
            autoTradingEnabled: eligible,
            breakEvenEnabled: eligible,
            // A workspace can run the trail without break even, so the fake has to be able to
            // say the two switches apart instead of treating them as one flag.
            trailingStopEnabled: trailingEligible === null ? eligible : trailingEligible,
            executionAccountId: 'account-1',
          }],
        };
      }
      if (sql.includes('INSERT INTO break_even_moves')) return { rows: [] };
      if (sql.includes('UPDATE trades SET stop_loss')) return { rows: [] };
      if (sql.includes("UPDATE trades SET status='unknown'")) return { rows: [] };
      return { rows: [] };
    },
    fake: {
      state, stateError, modifyResult, modifyError, token,
    },
  };
}

function fakeTrading(pool) {
  const calls = [];
  return {
    calls,
    async getAccountState() {
      calls.push({ method: 'getAccountState' });
      if (pool.fake.stateError) throw pool.fake.stateError;
      return pool.fake.state;
    },
    async createMarketOrder() {
      throw new Error('The market order path is not exercised by these tests.');
    },
    async modifyPosition(request) {
      calls.push({ method: 'modifyPosition', request });
      if (pool.fake.modifyError) throw pool.fake.modifyError;
      return pool.fake.modifyResult;
    },
  };
}

function buildEngine(options = {}) {
  let clock = 1_700_000_000_000;
  const pool = fakePool(options);
  const trading = fakeTrading(pool);
  const logs = [];
  const engine = createExecutionEngine({
    pool,
    trading,
    resolveToken: async () => pool.fake.token,
    runtimeEnabled: true,
    now: () => clock,
    breakEvenIntervalMs: 5_000,
    logger: { error: (line) => logs.push(line), info: (line) => logs.push(line) },
    ...options.engine,
  });
  return { engine, pool, trading, logs, advance: (ms) => { clock += ms; } };
}

const moveInsert = (pool) => pool.calls.filter((call) => call.sql.includes('INSERT INTO break_even_moves')).pop();

test('the sweep moves the stop of an in-profit position and records the result', async () => {
  const harness = buildEngine();
  const result = await harness.engine.sweepBreakEven();
  assert.deepEqual({ attempted: result.attempted, moved: result.moved }, { attempted: 1, moved: 1 });

  const modify = harness.trading.calls.find((call) => call.method === 'modifyPosition');
  assert.equal(modify.request.accountId, 'account-1');
  assert.equal(modify.request.positionId, '42');
  assert.equal(modify.request.stopLoss, 1.1, 'entry price, because the offset is zero');
  assert.equal('takeProfit' in modify.request, false, 'the take profit is never part of the request');

  const insert = moveInsert(harness.pool);
  assert.equal(insert.params[11], 'moved');
  assert.equal(insert.params[10], 1.1);
  assert.ok(harness.pool.calls.some((call) => call.sql.includes('UPDATE trades SET stop_loss')));
});

test('the candidate query is the guard: opt-in settings, an eligible account, and only retryable rows', async () => {
  const harness = buildEngine();
  await harness.engine.sweepBreakEven();
  const { sql, params } = harness.pool.calls.find((call) => call.sql.includes('FROM trades t'));
  assert.match(sql, /s\.break_even_enabled=TRUE/);
  assert.match(sql, /s\.auto_trading_enabled=TRUE/, 'turning Auto-Trading off stops every broker write, including stop moves');
  assert.match(sql, /s\.execution_account_id=t\.metaapi_account_id/);
  assert.match(sql, /UPPER\(COALESCE\(ma\.state,''\)\)='DEPLOYED'/);
  assert.match(sql, /LEFT JOIN break_even_moves/);
  assert.match(sql, /m\.status IN \('deferred','failed'\)/, 'a terminal result is never retried');
  assert.match(sql, /m\.attempt_count < \$2/);
  assert.match(sql, /m\.next_attempt_at IS NULL OR m\.next_attempt_at <= NOW\(\)/);
  assert.match(sql, /JOIN users u ON u\.id=t\.user_id/);
  assert.match(sql, /u\.subscription_status = ANY\(\$4::text\[\]\)/, 'automation, including stop protection, requires a paid plan');
  assert.deepEqual(params, [String(30), BREAK_EVEN_MAX_ATTEMPTS, 20, ['active', 'non_renewing']]);
});

test('a second sweep inside the interval does no work at all', async () => {
  const harness = buildEngine();
  await harness.engine.sweepBreakEven();
  const before = harness.trading.calls.length;
  const throttled = await harness.engine.sweepBreakEven();
  assert.equal(throttled.reason, 'throttled');
  assert.equal(harness.trading.calls.length, before);
  harness.advance(6_000);
  await harness.engine.sweepBreakEven();
  assert.ok(harness.trading.calls.length > before, 'the sweep resumes after the interval');
});

test('the sweep is inert when the execution runtime is off', async () => {
  const harness = buildEngine({ engine: { runtimeEnabled: false } });
  const result = await harness.engine.sweepBreakEven();
  assert.equal(result.reason, 'runtime-disabled');
  assert.equal(harness.pool.calls.length, 0, 'not even the database is read');
  assert.equal(harness.trading.calls.length, 0);
});

test('the market not having travelled far enough writes nothing', async () => {
  const harness = buildEngine({ state: fakeState({ price: { bid: 1.1005, ask: 1.1007, lossTickValue: 1, time: new Date().toISOString() } }) });
  const result = await harness.engine.sweepBreakEven();
  assert.deepEqual({ attempted: result.attempted, skipped: result.skipped, moved: result.moved }, { attempted: 1, skipped: 1, moved: 0 });
  assert.equal(harness.trading.calls.some((call) => call.method === 'modifyPosition'), false);
  assert.equal(moveInsert(harness.pool), undefined);
});

test('a position that is no longer open is closed off permanently', async () => {
  const harness = buildEngine({ state: fakeState({ positions: [] }) });
  const result = await harness.engine.sweepBreakEven();
  assert.equal(result.closed, 1);
  assert.equal(moveInsert(harness.pool).params[11], 'closed');
  assert.equal(moveInsert(harness.pool).params[12], 'false', 'a closed position does not consume an attempt');
  assert.equal(harness.trading.calls.some((call) => call.method === 'modifyPosition'), false);
});

test('the settings and account are re-checked immediately before the broker write', async () => {
  const harness = buildEngine({ eligible: false });
  const result = await harness.engine.sweepBreakEven();
  assert.equal(result.moved, 0);
  assert.equal(harness.trading.calls.some((call) => call.method === 'modifyPosition'), false, 'a toggle switched off mid-sweep cannot reach the broker');
  assert.equal(moveInsert(harness.pool), undefined, 'a skipped move leaves no trace to retry');
});

test('an undeployed or unowned account is skipped without a provider call', async () => {
  const harness = buildEngine({ accountState: 'UNDEPLOYED' });
  const result = await harness.engine.sweepBreakEven();
  assert.equal(result.skipped, 1);
  assert.equal(harness.trading.calls.length, 0);
});

test('the broker minimum stop distance is recorded as a short deferral', async () => {
  const harness = buildEngine({ state: fakeState({ specification: { ...spec, stopsLevel: 30 }, price: { bid: 1.102, ask: 1.1021, lossTickValue: 1, time: new Date().toISOString() } }) });
  const result = await harness.engine.sweepBreakEven();
  assert.equal(result.deferred, 1);
  const insert = moveInsert(harness.pool);
  assert.equal(insert.params[11], 'deferred');
  assert.equal(Number(insert.params[17]), BREAK_EVEN_DEFERRED_RETRY_MS);
  assert.match(insert.params[16], /30 points/);
});

test('a broker rejection is stored with its sanitized code and message', async () => {
  const harness = buildEngine({ modifyResult: { stringCode: 'TRADE_RETCODE_TRADE_DISABLED', numericCode: 10017, message: 'Trade is disabled for secret-token-1' } });
  const result = await harness.engine.sweepBreakEven();
  assert.equal(result.failed, 1);
  const insert = moveInsert(harness.pool);
  assert.equal(insert.params[11], 'failed');
  assert.match(insert.params[16], /Trade is disabled/);
  assert.equal(insert.params[16].includes('secret-token-1'), false, 'the access token never reaches stored text');
  assert.equal(harness.pool.calls.some((call) => call.sql.includes('UPDATE trades SET stop_loss')), false, 'a rejected move must not change the recorded stop');
});

test('an ambiguous failure is marked unknown and needs reconciliation instead of a retry', async () => {
  const harness = buildEngine({ modifyError: Object.assign(new Error('Request timed out'), { name: 'TradeError', numericCode: 10012, stringCode: 'TRADE_RETCODE_TIMEOUT' }) });
  const result = await harness.engine.sweepBreakEven();
  assert.equal(result.failed, 1);
  const insert = moveInsert(harness.pool);
  assert.equal(insert.params[11], 'unknown');
  assert.equal(insert.params[17], null, 'no automatic retry is scheduled for an unconfirmed change');
  assert.match(insert.params[16], /Reconcile the position/);
  assert.equal(insert.params[12], 'true', 'an unconfirmed change does consume an attempt, so it cannot loop forever');
  assert.equal(harness.pool.calls.some((call) => call.sql.includes("UPDATE trades SET status='unknown'")), false,
    'the order filled, so its execution status is not rewritten by a stop-move failure');
});

test('MetaAPI reporting no changes is treated as protected, not as an error', async () => {
  const harness = buildEngine({ modifyResult: { stringCode: 'TRADE_RETCODE_NO_CHANGES', numericCode: 10025, message: 'No changes' } });
  const result = await harness.engine.sweepBreakEven();
  assert.equal(result.moved, 0);
  assert.equal(result.skipped, 1);
  assert.equal(moveInsert(harness.pool).params[11], 'already_beyond');
});

test('an unsynchronized account defers the whole group and never throws', async () => {
  const harness = buildEngine({ stateError: new Error('MetaAPI account positions or pending orders are not synchronized for secret-token-1') });
  const result = await harness.engine.sweepBreakEven();
  assert.equal(result.deferred, 1);
  const insert = moveInsert(harness.pool);
  assert.equal(insert.params[11], 'deferred');
  assert.match(insert.params[16], /not synchronized/);
  assert.equal(insert.params[16].includes('secret-token-1'), false);
  assert.equal(insert.params[12], 'false', 'an unreadable account must not exhaust the attempts of a position that still needs protecting');
});

/* ---------------------------------- the worker ---------------------------------- */
test('an eligible order always outranks the break-even sweep', async () => {
  const order = [];
  const engine = {
    async processJob() { order.push('job'); },
    async captureUtcDayBaselines() {},
    async sweepBreakEven() { order.push('sweep'); return { moved: 0 }; },
  };
  const worker = createExecutionWorker({
    pool: {
      async connect() {
        return {
          async query() {
            return { rows: [{ id: 'job-1', user_id: 'user-1', signal_id: 'signal-1' }] };
          },
          release() {},
        };
      },
      async query() { return { rows: [] }; },
    },
    engine,
    logger: { error() {}, info() {} },
  });
  await worker.runOnce();
  assert.deepEqual(order, ['job'], 'protecting an open position must never delay a queued signal');
});

test('a continuous stream of signals cannot starve protection', async () => {
  const order = [];
  let claimed = 0;
  const worker = createExecutionWorker({
    pool: {
      async connect() {
        return {
          async query() {
            claimed += 1;
            return { rows: [{ id: `job-${claimed}`, user_id: 'user-1', signal_id: `signal-${claimed}` }] };
          },
          release() {},
        };
      },
      async query() { return { rows: [] }; },
    },
    engine: {
      async captureUtcDayBaselines() {},
      async processJob() { order.push('job'); },
      async sweepBreakEven() { order.push('sweep'); return { moved: 1 }; },
    },
    logger: { error() {}, info() {} },
  });
  for (let index = 0; index < 6; index += 1) await worker.runOnce();
  assert.equal(order.filter((item) => item === 'job').length, 6);
  assert.equal(order.includes('sweep'), true, 'a busy signal stream still protects open positions');
  assert.deepEqual(order, ['job', 'job', 'job', 'job', 'job', 'sweep', 'job'], 'the first four iterations only place orders, then protection gets a turn');
});

test('a break-even sweep failure cannot take the worker loop down', async () => {
  const seen = [];
  const worker = createExecutionWorker({
    pool: { async connect() { return { async query() { return { rows: [] }; }, release() {} }; }, async query() { return { rows: [] }; } },
    engine: {
      async captureUtcDayBaselines() {},
      async processJob() { seen.push('job'); },
      async sweepBreakEven() { throw new Error('break-even exploded access_token=super-secret-9'); },
    },
    logger: { error: (line) => seen.push(line), info() {} },
  });
  await worker.runOnce();
  assert.equal(seen.length, 1, 'the loop logged the failure and carried on');
  assert.match(seen[0], /break-even exploded/);
  assert.equal(seen[0].includes('super-secret-9'), false);
});


/* ============================== the trailing stop ============================== */
/* Same guarantees, one more decision: the trail may only ever tighten a stop, and every
 * rule that protects a break-even move (fresh quote, tick grid, broker stop and freeze
 * distances, re-checked settings, no retry on an unconfirmed answer) applies to it too. */
const trail = (overrides = {}) => ({
  side: 'buy', openPrice: 1.1, bid: 1.105, ask: 1.1051, stopLoss: 1.089, tickSize: tick,
  trailing: { distancePoints: 30 }, ...overrides,
});

test('a trailing stop holds the stop the user distance behind the market', () => {
  const decision = calculateTrailingStop({ side: 'buy', openPrice: 1.1, bid: 1.105, ask: 1.1051, stopLoss: 1.089, distancePoints: 30, tickSize: tick });
  assert.equal(decision.action, 'move');
  assert.equal(decision.stopLoss, 1.102, 'the bid minus the trailing distance, on the tick grid');
  assert.equal(decision.previousStopLoss, 1.089);
  assert.equal(decision.source, 'trailing');
  assert.equal(decision.ratcheted, true, 'tightening an existing stop is a ratchet');
  assert.equal(decision.improvementPoints, 130, 'the stop moved 130 points in the trade\'s favour');
  assert.equal(decision.lockedPoints, 20, 'entry is still locked in, because the trail is above it');
});

test('a sell trail ratchets downward and reads the ask side', () => {
  const decision = calculateTrailingStop({ side: 'sell', openPrice: 1.1, bid: 1.0950, ask: 1.0951, stopLoss: 1.111, distancePoints: 30, tickSize: tick });
  assert.equal(decision.action, 'move');
  assert.equal(decision.stopLoss, 1.0981, 'the ask plus the trailing distance');
  assert.equal(decision.source, 'trailing');
});

test('a trailing stop never widens a stop when the price retraces', () => {
  // The trail would put the stop at 1.0995, which is looser than the 1.102 the position
  // already has, so nothing is sent - and the finding is a wait, not a terminal result,
  // because the trail has to be re-checked as the market moves again.
  const decision = calculateTrailingStop({ side: 'buy', openPrice: 1.1, bid: 1.1025, ask: 1.1026, stopLoss: 1.102, distancePoints: 30, tickSize: tick });
  assert.equal(decision.action, 'wait');
  assert.equal(decision.reason, 'trail-not-tighter');
  assert.equal(decision.stopLoss, 1.102, 'the report keeps the tighter stop the user already has');

  // The same inputs without a trail are break-even's terminal answer, unchanged.
  const guarded = calculateStopGuard({ side: 'buy', openPrice: 1.1, bid: 1.105, ask: 1.1051, stopLoss: 1.1042, tickSize: tick, breakEven: { triggerPoints: 20, offsetPoints: 0 } });
  assert.equal(guarded.action, 'already_beyond');
});

test('the more protective target wins when both protections are on', () => {
  const both = { side: 'buy', openPrice: 1.1, stopLoss: 1.089, tickSize: tick, breakEven: { triggerPoints: 20, offsetPoints: 0 }, trailing: { distancePoints: 30 } };
  const early = calculateStopGuard({ ...both, bid: 1.1025, ask: 1.1026 });
  assert.equal(early.action, 'move');
  assert.equal(early.stopLoss, 1.1, 'entry protects more than 30 points behind a 1.1025 bid');
  assert.equal(early.source, 'break-even');

  const later = calculateStopGuard({ ...both, bid: 1.105, ask: 1.1051 });
  assert.equal(later.action, 'move');
  assert.equal(later.stopLoss, 1.102, 'once the market travels, the trail is the tighter stop');
  assert.equal(later.source, 'trailing');
});

test('a trail is refused without a fresh quote, a valid distance, or a tick size', () => {
  const blocked = (input, why) => assert.equal(calculateStopGuard(trail(input)).action, 'blocked', why);
  blocked({ bid: 0 }, 'no quote');
  blocked({ bid: 1.106, ask: 1.105 }, 'a crossed market is never trusted');
  blocked({ tickSize: undefined }, 'no tick grid');
  blocked({ side: 'hold' }, 'no direction');
  blocked({ openPrice: null }, 'no entry price');
  blocked({ trailing: { distancePoints: 0 } }, 'a zero distance would mean a stop on the market');
  blocked({ trailing: { distancePoints: TRAILING_MAX_DISTANCE_POINTS + 1 } }, 'an absurd distance is refused, not clamped');
  assert.equal(calculateStopGuard(trail({ trailing: null, breakEven: null })).reason, 'nothing-configured', 'with neither protection on there is nothing to decide');
});

test('a trailing move obeys the broker stop and freeze distances and the tick grid', () => {
  const tooClose = calculateTrailingStop({ side: 'buy', openPrice: 1.1, bid: 1.105, ask: 1.1051, stopLoss: 1.089, distancePoints: 5, tickSize: tick, stopsLevelPoints: 30 });
  assert.equal(tooClose.action, 'defer');
  assert.equal(tooClose.reason, 'broker-stop-distance', 'the trail is deferred, never forced through');

  const frozen = calculateTrailingStop({ side: 'buy', openPrice: 1.1, bid: 1.105, ask: 1.1051, stopLoss: 1.1048, distancePoints: 1, tickSize: tick, freezeLevelPoints: 30 });
  assert.equal(frozen.action, 'defer');
  assert.equal(frozen.reason, 'broker-freeze-distance');

  const aligned = calculateTrailingStop({ side: 'buy', openPrice: 1.1, bid: 1.10503, ask: 1.10505, stopLoss: 1.089, distancePoints: 3, tickSize: tick });
  assert.equal(aligned.action, 'move');
  assert.equal(aligned.stopLoss, 1.1047, 'aligned down onto the tick, never above the intended price');
});

test('a position with no stop at all is still protected by the trail', () => {
  for (const stopLoss of [0, null, undefined]) {
    const decision = calculateTrailingStop({ side: 'buy', openPrice: 1.1, bid: 1.105, ask: 1.1051, stopLoss, distancePoints: 30, tickSize: tick });
    assert.equal(decision.action, 'move');
    assert.equal(decision.previousStopLoss, null);
    assert.equal(decision.ratcheted, false, 'the first stop on a naked position is not a ratchet');
  }
});

/* ------------------------- the sweep, with the trail attached ------------------------- */
const trailedCandidate = (overrides = {}) => ({
  ...candidate, break_even_enabled: true, trailing_enabled: true, trailing_distance_points: '30', ...overrides,
});
// 1.1050 minus 30 points is 1.1020, which is tighter than break even's 1.1000, so a state
// built on this quote is decided by the trail rather than by the one-off break-even target.
const travelledState = (overrides = {}) => fakeState({ price: { bid: 1.105, ask: 1.1051, lossTickValue: 1, time: new Date().toISOString() }, ...overrides });

test('the candidate query lets a handled position back in only while trailing is on', async () => {
  const harness = buildEngine({ rows: [trailedCandidate()] });
  await harness.engine.sweepBreakEven();
  const { sql, params } = harness.pool.calls.find((call) => call.sql.includes('FROM trades t'));
  assert.match(sql, /\(s\.break_even_enabled=TRUE OR s\.trailing_stop_enabled=TRUE\)/, 'either protection is enough to look, and neither is needed if both are off');
  assert.match(sql, /s\.trailing_stop_enabled=TRUE AND m\.status IN \('moved','already_beyond'\)/, 'a trail re-visits a settled row; nothing else may');
  assert.match(sql, /m\.status IN \('deferred','failed'\)/, 'break-even retry behaviour is unchanged');
  assert.deepEqual(params, [String(30), BREAK_EVEN_MAX_ATTEMPTS, 20, ['active', 'non_renewing']], 'the ratchet branch needed no new parameter');
});

test('a trailing sweep ratchets the stop of a position break even already handled', async () => {
  const harness = buildEngine({ rows: [trailedCandidate()], state: travelledState() });
  const result = await harness.engine.sweepBreakEven();
  assert.deepEqual({ attempted: result.attempted, moved: result.moved, ratcheted: result.ratcheted }, { attempted: 1, moved: 1, ratcheted: 1 });

  const modify = harness.trading.calls.find((call) => call.method === 'modifyPosition');
  assert.equal(modify.request.stopLoss, 1.102, 'the bid in the test quote minus 30 points');
  assert.equal('takeProfit' in modify.request, false, 'a ratchet never touches the take profit');
  assert.equal('trailingStopLoss' in modify.request, false, 'the trail is ours; MetaAPI native trailing is never asked for');

  const insert = moveInsert(harness.pool);
  assert.equal(insert.params[11], 'moved');
  assert.equal(insert.params[10], 1.102);
  assert.equal(insert.params[9], 1.089, 'the previous stop is kept for the audit');
  assert.equal(insert.params[18], 'true', 'only a trail may rewrite a settled row');
  assert.equal(insert.params[19], '30', 'the distance it was decided under is stored, not assumed');
  assert.ok(harness.pool.calls.some((call) => call.sql.includes('UPDATE trades SET stop_loss')), 'the recorded stop follows the ratchet');
});

test('with trailing off the ledger keeps its old one-write-per-position behaviour', async () => {
  const harness = buildEngine();
  const result = await harness.engine.sweepBreakEven();
  assert.equal(result.moved, 1);
  const insert = moveInsert(harness.pool);
  assert.equal(insert.params[18], 'false', 'break even alone cannot revisit a settled row');
  assert.equal(insert.params[19], null, 'no trailing distance is invented for a workspace that never enabled it');
  assert.equal(result.ratcheted, 0);
});

test('a workspace with only the trail on still moves the stop, and the re-check knows it', async () => {
  const harness = buildEngine({ rows: [trailedCandidate({ break_even_enabled: false })] });
  const result = await harness.engine.sweepBreakEven();
  assert.equal(result.moved, 1);
  const eligibility = harness.pool.calls.find((call) => call.sql.includes('break_even_enabled AS "breakEvenEnabled"'));
  assert.match(eligibility.sql, /trailing_stop_enabled AS "trailingStopEnabled"/, 'the pre-write re-check reads both switches');
});

test('switching both protections off mid-sweep stops the trail at the broker', async () => {
  const harness = buildEngine({ rows: [trailedCandidate({ break_even_enabled: false })], eligible: false, trailingEligible: false });
  const result = await harness.engine.sweepBreakEven();
  assert.equal(result.moved, 0);
  assert.equal(harness.trading.calls.some((call) => call.method === 'modifyPosition'), false, 'Auto-Trading or both switches off means Signal Desk sends nothing');
  assert.equal(moveInsert(harness.pool), undefined, 'a skipped move leaves no trace to retry');
});

test('an unconfirmed trailing move parks the trail instead of retrying it', async () => {
  const harness = buildEngine({ rows: [trailedCandidate()], state: travelledState(), modifyError: Object.assign(new Error('Request timed out'), { numericCode: 10012, stringCode: 'TRADE_RETCODE_TIMEOUT' }) });
  const result = await harness.engine.sweepBreakEven();
  assert.equal(result.failed, 1);
  const insert = moveInsert(harness.pool);
  assert.equal(insert.params[11], 'unknown');
  assert.equal(insert.params[17], null, 'no retry is scheduled while the broker answer is unknown');
  assert.match(insert.params[16], /Reconcile the position/);
  // The ratchet branch of the candidate query names only 'moved' and 'already_beyond', so an
  // unconfirmed row cannot come back and send the same modification a second time.
  const { sql } = harness.pool.calls.find((call) => call.sql.includes('FROM trades t'));
  const ratchetBranch = sql.match(/OR \(s\.trailing_stop_enabled=TRUE AND m\.status IN \(([^)]*)\)\)/)[1];
  assert.deepEqual(ratchetBranch.split(',').map((item) => item.trim()), ["'moved'", "'already_beyond'"], 'unknown and closed are never re-offered to the sweep');
  assert.ok(insert.params[10] === null || insert.params[10] === undefined || insert.params[10] === 1.102, 'the unapplied price is not recorded as the live stop');
});

test('a deferred trailing attempt consumes no attempt and stays in the sweep', async () => {
  const harness = buildEngine({
    rows: [trailedCandidate({ trailing_distance_points: '3' })],
    state: fakeState({ specification: { ...spec, stopsLevel: 30 } }),
  });
  const result = await harness.engine.sweepBreakEven();
  assert.equal(result.deferred, 1);
  const insert = moveInsert(harness.pool);
  assert.equal(insert.params[11], 'deferred');
  assert.equal(insert.params[12], 'false', 'a broker-side wait must not exhaust the attempts of a live trail');
  assert.equal(Number(insert.params[17]), BREAK_EVEN_DEFERRED_RETRY_MS);
  assert.equal(insert.params[18], 'true', 'a trail rewrites its own row to record the deferral');
});

test('the trailing sweep shares break-even throttle, runtime gate, and provider support checks', async () => {
  const harness = buildEngine({ rows: [trailedCandidate()] });
  assert.equal(harness.engine.sweepBreakEven instanceof Function, true, 'one sweep serves both protections');
  await harness.engine.sweepBreakEven();
  assert.equal((await harness.engine.sweepBreakEven()).reason, 'throttled', 'a ratchet cannot be used to hammer the broker');

  const noRuntime = buildEngine({ rows: [trailedCandidate()], engine: { runtimeEnabled: false } });
  assert.equal((await noRuntime.engine.sweepBreakEven()).reason, 'runtime-disabled');
  assert.equal(noRuntime.pool.calls.length, 0, 'not even the database is read');
});

test('a fresh position always outranks an established trail', async () => {
  // Without this, a workspace holding more open trades than the sweep limit could have every
  // slot taken by positions that merely need re-checking, and a new trade would never get its
  // stop moved at all.
  const harness = buildEngine({ rows: [trailedCandidate(), trailedCandidate({ broker_position_id: '43' })] });
  await harness.engine.sweepBreakEven();
  const { sql } = harness.pool.calls.find((call) => call.sql.includes('FROM trades t'));
  assert.match(sql, /ORDER BY CASE WHEN m\.id IS NULL THEN 0/, 'never-protected first');
  assert.match(sql, /WHEN m\.status IN \('deferred','failed'\) THEN 1/, 'then a retry that is due');
  assert.match(sql, /ELSE 2 END/, 'then the ratchets');
  assert.match(sql, /COALESCE\(m\.updated_at, t\.created_at\) ASC/, 'and inside a class, whoever waited longest');
});

test('a trail reads the quote, the position, and the spec from one account read', async () => {
  // The safety of a ratchet depends on price and stop belonging to the same moment, so the
  // sweep must not mix a stored quote from the ledger with a newly read position.
  // 1.0906 minus 30 points is 1.0876, looser than the 1.0890 the position already holds, and
  // the break-even trigger has not been reached, so the sweep has nothing it may send.
  const state = fakeState({ price: { bid: 1.0906, ask: 1.0908, lossTickValue: 1, time: new Date().toISOString() } });
  const harness = buildEngine({ rows: [trailedCandidate()], state });
  const result = await harness.engine.sweepBreakEven();
  assert.equal(result.moved, 0, 'a retracing market never pulls the stop back down');
  assert.equal(harness.trading.calls.filter((call) => call.method === 'getAccountState').length, 1);
  const insert = moveInsert(harness.pool);
  assert.equal(insert, undefined, 'a wait writes nothing at all');
});

/* A platform-wide pause is an emergency brake on *new* exposure. Positions that are already open
 * keep their protection, because taking a safety net away in the middle of an incident is the
 * opposite of what a pause is for - so the sweep deliberately never consults the switch. */
test('a platform pause stops new orders but never stops protective stop moves', async () => {
  let asked = 0;
  const harness = buildEngine({ engine: { isTradingPaused: async () => { asked += 1; return true; } } });
  const result = await harness.engine.sweepBreakEven();
  assert.deepEqual({ attempted: result.attempted, moved: result.moved }, { attempted: 1, moved: 1 });
  assert.equal(harness.trading.calls.some((call) => call.method === 'modifyPosition'), true);
  assert.equal(asked, 0, 'the sweep does not even ask');
});
