/**
 * "Gold Buy now / SL: 4041.50" — a market order with a stop and no entry price.
 *
 * This is the shape a real channel writes when it does not want to commit to a number: the metal, the
 * direction, and the level that kills the trade. The message is complete, and the only wrong response
 * available to a copier is to call it unclear. This file walks that one text through the three places it
 * could be lost - the parser, the dashboard's filter, and the engine - and asserts the outcome at each,
 * against a mocked MetaAPI adapter so nothing here can accidentally trade on a real account.
 *
 * The property the whole file protects is that a missing entry is *information about how to enter* (at
 * market, now), never a reason to refuse: an absent entry must skip the entry-price guard, not trip it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseSignal } from '../services/signal-parser.js';
import { captureSafety, TARGET_REQUIRED_MESSAGE } from '../services/signal-safety.js';
import { createExecutionEngine } from '../services/execution-engine.js';
import { buildDashboardActionableSignalsQuery } from '../services/dashboard-signals.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const routes = readFileSync(path.join(here, '..', 'index.js'), 'utf8');

/** The exact text from the brief, punctuation and all. */
export const MARKET_SIGNAL_TEXT = 'Gold Buy now\n\nSL: 4041.50';

/** Gold's own instrument rules: a point is 0.01, and a stop has to clear 10 points. */
const SPEC = { symbol: 'XAUUSD', minVolume: 0.01, maxVolume: 100, volumeStep: 0.01, tickSize: 0.01, stopsLevel: 10 };
const QUOTE = { bid: 4050, ask: 4050.2, lossTickValue: 1 };

const settingsFor = (over = {}) => ({
  lotSizeMode: 'fixed',
  blockExecutionWithoutStopLoss: true,
  blockExecutionWithoutTakeProfit: true,
  fallbackStopLossPoints: null,
  fallbackTakeProfitPoints: null,
  ...over,
});

/* --------------------------------------------------------------------- the parse --------------------------------------------------------------------- */

test('the message names gold, a direction, and a stop - and no entry, which is not a failure', () => {
  const parsed = parseSignal(MARKET_SIGNAL_TEXT);
  assert.equal(parsed.symbol, 'XAUUSD', 'the word "Gold" is the metal, not an unsupported symbol');
  assert.equal(parsed.side, 'buy');
  assert.equal(parsed.stopLoss, 4041.5);
  assert.equal(parsed.entryPrice, null, 'no entry is stated, so none is invented');
  assert.equal(parsed.takeProfit, null);
  assert.equal(parsed.directionInferred, false, 'the channel said BUY; nothing was judged');
  assert.equal(parsed.parseError, null, 'and it is not flagged unclear: there is nothing missing but the price to enter at');
  assert.equal(parsed.executionReady, true);
  assert.deepEqual(parsed.missing, { entryPrice: true, stopLoss: false, takeProfit: true });
  assert.equal(parsed.hasTradingData, true, 'the row carries a trade, which is what separates it from a bulletin');
});

test('a name glued to punctuation still resolves, because channels punctuate', async () => {
  const { parseSignal: parse } = await import('../services/signal-parser.js');
  for (const [text, symbol] of [
    ['BUY NOW Gold, SL 4041.50', 'XAUUSD'],
    ['Gold. Buy now. SL: 4041.50', 'XAUUSD'],
    ['sell gold: SL 4041.50', 'XAUUSD'],
    ['**SELL GOLD:** SL 4030', 'XAUUSD'],
    ['#Gold sell now SL 4030', 'XAUUSD'],
    ['trade WTI crude now SL 61.20', 'USOIL'],
  ]) {
    assert.equal(parse(text).symbol, symbol, `${text} used to be refused for the punctuation next to its metal`);
  }
  // The strict half of the boundary is still there: a name may not be found *inside* a longer word.
  assert.equal(parse('be ETHICAL and DOWnload now, SL 1').symbol, null, 'no alias may be read out of an unrelated sentence');
});

/* -------------------------------------------------------------------- the capture -------------------------------------------------------------------- */

test('the workspace decides, not the parser: the missing TP is a policy, the missing entry never is', () => {
  const parsed = parseSignal(MARKET_SIGNAL_TEXT);

  const blocked = captureSafety({ parsed, source: 'telegram', settings: settingsFor() });
  assert.equal(blocked.executionReady, false);
  assert.equal(blocked.parseError, TARGET_REQUIRED_MESSAGE, 'the only refusal this text can earn is the one the user switched on themselves');
  assert.match(blocked.parseError, /take-profit target/, 'and it names the leg that is absent, never "no clear signal"');
  assert.equal(/entry/i.test(blocked.parseError), false, 'nothing here is blamed on the missing entry price');

  const rescued = captureSafety({ parsed, source: 'telegram', settings: settingsFor({ fallbackTakeProfitPoints: 500 }) });
  assert.equal(rescued.executionReady, true, 'an Advanced Safety net completes the leg, so the signal is eligible');
  assert.equal(rescued.parseError, null);

  const overridden = captureSafety({ parsed, source: 'telegram', settings: settingsFor({ blockExecutionWithoutTakeProfit: false }) });
  assert.equal(overridden.executionReady, true, 'and a workspace that allows a naked position is not contradicted');

  /* The row that gets written is what the dashboard and the engine both read, so the storage has to keep the
     stop even when the signal is refused - that is the difference between "not tradeable yet" and "nothing
     was said". */
  /* The statement is checked by shape rather than by a literal run of placeholders: pinning `$1..$16` meant
     every column added to the row broke a test about something else. What has to stay true is that the insert
     is one statement, that its values line up with its columns, and that the provenance of a number is stored
     with the number. */
  const insert = routes.match(/INSERT INTO signals\(([\s\S]*?)\)\s*VALUES\(([^)]*)\)/);
  assert.ok(insert, 'the capture site writes the row in one statement');
  const columns = insert[1].split(',').map((name) => name.trim()).filter(Boolean);
  const values = insert[2].split(',').map((value) => value.trim()).filter(Boolean);
  assert.equal(columns.length, values.length, 'every stored column is given a value, in order');
  for (const column of ['needs_review', 'parsed_by', 'parse_confidence', 'llm_used', 'stop_loss_pips', 'take_profit_pips']) {
    assert.ok(columns.includes(column), `${column} is stored at capture, not patched in afterwards`);
  }
  assert.match(routes, /\[userId, channel\.channelId \|\| null, channel\.title \|\| null, telegramMessageId, source, savedText, parsed\.symbol, parsed\.side, parsed\.entryPrice, parsed\.stopLoss, parsed\.takeProfit,/, 'entry, stop and target are stored as the parser read them, null included');
});

test('a market-order signal passes the dashboard filter on the strength of its stop loss', () => {
  const parsed = parseSignal(MARKET_SIGNAL_TEXT);
  const { sql } = buildDashboardActionableSignalsQuery();
  // Which columns the shipped predicate treats as "states a price", read out of the SQL rather than
  // restated here, so the filter can be changed without the test quietly agreeing with whatever it became.
  const pricedColumns = [...sql.matchAll(/(\w+) IS NOT NULL/g)].map((match) => match[1]).filter((name) => name.endsWith('price') || name.endsWith('_loss') || name.endsWith('_profit'));
  assert.deepEqual(pricedColumns, ['entry_price', 'stop_loss', 'take_profit']);
  const row = { entry_price: parsed.entryPrice, stop_loss: parsed.stopLoss, take_profit: parsed.takeProfit, execution_ready: parsed.executionReady, status: 'unparsed' };
  const statesAPrice = pricedColumns.some((column) => row[column] != null);
  assert.equal(statesAPrice, true, 'the stop loss alone is enough to earn the row a place on the Overview');
  assert.equal(row.entry_price, null, 'while the entry stays absent');
});

/* --------------------------------------------------------------------- the engine --------------------------------------------------------------------- */

/**
 * The row `saveSignal` would have written, fed straight into the engine. Deriving it from the parse rather
 * than typing it out is the point: the test then fails if the parser starts inventing an entry, not only if
 * the engine stops handling its absence.
 */
function itemFromParse(parsed, over = {}) {
  return {
    job_id: 'job-1', user_id: 'user-1', job_status: 'processing', attemptCount: 1,
    expires_at: new Date(Date.now() + 120_000).toISOString(),
    signal_id: 'signal-1', source: 'telegram', signal_created_at: new Date(),
    symbol: parsed.symbol, side: parsed.side,
    entry_price: parsed.entryPrice, stop_loss: parsed.stopLoss, take_profit: parsed.takeProfit,
    execution_ready: true, parse_error: null,
    auto_trading_enabled: true, lot_size_mode: 'fixed', fixed_lot_size: 0.01, risk_percent: 1,
    block_execution_without_stop_loss: true, block_execution_without_take_profit: true,
    fallback_stop_loss_points: null, fallback_take_profit_points: null,
    max_open_positions: 3, max_daily_trades: 10, daily_loss_limit: 5,
    execution_account_id: 'account-1', metaapi_account_id: 'account-1', managed_by_app: true,
    account_state: 'DEPLOYED', subscription_status: 'active', subscription_plan: 'pro',
    multipleTargetHandling: 'first_target', takeProfitLevels: parsed.takeProfitLevels,
    ...over,
  };
}

/** `fakePool(..).find` matches a substring; this takes a predicate, for the inserts we want by shape. */
const findCall = (pool, test) => pool.calls.find((call) => test(call.sql));

function fakePool(item) {
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
      return { rows: [], rowCount: 1 };
    },
  };
}

function fakeAdapter({ price = QUOTE, side } = {}) {
  const calls = [];
  return {
    calls,
    ordersSent: () => calls.filter((call) => call.order).map((call) => call.order),
    async getAccountState() {
      return {
        account: { state: 'DEPLOYED' },
        accountInformation: { balance: 1000, equity: 1000 },
        positions: [], orders: [], deals: [], specification: SPEC,
        price: { ...price, time: new Date().toISOString() },
        link: { connectedToBroker: true, synchronized: true },
      };
    },
    async createMarketOrder(order) {
      calls.push({ order });
      return { stringCode: 'TRADE_RETCODE_DONE', numericCode: 10009, orderId: 'gold-order-1', positionId: 'gold-position-1' };
    },
    async findOrderByClientId() { return null; },
  };
}

/** Runs the job and hands back the outcome plus what the broker actually received. */
async function runEngine({ item, price = QUOTE }) {
  const adapter = fakeAdapter({ price });
  const pool = fakePool(item);
  const engine = createExecutionEngine({
    pool, trading: adapter, resolveToken: async () => 'fake-token', runtimeEnabled: true,
    isTradingPaused: async () => false, now: () => Date.now(),
    logger: { info() {}, warn() {}, error() {} },
  });
  return { pool, adapter, result: await engine.processJob({ id: 'job-1', user_id: 'user-1' }) };
}

test('a signal with no entry goes to the broker as a market buy at the ask', async () => {
  const parsed = parseSignal(MARKET_SIGNAL_TEXT);
  const { pool, adapter, result } = await runEngine({ item: itemFromParse(parsed, { fallback_take_profit_points: 500 }) });
  assert.equal(result.status, 'executed', 'the trade is taken; a missing entry is not a reason to refuse');

  const sent = adapter.ordersSent();
  assert.equal(sent.length, 1, 'exactly one order reached the adapter');
  const [order] = sent;
  assert.equal(order.symbol, 'XAUUSD');
  assert.equal(order.side, 'buy');
  assert.equal(order.volume, 0.01);
  assert.equal(order.stopLoss, 4041.5, 'the stop the channel stated is the stop that is sent, untouched');
  assert.equal(order.takeProfit, 4055.2, '500 points of gold (0.01 each) above the ask the order is filled at - the fallback net measured from the market, not from an entry nobody gave');
  assert.match(order.clientId, /^SD_XAUUSD_/, 'and the idempotency id is the one every retry reuses');

  // The price the position is booked at is the live ask, and it is the ask alone: no entry, no adjustment.
  const tradeInsert = findCall(pool, (sql) => /INSERT INTO trades\(/.test(sql));
  assert.ok(tradeInsert, 'the trade row is written before the order is sent');
  assert.equal(tradeInsert.params[7], QUOTE.ask, 'entry_price on the trade is the ask this order went out at');
  assert.equal(tradeInsert.params[8], 4041.5);
  assert.equal(tradeInsert.params[9], 4055.2);
});

test('a market sell fills at the bid, and no entry-price guard is applied to either', async () => {
  const parsed = parseSignal('Gold Sell now\n\nSL: 4060.00');
  assert.equal(parsed.side, 'sell');
  assert.equal(parsed.entryPrice, null);
  const { pool, adapter, result } = await runEngine({ item: itemFromParse(parsed, { fallback_take_profit_points: 500 }) });
  assert.equal(result.status, 'executed');
  const [order] = adapter.ordersSent();
  assert.equal(order.side, 'sell');
  assert.equal(order.stopLoss, 4060, 'a sell with its stop above the market is the correct shape, not an error');
  assert.equal(order.takeProfit, 4045, '500 points below the bid');
  assert.equal(findCall(pool, (sql) => /INSERT INTO trades\(/.test(sql)).params[7], QUOTE.bid, 'a sell books the bid');
});

test('the entry-price guard is skipped because there is no entry, not failed', async () => {
  // With an entry of 4050.10 for a buy, an ask of 4050.2 is "worse than the signal entry" and the job is
  // skipped. With no entry stated there is nothing to be worse than, and the order goes out.
  const parsed = parseSignal(MARKET_SIGNAL_TEXT);
  const noEntry = await runEngine({ item: itemFromParse(parsed, { fallback_take_profit_points: 500 }) });
  assert.equal(noEntry.result.status, 'executed');

  const stated = await runEngine({ item: itemFromParse({ ...parsed, entryPrice: 4050.1 }, { fallback_take_profit_points: 500 }) });
  assert.equal(stated.result.status, 'skipped');
  assert.equal(stated.result.message, 'The current market price is worse than the signal entry price.', 'the guard is real - it is the *absence* of an entry that switches it off');

  // And with no entry stated, nothing has to be re-qualified when the market has run far from where the
  // channel was typing: `now` is answered by whatever `now` is, and the fallback net is measured from there.
  const far = await runEngine({ item: itemFromParse(parsed, { fallback_take_profit_points: 500 }), price: { bid: 4180, ask: 4180.2, lossTickValue: 1 } });
  assert.equal(far.result.status, 'executed', '130 dollars of movement does not make this signal stale');
  assert.equal(far.adapter.ordersSent()[0].takeProfit, 4185.2, 'the target is built from the price the order goes out at, not from the message');
  assert.equal(far.adapter.ordersSent()[0].stopLoss, 4041.5, 'the stated stop is still the stated stop');

  // What *is* still refused is a leg that cannot be a leg: a buy with its stop above the market.
  const wrongSide = await runEngine({ item: itemFromParse(parsed, { stop_loss: 4200, fallback_take_profit_points: 500 }) });
  assert.equal(wrongSide.result.status, 'skipped');
  assert.equal(wrongSide.result.message, 'The signal stop loss is on the wrong side of the market.', 'the entry guard is off, the price sanity guards are not');
});

test('the missing take profit is answered by the net, and only by the net', async () => {
  const parsed = parseSignal(MARKET_SIGNAL_TEXT);

  const withNet = await runEngine({ item: itemFromParse(parsed, { fallback_take_profit_points: 500 }) });
  assert.equal(withNet.result.status, 'executed');

  const withoutNet = await runEngine({ item: itemFromParse(parsed) });
  assert.equal(withoutNet.result.status, 'skipped');
  assert.equal(withoutNet.result.message, TARGET_REQUIRED_MESSAGE, 'the sentence the user can act on, in the Safety settings');
  assert.deepEqual(withoutNet.adapter.ordersSent(), [], 'and the broker was never touched, because a skip that already sent an order is not a skip');

  const naked = await runEngine({ item: itemFromParse(parsed, { block_execution_without_take_profit: false }) });
  assert.equal(naked.result.status, 'executed', 'with the block off, the override sends the position unprotected and records it');
  assert.equal(naked.adapter.ordersSent()[0].takeProfit, null, 'no target is invented on the way; the adapter is what drops it before the SDK sees it');
});
