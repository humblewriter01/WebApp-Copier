import { assertQueryParameters } from './query-params.js';

const PROMO_CODE_PATTERN = /^[A-Z0-9][A-Z0-9_-]{2,49}$/;
const ROLE_VALUES = new Set(['user', 'admin']);
const DEFAULT_ADMIN_EMAILS = ['ameenujaafar432@gmail.com'];

export function validationError(message) {
  const error = new Error(message);
  error.status = 400;
  error.code = 'VALIDATION_ERROR';
  return error;
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

/**
 * Builds the workspace admin allow-list. The list comes from ADMIN_EMAILS (comma
 * separated) plus the original owner address, so promoting an admin only ever
 * requires configuration, not a code change.
 */
export function createAdminAccess({ env = process.env, fallbackEmails = DEFAULT_ADMIN_EMAILS } = {}) {
  const emails = [...fallbackEmails, ...String(env.ADMIN_EMAILS || '').split(',')]
    .map(normalizeEmail)
    .filter(Boolean);
  const uniqueEmails = Object.freeze([...new Set(emails)]);
  return Object.freeze({
    emails: uniqueEmails,
    isAdminEmail: (email) => uniqueEmails.includes(normalizeEmail(email)),
    isAdminRole: (role) => String(role || '').trim().toLowerCase() === 'admin',
  });
}

function roundCurrency(value) {
  return Math.round(value * 100) / 100;
}

function normalizeMaxUses(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 1_000_000) {
    throw validationError('Maximum uses must be a whole number between 1 and 1000000, or left empty for unlimited use.');
  }
  return parsed;
}

function normalizeExpiry(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) throw validationError('Enter a valid expiry date and time.');
  if (parsed.getTime() <= Date.now()) throw validationError('Choose an expiry date in the future.');
  return parsed.toISOString();
}

/** Validates and normalizes a new promo code before it reaches PostgreSQL. */
export function normalizePromoCodeInput(input = {}) {
  const code = String(input.code || '').trim().toUpperCase().replace(/\s+/g, '');
  if (!PROMO_CODE_PATTERN.test(code)) {
    throw validationError('Promo codes must be 3 to 50 characters using letters, numbers, hyphens, or underscores, and must start with a letter or number.');
  }

  const discountType = String(input.discountType || '').trim().toLowerCase();
  if (!['percentage', 'fixed'].includes(discountType)) {
    throw validationError('Choose a percentage or fixed discount type.');
  }

  const discountValue = Number(input.discountValue);
  if (!Number.isFinite(discountValue) || discountValue <= 0) {
    throw validationError('Enter a discount value greater than zero.');
  }
  if (discountType === 'percentage' && discountValue > 100) {
    throw validationError('A percentage discount cannot be greater than 100.');
  }
  if (discountType === 'fixed' && discountValue > 100_000) {
    throw validationError('A fixed discount cannot be greater than 100000.');
  }

  return Object.freeze({
    code,
    discountType,
    discountValue: discountType === 'fixed' ? roundCurrency(discountValue) : discountValue,
    maxUses: normalizeMaxUses(input.maxUses),
    expiresAt: normalizeExpiry(input.expiresAt),
  });
}

/** Validates a partial admin edit of a promo code. */
export function normalizePromoCodeUpdate(input = {}) {
  const update = {};
  if (Object.hasOwn(input, 'active')) {
    if (typeof input.active !== 'boolean') throw validationError('Active must be true or false.');
    update.active = input.active;
  }
  if (Object.hasOwn(input, 'maxUses')) update.maxUses = normalizeMaxUses(input.maxUses);
  if (Object.hasOwn(input, 'expiresAt')) update.expiresAt = normalizeExpiry(input.expiresAt);
  if (!Object.keys(update).length) throw validationError('Choose at least one change to save.');
  return Object.freeze(update);
}

/* ----------------------------------------------------------------------------------------------
 * Reading the account edit the panel sends.
 *
 * Every rejection here is a sentence an administrator reads instead of a red badge, so each one names
 * what the endpoint actually received rather than what it wanted. That distinction is the whole point:
 * a payload whose key is spelled differently, or whose boolean arrived as text, used to fail with
 * "Choose at least one change to save." - which is true, useless, and indistinguishable from having
 * pressed the button without changing anything.
 * ---------------------------------------------------------------------------------------------- */

/** The shape a value arrived in, never its contents - enough to spot a string where a boolean belongs. */
function describeValue(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'a list';
  if (typeof value === 'string') return `the text "${value.slice(0, 24)}"`;
  if (typeof value === 'object') return 'an object';
  return `a ${typeof value}`;
}

/**
 * A suspension flag, read tolerantly. `true`/`false` are what the panel sends; the same words as text
 * mean the same thing and cost nothing to accept, because the value only ever selects between two
 * statements the endpoint already validates. Anything else - a list, an object, a number - is refused
 * rather than guessed at.
 */
function readSuspensionFlag(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const text = value.trim().toLowerCase();
    if (text === 'true') return true;
    if (text === 'false') return false;
  }
  return undefined;
}

/** Field names only, sanitised: enough to reveal a key the endpoint does not write, never a value. */
function sentFieldNames(input) {
  const names = Object.keys(input || {})
    .filter((key) => /^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(key))
    .slice(0, 5)
    .map((key) => `"${key}"`);
  if (!names.length) return 'the request arrived with no recognised field';
  return `it sent ${names.join(', ')}`;
}

/** Validates a partial admin edit of a user record. */
export function normalizeUserUpdate(input = {}) {
  const update = {};

  if (Object.hasOwn(input, 'role')) {
    const role = String(input.role || '').trim().toLowerCase();
    if (!ROLE_VALUES.has(role)) throw validationError(`Choose either the user or admin role (received ${describeValue(input.role)}).`);
    update.role = role;
  }

  if (Object.hasOwn(input, 'isSuspended')) {
    const flag = readSuspensionFlag(input.isSuspended);
    if (flag === undefined) {
      throw validationError(`Suspension must be true or false (received ${describeValue(input.isSuspended)}).`);
    }
    update.isSuspended = flag;
  }

  if (Object.hasOwn(input, 'suspensionReason')) {
    update.suspensionReason = input.suspensionReason == null ? '' : String(input.suspensionReason).trim().slice(0, 200);
  }

  if (!Object.keys(update).length) {
    throw validationError(`Choose at least one change to save - this endpoint writes "role", "isSuspended" and "suspensionReason", and ${sentFieldNames(input)}.`);
  }

  if (update.isSuspended === true && !update.suspensionReason) {
    throw validationError(`Add a short reason so the user understands the suspension (suspensionReason ${Object.hasOwn(input, 'suspensionReason') ? 'arrived blank' : 'was not sent'}).`);
  }
  if (update.isSuspended === false) update.suspensionReason = '';

  return Object.freeze(update);
}

/** Guards destructive admin edits so an admin cannot lock themselves out. */
export function assertAllowedSelfUpdate({ actorId, targetId, update }) {
  if (String(actorId) !== String(targetId)) return;
  if (update.role === 'user') {
    const error = new Error('You cannot remove your own admin access.');
    error.status = 409;
    throw error;
  }
  if (update.isSuspended === true) {
    const error = new Error('You cannot suspend your own account.');
    error.status = 409;
    throw error;
  }
}

/**
 * Validates a manual subscription adjustment: grant a plan, add days, or both. The reason is
 * mandatory because it is what makes the audit row readable months later - "why does this
 * account have Premium for free" should never depend on remembering who asked.
 *
 * `endsAt` is offered for the case where support promised a specific date ("until the 30th");
 * it is validated as a future timestamp and takes precedence over `days`.
 */
export function normalizeSubscriptionAdjustment(input = {}, { plans = [] } = {}) {
  const planKeys = ['free', ...plans.map((plan) => String(plan.key).toLowerCase())];
  const adjustment = { planKey: null, days: null, endsAt: null, reason: '' };

  if (input.plan !== undefined && input.plan !== null && String(input.plan).trim() !== '') {
    const planKey = String(input.plan).trim().toLowerCase();
    if (!planKeys.includes(planKey)) {
      throw validationError(`Choose a plan the workspace sells: ${planKeys.join(', ')}.`);
    }
    adjustment.planKey = planKey;
  }

  if (input.days !== undefined && input.days !== null && String(input.days).trim() !== '') {
    const days = Number(input.days);
    if (!Number.isInteger(days) || days < 1 || days > 365) {
      throw validationError('Extend the subscription by 1 to 365 whole days.');
    }
    adjustment.days = days;
  }

  if (input.endsAt !== undefined && input.endsAt !== null && String(input.endsAt).trim() !== '') {
    const endsAt = new Date(input.endsAt);
    if (Number.isNaN(endsAt.getTime())) throw validationError('That expiry date is not readable.');
    if (endsAt.getTime() <= Date.now()) throw validationError('Set an expiry date in the future.');
    adjustment.endsAt = endsAt.toISOString();
  }

  const reason = String(input.reason ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
  if (reason.length < 5) throw validationError('Add a short reason for this adjustment (at least 5 characters).');
  adjustment.reason = reason;

  if (!adjustment.planKey && adjustment.days === null && !adjustment.endsAt) {
    throw validationError('Choose a plan to grant, days to add, or an expiry date.');
  }
  if (adjustment.planKey === 'free' && (adjustment.days !== null || adjustment.endsAt)) {
    throw validationError('Moving an account to Free already ends its paid period - remove the extra days.');
  }
  if (adjustment.days !== null && adjustment.endsAt) {
    throw validationError('Use either a number of days or an expiry date, not both.');
  }
  return Object.freeze(adjustment);
}

/**
 * Support access rules. A suspended account cannot sign in, so viewing its dashboard would show a
 * locked screen rather than what the customer sees, and an admin looking at their own workspace
 * gains nothing but an unauditable blur between two sessions.
 */
export function assertAllowedImpersonation({ actorId, target }) {
  if (!target) {
    const error = new Error('That account could not be found.');
    error.status = 404;
    throw error;
  }
  if (String(actorId) === String(target.id)) {
    const error = new Error('You cannot open a support session on your own account.');
    error.status = 409;
    throw error;
  }
  if (target.isSuspended === true) {
    const error = new Error('That account is suspended, so its dashboard is locked. Lift the suspension first.');
    error.status = 409;
    throw error;
  }
}

/**
 * A failed administrative mutation used to arrive at the panel as one anonymous sentence, because an
 * unexpected error has no status and its message is not safe to show. This names the action instead:
 * the administrator reads which button failed and why in one line, while the status is kept for
 * anything a validation chose deliberately. Sub-500 errors pass through untouched, because their
 * message was written for the person who just typed it.
 */
/**
 * `applied` says whether the mutation had already reached the database when the failure happened.
 * "Nothing was changed" is worth reading only when it is true; a failure after the write would
 * otherwise send the administrator to reload a list that already shows their change.
 */
export function adminActionError(action, error, { applied = false } = {}) {
  const status = Number(error?.status) || 500;
  if (status < 500) return error;
  const wrapped = new Error(error?.message || `${action} could not be completed.`);
  wrapped.status = status;
  if (error?.code) wrapped.code = error.code;
  if (error?.upgradeRequired) wrapped.upgradeRequired = true;
  const detail = [error?.message, error?.detail].filter(Boolean).join(' - ').replace(/\s+/g, ' ').trim().slice(0, 180);
  wrapped.userMessage = typeof error?.userMessage === 'string' && error.userMessage.trim()
    ? error.userMessage
    : `${action} did not complete${detail ? `: ${detail}` : ''}. ${applied
      ? 'Part of this may already be saved - reload the list before you try it again.'
      : 'Nothing was changed - please try again, and send us this reference if it fails twice.'}`;
  return wrapped;
}

/* ----------------------------------------------------------------------------------------------
 * Admin statements that are assembled rather than written out.
 *
 * A query with a fixed text is safe by inspection; these are not, because the columns they touch
 * depend on which fields the administrator filled in, and a period can come either from a number of
 * days or from an explicit end date. Each builder returns the statement *and* its values from the same
 * expression and checks them against each other before returning, which is the only moment both halves
 * are known together. `pool.query` repeats the check at the boundary, so a statement built anywhere
 * else in the app cannot reach Postgres half-bound either.
 * ---------------------------------------------------------------------------------------------- */

/** The account edit: only the fields that were sent are written, and the id binds last. */
export function buildUserAdminUpdate(update = {}, targetId) {
  const assignments = [];
  const values = [];
  const push = (column, value) => {
    values.push(value);
    assignments.push(`${column}=$${values.length}`);
  };
  if (update.role !== undefined) push('role', update.role);
  if (update.isSuspended !== undefined) push('is_suspended', update.isSuspended);
  if (update.suspensionReason !== undefined) push('suspension_reason', update.suspensionReason || null);
  if (!assignments.length) throw validationError('Choose at least one change to save.');
  /*
   * The write returns what it wrote, for one specific reason: the caller used to answer a successful
   * suspension by running a second SELECT over the whole admin column list, so any failure in that
   * follow-up - a connection dropped while the host was waking, one missing column - turned an
   * account that had really been suspended into an error in the panel. The state an administrator is
   * told about now comes from the statement that changed it, and the richer re-read is an
   * enhancement the route may skip. Every name in this list is a literal from a closed set, chosen by
   * which fields were assigned, never by their content.
   */
  const returning = ['id AS "userId"'];
  if (update.role !== undefined) returning.push('role');
  if (update.isSuspended !== undefined) returning.push('is_suspended AS "isSuspended"');
  if (update.isSuspended !== undefined || update.suspensionReason !== undefined) returning.push('suspension_reason AS "suspensionReason"');
  values.push(targetId);
  const sql = `UPDATE users SET ${assignments.join(',')} WHERE id=$${values.length}
     RETURNING ${returning.join(',')}`;
  assertQueryParameters(sql, values, 'Updating that account');
  return { sql, params: values };
}

/** The period an admin granted is counted once, in SQL, so the insert and the conflict update agree. */
export const SUBSCRIPTION_PERIOD_EXPRESSION = 'COALESCE($5::timestamptz,NOW() + ($4::text)::interval)';

/**
 * Granting a plan: the mirrored row on `users` (what the product enforces) and the subscription row
 * (what the expiry is read from). The period is one expression used twice - an explicit end date wins,
 * otherwise it is counted from now - rather than two different statements, because a variant that
 * mentions `$5` only sometimes is exactly how a bind ends up with more values than slots.
 *
 * @typedef {Object} BuildSubscriptionGrantStatementsInput
 * @property {string|null} [targetId]
 * @property {Record<string, any>} [plan]
 * @property {string|null} [interval]
 * @property {Record<string, any>} [period]
 * @property {string|null} [endsAt]
 * @property {Record<string, any>} [limits]
 */
export function buildSubscriptionGrantStatements(/** @type {BuildSubscriptionGrantStatementsInput} */ { targetId, plan, interval, period, endsAt = null, limits = {} } = {}) {
  if (!plan?.key) throw validationError('Choose a plan to grant.');
  const userUpdate = {
    sql: "UPDATE users SET subscription_status='active',subscription_plan=$2,plan_limits=$3 WHERE id=$1",
    params: [targetId, plan.key, JSON.stringify(limits || {})],
  };
  const subscription = {
    sql: `INSERT INTO subscriptions(user_id,plan_key,status,interval,current_period_end,cancel_at_period_end,started_at,provider,updated_at)
     VALUES($1,$2,'active',$3,${SUBSCRIPTION_PERIOD_EXPRESSION},FALSE,NOW(),'manual',NOW())
     ON CONFLICT(user_id) DO UPDATE SET plan_key=EXCLUDED.plan_key,status='active',interval=EXCLUDED.interval,
       current_period_end=GREATEST(COALESCE(subscriptions.current_period_end,NOW()),${SUBSCRIPTION_PERIOD_EXPRESSION}),
       cancel_at_period_end=FALSE,started_at=COALESCE(subscriptions.started_at,NOW()),canceled_at=NULL,updated_at=NOW()
     RETURNING current_period_end AS "periodEnd"`,
    params: [targetId, plan.key, interval || 'monthly', period, endsAt ?? null],
  };
  assertQueryParameters(userUpdate.sql, userUpdate.params, 'Adjusting that plan (account row)');
  assertQueryParameters(subscription.sql, subscription.params, 'Adjusting that plan (subscription row)');
  return { userUpdate, subscription };
}

/** Moving an existing subscription's expiry without changing the plan.
 *
 * @typedef {Object} BuildSubscriptionExtendStatementInput
 * @property {string|null} [targetId]
 * @property {number} [days]
 * @property {string|null} [endsAt]
 */
export function buildSubscriptionExtendStatement(/** @type {BuildSubscriptionExtendStatementInput} */ { targetId, days = null, endsAt = null } = {}) {
  const assignment = endsAt
    ? 'current_period_end=$2::timestamptz'
    : `current_period_end=GREATEST(COALESCE(current_period_end,NOW()),NOW()) + ($2::int * INTERVAL '1 day')`;
  const sql = `UPDATE subscriptions SET ${assignment},
           status=CASE WHEN status IN ('canceled','free') THEN 'non_renewing' ELSE status END,
           cancel_at_period_end=CASE WHEN status IN ('canceled','free') THEN TRUE ELSE cancel_at_period_end END,
           updated_at=NOW()
         WHERE user_id=$1
         RETURNING current_period_end AS "periodEnd",status,cancel_at_period_end AS "cancelAtPeriodEnd"`;
  const params = [targetId, endsAt || days];
  assertQueryParameters(sql, params, 'Adjusting that plan (extension)');
  return { sql, params };
}

/** Revoking a paid plan: both rows return to Free, and the limits with them.
 *
 * @typedef {Object} BuildSubscriptionReleaseStatementsInput
 * @property {string|null} [targetId]
 * @property {Record<string, any>} [limits]
 */
export function buildSubscriptionReleaseStatements(/** @type {BuildSubscriptionReleaseStatementsInput} */ { targetId, limits = {} } = {}) {
  const userUpdate = {
    sql: "UPDATE users SET subscription_status='free',subscription_plan='free',plan_limits=$2 WHERE id=$1",
    params: [targetId, JSON.stringify(limits || {})],
  };
  const subscription = {
    sql: "UPDATE subscriptions SET plan_key='free',status='free',current_period_end=NULL,cancel_at_period_end=FALSE,updated_at=NOW() WHERE user_id=$1",
    params: [targetId],
  };
  assertQueryParameters(userUpdate.sql, userUpdate.params, 'Adjusting that plan (account row)');
  assertQueryParameters(subscription.sql, subscription.params, 'Adjusting that plan (subscription row)');
  return { userUpdate, subscription };
}

/** Re-deriving the enforced mirror from the subscription row, which is the truth after any change.
 *
 * @typedef {Object} BuildSubscriptionMirrorStatementInput
 * @property {string|null} [targetId]
 * @property {string|null} [status]
 * @property {string} [planKey]
 * @property {Record<string, any>} [limits]
 */
export function buildSubscriptionMirrorStatement(/** @type {BuildSubscriptionMirrorStatementInput} */ { targetId, status, planKey, limits = {} } = {}) {
  const sql = 'UPDATE users SET subscription_status=$2,subscription_plan=$3,plan_limits=$4 WHERE id=$1';
  const params = [targetId, status, planKey, JSON.stringify(limits || {})];
  assertQueryParameters(sql, params, 'Adjusting that plan (mirror)');
  return { sql, params };
}

/* ----------------------------------------------------------------------------------------------
 * Signal deletion, as statements rather than string fragments.
 *
 * A signal is now removable by its owner and by an administrator, and the one thing that must never
 * happen is the ledger losing an order because the message that triggered it was cleared away. So
 * every delete is returned as a *pair* - unlink first, remove second - from the same expression, with
 * the placeholders and the values asserted against each other before either is sent. The optional age
 * filter is a `COALESCE($n::timestamptz,'infinity'::timestamptz)` rather than an `if`: a statement that
 * only sometimes mentions a placeholder is exactly how a bind ends up misaligned.
 * ---------------------------------------------------------------------------------------------- */

/** Signals older than this instant are in scope; `null` means "everything the filter names". */
const AGE_FILTER = "created_at < COALESCE($2::timestamptz,'infinity'::timestamptz)";

function assertPair(pair, label) {
  assertQueryParameters(pair.sql, pair.params, label);
  return pair;
}

/** One signal, deleted only by the account that owns it. */
export function buildSignalOwnershipDelete({ userId, signalId }) {
  return {
    unlink: assertPair({
      sql: 'UPDATE trades SET signal_id=NULL WHERE signal_id=$1 AND user_id=$2',
      params: [signalId, userId],
    }, 'Unlinking trades from that signal'),
    remove: assertPair({
      sql: 'DELETE FROM signals WHERE id=$1 AND user_id=$2 RETURNING id,created_at AS "createdAt",source',
      params: [signalId, userId],
    }, 'Deleting that signal'),
  };
}

/** One signal, deleted by an administrator from any workspace. */
export function buildAdminSignalDelete({ signalId }) {
  return {
    unlink: assertPair({
      sql: 'UPDATE trades SET signal_id=NULL WHERE signal_id=$1',
      params: [signalId],
    }, 'Unlinking trades from that signal'),
    remove: assertPair({
      sql: 'DELETE FROM signals WHERE id=$1 RETURNING id,user_id AS "userId",created_at AS "createdAt",source',
      params: [signalId],
    }, 'Deleting that signal'),
  };
}

/**
 * Every signal of one workspace - the user's own "clear history" and the administrator's per-account
 * delete, which is the same statement because the scope is the user id either way. Trades keep their
 * rows and lose only the pointer.
 */
export function buildSignalsPurgeForUser({ userId, olderThan = null }) {
  return {
    unlink: assertPair({
      sql: `UPDATE trades SET signal_id=NULL
            WHERE user_id=$1 AND signal_id IN (SELECT id FROM signals WHERE user_id=$1 AND ${AGE_FILTER})`,
      params: [userId, olderThan],
    }, 'Unlinking trades from those signals'),
    remove: assertPair({
      sql: `DELETE FROM signals WHERE user_id=$1 AND ${AGE_FILTER} RETURNING id`,
      params: [userId, olderThan],
    }, 'Deleting those signals'),
  };
}

/** The platform-wide age purge. The cutoff is arithmetic in SQL, so it cannot disagree with a preview. */
export function buildSignalsPurgeOlderThan({ days }) {
  const cutoff = "NOW() - ($1::int * INTERVAL '1 day')";
  return {
    unlink: assertPair({
      sql: `UPDATE trades t SET signal_id=NULL
            FROM signals s
            WHERE t.signal_id=s.id AND s.created_at < ${cutoff}`,
      params: [days],
    }, 'Unlinking trades from the expired signals'),
    remove: assertPair({
      sql: `DELETE FROM signals WHERE created_at < ${cutoff} RETURNING id`,
      params: [days],
    }, 'Deleting the expired signals'),
  };
}

/**
 * How many rows a purge would take, and how many executed orders it must unlink - read *before* the
 * write so a confirmation can state real numbers instead of reassuring nobody.
 */
export function buildSignalsPurgeCount({ userId = null, days = null }) {
  if (userId) {
    return assertPair({
      sql: `SELECT COUNT(*)::int AS signals,
                   (SELECT COUNT(*)::int FROM trades t
                     WHERE t.user_id=$1 AND t.signal_id IN (SELECT id FROM signals WHERE user_id=$1)) AS unlinkable_trades
              FROM signals WHERE user_id=$1 AND created_at < COALESCE($2::timestamptz,'infinity'::timestamptz)`,
      params: [userId, days],
    }, 'Counting the signals to clear');
  }
  return assertPair({
    sql: `SELECT COUNT(*)::int AS signals,
                 (SELECT COUNT(*)::int FROM trades t
                   WHERE t.signal_id IN (SELECT id FROM signals WHERE created_at < NOW() - ($1::int * INTERVAL '1 day'))) AS unlinkable_trades
            FROM signals WHERE created_at < NOW() - ($1::int * INTERVAL '1 day')`,
    params: [days],
  }, 'Counting the expired signals');
}
