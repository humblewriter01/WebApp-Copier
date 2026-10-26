import test from 'node:test';
import assert from 'node:assert/strict';
import { countSignalEntryDeals, parseSignal, resolveBrokerSymbol } from '../services/signal-parser.js';
import { captureSafety } from '../services/signal-safety.js';

test('parses a strict BUY signal with an entry, stop loss, and one target', () => {
  const parsed = parseSignal('BUY EURUSD\nEntry: 1.0850\nSL: 1.0800\nTP1: 1.0950');
  assert.deepEqual(parsed, {
    symbol: 'EURUSD', side: 'buy', entryPrice: 1.085, stopLoss: 1.08, takeProfit: 1.095,
    executionReady: true, parseError: null,
    directionInferred: false,
    hasTradingData: true,
    entryRange: null,
    takeProfitLevels: [1.095],
    // The legs the message stated as a *distance* rather than a price, the DCA plan it listed, and the
    // numbers it wrote in a form nobody could settle: all null here, because this message is exact.
    stopLossPips: null,
    takeProfitPips: null,
    entryLevels: null,
    entryWasBare: false,
    ambiguousLevels: [],
    // Not news: the message is an instruction, so nothing about the bulletin rule applies to it.
    newsOnly: false,
    newsMarkers: [],
    managementUpdate: false,
    managementMarkers: [],
    // The message publishes a price and never says `NOW`, so it is read as a level to be filled *at*. Not
    // because the channel asked for a pending order - it did not - but because a price that was written down
    // is a price the trader meant to get, and `orderTypeStated: false` is what keeps the two apart on screen.
    orderType: 'limit',
    orderTypeStated: false,
    isScalping: false,
    hasPriceLevel: true,
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

test('rejects ambiguous directions and symbols, and a range with no direction to read it against', () => {
  assert.match(parseSignal('BUY SELL EURUSD SL 1.0').parseError, /direction/i);
  assert.match(parseSignal('BUY EURUSD GBPUSD SL 1.0').parseError, /symbol/i);
  // A stop or target given as a range is genuinely one price the channel did not commit to, so the
  // refusal stays: an entry range can be bounded by the direction, a stop range cannot.
  assert.match(parseSignal('BUY EURUSD SL 1.08-1.06').parseError, /stop-loss range/i);
  assert.match(parseSignal('BUY EURUSD SL 1.08 TP 1.11-1.12').parseError, /take-profit range/i);
  // Two stops is not a signal with a spare stop; it is a message that does not say which one to use.
  // Only an unambiguous stop is read, so a target can be indexed and a stop never both.
  assert.match(parseSignal('BUY EURUSD SL 1.08 SL 1.07 TP 1.12').parseError, /more than one stop loss/i);
});

test('a price the message restates is still one price', () => {
  // Channels repeat themselves in prose and in short-hand; only two different numbers is a conflict.
  const restated = parseSignal('SELL GBPUSD Entry 1.2750 SL 1.28 TP 1.26 (SL 1.28 is above entry)');
  assert.equal(restated.stopLoss, 1.28);
  assert.deepEqual(restated.blockers, []);
  assert.equal(restated.executionReady, true);
  const repeatedTarget = parseSignal('BUY EURUSD Entry 1.08 SL 1.07 TP 1.12 TP 1.12');
  assert.equal(repeatedTarget.takeProfit, 1.12);
  assert.deepEqual(repeatedTarget.takeProfitLevels, [1.12]);
  // Two different stops stay a contradiction, whatever the spelling.
  assert.match(parseSignal('BUY EURUSD SL 1.08 SL 1.07 TP 1.12').parseError, /more than one stop loss/i);
});

test('an entry zone is read as an entry, at the least favourable price in it for the side', () => {
  // The bound is what keeps the engine's price guard honest, so a buy takes the top of its zone and a
  // sell the bottom, and neither can look better-filled than the channel described.
  assert.equal(parseSignal('BUY EURUSD Entry 1.10-1.12 SL 1.08').entryPrice, 1.12);
  assert.equal(parseSignal('SELL EURUSD Entry 1.10-1.12 SL 1.14').entryPrice, 1.1);
  const zone = parseSignal('GOLD SELL NOW IN ZONE  4031.50-4138.60 SL : 4041.50');
  assert.equal(zone.entryPrice, 4031.5, 'the word ZONE is an entry label, not an unknown word');
  assert.deepEqual(zone.entryRange, { low: 4031.5, high: 4138.6 });
  assert.equal(zone.missing.entryPrice, false);
  // Without a direction there is no bound to pick, so the range still reads as a range.
  const directionless = parseSignal('EURUSD IN ZONE 1.10-1.12 SL 1.08');
  assert.equal(directionless.entryPrice, null);
  assert.ok(directionless.blockers.some((blocker) => blocker.code === 'entry-range'), 'saved for review, with the reason named');
});

/* Scale-out targets used to be a refusal, while the Advanced Safety panel told users that "missing or
   multiple targets are shown as they are; the block above is what decides, not the parser". Reading
   TP1 and leaving the rest on the row makes that sentence true, and closing at the first target is
   earlier than the channel's plan, never riskier: the stop still governs the risk. */
test('numbered targets are read, with the first one as the exit and the rest recorded', () => {
  const two = parseSignal('BUY EURUSD SL 1.08 TP1 1.12 TP2 1.15');
  assert.equal(two.takeProfit, 1.12, 'TP1 is the primary target');
  assert.deepEqual(two.takeProfitLevels, [1.12, 1.15]);
  assert.deepEqual(two.blockers, [], 'a plan with several exits is not a contradiction');
  assert.equal(two.executionReady, true);
  assert.equal(two.missing.takeProfit, false);
  // A target that names no price at all is not a target, and must not read as one worth 1 point.
  const openEnd = parseSignal('BUY EURUSD Entry 1.08 SL 1.07 TP 1 : 1.10 TP 2 : OPEN');
  assert.equal(openEnd.takeProfit, 1.1, 'the index is consumed as a label, not as the price');
  assert.deepEqual(openEnd.takeProfitLevels, [1.1]);
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
  // The parser only states facts. Whether a missing stop is survivable is one workspace setting away, so
  // that judgement lives in `captureSafety` and is tested there against this same shape.
  assert.deepEqual(noStop.blockers.map((blocker) => blocker.code), ['stop-loss-missing']);
  assert.equal(noStop.hasTradingData, true, 'a usable note is not "no clear signal"');

  const noTarget = parseSignal('BUY EURUSD Entry 1.08 SL 1.06');
  assert.deepEqual(noTarget.missing, { entryPrice: false, stopLoss: false, takeProfit: true });
  assert.equal(noTarget.blockers.length, 0, 'a missing target is not a reason to refuse execution');

  const prose = parseSignal('good morning everyone, another great week ahead');
  assert.equal(prose.hasTradingData, false, 'only a message with no trading data at all reads as unclear');
  assert.deepEqual(prose.blockers.map((blocker) => blocker.code), ['direction-missing', 'symbol', 'stop-loss-missing'], 'a greeting is refused for what it actually lacks');

  // Several exits are a plan, not a gap: the first is used and the rest are kept as levels.
  const twoTargets = parseSignal('BUY EURUSD SL 1.08 TP1 1.12 TP2 1.15');
  assert.equal(twoTargets.takeProfit, 1.12);
  assert.deepEqual(twoTargets.missing, { entryPrice: true, stopLoss: false, takeProfit: false });
  assert.deepEqual(twoTargets.blockers, []);
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

test('a number glued to a unit word is a distance even when the unit is written without a space', () => {
  /* `50PIPS` with no space was read as an entry of 5: `\d+` matched 50, the unit guard rejected it, and the
     engine gave a digit back until the guard was happy. Every "N lots", "N pips", "2%" glued to its word is
     the same shape, and each one was a price the channel never stated. */
  const shout = '\u{1F4C8} GOLD BUY : 50PIPS \n\nUS Session setups buy, traders ! Like i said, Always trust your market mover here ! \u{1F64F}\n\n\u{1F4F9}@OnlyLunaBecht';
  const parsed = parseSignal(shout);
  assert.equal(parsed.symbol, 'XAUUSD', 'the metal is still a fact about the message');
  assert.equal(parsed.side, 'buy');
  assert.equal(parsed.entryPrice, null, 'while the number is a distance with no leg to belong to');
  assert.equal(parsed.executionReady, false);
  assert.equal(parseSignal('BUY GOLD 50 lots').entryPrice, null, 'and a size is not an entry either');
  assert.equal(parseSignal('SELL : 300PIPS').entryPrice, null);
  assert.equal(parseSignal('BUY GOLD 4011').entryPrice, 4011, 'a whole number that is a price is still read as one');
  assert.equal(parseSignal('BUY GOLD @ 4011.50').entryPrice, 4011.5, 'and so is a decimal');
});


/* --------------------------------------------------------------------- market news is not a signal --------------------------------------------------------------------- */

/** The message a monitored channel actually posted, with its emojis, its bold markers and its blank lines. */
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

test('a news bulletin yields nothing at all: no symbol, no direction, no price', () => {
  /* Four instruments and four prices, and not one instruction. Before this rule the row came back with
     `symbol: BTCUSD` on it, which made a headline look like a signal the platform had read halfway - and a
     half-read signal is what a review badge, a fallback distance, or a reader in a hurry can turn into a
     trade. The whole message is refused instead, so the row says what is true of it: nothing was found. */
  const parsed = parseSignal(NEWS_BULLETIN);
  assert.equal(parsed.newsOnly, true, 'and the reason is recorded, not inferred by the reader');
  assert.equal(parsed.symbol, null, 'the coins it names are not extracted');
  assert.equal(parsed.side, null, 'a price falling is not a sell');
  assert.equal(parsed.entryPrice, null);
  assert.equal(parsed.stopLoss, null);
  assert.equal(parsed.takeProfit, null);
  assert.equal(parsed.hasTradingData, false, 'so the client can call it "No clear signal" honestly');
  assert.equal(parsed.hasPriceLevel, false, 'and no fallback distance has anything to attach to');
  assert.equal(parsed.executionReady, false);
});

test('the row says it is news, and does not blame a leg nobody asked for', () => {
  const parsed = parseSignal(NEWS_BULLETIN);
  assert.deepEqual(parsed.blockers, [{
    code: 'news-commentary',
    message: 'This message is market news rather than a trade instruction, so nothing was taken from it.',
  }], 'one reason, in plain words, instead of "a BUY or SELL direction was not found"');
  assert.equal(parsed.parseError, 'This message is market news rather than a trade instruction, so nothing was taken from it.');
  assert.equal(parsed.directionInferred, false, 'and no direction is read out of a headline by any route');
  assert.equal(parsed.isScalping, false);
  assert.deepEqual(parsed.takeProfitLevels, []);
});

test('news wording above a real instruction is read as the instruction', () => {
  /* Channels shout. The same "JUST IN" over a complete gold setup must still be traded, which is why the
     rule needs an absence of instruction as well as a presence of news words. */
  const parsed = parseSignal('**JUST IN** \u{1F6A8} SELL GOLD 4016.00 - 4026.00 / SL: 4010.00 / TP: 4050.00');
  assert.equal(parsed.newsOnly, false);
  assert.equal(parsed.symbol, 'XAUUSD');
  assert.equal(parsed.side, 'sell');
  assert.equal(parsed.entryPrice, 4016);
  assert.equal(parsed.executionReady, true, 'and it is eligible, hype prefix and all');
});

test('a signal that mentions a report is not refused for mentioning it', () => {
  const parsed = parseSignal('GOLD 4016.00 SL: 4010.00 TP: 4050.00 (full report on the website)');
  assert.equal(parsed.newsOnly, false, 'the leg labels outrank one journalism noun');
  assert.equal(parsed.symbol, 'XAUUSD');
  assert.equal(parsed.stopLoss, 4010);
  assert.equal(parsed.takeProfit, 4050);
});

test('a headline cannot be finished into an order by a workspace fallback distance', () => {
  /* The nets in Safety settings exist for a trader who forgot to write a stop, and a channel that never
     asked for a trade has not forgotten anything. `hasPriceLevel` is the flag that keeps them furled. */
  const safety = captureSafety({
    parsed: parseSignal(NEWS_BULLETIN),
    source: 'telegram',
    settings: { lotSizeMode: 'fixed', blockExecutionWithoutStopLoss: true, blockExecutionWithoutTakeProfit: true, fallbackStopLossPoints: 500, fallbackTakeProfitPoints: 1000 },
  });
  assert.equal(safety.executionReady, false);
  assert.deepEqual(safety.fallbacks, { stopLoss: null, takeProfit: null });
  assert.equal(safety.override.stopLoss, false, 'and no policy override is claimed for a leg nobody asked about');
  assert.equal(safety.problems.length, 0, 'and it is not reported as a missing leg on top of being news');
  assert.equal(safety.parseError, 'This message is market news rather than a trade instruction, so nothing was taken from it.');
});
