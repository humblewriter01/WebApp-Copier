import test from 'node:test';
import assert from 'node:assert/strict';
import {
  announcementIsLive,
  announcementState,
  createAnnouncementService,
  normalizeAnnouncementDraft,
  normalizeAnnouncementListQuery,
} from '../services/announcements.js';

const NOW = new Date('2026-03-04T05:00:00.000Z');
const FUTURE = '2026-03-05T02:00:00.000Z';

function fakePool(script = {}) {
  const calls = [];
  const order = [
    ['INSERT INTO announcements', 'publish'],
    ['SET active=FALSE', 'retire'],
    ['UPDATE announcements SET', 'update'],
    ['COUNT(*) OVER()', 'list'],
    ['announcement_dismissals d WHERE d.announcement_id=a.id AND d.user_id', 'activeFor'],
    ['INSERT INTO announcement_dismissals', 'dismiss'],
  ];
  return {
    calls,
    async query(sql, params = []) {
      calls.push({ sql, params });
      const key = order.find(([match]) => sql.includes(match))?.[1];
      const handler = key ? script[key] : undefined;
      if (handler instanceof Error) throw handler;
      if (typeof handler === 'function') return handler(sql, params);
      if (handler) return handler;
      return { rows: [], rowCount: 0 };
    },
  };
}

test('an announcement draft is trimmed, capped, and checked against the clock', () => {
  const draft = normalizeAnnouncementDraft({
    message: '  Scheduled   maintenance on Sunday at 2 AM \n ',
    level: ' WARNING ',
    startsAt: FUTURE,
    endsAt: new Date(NOW.getTime() + 48 * 3600_000).toISOString(),
  }, { now: NOW });
  assert.equal(draft.message, 'Scheduled maintenance on Sunday at 2 AM');
  assert.equal(draft.level, 'warning');
  assert.equal(draft.active, true);
  assert.equal(draft.startsAt, FUTURE);
  assert.equal(draft.endsAt.slice(0, 10), '2026-03-06');

  const minimal = normalizeAnnouncementDraft({ message: 'Back soon' }, { now: NOW });
  assert.deepEqual(minimal, { message: 'Back soon', level: 'info', active: true, startsAt: null, endsAt: null });

  assert.throws(() => normalizeAnnouncementDraft({ message: '   ' }, { now: NOW }), /at least 4 characters/);
  assert.equal(normalizeAnnouncementDraft({ message: 'x'.repeat(600) }, { now: NOW }).message.length, 500, 'too long is truncated to what the column can hold');
  assert.throws(() => normalizeAnnouncementDraft({ message: 'fine', level: 'urgent' }, { now: NOW }), /info, warning, or critical/);
  assert.throws(() => normalizeAnnouncementDraft({ message: 'fine', startsAt: 'yesterday' }, { now: NOW }), /not a readable date/);
  assert.throws(() => normalizeAnnouncementDraft({ message: 'fine', endsAt: '2026-03-04T04:00:00.000Z' }, { now: NOW }), /already passed/);
  assert.throws(() => normalizeAnnouncementDraft({ message: 'fine', startsAt: '2026-03-06T00:00:00.000Z', endsAt: '2026-03-05T00:00:00.000Z' }, { now: NOW }), /after its start time/);
  assert.throws(() => normalizeAnnouncementDraft({ message: 'fine', active: 'yes' }, { now: NOW }), /whether the announcement is live/);
});

test('a patch draft only carries what the administrator actually sent', () => {
  const patch = normalizeAnnouncementDraft({ message: 'Maintenance moved to 3 AM' }, { partial: true, now: NOW });
  assert.deepEqual(patch, { message: 'Maintenance moved to 3 AM', level: undefined, active: undefined, startsAt: undefined, endsAt: undefined });
  assert.deepEqual(normalizeAnnouncementDraft({ active: false }, { partial: true, now: NOW }), { message: undefined, level: undefined, active: false, startsAt: undefined, endsAt: undefined });
  // A start in the recent past is normal for "publish it now"; an end in the past is a mistake.
  assert.equal(normalizeAnnouncementDraft({ startsAt: new Date(NOW.getTime() - 5 * 60_000).toISOString() }, { partial: true, now: NOW }).startsAt, new Date(NOW.getTime() - 5 * 60_000).toISOString());
});

test('announcement listing filters are validated before they reach SQL', () => {
  assert.deepEqual(normalizeAnnouncementListQuery({}), { limit: 25, offset: 0, status: 'all' });
  assert.deepEqual(normalizeAnnouncementListQuery({ limit: '10', offset: '20', status: ' LIVE ' }), { limit: 10, offset: 20, status: 'live' });
  assert.throws(() => normalizeAnnouncementListQuery({ limit: 500 }), /1-100/);
  assert.throws(() => normalizeAnnouncementListQuery({ status: 'archived' }), /filter is not available/);
});

test('live means active and inside the window, decided in one place', () => {
  const at = NOW;
  assert.equal(announcementIsLive({ active: true }, at), true);
  assert.equal(announcementIsLive({ active: false }, at), false);
  assert.equal(announcementIsLive({ active: true, startsAt: '2026-03-04T05:00:00.000Z' }, at), true, 'a banner starting now is on screen now');
  assert.equal(announcementIsLive({ active: true, startsAt: FUTURE }, at), false);
  assert.equal(announcementIsLive({ active: true, endsAt: '2026-03-04T05:00:00.000Z' }, at), false, 'the end instant is exclusive');
  assert.equal(announcementState(null, at), 'unknown');
  assert.equal(announcementState({ active: true }, at), 'live');
  assert.equal(announcementState({ active: true, startsAt: FUTURE }, at), 'scheduled');
  assert.equal(announcementState({ active: true, endsAt: '2026-03-01T00:00:00.000Z' }, at), 'ended');
  assert.equal(announcementState({ active: false }, at), 'retired');
});

test('publishing stores the draft and reports the state it landed in', async () => {
  const logged = [];
  const pool = fakePool({ publish: { rows: [{ id: 'ann-1', message: 'Scheduled maintenance', level: 'warning', active: true, startsAt: null, endsAt: null, state: undefined }] } });
  const service = createAnnouncementService({ pool, logger: { info: (message, extra) => logged.push({ message, extra }) }, now: () => NOW });
  const announcement = await service.publish({ draft: { message: 'Scheduled maintenance', level: 'warning', active: true, startsAt: null, endsAt: null }, actorId: 'admin-1' });
  assert.equal(announcement.state, 'live');
  assert.equal(announcement.dismissalCount, 0);
  const { sql, params } = pool.calls[0];
  assert.match(sql, /INSERT INTO announcements\(message,level,active,starts_at,ends_at,created_by,created_at,updated_at\)/);
  assert.deepEqual(params, ['Scheduled maintenance', 'warning', true, null, null, 'admin-1']);
  assert.deepEqual(logged, [{ message: 'Announcement published', extra: { id: 'ann-1', level: 'warning', active: true, actorId: 'admin-1' } }]);
});

test('an edit writes only the columns that changed, and an empty edit writes nothing', async () => {
  const pool = fakePool({ update: { rows: [{ id: 'ann-1', message: 'Maintenance moved to 3 AM', active: true }] } });
  const service = createAnnouncementService({ pool, logger: { info: () => {} }, now: () => NOW });
  const row = await service.update({ id: 'ann-1', draft: { message: 'Maintenance moved to 3 AM', level: undefined, active: undefined, startsAt: null, endsAt: undefined } });
  assert.equal(row.message, 'Maintenance moved to 3 AM');
  // an explicit null clears a column; only `undefined` means "leave it alone"
  assert.ok(
    pool.calls[0].sql.includes('UPDATE announcements SET message=$1,starts_at=$2,updated_at=NOW() WHERE id=$3 RETURNING'),
    pool.calls[0].sql,
  );
  assert.deepEqual(pool.calls[0].params, ['Maintenance moved to 3 AM', null, 'ann-1']);
  assert.equal(await service.update({ id: 'ann-1', draft: { message: undefined, level: undefined, active: undefined, startsAt: undefined, endsAt: undefined } }), null);
  assert.equal(pool.calls.length, 1, 'nothing to change is not a database write');
});

test('retiring is a soft close, and twice is a miss the route can report as 404', async () => {
  const pool = fakePool({ retire: { rows: [] } });
  const logged = [];
  const service = createAnnouncementService({ pool, logger: { warn: (message, extra) => logged.push({ message, extra }) }, now: () => NOW });
  assert.equal(await service.retire({ id: 'ann-9' }), null);
  assert.match(pool.calls[0].sql, /SET active=FALSE,updated_at=NOW\(\) WHERE id=\$1 AND active=TRUE/);
  assert.deepEqual(logged, [{ message: 'Announcement retired', extra: { id: 'ann-9', retired: false } }]);
});

test('the admin listing counts dismissals per announcement and pages with a total', async () => {
  const pool = fakePool({ list: { rows: [{ id: 'ann-1', message: 'hi', active: true, startsAt: null, endsAt: null, createdBy: 'admin-1', createdByEmail: 'ops@example.com', dismissalCount: 3, totalCount: 7 }] } });
  const service = createAnnouncementService({ pool, now: () => NOW });
  const page = await service.list({ limit: 1, offset: 4, status: 'live' });
  assert.equal(page.total, 7);
  assert.equal(page.announcements[0].dismissalCount, 3);
  assert.equal(page.announcements[0].state, 'live');
  const { sql, params } = pool.calls[0];
  assert.match(sql, /\(SELECT COUNT\(\*\)::int FROM announcement_dismissals d WHERE d\.announcement_id=a\.id\) AS "dismissalCount"/);
  assert.match(sql, /a\.active=TRUE AND \(a\.starts_at IS NULL OR a\.starts_at<=\$1\) AND \(a\.ends_at IS NULL OR a\.ends_at>\$1\)/);
  assert.match(sql, /LIMIT \$2 OFFSET \$3/);
  assert.deepEqual(params, [NOW, 1, 4], 'one date parameter feeds both window bounds, then the page');
});

test('a user only receives live announcements they have not dismissed, critical first', async () => {
  const pool = fakePool({
    activeFor: {
      rows: [
        { id: 'ann-2', message: 'Broker incident', level: 'critical', active: true, startsAt: null, endsAt: null },
        { id: 'ann-1', message: 'Maintenance Sunday', level: 'info', active: true, startsAt: null, endsAt: null },
      ],
    },
  });
  const service = createAnnouncementService({ pool, now: () => NOW });
  const banners = await service.activeFor('user-1');
  assert.deepEqual(banners.map((row) => row.level), ['critical', 'info']);
  assert.deepEqual(banners.map((row) => row.state), ['live', 'live']);
  const { sql, params } = pool.calls[0];
  assert.match(sql, /NOT EXISTS \(SELECT 1 FROM announcement_dismissals d WHERE d\.announcement_id=a\.id AND d\.user_id=\$1\)/);
  assert.match(sql, /ORDER BY CASE a\.level WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END,a\.created_at DESC/);
  assert.match(sql, /LIMIT \$2/);
  assert.deepEqual(params, ['user-1', 3]);
});

test('dismissing is recorded once per user and never fails the request', async () => {
  const pool = fakePool({ dismiss: { rowCount: 1 } });
  const service = createAnnouncementService({ pool, now: () => NOW });
  assert.deepEqual(await service.dismiss({ userId: 'user-1', id: 'ann-1' }), { recorded: true });
  const { sql, params } = pool.calls[0];
  assert.match(sql, /INSERT INTO announcement_dismissals\(user_id,announcement_id,dismissed_at\)/);
  assert.match(sql, /WHERE EXISTS \(SELECT 1 FROM announcements WHERE id=\$2\)/, 'a made-up id cannot grow the table');
  assert.match(sql, /ON CONFLICT\(user_id,announcement_id\) DO NOTHING/);
  assert.deepEqual(params, ['user-1', 'ann-1']);

  const broken = createAnnouncementService({ pool: { async query() { throw new Error('dead'); } }, logger: { warn: () => {} }, now: () => NOW });
  assert.deepEqual(await broken.dismiss({ userId: 'user-1', id: 'ann-1' }), { recorded: false });
});

/* A write statement has no alias to qualify with - `INSERT` cannot name its target at all - so the
   read alias belongs to the reads only. Every announcement write used to return `a.id,a.message,…`
   and Postgres refused the whole action with `missing FROM-clause entry for table "a"`, which reached
   the panel as an unexplained failure of Publish, Edit, and Retire alike. */
test('an announcement write reads its row back without borrowing the read alias', async () => {
  const row = { rows: [{ id: 'ann-1', message: 'Maintenance', level: 'info', active: true }], rowCount: 1 };
  const pool = fakePool({ publish: row, update: row, retire: row });
  const service = createAnnouncementService({ pool, logger: { info: () => {}, warn: () => {} }, now: () => NOW });

  await service.publish({ draft: { message: 'Maintenance', level: 'info', active: true, startsAt: null, endsAt: null }, actorId: 'admin-1' });
  await service.update({ id: 'ann-1', draft: { message: 'Maintenance moved to 3 AM' } });
  await service.retire({ id: 'ann-1' });

  assert.equal(pool.calls.length, 3);
  for (const { sql } of pool.calls) {
    const at = sql.indexOf('RETURNING');
    assert.notEqual(at, -1, `a write returns the stored row: ${sql}`);
    const returning = sql.slice(at);
    assert.equal(/\ba\.\w/.test(returning), false, `RETURNING must not use the read alias: ${returning}`);
    assert.match(returning, /starts_at AS "startsAt"/, 'the camelCase shape the panel reads is unchanged');
    assert.match(returning, /updated_at AS "updatedAt"/);
  }

  // The reads keep their qualifier, because they join the table under it.
  await service.list({ limit: 25, offset: 0, status: 'live' });
  assert.match(pool.calls.at(-1).sql, /SELECT a\.id,a\.message/);
  assert.match(pool.calls.at(-1).sql, /FROM announcements a/);
});
