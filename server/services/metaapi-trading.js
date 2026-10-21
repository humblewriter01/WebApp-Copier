import crypto from 'node:crypto';
import MetaApi from 'metaapi.cloud-sdk/esm-node';
import { normalizeMetaApiToken } from './metaapi.js';
import { resolveBrokerSymbol } from './signal-parser.js';

const CONNECTION_TIMEOUT_MS = 45_000;
const DEFAULT_QUOTE_TIMEOUT_MS = 7_000;
const MAX_QUOTE_AGE_MS = 15_000;

function withTimeout(promise, milliseconds, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out.`)), milliseconds);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function tokenFingerprint(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function accountInfoOf(connection) {
  const info = connection.terminalState?.accountInformation;
  if (!info || !Number.isFinite(Number(info.balance)) || Number(info.balance) <= 0 || !Number.isFinite(Number(info.equity)) || Number(info.equity) <= 0) {
    throw new Error('MetaAPI did not provide current account balance and equity.');
  }
  return info;
}

export function createMetaApiTradingAdapter({ MetaApiClass = MetaApi, now = () => Date.now(), quoteTimeoutMs = DEFAULT_QUOTE_TIMEOUT_MS } = {}) {
  const clients = new Map();
  const connections = new Map();

  function getClient(token) {
    const normalized = normalizeMetaApiToken(String(token || ''));
    const key = tokenFingerprint(normalized);
    let api = clients.get(key);
    if (!api) {
      api = new MetaApiClass(normalized);
      clients.set(key, api);
    }
    return { api, normalized, key };
  }

  async function getConnection(token, accountId) {
    if (typeof accountId !== 'string' || !accountId.trim()) throw new Error('A connected trading account is required.');
    const { api, normalized, key: tokenKey } = getClient(token);
    const cacheKey = `${tokenKey}:${accountId}`;
    const existing = connections.get(cacheKey);
    if (existing) return existing;

    const connectionPromise = (async () => {
      const account = await api.metatraderAccountApi.getAccount(accountId);
      const state = String(account?.state || '').toUpperCase();
      if (!['DEPLOYED', 'CONNECTED'].includes(state)) throw new Error('The selected MetaAPI account is not deployed.');
      const connection = account.getStreamingConnection();
      await connection.connect();
      await withTimeout(connection.waitSynchronized(), CONNECTION_TIMEOUT_MS, 'MetaAPI account synchronization');
      if (connection.terminalState?.connectedToBroker !== true) throw new Error('MetaAPI account is not connected to the broker.');
      accountInfoOf(connection);
      return { connection, account, tokenKey, cacheKey, token: normalized };
    })();
    connections.set(cacheKey, connectionPromise);
    try { return await connectionPromise; }
    catch (error) { connections.delete(cacheKey); throw error; }
  }

  async function waitForFreshPrice(connection, symbol, timeoutMs = quoteTimeoutMs) {
    const until = now() + timeoutMs;
    let lastPrice = null;
    while (now() <= until) {
      lastPrice = connection.terminalState?.price(symbol) || null;
      const bid = Number(lastPrice?.bid);
      const ask = Number(lastPrice?.ask);
      const quoteTime = Date.parse(lastPrice?.time || '');
      if (Number.isFinite(bid) && bid > 0 && Number.isFinite(ask) && ask > 0 && Number.isFinite(quoteTime)) {
        const age = now() - quoteTime;
        if (age >= -5_000 && age <= MAX_QUOTE_AGE_MS) return lastPrice;
      }
      await delay(250);
    }
    throw new Error(lastPrice ? 'MetaAPI did not provide a fresh, valid market quote.' : 'MetaAPI did not provide a market quote for this symbol.');
  }

  async function getAccountState({ token, accountId, symbol = null, fromTime = new Date(Date.UTC(new Date(now()).getUTCFullYear(), new Date(now()).getUTCMonth(), new Date(now()).getUTCDate())), quoteTimeoutMs: requestQuoteTimeoutMs = quoteTimeoutMs }) {
    const { connection, account } = await getConnection(token, accountId);
    const terminal = connection.terminalState;
    const accountInformation = accountInfoOf(connection);
    const positions = terminal.positions;
    const orders = terminal.orders;
    if (!Array.isArray(positions) || !Array.isArray(orders)) throw new Error('MetaAPI account positions or pending orders are not synchronized.');

    let resolvedSymbol = null;
    let specification = null;
    if (symbol) {
      const resolution = resolveBrokerSymbol(symbol, terminal.specifications);
      if (!resolution.symbol) throw new Error(resolution.error);
      resolvedSymbol = resolution.symbol;
      specification = resolution.specification;
      await connection.subscribeToMarketData(resolvedSymbol);
    }

    const history = connection.historyStorage;
    if (!history || history.dealSynchronizationFinished !== true) throw new Error('MetaAPI account trade history is not synchronized.');
    const deals = history.dealsByTimeRange(new Date(fromTime), new Date(now()));
    const price = resolvedSymbol ? await waitForFreshPrice(connection, resolvedSymbol, requestQuoteTimeoutMs) : null;

    return { account, connection, accountInformation, positions, orders, deals, history, price, specification, symbol: resolvedSymbol };
  }

  async function createMarketOrder({ token, accountId, side, symbol, volume, stopLoss, takeProfit, clientId }) {
    const { connection } = await getConnection(token, accountId);
    const options = { comment: 'SD', clientId };
    if (side === 'buy') return connection.createMarketBuyOrder(symbol, volume, stopLoss, takeProfit ?? undefined, options);
    if (side === 'sell') return connection.createMarketSellOrder(symbol, volume, stopLoss, takeProfit ?? undefined, options);
    throw new Error('Unsupported order direction.');
  }

  /**
   * Moves the stop loss of an open position. MetaAPI's
   * `modifyPosition(positionId, stopLoss, takeProfit, trailingStopLoss, stopPriceBase)`
   * omits any stop that is undefined, so passing only a numeric stop loss leaves the
   * existing take profit untouched.
   */
  async function modifyPosition({ token, accountId, positionId, stopLoss }) {
    const id = String(positionId ?? '').trim();
    if (!id) throw new Error('A broker position id is required to move a stop loss.');
    const price = Number(stopLoss);
    if (!Number.isFinite(price) || price <= 0) throw new Error('A valid stop loss price is required to move a stop loss.');
    const { connection } = await getConnection(token, accountId);
    return connection.modifyPosition(id, price);
  }

  async function close() {
    const pending = [...connections.values()];
    connections.clear();
    await Promise.allSettled(pending.map(async (connectionPromise) => {
      const value = await connectionPromise;
      await value.connection.close();
    }));
    clients.clear();
  }

  return { getAccountState, createMarketOrder, modifyPosition, close };
}
