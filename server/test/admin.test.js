import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  assertAllowedImpersonation,
  assertAllowedSelfUpdate,
  normalizeSubscriptionAdjustment,
  createAdminAccess,
  normalizePromoCodeInput,
  normalizePromoCodeUpdate,
  normalizeUserUpdate,
  buildUserAdminUpdate,
  buildAdminSignalDelete,
  buildSignalOwnershipDelete,
  buildSignalsPurgeCount,
  buildSignalsPurgeForUser,
  buildSignalsPurgeOlderThan,
} from '../services/admin.js';

test('admin access uses ADMIN_EMAILS plus the workspace owner address', () => {
  const access = createAdminAccess({ env: { ADMIN_EMAILS: ' Boss@Example.com , second@example.com ' } });
  assert.equal(access.isAdminEmail('boss@example.com'), true);
  assert.equal(access.isAdminEmail('ameenujaafar432@gmail.com'), true);
  assert.equal(access.isAdminEmail('someone@example.com'), false);
  assert.equal(access.isAdminEmail(''), false);
  assert.equal(access.isAdminRole('ADMIN'), true);
  assert.equal(access.isAdminRole('user'), false);
  assert.equal(access.isAdminRole(null), false);
  assert.deepEqual(access.emails.filter((email) => email === 'boss@example.com').length, 1);
});

test('promo code input is normalized and validated before it reaches the database', () => {
  const promo = normalizePromoCodeInput({ code: ' launch-25 ', discountType: 'percentage', discountValue: '25', maxUses: '100', expiresAt: '2099-01-01T00:00:00.000Z' });
  assert.deepEqual(promo, {
    code: 'LAUNCH-25',
    discountType: 'percentage',
    discountValue: 25,
    maxUses: 100,
    expiresAt: '2099-01-01T00:00:00.000Z',
  });

  const unlimited = normalizePromoCodeInput({ code: 'FIXED10', discountType: 'fixed', discountValue: 10.005 });
  assert.equal(unlimited.maxUses, null);
  assert.equal(unlimited.expiresAt, null);
  assert.equal(unlimited.discountValue, 10.01);
});

test('promo code validation rejects unsafe or impossible values', () => {
  assert.throws(() => normalizePromoCodeInput({ code: 'ab', discountType: 'percentage', discountValue: 10 }), /3 to 50 characters/);
  assert.throws(() => normalizePromoCodeInput({ code: '-BAD', discountType: 'percentage', discountValue: 10 }), /3 to 50 characters/);
  assert.throws(() => normalizePromoCodeInput({ code: 'GOOD', discountType: 'unknown', discountValue: 10 }), /percentage or fixed/);
  assert.throws(() => normalizePromoCodeInput({ code: 'GOOD', discountType: 'percentage', discountValue: 0 }), /greater than zero/);
  assert.throws(() => normalizePromoCodeInput({ code: 'GOOD', discountType: 'percentage', discountValue: 101 }), /cannot be greater than 100/);
  assert.throws(() => normalizePromoCodeInput({ code: 'GOOD', discountType: 'fixed', discountValue: 200_000 }), /cannot be greater than 100000/);
  assert.throws(() => normalizePromoCodeInput({ code: 'GOOD', discountType: 'fixed', discountValue: 5, maxUses: 1.5 }), /whole number/);
  assert.throws(() => normalizePromoCodeInput({ code: 'GOOD', discountType: 'fixed', discountValue: 5, expiresAt: 'not-a-date' }), /valid expiry/);
  assert.throws(() => normalizePromoCodeInput({ code: 'GOOD', discountType: 'fixed', discountValue: 5, expiresAt: '2000-01-01' }), /future/);
});

test('promo code updates only touch supported fields', () => {
  assert.deepEqual(normalizePromoCodeUpdate({ active: false }), { active: false });
  assert.deepEqual(normalizePromoCodeUpdate({ maxUses: '' }), { maxUses: null });
  assert.throws(() => normalizePromoCodeUpdate({ active: 'no' }), /true or false/);
  assert.throws(() => normalizePromoCodeUpdate({}), /at least one change/);
});

test('user updates require a suspension reason and a valid role', () => {
  assert.deepEqual(normalizeUserUpdate({ role: 'admin' }), { role: 'admin' });
  assert.deepEqual(normalizeUserUpdate({ isSuspended: true, suspensionReason: 'Chargeback' }), { isSuspended: true, suspensionReason: 'Chargeback' });
  assert.deepEqual(normalizeUserUpdate({ isSuspended: false, suspensionReason: 'stale' }), { isSuspended: false, suspensionReason: '' });
  assert.throws(() => normalizeUserUpdate({ role: 'owner' }), /valid role|user or admin/);
  assert.throws(() => normalizeUserUpdate({ isSuspended: true }), /reason/);
  assert.throws(() => normalizeUserUpdate({}), /at least one change/);
});

/* The panel's own guard and the endpoint's must agree, and a rejection has to say what arrived: an
   administrator staring at "Choose at least one change to save." cannot tell a wrong field name from a
   form they had not filled in, which is how a payload mismatch ends up reported as a broken button. */
test('a suspension flag is read from the value, not from its JSON type alone', () => {
  assert.deepEqual(normalizeUserUpdate({ isSuspended: 'true', suspensionReason: ' Chargeback ' }), { isSuspended: true, suspensionReason: 'Chargeback' });
  assert.deepEqual(normalizeUserUpdate({ isSuspended: 'FALSE' }), { isSuspended: false, suspensionReason: '' });
  assert.deepEqual(normalizeUserUpdate({ isSuspended: false, suspensionReason: 'Chargeback' }), { isSuspended: false, suspensionReason: '' });
  // Anything that is not recognisably a decision is refused rather than guessed at.
  assert.throws(() => normalizeUserUpdate({ isSuspended: 1 }), /Suspension must be true or false \(received a number\)/);
  assert.throws(() => normalizeUserUpdate({ isSuspended: { value: true } }), /received an object/);
  assert.throws(() => normalizeUserUpdate({ isSuspended: null }), /received null/);
});

test('a rejected account edit names the fields the endpoint writes and the ones that were sent', () => {
  // A key spelled differently is the failure mode that looks like a dead button, so it must read as a
  // naming problem in the panel itself.
  assert.throws(
    () => normalizeUserUpdate({ suspended: true, reason: 'Chargeback' }),
    /writes "role", "isSuspended" and "suspensionReason", and it sent "suspended", "reason"/,
  );
  assert.throws(() => normalizeUserUpdate({}), /the request arrived with no recognised field/);
  assert.throws(() => normalizeUserUpdate({ id: 'user-1' }), /it sent "id"/);
  assert.throws(() => normalizeUserUpdate({ isSuspended: true }), /suspensionReason was not sent/);
  assert.throws(() => normalizeUserUpdate({ isSuspended: 'true', suspensionReason: '   ' }), /suspensionReason arrived blank/);
  assert.throws(() => normalizeUserUpdate({ role: 'owner' }), /received the text "owner"/);
});

test('a crafted field name is not echoed back', () => {
  const hostile = { 'isSuspended\nSet-Cookie: a=b': true, '<img src=x>': 1, 123: 'numeric' };
  let message = '';
  try { normalizeUserUpdate(hostile); } catch (error) { message = error.message; }
  assert.match(message, /Choose at least one change to save/);
  assert.equal(message.includes('Set-Cookie'), false, 'only plain identifier-shaped keys are named');
  assert.equal(message.includes('<img'), false);
});

test('a suspension that arrived as text writes the same statement as a real boolean', () => {
  const fromBoolean = buildUserAdminUpdate(normalizeUserUpdate({ isSuspended: true, suspensionReason: 'Chargeback' }), 'user-1');
  const fromText = buildUserAdminUpdate(normalizeUserUpdate({ isSuspended: 'true', suspensionReason: 'Chargeback' }), 'user-1');
  assert.deepEqual(fromText, fromBoolean);
  assert.equal(fromText.params[0], true, 'the column is bound with a boolean, not the string "true"');
  assert.equal(fromText.params.length, 3);
});

test('an admin cannot demote or suspend themselves', () => {
  assert.doesNotThrow(() => assertAllowedSelfUpdate({ actorId: 'a1', targetId: 'b2', update: { role: 'user' } }));
  assert.throws(() => assertAllowedSelfUpdate({ actorId: 'a1', targetId: 'a1', update: { role: 'user' } }), /own admin access/);
  assert.throws(() => assertAllowedSelfUpdate({ actorId: 'a1', targetId: 'a1', update: { isSuspended: true } }), /suspend your own/);
  assert.doesNotThrow(() => assertAllowedSelfUpdate({ actorId: 'a1', targetId: 'a1', update: { role: 'admin' } }));
});

/* --------------------- manual subscription adjustments --------------------- */
const CATALOGUE = [{ key: 'starter', name: 'Starter' }, { key: 'pro', name: 'Pro' }, { key: 'premium', name: 'Premium' }];

test('a manual adjustment accepts a plan, a period, or an exact date, and always a reason', () => {
  assert.deepEqual(normalizeSubscriptionAdjustment({ plan: ' PRO ', reason: 'Outage credit' }, { plans: CATALOGUE }), {
    planKey: 'pro', days: null, endsAt: null, reason: 'Outage credit',
  });
  assert.equal(normalizeSubscriptionAdjustment({ days: '14', reason: 'Trial after refund' }, { plans: CATALOGUE }).days, 14);
  assert.equal(normalizeSubscriptionAdjustment({ plan: 'free', reason: 'Refunded in full' }, { plans: CATALOGUE }).planKey, 'free');
  assert.equal(normalizeSubscriptionAdjustment({ endsAt: '2099-01-01T00:00:00.000Z', reason: 'Promised date' }, { plans: CATALOGUE }).endsAt, '2099-01-01T00:00:00.000Z');
});

test('a manual adjustment cannot be vague, contradictory, or endless', () => {
  assert.throws(() => normalizeSubscriptionAdjustment({ plan: 'pro' }, { plans: CATALOGUE }), /reason for this adjustment/);
  assert.throws(() => normalizeSubscriptionAdjustment({ reason: 'ok' }, { plans: CATALOGUE }), /reason for this adjustment/);
  assert.throws(() => normalizeSubscriptionAdjustment({ reason: 'a valid reason' }, { plans: CATALOGUE }), /plan to grant/);
  assert.throws(() => normalizeSubscriptionAdjustment({ plan: 'founder', reason: 'legacy friend' }, { plans: CATALOGUE }), /free, starter, pro, premium/);
  assert.throws(() => normalizeSubscriptionAdjustment({ days: 0, reason: 'nothing really' }, { plans: CATALOGUE }), /1 to 365 whole days/);
  assert.throws(() => normalizeSubscriptionAdjustment({ days: 2.5, reason: 'nothing really' }, { plans: CATALOGUE }), /1 to 365 whole days/);
  assert.throws(() => normalizeSubscriptionAdjustment({ days: 400, reason: 'nothing really' }, { plans: CATALOGUE }), /1 to 365 whole days/);
  assert.throws(() => normalizeSubscriptionAdjustment({ days: 7, endsAt: '2099-01-01T00:00:00.000Z', reason: 'belt and braces' }, { plans: CATALOGUE }), /either a number of days or an expiry date/);
  assert.throws(() => normalizeSubscriptionAdjustment({ endsAt: '2000-01-01', reason: 'backdated favour' }, { plans: CATALOGUE }), /in the future/);
  assert.throws(() => normalizeSubscriptionAdjustment({ endsAt: 'not a date', reason: 'backdated favour' }, { plans: CATALOGUE }), /not readable/);
});

test('support access is refused for the accounts where it would mislead', () => {
  const target = { id: 'user-2', email: 'trader@example.com', isSuspended: false };
  assert.equal(assertAllowedImpersonation({ actorId: 'admin-1', target }), undefined);
  assert.throws(() => assertAllowedImpersonation({ actorId: 'admin-1', target: undefined }), /could not be found/);
  assert.throws(() => assertAllowedImpersonation({ actorId: 'admin-1', target: { ...target, id: 'admin-1' } }), /your own account/);
  assert.throws(() => assertAllowedImpersonation({ actorId: 'admin-1', target: { ...target, isSuspended: true } }), /suspended/);
  try {
    assertAllowedImpersonation({ actorId: 'admin-1', target: { ...target, isSuspended: true } });
  } catch (error) {
    assert.equal(error.status, 409, 'a refusal the panel can show without a guess');
  }
});

/* Signal history deletion is the one admin surface that removes application data, and its whole
   guarantee is narrow: a trade is never deleted, only unlinked, and the unlink and the delete are a
   matched pair of statements. These builders are the only SQL those routes run, so the invariants are
   asserted here rather than trusted from a route that could drift away from them. */
const SIGNAL_DELETIONS = {
  ownership: () => buildSignalOwnershipDelete({ userId: 'user-1', signalId: 'signal-1' }),
  single: () => buildAdminSignalDelete({ signalId: 'signal-1' }),
  user: () => buildSignalsPurgeForUser({ userId: 'user-1' }),
  aged: () => buildSignalsPurgeOlderThan({ days: 30 }),
};

test('every signal deletion unlinks trades before it removes the signal', () => {
  for (const [name, build] of Object.entries(SIGNAL_DELETIONS)) {
    const pair = build();
    // The alias is allowed: the platform purge updates trades against a joined signals row.
    assert.match(pair.unlink.sql, /^UPDATE trades( \w+)? SET signal_id=NULL/, `${name} keeps the trade rows`);
    assert.match(pair.unlink.sql, /signal_id=NULL/, `${name} clears only the pointer`);
    assert.match(pair.remove.sql, /^DELETE FROM signals/, `${name} deletes only signals`);
    assert.equal(/\bFROM (trades|users|settings|channels|execution_jobs)\b/.test(pair.remove.sql.replace(/RETURNING.*/s, '')), false, `${name} never deletes another table's rows`);
    for (const statement of [pair.unlink, pair.remove]) {
      // Distinct placeholder *numbers*, not occurrences: a scope may be written twice in one statement
      // and bound once, which is what Postgres does with `user_id=$1 ... WHERE user_id=$1`.
      const numbers = new Set((statement.sql.match(/\$\d+/g) || []).map((token) => token.slice(1)));
      assert.equal(statement.params.length, numbers.size, `${name} binds every placeholder exactly once`);
      assert.deepEqual([...numbers].map(Number), [...numbers].map((_, index) => index + 1), `${name} numbers its placeholders from one, with no gaps`);
      assert.equal(statement.params.some((value) => value === undefined), false, `${name} never binds a hole`);
      assert.match(pair.remove.sql, /RETURNING/, `${name} reports what it actually removed`);
    }
  }
});

test('a workspace clearing its own history is bounded to its own rows', () => {
  const pair = buildSignalOwnershipDelete({ userId: 'user-1', signalId: 'signal-1' });
  // The owner is part of the delete predicate, not a check in front of it: a route that forgets the
  // check still cannot reach another account's row.
  assert.match(pair.remove.sql, /id=\$1 AND user_id=\$2/);
  assert.match(pair.unlink.sql, /signal_id=\$1 AND user_id=\$2/, 'the unlink is scoped the same way');
  assert.deepEqual(pair.remove.params, ['signal-1', 'user-1']);
});

test('bulk purges age in SQL from one expression, so a preview cannot disagree with the delete', () => {
  const aged = buildSignalsPurgeOlderThan({ days: 30 });
  const cutoff = /NOW\(\) - \(\$1::int \* INTERVAL '1 day'\)/g;
  assert.equal((aged.remove.sql.match(cutoff) || []).length, 1);
  assert.equal((aged.unlink.sql.match(cutoff) || []).length, 1, 'the unlink uses the same age as the delete');
  assert.deepEqual(aged.remove.params, [30]);
  const user = buildSignalsPurgeForUser({ userId: 'user-1' });
  assert.match(user.remove.sql, /user_id=\$1/, 'the per-user clear never escapes that account');
  assert.match(user.remove.sql, /COALESCE\(\$2::timestamptz,'infinity'::timestamptz\)/, 'no cutoff means everything of theirs, and the placeholder count never changes');
  assert.equal((user.unlink.sql.match(/\$1/g) || []).length, 2, 'the account is bound in both the unlink and its subquery');
  assert.equal(user.unlink.params.filter((value) => value === 'user-1').length, 1, 'once per placeholder number, Postgres reuses it');
});

test('the counts a confirmation quotes come from the same shapes as the deletion', () => {
  const platform = buildSignalsPurgeCount({ days: 30 });
  assert.deepEqual(platform.params, [30]);
  assert.match(platform.sql, /COUNT\(\*\)::int AS signals/);
  assert.match(platform.sql, /AS unlinkable_trades/, 'the preview says how many trades will be unlinked, not deleted');
  const perUser = buildSignalsPurgeCount({ userId: 'user-1' });
  assert.deepEqual(perUser.params, ['user-1', null], 'a null age is a valid "everything" and still binds');
  assert.equal((perUser.sql.match(/user_id=\$1/g) || []).length >= 3, true, 'every count is scoped to the account');
});

/* The builders are deliberately dumb: their safety is that a target is *bound*, never concatenated, so
   the shape of the id cannot change the shape of the statement. Refusing a malformed id is the route's
   job, which is why that guard is asserted against the route source here rather than invented twice. */
test('a hostile target cannot widen a delete, because nothing is interpolated into the SQL', () => {
  const hostile = "1 OR 1=1'; DROP TABLE trades;--";
  for (const build of [
    () => buildAdminSignalDelete({ signalId: hostile }),
    () => buildSignalOwnershipDelete({ userId: hostile, signalId: hostile }),
    () => buildSignalsPurgeForUser({ userId: hostile }),
  ]) {
    const pair = build();
    for (const statement of [pair.unlink, pair.remove]) {
      assert.equal(statement.sql.includes(hostile), false, 'the value stays in the bind list');
      assert.equal(statement.sql.includes(';'), false, 'one statement per call, never a stacked one');
      assert.match(statement.sql, /\$1/, 'and it reaches the row only as a parameter');
    }
  }
  const index = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  const routes = index.slice(index.indexOf("app.delete('/api/signals/:id'"), index.indexOf("app.get('/api/accounts'"));
  const adminRoutes = index.slice(index.indexOf('data management (admin)'), index.indexOf('/api/admin/promo-codes'));
  for (const block of [routes, adminRoutes]) {
    assert.match(block, /UUID_PATTERN\.test\((signalId|targetId)\)/, 'the route refuses a non-uuid before the builder is consulted');
  }
  assert.match(adminRoutes, /Number\.isInteger\(days\) \|\| days < 1 \|\| days > 3650/, 'the purge age is clamped in the route');
});
