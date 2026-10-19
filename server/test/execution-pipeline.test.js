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
};

function fakePool({ baseline = 1000, localTrades = 0 } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes('SELECT ej.id AS job_id')) return { rows: [{ ...baseItem }] };
      if (sql.includes('SELECT baseline_equity')) return { rows: [{ baseline_equity: baseline }] };
      if (sql.includes('SELECT COUNT(*)::int AS count FROM trades')) return { rows: [{ count: localTrades }] };
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
});
