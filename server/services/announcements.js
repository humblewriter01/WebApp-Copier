/**
 * Global system announcements.
 *
 * One banner, shown to every signed-in workspace at the top of the dashboard, dismissible per
 * user. Dismissal is stored as its own row rather than in the browser, because a user who
 * dismisses a maintenance notice on their phone should not see it again on the web - and an
 * admin can see how many people dismissed it.
 *
 * An announcement is "live" when it is active and inside its optional window. Retiring never
 * deletes the row: the dismissal records and the audit trail keep pointing at something real.
 */
import { validationError } from './admin.js';

export const ANNOUNCEMENT_LEVELS = Object.freeze(['info', 'warning', 'critical']);
export const ANNOUNCEMENT_MIN_LENGTH = 4;
export const ANNOUNCEMENT_MAX_LENGTH = 500;
export const ANNOUNCEMENT_PAGE_SIZE_MAX = 100;
export const LIVE_ANNOUNCEMENT_LIMIT = 3;

/**
 * The announcement columns, described once and rendered two ways.
 *
 * The qualified form belongs to the reads, which join `announcements a` to users and dismissal counts.
 * The unqualified form belongs to every `RETURNING` clause, because an `INSERT` cannot alias its
 * target at all and an `UPDATE` that does not name an alias has no `a` to resolve: asking for `a.id`
 * there is not a stylistic slip: Postgres refuses the statement with `missing FROM-clause entry for
 * table "a"` before a row is written, and all the panel gets to show is that raw sentence.
 */
const ANNOUNCEMENT_FIELDS = [
  ['id'], ['message'], ['level'], ['active'],
  ['starts_at', 'startsAt'], ['ends_at', 'endsAt'],
  ['created_at', 'createdAt'], ['updated_at', 'updatedAt'], ['created_by', 'createdBy'],
];

function announcementSelect(prefix) {
  return ANNOUNCEMENT_FIELDS.map(([column, alias]) => `${prefix}${column}${alias ? ` AS "${alias}"` : ''}`).join(',');
}

export const announcementColumns = announcementSelect('a.');
export const announcementReturnColumns = announcementSelect('');

function clean(value, max) {
  return String(value ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function parseTime(value, label, { now, mustBeFuture = false } = {}) {
  if (value === undefined || value === null || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw validationError(`That ${label} is not a readable date and time.`);
  // A start time in the recent past is normal ("publish it now"); an end time in the past
  // would produce an announcement nobody can see, which is always a mistake.
  if (mustBeFuture && date.getTime() <= now.getTime()) {
    throw validationError(`That ${label} has already passed, so nobody would see the announcement. Pick a later time or leave it empty.`);
  }
  return date.toISOString();
}

/**
 * Validates an announcement body. `partial` is used by the patch route, where a missing key means
 * "leave it alone" and only the supplied keys are returned.
 */
export function normalizeAnnouncementDraft(input = {}, { partial = false, now = new Date() } = {}) {
  // A patch draft keeps every key and uses `undefined` for "leave this alone", so the writer
  // below is the only place that decides which columns an UPDATE touches.
  const draft = { message: undefined, level: undefined, active: undefined, startsAt: undefined, endsAt: undefined };

  if (!partial || (Object.hasOwn(input, 'message') && input.message !== null)) {
    const message = clean(input.message, ANNOUNCEMENT_MAX_LENGTH);
    if (message.length < ANNOUNCEMENT_MIN_LENGTH) {
      throw validationError(`Write at least ${ANNOUNCEMENT_MIN_LENGTH} characters for the announcement.`);
    }
    draft.message = message;
  }

  if (input.level !== undefined && input.level !== null && input.level !== '') {
    const level = String(input.level).trim().toLowerCase();
    if (!ANNOUNCEMENT_LEVELS.includes(level)) throw validationError('Choose info, warning, or critical for the announcement.');
    draft.level = level;
  } else if (!partial) {
    draft.level = 'info';
  }

  if (Object.hasOwn(input, 'active')) {
    if (typeof input.active !== 'boolean') throw validationError('Say whether the announcement is live.');
    draft.active = input.active;
  } else if (!partial) {
    draft.active = true;
  }

  if (Object.hasOwn(input, 'startsAt')) draft.startsAt = parseTime(input.startsAt, 'start time', { now });
  else if (!partial) draft.startsAt = null;

  if (Object.hasOwn(input, 'endsAt')) draft.endsAt = parseTime(input.endsAt, 'end time', { now, mustBeFuture: true });
  else if (!partial) draft.endsAt = null;

  const startsAt = draft.startsAt ?? null;
  const endsAt = draft.endsAt ?? null;
  if (startsAt && endsAt && new Date(endsAt).getTime() <= new Date(startsAt).getTime()) {
    throw validationError('The announcement end time has to be after its start time.');
  }
  return draft;
}

export function normalizeAnnouncementListQuery(input = {}) {
  const rawLimit = input.limit === undefined || input.limit === '' ? 25 : Number(input.limit);
  if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > ANNOUNCEMENT_PAGE_SIZE_MAX) {
    throw validationError('Choose how many announcements to show (1-100).');
  }
  const rawOffset = input.offset === undefined || input.offset === '' ? 0 : Number(input.offset);
  if (!Number.isInteger(rawOffset) || rawOffset < 0 || rawOffset > 100_000) throw validationError('That page is not available.');
  const status = String(input.status || 'all').trim().toLowerCase();
  if (!['all', 'live', 'retired', 'scheduled'].includes(status)) throw validationError('That announcement filter is not available.');
  return { limit: rawLimit, offset: rawOffset, status };
}

/** Whether a row is on screen for a user right now - one definition, used by the panel and the banner. */
export function announcementIsLive(row, now = new Date()) {
  if (!row || row.active !== true) return false;
  const start = row.startsAt ? new Date(row.startsAt).getTime() : -Infinity;
  const end = row.endsAt ? new Date(row.endsAt).getTime() : Infinity;
  const at = now.getTime();
  return at >= start && at < end;
}

export function announcementState(row, now = new Date()) {
  if (!row) return 'unknown';
  if (!announcementIsLive(row, now)) {
    if (row.active === true && row.startsAt && new Date(row.startsAt).getTime() > now.getTime()) return 'scheduled';
    return row.active === true ? 'ended' : 'retired';
  }
  return 'live';
}

/**
 * The statement behind the banner panel's "Clear history" button.
 *
 * Retiring a banner has always been a soft change - `active=FALSE`, the row kept - which is why the
 * history list only ever grows. This deletes the two states a row cannot come back from: retired ones,
 * and ones whose end date has passed. Those two terms are exactly `announcementState`'s `retired` and
 * `ended` branches: `announcements_window_check` forbids a banner from ending before it starts, so a row
 * with a past `ends_at` can never be `scheduled`, and everything left standing (active, with an open or
 * future window) is a banner somebody can still see. `announcement_dismissals` hangs off these ids
 * with `ON DELETE CASCADE`, so each user's "I've seen this" record goes with its banner rather than
 * orphaning.
 */
export function buildRetiredAnnouncementClear() {
  return { sql: 'DELETE FROM announcements WHERE active = FALSE OR ends_at <= NOW()', params: [] };
}

export function createAnnouncementService({ pool, logger = console, now = () => new Date() } = {}) {
  if (!pool?.query) throw new TypeError('Announcements need a database pool.');
  const log = (level, message, extra = {}) => logger?.[level]?.(message, extra);

  async function publish({ draft, actorId = null }) {
    const { rows } = await pool.query(
      `INSERT INTO announcements(message,level,active,starts_at,ends_at,created_by,created_at,updated_at)
       VALUES($1,$2,$3,$4,$5,$6,NOW(),NOW())
       RETURNING ${announcementReturnColumns}`,
      [draft.message, draft.level, draft.active, draft.startsAt, draft.endsAt, actorId],
    );
    const row = rows[0] || null;
    if (row) {
      row.state = announcementState(row, now());
      row.dismissalCount = 0;
    }
    log('info', 'Announcement published', { id: row?.id || null, level: row?.level, active: row?.active, actorId });
    return row;
  }

  async function update({ id, draft }) {
    const columns = [];
    const params = [];
    const push = (column, value) => {
      params.push(value);
      columns.push(`${column}=$${params.length}`);
    };
    if (draft.message !== undefined) push('message', draft.message);
    if (draft.level !== undefined) push('level', draft.level);
    if (draft.active !== undefined) push('active', draft.active);
    if (draft.startsAt !== undefined) push('starts_at', draft.startsAt);
    if (draft.endsAt !== undefined) push('ends_at', draft.endsAt);
    if (!columns.length) return null;
    params.push(id);
    const { rows } = await pool.query(
      `UPDATE announcements SET ${columns.join(',')},updated_at=NOW() WHERE id=$${params.length} RETURNING ${announcementReturnColumns}`,
      params,
    );
    const row = rows[0] || null;
    if (row) row.state = announcementState(row, now());
    log('info', 'Announcement changed', { id, changed: columns.map((entry) => entry.split('=')[0]), actorId: draft.actorId ?? null });
    return row;
  }

  async function retire({ id }) {
    const { rows } = await pool.query(
      `UPDATE announcements SET active=FALSE,updated_at=NOW() WHERE id=$1 AND active=TRUE RETURNING ${announcementReturnColumns}`,
      [id],
    );
    const row = rows[0] || null;
    if (row) row.state = 'retired';
    log('warn', 'Announcement retired', { id, retired: Boolean(row) });
    return row;
  }

  async function list({ limit = 25, offset = 0, status = 'all' } = {}) {
    const at = now();
    const params = [];
    let where = '';
    if (status === 'live') {
      params.push(at);
      where = ' WHERE a.active=TRUE AND (a.starts_at IS NULL OR a.starts_at<=$1) AND (a.ends_at IS NULL OR a.ends_at>$1)';
    } else if (status === 'retired') {
      where = ' WHERE a.active=FALSE';
    } else if (status === 'scheduled') {
      params.push(at);
      where = ' WHERE a.active=TRUE AND a.starts_at IS NOT NULL AND a.starts_at>$1';
    }
    const limitAt = params.length + 1;
    const offsetAt = params.length + 2;
    const { rows } = await pool.query(
      `SELECT ${announcementColumns},u.email AS "createdByEmail",
        (SELECT COUNT(*)::int FROM announcement_dismissals d WHERE d.announcement_id=a.id) AS "dismissalCount",
        COUNT(*) OVER()::int AS "totalCount"
       FROM announcements a LEFT JOIN users u ON u.id=a.created_by${where}
       ORDER BY a.created_at DESC LIMIT $${limitAt} OFFSET $${offsetAt}`,
      [...params, limit, offset],
    );
    return {
      announcements: rows.map((row) => ({ ...row, state: announcementState(row, at) })),
      total: Number(rows[0]?.totalCount || 0),
      limit,
      offset,
    };
  }

  /** The banners one user should see: live, inside the window, and not already dismissed. */
  async function activeFor(userId) {
    const { rows } = await pool.query(
      `SELECT ${announcementColumns}
       FROM announcements a
       WHERE a.active=TRUE AND (a.starts_at IS NULL OR a.starts_at<=NOW()) AND (a.ends_at IS NULL OR a.ends_at>NOW())
         AND NOT EXISTS (SELECT 1 FROM announcement_dismissals d WHERE d.announcement_id=a.id AND d.user_id=$1)
       ORDER BY CASE a.level WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END,a.created_at DESC
       LIMIT $2`,
      [userId, LIVE_ANNOUNCEMENT_LIMIT],
    );
    return rows.map((row) => ({ ...row, state: announcementState(row, now()) }));
  }

  async function dismiss({ userId, id }) {
    try {
      const result = await pool.query(
        `INSERT INTO announcement_dismissals(user_id,announcement_id,dismissed_at)
         SELECT $1,$2,NOW()
         WHERE EXISTS (SELECT 1 FROM announcements WHERE id=$2)
         ON CONFLICT(user_id,announcement_id) DO NOTHING`,
        [userId, id],
      );
      return { recorded: result.rowCount > 0 };
    } catch (error) {
      log('warn', 'Announcement dismissal could not be recorded', { code: error.code || 'DISMISSAL_FAILED' });
      return { recorded: false };
    }
  }

  return { publish, update, retire, list, activeFor, dismiss };
}
