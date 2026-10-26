/**
 * Trade management: the messages a channel sends about a position it already has open.
 *
 * The report this file exists for was a row wearing a `Market` badge and a `Missing SL` pill over
 * `HIT TP 1 ✅ +50 PIPS`. Neither badge was lying about a signal, because there was no signal - both were
 * consequences of one reading: `TP 1` was taken as a take-profit *price* of 1. Once the row had a price in it,
 * the missing stop loss became a complaint about the trader's discipline rather than a fact about the
 * platform's own scan, and the entry-less row became a market order waiting to be filled at whatever the
 * market was doing. A channel that writes `GOLD BUY HIT TP 1` and gets an entry of `1` out of the other end is
 * not having a bad day, it is being traded on by accident.
 *
 * Three rules, each pinned here:
 *
 *   - a target label followed by one small bare integer is the ladder's index, never a price;
 *   - management wording with no fresh instruction of its own is a **trade update**: the row is stored, every
 *     trading field is empty, and the one sentence says why;
 *   - an instruction to *close* never states an entry order type, so "close now at market" cannot make a row
 *     a market order - while `SELL NOW` still does, and a signal published next to a management note is still
 *     read as the signal it is.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { parseSignal, findManagementMarkers, detectOrderType, MANAGEMENT_BLOCKER_CODE, MANAGEMENT_BLOCKER_MESSAGE } from '../services/signal-parser.js';
import { needsLayer2 } from '../services/signal-llm.js';
import { captureSafety } from '../services/signal-safety.js';

/** The texts from the brief, verbatim. */
const HIT_TP = 'HIT TP 1 ✅ +50 PIPS';
const SET_BE = '✅ HIT TP1 +50 pips, well done. Set BE now';
const CLOSE_NOW = 'CLOSE NOW';
const CLOSE_HALF = 'TP1 HIT ✅ +50 PIPS - close half and move SL to BE';
const GOLD_WITH_ENTRY = '✅ TP 1 HIT for GOLD BUY 4016. Close now at market';
const ALL_UPDATES = [HIT_TP, SET_BE, CLOSE_NOW, CLOSE_HALF, GOLD_WITH_ENTRY];

const NETS = {
  lotSizeMode: 'fixed',
  blockExecutionWithoutStopLoss: true,
  blockExecutionWithoutTakeProfit: true,
  fallbackStopLossPoints: 500,
  fallbackTakeProfitPoints: 1000,
};

for (const text of ALL_UPDATES) {
  test(`"${text.slice(0, 38)}" is stored as a trade update with nothing taken from it`, () => {
    const parsed = parseSignal(text);
    assert.equal(parsed.managementUpdate, true, 'the classifier recognises it');
    assert.deepEqual(
      [parsed.symbol, parsed.side, parsed.entryPrice, parsed.stopLoss, parsed.takeProfit, parsed.takeProfitPips, parsed.stopLossPips],
      [null, null, null, null, null, null, null],
      'every trading field is empty',
    );
    assert.equal(parsed.hasTradingData, false);
    assert.equal(parsed.hasPriceLevel, false, 'and nothing is left for a badge to be built from');
    assert.equal(parsed.entryRange, null);
    assert.deepEqual(parsed.takeProfitLevels, [], 'the numbered ladder is not a list of prices either');
    assert.equal(parsed.executionReady, false);
    assert.equal(parsed.orderTypeStated, false, 'an exit clause never states an entry order type');
    assert.equal(parsed.newsOnly, false, 'while it is a trade update, not news - the two sentences are different');
    assert.deepEqual(parsed.blockers, [{ code: MANAGEMENT_BLOCKER_CODE, message: MANAGEMENT_BLOCKER_MESSAGE }]);
    assert.equal(parsed.parseError, MANAGEMENT_BLOCKER_MESSAGE);
    assert.equal(parsed.missing.stopLoss, true);
    assert.equal(parsed.missing.takeProfit, true, 'both legs stay missing, so no fallback distance may finish it');
    assert.equal(needsLayer2(parsed), false, 'and the model is never asked to find a trade in it');
  });
}

test('the two badges the report was about cannot be built from a cleared row', () => {
  // The client's badges are derived from the stored legs (`signalStatesAPrice` and the order type), so the
  // server-side guarantee is that those legs are all empty - which is what these two assertions re-check.
  for (const text of ALL_UPDATES) {
    const parsed = parseSignal(text);
    const statesAPrice = [parsed.entryPrice, parsed.stopLoss, parsed.takeProfit, parsed.stopLossPips, parsed.takeProfitPips].some((value) => value !== null);
    assert.equal(statesAPrice, false, `${text.slice(0, 24)} leaves no price for a Missing SL pill to point at`);
    assert.equal(parsed.orderType === 'market' && parsed.orderTypeStated === true, false, 'and no stated market order to badge');
  }
});

test('the safety layer adds no complaint on top of the update sentence', () => {
  for (const text of [HIT_TP, SET_BE, CLOSE_HALF, GOLD_WITH_ENTRY]) {
    const parsed = parseSignal(text);
    const safety = captureSafety({ parsed, source: 'telegram', settings: NETS });
    assert.equal(safety.executionReady, false);
    assert.deepEqual(safety.problems, [], `no policy problem is stacked on top of "${text.slice(0, 22)}"`);
    assert.deepEqual(safety.fallbacks, { stopLoss: null, takeProfit: null }, 'and the fallback nets stay furled');
    assert.equal(safety.override.stopLoss, false, 'nothing is traded unprotected, on the strength of an exit note');
  }
});

test('a numbered target is an index, and a priced target is still a price', () => {
  // The shape that started it: `TP 1` with nothing after it.
  assert.equal(parseSignal('BUY GOLD 4016 SL 4010 TP 1').takeProfit, null);
  assert.equal(parseSignal('BUY GOLD 4016 SL 4010 TP 1 ✅').takeProfit, null);
  // The shapes the ladder rule must keep working for, because a channel that numbers its exits is the
  // normal case rather than the exception.
  assert.equal(parseSignal('BUY GOLD 4016 SL 4010 TP 1: 4050').takeProfit, 4050);
  assert.equal(parseSignal('BUY GOLD 4016 SL 4010 TP 1 4050').takeProfit, 4050);
  assert.equal(parseSignal('BUY EURUSD 1.0850 SL 1.0800 TP 1.0950').takeProfit, 1.095, 'a decimal price is a price');
  assert.deepEqual([...parseSignal('BUY GOLD 4016 SL 4010 TP 1: 4050 TP 2: 4060').takeProfitLevels], [4050, 4060]);
  assert.equal(parseSignal('BUY GOLD 4016 SL 4010 TP 4050').takeProfit, 4050, 'and an unnumbered target is untouched');
});

test('a target index never becomes the entry price either', () => {
  /* `GOLD BUY HIT TP 1` used to yield `entryPrice: 1` from the bare scan - the number nearest the symbol -
     and a one-dollar entry on a 4000-dollar market is a price no fallback distance would argue with. */
  const parsed = parseSignal('GOLD BUY HIT TP 1 ✅ +50 PIPS set BE');
  assert.equal(parsed.entryPrice, null);
  assert.equal(parsed.entryWasBare, false);
  // The bare entry the scan exists for is still read.
  assert.equal(parseSignal('BUY EURUSD 1.0850 SL 1.0800 TP 1.0950').entryPrice, 1.085);
  assert.equal(parseSignal('SELL GOLD 4016, SL 4030, TP 4000').entryPrice, 4016);
  // A target given as a distance stays a distance, not an entry.
  assert.equal(parseSignal('BUY GOLD 4016 SL 4010 TP 300 pips').takeProfitPips, 300);
});

test('an exit clause never states an entry order type, and an entry clause still does', () => {
  const cases = [
    ['✅ TP 1 HIT for GOLD BUY 4016. Close now at market', 'limit', false, 'the "now" and the "market" belong to the close'],
    ['SELL GOLD 4016 - close half now, let the rest run', 'limit', false, 'a partial close is not an instruction about the entry'],
    ['EXIT NOW', 'market', false, 'a bare exit is no instruction at all, so the default stands unstated'],
    ['SELL NOW GOLD 4016 SL 4030 TP 4000', 'market', true, 'while a direction with "now" is exactly what states it'],
    ['BUY GOLD 4016 SL 4010 TP 4050 MARKET EXECUTION', 'market', true, 'and a stated market execution still says so'],
    ['CLOSE ALL, then BUY GOLD 4016 NOW', 'market', true, 'the second clause survives the blanking of the first'],
    ['BUY GOLD 4016 SL 4010 TP 4050', 'limit', false, 'a published price with no words at all still rests'],
  ];
  for (const [text, orderType, stated, because] of cases) {
    const found = detectOrderType(text, { entryPrice: text.includes('4016') ? 4016 : null });
    assert.deepEqual({ orderType: found.orderType, stated: found.stated }, { orderType, stated }, because);
  }
});

test('each family of management wording is recognised on its own', () => {
  const cases = [
    ['HIT TP 1 ✅ +50 PIPS', ['target-hit', 'pips-result']],
    ['TARGET 2 REACHED, well done', ['target-hit', 'pips-result']],
    ['close all positions now', ['close-instruction']],
    ['SET BE', ['break-even']],
    ['move SL to break even', ['break-even']],
    ['+50 PIPS in profit', ['pips-result']],
    ['trade still running, let it run', ['trade-running']],
  ];
  for (const [text, expected] of cases) {
    const markers = findManagementMarkers(text);
    for (const marker of expected) assert.ok(markers.includes(marker), `"${text}" reports ${marker}, got ${markers.join('|') || 'nothing'}`);
  }
});

test('the marker scan is stateless, because a global regex remembers where it stopped', () => {
  /* Every management pattern is `g`-flagged. A `test()` on one advances `lastIndex`, and a second call on the
     same text would then answer from where the first left off - the classic way this kind of scanner starts
     working in one request and not in the next. */
  const text = 'TP1 HIT ✅ +50 PIPS - close half and move SL to BE';
  const first = findManagementMarkers(text);
  const second = findManagementMarkers(text);
  const third = findManagementMarkers(text);
  assert.deepEqual(first, second);
  assert.deepEqual(second, third);
  assert.ok(first.length >= 3, 'and the text is not being read as less management each time');
  // The same scan run over two messages in a row, in either order, answers for each message on its own.
  const other = findManagementMarkers('BUY GOLD 4016 SL 4010 TP 4050');
  assert.deepEqual(other, []);
  assert.deepEqual(findManagementMarkers(text), first);
});

test('a management note beside a real signal costs that signal nothing', () => {
  const cases = [
    '✅ TP 1 HIT +50 pips. BUY GOLD 4016 SL 4010 TP 4050',
    'SELL XAUUSD CMP, SL 4030, TP 4000 - previous trade hit TP1 +50 pips',
    'BUY GOLD ZONE 4016.00 - 4026.00 / SL: 4010.00 / TP: 4050.00 (set BE on the last one)',
  ];
  for (const text of cases) {
    const parsed = parseSignal(text);
    assert.equal(parsed.managementUpdate, false, `"${text.slice(0, 30)}" is a signal`);
    assert.equal(parsed.side !== null && parsed.symbol !== null, true);
    assert.equal(parsed.executionReady, true, 'and it is as eligible as the same message without the note');
  }
});

test('the update sentence names the wording that triggered it, in the reader\'s language', () => {
  // One sentence, no jargon, and it says what happened to the message rather than blaming the channel.
  assert.match(MANAGEMENT_BLOCKER_MESSAGE, /manages a trade that is already open/);
  assert.match(MANAGEMENT_BLOCKER_MESSAGE, /nothing was taken from it/);
  assert.equal(/hallucin|invalid|parse/i.test(MANAGEMENT_BLOCKER_MESSAGE), false, 'and it does not describe the platform\'s internals');
});
