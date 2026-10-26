/**
 * What a trader is allowed to read on a signal row.
 *
 * The rule this file exists to enforce is short: `signals.execution_note` and `signals.parse_error` are rendered
 * on the card, so they carry a sentence about what happened and never the machinery behind it - no status code,
 * no provider endpoint, no model name, no payload, no stack. The exact reason is kept, in the log, in
 * `signals.technical_note` (which the admin panel alone reads), and in Admin Panel -> System Health -> AI reading
 * assistant, where an operator is the reader.
 *
 * Three kinds of check are here because the leak has three shapes: a writer that says the wrong thing (the
 * source sweep over every literal that can become a note), a writer far away from the card that hands up
 * somebody else's text - an HTTP status, a provider body, a thrown exception (the real-path cases below drive
 * `parseSignalTwoLayer` with a failing endpoint), and text that is already in the database from before the rule
 * existed (the client's own copy, pinned in `client/test/user-note-language.test.mjs`).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { FRIENDLY_NOTES, describeTechnicalNote, friendlySignalNote, isTechnicalNote, TECHNICAL_NOTE_MARKERS } from '../services/signal-wording.js';
import { EXECUTION_BLOCKER_NOTES } from '../services/signal-outcome.js';
import { describeLastReaderFailure, llmConfig, llmParseSignal } from '../services/signal-llm.js';
import { parseSignalTwoLayer } from '../services/signal-parse-pipeline.js';
import { captureSafety } from '../services/signal-safety.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const read = (relative) => readFileSync(new URL(relative, import.meta.url), 'utf8');

/** The user's own rule, verbatim, plus the shapes the same class of leak takes. */
const FORBIDDEN_IN_USER_NOTE = /HTTP|api\.groq|gpt-oss|stack|groq\.com|openai\.com|traceback|TypeError|ReferenceError|ECONN|ETIMEDOUT|ENOTFOUND|retcode|retCode|\{\}|<anonymous>|\bundefined\b|not configured/i;

/* ------------------------------------------------------------------- the mapping, on its own terms */

test('a note that carries internals is replaced, and every family maps to its own sentence', () => {
  const cases = [
    ['The AI reader could not be reached (HTTP 400).', FRIENDLY_NOTES.readerUnavailable, 'the exact string from the screenshot'],
    ['The AI reader timed out after 6 seconds (ECONNRESET) while reading EURUSD.', FRIENDLY_NOTES.readerUnavailable, 'a provider timeout, with the retry detail kept aside'],
    ['MetaAPI returned HTTP 502 (ECONNRESET) while the order was in flight.', FRIENDLY_NOTES.brokerDeclined, 'and the same status code from the trading server is a declined order, not a reading failure'],
    ['reader failed: TypeError: fetch failed at node:internal/deps/undici/undici:11616:19', FRIENDLY_NOTES.readerUnavailable, 'an exception with a frame in it'],
    ['The model gpt-oss-20b at https://api.groq.com/openai/v1/chat/completions returned {"error":{"code":"model_overloaded"}}', FRIENDLY_NOTES.readerUnavailable, 'model name, endpoint and payload together'],
    ['Trade failed: TRADE_RETCODE_REQUOTE (10004)', FRIENDLY_NOTES.brokerDeclined, 'a broker retcode reads as a declined order'],
    ['MetaAPI rejected the market order (10006).', FRIENDLY_NOTES.brokerDeclined, 'a numeric rejection code, likewise'],
    ['The signal needs a stop loss (code: stop-loss-missing)', FRIENDLY_NOTES.missingStop, 'a missing leg keeps naming the leg'],
    ['Missing take-profit (code: take-profit-missing)', FRIENDLY_NOTES.missingTarget, 'as the target does'],
    ['SQLSTATE[HY000]: connection pool exhausted', FRIENDLY_NOTES.generic, 'and something with no family at all says only that it could not be finished'],
  ];
  for (const [technical, expected, why] of cases) {
    assert.equal(isTechnicalNote(technical), true, `${why}: the input is recognised as technical`);
    const result = friendlySignalNote(technical);
    assert.equal(result.text, expected, why);
    assert.equal(FORBIDDEN_IN_USER_NOTE.test(result.text), false, `${why}: the replacement is clean`);
    assert.equal(result.replaced, true);
    assert.ok((result.original || '').length > 0, `${why}: the raw text travels with it`);
  }
});

test('clean copy is passed through word for word, because this is a filter and not a rewriting layer', () => {
  const friendly = [
    ...EXECUTION_BLOCKER_NOTES,
    ...Object.values(FRIENDLY_NOTES),
    'This signal was saved for review and is not eligible for automatic execution.',
    'Only the AI reading assistant could make sense of this message, so it was saved for review and will not be traded automatically.',
    'The AI reader is already catching up on this channel, so this message was left for review.',
    'The signal has no stop loss, and your workspace requires one before an order is sent.',
    'Your Safety settings require a take-profit target, and this signal does not carry one.',
    'This message is market news rather than a trade instruction, so nothing was taken from it.',
    'This message manages a trade that is already open - a target hit, a stop moved to break even, or an instruction to close - rather than giving a new entry, so nothing was taken from it.',
  ];
  for (const text of friendly) {
    const result = friendlySignalNote(text);
    assert.equal(result.replaced, false, `"${text}" is not technical`);
    assert.equal(result.text, text, 'and is therefore untouched');
    assert.equal(result.original, null, 'with nothing hidden away');
  }
  assert.equal(friendlySignalNote('', { fallback: 'a' }).text, 'a', 'an empty sentence takes the caller\'s fallback');
  assert.equal(friendlySignalNote(null).text, FRIENDLY_NOTES.generic);
});

test('the sentences the filter may produce are themselves clean, in both languages', () => {
  const serverSentences = [...Object.values(FRIENDLY_NOTES), ...EXECUTION_BLOCKER_NOTES];
  for (const text of serverSentences) {
    assert.equal(FORBIDDEN_IN_USER_NOTE.test(text), false, `no user-facing sentence may match the forbidden rule: ${text}`);
    assert.equal(isTechnicalNote(text), false, `and none may be flagged by the filter it goes through: ${text}`);
  }
  // `user-note.js`, not `signal-outcome.js`: the rule was lifted out of the signal module the moment a trade
  // row and an account note needed the same filter, and `signal-outcome.js` re-exports it from there.
  const clientSource = read('../../client/src/lib/user-note.js');
  for (const text of serverSentences) {
    if (Object.values(FRIENDLY_NOTES).includes(text)) {
      assert.ok(clientSource.includes(text), `the client's copy knows the sentence "${text}"`);
    }
  }
  // The two halves read the same column, so they must flag it by the same rule. The marker source is compared as
  // text because the client is a separate bundle and cannot import this file.
  const clientMarkers = /export const TECHNICAL_NOTE_MARKERS = String\.raw`([\s\S]*?)`;/.exec(clientSource);
  assert.ok(clientMarkers, 'the client declares the same rule');
  assert.equal(clientMarkers[1], TECHNICAL_NOTE_MARKERS, 'character for character');
});

/* ---------------------------------------------------------------- the writers, driven for real */

const CONFIG = llmConfig({ LLM_API_KEY: 'gsk_test_key' });
/** A message Layer 1 cannot finish, so the reading assistant is consulted and the failure path is reachable. */
const NEEDS_MODEL = 'BUY EURUSD Entry 1.0850 TP 1.0950 - stop should be 1.0800';

function response({ ok = true, status = 200, text = '' }) {
  return async () => ({ ok, status, text: async () => text });
}

/** The whole capture sequence for one hostile endpoint: parse, safety, and the sentences a row would carry. */
async function captureWith(fetchImpl, config = CONFIG) {
  const { parsed, review, provenance } = await parseSignalTwoLayer(NEEDS_MODEL, {
    source: 'telegram', config, fetchImpl, logger: { warn() {}, info() {} },
  });
  const safety = captureSafety({ parsed, source: 'telegram', settings: {}, review });
  return { parsed, review, provenance, safety, parseError: safety.parseError, technical: safety.technicalNote };
}

test('every way the reading endpoint can fail puts a clean sentence on the row and the reason beside it', async () => {
  const failures = [
    { label: 'HTTP 400 with a provider body', fetchImpl: response({ ok: false, status: 400, text: '{"error":{"message":"The model `gpt-oss-20b` does not exist or you do not have access to it."}}' }) },
    { label: 'HTTP 429 from the endpoint', fetchImpl: response({ ok: false, status: 429, text: 'rate limit exceeded, retry in 21 seconds' }) },
    { label: 'HTTP 500 with an HTML error page', fetchImpl: response({ ok: false, status: 500, text: '<html><body>502 Bad Gateway</body></html>' }) },
    { label: 'a body that is not JSON', fetchImpl: response({ ok: true, status: 200, text: 'upstream connect error or disconnect/reset before headers' }) },
    { label: 'an answer with no content', fetchImpl: response({ ok: true, text: JSON.stringify({ choices: [{ message: {} }] }) }) },
    { label: 'a thrown transport error', fetchImpl: async () => { throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }); } },
    { label: 'an abort (the request outlived its budget)', fetchImpl: async (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }), configOverride: { timeoutMs: 5 } },
  ];
  for (const entry of failures) {
    const config = entry.configOverride ? { ...CONFIG, ...entry.configOverride } : CONFIG;
    const { safety, parseError, technical } = await captureWith(entry.fetchImpl, config);
    assert.equal(safety.executionReady, false, `${entry.label}: nothing is tradable from a message that could not be read`);
    assert.equal(safety.reviewRequired, true, `${entry.label}: and the row is marked for a person`);
    assert.equal(parseError, 'This signal was saved for review. The platform could not fully read it.', entry.label);
    assert.equal(FORBIDDEN_IN_USER_NOTE.test(parseError), false, `${entry.label}: the sentence on the card carries no internals`);
    assert.ok(typeof technical === 'string' && technical.length > 0, `${entry.label}: the reason is still recorded, for the admin half`);
  }
});

test('the capture sweep above is reached through the same object the row is written from', async () => {
  // `captureSafety` is the last function to touch the sentence before it becomes a column, so the two must be
  // the same string: a pipeline that sanitized into a field nobody writes would be a test passing on air.
  const { safety, review, technical } = await captureWith(response({ ok: false, status: 400, text: '{"error":{"message":"boom" }}' }));
  assert.equal(safety.parseError, review.reason, 'the row shows the pipeline\'s sentence, filtered');
  assert.ok(String(technical).includes('HTTP 400'), 'and the status code is only ever in the technical half');
  assert.equal(/HTTP/.test(safety.parseError), false);
});

test('the credential in a provider response never reaches the technical column either', async () => {
  const leaked = `{"error":{"message":"invalid api key gsk_abcdefghijklmnopqrstuv used by bearer sk-proj-abcdefghij"}}`;
  const { technical } = await captureWith(response({ ok: false, status: 401, text: leaked }));
  assert.equal(/gsk_|sk-proj/.test(String(technical)), false, 'the key is redacted wherever the detail is stored');
  assert.match(String(technical), /HTTP 401/, 'while the part an operator needs survives');
  assert.equal(describeTechnicalNote('authorization: Bearer gsk_secretvalue here'), 'authorization: [redacted] here');
});

test('the admin panel is told the last time the reader could not be consulted, and not told when it is off', async () => {
  const before = describeLastReaderFailure();
  const failure = await llmParseSignal(NEEDS_MODEL, { config: CONFIG, fetchImpl: response({ ok: false, status: 400, text: '{"error":{"message":"nope"}}' }) });
  assert.equal(failure.reason, FRIENDLY_NOTES.readerUnavailable, 'the trader-facing half');
  const after = describeLastReaderFailure();
  assert.equal(after.code, 'http-error', 'the panel sees the code');
  assert.match(after.technical, /HTTP 400/);
  assert.equal(after.model, CONFIG.model, 'and the model the request was actually made against');
  assert.ok(Date.parse(after.at) > 0, 'and when');
  const disabled = await llmParseSignal(NEEDS_MODEL, { config: { ...CONFIG, enabled: false, disabledReason: 'LLM_API_KEY is not set on this service' } });
  assert.equal(disabled.ok, false);
  assert.equal(disabled.reason, FRIENDLY_NOTES.readerUnavailable, 'a switched-off reader is still not a sentence about variables');
  assert.equal(/LLM_API_KEY/.test(disabled.reason), false);
  assert.equal(describeLastReaderFailure().code, after.code, 'and a disabled reader is not recorded as a failure of a running one');
  assert.ok(before === null || typeof before === 'object');
});

/* --------------------------------------------------------- the source sweep: no writer may say it */

test('no literal that can become a user-facing note carries internals', () => {
  const scanned = [
    ['../services/signal-outcome.js', /note:\s*'([^']{12,})'/g],
    ['../services/signal-outcome.js', /^export const [A-Z_]+_NOTE = '([^']{12,})';/gm],
    ['../services/signal-wording.js', /^\s+\w+:\s*'([^']{12,})',/gm],
    ['../services/signal-safety.js', /_MESSAGE = '([^']{12,})'/g],
    ['../services/signal-safety.js', /message:\s*'([^']{12,})'/g],
    ['../services/signal-parser.js', /message:\s*'([^']{12,})'/g],
    ['../services/signal-parse-pipeline.js', /reason:\s*'([^']{12,})'/g],
    ['../services/signal-llm.js', /reason:\s*'([^']{12,})'/g],
    ['../services/llm-gate.js', /reason:\s*'([^']{12,})'/g],
    ['../services/execution-engine.js', /stop\(job,\s*'[a-z]+',\s*'([^']{12,})'\)/g],
    ['../services/execution-engine.js', /PLATFORM_PAUSE_MESSAGE = '([^']{12,})'/g],
  ];
  let seen = 0;
  const offenders = [];
  for (const [file, pattern] of scanned) {
    const source = read(file);
    for (const match of source.matchAll(pattern)) {
      seen += 1;
      const literal = match[1];
      if (FORBIDDEN_IN_USER_NOTE.test(literal)) offenders.push(`${file}: ${literal}`);
      if (friendlySignalNote(literal).replaced) offenders.push(`${file}: replaced by the filter - ${literal}`);
    }
  }
  assert.ok(seen >= 30, `the sweep is reading the writers, not scanning nothing (found ${seen} sentences)`);
  assert.deepEqual(offenders, [], 'every sentence any of these modules can put on a row is already free of internals');
});

test('the user route cannot ask for the technical column, because only the admin list selects it', () => {
  const index = read('../index.js');
  const dashboard = index.slice(index.indexOf("app.get('/api/dashboard'"), index.indexOf("app.get('/api/channels'"));
  const signalsStart = index.indexOf("app.get('/api/signals'");
  const signals = index.slice(signalsStart, index.indexOf("\napp.get('", signalsStart + 10));
  assert.equal(dashboard.includes('technical_note'), false, 'the Overview strip does not read it');
  assert.equal(signals.includes('technical_note'), false, 'neither does the Signals tab');
  const schema = read('../db.js');
  assert.match(schema, /ALTER TABLE signals ADD COLUMN IF NOT EXISTS technical_note TEXT;/);
  assert.equal(schema.includes('`technical_note'), false, 'and the statement is written without a backtick, which `SCHEMA_SQL` may never contain');
});

test('the client copy of the rule is the same code, not a paraphrase of it', () => {
  // Three blocks are duplicated across the boundary because the client is a separate bundle: the marker list,
  // the sentences, and the family tests in order. Compared as text, so the drift that would put a status code
  // back on a card is a failing test rather than a support conversation.
  const serverSource = read('../services/signal-wording.js');
  const clientSource = read('../../client/src/lib/user-note.js');
  const slice = (source, from, to) => {
    const start = source.indexOf(from);
    assert.notEqual(start, -1, `${from.slice(0, 42)} is declared`);
    return source.slice(start, source.indexOf(to, start)).trimEnd();
  };
  // Only the rules themselves: each half may document its own entry point in its own words.
  const throughRules = (text) => text.slice(0, text.lastIndexOf('];') + 2);
  assert.equal(
    slice(clientSource, 'export const FRIENDLY_NOTES = Object.freeze({', '/*\n * Which family'),
    slice(serverSource, 'export const FRIENDLY_NOTES = Object.freeze({', '/*\n * Which family'),
    'the same five sentences, in the same order',
  );
  assert.equal(
    throughRules(slice(clientSource, 'const READER_SPECIFIC', 'export function friendlySignalNote'))
      .replace('const NOTE_FAMILIES = [', 'const FAMILIES = ['),
    throughRules(slice(serverSource, 'const READER_SPECIFIC', '/** Whether a sentence')),
    'and the same family rules, tried in the same order - which is what decides whether an HTTP 502 from the trading server reads as a declined order or as a reading failure',
  );
  assert.match(clientSource, /const TECHNICAL_NOTE_PATTERN = new RegExp\(TECHNICAL_NOTE_MARKERS, 'i'\);/, 'the client compiles its copy from the same source string');
});
