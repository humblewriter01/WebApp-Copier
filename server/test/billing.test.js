/**
 * The billing catalogue and the Flutterwave client that charges from it.
 *
 * Two things are pinned here because both are the kind of bug that is invisible until somebody is charged the
 * wrong amount. First, units: every stored price in this workspace is hundredths of a naira or a dollar, and
 * Flutterwave is fed the *major* unit - `60000` for ₦60,000, `39` for $39 - so the division happens exactly
 * once, in `services/flutterwave.js`, and a test states both sides of it. Second, the currency: a price is
 * never compared, formatted, or sent without the code it belongs to, because ₦3,900 and $3,900 are the same
 * digits and completely different money.
 *
 * Nothing here talks to Flutterwave. The client is exercised with an injected `fetchImpl` that records the
 * request and returns a canned answer, which is also why the assertions read the request body rather than
 * trusting a log line.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  PLAN_DEFINITIONS,
  FREE_PLAN,
  CURRENCIES,
  SUPPORTED_CURRENCIES,
  applyPromoCode,
  billingConfig,
  billingIntervalMs,
  buildReference,
  findPlan,
  formatAmount,
  isSupportedCurrency,
  minimumChargeMinor,
  normalizeCurrency,
  normalizeReference,
  planPriceMinor,
  planPrices,
  publicPlans,
  toMinorUnits,
  toProviderAmount,
  userIdFromReference,
} from '../services/billing.js';
import {
  amountString,
  createFlutterwaveClient,
  isProviderNotFound,
  payloadHash,
  toMajorAmount,
  toSafePlan,
  toSafeRenewal,
  toSafeSubscription,
  toSafeTransaction,
  verifyWebhookHash,
} from '../services/flutterwave.js';
import { planLimitsFor, buildLimitError } from '../services/plan-limits.js';

const baseEnv = { FLW_SECRET_KEY: 'sk_test_secret', FLW_PUBLIC_KEY: 'pk_test_public', FLW_WEBHOOK_HASH: 'shared-webhook-hash' };

/* --------------------------------------------------------------------------- config -------------------------------------------------------------------------- */

test('plans expose defaults, per-currency overrides, and never leak a key', () => {
  const config = billingConfig({ ...baseEnv, FLW_PLAN_PRO_AMOUNT: '150000', FLW_PLAN_PRO_USD_AMOUNT: '4500' });
  assert.equal(planPriceMinor(findPlan(config, 'pro'), 'NGN'), 150_000);
  assert.equal(planPriceMinor(findPlan(config, 'pro'), 'USD'), 4_500);
  assert.equal(planPriceMinor(findPlan(config, 'premium'), 'NGN'), PLAN_DEFINITIONS.premium.defaultAmountMinor);
  assert.equal(findPlan(config, 'missing'), null);
  assert.equal(config.configured, true);
  assert.equal(config.webhookConfigured, true);

  const plans = publicPlans(config);
  assert.deepEqual(plans.map((plan) => plan.key), ['starter', 'pro', 'premium']);
  assert.deepEqual(plans.map((plan) => plan.prices.NGN.amountMinor), [6_000_000, 150_000, 15_000_000]);
  assert.deepEqual(plans.map((plan) => plan.prices.USD.amountMinor), [3_900, 4_500, 9_900]);
  assert.equal(plans[2].amount, 150_000);
  assert.equal(JSON.stringify(plans).includes('sk_test_secret'), false);
  assert.equal(JSON.stringify(plans).includes('pk_test_public'), false);
});

test('the catalogue is one free tier and three paid tiers, priced in both currencies', () => {
  assert.deepEqual(Object.keys(PLAN_DEFINITIONS), ['starter', 'pro', 'premium']);
  assert.deepEqual(
    Object.fromEntries(Object.values(PLAN_DEFINITIONS).map((plan) => [plan.key, [plan.defaultAmountMinor, plan.defaultUsdAmountMinor, plan.limits.maxTradingAccounts, plan.limits.maxTelegramChannels, plan.limits.maxDailySignals]])),
    {
      starter: [6_000_000, 3_900, 1, 10, 200],
      pro: [10_500_000, 6_900, 3, 50, 500],
      premium: [15_000_000, 9_900, 5, 100, 2000],
    },
  );
  assert.equal(FREE_PLAN.limits.maxTradingAccounts, 0, 'Free must not be able to connect an account to execute on');
  assert.equal(FREE_PLAN.limits.maxTelegramChannels, 2, 'Free exists so a second source can be compared against the first');
  assert.equal(FREE_PLAN.limits.maxDailySignals, 50);
  assert.deepEqual([...SUPPORTED_CURRENCIES], ['NGN', 'USD']);
});

test('an unconfigured workspace reports no payment support', () => {
  const config = billingConfig({});
  assert.equal(config.configured, false);
  assert.equal(config.webhookConfigured, false);
  assert.equal(config.currency, 'NGN');
  assert.equal(config.baseUrl, 'https://api.flutterwave.com');
  assert.equal(config.interval, 'monthly');
});

test('a currency is either offered or read as naira, never half-accepted', () => {
  assert.equal(normalizeCurrency(' usd '), 'USD');
  assert.equal(normalizeCurrency('ngn'), 'NGN');
  assert.equal(normalizeCurrency('EUR'), 'NGN', 'a currency we cannot charge in falls back to the workspace default');
  assert.equal(normalizeCurrency(undefined), 'NGN');
  assert.equal(isSupportedCurrency('eur'), false);
  assert.equal(isSupportedCurrency('usd'), true);
  const config = billingConfig({ ...baseEnv, FLW_CURRENCY: 'USD', FLW_PLAN_INTERVAL: 'weekly' });
  assert.equal(config.currency, 'USD');
  // Flutterwave has no "weekly" for payment plans in this workspace's vocabulary, so an unknown interval is
  // read as the default rather than sent to the provider and rejected there.
  assert.equal(config.interval, 'monthly');
  assert.deepEqual(config.supportedCurrencies, ['NGN', 'USD']);
});

/* ----------------------------------------------------------------------------- money ----------------------------------------------------------------------------- */

test('minor units are stored, major units are what Flutterwave is told to charge', () => {
  // The whole migration in four numbers: 60000 naira and 39 dollars, not 6000000 and 3900.
  assert.equal(toProviderAmount(6_000_000), 60_000);
  assert.equal(toProviderAmount(3_900), 39);
  assert.equal(amountString(10_500_000), '105000');
  assert.equal(amountString(6_900), '69');
  assert.equal(toMajorAmount(12_345), 123.45, 'a price with kobo keeps its decimals');
  assert.equal(toMajorAmount(0), null, 'a zero price is not a charge');
  assert.equal(toMajorAmount('nonsense'), null);
  assert.equal(toMinorUnits(2500), 250_000);
  assert.equal(toMinorUnits('12.34'), 1234);
  assert.equal(toMinorUnits('not-a-number'), null);
});

test('the amount string and the amount sent are the same characters', () => {
  // The payload hash is computed over the amount as text; if the request body and the hash were built from
  // different renderings of 60000.00, Flutterwave would refuse the checkout for tampering.
  for (const amountMinor of [6_000_000, 3_900, 12_345]) {
    assert.equal(amountString(amountMinor), String(toMajorAmount(amountMinor)));
  }
});

test('the minimum Flutterwave charge is a property of the currency, not a constant', () => {
  assert.equal(minimumChargeMinor('NGN'), 10_000, '₦100');
  assert.equal(minimumChargeMinor('USD'), 100, '$1');
  assert.equal(minimumChargeMinor('eur'), 10_000, 'an unknown code is charged in the workspace currency');
  assert.deepEqual(Object.keys(CURRENCIES), ['NGN', 'USD']);
});

test('prices are per currency, and a plan with no price in one is simply not offered in it', () => {
  const plan = { key: 'pro', amountMinor: 10_500_000, usdAmountMinor: null };
  assert.deepEqual(Object.keys(planPrices(plan)), ['NGN']);
  assert.equal(planPriceMinor(plan, 'USD'), null);
  assert.deepEqual(planPrices(plan).NGN, {
    currency: 'NGN', amountMinor: 10_500_000, amount: 105_000, providerAmount: 105_000, interval: 'monthly',
  });
  assert.equal(planPriceMinor(null, 'NGN'), null);
});

test('money is read out loud in the currency it is written in', () => {
  assert.equal(formatAmount(6_000_000, 'NGN'), '₦60,000.00', 'the stored kobo figure is divided, never printed raw');
  assert.equal(formatAmount(60_000, 'NGN'), '₦600.00');
  assert.equal(formatAmount(39_00, 'USD'), '$39.00');
  assert.equal(formatAmount(1_234_56, 'USD'), '$1,234.56');
  // A stored row can name a currency this workspace does not sell in; that is a label problem, not a crash.
  assert.equal(formatAmount(1_200, 'GBP'), '£12.00');
  assert.equal(formatAmount(1_200), '₦12.00');
});

/* ---------------------------------------------------------------------------- promos ---------------------------------------------------------------------------- */

test('percentage and fixed promo codes reduce the price in the currency being charged', () => {
  const percentage = applyPromoCode({ amountMinor: 250_000, currency: 'NGN', promoCode: { code: 'LAUNCH25', discountType: 'percentage', discountValue: 25, active: true } });
  assert.equal(percentage.amountMinor, 187_500);
  assert.equal(percentage.discountMinor, 62_500);

  const fixed = applyPromoCode({ amountMinor: 250_000, currency: 'NGN', promoCode: { code: 'FIVE', discountType: 'fixed', discountValue: 500, active: true } });
  assert.equal(fixed.amountMinor, 200_000);

  const dollarPercentage = applyPromoCode({ amountMinor: 3_900, currency: 'USD', promoCode: { code: 'LAUNCH25', discountType: 'percentage', discountValue: 25, active: true } });
  assert.equal(dollarPercentage.amountMinor, 2_925, '$39 less 25% is $29.25, computed in cents');

  assert.deepEqual(applyPromoCode({ amountMinor: 250_000, promoCode: null }), { amountMinor: 250_000, discountMinor: 0, promoCode: null });
});

test('a promo code may not leave an amount the provider would reject, in either currency', () => {
  const future = { discountType: 'percentage', discountValue: 10, active: true };
  assert.throws(() => applyPromoCode({ amountMinor: 1000, promoCode: { ...future, active: false } }), /no longer active/);
  assert.throws(() => applyPromoCode({ amountMinor: 1000, promoCode: { ...future, expiresAt: '2000-01-01T00:00:00.000Z' } }), /expired/);
  assert.throws(() => applyPromoCode({ amountMinor: 1000, promoCode: { ...future, maxUses: 2, currentUses: 2 } }), /usage limit/);
  assert.throws(() => applyPromoCode({ amountMinor: 1000, promoCode: { discountType: 'percentage', discountValue: 0, active: true } }), /not valid/);

  // ₦200 minus ₦199.50 is below the ₦100 floor, and 99% off $39 is below the $1 floor: both are refused here
  // rather than after a customer has been sent to a checkout page that cannot complete.
  assert.throws(
    () => applyPromoCode({ amountMinor: 20_000, currency: 'NGN', promoCode: { discountType: 'fixed', discountValue: 199.9, active: true } }),
    /minimum Flutterwave charge/,
  );
  assert.throws(
    () => applyPromoCode({ amountMinor: 3_900, currency: 'USD', promoCode: { discountType: 'percentage', discountValue: 99, active: true } }),
    /minimum Flutterwave charge in USD/,
  );
  // A code that covers the whole price is a grant, not a payment, and is handled by the caller.
  assert.equal(applyPromoCode({ amountMinor: 250_000, currency: 'NGN', promoCode: { discountType: 'fixed', discountValue: 2500, active: true } }).amountMinor, 0);
});

/* -------------------------------------------------------------------------- references ------------------------------------------------------------------------- */

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

/* ------------------------------------------------------------------------ webhook + checksum ------------------------------------------------------------------- */

test('the webhook accepts only the exact verif-hash configured for this workspace', () => {
  const header = 'shared-webhook-hash';
  assert.equal(verifyWebhookHash({ header, expectedHash: header }), true);
  assert.equal(verifyWebhookHash({ header: `  ${header}  `, expectedHash: header }), true, 'surrounding whitespace is not a different secret');
  assert.equal(verifyWebhookHash({ header: 'shared-webhook-haxh', expectedHash: header }), false);
  assert.equal(verifyWebhookHash({ header: 'short', expectedHash: header }), false, 'a shorter string is refused without throwing on timingSafeEqual');
  assert.equal(verifyWebhookHash({ header: undefined, expectedHash: header }), false);
  assert.equal(verifyWebhookHash({ header: '', expectedHash: header }), false);
  // An unset FLW_WEBHOOK_HASH refuses everything: a half-configured deploy must not grant plans.
  assert.equal(verifyWebhookHash({ header, expectedHash: '' }), false);
  assert.equal(verifyWebhookHash({ header: '', expectedHash: '' }), false);
  assert.equal(verifyWebhookHash(), false);
});

test('payload_hash is Flutterwave\'s documented sha256 of amount, currency, email, tx_ref and the hashed key', () => {
  const fields = { amountMinor: 6_000_000, currency: 'NGN', email: 'person@example.com', txRef: 'sdb_ref_1', secretKey: 'sk_test_secret' };
  const expected = crypto.createHash('sha256')
    .update(`60000NGNperson@example.comsdb_ref_1${crypto.createHash('sha256').update('sk_test_secret', 'utf8').digest('hex')}`, 'utf8')
    .digest('hex');
  assert.equal(payloadHash(fields), expected);

  // Every field the provider will recompute over, in either unit, changes the hash - which is the point.
  for (const tampered of [
    { ...fields, amountMinor: 6_000_001 },
    { ...fields, currency: 'USD' },
    { ...fields, email: 'attacker@example.com' },
    { ...fields, txRef: 'sdb_ref_2' },
    { ...fields, secretKey: 'sk_test_other' },
  ]) {
    assert.notEqual(payloadHash(tampered), expected);
  }
  assert.equal(payloadHash({ ...fields, secretKey: '' }), null);
  assert.equal(payloadHash({ ...fields, txRef: '' }), null);
});

/* --------------------------------------------------------------------- provider payload shapes --------------------------------------------------------------------- */

test('a charge payload is reduced to safe fields, in minor units, and its strings are numbers', () => {
  const safe = toSafeTransaction({
    id: 1_498_138_254, tx_ref: 'sdb_ref', flw_ref: 'FLW-MOCK-123', status: 'successful', amount: '60000.00', currency: 'ngn',
    charged_amount: 59400, payment_type: 'card', processor_response: '00:Successful', created_at: '2026-01-02T03:04:05.000Z',
    card: { masked: '444444XXXXXX4444', first6digits: '444444', country: 'NG' }, customer: { email: 'person@example.com', phone_number: '08012345678' },
  });
  assert.equal(safe.reference, 'sdb_ref');
  assert.equal(safe.transactionId, 1_498_138_254);
  assert.equal(safe.providerReference, 'FLW-MOCK-123');
  assert.equal(safe.status, 'success', 'both documented spellings of a paid charge mean paid');
  assert.equal(safe.amountMinor, 6_000_000, '"60000.00" naira is 6,000,000 kobo');
  assert.equal(safe.chargedAmountMinor, 5_940_000);
  assert.equal(safe.currency, 'NGN');
  assert.equal(safe.channel, 'card');
  assert.equal(safe.gatewayResponse, '00:Successful');
  assert.equal(safe.paidAt, '2026-01-02T03:04:05.000Z');
  const json = JSON.stringify(safe);
  assert.equal(json.includes('444444'), false, 'card digits are never read, let alone stored');
  assert.equal(json.includes('person@example.com'), false);
  assert.equal(json.includes('08012345678'), false);

  assert.equal(toSafeTransaction({ status: 'pending' }).status, 'pending');
  assert.equal(toSafeTransaction({ status: 'failed' }).status, 'failed');
  assert.equal(toSafeTransaction({ status: 'reversed' }).status, 'failed');
  assert.equal(toSafeTransaction({}).amountMinor, null);
});

test('plans and subscriptions report amounts in minor units whatever the provider used', () => {
  const plan = toSafePlan({ id: 42, plan_token: 'PLN-abc', name: 'Signal Desk Pro NGN (monthly)', amount: 60000, interval: 'MONTHLY', currency: 'NGN', status: 'ACTIVE', duration: 0 });
  assert.deepEqual(plan, {
    planId: 42, planToken: 'PLN-abc', name: 'Signal Desk Pro NGN (monthly)', amountMinor: 6_000_000,
    interval: 'monthly', duration: 0, currency: 'NGN', status: 'active',
  });
  assert.equal(toSafePlan(null), null);

  const subscription = toSafeSubscription({ id: 7, status: 'active', amount: 39, currency: 'USD', next_payed: '2026-12-01T00:00:00.000Z', plan_id: 42, email: 'a@b.com' });
  assert.equal(subscription.amountMinor, 3_900);
  assert.equal(subscription.nextPaymentDate, '2026-12-01T00:00:00.000Z');
  assert.equal(toSafeSubscription({}).subscriptionId, null);
});

test('a renewal is keyed on the cycle it belongs to, so a retry cannot buy a second month', () => {
  const renewal = toSafeRenewal({
    id: 77, subscription_id: 77, event: 'subscribe.renewed', status: 'renewed', amount: '39.00', currency: 'USD',
    created_at: '2026-11-01T09:00:00.000Z', next_due_date: '2026-12-01T09:00:00.000Z',
    plan: { id: 42, interval: 'MONTHLY', currency: 'USD' }, customer: { email: 'Payer@Example.com' },
  });
  assert.equal(renewal.renewalKey, 'sdb_flwsub_77_20261201', 'the key is the subscription and the cycle it bought');
  assert.equal(renewal.amountMinor, 3_900);
  assert.equal(renewal.currency, 'USD');
  assert.equal(renewal.interval, 'monthly');
  assert.equal(renewal.planId, 42);
  assert.equal(renewal.email, 'payer@example.com');

  // `created_at` is the fallback for a plan with no next due date, and a tx_ref we were given outranks both.
  assert.equal(toSafeRenewal({ id: 8, created_at: '2026-11-05T10:00:00.000Z', amount: 1 }).renewalKey, 'sdb_flwsub_8_20261105');
  assert.equal(toSafeRenewal({ id: 3, tx_ref: 'sdb_abc_1_2', amount: 1 }).renewalKey, 'sdb_abc_1_2');
  assert.equal(toSafeRenewal({ amount: 1 }).renewalKey, null);
  assert.equal(toSafeRenewal({}).renewalKey, null);
});

test('a 404 is recognised as "that plan is not ours any more"', () => {
  assert.equal(isProviderNotFound(Object.assign(new Error('gone'), { flutterwaveStatus: 404 })), true);
  assert.equal(isProviderNotFound(Object.assign(new Error('No plan was found for this id'), {})), true, "Flutterwave's own 404 wording, without a status attached");
  assert.equal(isProviderNotFound(Object.assign(new Error('down'), { flutterwaveStatus: 500 })), false);
  assert.equal(isProviderNotFound(null), false);
});

/* ---------------------------------------------------------------------- intervals, limits ---------------------------------------------------------------------- */

test('billing intervals convert to durations', () => {
  assert.equal(billingIntervalMs('monthly'), 30 * 24 * 60 * 60 * 1000);
  assert.equal(billingIntervalMs('annually'), 365 * 24 * 60 * 60 * 1000);
  assert.equal(billingIntervalMs('bi-annually'), 182 * 24 * 60 * 60 * 1000);
  assert.equal(billingIntervalMs('quarterly'), 91 * 24 * 60 * 60 * 1000);
  assert.equal(billingIntervalMs('unknown'), 30 * 24 * 60 * 60 * 1000);
});

test('plan limits fall back to free for inactive subscriptions', () => {
  assert.deepEqual(planLimitsFor({ subscription_status: 'free', subscription_plan: 'free' }), FREE_PLAN.limits);
  assert.deepEqual(planLimitsFor({ subscription_status: 'active', subscription_plan: 'starter' }), PLAN_DEFINITIONS.starter.limits);
  assert.deepEqual(planLimitsFor({ subscription_status: 'active', subscription_plan: 'pro' }), PLAN_DEFINITIONS.pro.limits);
  assert.deepEqual(planLimitsFor({ subscription_status: 'non_renewing', subscription_plan: 'premium' }), PLAN_DEFINITIONS.premium.limits);
  assert.deepEqual(planLimitsFor({ subscription_status: 'canceled', subscription_plan: 'premium' }), FREE_PLAN.limits);
  assert.deepEqual(planLimitsFor({ subscription_status: 'expired', subscription_plan: 'premium' }), FREE_PLAN.limits);
});

test('the deployed tier outranks a stale purchase snapshot', () => {
  // Re-pricing or re-limiting a plan must not leave existing subscribers on allowances
  // the catalogue no longer advertises. A stored snapshot still carries a retired plan
  // key, so a purchase is never reduced to free by an unrelated catalogue edit.
  assert.equal(planLimitsFor({ subscription_status: 'active', subscription_plan: 'premium', plan_limits: { maxTradingAccounts: 99 } }).maxTradingAccounts, 5);
  assert.equal(planLimitsFor({ subscription_status: 'active', subscription_plan: 'legacy', plan_limits: { maxTradingAccounts: 99 } }).maxTradingAccounts, 99);
  assert.equal(planLimitsFor({ subscription_status: 'active', subscription_plan: 'premium', plan_limits: { unexpected: 5 } }).maxTradingAccounts, PLAN_DEFINITIONS.premium.limits.maxTradingAccounts);
  // Zero is a limit, not "unset", and must survive a stored snapshot.
  assert.equal(planLimitsFor({ subscription_status: 'active', subscription_plan: 'legacy', plan_limits: { maxTradingAccounts: 0 } }).maxTradingAccounts, 0);
});

test('plan limit errors describe the allowance and request an upgrade', () => {
  const error = buildLimitError({ limitKey: 'maxTradingAccounts', limit: 1, planKey: 'starter' });
  assert.equal(error.status, 402);
  assert.equal(error.code, 'PLAN_LIMIT_REACHED');
  assert.equal(error.upgradeRequired, true);
  assert.equal(error.message, 'Your Starter plan allows 1 connected trading accounts. Upgrade your plan to add more.');
  // The sentence a Free workspace reads at its third channel, built from the catalogue rather than written
  // beside it, so the limit the server enforces and the number a user is told are one number.
  const channels = buildLimitError({ limitKey: 'maxTelegramChannels', limit: FREE_PLAN.limits.maxTelegramChannels, planKey: 'free' });
  assert.equal(channels.message, 'Your Free plan allows 2 monitored Telegram channels. Upgrade your plan to add more.');
  assert.equal(channels.status, 402);
  assert.equal(channels.code, 'PLAN_LIMIT_REACHED');
});

test('a limit of zero is announced as not included rather than zero allowance', () => {
  const error = buildLimitError({ limitKey: 'maxTradingAccounts', limit: 0, planKey: 'free' });
  assert.equal(error.status, 402);
  assert.equal(error.upgradeRequired, true);
  assert.equal(error.message, 'The Free plan does not include connected trading accounts. Upgrade to Starter or higher to add one.');
});

/* -------------------------------------------------------------------------- the client ------------------------------------------------------------------------- */

test('Flutterwave is asked for the major unit, with our reference and its own redirect', async () => {
  const requests = [];
  const client = createFlutterwaveClient({
    config: billingConfig(baseEnv),
    fetchImpl: async (url, options) => {
      requests.push({ url, options, body: JSON.parse(options.body) });
      return new Response(JSON.stringify({ status: 'success', message: 'Hosted Link', data: { link: 'https://checkout.flutterwave.com/pay/abc123' } }), { status: 200 });
    },
  });
  const result = await client.initializeTransaction({
    email: 'person@example.com',
    name: 'Payer',
    amountMinor: 6_000_000,
    currency: 'NGN',
    reference: 'sdb_ref_1',
    redirectUrl: 'https://app.example.test/billing/callback',
    metadata: { user_id: 'u1' },
    title: 'Signal Desk Pro',
  });
  assert.equal(result.link, 'https://checkout.flutterwave.com/pay/abc123');
  assert.equal(result.reference, 'sdb_ref_1');
  assert.equal(requests[0].url, 'https://api.flutterwave.com/v3/payments');
  assert.equal(requests[0].options.method, 'POST');
  assert.equal(requests[0].options.headers.Authorization, 'Bearer sk_test_secret');
  assert.equal(requests[0].body.amount, '60000', 'the provider is told 60000, never 6000000');
  assert.equal(requests[0].body.currency, 'NGN');
  assert.equal(requests[0].body.tx_ref, 'sdb_ref_1');
  assert.equal(requests[0].body.redirect_url, 'https://app.example.test/billing/callback');
  assert.deepEqual(requests[0].body.customer, { email: 'person@example.com', name: 'Payer' });
  assert.deepEqual(requests[0].body.customizations, { title: 'Signal Desk Pro' });
  assert.deepEqual(requests[0].body.meta, { user_id: 'u1' });
  assert.equal(requests[0].body.payload_hash, payloadHash({ amountMinor: 6_000_000, currency: 'NGN', email: 'person@example.com', txRef: 'sdb_ref_1', secretKey: 'sk_test_secret' }));

  const dollar = await client.initializeTransaction({ email: 'us@example.com', amountMinor: 3_900, currency: 'usd', reference: 'sdb_ref_2', redirectUrl: 'https://app.example.test/billing/callback' });
  assert.equal(dollar.link, 'https://checkout.flutterwave.com/pay/abc123');
  assert.equal(requests[1].body.amount, '39');
  assert.equal(requests[1].body.currency, 'USD');
  assert.equal(requests[1].body.payload_hash, payloadHash({ amountMinor: 3_900, currency: 'USD', email: 'us@example.com', txRef: 'sdb_ref_2', secretKey: 'sk_test_secret' }));
});

test('a checkout bound to a payment plan sends the plan id and nothing else about the price', async () => {
  const requests = [];
  const client = createFlutterwaveClient({
    config: billingConfig(baseEnv),
    fetchImpl: async (url, options) => {
      requests.push(JSON.parse(options.body));
      return new Response(JSON.stringify({ status: 'success', data: { link: 'https://checkout.flutterwave.com/pay/plan123' } }), { status: 200 });
    },
  });
  await client.initializeTransaction({ email: 'a@b.com', amountMinor: 6_000_000, currency: 'NGN', reference: 'sdb_ref_3', redirectUrl: 'https://app.example.test/billing/callback', planId: 42 });
  assert.equal(requests[0].payment_plan, 42);
});

test('verification asks Flutterwave by our reference, not by anything the browser carried', async () => {
  const seen = [];
  const client = createFlutterwaveClient({
    config: billingConfig(baseEnv),
    fetchImpl: async (url) => {
      seen.push(url);
      return new Response(JSON.stringify({ status: 'success', data: { tx_ref: 'sdb_ref', status: 'successful', amount: 60000, currency: 'NGN' } }), { status: 200 });
    },
  });
  const data = await client.verifyTransaction('sdb_ref');
  // The client hands back the provider's own fields; reducing them to minor units is `toSafeTransaction`'s
  // job, and that separation is what keeps one translation between "what Flutterwave said" and "what we store".
  assert.equal(data.status, 'successful');
  assert.equal(toSafeTransaction(data).amountMinor, 6_000_000);
  assert.equal(seen[0], 'https://api.flutterwave.com/v3/transactions/verify_by_reference?tx_ref=sdb_ref');
});

test('a provider answer is refused when it is not a Flutterwave page, an error envelope, or nonsense', async () => {
  const config = billingConfig(baseEnv);
  const foreignHost = createFlutterwaveClient({
    config,
    fetchImpl: async () => new Response(JSON.stringify({ status: 'success', data: { link: 'https://evil.example/checkout' } }), { status: 200 }),
  });
  await assert.rejects(
    foreignHost.initializeTransaction({ email: 'a@b.co', amountMinor: 10_000, currency: 'NGN', reference: 'sdb_ref' }),
    (error) => error.code === 'FLUTTERWAVE_INVALID_RESPONSE' && /did not return a checkout page/.test(error.userMessage),
  );

  // Flutterwave answers 200 with status:"error" for a rejected payload; that is not a transaction.
  const silentError = createFlutterwaveClient({
    config,
    fetchImpl: async () => new Response(JSON.stringify({ status: 'error', message: 'Invalid amount' }), { status: 200 }),
  });
  await assert.rejects(
    silentError.initializeTransaction({ email: 'a@b.co', amountMinor: 10_000, currency: 'NGN', reference: 'sdb_ref' }),
    (error) => error.code === 'FLUTTERWAVE_PROVIDER_ERROR' && error.userMessage.includes('Invalid amount'),
  );

  const noLink = createFlutterwaveClient({ config, fetchImpl: async () => new Response(JSON.stringify({ status: 'success', data: { link: null } }), { status: 200 }) });
  await assert.rejects(
    noLink.initializeTransaction({ email: 'a@b.co', amountMinor: 10_000, currency: 'NGN', reference: 'sdb_ref' }),
    (error) => error.code === 'FLUTTERWAVE_INVALID_RESPONSE',
  );

  // A price that cannot be read is refused before a request is made: no amount means no charge, not a zero.
  const noAmount = createFlutterwaveClient({ config, fetchImpl: async () => new Response('{}', { status: 500 }) });
  await assert.rejects(
    noAmount.initializeTransaction({ email: 'a@b.co', amountMinor: 0, currency: 'NGN', reference: 'sdb_ref' }),
    (error) => error.code === 'FLUTTERWAVE_AMOUNT_INVALID' && /could not be read/.test(error.userMessage),
  );
});

test('provider and network failures are translated for a trader, and never repeat a secret', async () => {
  const config = billingConfig(baseEnv);
  const rejection = createFlutterwaveClient({
    config,
    fetchImpl: async () => new Response(JSON.stringify({ status: 'error', message: 'Invalid access token' }), { status: 401 }),
  });
  await assert.rejects(
    rejection.verifyTransaction('sdb_ref'),
    (error) => error.code === 'FLUTTERWAVE_PROVIDER_ERROR'
      && error.status === 503
      && error.flutterwaveStatus === 401
      && error.userMessage.includes('rejected the workspace credentials')
      && !error.userMessage.includes('sk_test_secret'),
  );

  const offline = createFlutterwaveClient({
    config,
    fetchImpl: async () => { throw Object.assign(new Error('fetch failed'), { code: 'ENOTFOUND' }); },
  });
  await assert.rejects(
    offline.verifyTransaction('sdb_ref'),
    (error) => error.code === 'FLUTTERWAVE_NETWORK_ERROR' && error.userMessage.includes('ENOTFOUND') && error.userMessage.includes('No payment was taken'),
  );

  const unconfigured = createFlutterwaveClient({ config: billingConfig({}) });
  assert.equal(unconfigured.isConfigured(), false);
  await assert.rejects(unconfigured.verifyTransaction('sdb_ref'), (error) => error.code === 'FLUTTERWAVE_NOT_CONFIGURED');
  await assert.rejects(unconfigured.createPlan({ name: 'x', amountMinor: 10_000, currency: 'NGN', interval: 'monthly' }), (error) => error.code === 'FLUTTERWAVE_NOT_CONFIGURED');
});
