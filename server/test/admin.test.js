import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertAllowedImpersonation,
  assertAllowedSelfUpdate,
  normalizeSubscriptionAdjustment,
  createAdminAccess,
  normalizePromoCodeInput,
  normalizePromoCodeUpdate,
  normalizeUserUpdate,
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
