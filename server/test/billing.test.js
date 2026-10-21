import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  PLAN_DEFINITIONS,
  FREE_PLAN,
  applyPromoCode,
  billingConfig,
  billingIntervalMs,
  buildReference,
  findPlan,
  normalizeReference,
  publicPlans,
  toMinorUnits,
  toSafeTransaction,
  userIdFromReference,
  verifyPaystackSignature,
  verifyWebhookSignature,
} from '../services/billing.js';
import { planLimitsFor, buildLimitError } from '../services/plan-limits.js';
import { createPaystackClient } from '../services/paystack.js';

const baseEnv = { PAYSTACK_SECRET_KEY: 'sk_test_secret', PAYSTACK_PUBLIC_KEY: 'pk_test_public' };

test('plans expose defaults, overrides, and never leak the secret key', () => {
  const config = billingConfig({ ...baseEnv, PAYSTACK_PLAN_PRO_AMOUNT: '150000' });
  assert.equal(findPlan(config, 'pro').amountMinor, 150_000);
  assert.equal(findPlan(config, 'premium').amountMinor, PLAN_DEFINITIONS.premium.defaultAmountMinor);
  assert.equal(findPlan(config, 'missing'), null);
  assert.equal(config.configured, true);

  const plans = publicPlans(config);
  assert.equal(plans.length, 2);
  assert.equal(plans[0].amount, 1500);
  assert.equal(JSON.stringify(plans).includes('sk_test_secret'), false);
  assert.equal(JSON.stringify(plans).includes('pk_test_public'), false);
});

test('an unconfigured workspace reports no payment support', () => {
  const config = billingConfig({});
  assert.equal(config.configured, false);
  assert.equal(config.currency, 'NGN');
  assert.equal(config.baseUrl, 'https://api.paystack.co');
});

test('amounts are converted to and checked in minor units', () => {
  assert.equal(toMinorUnits(2500), 250_000);
  assert.equal(toMinorUnits('12.34'), 1234);
  assert.equal(toMinorUnits('not-a-number'), null);
});

test('percentage and fixed promo codes reduce the price', () => {
  const percentage = applyPromoCode({ amountMinor: 250_000, promoCode: { code: 'LAUNCH25', discountType: 'percentage', discountValue: 25, active: true } });
  assert.equal(percentage.amountMinor, 187_500);
  assert.equal(percentage.discountMinor, 62_500);

  const fixed = applyPromoCode({ amountMinor: 250_000, promoCode: { code: 'FIVE', discountType: 'fixed', discountValue: 500, active: true } });
  assert.equal(fixed.amountMinor, 200_000);

  assert.deepEqual(applyPromoCode({ amountMinor: 250_000, promoCode: null }), { amountMinor: 250_000, discountMinor: 0, promoCode: null });
});

test('promo codes are rejected when inactive, expired, exhausted, or leaving an invalid amount', () => {
  const future = { discountType: 'percentage', discountValue: 10, active: true };
  assert.throws(() => applyPromoCode({ amountMinor: 1000, promoCode: { ...future, active: false } }), /no longer active/);
  assert.throws(() => applyPromoCode({ amountMinor: 1000, promoCode: { ...future, expiresAt: '2000-01-01T00:00:00.000Z' } }), /expired/);
  assert.throws(() => applyPromoCode({ amountMinor: 1000, promoCode: { ...future, maxUses: 2, currentUses: 2 } }), /usage limit/);
  assert.throws(() => applyPromoCode({ amountMinor: 250_000, promoCode: { discountType: 'fixed', discountValue: 2499.5, active: true } }), /minimum Paystack charge/);
  assert.equal(applyPromoCode({ amountMinor: 250_000, promoCode: { discountType: 'fixed', discountValue: 2500, active: true } }).amountMinor, 0);
  assert.throws(() => applyPromoCode({ amountMinor: 1000, promoCode: { discountType: 'percentage', discountValue: 0, active: true } }), /not valid/);
});

test('references round-trip a user id and are validated', () => {
  const userId = '1f8c9e2a-3b4d-4c5e-8f90-123456789abc';
  const reference = buildReference({ userId, now: Date.UTC(2026, 0, 2), random: 'abcdef012345' });
  assert.equal(reference, 'sdb_1f8c9e2a3b4d4c5e8f90123456789abc_1767312000_abcdef012345');
  assert.equal(userIdFromReference(reference), userId);
  assert.equal(userIdFromReference('nonsense'), null);
  assert.equal(normalizeReference(reference), reference);
  assert.equal(normalizeReference('bad reference with spaces'), null);
  assert.equal(normalizeReference(''), null);
});

test('webhook signatures are verified against the raw body with constant-time comparison', () => {
  const rawBody = Buffer.from(JSON.stringify({ event: 'charge.success', data: { reference: 'sdb_x' } }));
  const signature = crypto.createHmac('sha512', 'sk_test_secret').update(rawBody).digest('hex');
  assert.equal(verifyPaystackSignature({ rawBody, signature, secretKey: 'sk_test_secret' }), true);
  assert.equal(verifyPaystackSignature({ rawBody, signature: signature.toUpperCase(), secretKey: 'sk_test_secret' }), true);
  assert.equal(verifyPaystackSignature({ rawBody, signature, secretKey: 'sk_live_other' }), false);
  assert.equal(verifyPaystackSignature({ rawBody, signature: 'short', secretKey: 'sk_test_secret' }), false);
  assert.equal(verifyPaystackSignature({ rawBody, signature: undefined, secretKey: 'sk_test_secret' }), false);
  assert.equal(verifyWebhookSignature(rawBody, signature, baseEnv), true);
  assert.equal(verifyWebhookSignature(rawBody, signature, {}), false);
});

test('transaction payloads are reduced to safe fields', () => {
  const safe = toSafeTransaction({
    reference: 'sdb_ref', status: 'SUCCESS', amount: 250000, currency: 'ngn', channel: 'card',
    gateway_response: 'Approved', paid_at: '2026-01-02T03:04:05.000Z', authorization: { authorization_code: 'AUTH_secret' },
    customer: { email: 'person@example.com' }, plan: { plan_code: 'PLN_x' },
  });
  assert.deepEqual(safe, {
    reference: 'sdb_ref', status: 'success', amountMinor: 250000, currency: 'NGN',
    channel: 'card', gatewayResponse: 'Approved', paidAt: '2026-01-02T03:04:05.000Z', planCode: 'PLN_x',
  });
  assert.equal(JSON.stringify(safe).includes('AUTH_secret'), false);
  assert.equal(JSON.stringify(safe).includes('person@example.com'), false);
});

test('plan limits fall back to free for inactive subscriptions', () => {
  assert.deepEqual(planLimitsFor({ subscription_status: 'free', subscription_plan: 'free' }), FREE_PLAN.limits);
  assert.deepEqual(planLimitsFor({ subscription_status: 'active', subscription_plan: 'pro' }), PLAN_DEFINITIONS.pro.limits);
  assert.deepEqual(planLimitsFor({ subscription_status: 'canceled', subscription_plan: 'premium' }), FREE_PLAN.limits);
  assert.equal(planLimitsFor({ subscription_status: 'active', subscription_plan: 'premium', plan_limits: { maxTradingAccounts: 99, unexpected: 5 } }).maxTradingAccounts, 99);
  assert.equal(planLimitsFor({ subscription_status: 'active', subscription_plan: 'premium', plan_limits: { unexpected: 5 } }).maxTradingAccounts, PLAN_DEFINITIONS.premium.limits.maxTradingAccounts);
});

test('plan limit errors describe the allowance and request an upgrade', () => {
  const error = buildLimitError({ limitKey: 'maxTradingAccounts', limit: 1, planKey: 'free' });
  assert.equal(error.status, 402);
  assert.equal(error.code, 'PLAN_LIMIT_REACHED');
  assert.equal(error.upgradeRequired, true);
  assert.match(error.message, /1 connected trading accounts/);
  assert.match(error.message, /Upgrade/);
});

test('billing intervals convert to durations', () => {
  assert.equal(billingIntervalMs('monthly'), 30 * 24 * 60 * 60 * 1000);
  assert.equal(billingIntervalMs('annually'), 365 * 24 * 60 * 60 * 1000);
  assert.equal(billingIntervalMs('unknown'), 30 * 24 * 60 * 60 * 1000);
});

test('Paystack initialize sends the documented payload and returns a checkout URL', async () => {
  const requests = [];
  const client = createPaystackClient({
    config: billingConfig(baseEnv),
    fetchImpl: async (url, options) => {
      requests.push({ url, options, body: JSON.parse(options.body) });
      return new Response(JSON.stringify({ status: true, data: { authorization_url: 'https://checkout.paystack.com/abc123', access_code: 'abc123', reference: 'sdb_ref' } }), { status: 200 });
    },
  });
  const result = await client.initializeTransaction({
    email: 'person@example.com', amountMinor: 250000, currency: 'NGN', reference: 'sdb_ref',
    callbackUrl: 'https://app.example.test/billing/callback', metadata: { user_id: 'u1' },
  });
  assert.equal(result.authorizationUrl, 'https://checkout.paystack.com/abc123');
  assert.equal(requests[0].url, 'https://api.paystack.co/transaction/initialize');
  assert.equal(requests[0].options.method, 'POST');
  assert.equal(requests[0].options.headers.Authorization, 'Bearer sk_test_secret');
  assert.deepEqual(requests[0].body, {
    email: 'person@example.com', amount: 250000, currency: 'NGN', reference: 'sdb_ref',
    callback_url: 'https://app.example.test/billing/callback', metadata: { user_id: 'u1' },
  });
});

test('Paystack verify reads transaction details by reference', async () => {
  let requested;
  const client = createPaystackClient({
    config: billingConfig(baseEnv),
    fetchImpl: async (url) => {
      requested = url;
      return new Response(JSON.stringify({ status: true, data: { reference: 'sdb_ref', status: 'success', amount: 250000 } }), { status: 200 });
    },
  });
  const data = await client.verifyTransaction('sdb_ref');
  assert.equal(data.status, 'success');
  assert.equal(requested, 'https://api.paystack.co/transaction/verify/sdb_ref');
});

test('Paystack rejects foreign checkout hosts, provider errors, and network failures safely', async () => {
  const config = billingConfig(baseEnv);
  const foreignHost = createPaystackClient({
    config,
    fetchImpl: async () => new Response(JSON.stringify({ status: true, data: { authorization_url: 'https://evil.example/checkout', access_code: 'x' } }), { status: 200 }),
  });
  await assert.rejects(
    foreignHost.initializeTransaction({ email: 'a@b.co', amountMinor: 100, currency: 'NGN', reference: 'sdb_ref' }),
    /unexpected checkout URL/,
  );

  const rejection = createPaystackClient({
    config,
    fetchImpl: async () => new Response(JSON.stringify({ status: false, message: 'Invalid key' }), { status: 401 }),
  });
  await assert.rejects(
    rejection.verifyTransaction('sdb_ref'),
    (error) => error.code === 'PAYSTACK_PROVIDER_ERROR'
      && error.status === 503
      && error.userMessage.includes('rejected the workspace credentials')
      && !error.userMessage.includes('sk_test_secret'),
  );

  const offline = createPaystackClient({
    config,
    fetchImpl: async () => { throw Object.assign(new Error('fetch failed'), { code: 'ENOTFOUND' }); },
  });
  await assert.rejects(
    offline.verifyTransaction('sdb_ref'),
    (error) => error.code === 'PAYSTACK_NETWORK_ERROR' && error.userMessage.includes('ENOTFOUND'),
  );

  const unconfigured = createPaystackClient({ config: billingConfig({}) });
  assert.equal(unconfigured.isConfigured(), false);
  await assert.rejects(
    unconfigured.verifyTransaction('sdb_ref'),
    (error) => error.code === 'PAYSTACK_NOT_CONFIGURED',
  );
});
