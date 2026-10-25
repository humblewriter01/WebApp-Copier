/**
 * The rules themselves, away from the broker.
 *
 * The engine tests in `order-type-execution.test.js` prove the wiring; these prove the arithmetic and the
 * boundaries that only show up at the edges - an expiry of zero, a tick size the broker never published, a
 * setting stored by a workspace that has since been downgraded, a cancel that arrived after the order had
 * already filled on its own. Each of those is a case where a confident answer is worse than a refusal, so
 * the refusal is what is pinned here.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  EXPIRY_UNITS, MAX_EXPIRY_DAYS, SCALP_EXPIRY_MS,
  expiryCeiling, expiryUnitMs, expiryWindowMs, isUsableExpiry,
  interpretCancelResponse, marketSlippage, pendingOrderOutcome, pendingOrderPlan,
  readExpirySetting, readSlippageSetting, resolveOrderExpiry,
} from '../services/order-routing.js';

const MINUTE = 60_000;

test('the expiry units are the ones the settings route and the client both offer', () => {
  assert.deepEqual(EXPIRY_UNITS, ['minutes', 'hours', 'days']);
  assert.equal(expiryUnitMs('minutes'), MINUTE);
  assert.equal(expiryUnitMs('HOURS'), null, 'case is normalised by the reader, not by this');
  assert.equal(expiryUnitMs('weeks'), null, 'a unit nobody offered has no answer');
  assert.equal(expiryUnitMs(null), MINUTE, 'and no unit at all means the default unit, not no deadline');
  assert.equal(expiryCeiling('days'), 30);
  assert.equal(expiryCeiling('hours'), 720);
  assert.equal(expiryCeiling('minutes'), 43_200);
});

test('a workspace expiry becomes an absolute deadline, and only a resting order tells the broker', () => {
  const plain = resolveOrderExpiry({ value: 45, unit: 'minutes', now: 1_000_000 });
  assert.deepEqual({ windowMs: plain.windowMs, expiresAt: plain.expiresAt, source: plain.source }, { windowMs: 45 * MINUTE, expiresAt: 1_000_000 + 45 * MINUTE, source: 'setting' });
  assert.equal(plain.brokerExpiration, null, 'a market order cannot carry an expiration, so none is invented for it');

  const resting = resolveOrderExpiry({ value: 2, unit: 'hours', pendingOrder: true, now: 0 });
  assert.equal(resting.brokerExpiration.type, 'ORDER_TIME_SPECIFIED', 'the one expiration type MT4 supports is the one both platforms get');
  assert.equal(resting.brokerExpiration.time.getTime(), 2 * 60 * MINUTE);
});

test('a scalping signal overrides the workspace expiry, and the ceiling is applied rather than refused', () => {
  assert.equal(SCALP_EXPIRY_MS, 2 * MINUTE);
  const scalp = resolveOrderExpiry({ value: 8, unit: 'hours', isScalping: true, pendingOrder: true, now: 0 });
  assert.equal(scalp.windowMs, 2 * MINUTE, 'eight hours of patience is not what a scalp asked for');
  assert.equal(scalp.source, 'scalping', 'and the row says which rule produced the deadline');

  const over = resolveOrderExpiry({ value: 400, unit: 'days', pendingOrder: true, now: 0 });
  assert.equal(over.windowMs, MAX_EXPIRY_DAYS * 24 * 60 * MINUTE, '400 days is clamped to 30 rather than honoured');
  assert.equal(over.clamped, true, 'and the clamp is reported, so a note can say so out loud');

  const under = resolveOrderExpiry({ value: 1, unit: 'seconds', now: 0 });
  assert.equal(under.source, 'default', 'an unusable unit is not an expiry of zero: it is no expiry chosen');
  assert.equal(under.windowMs, 30 * MINUTE);
});

test('an unusable stored setting falls back to the default rather than to no deadline', () => {
  assert.equal(expiryWindowMs({ value: 'abc', unit: 'minutes' }), 30 * MINUTE);
  assert.equal(expiryWindowMs({ value: -5, unit: 'minutes' }), 30 * MINUTE);
  assert.equal(expiryWindowMs({ value: null, unit: null }), 30 * MINUTE);
  assert.equal(expiryWindowMs({ value: 3, unit: 'hours' }), 180 * MINUTE);
  assert.equal(isUsableExpiry({ value: '', unit: 'minutes' }), false);
  assert.equal(isUsableExpiry({ value: 10, unit: 'minutes' }), true);
});

test('the settings route accepts what the engine can honour and refuses the rest by name', () => {
  assert.deepEqual(readExpirySetting({}), { value: 30, unit: 'minutes', error: null });
  assert.deepEqual(readExpirySetting({ value: '12', unit: 'HOURS' }), { value: 12, unit: 'hours', error: null });
  assert.deepEqual(readExpirySetting({ value: 30, unit: 'days' }), { value: 30, unit: 'days', error: null }, 'the ceiling is inclusive');
  assert.match(readExpirySetting({ value: 31, unit: 'days' }).error, /at most 30 days/);
  assert.match(readExpirySetting({ value: 0, unit: 'minutes' }).error, /whole number of minutes between 1 and 43200/);
  assert.match(readExpirySetting({ value: 1.5, unit: 'hours' }).error, /whole number/);
  assert.match(readExpirySetting({ value: 5, unit: 'weeks' }).error, /minutes, hours, days/);
  assert.match(readExpirySetting({ value: {}, unit: 'minutes' }).error, /whole number of minutes/);
});

test('the drift guard is blank, zero, or a whole number - and never negative', () => {
  assert.deepEqual(readSlippageSetting(''), { value: null, error: null });
  assert.deepEqual(readSlippageSetting(null), { value: null, error: null });
  assert.deepEqual(readSlippageSetting(0), { value: 0, error: null }, '0 is an explicit choice and is kept as one');
  assert.deepEqual(readSlippageSetting('250'), { value: 250, error: null });
  assert.match(readSlippageSetting(-1).error, /between 0 and 100000/);
  assert.match(readSlippageSetting(1.5).error, /whole number/);
  assert.match(readSlippageSetting(true).error, /whole number of points/);
});

/* ------------------------------------------------------------------ the slippage matrix ------------------------------------------------------------------ */

test('a better fill is never refused, in either direction', () => {
  const buy = marketSlippage({ side: 'buy', desired: 4110, ask: 4109, bid: 4108.9, tickSize: 0.01 });
  assert.deepEqual({ action: buy.action, favourable: buy.favourable, driftPoints: buy.driftPoints }, { action: 'execute', favourable: true, driftPoints: 100 });
  assert.equal(buy.message, null, 'and it is not a warning, because nothing had to be forgiven');

  const sell = marketSlippage({ side: 'sell', desired: 4110, bid: 4115, ask: 4115.1, tickSize: 0.01 });
  assert.equal(sell.action, 'execute', 'a sell filled higher than published is the same favour, inverted');
  assert.equal(sell.favourable, true);
});

test('a worse fill is judged by the allowance, in the broker\u0027s own points', () => {
  const strict = marketSlippage({ side: 'buy', desired: 4110, ask: 4115, bid: 4114.9, tickSize: 0.01, maxSlippagePoints: null });
  assert.equal(strict.action, 'skip');
  assert.equal(strict.reason, 'drift-exceeded');
  assert.equal(strict.driftPoints, 500);
  assert.match(strict.message, /the ask is 500 points above the signal price of 4110/);
  assert.match(strict.message, /allows no drift at all/);

  const inside = marketSlippage({ side: 'buy', desired: 4110, ask: 4115, bid: 4114.9, tickSize: 0.01, maxSlippagePoints: 500 });
  assert.equal(inside.action, 'execute', 'exactly at the allowance is inside it');
  assert.match(inside.message, /inside your 500-point drift guard/);

  const beyond = marketSlippage({ side: 'buy', desired: 4110, ask: 4115.01, bid: 4115, tickSize: 0.01, maxSlippagePoints: 1 });
  assert.equal(beyond.action, 'skip', 'one point past it is outside it');

  const sell = marketSlippage({ side: 'sell', desired: 4110, bid: 4100, ask: 4100.1, tickSize: 0.01, maxSlippagePoints: 50 });
  assert.equal(sell.action, 'skip');
  assert.match(sell.message, /the bid is 1000 points below/, 'a sell is worse when it is lower, and the sentence says which side it looked at');
});

test('a point cannot be invented from a symbol with no tick size, and a price cannot be guarded without a quote', () => {
  const noTick = marketSlippage({ side: 'buy', desired: 4110, ask: 4115, bid: 4114.9 });
  assert.equal(noTick.action, 'skip', 'we could not measure the drift, so the strict reading is taken and said');
  assert.match(noTick.message, /no tick size to measure that in points/);

  const noQuote = marketSlippage({ side: 'buy', desired: 4110, ask: 0, bid: 0, tickSize: 0.01 });
  assert.deepEqual({ action: noQuote.action, reason: noQuote.reason }, { action: 'skip', reason: 'no-quote' });

  const noPrice = marketSlippage({ side: 'buy', desired: null, ask: 4109, bid: 4108.9, tickSize: 0.01 });
  assert.equal(noPrice.action, 'execute', 'nothing was published, so there is nothing to have drifted from');
  assert.equal(noPrice.reason, 'no-stated-price');
});

/* ------------------------------------------------------------------ the resting-order plan ------------------------------------------------------------------ */

test('a level that is still ahead of the market rests; a level already reached is taken', () => {
  const buyLimit = pendingOrderPlan({ orderType: 'limit', entryPrice: 4011, side: 'buy', bid: 4020, ask: 4020.1, tickSize: 0.01 });
  assert.deepEqual({ kind: buyLimit.kind, price: buyLimit.price }, { kind: 'pending', price: 4011 });

  const through = pendingOrderPlan({ orderType: 'limit', entryPrice: 4025, side: 'buy', bid: 4020, ask: 4020.1, tickSize: 0.01 });
  assert.equal(through.kind, 'market');
  assert.equal(through.reason, 'level-would-fill-now', 'a buy limit above the ask is not a limit, it is a market order the server would refuse');

  const sellStop = pendingOrderPlan({ orderType: 'stop', entryPrice: 4005, side: 'sell', bid: 4010, ask: 4010.1, tickSize: 0.01 });
  assert.equal(sellStop.kind, 'pending');
  const triggered = pendingOrderPlan({ orderType: 'stop', entryPrice: 4005, side: 'buy', bid: 4010, ask: 4010.1, tickSize: 0.01 });
  assert.equal(triggered.kind, 'market', 'the breakout a buy stop was waiting for already happened');
});

test('a market signal never reaches the plan, and a plan with no level has nothing to rest at', () => {
  assert.equal(pendingOrderPlan({ orderType: 'market', entryPrice: 4011, side: 'buy', bid: 4010, ask: 4010.1 }).kind, 'market');
  const noLevel = pendingOrderPlan({ orderType: 'limit', entryPrice: null, side: 'buy', bid: 4010, ask: 4010.1 });
  assert.equal(noLevel.kind, 'market');
  assert.match(noLevel.note, /states no entry price/);
  const noQuote = pendingOrderPlan({ orderType: 'limit', entryPrice: 4011, side: 'buy', bid: 0, ask: 0 });
  assert.equal(noQuote.kind, 'skip');
});

test('a pending order the broker would refuse for being too close is refused here, naming the number', () => {
  const tooClose = pendingOrderPlan({ orderType: 'limit', entryPrice: 4020.02, side: 'buy', bid: 4020, ask: 4020.1, stopsLevelPoints: 10, tickSize: 0.01 });
  assert.equal(tooClose.kind, 'market', 'a limit that close would fill on the next tick anyway, so it is taken rather than rested');
  assert.match(tooClose.note, /broker keeps 10/);

  // A buy stop 5 points *above* the ask is on the correct side to be a stop, so `resting` is not what refuses
  // it - the broker's own minimum distance is, and refusing is the only honest answer: moving the level would
  // be choosing an entry the channel did not publish.
  const stop = pendingOrderPlan({ orderType: 'stop', entryPrice: 4020.15, side: 'buy', bid: 4020, ask: 4020.1, stopsLevelPoints: 10, tickSize: 0.01 });
  assert.equal(stop.kind, 'skip', 'a stop that close is an invalid price on the platform, and it is not quietly moved');
  assert.match(stop.message, /4020\.15 is 5 points from the market and this broker requires pending orders at least 10 points away/);
});

/* ------------------------------------------------------------------ what a resting order became ------------------------------------------------------------------ */

test('a read that failed is not evidence that an order is gone', () => {
  assert.equal(pendingOrderOutcome({}).action, 'defer');
  assert.equal(pendingOrderOutcome({ readOk: false, orderStillOpen: false }).action, 'defer');
  assert.match(pendingOrderOutcome({ readOk: false }).message, /could not be read/);
});

test('open, filled, expired and cancelled are four different answers', () => {
  assert.equal(pendingOrderOutcome({ readOk: true, orderStillOpen: true, expiryReached: true }).action, 'wait', 'past its deadline but still on the book is the sweeper\u0027s job, not a state change');
  assert.equal(pendingOrderOutcome({ readOk: true, orderStillOpen: false, positionFound: true, expiryReached: true }).action, 'filled');
  assert.equal(pendingOrderOutcome({ readOk: true, orderStillOpen: false, dealFound: true }).action, 'filled', 'a deal is a fill even when the position has already been closed again');
  assert.equal(pendingOrderOutcome({ readOk: true, orderStillOpen: false }).action, 'cancelled');
  assert.equal(pendingOrderOutcome({ readOk: true, orderStillOpen: false, expiryReached: true }).action, 'expired');
  assert.equal(pendingOrderOutcome({ readOk: true, orderStillOpen: false, expiryReached: true, cancelConfirmed: true }).reason, 'expiry-passed-and-cancelled-here');
  assert.equal(pendingOrderOutcome({ readOk: true, orderStillOpen: false, cancelConfirmed: true }).action, 'cancelled');
});

test('a fill is booked at the price and size the broker actually produced', () => {
  const fromPosition = pendingOrderOutcome({ readOk: true, positionFound: true, position: { positionId: 'pos-9', openPrice: 4010.8, volume: 0.02 } });
  assert.deepEqual({ action: fromPosition.action, positionId: fromPosition.positionId, entryPrice: fromPosition.entryPrice, volume: fromPosition.volume }, { action: 'filled', positionId: 'pos-9', entryPrice: 4010.8, volume: 0.02 });
  const fromDeal = pendingOrderOutcome({ readOk: true, dealFound: true, deal: { positionId: 'pos-9', price: 4011 } });
  assert.equal(fromDeal.entryPrice, 4011, 'and when only the deal is left, the deal\u0027s own price is the fill');
});

/* ------------------------------------------------------------------ reading the broker's answer ------------------------------------------------------------------ */

test('a cancel is accepted, already-done, or refused - and only the last one is an error', () => {
  assert.equal(interpretCancelResponse({ result: { numericCode: 10025 } }).kind, 'cancelled');
  assert.equal(interpretCancelResponse({ result: { stringCode: 'TRADE_RETCODE_DONE' } }).kind, 'cancelled');
  assert.equal(interpretCancelResponse({ error: { numericCode: 10023 } }).kind, 'gone');
  assert.equal(interpretCancelResponse({ error: { message: 'order not found' } }).kind, 'gone', 'a race with the platform\u0027s own expiry is the outcome we wanted');
  assert.equal(interpretCancelResponse({ error: { numericCode: 10017, message: 'Trade is disabled' } }).kind, 'rejected');
  assert.equal(interpretCancelResponse({}).kind, 'rejected');
  assert.match(interpretCancelResponse({ error: { numericCode: 10017, message: 'Trade is disabled' } }).message, /Trade is disabled/);
});
