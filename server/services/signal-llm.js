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
  'Reply with a single JSON object and nothing else, with exactly these keys:',
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
  'Do not add commentary, markdown, or any text outside the JSON object.',
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
 * The JSON object inside whatever came back.
 *
 * Models wrap JSON in fences, prefix it with "Here is the object:", or trail it with a disclaimer, and a
 * strict `JSON.parse` on that is a refusal that looks like a model failure. So the outermost braces are
 * located and parsed, which is tolerant of the frame and still strict about the contents.
 */
export function extractJsonObject(content) {
  const text = String(content ?? '').trim();
  if (!text) return null;
  const direct = (() => { try { return JSON.parse(text); } catch { return null; } })();
  if (direct && typeof direct === 'object') return direct;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch { return null; }
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
 * One request, one answer, no exceptions thrown.
 *
 * `temperature: 0` because this is transcription, not composition. `response_format: json_object` is sent
 * because endpoints that support it stop writing prose, and dropped on a single retry when the provider says
 * it does not understand the parameter - a request that would otherwise 400 forever and leave the layer
 * silently switched off.
 */
/**
 * Ask the model about one message, and come back with either its fields or a refusal.
 *
 * `gate` is the queue in `llm-gate.js`: when one is supplied the request is made through it, so a burst of
 * catch-up work cannot hold the endpoint away from a live capture. Without a gate (the manual save path, every
 * test that has no interest in queueing) the request is simply made. A gate that refuses is not an error: it
 * returns the same `{ ok: false }` shape as a timeout, which is what makes "the reader was busy" land on the
 * row as a review flag rather than as a failed capture.
 */
export async function llmParseSignal(message, { config, fetchImpl = globalThis.fetch, logger, gate = null, priority = 'realtime' } = {}) {
  if (!config?.enabled) return { ok: false, code: 'disabled', reason: config?.disabledReason || 'not configured' };
  const request = () => llmRequest(message, { config, fetchImpl, logger });
  if (!gate) return request();
  const slot = await gate.run(request, { priority });
  if (slot?.ok !== true) {
    return { ok: false, code: slot?.code || 'gated', reason: slot?.reason || 'The AI reader was busy, so this signal was saved for review.' };
  }
  return slot.value;
}

async function llmRequest(message, { config, fetchImpl = globalThis.fetch, logger } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  const body = (withFormat) => JSON.stringify({
    model: config.model,
    temperature: 0,
    max_tokens: 300,
    ...(withFormat ? { response_format: { type: 'json_object' } } : {}),
    messages: buildMessages(message, config),
  });
  const send = async (withFormat) => {
    const response = await fetchImpl(config.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${config.apiKey}` },
      body: body(withFormat),
      signal: controller.signal,
    });
    const text = await response.text().catch(() => '');
    return { ok: response.ok, status: response.status, text };
  };

  try {
    let result = await send(true);
    if (!result.ok && result.status === 400 && /response_format/i.test(result.text)) {
      logger?.warn?.(JSON.stringify({ level: 'warn', message: '[Parser] The AI endpoint rejected the JSON response format; retrying without it.' }));
      result = await send(false);
    }
    if (!result.ok) {
      return { ok: false, code: 'http-error', status: result.status, reason: `The AI reader could not be reached (HTTP ${result.status}).` };
    }
    let content;
    try {
      const payload = JSON.parse(result.text);
      content = payload?.choices?.[0]?.message?.content;
      if (content === undefined || content === null) return { ok: false, code: 'empty-reply', reason: 'The AI reader returned no answer.' };
    } catch {
      return { ok: false, code: 'malformed-reply', reason: 'The AI reader returned something that was not an answer.' };
    }
    return validateExtraction(extractJsonObject(typeof content === 'string' ? content : JSON.stringify(content)), { rawMessage: message, config });
  } catch (error) {
    const aborted = error?.name === 'AbortError' || controller.signal.aborted;
    return { ok: false, code: aborted ? 'timeout' : 'request-failed', reason: aborted
      ? `The AI reader did not answer within ${Math.round(config.timeoutMs / 1000)} seconds, so this signal was saved for review.`
      : 'The AI reader could not be reached.' };
  } finally {
    clearTimeout(timer);
  }
}
