const NUMBER = '(\\d+(?:\\.\\d+)?|\\.\\d+)';
const DIRECTION_WORDS = /\b(BUY|SELL|LONG|SHORT)\b/gi;
const STOP_WORDS = new Set([
  'BUY', 'SELL', 'LONG', 'SHORT', 'TAKE', 'PROFIT', 'TARGET', 'STOP', 'LOSS', 'STOPLOSS',
  'ENTRY', 'PRICE', 'AT', 'MARKET', 'LIMIT', 'ORDER', 'SIGNAL', 'SIGNALS', 'TRADE', 'TRADES',
  'OPEN', 'CLOSE', 'SL', 'TP', 'TP1', 'TP2', 'TP3', 'TP4', 'NOW', 'BUYING', 'SELLING',
]);

function parseNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function normalizeSymbol(value) {
  return String(value || '').trim().toUpperCase().replaceAll('/', '').replace(/^[._-]+|[._-]+$/g, '');
}

/**
 * The asset names channels write instead of a ticker, and the symbol each one means.
 *
 * A gold signal says "GOLD", "XAUUSD", "XAUUSDm" or "GOLD#" depending on the broker, and a message
 * that names its product in words used to be refused as "no supported trading symbol" - the
 * instruction was complete, the reader was blind. Each entry below is a *canonical* symbol: the
 * account's own instrument list still has the final say in `resolveBrokerSymbol`, and an alias that
 * no deployed account carries is refused with that sentence rather than traded on a guess. Only
 * names with one widely accepted meaning belong here - "OIL" does not, because it is a different
 * product on different platforms, while "BRENT CRUDE" and "WTI" are not.
 */
export const SYMBOL_ALIASES = Object.freeze({
  GOLD: 'XAUUSD', XAU: 'XAUUSD', 'GOLD SPOT': 'XAUUSD',
  SILVER: 'XAGUSD', XAG: 'XAGUSD',
  PLATINUM: 'XPTUSD', PALLADIUM: 'XPDUSD',
  'BRENT CRUDE': 'UKOIL', BRENT: 'UKOIL', 'WTI CRUDE': 'USOIL', WTI: 'USOIL',
  BITCOIN: 'BTCUSD', BTC: 'BTCUSD', XBT: 'BTCUSD',
  ETHEREUM: 'ETHUSD', ETH: 'ETHUSD',
  'S&P 500': 'US500', SPX500: 'US500', SPX: 'US500', US500: 'US500', 'S&P500': 'US500',
  NASDAQ: 'NAS100', 'NASDAQ 100': 'NAS100', NAS100: 'NAS100', US100: 'NAS100', NDX: 'NAS100',
  DOW: 'US30', 'DOW JONES': 'US30', US30: 'US30', 'US30 CASH': 'US30', DJIA: 'US30',
  DAX: 'GER40', 'DAX 40': 'GER40', GER40: 'GER40', GDAXI: 'GER40',
  FTSE: 'UK100', 'FTSE 100': 'UK100', UK100: 'UK100',
  'NIKKEI 225': 'JP225', NIKKEI: 'JP225', JP225: 'JP225', NKY: 'JP225',
  EUROSTOXX: 'EU50E', 'EURO STOXX 50': 'EU50E', EU50: 'EU50E',
});

/** ISO-4217 codes plus the crypto bases that share their two-letter-plus-USD shape. */
const ASSET_CODES = new Set([
  'USD', 'EUR', 'JPY', 'GBP', 'CHF', 'AUD', 'NZD', 'CAD', 'CNY', 'HKD', 'SGD', 'SEK', 'NOK', 'DKK',
  'PLN', 'CZK', 'HUF', 'RUB', 'TRY', 'ZAR', 'MXN', 'BRL', 'ARS', 'CLP', 'COP', 'PEN', 'INR', 'IDR',
  'MYR', 'THB', 'PHP', 'VND', 'KRW', 'TWD', 'AED', 'SAR', 'QAR', 'OMR', 'BHD', 'KWD', 'EGY', 'NGN',
  'GHS', 'KES', 'MAD', 'TND', 'ILS', 'PKR', 'BDT', 'LKR', 'NPR', 'UAH', 'KZT', 'UZS', 'GEL', 'AMD',
  'AZN', 'BYN', 'MDL', 'GEL', 'XAU', 'XAG', 'XPT', 'XPD', 'XDR',
  'BTC', 'ETH', 'SOL', 'XRP', 'ADA', 'DOGE', 'LTC', 'DOT', 'AVAX', 'TRX', 'BNB', 'XLM', 'LINK',
  'ETC', 'ZEC', 'XMR', 'ALGO', 'ATOM', 'FIL', 'NEAR', 'ARB', 'OP', 'SUI', 'TON', 'SHIB', 'PEPE',
]);

/**
 * Whether a pair-shaped word is an instrument or a sentence.
 *
 * `[A-Z]{3}[A-Z]{3}` also matches "PROPER" and "FUTURE", and a disclaimer line - "Use Proper Money
 * Management. Past Profits do not predict future earnings" - then produced two candidate symbols, so
 * the message that named its metal in words was refused with "more than one possible trading symbol
 * was found". A pair is only a pair when both halves are codes this market trades.
 */
function isAssetPair(candidate) {
  const compact = String(candidate || '').replace('/', '');
  if (!/^[A-Z]{3}[A-Z]{3}$/.test(compact)) return false;
  return ASSET_CODES.has(compact.slice(0, 3)) && ASSET_CODES.has(compact.slice(3));
}

/** Alias keys are matched as whole words, longest first, so "BRENT CRUDE" wins over "BRENT". */
const ALIAS_PHRASES = Object.keys(SYMBOL_ALIASES).sort((left, right) => right.length - left.length);

function findAliasSymbol(text) {
  const upper = text.toUpperCase();
  for (const phrase of ALIAS_PHRASES) {
    const pattern = new RegExp(`(?:^|[\\s(\\[]|\\*)${phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:$|[\\s)\\]]|\\*)`, 'i');
    if (pattern.test(upper)) return SYMBOL_ALIASES[phrase];
  }
  return null;
}

function findSymbol(text) {
  const explicit = /\b(?:SYMBOL|PAIR|INSTRUMENT)\s*[:=@-]?\s*([A-Z0-9][A-Z0-9./_-]{1,19})/i.exec(text);
  if (explicit) {
    const raw = normalizeSymbol(explicit[1]);
    if (STOP_WORDS.has(raw)) return { symbol: null, error: 'The message does not contain a valid trading symbol.' };
    return { symbol: SYMBOL_ALIASES[raw] || raw, error: null };
  }

  const tickerPattern = /\b(?:[A-Z]{3}\/?[A-Z]{3}|[A-Z]{2,10}USDT|[A-Z]{2,8}\d{1,5})\b/gi;
  const candidates = [...text.toUpperCase().matchAll(tickerPattern)]
    .map((match) => normalizeSymbol(match[0]))
    // A pair-shaped word is only a symbol when both of its halves are traded codes. The slash is
    // already gone by this point, so "EURUSD" and "PROPER" look identical here and are told apart by
    // the code list, not by punctuation.
    .filter((symbol) => symbol && !STOP_WORDS.has(symbol))
    .filter((symbol) => !/^[A-Z]{6}$/.test(symbol) || isAssetPair(symbol))
    .map((symbol) => SYMBOL_ALIASES[symbol] || symbol);
  const alias = findAliasSymbol(text);
  if (alias) candidates.push(alias);
  const unique = [...new Set(candidates.filter(Boolean))];
  if (unique.length === 1) return { symbol: unique[0], error: null };
  if (unique.length > 1) return { symbol: null, error: 'More than one possible trading symbol was found.' };
  return { symbol: null, error: 'No supported trading symbol was found.' };
}

/**
 * Every price a message marks with a label, and the number it actually said.
 *
 * The label is where this used to go wrong. Channels write "TP 1 : 4029.50", and a pattern that reads
 * `TP` then an optional separator then a number stopped at the *index* - the target became 1, and the
 * real price was left behind as an unlabelled number. So the label may consume a one- or two-digit
 * index when what follows it is a separator or another number ("TP 1 :", "TP 1 4029.50", "TP2: 4027.5"),
 * and a match is rejected when the number it found is itself followed by a separator, because that is
 * the shape of an index that had no price after it - "TP 3 : OPEN". Reading the index as the price was
 * how a numbered-target channel produced a take-profit of 1 point and a hundred and thirty-two broker
 * rejections.
 */
function findMarkedValues(text, labelPattern) {
  const index = '(?:\\s*\\d{1,2}(?:\\s*[:=@]|\\s+(?=[\\d.])))?';
  const regex = new RegExp(`\\b(?:${labelPattern})\\b${index}\\s*[:=@]?\\s*${NUMBER}(?!\\s*[:=@])`, 'gi');
  return [...text.matchAll(regex)].map((match) => {
    const tail = text.slice(match.index + match[0].length);
    return { value: parseNumber(match[1]), match, range: /^\s*(?:-|–|—|TO|\.\.)\s*(?:\d|\.)/i.test(tail) };
  });
}

/**
 * An entry a channel names as a price, a pair of prices, or a zone.
 *
 * "SELL NOW IN ZONE 4031.50-4138.60" is a complete instruction with an imprecise *price*, and those
 * two things used to be treated as one failure: the label list did not know the word ZONE at all, so
 * the number was simply missing from the row, and the message that named a stop, a target and a
 * direction was stored as though it had said nothing. A range is now read, and the bound it yields is
 * the least favourable price inside it - the high end for a buy, the low end for a sell - which is
 * the bound that keeps the engine's own price guard honest: a sell is only sent while the market is at
 * or above that price, a buy only at or below it, so a zone can never make the trade look better than
 * the channel described. The engine fills at the live quote either way; the entry a message states is
 * a limit on *whether* to trade, not the price anything is filled at.
 */
const RANGE_SEPARATOR = '\\s*(?:-|–|—|TO|\\.\\.)\\s*';
const ENTRY_LABEL = '(?:ENTRY\\s+ZONE|SELL\\s+ZONE|BUY\\s+ZONE|ENTRY\\s+AREA|ENTRY(?:\\s+PRICE)?|PRICE|AT|ZONE|AREA)';

function parseEntry(text) {
  const regex = new RegExp(`\\b${ENTRY_LABEL}\\s*[:=@-]?\\s*${NUMBER}(?:${RANGE_SEPARATOR}${NUMBER})?`, 'gi');
  const matches = [...text.matchAll(regex)];
  if (!matches.length) return { value: null, range: null, error: null };
  if (matches.length > 1) return { value: null, range: null, error: 'More than one entry price was found.' };
  const low = parseNumber(matches[0][1]);
  const high = parseNumber(matches[0][2]);
  if (matches[0][2] === undefined || high === null) return low ? { value: low, range: null, error: null } : { value: null, range: null, error: 'The entry price is not a valid price.' };
  const range = { low: Math.min(low, high), high: Math.max(low, high) };
  return { value: null, range, error: null };
}

/** The bound of an entry range a signal is credited with, once the direction is known. */
function entryFromRange(range, side) {
  if (!range) return null;
  if (side === 'buy') return range.high;
  if (side === 'sell') return range.low;
  return null;
}

/**
 * What a message says, separated from what Signal Desk is willing to do about it.
 *
 * `blockers` is the honest list of reasons a message will not be traded, each with a code, so a
 * policy can be applied to a *reason* instead of to the wording of a sentence. `missing` says which
 * prices the message did not carry, which is what the badges on the Signals page read: a message with
 * an entry and a target but no stop is a usable note to a trader, and calling it "no clear signal"
 * told them the parser had failed when it had actually done its job. `directionInferred` marks the one
 * judgement this function makes rather than reads - and a judged direction is never traded, only shown.
 */
export function parseSignal(message) {
  const text = String(message || '').slice(0, 5000);
  const directions = [...text.matchAll(DIRECTION_WORDS)].map((match) => ['BUY', 'LONG'].includes(match[1].toUpperCase()) ? 'buy' : 'sell');
  const uniqueDirections = [...new Set(directions)];
  let side = uniqueDirections.length === 1 ? uniqueDirections[0] : null;
  const ambiguousSideError = uniqueDirections.length > 1 ? 'More than one trade direction was found.' : null;
  const missingSideError = uniqueDirections.length === 0 ? 'A BUY or SELL direction was not found.' : null;

  const { symbol, error: symbolError } = findSymbol(text);
  const entry = parseEntry(text);
  const stopMatches = findMarkedValues(text, 'SL|STOP(?:\\s*LOSS)?');
  const takeProfitMatches = findMarkedValues(text, 'TP\\d*|TAKE\\s*PROFIT(?:\\s*\\d+)?|TARGET(?:\\s*\\d+)?');
  /* A price named twice in one message is one price, not a choice: "SL 1.28 ... (SL 1.28 is above
     entry)" restates the stop inside its own commentary, and only two *different* numbers leave nothing
     to pick. Distinct-first-seen order is what both stops and targets are judged on. */
  const distinctPrices = (matches) => [...new Set(matches.map((match) => match.value).filter((value) => value !== null))];
  const stopPrices = distinctPrices(stopMatches);
  const stopLoss = stopPrices.length === 1 ? stopPrices[0] : null;
  /* A channel that numbers its targets is describing one trade with a scale-out plan, not a
     contradictory message: the first price it names is the exit this product trades, because closing
     at TP1 is strictly earlier than the plan rather than riskier than it. The other levels are kept so
     the row can say what the message really carried. */
  const takeProfitLevels = distinctPrices(takeProfitMatches);
  const takeProfit = takeProfitLevels.length ? takeProfitLevels[0] : null;
  let entryPrice = entry.value !== null ? entry.value : entryFromRange(entry.range, side);

  /* A target above the entry can only be reached by buying; a target below it only by selling. That is
     arithmetic, not a guess, so the direction is filled in for reading - but it stays out of the
     execution path, because a published signal that never says BUY or SELL is not an instruction to
     spend money, and a channel that renames "LONG" as something else should be reviewed, not traded. */
  let directionInferred = false;
  if (!side && !ambiguousSideError && entryPrice !== null && takeProfit !== null && takeProfit !== entryPrice) {
    side = takeProfit > entryPrice ? 'buy' : 'sell';
    directionInferred = true;
    // A range that had no direction to be read against is now readable: the inferred side picks the
    // bound, and the trade stays out of the execution path because a judged direction never trades.
    if (entry.value === null && entry.range) entry.entryPriceFromRange = entryFromRange(entry.range, side);
  }

  const blockers = [];
  const block = (code, message) => { if (message) blockers.push({ code, message }); };
  // The order is the old precedence, kept on purpose: direction, then symbol, then entry. Which reason
  // a panel quotes first is a sentence users have learned to read, and `parseError` is the first one.
  block('direction-ambiguous', ambiguousSideError);
  block('direction-missing', side === null ? missingSideError : null);
  block('symbol', symbolError);
  block('entry', entry.error);
  if (entry.range && entryPrice === null) block('entry-range', 'Entry price is a range; this signal was saved but not auto-traded.');
  if (stopMatches.length === 0) block('stop-loss-missing', 'A stop loss is required for automatic execution.');
  if (stopPrices.length > 1) block('stop-loss-multiple', 'More than one stop loss was found.');
  if (stopMatches.some((match) => match.range)) block('stop-loss-range', 'Stop-loss ranges are not supported for automatic execution.');
  if (takeProfitMatches.some((match) => match.range)) block('take-profit-range', 'Take-profit ranges are not supported for automatic execution.');
  if (!blockers.some((item) => item.code.startsWith('stop-loss')) && !stopLoss) block('stop-loss-invalid', 'The stop loss is not a valid price.');
  if (takeProfitMatches.length === 1 && !takeProfit) block('take-profit-invalid', 'The take-profit price is not a valid price.');
  if (directionInferred) block('direction-inferred', 'The trade direction was inferred from the entry and target prices, so this signal is saved for review rather than traded.');

  const parseError = blockers[0]?.message ?? null;
  if (entryPrice === null && entry.entryPriceFromRange !== undefined) entryPrice = entry.entryPriceFromRange;
  const hasTradingData = Boolean(symbol || side || entryPrice !== null || stopLoss !== null || takeProfit !== null);

  return {
    symbol,
    side,
    entryPrice,
    stopLoss,
    takeProfit,
    executionReady: !parseError,
    parseError,
    directionInferred,
    hasTradingData,
    entryRange: entry.range,
    takeProfitLevels,
    missing: { entryPrice: entryPrice === null, stopLoss: stopLoss === null, takeProfit: takeProfit === null },
    blockers,
  };
}


export function resolveBrokerSymbol(signalSymbol, specifications) {
  const candidate = normalizeSymbol(signalSymbol);
  if (!candidate || !Array.isArray(specifications)) return { symbol: null, error: 'The trading symbol is unavailable on this account.' };
  const exact = specifications.find((specification) => normalizeSymbol(specification?.symbol) === candidate);
  if (exact) return { symbol: exact.symbol, specification: exact, error: null };

  const aliases = specifications.filter((specification) => {
    const normalized = normalizeSymbol(specification?.symbol);
    return normalized.startsWith(candidate) && normalized.length > candidate.length;
  });
  if (aliases.length === 1) return { symbol: aliases[0].symbol, specification: aliases[0], error: null };
  if (aliases.length > 1) return { symbol: null, error: 'More than one broker symbol matches this signal.' };
  /* The other direction, which a word-to-ticker alias makes necessary: some platforms list gold as
     "GOLD" rather than "XAUUSDm", so once the message has been normalised to a canonical symbol the
     account's own name has to be read back through the same table. Only an unambiguous one-to-one
     match counts, and the engine's own "not available" sentence still answers every other case. */
  const reverse = specifications.filter((specification) => {
    const normalized = normalizeSymbol(specification?.symbol);
    return SYMBOL_ALIASES[normalized] === candidate;
  });
  if (reverse.length === 1) return { symbol: reverse[0].symbol, specification: reverse[0], error: null };
  return { symbol: null, error: 'The signal symbol is not available on this trading account.' };
}

export function countSignalEntryDeals(deals = []) {
  const entryTypes = new Set(['DEAL_ENTRY_IN', 'DEAL_ENTRY_INOUT']);
  const exitTypes = new Set(['DEAL_ENTRY_OUT', 'DEAL_ENTRY_OUT_BY']);
  const identities = new Set();
  for (const deal of deals) {
    const type = String(deal?.type || '').toUpperCase();
    if (!type.includes('BUY') && !type.includes('SELL')) continue;
    const entryType = String(deal?.entryType || '').toUpperCase();
    if (exitTypes.has(entryType)) continue;
    if (!entryTypes.has(entryType)) throw new Error('MetaAPI trade history is missing entry/exit classification; the daily trade limit cannot be checked safely.');
    const identity = String(deal?.orderId || deal?.id || '');
    if (!identity) throw new Error('MetaAPI trade history is missing an order identifier; the daily trade limit cannot be checked safely.');
    identities.add(identity);
  }
  return identities.size;
}
