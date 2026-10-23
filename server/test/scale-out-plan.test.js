import test from 'node:test';
import assert from 'node:assert/strict';
import { planScaleOutLevels, resolveCloseVolume, selectTarget, targetReached, SCALE_OUT_LADDER, TARGET_MODES } from '../services/scale-out.js';

const SPEC = { minVolume: 0.01, maxVolume: 100, volumeStep: 0.01, tickSize: 0.0001 };
const sellPlan = (overrides = {}) => planScaleOutLevels({
  levels: [4029.5, 4027.5, 4025.5], side: 'sell', bid: 4032.1, ask: 4032.6, volume: 0.1, specification: SPEC, ...overrides,
});

/* ---------------------------------------------------------------- which price the trade carries */

test('the mode decides which of the channel targets the position itself carries', () => {
  assert.deepEqual(selectTarget({ mode: 'first_target', takeProfit: 4029.5, levels: [4029.5, 4027.5] }), { takeProfit: 4029.5, mode: 'first_target', source: 'signal' });
  assert.equal(selectTarget({ mode: 'final_target', takeProfit: 4029.5, levels: [4029.5, 4027.5] }).takeProfit, 4027.5);
  assert.equal(selectTarget({ mode: 'scale_out', takeProfit: 4029.5, levels: [4029.5, 4027.5, 4025.5] }).takeProfit, 4025.5, 'the ride needs a real target on the broker');
  // One named target is not a choice between targets, and an unknown value is not a licence to guess.
  assert.equal(selectTarget({ mode: 'scale_out', takeProfit: 4029.5, levels: [4029.5] }).takeProfit, 4029.5);
  assert.equal(selectTarget({ mode: 'nonsense', takeProfit: 4029.5, levels: [4029.5, 4027.5] }).takeProfit, 4029.5);
  assert.equal(selectTarget({}).takeProfit, null);
  assert.deepEqual(TARGET_MODES, ['first_target', 'final_target', 'scale_out'], 'the three answers are the three the panel offers');
});

/* ---------------------------------------------------------------- the ladder */

test('a three-target message is split 50 / 30 with a fifth of the trade riding', () => {
  const plan = sellPlan();
  assert.equal(plan.eligible, true);
  assert.equal(plan.takeProfit, 4025.5, 'the final target is the exit the broker holds');
  assert.deepEqual(plan.levels.map((level) => [level.level, level.price, level.closePercent, level.volume, level.breakEven]), [
    [1, 4029.5, 50, 0.05, true],
    [2, 4027.5, 30, 0.03, false],
  ]);
  assert.equal(plan.rideVolume, 0.02);
  assert.equal(plan.ridePercent, 20);
  assert.deepEqual(SCALE_OUT_LADDER, [50, 30, 10]);
});

test('two targets are half and half, and three or more share the same budget', () => {
  const two = planScaleOutLevels({ levels: [1.12, 1.15], side: 'buy', bid: 1.0998, ask: 1.1, volume: 0.1, specification: SPEC });
  assert.deepEqual(two.levels.map((level) => [level.price, level.closePercent, level.volume]), [[1.12, 50, 0.05]]);
  assert.equal(two.takeProfit, 1.15);
  assert.equal(two.ridePercent, 50, 'closing 80% at the first target is not what two targets describes');

  const four = planScaleOutLevels({ levels: [1.11, 1.12, 1.13, 1.15], side: 'buy', bid: 1.0998, ask: 1.1, volume: 0.1, specification: SPEC });
  assert.deepEqual(four.levels.map((level) => [level.price, level.volume]), [[1.11, 0.02], [1.12, 0.02], [1.13, 0.02]]);
  assert.equal(four.takeProfit, 1.15);
  assert.equal(Number((four.levels.reduce((sum, level) => sum + level.volume, 0) + four.rideVolume).toFixed(8)), 0.1, 'the pieces are the whole trade, no more');
});

test('a level the broker could not hold returns its share to the ride rather than being traded anyway', () => {
  // 0.03 lots: 50% is 0.01 (legal), 30% is 0.009, which rounds below the 0.01 minimum - so that level
  // is recorded as skipped and never sent, and the ride keeps 0.02.
  const plan = planScaleOutLevels({ levels: [1.12, 1.15, 1.18], side: 'buy', bid: 1.0998, ask: 1.1, volume: 0.03, specification: SPEC });
  assert.deepEqual(plan.levels.map((level) => [level.price, level.volume]), [[1.12, 0.01]]);
  assert.deepEqual(plan.dropped, [{ price: 1.15, reason: 'below-broker-minimum-lot' }]);
  assert.equal(plan.rideVolume, 0.02);
  assert.equal(plan.ridePercent, 66.67, 'the percent describes the position, not the budget the ladder planned to spend');
  assert.equal(planScaleOutLevels({ levels: [1.12, 1.15, 1.18], side: 'buy', bid: 1.0998, ask: 1.1, volume: 0.01, specification: SPEC }).reason, 'volume-too-small', 'a position that cannot be halved cannot be scaled out of');
});

test('the channel owns the sequence, so a level out of order is dropped and never renumbered', () => {
  const unordered = planScaleOutLevels({ levels: [1.15, 1.12, 1.18], side: 'buy', bid: 1.0998, ask: 1.1, volume: 0.1, specification: SPEC });
  assert.deepEqual(unordered.levels.map((level) => level.price), [1.15]);
  assert.equal(unordered.takeProfit, 1.18);
  assert.deepEqual(unordered.dropped, [{ price: 1.12, reason: 'not-beyond-previous-target' }]);

  // A "target" on the wrong side of the quote the order goes out at is not a target; it is the entry.
  const wrongSide = planScaleOutLevels({ levels: [4033, 4029.5, 4027.5], side: 'sell', bid: 4032.1, ask: 4032.6, volume: 0.1, specification: SPEC });
  assert.deepEqual(wrongSide.dropped, [{ price: 4033, reason: 'wrong-side-of-market' }]);
  assert.deepEqual(wrongSide.levels.map((level) => level.price), [4029.5]);
  assert.equal(wrongSide.takeProfit, 4027.5);

  // With one usable level left there is no plan, and the trade keeps the target the parser read.
  assert.equal(planScaleOutLevels({ levels: [1.09, 1.08], side: 'buy', bid: 1.1, ask: 1.1002, volume: 0.1, specification: SPEC }).eligible, false);
  assert.equal(planScaleOutLevels({ levels: [1.12], side: 'buy', bid: 1.0998, ask: 1.1, volume: 0.1, specification: SPEC }).reason, 'needs-two-targets');
  assert.equal(planScaleOutLevels({ levels: [1.12, 1.15], side: 'buy', bid: 1.0998, ask: 1.1, volume: 0.1 }).reason, 'sizing-unavailable', 'no broker rules, no lots to split');
});

/* ---------------------------------------------------------------- reaching a price, and how much to close */

test('a target is reached at the price the close would execute at, not the other side of the spread', () => {
  // A buy exits at the bid: an ask that touched the target means nothing while the bid is under it.
  assert.deepEqual(targetReached({ side: 'buy', bid: 1.1201, ask: 1.1205, target: 1.12 }), { reached: true, price: 1.1201 });
  assert.equal(targetReached({ side: 'buy', bid: 1.1199, ask: 1.1205, target: 1.12 }).reached, false);
  assert.deepEqual(targetReached({ side: 'sell', bid: 1.115, ask: 1.1199, target: 1.12 }), { reached: true, price: 1.1199 });
  assert.equal(targetReached({ side: 'sell', bid: 1.115, ask: 1.1201, target: 1.12 }).reached, false);
  assert.equal(targetReached({ side: 'buy', bid: 0, ask: 0, target: 1.12 }).reason, 'price-unavailable');
  assert.equal(targetReached({ side: 'hold', bid: 1.12, ask: 1.12, target: 1.12 }).reached, false, 'a directionless position is not a match');
});

test('the volume actually closed is the broker-safe amount, whichever way the position has moved', () => {
  assert.deepEqual(resolveCloseVolume({ plannedVolume: 0.05, liveVolume: 0.1, minVolume: 0.01, volumeStep: 0.01 }), { error: null, closeAll: false, volume: 0.05 });
  assert.deepEqual(resolveCloseVolume({ plannedVolume: 0.05, liveVolume: 0.05, minVolume: 0.01, volumeStep: 0.01 }), { error: null, closeAll: true, volume: 0.05 }, 'the plan asked for everything that is left');
  assert.equal(resolveCloseVolume({ plannedVolume: 0.05, liveVolume: 0, minVolume: 0.01, volumeStep: 0.01 }).reason, 'position-gone');
  assert.match(resolveCloseVolume({ plannedVolume: 0.005, liveVolume: 0.1, minVolume: 0.01, volumeStep: 0.01 }).error, /below this symbol's 0\.01 lot minimum/);
  // Trimming to the smallest close that still leaves a legal position is the conservative reading: it
  // banks part of the target without asking the broker to hold dust.
  const shrunk = resolveCloseVolume({ plannedVolume: 0.09, liveVolume: 0.1, minVolume: 0.02, volumeStep: 0.01 });
  assert.equal(shrunk.volume, 0.08);
  assert.match(shrunk.note, /less than the plan asked for/);
  // And when no legal close exists at all - every candidate volume would leave an illegal remainder -
  // the level is refused outright rather than the position being squeezed into a shape nobody chose.
  assert.match(resolveCloseVolume({ plannedVolume: 0.04, liveVolume: 0.05, minVolume: 0.03, volumeStep: 0.01 }).error, /would leave 0\.01 lots, below this symbol's 0\.03 lot minimum/);
  assert.match(resolveCloseVolume({ plannedVolume: null, liveVolume: 0.1, minVolume: 0.01, volumeStep: 0.01 }).error, /did not provide a position size/);
});
