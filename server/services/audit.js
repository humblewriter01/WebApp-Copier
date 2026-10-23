/**
 * Administrator audit trail.
 *
 * One row per administrator action: what was done, the admin's email address at the time,
 * and when. The trail is append-only as far as the application is concerned - there is no
 * update or delete path - and a write failure is logged loudly but never turns a successful
 * admin action into an error, because "the price was saved but the response was a 500"
 * is worse than a gap in the log. Metadata is scrubbed of anything credential-shaped before
 * it is stored, since these rows are read back by a browser.
 */
import { validationError } from './admin.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Keys that must never be persisted, whatever their value looks like. */
const SECRET_KEY_PATTERN = /(token|password|secret|authorization|credential|session|api[-_]?key|apikey|otp|seed|pin)/i;
/** Values that look like a credential are redacted even under a harmless key. */
const SECRET_VALUE_PATTERN = /(authorization|auth[-_ ]?token|access[-_ ]?token|api[-_ ]?token|password|secret|bearer)\s*[:=]\s*[^\s,;]+/gi;

export const AUDIT_TARGET_TYPES = Object.freeze(['user', 'promo_code', 'plan', 'announcement', 'platform', 'support_session']);

/**
 * The closed vocabulary of recorded actions. A typo in a route should fail loudly in review,
 * so `buildAuditEntry` rejects anything not listed here instead of inventing a new key.
 */
export const AUDIT_ACTIONS = Object.freeze({
  'pricing.update': 'Pricing changed',
  'pricing.sync': 'Paystack plans re-synced',
  'promo_code.create': 'Promo code created',
  'promo_code.update': 'Promo code changed',
  'promo_code.delete': 'Promo code removed',
  'user.update': 'User account changed',
  'user.role': 'User role changed',
  'user.suspend': 'User suspended',
  'user.unsuspend': 'User suspension lifted',
  'subscription.grant': 'Plan granted',
  'subscription.extend': 'Subscription extended',
  'subscription.clear': 'Paid plan removed',
  'execution.pause': 'Auto-trading killed',
  'execution.resume': 'Auto-trading resumed',
  'announcement.publish': 'Announcement published',
  'announcement.update': 'Announcement changed',
  'announcement.retire': 'Announcement retired',
  'impersonation.start': 'Support access opened',
  'impersonation.stop': 'Support access closed',
  /* Signal history is application data an administrator can remove, so every path that removes it is in
     the vocabulary: the closed list exists to catch a typo in review, and a route that invents a key is
     refused *after* the write it was recording has already been committed. */
  'signal.delete': 'Captured signal removed',
  'signal.clearUser': 'Signal history cleared for one workspace',
  'signal.purgeOld': 'Old captured signals purged platform-wide',
  'user.suspend.refused': 'Suspension request refused',
});

const MAX_SUMMARY = 400;
const MAX_META_STRINGS = 200;
const MAX_META_KEYS = 24;

function cleanText(value, max) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(SECRET_VALUE_PATTERN, (match) => match.replace(/[:=].*$/, '=[redacted]'))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/**
 * Metadata is stored as JSON for humans, not as a serialization of anything. Only scalars
 * and short arrays of scalars survive, credential-shaped keys are dropped outright, and the
 * whole object is capped so one bad payload cannot bloat the table.
 */
export function sanitizeAuditMetadata(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const out = {};
  for (const [key, value] of Object.entries(input).slice(0, MAX_META_KEYS)) {
    const name = cleanText(key, 60);
    if (!name || SECRET_KEY_PATTERN.test(name)) continue;
    if (value === null || typeof value === 'boolean' || typeof value === 'number') {
      out[name] = typeof value === 'number' && !Number.isFinite(value) ? null : value;
    } else if (typeof value === 'string') {
      const text = cleanText(value, MAX_META_STRINGS);
      if (text) out[name] = text;
    } else if (Array.isArray(value)) {
      const items = value
        .filter((item) => item === null || ['string', 'number', 'boolean'].includes(typeof item))
        .slice(0, 20)
        .map((item) => (typeof item === 'string' ? cleanText(item, MAX_META_STRINGS) : item));
      out[name] = items;
    }
  }
  return out;
}

/**
 * Normalises one audit row. Deliberately forgiving about the actor (a missing email falls back
 * to a placeholder and is reported through `onWarning`) because losing an audit entry to a
 * validation throw at the end of a successful admin mutation would be the worse failure.
 */
export function buildAuditEntry(input = {}, { now = () => new Date(), onWarning } = {}) {
  const action = cleanText(input.action, 60);
  if (!action) throw validationError('An audit entry needs the action that was performed.');
  if (!Object.hasOwn(AUDIT_ACTIONS, action)) throw validationError(`Unknown audit action "${action}".`);
  const summary = cleanText(input.summary || AUDIT_ACTIONS[action], MAX_SUMMARY);
  if (!summary) throw validationError('An audit entry needs a summary.');
  let actorEmail = cleanText(input.actorEmail, 200).toLowerCase();
  if (!actorEmail) {
    actorEmail = 'unknown';
    onWarning?.('audit entry written without an actor email', { action });
  }
  const actorId = UUID_PATTERN.test(String(input.actorId || '')) ? String(input.actorId) : null;
  if (input.actorId && !actorId) {
    onWarning?.('audit entry actor id was not a uuid and was dropped', { action });
  }
  return {
    actorId,
    actorEmail,
    action,
    targetType: cleanText(input.targetType, 40).toLowerCase() || null,
    targetId: cleanText(input.targetId, 80) || null,
    summary,
    metadata: sanitizeAuditMetadata(input.metadata),
    createdAt: input.createdAt ? new Date(input.createdAt) : now(),
  };
}

export function normalizeAuditQuery(input = {}) {
  const rawLimit = input.limit === undefined || input.limit === '' ? 50 : Number(input.limit);
  if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > 200) {
    throw validationError('Choose how many audit entries to show (1-200).');
  }
  const rawOffset = input.offset === undefined || input.offset === '' ? 0 : Number(input.offset);
  if (!Number.isInteger(rawOffset) || rawOffset < 0 || rawOffset > 100_000) {
    throw validationError('That audit log page is not available.');
  }
  const action = cleanText(input.action, 60);
  if (action && !Object.hasOwn(AUDIT_ACTIONS, action)) throw validationError('That administrator action cannot be filtered.');
  const search = cleanText(input.search, 100);
  if (search.length === 1) throw validationError('Search the audit log with at least two characters.');
  return { action: action || null, search: search || null, limit: rawLimit, offset: rawOffset };
}

/** The `WHERE` half of the audit listing, built here so the route and the tests agree. */
export function auditFilterSql(query) {
  const clauses = [];
  const params = [];
  if (query.action) {
    params.push(query.action);
    clauses.push(`action=$${params.length}`);
  }
  if (query.search) {
    params.push(`%${query.search.replace(/[%_]/g, '\\$&')}%`);
    clauses.push(`(actor_email ILIKE $${params.length} OR summary ILIKE $${params.length} OR target_id ILIKE $${params.length})`);
  }
  return { text: clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '', params };
}

export const auditLogColumns = `id,actor_id AS "actorId",actor_email AS "actorEmail",action,target_type AS "targetType",
  target_id AS "targetId",summary,metadata,created_at AS "createdAt"`;

export function createAuditLogger({ pool, logger = console, now = () => new Date() } = {}) {
  if (!pool?.query) throw new TypeError('The audit logger needs a database pool.');
  const log = (level, message, extra = {}) => logger?.[level]?.(message, extra);

  /** Appends one entry. Returns the stored row, or null when the write failed. */
  async function record(input) {
    let entry;
    try {
      entry = buildAuditEntry(input, {
        now,
        onWarning: (message, extra) => log('warn', `Audit entry is incomplete: ${message}`, extra),
      });
    } catch (error) {
      log('error', 'Audit entry could not be built', { code: error.code || 'AUDIT_BUILD_FAILED', action: input?.action });
      return null;
    }
    try {
      const { rows } = await pool.query(
        `INSERT INTO admin_audit_logs(actor_id,actor_email,action,target_type,target_id,summary,metadata,created_at)
         VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8)
         RETURNING ${auditLogColumns}`,
        [
          entry.actorId,
          entry.actorEmail,
          entry.action,
          entry.targetType,
          entry.targetId,
          entry.summary,
          JSON.stringify(entry.metadata),
          entry.createdAt,
        ],
      );
      return rows[0] || null;
    } catch (error) {
      // An audit write must never break the action it is describing, but it must never be quiet either.
      log('error', 'Audit entry could not be written', { code: error.code || 'AUDIT_WRITE_FAILED', action: entry.action });
      return null;
    }
  }

  async function list(input = {}) {
    const query = normalizeAuditQuery(input);
    const filter = auditFilterSql(query);
    const { rows } = await pool.query(
      `SELECT ${auditLogColumns},COUNT(*) OVER()::int AS "totalCount",
        (SELECT COUNT(*)::int FROM admin_audit_logs) AS "totalEntries"
       FROM admin_audit_logs${filter.text}
       ORDER BY created_at DESC LIMIT $${filter.params.length + 1} OFFSET $${filter.params.length + 2}`,
      [...filter.params, query.limit, query.offset],
    );
    return {
      entries: rows.map((row) => ({ ...row, metadata: row.metadata || {} })),
      total: Number(rows[0]?.totalCount || 0),
      totalEntries: Number(rows[0]?.totalEntries || 0),
      limit: query.limit,
      offset: query.offset,
      actions: Object.entries(AUDIT_ACTIONS).map(([key, label]) => ({ key, label })),
    };
  }

  return { record, list };
}
