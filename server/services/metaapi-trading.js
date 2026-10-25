import crypto from 'node:crypto';
import MetaApi from 'metaapi.cloud-sdk/esm-node';
import { normalizeMetaApiToken } from './metaapi.js';
import { resolveBrokerSymbol } from './signal-parser.js';
import { CLIENT_ID_COMMENT, clientIdFits } from './execution-defense.js';

const CONNECTION_TIMEOUT_MS = 45_000;
const DEFAULT_QUOTE_TIMEOUT_MS = 7_000;
/* Deliberately looser than the execution engine's 2-second bound (`MAX_QUOTE_AGE_MS` in
 * `execution-defense.js`), and not a mistake: this tolerance governs every read of the account, including
 * the protection sweeps, where acting on a slightly aged price beats leaving an open position with no
 * stop at all. Opening a NEW position is the case where an aged price costs money, so that judgement is
 * made in the engine against a tighter clock - this file supplies the quote and says how old it is, and
 * never decides whether old means "don't trade".
 */
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

    /* `link` is what the connection itself says at the moment the snapshot was taken. The two flags come
     * straight off the SDK: `connectedToBroker` on the terminal state, and the connection's own
     * `synchronized` getter. They are reported, not enforced here, because "the link is down" has two very
     * different remedies depending on whether it blocks an order or only warns against moving a stop - and
     * deciding that is the engine's job, not this file's.
     */
    return {
      account, connection, accountInformation, positions, orders, deals, history, price, specification,
      symbol: resolvedSymbol,
      link: { connectedToBroker: terminal?.connectedToBroker === true, synchronized: connection.synchronized !== false },
    };
  }

  /**
   * MetaAPI has no unique constraint over `clientId`: it stores the value inside the order comment, which
   * is also why the two share a length budget (the schemas in this SDK version say 30 characters with a
   * comment and 31 without, the older JSDoc says 26; the app obeys the strictest reading, with slack).
   * So a repeated id is *not* refused by the broker, and an order without an id cannot be recognised as a
   * repeat at all. That is why this boundary refuses to submit without one: the alternative is a silent
   * second trade on an account that is not ours to guess about.
   */
  function assertClientId(clientId) {
    const fit = clientIdFits({ clientId, comment: CLIENT_ID_COMMENT });
    if (!fit.ok) throw new Error(fit.reason);
    return String(clientId);
  }

  async function createMarketOrder({ token, accountId, side, symbol, volume, stopLoss, takeProfit, clientId }) {
    const order = { comment: CLIENT_ID_COMMENT, clientId: assertClientId(clientId) };
    const { connection } = await getConnection(token, accountId);
    if (side === 'buy') return connection.createMarketBuyOrder(symbol, volume, stopLoss, takeProfit ?? undefined, order);
    if (side === 'sell') return connection.createMarketSellOrder(symbol, volume, stopLoss, takeProfit ?? undefined, order);
    throw new Error('Unsupported order direction.');
  }

  /**
   * A resting order - a limit or a stop - at the price the channel published, with the same protective legs
   * a market order would have carried, and a broker-side expiry.
   *
   * Two things about this call are not obvious from the SDK and are the reason it is wrapped rather than
   * reached for directly. The first is the expiration: MetaAPI will accept an order with no deadline and hold
   * it on the server indefinitely, and an order that outlives the setup it came from is money that moves
   * while nobody is watching. So the caller passes the deadline it computed and this method hands it to the
   * platform, which is the one place the rule can be enforced even when this service is asleep; the app's
   * own sweeper is the belt, not the braces. The second is that `ORDER_TIME_SPECIFIED` is the only expiration
   * type MT4 supports, so it is the one this uses on both platforms rather than the prettier MT5 variants.
   *
   * A market order is deliberately not this method's business: `expiration` is invalid on one, and silently
   * dropping a deadline the caller believed it had set is worse than refusing.
   */
  async function createPendingOrder({ token, accountId, kind, side, symbol, volume, price, stopLoss, takeProfit, expiration, clientId }) {
    const openPrice = Number(price);
    if (!Number.isFinite(openPrice) || openPrice <= 0) throw new Error('A resting order needs the price it waits at.');
    const orderKind = String(kind || '').toLowerCase();
    const orderSide = String(side || '').toLowerCase();
    const method = { 'limit:buy': 'createLimitBuyOrder', 'limit:sell': 'createLimitSellOrder', 'stop:buy': 'createStopBuyOrder', 'stop:sell': 'createStopSellOrder' }[`${orderKind}:${orderSide}`];
    if (!method) throw new Error('A resting order needs a limit or stop kind and a buy or sell direction.');
    const volumeNumber = Number(volume);
    if (!Number.isFinite(volumeNumber) || volumeNumber <= 0) throw new Error('A positive volume is required to place an order.');
    const options = { comment: CLIENT_ID_COMMENT, clientId: assertClientId(clientId) };
    if (expiration && typeof expiration === 'object' && expiration.type && expiration.time instanceof Date && Number.isFinite(expiration.time.getTime())) {
      options.expiration = { type: String(expiration.type), time: expiration.time };
    }
    const { connection } = await getConnection(token, accountId);
    return connection[method](symbol, volumeNumber, openPrice, stopLoss ?? undefined, takeProfit ?? undefined, options);
  }

  /**
   * Takes a resting order off the broker's book. MetaAPI's `cancelOrder(orderId)` accepts only the order id
   * and is refused for a position - which is the correct division, and the reason the caller has to look for
   * the order by id rather than guess at one from a position.
   *
   * A refusal is returned, not thrown: "the order is no longer there" is the outcome the sweeper was aiming
   * at, and it has to be told apart from "the broker will not let me cancel" without unwinding a stack.
   */
  async function cancelOrder({ token, accountId, orderId } = {}) {
    const id = String(orderId ?? '').trim();
    if (!id) throw new Error('A broker order id is required to cancel an order.');
    const { connection } = await getConnection(token, accountId);
    try {
      return { result: await connection.cancelOrder(id), error: null };
    } catch (error) {
      return { result: null, error };
    }
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

  /**
   * Closes part of an open position. MetaAPI's `closePositionPartially(positionId, volume, options)`
   * takes a volume, not a percentage, so the caller decides how much of the trade leaves the account -
   * which is why the engine aligns it onto the symbol's lot step before ever getting here.
   */
  async function closePositionPartially({ token, accountId, positionId, volume, clientId }) {
    const id = String(positionId ?? '').trim();
    if (!id) throw new Error('A broker position id is required to close part of a position.');
    const lots = Number(volume);
    if (!Number.isFinite(lots) || lots <= 0) throw new Error('A positive volume is required to close part of a position.');
    const { connection } = await getConnection(token, accountId);
    // A partial close is retried by the plan sweep just like an entry is, so it earns the same rule.
    return connection.closePositionPartially(id, lots, { comment: CLIENT_ID_COMMENT, clientId: assertClientId(clientId) });
  }

  /**
   * "Is an order with this client id already on the account?" - the question a retry may not skip. MetaAPI
   * puts the id in the order comment and keeps it on the resulting position, pending order and deal, so a
   * second submission of the same intent can be *found* even though it cannot be refused for us. Live
   * positions and pending orders answer first, because that is where an order accepted a moment ago is;
   * the day's deals are searched as well so a position opened and closed inside the retry window is still
   * found. A missing history store is not an error here: it narrows the search, it does not clear it.
   */
  async function findOrderByClientId({ token, accountId, clientId, fromTime } = {}) {
    const id = assertClientId(clientId);
    const { connection } = await getConnection(token, accountId);
    const terminal = connection.terminalState;
    if (!Array.isArray(terminal?.positions) || !Array.isArray(terminal?.orders)) {
      throw new Error('MetaAPI account positions or pending orders are not synchronized.');
    }
    const matches = (candidate) => String(candidate?.clientId || '') === id;
    const position = terminal.positions.find(matches);
    if (position) {
      return { where: 'position', symbol: position.symbol || null, positionId: position.positionId ?? position.id ?? null, orderId: position.orderId ?? null, position };
    }
    const pending = terminal.orders.find(matches);
    if (pending) {
      return { where: 'order', symbol: pending.symbol || null, positionId: pending.positionId ?? null, orderId: pending.id ?? pending.orderId ?? null, position: pending };
    }
    const history = connection.historyStorage;
    if (history && history.dealSynchronizationFinished === true && typeof history.dealsByTimeRange === 'function') {
      const start = fromTime || new Date(new Date(now()).setUTCHours(0, 0, 0, 0));
      const deals = history.dealsByTimeRange(new Date(start), new Date(now()));
      const deal = (Array.isArray(deals) ? deals : []).find(matches);
      if (deal) {
        return { where: 'deal', symbol: deal.symbol || null, positionId: deal.positionId ?? null, orderId: deal.orderId ?? null, position: deal };
      }
    }
    return null;
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

  return { getAccountState, createMarketOrder, createPendingOrder, cancelOrder, modifyPosition, closePositionPartially, findOrderByClientId, close };
}
