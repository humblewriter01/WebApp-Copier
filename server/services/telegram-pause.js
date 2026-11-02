/**
 * Pausing one workspace's Telegram session, and the two sweeps that decide it.
 *
 * A pause is not a sign-out. It is this process letting go of a socket it is holding for a session nobody is using,
 * while the session itself stays exactly where it was: the stored `StringSession` keeps its bytes, `telegram_connected`
 * keeps its TRUE, the user is never sent to the login flow, and an administrator can put the socket back with one
 * call. The distinction is the whole design, because the two flags answer different questions - `telegram_connected`
 * means "this account has a session worth resuming", `telegram_paused` means "no process should be holding a client
 * for it right now" - and collapsing them is how a resource-saving feature ends up deleting someone's login.
 *
 * Four things have to be true at the end of a pause, and every one of them is a call this file makes rather than
 * describes: the client is ended (not merely disconnected, so its `while (!client._destroyed)` update loop stops),
 * its keep-alive record is released, the workspace's entry leaves `telegramClients` through the same
 * identity-guarded `forget` the reconnect path uses, and the database says paused. The first three without the
 * fourth is a workspace that reappears on the next sweep; the fourth without the third is a live socket the panel
 * reports as paused while it carries on capturing.
 *
 * The exclusion the safety of this feature rests on is in `selectCaptureCandidates`: the resume sweep is the one
 * loop that reaches for a session from the database rather than from memory, so a paused workspace has to be
 * dropped from its row list - not merely skipped later, because "later" is after a rebuild has already been started.
 * The `isPaused` check is the part that survives a stale read: the sweep's rows are a snapshot taken before its
 * first rebuild finished, and a pause that lands mid-pass must still stop the remaining rows.
 */
import { isPaidSubscriber } from './plan-limits.js';
import { isAdmin } from './inactivity.js';

/** Why a session is paused, in one word, because the sentence the user is shown differs by cause. */
export const PAUSE_REASON_ADMIN = 'admin-manual';
export const PAUSE_REASON_IDLE = 'idle-free-plan';
export const PAUSE_REASONS = Object.freeze([PAUSE_REASON_ADMIN, PAUSE_REASON_IDLE]);

/**
 * Thirty days, because that is the number the inactivity policy already uses for the accounts that cost real money
 * (`inactivity.js:21`), and a Telegram socket costs memory rather than a provider invoice. Kept next to that file's
 * constant rather than imported from it: the two policies are allowed to disagree, and a shared number would
 * quietly link them.
 */
export const TELEGRAM_IDLE_PAUSE_DAYS = 30;
/** Per pass, so a fleet-wide change cannot open a queue of rebuilds; the next pass takes the rest. */
export const TELEGRAM_PAUSE_SWEEP_LIMIT = 25;
/** How many paused ids the in-memory gate reads at once. Beyond it a pause still holds; only the sweep is late. */
export const TELEGRAM_GATE_SYNC_LIMIT = 500;

/**
 * The candidates for an inactivity pause, as one statement.
 *
 * Every term is load-bearing. `role<>'admin'` and `is_suspended=FALSE` are the exemptions `inactivity.js` uses for
 * the same reason (an operator's own test account, and an account that has already lost access). The plan test is
 * `subscription_status NOT IN ('active','non_renewing')` rather than `subscription_plan='free'`, because an expired
 * Pro subscriber keeps the plan name and must still be pausable - which is the same rule `plan-limits.js` applies
 * when it decides a workspace no longer gets paid limits. The clock is the `COALESCE` the inactivity policy uses,
 * so an account that predates `last_active_at` is measured on its last sign-in rather than never.
 */
export const TELEGRAM_PAUSE_CANDIDATES_SQL = `
  SELECT u.id,u.role,u.is_suspended AS "isSuspended",u.subscription_status,u.telegram_paused,u.telegram_connected,
    (u.telegram_session IS NOT NULL) AS has_session,
    EXTRACT(EPOCH FROM (NOW() - COALESCE(u.last_active_at,u.last_login,u.created_at))) / 86400 AS days_inactive
    FROM users u
   WHERE u.telegram_paused=FALSE
     AND u.telegram_connected=TRUE
     AND u.telegram_session IS NOT NULL
     AND u.role<>'admin'
     AND u.is_suspended=FALSE
     AND u.subscription_status NOT IN ('active','non_renewing')
     AND COALESCE(u.last_active_at,u.last_login,u.created_at) < NOW() - ($1::text || ' days')::interval
   ORDER BY COALESCE(u.last_active_at,u.last_login,u.created_at) ASC
   LIMIT $2`;

/**
 * The other direction, which is what makes the policy a pause rather than a punishment: a workspace that was paused
 * for idling on the free plan and has now paid is put back on the next pass, without an administrator noticing.
 * `telegram_pause_reason=$2` is the term that keeps an administrator's manual pause out of this - paying does not
 * undo a decision made about a specific account, and the two causes would otherwise be indistinguishable.
 */
export const TELEGRAM_RESUME_PAID_SQL = `
  SELECT u.id,u.subscription_status,u.telegram_paused,u.telegram_pause_reason
    FROM users u
   WHERE u.telegram_paused=TRUE
     AND u.telegram_connected=TRUE
     AND u.telegram_session IS NOT NULL
     AND u.telegram_pause_reason=$2
     AND u.subscription_status IN ('active','non_renewing')
   ORDER BY u.telegram_paused_at ASC NULLS LAST
   LIMIT $1`;

/** The gate's own read: which workspaces this process must not be holding clients for. */
export const TELEGRAM_PAUSED_IDS_SQL = `
  SELECT id FROM users WHERE telegram_paused=TRUE ORDER BY telegram_paused_at ASC NULLS LAST LIMIT $1`;

/** @param {any} reason @returns {boolean} */
export function isValidPauseReason(reason) {
  return PAUSE_REASONS.includes(String(reason || ''));
}

/**
 * Which of the sweep's candidate rows may be rebuilt, in order, with the reason for every rejection.
 *
 * `rows` is the sweep's own snapshot; `isPaused` is the live gate. A row that says it is not paused *and* the gate
 * that was updated a second later both have to be consulted, in that order, because the disagreement is the normal
 * case: pausing writes the flag first and the memory second, precisely so that nothing in between can pick the
 * workspace up and hand it a new socket.
 */
/**
 * @param {any[]} [rows] - the sweep's snapshot
 * @param {{ isPaused?: (userId: string) => boolean }} [options] - the live gate, as a question rather than a copy
 * @returns {Array<any>} the rows this pass may rebuild, each with `userId` set to the string form of its id
 */
export function selectCaptureCandidates(rows, { isPaused = () => false } = {}) {
  const candidates = [];
  const seen = new Set();
  for (const row of rows || []) {
    const userId = row?.id ?? row?.userId ?? null;
    if (userId === null || userId === undefined || userId === '') continue;
    const key = String(userId);
    // The query already orders and limits, but a duplicated id in a row list would mean two rebuilds for one
    // workspace, and the latch would refuse the second one and report it as "already running". Drop it here.
    if (seen.has(key)) continue;
    seen.add(key);
    if (row.telegram_paused === true || row.telegramPaused === true) continue;
    if (isPaused(key)) continue;
    candidates.push({ ...row, userId: key });
  }
  return candidates;
}

/**
 * The inactivity policy as a pure decision, so it can be argued with without a database.
 *
 * The SQL above is the filter; this is the *enforcement*. That overlap is deliberate: a row that arrives here from
 * a replica, a cache, or a future edit to the query must not be able to pause a paying subscriber on its own, so
 * every exemption is checked twice - once by whoever wrote the query and once by the code that acts on it.
 */
/**
 * @param {any} [row]
 * @param {{ idleDays?: number, now?: () => number }} [options]
 * @returns {{ action: string, reason: string, daysInactive?: number }} - `pause` or `skip`, and the exemption name
   so a log line can say which of the six reasons it was
 */
export function decideIdlePause(row = {}, { idleDays = TELEGRAM_IDLE_PAUSE_DAYS, now = () => Date.now() } = {}) {
  const skip = (reason) => ({ action: 'skip', reason });
  if (row.telegram_paused === true || row.telegramPaused === true) return skip('already-paused');
  if (isAdmin(row)) return skip('admin');
  if (row.is_suspended === true || row.isSuspended === true) return skip('suspended');
  if (isPaidSubscriber(row)) return skip('paid');
  if (row.telegram_connected !== true && row.telegramConnected !== true) return skip('not-linked');
  if (row.has_session === false || row.hasSession === false) return skip('no-session');
  const days = Number(row.days_inactive ?? row.daysInactive);
  if (!Number.isFinite(days) || days < idleDays) return skip('under-threshold');
  return { action: 'pause', reason: PAUSE_REASON_IDLE, daysInactive: Math.floor(days) };
}

/** The reverse decision, and it is narrower on purpose: only an idle pause is ever undone by a plan change. */
/**
 * @param {any} [row]
 * @returns {{ action: string, reason: string }}
 */
export function decideIdleResume(row = {}) {
  const skip = (reason) => ({ action: 'skip', reason });
  if (row.telegram_paused !== true) return skip('not-paused');
  if (String(row.telegram_pause_reason || '') !== PAUSE_REASON_IDLE) return skip('not-an-idle-pause');
  if (!isPaidSubscriber(row)) return skip('not-paid');
  return { action: 'resume', reason: 'plan-upgrade' };
}

/**
 * Everything the pause control needs from the server, and none of it is a copy of a decision: the client map is the
 * same Map the sweep walks, `forget` is the reconnect policy's own identity-guarded removal, `isLive` is the
 * adapter's strict predicate, `restoreClient` is the one function every reviver in the app already goes through.
 * A pause that maintained its own versions of those would be a second implementation of "holding a Telegram
 * session", and the whole point of this file is that there is only ever one.
 *
 * @typedef {Object} TelegramPauseDeps
 * @property {Map<any, any>} clients - the live client map, keyed exactly as `index.js` keys it
 * @property {PoolLike} pool - the pool, used for the flag writes and the two candidate reads
 * @property {ServiceLogger} [log] - `log(level, sentence, facts)`; absent means silent, not `console`
 * @property {(client: any) => any} endClient - the adapter's `destroyClient`, the only teardown that stops the
 *   update loop rather than merely closing the socket
 * @property {(client: any) => any} releaseClient - `telegramKeepAlive.release`, so the keep-alive guard stops
 *   pinging a client nobody owns any more
 * @property {(userId: any, entry: any) => boolean} forget - `telegramReconnect.forget`, whose identity check is
 *   what makes removing an entry safe while a rebuild holds it
 * @property {(client: any) => boolean} [isLive] - whether this client was actually connected, recorded so the
 *   audit row can say whether a socket really was cut
 * @property {(userId: any) => any} [resetBaseline] - the listener's per-workspace stream memory: the `pts`
 *   baseline, the strike counters, the reconnect cooldown, so a resume starts from "we have never seen this
 *   session" instead of from whatever a stale record claimed
 * @property {(userId: any, options?: { reason?: string, force?: boolean, strict?: boolean }) => any} [restoreClient] -
 *   `restoreTelegramClient`, called only on a resume, and only after the flag has been cleared
 * @property {{ record: (entry: any) => Promise<any> }} [audit] - the audit logger, so an automatic pause leaves a
 *   trace and is never mistaken for a person having pressed a button
 * @property {number} [idleDays] - the threshold, for the tests and for a future operator who wants it configurable
 * @property {number} [sweepLimit] - the per-pass cap, so a first sweep cannot start hundreds of reconnects
 * @property {number} [gateSyncLimit] - how many paused ids one gate refresh reads
 * @property {() => number} [now] - milliseconds, injected so a test can move the clock instead of waiting on it
 *
 * @param {Partial<TelegramPauseDeps>} deps
 */
export function createTelegramPauseControl({
  clients,
  pool,
  log = () => {},
  endClient,
  releaseClient,
  forget,
  isLive = () => true,
  resetBaseline = () => {},
  restoreClient = async () => null,
  audit = null,
  idleDays = TELEGRAM_IDLE_PAUSE_DAYS,
  sweepLimit = TELEGRAM_PAUSE_SWEEP_LIMIT,
  gateSyncLimit = TELEGRAM_GATE_SYNC_LIMIT,
  now = () => Date.now(),
} = {}) {
  if (!clients || typeof clients.get !== 'function' || typeof clients.delete !== 'function') {
    throw new TypeError('createTelegramPauseControl requires the live client map, so a pause ends the real entry');
  }
  if (typeof pool?.query !== 'function') throw new TypeError('createTelegramPauseControl requires a pool');
  for (const [name, fn] of [['endClient', endClient], ['releaseClient', releaseClient], ['forget', forget]]) {
    if (typeof fn !== 'function') throw new TypeError(`createTelegramPauseControl requires \`${name}\`, so pausing reuses the reconnect path's own teardown`);
  }

  /**
   * The gate. A Set of ids, not a cache of user objects: the only question asked of it is "may this workspace be
   * held open", it is answered on the hot paths (the sweep's loop, the status route, a watchdog that found a dead
   * stream), and a synchronously-correct answer is worth more here than a fresh one - which is why the database
   * read at the point of a rebuild stays the authority and this only ever *refuses*, never revives.
   */
  const paused = new Set();
  const counters = { pauses: 0, resumes: 0, autoPaused: 0, autoResumed: 0, refusedRevives: 0, enforced: 0, lastSweepAt: null };

  const isPaused = (userId) => paused.has(String(userId));
  const markPaused = (userId) => { paused.add(String(userId)); };
  const markResumed = (userId) => { paused.delete(String(userId)); };

  function pausedError() {
    const error = new Error('This workspace\'s Telegram session is paused.');
    /* Spelled out rather than built from a constant, like every other flag this app puts on a thrown thing:
       `types/app.d.ts` declares `telegramSessionPaused` by name, and `test/typescript-enforcement.test.js` fails a
       declaration no code writes. The name is the route's whole answer - it is how a 409 that says "resume it first"
       is told apart from a 502 that says "Telegram refused" - so it is the sort of thing a computed key has no
       business hiding. */
    error.telegramSessionPaused = true;
    return error;
  }

  function noSessionError() {
    const error = new Error('This workspace has no linked Telegram session to pause.');
    error.telegramPauseNoSession = true;
    return error;
  }

  /**
   * Read the flag, rebuild the gate, and let go of anything this process is still holding that the flag says is
   * paused.
   *
   * The third half is the one that is easy to leave out. A pause performed here ends its own socket, but a pause
   * that arrives any other way - a second instance, an operator's `UPDATE`, a restore of a snapshot - would
   * otherwise be enforced only in the sense that the *next* rebuild is refused, while the client already in the
   * map carries on capturing for as long as its socket stays up. Refreshing a Set is not stopping a session, so
   * the refresh looks for the gap and closes it. The order is the point: `paused` is updated first, because a
   * teardown that lets a reviver in on the way out would put the socket straight back.
   */
  async function syncGate({ reason = 'sweep' } = {}) {
    const { rows } = await pool.query(TELEGRAM_PAUSED_IDS_SQL, [gateSyncLimit]);
    const next = new Set((rows || []).map((row) => String(row.id)));
    // A gate that grew without the database agreeing is a refusal nobody asked for; one that shrank is a revive
    // nobody authorised. Rebuilding it whole is the only order that cannot leak either, so `reason` is logged with
    // the size for whoever is comparing a pause to a workspace that stopped being listening.
    const fresh = [...next].filter((id) => !paused.has(id));
    paused.clear();
    for (const id of next) paused.add(id);
    let enforced = 0;
    for (const id of fresh) {
      if (!clients.has(id) && !clients.has(String(id))) continue;
      await endWorkspace(id, { reason: `${reason}-gate` });
      enforced += 1;
    }
    counters.lastSweepAt = new Date(now()).toISOString();
    if (enforced) counters.enforced += 1;
    log('debug', 'Telegram pause gate refreshed', { reason, paused: paused.size, enforced });
    return { paused: paused.size, enforced };
  }

  /**
   * Let go of whatever this process is holding for one workspace, in the order the reconnect path established.
   *
   * Ends the client rather than disconnecting it (a merely disconnected GramJS client keeps its update loop
   * spinning against a closed sender, which is the 39-second ping timeout this app already counts); releases the
   * keep-alive record so the guard is not left holding a client nobody owns; then drops the map entry through
   * `forget`, whose identity check is what makes this safe to call while a rebuild is in flight.
   */
  async function endWorkspace(userId, { reason = 'pause' } = {}) {
    const key = String(userId);
    const entry = clients.get(key) || clients.get(userId);
    if (!entry) return { ended: false, wasLive: false, reason: 'no-entry' };
    const wasLive = Boolean(entry.client) && isLive(entry.client);
    if (entry.client) {
      try { await endClient(entry.client); } catch (error) {
        // Every one of these is a cleanup step that has already decided a failure is not worth an exception: the
        // pause is a fact about the database and the map, and a socket that refuses to die is reported, not fatal.
        log('warn', 'Telegram pause could not end the client cleanly', { userId: key, reason, error: `${error?.message || error}`.slice(0, 160) });
      }
      try { releaseClient(entry.client); } catch (error) {
        log('warn', 'Telegram pause could not release the keep-alive record', { userId: key, reason, error: `${error?.message || error}`.slice(0, 160) });
      }
    }
    const forgotten = forget(userId, entry) === true || forget(key, entry) === true;
    // `resetStreamBaseline` is the beat's own memory: `pts` deltas, strike counters, a rebuild cooldown, and the
    // `reauthRequired` flag. A paused workspace that keeps a stale record comes back already accused of whatever
    // it looked like when it went away, so the slate is wiped at the moment of the pause, not at the resume.
    try { resetBaseline(userId); } catch { /* a diagnostic reset is not allowed to fail a pause */ }
    log('info', 'Telegram session ended for pause', { userId: key, reason, wasLive, forgotten });
    return { ended: true, wasLive, forgotten };
  }

  async function recordAudit(entry) {
    if (!audit || typeof audit.record !== 'function') return null;
    try { return await audit.record(entry); } catch (error) {
      // As everywhere else in this app: an audit row that cannot be written is a warning, never a failed action.
      log('warn', 'Telegram pause could not be audited', { action: entry?.action, error: error.message });
      return null;
    }
  }

  /**
   * Pause one workspace.
   *
   * The order is the guarantee: flag first (so any pass that starts from now on refuses it), then memory. The flag
   * is written with `COALESCE`, which is what makes pausing an already-paused session idempotent in the way an
   * operator needs - the row keeps saying *when* the pause began and *who asked for it*, instead of the clock
   * resetting under a second click.
   */
  async function pauseTelegramSession(userId, { reason = PAUSE_REASON_ADMIN, actorId = null, actorEmail = null } = {}) {
    const key = String(userId);
    const why = isValidPauseReason(reason) ? reason : PAUSE_REASON_ADMIN;
    const alreadyGated = paused.has(key);
    markPaused(key);
    let rowCount = 0;
    try {
      const result = await pool.query(`
        UPDATE users
           SET telegram_paused=TRUE,
               telegram_paused_at=COALESCE(telegram_paused_at, NOW()),
               telegram_pause_reason=CASE WHEN telegram_paused=TRUE THEN telegram_pause_reason ELSE $2 END
         WHERE id=$1 AND telegram_connected=TRUE`, [key, why]);
      rowCount = Number(result?.rowCount) || 0;
    } catch (error) {
      if (!alreadyGated) markResumed(key);
      log('warn', 'Telegram pause could not be saved', { userId: key, reason: why, error: `${error?.message || error}`.slice(0, 160) });
      throw error;
    }
    if (rowCount === 0) {
      if (!alreadyGated) markResumed(key);
      throw noSessionError();
    }
    const { ended, wasLive } = await endWorkspace(key, { reason: why });
    counters.pauses += 1;
    if (why === PAUSE_REASON_IDLE) counters.autoPaused += 1;
    await recordAudit({
      actorId,
      actorEmail,
      action: 'telegram.sessionPaused',
      targetType: 'user',
      targetId: key,
      summary: `Paused a workspace's Telegram session (${why}); the live socket was ${wasLive ? 'open and is now ended' : 'already closed'}, and the stored session was left in place.`,
      metadata: { reason: why, clientEnded: ended, wasLive },
    });
    log('warn', 'Telegram session paused', { userId: key, reason: why, actorId, clientEnded: ended, wasLive });
    return { paused: true, reason: why, clientEnded: ended, wasLive, already: alreadyGated };
  }

  /**
   * Put one workspace back.
   *
   * Clearing the flag is the whole of this function: the *socket* is the reconnect flow's business, and it is
   * reached through `restoreClient` below so a resume cannot invent a second, weaker rebuild. `force: true` is why
   * a resume from a paused state actually reconnects rather than returning the connected-looking client the sweep
   * may have left behind, and the caller that is answering a human passes `strict` so it gets the refusal or the
   * dead socket reported instead of an `ok`.
   */
  async function resumeTelegramSession(userId, { reason = 'admin-resume', actorId = null, actorEmail = null, reconnect = true } = {}) {
    const key = String(userId);
    let cleared = 0;
    try {
      const result = await pool.query(
        'UPDATE users SET telegram_paused=FALSE,telegram_paused_at=NULL,telegram_pause_reason=NULL WHERE id=$1 AND telegram_paused=TRUE',
        [key],
      );
      cleared = Number(result?.rowCount) || 0;
    } catch (error) {
      // The flag is the truth, so a resume that did not land does not open the gate: a workspace the database
      // still says is paused has to stay refused here too, or the two answers disagree until the next sweep.
      log('warn', 'Telegram resume could not be saved', { userId: key, error: `${error?.message || error}`.slice(0, 160) });
      throw error;
    }
    markResumed(key);
    counters.resumes += 1;
    if (reason === 'plan-upgrade') counters.autoResumed += 1;
    let client = null;
    let reconnectError = null;
    if (reconnect) {
      try { client = await restoreClient(key, { reason, force: true }); } catch (error) {
        reconnectError = error;
        log('warn', 'Telegram session unpaused but could not be reconnected', { userId: key, reason, error: `${error?.message || error}`.slice(0, 160) });
      }
    }
    await recordAudit({
      actorId,
      actorEmail,
      action: 'telegram.sessionResumed',
      targetType: 'user',
      targetId: key,
      summary: `Resumed a workspace's Telegram session (${reason}); ${cleared ? 'the pause was lifted' : 'it was not paused'} and the session was ${client ? 'reconnected' : reconnectError ? 'not reconnected' : 'left for the sweep'}.`,
      metadata: { reason, cleared, reconnected: Boolean(client), wasAlreadyPaused: cleared > 0 },
    });
    log('info', 'Telegram session resumed', { userId: key, reason, actorId, cleared, reconnected: Boolean(client) });
    if (reconnectError) {
      reconnectError.telegramResumeReconnectFailed = true;
      throw reconnectError;
    }
    return { resumed: true, cleared, reason, reconnected: Boolean(client) };
  }

  /**
   * One pass of the inactivity policy.
   *
   * The row list is the query's answer and `decideIdlePause` is the code's own opinion about it; a row that the
   * decision declines to act on is logged rather than skipped in silence, because the only worse outcome than a
   * workspace that should have been paused and was not is nobody being able to say why.
   */
  async function sweepIdlePauses({ reason = 'sweep', limit = sweepLimit } = {}) {
    const summary = { reason, scanned: 0, paused: 0, skipped: 0, failed: 0 };
    let rows = [];
    try {
      ({ rows } = await pool.query(TELEGRAM_PAUSE_CANDIDATES_SQL, [String(idleDays), limit]));
    } catch (error) {
      log('warn', 'Telegram inactivity pause sweep could not run', { reason, error: `${error?.message || error}`.slice(0, 160) });
      return { ...summary, failed: 1, code: 'TELEGRAM_PAUSE_SWEEP_FAILED' };
    }
    summary.scanned = (rows || []).length;
    for (const row of rows || []) {
      const decision = decideIdlePause(row, { idleDays, now });
      if (decision.action !== 'pause') {
        summary.skipped += 1;
        log('debug', 'Telegram inactivity pause declined', { userId: String(row.id), reason: decision.reason, daysInactive: row.days_inactive });
        continue;
      }
      try {
        await pauseTelegramSession(row.id, { reason: PAUSE_REASON_IDLE });
        summary.paused += 1;
        log('warn', 'Telegram session paused for inactivity', { userId: String(row.id), daysInactive: decision.daysInactive, idleDays });
      } catch (error) {
        summary.failed += 1;
        log('warn', 'Telegram inactivity pause failed', { userId: String(row.id), error: `${error?.message || error}`.slice(0, 160) });
      }
    }
    return summary;
  }

  /** The same pass in reverse: a workspace that paid is taken out of the penalty box without an operator noticing. */
  async function resumePaidPauses({ reason = 'sweep', limit = sweepLimit } = {}) {
    const summary = { reason, scanned: 0, resumed: 0, skipped: 0, failed: 0 };
    let rows = [];
    try {
      ({ rows } = await pool.query(TELEGRAM_RESUME_PAID_SQL, [limit, PAUSE_REASON_IDLE]));
    } catch (error) {
      log('warn', 'Telegram pause reconciliation could not read paid workspaces', { reason, error: `${error?.message || error}`.slice(0, 160) });
      return { ...summary, failed: 1, code: 'TELEGRAM_RESUME_SWEEP_FAILED' };
    }
    summary.scanned = (rows || []).length;
    for (const row of rows || []) {
      const decision = decideIdleResume(row);
      if (decision.action !== 'resume') {
        summary.skipped += 1;
        log('debug', 'Telegram auto-resume declined', { userId: String(row.id), reason: decision.reason });
        continue;
      }
      try {
        await resumeTelegramSession(row.id, { reason: decision.reason });
        summary.resumed += 1;
        log('info', 'Telegram session resumed by a plan change', { userId: String(row.id), status: row.subscription_status });
      } catch (error) {
        summary.failed += 1;
        log('warn', 'Telegram auto-resume failed', { userId: String(row.id), error: `${error?.message || error}`.slice(0, 160) });
      }
    }
    return summary;
  }

  /**
   * The one call the timer makes: refresh the gate from the database, then reconcile both directions.
   *
   * Gate first, so a pause that landed in another process is refused here before this pass starts rebuilding
   * anything on the strength of a row list it read a moment earlier.
   */
  async function reconcile({ reason = 'sweep' } = {}) {
    const gate = await syncGate({ reason });
    // `gate` is the pair the log line and the panel both want: how many refusals the database asked for, and how
    // many of them this process had to enforce itself.
    const pausedNow = await sweepIdlePauses({ reason });
    const resumedNow = await resumePaidPauses({ reason });
    const summary = { reason, gate: gate.paused, gateEnforced: gate.enforced, paused: pausedNow.paused, resumed: resumedNow.resumed, skipped: pausedNow.skipped + resumedNow.skipped, failed: pausedNow.failed + resumedNow.failed };
    if (summary.paused || summary.resumed || summary.failed) log('info', 'Telegram pause sweep finished', summary);
    return summary;
  }

  return {
    isPaused,
    markPaused,
    markResumed,
    syncGate,
    endWorkspace,
    pauseTelegramSession,
    resumeTelegramSession,
    sweepIdlePauses,
    resumePaidPauses,
    reconcile,
    pausedError,
    noSessionError,
    isPausedError: (error) => error?.telegramSessionPaused === true,
    size: () => paused.size,
    stats: () => ({ paused: paused.size, ...counters }),
  };
}
