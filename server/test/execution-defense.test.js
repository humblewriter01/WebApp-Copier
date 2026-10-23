/**
 * The defense layers between a captured signal and an order at the broker, exercised the way the engine
 * runs them: a mocked MetaAPI adapter answers with the objects and exceptions a real account produces, and
 * each test asks what reached the broker, what the job row says, and what the user's signal row was told.
 *
 * Two properties matter more than any individual sentence here, and both are pinned from several sides:
 *  - a guard that blocks must block *before* anything touches MetaAPI (a skipped trade that already sent
 *    an order is not a skip), and
 *  - a retry may only happen when the previous attempt can be shown not to have reached the trading
 *    server, because an automatic second market order on top of a filled first one is the one failure this
 *    service cannot take back.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createExecutionEngine } from '../services/execution-engine.js';
import { createExecutionWorker } from '../services/execution-worker.js';
import {
  DAILY_LOSS_LIMIT_MESSAGE, MAX_OPEN_POSITIONS_MESSAGE, STALE_CONNECTION_MESSAGE, STALE_QUOTE_MESSAGE,
  buildClientId, canRetry, classifyBrokerFailure, clientIdFits, dailyLossPercent, guardQuote, retryDelayMs,
} from '../services/execution-defense.js';

const SPEC = { symbol: 'EURUSD', minVolume: 0.01, maxVolume: 20, volumeStep: 0.01, tickSize: 0.0001 };

/** @param over  signal/settings overrides, applied last so a test states only what it is about */
function itemFor(over = {}) {
  return {
    job_id: 'job-1', user_id: 'user-1', job_status: 'processing', attemptCount: 1,
    expires_at: new Date(Date.now() + 120_000).toISOString(),
    signal_id: 'signal-1', source: 'telegram', signal_created_at: new Date(), symbol: 'EURUSD', side: 'buy',
    entry_price: null, stop_loss: 1.09, take_profit: 1.12, execution_ready: true, parse_error: null,
    auto_trading_enabled: true, lot_size_mode: 'fixed', fixed_lot_size: 0.01, risk_percent: 1,
    block_execution_without_stop_loss: true, block_execution_without_take_profit: true,
    fallback_stop_loss_points: null, fallback_take_profit_points: null,
    max_open_positions: 3, max_daily_trades: 10, daily_loss_limit: 5, execution_account_id: 'account-1',
    metaapi_account_id: 'account-1', managed_by_app: true, account_state: 'DEPLOYED',
    subscription_status: 'active', subscription_plan: 'pro',
    multipleTargetHandling: 'first_target', takeProfitLevels: null,
    ...over,
  };
}

function fakePool({ item = {}, baseline = 1000, localTrades = 0, priorTrade = null } = {}) {
  const calls = [];
  return {
    calls,
    sql: () => calls.map((call) => call.sql),
    find: (needle) => calls.find((call) => call.sql.includes(needle)),
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes('SELECT ej.id AS job_id')) return { rows: [itemFor(item)] };
      if (sql.includes('SELECT baseline_equity')) return baseline === null ? { rows: [] } : { rows: [{ baseline_equity: baseline }] };
      if (sql.includes('SELECT COUNT(*)::int AS count FROM trades')) return { rows: [{ count: localTrades }] };
      if (sql.includes('SELECT auto_trading_enabled AS "autoTradingEnabled"')) return { rows: [{ autoTradingEnabled: true, executionAccountId: 'account-1' }] };
      // The retry path claims its existing row by re-stamping it, and only while it is still 'submitting';
      // the fake answers that claim the way the real row would, and refuses it for any other status.
      if (sql.includes("UPDATE trades SET symbol=")) return { rows: priorTrade?.status === 'submitting' ? [{ id: priorTrade.id }] : [] };
      if (sql.includes('INSERT INTO trades')) return { rows: priorTrade ? [] : [{ id: 'trade-1' }] };
      return { rows: [], rowCount: 1 };
    },
  };
}

/**
 * The adapter is the only broker this file ever talks to. `price` and `link` are what the freshness guard
 * reads, `positions`/`orders`/`deals` what the caps read, and `orderError` answers with the exception shape
 * MetaAPI actually uses for a refusal (`@throws {TradeError} on trade error, check error properties for
 * error code details`) rather than the shape it would be convenient to test.
 */
function fakeAdapter({
  price, positions = [], orders = [], deals = [], accountError = null, orderError = null,
  orderResult, link, found = null, findError = null, noFind = false,
} = {}) {
  const calls = [];
  const fresh = price === undefined ? { bid: 1.1, ask: 1.1002, lossTickValue: 1, time: new Date().toISOString() } : price;
  const adapter = {
    calls,
    ordersSent: () => calls.filter((call) => call.order),
    async getAccountState() {
      calls.push({ getAccountState: true });
      if (accountError) throw accountError;
      return {
        account: { state: 'DEPLOYED' }, accountInformation: { balance: 1000, equity: 1000 },
        positions, orders, deals, specification: SPEC, price: fresh,
        ...(link === undefined ? {} : { link }),
      };
    },
    async createMarketOrder(order) {
      calls.push({ order });
      if (orderError) throw orderError;
      return orderResult ?? { stringCode: 'TRADE_RETCODE_DONE', numericCode: 10009, orderId: 'broker-order-1', positionId: 'broker-position-1' };
    },
  };
  if (!noFind) {
    adapter.findOrderByClientId = async () => {
      calls.push({ find: true });
      if (findError) throw findError;
      return found;
    };
  }
  return adapter;
}

function engineFor({ pool, adapter, now, ...rest } = {}) {
  return createExecutionEngine({
    pool, trading: adapter, resolveToken: async () => 'fake-token', runtimeEnabled: true,
    now: now || (() => Date.now()),
    logger: { info() {}, warn() {}, error() {} },
    ...rest,
  });
}

const ageFrom = (ms, clock = Date.now) => new Date(clock() - ms).toISOString();

/* ================================ layer 1: the stale quote guard ================================ */

test('a quote older than the freshness bound is skipped, and nothing is ever sent to the broker', async () => {
  const pool = fakePool();
  const adapter = fakeAdapter({ price: { bid: 1.1, ask: 1.1002, lossTickValue: 1, time: ageFrom(4_200) } });
  const result = await engineFor({ pool, adapter }).processJob({ id: 'job-1', user_id: 'user-1' });
  assert.equal(result.status, 'skipped');
  assert.equal(result.message, 'Execution skipped: price quote is stale to prevent slippage.');
  assert.equal(adapter.ordersSent().length, 0, 'a skipped trade means no order, not an order and an apology');
  assert.equal(pool.find('INSERT INTO trades'), undefined, 'not even a trade row is opened against a stale price');
});

test('the sentence the workspace reads is the guard, the job row, and the signal row saying the same thing', async () => {
  const pool = fakePool();
  const adapter = fakeAdapter({ price: { bid: 1.1, ask: 1.1002, lossTickValue: 1, time: ageFrom(9_000) } });
  await engineFor({ pool, adapter }).processJob({ id: 'job-1', user_id: 'user-1' });
  const job = pool.find('UPDATE execution_jobs');
  assert.match(job.sql, /status='skipped'|SET status=\$1/);
  assert.ok(job.params.includes('skipped'), 'the job row records a skip, not a failure');
  const signal = pool.find('UPDATE signals SET status=');
  assert.ok(signal.params.includes('unexecuted'), 'the signal says it was not executed, in the words the panel already uses');
  assert.ok(signal.params.some((value) => String(value).includes('price quote is stale')), 'and says why, so the row is not a mystery');
});

test('a quote inside the bound still trades, so the guard is a bound and not a block', async () => {
  const base = Date.now();
  const pool = fakePool();
  // 1999 ms old at the snapshot and at the last gate alike: the test that matters for a guard is the one
  // showing a good order still gets through.
  const adapter = fakeAdapter({ price: { bid: 1.1, ask: 1.1002, lossTickValue: 1, time: new Date(base).toISOString() } });
  const result = await engineFor({ pool, adapter, now: () => base + 1_999 }).processJob({ id: 'job-1', user_id: 'user-1' });
  assert.equal(result.status, 'executed', JSON.stringify(result));
  assert.equal(adapter.ordersSent().length, 1);
});

test('the bound is inclusive on one side: 2000 ms is tradeable, 2001 ms is not', async () => {
  const base = Date.now();
  for (const [ageMs, expected] of [[2_000, 'executed'], [2_001, 'skipped']]) {
    const pool = fakePool();
    const adapter = fakeAdapter({ price: { bid: 1.1, ask: 1.1002, lossTickValue: 1, time: new Date(base - ageMs).toISOString() } });
    const result = await engineFor({ pool, adapter, now: () => base }).processJob({ id: 'job-1', user_id: 'user-1' });
    assert.equal(result.status, expected, `${ageMs} ms`);
  }
});

test('a quote dated in the future past the window is refused, because skew must not look like freshness', async () => {
  const base = Date.now();
  const pool = fakePool();
  const adapter = fakeAdapter({ price: { bid: 1.1, ask: 1.1002, lossTickValue: 1, time: new Date(base + 60_000).toISOString() } });
  const result = await engineFor({ pool, adapter, now: () => base }).processJob({ id: 'job-1', user_id: 'user-1' });
  assert.equal(result.status, 'skipped');
  assert.equal(result.message, STALE_QUOTE_MESSAGE);
  assert.equal(adapter.ordersSent().length, 0);
});

test('a price with no timestamp cannot be bounded, so it cannot be traded against', async () => {
  const pool = fakePool();
  const adapter = fakeAdapter({ price: { bid: 1.1, ask: 1.1002, lossTickValue: 1 } });
  const result = await engineFor({ pool, adapter }).processJob({ id: 'job-1', user_id: 'user-1' });
  assert.equal(result.status, 'skipped', 'a missing time is "unknown age", never "fresh"');
  assert.equal(result.message, STALE_QUOTE_MESSAGE);
  assert.equal(adapter.ordersSent().length, 0);
});

test('a dead broker link is refused even when the last price looks fresh, in its own words', async () => {
  for (const link of [{ connectedToBroker: false, synchronized: true }, { connectedToBroker: true, synchronized: false }]) {
    const pool = fakePool();
    const adapter = fakeAdapter({ link, price: { bid: 1.1, ask: 1.1002, lossTickValue: 1, time: new Date().toISOString() } });
    const result = await engineFor({ pool, adapter }).processJob({ id: 'job-1', user_id: 'user-1' });
    assert.equal(result.status, 'skipped');
    assert.equal(result.message, STALE_CONNECTION_MESSAGE, 'a frozen feed and a slow feed are told apart');
    assert.equal(adapter.ordersSent().length, 0);
  }
});

test('a snapshot that says nothing about its link keeps trading: a gap in what we can see is not a fault', async () => {
  const pool = fakePool();
  const adapter = fakeAdapter({ price: { bid: 1.1, ask: 1.1002, lossTickValue: 1, time: new Date().toISOString() } });
  const result = await engineFor({ pool, adapter }).processJob({ id: 'job-1', user_id: 'user-1' });
  assert.equal(result.status, 'executed', JSON.stringify(result));
  assert.equal(pool.find('UPDATE execution_jobs').params.includes('executed'), true);
});

test('the quote is checked again at the last gate, so an order cannot go out on a price that aged mid-job', async () => {
  /* The snapshot was fresh; then the safety nets, the sizing and four database reads happened, and by the
   * moment the order is about to be sent the price is four seconds old. Without the second check this
   * test would place an order, which is exactly the slippage the guard exists to prevent. */
  let lost = 0;
  const pool = fakePool();
  const query = pool.query.bind(pool);
  // A slow settings re-read is the honest way to open a gap between the two checks: it is exactly what the
  // second one exists to cover.
  pool.query = async (sql, params) => {
    if (sql.includes('autoTradingEnabled')) lost = 4_000;
    return query(sql, params);
  };
  const adapter = fakeAdapter({ price: { bid: 1.1, ask: 1.1002, lossTickValue: 1, time: new Date().toISOString() } });
  const engine = createExecutionEngine({
    pool, trading: adapter, resolveToken: async () => 'fake-token', runtimeEnabled: true,
    now: () => Date.now() + lost,
    logger: { info() {}, warn() {}, error() {} },
  });
  const result = await engine.processJob({ id: 'job-1', user_id: 'user-1' });
  assert.equal(result.status, 'skipped');
  assert.equal(result.message, STALE_QUOTE_MESSAGE);
  assert.equal(adapter.ordersSent().length, 0, 'the refusal still happens before MetaAPI, not after it');
  assert.equal(pool.find('INSERT INTO trades'), undefined, 'and before any trade row exists');
});

/* ============================== layer 2: pre-trade risk and exposure caps ============================== */

test('a workspace at its maximum open positions skips the signal, before MetaAPI is asked for anything', async () => {
  const pool = fakePool();
  // two positions + one pending order = 3, and the limit is 3: the cap counts resting orders because a
  // resting order becomes a position without asking again.
  const adapter = fakeAdapter({ positions: [{ id: 'p-1' }, { id: 'p-2' }], orders: [{ id: 'o-1' }] });
  const result = await engineFor({ pool, adapter }).processJob({ id: 'job-1', user_id: 'user-1' });
  assert.equal(result.status, 'skipped');
  assert.equal(result.message, 'Execution skipped: Max open positions reached.');
  assert.equal(adapter.ordersSent().length, 0, 'the cap is checked before the order, not after it');
  assert.equal(pool.find('INSERT INTO trades'), undefined);
  assert.ok(pool.find('UPDATE signals SET status=').params.some((value) => String(value).includes('Max open positions')));
});

test('one position below the limit is traded, so the cap is a limit and not a freeze', async () => {
  const pool = fakePool();
  const adapter = fakeAdapter({ positions: [{ id: 'p-1' }, { id: 'p-2' }], orders: [] });
  const result = await engineFor({ pool, adapter }).processJob({ id: 'job-1', user_id: 'user-1' });
  assert.equal(result.status, 'executed', JSON.stringify(result));
  assert.equal(adapter.ordersSent().length, 1);
});

test('a workspace over its daily loss limit is stopped, and the sentence names the limit', async () => {
  // equity 940 against a 1000 baseline is a 6 % drawdown on a 5 % limit
  const pool = fakePool({ baseline: 1000 });
  const adapter = fakeAdapter();
  adapter.getAccountState = async () => ({
    account: { state: 'DEPLOYED' }, accountInformation: { balance: 1000, equity: 940 },
    positions: [], orders: [], deals: [], specification: SPEC,
    price: { bid: 1.1, ask: 1.1002, lossTickValue: 1, time: new Date().toISOString() },
  });
  const result = await engineFor({ pool, adapter }).processJob({ id: 'job-1', user_id: 'user-1' });
  assert.equal(result.status, 'skipped');
  assert.equal(result.message, 'Execution skipped: Daily loss limit reached.');
  assert.equal(adapter.ordersSent().length, 0, 'the loss cap is what makes a bad day stop rather than compound');
});

test('a day that went backwards just under the limit still trades', async () => {
  const pool = fakePool();
  const adapter = fakeAdapter();
  adapter.getAccountState = async () => ({
    account: { state: 'DEPLOYED' }, accountInformation: { balance: 1000, equity: 951 },
    positions: [], orders: [], deals: [], specification: SPEC,
    price: { bid: 1.1, ask: 1.1002, lossTickValue: 1, time: new Date().toISOString() },
  });
  const result = await engineFor({ pool, adapter }).processJob({ id: 'job-1', user_id: 'user-1' });
  assert.equal(result.status, 'executed', 'a 4.9 % drawdown is under a 5 % limit, and 950 would not be');
});

test('both caps violated at once reports the position cap first, consistently for every signal', async () => {
  const pool = fakePool();
  const adapter = fakeAdapter({ positions: [{ id: 'p-1' }, { id: 'p-2' }, { id: 'p-3' }], orders: [{ id: 'o-1' }] });
  adapter.getAccountState = async () => ({
    account: { state: 'DEPLOYED' }, accountInformation: { balance: 1000, equity: 800 },
    positions: [{ id: 'p-1' }, { id: 'p-2' }, { id: 'p-3' }], orders: [{ id: 'o-1' }], deals: [], specification: SPEC,
    price: { bid: 1.1, ask: 1.1002, lossTickValue: 1, time: new Date().toISOString() },
  });
  const result = await engineFor({ pool, adapter }).processJob({ id: 'job-1', user_id: 'user-1' });
  assert.equal(result.message, MAX_OPEN_POSITIONS_MESSAGE, 'one order per violated cap, and always the same one');
  assert.equal(adapter.ordersSent().length, 0);
});

test('the daily-trades cap is a third cap in the same voice, and it also stops before the broker', async () => {
  const pool = fakePool({ localTrades: 10 });
  const adapter = fakeAdapter();
  const result = await engineFor({ pool, adapter }).processJob({ id: 'job-1', user_id: 'user-1' });
  assert.equal(result.status, 'skipped');
  assert.match(result.message, /^Execution skipped: Maximum daily trades reached\./);
  assert.equal(adapter.ordersSent().length, 0);
});

test('a missing baseline is never read as "no loss yet"', async () => {
  const pool = fakePool({ baseline: null });
  const adapter = fakeAdapter();
  const result = await engineFor({ pool, adapter }).processJob({ id: 'job-1', user_id: 'user-1' });
  assert.equal(result.status, 'skipped');
  assert.match(result.message, /baseline is missing/);
  assert.equal(adapter.ordersSent().length, 0, 'the loss cap cannot be skipped by not having the number it needs');
});

test('the cap arithmetic itself: a winning day is zero loss, and both bounds are inclusive', () => {
  assert.equal(dailyLossPercent({ baselineEquity: 1000, equity: 1200 }), 0, 'a gain is not a negative loss');
  assert.ok(dailyLossPercent({ baselineEquity: 1000, equity: 950 }) > 4.99);
  assert.equal(dailyLossPercent({ baselineEquity: 0, equity: 900 }), null, 'no baseline is not 100 % loss either');
  assert.equal(dailyLossPercent({ baselineEquity: null, equity: null }), null);
});

/* ====================== layer 3: what a broker failure proves, and what follows ====================== */

test('a refusal that proves the request never reached the trading server is retried with a wait', async () => {
  const pool = fakePool();
  const closed = Object.assign(new Error('Market is closed'), { name: 'TradeError', stringCode: 'TRADE_RETCODE_MARKET_CLOSED', numericCode: 10018 });
  const adapter = fakeAdapter({ orderError: closed });
  const result = await engineFor({ pool, adapter }).processJob({ id: 'job-1', user_id: 'user-1' });
  assert.equal(result.status, 'queued', 'the job goes back to the queue rather than dying');
  assert.equal(result.retryInMs, 1_500, 'the first wait is the base delay');
  const defer = pool.find('UPDATE execution_jobs SET status=\'queued\'');
  assert.ok(defer, 'a deferred job is written as a queued job with a next attempt, in one statement');
  assert.match(defer.sql, /next_attempt_at=NOW\(\)\+\(\$3::text \|\| ' milliseconds'\)::interval/);
  assert.deepEqual(defer.params.slice(1, 3), ['Market is closed (TRADE_RETCODE_MARKET_CLOSED) Retrying: the request never reached the trading server.', '1500'], 'the reason travels with the wait, as text and as milliseconds');
  const signal = pool.find('UPDATE signals SET status=');
  assert.equal(signal.params[1], null, 'a signal waiting its turn is not annotated as blocked');
  assert.equal(adapter.ordersSent().length, 1);
});

test('the trade row waits with the job, and the retry continues on that same row', async () => {
  const pool = fakePool();
  const adapter = fakeAdapter({ orderError: Object.assign(new Error('Requote'), { name: 'TradeError', stringCode: 'TRADE_RETCODE_REQUOTE', numericCode: 10004 }) });
  await engineFor({ pool, adapter }).processJob({ id: 'job-1', user_id: 'user-1' });
  assert.equal(pool.find("UPDATE trades SET status=$1,provider_response=$2,error_message=$3 WHERE id="), undefined,
    'the row is left at submitting: a wait is not a new outcome, and rewriting the status per attempt is how a trade ends up describing the wrong one');
});

test('a retry re-sends under the same client id, so the earlier attempt is still findable', async () => {
  const first = fakePool();
  const firstAdapter = fakeAdapter({ orderError: Object.assign(new Error('Too many requests'), { name: 'TradeError', stringCode: 'TRADE_RETCODE_TOO_MANY_REQUESTS', numericCode: 10024 }) });
  await engineFor({ pool: first, adapter: firstAdapter }).processJob({ id: 'job-1', user_id: 'user-1' });
  const second = fakePool({ item: { attemptCount: 2 }, priorTrade: { id: 'trade-1', status: 'submitting' } });
  const secondAdapter = fakeAdapter();
  await engineFor({ pool: second, adapter: secondAdapter }).processJob({ id: 'job-1', user_id: 'user-1' });
  const sentTwice = [firstAdapter.ordersSent()[0].order.clientId, secondAdapter.ordersSent()[0].order.clientId];
  assert.equal(sentTwice[0], sentTwice[1], 'one intent, one id, whatever the attempt number');
  assert.match(sentTwice[0], /^SD_EURUSD_[0-9a-f]{9,}$/);
  const restamp = second.find("UPDATE trades SET symbol=");
  assert.ok(restamp, 'the retried attempt re-stamps its own row, so the trade describes the order that was actually sent');
  assert.equal(restamp.params[0], 'job-1', 'and it can only claim the row belonging to this job');
  assert.equal(clientIdFits({ clientId: sentTwice[0] }).ok, true, "and it still fits inside MetaAPI's comment budget");
});

test('a retry does not send when the account already holds the order, and reconciles it instead', async () => {
  const pool = fakePool({ item: { attemptCount: 2 }, priorTrade: { id: 'trade-1', status: 'submitting' } });
  const adapter = fakeAdapter({ found: { where: 'position', positionId: 'broker-position-9', orderId: 'broker-order-9', symbol: 'EURUSD' } });
  const result = await engineFor({ pool, adapter }).processJob({ id: 'job-1', user_id: 'user-1' });
  assert.equal(adapter.ordersSent().length, 0, 'the whole point: the first attempt reached the broker, so there is nothing to send');
  assert.equal(result.status, 'executed');
  assert.match(result.message, /already reached your broker; the order was matched by its client id/);
  const executed = pool.find("UPDATE trades SET status='executed'");
  assert.ok(executed.params.includes('broker-position-9'), 'and the position the earlier attempt produced is recorded on the row');
  assert.deepEqual(adapter.calls.map((call) => Object.keys(call)[0]), ['getAccountState', 'find'], 'the lookup happens once, after the snapshot and instead of the order');
  assert.equal(pool.find('UPDATE execution_jobs')?.params.includes('executed'), true);
});

test('an adapter that cannot answer the duplicate question stops the retry instead of guessing', async () => {
  const pool = fakePool({ item: { attemptCount: 2 }, priorTrade: { id: 'trade-1', status: 'submitting' } });
  const adapter = fakeAdapter({ noFind: true });
  const result = await engineFor({ pool, adapter }).processJob({ id: 'job-1', user_id: 'user-1' });
  assert.equal(adapter.ordersSent().length, 0, 'nothing is sent on an unknown');
  assert.equal(result.status, 'unknown');
  assert.match(result.message, /could not be searched|cannot do that/);
});

test('a lookup that fails is treated as unknown, not as "no duplicate found"', async () => {
  const pool = fakePool({ item: { attemptCount: 2 }, priorTrade: { id: 'trade-1', status: 'submitting' } });
  const adapter = fakeAdapter({ findError: new Error('MetaAPI account is not connected to the broker.') });
  const result = await engineFor({ pool, adapter }).processJob({ id: 'job-1', user_id: 'user-1' });
  assert.equal(adapter.ordersSent().length, 0);
  assert.equal(result.status, 'unknown', 'an unanswered question is never evidence of absence');
});

test('a network failure during submission is never retried, whatever it says', async () => {
  for (const message of ['socket hang up', 'fetch failed', 'connection reset by peer']) {
    const pool = fakePool();
    const adapter = fakeAdapter({ orderError: new Error(message) });
    const result = await engineFor({ pool, adapter }).processJob({ id: 'job-1', user_id: 'user-1' });
    assert.equal(result.status, 'unknown', message);
    assert.match(result.message, /may already have been applied; reconcile the broker account/);
    assert.equal(pool.find("UPDATE execution_jobs SET status='queued'"), undefined, 'and no retry is scheduled, because a second order may be a second trade');
    assert.equal(pool.find('UPDATE metaapi_accounts'), undefined, 'nor is the user told their credentials are at fault, which is not what this says');
  }
});

test('an invalid credentials failure is permanent: one attempt, a note on the account, no wait', async () => {
  const pool = fakePool();
  const adapter = fakeAdapter({ accountError: Object.assign(new Error('Authentication failed'), { details: 'E_AUTH' }) });
  const result = await engineFor({ pool, adapter }).processJob({ id: 'job-1', user_id: 'user-1' });
  assert.equal(result.status, 'failed', 'a job that cannot ever succeed is failed, not skipped or queued');
  assert.equal(adapter.ordersSent().length, 0);
  const note = pool.find('UPDATE metaapi_accounts SET execution_note');
  assert.ok(note, 'and the account itself carries the sentence');
  assert.deepEqual(note.params, ['user-1', 'account-1', 'Broker connection failed. Please check your credentials.']);
  assert.equal(pool.find("UPDATE execution_jobs SET status='queued'"), undefined, 'no retry is scheduled against a refusal that will repeat');
  const signal = pool.find('UPDATE signals SET status=');
  assert.equal(signal.params[0], 'failed', 'the signal row says the account blocked it, and the panel has words for that');
});

test('a broker that refuses orders is noted once per account, in the sentence the user can act on', async () => {
  const pool = fakePool();
  const adapter = fakeAdapter({
    orderError: Object.assign(new Error('AutoTrading disabled by server'), { name: 'TradeError', stringCode: 'TRADE_RETCODE_SERVER_DISABLES_AT', numericCode: 10026 }),
  });
  const result = await engineFor({ pool, adapter }).processJob({ id: 'job-1', user_id: 'user-1' });
  assert.equal(result.status, 'failed');
  assert.match(pool.find('UPDATE metaapi_accounts SET execution_note').params[2], /auto-trading disabled/i);
});

test('a permanent refusal of this order is rejected without blaming the account', async () => {
  const pool = fakePool();
  const adapter = fakeAdapter({
    orderError: Object.assign(new Error('Invalid volume'), { name: 'TradeError', stringCode: 'TRADE_RETCODE_INVALID_VOLUME', numericCode: 10014 }),
  });
  const result = await engineFor({ pool, adapter }).processJob({ id: 'job-1', user_id: 'user-1' });
  assert.equal(result.status, 'rejected', 'the order is what the broker refused, not the account');
  assert.equal(pool.find('UPDATE metaapi_accounts'), undefined, 'so no note is left to frighten the user with');
  assert.equal(pool.find("UPDATE execution_jobs SET status='queued'"), undefined, 'and a refusal a retry cannot fix is not retried');
});

test('the attempt budget is the whole budget: the third try is terminal', async () => {
  const pool = fakePool({ item: { attemptCount: 3 } });
  const adapter = fakeAdapter({ orderError: Object.assign(new Error('Market is closed'), { name: 'TradeError', stringCode: 'TRADE_RETCODE_MARKET_CLOSED', numericCode: 10018 }) });
  const result = await engineFor({ pool, adapter }).processJob({ id: 'job-1', user_id: 'user-1' });
  assert.equal(result.status, 'rejected', 'attempts spent, so the refusal is recorded as the outcome');
  assert.equal(pool.find("UPDATE execution_jobs SET status='queued'"), undefined);
});

test('a retry with no time left in the signal window expires instead of queueing a doomed attempt', async () => {
  const pool = fakePool({ item: { expires_at: new Date(Date.now() + 400).toISOString() } });
  const adapter = fakeAdapter({ orderError: Object.assign(new Error('Market is closed'), { name: 'TradeError', stringCode: 'TRADE_RETCODE_MARKET_CLOSED', numericCode: 10018 }) });
  const result = await engineFor({ pool, adapter }).processJob({ id: 'job-1', user_id: 'user-1' });
  assert.equal(result.status, 'expired', 'the window is the limit, and a signal that outlives it must not be traded late');
  assert.match(result.message, /no time left in the signal's window/);
});

test('a successful order takes the account note away, so a fixed problem stops being announced', async () => {
  const pool = fakePool();
  const adapter = fakeAdapter();
  const result = await engineFor({ pool, adapter }).processJob({ id: 'job-1', user_id: 'user-1' });
  assert.equal(result.status, 'executed');
  const cleared = pool.find('UPDATE metaapi_accounts SET execution_note=NULL');
  assert.ok(cleared, 'the clear is issued on the same account the order went to');
  assert.deepEqual(cleared.params, ['user-1', 'account-1']);
  assert.equal(pool.find('UPDATE execution_jobs').params.includes('executed'), true);
  assert.equal(pool.find('UPDATE execution_jobs').params.includes(null), true, 'and a settled job has no retry waiting behind it');
});

test('the backoff grows and stops growing, and the attempt count decides whether to try at all', () => {
  assert.deepEqual([1, 2, 3, 4, 5].map((attempt) => retryDelayMs({ attempt })), [1_500, 3_000, 6_000, 12_000, 15_000]);
  assert.equal(retryDelayMs({ attempt: 0 }), null, 'an attempt that never happened has no wait');
  assert.equal(canRetry({ attempt: 1, retriable: true }), true);
  assert.equal(canRetry({ attempt: 2, retriable: true }), true);
  assert.equal(canRetry({ attempt: 3, retriable: true }), false, 'the third attempt is the last one a job gets');
  assert.equal(canRetry({ attempt: 1, retriable: false }), false, 'attempts are not the constraint that decides; certainty is');
});

/* ================================= the queue's half of a retry ================================= */

test('the worker will not claim a job that is still waiting out its backoff', async () => {
  const statements = [];
  const client = {
    async query(sql) {
      statements.push(sql);
      return { rows: [] };
    },
    release() {},
  };
  const pool = { async connect() { return client; }, async query(sql) { statements.push(sql); return { rows: [] }; } };
  const engine = { async processJob() { return { status: 'executed' }; }, captureUtcDayBaselines: async () => ({ attempted: 0 }) };
  const worker = createExecutionWorker({ pool, engine, pollIntervalMs: 1 });
  // One turn of the real loop, so the expiring sweep and the claim are read in the order the worker uses
  // them: the same two statements, on the same rows, are what a waiting retry is judged by.
  await worker.runOnce();
  const claim = statements.find((sql) => sql.includes('FOR UPDATE SKIP LOCKED'));
  assert.match(claim, /\(next_attempt_at IS NULL OR next_attempt_at <= NOW\(\)\)/);
  assert.match(claim, /expires_at > NOW\(\)/, 'the signal window still bounds a retry: a job may wait, never outlive the signal');
  assert.equal(statements.some((sql) => sql.includes("SET status='expired'")), true, 'and a job whose window closed expires instead of waiting forever');
});

/* ===================== the code tables, read straight off what MetaAPI documents ===================== */

test('the two codes MetaAPI documents as "never delivered" and "unknowable" are told apart', () => {
  const before = classifyBrokerFailure({ error: Object.assign(new Error('Could not submit the trade request to the broker'), { name: 'TradeError', numericCode: -10, stringCode: 'TRADE_RETCODE_DISCONNECTED_BEFORE_TRADE' }), submitted: true });
  assert.equal(before.delivered, 'no');
  assert.equal(before.retriable, true, 'the request failed for sure, so sending it again duplicates nothing');
  const during = classifyBrokerFailure({ error: Object.assign(new Error('The trading server terminated the connection'), { name: 'TradeError', numericCode: -11, stringCode: 'TRADE_RETCODE_DISCONNECTED_DURING_TRADE' }), submitted: true });
  assert.equal(during.delivered, 'unknown');
  assert.equal(during.retriable, false, 'the result is not known, and that is the one answer a market order must not be retried on');
});

test('a refusal is judged on its code, not on which side of the transport it arrived', () => {
  const answered = classifyBrokerFailure({ result: { stringCode: 'TRADE_RETCODE_DONE', numericCode: 10009 } });
  assert.equal(answered.kind, 'permanent', 'a *successful* code is never a failure, so this only ever sees refusals');
  assert.equal(classifyBrokerFailure({ result: { stringCode: 'TRADE_RETCODE_REQUOTE', numericCode: 10004 } }).retriable, true);
  const margin = classifyBrokerFailure({ result: { stringCode: 'TRADE_RETCODE_NO_MONEY', numericCode: 10019, message: 'There is not enough money to complete the request.' } });
  assert.equal(margin.kind, 'permanent');
  assert.equal(margin.accountFault, false, 'running out of margin is a trade the user must change, not an account that is broken, so it is said on the signal and never as an account note');
  assert.equal(margin.note, null);
});

test('credential-shaped failures of every shape produce the one sentence the user can act on', () => {
  const shapes = [
    { error: Object.assign(new Error('Authentication failed'), { details: 'E_AUTH' }) },
    { error: Object.assign(new Error('forbidden'), { name: 'ApiError', status: 401 }) },
    { error: new Error('MetaApiUnauthorizedException: unauthorized') },
    { error: Object.assign(new Error('invalid api token'), { code: 'E_AUTH' }) },
    { result: { stringCode: 'ERR_INVESTOR', numericCode: -8, message: 'Trading is not allowed with investor password' } },
  ];
  for (const shape of shapes) {
    const failure = classifyBrokerFailure(shape);
    assert.equal(failure.kind, 'permanent', JSON.stringify(shape));
    assert.equal(failure.retriable, false, JSON.stringify(shape));
    assert.equal(failure.accountFault, true, JSON.stringify(shape));
    assert.match(failure.note, /(check your credentials|investor \(read-only\) password)/, JSON.stringify(shape));
  }
});

test('a broker server MetaAPI cannot serve is permanent and says so, rather than retrying forever', () => {
  const failure = classifyBrokerFailure({ error: Object.assign(new Error('.dat file for server not found'), { details: { code: 'E_SRV_NOT_FOUND' } }) });
  assert.equal(failure.kind, 'permanent');
  assert.equal(failure.accountFault, true);
  assert.match(failure.note, /cannot serve this broker server/i);
});

test('the guard functions answer for a bare call, so the engine is not the only way to be safe', () => {
  const clock = Date.now();
  assert.equal(guardQuote({ price: { bid: 1, ask: 1.1, time: new Date(clock).toISOString() }, now: clock }).ok, true);
  assert.deepEqual(guardQuote({ price: { bid: 1, ask: 0, time: new Date(clock).toISOString() }, now: clock }), { ok: false, kind: 'no-quote', message: 'MetaAPI did not provide a valid market quote.' });
  assert.equal(guardQuote({ price: null, now: clock }).kind, 'no-quote', 'no price at all is the same failure, told in the same words');
  assert.equal(guardQuote({ price: { bid: 1, ask: 1.1, time: 'not a date' }, now: clock }).kind, 'stale-quote', 'an undatable price is a stale price');
  assert.equal(STALE_CONNECTION_MESSAGE.includes('broker connection is stale'), true);
});

test('the client id builder follows the shape MetaAPI documents, and survives an awkward symbol', () => {
  assert.equal(buildClientId({ jobId: 'job-1', symbol: 'EURUSD' }), buildClientId({ jobId: 'job-1', symbol: 'eur_usd' }), 'the symbol part is a label; the same job gets the same id');
  const long = buildClientId({ jobId: 'job-2', symbol: 'GOLD.us.micro2024.mt5' });
  assert.equal(long.length <= 23, true, `${long} must fit beside the order comment`);
  assert.equal(clientIdFits({ clientId: long }).ok, true);
  assert.notEqual(buildClientId({ jobId: 'job-3', symbol: 'EURUSD' }), buildClientId({ jobId: 'job-4', symbol: 'EURUSD' }), 'two jobs never share an id');
  assert.throws(() => buildClientId({}), /durable job id is required/);
  assert.equal(clientIdFits({ clientId: '' }).reason.includes('A client id is required'), true, 'an order cannot leave without one');
  assert.equal(clientIdFits({ clientId: 'SD_EURUSD_deadbeefdeadbeefdead', comment: 'SD' }).ok, false, 'and neither can one that is too long for the comment field');
});
