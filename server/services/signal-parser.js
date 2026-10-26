import { normalizeSignalNumbers, isPipDistance } from './signal-numbers.js';

/* After `normalizeSignalNumbers`, every price in the scanned text is a canonical dot-decimal, so the only
   shape a number can take here is one the label scanners were written for. */
/* NUMBER captures, and the group is not decoration: every scanner below reads `match[1]`, so a
   non-capturing NUMBER would leave every leg undefined and read as an invalid price. */
const NUMBER = '(\\d+(?:\\.\\d+)?)';

/**
 * Direction words, and the two that need a neighbour to mean anything.
 *
 * BUY/SELL/LONG/SHORT are unambiguous in a trading message. CALL and PUT are English words first ("do not
 * call me", "put your stop above the entry"), and a direction read out of a sentence like that is a live
 * order in the wrong market - so they count only when the word is attached to an instrument or a price,
 * which is the shape of an instruction: `CALL GOLD`, `PUT on EURUSD`, `SELL - BUY 1.0850` stays a
 * contradiction rather than a coin flip.
 */
const DIRECTION_WORDS = /\b(BUY|SELL|LONG|SHORT|BUYING|SELLING)\b/gi;
const OPTION_WORDS = /\b(CALL|PUT)\b(?:\s+(?:ON|AT))?[^\w\n]{0,3}[ \t]*(?:[A-Z]{3,10}\d{0,5}|\d)/gi;
const SELLISH = new Set(['SELL', 'SHORT', 'PUT', 'SELLING']);
const STOP_WORDS = new Set([
  'BUY', 'SELL', 'LONG', 'SHORT', 'TAKE', 'PROFIT', 'TARGET', 'STOP', 'LOSS', 'STOPLOSS',
  'ENTRY', 'PRICE', 'AT', 'MARKET', 'LIMIT', 'ORDER', 'SIGNAL', 'SIGNALS', 'TRADE', 'TRADES',
  'OPEN', 'CLOSE', 'SL', 'TP', 'TP1', 'TP2', 'TP3', 'TP4', 'NOW', 'BUYING', 'SELLING',
]);

function parseNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

/**
 * The decoration a Telegram message carries, taken out before anything is read.
 *
 * Emojis, markdown emphasis, links and @mentions are how a channel shouts, and none of them are ever a
 * trading instruction - but they sit *inside* the things that are: `**SELL GOLD:**` puts asterisks against
 * the metal, `t.me/vipchannel` hands the symbol scanner a candidate, and `🚀🚀 BUY 🚀 EURUSD` splits a
 * direction word from its pair. Stripping them is not tidying for its own sake: every one of those made a
 * complete instruction unreadable.
 *
 * Deliberately absent: anything a message's *meaning* could live in. Numbers, labels, line breaks, brackets
 * and colons stay, and prose is left alone - a disclaimer that happens to contain the word "risk" is not
 * noise to this function, and removing whole lines on a keyword would delete the stop of a signal that
 * mentioned one.
 */
const EMOJI = /[\u{1F000}-\u{1FAFF}\u{1F1E6}-\u{1F1FF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}\u{2190}-\u{21FF}]/gu;
const LINKS = /\b(?:https?:\/\/|www\.|t\.me\/|discord\.gg\/|vip\s*channel\b)[^\s|)]*/gi;
const MENTIONS = /@[A-Za-z][A-Za-z0-9_]{3,31}/g;
const EMPHASIS = /[*_~`#|]+/g;

function stripNoise(text) {
  return String(text ?? '')
    .replace(LINKS, ' ')
    .replace(MENTIONS, ' ')
    .replace(EMOJI, ' ')
    .replace(EMPHASIS, ' ')
    // A run of spaces is one space, but line breaks are kept: `findMarkedValues` reads "TP 1 : 4029.50"
    // across them, and a signal's labels are usually one per line.
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
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

/**
 * Whether a name in the message is the asset's name or part of a longer word.
 *
 * The boundary used to be "a space, a bracket, or an asterisk" on each side, which reads a name on its own
 * line perfectly and a name in a sentence not at all: `BUY NOW Gold, SL 4041.50` produced *no symbol* and
 * the message was refused as "No supported trading symbol was found" - a complete instruction, killed by a
 * comma. Channels punctuate constantly (`GOLD:`, `**SELL GOLD:**`, `#Gold`), so what is required instead is
 * simply that the name not be glued to another letter or digit. That still refuses "DOW" inside "DOWN" and
 * "ETH" inside "ETHICAL", which is the only thing the strict boundary was ever doing for us.
 */
function findAliasSymbol(text) {
  const upper = text.toUpperCase();
  for (const phrase of ALIAS_PHRASES) {
    const pattern = new RegExp(`(?<![A-Z0-9])${phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Z0-9])`, 'i');
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
 * Every price a message marks with a label, and whether it marked a *distance* instead.
 *
 * The label is where this used to go wrong. Channels write "TP 1 : 4029.50", and a pattern that reads
 * `TP` then an optional separator then a number stopped at the *index* - the target became 1, and the
 * real price was left behind as an unlabelled number. So the label may consume a one- or two-digit index
 * when what follows it is a separator or another number ("TP 1 :", "TP 1 4029.50", "TP2: 4027.5"), and a
 * match is rejected when the number it found is itself followed by a separator, because that is the shape
 * of an index that had no price after it - "TP 3 : OPEN". Reading the index as the price was how a
 * numbered-target channel produced a take-profit of 1 point and a hundred and thirty-two broker
 * rejections.
 *
 * The separator class now carries a dash and a bullet as well as `: = @`: `SL - 4011.00`, `SL • 4011`,
 * `SL → 4011` are how a message with a template and no typographic care looks, and each of them used to
 * leave the leg simply absent - which reads as "the channel forgot the stop" and hands the trade to the
 * workspace's fallback distance instead of the one the trader wrote down.
 */
/**
 * A distance written *before* its label - `30 pips SL`, `50 pips TP` - which the labelled scan cannot see,
 * because the number is not in front of the word it belongs to.
 */
/* A label and its price are usually separated by punctuation, but plenty of channels separate them with a
   small word instead - `SL at 4010`, `TP is 4050`, `Invalidation level 4011`. A closed list of those words,
   at most three of them, is what makes the number still belong to the label. The words are only connectives,
   never level words: `entry`, `price`, `zone` and `target` are labels in their own right, and letting one
   label skip over another produced `DCA Entry 1: 1.0850` read as "DCA" + "entry" + the number *1* - a third
   match that won the ladder and made the entry 1.0. An open-ended skip would let a
   label reach any number later in the message and call it a price, which is a worse failure than missing it. */
const MARKED_CONNECTIVE = String.raw`(?:\s*(?:[:=@\u2013\u2014\u2022\u2192-]|\b(?:is|are|at|to|in|of|on|for|by|the|around|near|level|now|market|open|close)\b)\s*)`;
const MARKED_GAP = `${MARKED_CONNECTIVE}{0,3}\\s*`;

function findPipDistances(text, labelPattern) {
  const regex = new RegExp(`\\b${NUMBER}\\s*(?:pips?|pts?|points?)\\s*(?:${labelPattern})\\b`, 'gi');
  return [...text.matchAll(regex)].map((match) => parseNumber(match[1])).filter((value) => value !== null);
}

function findMarkedValues(text, labelPattern) {
  const index = '(?:\\s*\\d{1,2}(?:\\s*[:=@]|\\s+(?=[\\d.])))?';
  const regex = new RegExp(`\\b(?:${labelPattern})\\b${index}${MARKED_GAP}${NUMBER}(?!\\s*[:=@])`, 'gi');
  return [...text.matchAll(regex)].map((match) => {
    const end = match.index + match[0].length;
    const tail = text.slice(end);
    return {
      value: parseNumber(match[1]),
      match,
      pips: isPipDistance(text, end),
      range: /^\s*(?:-|–|—|TO|\.\.)\s*(?:\d|\.)/i.test(tail),
    };
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
/* The index clause is index-aware in exactly the way `findMarkedValues` is, and for the same reason.
   `Entry 1: 1.0850` carries a level number; `Entry 4026.00` does not. Written loosely - "ENTRY" then one
   or two digits - it matched the "40" of a 4026.00 price, called that the index, and returned 26.00 as the
   entry, which is a readable number that is completely wrong. A digit run is only an index when a separator
   or another number follows it. */
const ENTRY_INDEX = '(?:\\s*\\d{1,2}(?:\\s*[:=@]|\\s+(?=[\\d.])))?';
const ENTRY_LABEL = `(?:ENTRY${ENTRY_INDEX}ZONE|SELL${ENTRY_INDEX}ZONE|BUY${ENTRY_INDEX}ZONE|ENTRY${ENTRY_INDEX}AREA|ENTRY${ENTRY_INDEX}(?:\\s+PRICE)?|PRICE${ENTRY_INDEX}|ZONE|AREA|DCA)`;
/* `@ 1.0850`, `@1.0850` and `EVERY PRICE @ 4011` - a price introduced by the at-sign and by no label at
   all. Channels mark the level this way constantly, and it used to be invisible: an entry written as `@`
   left no number on the row, which is the difference between a signal the engine can price-check and one
   it has to take on trust at whatever the market is doing. */
const ENTRY_MARKER = '@';
/*
 * `SELL STOP 4010`, `BUY LIMIT @ 4011`, `SELL GOLD LIMIT 4011`: the number that follows an order type is the
 * level the resting order waits at, and in these messages it is named by nothing else - no `ENTRY`, no `@`.
 * `LIMIT` may have a symbol between it and the direction word because `LIMIT` is never the name of a
 * protective leg. `STOP` may not, because `BUY GOLD stop 4005` really is a stop loss with the direction two
 * words away, and reading that number as the entry would put the entry where the stop belongs. A level that
 * is genuinely ambiguous is left to the other rules rather than guessed at.
 */
/*
 * Which stop-looking number is a level rather than a leg: `SELL STOP 4010` and `BUY GOLD LIMIT 4011` name the
 * price the resting order waits at, and in these messages nothing else names it - no `ENTRY`, no `@`.
 * A symbol between the direction word and `LIMIT` is allowed because `LIMIT` is never the name of a protective
 * leg. The same licence for `STOP` is given only when the protective leg has already been claimed by its own
 * label elsewhere in the message: `BUY GOLD stop 4005 TP 4030` is shorthand for a stop loss, and taking that
 * number as the entry would put the entry where the stop belongs and leave the trade unprotected.
 */
/* The two branches need distinct group names - a pattern cannot declare `price` twice - and the reader takes
   whichever one the alternative that matched filled in. */
const PENDING_LIMIT = (symbol) => String.raw`(?:BUY|SELL|LONG|SHORT)\s+${symbol}LIMIT\s*(?:ORDER\s*)?(?:AT|@|:|=|\s)\s*(?<limit>${NUMBER})`;
const PENDING_STOP = (symbol) => String.raw`(?:BUY|SELL|LONG|SHORT)\s+${symbol}STOP\s*(?:ORDER\s+|ENTRY\s+)?(?:ABOVE|BELOW|AT|@|:|=)?\s*(?<stop>${NUMBER})`;
const PENDING_SYMBOL = String.raw`(?:[A-Za-z][A-Za-z0-9._-]{1,9}\s+)?`;
const LABELLED_STOP = /\b(?:SL|STOP[- ]?LOSS|STOPLOSS|INVALIDATION)\b\s*[:=@-]?\s*\d/i;
/* An instruction to get *out* of a trade, and nothing this file may read as an instruction to get into one.
   `Close now` is the trap: `IMMEDIATE_IN_CLAUSE` looks for a direction word within twenty characters of `NOW`,
   and `GOLD BUY 4016. Close now at market` has one - the `BUY` of the trade being *closed*. That is how a
   management update came back wearing a stated MARKET order type. The verb and the exit words that belong to
   it are blanked out of the order-type scope (blanked, not removed, so every other rule still reads the same
   offsets), and only they are blanked: the run stops at the first word that is not part of an exit clause, so
   `CLOSE ALL, then BUY GOLD 4016 NOW` keeps its `NOW`. */
const EXIT_CLAUSE = /\b(?:CLOSE|CLOSES|CLOSED|CLOSING|EXIT|EXITS|EXITING|LIQUIDATE|LIQUIDATED|SCALE\s*OUT|PARTIAL\s*CLOSE)\b(?:\s+(?:ALL|EVERYTHING|HALF|MY|THE|A|AN|POSITION|POSITIONS|TRADE|TRADES|IT|NOW|IMMEDIATELY|AT|IN|MARKET|PROFIT|LOSS|EARLY|PARTIAL|ANYWAY|PLEASE|BE|BELOW|ABOVE))*(?!\s*\d)/gi;

function pendingLevelPattern(text) {
  const stopAllowsSymbol = LABELLED_STOP.test(String(text || ''));
  return new RegExp(`${PENDING_LIMIT(PENDING_SYMBOL)}|${PENDING_STOP(stopAllowsSymbol ? PENDING_SYMBOL : '')}`, 'gi');
}

/** The level itself, or null when the message states no resting price next to its order type. */
function findPendingLevel(text) {
  const values = [...String(text || '').matchAll(pendingLevelPattern(text))]
    .map((match) => parseNumber(match.groups.limit ?? match.groups.stop));
  const distinct = [...new Set(values.filter((value) => value !== null && value > 0))];
  // Two different levels named this way is the same contradiction as two entry labels, and gets the same
  // answer: refuse rather than pick, because both numbers look like the entry to a scanner this shallow.
  if (distinct.length > 1) return { value: null, error: 'More than one entry price was found.' };
  return { value: distinct.length === 1 ? distinct[0] : null, error: null };
}

/**
 * The text the protective legs are scanned from, with any pending-order level blanked out.
 *
 * Blanking (rather than removing) keeps every index in the string pointing at the same character, which the
 * pip-distance look-around depends on. Without this, `SELL STOP 4010, SL 4020` reads 4010 a second time as a
 * stop price, two stops are found, and the message is refused for a contradiction that is only in the
 * scanner's way.
 */
function withoutPendingLevel(text) {
  return String(text || '').replace(pendingLevelPattern(text), (match) => ' '.repeat(match.length));
}
const ENTRY_SEPARATORS = '[:=@–—-]';

/**
 * The most common signal shape, and the one no label catches: `BUY EURUSD 1.0850 SL 1.0800`.
 *
 * The price sits against the symbol with nothing in front of it, so a scanner that only reads labels never
 * sees it, and the row goes out with no entry. That is not fatal - the order is a market order either way -
 * but it throws away the one number that tells the engine the channel's level has already been passed. So
 * it is read here, narrowly: a number within a few characters of the symbol the message used, only when
 * nothing labelled claimed an entry, and never a quantity. Measure words are the trap: `BUY EURUSD 2 lots`
 * states a size, and a stop 2.0 away from 1.08 is exactly the readable-but-wrong number this file exists
 * to refuse. A price that matches a leg the labels already found is that leg restated, not an entry.
 */
/* The first lookahead is not decoration: `NUMBER` is `\d+`, so without it the engine is free to give a digit
   back when the guard rejects the match. `GOLD BUY : 50PIPS` then matched as an entry of **5** - the guard
   happily looking at `0PIPS`, which is not a unit word. `50 lots`, `300PIPS`, `2%` are the same shape: a
   number the message attached to a measure, read as a price by shrinking it until the measure stopped
   looking like a measure. A number that has a digit after it was never the whole number. */
const BARE_ENTRY_GUARD = '(?!\\d)(?!\\s*(?:lots?|units?|deals?|%|pips?|pts?|points?|USD|EUR|digits?|minutes?|hours?|days?|traders?))';

/* The number the bare scan reaches over has to be reachable: if a protective-leg label sits between the
   symbol and the digits, the digits belong to that leg. `GOLD BUY HIT TP 1` is a channel naming target one of
   a trade it is reporting on, and taking `1` as the entry price made a management update look like a signal
   with a one-dollar entry - a price so far from the market that every fallback distance in the product would
   happily trade it. */
const LEG_WORD = /\b(?:TP\d*|TAKE\s*PROFIT|SL|STOP(?:\s*LOSS|\s*OUT)?|TARGET|GOAL|INVALIDATION|BREAK\s*EVEN)\b/i;

function parseBareEntry(text, names, taken) {
  const pattern = (names || []).filter(Boolean).map((name) => String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (!pattern.length) return null;
  const regex = new RegExp(`\\b(?:${pattern.join('|')})\\b[^\\d\\n]{0,12}${NUMBER}${BARE_ENTRY_GUARD}`, 'gi');
  const found = [];
  for (const match of text.matchAll(regex)) {
    if (LEG_WORD.test(match[0])) continue;
    const value = parseNumber(match[1]);
    if (value === null || taken.includes(value)) continue;
    found.push(value);
  }
  return found.length === 1 ? found[0] : null;
}

function parseEntry(text) {
  /* The label has to be there; a small connective word after it is allowed, because channels write
     `Entry at 1.0850` and `price is 140.512` as naturally as `Entry: 1.0850`. `at` used to be a *label* of
     its own, and that is how `SELL US30 35000 - SL at 35100` came back with an entry of 35100: the English
     word in front of the stop, read as the entry. A word an ordinary sentence uses cannot be a marker - it
     can only ever be something a real label leans on. The same allowance is shared with `findMarkedValues`. */
  const regex = new RegExp(`(?:\\b${ENTRY_LABEL}|${ENTRY_MARKER})${MARKED_GAP}${NUMBER}(?:${RANGE_SEPARATOR}${NUMBER})?`, 'gi');
  const matches = [...text.matchAll(regex)];
  if (!matches.length) {
    const pending = findPendingLevel(text);
    if (pending.error) return { value: null, range: null, error: pending.error, levels: null, pips: false };
    // The label-based scan finding nothing is also the only safe moment to trust an order type as a price:
    // a message that says `Entry 4020` and `SELL STOP 4010` has two candidates, and the label wins.
    return pending.value === null
      ? { value: null, range: null, error: null, levels: null, pips: false }
      : { value: pending.value, range: null, error: null, levels: null, pips: false };
  }
  /* More than one entry is a dollar-cost-averaging plan when the message enumerates it - `Entry 1: 1.0850`
     then `Entry 2: 1.0800` - which is an instruction with a first leg, not a contradiction. It stays a
     contradiction when the levels are offered as alternatives ("entry 1.085 or 1.080"), because choosing
     between two prices a human wrote as a choice is exactly the guessing this parser exists to avoid. So
     an `or`, a slash, or an "if" between two candidates leaves the refusal in place. */
  if (matches.length > 1) {
    const between = matches.slice(0, -1).map((match, index) => text.slice(match.index + match[0].length, matches[index + 1].index)).join(' ');
    const ladder = !/\b(?:or|else|if|otherwise)\b|\//i.test(between);
    const listed = matches.map((match) => parseNumber(match[1])).filter((value) => value !== null);
    if (ladder && listed.length === matches.length) {
      return { value: listed[0], range: null, error: null, levels: listed, pips: isPipDistance(text, matches[0].index + matches[0][0].length) };
    }
    return { value: null, range: null, error: 'More than one entry price was found.', levels: null, pips: false };
  }
  const low = parseNumber(matches[0][1]);
  const high = parseNumber(matches[0][2]);
  if (matches[0][2] === undefined || high === null) {
    const pips = isPipDistance(text, matches[0].index + matches[0][0].length);
    return low !== null
      ? { value: pips ? null : low, range: null, error: null, pips, levels: null }
      : { value: null, range: null, error: 'The entry price is not a valid price.', levels: null, pips: false };
  }
  const range = { low: Math.min(low, high), high: Math.max(low, high) };
  return { value: null, range, error: null, levels: null, pips: false };
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
/**
 * How the channel wants the order put on the book: filled at the market, or resting at a price.
 *
 * The naive version of this - scan the message for `STOP`, `LIMIT` or `MARKET` - is wrong on almost every
 * real signal this product has ever stored, because those words are ordinary English in trading prose.
 * "Stop Loss: 4010" contains STOP; "daily loss limit" and "max positions limit" contain LIMIT; "trust your
 * market mover" contains MARKET. A parser that read those as order types would quietly turn a channel's
 * risk warnings into resting orders, and a resting order is money that moves while nobody is watching.
 *
 * So the search is scoped the way the rest of this file reads a message. Only a line that carries an
 * instruction can set the order type; the labelled legs and their numbers are cut out of that line before it
 * is read, because they are where the false `stop` and `limit` live; and an immediate word has to sit next to
 * the word it modifies. `SELL GOLD Stop Loss: 4010` therefore says nothing at all about the entry type and
 * stays a market order, exactly as it has always been.
 *
 * When the message says nothing, the shape of the entry decides. A single stated price with no instruction to
 * pay the market is a level to be filled *at*, which is a limit - and so is a zone, at the bound the row is
 * credited with: a range is a price to wait at rather than one to chase. What a zone does once the order is
 * being built is a different question, with three answers that need a live quote and are given in
 * `pendingOrderPlan` (`order-routing.js`): above the zone it rests at the near edge, inside it the trade is
 * taken at the market, and past the far edge the setup is gone and nothing is sent. An entry that was never
 * given at all has nothing to rest at and stays a market order.
 */
const INSTRUCTION_LINE = /\b(?:BUY|SELL|LONG|SHORT|ENTRY|POSITION|ORDER|TRADE|LIMIT|STOP|SL|TP)\b/i;
/* A leg label and the number attached to it, removed from the clause before order-type words are looked
   for. Only the value is cut, not the rest of the line: a channel that writes `TP1 4050 - limit orders only`
   has something to say about the order type after the number. */
const LEG_WITH_VALUE = /\b(?:SL|STOP[- ]?LOSS|STOPLOSS|INVALIDATION|TP\d*|TAKE[- ]?PROFIT|TARGET)\b\s*[:=@-]?\s*\d[\d.,]*(?:\s*-\s*\d[\d.,]*)?(?:\s*(?:USD|pips?|points?|usd))?/gi;
const PROSE_LIMIT = /\b(?:daily|per[- ]?day|total|maximum|max|min(?:imum)?|loss|drawdown|risk|position(?:s)?|trade(?:s)?|order(?:s)?|exposure|withdrawal|deposit|betting|trading|per[- ]?trade)\s+(?:loss\s+|order\s+)?limit(?:s)?\b/gi;
const PROSE_STOP = /\b(?:trailing|break[- ]?even|guaranteed|emergency)\s+stop\b|\bstop[- ]?(?:out|hunt(?:ing)?|level|move|moving)\b/gi;
const IMMEDIATE_IN_CLAUSE = /\b(?:BUY|SELL|LONG|SHORT|ENTER|ENTRY|EXECUTE|EXECUTION|OPEN|ORDER|TRADE|SETUP|POSITION)\b[^\n]{0,20}?\b(?:NOW|CMP|INSTANT(?:LY)?|IMMEDIATELY|AT\s+MARKET(?:\s+PRICE)?|MARKET\s+(?:ORDER|PRICE|EXECUTION|ENTRY|FILL))\b/i;
/* `MARKET` on its own is only a trading instruction when nothing but punctuation separates it from the verb:
   `BUY MARKET` yes, `do not trade if market closes` no. */
const MARKET_AFTER_INSTRUCTION = /\b(?:BUY|SELL|LONG|SHORT|ENTER|ENTRY|EXECUTE|OPEN|ORDER|TRADE)\b[\s,!.:'"\-]{0,3}MARKET\b/i;
const BARE_CMP = /\bCMP\b/;
/* The number form of a limit needs the order type to be *pointing* at it (`LIMIT @ 4011`, `LIMIT: 4011`,
   `LIMIT AT 4011`), because `limit 4011` with nothing between is also how a channel writes a risk cap
   ("max positions limit 5"). A message that only says `BUY GOLD LIMIT 4011` still ends up a limit order - the
   stated price decides that - so what this rule protects is the `stated` flag, and the refusal to read a
   number belonging to somebody else's sentence as an entry level. */
const LIMIT_ORDER = /\b(?:BUY|SELL|LONG|SHORT)\s+(?:[A-Za-z][A-Za-z0-9._-]{1,9}\s+)?LIMIT\b|\bLIMIT\s+(?:BUY|SELL|ORDER|ENTRY|PRICE)\b|\bLIMIT\s+(?:AT|@|:|=)\s*\d|\bPENDING\s+(?:BUY|SELL|LIMIT|ORDER)\b/i;
const STOP_ORDER = /\b(?:BUY|SELL|LONG|SHORT)\s+STOP\b(?!\s*(?:LOSS|LOSSES|OUT|HUNT|HUNTING|LEVEL|MOVE|MOVING|TRAILING))|\bSTOP\s*(?:ORDER|ENTRY)\s*(?:AT|@|:)\s*\d|\b(?:STOPPED?|BREAKOUT)\s+(?:ABOVE|BELOW)\b|\bON\s+(?:STOP|BREAKOUT)\b/i;
/* `fast` and `quick` on their own are adjectives in nearly every channel's prose, so they only count next to
   a word that names the trade itself. `scalp` needs no such company. */
const SCALP_WORDS = /\bSCALP(?:ING|ED|ER|S)?\b/i;
const SCALP_PHRASE = /\b(?:FAST|QUICK)\s+(?:IN|ENTRY|EXECUTION|TRADE|SETUP|BUY|SELL|TP|TAKE\s*PROFIT)\b|\b(?:ENTRY|EXECUTION|SETUP|SCALP)\s+(?:FAST|QUICK)\b/i;

function orderTypeClause(text) {
  const lines = String(text || '').split(/\r?\n/).filter((line) => INSTRUCTION_LINE.test(line));
  const scope = (lines.length ? lines.join('\n') : String(text || ''))
    .replace(LEG_WITH_VALUE, ' ')
    .replace(PROSE_LIMIT, ' ')
    .replace(PROSE_STOP, ' ')
    .replace(EXIT_CLAUSE, ' ');
  // A message with no instruction line cannot be attributed to an entry at all, so only the phrases that
  // could not possibly mean anything else are allowed to speak for it.
  return { scope, hasInstructionLine: lines.length > 0 };
}

/**
 * `stated` separates what the channel asked for from what the shape of the message implied. It matters to the
 * reader: a row that reads `Limit` because the channel wrote `LIMIT 4011` is a fact about the signal, and a
 * row that reads `Limit` because a price was published with no instruction to take the market is a policy this
 * product chose. The UI says them differently.
 */
export function detectOrderType(text, { entryPrice = null } = {}) {
  const { scope, hasInstructionLine } = orderTypeClause(text);
  const immediate = IMMEDIATE_IN_CLAUSE.test(scope) || MARKET_AFTER_INSTRUCTION.test(scope) || BARE_CMP.test(scope);
  // A request to be filled now outranks every other reading, and it is the safe one: it is what this product
  // has always done, and it cannot leave an order on the book after the setup has gone.
  if (immediate) return { orderType: 'market', stated: true };
  if (STOP_ORDER.test(scope)) return { orderType: 'stop', stated: true };
  if (hasInstructionLine && LIMIT_ORDER.test(scope)) return { orderType: 'limit', stated: true };
  const level = Number(entryPrice);
  /* Both a single published price and the bound credited from a zone are levels to be filled *at*. The range
     is not lost here - it travels on the row as `entryRange`, and it is that range's far edge which later
     refuses the trade, which is the whole difference between waiting for a setup and chasing one. */
  if (Number.isFinite(level) && level > 0) return { orderType: 'limit', stated: false };
  return { orderType: 'market', stated: false };
}

export function detectScalping(text) {
  const { scope, hasInstructionLine } = orderTypeClause(text);
  if (SCALP_WORDS.test(scope)) return true;
  return hasInstructionLine && SCALP_PHRASE.test(scope);
}

/**
 * Market news, and why it is not a signal.
 *
 * A headline is built out of exactly what a signal scanner looks for: instruments, prices, and verbs about
 * prices moving. `JUST IN: Crypto is dumping - $SOL falls under $100, $BTC falls under $80,000` is therefore
 * five mentions of markets with numbers attached, and if such a message is ever allowed a *direction*, a
 * channel's editorial becomes somebody's live short. Layer 1 does not invent directions - it reads a stated
 * BUY/SELL/LONG/SHORT or nothing - but it did happily return `symbol: BTCUSD` for that bulletin, and a row
 * naming a coin with no instruction is what makes a news post look like a signal the platform failed to read
 * instead of a message that never asked anyone to trade.
 *
 * So the classification happens here, before anything is stored, and it is deliberately narrow. Both halves
 * must hold:
 *
 *   1. the text carries news wording - a bulletin lead, a journalism noun, a verb of a price *moving*, or a
 *      list of cashtags; and
 *   2. the text states no trade of its own - no direction, no labelled entry, no zone, no stop, no target.
 *
 * The second half is what stops this being a keyword blocklist that refuses real signals. Channels put
 * `JUST IN` above genuine instructions constantly, and a hype prefix over `SELL GOLD 4016 SL 4010 TP 4050`
 * must still be read as the trade it is. What is refused here is only the message whose whole content is a
 * movement being reported, because that is the only kind a reader could mistake for an instruction.
 */
/** The shout at the top of a bulletin. */
const NEWS_LEAD = /\b(?:JUST\s+IN|BREAKING|DEVELOPING|HEADLINES?|MARKET\s+(?:WRAP|ROUNDUP|RECAP)|DAILY\s+RECAP|WEEKLY\s+OUTLOOK|NEWS\s*(?:FLASH|DESK|ROOM|WIRE)|UPDATE\s*:)\b/i;
/** Nouns that belong to a publication rather than to an order. */
const NEWS_NOUN = /\b(?:NEWS|REPORT(?:ED|S|ING)?|OUTLET|JOURNALIST|SOURCES\s+SAY|ANALYSTS?|ECONOMISTS?|COMMENTARY|EDITORIAL|FORECAST|PROJECTIONS?|SELL-side\s+RESEARCH)\b/i;
/** A price described as moving, which is not the same thing as a price to act at. */
const NEWS_MOVE = /\b(?:DUMP(?:S|ED|ING)|CRASH(?:ES|ED|ING)?|PLUNGE(?:S|ED|ING)?|SINK(?:S|ING)?|SOAR(?:S|ING)?|SURGE(?:S|D|ING)?|SPIKE(?:S|D|ING)?|TUMBLE(?:S|D|ING)?|SLUMP(?:S|ED|ING)?|RALL(?:Y|IES|YING)|PUMP(?:S|ED|ING)?|CORRECTION|SELL-?OFF|SELLING\s+SPREE|CAPITULATION|VOLATILITY|RALLYING)\b/i;
/** The headline idiom: a level being crossed, written in prose, with no imperative in sight. */
const NEWS_LEVEL_MOVE = /\b(?:FALLS?|DROPS?|SLIPS?|DIPS?|SINKS?|TUMBLES?|PLUNGES?|CRASHES?|BREAKS?|TOUCHES?|HITS?)\s+(?:UNDER|BELOW|TO|THROUGH|PAST)\b|\b(?:RISES?|CLIMBS?|GAINS?|JUMPS?|SOARS?|SURGES?|BREAKS?|SHOOTS?)\s+(?:ABOVE|OVER|TO|THROUGH|PAST)\b|\b(?:TRADES?|CHANGES?|SITS?|STANDS?|EXCHANGES?)\s+(?:AT|NEAR|AROUND|FOR)\b|\bAT\s+(?:AN\s+)?(?:ALL-TIME\s+)?(?:RECORD|HIGH|LOW)\b/i;
/** `$SOL $XRP $ETH` - a *list* of cashtags is a roundup; a single one is how a channel names its coin. */
const CASHTAGS = /\$[A-Za-z][A-Za-z0-9]{1,9}\b/g;
const CASHTAG_LIST_MIN = 3;

/** The blocker code and the sentence that go on a row classified as news. */
export const NEWS_BLOCKER_CODE = 'news-commentary';
export const NEWS_BLOCKER_MESSAGE = 'This message is market news rather than a trade instruction, so nothing was taken from it.';

/*
 * Trade management, in the words channels actually use.
 *
 * A channel that is watching an open position writes about targets being hit, stops moved to break even,
 * halves closed and trades running - and every one of those sentences contains the vocabulary of an order
 * (`TP`, `SL`, `CLOSE`, `+50 PIPS`) without containing an order. This family is nastier than market news, which
 * is why it needs its own classifier rather than a wider news rule: a management update *does* name the
 * direction and the instrument, because it is reporting on the trade it took in them, so the test the news
 * uses ("did the message state a direction?") answers "yes" here every time.
 */
/** A leg of the plan completed, which is a fact about a finished trade. */
const MANAGEMENT_HIT = /\b(?:TP|TAKE\s*PROFIT|TARGET|SL|STOP\s*LOSS)\s*\d*\s*(?:HIT|REACHED|TOUCHED|DONE|COMPLETED|FIRED)\b|\b(?:HIT|REACHED|TOUCHED|CLOSED\s+AT)\s+(?:ALL\s+)?(?:THE\s+)?(?:TP|TAKE\s*PROFIT|TARGET|SL|STOP)\s*\d*\b|\b(?:TP\s*\d+|TARGET\s*\d+)\s*(?:✅|✔|✅✅)\s*\b/gi;
/** An instruction about the exit of a position, which is never an instruction about an entry. */
const MANAGEMENT_EXIT = /\b(?:CLOSE|CLOSES|CLOSED|CLOSING|EXIT|EXITS|EXITING|LIQUIDATE|SCALE\s*OUT|PARTIAL\s*CLOSE)\b\s*(?:ALL|EVERYTHING|HALF|MY|THE|A|POSITION|POSITIONS|TRADE|TRADES|NOW|IT|EARLY|PARTIAL|AT\s+MARKET)?\b/gi;
/** Moving a stop to the entry price - management of an open trade, in every channel that writes it. */
const MANAGEMENT_BREAK_EVEN = /\b(?:SET|MOVE|MOVED|SHIFT|ADJUST|SLIDE|CHANGE)\s+(?:THE\s+|MY\s+|YOUR\s+)?(?:SL|STOP|STOP\s*LOSS)?\s*(?:TO|AT|AT\s+THE)?\s*(?:BE|B\/E|BREAK\s*EVEN|ENTRY)\b|\b(?:SL|STOP)\s*(?:TO|ON|AT)\s*(?:BE|BREAK\s*EVEN|ENTRY)\b|\bSET\s*(?:BE|BREAK\s*EVEN)\b|\bBREAK\s*EVEN\s+(?:SET|DONE|ACTIVATED?)\b|\b(?:IN\s+)?BREAK\s*EVEN\b/gi;
/** The result of a closed trade: a signed distance, or the words that go with one. */
const MANAGEMENT_RESULT = /(?:^|[\s(,|:])[-+] ?\d+(?:[.,]\d+)? ?(?:PIPS?|POINTS?|PTS)\b|\b(?:WITH|MAKING|UP|DOWN|IN|FOR)\s+(?:A\s+)?(?:PROFIT|LOSS)\b|\b(?:PROFIT|LOSS)\s+(?:OF|IS|:)?\s*\d|\b(?:GOOD\s+TRADE|WELL\s+DONE|CONGRATS|CONGRATULATIONS|GG)\b/gi;
/** The trade is still being described, not ordered. */
const MANAGEMENT_RUNNING = /\b(?:TRADE|POSITION|SETUP)\s+(?:IS\s+)?(?:STILL\s+)?(?:RUNNING|LIVE|OPEN|ACTIVE)\b|\b(?:LET\s+IT\s+RUN|RUN\s+IT|HOLD\s+(?:THE|YOUR|IT)?\s*(?:POSITION|TRADE|WINNERS?)|TP\s*\d+\s+(?:PENDING|OPEN|RUNNING))\b/gi;

/** The blocker code and the sentence that go on a row classified as a trade update. */
export const MANAGEMENT_BLOCKER_CODE = 'trade-management-update';
export const MANAGEMENT_BLOCKER_MESSAGE = 'This message manages a trade that is already open - a target hit, a stop moved to break even, or an instruction to close - rather than giving a new entry, so nothing was taken from it.';

/**
 * Which management wording this message carries.
 *
 * Every one of these is `g`-flagged and used with `test`, which makes a regex's `lastIndex` a live variable
 * shared by every caller - so each is reset first. Reading the same text twice and getting a different answer
 * the second time is a worse bug than the one being fixed, and it is invisible in a single test.
 */
export function findManagementMarkers(text) {
  const value = String(text ?? '');
  const markers = [];
  for (const [name, pattern] of [['target-hit', MANAGEMENT_HIT], ['close-instruction', MANAGEMENT_EXIT], ['break-even', MANAGEMENT_BREAK_EVEN], ['pips-result', MANAGEMENT_RESULT], ['trade-running', MANAGEMENT_RUNNING]]) {
    pattern.lastIndex = 0;
    if (pattern.test(value)) markers.push(name);
  }
  return markers;
}

/**
 * Whether management wording makes this message something other than an entry instruction.
 *
 * The wording alone is not enough, because a channel that publishes a fresh signal often mentions the trade
 * it is replacing. What decides it is whether the message can stand as an order on its own: a level to get in
 * at (a price, a zone, or an explicit "now"/"CMP"), *and* a protective leg. A message with both is a signal
 * that happens to talk about its predecessor, and clearing it would lose a trade. A message with management
 * wording and no complete instruction of its own is a report, and reading it as an order is how a
 * "CLOSE NOW" ends up opening a position.
 */
function readsAsTradeUpdate({ markers, entry, entryPrice, entryPips, order, stopMatches, targetPriceMatches }) {
  if (!markers.length) return false;
  /* `entryPrice`, not `entry.value`: the level a channel writes next to the symbol with no label at all
     (`GOLD BUY 4011`) is resolved after the labelled scan, and an instruction that named its entry that way is
     still an instruction with a price to be filled at. */
  const levelStated = entryPrice !== null || entry.range !== null || entryPips === true || order?.stated === true;
  const protectedStated = stopMatches.length > 0 || targetPriceMatches.length > 0;
  if (levelStated && protectedStated) return false;
  return true;
}

/**
 * Which news tells a message this is. Every marker is reported, never counted blindly: a single journalism
 * noun is not enough (a real signal says "no trading during the news" too), while a bulletin lead or a price
 * *described* as moving is, because no channel writes an instruction that way.
 */
export function findNewsMarkers(text) {
  const value = String(text ?? '');
  const markers = [];
  if (NEWS_LEAD.test(value)) markers.push('lead');
  if (NEWS_MOVE.test(value) || NEWS_LEVEL_MOVE.test(value)) markers.push('price-move');
  if (/\b(?:FALLS?|DROPS?)\s+UNDER\b/i.test(value)) markers.push('level-broken');
  if ((value.match(CASHTAGS) || []).length >= CASHTAG_LIST_MIN) markers.push('ticker-list');
  if (NEWS_NOUN.test(value)) markers.push('news-wording');
  return markers;
}

/**
 * Whether news wording makes this message unread as an instruction, given what the scan already found.
 *
 * The news markers are only half the test. A message that states a direction, or names a level the channel
 * labelled as an entry, a zone, a stop or a target, is about a trade whatever else it says, and refusing it
 * would lose a signal to a rule meant to protect one.
 */
function readsAsNews({ markers, side, entry, entryPips, stopMatches, takeProfitMatches }) {
  if (!markers.length) return false;
  if (side !== null) return false;
  if (entry.value !== null || entry.range !== null || entryPips) return false;
  if (stopMatches.length || takeProfitMatches.length) return false;
  return true;
}

export function parseSignal(message) {
  const raw = String(message || '').slice(0, 5000);
  const numbers = normalizeSignalNumbers(stripNoise(raw));
  const text = numbers.text;
  /* Which numbers in this message could only be read by guessing. A leg that lands on one of them is
     reported, not traded: `SL 4,011` means 4.011 to one market and 4011 to another, and a stop chosen by
     a coin flip is worse than no stop, because it looks like a plan. */
  const unclear = numbers.ambiguous;
  const unclearValue = (value) => (value === null ? null : unclear.find((item) => item.value === value) || null);

  const directions = [...text.matchAll(DIRECTION_WORDS), ...text.matchAll(OPTION_WORDS)]
    .map((match) => match[1].toUpperCase())
    .map((word) => (SELLISH.has(word) ? 'sell' : 'buy'));
  const uniqueDirections = [...new Set(directions)];
  let side = uniqueDirections.length === 1 ? uniqueDirections[0] : null;
  const ambiguousSideError = uniqueDirections.length > 1 ? 'More than one trade direction was found.' : null;
  const missingSideError = uniqueDirections.length === 0 ? 'A BUY or SELL direction was not found.' : null;

  const { symbol, error: symbolError } = findSymbol(text);
  const entry = parseEntry(text);
  /* A level a message gives as a distance ("SL 30 pips") is a *leg the channel stated*, and it is kept
     apart from a price for two reasons. It cannot be turned into a price here - that needs the broker's tick
     size, which only exists when the order is built - and treating it as absent would let a workspace's
     fallback distance quietly replace the number the trader actually wrote down. */
  const legText = withoutPendingLevel(text);
  const stopMatches = findMarkedValues(legText, 'SL|STOP(?:\\s*LOSS)?|INVALIDATION|INVALIDATE(?:\\s*LEVEL)?|STOP\\s*OUT');
  const takeProfitMatches = findMarkedValues(legText, 'TP\\d*|TAKE\\s*PROFIT(?:\\s*\\d+)?|TARGET(?:\\s*\\d+)?|GOAL');
  /* A price named twice in one message is one price, not a choice: "SL 1.28 ... (SL 1.28 is above
     entry)" restates the stop inside its own commentary, and only two *different* numbers leave nothing
     to pick. Distinct-first-seen order is what both stops and targets are judged on. */
  const distinctPrices = (matches) => [...new Set(matches.map((match) => match.value).filter((value) => value !== null))];
  const stopPriceMatches = stopMatches.filter((match) => !match.pips);
  const stopDistanceMatches = stopMatches.filter((match) => match.pips);
  /* A target label followed by one small bare integer is the channel numbering its ladder, not a level:
     `HIT TP 1 ✅ +50 PIPS` names target one, and `TP 1` is not a price of one. The index clause in
     `findMarkedValues` already skips `TP 1: 4050` and `TP 1 4050`, where a price follows; what it could not
     see was the index with *nothing* after it, and reading that as a price of 1 did two kinds of damage: the
     row claimed a take-profit the message never stated, and `directionInferred` then compared 1 against the
     entry and "worked out" a direction from it. A genuine one-digit price level is not a thing in any market
     this product trades (and dropping one only costs a target: the take-profit block then refuses to trade,
     which is the safe direction). */
  const isTargetIndex = (match) => /^\d$/.test(String(match.match?.[1] ?? '').trim());
  const targetPriceMatches = takeProfitMatches.filter((match) => !match.pips && !isTargetIndex(match));
  const targetDistanceMatches = takeProfitMatches.filter((match) => match.pips);
  const stopPrices = distinctPrices(stopPriceMatches);
  const stopPips = [...distinctPrices(stopDistanceMatches), ...findPipDistances(legText, 'SL|STOP(?:\\s*LOSS)?|INVALIDATION')];
  const targetPipsAll = [...distinctPrices(targetDistanceMatches), ...findPipDistances(legText, 'TP\\d*|TAKE\\s*PROFIT|TARGET')];
  const targetPips = [...new Set(targetPipsAll)];
  const stopLoss = stopPrices.length === 1 ? stopPrices[0] : null;
  /* A leg expressed in pips counts as *present* - `missing` is what the fallback nets and the Safety blocks
     read, and overwriting a distance the channel gave with a distance the workspace guessed is the kind of
     helpfulness this file exists to refuse. */
  const stopLossPips = stopPips.length === 1 ? stopPips[0] : null;
  const takeProfitPips = targetPips.length === 1 ? targetPips[0] : null;
  /* A channel that numbers its targets is describing one trade with a scale-out plan, not a
     contradictory message: the first price it names is the exit this product trades, because closing
     at TP1 is strictly earlier than the plan rather than riskier than it. The other levels are kept so
     the row can say what the message really carried. */
  const takeProfitLevels = distinctPrices(targetPriceMatches);
  const takeProfit = takeProfitLevels.length ? takeProfitLevels[0] : null;
  let entryPrice = entry.value !== null ? entry.value : entryFromRange(entry.range, side);
  const entryPips = entry.pips === true && entryPrice === null;
  /* An entry named by nothing but its position, read only once the labelled legs are known - so that a
     number already claimed as a stop or a target is never counted twice as an entry, and the message's own
     scale is what tells "EURUSD 1.0850" from "EURUSD 2 lots". */
  let entryWasBare = false;
  if (entryPrice === null && entry.range === null && !entryPips) {
    const names = [symbol, ...Object.keys(SYMBOL_ALIASES).filter((alias) => SYMBOL_ALIASES[alias] === symbol)];
    const taken = [stopLoss, takeProfit, ...takeProfitLevels, stopLossPips, takeProfitPips].filter((value) => value !== null);
    const bare = parseBareEntry(text, names, taken);
    if (bare !== null) { entryPrice = bare; entryWasBare = true; }
  }

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
  if (stopDistanceMatches.length && stopPips.length > 1) block('stop-loss-pips-multiple', 'More than one stop-loss distance was found.');
  if (stopPriceMatches.length === 0 && stopDistanceMatches.length === 0 && stopPips.length === 0) block('stop-loss-missing', 'A stop loss is required for automatic execution.');
  if (stopPrices.length > 1) block('stop-loss-multiple', 'More than one stop loss was found.');
  if (stopMatches.some((match) => match.range)) block('stop-loss-range', 'Stop-loss ranges are not supported for automatic execution.');
  if (takeProfitMatches.some((match) => match.range)) block('take-profit-range', 'Take-profit ranges are not supported for automatic execution.');
  if (!blockers.some((item) => item.code.startsWith('stop-loss')) && !stopLoss && stopLossPips === null) block('stop-loss-invalid', 'The stop loss is not a valid price.');
  if (targetDistanceMatches.length && targetPips.length > 1) block('take-profit-pips-multiple', 'More than one take-profit distance was found.');
  /* An entry given only as a distance from nothing ("entry 20 pips") has no anchor to measure from, and no
     honest reading: the order is a market order, so there is no price the distance could be applied to
     before the trade exists. */
  if (entryPips) block('entry-distance', 'The entry was given as a distance without a price to measure it from; the order will be filled at the market price.');
  /* The number a leg landed on was only readable by choosing between two magnitudes. Naming it is the
     whole point: a reader who can see `4,011` knows instantly which one it was, and the parser does not. */
  for (const [code, label, value] of [['entry-format', 'the entry', entryPrice], ['stop-loss-format', 'the stop loss', stopLoss], ['take-profit-format', 'the take profit', takeProfit]]) {
    const unclearLevel = unclearValue(value === null ? null : Number(value));
    if (!unclearLevel) continue;
    block(code, `A price was written in a form Signal Desk cannot read safely (${label}: ${unclearLevel.raw} may be ${unclearLevel.candidates.join(' or ')}), so this signal was saved for review.`);
  }
  if (targetPriceMatches.length === 1 && !takeProfit) block('take-profit-invalid', 'The take-profit price is not a valid price.');
  if (directionInferred) block('direction-inferred', 'The trade direction was inferred from the entry and target prices, so this signal is saved for review rather than traded.');

  /* A trade whose entry and stop are the same number has no room to be wrong, which is never what a channel
     wrote: it is one number read twice, and exactly the shape a bug produces when an entry gets taken from a
     leg. Refusing costs a look at a row; accepting sends an order that closes the moment it opens. */
  if (entryPrice !== null && stopLoss !== null && entryPrice === stopLoss) {
    block('entry-stop-identical', 'The entry and the stop loss are the same price, so this signal cannot be executed as written.');
  }
  if (entryPrice !== null && takeProfit !== null && entryPrice === takeProfit) {
    block('entry-target-identical', 'The entry and the take-profit target are the same price, so this signal cannot be executed as written.');
  }

  const parseError = blockers[0]?.message ?? null;
  if (entryPrice === null && entry.entryPriceFromRange !== undefined) entryPrice = entry.entryPriceFromRange;
  /* Read after every leg is settled, because the fallback rule is about the entry that survives resolution:
     a bound taken from a zone, or an entry inferred from a target after the direction was guessed, is not a
     price the channel asked to be filled at. */
  const order = detectOrderType(text, { entryPrice });
  const hasTradingData = Boolean(symbol || side || entryPrice !== null || stopLoss !== null || takeProfit !== null || stopLossPips !== null || takeProfitPips !== null);

  /* Market news gets the last word, because it is the one reading that changes what may be *stored*. A
     bulletin that names a coin and quotes four prices has already been scanned for a trade and found to
     carry none - no direction, no labelled level - and leaving `symbol: BTCUSD` in the row would present a
     headline as a signal this platform could not finish reading. Cleared instead, so the row says "no clear
     signal" and quotes the reason the message is news. */
  const newsMarkers = findNewsMarkers(text);
  const newsOnly = readsAsNews({
    markers: newsMarkers,
    side,
    entry,
    entryPips,
    stopMatches,
    takeProfitMatches,
  });
  /* Trade management is decided next to news and by a different test, for the reason above: a management update
     names its direction and its instrument, so "did it state a direction" cannot be the discriminator here. */
  const managementMarkers = findManagementMarkers(text);
  const managementUpdate = readsAsTradeUpdate({
    markers: managementMarkers,
    entry,
    entryPrice,
    entryPips,
    order,
    stopMatches,
    targetPriceMatches,
  });

  const parsed = {
    symbol,
    side,
    entryPrice,
    stopLoss,
    takeProfit,
    orderType: order.orderType,
    orderTypeStated: order.stated,
    isScalping: detectScalping(text),
    executionReady: !parseError,
    parseError,
    directionInferred,
    hasTradingData,
    entryRange: entry.range,
    takeProfitLevels,
    stopLossPips,
    takeProfitPips,
    entryWasBare,
    entryLevels: entry.levels || null,
    ambiguousLevels: unclear.map((item) => ({ raw: item.raw, candidates: item.candidates })),
    /* Whether this message was read as market news rather than as a signal at all. It is the one flag a
       reader should be able to tell a "needs review" row apart from a "not a signal" row by, and it is what
       keeps the fallback layer from being consulted about a headline. */
    newsOnly,
    /* Whether this message was read as an update on an open trade. Same purpose as `newsOnly`, different rule:
       it is what stops a "HIT TP 1 +50 PIPS" being stored as an order that is missing a stop loss. */
    managementUpdate,
    managementMarkers,
    /* Which news wording the message carries, kept even on a row that stays a signal. A headline that quotes
       levels is still a headline, and this is what stops a direction being taken from one. */
    newsMarkers,
    /* Whether the message contains a price at all. It decides whether a workspace's fallback distance may
       rescue this row, and a direction with no level anywhere is not an incomplete instruction - it is
       enthusiasm. `BUY GOLD` does not tell anyone where to get in, so no default distance should turn it
       into an order. */
    hasPriceLevel: Boolean(entryPrice !== null || entry.range || stopLoss !== null || takeProfit !== null || stopLossPips !== null || takeProfitPips !== null),
    missing: { entryPrice: entryPrice === null, stopLoss: stopLoss === null && stopLossPips === null, takeProfit: takeProfit === null && takeProfitPips === null },
    blockers,
  };

  if (!newsOnly && !managementUpdate) return parsed;
  /* Nothing at all is taken from a news message or a management update: not the symbol it named, and above all
     not a direction read out of a price falling, or an entry read out of a trade being closed. The legs are null
     because the text never stated them, and `missing` stays all-true so no workspace fallback distance can
     finish a headline - or a `CLOSE NOW` - into an order. */
  return {
    ...parsed,
    symbol: null,
    side: null,
    entryPrice: null,
    stopLoss: null,
    takeProfit: null,
    stopLossPips: null,
    takeProfitPips: null,
    takeProfitLevels: [],
    entryRange: null,
    entryLevels: null,
    entryWasBare: false,
    directionInferred: false,
    isScalping: false,
    orderType: 'market',
    orderTypeStated: false,
    hasTradingData: false,
    hasPriceLevel: false,
    missing: { entryPrice: true, stopLoss: true, takeProfit: true },
    newsOnly,
    newsMarkers,
    managementUpdate,
    managementMarkers,
    executionReady: false,
    parseError: newsOnly ? NEWS_BLOCKER_MESSAGE : MANAGEMENT_BLOCKER_MESSAGE,
    blockers: [{
      code: newsOnly ? NEWS_BLOCKER_CODE : MANAGEMENT_BLOCKER_CODE,
      message: newsOnly ? NEWS_BLOCKER_MESSAGE : MANAGEMENT_BLOCKER_MESSAGE,
    }],
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
