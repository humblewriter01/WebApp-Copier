import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createInactivityService,
  daysInactiveSince,
  inactivityDecision,
  warningText,
  isAdmin,
  INACTIVITY_WARNING_DAYS,
  INACTIVITY_DELETION_DAYS,
  INACTIVITY_RETRY_HOURS,
  INACTIVITY_MAX_ATTEMPTS,
  DAY_MS,
} from '../services/inactivity.js';

const NOW = Date.parse('2026-06-15T12:00:00.000Z');
const daysAgo = (days) => new Date(NOW - days * DAY_MS);
const now = () => NOW;
const silentLogger = { info() {}, warn() {}, error() {} };

/** Rows are read from the sweep; the fake answers each statement the service uses. */
function fakeDb({ candidates = [], user = null, notices = [] } = {}) {
  const calls = [];
  const db = {
    calls,
    rows: { deleted: [], notices: [], accountUpdates: [], settingUpdates: [], userUpdates: [] },
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes('FROM metaapi_accounts ma') && sql.includes('JOIN users u')) return { rows: candidates, rowCount: candidates.length };
      if (sql.includes('INSERT INTO account_activity_notices')) { db.rows.notices.push({ params }); return { rows: [], rowCount: 1 }; }
      if (sql.includes('UPDATE metaapi_accounts')) { db.rows.accountUpdates.push({ params }); return { rows: [], rowCount: 1 }; }
      if (sql.includes('DELETE FROM metaapi_accounts')) { db.rows.deleted.push({ params }); return { rows: [], rowCount: 1 }; }
      if (sql.includes('UPDATE settings SET auto_trading_enabled=FALSE')) { db.rows.settingUpdates.push({ params }); return { rows: [], rowCount: 1 }; }
      if (sql.includes('UPDATE users SET last_active_at=NOW()')) { db.rows.userUpdates.push({ params }); return { rows: [], rowCount: 1 }; }
      if (sql.includes('FROM users WHERE id=$1')) return { rows: user ? [user] : [], rowCount: user ? 1 : 0 };
      if (sql.includes('FROM account_activity_notices')) return { rows: notices, rowCount: notices.length };
      return { rows: [], rowCount: 0 };
    },
  };
  return db;
}

function fakeCleanup({ fail = false, alreadyMissing = false } = {}) {
  const calls = [];
  return {
    calls,
    async removeProviderAccounts({ accounts }) {
      calls.push(accounts.map((account) => account.metaapi_account_id));
      if (fail) return { total: accounts.length, attempted: 1, deleted: 0, alreadyMissing: 0, failed: 1, skipped: 0, failures: [{ accountId: accounts[0].metaapi_account_id, status: 503, code: 'UPSTREAM' }] };
      return { total: accounts.length, attempted: 1, deleted: alreadyMissing ? 0 : 1, alreadyMissing: alreadyMissing ? 1 : 0, failed: 0, skipped: 0, failures: [] };
    },
  };
}

function fakeTrading(state) {
  const calls = [];
  return {
    calls,
    async getAccountState(input) {
      calls.push(input);
      if (state instanceof Error) throw state;
      return state;
    },
  };
}

const account = (overrides = {}) => ({
  account_row_id: 'row-1',
  user_id: 'user-1',
  metaapi_account_id: 'acct-1',
  name: 'My MT5',
  login: '7001',
  platform: 'mt5',
  state: 'DEPLOYED',
  inactivity_status: 'none',
  inactivity_for: null,
  inactivity_checked_at: null,
  inactivity_reason: null,
  inactivity_attempts: 0,
  email: 'trader@example.com',
  user_name: 'Trader',
  subscription_status: 'free',
  subscription_plan: 'free',
  is_suspended: false,
  last_active_at: daysAgo(INACTIVITY_DELETION_DAYS),
  ...overrides,
});

const openPositions = { positions: [{ id: '1' }], orders: [] };
const idleState = { positions: [], orders: [] };

function service({ db, cleanup = fakeCleanup(), trading = fakeTrading(idleState), options = {} } = {}) {
  return createInactivityService({
    pool: db,
    trading,
    accountCleanup: cleanup,
    resolveToken: async () => 'provisioning-token',
    now,
    logger: silentLogger,
    ...options,
  });
}

test('the clock is measured in whole days and never goes negative', () => {
  assert.equal(daysInactiveSince(daysAgo(24.9), now()), 24);
  assert.equal(daysInactiveSince(daysAgo(25), now()), INACTIVITY_WARNING_DAYS);
  assert.equal(daysInactiveSince(daysAgo(30), now()), INACTIVITY_DELETION_DAYS);
  assert.equal(daysInactiveSince(new Date(NOW + DAY_MS), now()), 0, 'a clock skew can never produce a negative age');
  assert.equal(daysInactiveSince(null, now()), 0);
  assert.equal(daysInactiveSince('not a date', now()), 0);
});

test('the warning reads as the operator asked, with the days left counted down', () => {
  const message = warningText({ accountName: 'My MT5', daysInactive: 25, now });
  assert.equal(message, 'Your MT4/MT5 account "My MT5" has been inactive for 25 days. To prevent unauthorized access and free up resources, it will be permanently deleted in 5 days. Please log in to keep it active.');
  assert.match(warningText({ accountName: null, daysInactive: 29 }), /deleted in 1 days/);
  assert.match(warningText({ accountName: 'My MT5', daysInactive: 27 }), /inactive for 27 days/);
});

test('day 24 waits, day 25 warns, day 30 deletes', () => {
  assert.equal(inactivityDecision({ daysInactive: 24 }).action, 'skip');
  assert.equal(inactivityDecision({ daysInactive: 25 }).action, 'warn');
  assert.equal(inactivityDecision({ daysInactive: 29 }).action, 'warn');
  assert.equal(inactivityDecision({ daysInactive: 30, positionState: { readable: true, openPositions: 0, pendingOrders: 0 } }).action, 'delete');
  assert.equal(inactivityDecision({ daysInactive: 90, positionState: { readable: true, openPositions: 0, pendingOrders: 0 } }).action, 'delete');
});

test('a paying subscriber and a suspended account are never touched', () => {
  for (const status of ['active', 'non_renewing']) {
    assert.deepEqual(inactivityDecision({ daysInactive: 60, subscribed: true, positionState: { readable: true, openPositions: 0 } }), { action: 'skip', reason: 'active-subscription' }, status);
  }
  assert.deepEqual(inactivityDecision({ daysInactive: 60, suspended: true }), { action: 'skip', reason: 'suspended' });
  // A lapsed or never-paid plan is exactly what the policy is for.
  assert.equal(inactivityDecision({ daysInactive: 60, subscribed: false, suspended: false, positionState: { readable: true, openPositions: 0 } }).action, 'delete');
});

test('an open position or pending order defers deletion, and an unreadable state fails closed', () => {
  const open = inactivityDecision({ daysInactive: 31, positionState: { readable: true, openPositions: 2, pendingOrders: 0 } });
  assert.equal(open.action, 'defer');
  assert.equal(open.reason, 'open-positions');
  assert.equal(open.openPositions, 2);
  const pending = inactivityDecision({ daysInactive: 31, positionState: { readable: true, openPositions: 0, pendingOrders: 1 } });
  assert.equal(pending.reason, 'open-positions', 'a resting limit order is still a live obligation');
  assert.equal(inactivityDecision({ daysInactive: 31, positionState: { readable: false, error: 'timeout' } }).reason, 'position-state-unreadable');
  assert.equal(inactivityDecision({ daysInactive: 31, positionState: null }).action, 'defer');
  // An account MetaAPI reports as undeployed cannot be holding a trade, so there is
  // nothing to read and deletion is safe.
  assert.equal(inactivityDecision({ daysInactive: 31, accountState: 'DELETED', positionState: null }).action, 'delete');
});

test('the warning is sent once per idle spell and re-armed by new activity', () => {
  assert.deepEqual(inactivityDecision({ daysInactive: 26, alreadyWarned: true }), { action: 'skip', reason: 'already-warned' });
  assert.equal(inactivityDecision({ daysInactive: 26, alreadyWarned: false }).action, 'warn');
});

test('repeated provider failures are paced, then reported instead of looping forever', () => {
  assert.deepEqual(inactivityDecision({ daysInactive: 31, retryBlocked: true, positionState: { readable: true, openPositions: 0 } }), { action: 'skip', reason: 'retry-paced' });
  const attempts = INACTIVITY_MAX_ATTEMPTS - 1;
  assert.equal(inactivityDecision({ daysInactive: 31, attempts, positionState: { readable: false } }).action, 'defer');
  assert.equal(inactivityDecision({ daysInactive: 31, attempts: INACTIVITY_MAX_ATTEMPTS, positionState: { readable: false } }).action, 'give-up');
  // A live position is not a failure, so waiting on it is never counted as an attempt.
  assert.equal(inactivityDecision({ daysInactive: 31, attempts: INACTIVITY_MAX_ATTEMPTS, positionState: { readable: true, openPositions: 3 } }).action, 'defer');
  assert.equal(inactivityDecision({ daysInactive: 31, gaveUp: true, positionState: { readable: true, openPositions: 0 } }).reason, 'gave-up');
  assert.equal(INACTIVITY_RETRY_HOURS, 12);
});

test('an admin is never swept, warned, or deleted', () => {
  const exempt = { action: 'skip', reason: 'admin' };
  // Day 25 and day 30 alike, and the exemption outranks every other input, including a
  // position that would only defer the deletion anyway.
  assert.deepEqual(inactivityDecision({ daysInactive: 25, admin: true }), exempt);
  assert.deepEqual(inactivityDecision({ daysInactive: 30, admin: true, positionState: { readable: true, openPositions: 0 } }), exempt);
  assert.deepEqual(inactivityDecision({ daysInactive: 400, admin: true, subscribed: false }), exempt);
  assert.equal(isAdmin({ role: 'admin' }), true);
  assert.equal(isAdmin({ role: 'user' }), false);
  assert.equal(isAdmin({}), false, 'a missing role is never treated as an admin');
});

test('the sweep skips an admin account silently and never touches MetaAPI', async () => {
  const db = fakeDb({ candidates: [account({ role: 'admin' })] });
  const cleanup = fakeCleanup();
  const trading = fakeTrading(openPositions);
  const result = await service({ db, cleanup, trading }).sweepOnce();
  assert.deepEqual({ deleted: result.deleted, warned: result.warned, deferred: result.deferred, skippedAdmin: result.skippedAdmin }, { deleted: 0, warned: 0, deferred: 0, skippedAdmin: 1 });
  assert.equal(cleanup.calls.length, 0);
  assert.equal(trading.calls.length, 0, 'not even a position read for an exempt account');
  assert.equal(db.rows.notices.length, 0);
  assert.equal(db.rows.deleted.length, 0);
  assert.equal(db.rows.accountUpdates.length, 0, 'no bookkeeping written for an account that is exempt');
});

test('the candidate query never lets an exempt user occupy a sweep slot', async () => {
  const db = fakeDb({ candidates: [] });
  await service({ db }).sweepOnce();
  const { sql, params } = db.calls.find(({ sql: text }) => sql2(text));
  function sql2(text) { return text.includes('FROM metaapi_accounts ma'); }
  assert.match(sql, /u\.role <> 'admin'/, 'admins are filtered in SQL as well as in the decision');
  assert.match(sql, /u\.is_suspended = FALSE/);
  assert.match(sql, /NOT \(u\.subscription_status = ANY\(\$2::text\[\]\)\)/);
  assert.deepEqual(params, ['25', ['active', 'non_renewing'], 25]);
});

test('the sweep warns day-25 accounts and records the notice once', async () => {
  const db = fakeDb({ candidates: [account({ last_active_at: daysAgo(25) })] });
  const cleanup = fakeCleanup();
  const result = await service({ db, cleanup }).sweepOnce();
  assert.equal(result.warned, 1);
  assert.equal(result.deleted, 0);
  assert.equal(cleanup.calls.length, 0, 'nothing is deleted before day 30');
  assert.equal(db.rows.deleted.length, 0);
  const [notice] = db.rows.notices;
  assert.deepEqual(notice.params.slice(0, 4), ['user-1', 'acct-1', 'warning', 25]);
  assert.match(notice.params[5], /permanently deleted in 5 days/);
  assert.match(notice.params[5], /Please log in to keep it active/);
  const [update] = db.rows.accountUpdates;
  assert.equal(update.params[1], 'warned', 'the account remembers it was warned');
  assert.equal(update.params[4].toISOString(), daysAgo(25).toISOString(), 'the warning is tied to this activity timestamp');
});

test('an account warned for the current idle spell is not warned twice', async () => {
  const lastActive = daysAgo(27);
  const db = fakeDb({ candidates: [account({ last_active_at: lastActive, inactivity_status: 'warned', inactivity_for: lastActive })] });
  const result = await service({ db }).sweepOnce();
  assert.deepEqual({ warned: result.warned, deleted: result.deleted, skippedOther: result.skippedOther }, { warned: 0, deleted: 0, skippedOther: 1 });
  assert.equal(db.rows.notices.length, 0);
  assert.equal(db.rows.accountUpdates.length, 0);
});

test('a new sign-in re-arms the warning for the next idle spell', async () => {
  const db = fakeDb({ candidates: [account({ last_active_at: daysAgo(26), inactivity_status: 'warned', inactivity_for: daysAgo(40) })] });
  const result = await service({ db }).sweepOnce();
  assert.equal(result.warned, 1, 'activity resets the clock, so a fresh warning is due');
});

test('day 30 with no open positions deletes the broker account and the local links', async () => {
  const db = fakeDb({ candidates: [account()] });
  const cleanup = fakeCleanup();
  const trading = fakeTrading(idleState);
  const result = await service({ db, cleanup, trading }).sweepOnce();
  assert.equal(result.deleted, 1);
  assert.deepEqual(cleanup.calls[0], ['acct-1'], 'the provider delete runs first');
  assert.deepEqual(trading.calls[0], { token: 'provisioning-token', accountId: 'acct-1' }, 'positions are read before anything is destroyed');
  assert.deepEqual(db.rows.deleted[0].params, ['row-1', 'user-1']);
  assert.deepEqual(db.rows.settingUpdates[0].params, ['user-1', 'acct-1'], 'Auto-Trading is switched off for the deleted account');
  const kinds = db.rows.notices.map((notice) => notice.params[2]);
  assert.deepEqual(kinds, ['deleted']);
  assert.match(db.rows.notices[0].params[5], /no longer billed/i);
  assert.match(db.rows.notices[0].params[5], /Auto-Trading was switched off/i);
});

test('an open position defers the deletion, keeps the row, and tells the user once', async () => {
  const db = fakeDb({ candidates: [account()] });
  const cleanup = fakeCleanup();
  const result = await service({ db, cleanup, trading: fakeTrading(openPositions) }).sweepOnce();
  assert.deepEqual({ deleted: result.deleted, deferred: result.deferred }, { deleted: 0, deferred: 1 });
  assert.equal(cleanup.calls.length, 0, 'a position nobody could cancel is never stranded');
  assert.equal(db.rows.deleted.length, 0);
  assert.equal(db.rows.accountUpdates[0].params[1], 'deferred');
  assert.match(db.rows.accountUpdates[0].params[2], /open position/);
  assert.match(db.rows.notices[0].params[5], /Log in to close them or remove the account yourself/);
});

test('the deferral notice is not repeated on every sweep', async () => {
  const db = fakeDb({ candidates: [account({ inactivity_status: 'deferred', inactivity_reason: 'earlier note' })] });
  const result = await service({ db, trading: fakeTrading(openPositions) }).sweepOnce();
  assert.equal(result.deferred, 1);
  assert.equal(db.rows.notices.length, 0, 'the state is refreshed quietly');
  assert.equal(db.rows.accountUpdates[0].params[1], 'deferred');
});

test('a MetaAPI failure keeps the local link, records why, and never throws out of the sweep', async () => {
  const db = fakeDb({ candidates: [account()] });
  const result = await service({ db, cleanup: fakeCleanup({ fail: true }) }).sweepOnce();
  assert.deepEqual({ deleted: result.deleted, failed: result.failed }, { deleted: 0, failed: 1 });
  assert.equal(db.rows.deleted.length, 0, 'deleting locally would orphan a still-billed account with no retry path');
  assert.equal(db.rows.accountUpdates[0].params[1], 'deferred');
  assert.match(db.rows.accountUpdates[0].params[2], /Automatic deletion failed/);
  assert.match(db.rows.notices[0].params[5], /will try again later/);
});

test('an unreadable position state fails closed and an already-missing account is finished locally', async () => {
  const broken = fakeDb({ candidates: [account()] });
  assert.equal(await service({ db: broken, trading: fakeTrading(new Error('gateway timeout')) }).sweepOnce().then((r) => r.deferred), 1);
  assert.equal(broken.rows.deleted.length, 0);

  const missing = fakeDb({ candidates: [account({ state: 'UNDEPLOYED' })] });
  const summary = await service({ db: missing, cleanup: fakeCleanup({ alreadyMissing: true }), trading: fakeTrading(new Error('account not found')) }).sweepOnce();
  assert.deepEqual({ deleted: summary.deleted, failed: summary.failed }, { deleted: 1, failed: 0 }, 'already gone upstream is a success');
  assert.equal(missing.rows.deleted.length, 1);
});

test('subscribers are skipped without a notice, and the account is left alone', async () => {
  const db = fakeDb({ candidates: [account({ subscription_status: 'active' })] });
  const cleanup = fakeCleanup();
  const result = await service({ db, cleanup }).sweepOnce();
  assert.deepEqual({ deleted: result.deleted, warned: result.warned, skippedSubscribed: result.skippedSubscribed }, { deleted: 0, warned: 0, skippedSubscribed: 1 });
  assert.equal(cleanup.calls.length, 0);
  assert.equal(db.rows.notices.length, 0, 'a paying customer is never threatened');
});

test('the sweep survives a broken candidate query and an empty table', async () => {
  const result = await service({ db: { async query() { throw Object.assign(new Error('down'), { code: '57P01' }); } } }).sweepOnce();
  assert.deepEqual(result, { scanned: 0, warned: 0, deferred: 0, deleted: 0, failed: 0, skippedSubscribed: 0, skippedSuspended: 0, skippedAdmin: 0, skippedOther: 0, reason: 'candidates-unavailable' });
  const empty = await service({ db: fakeDb() }).sweepOnce();
  assert.equal(empty.scanned, 0);
});

test('one bad account cannot stop the others in the same sweep', async () => {
  const db = fakeDb({
    candidates: [
      account({ account_row_id: 'row-1', metaapi_account_id: 'acct-bad', name: 'Bad', inactivity_status: 'warned', inactivity_for: daysAgo(30) }),
      account({ account_row_id: 'row-2', metaapi_account_id: 'acct-ok', name: 'Fine', inactivity_status: 'warned', inactivity_for: daysAgo(30) }),
    ],
  });
  const cleanup = {
    async removeProviderAccounts({ accounts }) {
      if (accounts[0].metaapi_account_id === 'acct-bad') throw new Error('provider exploded');
      return { total: 1, attempted: 1, deleted: 1, alreadyMissing: 0, failed: 0, skipped: 0, failures: [] };
    },
  };
  const result = await service({ db, cleanup }).sweepOnce();
  assert.deepEqual({ deleted: result.deleted, failed: result.failed }, { deleted: 1, failed: 1 });
  assert.deepEqual(db.rows.deleted[0].params, ['row-2', 'user-1']);
});

test('activity is recorded on login, settings, and execution paths', async () => {
  const db = fakeDb();
  const inactivity = service({ db });
  await inactivity.touch('user-1');
  assert.deepEqual(db.rows.userUpdates[0].params, ['user-1']);
  assert.match(db.calls.at(-1).sql, /UPDATE users SET last_active_at=NOW\(\) WHERE id=\$1/);

  const failing = { async query() { throw new Error('db down'); } };
  const warnings = [];
  const quiet = createInactivityService({ pool: failing, accountCleanup: fakeCleanup(), logger: { warn: (message) => warnings.push(message) } });
  await quiet.touchQuietly('user-1');
  assert.deepEqual(warnings, ['User activity could not be recorded'], 'a failed activity write must never break a request');
  await assert.rejects(quiet.touch('user-1'), /db down/);
});

test('the Trading Accounts page gets the idle state, exemption, and notices', async () => {
  const inactivity = service({ db: fakeDb({ user: { lastActiveAt: daysAgo(26), subscriptionStatus: 'free' }, notices: [{ kind: 'warning', metaApiAccountId: 'acct-1', daysInactive: 25, accountName: 'My MT5', message: 'warning', createdAt: daysAgo(1) }] }) });
  const status = await inactivity.statusFor('user-1');
  assert.equal(status.daysInactive, 26);
  assert.equal(status.warningDays, 25);
  assert.equal(status.deletionDays, 30);
  assert.equal(status.exempt, false);
  assert.equal(status.notices.length, 1);
  assert.equal(status.notices[0].kind, 'warning');

  const paid = service({ db: fakeDb({ user: { lastActiveAt: daysAgo(80), subscriptionStatus: 'active' } }) });
  assert.equal((await paid.statusFor('user-1')).exempt, true, 'the banner must not threaten a subscriber');
  const admin = service({ db: fakeDb({ user: { lastActiveAt: daysAgo(80), subscriptionStatus: 'free', role: 'admin' } }) });
  assert.equal((await admin.statusFor('user-1')).exempt, true, 'an admin sees the policy as not applying to them');
});

test('the thresholds are configuration, not constants baked into behaviour', async () => {
  // A shorter policy must warn and delete sooner, which is the whole reason the sweep
  // reads an age instead of waiting for a calendar day.
  const inactivity = service({ db: fakeDb(), options: { warningDays: 3, deletionDays: 5 } });
  assert.equal(inactivityDecision({ daysInactive: 4, warningDays: 3, deletionDays: 5 }).action, 'warn');
  assert.equal(inactivityDecision({ daysInactive: 5, warningDays: 3, deletionDays: 5, positionState: { readable: true, openPositions: 0 } }).action, 'delete');
  const db = fakeDb({ candidates: [account({ last_active_at: daysAgo(5) })] });
  const cleanup = fakeCleanup();
  const summary = await createInactivityService({
    pool: db, trading: fakeTrading(idleState), accountCleanup: cleanup,
    resolveToken: async () => 'token', warningDays: 3, deletionDays: 5, now, logger: silentLogger,
  }).sweepOnce();
  assert.equal(summary.deleted, 1, 'the sweep honours the configured day counts');
  assert.deepEqual(cleanup.calls[0], ['acct-1']);
  // The candidate query is bounded by the warning threshold, so a longer policy cannot
  // quietly delete without ever having warned.
  const scanned = db.calls.find(({ sql }) => sql.includes('FROM metaapi_accounts ma'));
  assert.deepEqual(scanned.params, ['3', ['active', 'non_renewing'], 25]);
});

test('the service refuses to run without a database', () => {
  assert.throws(() => createInactivityService({ pool: null }), /database pool/);
});
