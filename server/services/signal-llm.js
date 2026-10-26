/**
 * Layer 2: asking a model to read a message the deterministic parser could not finish.
 *
 * The shape is deliberately small and deliberately suspicious of itself. A regex either found a price or it
 * did not; a model always produces *something*, and the dangerous property of that is not that it is wrong
 * sometimes but that its answer arrives in the right shape - a JSON object with a plausible number in it,
 * which is exactly what an order is built from. So three things are true of every call here:
 *
 *   1. **Refusal is a feature.** Anything unclear comes back `null`, and `null` is what the caller treats as
 *      "a human looks at this". The prompt says so, the validator enforces it, and every failure mode - a
 *      timeout, a non-JSON reply, a model that is gone - lands on the same path as a refusal rather than on
 *      a guess.
 *   2. **A number the message does not contain is not a number.** `entry`, `stop_loss` and `take_profit` are
 *      checked against the values the raw text actually carries. A model that returns 4011.5 for a message
 *      that says "SL 4011,50" passes, because that is the same digits; a model that returns 4011.50 for a
 *      message that never stated a stop does not, and that is the whole difference between a reader and an
 *      author. This is the rule that makes it safe to put a language model in front of a live account.
 *   3. **It only fills gaps.** The caller (`signal-parse-pipeline.js`) decides what may be *done* with an
 *      answer; this file only produces one. Nothing here knows about execution.
 *
 * It speaks the OpenAI chat-completions dialect because that is what Groq's endpoint serves, and it is
 * injected rather than imported so the tests can drive every branch without a network - there is no
 * provider access from this sandbox, which is precisely why `fetchImpl` exists.
 */

import { normalizeSignalNumbers } from './signal-numbers.js';
import { FRIENDLY_NOTES, describeTechnicalNote, friendlySignalNote } from './signal-wording.js';

export const DEFAULT_LLM_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
export const DEFAULT_LLM_MODEL = 'llama-3.1-8b-instant';
/** Below this, the model is not reporting a reading but hedging one, and a hedge is not an instruction. */
export const DEFAULT_MIN_CONFIDENCE = 0.85;
/** Long enough for any real signal, short enough that a wall of marketing cannot spend the context. */
export const DEFAULT_MAX_MESSAGE_CHARS = 2000;
/** A capture loop must never be held open by a third party for longer than this. */
export const DEFAULT_TIMEOUT_MS = 6000;

/** The exact keys the brief asked for, and the only keys the response is believed to have. */
const FIELDS = ['symbol', 'side', 'entry', 'stop_loss', 'take_profit'];

const SYSTEM_PROMPT = [
  'You read Telegram trading signals and report only what the message states.',
  'Your reply is the raw JSON object and nothing else: its first character is "{", its last is "}".',
  'Never wrap it in a markdown code fence (no ``` and no ```json), never prefix it with "Here is", never add a sentence after it. Any character outside the braces can discard a trade.',
  'Answer with exactly these keys:',
  '{"symbol": string|null, "side": "buy"|"sell"|null, "entry": number|null, "stop_loss": number|null, "take_profit": number|null, "confidence": number}',
  'Rules, in order of importance:',
  '- Copy numbers exactly as the message writes them and return them as plain decimals (1085.50, not "1,085.50", not "$1085.50"). Never convert, estimate, average, extend or infer a number that is not written in the message.',
  '- If a field is absent, unclear, contradictory or needs arithmetic to obtain, return null for it. Null is the correct answer far more often than a guess, and a guessed price causes a real trade.',
  '- symbol is only reported when the message names the instrument. Use the broker form: XAUUSD for gold, XAGUSD for silver, UKOIL for Brent, USOIL for WTI, US30 for the Dow, NAS100 for the Nasdaq 100, US500 for the S&P 500, GER40 for the DAX, BTCUSD, ETHUSD, or a six-letter currency pair such as EURUSD or GBPJPY.',
  '- side is "buy" for BUY, LONG or CALL and "sell" for SELL, SHORT or PUT. A message that says both is contradictory: return null for every field and confidence 0.',
  '- If the text is a news headline or market commentary rather than a trade instruction, return null for the direction. "JUST IN", "breaking", "report", "headline", "news", a market "dumping" or a price that "falls under" or "rises above" a level are reporting what happened, not telling anyone what to do: return null for side, and null for any other field the message does not state as an instruction. A direction must never be chosen from the tone of a headline.',
  '- An entry of "now", "market" or "current price" means entry null. That is not a missing value; do not fill it in.',
  '- A message about a position that is already open is not an entry instruction. "TP 1 HIT", "close now", "close half", "set BE", "SL to entry" and "+50 PIPS" describe how a trade finished or how it is being managed: return null for side, and never turn an instruction to close into a direction to open. A numbered target ("TP 1", "TP2 ✅") is the index of a level, not a price.',
  '- A target or stop given in pips or points is a distance, not a price: return null for that field.',
  '- confidence is how sure you are that this message is a trade instruction and that you read it correctly: 1 only when every value you returned is written in the message in plain form.',
  'Output format, restated because it is the only part of this brief with no second chance: one JSON object, unquoted, unescaped, unfenced, on its own.',
].join('\n');

function numberValue(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

/**
 * How this deployment is configured, decided once and explained.
 *
 * The three variables the operator sets are `LLM_API_KEY`, `LLM_API_URL` and `LLM_MODEL_NAME`; everything
 * else has a working default, because the commonest reason a fallback layer stays switched off forever is a
 * required variable nobody remembered to name. A missing key is not an error - it is the documented state of
 * "Layer 1 only", and the caller keeps going.
 */
export function llmConfig(env = process.env, defaults = {}) {
  const apiKey = String(env.LLM_API_KEY ?? '').trim();
  const url = String(env.LLM_API_URL ?? defaults.url ?? DEFAULT_LLM_API_URL).trim();
  const model = String(env.LLM_MODEL_NAME ?? defaults.model ?? DEFAULT_LLM_MODEL).trim();
  const timeoutMs = Number(env.LLM_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  const minConfidence = Number(env.LLM_MIN_CONFIDENCE ?? DEFAULT_MIN_CONFIDENCE);
  const config = {
    apiKey: apiKey || null,
    url: url || DEFAULT_LLM_API_URL,
    model: model || DEFAULT_LLM_MODEL,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.min(timeoutMs, 30_000) : DEFAULT_TIMEOUT_MS,
    minConfidence: Number.isFinite(minConfidence) && minConfidence > 0 && minConfidence <= 1 ? minConfidence : DEFAULT_MIN_CONFIDENCE,
    maxChars: Number.isFinite(Number(env.LLM_MAX_MESSAGE_CHARS)) ? Math.max(200, Number(env.LLM_MAX_MESSAGE_CHARS)) : DEFAULT_MAX_MESSAGE_CHARS,
  };
  if (!config.apiKey) return { ...config, enabled: false, disabledReason: 'no API key' };
  if (!/^(https?):\/\//i.test(url)) return { ...config, enabled: false, disabledReason: 'the configured endpoint is not an http(s) URL' };
  return { ...config, enabled: true, disabledReason: null };
}

/**
 * What may be said out loud about this configuration: which model, which endpoint host, no secret.
 *
 * The admin health panel needs to answer "is my `LLM_MODEL_NAME` actually the thing being asked" without
 * anybody reading a Render log line or, worse, printing a key. The model name and the host are not secrets -
 * the endpoint is public - and the key never leaves `llmConfig`.
 */
export function describeLlmConfig(config = llmConfig()) {
  let host = null;
  try { host = new URL(config?.url || '').host || null; } catch { host = null; }
  return {
    enabled: config?.enabled === true,
    model: config?.model || null,
    host,
    timeoutMs: config?.timeoutMs ?? null,
    minConfidence: config?.minConfidence ?? null,
    disabledReason: config?.disabledReason || null,
  };
}

/**
 * Whether this message is worth a request.
 *
 * Only signal-shaped text is: something in it looked like a trade instruction (a direction, a symbol, a
 * price or a marked level) and Layer 1 could not finish reading it. A "good morning" or a VIP advertisement
 * has neither, and sending those to the model would spend a rate limit on a non-signal while teaching the
 * pipeline to trade on anything with an imperative verb in it. A message Layer 1 identified as market news is
 * refused for the same reason with the opposite shape: it *looks* like a signal - instruments and prices, all
 * day long - which is exactly why a model must not be handed it and asked what trade it implies.
 */
export function needsLayer2(parsed) {
  if (!parsed) return false;
  /* A message Layer 1 classified as market news is not an unfinished signal, and asking a model about it is
     how a headline ends up with a direction attached: the model is paid to find a trade, it will find one.
     Refusing the request outright is cheaper and surer than hoping the answer is cautious. */
  if (parsed.newsOnly === true || parsed.managementUpdate === true) return false;
  const complete = parsed.executionReady === true && parsed.missing
    && parsed.missing.stopLoss === false && parsed.missing.takeProfit === false && parsed.missing.entryPrice === false;
  if (complete) return false;
  /* A direction and a price, in any combination, is a message about a trade. A symbol on its own is not:
     a channel's disclaimer, its VIP pitch and its member count all name instruments, and sending those to a
     model would spend the rate limit on text nobody intends to trade. This gate is what keeps the fallback
     layer at zero cost for hype while still firing the moment a real signal cannot be read. */
  return Boolean(parsed.hasPriceLevel && (parsed.side || parsed.symbol));
}

/**
 * The prompt pair. The message is passed exactly as captured - not the sanitised copy - because the model's
 * whole job is to read the messy version, and the emoji it would have thrown away are how a channel marks a
 * level ("🎯 4050").
 */
export function buildMessages(message, config = {}) {
  const maxChars = config.maxChars ?? DEFAULT_MAX_MESSAGE_CHARS;
  const text = String(message ?? '').slice(0, maxChars);
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: `Message:\n"""\n${text}\n"""` },
  ];
}

/**
 * Remove a markdown code fence, and the BOM, from a reply that was meant to be JSON.
 *
 * The fence is the model being polite: chat models are trained on answers that put code in a block, and the
 * object inside is exactly what was asked for. Anything outside the block is the model's own framing and is
 * discarded, because a sentence is never a price. A reply with an *opening* fence and no closing one is not
 * repaired - that is a truncated answer, and truncation is where a field goes missing.
 *
 * Taking the block rather than letting it be found by the brace walk below is the point: `extractJsonObject`
 * prefers the last object in a reply, so without this step an example the model waved at *after* its answer
 * would outrank the answer. Inside the fence is what the model meant to send.
 */
function stripJsonFence(text) {
  const trimmed = String(text ?? '').trim().replace(/^\uFEFF/, '');
  if (!trimmed.includes('`')) return trimmed;
  const closed = trimmed.match(/```[ \t]*(?:json|JSON|javascript|js)?[ \t]*\r?\n([\s\S]*?)\r?\n?[ \t]*```/);
  if (closed) return closed[1].trim();
  const opened = trimmed.match(/```[ \t]*(?:json|JSON|javascript|js)?[ \t]*\r?\n?([\s\S]*)$/);
  if (opened && !/```/.test(opened[1])) return opened[1].trim();
  return trimmed;
}

/**
 * Every top-level `{...}` in the text, in order, with strings and escapes respected.
 *
 * Scanning by brace depth rather than "first brace to last brace" - which is what this used to do - is what
 * makes the two shapes a chatty model produces readable: an example object shown before the answer, and a
 * stray brace in the closing sentence. A depth walk finds the objects and ignores the manners, and a reply
 * whose last object never closes is returned as the broken slice it is, so the caller can refuse it rather
 * than parse half a trade.
 */
function topLevelObjects(text) {
  const found = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') {
      if (depth === 0) start = index;
      depth += 1;
    } else if (char === '}') {
      if (depth === 0) continue;
      depth -= 1;
      if (depth === 0 && start !== -1) {
        found.push(text.slice(start, index + 1));
        start = -1;
      }
    }
  }
  if (depth > 0 && start !== -1) found.push(text.slice(start));
  return found;
}

const tryParseObject = (text) => {
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch { return null; }
};

/**
 * The JSON object inside whatever came back.
 *
 * A strict `JSON.parse` on a model reply is a refusal that looks like a model failure, and a refusal on this
 * path costs somebody a trade they described correctly. So the frame comes off first - fence, byte-order
 * mark, the sentence before the braces, the sentence after - and the contents are then parsed strictly. The
 * answer is taken as the *last* object in the reply rather than the first, because a model that shows an
 * example writes the answer after it. The one tolerance inside the braces is a trailing comma before `}` or
 * `]`, which is a syntax slip that cannot change a number; nothing else is repaired, because the next step
 * after being helpful about syntax is being helpful about prices, and that is the line this layer exists to
 * hold.
 */
export function extractJsonObject(content) {
  const text = stripJsonFence(content);
  if (!text) return null;
  const direct = tryParseObject(text);
  if (direct) return direct;
  const candidates = topLevelObjects(text);
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const parsed = tryParseObject(candidates[index]) ?? tryParseObject(candidates[index].replace(/,\s*([}\]])/g, '$1'));
    if (parsed) return parsed;
  }
  return null;
}

/** Every number the message itself states, after the same normalisation Layer 1 reads. */
export function numbersInText(message) {
  const normalized = normalizeSignalNumbers(message).text;
  const values = new Set();
  for (const match of normalized.matchAll(/\d+(?:\.\d+)?/g)) {
    const value = Number(match[0]);
    if (Number.isFinite(value) && value > 0) values.add(Number(value.toFixed(6)));
  }
  return values;
}

const sameNumber = (values, value) => {
  if (values.has(Number(value.toFixed(6)))) return true;
  // A model that rounds `1.08450` to `1.0845` or writes `4011.5` for `4011.50` said the same number; a
  // tenth of a percent is the width allowed for that, and nothing more.
  for (const candidate of values) {
    if (Math.abs(candidate - value) / Math.max(candidate, value) <= 0.001) return true;
  }
  return false;
};

/**
 * What the model reported, and whether it is allowed to be believed.
 *
 * `refused` with a `reason` is a normal outcome, not an exception: low confidence, a missing symbol or side,
 * an unusable type, or a price that is not in the message. Each has its own code because each is a different
 * sentence for the reader - and "the model invented a price" must never be described as "the message was
 * unclear", because the second tells a user to fix their channel and the first tells us to fix our code.
 */
export function validateExtraction(json, { rawMessage, config = {} } = {}) {
  const minConfidence = config.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    return { ok: false, code: 'malformed', reason: 'The AI reader did not return a usable answer.' };
  }
  const confidence = Number(json.confidence);
  const side = String(json.side ?? '').trim().toLowerCase();
  const symbol = String(json.symbol ?? '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');

  if (!Number.isFinite(confidence) || confidence < minConfidence) {
    return { ok: false, code: 'low-confidence', reason: `The AI reader was not confident enough to rely on (it reported ${Number.isFinite(confidence) ? `${Math.round(confidence * 100)}%` : 'no confidence at all'}; this signal needs ${Math.round(minConfidence * 100)}%).`, confidence: Number.isFinite(confidence) ? confidence : null };
  }
  if (!symbol) return { ok: false, code: 'missing-symbol', reason: 'The AI reader could not identify the instrument, so this signal was saved for review.', confidence };
  if (side !== 'buy' && side !== 'sell') {
    return { ok: false, code: 'missing-side', reason: side && side !== 'buy' && side !== 'sell'
      ? `The AI reader reported a direction ("${side}") that is not a buy or a sell, so this signal was saved for review.`
      : 'The AI reader could not tell buy from sell, so this signal was saved for review.', confidence };
  }

  const values = numbersInText(rawMessage);
  const prices = {};
  for (const field of FIELDS) {
    if (field === 'symbol' || field === 'side') continue;
    const value = numberValue(json[field]);
    if (json[field] === null || json[field] === undefined || json[field] === '') { prices[field] = null; continue; }
    if (value === null) return { ok: false, code: 'malformed-price', reason: 'The AI reader returned a price that is not a price, so this signal was saved for review.', confidence };
    if (!sameNumber(values, value)) {
      return {
        ok: false,
        code: 'invented-price',
        reason: `The AI reader reported a price (${value}) that does not appear in the message, so nothing from that reading is used.`,
        confidence,
      };
    }
    prices[field] = value;
  }
  return { ok: true, confidence, fields: { symbol, side, ...prices } };
}

/**
 * Ask the model about one message, and come back with either its fields or a refusal.
 *
 * `temperature: 0` because this is transcription, not composition, and the request body is the same four keys
 * the endpoint documents - no `response_format`, whose absence is explained at `llmRequest`.
 *
 * `gate` is the queue in `llm-gate.js`: when one is supplied the request is made through it, so a burst of
 * catch-up work cannot hold the endpoint away from a live capture. Without a gate (the manual save path, every
 * test that has no interest in queueing) the request is simply made. A gate that refuses is not an error: it
 * returns the same `{ ok: false }` shape as a timeout, which is what makes "the reader was busy" land on the
 * row as a review flag rather than as a failed capture.
 */
/**
 * Pulls the provider's own explanation out of a failure body, for the admin-only copy of this incident.
 *
 * Groq (and anything else speaking this dialect) answers a bad request with `{"error":{...,"message":"..."}}`.
 * The message is the useful part and the JSON around it is not: the operator wants `model_not_found`, not a
 * payload, and the trader wants neither.
 */
function providerErrorHint(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  try {
    const parsed = JSON.parse(text);
    const error = parsed?.error;
    const hint = typeof error === 'string' ? error : (error?.message || error?.code || error?.type || null);
    return hint ? String(hint).replace(/\s+/g, ' ').trim().slice(0, 200) : null;
  } catch {
    // Not JSON: the first line of whatever came back is still better than nothing, when it is short enough.
    const line = String(text).replace(/\s+/g, ' ').trim();
    return line.length > 0 && line.length <= 200 ? line : null;
  }
}

/* The last time this process could not consult the reader, with the reason the rows are not allowed to carry.
   Process state on purpose: it is a statement about *this instance*, it must be answerable without a database
   round-trip while a signal is failing right now, and it is read only by Admin Panel -> System Health. */
let lastReaderFailure = null;

/** What the panel shows beside the queue stats. Never part of a signal row or a user-facing payload. */
export function describeLastReaderFailure() {
  return lastReaderFailure ? { ...lastReaderFailure } : null;
}

/** One line per unreadable signal, with the detail the card is not allowed to carry. Never a second copy. */
function logReaderFailure(logger, result, priority) {
  /* A reader that is switched off and a reader that is busy are reported by the health row as states, not as
     failures; only a request that was actually made and did not produce a reading belongs here. */
  if (result && result.ok !== true && result.code !== 'disabled' && result.code !== 'gated' && (result.technical || result.code)) {
    lastReaderFailure = {
      code: result.code || 'unknown',
      technical: result.technical || null,
      model: result.model || null,
      queue: priority || 'realtime',
      at: new Date().toISOString(),
    };
  }
  if (!logger || !result || result.ok === true || !result.technical) return;
  try {
    logger.warn?.(JSON.stringify({
      level: 'warn',
      message: `[Parser] The AI reader could not be consulted (${result.code})`,
      technical: result.technical,
      queue: priority,
      model: result.model || null,
    }));
  } catch { /* a logger that cannot format a line is not a reason to lose a signal */ }
}

export async function llmParseSignal(message, input = {}) {
  const result = await readSignalWithModel(message, input);
  if (result?.ok !== true) logReaderFailure(input.logger, result, input.priority);
  return result;
}

async function readSignalWithModel(message, { config, fetchImpl = globalThis.fetch, gate = null, priority = 'realtime' } = {}) {
  // `disabledReason` names variables and endpoints, which is admin-facing information; it is kept on
  // `technical` and never put on a sentence the trader reads.
  if (!config?.enabled) {
    return {
      ok: false,
      code: 'disabled',
      reason: FRIENDLY_NOTES.readerUnavailable,
      technical: describeTechnicalNote(config?.disabledReason || 'the AI reading assistant is not configured'),
    };
  }
  // No logger here on purpose: the one line per failure is written by `llmParseSignal` through
  // `logReaderFailure`, which is also where the record the admin card reads is kept. A second copy in the
  // request would only double the noise when the provider is down.
  const request = () => llmRequest(message, { config, fetchImpl });
  if (!gate) return request();
  const slot = await gate.run(request, { priority });
  if (slot?.ok !== true) {
    // The gate's own reasons are already written for a trader; `technical` is only what the slot carried.
    const note = friendlySignalNote(slot?.reason, { fallback: 'The AI reader was busy, so this signal was saved for review.' });
    return { ok: false, code: slot?.code || 'gated', reason: note.text, technical: note.original || describeTechnicalNote(slot?.technical) };
  }
  return slot.value;
}

/**
 * The call itself.
 *
 * There is deliberately no `response_format` in this body, and that is a fix rather than a simplification. The
 * parameter asks the endpoint to enforce JSON for us, which sounds free until a model does not implement it:
 * Groq answers that request with `HTTP 400 - Failed to validate JSON`, and the previous version of this file
 * recovered from that by retrying without the parameter *when the error text named it*. Groq's text does not -
 * it complains about the JSON, not about the key - so the retry never fired, every Layer 2 read in the fleet
 * returned `http-error`, and every message the regex could not finish was written as "The platform could not
 * fully read it" while the provider had in fact refused the envelope, not the reading. A format this code
 * cannot predict the error text for is a format that fails silently and permanently.
 *
 * So the contract is the prompt plus the parser, and it is one-sided on purpose: we ask for an object, and we
 * accept one wherever it is buried (`extractJsonObject` strips fences, prose and the model's own hedging).
 * Nothing here can be rejected by a provider's idea of a valid request, which is the only guarantee worth
 * having on a path where a refusal costs someone an entry.
 */
async function llmRequest(message, { config, fetchImpl = globalThis.fetch } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  const payload = JSON.stringify({
    model: config.model,
    temperature: 0,
    max_tokens: 300,
    messages: buildMessages(message, config),
  });
  const send = async () => {
    const response = await fetchImpl(config.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${config.apiKey}` },
      body: payload,
      signal: controller.signal,
    });
    const text = await response.text().catch(() => '');
    return { ok: response.ok, status: response.status, text };
  };

  try {
    const result = await send();
    if (!result.ok) {
      /* The status code and the provider's body are the only things that make this debuggable, and they are
         not things a trader can act on: the sentence says what happened to their signal, the detail goes to
         `technical`, which the log, the admin panel and `signals.technical_note` each read. */
      return {
        ok: false,
        code: 'http-error',
        status: result.status,
        reason: FRIENDLY_NOTES.readerUnavailable,
        model: config.model,
        technical: describeTechnicalNote(`The AI reader answered HTTP ${result.status} for model ${config.model} at ${config.url}${providerErrorHint(result.text) ? `: ${providerErrorHint(result.text)}` : ''}.`),
      };
    }
    let content;
    try {
      const payload = JSON.parse(result.text);
      content = payload?.choices?.[0]?.message?.content;
      if (content === undefined || content === null) {
        return { ok: false, code: 'empty-reply', reason: FRIENDLY_NOTES.readerUnavailable, technical: describeTechnicalNote('The AI reader returned an answer with no content in it.') };
      }
    } catch {
      return { ok: false, code: 'malformed-reply', reason: FRIENDLY_NOTES.readerUnavailable, technical: describeTechnicalNote(`The AI reader returned something that was not an answer: ${result.text.slice(0, 200)}`) };
    }
    return validateExtraction(extractJsonObject(typeof content === 'string' ? content : JSON.stringify(content)), { rawMessage: message, config });
  } catch (error) {
    const aborted = error?.name === 'AbortError' || controller.signal.aborted;
    // Both halves are the same event as far as the trader is concerned - the reading did not arrive - so both
    // get the same sentence. The seconds, the error name and its message are the operator's half.
    return {
      ok: false,
      code: aborted ? 'timeout' : 'request-failed',
      reason: FRIENDLY_NOTES.readerUnavailable,
      technical: describeTechnicalNote(aborted
        ? `The AI reader did not answer within ${Math.round(config.timeoutMs / 1000)} seconds.`
        : `The request to the AI reader failed: ${error?.message || error?.name || error || 'unknown error'}`),
    };
  } finally {
    clearTimeout(timer);
  }
}
