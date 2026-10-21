import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AUDIT_ACTIONS,
  auditFilterSql,
  buildAuditEntry,
  createAuditLogger,
  normalizeAuditQuery,
  sanitizeAuditMetadata,
} from '../services/audit.js';

const ACTOR = { actorId: '11111111-1111-4111-8111-111111111111', actorEmail: 'Admin@Example.com ' };

test('an audit entry records the action, the admin email as it was, and the timestamp', () => {
  const entry = buildAuditEntry({
    ...ACTOR,
    action: 'promo_code.create',
    targetType: 'Promo_Code',
    targetId: 'promo-9',
    summary: 'Created promo code   SPRING25\n with 25% off.',
    metadata: { code: 'SPRING25', discountValue: 25 },
  }, { now: () => new Date('2026-03-04T05:06:07.000Z') });
  assert.deepEqual(entry, {
    actorId: '11111111-1111-4111-8111-111111111111',
    actorEmail: 'admin@example.com',
    action: 'promo_code.create',
    targetType: 'promo_code',
    targetId: 'promo-9',
    summary: 'Created promo code SPRING25 with 25% off.',
    metadata: { code: 'SPRING25', discountValue: 25 },
    createdAt: new Date('2026-03-04T05:06:07.000Z'),
  });
});

test('an unknown audit action is rejected instead of inventing a new key', () => {
  assert.throws(() => buildAuditEntry({ ...ACTOR, action: 'user.teleported', summary: 'x' }), /Unknown audit action/);
  assert.throws(() => buildAuditEntry({ ...ACTOR, summary: 'x' }), /needs the action/);
  for (const action of Object.keys(AUDIT_ACTIONS)) {
    assert.equal(buildAuditEntry({ ...ACTOR, action }).summary, AUDIT_ACTIONS[action]);
  }
});

test('a missing actor email is reported but never loses the entry', () => {
  const warnings = [];
  const entry = buildAuditEntry({ action: 'pricing.update', summary: 'Changed Pro price', metadata: {} }, {
    onWarning: (message, extra) => warnings.push({ message, extra }),
  });
  assert.equal(entry.actorEmail, 'unknown');
  assert.equal(entry.actorId, null);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].message, /without an actor email/);
});

test('a non-uuid actor id is dropped rather than passed to a uuid column', () => {
  const warnings = [];
  const entry = buildAuditEntry({ actorId: "' OR 1=1 --", actorEmail: 'admin@example.com', action: 'user.update', summary: 'x' }, {
    onWarning: (message, extra) => warnings.push({ message, extra }),
  });
  assert.equal(entry.actorId, null);
  assert.deepEqual(warnings, [{ message: 'audit entry actor id was not a uuid and was dropped', extra: { action: 'user.update' } }]);
});

test('metadata is capped, flattened, and emptied of anything credential-shaped', () => {
  const longValue = 'x'.repeat(600);
  const metadata = sanitizeAuditMetadata({
    authorization: 'Bearer super-secret',
    accessToken: 'abc.def',
    password: 'hunter2',
    'api-key': 'key-1',
    note: 'reset the password=abc123 for the customer',
    longValue,
    nested: { deeper: true },
    list: ['a', 1, false, { bad: true }],
    amountMinor: 5000,
    empty: '',
  });
  assert.deepEqual(Object.keys(metadata), ['note', 'longValue', 'list', 'amountMinor']);
  assert.equal(metadata.note, 'reset the password=[redacted] for the customer');
  assert.equal(metadata.longValue.length, 200);
  assert.deepEqual(metadata.list, ['a', 1, false]);
  assert.equal(metadata.amountMinor, 5000);
  assert.equal('empty' in metadata, false);
  const capped = sanitizeAuditMetadata(Object.fromEntries(Array.from({ length: 60 }, (_v, i) => [`key${i}`, i])));
  assert.equal(Object.keys(capped).length, 24);
});

test('the audit listing builds one filter for action and search with escaped wildcards', () => {
  assert.equal(auditFilterSql({ action: null, search: null }).text, '');
  const filtered = auditFilterSql({ action: 'user.suspend', search: '100%_off' });
  assert.equal(filtered.text, " WHERE action=$1 AND (actor_email ILIKE $2 OR summary ILIKE $2 OR target_id ILIKE $2)");
  assert.deepEqual(filtered.params, ['user.suspend', '%100\\%\\_off%']);
});

test('audit queries are bounded before they reach the database', () => {
  assert.deepEqual(normalizeAuditQuery({}), { action: null, search: null, limit: 50, offset: 0 });
  assert.deepEqual(normalizeAuditQuery({ action: 'pricing.update', search: ' ab ', limit: '10', offset: '20' }), { action: 'pricing.update', search: 'ab', limit: 10, offset: 20 });
  assert.throws(() => normalizeAuditQuery({ limit: 500 }), /1-200/);
  assert.throws(() => normalizeAuditQuery({ limit: 0 }), /1-200/);
  assert.throws(() => normalizeAuditQuery({ offset: -1 }), /page is not available/);
  assert.throws(() => normalizeAuditQuery({ action: 'user.teleported' }), /cannot be filtered/);
  assert.throws(() => normalizeAuditQuery({ search: 'a' }), /at least two characters/);
});

function recordingPool(handlers = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params = []) {
      calls.push({ sql, params });
      const handler = Object.entries(handlers).find(([match]) => sql.includes(match));
      if (handler) return handler[1](sql, params);
      return { rows: [], rowCount: 0 };
    },
  };
}

test('record writes one append-only row and returns it', async () => {
  const pool = recordingPool({
    'INSERT INTO admin_audit_logs': () => ({ rows: [{ id: 'audit-1', createdAt: '2026-01-01T00:00:00.000Z' }] }),
  });
  const audit = createAuditLogger({ pool });
  const row = await audit.record({ ...ACTOR, action: 'user.suspend', targetType: 'user', targetId: 'user-9', summary: 'Suspended user-9', metadata: { reason: 'chargeback' } });
  assert.deepEqual(row, { id: 'audit-1', createdAt: '2026-01-01T00:00:00.000Z' });
  const { sql, params } = pool.calls[0];
  assert.match(sql, /INSERT INTO admin_audit_logs\(actor_id,actor_email,action,target_type,target_id,summary,metadata,created_at\)/);
  assert.ok(!/UPDATE |DELETE FROM admin_audit_logs/.test(sql), 'the trail is append-only');
  assert.deepEqual(params, ['11111111-1111-4111-8111-111111111111', 'admin@example.com', 'user.suspend', 'user', 'user-9', 'Suspended user-9', JSON.stringify({ reason: 'chargeback' }), params[7]]);
  assert.ok(params[7] instanceof Date);
});

test('an audit write failure never turns a successful admin action into an error', async () => {
  const logged = [];
  const logger = { error: (message, extra) => logged.push({ level: 'error', message, extra }) };
  const audit = createAuditLogger({ pool: { async query() { throw Object.assign(new Error('db down'), { code: '57P01' }); } }, logger });
  assert.equal(await audit.record({ ...ACTOR, action: 'pricing.update', summary: 'Changed price' }), null);
  assert.equal(logged.length, 1);
  assert.equal(logged[0].message, 'Audit entry could not be written');
  assert.equal(logged[0].extra.code, '57P01');
});

test('a malformed entry is dropped loudly instead of throwing into the route', async () => {
  const logged = [];
  const audit = createAuditLogger({ pool: recordingPool({}), logger: { error: (message, extra) => logged.push({ message, extra }) } });
  assert.equal(await audit.record({ ...ACTOR, action: 'not.a.real.action', summary: 'x' }), null);
  assert.deepEqual(logged, [{ message: 'Audit entry could not be built', extra: { code: 'VALIDATION_ERROR', action: 'not.a.real.action' } }]);
});

test('the audit listing pages with a total and never trusts the browser filter', async () => {
  const pool = recordingPool({
    'FROM admin_audit_logs': () => ({ rows: [{ id: 'a1', action: 'user.suspend', summary: 'Suspended', metadata: { reason: 'x' }, totalCount: 7, totalEntries: 400 }] }),
  });
  const audit = createAuditLogger({ pool });
  const page = await audit.list({ action: 'user.suspend', limit: 1, offset: 3 });
  assert.equal(page.total, 7);
  assert.equal(page.totalEntries, 400);
  assert.equal(page.entries[0].action, 'user.suspend');
  assert.equal(page.entries[0].metadata.reason, 'x');
  assert.equal(page.actions.length, Object.keys(AUDIT_ACTIONS).length);
  const { sql, params } = pool.calls[0];
  assert.match(sql, /COUNT\(\*\) OVER\(\)::int AS "totalCount"/);
  assert.match(sql, /ORDER BY created_at DESC LIMIT \$2 OFFSET \$3/);
  assert.deepEqual(params, ['user.suspend', 1, 3]);
});
