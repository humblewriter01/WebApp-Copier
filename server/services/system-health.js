/**
 * System health for the admin panel.
 *
 * Everything here is read back out of the rows the platform already wrote, because those rows
 * are the truth an operator needs: a MetaAPI rejection is recorded on the trade, a Telegram
 * message the parser refused carries `signals.parse_error`, a stop that could not be moved is
 * recorded in `break_even_moves`, and a job that died is still on `execution_jobs`. Storing a
 * second copy of those failures in a new table would only create a way for the two to disagree,
 * so this reads them where they live - which also means the panel is useful for incidents that
 * happened before it existed.
 *
 * The console-only `log()` output stays out of it on purpose: a server log is not a queryable
 * error record and is rotated away.
 */

const DEFAULT_WINDOW_HOURS = 24;
const DEFAULT_LIMIT = 20;
const MAX_WINDOW_HOURS = 24 * 30;

function hoursValue(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Math.trunc(Number(value));
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > MAX_WINDOW_HOURS) return fallback;
  return parsed;
}

function clampCount(value, fallback, max) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Math.trunc(Number(value));
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, max);
}

export function normalizeHealthQuery(input = {}) {
  return {
    hours: hoursValue(input.hours ?? input.since, DEFAULT_WINDOW_HOURS),
    limit: clampCount(input.limit, DEFAULT_LIMIT, 200),
  };
}

/**
 * The single definition of "what went wrong recently". Each branch keeps the same column list so
 * the union type-checks, and every branch is bounded by the same window parameter so the list
 * and the per-kind counts can never disagree about the period they describe.
 */
export const RECENT_ERRORS_CTE = `recent AS (
  SELECT 'metaapi_execution' AS kind,t.created_at AS occurred_at,t.status,t.error_message AS message,
         t.symbol,t.side,t.metaapi_account_id AS account_id,t.user_id,u.email,u.name
  FROM trades t JOIN users u ON u.id=t.user_id
  WHERE t.status IN ('unknown','rejected') AND t.error_message IS NOT NULL AND t.error_message <> ''
    AND t.created_at >= NOW() - ($1::int * INTERVAL '1 hour')
  UNION ALL
  SELECT 'metaapi_execution',ej.created_at,ej.status,ej.error_message,s.symbol,s.side,NULL,ej.user_id,u.email,u.name
  FROM execution_jobs ej
  JOIN users u ON u.id=ej.user_id
  LEFT JOIN signals s ON s.id=ej.signal_id AND s.user_id=ej.user_id
  WHERE ej.status IN ('failed','unknown') AND ej.error_message IS NOT NULL AND ej.error_message <> ''
    AND ej.created_at >= NOW() - ($1::int * INTERVAL '1 hour')
    AND NOT EXISTS (SELECT 1 FROM trades te WHERE te.execution_job_id=ej.id AND te.error_message IS NOT NULL)
  UNION ALL
  SELECT 'metaapi_stop_move',m.created_at,m.status,m.error_message,m.symbol,m.side,m.metaapi_account_id,m.user_id,u.email,u.name
  FROM break_even_moves m JOIN users u ON u.id=m.user_id
  WHERE m.status IN ('failed','unknown') AND m.error_message IS NOT NULL AND m.error_message <> ''
    AND m.created_at >= NOW() - ($1::int * INTERVAL '1 hour')
  UNION ALL
  -- The list is the operator's, so it leads with what the row was actually told: technical_note holds the status
  -- code or provider sentence the card is not allowed to carry, and the friendly sentence is the fallback for a
  -- row with no technical half. The condition stays parse_error, which is what a row the parser filed means, and
  -- is also what "Clear parsing errors" clears.
  SELECT 'telegram_parse',s.created_at,s.status,COALESCE(NULLIF(s.technical_note,''),s.parse_error),s.symbol,s.side,NULL,s.user_id,u.email,u.name
  FROM signals s JOIN users u ON u.id=s.user_id
  WHERE s.parse_error IS NOT NULL AND s.parse_error <> ''
    AND s.created_at >= NOW() - ($1::int * INTERVAL '1 hour')
)`;

/* The `WITH` belongs to the queries that reach Postgres, not to the shared fragment: a statement
 * that begins with a bare `recent AS (` is a syntax error, and because each health section swallows
 * its own read failure, that error would have shown up as a permanently unreadable errors panel
 * rather than as a crash. Both forms were run against the live database to confirm the difference. */
export const RECENT_ERRORS_SELECT = `WITH ${RECENT_ERRORS_CTE}
SELECT kind,occurred_at AS "occurredAt",status,message,symbol,side,account_id AS "accountId",user_id AS "userId",email,name
FROM recent ORDER BY occurred_at DESC LIMIT $2`;

export const RECENT_ERROR_COUNTS_SELECT = `WITH ${RECENT_ERRORS_CTE}
SELECT kind,COUNT(*)::int AS count,COUNT(DISTINCT user_id)::int AS "affectedUsers",MAX(occurred_at) AS "lastSeen"
FROM recent GROUP BY kind`;

/**
 * The statement behind the panel's "Clear history" button on the errors list.
 *
 * The `telegram_parse` rows in `RECENT_ERRORS_CTE` are defined by one condition - a non-empty
 * `signals.parse_error` - so clearing exactly that condition is what empties that tab, and nothing
 * else. `execution_note` is deliberately untouched even though the list falls back to it for the
 * wording: it is written by the execution engine about a trade attempt, so erasing it would remove
 * a workspace's own record of what happened to their signal in order to tidy an admin screen. The
 * captured message itself is never deleted either, so the parse can be re-run from the original text.
 */
export function buildParseErrorClear() {
  // The raw half goes with the sentence it explains: clearing one and leaving the other would keep a
  // status code on a row the panel has already been told to stop complaining about.
  return { sql: "UPDATE signals SET parse_error=NULL,technical_note=NULL WHERE parse_error IS NOT NULL AND parse_error <> ''", params: [] };
}

export const EXECUTION_STATE_SELECT = `SELECT
  (SELECT COUNT(*)::int FROM execution_jobs WHERE status='queued') AS queued_jobs,
  (SELECT COUNT(*)::int FROM execution_jobs WHERE status='processing') AS processing_jobs,
  (SELECT COUNT(*)::int FROM execution_jobs WHERE status='queued' AND expires_at <= NOW()) AS overdue_jobs,
  (SELECT COUNT(*)::int FROM execution_jobs WHERE status IN ('failed','unknown')) AS dead_jobs,
  (SELECT EXTRACT(EPOCH FROM (NOW() - MIN(created_at)))::int FROM execution_jobs WHERE status='queued') AS oldest_queued_seconds,
  (SELECT MAX(locked_at) FROM execution_jobs WHERE status='processing') AS last_claim_at,
  (SELECT COUNT(*)::int FROM trades WHERE status IN ('executed','filled') AND created_at >= NOW() - ($1::int * INTERVAL '1 hour')) AS executed_trades,
  (SELECT COUNT(*)::int FROM settings WHERE auto_trading_enabled=TRUE) AS auto_trading_workspaces,
  (SELECT COUNT(*)::int FROM users WHERE is_suspended=FALSE) AS active_users`;

export const ERROR_KINDS = Object.freeze({
  metaapi_execution: { label: 'MetaAPI order errors', hint: 'Orders the broker rejected, or whose outcome MetaAPI could not confirm.' },
  metaapi_stop_move: { label: 'MetaAPI stop-move errors', hint: 'Break-even and trailing stop changes that did not reach the broker.' },
  telegram_parse: { label: 'Telegram parsing errors', hint: 'Messages captured from channels that could not be read as a signal.' },
});

/** How long a connected, listening session may be silent before the panel says so out loud. */
export const CAPTURE_QUIET_MS = 15 * 60 * 1000;
/** An instance younger than this has almost certainly just been woken or redeployed. */
export const CAPTURE_RECENT_BOOT_MS = 5 * 60 * 1000;

/**
 * The one question the Telegram panel cannot answer by itself: is anything actually receiving?
 *
 * `live` is what this process holds in memory (sessions, verified handlers, counters), `stored` is
 * what the database believes (who is connected, which channels are monitored, when the last signal
 * landed). The failure this looks for is the gap between them - a session the users table still calls
 * connected, with monitored channels, while nothing in this process is attached to receive anything,
 * which is what a service that stops between visitors looks like. It is deliberately reported to the
 * administrator only: a workspace owner cannot act on their host sleeping, and a warning about it in
 * their dashboard would be noise wearing the costume of a fault.
 *
 * @typedef {Object} BuildCaptureHealthInput
 * @property {any} [live]
 * @property {any} [stored]
 * @property {any} [now]
 * @property {any} [quietMs]
 * @property {any} [recentBootMs]
 */
export function buildCaptureHealth(/** @type {BuildCaptureHealthInput} */ { live, stored, now = Date.now(), quietMs = CAPTURE_QUIET_MS, recentBootMs = CAPTURE_RECENT_BOOT_MS } = {}) {
  const facts = {
    available: Boolean(live),
    sessionsInMemory: Number(live?.sessionsInMemory || 0),
    listening: Number(live?.listening || 0),
    messagesSeen: Number(live?.messagesSeen || 0),
    signalsSaved: Number(live?.signalsSaved || 0),
    resumedAfterBoot: Number(live?.resumedAfterBoot || 0),
    lastMessageAt: live?.lastMessageAt || null,
    lastError: live?.sessions?.find((entry) => entry.lastError)?.lastError || null,
    gitCommit: live?.gitCommit || null,
    instanceStartedAt: live?.instanceStartedAt || null,
    instanceUptimeSeconds: Number.isFinite(live?.instanceUptimeSeconds) ? live.instanceUptimeSeconds : null,
    connectedUsers: Number(stored?.connectedUsers || 0),
    restorableSessions: Number(stored?.restorableSessions || 0),
    monitoredChannels: Number(stored?.monitoredChannels || 0),
    lastSignalAt: stored?.lastSignalAt || null,
    storedAvailable: stored !== null && stored !== undefined,
  };
  const nowMs = now instanceof Date ? now.getTime() : Number(now) || Date.now();
  const lastSeenMs = Date.parse(facts.lastMessageAt || facts.lastSignalAt || '') || null;
  const silenceMs = lastSeenMs === null ? null : Math.max(0, nowMs - lastSeenMs);
  const recentlyWoken = facts.instanceUptimeSeconds !== null && facts.instanceUptimeSeconds * 1000 < recentBootMs;
  // Nothing attached while the database still expects traffic is the actionable case; a freshly woken
  // instance says why, because the sessions are rebuilt in the seconds after a boot.
  const nothingAttached = facts.available && facts.listening === 0 && facts.monitoredChannels > 0;
  const quiet = facts.available && facts.listening > 0 && (silenceMs === null || silenceMs > quietMs);
  facts.nothingAttached = nothingAttached;
  facts.streamIdle = quiet;
  facts.sleepSuspected = (nothingAttached || quiet) && (recentlyWoken || silenceMs === null || silenceMs > quietMs);

  if (!facts.available) {
    return { state: 'unknown', headline: 'Unknown', detail: 'This process could not report its Telegram sessions, so whether messages are being received is unknown - not the same as nothing arriving.', facts, silenceMs, recentlyWoken };
  }
  if (!facts.storedAvailable) {
    return { state: 'unknown', headline: `${facts.listening} live`, detail: 'The sessions this instance is holding could not be compared with what the database expects, so the counts below may be incomplete.', facts, silenceMs, recentlyWoken };
  }
  if (nothingAttached && facts.connectedUsers === 0) {
    return { state: 'unavailable', headline: 'No session', detail: 'No workspace has a Telegram account connected, so there is nothing to listen to.', facts, silenceMs, recentlyWoken };
  }
  if (nothingAttached) {
    return {
      state: 'fail',
      headline: 'Not receiving',
      detail: `${facts.connectedUsers} workspace${facts.connectedUsers === 1 ? '' : 's'} have Telegram connected and ${facts.monitoredChannels} channel${facts.monitoredChannels === 1 ? '' : 's'} are monitored, but no session in this process has a live handler, so messages arriving now are not read.`
        + `${recentlyWoken ? ` This instance started ${facts.instanceUptimeSeconds}s ago${facts.resumedAfterBoot ? ` and has rebuilt ${facts.resumedAfterBoot} session${facts.resumedAfterBoot === 1 ? '' : 's'} since` : ' and has not rebuilt any session yet'}; on a host that stops between visitors the listener only exists while the process is running, and everything a channel posted in between is only recovered by the catch-up pull.` : ''}`
        + `${facts.lastError ? ` Last handler error: ${facts.lastError}` : ''}`,
      facts, silenceMs, recentlyWoken,
    };
  }
  if (quiet) {
    return {
      state: 'watch',
      headline: 'Connected, quiet',
      detail: `${facts.listening} session${facts.listening === 1 ? '' : 's'} listening${facts.lastMessageAt ? `, nothing has passed through the handler since ${facts.lastMessageAt}` : ', and this instance has not received a message yet'}.${silenceMs !== null ? ` That is ${Math.round(silenceMs / 60000)} minute${silenceMs >= 120000 ? 's' : ''} of silence.` : ''} A channel that posts nothing looks identical to a host that was asleep, which is why the seen/ignored counters below are the number to read.`
        + `${recentlyWoken ? ` This instance has been up ${facts.instanceUptimeSeconds}s, so an idle counter is expected immediately after a wake.` : ''}`,
      facts, silenceMs, recentlyWoken,
    };
  }
  return {
    state: 'ok',
    headline: `${facts.listening} listening`,
    detail: `${facts.sessionsInMemory} session${facts.sessionsInMemory === 1 ? '' : 's'} in this process, ${facts.messagesSeen} message${facts.messagesSeen === 1 ? '' : 's'} read, ${facts.signalsSaved} stored.`,
    facts, silenceMs, recentlyWoken,
  };
}

function stateFor(count, { failAt = 0, warnAt = 1 } = {}) {
  if (count > failAt) return 'fail';
  if (count >= warnAt) return 'watch';
  return 'ok';
}

/**
 * Turns the raw numbers into a short list of checks. The wording is produced here rather than in
 * the browser so the panel can never invent a reassuring sentence, and an unreadable section is
 * reported as `unknown` - never as "fine".
 *
 * @typedef {Object} BuildHealthChecksInput
 * @property {any} [killSwitch]
 * @property {any} [runtimeEnabled]
 * @property {any} [queue]
 * @property {any} [counts]
 * @property {Record<string, any>} [thresholds]
 * @property {Record<string, any>|null} [capture]
 * @property {Record<string, any>|null} [llm]
 */
export function buildHealthChecks(/** @type {BuildHealthChecksInput} */ { killSwitch, runtimeEnabled, queue, counts, thresholds = {}, capture = null, llm = null } = {}) {
  const checks = [];
  const switchState = killSwitch?.state;
  checks.push({
    key: 'kill_switch',
    label: 'Platform auto-trading switch',
    state: switchState === 'live' ? 'ok' : switchState === 'paused' ? 'paused' : 'fail',
    headline: switchState === 'live' ? 'Live' : switchState === 'paused' ? 'Paused' : 'Unknown',
    detail: switchState === 'live'
      ? 'New orders may be submitted for eligible workspaces.'
      : switchState === 'paused'
        ? `${killSwitch.reason || 'No reason recorded.'}${killSwitch.updatedByEmail ? ` — set by ${killSwitch.updatedByEmail}.` : ''}`
        : killSwitch?.reason || 'The switch could not be read, so execution is blocked until it can.',
  });
  checks.push({
    key: 'runtime',
    label: 'Execution runtime',
    state: runtimeEnabled ? 'ok' : 'unavailable',
    headline: runtimeEnabled ? 'Enabled' : 'Disabled',
    detail: runtimeEnabled
      ? 'The worker is running in this deployment.'
      : 'AUTO_TRADING_RUNTIME_ENABLED is off in this deployment, so no workspace can execute - the switch is not the reason.',
  });
  if (!queue) {
    checks.push({ key: 'queue', label: 'Execution queue', state: 'unknown', headline: 'Unknown', detail: 'The queue could not be read right now.' });
  } else {
    const overdue = Number(queue.overdueJobs || 0);
    checks.push({
      key: 'queue',
      label: 'Execution queue',
      state: overdue > 0 ? 'fail' : Number(queue.processingJobs || 0) > 0 ? 'ok' : 'idle',
      headline: overdue > 0 ? 'Backed up' : 'Draining',
      detail: overdue > 0
        ? `${overdue} queued job${overdue === 1 ? '' : 's'} already past their expiry, so the worker is not claiming work.`
        : `${queue.queuedJobs ?? 0} queued, ${queue.processingJobs ?? 0} in flight${Number(queue.oldestQueuedSeconds || 0) > 0 ? `, oldest waiting ${queue.oldestQueuedSeconds}s` : ''}.`,
    });
  }
  const errorThresholds = { executionFail: 15, parseFail: 40, ...thresholds };
  const pushErrorCheck = (kind, label, failAt) => {
    const count = Number(counts?.[kind]?.count || 0);
    if (counts?.available === false) {
      checks.push({ key: kind, label, state: 'unknown', headline: 'Unknown', detail: 'Recent errors could not be read right now.' });
      return;
    }
    checks.push({
      key: kind,
      label,
      state: stateFor(count, { failAt, warnAt: 1 }),
      headline: count ? `${count} in the last ${counts.windowHours ?? 24}h` : 'None',
      detail: count
        ? `${ERROR_KINDS[kind]?.hint || ''} Affecting ${counts[kind].affectedUsers || 0} workspace${counts[kind].affectedUsers === 1 ? '' : 's'}`
          + `${counts[kind].lastSeen ? `, last at ${new Date(counts[kind].lastSeen).toISOString().slice(0, 16).replace('T', ' ')} UTC.` : '.'}`
        : ERROR_KINDS[kind]?.hint || 'Nothing recorded in this window.',
    });
  };
  pushErrorCheck('metaapi_execution', 'MetaAPI execution', errorThresholds.executionFail);
  pushErrorCheck('metaapi_stop_move', 'Broker stop moves', errorThresholds.executionFail);
  pushErrorCheck('telegram_parse', 'Telegram parsing', errorThresholds.parseFail);
  if (capture) {
    checks.push({ key: 'capture', label: 'Telegram message capture', state: capture.state, headline: capture.headline, detail: capture.detail });
  }
  /* The fallback layer is the one part of capture whose behaviour is set by an environment variable, which
     makes it the part most often believed to be on when it is not. So the panel says which model this process
     read at boot, and the queue in front of it, instead of leaving an operator to infer it from a log line. */
  if (llm) {
    const waiting = Number(llm.waiting?.realtime || 0) + Number(llm.waiting?.replay || 0);
    const gated = Number(llm.gated || 0);
    checks.push({
      key: 'ai_reader',
      label: 'AI reading assistant',
      state: llm.enabled === true ? (gated > 0 ? 'watch' : 'ok') : 'unavailable',
      headline: llm.enabled === true ? (llm.model || 'configured') : 'Off',
      detail: llm.enabled === true
        ? `Layer 2 asks ${llm.model || 'the configured model'} at ${llm.host || 'the configured endpoint'} when the built-in reader cannot finish a signal.`
          + ` ${Number(llm.maxConcurrent || 0)} request${Number(llm.maxConcurrent || 1) === 1 ? '' : 's'} at a time, ${Number(llm.active || 0)} in flight, ${waiting} waiting.`
          + (gated > 0 ? ` ${gated} replayed message${gated === 1 ? '' : 's'} left for review because the queue was full.` : '')
          // The sentence a trader was not shown, kept here instead: same incident, right audience.
          + (llm.lastFailure?.technical
            ? ` Last failure${llm.lastFailure.code ? ` (${llm.lastFailure.code})` : ''} at ${llm.lastFailure.at || 'an unknown time'}: ${llm.lastFailure.technical}`
            : '')
        : `The fallback layer is switched off (${llm.disabledReason || 'no LLM_API_KEY set'}), so every message is read by the built-in parser alone and anything it cannot finish is saved for review.`,
    });
  }
  return checks;
}

function toIso(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export const CAPTURE_STATE_SELECT = `SELECT
  (SELECT count(*) FROM users WHERE telegram_connected=TRUE)::int AS connected_users,
  (SELECT count(*) FROM users WHERE telegram_connected=TRUE AND telegram_session IS NOT NULL)::int AS restorable_sessions,
  (SELECT count(*) FROM channels WHERE enabled=TRUE)::int AS monitored_channels,
  (SELECT max(created_at) FROM signals) AS last_signal_at`;

export function mapCaptureState(row = {}) {
  return {
    connectedUsers: Number(row.connected_users ?? 0),
    restorableSessions: Number(row.restorable_sessions ?? 0),
    monitoredChannels: Number(row.monitored_channels ?? 0),
    lastSignalAt: toIso(row.last_signal_at),
  };
}

/**
 *
 * @typedef {Object} SystemHealthServiceDeps
 * @property {PoolLike} [pool]
 * @property {any} [controls]
 * @property {boolean} [runtimeEnabled]
 * @property {LoggerMethods} [logger]
 * @property {Function} [now]
 * @property {Record<string, any>|null} [capture]
 * @property {Record<string, any>|null} [llm]
 */
export function createSystemHealthService(/** @type {SystemHealthServiceDeps} */ { pool, controls, runtimeEnabled = false, logger = console, now = () => new Date(), capture = null, llm = null } = {}) {
  if (!pool?.query) throw new TypeError('System health needs a database pool.');
  const log = (level, message, extra = {}) => logger?.[level]?.(message, extra);

  async function snapshot(input = {}) {
    const { hours, limit } = normalizeHealthQuery(input);
    // A deployment without the collector (tests, or a build that never wired Telegram) does not get a
    // capture section at all: "unknown" is the answer to an unreadable read, not to an absent one.
    const captureWired = Boolean(capture);
    const [killSwitch, errors, errorCounts, execution, liveCapture, storedCapture] = await Promise.all([
      typeof controls?.read === 'function' ? controls.read() : Promise.resolve(null),
      pool.query(RECENT_ERRORS_SELECT, [hours, limit]).then((result) => result.rows).catch((error) => {
        log('warn', 'Recent system errors could not be listed', { code: error.code || 'HEALTH_ERRORS_FAILED' });
        return null;
      }),
      pool.query(RECENT_ERROR_COUNTS_SELECT, [hours]).then((result) => result.rows).catch(() => null),
      pool.query(EXECUTION_STATE_SELECT, [hours]).then((result) => result.rows[0] || null).catch((error) => {
        log('warn', 'Execution queue state could not be read', { code: error.code || 'HEALTH_QUEUE_FAILED' });
        return null;
      }),
      captureWired
        ? (typeof capture === 'function' ? Promise.resolve().then(() => capture()) : Promise.resolve(capture)).catch(() => null)
        : Promise.resolve(null),
      captureWired
        ? pool.query(CAPTURE_STATE_SELECT).then((result) => mapCaptureState(result.rows[0] || {})).catch((error) => {
          log('warn', 'Telegram capture state could not be read', { code: error.code || 'HEALTH_CAPTURE_FAILED' });
          return null;
        })
        : Promise.resolve(null),
    ]);

    const counts = { available: errorCounts !== null, windowHours: hours };
    for (const row of errorCounts || []) {
      if (ERROR_KINDS[row.kind]) counts[row.kind] = { count: Number(row.count || 0), affectedUsers: Number(row.affectedUsers || 0), lastSeen: toIso(row.lastSeen) };
    }
    const queue = execution
      ? {
        queuedJobs: Number(execution.queued_jobs || 0),
        processingJobs: Number(execution.processing_jobs || 0),
        overdueJobs: Number(execution.overdue_jobs || 0),
        deadJobs: Number(execution.dead_jobs || 0),
        oldestQueuedSeconds: execution.oldest_queued_seconds === null || execution.oldest_queued_seconds === undefined ? null : Number(execution.oldest_queued_seconds),
        lastClaimAt: toIso(execution.last_claim_at),
        executedTrades: Number(execution.executed_trades || 0),
        autoTradingWorkspaces: Number(execution.auto_trading_workspaces || 0),
        activeUsers: Number(execution.active_users || 0),
      }
      : null;

    /*
     * The capture diagnostic, built once and used twice: the panel reads the numbers, the check row
     * reads the sentence, and neither can disagree with the other because both come from this call.
     */
    const captureHealth = liveCapture === null || liveCapture === undefined
      ? null
      : buildCaptureHealth({ live: liveCapture, stored: storedCapture, now: now() });

    /* What the AI reader is doing is process state rather than a row, so it is read from the process: the
       configuration this instance was started with and the queue in front of the endpoint. A reader that
       cannot answer is reported as no section at all, never as a healthy one. */
    let llmHealth = null;
    if (typeof llm === 'function') {
      /* Awaited through a resolved promise so a provider that has to look something up - the last failure this
         process recorded, for instance - is as simple to write as one that returns a constant. */
      try { llmHealth = (await Promise.resolve(llm())) || null; } catch { llmHealth = null; }
    }

    // One object feeds both the payload and the checks, so the sentence next to the toggle can
    // never disagree with the state the toggle reports.
    const switchState = killSwitch
      ? { state: killSwitch.state, paused: killSwitch.paused === true, reason: killSwitch.reason, updatedAt: toIso(killSwitch.updatedAt), updatedByEmail: killSwitch.updatedByEmail }
      : { state: 'unavailable', paused: true, reason: 'The platform switch is not wired up in this process, so automatic execution is blocked.', updatedAt: null, updatedByEmail: null };

    return {
      generatedAt: now().toISOString(),
      windowHours: hours,
      killSwitch: switchState,
      runtimeEnabled: runtimeEnabled === true,
      queue,
      counts,
      checks: buildHealthChecks({ killSwitch: switchState, runtimeEnabled: runtimeEnabled === true, queue, counts, capture: captureHealth, llm: llmHealth }),
      // Admin-only: what this process and the database each say about message capture, including how
      // long the instance has been up, because "is my fix even deployed" has to be answerable here.
      aiReader: llmHealth,
      capture: captureHealth
        ? {
          ...captureHealth.facts,
          silenceMs: captureHealth.silenceMs,
          recentlyWoken: captureHealth.recentlyWoken,
          state: captureHealth.state,
          headline: captureHealth.headline,
          detail: captureHealth.detail,
        }
        : null,
      // `false` only when the read itself failed: an empty list and an unreadable list are
      // different answers, and the panel has to say which one it is showing.
      errorsAvailable: errors !== null,
      errors: (errors || []).map((row) => ({
        kind: row.kind,
        kindLabel: ERROR_KINDS[row.kind]?.label || row.kind,
        occurredAt: toIso(row.occurredAt),
        status: row.status || null,
        message: String(row.message || '').slice(0, 500),
        symbol: row.symbol || null,
        side: row.side || null,
        accountId: row.accountId || null,
        userId: row.userId || null,
        email: row.email || null,
        name: row.name || null,
      })),
      errorsTruncated: (errors || []).length >= limit,
    };
  }

  return { snapshot };
}
