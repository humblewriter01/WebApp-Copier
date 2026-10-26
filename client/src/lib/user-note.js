/**
 * The language a trader is shown, and nothing else.
 *
 * `signals.execution_note`, `signals.parse_error`, a trade's `error_message` and an account's note are all text
 * this app generated from something else's failure, and all four end up on a screen. The rule is the server's -
 * see `server/services/signal-wording.js`, whose three blocks below are copied here because the client is a
 * separate bundle - and `server/test/signal-wording.test.js` compares the copies character for character, so a
 * status code, a model name, an endpoint or a stack frame cannot quietly become a sentence in a list.
 */
/**
 * The same rule the server applies when it writes a signal row, applied again on the way to the screen.
 *
 * `signals.execution_note` and `signals.parse_error` are columns this app has filled from several places over
 * time, so a card cannot rely on the writer having been careful: a row captured before the sentence was cleaned
 * is still on somebody's list today. The three pieces below are the server's, copied rather than imported
 * because the client is a separate bundle, and `server/test/signal-wording.test.js` compares them against the
 * originals character for character, which is what turns drift into a failing test instead of a leak.
 */
export const TECHNICAL_NOTE_MARKERS = String.raw`https?://|\bHTTP(?:/[\d.]+)?\b|\b\s*\d{3}\s*(?:bad request|unauthorized|payment required|forbidden|not found|request timeout|conflict|too many requests|unavailable|bad gateway|gateway timeout)\b|\bstatus\s*(?:code)?\s*[:=]\s*\d{3}|\b(?:code|err|error_code|retcode)\s*[:=]\s*[A-Za-z0-9_.-]+|\(\d{3,6}\)|TRADE_RETCODE_[A-Z_]+|\bretcode\b|\b(?:ECONN[A-Z_]*|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|EACCES|EAI_AGAIN|ENOTFOUND|ENOTCONNECTED|ERR_[A-Z0-9_]+)\b|\b(?:TypeError|ReferenceError|SyntaxError|RangeError|AbortError|SocketError)\b|\bfetch failed\b|\bunhandled\b|stack\s*trace|\btraceback\b|\bexception\b|\bat\s+[\w$.]+\s+\(?[\w./-]+:\d+:\d+\)?|\[object Object\]|\bundefined\b|\bnan\b|[{}<>]|\b(?:groq|api\.groq|openai|anthropic|agiliumtrade|supabase|cloudflare|vercel)\b|\b[a-z0-9.-]*-[\d.]*\d+b(?:-[\w.]+)?\b|\b(?:gpt|llama|mistral|gemma|claude|deepseek)-[\w.]+|\bjson\b|\bnull\b|\bSQLSTATE\b|\bpg_\w+|\bpool\b|\btimeout_ms\b|\bstack\b|\bendpoint\b|\bpayload\b|\bresponse_format\b|\bmax_tokens\b`;

/** A compiled copy, for callers that only need the yes/no. */
export const TECHNICAL_NOTE_PATTERN = new RegExp(TECHNICAL_NOTE_MARKERS, 'i');

/** The sentences this module is allowed to substitute. Anything friendlier comes from the writer, untouched. */

export const FRIENDLY_NOTES = Object.freeze({
  /** AI reader unreachable, a 4xx/5xx from it, a timeout, an empty or unparseable answer. */
  readerUnavailable: 'This signal was saved for review. The platform could not fully read it.',
  /** The broker said no to the order - any retcode, any rejection, any "account cannot trade right now". */
  brokerDeclined: 'The broker declined this order. Check your account and try again.',
  missingStop: 'This signal is missing a Stop Loss, so it was saved for review.',
  missingTarget: 'This signal is missing a take-profit target, so it was saved for review.',
  /** Last resort, when a technical string belongs to no family: honest, and it never invents a cause. */
  generic: 'This signal was saved for review. The platform could not finish processing it.',
});

/*
 * Which family a technical string belongs to, in the order they are tried. The families are chosen by what the
 * text is *about*, because the same code - an `HTTP 502` - is a reading failure when it comes from the reader
 * and a declined order when it comes from the trading server, and the two sentences a trader is owed are not
 * interchangeable.
 *
 * Naming the reader wins over everything: a broker that mentions a model is not a thing, while a reading
 * failure that mentions an order is ordinary copy. After that, a text naming the broker, an order, a position
 * or an account is about money and must not be described as a reading problem. A bare protocol error at the end
 * of the list is still the reader's, because at capture time the reader is the only component that talks to
 * anything.
 */

const READER_SPECIFIC = /AI reader|reading assistant|\bLLM\b|\bAI\b|groq|api\.groq|response_format|max_tokens|\bmodel\b|endpoint|payload/i;
const BROKER = /broker|metaapi|trading server|terminal|retcode|requot|market_closed|trade_disabled|no_money|insufficient|not enough|frozen|locked|stale|spread|declin|reject|position|order|account|volume|symbol|expiry/i;
const READER_GENERIC = /\bHTTP\b|https?:\/\/|\bstatus\s*[:=]\s*\d{3}|\bECONN|\bENOTFOUND|\bEAI_AGAIN|\bETIMEDOUT|\bEACCES|fetch failed|\bsocket\b|\bTLS\b|certificate|\bproxy\b|\bJSON\b|[{}]|\bundefined\b|\bnan\b|traceback|stack\s*trace|TypeError|ReferenceError|SyntaxError|RangeError|Exception/i;

const NOTE_FAMILIES = [
  { note: FRIENDLY_NOTES.readerUnavailable, test: READER_SPECIFIC },
  { note: FRIENDLY_NOTES.brokerDeclined, test: BROKER },
  { note: FRIENDLY_NOTES.missingStop, test: /stop.?loss|\bsl\b/i },
  { note: FRIENDLY_NOTES.missingTarget, test: /take.?profit|\btp\b|target/i },
  { note: FRIENDLY_NOTES.readerUnavailable, test: READER_GENERIC },
];

/**
 * The sentence a card may show: clean text word for word, technical text replaced by the sentence for its
 * family. Kept free of any knowledge of why the text was technical, because this half cannot look it up.
 */
export function friendlySignalNote(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return '';
  if (!isTechnicalNote(raw)) return raw;
  const family = NOTE_FAMILIES.find((entry) => entry.test.test(raw));
  return family ? family.note : FRIENDLY_NOTES.generic;
}

/** Whether a stored sentence carries anything a trader has no use for. The card filters on it; the tests pin it. */
export function isTechnicalNote(value) {
  return typeof value === 'string' && value.trim().length > 0 && TECHNICAL_NOTE_PATTERN.test(value);
}
