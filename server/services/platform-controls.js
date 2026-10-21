/**
 * The platform-wide auto-trading kill switch.
 *
 * A per-user setting can already stop one workspace, and `AUTO_TRADING_RUNTIME_ENABLED` can
 * stop the whole service - but an environment flag is read once at boot, so it can never be
 * flipped while the process is running. This is the switch that can: the state lives in
 * `admin_settings` and the execution engine reads it before it submits an order, so turning
 * it off stops new trades for every user on the next claim without a deploy or a restart.
 *
 * Reading is fail-closed. If the stored value cannot be trusted or cannot be read at all, the
 * platform is treated as paused: a broker order that should not have been sent is much more
 * expensive than a signal that waits for the next poll, and the health panel reports the
 * uncertainty as `unavailable` instead of quietly showing "live".
 */
import { validationError } from './admin.js';

export const KILL_SWITCH_SETTING_KEY = 'auto_trading_kill_switch';
export const KILL_SWITCH_DESCRIPTION = 'Platform-wide switch that stops new automatic orders for every workspace.';
export const KILL_SWITCH_PAUSE_MESSAGE = 'Automatic execution is paused by Signal Desk. New orders are not being submitted.';
const MAX_REASON = 300;

function clean(value, max) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

export function normalizeKillSwitchInput(input = {}) {
  let paused = null;
  if (typeof input.paused === 'boolean') paused = input.paused;
  else if (typeof input.tradingPaused === 'boolean') paused = input.tradingPaused;
  else if (typeof input.enabled === 'boolean') paused = !input.enabled;
  else if (input.paused === 'true' || input.paused === 1 || input.paused === '1') paused = true;
  else if (input.paused === 'false' || input.paused === 0 || input.paused === '0') paused = false;
  if (paused === null) throw validationError('Say whether automatic execution should be paused.');
  const reason = clean(input.reason, MAX_REASON);
  if (paused && reason.length < 3) {
    throw validationError('Add a short reason for the pause - it is shown to every workspace that asks why signals were not executed.');
  }
  return { paused, reason: reason || null };
}

/**
 * Interprets the stored JSONB value. Anything that is not a definite `{"paused": false}` is
 * treated as paused, and the state is reported so a caller can tell "live" from "we could not
 * tell" instead of defaulting to a green light.
 */
export function readKillSwitchValue(row) {
  if (!row) {
    return { state: 'live', paused: false, reason: null, updatedAt: null, updatedByEmail: null, stored: false };
  }
  const value = typeof row.settingValue === 'string' ? safeParse(row.settingValue) : row.settingValue;
  const updatedAt = row.updatedAt || null;
  const updatedByEmail = row.updatedByEmail || null;
  if (!value || typeof value !== 'object' || typeof value.paused !== 'boolean') {
    return {
      state: 'unavailable',
      paused: true,
      reason: 'The stored platform switch could not be read, so automatic execution is blocked until an administrator sets it again.',
      updatedAt,
      updatedByEmail,
      stored: true,
    };
  }
  return {
    state: value.paused ? 'paused' : 'live',
    paused: value.paused === true,
    reason: clean(value.reason, MAX_REASON) || null,
    updatedAt,
    updatedByEmail,
    stored: true,
  };
}

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function createPlatformControls({ pool, logger = console } = {}) {
  if (!pool?.query) throw new TypeError('Platform controls need a database pool.');
  const log = (level, message, extra = {}) => logger?.[level]?.(message, extra);

  async function read() {
    try {
      const { rows } = await pool.query(
        `SELECT a.setting_value AS "settingValue",a.updated_at AS "updatedAt",u.email AS "updatedByEmail"
         FROM admin_settings a LEFT JOIN users u ON u.id=a.updated_by
         WHERE a.setting_key=$1 LIMIT 1`,
        [KILL_SWITCH_SETTING_KEY],
      );
      return readKillSwitchValue(rows[0]);
    } catch (error) {
      log('error', 'Platform kill switch could not be read; automatic execution stays blocked', { code: error.code || 'KILL_SWITCH_READ_FAILED' });
      return {
        state: 'unavailable',
        paused: true,
        reason: 'The platform switch could not be read from the database, so automatic execution is blocked.',
        updatedAt: null,
        updatedByEmail: null,
        stored: false,
      };
    }
  }

  /** What the engine asks before every order. Fail-closed by construction: only 'live' trades. */
  async function isPaused() {
    const snapshot = await read();
    return snapshot.state !== 'live';
  }

  async function setPaused({ paused, reason = null, actorId = null }) {
    const value = { paused: paused === true, reason: clean(reason, MAX_REASON) || null, changedAt: new Date().toISOString() };
    const { rows } = await pool.query(
      `INSERT INTO admin_settings(setting_key,setting_value,description,updated_by,created_at,updated_at)
       VALUES($1,$2::jsonb,$3,$4,NOW(),NOW())
       ON CONFLICT(setting_key) DO UPDATE SET setting_value=EXCLUDED.setting_value,description=EXCLUDED.description,
         updated_by=EXCLUDED.updated_by,updated_at=NOW()
       RETURNING setting_key AS "settingKey",updated_at AS "updatedAt"`,
      [KILL_SWITCH_SETTING_KEY, JSON.stringify(value), KILL_SWITCH_DESCRIPTION, actorId],
    );
    const snapshot = await read();
    log(paused ? 'warn' : 'info', paused ? 'Platform auto-trading kill switch engaged' : 'Platform auto-trading kill switch released', {
      actorId: actorId || null,
      reason: value.reason,
      state: snapshot.state,
    });
    return { ...snapshot, writtenAt: rows[0]?.updatedAt || new Date().toISOString() };
  }

  return { read, isPaused, setPaused };
}
