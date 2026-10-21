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
  SELECT 'telegram_parse',s.created_at,s.status,s.parse_error,s.symbol,s.side,NULL,s.user_id,u.email,u.name
  FROM signals s JOIN users u ON u.id=s.user_id
  WHERE s.parse_error IS NOT NULL AND s.parse_error <> ''
    AND s.created_at >= NOW() - ($1::int * INTERVAL '1 hour')
)`;

export const RECENT_ERRORS_SELECT = `${RECENT_ERRORS_CTE}
SELECT kind,occurred_at AS "occurredAt",status,message,symbol,side,account_id AS "accountId",user_id AS "userId",email,name
FROM recent ORDER BY occurred_at DESC LIMIT $2`;

export const RECENT_ERROR_COUNTS_SELECT = `${RECENT_ERRORS_CTE}
SELECT kind,COUNT(*)::int AS count,COUNT(DISTINCT user_id)::int AS "affectedUsers",MAX(occurred_at) AS "lastSeen"
FROM recent GROUP BY kind`;

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

function stateFor(count, { failAt = 0, warnAt = 1 } = {}) {
  if (count > failAt) return 'fail';
  if (count >= warnAt) return 'watch';
  return 'ok';
}

/**
 * Turns the raw numbers into a short list of checks. The wording is produced here rather than in
 * the browser so the panel can never invent a reassuring sentence, and an unreadable section is
 * reported as `unknown` - never as "fine".
 */
export function buildHealthChecks({ killSwitch, runtimeEnabled, queue, counts, thresholds = {} }) {
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
  return checks;
}

function toIso(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function createSystemHealthService({ pool, controls, runtimeEnabled = false, logger = console, now = () => new Date() } = {}) {
  if (!pool?.query) throw new TypeError('System health needs a database pool.');
  const log = (level, message, extra = {}) => logger?.[level]?.(message, extra);

  async function snapshot(input = {}) {
    const { hours, limit } = normalizeHealthQuery(input);
    const [killSwitch, errors, errorCounts, execution] = await Promise.all([
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
      checks: buildHealthChecks({ killSwitch: switchState, runtimeEnabled: runtimeEnabled === true, queue, counts }),
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
