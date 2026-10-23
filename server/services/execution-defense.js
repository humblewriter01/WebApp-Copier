/**
 * Defense-in-depth between "a signal was captured" and "an order reaches the broker".
 *
 * The engine's own gates (Auto-Trading on, plan paid, signal fresh, account deployed, legs on the right
 * side of the spread) decide *whether this signal may be traded*. The guards here decide whether trading
 * it *right now* is safe, in three layers, from the cheapest to the most expensive:
 *
 *  1. `guardQuote` - is the price this order would be sized and filled from actually current, and is the
 *     link that delivered it alive? A 20-second-old quote on a fast market is not a price, it is a
 *     rumour, and a market order sent against it fills somewhere else. Slippage is prevented by not
 *     trading, never by hoping the market holds still.
 *  2. `guardExposure` - does the account have room for one more position, and has the day's loss cap
 *     already been reached? Both read the *live* terminal state rather than the app's own bookkeeping,
 *     because a position the user opened on their phone is a position this service must see.
 *  3. `classifyBrokerFailure` - once a refusal or an exception is in hand, what does it actually prove?
 *     The distinction that matters is not how angry the message looks but whether the request can be
 *     shown *never to have reached* the trading server. Only that class of failure may be retried.
 *
 * Nothing in this file touches the database, the clock source, or the broker: every function is a pure
 * decision over values the engine already holds, so each layer can be tested with a mocked adapter and
 * the numbers a real MetaAPI account produces. Error messages come out in the words the workspace reads,
 * because a guard the user cannot understand is a guard they cannot act on.
 */

import crypto from 'node:crypto';

/* ---------------------------------------------------------------------------------------------
 * layer 1 - stale quotes
 * ------------------------------------------------------------------------------------------- */

/**
 * How old a quote may be and still be treated as the current market.
 *
 * Two seconds is not a rounded guess: it is roughly one quote interval on a busy metal or index feed and
 * several times longer than this service takes to go from "price read" to "order sent", so a price older
 * than this has been overtaken by the market at least once. The adapter keeps a deliberately looser
 * 15-second tolerance for *protection* work (moving a stop on an already open position is worth doing on
 * a slightly aged price, because the alternative is leaving the position naked); opening a NEW position is
 * the one case where acting late costs money rather than saving it. That is why the tight bound lives
 * here, in the order path, and not inside the connection.
 */
export const MAX_QUOTE_AGE_MS = 2_000;

export const STALE_QUOTE_MESSAGE = 'Execution skipped: price quote is stale to prevent slippage.';
export const STALE_CONNECTION_MESSAGE = 'Execution skipped: the broker connection is stale, so the latest quote could not be trusted.';

/**
 * Age of a quote in milliseconds, from the timestamp MetaAPI stamped on it. `null` means the quote carries
 * no usable time at all - which is deliberately not the same as "0 ms old", because assuming a missing
 * timestamp means a fresh price is exactly how a silent feed becomes a live order.
 */
export function quoteAgeMs(price, now = Date.now()) {
  const at = Date.parse(String(price?.time || ''));
  if (!Number.isFinite(at) || !Number.isFinite(Number(now))) return null;
  return Number(now) - at;
}

/**
 * A quote is usable when it is recent in both directions. The past half is the slippage rule; the future
 * half is clock skew, and a broker terminal running ahead of us by minutes would make every quote look
 * fresh forever, so a symmetric window is the only version that cannot be fooled.
 */
function quoteIsFresh(price, now = Date.now(), maxAgeMs = MAX_QUOTE_AGE_MS) {
  const age = quoteAgeMs(price, now);
  const limit = Number(maxAgeMs);
  if (age === null || !Number.isFinite(limit) || limit <= 0) return { fresh: false, age };
  return { fresh: Math.abs(age) <= limit, age };
}

/**
 * The quote and the link it arrived on, checked together.
 *
 * `link` is what the account snapshot says about the connection itself
 * (`{ connectedToBroker, synchronized }`). Only a clear `false` is a verdict of "stale": a snapshot that
 * says nothing keeps trading, exactly as it did before this guard existed, because a missing field is a
 * gap in what we can see and not evidence of a broken feed.
 */
export function guardQuote({ price, link = null, now = Date.now(), maxAgeMs = MAX_QUOTE_AGE_MS } = {}) {
  if (link && (link.connectedToBroker === false || link.synchronized === false)) {
    return { ok: false, kind: 'stale-connection', message: STALE_CONNECTION_MESSAGE };
  }
  const bid = Number(price?.bid);
  const ask = Number(price?.ask);
  if (!Number.isFinite(bid) || bid <= 0 || !Number.isFinite(ask) || ask <= 0) {
    return { ok: false, kind: 'no-quote', message: 'MetaAPI did not provide a valid market quote.' };
  }
  const freshness = quoteIsFresh(price, now, maxAgeMs);
  if (!freshness.fresh) return { ok: false, kind: 'stale-quote', message: STALE_QUOTE_MESSAGE, ageMs: freshness.age };
  return { ok: true, ageMs: freshness.age };
}

/* ---------------------------------------------------------------------------------------------
 * layer 2 - pre-trade risk and exposure caps
 * ------------------------------------------------------------------------------------------- */

export const MAX_OPEN_POSITIONS_MESSAGE = 'Execution skipped: Max open positions reached.';
export const DAILY_LOSS_LIMIT_MESSAGE = 'Execution skipped: Daily loss limit reached.';
export const MAX_DAILY_TRADES_MESSAGE = 'Execution skipped: Maximum daily trades reached.';

/**
 * How much of the day's starting equity has gone, as a percentage. `null` means the comparison cannot be
 * made (no baseline, a zero or negative baseline, a non-numeric equity) rather than "no loss", so a caller
 * that treats `null` as 0 % would be trading through a missing safety measurement.
 */
export function dailyLossPercent({ baselineEquity, equity } = {}) {
  const baseline = Number(baselineEquity);
  const current = Number(equity);
  if (!Number.isFinite(baseline) || baseline <= 0 || !Number.isFinite(current)) return null;
  return Math.max(0, ((baseline - current) / baseline) * 100);
}

/**
 * The two caps a workspace sets for itself, answered in one place before anything reaches the broker.
 *
 * Both are `>=`, not `>`: `Max open positions: 3` means three is the most the account may hold, so a
 * signal that would make a fourth is skipped rather than executed and then described as an overage. The
 * daily loss limit works the same way on the day's drawdown. Values that are not numbers are treated as
 * "no verdict from this cap", because both settings are bounded to real numbers by the settings route
 * (`1..50` and `0.1..100`) and a guard that invented its own limit would be a rule nobody chose.
 */
export function guardExposure({ openTrades, maxOpenPositions, dailyTrades, maxDailyTrades, equity, baselineEquity, dailyLossLimit } = {}) {
  const cap = Number(maxOpenPositions);
  const held = Number(openTrades);
  if (Number.isFinite(cap) && Number.isFinite(held) && held >= cap) {
    return { ok: false, kind: 'max-open-positions', message: MAX_OPEN_POSITIONS_MESSAGE, openTrades: held, limit: cap };
  }
  const loss = dailyLossPercent({ baselineEquity, equity });
  const limit = Number(dailyLossLimit);
  if (loss !== null && Number.isFinite(limit) && loss >= limit) {
    return { ok: false, kind: 'daily-loss-limit', message: DAILY_LOSS_LIMIT_MESSAGE, lossPercent: loss, limit };
  }
  const tradeCap = Number(maxDailyTrades);
  const traded = Number(dailyTrades);
  if (Number.isFinite(tradeCap) && Number.isFinite(traded) && traded >= tradeCap) {
    return { ok: false, kind: 'max-daily-trades', message: MAX_DAILY_TRADES_MESSAGE, dailyTrades: traded, limit: tradeCap };
  }
  return { ok: true, lossPercent: loss };
}

/* ---------------------------------------------------------------------------------------------
 * layer 3 - what a broker failure proves
 *
 * Every code below is from MetaAPI's own model documentation
 * (https://metaapi.cloud/docs/client/models/metatraderTradeResponse/) and the SDK's error classes
 * (lib/clients/metaApi/{tradeError,notConnectedError,notSynchronizedError}, lib/clients/timeoutError).
 * The table is built around one question: can the request be *shown* not to have reached the trading
 * server? MetaAPI documents -10 as "the trade was never delivered to the trading server, thus it has
 * failed for sure" and -11 as "the result of the trade is not known". Those two sentences are the whole
 * safety case for retrying, so a code that cannot be placed in either class is never retried.
 * ------------------------------------------------------------------------------------------- */

/** Codes whose own documentation says nothing was delivered. Retrying them duplicates nothing. */
const NEVER_DELIVERED_NUMERIC = new Set([-10, -5, -6]);
const NEVER_DELIVERED_TEXT = /DISCONNECTED_BEFORE_TRADE|NOT_SYNCHRONIZED|NO_QUOTES|NOT_CONNECTED|NOT_STARTED|SYNCHRONIZATION|RETCODE_CONNECTION/i;

/** Codes whose own documentation says the outcome is unknowable from the response. A human reconciles these. */
const UNKNOWN_DELIVERY_NUMERIC = new Set([-11, -7, 10012, 10028]);
const UNKNOWN_DELIVERY_TEXT = /DISCONNECTED_DURING_TRADE|TRADE_TIMED_OUT|RETCODE_TIMEOUT|RETCODE_LOCKED|TIMED?\s?OUT|SOCKET HANG|ECONNRESET|ECONNREFUSED|EAI_AGAIN|EAI_FAIL|ETIMEDOUT|NETWORK|FETCH FAILED|ABORTED|CONNECTION (?:CLOSED|RESET|LOSS)/i;

/** Broker refusals that a later request can plausibly clear, given the broker answered and opened nothing. */
const TRANSIENT_ANSWER_TEXT = /REQUOTE|PRICE_CHANGED|PRICE_OFF|TOO_MANY_REQUESTS|MARKET_CLOSED|INVALID_STOPS|INVALID_PRICE|ORDER_CHANGED/i;

/**
 * Account-level permanent failures: the same request will fail forever until a person changes something
 * outside this signal, so the workspace is told on the account itself and the queue stops touching it.
 * Each note is one sentence the user can act on, in the panel that already lists their trading accounts.
 */
const ACCOUNT_FAULTS = [
  {
    key: 'credentials',
    test: /E_AUTH|UNAUTHORIZED|NOT AUTHORIZED|FORBIDDEN|INVALID (?:API )?TOKEN|TOKEN (?:EXPIRED|REVOKED|INVALID)|BAD TOKEN|SIGNATURE|LOGIN AND PASSWORD|INVALID CREDENTIALS|PERMISSION_DENIED|NO_PERMISSION/i,
    note: 'Broker connection failed. Please check your credentials.',
  },
  {
    key: 'investor-password',
    test: /ERR_INVESTOR|INVESTOR PASSWORD|READ-ONLY/i,
    note: 'This broker account is linked with an investor (read-only) password, so it cannot place orders. Re-link it with the trader password.',
  },
  {
    key: 'server-not-supported',
    test: /E_SERVER_NOT_SUPPORTED|E_SRV_NOT_FOUND|SERVER (?:FILE )?NOT (?:FOUND|SUPPORTED)|PROVISIONING/i,
    note: 'MetaAPI cannot serve this broker server, so this account cannot trade. Contact your broker or choose another server.',
  },
  {
    key: 'autotrading-disabled',
    test: /SERVER_DISABLES_AT|CLIENT_DISABLES_AT|AUTOTRADING DISABLED|TRADE_DISABLED|TRADING DISABLED/i,
    note: 'Your broker account currently refuses orders (auto-trading disabled). Enable trading in your broker or MetaAPI account settings.',
  },
  {
    key: 'account-unusable',
    test: /INVALID_ACCOUNT|ACCOUNT (?:NOT FOUND|DISABLED|BLOCKED)|TRADE_RETCODE_INVALID_ACCOUNT/i,
    note: 'Your broker account is not usable for orders as it stands. Check its status with your broker before trading again.',
  },
];

/** The MetaAPI error names, kept explicit so a stack-less rejection is still recognised by `name`. */
const PRE_SUBMIT_ERROR_NAMES = new Set(['NotConnectedError', 'NotSynchronizedError', 'TimeoutError', 'AbortError']);
/** Provisioning/validation codes MetaAPI reports on `err.details` (or `err.details.code`). */
const PROVISIONING_CODE_TEXT = /E_AUTH|E_SRV_NOT_FOUND|E_SERVER_NOT_SUPPORTED|E_SERVER_TIMEZONE|E_RESOURCE_SLOTS|E_NO_SYMBOLS|E_ACCOUNT_DISABLED|E_PASSWORD_CHANGE/i;

/**
 * The three shapes a MetaAPI failure arrives in, read at once:
 *  - a `MetatraderTradeResponse`-shaped answer (`{ numericCode, stringCode, message }`);
 *  - a `TradeError` thrown by the SDK, which carries the same two codes (`@throws {TradeError} on trade
 *    error, check error properties for error code details` is how every order method documents itself),
 *    so *this* is the common case for a broker refusal, not the returned object;
 *  - an `ApiError`/provisioning error, which carries an HTTP `status` and a code on `code`/`details`
 *    (`E_AUTH`, `E_SRV_NOT_FOUND`, ...).
 * A plain `Error`'s `name` is deliberately not treated as a code: `ERROR` would otherwise look like a
 * broker answer, and an error with no code is the case where the app knows the least.
 */
function codesOf(source) {
  const numericRaw = source?.numericCode;
  const numeric = Number.isFinite(Number(numericRaw)) ? Number(numericRaw) : null;
  const details = typeof source?.details === 'string' ? source.details : String(source?.details?.code || '');
  const codes = [source?.stringCode, source?.code, details, source?.error]
    .map((value) => String(value || '').toUpperCase().replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const statusRaw = Number(source?.status);
  return {
    numeric,
    code: codes[0] || null,
    haystack: codes.join(' '),
    name: String(source?.name || ''),
    message: String(source?.message || source?.description || source?.comment || ''),
    status: Number.isFinite(statusRaw) ? statusRaw : null,
  };
}

/**
 * A return code means a *server* answered, whatever the transport around it looked like: MetaAPI throws
 * `TradeError` for a refusal, and it is still a refusal with a code that says what happened. This test is
 * what separates "the broker said no" from "we never found out".
 */
function hasReturnCode({ numeric, haystack }) {
  if (numeric !== null) return true;
  return /TRADE_RETCODE_|ERR_[A-Z_]+|E_[A-Z_]+/.test(haystack);
}

function accountFaultNote(haystack) {
  for (const fault of ACCOUNT_FAULTS) if (fault.test.test(haystack)) return { key: fault.key, note: fault.note };
  return null;
}

/**
 * Classify one broker failure.
 *
 * @param input.result     a `MetatraderTradeResponse`-shaped answer the broker returned
 * @param input.error      an exception thrown while preparing or sending the request
 * @param input.submitted  whether the order had already been handed to the broker when it failed
 *
 * `delivered` is the load-bearing answer: `'answered'` (a server replied, and a failing code means it
 * opened nothing), `'no'` (proved never delivered), `'unknown'` (the request may have become an order).
 * `retriable` follows from it mechanically - transient *and* delivery established. A transient failure
 * whose delivery is unknown is never retried: an automatic second market order on top of a filled first
 * one is a bigger loss than a missed signal, and no amount of backoff makes that safe.
 *
 * Ordered from what is known for certain to what is inferred: an account-level fault (a retry cannot fix
 * credentials), then the codes whose own documentation settles delivery, then the code-vs-no-code split,
 * and only then the fallback for an error with nothing to go on.
 */
export function classifyBrokerFailure({ result = null, error = null, submitted = false } = {}) {
  const source = error || result || {};
  const { numeric, code, haystack, name, message, status } = codesOf(source);
  const rawMessage = message || String(error?.message || '') || 'The broker refused the order.';
  // The message is searched alongside the codes, because MetaAPI copies the MT5 text verbatim and a
  // broker that renames a code still says the same sentence.
  const search = `${haystack} ${rawMessage}`;
  const outcome = (patch) => ({
    kind: 'permanent',
    delivered: 'unknown',
    accountFault: false,
    faultKey: null,
    note: null,
    retriable: false,
    code: code ?? (numeric !== null ? String(numeric) : null),
    message: rawMessage,
    ...patch,
  });

  const fault = accountFaultNote(`${search} ${name}`);
  if (fault) return outcome({ kind: 'permanent', delivered: submitted ? 'unknown' : 'no', accountFault: true, faultKey: fault.key, note: fault.note });
  if (status === 401 || status === 403) {
    return outcome({ kind: 'permanent', delivered: 'no', accountFault: true, faultKey: 'credentials', note: ACCOUNT_FAULTS[0].note, code: String(status) });
  }
  if (PROVISIONING_CODE_TEXT.test(search)) {
    const provisioning = accountFaultNote(search) || ACCOUNT_FAULTS[0];
    return outcome({ kind: 'permanent', delivered: 'no', accountFault: true, faultKey: provisioning.key, note: provisioning.note });
  }

  // MetaAPI documents these two families in the codes themselves, so they outrank everything below:
  // -11/-7/10012/10028 mean the outcome cannot be established, and -10/-5/-6 mean the request never got
  // to the trading server at all.
  if (UNKNOWN_DELIVERY_NUMERIC.has(numeric) || UNKNOWN_DELIVERY_TEXT.test(search)) {
    return outcome({ kind: 'ambiguous', delivered: 'unknown' });
  }
  if (NEVER_DELIVERED_NUMERIC.has(numeric) || NEVER_DELIVERED_TEXT.test(search)) {
    return outcome({ kind: 'transient', delivered: 'no', retriable: true });
  }

  if (hasReturnCode({ numeric, haystack })) return outcome({
    kind: TRANSIENT_ANSWER_TEXT.test(search) ? 'transient' : 'permanent',
    delivered: 'answered',
    retriable: TRANSIENT_ANSWER_TEXT.test(search),
  });

  if (error) {
    // No code at all. Before submission the order never left this process, so a retry is safe no matter
    // how the sentence reads; after submission it is the one case nobody may guess about.
    if (!submitted) {
      return outcome({ kind: 'transient', delivered: 'no', retriable: true, code: PRE_SUBMIT_ERROR_NAMES.has(name) ? name : code });
    }
    return outcome({ kind: 'ambiguous', delivered: 'unknown' });
  }

  return outcome({ kind: 'permanent', delivered: 'answered' });
}

/* ---------------------------------------------------------------------------------------------
 * retries and duplicate protection
 * ------------------------------------------------------------------------------------------- */

/**
 * Attempts a job may have at the broker in total, the first one included. Three is enough to ride out a
 * requote, a `TOO_MANY_REQUESTS` and one further blip, and small enough that a stuck signal cannot spend
 * the queue's attention: the whole budget fits inside the signal's own two-minute life, which is the
 * real limit - a signal that outlives it is expired rather than executed late.
 */
export const MAX_ORDER_ATTEMPTS = 3;
export const RETRY_BASE_DELAY_MS = 1_500;
export const RETRY_MAX_DELAY_MS = 15_000;

/**
 * Exponential backoff with no randomness: `base * 2^(attempt-1)`, capped.
 *
 * Deterministic on purpose. A jittered delay would be better engineering for a thousand workers hammering
 * one broker and worse testing for the one worker this service runs, and a retry whose timing can be
 * asserted is a retry whose timing can be trusted.
 */
export function retryDelayMs({ attempt, baseMs = RETRY_BASE_DELAY_MS, maxMs = RETRY_MAX_DELAY_MS, factor = 2 } = {}) {
  const n = Number(attempt);
  if (!Number.isFinite(n) || n < 1) return null;
  const growth = Number.isFinite(Number(baseMs)) && Number(baseMs) > 0 ? Number(baseMs) : RETRY_BASE_DELAY_MS;
  const ceiling = Number.isFinite(Number(maxMs)) && Number(maxMs) > 0 ? Number(maxMs) : RETRY_MAX_DELAY_MS;
  const scale = Number.isFinite(Number(factor)) && Number(factor) > 1 ? Number(factor) : 2;
  return Math.min(ceiling, Math.round(growth * scale ** (Math.floor(n) - 1)));
}

/** Whether this job still has an attempt left, given `attempt_count` as the claim wrote it. */
export function canRetry({ attempt, maxAttempts = MAX_ORDER_ATTEMPTS, retriable = false }) {
  if (retriable !== true) return false;
  const used = Number(attempt);
  const max = Number(maxAttempts);
  if (!Number.isFinite(used) || used < 1) return false;
  return used < (Number.isFinite(max) && max > 0 ? max : MAX_ORDER_ATTEMPTS);
}

/* ---------------------------------------------------------------------------------------------
 * client id
 *
 * MetaAPI stores `clientId` inside the order comment, so the two together have a length budget: the
 * websocket trade API and the model documentation both state "the sum of the line lengths of the comment
 * and the clientId must be less than or equal to 26", and the tracking-trades page says 30 when a comment
 * is present. The app obeys the stricter number so the id is safe under either reading.
 *
 * The same page gives the id a shape - `${strategyId}_${positionId}_${orderId}`, example
 * `RF_EURUSD_GjCy5lk` - and MetaAPI's own SDK tests send `TE_GBPUSD_7hyINWqAlE`. `buildClientId` follows
 * it: strategy `SD`, the symbol in the middle, a hash of the durable job id at the end.
 *
 * What the id buys is *identification*, not deduplication: MetaAPI publishes no rule that it rejects a
 * repeated clientId, and a comment field cannot be a unique constraint. So a duplicate is prevented here
 * (one trade row per job, enforced by a unique index) and *detected* here (before a retry, the app looks
 * for an existing position, order or deal carrying the id, and reconciles instead of re-sending). The id
 * is deliberately stable for the life of a job, which is what makes that lookup able to find anything.
 * ------------------------------------------------------------------------------------------- */

export const CLIENT_ID_COMMENT = 'SD';
/**
 * One character of slack under the strictest published budget: `SD` + 23 = 25 of 26. Some MetaAPI
 * servers join the two fields with a separator before storing them, and an id that is rejected only on
 * the user's broker is the worst kind of bug to find.
 */
export const CLIENT_ID_MAX_LENGTH = 23;
const CLIENT_ID_STRATEGY = 'SD';
const CLIENT_ID_SYMBOL_MAX = 10;
const CLIENT_ID_HASH_MIN = 8;

function normalizeSymbolPart(symbol) {
  const cleaned = String(symbol || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return cleaned.slice(0, CLIENT_ID_SYMBOL_MAX) || 'NA';
}

/**
 * The total order-comment budget: `comment` + `clientId`, as MetaAPI stores them in one field.
 */
export function clientIdFits({ clientId, comment = CLIENT_ID_COMMENT } = {}) {
  const id = String(clientId || '');
  const note = String(comment || '');
  if (!id) return { ok: false, reason: 'A client id is required for every order sent to the broker.' };
  if (/[\s\u0000-\u001f]/.test(id)) return { ok: false, reason: 'A client id cannot contain spaces or control characters.' };
  // MetaAPI's rule is a sum of the two line lengths, so the separator between them is not counted here;
  // the slack lives in CLIENT_ID_MAX_LENGTH instead, where a test can see it.
  const total = id.length + note.length;
  if (total > 26) {
    return { ok: false, reason: `The comment and client id together must stay within 26 characters (MetaAPI stores them in one field); got ${total}.` };
  }
  return { ok: true, total };
}

export function buildClientId({ jobId, symbol = null } = {}) {
  const seed = String(jobId || '');
  if (!seed) throw new Error('A durable job id is required to build a broker client id.');
  const digest = crypto.createHash('sha256').update(seed).digest('hex');
  const prefix = `${CLIENT_ID_STRATEGY}_${normalizeSymbolPart(symbol)}_`;
  // The id part is what makes two different jobs produce two different ids, so it never yields to the
  // symbol: a broker with a 20-character symbol name gets its symbol shortened, not the hash. With the
  // symbol capped at 10 the prefix is at most 14 characters, so the tail is always at least 9 of them and
  // the whole id always fits; `clientIdFits` below is what turns that arithmetic into a loud failure
  // instead of a quiet one if the constants above ever stop agreeing with each other.
  const clientId = `${prefix}${digest.slice(0, CLIENT_ID_MAX_LENGTH - prefix.length)}`;
  const fit = clientIdFits({ clientId, comment: CLIENT_ID_COMMENT });
  if (!fit.ok) throw new Error(`The broker client id could not be built within MetaAPI's comment budget: ${fit.reason}`);
  return clientId;
}
