/**
 * A captured signal the channel never dated.
 *
 * `signals.sent_at` is nullable on purpose, and the capture writes `null` rather than reading its own clock,
 * because a fabricated send time would defeat the column: the whole point of storing when the *trader* posted is
 * that a signal which reaches us five minutes late must not be described as five minutes fresh. The execution
 * engine's age bound (`MAX_SIGNAL_AGE_MS`, two minutes) therefore reads `COALESCE(s.sent_at, s.created_at)` -
 * the fallback exists for rows written before that column shipped, whose `created_at` genuinely is the moment the
 * signal arrived, and for sources that have no channel clock at all.
 *
 * A Telegram update with no usable `date` walks into that fallback by accident. For it, `created_at` is the
 * instant *we* stored it, so a post of unknown age - three days old in the case that produced this file, see the
 * post-deploy replay in the production log - arrives looking two minutes old and is traded. That is not an
 * "expired" problem and not a "stale" problem; it is the absence of the measurement those judgements need. So the
 * claim query states the missing clock as its own column, and the engine refuses on it before a token is
 * resolved, before a quote is asked, and before the age bound that cannot be evaluated.
 *
 * The distinction the trader is owed is in the sentence: "we refused to guess" is not "the market moved on".
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createExecutionEngine, NO_POSTING_TIME_MESSAGE } from '../services/execution-engine.js';
import { isTechnicalNote } from '../services/signal-wording.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const engineSource = readFileSync(path.join(here, '..', 'services/execution-engine.js'), 'utf8');

/** The row a claim query returns for a signal that is otherwise perfectly tradable. */
const baseItem = {
  job_id: 'job-1', user_id: 'user-1', job_status: 'processing', expires_at: new Date(Date.now() + 120000),
  signal_id: 'signal-1', source: 'telegram', signal_created_at: new Date(), sent_at: new Date(), symbol: 'EURUSD', side: 'buy',
  entry_price: null, stop_loss: 1.09, take_profit: 1.12, execution_ready: true, parse_error: null,
  auto_trading_enabled: true, lot_size_mode: 'fixed', fixed_lot_size: 0.01, risk_percent: 1,
  block_execution_without_stop_loss: true, block_execution_without_take_profit: true,
  fallback_stop_loss_points: null, fallback_take_profit_points: null,
  max_open_positions: 3, max_daily_trades: 10, daily_loss_limit: 5, execution_account_id: 'account-1',
  metaapi_account_id: 'account-1', managed_by_app: true, account_state: 'DEPLOYED',
  subscription_status: 'active', subscription_plan: 'pro',
};

/** The claim query is answered verbatim, which is also where a test puts `sentAtMissing` - see the pin below for
 *  why the SQL text is asserted here rather than only in the source. */
function fakePool({ item = {} } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes('SELECT ej.id AS job_id')) return { rows: [{ ...baseItem, ...item }] };
      if (sql.includes('SELECT baseline_equity')) return { rows: [{ baseline_equity: 1000 }] };
      if (sql.includes('SELECT COUNT(*)::int AS count FROM trades')) return { rows: [{ count: 0 }] };
      if (sql.includes('SELECT auto_trading_enabled AS "autoTradingEnabled"')) return { rows: [{ autoTradingEnabled: true, executionAccountId: 'account-1' }] };
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

/** Only `createMarketOrder` counts as reaching the broker; an account snapshot is not an order. */
function orderCalls(trading) {
  return trading.calls.filter((call) => call?.order);
}

async function run(item) {
  const pool = fakePool({ item });
  const trading = fakeTrading();
  const engine = createExecutionEngine({ pool, trading, resolveToken: async () => 'fake-token', runtimeEnabled: true });
  const result = await engine.processJob({ id: 'job-1', user_id: 'user-1' });
  return { pool, trading, result };
}

const SENTENCE = 'This signal arrived without a posting time, so it was not executed.';

test('the copy a trader is owed for an undated signal, stated exactly', () => {
  assert.equal(NO_POSTING_TIME_MESSAGE, SENTENCE, 'the sentence is product copy, so it is pinned as a string and not as a regex someone can satisfy with a paraphrase');
  assert.equal(isTechnicalNote(SENTENCE), false, 'and it carries no code, provider, status or URL, which is what lets it survive the mirror to the signal row unchanged');
});

test('a telegram row with no posting time is refused before anything is asked of the market', async () => {
  // `signal_created_at` is fresh *because* `sent_at` is null and the COALESCE fell back to the write time: this is
  // the row that used to trade. Every guard above the refusal is satisfied, so only the new one can stop it.
  const { pool, trading, result } = await run({ sentAtMissing: true, sent_at: null, signal_created_at: new Date() });
  assert.equal(result.status, 'expired', 'an un-ageable signal is finished, not retried: a later attempt has no more information than this one did');
  assert.equal(result.message, SENTENCE);
  assert.equal(trading.calls.length, 0, 'no account snapshot and no order - the decision is made before a token is resolved');
  assert.equal(pool.calls.some(({ sql }) => sql.includes('INSERT INTO trades')), false, 'and no trade row is written for a signal that never went out');

  const settled = pool.calls.find(({ sql }) => sql.includes('UPDATE execution_jobs SET status='));
  assert.equal(settled.params[0], 'expired', 'the job the admin history reads');
  assert.equal(settled.params[1], SENTENCE);
  const mirror = pool.calls.find(({ sql }) => sql.includes('UPDATE signals SET status='));
  assert.equal(mirror.params[0], 'expired', 'the signal row the trader reads, in the same words');
  assert.equal(mirror.params[1], SENTENCE, 'the sentence reaches the panel verbatim - no friendly substitution rewrote it');
  assert.equal(mirror.params[2], null, 'and nothing was demoted to technical_note, because there was nothing technical about it');
});

test('the claim query states the missing clock, and the guard consumes exactly that column', async () => {
  /* The behaviour above is driven by a fixture row, so on its own it proves only that the engine honours the
     flag. What the database actually sends is asserted from the SQL this engine issued - the real query text,
     captured on the way past a real pool boundary, not grepped out of the file and not restated in a fake. */
  const { pool } = await run({ sentAtMissing: true, sent_at: null });
  const claim = pool.calls.find(({ sql }) => sql.includes('SELECT ej.id AS job_id'));
  assert.match(claim.sql, /\(s\.sent_at IS NULL AND s\.source = 'telegram'\) AS "sentAtMissing"/,
    'the predicate is the user-visible rule: no posting time, on the source that has a channel clock to be missing');

  const guardAt = engineSource.indexOf('if (item.sentAtMissing === true)');
  assert.ok(guardAt > 0, 'the engine reads that alias, by name');
  const ageAt = engineSource.indexOf('const createdAt = new Date(item.signal_created_at).getTime();');
  assert.ok(guardAt < ageAt && ageAt - guardAt < 1500, 'ahead of the age bound it protects, inside the same block, so the two refusals cannot be reordered into one');
  assert.equal(/!\s*item\.sentAtMissing/.test(engineSource), false,
    'only a definite TRUE refuses: a row where the expression is NULL - a source the column never covered - falls through to the ordinary bound instead of being blocked by a missing value');
});

test('a dated signal still trades, and a dated-but-stale one still gets the stale sentence', async () => {
  const fresh = await run({});
  assert.equal(fresh.result.status, 'executed', 'the guard does not over-block: a row the query reports as having a posting time is sent on');
  assert.equal(orderCalls(fresh.trading).length, 1);

  const stale = await run({ sentAtMissing: false, signal_created_at: new Date(Date.now() - 10 * 60_000) });
  assert.equal(stale.result.status, 'expired');
  assert.match(stale.result.message, /too old to execute safely/, 'two refusals, two sentences: "the market moved on" stays distinguishable from "we refused to guess"');
  assert.equal(stale.result.message === SENTENCE, false);
  assert.equal(orderCalls(stale.trading).length, 0);
});
