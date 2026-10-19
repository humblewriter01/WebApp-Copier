import test from 'node:test';
import assert from 'node:assert/strict';
import { createMetaApiTradingAdapter } from '../services/metaapi-trading.js';

function mockMetaApi({ state = 'DEPLOYED', brokerConnected = true, accountInformation = { balance: 1000, equity: 1000 }, price = { bid: 1.1, ask: 1.1002, time: new Date().toISOString() }, specification = { symbol: 'EURUSD', minVolume: 0.01, maxVolume: 50, volumeStep: 0.01, tickSize: 0.00001 }, specifications = [specification] } = {}) {
  const calls = [];
  const connection = {
    terminalState: {
      connectedToBroker: brokerConnected,
      accountInformation,
      positions: [],
      orders: [],
      specifications,
      price: () => price,
      specification: () => specification,
    },
    historyStorage: { dealSynchronizationFinished: true, dealsByTimeRange: () => [] },
    connect: async () => calls.push(['connect']),
    waitSynchronized: async () => calls.push(['waitSynchronized']),
    subscribeToMarketData: async (symbol) => calls.push(['subscribe', symbol]),
    createMarketBuyOrder: async (...args) => { calls.push(['buy', ...args]); return { stringCode: 'TRADE_RETCODE_DONE', numericCode: 10009 }; },
    createMarketSellOrder: async (...args) => { calls.push(['sell', ...args]); return { stringCode: 'TRADE_RETCODE_DONE', numericCode: 10009 }; },
    close: async () => calls.push(['close']),
  };
  class FakeMetaApi {
    constructor(token) { calls.push(['token', token]); this.metatraderAccountApi = { getAccount: async (accountId) => ({ id: accountId, state, getStreamingConnection: () => connection }) }; }
  }
  return { FakeMetaApi, calls, connection };
}

test('connects, synchronizes, subscribes, and returns live account/quote data', async () => {
  const { FakeMetaApi, calls } = mockMetaApi();
  const adapter = createMetaApiTradingAdapter({ MetaApiClass: FakeMetaApi });
  const state = await adapter.getAccountState({ token: 'ASCII_TEST_TOKEN_0123456789', accountId: 'account-1', symbol: 'EURUSD' });
  assert.equal(state.accountInformation.balance, 1000);
  assert.equal(state.price.ask, 1.1002);
  assert.equal(state.specification.symbol, 'EURUSD');
  assert.ok(calls.some(([name]) => name === 'waitSynchronized'));
  assert.ok(calls.some(([name, symbol]) => name === 'subscribe' && symbol === 'EURUSD'));
  await adapter.close();
});

test('resolves a unique broker suffix before subscribing, but rejects ambiguous broker aliases', async () => {
  const unique = mockMetaApi({
    specification: { symbol: 'EURUSD.a', minVolume: 0.01, maxVolume: 20, volumeStep: 0.01, tickSize: 0.00001 },
    specifications: [{ symbol: 'EURUSD.a', minVolume: 0.01, maxVolume: 20, volumeStep: 0.01, tickSize: 0.00001 }],
  });
  const adapterA = createMetaApiTradingAdapter({ MetaApiClass: unique.FakeMetaApi });
  const state = await adapterA.getAccountState({ token: 'ASCII_TEST_TOKEN_0123456789', accountId: 'account-1', symbol: 'EURUSD' });
  assert.equal(state.symbol, 'EURUSD.a');
  assert.ok(unique.calls.some(([name, symbol]) => name === 'subscribe' && symbol === 'EURUSD.a'));
  await adapterA.close();

  const ambiguous = mockMetaApi({ specifications: [
    { symbol: 'EURUSD.a', minVolume: 0.01, maxVolume: 20, volumeStep: 0.01, tickSize: 0.00001 },
    { symbol: 'EURUSD.pro', minVolume: 0.01, maxVolume: 20, volumeStep: 0.01, tickSize: 0.00001 },
  ] });
  const adapterB = createMetaApiTradingAdapter({ MetaApiClass: ambiguous.FakeMetaApi });
  await assert.rejects(adapterB.getAccountState({ token: 'ASCII_TEST_TOKEN_0123456789', accountId: 'account-1', symbol: 'EURUSD' }), /more than one broker symbol/i);
  assert.equal(ambiguous.calls.some(([name]) => name === 'subscribe'), false);
});

test('invokes MetaAPI market orders with the expected symbol, volume, SL/TP, and idempotency options', async () => {
  const { FakeMetaApi, calls } = mockMetaApi();
  const adapter = createMetaApiTradingAdapter({ MetaApiClass: FakeMetaApi });
  await adapter.createMarketOrder({ token: 'ASCII_TEST_TOKEN_0123456789', accountId: 'account-1', side: 'buy', symbol: 'EURUSD', volume: 0.02, stopLoss: 1.09, takeProfit: 1.12, clientId: 'SD1234567890abcdef' });
  const orderCall = calls.find(([name]) => name === 'buy');
  assert.deepEqual(orderCall.slice(1), ['EURUSD', 0.02, 1.09, 1.12, { comment: 'SD', clientId: 'SD1234567890abcdef' }]);
  await adapter.close();
});

test('rejects accounts that are not deployed and broker connections that are not ready', async () => {
  const undeployed = mockMetaApi({ state: 'DRAFT' });
  const adapterA = createMetaApiTradingAdapter({ MetaApiClass: undeployed.FakeMetaApi });
  await assert.rejects(adapterA.getAccountState({ token: 'ASCII_TEST_TOKEN_0123456789', accountId: 'account-1' }), /not deployed/i);

  const disconnected = mockMetaApi({ brokerConnected: false });
  const adapterB = createMetaApiTradingAdapter({ MetaApiClass: disconnected.FakeMetaApi });
  await assert.rejects(adapterB.getAccountState({ token: 'ASCII_TEST_TOKEN_0123456789', accountId: 'account-1' }), /not connected to the broker/i);
});

test('rejects an invalid account balance/equity snapshot before use', async () => {
  const { FakeMetaApi } = mockMetaApi({ accountInformation: { balance: 0, equity: null } });
  const adapter = createMetaApiTradingAdapter({ MetaApiClass: FakeMetaApi });
  await assert.rejects(adapter.getAccountState({ token: 'ASCII_TEST_TOKEN_0123456789', accountId: 'account-1' }), /balance and equity/i);
});
