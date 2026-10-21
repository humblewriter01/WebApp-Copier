import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  buildSupportClaims,
  createSupportSessionService,
  normalizeSupportReason,
  sessionIsLive,
  SUPPORT_SESSION_HOURS,
  SUPPORT_SESSION_RETENTION_DAYS,
  supportTokenHash,
} from '../services/support-sessions.js';

const ADMIN = '11111111-1111-4111-8111-111111111111';
const TARGET = '22222222-2222-4222-8222-222222222222';
const NOW = new Date('2026-03-04T05:00:00.000Z');

function fakePool(script = {}) {
  const calls = [];
  const order = [
    ['INSERT INTO support_sessions', 'start'],
    ['FROM support_sessions WHERE token_hash', 'redeem'],
    ['WHERE id=$1 AND revoked_at IS NULL', 'stop'],
    ['WHERE user_id=$1 AND revoked_at IS NULL', 'revokeForUser'],
    ['FROM support_sessions s', 'list'],
    ['DELETE FROM support_sessions', 'prune'],
  ];
  return {
    calls,
    async query(sql, params = []) {
      calls.push({ sql, params });
      const key = order.find(([match]) => sql.includes(match))?.[1];
      const handler = key ? script[key] : undefined;
      if (handler instanceof Error) throw handler;
      if (typeof handler === 'function') return handler(sql, params);
      return handler || { rows: [], rowCount: 0 };
    },
  };
}

test('a support session is one hour long and the token itself is never stored', async () => {
  const logged = [];
  const pool = fakePool({ start: { rows: [{ id: 'session-1', expiresAt: new Date(NOW.getTime() + 3600_000), createdAt: NOW }] } });
  const service = createSupportSessionService({ pool, now: () => NOW, randomId: () => 'jti-abc', logger: { warn: (message, extra) => logged.push({ message, extra }) } });
  const session = await service.start({ adminId: ADMIN, userId: TARGET, reason: 'Investigating a missing signal' });
  assert.deepEqual(session, { sessionId: 'session-1', jti: 'jti-abc', expiresAt: new Date(NOW.getTime() + 3600_000).toISOString(), ttlMinutes: 60 });
  const { sql, params } = pool.calls[0];
  assert.match(sql, /INSERT INTO support_sessions\(token_hash,admin_id,user_id,reason,created_at,expires_at\)/);
  assert.deepEqual(params.slice(0, 4), [supportTokenHash('jti-abc'), ADMIN, TARGET, 'Investigating a missing signal']);
  assert.equal(params[0], crypto.createHash('sha256').update('jti-abc').digest('hex'));
  assert.equal(JSON.stringify(params).includes('jti-abc'), false, 'the redeemable value never reaches the table');
  assert.equal(new Date(params[4]).getTime() - NOW.getTime(), 3600_000);
  assert.deepEqual(logged, [{ message: 'Support session opened', extra: { sessionId: 'session-1', adminId: ADMIN, userId: TARGET, ttlMinutes: 60 } }]);
});

test('the lifetime cannot be stretched past an hour by configuration', async () => {
  const pool = fakePool({ start: { rows: [{ id: 'session-1', expiresAt: NOW, createdAt: NOW }] } });
  assert.equal(createSupportSessionService({ pool, hours: 24 }).ttlMinutes, 60);
  assert.equal(createSupportSessionService({ pool }).ttlMinutes, SUPPORT_SESSION_HOURS * 60);
  assert.equal(createSupportSessionService({ pool, hours: 0.25 }).ttlMinutes, 15);
  assert.equal(createSupportSessionService({ pool, hours: 0 }).ttlMinutes, 60, 'nonsense falls back to the documented hour');
});

test('a support session needs an administrator and an account, and a reason that means something', () => {
  assert.throws(() => normalizeSupportReason(''), /Say why you need support access/);
  assert.throws(() => normalizeSupportReason('  ok '), /Say why you need support access/);
  assert.equal(normalizeSupportReason('  Chargeback   dispute \n with the gateway  '), 'Chargeback dispute with the gateway');
  assert.equal(normalizeSupportReason('x'.repeat(300)).length, 200);
});

test('only the live unrevoked session redeems, and a broken read is a refusal', async () => {
  const live = { id: 'session-1', adminId: ADMIN, userId: TARGET, reason: 'Investigation', revokedAt: null, createdAt: NOW, expiresAt: new Date(NOW.getTime() + 60_000) };
  const service = createSupportSessionService({ pool: fakePool({ redeem: { rows: [live] } }), now: () => NOW });
  assert.deepEqual(await service.redeem('jti-abc'), live);

  const expired = { ...live, expiresAt: new Date(NOW.getTime() - 1) };
  assert.equal(await createSupportSessionService({ pool: fakePool({ redeem: { rows: [expired] } }), now: () => NOW }).redeem('jti'), null);
  const revoked = { ...live, revokedAt: NOW };
  assert.equal(await createSupportSessionService({ pool: fakePool({ redeem: { rows: [revoked] } }), now: () => NOW }).redeem('jti'), null);
  assert.equal(await createSupportSessionService({ pool: fakePool({ redeem: { rows: [] } }), now: () => NOW }).redeem('jti'), null);
  assert.equal(await createSupportSessionService({ pool: fakePool({ redeem: new Error('dead') }), logger: { error: () => {} }, now: () => NOW }).redeem('jti'), null, 'a failing lookup cannot be a way in');
  assert.equal(await createSupportSessionService({ pool: fakePool({}), now: () => NOW }).redeem(undefined), null);
});

test('revoking closes the session once and only for its own administrator', async () => {
  const pool = fakePool({ stop: { rows: [{ id: 'session-1', revokedAt: NOW }] } });
  const service = createSupportSessionService({ pool, logger: { warn: () => {} }, now: () => NOW });
  assert.deepEqual(await service.stop({ sessionId: 'session-1', adminId: ADMIN }), { revoked: true, sessionId: 'session-1' });
  const { sql, params } = pool.calls.filter((call) => call.sql.includes('UPDATE support_sessions'))[0];
  assert.match(sql, /UPDATE support_sessions SET revoked_at=NOW\(\)/);
  assert.match(sql, /WHERE id=\$1 AND revoked_at IS NULL AND admin_id=\$2/, 'another admin cannot close a session they did not open');
  assert.deepEqual(params, ['session-1', ADMIN]);
  assert.equal(sql.includes('RETURNING'), true);

  const idle = createSupportSessionService({ pool: fakePool({}), logger: { warn: () => {} }, now: () => NOW });
  assert.deepEqual(await idle.stop({ sessionId: 'session-9' }), { revoked: false, sessionId: 'session-9' });
});

test('suspending an account also closes anyone looking at it through support', async () => {
  const pool = fakePool({ revokeForUser: { rowCount: 2 } });
  const service = createSupportSessionService({ pool, now: () => NOW });
  assert.deepEqual(await service.revokeForUser(TARGET), { revoked: 2 });
  const { sql, params } = pool.calls[0];
  assert.match(sql, /UPDATE support_sessions SET revoked_at=NOW\(\) WHERE user_id=\$1 AND revoked_at IS NULL/);
  assert.deepEqual(params, [TARGET]);
});

test('the support list says what is still open and prunes rows nobody will need', async () => {
  const rows = [
    { id: 'session-1', reason: 'Chargeback dispute', createdAt: NOW, expiresAt: new Date(NOW.getTime() + 900_000), revokedAt: null, adminEmail: 'ops@example.com', userEmail: 'trader@example.com', userName: 'Trader', totalCount: 2 },
    { id: 'session-2', reason: 'Old check', createdAt: NOW, expiresAt: new Date(NOW.getTime() + 900_000), revokedAt: NOW, adminEmail: 'ops@example.com', userEmail: 'other@example.com', userName: 'Other', totalCount: 2 },
  ];
  const pool = fakePool({ list: { rows }, prune: { rowCount: 3 } });
  const service = createSupportSessionService({ pool, now: () => NOW });
  const page = await service.list({ limit: 5, offset: 0 });
  assert.equal(page.total, 2);
  assert.equal(page.liveCount, 1, 'a revoked row stays visible for audit but is not live');
  assert.equal(page.sessions[0].live, true);
  assert.equal(page.sessions[0].secondsLeft, 900);
  assert.equal(page.sessions[1].live, false);
  assert.equal(page.sessions[1].secondsLeft, 0);
  const prune = pool.calls.find((call) => call.sql.includes('DELETE FROM support_sessions'));
  assert.match(prune.sql, /DELETE FROM support_sessions WHERE expires_at < NOW\(\) - \(\$1::int \* INTERVAL '1 day'\)/);
  assert.deepEqual(prune.params, [SUPPORT_SESSION_RETENTION_DAYS]);
});

test('the claims name the admin inside the token, so an audit can always reconstruct who acted', () => {
  const claims = buildSupportClaims({ sessionId: 'session-1', jti: 'jti-abc', adminId: ADMIN, adminEmail: 'ops@example.com', userId: TARGET, userEmail: 'trader@example.com' });
  assert.deepEqual(claims, {
    sub: TARGET, email: 'trader@example.com', act: ADMIN, actEmail: 'ops@example.com',
    jti: 'jti-abc', sid: 'session-1', purpose: 'impersonation',
  });
  assert.equal(claims.purpose, 'impersonation', 'the purpose claim is what the server blocks admin routes and writes on');
});

test('liveness is one rule, shared by redemption and the list', () => {
  assert.equal(sessionIsLive(null, NOW), false);
  assert.equal(sessionIsLive({ expiresAt: new Date(NOW.getTime() + 1), revokedAt: null }, NOW), true);
  assert.equal(sessionIsLive({ expiresAt: new Date(NOW.getTime() + 1), revokedAt: NOW }, NOW), false);
  assert.equal(sessionIsLive({ expiresAt: NOW, revokedAt: null }, NOW), false, 'the expiry instant itself is already closed');
  assert.equal(sessionIsLive({ expiresAt: 'nonsense' }, NOW), false);
});
