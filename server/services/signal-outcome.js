/**
 * What happens to a signal the moment it is captured, and what the workspace is told about it.
 *
 * Signal capture is deliberately not part of this decision. A message that a user asked to
 * monitor is always saved - plan, trading accounts, the execution runtime and the platform
 * switch decide only whether the signal is *queued*, never whether it is stored. This module is
 * the single place that turns those conditions into an outcome label and one honest sentence, so
 * the row the user reads and the job the worker runs can never disagree about why nothing traded.
 */
export const SIGNAL_STATUSES = Object.freeze({
  received: 'received',
  unparsed: 'unparsed',
  queued: 'queued',
  unexecuted: 'unexecuted',
  expired: 'expired',
  unknown: 'unknown',
  /* A signal whose order is on the broker's book, unfilled, is neither executed nor unexecuted: it is the
   * one state where the app has spent nothing and can still spend something. It gets a status of its own
   * because "nothing happened yet" and "nothing will happen" must never read the same on a trading screen.
   * `cancelled` is its pair: the order left the book without becoming a position. */
  pending: 'pending',
  cancelled: 'cancelled',
});

/** Outcomes that mean "a job is on its way", so nothing else may also start one. */
export const QUEUED_STATUSES = Object.freeze([SIGNAL_STATUSES.queued]);

export const UPGRADE_REQUIRED_NOTE = 'Upgrade to Starter or higher to execute signals automatically. This signal is saved for review.';

function paid(status) {
  return ['active', 'non_renewing'].includes(String(status || '').toLowerCase());
}

/**
 * @param input.executionReady   the parser found a symbol, side and prices
 * @param input.autoTradingEnabled the workspace's own switch
 * @param input.runtimeEnabled   the service is allowed to reach the broker at all
 * @param input.paused           the platform kill switch (an unreadable switch counts as paused)
 * @param input.subscriptionStatus  the workspace plan status
 * @param input.accountState     state of the account selected for execution, if any
 * @param input.accountSelected  whether an execution account is selected
 */
export function decideSignalOutcome(input = {}) {
  if (input.executionReady !== true) {
    return { status: SIGNAL_STATUSES.unparsed, note: null, queue: false };
  }
  // A hand-written signal note is a record the user keeps for themselves. It is never executed, so
  // it is not "unexecuted for a reason" and no warning belongs on it.
  if (input.manual === true) {
    return { status: SIGNAL_STATUSES.received, note: null, queue: false };
  }
  if (input.autoTradingEnabled !== true) {
    return { status: SIGNAL_STATUSES.received, note: 'Auto-Trading is off, so this signal was saved for review only.', queue: false };
  }
  // Reasons are ordered from the ones the user can act on to the ones nobody can: an unpaid
  // workspace is told to upgrade, an unselected account is told to select one, and a platform
  // pause says so without blaming the workspace.
  if (!paid(input.subscriptionStatus)) {
    return { status: SIGNAL_STATUSES.unexecuted, note: UPGRADE_REQUIRED_NOTE, queue: false, upgradeRequired: true };
  }
  if (input.runtimeEnabled !== true) {
    return { status: SIGNAL_STATUSES.unexecuted, note: 'Automatic execution is unavailable on this service right now, so nothing was sent to your broker.', queue: false };
  }
  if (input.paused === true) {
    return { status: SIGNAL_STATUSES.unexecuted, note: 'Automatic execution is paused by Signal Desk for every workspace. This signal was saved and was not sent to your broker.', queue: false };
  }
  if (!input.accountSelected) {
    return { status: SIGNAL_STATUSES.unexecuted, note: 'No trading account is selected for execution, so this signal was saved for review only.', queue: false };
  }
  if (String(input.accountState || '').toUpperCase() !== 'DEPLOYED') {
    return { status: SIGNAL_STATUSES.unexecuted, note: 'The selected trading account is not deployed, so this signal was saved for review only.', queue: false };
  }
  return { status: SIGNAL_STATUSES.queued, note: null, queue: true };
}

/**
 * The job table and the signal table describe the same event with different words: a job that was
 * `skipped` is a signal the user sees as `unexecuted`. Keeping the mapping here stops the two from
 * drifting, which is how a skipped signal would end up looking like a successful one.
 */
export function signalStatusForJobStatus(jobStatus) {
  if (jobStatus === 'skipped') return SIGNAL_STATUSES.unexecuted;
  // A job that ends with an order on the book is not a job that ended: `pending` travels to the signal row
  // unchanged, which is what lets the expiry sweep own that row's next transition.
  if (jobStatus === SIGNAL_STATUSES.pending) return SIGNAL_STATUSES.pending;
  if (jobStatus === 'expired') return SIGNAL_STATUSES.expired;
  if (jobStatus === 'unknown') return SIGNAL_STATUSES.unknown;
  if (jobStatus === 'executed' || jobStatus === 'filled') return jobStatus;
  return jobStatus || SIGNAL_STATUSES.received;
}
