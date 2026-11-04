/**
 * End-to-end target selection in the execution engine across `first_target`, `final_target`, and `scale_out`.
 *
 * Verifies that when a signal publishes multiple targets (TP1, TP2, TP3):
 *   - `first_target` sends TP1 to the broker;
 *   - `final_target` ignores TP1 and TP2 completely (even when live price has already moved past TP1/TP2)
 *     and sends only TP3 to the broker for both market and pending orders;
 *   - `scale_out` sets the position's broker TP to the final rung while recording partial closes for the
 *     intermediate rungs, and drops already-passed rungs rather than failing on TP1.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { parseSignal } from '../services/signal-parser.js';
import { createExecutionEngine } from '../services/execution-engine.js';

const AT = Date.parse('2026-10-25T12:00:00.000Z');
const clock = () => AT;

const SPEC = { symbol: 'XAUUSD', minVolume: 0.01, maxVolume: 100, volumeStep: 0.01, tickSize: 0.01, stopsLevel: 10 };

const goldQuote = (bid, ask = Number((bid + 0.2).toFixed(2))) => ({
  bid,
  ask,
  time: new Date(AT).toISOString(),
});

function signalItem(message, over = {}) {
  const parsed = parseSignal(message);
  if (parsed.parseError && !over.parse_error) {
    throw new Error(`fixture message failed to parse: ${parsed.parseError}`);
  }
  return {
    job_id: 'job-1',
    user_id: 'user-1',
    job_status: 'processing',
    attemptCount: 1,
    expires_at: new Date(AT + 120_000).toISOString(),
    signal_id: 'signal-1',
    source: 'telegram',
    signal_created_at: new Date(AT),
    symbol: parsed.symbol,
    side: parsed.side,
    entry_price: parsed.entryPrice,
    stop_loss: parsed.stopLoss,
    take_profit: parsed.takeProfit,
    orderType: parsed.orderType,
    orderTypeStated: parsed.orderTypeStated,
    isScalping: parsed.isScalping,
    entryRange: parsed.entryRange,
    execution_ready: true,
    parse_error: null,
    needs_review: false,
    stop_loss_pips: parsed.stopLossPips,
    take_profit_pips: parsed.takeProfitPips,
    auto_trading_enabled: true,
    lot_size_mode: 'fixed',
    fixed_lot_size: 0.03,
    risk_percent: 1,
    block_execution_without_stop_loss: true,
    block_execution_without_take_profit: false,
    fallback_stop_loss_points: null,
    fallback_take_profit_points: null,
    max_open_positions: 3,
    max_daily_trades: 10,
    daily_loss_limit: 5,
    execution_account_id: 'account-1',
    metaapi_account_id: 'account-1',
    managed_by_app: true,
    account_state: 'DEPLOYED',
    subscription_status: 'active',
    subscription_plan: 'pro',
    multipleTargetHandling: 'first_target',
    takeProfitLevels: parsed.takeProfitLevels,
    limitOrderExpiryValue: 30,
    limitOrderExpiryUnit: 'minutes',
    maxSlippagePoints: null,
    ...over,
  };
}

function fakePool(item) {
  const calls = [];
  return {
    calls,
    find: (needle) => calls.find((call) => call.sql.includes(needle)),
    filter: (needle) => calls.filter((call) => call.sql.includes(needle)),
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes('SELECT ej.id AS job_id')) return { rows: [item] };
      if (sql.includes('SELECT baseline_equity')) return { rows: [{ baseline_equity: 1000 }] };
      if (sql.includes('SELECT COUNT(*)::int AS count FROM trades')) return { rows: [{ count: 0 }] };
      if (sql.includes('SELECT auto_trading_enabled AS "autoTradingEnabled"')) {
        return { rows: [{ autoTradingEnabled: true, executionAccountId: 'account-1' }] };
      }
      if (sql.includes('INSERT INTO trades')) return { rows: [{ id: 'trade-1' }] };
      return { rows: [], rowCount: 1 };
    },
  };
}

function fakeAdapter(price) {
  const calls = [];
  return {
    calls,
    marketOrders: () => calls.filter((call) => call.kind === 'market').map((call) => call.args),
    pendingOrders: () => calls.filter((call) => call.kind === 'pending').map((call) => call.args),
    async getAccountState() {
      return {
        account: { state: 'DEPLOYED' },
        accountInformation: { balance: 1000, equity: 1000 },
        positions: [],
        orders: [],
        deals: [],
        specification: SPEC,
        price,
        link: { connectedToBroker: true, synchronized: true },
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
    async cancelOrder() {
      return { result: { stringCode: 'TRADE_RETCODE_DONE', numericCode: 10025 }, error: null };
    },
    async findOrderByClientId() {
      return null;
    },
  };
}

function runJob(item, price) {
  const pool = fakePool(item);
  const adapter = fakeAdapter(price);
  const engine = createExecutionEngine({
    pool,
    trading: adapter,
    resolveToken: async () => 'fake-token',
    runtimeEnabled: true,
    isTradingPaused: async () => false,
    now: clock,
    logger: { info() {}, warn() {}, error() {} },
  });
  return engine.processJob({ id: 'job-1', user_id: 'user-1' }).then((result) => ({ pool, adapter, result }));
}

const BUY_LADDER_SIGNAL = 'BUY NOW XAUUSD\nEntry: 2650\nSL: 2645\nTP1: 2655\nTP2: 2660\nTP3: 2665';
const BUY_LIMIT_LADDER_SIGNAL = 'BUY LIMIT XAUUSD\nEntry: 2650\nSL: 2645\nTP1: 2655\nTP2: 2660\nTP3: 2665';
const SELL_LADDER_SIGNAL = 'SELL NOW XAUUSD\nEntry: 2650\nSL: 2655\nTP1: 2645\nTP2: 2640\nTP3: 2635';

test('First Target Only sends TP1 (2655) to the broker on a multi-target signal', async () => {
  const item = signalItem(BUY_LADDER_SIGNAL, { multipleTargetHandling: 'first_target' });
  assert.deepEqual(item.takeProfitLevels, [2655, 2660, 2665]);
  assert.equal(item.take_profit, 2655);

  const { pool, adapter, result } = await runJob(item, goldQuote(2649.8, 2650));

  assert.equal(result.status, 'executed');
  assert.equal(adapter.marketOrders().length, 1);
  assert.equal(adapter.marketOrders()[0].takeProfit, 2655, 'broker market order receives TP1');
  assert.equal(adapter.marketOrders()[0].stopLoss, 2645);

  const tradeInsert = pool.find('INSERT INTO trades');
  assert.ok(tradeInsert);
  assert.equal(tradeInsert.params[9], 2655, 'recorded trade row stores TP1');
  assert.equal(pool.filter('INSERT INTO trade_tp_levels').length, 0, 'no scale-out ladder is recorded');
});

test('Final Target Only ignores TP1 and TP2 and sends only TP3 (2665) for market and pending orders', async () => {
  const marketItem = signalItem(BUY_LADDER_SIGNAL, { multipleTargetHandling: 'final_target' });
  const marketRun = await runJob(marketItem, goldQuote(2649.8, 2650));

  assert.equal(marketRun.result.status, 'executed');
  assert.equal(marketRun.adapter.marketOrders().length, 1);
  assert.equal(marketRun.adapter.marketOrders()[0].takeProfit, 2665, 'market order receives only TP3 (2665)');
  assert.equal(marketRun.pool.find('INSERT INTO trades').params[9], 2665, 'recorded market trade stores TP3');
  assert.equal(marketRun.pool.filter('INSERT INTO trade_tp_levels').length, 0);

  const pendingItem = signalItem(BUY_LIMIT_LADDER_SIGNAL, { multipleTargetHandling: 'final_target' });
  const pendingRun = await runJob(pendingItem, goldQuote(2652, 2652.2));

  assert.equal(pendingRun.result.status, 'pending');
  assert.equal(pendingRun.adapter.pendingOrders().length, 1);
  assert.equal(pendingRun.adapter.pendingOrders()[0].takeProfit, 2665, 'pending limit order receives only TP3 (2665)');
  assert.equal(pendingRun.pool.find('INSERT INTO trades').params[9], 2665, 'recorded pending trade stores TP3');
});

test('Final Target Only completely ignores TP1/TP2 when live price has already passed earlier targets', async () => {
  // Live ask is 2661.5: past TP1 (2655) and TP2 (2660), but still profitably below TP3 (2665).
  // Allow drift so the market-order drift guard permits filling above 2650 and reaches target validation.
  const passedEarlierQuote = goldQuote(2661.3, 2661.5);

  const firstModeRun = await runJob(
    signalItem(BUY_LADDER_SIGNAL, { multipleTargetHandling: 'first_target', maxSlippagePoints: 2000 }),
    passedEarlierQuote,
  );
  assert.equal(firstModeRun.result.status, 'skipped');
  assert.equal(firstModeRun.adapter.marketOrders().length, 0, 'First Target Only skips because TP1 (2655) is behind ask (2661.5)');
  const firstSkipped = firstModeRun.pool.find('UPDATE signals SET status=$1,execution_note=$2');
  assert.ok(firstSkipped);
  assert.equal(firstSkipped.params[0], 'unexecuted');
  assert.match(String(firstSkipped.params[1]), /wrong side of the market/);

  const finalModeRun = await runJob(
    signalItem(BUY_LADDER_SIGNAL, { multipleTargetHandling: 'final_target', maxSlippagePoints: 2000 }),
    passedEarlierQuote,
  );
  assert.equal(finalModeRun.result.status, 'executed');
  assert.equal(finalModeRun.adapter.marketOrders().length, 1, 'Final Target Only executes because TP3 (2665) is still ahead of ask (2661.5)');
  assert.equal(finalModeRun.adapter.marketOrders()[0].takeProfit, 2665, 'broker receives TP3 (2665)');

  // And if live ask has also passed TP3 (2665), Final Target Only still refuses the trade.
  const passedAllQuote = goldQuote(2665.8, 2666);
  const pastFinalRun = await runJob(
    signalItem(BUY_LADDER_SIGNAL, { multipleTargetHandling: 'final_target', maxSlippagePoints: 2000 }),
    passedAllQuote,
  );
  assert.equal(pastFinalRun.result.status, 'skipped');
  assert.equal(pastFinalRun.adapter.marketOrders().length, 0, 'Final Target Only skips once TP3 itself is behind the market');

  // Sell direction mirror: TP1=2645, TP2=2640, TP3=2635 with live bid at 2639 (past TP1 and TP2, above TP3).
  const sellFinalRun = await runJob(
    signalItem(SELL_LADDER_SIGNAL, { multipleTargetHandling: 'final_target', maxSlippagePoints: 2000 }),
    goldQuote(2639, 2639.2),
  );
  assert.equal(sellFinalRun.result.status, 'executed');
  assert.equal(sellFinalRun.adapter.marketOrders().length, 1);
  assert.equal(sellFinalRun.adapter.marketOrders()[0].takeProfit, 2635, 'SELL order in Final Target Only receives TP3 (2635)');
});

test('Split & Scale-Out places TP3 on the broker position and records intermediate partial-close rungs', async () => {
  const item = signalItem(BUY_LADDER_SIGNAL, { multipleTargetHandling: 'scale_out', fixed_lot_size: 0.04 });
  const { pool, adapter, result } = await runJob(item, goldQuote(2649.8, 2650));

  assert.equal(result.status, 'executed');
  assert.equal(adapter.marketOrders().length, 1);
  assert.equal(adapter.marketOrders()[0].takeProfit, 2665, 'position rides to final target TP3 while partial closes handle TP1/TP2');
  const scaleOutInserts = pool.filter('INSERT INTO trade_tp_levels');
  assert.deepEqual(
    scaleOutInserts.map((call) => call.params[7]),
    [2655, 2660],
    'intermediate rungs TP1 (2655) and TP2 (2660) are persisted for partial closes',
  );

  // If TP1 (2655) is already passed (ask 2656) while TP2 (2660) and TP3 (2665) remain ahead, scale_out
  // drops TP1 and scales out across TP2 and TP3 instead of failing on TP1.
  const partialLadderRun = await runJob(
    signalItem(BUY_LADDER_SIGNAL, { multipleTargetHandling: 'scale_out', fixed_lot_size: 0.02, maxSlippagePoints: 2000 }),
    goldQuote(2655.8, 2656),
  );
  assert.equal(partialLadderRun.result.status, 'executed');
  assert.equal(partialLadderRun.adapter.marketOrders().length, 1);
  assert.equal(partialLadderRun.adapter.marketOrders()[0].takeProfit, 2665);
  assert.deepEqual(
    partialLadderRun.pool.filter('INSERT INTO trade_tp_levels').map((call) => call.params[7]),
    [2660],
    'remaining intermediate rung TP2 (2660) is persisted while riding to TP3 (2665)',
  );
});
