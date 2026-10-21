import { isPaidSubscriber } from './plan-limits.js';

/**
 * 30-day inactivity cleanup for MetaAPI accounts this workspace pays for.
 *
 * Accounts stay deployed around the clock so execution is never delayed; this service
 * does not sleep, wake, or undeploy anything. It only deletes accounts nobody has used
 * for a month, because an abandoned provisioned account keeps billing forever.
 *
 * The clock is `users.last_active_at`, refreshed on sign-in, when execution settings are
 * saved, and when a signal is executed. Because the thresholds are read from that
 * timestamp rather than from a calendar schedule, a service that was asleep or restarted
 * simply catches up on its next sweep instead of missing a day.
 *
 * Deleting a broker account can strand a trade, so two rules outrank the schedule:
 * a paying subscriber is never touched, and an account that is still carrying an open
 * position or pending order is left alone and retried. Both are recorded, not silent.
 */
export const INACTIVITY_WARNING_DAYS = 25;
export const INACTIVITY_DELETION_DAYS = 30;
export const INACTIVITY_RETRY_HOURS = 12;
export const INACTIVITY_SWEEP_LIMIT = 25;
export const INACTIVITY_MAX_ATTEMPTS = 10;
export const DAY_MS = 86_400_000;

export const INACTIVITY_WARNING_TEXT = 'Your MT4/MT5 account {account} has been inactive for {days} days. To prevent unauthorized access and free up resources, it will be permanently deleted in {remaining} days. Please log in to keep it active.';

function safeText(value) {
  return String(value || '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/(authorization|auth[-_ ]?token|access[-_ ]?token|api[-_ ]?token|password|secret)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1000);
}

export function warningText({ accountName, daysInactive, warningDays = INACTIVITY_WARNING_DAYS, deletionDays = INACTIVITY_DELETION_DAYS }) {
  const remaining = Math.max(1, deletionDays - daysInactive);
  return INACTIVITY_WARNING_TEXT
    .replace('{account}', accountName ? `"${accountName}"` : 'your trading account')
    .replace('{days}', String(daysInactive))
    .replace('{remaining}', String(remaining));
}

export function daysInactiveSince(timestamp, now = Date.now()) {
  const at = Date.parse(timestamp instanceof Date ? timestamp.toISOString() : String(timestamp || ''));
  if (!Number.isFinite(at)) return 0;
  return Math.max(0, Math.floor((now - at) / DAY_MS));
}

/**
 * The whole policy, as a pure decision so it can be tested without a database.
 * `positionState` is null when it could not be read, which fails closed: an account
 * whose position state is unknown is never deleted.
 */
export function inactivityDecision({
  daysInactive,
  accountState = null,
  subscribed = false,
  suspended = false,
  alreadyWarned = false,
  gaveUp = false,
  retryBlocked = false,
  positionState = null,
  warningDays = INACTIVITY_WARNING_DAYS,
  deletionDays = INACTIVITY_DELETION_DAYS,
  maxAttempts = INACTIVITY_MAX_ATTEMPTS,
  attempts = 0,
} = {}) {
  if (subscribed) return { action: 'skip', reason: 'active-subscription' };
  if (suspended) return { action: 'skip', reason: 'suspended' };
  if (daysInactive < warningDays) return { action: 'skip', reason: 'not-due' };
  if (daysInactive < deletionDays) {
    return alreadyWarned ? { action: 'skip', reason: 'already-warned' } : { action: 'warn' };
  }
  if (gaveUp) return { action: 'skip', reason: 'gave-up' };
  if (retryBlocked) return { action: 'skip', reason: 'retry-paced' };
  // An undeployed or disconnected account cannot be holding a live trade, and there is
  // no connection to read, so the position check is not applicable rather than unknown.
  const deployed = !accountState || String(accountState).toUpperCase() === 'DEPLOYED' || String(accountState).toUpperCase() === 'CONNECTED';
  if (deployed) {
    if (!positionState || !positionState.readable) {
      // Repeatedly unable to check is a dead end, not a reason to keep trying forever.
      return attempts >= maxAttempts
        ? { action: 'give-up', reason: 'position-state-unreadable', attempts, maxAttempts }
        : { action: 'defer', reason: 'position-state-unreadable', attempts, maxAttempts };
    }
    if (Number(positionState.openPositions) > 0 || Number(positionState.pendingOrders) > 0) {
      return {
        action: 'defer',
        reason: 'open-positions',
        attempts,
        maxAttempts,
        openPositions: Number(positionState.openPositions) || 0,
        pendingOrders: Number(positionState.pendingOrders) || 0,
      };
    }
  }
  return { action: 'delete' };
}

export function createInactivityService({
  pool,
  trading = null,
  accountCleanup,
  resolveToken = null,
  warningDays = INACTIVITY_WARNING_DAYS,
  deletionDays = INACTIVITY_DELETION_DAYS,
  retryHours = INACTIVITY_RETRY_HOURS,
  sweepLimit = INACTIVITY_SWEEP_LIMIT,
  maxAttempts = INACTIVITY_MAX_ATTEMPTS,
  now = () => Date.now(),
  logger = console,
} = {}) {
  if (!pool?.query) throw new TypeError('The inactivity service needs a database pool.');

  async function touch(userId) {
    if (!userId) return;
    await pool.query('UPDATE users SET last_active_at=NOW() WHERE id=$1', [userId]);
  }

  /** Best effort: activity tracking must never fail the request it belongs to. */
  async function touchQuietly(userId) {
    try { await touch(userId); } catch (error) {
      logger.warn?.('User activity could not be recorded', { code: error?.code || 'ACTIVITY_TOUCH_FAILED' });
    }
  }

  async function candidates() {
    const { rows } = await pool.query(
      `SELECT ma.id AS account_row_id,ma.user_id,ma.metaapi_account_id,ma.name,ma.login,ma.platform,ma.state,
              ma.inactivity_status,ma.inactivity_for,ma.inactivity_checked_at,ma.inactivity_reason,ma.inactivity_attempts,
              u.email,u.name AS user_name,u.subscription_status,u.subscription_plan,u.is_suspended,
              COALESCE(u.last_active_at,u.last_login,u.created_at) AS last_active_at
       FROM metaapi_accounts ma
       JOIN users u ON u.id=ma.user_id
       WHERE ma.managed_by_app=TRUE
         AND COALESCE(u.last_active_at,u.last_login,u.created_at) < NOW() - ($1::text || ' days')::interval
       ORDER BY COALESCE(u.last_active_at,u.last_login,u.created_at) ASC,ma.created_at ASC
       LIMIT $2`,
      [String(warningDays), sweepLimit],
    );
    return rows;
  }

  async function positionState({ token, accountId }) {
    if (!trading?.getAccountState || !token) return { readable: false, openPositions: null, pendingOrders: null, error: 'no usable connection' };
    try {
      const state = await trading.getAccountState({ token, accountId });
      return {
        readable: true,
        openPositions: Array.isArray(state?.positions) ? state.positions.length : null,
        pendingOrders: Array.isArray(state?.orders) ? state.orders.length : null,
      };
    } catch (error) {
      return { readable: false, openPositions: null, pendingOrders: null, error: safeText(error?.message || error) };
    }
  }

  async function notice(row, kind, message, daysInactive) {
    await pool.query(
      `INSERT INTO account_activity_notices(user_id,metaapi_account_id,kind,days_inactive,account_name,message)
       VALUES($1,$2,$3,$4,$5,$6)`,
      [row.user_id, row.metaapi_account_id, kind, daysInactive, row.name || row.login || null, message ? safeText(message) : null],
    );
  }

  async function mark(row, patch) {
    const { status, reason = null, stampActivity = false, checkedAt = true, attempts = null } = patch;
    await pool.query(
      `UPDATE metaapi_accounts
       SET inactivity_status=$2,
           inactivity_reason=$3,
           inactivity_for=CASE WHEN $4::text = 'true' THEN $5::timestamptz ELSE inactivity_for END,
           inactivity_checked_at=CASE WHEN $6::text = 'true' THEN NOW() ELSE inactivity_checked_at END,
           inactivity_attempts=CASE WHEN $7::text IS NULL THEN inactivity_attempts + 1 ELSE $7::int END
       WHERE id=$1`,
      [row.account_row_id, status, reason, String(stampActivity), row.last_active_at, String(checkedAt), attempts],
    );
  }

  async function sweepOnce() {
    const summary = { scanned: 0, warned: 0, deferred: 0, deleted: 0, failed: 0, skippedSubscribed: 0, skippedSuspended: 0, skippedOther: 0 };
    let rows;
    try {
      rows = await candidates();
    } catch (error) {
      logger.error?.('Inactivity candidates could not be read', { code: error?.code || 'INACTIVITY_QUERY_FAILED', error: safeText(error?.message || error) });
      return { ...summary, reason: 'candidates-unavailable' };
    }
    summary.scanned = rows.length;
    if (!rows.length) return summary;

    for (const row of rows) {
      const daysInactive = daysInactiveSince(row.last_active_at, now());
      const lastActiveMs = Date.parse(row.last_active_at instanceof Date ? row.last_active_at.toISOString() : String(row.last_active_at));
      const warnedMs = Date.parse(row.inactivity_for instanceof Date ? row.inactivity_for.toISOString() : String(row.inactivity_for || ''));
      const checkedMs = Date.parse(row.inactivity_checked_at instanceof Date ? row.inactivity_checked_at.toISOString() : String(row.inactivity_checked_at || ''));
      const retryBlocked = Number.isFinite(checkedMs) && (now() - checkedMs) < retryHours * 3_600_000;
      let positions = null;
      if (daysInactive >= deletionDays) {
        const token = typeof resolveToken === 'function' ? await resolveToken(row).catch(() => null) : null;
        positions = await positionState({ token, accountId: row.metaapi_account_id });
      }
      const decision = inactivityDecision({
        daysInactive,
        accountState: row.state,
        subscribed: isPaidSubscriber({ subscription_status: row.subscription_status }),
        suspended: row.is_suspended === true,
        alreadyWarned: row.inactivity_status === 'warned' && warnedMs === lastActiveMs,
        gaveUp: row.inactivity_status === 'failed',
        retryBlocked,
        positionState: positions,
        attempts: Number(row.inactivity_attempts || 0),
        maxAttempts,
        warningDays,
        deletionDays,
      });

      if (decision.action === 'skip') {
        if (decision.reason === 'active-subscription') summary.skippedSubscribed += 1;
        else if (decision.reason === 'suspended') summary.skippedSuspended += 1;
        else summary.skippedOther += 1;
        continue;
      }

      if (decision.action === 'warn') {
        const message = warningText({ accountName: row.name || row.login, daysInactive, warningDays, deletionDays });
        try {
          await notice(row, 'warning', message, daysInactive);
          await mark(row, { status: 'warned', reason: null, stampActivity: true, attempts: 0 });
          summary.warned += 1;
          logger.info?.('Inactivity warning recorded', { userId: row.user_id, accountId: row.metaapi_account_id, daysInactive });
        } catch (error) {
          logger.error?.('Inactivity warning could not be recorded', { accountId: row.metaapi_account_id, error: safeText(error?.message || error) });
          summary.failed += 1;
        }
        continue;
      }

      if (decision.action === 'defer') {
        const reason = decision.reason === 'open-positions'
          ? `Not deleted: ${decision.openPositions || 'one or more'} open position(s) or pending order(s) are still on this account. Log in to close them or remove the account yourself.`
          : `Not deleted yet: MetaAPI could not confirm the account's open positions (${positions?.error || 'unreadable'}). Signal Desk will check again later.`;
        try {
          // Only announce the first deferral; a repeated check must not pile up notices.
          if (row.inactivity_status !== 'deferred') await notice(row, 'deferred', reason, daysInactive);
          await mark(row, { status: 'deferred', reason });
          summary.deferred += 1;
        } catch (error) {
          logger.error?.('Inactivity deferral could not be recorded', { accountId: row.metaapi_account_id, error: safeText(error?.message || error) });
          summary.failed += 1;
        }
        continue;
      }

      if (decision.action === 'give-up') {
        try {
          await mark(row, { status: 'failed', reason: 'Automatic deletion gave up after repeated failures. Remove the account from Trading Accounts, or delete it in MetaAPI.' });
          await notice(row, 'failed', 'Signal Desk could not delete this idle account automatically. It may still be billed; remove it from Trading Accounts or in MetaAPI.', daysInactive);
        } catch { /* nothing further to do */ }
        summary.skippedOther += 1;
        continue;
      }

      // action === 'delete'
      try {
        const cleanup = await accountCleanup.removeProviderAccounts({
          accounts: [{ metaapi_account_id: row.metaapi_account_id, managed_by_app: true }],
          resolveToken: () => (typeof resolveToken === 'function' ? resolveToken(row).catch(() => null) : null),
        });
        const removed = Number(cleanup?.deleted || 0) + Number(cleanup?.alreadyMissing || 0);
        if (removed < 1) throw new Error(cleanup?.failures?.[0]?.code ? `MetaAPI returned ${cleanup.failures[0].code}` : 'MetaAPI could not confirm the deletion.');
        const { rowCount } = await pool.query('DELETE FROM metaapi_accounts WHERE id=$1 AND user_id=$2', [row.account_row_id, row.user_id]);
        await pool.query(
          `UPDATE settings SET auto_trading_enabled=FALSE, execution_account_id=NULL, updated_at=NOW()
           WHERE user_id=$1 AND execution_account_id=$2`,
          [row.user_id, row.metaapi_account_id],
        );
        await notice(row, 'deleted', `Your idle MT4/MT5 account "${row.name || row.login || row.metaapi_account_id}" was deleted after ${daysInactive} days of inactivity, so it is no longer billed. Auto-Trading was switched off because its trading account is gone. Connect a new account any time.`, daysInactive);
        summary.deleted += 1;
        logger.info?.('Idle MetaAPI account deleted', { userId: row.user_id, accountId: row.metaapi_account_id, daysInactive, localRowsRemoved: rowCount });
      } catch (error) {
        // A provider failure must not lose the local link (nobody would ever retry it)
        // and must not stop the sweep for the other accounts.
        const reason = `Automatic deletion failed: ${safeText(error?.message || error)}`;
        try {
          if (row.inactivity_status !== 'deferred') await notice(row, 'failed', `${reason} Signal Desk will try again later.`, daysInactive);
          await mark(row, { status: 'deferred', reason });
        } catch { /* the next sweep retries from the same state */ }
        summary.failed += 1;
        logger.warn?.('Idle MetaAPI account could not be deleted', { accountId: row.metaapi_account_id, error: safeText(error?.message || error) });
      }
    }
    return summary;
  }

  /** Per-account idle state for the Trading Accounts page, including the exemption. */
  async function statusFor(userId) {
    const { rows } = await pool.query(
      `SELECT COALESCE(last_active_at,last_login,created_at) AS "lastActiveAt",subscription_status AS "subscriptionStatus"
       FROM users WHERE id=$1 LIMIT 1`,
      [userId],
    );
    const user = rows[0] || null;
    const { rows: notices } = await pool.query(
      `SELECT kind,metaapi_account_id AS "metaApiAccountId",days_inactive AS "daysInactive",account_name AS "accountName",message,created_at AS "createdAt"
       FROM account_activity_notices
       WHERE user_id=$1 AND kind IN ('warning','deferred','failed') AND created_at > NOW() - ($2::text || ' days')::interval
       ORDER BY created_at DESC LIMIT 5`,
      [userId, String(warningDays + deletionDays + 15)],
    );
    return {
      lastActiveAt: user?.lastActiveAt || null,
      daysInactive: user ? daysInactiveSince(user.lastActiveAt, now()) : 0,
      warningDays,
      deletionDays,
      exempt: isPaidSubscriber({ subscription_status: user?.subscriptionStatus }),
      notices,
    };
  }

  return Object.freeze({ touch, touchQuietly, sweepOnce, statusFor, candidates, warningText });
}
