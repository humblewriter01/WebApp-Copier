import test from 'node:test';
import assert from 'node:assert/strict';
import { countSignalEntryDeals, isBlockedOnlyByStopLoss, parseSignal, resolveBrokerSymbol } from '../services/signal-parser.js';

test('parses a strict BUY signal with an entry, stop loss, and one target', () => {
  const parsed = parseSignal('BUY EURUSD\nEntry: 1.0850\nSL: 1.0800\nTP1: 1.0950');
  assert.deepEqual(parsed, {
    symbol: 'EURUSD', side: 'buy', entryPrice: 1.085, stopLoss: 1.08, takeProfit: 1.095,
    executionReady: true, parseError: null,
    directionInferred: false,
    hasTradingData: true,
    missing: { entryPrice: false, stopLoss: false, takeProfit: false },
    blockers: [],
  });
});

test('parses common gold and crypto symbols and accepts a missing entry or target', () => {
  const gold = parseSignal('SELL XAU/USD\nStop Loss: 2400.00');
  assert.equal(gold.symbol, 'XAUUSD');
  assert.equal(gold.side, 'sell');
  assert.equal(gold.stopLoss, 2400);
  assert.equal(gold.executionReady, true);
  assert.equal(parseSignal('BUY BTCUSDT\nSL: 60000').symbol, 'BTCUSDT');
});

test('does not interpret TAKE PROFIT or other instructions as a symbol', () => {
  const parsed = parseSignal('BUY now\nTake Profit: 1.23\nSL: 1.20');
  assert.equal(parsed.symbol, null);
  assert.equal(parsed.executionReady, false);
  assert.match(parsed.parseError, /symbol/i);
});

test('rejects ambiguous directions, symbols, entry ranges, and multiple targets', () => {
  assert.match(parseSignal('BUY SELL EURUSD SL 1.0').parseError, /direction/i);
  assert.match(parseSignal('BUY EURUSD GBPUSD SL 1.0').parseError, /symbol/i);
  assert.match(parseSignal('BUY EURUSD Entry 1.10-1.12 SL 1.08').parseError, /range/i);
  assert.match(parseSignal('BUY EURUSD SL 1.08 TP1 1.12 TP2 1.15').parseError, /multiple take-profit/i);
});

test('requires a valid stop loss before a signal can be queued for execution', () => {
  const parsed = parseSignal('BUY EURUSD Entry 1.08 TP 1.10');
  assert.equal(parsed.executionReady, false);
  assert.match(parsed.parseError, /stop loss/i);
  assert.match(parseSignal('BUY EURUSD SL 1.08-1.06').parseError, /stop-loss range/i);
  assert.match(parseSignal('BUY EURUSD SL 1.08 TP 1.11-1.12').parseError, /take-profit range/i);
});

/* The incomplete-but-legible message: an entry and a target, no direction and no stop. The parser used
   to call that "no direction found" and leave the panel to imply the channel had said nothing. */
test('the first reason a message is refused is the same one the parser has always led with', () => {
  // A message missing everything: direction is the fundamental gap, so it is what the row quotes, and
  // the remaining reasons stay readable in `blockers` rather than overwriting each other.
  const bare = parseSignal('1.0850 1.0800 1.0950');
  assert.equal(bare.parseError, 'A BUY or SELL direction was not found.');
  assert.deepEqual(bare.blockers.map((blocker) => blocker.code), ['direction-missing', 'symbol', 'stop-loss-missing']);
  const noSymbol = parseSignal('BUY Entry 1.0850 SL 1.0800 TP 1.0950');
  assert.equal(noSymbol.parseError, noSymbol.blockers[0].message);
  assert.match(noSymbol.parseError, /symbol/i);
});

test('a direction is inferred from the prices, marked as inferred, and never traded on that basis', () => {
  const above = parseSignal('EURUSD Entry 1.0850 TP 1.0950 SL 1.0800');
  assert.equal(above.side, 'buy');
  assert.equal(above.directionInferred, true);
  assert.equal(above.executionReady, false, 'an inferred direction is shown, not sent to a broker');
  assert.match(above.parseError, /inferred/i);
  assert.deepEqual(above.blockers.map((blocker) => blocker.code), ['direction-inferred']);

  const below = parseSignal('XAUUSD Entry 2400 TP 2350 SL 2450');
  assert.equal(below.side, 'sell', 'a target under the entry can only be reached by selling');
  assert.equal(below.directionInferred, true);

  // An entry and a target that agree exactly, or a message that is all prose, are not a direction.
  assert.equal(parseSignal('EURUSD Entry 1.08 TP 1.08').directionInferred, false);
  assert.equal(parseSignal('EURUSD Entry 1.08').directionInferred, false, 'no target means nothing to infer from');
  assert.equal(parseSignal('BUY SELL EURUSD Entry 1.0 TP 1.1').directionInferred, false, 'a contradictory message is not resolved by arithmetic');
});

test('what a message lacks is reported as facts, not as one generic failure', () => {
  const noStop = parseSignal('BUY EURUSD Entry 1.08 TP 1.10');
  assert.deepEqual(noStop.missing, { entryPrice: false, stopLoss: true, takeProfit: false });
  assert.deepEqual(noStop.blockers.map((blocker) => blocker.code), ['stop-loss-missing']);
  assert.equal(isBlockedOnlyByStopLoss(noStop), true);
  assert.equal(noStop.hasTradingData, true, 'a usable note is not "no clear signal"');

  const noTarget = parseSignal('BUY EURUSD Entry 1.08 SL 1.06');
  assert.deepEqual(noTarget.missing, { entryPrice: false, stopLoss: false, takeProfit: true });
  assert.equal(noTarget.blockers.length, 0, 'a missing target is not a reason to refuse execution');

  const prose = parseSignal('good morning everyone, another great week ahead');
  assert.equal(prose.hasTradingData, false, 'only a message with no trading data at all reads as unclear');
  assert.equal(isBlockedOnlyByStopLoss(prose), false);

  // Multiple targets leave the value null, which is a fact about the row and not a missing field.
  const twoTargets = parseSignal('BUY EURUSD SL 1.08 TP1 1.12 TP2 1.15');
  assert.equal(twoTargets.takeProfit, null);
  assert.deepEqual(twoTargets.blockers.map((blocker) => blocker.code), ['take-profit-multiple']);
});

test('resolves a unique broker suffix but refuses ambiguous symbol aliases', () => {
  assert.equal(resolveBrokerSymbol('EURUSD', [{ symbol: 'EURUSD.a' }]).symbol, 'EURUSD.a');
  assert.match(resolveBrokerSymbol('EURUSD', [{ symbol: 'EURUSD.a' }, { symbol: 'EURUSD.b' }]).error, /more than one/i);
  assert.match(resolveBrokerSymbol('EURUSD', [{ symbol: 'GBPUSD' }]).error, /not available/i);
});

test('counts unique new positions from entry and reversal deals, not exits', () => {
  const deals = [
    { type: 'DEAL_TYPE_BUY', entryType: 'DEAL_ENTRY_IN', orderId: '1' },
    { type: 'DEAL_TYPE_BUY', entryType: 'DEAL_ENTRY_IN', orderId: '1' },
    { type: 'DEAL_TYPE_SELL', entryType: 'DEAL_ENTRY_OUT', orderId: '2' },
    { type: 'DEAL_TYPE_SELL', entryType: 'DEAL_ENTRY_INOUT', id: '3' },
    { type: 'DEAL_TYPE_BALANCE', entryType: 'DEAL_ENTRY_IN', id: '4' },
  ];
  assert.equal(countSignalEntryDeals(deals), 2);
  assert.throws(() => countSignalEntryDeals([{ type: 'DEAL_TYPE_BUY', orderId: '5' }]), /classification/i);
  assert.throws(() => countSignalEntryDeals([{ type: 'DEAL_TYPE_SELL', entryType: 'DEAL_ENTRY_IN' }]), /identifier/i);
});
