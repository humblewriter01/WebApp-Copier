/**
 * The safety nets: what a workspace may do about a signal that forgot its stop loss or its target.
 *
 * The behaviour these tests hold is the one users cannot get wrong from the outside but would feel
 * immediately if it slipped: a trade sent without a stop, a fallback quietly dropped because the broker
 * did not like it, or a refusal that blames the provider for a rule the workspace set itself.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseSignal } from '../services/signal-parser.js';
import {
  MAX_FALLBACK_POINTS,
  MIN_FALLBACK_POINTS,
  NAKED_STOP_WARNING,
  NAKED_TARGET_WARNING,
  SIZING_REQUIRES_STOP_MESSAGE,
  STOP_REQUIRED_MESSAGE,
  TARGET_REQUIRED_MESSAGE,
  applySafetyNets,
  captureSafety,
  readFallbackPoints,
  safetyNote,
} from '../services/signal-safety.js';

const NETS = { fallbackStopLossPoints: 3000, fallbackTakeProfitPoints: 4000 };
const BLOCK_BOTH = { blockExecutionWithoutStopLoss: true, blockExecutionWithoutTakeProfit: true };
const ALLOW_BOTH = { blockExecutionWithoutStopLoss: false, blockExecutionWithoutTakeProfit: false };

/* ---------- the setting itself ---------- */

test('a fallback distance is either usable points or no net at all', () => {
  for (const blank of [null, undefined, '', '   ']) {
    assert.deepEqual(readFallbackPoints(blank, 'x'), { value: null, error: null }, `${JSON.stringify(blank)} means no fallback`);
  }
  for (const usable of [MIN_FALLBACK_POINTS, 3000, MAX_FALLBACK_POINTS, '3000', ' 4000 ']) {
    const read = readFallbackPoints(usable, 'x');
    assert.equal(read.error, null, `${usable} is a valid distance`);
    assert.equal(read.value, Number(String(usable).trim()));
  }
  // Never clamped: 0 and a billion points are opposite mistakes, and neither is a distance anyone meant.
  for (const refused of [0, -1, 1.5, '1.5', 'five', '3000.5', Number.NaN, Number.POSITIVE_INFINITY, MIN_FALLBACK_POINTS - 1, MAX_FALLBACK_POINTS + 1, true, false, [5], {}, { value: 3000 }]) {
    const read = readFallbackPoints(refused, 'The fallback stop-loss distance');
    assert.equal(read.value, null, `${String(refused)} is not stored`);
    assert.match(read.error, /must be a whole number of points between 1 and 1000000, or blank for no fallback\.$/);
  }
});

test('the error names the field the reader has to fix', () => {
  assert.match(readFallbackPoints(0, 'The fallback stop-loss distance').error, /^The fallback stop-loss distance/);
  assert.match(readFallbackPoints(0, 'The fallback take-profit distance').error, /^The fallback take-profit distance/);
});

/* ---------- capture: is this message eligible at all? ---------- */

test('a signal that carries both legs is untouched by the policy', () => {
  const safety = captureSafety({ parsed: parseSignal('BUY EURUSD Entry 1.0800 SL 1.0600 TP 1.1200'), settings: { ...NETS, ...BLOCK_BOTH } });
  assert.equal(safety.executionReady, true);
  assert.equal(safety.parseError, null);
  assert.deepEqual(safety.fallbacks, { stopLoss: null, takeProfit: null }, 'the channel said both legs, so nothing is borrowed');
  assert.deepEqual(safety.override, { stopLoss: false, takeProfit: false });
  assert.deepEqual(safety.problems, []);
});

test('a fallback rescues a signal whose provider forgot the stop', () => {
  const parsed = parseSignal('BUY EURUSD Entry 1.0800 TP 1.1200');
  assert.equal(parsed.executionReady, false, 'the parser alone would refuse it');
  const safety = captureSafety({ parsed, settings: { ...NETS, ...BLOCK_BOTH } });
  assert.equal(safety.executionReady, true);
  assert.equal(safety.parseError, null, 'a rescued signal does not go on saying it is broken');
  assert.deepEqual(safety.fallbacks, { stopLoss: 3000, takeProfit: null });
  assert.equal(safety.override.stopLoss, false, 'this is a net, not an override - the trade will carry a stop');
});

test('with no net and the block up, the refusal keeps its own sentence', () => {
  const safety = captureSafety({ parsed: parseSignal('BUY EURUSD Entry 1.0800 TP 1.1200'), settings: BLOCK_BOTH });
  assert.equal(safety.executionReady, false);
  // The parser's own line would read as the provider's fault; this is the workspace's rule, and it is
  // the sentence that tells the reader which of the two they are looking at.
  assert.equal(safety.parseError, STOP_REQUIRED_MESSAGE);
  assert.deepEqual(safety.problems.map((problem) => problem.code), ['stop-loss-required']);
});

test('with no net and the block down, the row is executable and marked as an override', () => {
  const safety = captureSafety({ parsed: parseSignal('BUY EURUSD Entry 1.0800 TP 1.1200'), settings: { ...ALLOW_BOTH, lotSizeMode: 'fixed' } });
  assert.equal(safety.executionReady, true);
  assert.equal(safety.parseError, null);
  assert.equal(safety.override.stopLoss, true, 'the panel has to be able to say "this one is unprotected because you allowed it"');
  assert.deepEqual(safety.fallbacks, { stopLoss: null, takeProfit: null });
});

test('an override cannot size a risk-based lot', () => {
  /* Sending a risk-based lot without a stop is not "less safe", it is undefined arithmetic: the lot is
     the distance to the stop divided into the risk amount. The block toggle being off does not fix that. */
  const safety = captureSafety({ parsed: parseSignal('BUY EURUSD Entry 1.0800 TP 1.1200'), settings: { ...ALLOW_BOTH, lotSizeMode: 'risk_percent' } });
  assert.equal(safety.executionReady, false);
  assert.equal(safety.parseError, SIZING_REQUIRES_STOP_MESSAGE);
  assert.deepEqual(safety.problems.map((problem) => problem.code), ['stop-loss-sizing']);
});

test('a missing target becomes a blocker only when the workspace asks for it', () => {
  const parsed = parseSignal('BUY EURUSD Entry 1.0800 SL 1.0600');
  assert.equal(parsed.executionReady, true, 'the parser does not refuse an absent target');

  const blocked = captureSafety({ parsed, settings: BLOCK_BOTH });
  assert.equal(blocked.executionReady, false);
  assert.equal(blocked.parseError, TARGET_REQUIRED_MESSAGE);

  const allowed = captureSafety({ parsed, settings: { blockExecutionWithoutStopLoss: true, blockExecutionWithoutTakeProfit: false } });
  assert.equal(allowed.executionReady, true);
  assert.deepEqual(allowed.override, { stopLoss: false, takeProfit: true });

  const netted = captureSafety({ parsed, settings: { fallbackTakeProfitPoints: 4000, ...BLOCK_BOTH } });
  assert.equal(netted.executionReady, true);
  assert.deepEqual(netted.fallbacks, { stopLoss: null, takeProfit: 4000 });
  assert.deepEqual(netted.override, { stopLoss: false, takeProfit: false });
});

test('a signal missing both legs needs both nets, and says which one is still open', () => {
  const parsed = parseSignal('BUY EURUSD Entry 1.0800');
  const halfNet = captureSafety({ parsed, settings: { fallbackStopLossPoints: 3000, ...BLOCK_BOTH } });
  assert.equal(halfNet.executionReady, false);
  assert.equal(halfNet.parseError, TARGET_REQUIRED_MESSAGE, 'the stop is covered, so the target is the reason left');
  assert.deepEqual(halfNet.fallbacks, { stopLoss: 3000, takeProfit: null });

  const bothNets = captureSafety({ parsed, settings: { ...NETS, ...BLOCK_BOTH } });
  assert.equal(bothNets.executionReady, true);
  assert.equal(bothNets.parseError, null);
});

test('a failure the policy cannot fix still leads', () => {
  const prose = captureSafety({ parsed: parseSignal('good morning everyone, another great week ahead'), settings: { ...NETS, ...ALLOW_BOTH } });
  assert.equal(prose.executionReady, false);
  assert.equal(prose.parseError, 'A BUY or SELL direction was not found.', 'nets do not turn a greeting into a trade');

  /* Inferring a direction from two prices is a reading of a message, not an instruction to trade, so a
     fallback distance must not make it executable - that combination would put money on a guess. */
  const inferred = captureSafety({ parsed: parseSignal('EURUSD Entry 1.0800 TP 1.1200'), settings: { ...NETS, ...ALLOW_BOTH } });
  assert.equal(inferred.executionReady, false);
  assert.match(inferred.parseError, /inferred/i);
});

test('a manual note is described by the parser alone', () => {
  /* Nothing a user typed by hand is queued for execution, so the safety rules have nothing to answer
     here. Marking someone's own note "unsafe" because it has no target would be noise. */
  const manual = captureSafety({ parsed: parseSignal('BUY EURUSD Entry 1.0800 SL 1.0600'), source: 'manual', settings: BLOCK_BOTH });
  assert.equal(manual.executionReady, true);
  assert.deepEqual(manual.problems, []);

  const manualNoStop = captureSafety({ parsed: parseSignal('BUY EURUSD Entry 1.0800 TP 1.1200'), source: 'manual', settings: { ...NETS, ...ALLOW_BOTH } });
  assert.equal(manualNoStop.executionReady, false);
  assert.equal(manualNoStop.parseError, 'A stop loss is required for automatic execution.', 'the parser sentence, not a policy sentence');
  assert.deepEqual(manualNoStop.fallbacks, { stopLoss: null, takeProfit: null }, 'a manual row is not given a net it will never use');
});

test('a bad value already in the database reads as no net, never as a guess', () => {
  for (const junk of ['abc', 0, -5, Number.NaN]) {
    const safety = captureSafety({ parsed: parseSignal('BUY EURUSD Entry 1.0800 TP 1.1200'), settings: { fallbackStopLossPoints: junk, ...BLOCK_BOTH } });
    assert.equal(safety.executionReady, false, `${String(junk)} is not a stop-loss distance`);
    assert.equal(safety.parseError, STOP_REQUIRED_MESSAGE);
  }
});

/* ---------- execution: what prices go on the order ---------- */

const QUOTE = { marketPrice: 1.07, bid: 1.07, ask: 1.0702, tickSize: 0.00001 };

test("the signal's own legs are passed through untouched", () => {
  const result = applySafetyNets({ side: 'buy', ...QUOTE, stopLoss: 1.06, takeProfit: 1.12, ...NETS, ...BLOCK_BOTH });
  assert.equal(result.stopLoss, 1.06);
  assert.equal(result.takeProfit, 1.12);
  assert.deepEqual(result.sources, { stopLoss: 'signal', takeProfit: 'signal' });
  assert.deepEqual(result.problems, []);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.blocking, false);
});

test('a missing leg is measured from the order price, on the correct side of it', () => {
  const buy = applySafetyNets({ side: 'buy', ...QUOTE, ...NETS, ...BLOCK_BOTH });
  assert.equal(buy.stopLoss, 1.04, 'a buy stop sits below the market');
  assert.equal(buy.takeProfit, 1.11, 'a buy target is the same distance above the market, and is then held to clearing the ask');
  assert.deepEqual(buy.sources, { stopLoss: 'net', takeProfit: 'net' });
  assert.equal(buy.blocking, false, 'a signal with both legs completed is not a problem');

  const sell = applySafetyNets({ side: 'sell', ...QUOTE, ...NETS, ...BLOCK_BOTH });
  assert.equal(sell.stopLoss, 1.1, 'a sell stop sits above the market');
  assert.equal(sell.takeProfit, 1.03, 'a sell target is measured from the bid');
  assert.deepEqual(sell.sources, { stopLoss: 'net', takeProfit: 'net' });
});

test('the aligned price moves away from the market, never into it', () => {
  /* Rounding a stop onto the tick grid must never tighten it: half a tick in the wrong direction is a
     stop that is closer than the user's own setting, on a symbol whose tick does not divide the price. */
  const gold = applySafetyNets({ side: 'buy', marketPrice: 2400.113, bid: 2400.113, ask: 2400.13, tickSize: 0.01, ...NETS, ...BLOCK_BOTH });
  assert.equal(gold.stopLoss, 2370.11, 'floored down, away from the buy');
  assert.equal(gold.takeProfit, 2440.12, 'ceiled up, away from the buy');
  const sell = applySafetyNets({ side: 'sell', marketPrice: 2400.113, bid: 2400.1, ask: 2400.113, tickSize: 0.01, ...NETS, ...BLOCK_BOTH });
  assert.equal(sell.stopLoss, 2430.12, 'ceiled up, away from the sell');
  assert.equal(sell.takeProfit, 2360.11, 'floored down, away from the sell');
  assert.ok(Math.abs(2400.113 - gold.stopLoss) >= 30 - 1e-9, 'the distance is never shortened by alignment');
});

test('a net that lands on or through the market is refused out loud', () => {
  /* A target inside the spread is not a target: the position would close the moment it fills. The usual
     cause is a fallback distance smaller than the symbol's spread, which is a setting to fix, not a
     reason to send an order with no target - and not something to swallow. */
  const result = applySafetyNets({ side: 'buy', marketPrice: 1.07, bid: 1.07, ask: 1.0705, tickSize: 0.00001, stopLoss: 1.06, fallbackTakeProfitPoints: 30, ...BLOCK_BOTH });
  assert.deepEqual(result.problems.map((problem) => problem.code), ['take-profit-net-unusable', 'take-profit-required']);
  assert.equal(result.takeProfit, null, 'no price is sent for a leg the broker would reject');
  assert.equal(result.blocking, true);
  // The refusal the user reads is both facts in one sentence: the rule that stopped the order, and the
  // reason the setting they already chose could not answer it.
  assert.ok(result.reason.startsWith(`${TARGET_REQUIRED_MESSAGE} `), result.reason);
  assert.match(result.reason, /smaller than the current spread/);
});

test('a net inside the broker’s minimum stop distance is refused, not widened', () => {
  const result = applySafetyNets({ side: 'buy', ...QUOTE, stopsLevelPoints: 2000, fallbackStopLossPoints: 500, fallbackTakeProfitPoints: 4000, ...BLOCK_BOTH });
  assert.ok(result.problems.some((problem) => problem.code === 'stop-loss-net-unusable'));
  assert.match(result.reason, /requires stops at least 2000 points/);
  assert.equal(result.blocking, true);
  assert.equal(result.takeProfit, 1.11, 'the leg that is usable is still applied');
});

test('a leg cannot be judged against a price the quote never provided', () => {
  for (const unusable of [{}, { marketPrice: 0 }, { marketPrice: -1 }]) {
    const result = applySafetyNets({ side: 'buy', tickSize: 0.00001, ...unusable, ...NETS, ...BLOCK_BOTH });
    assert.equal(result.stopLoss, null);
    assert.match(result.reason, /no valid market price to measure from/);
  }
  const noTick = applySafetyNets({ side: 'buy', marketPrice: 1.07, bid: 1.07, ask: 1.0702, ...NETS, ...BLOCK_BOTH });
  assert.match(noTick.reason, /did not report a tick size/);
  const tinyGold = applySafetyNets({ side: 'buy', marketPrice: 0.02, bid: 0.02, ask: 0.0201, tickSize: 0.01, fallbackStopLossPoints: 3000, fallbackTakeProfitPoints: 4000, ...BLOCK_BOTH });
  assert.match(tinyGold.reason, /at or below zero/, 'a wide fallback on a near-zero price is a mistake in the settings');
});

test('no net plus the block up is a refusal; no net plus the block down is a stated override', () => {
  const refused = applySafetyNets({ side: 'buy', ...QUOTE, blockExecutionWithoutStopLoss: true, blockExecutionWithoutTakeProfit: true, stopLoss: null, takeProfit: null });
  assert.equal(refused.stopLoss, null);
  assert.equal(refused.takeProfit, null);
  assert.equal(refused.blocking, true);
  assert.deepEqual(refused.warnings, []);
  assert.deepEqual(refused.problems.map((problem) => problem.code), ['stop-loss-required', 'take-profit-required']);

  const allowed = applySafetyNets({ side: 'buy', ...QUOTE, ...ALLOW_BOTH, stopLoss: null, takeProfit: null, lotSizeMode: 'fixed' });
  assert.equal(allowed.blocking, false, 'the workspace chose to trade naked; that is its decision');
  assert.deepEqual(allowed.problems, []);
  assert.deepEqual(allowed.warnings.map((warning) => warning.message), [
    `${NAKED_STOP_WARNING} No fallback distance is configured.`,
    `${NAKED_TARGET_WARNING} No fallback distance is configured.`,
  ]);
  assert.deepEqual(allowed.warnings.map((warning) => warning.code), ['naked-stop', 'naked-target']);
});

test('risk-based sizing is refused even when the stop block is off', () => {
  const result = applySafetyNets({ side: 'buy', ...QUOTE, blockExecutionWithoutStopLoss: false, blockExecutionWithoutTakeProfit: false, stopLoss: null, takeProfit: 1.12, lotSizeMode: 'risk_percent' });
  assert.equal(result.blocking, true);
  assert.equal(result.reason, SIZING_REQUIRES_STOP_MESSAGE);
  assert.deepEqual(result.problems.map((problem) => problem.code), ['stop-loss-sizing']);
  assert.deepEqual(result.warnings, [], 'the block being off does not make an unsizable order worth sending');
});

test('an absent leg is never zero', () => {
  /* `Number(null)` is `0`, which is finite and on the right side of any price. Both legs are tested for
     existence before anything is converted, or a missing stop reads as a stop at zero and no fallback
     is ever applied. */
  for (const absent of [null, undefined, '']) {
    const result = applySafetyNets({ side: 'buy', ...QUOTE, stopLoss: absent, takeProfit: 1.12, ...NETS, ...BLOCK_BOTH });
    assert.equal(result.sources.stopLoss, 'net', `${String(absent)} is not a price`);
    assert.equal(result.stopLoss, 1.04);
  }
});

test('the note says what the workspace supplied, on the side that was traded', () => {
  const both = safetyNote({ stopLoss: 'net', takeProfit: 'net' }, { stopLoss: 3000, takeProfit: 4000 }, 'buy');
  assert.equal(both, 'Your Safety fallback distances were used because the signal did not carry them: stop loss 3000 points below the order price and target 4000 points above it.');
  assert.match(safetyNote({ stopLoss: 'net', takeProfit: 'net' }, { stopLoss: 3000, takeProfit: 4000 }, 'sell'), /stop loss 3000 points above the order price and target 4000 points below it\./);
  assert.equal(safetyNote({ stopLoss: 'net', takeProfit: 'signal' }, { stopLoss: 3000, takeProfit: 4000 }, 'buy'), 'Your Safety fallback distances were used because the signal did not carry them: stop loss 3000 points below the order price.');
  assert.equal(safetyNote({ stopLoss: 'signal', takeProfit: 'signal' }, NETS, 'buy'), null, 'nothing borrowed, nothing to explain');
  assert.equal(safetyNote({ stopLoss: 'none', takeProfit: 'none' }, NETS, 'buy'), null, 'an override is not a fallback');
});

/* ---------- the routes and the engine that carry the settings ---------- */

/* The distance is only a policy if it survives the round trip: read out of the settings row, validated on
   the way in, and present in the claim query the worker uses before it touches the broker. A column the
   claim does not select is a fallback that never fires, and nothing would say so. */
const index = readFileSync(fileURLToPath(new URL('../index.js', import.meta.url)), 'utf8');
const engine = readFileSync(fileURLToPath(new URL('../services/execution-engine.js', import.meta.url)), 'utf8');
const settingsGet = index.slice(index.indexOf("app.get('/api/settings'"), index.indexOf("app.put('/api/settings'"));
const settingsPut = index.slice(index.indexOf("app.put('/api/settings'"), index.indexOf("app.put('/api/settings'") + 20000);

test('the settings route reads, validates and stores all three safety nets', () => {
  for (const column of ['block_execution_without_take_profit', 'fallback_stop_loss_points', 'fallback_take_profit_points']) {
    assert.ok(settingsGet.includes(column), `GET /api/settings has to return ${column} or the panel cannot show it`);
    assert.ok(settingsPut.includes(column), `PUT /api/settings has to write ${column}`);
  }
  // A workspace created before these columns existed has no row values at all; the defaults are the
  // safe ones (block on, no net), so an old account is never silently switched into trading naked.
  assert.match(settingsGet, /blockExecutionWithoutTakeProfit: true/);
  assert.match(settingsGet, /fallbackStopLossPoints: null/);
  assert.match(settingsGet, /fallbackTakeProfitPoints: null/);
  assert.match(settingsPut, /readFallbackPoints\(req\.body\.fallbackStopLossPoints, 'The fallback stop-loss distance'\)/);
  assert.match(settingsPut, /readFallbackPoints\(req\.body\.fallbackTakeProfitPoints, 'The fallback take-profit distance'\)/);
  assert.match(settingsPut, /if \(fallbackStopLoss\.error \|\| fallbackTakeProfit\.error\) return fail\(res, 400, fallbackStopLoss\.error \|\| fallbackTakeProfit\.error\);/);
  const rejected = settingsPut.slice(0, settingsPut.indexOf('INSERT INTO settings'));
  assert.ok(rejected.includes('fallbackStopLoss.error'), 'an unusable distance is answered before anything is written');
});

test('the worker reads the nets in the same query that claims the job', () => {
  assert.match(engine, /st\.block_execution_without_stop_loss,\s+st\.block_execution_without_take_profit,st\.fallback_stop_loss_points,st\.fallback_take_profit_points,\s+st\.multiple_target_handling AS "multipleTargetHandling",s\.take_profit_levels AS "takeProfitLevels",/);
  assert.match(engine, /const safety = applySafetyNets\(\{[\s\S]*?fallbackStopLossPoints: item\.fallback_stop_loss_points,[\s\S]*?blockExecutionWithoutTakeProfit: item\.block_execution_without_take_profit,[\s\S]*?lotSizeMode: item\.lot_size_mode,/);
  assert.match(engine, /if \(safety\.blocking\) return stop\(job, 'skipped', safety\.reason\)/, 'the refusal is one sentence, not a re-derivation');
  assert.match(engine, /for \(const warning of safety\.warnings\)/, 'an override is logged every time it happens');
  assert.equal(engine.includes('block_execution_without_take_profit ?'), false, 'the gate must not be re-implemented in the engine');
  // An executed job that borrowed a leg leaves the explanation on the signal row, which is where a
  // reader looks for it; an ordinary trade leaves the note empty as before.
  assert.match(engine, /await updateJob\(job\.id, job\.user_id, 'executed', null, \[safetyNoteText, planNote\]\.filter\(Boolean\)\.join\(' '\) \|\| null\)/, 'a borrowed leg and a scale-out plan share the one note a reader finds later');
  // The ladder travels with the same read that claims the job, so an order can never be sized under one
  // policy and executed under another because a second query agreed at a different moment.
  assert.ok(engine.lastIndexOf('recordScaleOutPlan({') > engine.indexOf('await trading.createMarketOrder'), 'the plan is written after the order reaches the broker, never before');
});
