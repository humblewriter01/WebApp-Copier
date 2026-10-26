/**
 * The line between what a trader reads and what an operator reads.
 *
 * A captured signal row carries two sentences, and they are not interchangeable. `execution_note` and
 * `parse_error` are rendered on the card, in the Signals tab, on a phone, in front of somebody deciding
 * whether to trust the app with money: they are user-facing. The status code, the provider's response body,
 * the model that failed and the frame that threw are what makes the product debuggable: they belong in the
 * log, in Admin Panel -> System Health, and in `signals.technical_note`, which no user route selects.
 *
 * The reason this is a module and not a convention is that the technical half keeps being *generated* by
 * code far away from the card - the AI reader's HTTP status, the gate's exception message, a broker's
 * retcode text mirrored from a failed job - and every one of those writers is a place the leak comes back.
 * So the text is classified at the moment it is stored, once, by the only function allowed to put a sentence
 * on a signal row, and the raw version is kept beside it instead of thrown away. Nothing is silently
 * dropped: a replaced sentence still says which family the failure came from, and its detail is one admin
 * click away rather than one support ticket away.
 */

/**
 * What makes a string "technical" rather than "written for a trader".
 *
 * Kept as a source string so the client's copy of this rule (`client/src/lib/signal-outcome.js`) can be
 * pinned against it: the two halves read the same database column and must not disagree about what is safe
 * to show, and legacy rows written before this file existed are still on screen today.
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

const FAMILIES = [
  { note: FRIENDLY_NOTES.readerUnavailable, test: READER_SPECIFIC },
  { note: FRIENDLY_NOTES.brokerDeclined, test: BROKER },
  { note: FRIENDLY_NOTES.missingStop, test: /stop.?loss|\bsl\b/i },
  { note: FRIENDLY_NOTES.missingTarget, test: /take.?profit|\btp\b|target/i },
  { note: FRIENDLY_NOTES.readerUnavailable, test: READER_GENERIC },
];

/** Whether a sentence carries anything a trader has no use for (and no way to act on). */
export function isTechnicalNote(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  return TECHNICAL_NOTE_PATTERN.test(value);
}

/**
 * The sentence a signal row may show.
 *
 * Clean text passes through byte for byte - this is not a rewriting layer for copy the product has already
 * chosen, and a test pins that every exported note survives it unchanged. Text that carries a status code,
 * a provider name, a model, a payload or a frame is replaced by the friendliest sentence that is still true
 * of it, chosen by family.
 *
 * @returns {{ text: string, replaced: boolean, original: string|null }} `original` is what to store in
 *          `signals.technical_note` when `replaced` - so the exact reason is never lost, only moved.
 */
export function friendlySignalNote(value, { fallback = FRIENDLY_NOTES.generic } = {}) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return { text: fallback, replaced: false, original: null };
  if (!isTechnicalNote(raw)) return { text: raw, replaced: false, original: null };
  const family = FAMILIES.find((entry) => entry.test.test(raw));
  return { text: family ? family.note : fallback, replaced: true, original: raw.slice(0, 1000) };
}

/**
 * The one-line summary for the admin panel, the log and `signals.technical_note`: the raw text the trader was
 * not shown, on one line, with anything that looks like a credential removed before it is stored.
 *
 * The detail is deliberately assembled here so every writer redacts the same way - a provider response body is
 * exactly the kind of text that comes back containing a token, and a column an admin reads is not where one
 * should end up.
 */
export function describeTechnicalNote(value, { limit = 400 } = {}) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return null;
  const clean = raw
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '[redacted]')
    .replace(/\b(?:gsk_|sk-|pk_|xoxb|AIza)[A-Za-z0-9_-]{6,}/g, '[redacted]')
    .replace(/(authorization|api[-_ ]?key|token|secret|password)(\w*\s*[:=]\s*)[^\s,;]+/gi, '$1$2[redacted]')
    .replace(/\s+/g, ' ')
    .trim();
  return clean.slice(0, Math.max(80, Number(limit) || 400));
}
