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
    closePositionPartially: async (...args) => { calls.push(['closePartial', ...args]); return { stringCode: 'TRADE_RETCODE_DONE_PARTIAL', numericCode: 10010, positionId: args[0], filledVolume: args[1] }; },
    modifyPosition: async (...args) => { calls.push(['modify', ...args]); return { stringCode: 'TRADE_RETCODE_DONE', numericCode: 10009 }; },
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

test('a partial close is forwarded as a volume, with the comment and client id the terminal expects', async () => {
  const { FakeMetaApi, calls, connection } = mockMetaApi();
  const adapter = createMetaApiTradingAdapter({ MetaApiClass: FakeMetaApi });
  const result = await adapter.closePositionPartially({ token: 'ASCII_TEST_TOKEN_0123456789', accountId: 'account-1', positionId: 'position-9', volume: 0.05, clientId: 'SDabc' });
  assert.equal(result.stringCode, 'TRADE_RETCODE_DONE_PARTIAL');
  const sent = calls.find(([name]) => name === 'closePartial');
  assert.deepEqual(sent, ['closePartial', 'position-9', 0.05, { comment: 'SD', clientId: 'SDabc' }], 'the SDK takes (positionId, volume, options) and nothing else');
  await adapter.close();

  // The guards are here rather than in the caller because this is the last point that can still refuse:
  // a zero or negative volume reaches the terminal as a request to close everything, and an empty
  // position id is a request against whichever position the library happens to resolve.
  for (const volume of [0, -0.05, 'many', null]) {
    await assert.rejects(() => adapter.closePositionPartially({ token: 'ASCII_TEST_TOKEN_0123456789', accountId: 'account-1', positionId: 'position-9', volume }), /positive volume/);
  }
  await assert.rejects(() => adapter.closePositionPartially({ token: 'ASCII_TEST_TOKEN_0123456789', accountId: 'account-1', positionId: '  ', volume: 0.05 }), /broker position id is required/);
  assert.equal(calls.filter(([name]) => name === 'closePartial').length, 1, 'a refused request never reached the connection');
});

/* ---------------- the boundary every order passes: an id the broker can store and we can find again ----------------
 * MetaAPI keeps `clientId` inside the order comment, so the two share one length budget, and it publishes
 * no unique constraint over the id. Both facts show up as rules here: an order without an id, or with one
 * too long for the field, never leaves this process, and the lookup a retry depends on is this file's job.
 */

const TOKEN = 'ASCII_TEST_TOKEN_0123456789';
const GOOD_ID = 'SD_EURUSD_deadbeef1';

test('an order without a client id is refused before the broker is touched', async () => {
  const { FakeMetaApi, calls } = mockMetaApi();
  const adapter = createMetaApiTradingAdapter({ MetaApiClass: FakeMetaApi });
  await assert.rejects(() => adapter.createMarketOrder({ token: TOKEN, accountId: 'account-1', side: 'buy', symbol: 'EURUSD', volume: 0.02, stopLoss: 1.09, takeProfit: 1.12 }), /client id is required/i);
  await assert.rejects(() => adapter.closePositionPartially({ token: TOKEN, accountId: 'account-1', positionId: 'position-1', volume: 0.01 }), /client id is required/i);
  assert.deepEqual(calls.filter(([name]) => name === 'buy' || name === 'closePartial'), [], 'no request reaches the terminal on either path');
  await adapter.close();
});

test('an id too long for the comment field is refused rather than truncated by the broker', async () => {
  const { FakeMetaApi, calls } = mockMetaApi();
  const adapter = createMetaApiTradingAdapter({ MetaApiClass: FakeMetaApi });
  // The old shape: `SD` + 24 hex is 26 characters of its own and 28 beside a two-character comment, over
  // the strictest budget MetaAPI documents. It has to fail here instead of on the user's account.
  await assert.rejects(() => adapter.createMarketOrder({ token: TOKEN, accountId: 'account-1', side: 'buy', symbol: 'EURUSD', volume: 0.02, stopLoss: 1.09, takeProfit: 1.12, clientId: `SD${'a'.repeat(24)}` }), /within 26 characters/i);
  assert.equal(calls.filter(([name]) => name === 'buy').length, 0);
  await adapter.close();
});

test('the account is searched for an earlier attempt by position, then pending order, then deal', async () => {
  const withPosition = mockMetaApi();
  withPosition.connection.terminalState.positions = [{ id: 'broker-position-9', symbol: 'EURUSD', clientId: GOOD_ID }];
  const adapterA = createMetaApiTradingAdapter({ MetaApiClass: withPosition.FakeMetaApi });
  const foundPosition = await adapterA.findOrderByClientId({ token: TOKEN, accountId: 'account-1', clientId: GOOD_ID });
  assert.equal(foundPosition.where, 'position');
  assert.equal(foundPosition.positionId, 'broker-position-9');
  await adapterA.close();

  const withOrder = mockMetaApi();
  withOrder.connection.terminalState.orders = [{ id: 'broker-order-4', symbol: 'EURUSD', clientId: GOOD_ID }];
  const adapterB = createMetaApiTradingAdapter({ MetaApiClass: withOrder.FakeMetaApi });
  assert.equal((await adapterB.findOrderByClientId({ token: TOKEN, accountId: 'account-1', clientId: GOOD_ID })).where, 'order');
  await adapterB.close();

  const withDeal = mockMetaApi();
  withDeal.connection.historyStorage = { dealSynchronizationFinished: true, dealsByTimeRange: () => [{ id: 'deal-1', orderId: 'broker-order-7', positionId: 'broker-position-7', symbol: 'EURUSD', clientId: GOOD_ID }] };
  const adapterC = createMetaApiTradingAdapter({ MetaApiClass: withDeal.FakeMetaApi });
  const deal = await adapterC.findOrderByClientId({ token: TOKEN, accountId: 'account-1', clientId: GOOD_ID });
  assert.deepEqual({ where: deal.where, positionId: deal.positionId, orderId: deal.orderId }, { where: 'deal', positionId: 'broker-position-7', orderId: 'broker-order-7' }, 'a position opened and closed inside the retry window is still evidence');
  await adapterC.close();

  const empty = mockMetaApi();
  const adapterD = createMetaApiTradingAdapter({ MetaApiClass: empty.FakeMetaApi });
  assert.equal(await adapterD.findOrderByClientId({ token: TOKEN, accountId: 'account-1', clientId: GOOD_ID }), null, 'and nothing found is a genuine answer, not an error');
  await adapterD.close();
});

test('an unsynchronized account refuses to answer the duplicate question', async () => {
  const { FakeMetaApi, connection } = mockMetaApi();
  connection.terminalState.positions = null;
  const adapter = createMetaApiTradingAdapter({ MetaApiClass: FakeMetaApi });
  await assert.rejects(() => adapter.findOrderByClientId({ token: TOKEN, accountId: 'account-1', clientId: GOOD_ID }), /not synchronized/i);
  await adapter.close();
});

test('the snapshot reports what the link itself says, including after it drops', async () => {
  const { FakeMetaApi, connection } = mockMetaApi();
  const adapter = createMetaApiTradingAdapter({ MetaApiClass: FakeMetaApi });
  const before = await adapter.getAccountState({ token: TOKEN, accountId: 'account-1', symbol: 'EURUSD' });
  assert.deepEqual(before.link, { connectedToBroker: true, synchronized: true });
  // The connection is cached, so this is the real shape of the failure: the link went away after the
  // snapshot machinery had already approved it, and only the flags say so.
  connection.terminalState.connectedToBroker = false;
  const after = await adapter.getAccountState({ token: TOKEN, accountId: 'account-1', symbol: 'EURUSD' });
  assert.equal(after.link.connectedToBroker, false);
  connection.terminalState.connectedToBroker = true;
  connection.synchronized = false;
  const unsynced = await adapter.getAccountState({ token: TOKEN, accountId: 'account-1', symbol: 'EURUSD' });
  assert.equal(unsynced.link.synchronized, false);
  await adapter.close();
});
