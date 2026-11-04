import test from 'node:test';
import assert from 'node:assert/strict';

import { parseSignal } from '../services/signal-parser.js';
import { needsLayer2 } from '../services/signal-llm.js';
import { applySafetyNets, captureSafety, pipSizeFor } from '../services/signal-safety.js';
import { calculateOrderVolume, createExecutionEngine } from '../services/execution-engine.js';

function buildHarness({ parsed, quote, spec, lotSizeMode = 'fixed', fixedLotSize = 0.01, riskPercent = 1, balance = 1000 }) {
  const sentOrders = [];
  const item = {
    job_id: 'job-metal-1',
    user_id: 'user-1',
    job_status: 'processing',
    attemptCount: 1,
    expires_at: new Date(Date.now() + 120_000).toISOString(),
    signal_id: 'signal-metal-1',
    source: 'telegram',
    signal_created_at: new Date(),
    symbol: parsed.symbol,
    side: parsed.side,
    orderType: parsed.orderType,
    entry_price: parsed.entryPrice,
    entryRange: parsed.entryRange,
    stop_loss: parsed.stopLoss,
    take_profit: parsed.takeProfit,
    stop_loss_pips: parsed.stopLossPips,
    take_profit_pips: parsed.takeProfitPips,
    takeProfitLevels: parsed.takeProfitLevels,
    multipleTargetHandling: 'first_target',
    isScalping: parsed.isScalping,
    needs_review: false,
    execution_ready: parsed.executionReady,
    parse_error: parsed.parseError,
    auto_trading_enabled: true,
    lot_size_mode: lotSizeMode,
    fixed_lot_size: fixedLotSize,
    risk_percent: riskPercent,
    block_execution_without_stop_loss: true,
    block_execution_without_take_profit: true,
    fallback_stop_loss_points: null,
    fallback_take_profit_points: null,
    max_open_positions: 5,
    max_daily_trades: 10,
    daily_loss_limit: 10,
    execution_account_id: 'account-1',
    metaapi_account_id: 'account-1',
    managed_by_app: true,
    account_state: 'DEPLOYED',
    subscription_status: 'active',
    subscription_plan: 'pro',
  };

  const pool = {
    calls: [],
    async query(sql, params = []) {
      pool.calls.push({ sql, params });
      if (sql.includes('SELECT ej.id AS job_id')) return { rows: [item] };
      if (sql.includes('SELECT baseline_equity')) return { rows: [{ baseline_equity: balance }] };
      if (sql.includes('FROM trades')) return { rows: [{ count: 0 }] };
      if (sql.includes('SELECT auto_trading_enabled AS "autoTradingEnabled"')) {
        return { rows: [{ autoTradingEnabled: true, executionAccountId: 'account-1' }] };
      }
      if (sql.includes('INSERT INTO trades')) return { rows: [{ id: 'trade-metal-1' }] };
      return { rows: [], rowCount: 1 };
    },
    find: (needle) => pool.calls.find((call) => call.sql.includes(needle)),
  };

  const engine = createExecutionEngine({
    pool,
    trading: {
      async getAccountState() {
        return {
          account: { state: 'DEPLOYED' },
          accountInformation: { balance, equity: balance },
          positions: [],
          orders: [],
          deals: [],
          specification: spec,
          price: { ...quote, time: new Date().toISOString() },
          link: { connectedToBroker: true, synchronized: true },
        };
      },
      async createMarketOrder(order) {
        sentOrders.push(order);
        return { stringCode: 'TRADE_RETCODE_DONE', numericCode: 10009, orderId: 'ord-1', positionId: 'pos-1' };
      },
      async findOrderByClientId() {
        return null;
      },
    },
    resolveToken: async () => 'fake-token',
    runtimeEnabled: true,
    isTradingPaused: async () => false,
    now: () => Date.now(),
    logger: { info() {}, warn() {}, error() {} },
  });

  return { engine, sentOrders, pool };
}

test('pipSizeFor returns 0.01 for XAUUSD, 0.001 for XAGUSD (including broker suffixes), FX pip sizes for currencies, and null for indices/crypto/invalid symbols', () => {
  assert.equal(pipSizeFor('XAUUSD'), 0.01);
  assert.equal(pipSizeFor('XAU/USD'), 0.01);
  assert.equal(pipSizeFor('XAUUSDm'), 0.01);
  assert.equal(pipSizeFor('XAUUSD.pro'), 0.01);
  assert.equal(pipSizeFor('GOLD'), 0.01);

  assert.equal(pipSizeFor('XAGUSD'), 0.001);
  assert.equal(pipSizeFor('XAG/USD'), 0.001);
  assert.equal(pipSizeFor('XAGUSDm'), 0.001);
  assert.equal(pipSizeFor('XAGUSD.a'), 0.001);
  assert.equal(pipSizeFor('SILVER'), 0.001);

  assert.equal(pipSizeFor('EURUSD'), 0.0001);
  assert.equal(pipSizeFor('EURUSD.a'), 0.0001);
  assert.equal(pipSizeFor('USDJPY'), 0.01);

  for (const unsupported of ['US30', 'NAS100', 'US500', 'GER40', 'BTCUSD', 'ETHUSD', 'ADAUSD', 'USOIL', 'UKOIL', 'XPTUSD', 'XPDUSD', 'FOOBAR', 'INVALID', '']) {
    assert.equal(pipSizeFor(unsupported), null, `expected null pip size for ${unsupported}`);
  }
});

test('GOLD BUY @ Market SL 20 pips TP 50 pips parses cleanly and executes with exact $0.01/pip conversion', async () => {
  for (const raw of [
    'GOLD BUY @ Market SL 20 pips TP 50 pips',
    'GOLD BUY @ Market\nSL 20 pips\nTP 50 pips',
  ]) {
    const parsed = parseSignal(raw);
    assert.equal(parsed.symbol, 'XAUUSD');
    assert.equal(parsed.side, 'buy');
    assert.equal(parsed.entryPrice, null);
    assert.equal(parsed.orderType, 'market');
    assert.equal(parsed.orderTypeStated, true);
    assert.equal(parsed.stopLoss, null);
    assert.equal(parsed.stopLossPips, 20);
    assert.equal(parsed.takeProfit, null);
    assert.equal(parsed.takeProfitPips, 50);
    assert.equal(parsed.executionReady, true);
    assert.equal(parsed.parseError, null);
    assert.equal(needsLayer2(parsed), false);
    assert.equal(captureSafety({ parsed, source: 'telegram', settings: {} }).executionReady, true);

    const spec = { symbol: 'XAUUSD', minVolume: 0.01, maxVolume: 100, volumeStep: 0.01, tickSize: 0.01, stopsLevel: 10 };
    const quote = { bid: 3999.90, ask: 4000.00, lossTickValue: 1 };
    const { engine, sentOrders } = buildHarness({ parsed, quote, spec });

    const result = await engine.processJob({ id: 'job-metal-1', user_id: 'user-1' });
    assert.equal(result.status, 'executed', result.message ?? '');
    assert.equal(sentOrders.length, 1);
    // 1 pip = 0.01 -> 20 pips below 4000.00 = 3999.80; 50 pips above 4000.00 = 4000.50
    assert.equal(sentOrders[0].stopLoss, 3999.80);
    assert.equal(sentOrders[0].takeProfit, 4000.50);
  }
});

test('ADRIELLE TRADERS CIRCLE Gold signal with zone, numeric SL, and TP 50 pips executes cleanly at live ask + $0.50', async () => {
  const raw = 'GOLD BUY MORE NOW! Price : 4005.00 - 3995.00 SL - 3990.00 TP 50 pips';
  const parsed = parseSignal(raw);
  assert.equal(parsed.symbol, 'XAUUSD');
  assert.equal(parsed.side, 'buy');
  assert.equal(parsed.stopLoss, 3990);
  assert.equal(parsed.takeProfit, null);
  assert.equal(parsed.takeProfitPips, 50);
  assert.equal(parsed.executionReady, true);

  const spec = { symbol: 'XAUUSDm', minVolume: 0.01, maxVolume: 100, volumeStep: 0.01, tickSize: 0.01, stopsLevel: 10 };
  const quote = { bid: 3999.90, ask: 4000.00, lossTickValue: 1 };
  const { engine, sentOrders } = buildHarness({ parsed, quote, spec });

  const result = await engine.processJob({ id: 'job-metal-1', user_id: 'user-1' });
  assert.equal(result.status, 'executed', result.message ?? '');
  assert.equal(sentOrders.length, 1);
  assert.equal(sentOrders[0].symbol, 'XAUUSDm');
  assert.equal(sentOrders[0].stopLoss, 3990);
  assert.equal(sentOrders[0].takeProfit, 4000.50);
});

test('tick-size alignment and risk-based calculateOrderVolume work accurately with pip-based stops on Gold', async () => {
  // Coarse 0.05 tick grid aligns away from the market so rounding never tightens risk or clips stopsLevel:
  // 4000.00 - (13 * 0.01 = 0.13) = 3999.87 -> aligned down to 3999.85
  // 4000.00 + (13 * 0.01 = 0.13) = 4000.13 -> aligned up to 4000.15
  const aligned = applySafetyNets({
    side: 'buy',
    marketPrice: 4000.00,
    bid: 3999.90,
    ask: 4000.00,
    tickSize: 0.05,
    stopsLevelPoints: 2,
    stopLoss: null,
    takeProfit: null,
    stopLossPips: 13,
    takeProfitPips: 13,
    symbol: 'XAUUSD',
    blockExecutionWithoutStopLoss: true,
    blockExecutionWithoutTakeProfit: true,
    lotSizeMode: 'risk_based',
  });
  assert.equal(aligned.blocking, false);
  assert.equal(aligned.stopLoss, 3999.85);
  assert.equal(aligned.takeProfit, 4000.15);

  // Direct risk-based sizing verification on Gold with SL converted from 20 pips (4000.00 -> 3999.80 = 20 ticks):
  // Balance $1,000, risk 1% ($10), lossTickValue $1/tick (100 oz * $0.01) -> $20 loss per 1.00 lot -> 0.50 lots.
  const directVolume = calculateOrderVolume({
    mode: 'risk_based',
    fixedLotSize: 0.01,
    balance: 1000,
    riskPercent: 1,
    side: 'buy',
    entryPrice: 4000.00,
    stopLoss: 3999.80,
    specification: { minVolume: 0.01, maxVolume: 100, volumeStep: 0.01, tickSize: 0.01 },
    price: { bid: 3999.90, ask: 4000.00, lossTickValue: 1 },
  });
  assert.equal(directVolume, 0.50);

  // End-to-end risk_based execution through the engine with pip-based stop on Gold:
  const parsed = parseSignal('GOLD BUY @ Market SL 20 pips TP 50 pips');
  const spec = { symbol: 'XAUUSD', minVolume: 0.01, maxVolume: 100, volumeStep: 0.01, tickSize: 0.01, stopsLevel: 10 };
  const quote = { bid: 3999.90, ask: 4000.00, lossTickValue: 1 };
  const { engine, sentOrders } = buildHarness({
    parsed,
    quote,
    spec,
    lotSizeMode: 'risk_based',
    riskPercent: 1,
    balance: 1000,
  });

  const result = await engine.processJob({ id: 'job-metal-1', user_id: 'user-1' });
  assert.equal(result.status, 'executed', result.message ?? '');
  assert.equal(sentOrders.length, 1);
  assert.equal(sentOrders[0].volume, 0.50);
  assert.equal(sentOrders[0].stopLoss, 3999.80);
  assert.equal(sentOrders[0].takeProfit, 4000.50);
});

test('XAGUSD (Silver) pip conversion uses 1 pip = 0.001 and aligns to broker tickSize', async () => {
  const parsed = parseSignal('SILVER SELL @ Market SL 30 pips TP 80 pips');
  assert.equal(parsed.symbol, 'XAGUSD');
  assert.equal(parsed.side, 'sell');
  assert.equal(parsed.entryPrice, null);
  assert.equal(parsed.stopLossPips, 30);
  assert.equal(parsed.takeProfitPips, 80);
  assert.equal(parsed.executionReady, true);

  // Sell fills at bid = 30.500:
  // SL = 30.500 + (30 * 0.001) = 30.530 (above ask 30.510)
  // TP = 30.500 - (80 * 0.001) = 30.420 (below bid 30.500)
  const spec = { symbol: 'XAGUSD', minVolume: 0.01, maxVolume: 100, volumeStep: 0.01, tickSize: 0.001, stopsLevel: 5 };
  const quote = { bid: 30.500, ask: 30.510, lossTickValue: 5 };
  const { engine, sentOrders } = buildHarness({ parsed, quote, spec });

  const result = await engine.processJob({ id: 'job-metal-1', user_id: 'user-1' });
  assert.equal(result.status, 'executed', result.message ?? '');
  assert.equal(sentOrders.length, 1);
  assert.equal(sentOrders[0].stopLoss, 30.53);
  assert.equal(sentOrders[0].takeProfit, 30.42);
});

test('non-FX / non-metal and invalid symbols still trigger stop-loss-pips-unusable and take-profit-pips-unusable safety blocks', async () => {
  for (const symbol of ['US30', 'BTCUSD', 'USOIL', 'XPTUSD', 'INVALID']) {
    const safety = applySafetyNets({
      side: 'buy',
      marketPrice: 40000,
      bid: 39995,
      ask: 40000,
      tickSize: 1,
      stopsLevelPoints: 5,
      stopLoss: null,
      takeProfit: null,
      stopLossPips: 20,
      takeProfitPips: 50,
      symbol,
      fallbackStopLossPoints: null,
      fallbackTakeProfitPoints: null,
      blockExecutionWithoutStopLoss: true,
      blockExecutionWithoutTakeProfit: true,
      lotSizeMode: 'fixed',
    });
    assert.equal(safety.blocking, true, `${symbol} must block when SL/TP are given in pips`);
    assert.ok(safety.problems.some((problem) => problem.code === 'stop-loss-pips-unusable'), `${symbol} should report stop-loss-pips-unusable`);
    assert.ok(safety.problems.some((problem) => problem.code === 'take-profit-pips-unusable'), `${symbol} should report take-profit-pips-unusable`);
  }

  // Also verify end-to-end execution skip on US30 pip signal:
  const us30Parsed = parseSignal('US30 BUY @ Market SL 20 pips TP 50 pips');
  assert.equal(us30Parsed.symbol, 'US30');
  const spec = { symbol: 'US30', minVolume: 0.01, maxVolume: 100, volumeStep: 0.01, tickSize: 1, stopsLevel: 5 };
  const quote = { bid: 39995, ask: 40000, lossTickValue: 1 };
  const { engine, sentOrders } = buildHarness({ parsed: us30Parsed, quote, spec });

  const result = await engine.processJob({ id: 'job-metal-1', user_id: 'user-1' });
  assert.equal(result.status, 'skipped');
  assert.equal(sentOrders.length, 0);
  assert.match(String(result.message), /pips are not a defined distance for US30/i);
});
