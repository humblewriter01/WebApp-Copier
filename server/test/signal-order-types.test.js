import test from 'node:test';
import assert from 'node:assert/strict';
import { detectOrderType, detectScalping, parseSignal } from '../services/signal-parser.js';

/*
 * The order type is the one part of the parser that changes what money does *later*, on its own, while nobody
 * is watching: a resting order fills at whatever price the market comes to it. So these tests are mostly
 * about the words that must NOT move money - the risk prose of a real channel, which contains "stop",
 * "limit" and "market" constantly, and is where a keyword scanner fails.
 */

test('an instruction to take the market is read as a market order', () => {
  const forms = [
    'BUY GOLD NOW 4110 SL 4100 TP 4130',
    'GOLD SELL NOW. SL 4025, TP 4000',
    'BUY XAUUSD at 4011, CMP',
    'SELL GOLD at market SL 3340 TP 3300',
    'BUY EURUSD 1.0850 instantly. SL 1.0800 TP 1.0900',
    'Gold Buy now\n\nSL: 4041.50',
  ];
  for (const message of forms) {
    const parsed = parseSignal(message);
    assert.equal(parsed.orderType, 'market', `${message.slice(0, 34)} -> ${parsed.orderType}`);
    assert.equal(parsed.orderTypeStated, true, `${message.slice(0, 34)} did ask for it`);
  }
});

test('the price a market order was asked at is kept as the reference, not thrown away', () => {
  const parsed = parseSignal('BUY GOLD NOW 4110 SL 4100 TP 4130');
  assert.equal(parsed.entryPrice, 4110);
});

test('a level named by an order type is a resting order at that level', () => {
  const limit = parseSignal('BUY GOLD LIMIT 4011 SL 4005 TP 4030');
  assert.equal(limit.orderType, 'limit');
  assert.equal(limit.orderTypeStated, true);
  assert.equal(limit.entryPrice, 4011);

  const sellLimit = parseSignal('Sell gold limit order at 4011, sl 4005, tp 4030');
  assert.deepEqual([sellLimit.orderType, sellLimit.side, sellLimit.entryPrice], ['limit', 'sell', 4011]);

  const stop = parseSignal('BUY STOP above 4050 SL 4040 TP 4080');
  assert.equal(stop.orderType, 'stop');
  assert.equal(stop.entryPrice, 4050, 'the breakout level is the entry, and it is not read a second time as the stop loss');
  assert.equal(stop.stopLoss, 4040);
  assert.equal(stop.takeProfit, 4080);
});

test('a single stated price with no instruction to take the market is a limit', () => {
  const parsed = parseSignal('GOLD SELL 4024 SL 4009 TP 50 pips');
  assert.equal(parsed.orderType, 'limit');
  assert.equal(parsed.orderTypeStated, false, 'this is the product choosing, not the channel asking, and the UI says so');
});

test('an entry published as a zone has no single level to rest at, so it stays a market order', () => {
  const parsed = parseSignal('GOLD SELL Entry Zone 4026-4016 SL 4010 TP 4050');
  assert.equal(parsed.entryPrice, 4016, 'the bound the sell is credited with is still read');
  assert.equal(parsed.orderType, 'market');
});

test('a signal with no entry level at all is a market order', () => {
  assert.equal(parseSignal('SELL GOLD Stop Loss: 4010, Take Profit: 4030').orderType, 'market');
  assert.equal(parseSignal('Buy EURUSD, SL 1.0800, TP 1.0900').orderType, 'market');
});

test('the words that share a name with an order type do not become one', () => {
  const traps = [
    // "stop" in every one of these is the protective leg or broker talk, never a pending order.
    ['SELL GOLD stop loss 4010, take profit 4030', 'market'],
    ['BUY XAUUSD — Stop Loss: 4010, Trailing stop 20 pips', 'market'],
    ['BUY GOLD stop 4005 TP 4030', 'market'],
    ['SELL EURUSD 1.0850 STOP 1.0800 TP 1.0900', 'limit'],
    ['GOLD BUY 4011 SL 4005 TP 4030 (break-even stop at entry)', 'limit'],
    // "limit" in these is a cap on risk. Read as an order type it would rest an order at the number in the
    // sentence, which is a percentage of the account, not a price.
    ['SELL GOLD stop loss 4010, take profit 4030, daily loss limit 3%, max positions limit 5', 'market'],
    ['BUY GOLD 4011 SL 4005 TP 4030. Withdrawal limit applies to bonuses only', 'limit'],
    // "market" is prose, and "now" belongs to a sentence about the channel, not the entry.
    ['SELL GOLD. Market closed for 2 hours, stop hunting is real. SL 4025 TP 4000 entry 4015', 'limit'],
    ['US30 BUY. Always trust your market mover here! SL 300 points', 'market'],
    ['BUY GOLD — do not trade if market is closed. SL 4005 TP 4030 entry 4011', 'limit'],
  ];
  for (const [message, expected] of traps) {
    const parsed = parseSignal(message);
    assert.equal(parsed.orderType, expected, `${message.slice(0, 46)} -> ${parsed.orderType}, wanted ${expected}`);
  }
});

test('a resting level is read once, not a second time as the protective leg', () => {
  // `SELL STOP 4010, SL 4020` used to be refused as "more than one stop loss", because the scanner that looks
  // for `STOP <price>` found the pending order's own level. The two numbers are now two different legs.
  const parsed = parseSignal('SELL GOLD STOP 4010, SL 4020, TP 4030');
  assert.equal(parsed.entryPrice, 4010);
  assert.equal(parsed.stopLoss, 4020);
  assert.equal(parsed.takeProfit, 4030);
  assert.equal(parsed.parseError, null);
});

test('an entry label outranks an order type that also names a number', () => {
  const parsed = parseSignal('SELL GOLD Entry 4020, SELL STOP 4010 SL 4030 TP 4000');
  assert.equal(parsed.entryPrice, 4020, 'the labelled entry wins over the level that came from the order type');
  assert.equal(parsed.stopLoss, 4030);
});

test('scalping is read from the words that mean it', () => {
  for (const message of ['GOLD SELL NOW (SCALPING) Entry 4020 SL 4025 TP 4010', 'BUY GOLD scalp 4011 SL 4005 TP 4030', 'SELL EURUSD fast entry 1.0850 SL 1.0800 TP 1.0900', 'BUY GBPUSD - Quick in 1.2750 SL 1.2720 TP 1.2800']) {
    assert.equal(parseSignal(message).isScalping, true, message.slice(0, 40));
  }
  for (const message of ['BUY GOLD 4011 SL 4005 TP 4030', 'SELL GOLD. A fast market can gap through your stop. SL 4010 TP 3990', 'BUY EURUSD 1.0850 SL 1.0800 TP 1.0900']) {
    assert.equal(parseSignal(message).isScalping, false, message.slice(0, 40));
  }
});

test('detection answers on its own, for callers that already know the entry', () => {
  assert.deepEqual(detectOrderType('BUY GOLD', { entryPrice: null }), { orderType: 'market', stated: false });
  assert.deepEqual(detectOrderType('BUY GOLD 4011', { entryPrice: 4011 }), { orderType: 'limit', stated: false });
  assert.deepEqual(detectOrderType('BUY GOLD LIMIT ORDER', { entryPrice: null }), { orderType: 'limit', stated: true });
  assert.equal(detectScalping('(SCALPING) BUY GOLD NOW 4011'), true);
  assert.equal(detectScalping('BUY GOLD 4011'), false);
});

test('an order type never blocks a signal that is otherwise complete', () => {
  const parsed = parseSignal('BUY GOLD NOW 4110 SL 4100 TP 4130');
  assert.deepEqual(parsed.blockers, []);
  assert.equal(parsed.executionReady, true);
});
