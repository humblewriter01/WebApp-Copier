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

function findSymbol(text) {
  const explicit = /\b(?:SYMBOL|PAIR|INSTRUMENT)\s*[:=@-]?\s*([A-Z0-9][A-Z0-9./_-]{1,19})/i.exec(text);
  if (explicit) {
    const symbol = normalizeSymbol(explicit[1]);
    return STOP_WORDS.has(symbol) ? { symbol: null, error: 'The message does not contain a valid trading symbol.' } : { symbol, error: null };
  }

  const tickerPattern = /\b(?:[A-Z]{3}\/?[A-Z]{3}|[A-Z]{2,10}USDT|[A-Z]{2,8}\d{1,5})(?:[._-][A-Z0-9]{1,8})?\b/gi;
  const candidates = [...text.toUpperCase().matchAll(tickerPattern)]
    .map((match) => normalizeSymbol(match[0]))
    .filter((symbol) => symbol && !STOP_WORDS.has(symbol));
  const unique = [...new Set(candidates)];
  if (unique.length === 1) return { symbol: unique[0], error: null };
  if (unique.length > 1) return { symbol: null, error: 'More than one possible trading symbol was found.' };
  return { symbol: null, error: 'No supported trading symbol was found.' };
}

function findMarkedValues(text, labelPattern) {
  const regex = new RegExp(`\\b(?:${labelPattern})\\b\\s*[:=@]?\\s*${NUMBER}`, 'gi');
  return [...text.matchAll(regex)].map((match) => {
    const tail = text.slice(match.index + match[0].length);
    return { value: parseNumber(match[1]), match, range: /^\s*(?:-|–|—|TO|\.\.)\s*(?:\d|\.)/i.test(tail) };
  });
}

function parseEntry(text) {
  const regex = new RegExp(`\\b(?:ENTRY(?:\\s+PRICE)?|PRICE|AT)\\b\\s*[:=@-]?\\s*${NUMBER}(?:\\s*(?:-|TO)\\s*${NUMBER})?`, 'gi');
  const matches = [...text.matchAll(regex)];
  if (!matches.length) return { value: null, error: null };
  if (matches.length > 1) return { value: null, error: 'More than one entry price was found.' };
  if (matches[0][2] !== undefined || /(?:-|–|—|\.\.)/.test(matches[0][0].replace(matches[0][1], ''))) return { value: null, error: 'Entry price is a range; this signal was saved but not auto-traded.' };
  const value = parseNumber(matches[0][1]);
  return value ? { value, error: null } : { value: null, error: 'The entry price is not a valid price.' };
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
  const stopLoss = stopMatches.length === 1 ? stopMatches[0].value : null;
  const takeProfit = takeProfitMatches.length === 1 ? takeProfitMatches[0].value : null;

  /* A target above the entry can only be reached by buying; a target below it only by selling. That is
     arithmetic, not a guess, so the direction is filled in for reading - but it stays out of the
     execution path, because a published signal that never says BUY or SELL is not an instruction to
     spend money, and a channel that renames "LONG" as something else should be reviewed, not traded. */
  let directionInferred = false;
  if (!side && !ambiguousSideError && entry.value !== null && takeProfit !== null && takeProfit !== entry.value) {
    side = takeProfit > entry.value ? 'buy' : 'sell';
    directionInferred = true;
  }

  const blockers = [];
  const block = (code, message) => { if (message) blockers.push({ code, message }); };
  // The order is the old precedence, kept on purpose: direction, then symbol, then entry. Which reason
  // a panel quotes first is a sentence users have learned to read, and `parseError` is the first one.
  block('direction-ambiguous', ambiguousSideError);
  block('direction-missing', side === null ? missingSideError : null);
  block('symbol', symbolError);
  block('entry', entry.error);
  if (stopMatches.length === 0) block('stop-loss-missing', 'A stop loss is required for automatic execution.');
  if (stopMatches.length > 1) block('stop-loss-multiple', 'More than one stop loss was found.');
  if (takeProfitMatches.length > 1) block('take-profit-multiple', 'Multiple take-profit targets are not supported for automatic execution.');
  if (stopMatches.some((match) => match.range)) block('stop-loss-range', 'Stop-loss ranges are not supported for automatic execution.');
  if (takeProfitMatches.some((match) => match.range)) block('take-profit-range', 'Take-profit ranges are not supported for automatic execution.');
  if (!blockers.some((item) => item.code.startsWith('stop-loss')) && !stopLoss) block('stop-loss-invalid', 'The stop loss is not a valid price.');
  if (takeProfitMatches.length === 1 && !takeProfit) block('take-profit-invalid', 'The take-profit price is not a valid price.');
  if (directionInferred) block('direction-inferred', 'The trade direction was inferred from the entry and target prices, so this signal is saved for review rather than traded.');

  const parseError = blockers[0]?.message ?? null;
  const hasTradingData = Boolean(symbol || side || entry.value !== null || stopLoss !== null || takeProfit !== null);

  return {
    symbol,
    side,
    entryPrice: entry.value,
    stopLoss,
    takeProfit,
    executionReady: !parseError,
    parseError,
    directionInferred,
    hasTradingData,
    missing: { entryPrice: entry.value === null, stopLoss: stopLoss === null, takeProfit: takeProfit === null },
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
