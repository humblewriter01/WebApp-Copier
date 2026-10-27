/**
 * Support ("impersonate") sessions.
 *
 * An administrator needs to see a workspace exactly as its owner sees it: the same signals, the
 * same account state, the same notices. The safe way to do that is a second, short-lived token
 * that is *minted by the admin* - the customer's password is never read, never reset, and never
 * known, and there is nothing in the database that lets the token outlive its hour.
 *
 * What is stored is only a SHA-256 hash of a random session id. The signed token lives in the
 * admin's browser for the length of the session; the row is what makes it revocable, so closing
 * the support session - or an incident - cuts the token off on the next request instead of
 * waiting for the signature to expire.
 */
import crypto from 'node:crypto';
import { validationError } from './admin.js';

export const SUPPORT_SESSION_HOURS = 1;
export const SUPPORT_SESSION_MINUTES = SUPPORT_SESSION_HOURS * 60;
export const SUPPORT_SESSION_REASON_MIN = 3;
export const SUPPORT_SESSION_REASON_MAX = 200;
/** Rows are kept for review after they die; nothing lives in this table forever. */
export const SUPPORT_SESSION_RETENTION_DAYS = 30;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function supportTokenHash(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

export function normalizeSupportReason(value) {
  const reason = String(value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, SUPPORT_SESSION_REASON_MAX);
  if (reason.length < SUPPORT_SESSION_REASON_MIN) {
    throw validationError(`Say why you need support access (${SUPPORT_SESSION_REASON_MIN}-${SUPPORT_SESSION_REASON_MAX} characters) - it is written to the audit log.`);
  }
  return reason;
}

export function sessionIsLive(record, now = new Date()) {
  if (!record || record.revokedAt) return false;
  const expiresAt = new Date(record.expiresAt).getTime();
  return Number.isFinite(expiresAt) && now.getTime() < expiresAt;
}

/**
 * Claims put inside the signed token. `purpose` is what separates a support token from a normal
 * login: the server refuses admin routes and any write for it, so a support session can never
 * become a way to change a customer's account.
 */
export function buildSupportClaims({ sessionId, jti, adminId, adminEmail, userId, userEmail }) {
  return {
    sub: userId,
    email: userEmail,
    act: adminId,
    actEmail: adminEmail,
    jti,
    sid: sessionId,
    purpose: 'impersonation',
  };
}

/**
 *
 * @typedef {Object} SupportSessionServiceDeps
 * @property {PoolLike} [pool]
 * @property {number} [hours]
 * @property {LoggerMethods} [logger]
 * @property {Function} [now]
 * @property {Function} [randomId]
 */
export function createSupportSessionService(/** @type {SupportSessionServiceDeps} */ {
  pool,
  hours = SUPPORT_SESSION_HOURS,
  logger = console,
  now = () => new Date(),
  randomId = () => crypto.randomUUID(),
} = {}) {
  if (!pool?.query) throw new TypeError('Support sessions need a database pool.');
  const log = (level, message, extra = {}) => logger?.[level]?.(message, extra);
  const ttlMinutes = Math.min(Math.max(Math.trunc(Number(hours) * 60) || SUPPORT_SESSION_MINUTES, 1), SUPPORT_SESSION_MINUTES);

  async function start({ adminId, userId, reason = null }) {
    if (!UUID_PATTERN.test(String(adminId || '')) || !UUID_PATTERN.test(String(userId || ''))) {
      throw validationError('A support session needs an administrator and an account to view.');
    }
    const jti = randomId();
    const expiresAt = new Date(now().getTime() + ttlMinutes * 60_000);
    const { rows } = await pool.query(
      `INSERT INTO support_sessions(token_hash,admin_id,user_id,reason,created_at,expires_at)
       VALUES($1,$2,$3,$4,NOW(),$5)
       RETURNING id,expires_at AS "expiresAt",created_at AS "createdAt"`,
      [supportTokenHash(jti), adminId, userId, reason, expiresAt],
    );
    const row = rows[0] || null;
    if (!row) throw new Error('Support session could not be recorded.');
    log('warn', 'Support session opened', { sessionId: row.id, adminId, userId, ttlMinutes });
    return { sessionId: row.id, jti, expiresAt: new Date(row.expiresAt || expiresAt).toISOString(), ttlMinutes };
  }

  /** Only a live, unrevoked row redeems. Any failure returns null, which the caller turns into a 401. */
  async function redeem(jti) {
    if (!jti) return null;
    try {
      const { rows } = await pool.query(
        `SELECT id,admin_id AS "adminId",user_id AS "userId",reason,revoked_at AS "revokedAt",
                created_at AS "createdAt",expires_at AS "expiresAt"
         FROM support_sessions WHERE token_hash=$1 LIMIT 1`,
        [supportTokenHash(jti)],
      );
      const record = rows[0] || null;
      if (!record) return null;
      if (!sessionIsLive(record, now())) {
        log('warn', 'Support session is no longer valid', { sessionId: record.id, revoked: Boolean(record.revokedAt) });
        return null;
      }
      return record;
    } catch (error) {
      log('error', 'Support session could not be verified', { code: error.code || 'SUPPORT_SESSION_READ_FAILED' });
      return null;
    }
  }

  async function stop({ sessionId, adminId = null }) {
    const params = [sessionId];
    let filter = '';
    if (adminId) {
      params.push(adminId);
      filter = ` AND admin_id=$${params.length}`;
    }
    const { rows } = await pool.query(
      `UPDATE support_sessions SET revoked_at=NOW()
       WHERE id=$1 AND revoked_at IS NULL${filter}
       RETURNING id,revoked_at AS "revokedAt"`,
      params,
    );
    const revoked = Boolean(rows[0]);
    if (revoked) log('warn', 'Support session closed', { sessionId, adminId });
    return { revoked, sessionId };
  }

  async function revokeForUser(userId) {
    const result = await pool.query('UPDATE support_sessions SET revoked_at=NOW() WHERE user_id=$1 AND revoked_at IS NULL', [userId]);
    return { revoked: result.rowCount || 0 };
  }

  async function list({ limit = 25, offset = 0 } = {}) {
    await pool.query(
      'DELETE FROM support_sessions WHERE expires_at < NOW() - ($1::int * INTERVAL \'1 day\')',
      [SUPPORT_SESSION_RETENTION_DAYS],
    ).catch(() => 0);
    const { rows } = await pool.query(
      `SELECT s.id,s.reason,s.created_at AS "createdAt",s.expires_at AS "expiresAt",s.revoked_at AS "revokedAt",
              a.email AS "adminEmail",u.email AS "userEmail",u.name AS "userName",
              COUNT(*) OVER()::int AS "totalCount"
       FROM support_sessions s
       JOIN users a ON a.id=s.admin_id
       JOIN users u ON u.id=s.user_id
       ORDER BY s.created_at DESC LIMIT $1 OFFSET $2`,
      [limit, offset],
    );
    const at = now();
    return {
      sessions: rows.map((row) => ({
        ...row,
        live: sessionIsLive(row, at),
        secondsLeft: sessionIsLive(row, at) ? Math.max(0, Math.round((new Date(row.expiresAt).getTime() - at.getTime()) / 1000)) : 0,
      })),
      total: Number(rows[0]?.totalCount || 0),
      liveCount: rows.filter((row) => sessionIsLive(row, at)).length,
    };
  }

  return { start, redeem, stop, revokeForUser, list, ttlMinutes };
}
