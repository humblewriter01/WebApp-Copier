/**
 * The two-layer parser, and the four things that make it safe rather than merely clever.
 *
 * Layer 1 reads what a channel wrote; Layer 2 asks a model about the garbled remainder. Both halves are
 * easy to build and easy to trust too much, so the properties pinned here are the ones that decide whether
 * a wrong reading can reach a live account:
 *
 *   - a model may **complete** a signal and may never **create** one;
 *   - a price that is not in the message is not a price;
 *   - a refusal, a timeout, or a missing API key all land on "saved for review", never on a guess;
 *   - and a row that needs review is blocked *even when the workspace has fallback distances set*, because
 *     the fallbacks are there for a leg the channel forgot, not for a number the platform is unsure of.
 *
 * The engine cases run a real job through `createExecutionEngine` against a mocked adapter, so the pip
 * conversion is checked at the moment a number is put on an order - which is the only moment a broker's
 * price step exists to do it with.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseSignal } from '../services/signal-parser.js';
import { llmConfig, needsLayer2, extractJsonObject, validateExtraction, numbersInText, llmParseSignal, buildMessages, DEFAULT_MIN_CONFIDENCE } from '../services/signal-llm.js';
import { parseSignalTwoLayer, mergeGaps } from '../services/signal-parse-pipeline.js';
import { captureSafety, applySafetyNets, pipSizeFor } from '../services/signal-safety.js';
import { createExecutionEngine } from '../services/execution-engine.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const indexSource = readFileSync(path.join(here, '..', 'index.js'), 'utf8');
const schemaSource = readFileSync(path.join(here, '..', 'db.js'), 'utf8');

/** A chat message is complete when Layer 1 read it without help; only then is the fallback layer skipped. */
const CONFIG = llmConfig({ LLM_API_KEY: 'gsk_test_key' });

/** An OpenAI-shaped reply, with the content of the model's choosing. */
const llmReply = (payload) => async () => ({
  ok: true,
  status: 200,
  text: async () => JSON.stringify({ choices: [{ message: { content: typeof payload === 'string' ? payload : JSON.stringify(payload) } }] }),
});

/** Counts calls so "this message cost nothing" is an assertion rather than a hope. */
function countingFetch(reply) {
  const calls = [];
  return {
    calls,
    fetchImpl: async (url, init) => {
      calls.push({ url, init, body: JSON.parse(init.body) });
      return reply();
    },
  };
}

const read = async (text, { fetchImpl = countingFetch(llmReply({})).fetchImpl, config = CONFIG, source = 'telegram' } = {}) =>
  parseSignalTwoLayer(text, { source, config, fetchImpl, logger: { warn() {}, info() {} } });

/* --------------------------------------------------------------------- Layer 1: the formats --------------------------------------------------------------------- */

test('Layer 1 parses a standard signal, and the chaotic variants channels actually send', () => {
  const cases = [
    ['BUY EURUSD\nEntry: 1.0850\nSL: 1.0800\nTP1: 1.0950', { symbol: 'EURUSD', side: 'buy', entryPrice: 1.085, stopLoss: 1.08, takeProfit: 1.095 }],
    ['LONG GOLD 2665.00 SL 2650.00 TP 2700.00', { symbol: 'XAUUSD', side: 'buy', entryPrice: 2665, stopLoss: 2650, takeProfit: 2700 }],
    ['SHORT SILVER 30.50 SL 30.90 TP 29.00', { symbol: 'XAGUSD', side: 'sell', entryPrice: 30.5, stopLoss: 30.9, takeProfit: 29 }],
    ['SELL EURUSD. Entry: 1,0850. SL: 1,0800. TP: 1,0900.', { symbol: 'EURUSD', side: 'sell', entryPrice: 1.085, stopLoss: 1.08, takeProfit: 1.09 }],
    ['BUY XAUUSD @ $4011.50, SL - 4011.00, TP 4050.00', { symbol: 'XAUUSD', side: 'buy', entryPrice: 4011.5, stopLoss: 4011, takeProfit: 4050 }],
    ['BUY GOLD 4015.00, Invalidation: 4011.00, TP 4050.00', { symbol: 'XAUUSD', side: 'buy', entryPrice: 4015, stopLoss: 4011, takeProfit: 4050 }],
    ['BUY EURUSD 1.0850 SL 1.0800 TP 50 pips', { symbol: 'EURUSD', side: 'buy', entryPrice: 1.085, stopLoss: 1.08, takeProfit: null, takeProfitPips: 50 }],
    ['BUY EURUSD 1.0850, 30 pips SL, 50 pips TP', { entryPrice: 1.085, stopLoss: null, stopLossPips: 30, takeProfit: null, takeProfitPips: 50 }],
    ['🚀🔥 BUY XAUUSD NOW! Entry: 4010.00, SL: 4000.00, TP: 4050.00. Join VIP: t.me/join/abc', { symbol: 'XAUUSD', side: 'buy', entryPrice: 4010, stopLoss: 4000, takeProfit: 4050 }],
  ];
  for (const [message, expected] of cases) {
    const parsed = parseSignal(message);
    for (const [field, value] of Object.entries(expected)) {
      assert.equal(parsed[field], value, `${message}\n  ${field}`);
    }
  }
  /* A distance is stored as a distance. Reading `TP 50 pips` as a price of 50.0 produced a target a hundred
     and thirty-two broker rejections deep, and reading it as *absent* would have let a fallback distance
     stand in for the number the trader wrote down. */
  const pips = parseSignal('BUY EURUSD 1.0850 SL 1.0800 TP 50 pips');
  assert.equal(pips.takeProfit, null, 'no price is invented for a leg given in pips');
  assert.equal(pips.missing.takeProfit, false, 'and the leg is not reported missing either');
  assert.equal(pips.executionReady, true, 'so a pip-stated target does make the signal tradeable');
  // Marketing prose and risk warnings are stripped: nothing here is a tradeable signal, and nothing is billed to Layer 2 either.
  assert.equal(parseSignal('⚠️ Risk warning: CFDs are complex instruments. JOIN HERE: https://t.me/x').hasPriceLevel, false);
});

test('an ambiguous number is named, not coin-flipped', () => {
  /* `1,085` means 1.085 to a European channel and 1085 to an American one. The message's own unambiguous
     numbers vote, and a tie is left as a question - because a stop chosen by a coin flip looks exactly like
     a plan right up until it is hit. */
  const settled = parseSignal('BUY GOLD Entry 4,011 SL 4,015.50');
  assert.equal(settled.entryPrice, 4011, 'a neighbour written as 4,015.50 settles the vote the same way');
  assert.equal(settled.stopLoss, 4015.5);
  const tied = parseSignal('BUY EURUSD 1,085 SL 1,080 TP 1,120');
  assert.deepEqual(tied.ambiguousLevels.map((level) => level.raw), ['1,085', '1,080', '1,120']);
  assert.ok(tied.blockers.some((blocker) => blocker.code === 'stop-loss-format'), 'the leg is unreadable, not missing');
  assert.equal(tied.executionReady, false);
});

test('what a real channel sent on a Saturday, read exactly as it arrived', () => {
  /* Quoted from the screenshots a user reported, punctuation and emoji included, because each of these three
     rows was wrong in a different direction: a dashed stop read as no stop, a section heading read as a
     trading symbol, and a win-post read as a signal with a hole in it. */
  const manage = parseSignal('GOLD BUY MORE NOW !\n\nPrice : 4026.00 - 4016.00\n\nSL - 4011.00\nTP - 50Pips / 100Pips\n\nManage Layering And Money Management !');
  assert.equal(manage.symbol, 'XAUUSD', 'the metal, not the word MANAGE from the next line');
  assert.equal(manage.entryPrice, 4026, 'a zone is read, at the bound that is least favourable to a buy');
  assert.equal(manage.stopLoss, 4011, 'a dash is a separator, not a minus sign in front of nothing');
  assert.equal(manage.takeProfitPips, 50, 'two pip targets are a scale-out plan, so the first is the row\'s');
  assert.equal(manage.takeProfit, null, 'and neither number is dressed up as a price');
  assert.equal(manage.executionReady, true);
  assert.equal(manage.parseError, null, 'nothing about this message is missing');

  const winpost = parseSignal('✅ R1 GOLD BUY : 50PIPS\n✅ R2 GOLD BUY : 50PIPS\n✅ R3 GOLD BUY : 70PIPS\n\nWinning streak as usual when you trade with Sir Adrielle right ? So guys, enjoy your profit ! ⚡');
  assert.equal(winpost.side, 'buy', 'the direction is genuine - it is the price that is absent');
  assert.equal(winpost.hasPriceLevel, false, '50PIPS after a role number is a report of a closed trade, not a level to enter at');
  const held = captureSafety({ parsed: winpost, source: 'telegram', settings: { fallbackStopLossPoints: 500, fallbackTakeProfitPoints: 1000, blockExecutionWithoutStopLoss: true, blockExecutionWithoutTakeProfit: true } });
  assert.equal(held.executionReady, false, 'and no fallback turns a win-post into an order');
  assert.match(held.parseError, /states a direction but no price/);

  const chatter = parseSignal('Should I release more setups, guys ? Because I see the tap-tap reactions are so damn slow ! 😔');
  assert.equal(chatter.symbol, null, 'no word in a sentence is a trading symbol');
  assert.equal(chatter.side, null);
  assert.equal(chatter.hasPriceLevel, false);
  assert.equal(needsLayer2(chatter), false, 'and asking a model about it would cost a request to learn nothing');
});

/* --------------------------------------------------------------------- Layer 2: the fallback --------------------------------------------------------------------- */

test('Layer 2 fills a gap Layer 1 could not read, and says that it did', async () => {
  const message = 'BUY EURUSD Entry 1.0850 TP 1.0950 - stop should be 1.0800';
  assert.equal(needsLayer2(parseSignal(message)), true, 'a direction and a price but no leg is exactly what the fallback is for');
  const fetch = countingFetch(llmReply({ symbol: 'EURUSD', side: 'buy', entry: 1.085, stop_loss: 1.08, take_profit: 1.095, confidence: 0.95 }));
  const { parsed, provenance, review } = await read(message, fetch);

  assert.equal(fetch.calls.length, 1, 'one request, sent to the configured endpoint');
  assert.equal(fetch.calls[0].url, 'https://api.groq.com/openai/v1/chat/completions');
  assert.equal(fetch.calls[0].body.model, 'llama-3.1-8b-instant');
  assert.equal(fetch.calls[0].body.temperature, 0, 'this is transcription, not composition');
  assert.equal(fetch.calls[0].init.headers.authorization, 'Bearer gsk_test_key');

  assert.equal(parsed.stopLoss, 1.08, 'the leg the message wrote in prose is the leg the model found');
  assert.equal(parsed.executionReady, true);
  assert.equal(review.required, false, 'a completed signal the deterministic layer also read is not held back');
  assert.equal(provenance.parsedBy, 'llm');
  assert.deepEqual(provenance.filled, ['stopLoss']);
  assert.equal(provenance.confidence, 0.95);
});

test('a complete message never costs a request', async () => {
  const fetch = countingFetch(llmReply({ symbol: 'EURUSD', side: 'buy', entry: 1.085, stop_loss: 1.08, take_profit: 1.095, confidence: 0.99 }));
  const { parsed, provenance } = await read('BUY EURUSD\nEntry: 1.0850\nSL: 1.0800\nTP: 1.0950', fetch);
  assert.equal(fetch.calls.length, 0, 'Layer 1 read every leg, so Layer 2 is not consulted');
  assert.equal(provenance.llmUsed, false);
  assert.equal(parsed.executionReady, true);
});

test('and it never stands in the reader queue, which is the half that costs seconds', async () => {
  /* A request that is never made cannot be queued - but "the queue is not on the fast path" is a property of
     the call site, not of `needsLayer2`, and it is the property a launch depends on. The gate holds at most
     `maxConcurrent` calls open, so a completed signal that had to wait for a slot would be late for a reason
     nothing in the parser could see in its own timings. Counting `gate.run` is what keeps that visible: a
     message Layer 1 finished must never reach it, and a live capture must be served ahead of a replay. */
  const calls = [];
  const gate = {
    async run(task, options = {}) { calls.push(options.priority ?? null); return task(); },
    summary: () => ({ maxConcurrent: 2, active: 0, waiting: { realtime: 0, replay: 0 }, gated: 0 }),
  };
  const fetch = countingFetch(llmReply({ symbol: 'EURUSD', side: 'buy', entry: 1.085, stop_loss: 1.08, take_profit: 1.095 }));
  const complete = await parseSignalTwoLayer('BUY EURUSD\nEntry: 1.0850\nSL: 1.0800\nTP: 1.0950', { source: 'telegram', config: CONFIG, fetchImpl: fetch.fetchImpl, logger: { warn() {}, info() {} }, gate });
  assert.equal(complete.parsed.executionReady, true, 'the deterministic read stands on its own');
  assert.deepEqual(calls, [], 'and no queue entry was made for it');
  assert.equal(fetch.calls.length, 0, 'nor a request');

  const missingLeg = 'BUY EURUSD Entry 1.0850 TP 1.0950 - stop should be 1.0800';
  const live = await parseSignalTwoLayer(missingLeg, { source: 'telegram', config: CONFIG, fetchImpl: fetch.fetchImpl, logger: { warn() {}, info() {} }, gate, priority: 'realtime' });
  assert.deepEqual(calls, ['realtime'], 'the message that needs the model is the one that asks, once');
  assert.equal(live.provenance.llmUsed, true, 'and it is the row that got the answer');
  await parseSignalTwoLayer(missingLeg, { source: 'telegram', config: CONFIG, fetchImpl: fetch.fetchImpl, logger: { warn() {}, info() {} }, gate, priority: 'replay' });
  assert.deepEqual(calls, ['realtime', 'replay'], 'a catch-up replay queues behind it, in its own lane, and is given up on rather than allowed to hold a live signal');
});

test('a price the model invented is refused, and the row goes to review', async () => {
  /* The message states no stop at all. A model that answers 7.77 - a number nowhere in the text - is not
     reading, it is filling a template, and this is the single rule that makes it safe to have a language
     model in front of a live account. */
  const message = 'BUY EURUSD Entry: 1.0850 TP: 1.0950';
  const fetch = countingFetch(llmReply({ symbol: 'EURUSD', side: 'buy', entry: 1.085, stop_loss: 7.77, take_profit: 1.095, confidence: 0.99 }));
  const { parsed, review } = await read(message, fetch);
  assert.equal(review.code, 'invented-price');
  assert.match(review.reason, /does not appear in the message/);
  assert.equal(review.required, true);
  assert.equal(parsed.stopLoss, null, 'and the invented number is nowhere on the row');

  // The same rule at the unit boundary, without a network in the way.
  assert.deepEqual([...numbersInText('Entry: 1.0850, 30 pips')], [1.085, 30]);
  const refused = validateExtraction({ symbol: 'EURUSD', side: 'buy', entry: 1.09, stop_loss: null, take_profit: null, confidence: 1 }, { rawMessage: 'Entry: 1.0850', config: CONFIG });
  assert.equal(refused.ok, false, 'a price rounded into a different number is a different price');
});

test('a reading only the model could produce is saved for review, never traded - even with fallbacks set', async () => {
  /* Decision (a) of the design: the deterministic reading has to supply instrument, direction and a price
     before anything can be tradeable. `GOLD 1.0850` with no direction has none of that for Layer 1, so a
     confident model answer cannot promote it into an order. */
  const layer1 = parseSignal('BUY GOLD Entry: 4011.00 TP: 4050.00');
  const message = 'GOLD Entry: 4011.00 TP: 4050.00 - long';
  assert.notEqual(layer1.symbol, null);
  const fetch = countingFetch(llmReply({ symbol: 'XAUUSD', side: 'buy', entry: 4011, stop_loss: null, take_profit: 4050, confidence: 0.98 }));
  const { parsed, review } = await read(message, fetch);
  const safety = captureSafety({ parsed, source: 'telegram', settings: { fallbackStopLossPoints: 500, fallbackTakeProfitPoints: 1000, blockExecutionWithoutStopLoss: true, blockExecutionWithoutTakeProfit: true }, review });
  assert.equal(review.required, true);
  assert.equal(safety.executionReady, false, 'an AI-completed signal is not eligible, however generous the Safety settings are');
  assert.deepEqual(safety.fallbacks, { stopLoss: null, takeProfit: null }, 'and no fallback distance is offered to it either');
  assert.equal(safety.reviewRequired, true, 'and the row says so, which is what the badge reads');
  assert.match(safety.parseError, /stop loss is required/, 'while the sentence stays the specific one about the missing leg');
});

test('low confidence is a refusal, not a discount', async () => {
  const message = 'BUY EURUSD Entry 1.0850 TP 1.0950 - stop should be 1.0800';
  const fetch = countingFetch(llmReply({ symbol: 'EURUSD', side: 'buy', entry: 1.085, stop_loss: 1.08, take_profit: 1.095, confidence: 0.6 }));
  const { parsed, review } = await read(message, fetch);
  assert.equal(review.required, true);
  assert.equal(review.code, 'low-confidence');
  assert.match(review.reason, new RegExp(`${Math.round(DEFAULT_MIN_CONFIDENCE * 100)}%`));
  assert.equal(parsed.stopLoss, null, 'nothing from a hedged reading is used, not even the leg that looks fine');
});

test('a model that answers in prose still gets read, and a model that does not answer at all is a refusal', async () => {
  const prose = 'Sure! Here is the object:\n```json\n{"symbol":"EURUSD","side":"buy","entry":1.085,"stop_loss":1.08,"take_profit":1.095,"confidence":0.93}\n```';
  assert.deepEqual(Object.keys(extractJsonObject(prose)).sort(), ['confidence', 'entry', 'side', 'stop_loss', 'symbol', 'take_profit'].sort());
  const message = 'BUY EURUSD Entry 1.0850 TP 1.0950 - stop should be 1.0800';
  const { parsed } = await read(message, { fetchImpl: llmReply(prose) });
  assert.equal(parsed.stopLoss, 1.08, 'the fence is the model being polite, not the model being wrong');

  const broken = await llmParseSignal(message, { config: CONFIG, fetchImpl: async () => { throw new Error('socket hang up'); } });
  assert.equal(broken.ok, false);
  assert.equal(broken.code, 'request-failed', 'a transport failure is reported as one, not as a signal with no stop');

  const timedOut = await llmParseSignal(message, { config: { ...CONFIG, timeoutMs: 5 }, fetchImpl: async (_url, init) => new Promise((_resolve, reject) => { init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))); }) });
  assert.equal(timedOut.code, 'timeout');

  const http = await llmParseSignal(message, { config: CONFIG, fetchImpl: async () => ({ ok: false, status: 429, text: async () => 'rate limited' }) });
  assert.equal(http.code, 'http-error');
  assert.equal(http.status, 429, 'the status is kept, because 429 and 401 want different answers from an operator');
});

test('an endpoint that does not know response_format is asked again without it', async () => {
  const bodies = [];
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    if ('response_format' in body) return { ok: false, status: 400, text: async () => 'Unknown parameter: response_format' };
    return llmReply({ symbol: 'EURUSD', side: 'buy', entry: 1.085, stop_loss: 1.08, take_profit: 1.095, confidence: 0.95 })();
  };
  const result = await llmParseSignal('BUY EURUSD Entry 1.0850 TP 1.0950 - stop should be 1.0800', { config: CONFIG, fetchImpl });
  assert.equal(result.ok, true, 'the request is retried once, without the parameter the server objected to');
  assert.equal(bodies.length, 2);
  assert.ok('response_format' in bodies[0] && !('response_format' in bodies[1]));
});

/* --------------------------------------------------------------------- degradation --------------------------------------------------------------------- */

test('no API key means no request, no crash, and an honest sentence on the row', async () => {
  const off = llmConfig({});
  assert.equal(off.enabled, false);
  assert.equal(off.disabledReason, 'no API key');
  let touched = 0;
  const { parsed, review, provenance } = await parseSignalTwoLayer('BUY EURUSD Entry: 1.0850 TP: 1.0950', {
    source: 'telegram',
    config: off,
    fetchImpl: async () => { touched += 1; throw new Error('unreachable'); },
  });
  assert.equal(touched, 0, 'the layer is skipped rather than attempted and failed');
  assert.equal(review.required, true, 'and a signal the platform could not finish is held for a person');
  assert.equal(review.code, 'llm-disabled');
  assert.equal(provenance.parsedBy, 'regex');
  assert.equal(parsed.executionReady, false);
  assert.equal(parsed.parseError, 'A stop loss is required for automatic execution.', 'the refusal quotes the specific missing leg, not a stack of infrastructure worries');
  // The operator finds out at boot, in the log, in the exact wording the brief asked for.
  assert.match(indexSource, /\[Parser\] LLM Fallback disabled \(\$\{parserConfig\.disabledReason\}\)\./);
  assert.match(indexSource, /const parserConfig = llmConfig\(process\.env\)/);
});

test('a note typed by the user is never sent to the model', async () => {
  const fetch = countingFetch(llmReply({ symbol: 'EURUSD', side: 'buy', entry: 1.085, stop_loss: 1.08, take_profit: 1.095, confidence: 0.99 }));
  const { review, provenance } = await read('BUY EURUSD Entry: 1.0850 TP: 1.0950', { ...fetch, source: 'manual' });
  assert.equal(fetch.calls.length, 0);
  assert.equal(review.required, false);
  assert.equal(provenance.parsedBy, 'regex');
});

/* --------------------------------------------------------------------- safety nets --------------------------------------------------------------------- */

test('the workspace fallback completes an under-specified signal, and only that', async () => {
  const parsed = parseSignal('Gold Buy now\n\nSL: 4041.50');
  assert.equal(parsed.missing.takeProfit, true);
  const rescued = captureSafety({ parsed, source: 'telegram', settings: { fallbackTakeProfitPoints: 500, blockExecutionWithoutTakeProfit: true, blockExecutionWithoutStopLoss: true } });
  assert.equal(rescued.executionReady, true, 'a leg the channel forgot is what the nets exist for');
  assert.deepEqual(rescued.fallbacks, { stopLoss: null, takeProfit: 500 }, 'the stated stop is left alone; the absent target gets the net');

  const cleared = captureSafety({ parsed, source: 'telegram', settings: { fallbackTakeProfitPoints: null, blockExecutionWithoutTakeProfit: true, blockExecutionWithoutStopLoss: true } });
  assert.equal(cleared.executionReady, false, 'a user who cleared both nets and left the block on is obeyed, not rescued');
  assert.match(cleared.parseError, /require a take-profit target/);
});

test('a direction with no price anywhere is held, whatever the fallbacks say', () => {
  /* Decision (b): `BUY GOLD` is enthusiasm, not an instruction. Auto-execution needs at least one price
     level in the message, and no default distance may manufacture one. */
  const parsed = parseSignal('BUY GOLD');
  assert.equal(parsed.hasPriceLevel, false);
  const safety = captureSafety({ parsed, source: 'telegram', settings: { fallbackStopLossPoints: 500, fallbackTakeProfitPoints: 1000, blockExecutionWithoutStopLoss: true, blockExecutionWithoutTakeProfit: true } });
  assert.equal(safety.executionReady, false);
  assert.deepEqual(safety.fallbacks, { stopLoss: null, takeProfit: null });
  assert.ok(safety.problems.some((problem) => problem.code === 'no-price-level'));
  assert.match(safety.parseError, /states a direction but no price/);
});

test('a new workspace starts with 500 and 1000, and an existing one is not handed them', () => {
  /* Column defaults are the only mechanism that distinguishes those two groups without an update: a default
     in `ADD COLUMN` backfills every stored row, which would silently give 45 historical signals a safety net
     nobody asked for. So the columns are added nullable with no default, and the default is set afterwards,
     where it applies to the rows the signup insert creates from then on. */
  assert.match(schemaSource, /ALTER TABLE settings ADD COLUMN IF NOT EXISTS fallback_stop_loss_points NUMERIC;/);
  assert.match(schemaSource, /ALTER TABLE settings ADD COLUMN IF NOT EXISTS fallback_take_profit_points NUMERIC;/);
  assert.match(schemaSource, /ALTER TABLE settings ALTER COLUMN fallback_stop_loss_points SET DEFAULT 500;/);
  assert.match(schemaSource, /ALTER TABLE settings ALTER COLUMN fallback_take_profit_points SET DEFAULT 1000;/);
  // Provenance and distances, all nullable-with-no-default, so an upgrade changes no existing row.
  for (const column of ['needs_review', 'parsed_by', 'parse_confidence', 'llm_used', 'stop_loss_pips', 'take_profit_pips']) {
    assert.ok(new RegExp(`ALTER TABLE signals ADD COLUMN IF NOT EXISTS ${column} `).test(schemaSource), `${column} is added to signals`);
  }
  // The signup insert omits both columns, which is what makes them inherit the new defaults.
  assert.match(indexSource, /INSERT INTO settings\(user_id\) VALUES\(\$1\)/);
});

/* --------------------------------------------------------------------- pips, at order time --------------------------------------------------------------------- */

test('a pip distance becomes a price only when the broker is in the room', () => {
  assert.equal(pipSizeFor('EURUSD'), 0.0001);
  assert.equal(pipSizeFor('USDJPY'), 0.01);
  assert.equal(pipSizeFor('XAUUSD'), null, 'gold has no pip - brokers write points, and a guessed step is a guessed stop');
  assert.equal(pipSizeFor('US30'), null);

  const nets = applySafetyNets({
    side: 'buy', marketPrice: 1.0851, bid: 1.085, ask: 1.0851, tickSize: 0.0001, stopsLevelPoints: 20,
    stopLoss: 1.08, takeProfit: null, takeProfitPips: 50, symbol: 'EURUSD',
    fallbackTakeProfitPoints: 5000, blockExecutionWithoutTakeProfit: true, blockExecutionWithoutStopLoss: true, lotSizeMode: 'fixed',
  });
  assert.equal(Number(nets.takeProfit.toFixed(5)), 1.09010, '50 pips above the ask the order is filled at');
  assert.equal(nets.sources.takeProfit, 'signal-pips', 'the channel\'s own distance, so the workspace net is not applied at all');
  assert.equal(nets.blocking, false);

  const refused = applySafetyNets({
    side: 'buy', marketPrice: 4050.2, bid: 4050, ask: 4050.2, tickSize: 0.01, stopsLevelPoints: 10,
    stopLoss: 4041.5, takeProfit: null, takeProfitPips: 50, fallbackTakeProfitPoints: null,
    blockExecutionWithoutTakeProfit: true, blockExecutionWithoutStopLoss: true, lotSizeMode: 'fixed', symbol: 'XAUUSD',
  });
  assert.ok(refused.problems.some((problem) => problem.code === 'take-profit-pips-unusable'), 'on gold, "50 pips" is refused out loud rather than priced on a hunch');
});

test('the engine converts a pip target onto the order it sends', async () => {
  const parsed = parseSignal('BUY EURUSD 1.0850 SL 1.0800 TP 50 pips');
  const SPEC = { symbol: 'EURUSD', minVolume: 0.01, maxVolume: 100, volumeStep: 0.01, tickSize: 0.0001, stopsLevel: 20 };
  // Deliberately *inside* the stated entry: a buy is refused when the ask has run above the level the signal
  // named, and a fixture that tripped that guard would test the guard instead of the arithmetic.
  const QUOTE = { bid: 1.0848, ask: 1.0849, lossTickValue: 1 };
  const item = {
    job_id: 'job-1', user_id: 'user-1', job_status: 'processing', attemptCount: 1,
    expires_at: new Date(Date.now() + 120_000).toISOString(),
    signal_id: 'signal-1', source: 'telegram', signal_created_at: new Date(),
    symbol: parsed.symbol, side: parsed.side,
    entry_price: parsed.entryPrice, stop_loss: parsed.stopLoss, take_profit: parsed.takeProfit,
    stop_loss_pips: parsed.stopLossPips, take_profit_pips: parsed.takeProfitPips, needs_review: false,
    execution_ready: true, parse_error: null,
    auto_trading_enabled: true, lot_size_mode: 'fixed', fixed_lot_size: 0.01, risk_percent: 1,
    block_execution_without_stop_loss: true, block_execution_without_take_profit: true,
    fallback_stop_loss_points: null, fallback_take_profit_points: null,
    max_open_positions: 3, max_daily_trades: 10, daily_loss_limit: 5,
    execution_account_id: 'account-1', metaapi_account_id: 'account-1', managed_by_app: true,
    account_state: 'DEPLOYED', subscription_status: 'active', subscription_plan: 'pro',
    multipleTargetHandling: 'first_target', takeProfitLevels: parsed.takeProfitLevels,
  };
  const sent = [];
  const pool = {
    calls: [],
    async query(sql, params = []) {
      pool.calls.push({ sql, params });
      if (sql.includes('SELECT ej.id AS job_id')) return { rows: [item] };
      if (sql.includes('SELECT baseline_equity')) return { rows: [{ baseline_equity: 1000 }] };
      if (sql.includes('FROM trades')) return { rows: [{ count: 0 }] };
      // The engine re-reads the switch immediately before it submits, so that a workspace which turned
      // auto-trading off while this job was queued does not get a trade anyway. A harness that does not
      // answer that read is refusing, not testing.
      if (sql.includes('SELECT auto_trading_enabled AS "autoTradingEnabled"')) return { rows: [{ autoTradingEnabled: true, executionAccountId: 'account-1' }] };
      if (sql.includes('INSERT INTO trades')) return { rows: [{ id: 'trade-1' }] };
      return { rows: [], rowCount: 1 };
    },
    find: (needle) => pool.calls.find((call) => call.sql.includes(needle)),
  };
  const engine = createExecutionEngine({
    pool,
    trading: {
      async getAccountState() {
        return {
          account: { state: 'DEPLOYED' }, accountInformation: { balance: 1000, equity: 1000 },
          positions: [], orders: [], deals: [], specification: SPEC, price: { ...QUOTE, time: new Date().toISOString() },
          link: { connectedToBroker: true, synchronized: true },
        };
      },
      async createMarketOrder(order) { sent.push(order); return { stringCode: 'TRADE_RETCODE_DONE', numericCode: 10009, orderId: 'pips-1', positionId: 'pips-2' }; },
      async findOrderByClientId() { return null; },
    },
    resolveToken: async () => 'fake-token',
    runtimeEnabled: true,
    isTradingPaused: async () => false,
    now: () => Date.now(),
    logger: { info() {}, warn() {}, error() {} },
  });

  const result = await engine.processJob({ id: 'job-1', user_id: 'user-1' });
  assert.equal(result.status, 'executed', result.message ?? '(no reason given)');
  assert.equal(sent.length, 1);
  assert.equal(Math.abs(sent[0].takeProfit - 1.0899) < 1e-9, true, `the target on the order is the channel's 50 pips, measured from the ask: ${sent[0].takeProfit}`);
  assert.equal(sent[0].stopLoss, 1.08, 'while the stated price leg arrives untouched');
  const tradeInsert = pool.find('INSERT INTO trades');
  assert.ok(tradeInsert, 'and the trade row records the same target the broker received');
  assert.equal(Number(tradeInsert.params[9].toFixed(5)), 1.08990);
});

test('a row flagged for review cannot reach the broker even through a queued job', async () => {
  const sent = [];
  const item = {
    job_id: 'job-2', user_id: 'user-1', job_status: 'queued', attemptCount: 1,
    expires_at: new Date(Date.now() + 120_000).toISOString(),
    signal_id: 'signal-2', source: 'telegram', signal_created_at: new Date(),
    symbol: 'XAUUSD', side: 'buy', entry_price: 4011, stop_loss: 4010, take_profit: 4050,
    stop_loss_pips: null, take_profit_pips: null, needs_review: true,
    execution_ready: true, parse_error: null,
    auto_trading_enabled: true, lot_size_mode: 'fixed', fixed_lot_size: 0.01, risk_percent: 1,
    block_execution_without_stop_loss: true, block_execution_without_take_profit: true,
    fallback_stop_loss_points: 500, fallback_take_profit_points: 1000,
    max_open_positions: 3, max_daily_trades: 10, daily_loss_limit: 5,
    execution_account_id: 'account-1', metaapi_account_id: 'account-1', managed_by_app: true,
    account_state: 'DEPLOYED', subscription_status: 'active', subscription_plan: 'pro',
  };
  const pool = {
    calls: [],
    async query(sql) {
      if (sql.includes('SELECT ej.id AS job_id')) return { rows: [item] };
      if (sql.includes('INSERT INTO trades')) return { rows: [{ id: 't' }] };
      return { rows: [], rowCount: 1 };
    },
  };
  const engine = createExecutionEngine({
    pool,
    trading: { async getAccountState() { throw new Error('the engine must not ask for a quote for a blocked signal'); }, async createMarketOrder(order) { sent.push(order); return {}; }, async findOrderByClientId() { return null; } },
    resolveToken: async () => 'fake-token',
    runtimeEnabled: true,
    isTradingPaused: async () => false,
    now: () => Date.now(),
    logger: { info() {}, warn() {}, error() {} },
  });
  const result = await engine.processJob({ id: 'job-2', user_id: 'user-1' });
  assert.equal(result.status, 'skipped');
  assert.match(result.message, /saved for review/, '`stop()` reports the refusal on `message`, and this is the sentence the reader of the job sees');
  assert.equal(sent.length, 0, 'no order, and not even a quote looked at');
});

/* --------------------------------------------------------------------- market news is not a signal to ask about --------------------------------------------------------------------- */

/** The bulletin from the brief, exactly as the channel posted it. */
const NEWS_BULLETIN = [
  '**JUST IN:** \u{1F6A8}\u{1F6A8} **Crypto is dumping**',
  '',
  '$SOL falls under $100',
  '',
  '$XRP falls under $1.30',
  '',
  '$ETH falls under $2,350',
  '',
  'Bitcoin $BTC falls under $80,000',
].join('\n');

/** The settings a workspace with both nets up would have. */
const NETS = {
  lotSizeMode: 'fixed',
  blockExecutionWithoutStopLoss: true,
  blockExecutionWithoutTakeProfit: true,
  fallbackStopLossPoints: 500,
  fallbackTakeProfitPoints: 1000,
};

test('a news headline is never asked about, so it cannot come back with a direction', async () => {
  /* An eager model that would have answered "BTCUSD, buy, 80000" with total confidence. Nothing about this
     row can therefore be attributed to a cautious answer - the only thing keeping a BUY off a headline is
     that the question is never asked. */
  const fetch = countingFetch(llmReply({ symbol: 'BTCUSD', side: 'buy', entry: 80000, stop_loss: null, take_profit: null, confidence: 1 }));
  const outcome = await parseSignalTwoLayer(NEWS_BULLETIN, { source: 'telegram', config: CONFIG, fetchImpl: fetch.fetchImpl });
  assert.equal(fetch.calls.length, 0, 'refused before it costs a request');
  assert.equal(outcome.parsed.newsOnly, true);
  assert.equal(outcome.parsed.symbol, null);
  assert.equal(outcome.parsed.side, null);
  assert.equal(outcome.provenance.llmUsed, false);
  assert.equal(outcome.review.required, false, 'and it is not "a signal that needs review" - there is no signal in it');
});

test('the row written for a news bulletin stores no trade and reads as no clear signal', async () => {
  const fetch = countingFetch(llmReply({ symbol: 'BTCUSD', side: 'buy', confidence: 1 }));
  const outcome = await parseSignalTwoLayer(NEWS_BULLETIN, { source: 'telegram', config: CONFIG, fetchImpl: fetch.fetchImpl });
  // The same three lines `saveSignal` runs before it binds the INSERT, so these are the columns.
  const safety = captureSafety({ parsed: outcome.parsed, source: 'telegram', settings: NETS, review: outcome.review });
  const executionReady = safety.executionReady === true;
  assert.deepEqual([outcome.parsed.symbol, outcome.parsed.side, outcome.parsed.entryPrice, outcome.parsed.stopLoss, outcome.parsed.takeProfit],
    [null, null, null, null, null], 'symbol, side and every leg, all empty');
  assert.equal(outcome.parsed.directionInferred, false);
  assert.equal(outcome.parsed.isScalping, false);
  assert.equal(outcome.parsed.orderTypeStated, false);
  assert.equal(executionReady, false, 'nothing is queued');
  assert.equal(outcome.review.required === true, false, 'nothing is flagged for review');
  assert.equal(executionReady ? 'received' : 'unparsed', 'unparsed', 'which is the status the client calls "No clear signal"');
  assert.equal(safety.parseError, 'This message is market news rather than a trade instruction, so nothing was taken from it.');
});

test('a headline that quotes levels may be completed on price, never on direction', async () => {
  /* News wording without a full instruction: the numbers in it are verifiable against the text and so are
     still worth asking about, but the model's "sell" is refused at the merge. A headline states what a price
     did; it does not state what to do, and that is the one gap nothing may be allowed to fill. */
  const text = 'JUST IN: Bitcoin BTC dumps below 80000, TP 70000';
  const fetch = countingFetch(llmReply({ symbol: 'BTCUSD', side: 'sell', entry: 80000, stop_loss: null, take_profit: 70000, confidence: 1 }));
  const outcome = await parseSignalTwoLayer(text, { source: 'telegram', config: CONFIG, fetchImpl: fetch.fetchImpl });
  assert.equal(fetch.calls.length, 1, 'the message is signal-shaped enough to ask about');
  assert.equal(outcome.parsed.side, null, 'while the direction it never stated stays unstated');
  assert.equal(outcome.parsed.takeProfit, 70000, 'and the target the message did write down is kept');
  assert.ok(outcome.provenance.dropped.some((item) => item.key === 'side'), 'the refusal is recorded, not quiet');
  assert.match(outcome.provenance.dropped.find((item) => item.key === 'side').because, /headline/i);
});

test('the fallback layer is not entered by a news row that looks half-readable', () => {
  // A synthetic Layer 1 result with everything `needsLayer2` normally asks for, and the news flag on top.
  const layer1 = { ...parseSignal('GOLD 4016.00 SL 4010.00'), newsOnly: true, hasPriceLevel: true, symbol: 'XAUUSD' };
  assert.equal(needsLayer2(layer1), false);
  assert.equal(needsLayer2({ ...layer1, newsOnly: false }), true, 'while the same message without the news reading is still worth a request');
});

test('the prompt says out loud that a headline has no direction in it', () => {
  const [system] = buildMessages('anything at all', CONFIG);
  assert.match(system.content, /news headline or market commentary/i);
  assert.match(system.content, /return null for the direction/i);
  assert.match(system.content, /falls under/i, 'naming the wording that was actually misread');
  assert.match(system.content, /dumping/i);
});

/* --------------------------------------------------------------------- a trade update is not a signal to ask about either --------------------------------------------------------------------- */

/** The management posts from the brief, in the shapes channels actually send them. */
const MANAGEMENT_TEXTS = [
  'HIT TP 1 ✅ +50 PIPS',
  '✅ HIT TP1 +50 pips, well done. Set BE now',
  'TP1 HIT ✅ +50 PIPS - close half and move SL to BE',
  '✅ TP 1 HIT for GOLD BUY 4016. Close now at market',
];

for (const text of MANAGEMENT_TEXTS) {
  test(`a management update is never asked about: ${text.slice(0, 34)}`, async () => {
    /* A model told to find a trade in "GOLD BUY 4016. Close now at market" finds one - a BUY at 4016 - and
       that is how an exit becomes an entry. Nothing here depends on the model being careful: the request is
       never made, so there is no answer to merge. */
    const fetch = countingFetch(llmReply({ symbol: 'XAUUSD', side: 'buy', entry: 4016, stop_loss: 4010, take_profit: 4050, confidence: 1 }));
    const outcome = await parseSignalTwoLayer(text, { source: 'telegram', config: CONFIG, fetchImpl: fetch.fetchImpl });
    assert.equal(fetch.calls.length, 0, 'refused before it costs a request');
    assert.equal(outcome.parsed.managementUpdate, true);
    assert.deepEqual([outcome.parsed.symbol, outcome.parsed.side, outcome.parsed.entryPrice, outcome.parsed.stopLoss, outcome.parsed.takeProfit],
      [null, null, null, null, null], 'and nothing at all is taken from it');
    assert.equal(outcome.parsed.orderTypeStated, false, 'while a message that says "at market" about an exit does not state an entry type');
    assert.equal(outcome.provenance.llmUsed, false);
    assert.equal(outcome.review.required, false, 'a row with no signal in it is not a row awaiting a human');
  });
}

test('the row written for a management update stores no trade and carries the update sentence', async () => {
  const fetch = countingFetch(llmReply({ symbol: 'XAUUSD', side: 'buy', entry: 4016, confidence: 1 }));
  const outcome = await parseSignalTwoLayer('GOLD BUY HIT TP 1 ✅ +50 PIPS set BE', { source: 'telegram', config: CONFIG, fetchImpl: fetch.fetchImpl });
  const safety = captureSafety({ parsed: outcome.parsed, source: 'telegram', settings: NETS, review: outcome.review });
  assert.equal(fetch.calls.length, 0);
  assert.equal(safety.executionReady, false, 'nothing is queued');
  // The complaint the report was about: a row that read as a signal missing a stop loss.
  assert.equal(safety.problems.some((problem) => problem.code === 'stop-loss-required'), false, 'no missing-leg advice on a message that gave no legs');
  assert.equal(safety.problems.some((problem) => problem.code === 'no-price-level'), false, 'and not even the generic one, which is news and updates alike');
  assert.equal(safety.parseError, 'This message manages a trade that is already open - a target hit, a stop moved to break even, or an instruction to close - rather than giving a new entry, so nothing was taken from it.');
});

test('a signal published alongside a management note is still read as a signal', async () => {
  /* The other direction, and the one that decides whether this classifier is safe to have: a channel that
     reports TP1 and then posts the next setup must not lose the next setup. A message that names where to get
     in *and* what protects the trade has an instruction in it whatever else it is talking about. */
  const text = '✅ TP 1 HIT +50 pips, well done. BUY GOLD 4016 SL 4010 TP 4050';
  const fetch = countingFetch(llmReply({ symbol: 'XAUUSD', side: 'buy', entry: 4016, stop_loss: 4010, take_profit: 4050, confidence: 1 }));
  const outcome = await parseSignalTwoLayer(text, { source: 'telegram', config: CONFIG, fetchImpl: fetch.fetchImpl });
  assert.equal(outcome.parsed.managementUpdate, false);
  assert.deepEqual([outcome.parsed.symbol, outcome.parsed.side, outcome.parsed.entryPrice, outcome.parsed.stopLoss, outcome.parsed.takeProfit],
    ['XAUUSD', 'buy', 4016, 4010, 4050]);
  assert.equal(outcome.parsed.executionReady, true, 'and it is eligible, exactly as it was before the classifier existed');
});

test('the fallback layer is not entered by a management row that looks half-readable', () => {
  const layer1 = { ...parseSignal('GOLD BUY 4016'), managementUpdate: true, hasPriceLevel: true, symbol: 'XAUUSD' };
  assert.equal(needsLayer2(layer1), false);
  assert.equal(needsLayer2({ ...layer1, managementUpdate: false }), true, 'while the same message without the update reading is still worth a request');
});

test('the merge will not write a direction onto a management row either', () => {
  // Belt and braces: even a caller that asks anyway gets nothing written.
  const layer1 = { ...parseSignal('GOLD BUY HIT TP 1'), managementUpdate: true, side: null, symbol: null };
  const merged = mergeGaps(layer1, { side: 'buy', entry: 4016, confidence: 1 }, { pipValues: new Set() });
  assert.equal(merged.merged.side, null);
  assert.equal(merged.merged.entryPrice, null);
  assert.deepEqual(merged.filled, []);
});

test('the prompt says out loud that an open position is not an entry instruction', () => {
  const [system] = buildMessages('anything at all', CONFIG);
  assert.match(system.content, /already open is not an entry instruction/i);
  assert.match(system.content, /never turn an instruction to close into a direction to open/i);
  assert.match(system.content, /"TP 1", "TP2 ✅"|A numbered target/i, 'and it names the numbered-target shape that was being read as a price');
});
