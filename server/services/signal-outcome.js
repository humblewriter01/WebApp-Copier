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

/*
 * The four sentences the brief asks for, in the order they are checked. What matters here is not the wording but
 * which condition is allowed to speak: an unexecuted row used to be able to say "Auto-Trading is off" when the
 * switch was on and the real reason was that no trading account existed - because the switch was tested first
 * and its own sentence was the one written for a workspace whose settings row had not been saved yet, or whose
 * state had changed since the capture. Each sentence now names the condition that actually stops the order, and
 * the switch sentence is only used when the switch is what is off.
 */
export const AUTO_TRADING_OFF_NOTE = 'Auto-Trading is off, so this signal was saved for review only.';
export const PLAN_NO_EXECUTION_NOTE = 'Auto-Trading is on, but your plan does not include automatic execution. Upgrade to execute signals.';
export const NO_ACCOUNT_NOTE = 'Auto-Trading is on, but no trading account is connected. Connect one to execute signals.';
export const ACCOUNT_NOT_READY_NOTE = 'Auto-Trading is on, but your trading account is not connected yet. Deploy it to execute signals.';
/** Instance-wide conditions: true of every workspace, and nothing the reader can act on. */
export const RUNTIME_OFF_NOTE = 'Automatic execution is unavailable on this service right now, so nothing was sent to your broker.';
export const PAUSED_NOTE = 'Automatic execution is paused by Signal Desk for every workspace. This signal was saved and was not sent to your broker.';

/** Kept as a name because the client and the tests read the same sentence from the plan, not from a signal. */
export const UPGRADE_REQUIRED_NOTE = PLAN_NO_EXECUTION_NOTE;

/**
 * The sentences this module writes onto a blocked row, and nothing else may claim.
 *
 * It is a registry rather than a set of strings because two things depend on it: the read path below only ever
 * re-decides a row whose note it recognises as one of these, so a note written by the engine about a broker, or
 * by a person, is never overwritten; and the client's banner lists the same states, so a new sentence added here
 * without being added there shows up as a failing test instead of a contradiction on a screen.
 */
export const EXECUTION_BLOCKER_NOTES = Object.freeze([
  AUTO_TRADING_OFF_NOTE,
  PLAN_NO_EXECUTION_NOTE,
  NO_ACCOUNT_NOTE,
  ACCOUNT_NOT_READY_NOTE,
  RUNTIME_OFF_NOTE,
  PAUSED_NOTE,
]);

const BLOCKER_SET = new Set(EXECUTION_BLOCKER_NOTES);

/** Whether a row's note is one this module owns, and may therefore re-derive. */
export function isExecutionBlockerNote(note) {
  return typeof note === 'string' && BLOCKER_SET.has(note.trim());
}

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
    return { status: SIGNAL_STATUSES.received, note: AUTO_TRADING_OFF_NOTE, queue: false };
  }
  /* Ordered by who can do something about it: the plan, then the account, then the conditions that are true of
     the whole service. A workspace with no account and no paid plan is told to upgrade first, because paying
     for a plan is the step that makes a trading account possible at all. */
  if (!paid(input.subscriptionStatus)) {
    return { status: SIGNAL_STATUSES.unexecuted, note: PLAN_NO_EXECUTION_NOTE, queue: false, upgradeRequired: true };
  }
  if (!input.accountSelected) {
    return { status: SIGNAL_STATUSES.unexecuted, note: NO_ACCOUNT_NOTE, queue: false };
  }
  if (String(input.accountState || '').toUpperCase() !== 'DEPLOYED') {
    return { status: SIGNAL_STATUSES.unexecuted, note: ACCOUNT_NOT_READY_NOTE, queue: false };
  }
  if (input.runtimeEnabled !== true) {
    return { status: SIGNAL_STATUSES.unexecuted, note: RUNTIME_OFF_NOTE, queue: false };
  }
  if (input.paused === true) {
    return { status: SIGNAL_STATUSES.unexecuted, note: PAUSED_NOTE, queue: false };
  }
  return { status: SIGNAL_STATUSES.queued, note: null, queue: true };
}

/**
 * The one read that answers "could this workspace trade right now?", shared by capture and by the reads that
 * display a row, so a signal list and the decision beside it can never be built from two different pictures.
 */
export const SIGNAL_OUTCOME_CONTEXT_SQL = `SELECT s.auto_trading_enabled AS autoTrading,s.execution_account_id AS executionAccountId,
       ma.state AS accountState,u.subscription_status AS subscriptionStatus,u.id AS userId
  FROM users u
  LEFT JOIN settings s ON s.user_id=u.id
  LEFT JOIN metaapi_accounts ma ON ma.user_id=u.id AND ma.metaapi_account_id=s.execution_account_id
  WHERE u.id=$1 LIMIT 1`;

/**
 * What a blocked row should say *now*, for a row that is being shown to somebody.
 *
 * A note is written when a signal arrives, and the conditions behind it are settings - which means a workspace
 * that turns Auto-Trading on, connects an account or upgrades its plan is left looking at a list of rows
 * explaining a state of the account that no longer exists. That is not history being kept honest, it is a
 * contradiction with the banner three lines above it, and on a trading screen the two have to agree. So the read
 * path re-decides a row whose note is one of this module's blocker sentences and shows the current one instead:
 * the status is untouched, because whether an order was placed is a fact about the past, and the sentence about
 * why is a fact about now.
 *
 * A note this module did not write - a broker's answer mirrored from a job, a parser's reason, a sentence from
 * an older release that is no longer in the registry - is left exactly as it is. Nothing here invents a reason
 * for a row that was never blocked by these conditions.
 */
export function overlayLiveBlocker(signal, context = {}) {
  if (!signal || typeof signal !== 'object' || signal.executionReady !== true) return signal;
  if (String(signal.source || '') !== 'telegram' || signal.telegramMessageId == null) return signal;
  const stored = typeof signal.executionNote === 'string' ? signal.executionNote.trim() : '';
  // Only a row that already carries one of these sentences is re-decided. A row with no sentence had nothing to
  // report about its execution - a hand-written note, or a signal that went straight to the queue - and the
  // reader is not owed a blocker that never applied to it.
  if (stored === '' || !isExecutionBlockerNote(stored)) return signal;
  const decision = decideSignalOutcome({
    executionReady: true,
    manual: false,
    autoTradingEnabled: context.autoTradingEnabled === true,
    runtimeEnabled: context.runtimeEnabled === true,
    paused: context.paused === true,
    subscriptionStatus: context.subscriptionStatus,
    accountSelected: context.accountSelected === true,
    accountState: context.accountState,
  });
  if ((decision.note || '') === stored) return signal;
  return { ...signal, executionNote: decision.note || null };
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
