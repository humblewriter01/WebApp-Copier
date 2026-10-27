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

/**
 * The registry, keyed by a whitespace-normalised copy of itself.
 *
 * Matching is exact-after-normalising rather than fuzzy: the sentence has to *be* one of ours, because a note
 * this module did not write is not its to rewrite. But a stored value can differ from the constant by nothing a
 * reader would notice - a newline where a channel's text wrapped, a doubled space, a trailing one from a
 * console fix-up - and a `Set` of literals calls all three "not mine" and quietly leaves the contradiction on
 * the screen. Whitespace is normalised on both sides, so the comparison is about words.
 */
function normaliseBlockerNote(value) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

const BLOCKER_BY_TEXT = new Map(EXECUTION_BLOCKER_NOTES.map((note) => [normaliseBlockerNote(note), note]));

/** Which of this module's sentences a stored note is, or null when the note is not one of ours. */
export function matchExecutionBlockerNote(value) {
  const key = normaliseBlockerNote(value);
  return key === '' ? null : (BLOCKER_BY_TEXT.get(key) ?? null);
}

/** Whether a row's note is one this module owns, and may therefore re-derive. */
export function isExecutionBlockerNote(note) {
  return matchExecutionBlockerNote(note) !== null;
}

function paid(status) {
  return ['active', 'non_renewing'].includes(String(status || '').toLowerCase());
}

/**
 * @typedef {Object} SignalOutcomeInput
 * @property {boolean} [manual] - a hand-written note rather than a captured message: it is a record the user
 *   keeps, never a trade that was missed, so it is answered before any other question is asked. The prose above
 *   described that rule for as long as this function has had a doc block, and no type named the field until now
 * @property {boolean} [executionReady] - the parser found a symbol, side and prices
 * @property {boolean} [autoTradingEnabled] - the workspace's own switch
 * @property {boolean} [runtimeEnabled] - the service is allowed to reach the broker at all
 * @property {boolean} [paused] - the platform kill switch (an unreadable switch counts as paused)
 * @property {string|null} [subscriptionStatus] - the workspace plan status
 * @property {string|null} [accountState] - state of the account selected for execution, if any
 * @property {boolean} [accountSelected] - whether an execution account is selected
 */
export function decideSignalOutcome(/** @type {SignalOutcomeInput} */ input = {}) {
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
/* Every alias here is double-quoted, and that is not style: Postgres folds an unquoted identifier to lowercase,
   so `AS autoTrading` comes back as `autotrading`, `row.autoTrading` is `undefined`, `undefined === true` is
   false, and a workspace whose switch is ON is decided as though it were OFF - permanently, on every read and
   every write, with every unit test green because a fake pool hands back exactly the keys the code asked for.
   `test/sql-alias-shape.test.js` now refuses an unquoted camelCase alias anywhere in the server's SQL, and
   `test/signal-live-blocker-read.test.js` drives this statement through a pool that folds the way the real one
   does. */
export const SIGNAL_OUTCOME_CONTEXT_SQL = `SELECT s.auto_trading_enabled AS "autoTrading",s.execution_account_id AS "executionAccountId",
       ma.state AS "accountState",u.subscription_status AS "subscriptionStatus",u.id AS "userId"
  FROM users u
  LEFT JOIN settings s ON s.user_id=u.id
  LEFT JOIN metaapi_accounts ma ON ma.user_id=u.id AND ma.metaapi_account_id=s.execution_account_id
  WHERE u.id=$1 LIMIT 1`;

/**
 * --------------------------------------------------------------------------- *
 * Read-path tracing.
 *
 * A row that keeps a stale sentence is invisible from the outside: the card shows a sentence, the code says it
 * should have been replaced, and nothing between the two says which branch ran. Every decision this module makes
 * on a read therefore goes to stdout with its reason - once per row per decision, so a dashboard polling every
 * twenty seconds does not turn one question into a flood - and the running totals are readable by an operator
 * without a log search. `SIGNAL_OVERLAY_DEBUG=off` silences the lines, never the counters; an operator who can
 * only see `/health` still learns whether the path is being walked at all.
 * --------------------------------------------------------------------------- */
const OVERLAY_LOG_ROWS = 400;
const overlayTraceLines = new Set();
const overlayStats = {
  armedAt: new Date().toISOString(),
  registry: EXECUTION_BLOCKER_NOTES.length,
  reads: 0,
  rows: 0,
  eligible: 0,
  rewrites: 0,
  unchanged: 0,
  skips: 0,
  contextFailures: 0,
  lastReadAt: null,
  lastSkipReason: null,
  lastSkippedNote: null,
};

/**
 * One operator line, gated by `SIGNAL_OVERLAY_DEBUG`.
 *
 * `detail` is typed rather than defaulted to the empty string, because that default is the whole shape of the
 * argument and the checker reads a default as a type: every call site here passes an object of facts, and a
 * `detail = ''` said - wrongly - that a sentence belongs in that slot.
 *
 * @param {string} event
 * @param {string|null} [id]
 * @param {Record<string, any>|string|null} [detail]
 * @param {{ dedupe?: string|null }} [options]
 */
function overlayTrace(event, id = null, detail = '', { dedupe = null } = {}) {
  if (dedupe !== null) {
    if (overlayTraceLines.has(dedupe)) return;
    if (overlayTraceLines.size >= OVERLAY_LOG_ROWS) overlayTraceLines.clear();
    overlayTraceLines.add(dedupe);
  }
  if (String(process.env.SIGNAL_OVERLAY_DEBUG || '').toLowerCase() === 'off') return;
  if (id === null) console.log(`overlay: ${event}`, detail);
  else console.log(`overlay: ${event}`, id, detail);
}

const clipNote = (value) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, 90) : null);

/** What the read path has done so far - counts only, because `/health` is not authenticated. */
export function describeOverlayDiagnostics() {
  return {
    armedAt: overlayStats.armedAt,
    registry: overlayStats.registry,
    reads: overlayStats.reads,
    rows: overlayStats.rows,
    eligible: overlayStats.eligible,
    rewrites: overlayStats.rewrites,
    // The branch that a wrong decision hides behind: "the live state really does say this". Without it,
    // `rewrites: 0` is indistinguishable from "nothing was ever eligible".
    unchanged: overlayStats.unchanged,
    skips: overlayStats.skips,
    contextFailures: overlayStats.contextFailures,
    lastReadAt: overlayStats.lastReadAt,
    lastSkipReason: overlayStats.lastSkipReason,
    lastSkippedNote: overlayStats.lastSkippedNote,
  };
}

function overlaySkip(id, reason, note, parseError) {
  overlayStats.skips += 1;
  overlayStats.lastSkipReason = reason;
  overlayStats.lastSkippedNote = clipNote(note) || clipNote(parseError);
  overlayTrace('skipped', id ?? null, { reason, executionNote: clipNote(note), parseError: clipNote(parseError) },
    { dedupe: `skip:${id}:${reason}:${overlayStats.lastSkippedNote}` });
}

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
  if (!signal || typeof signal !== 'object') return signal;
  /* Two fields can carry the sentence: `execution_note` is where it belongs, and `parse_error` is where an
     older build left it, because that was the only text field the card read. A row is eligible on either. */
  const storedInNote = matchExecutionBlockerNote(signal.executionNote);
  const storedInParseError = matchExecutionBlockerNote(signal.parseError);
  if (!storedInNote && !storedInParseError) {
    // Rows with nothing of ours on them are the majority and are not worth a line each; a row that is showing a
    // sentence *is*, because that is the one somebody is reading and wondering about.
    if (clipNote(signal.executionNote) || clipNote(signal.parseError)) {
      overlaySkip(signal.id, 'note-not-in-registry', signal.executionNote, signal.parseError);
    }
    return signal;
  }
  /* A hand-written note belongs to the person who wrote it, whatever it says. Every other source this product
     has - a channel push, a catch-up replay, an older release's label for the same idea - is a row this module
     is entitled to re-describe, because the only way it reaches here is by already carrying one of our
     sentences. The gate used to be `source === 'telegram'`: a fact about how a row was born rather than about
     whether its sentence has gone stale, and it spared every row an older build filed under another label. */
  if (String(signal.source || '') === 'manual') {
    overlaySkip(signal.id, 'manual-source', signal.executionNote, signal.parseError);
    return signal;
  }
  /* One eligibility test, not three. `executionReady === true` was on this list on the reasoning that a row
     which never could not trade has no business being re-decided - and it silenced the whole function for
     exactly the rows this exists for, because that column is the parser's verdict on the *message*, and
     releases before it was a separate flag wrote false here for rows the workspace's own conditions had
     blocked. Carrying a sentence this module owns is the only evidence a re-decision needs. */
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
  /* The live sentence goes into `execution_note`, the field the card reads first, so it shadows whatever the
     legacy copy said; and a sentence of ours found in `parse_error` is dropped from the response, because that
     field is the fallback the card reaches for the moment the note is empty, and leaving it there would put the
     stale text back on the screen. Dropped from the response only - this function decorates a read, so the admin
     panel, the operator log and "Clear parsing errors" still see what was actually stored. */
  const shown = decision.note || null;
  // A row that already says the true thing is handed back as it came, so a list of them stays the same list of
  // objects and a client that compares rows sees no change where nothing changed.
  if (!storedInParseError && (typeof signal.executionNote === 'string' ? signal.executionNote : null) === shown) {
    // Already true, so nothing is rewritten - and this line is the answer to "the overlay ran and the card did
    // not change": it means the live settings really do still say this, and the sentence is not stale at all.
    overlayStats.unchanged += 1;
    overlayTrace('unchanged', signal.id, { note: clipNote(shown), context }, { dedupe: `same:${signal.id}:${shown}` });
    return signal;
  }
  overlayStats.rewrites += 1;
  overlayTrace('rewriting', signal.id, { from: clipNote(signal.executionNote) || clipNote(signal.parseError), to: clipNote(shown) });
  if (storedInParseError) return { ...signal, executionNote: shown, parseError: null };
  return { ...signal, executionNote: shown };
}

/**
 * The read behind that re-decision, as a factory, so the exact sequence a list route performs can be driven
 * from a test: which statements are issued, what happens when one of them fails, and which rows are left
 * exactly as stored because they never carried a blocker sentence.
 *
 * `runtimeEnabled` is a function rather than a value because the flag is turned over by an administrator while
 * this process is running: read once at start-up, every row in the product would keep the sentence the boot
 * environment deserved.
 *
 * @typedef {Object} SignalOutcomeReaderDeps
 * @property {PoolLike} [pool]
 * @property {any} [platformControls]
 * @property {Function} [runtimeEnabled]
 */
export function createSignalOutcomeReader(/** @type {SignalOutcomeReaderDeps} */ { pool, platformControls, runtimeEnabled = () => false } = {}) {
  if (!pool?.query) throw new TypeError('The outcome reader needs a pool to read from');

  // One line per process, and it is the line that answers "is the corrected code even running": a deployment
  // without it in its log is a deployment that did not build this.
  overlayTrace('reader armed', null, { registry: EXECUTION_BLOCKER_NOTES.length, runtimeEnabled: runtimeEnabled() === true });

  /** The live answer to "could this workspace trade right now", or null when it cannot be answered. */
  async function readOutcomeContext(userId) {
    const [context, pause] = await Promise.all([
      pool.query(SIGNAL_OUTCOME_CONTEXT_SQL, [userId]),
      Promise.resolve(platformControls?.read?.() ?? null).catch(() => null),
    ]);
    const row = context.rows[0];
    // An unreadable kill switch is not a reason to describe a workspace as paused, and an unreadable settings
    // row is not a reason to describe it as blocked by anything. No context, no re-decision.
    if (!row || !pause) return null;
    return {
      autoTradingEnabled: row.autoTrading === true,
      runtimeEnabled: runtimeEnabled() === true,
      paused: pause.state !== 'live',
      subscriptionStatus: row.subscriptionStatus,
      accountSelected: Boolean(row.executionAccountId),
      accountState: row.accountState,
    };
  }

  /** Re-derives the blocker sentence on the rows that carry one, for a route that is about to show them. */
  async function withLiveBlockers(userId, rows) {
    /* Asked against the registry rather than against "is there any note at all", because the two are the same
       question to this function - a note it does not own is a note it will not touch - and the answer decides
       whether a list read costs a database round trip. A workspace whose rows carry broker answers and personal
       notes, which is what a working one looks like, is served from the query it already ran. */
    const list = Array.isArray(rows) ? rows : [];
    const eligible = list.filter((row) => matchExecutionBlockerNote(row?.executionNote) || matchExecutionBlockerNote(row?.parseError)).length;
    overlayStats.reads += 1;
    overlayStats.rows += list.length;
    overlayStats.eligible += eligible;
    overlayStats.lastReadAt = new Date().toISOString();
    overlayTrace('read', null, { userId, rows: list.length, eligible });
    if (!eligible) return rows;
    const context = await readOutcomeContext(userId).catch((error) => {
      overlayTrace('context-failed', null, { userId, message: error?.message || String(error) });
      return null;
    });
    /* The one branch that leaves a stale sentence on the screen on purpose, so it is the loudest thing here:
       without a context there is nothing to re-decide against, and guessing a workspace's state to replace a
       stored one is worse than the stale text. If a trader ever reports a contradiction that this line does not
       explain, it is not this function. */
    if (!context) {
      overlayStats.contextFailures += 1;
      overlayStats.lastSkipReason = 'context-unreadable';
      // A code first and the sentence after it, because this is the line a log search turns on.
      overlayTrace('skipped-list', null, { userId, eligible, reason: 'context-unreadable', meaning: 'the workspace state could not be read, so the stored sentences stand' });
      return rows;
    }
    overlayTrace('context', null, { userId, ...context }, { dedupe: `context:${userId}:${JSON.stringify(context)}` });
    return rows.map((row) => overlayLiveBlocker(row, context));
  }

  return { readOutcomeContext, withLiveBlockers };
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
