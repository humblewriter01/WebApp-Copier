import test from 'node:test';
import assert from 'node:assert/strict';
import { countSignalEntryDeals, parseSignal, resolveBrokerSymbol } from '../services/signal-parser.js';

test('parses a strict BUY signal with an entry, stop loss, and one target', () => {
  const parsed = parseSignal('BUY EURUSD\nEntry: 1.0850\nSL: 1.0800\nTP1: 1.0950');
  assert.deepEqual(parsed, {
    symbol: 'EURUSD', side: 'buy', entryPrice: 1.085, stopLoss: 1.08, takeProfit: 1.095,
    executionReady: true, parseError: null,
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
