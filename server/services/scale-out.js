/* ---------------------------------------------------------------------------------------------
 * What a workspace does with a signal that numbered its targets.
 *
 * A channel that posts `TP 1 : 4029.50`, `TP 2 : 4027.50`, `TP 3 : OPEN` is publishing one trade with a
 * scale-out plan, and a copier that holds a single position has three honest answers: take the first
 * target and close, take the last one and let the trade run, or trade the plan itself - open the full
 * size at the final target and close pieces of it as each earlier target is reached. Which of the three
 * is a decision the workspace makes, so it is a setting, and this module is the only place that
 * arithmetic lives: the engine asks here what to send, and the sweep asks here what to close.
 *
 * The rules that never bend, and why:
 *  - a plan is only a plan when the prices are ordered in the trade's favour, so a level that sits on
 *    the wrong side of the live quote, or between two of its neighbours, is dropped rather than
 *    reordered - inventing a sequence the channel did not write is how a copy starts a trade it was
 *    never told to;
 *  - the ride is never squeezed below a fifth of the position, because the last target is the only leg
 *    the broker holds for you once the sweeps have finished;
 *  - every close is a volume the broker will accept: aligned onto its lot step, at least its minimum,
 *    and never leaving a remainder so small the terminal would have refused it;
 *  - nothing here reaches a broker. The engine reads these answers and acts, which is what lets the
 *    whole policy be tested without a connection.
 * ------------------------------------------------------------------------------------------- */

export const TARGET_MODES = ['first_target', 'final_target', 'scale_out'];

export const TARGET_MODE_LABELS = {
  first_target: 'First Target Only',
  final_target: 'Final Target Only',
  scale_out: 'Split & Scale-Out',
};

/** Share of the *original* volume each swept level closes; whatever is left rides to the final target. */
export const SCALE_OUT_LADDER = [50, 30, 10];
/** The floor for the leg that rides to the final target, in percent of the original volume. */
export const SCALE_OUT_MIN_RIDE_PERCENT = 20;

/* Null and 0 are not the same fact: a plan row whose volume never arrived must not read as "close no
   volume", which is a decision, while 0 lots is a broker error either way. */
function number(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function stepDecimals(step) {
  const text = String(step);
  return text.includes('.') ? text.length - text.indexOf('.') - 1 : 0;
}

function alignDown(value, step) {
  return Number((Math.floor(value / step + 1e-9) * step).toFixed(stepDecimals(step)));
}

/**
 * Is this level's price reached? A target is only "hit" at the price the *close* would execute at: a
 * buy exits at the bid, a sell at the ask. Reading the other side of the spread would let a level look
 * filled when the volume could not actually be closed at it.
 */
export function targetReached({ side, bid, ask, target }) {
  const price = side === 'buy' ? number(bid) : side === 'sell' ? number(ask) : null;
  const goal = number(target);
  if (price === null || goal === null || price <= 0 || goal <= 0) return { reached: false, reason: 'price-unavailable' };
  return { reached: side === 'buy' ? price >= goal : price <= goal, price };
}

/** Whether a level is on the profitable side of the market the trade was sent into. */
function inFavourOfTrade({ side, price, marketPrice }) {
  return side === 'buy' ? price > marketPrice : price < marketPrice;
}

/**
 * Which of the channel's prices the position itself should carry, before any scaling out. The
 * parser's `takeProfit` is already the first target, so only the two modes that look further down the
 * list have to change anything; a message that named one target has nothing to choose between.
 */
export function selectTarget({ mode = 'first_target', takeProfit = null, levels = [] } = {}) {
  const prices = (Array.isArray(levels) ? levels : []).map(number).filter((value) => value !== null);
  if (!TARGET_MODES.includes(mode) || mode === 'first_target' || prices.length < 2) {
    return { takeProfit, mode: TARGET_MODES.includes(mode) ? mode : 'first_target', source: 'signal' };
  }
  return { takeProfit: prices[prices.length - 1], mode, source: 'final-level' };
}

/**
 * The plan for one trade. `volume` is what the order will actually be sent at (the engine sizes before
 * it asks for a plan), so the shares are of real lots, not of a percentage the broker has to guess.
 *
 * Returns `{ eligible, reason }` when there is no plan to trade - and the caller then sends the order
 * with the target it already had, which is the behaviour a workspace had before this existed.
 */
export function planScaleOutLevels({ levels, side, bid, ask, volume, specification, minRidePercent = SCALE_OUT_MIN_RIDE_PERCENT } = {}) {
  if (side !== 'buy' && side !== 'sell') return { eligible: false, reason: 'direction' };
  const prices = (Array.isArray(levels) ? levels : []).map(number).filter((value) => value !== null && value > 0);
  if (prices.length < 2) return { eligible: false, reason: 'needs-two-targets' };
  const lots = number(volume);
  const minVolume = number(specification?.minVolume);
  const step = number(specification?.volumeStep);
  const marketPrice = side === 'buy' ? number(ask) : number(bid);
  if (![lots, minVolume, step, marketPrice].every((value) => value !== null && value > 0)) {
    return { eligible: false, reason: 'sizing-unavailable' };
  }

  /* Ordered, and only in the trade's favour: a level that would be reached before the one before it is
     not a step in a ladder, and a level on the wrong side of the market is not a target at all. */
  const kept = [];
  const dropped = [];
  for (const price of prices) {
    if (!inFavourOfTrade({ side, price, marketPrice })) { dropped.push({ price, reason: 'wrong-side-of-market' }); continue; }
    const last = kept[kept.length - 1];
    if (last !== undefined && (side === 'buy' ? price <= last.price : price >= last.price)) { dropped.push({ price, reason: 'not-beyond-previous-target' }); continue; }
    kept.push({ price, level: kept.length + 1 });
  }
  if (kept.length < 2) return { eligible: false, reason: 'no-ordered-targets', dropped };
  if (lots < minVolume * 2) {
    // A position that cannot be halved and still leave a legal remainder cannot be scaled out of at all.
    return { eligible: false, reason: 'volume-too-small', dropped };
  }

  const swept = kept.slice(0, -1);
  const ride = kept[kept.length - 1];
  const budget = Math.max(0, 100 - Math.max(0, Number(minRidePercent) || 0));
  /* Two swept levels follow the documented ladder (50 then 30, 20 rides). One swept level - a message
     with exactly two targets - takes half, because closing 80% of a trade at its first target while a
     sliver rides to the second is not what "take some off here and the rest there" describes. Three or
     more share the same budget evenly: the ladder was written for a three-target message, and inventing
     a fourth slice would be deciding the size of a close the channel never named. */
  const shares = swept.length === 1 ? [Math.min(SCALE_OUT_LADDER[0], budget)]
    : swept.length === 2 ? SCALE_OUT_LADDER.slice(0, 2).map((value) => Math.min(value, budget))
      : swept.map(() => Number((budget / swept.length).toFixed(2)));

  const planned = [];
  let usedPercent = 0;
  swept.forEach((item, index) => {
    const last = index === swept.length - 1;
    // The final swept level absorbs whatever the even split could not spend, so a ladder of three or
    // more still sums to the budget exactly and the ride is never a rounding error short.
    const share = last && swept.length > 2 ? budget - usedPercent : Math.min(shares[index] ?? 0, budget - usedPercent);
    const percent = Number(Math.max(0, share).toFixed(2));
    const lotsToClose = alignDown((lots * percent) / 100, step);
    usedPercent = Number((usedPercent + percent).toFixed(2));
    if (percent <= 0 || lotsToClose < minVolume) {
      dropped.push({ price: item.price, reason: lotsToClose < minVolume ? 'below-broker-minimum-lot' : 'no-share-left' });
      return;
    }
    planned.push({ level: item.level, price: item.price, closePercent: percent, volume: lotsToClose, breakEven: index === 0, status: 'pending' });
  });

  if (!planned.length) return { eligible: false, reason: 'no-legal-slice', dropped };
  const closedLots = Number(planned.reduce((sum, item) => sum + Number(item.volume), 0).toFixed(stepDecimals(step)));
  const rideVolume = Number((lots - closedLots).toFixed(stepDecimals(step)));
  return {
    eligible: true,
    side,
    takeProfit: ride.price,
    rideLevel: ride.level,
    rideVolume,
    // Percent of the *position*, not of the budget: a level the broker's minimum lot ruled out returns
    // its share to the ride, and a plan that still claimed 20% would be describing lots nobody holds.
    ridePercent: Number(((rideVolume / lots) * 100).toFixed(2)),
    levels: planned,
    dropped,
  };
}

/**
 * How much of the position may be closed right now. The live volume is read from the terminal rather
 * than from the plan, because a user may have trimmed the trade by hand, and a plan that ignores that
 * would close volume that is no longer there.
 */
export function resolveCloseVolume({ plannedVolume, liveVolume, minVolume, volumeStep } = {}) {
  const planned = number(plannedVolume);
  const live = number(liveVolume);
  const min = number(minVolume);
  const step = number(volumeStep) || 0.01;
  if (![planned, live, min].every((value) => value !== null && value >= 0)) return { error: 'The broker did not provide a position size to close from.' };
  if (live <= 0) return { error: null, closeAll: false, volume: 0, reason: 'position-gone' };
  if (planned <= 0) return { error: 'This level has no volume to close.' };
  // The plan asks for everything that is left: closing it is the level, not an extra decision.
  if (planned >= live - step / 2) return { error: null, closeAll: true, volume: Number(live.toFixed(stepDecimals(step))) };
  if (planned < min) return { error: `Closing ${planned} lots is below this symbol's ${min} lot minimum, so this level was left open.` };
  const remainder = Number((live - planned).toFixed(stepDecimals(step)));
  if (remainder < min) {
    const shrunk = alignDown(live - min, step);
    if (shrunk < min) return { error: `Closing ${planned} lots would leave ${remainder} lots, below this symbol's ${min} lot minimum, so this level was left open.` };
    return { error: null, closeAll: false, volume: shrunk, note: `the position had shrunk, so ${shrunk} lots was less than the plan asked for and still left a legal remainder` };
  }
  return { error: null, closeAll: false, volume: planned };
}
