/**
 * Two currencies, one checkout: the test file for the arithmetic this migration turned on.
 *
 * Paystack was fed kobo - hundredths - and Flutterwave is fed naira and dollars. Get that wrong in one
 * direction and a ₦60,000 plan is offered for six hundred naira; get it wrong in the other and a trader is
 * charged six million. So the assertions here are made against the bytes that would go over the wire: the
 * billing service is run for real, the Flutterwave client is the real one, and only `fetch` is replaced by a
 * recorder. What that buys is a test that fails if `toMajorAmount` is removed, if `amountMinor` is sent
 * directly, or if the currency a price was looked up in is not the currency the charge is made in.
 *
 * The second half is the refund side of the same coin: what the webhook accepts. An amount that does not
 * match the stored row is refused, a currency that does not match is refused, an overpayment is accepted with
 * a warning, and none of it is decided by what the browser was told.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { billingConfig } from '../services/billing.js';
import { createFlutterwaveClient, payloadHash, checkoutPresentation, CURRENCY_CHECKOUT_PRESENTATION } from '../services/flutterwave.js';
import { createPricingStore, mergePlanPricing } from '../services/pricing.js';
import { createBillingService } from '../services/billing-service.js';
import { verifyWebhookHash } from '../services/flutterwave.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const indexSource = readFileSync(path.join(here, '..', 'index.js'), 'utf8');

const env = {
  FLW_SECRET_KEY: 'sk_testflutterwavekey',
  FLW_PUBLIC_KEY: 'pk_testpublic',
  FLW_WEBHOOK_HASH: 'the-hash-in-the-dashboard',
  FLW_PLAN_STARTER_AMOUNT: '6000000',
  FLW_PLAN_STARTER_USD_AMOUNT: '3900',
  FLW_PLAN_PRO_AMOUNT: '10500000',
  FLW_PLAN_PRO_USD_AMOUNT: '6900',
  FLW_PLAN_PREMIUM_AMOUNT: '15000000',
  FLW_PLAN_PREMIUM_USD_AMOUNT: '9900',
  CLIENT_URL: 'https://app.example.test',
};
const config = billingConfig(env);

/** Where Flutterwave sends the browser back to; the checkout refuses to start without it. */
const silent = { info() {}, warn() {}, error() {} };

/** A recorder that behaves like Flutterwave's hosted-checkout endpoint. */
function flutterwaveDouble({ link = 'https://checkout.flutterwave.com/pay/mock', answer = {} } = {}) {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options, body: options?.body ? JSON.parse(options.body) : null });
    return new Response(JSON.stringify({ status: 'success', message: 'Hosted Link', data: { link, tx_ref: JSON.parse(options.body).tx_ref, ...answer } }), { status: 200 });
  };
  return {
    requests,
    client: createFlutterwaveClient({ config, fetchImpl }),
    last: () => requests[requests.length - 1],
  };
}

function poolDouble(handlers = []) {
  const calls = [];
  const query = async (sql, params = []) => {
    calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
    for (const [pattern, answer] of handlers) {
      if (sql.includes(pattern)) {
        const value = typeof answer === 'function' ? answer({ sql, params }) : answer;
        return value ?? { rows: [], rowCount: 0 };
      }
    }
    return { rows: [], rowCount: 0 };
  };
  return { calls, query, connect: async () => ({ query, release() {} }) };
}

function billingFor({ provider, pool, snapshot, random = 'deadbeef0123' } = {}) {
  const pricing = createPricingStore({ pool: poolDouble([['FROM plans p LEFT JOIN users u', { rows: [], rowCount: 0 }]]), config, logger: silent });
  const store = snapshot
    ? { snapshot: async () => snapshot, planFor: async (key) => snapshot.plans.find((plan) => plan.key === key) || null, recordPlanSync: async () => {} }
    : pricing;
  return createBillingService({ pool, flutterwave: provider.client, pricing: store, config, logger: silent, random, now: () => Date.UTC(2026, 9, 27, 9, 0, 0) });
}

const user = { id: '9f0dd7e2-3f6a-4a51-9b52-7d6ca4b0b123', name: 'Trader', email: 'trader@example.test', subscription_status: 'free', subscription_plan: 'free', plan_limits: {} };

/** Every request the workspace makes for a checkout, with the amount the provider will actually charge. */
async function checkoutFor({ planKey, currency, snapshot, stored = null, promo = null }) {
  const provider = flutterwaveDouble();
  const pool = poolDouble([
    ['FROM users WHERE id=$1 LIMIT 1', { rows: [user], rowCount: 1 }],
    ['FROM billing_transactions', { rows: [], rowCount: 0 }],
    ['INSERT INTO billing_transactions', { rows: [{ id: 't1' }], rowCount: 1 }],
    ...(stored ? [['FROM plans p LEFT JOIN users u', { rows: stored, rowCount: 1 }]] : []),
    ...(promo ? [['FROM promo_codes WHERE upper(code)=$1', { rows: [promo], rowCount: 1 }]] : []),
  ]);
  const checkout = await billingFor({ provider, pool, snapshot }).initialize({ userId: user.id, planKey, currency, promoCode: promo ? promo.code : undefined });
  return { provider, pool, checkout };
}

/* --------------------------------------------------------------- the amounts Flutterwave is told --------------------------------------------------------------- */

test('a naira checkout is sent in naira: Starter 60000, Pro 105000, Premium 150000', async () => {
  const expected = { starter: '60000', pro: '105000', premium: '150000' };
  for (const [planKey, amount] of Object.entries(expected)) {
    const { provider, pool, checkout } = await checkoutFor({ planKey, currency: 'NGN' });
    assert.equal(provider.last().body.amount, amount, `${planKey} in naira`);
    assert.equal(provider.last().body.currency, 'NGN');
    assert.equal(provider.last().url, 'https://api.flutterwave.com/v3/payments');
    // What is stored is the same price in hundredths, which is what the webhook is checked against.
    const insert = pool.calls.find((call) => call.sql.includes('INSERT INTO billing_transactions'));
    assert.equal(Number(insert.params[5]), Number(amount) * 100, `${planKey} stored in minor units`);
    assert.equal(insert.params[7], 'NGN');
    assert.equal(checkout.amountMinor, Number(amount) * 100);
    assert.equal(checkout.providerAmount, Number(amount), 'and the quote on the way back agrees with the request');
  }
});

test('a dollar checkout is sent in dollars: Starter 39, Pro 69, Premium 99', async () => {
  const expected = { starter: '39', pro: '69', premium: '99' };
  for (const [planKey, amount] of Object.entries(expected)) {
    const { provider, pool, checkout } = await checkoutFor({ planKey, currency: 'USD' });
    assert.equal(provider.last().body.amount, amount, `${planKey} in dollars - not ${Number(amount) * 100}, which is the naira convention`);
    assert.equal(provider.last().body.currency, 'USD');
    const insert = pool.calls.find((call) => call.sql.includes('INSERT INTO billing_transactions'));
    assert.equal(Number(insert.params[5]), Number(amount) * 100, 'cents are stored, dollars are sent');
    assert.equal(insert.params[7], 'USD');
    assert.equal(checkout.currency, 'USD');
    assert.equal(checkout.amount, Number(amount));
  }
});

test('the same plan in two currencies differs only in amount and currency, never in the reference', async () => {
  const naira = await checkoutFor({ planKey: 'pro', currency: 'NGN' });
  const dollars = await checkoutFor({ planKey: 'pro', currency: 'USD', random: 'deadbeef0123' });
  assert.equal(naira.provider.last().body.tx_ref, dollars.provider.last().body.tx_ref, 'the same request shape, with a fresh reference per attempt in production');
  assert.notEqual(naira.checkout.amountMinor, dollars.checkout.amountMinor, 'and two different prices, in the same unit');
  assert.equal(Number(naira.checkout.providerAmount) / Number(dollars.checkout.providerAmount), 105_000 / 69, 'the ratio is the price list, not an exchange rate invented here');
});

test('a price saved in the database is what is charged, in that currency', async () => {
  const snapshot = mergePlanPricing({
    config,
    planRows: { pro: { NGN: 8_900_000, USD: 4_500, interval: 'monthly', history: [], updatedAt: null, updatedBy: null } },
  });
  const naira = await checkoutFor({ planKey: 'pro', currency: 'NGN', snapshot });
  assert.equal(naira.provider.last().body.amount, '89000');
  const dollars = await checkoutFor({ planKey: 'pro', currency: 'USD', snapshot });
  assert.equal(dollars.provider.last().body.amount, '45');
});

test('a promo discount is taken in the currency being charged, and sent as the reduced major amount', async () => {
  const promo = { id: 'p1', code: 'LAUNCH25', discountType: 'percentage', discountValue: 25, maxUses: null, currentUses: 0, expiresAt: null, active: true };
  const naira = await checkoutFor({ planKey: 'pro', currency: 'NGN', promo });
  assert.equal(naira.provider.last().body.amount, '78750', '₦105,000 less 25% is ₦78,750 - sent as 78750, not 7875000');
  const dollars = await checkoutFor({ planKey: 'pro', currency: 'USD', promo });
  assert.equal(dollars.provider.last().body.amount, '51.75', '$69 less 25% is $51.75, and the cents survive the conversion');
  const insert = dollars.pool.calls.find((call) => call.sql.includes('INSERT INTO billing_transactions'));
  assert.equal(Number(insert.params[5]), 5_175);
  assert.equal(Number(insert.params[6]), 1_725, 'the discount is recorded in cents too');
});

/* ------------------------------------------------------------------ the checksum and the plan binding -------------------------------------------------------------------- */

test('payload_hash covers the amount, currency, email and reference that were actually sent', async () => {
  const { provider, checkout } = await checkoutFor({ planKey: 'starter', currency: 'NGN' });
  const body = provider.last().body;
  const recomputed = crypto.createHash('sha256')
    .update(`${body.amount}${body.currency}${body.customer.email}${body.tx_ref}${crypto.createHash('sha256').update(env.FLW_SECRET_KEY, 'utf8').digest('hex')}`, 'utf8')
    .digest('hex');
  assert.equal(body.payload_hash, recomputed, 'Flutterwave recomputes this and refuses a checkout whose fields were edited');
  assert.equal(body.payload_hash, payloadHash({ amountMinor: checkout.amountMinor, currency: checkout.currency, email: user.email, txRef: checkout.reference, secretKey: env.FLW_SECRET_KEY }));
});

test('a payment plan is attached per currency, only where the mirror is confirmed at this price', async () => {
  const snapshot = mergePlanPricing({
    config,
    planRows: { pro: { NGN: 10_500_000, USD: 6_900, interval: 'monthly', history: [], updatedAt: null, updatedBy: null } },
    providerPlans: {
      pro: {
        NGN: { planId: 42, syncStatus: 'synced', syncedAmountMinor: 10_500_000, currency: 'NGN', interval: 'monthly' },
        USD: { planId: 43, syncStatus: 'synced', syncedAmountMinor: 6_800, currency: 'USD', interval: 'monthly' },
      },
    },
  });
  const synced = await checkoutFor({ planKey: 'pro', currency: 'NGN', snapshot });
  assert.equal(synced.provider.last().body.payment_plan, 42);
  assert.equal(synced.checkout.renewsAutomatically, true);

  const stale = await checkoutFor({ planKey: 'pro', currency: 'USD', snapshot });
  assert.equal(stale.provider.last().body.payment_plan, undefined, 'a mirror a hundred cents out is not used, so the dollar customer pays the price on the page once instead of a stale price forever');
  assert.equal(stale.checkout.renewsAutomatically, false);
});

/* ----------------------------------------------- which country, and which payment methods the page offers ------------------------------------------------ */

test('a dollar checkout names the country and the one method that can settle it', async () => {
  const { provider, checkout } = await checkoutFor({ planKey: 'pro', currency: 'USD' });
  assert.equal(provider.last().body.currency, 'USD', 'the currency the toggle picked is the currency in the request, not the workspace default');
  assert.equal(provider.last().body.country, 'US', 'the country is stated so the provider does not read it off the payer');
  assert.equal(provider.last().body.payment_options, 'card', 'bank transfer and ussd are naira rails, and a dollar price offered only those is a page with no way to pay');
  assert.equal(checkout.country, 'US', 'and the same two fields travel to the browser, which configures the modal');
  assert.equal(checkout.paymentOptions, 'card');
});

test('a naira checkout keeps the local rails a naira payment can actually use', async () => {
  const { provider, checkout } = await checkoutFor({ planKey: 'pro', currency: 'NGN' });
  assert.equal(provider.last().body.currency, 'NGN');
  assert.equal(provider.last().body.country, 'NG');
  assert.equal(provider.last().body.payment_options, 'card,banktransfer,ussd', 'restricting dollars to cards must not quietly take away the methods naira customers pay with');
  assert.equal(checkout.country, 'NG');
  assert.equal(checkout.paymentOptions, 'card,banktransfer,ussd');
});

test('a charge bound to a payment plan is card-only in either currency', async () => {
  const snapshot = mergePlanPricing({
    config,
    planRows: { pro: { NGN: 10_500_000, USD: 6_900, interval: 'monthly', history: [], updatedAt: null, updatedBy: null } },
    providerPlans: {
      pro: {
        NGN: { planId: 42, syncStatus: 'synced', syncedAmountMinor: 10_500_000, currency: 'NGN', interval: 'monthly' },
      },
    },
  });
  const naira = await checkoutFor({ planKey: 'pro', currency: 'NGN', snapshot });
  assert.equal(naira.provider.last().body.payment_plan, 42, 'this checkout is the first charge of a subscription');
  assert.equal(naira.provider.last().body.payment_options, 'card', 'and a renewal is taken by card every cycle, so the local rails are not offered on a page that will be charged again');
  assert.equal(naira.provider.last().body.country, 'NG', 'the country still says which market the card belongs to');
  assert.equal(naira.checkout.renewsAutomatically, true);
  assert.equal(naira.checkout.paymentOptions, 'card', 'the modal is told the same thing the API was');
});

test('the presentation is a property of the currency, decided from a table nobody can edit at runtime', () => {
  assert.deepEqual({ ...checkoutPresentation('usd') }, { country: 'US', paymentOptions: 'card' }, 'a lower-case code from a form still resolves');
  assert.deepEqual({ ...checkoutPresentation(' NGN ') }, { country: 'NG', paymentOptions: 'card,banktransfer,ussd' });
  assert.deepEqual({ ...checkoutPresentation('EUR') }, { country: null, paymentOptions: null }, 'a currency this workspace does not price gets no guess from us');
  assert.deepEqual({ ...checkoutPresentation(null) }, { country: null, paymentOptions: null });
  assert.deepEqual({ ...checkoutPresentation('NGN', { planBound: true }) }, { country: 'NG', paymentOptions: 'card' });
  assert.deepEqual({ ...checkoutPresentation('XXX', { planBound: true }) }, { country: null, paymentOptions: 'card' }, 'an unknown currency still cannot be renewed by bank transfer');
  assert.throws(() => { CURRENCY_CHECKOUT_PRESENTATION.USD.country = 'GB'; }, TypeError, 'the rules are not mutable by anything that imported them');
});

test('a reused pending checkout carries the presentation its own row implies', async () => {
  const oneTime = {
    reference: 'sdb_pro_usd_1', authorization_url: 'https://checkout.flutterwave.com/pay/earlier', amount_minor: 6_900, currency: 'USD', plan_code: '',
  };
  const provider = flutterwaveDouble();
  const pool = poolDouble([
    ['FROM users WHERE id=$1 LIMIT 1', { rows: [user], rowCount: 1 }],
    ['FROM billing_transactions', { rows: [oneTime], rowCount: 1 }],
  ]);
  const reused = await billingFor({ provider, pool }).initialize({ userId: user.id, planKey: 'pro', currency: 'USD' });
  assert.equal(reused.reused, true);
  assert.equal(provider.requests.length, 0, 'nothing is re-initialised, so the page the browser goes back to is the page Flutterwave already built');
  assert.equal(reused.country, 'US');
  assert.equal(reused.paymentOptions, 'card');

  /* A subscription page stays a subscription page only while the mirror still agrees. The pending query pins the
     plan code, so these two cases are the whole difference between "reopen it" and "the offer changed". */
  const boundRow = {
    reference: 'sdb_pro_ngn_2', authorization_url: 'https://checkout.flutterwave.com/pay/bound', amount_minor: 10_500_000, currency: 'NGN', plan_code: '42',
  };
  const boundPool = () => poolDouble([
    ['FROM users WHERE id=$1 LIMIT 1', { rows: [user], rowCount: 1 }],
    ['FROM billing_transactions', ({ params }) => (params[3] === boundRow.plan_code ? { rows: [boundRow], rowCount: 1 } : { rows: [], rowCount: 0 })],
    ['INSERT INTO billing_transactions', { rows: [{ id: 't2' }], rowCount: 1 }],
  ]);
  const mirrored = mergePlanPricing({
    config,
    planRows: { pro: { NGN: 10_500_000, USD: 6_900, interval: 'monthly', history: [], updatedAt: null, updatedBy: null } },
    providerPlans: { pro: { NGN: { planId: 42, syncStatus: 'synced', syncedAmountMinor: 10_500_000, currency: 'NGN', interval: 'monthly' } } },
  });
  const stillBound = flutterwaveDouble();
  const reopened = await billingFor({ provider: stillBound, pool: boundPool(), snapshot: mirrored }).initialize({ userId: user.id, planKey: 'pro', currency: 'NGN' });
  assert.equal(reopened.reused, true);
  assert.equal(stillBound.requests.length, 0);
  assert.equal(reopened.paymentOptions, 'card', 'a reopened renewal page does not offer a method that cannot charge again next cycle');

  const driftedProvider = flutterwaveDouble();
  const drifted = await billingFor({ provider: driftedProvider, pool: boundPool() }).initialize({ userId: user.id, planKey: 'pro', currency: 'NGN' });
  assert.equal(drifted.reused, false, 'with no mirror to charge against, the old page is not reopened');
  assert.equal(driftedProvider.last().body.payment_plan, undefined);
  assert.equal(driftedProvider.last().body.payment_options, 'card,banktransfer,ussd', 'and a one-time naira charge offers every rail that can settle it');
});

test('the route hands the browser the whole checkout object, presentation included', () => {
  const route = indexSource.slice(
    indexSource.indexOf("app.post('/api/billing/checkout'"),
    indexSource.indexOf("app.get('/api/billing/verify'"),
  );
  assert.match(route, /\.json\(\{ checkout \}\)/, 'the service response is forwarded, not copied field by field, so a new one reaches the modal without a second edit');
  assert.match(route, /isSupportedCurrency\(requested\)/, 'and the currency is settled before a price is looked up in it');
});

/* ------------------------------------------------------------------------ currency refusals ------------------------------------------------------------------------ */

test('a currency nobody sells in, and a plan nobody priced, are both refused before a charge exists', async () => {
  const provider = flutterwaveDouble();
  const pool = poolDouble([['FROM users WHERE id=$1 LIMIT 1', { rows: [user], rowCount: 1 }]]);
  const billing = billingFor({ provider, pool });
  await assert.rejects(billing.quote({ planKey: 'pro', currency: 'EUR' }), (error) => error.code === 'CURRENCY_UNSUPPORTED' && error.status === 400);
  await assert.rejects(billing.initialize({ userId: user.id, planKey: 'pro', currency: 'gbp' }), (error) => error.code === 'CURRENCY_UNSUPPORTED');
  assert.equal(provider.requests.length, 0, 'a refused request never reaches the provider');
  await assert.rejects(billing.quote({ planKey: 'nope', currency: 'NGN' }), (error) => error.code === 'PLAN_INVALID');

  const unpriced = mergePlanPricing({ config, planRows: { pro: { NGN: 10_500_000, USD: null, interval: 'monthly', history: [], updatedAt: null, updatedBy: null } } });
  const forced = { key: 'pro', name: 'Pro', interval: 'monthly', amountMinor: 10_500_000, usdAmountMinor: null, prices: { NGN: { amountMinor: 10_500_000 } }, provider: {}, sources: { NGN: 'database', USD: 'environment' }, limits: {} };
  const pricing = { snapshot: async () => ({ ...unpriced, plans: unpriced.plans.map((plan) => (plan.key === 'pro' ? forced : plan)) }) };
  const billing2 = createBillingService({ pool, flutterwave: provider.client, pricing, config, logger: silent });
  await assert.rejects(billing2.quote({ planKey: 'pro', currency: 'USD' }), (error) => error.code === 'PLAN_NOT_PRICED' && error.status === 409);
  assert.equal(Number.isFinite(forced.usdAmountMinor), false, 'the state is "no price", not zero - a zero here would be a free plan');
});

/* ---------------------------------------------------------------------------- verification ------------------------------------------------------------------------- */

test('the webhook fulfils a payment only when amount and currency both match the stored row', async () => {
  const stored = {
    user_id: user.id, plan_key: 'pro', amount_minor: 6_900, currency: 'USD', status: 'pending', promo_code_id: null, promo_code: null, reference: 'sdb_pro_usd',
  };
  const handlers = [
    ['SELECT user_id FROM billing_transactions WHERE reference=$1', { rows: [{ user_id: user.id }], rowCount: 1 }],
    ['SELECT * FROM billing_transactions WHERE reference=$1', { rows: [stored], rowCount: 1 }],
    ['FOR UPDATE', { rows: [{ id: user.id, subscription_plan: 'free', subscription_status: 'free' }], rowCount: 1 }],
    ['SELECT plan_key,current_period_end FROM subscriptions', { rows: [], rowCount: 0 }],
    ["UPDATE billing_transactions SET status='success'", { rows: [{ id: 't1' }], rowCount: 1 }],
  ];

  const settle = async (data) => {
    const pool = poolDouble(handlers);
    const provider = flutterwaveDouble();
    const billing = billingFor({ provider, pool });
    return { result: await billing.handleWebhookEvent({ event: 'charge.completed', data: { tx_ref: 'sdb_pro_usd', ...data } }).catch((error) => error), pool };
  };

  const exact = await settle({ status: 'successful', amount: '69.00', currency: 'USD', flw_ref: 'FLW-USD-1' });
  assert.equal(exact.result.fulfilled, true);
  assert.equal(exact.result.currency, 'USD');
  const marked = exact.pool.calls.find((call) => call.sql.includes("UPDATE billing_transactions SET status='success'"));
  assert.equal(marked.params[4], 'FLW-USD-1', 'the provider receipt number is stored next to our reference');

  const wrongCurrency = (await settle({ status: 'successful', amount: 69, currency: 'NGN' })).result;
  assert.equal(wrongCurrency.code, 'CURRENCY_MISMATCH', '₦69 for a $69 plan is not the same payment');
  const short = (await settle({ status: 'successful', amount: 68.99, currency: 'USD' })).result;
  assert.equal(short.code, 'AMOUNT_MISMATCH', 'an underpayment is refused, not pro-rated into a plan');
  const over = (await settle({ status: 'successful', amount: 70, currency: 'USD' })).result;
  assert.equal(over.fulfilled, true, 'an overpayment is a customer who paid for the plan; the warning is for a human to refund the difference');
});

test('the browser redirect verifies with the provider and cannot spend somebody else’s reference', async () => {
  const stored = { user_id: user.id, plan_key: 'pro', amount_minor: 6_900, currency: 'USD', status: 'pending' };
  // Matched by parameter, because the whole point is that one reference is ours and the next one is not.
  const ours = ({ params }) => params[0] === 'sdb_pro_usd';
  const pool = poolDouble([
    ['SELECT user_id,status FROM billing_transactions WHERE reference=$1', ({ params }) => (ours({ params }) ? { rows: [{ user_id: user.id, status: 'pending' }], rowCount: 1 } : { rows: [], rowCount: 0 })],
    ['SELECT * FROM billing_transactions WHERE reference=$1', ({ params }) => (ours({ params }) ? { rows: [stored], rowCount: 1 } : { rows: [], rowCount: 0 })],
    // The read after the commit is what the response is built from, so the double answers as an account that
    // has just been upgraded - which is also the only way this test can prove the grant reached the view.
    ['FROM users WHERE id=$1 LIMIT 1', { rows: [{ ...user, subscription_status: 'active', subscription_plan: 'pro' }], rowCount: 1 }],
    ['FROM subscriptions WHERE user_id=$1 LIMIT 1', { rows: [], rowCount: 0 }],
    ['FOR UPDATE', { rows: [{ id: user.id, subscription_plan: 'free', subscription_status: 'free' }], rowCount: 1 }],
    ['SELECT plan_key,current_period_end FROM subscriptions', { rows: [], rowCount: 0 }],
    ["UPDATE billing_transactions SET status='success'", { rows: [{ id: 't1' }], rowCount: 1 }],
  ]);
  const verifyRequests = [];
  const provider = {
    requests: verifyRequests,
    client: {
      isConfigured: () => true,
      verifyTransaction: async (reference) => {
        verifyRequests.push(reference);
        return { tx_ref: reference, status: 'successful', amount: 69, currency: 'USD', flw_ref: 'FLW-1' };
      },
    },
  };
  const billing = billingFor({ provider, pool });
  const mine = await billing.verifyAndFulfill({ userId: user.id, reference: 'sdb_pro_usd' });
  assert.deepEqual(verifyRequests, ['sdb_pro_usd'], 'the provider is asked by the reference this workspace issued');
  assert.equal(mine.subscription.plan, 'pro');

  const other = await billing.verifyAndFulfill({ userId: 'someone-else', reference: 'sdb_pro_usd' }).catch((error) => error);
  assert.equal(other.code, 'REFERENCE_FORBIDDEN');
  const ghost = await billing.verifyAndFulfill({ userId: user.id, reference: 'sdb_nobody_here_000000' }).catch((error) => error);
  assert.equal(ghost.code, 'REFERENCE_NOT_FOUND', 'a reference this workspace never issued is not a payment');
});

/* ------------------------------------------------------------------------------ the gate ------------------------------------------------------------------------------ */

test('the webhook route trusts the verif-hash header and nothing else about the caller', () => {
  const route = indexSource.slice(indexSource.indexOf("app.post('/api/billing/webhook'"));
  const body = route.slice(0, route.indexOf('}));'));
  assert.ok(body.includes("req.headers['verif-hash']"), 'the documented header is what is compared');
  assert.ok(body.includes('verifyWebhookHash'), 'in constant time, by the shared helper');
  assert.ok(body.includes('flutterwaveConfig.webhookHash'), 'against FLW_WEBHOOK_HASH');
  assert.ok(body.includes('status(503)'), 'and an unconfigured workspace refuses everything');
  assert.ok(body.includes('status(401)'), 'with a 401 for a header that does not match');
  assert.ok(!/x-paystack-signature|createHmac/.test(body), 'no HMAC of the body, because that is not this provider\'s protocol');
  assert.ok(body.includes('res.json({ received: true'), 'and an event we have read is answered with a 200, whatever we did with it');

  // The comparison itself: the same function, on the same values, in both directions.
  assert.equal(verifyWebhookHash({ header: env.FLW_WEBHOOK_HASH, expectedHash: env.FLW_WEBHOOK_HASH }), true);
  assert.equal(verifyWebhookHash({ header: 'the-hash-in-the-dashboarX', expectedHash: env.FLW_WEBHOOK_HASH }), false);
  assert.equal(verifyWebhookHash({ header: 'the-hash-in-the-dashboard!', expectedHash: env.FLW_WEBHOOK_HASH }), false);
  assert.equal(verifyWebhookHash({ header: env.FLW_WEBHOOK_HASH, expectedHash: '' }), false, 'an unset FLW_WEBHOOK_HASH accepts nothing');
  assert.equal(verifyWebhookHash({ header: undefined, expectedHash: env.FLW_WEBHOOK_HASH }), false);
});

test('a reused pending checkout keeps its currency, so a toggle cannot re-price an open page', async () => {
  const pending = {
    reference: 'sdb_pro_usd_1', authorization_url: 'https://checkout.flutterwave.com/pay/earlier', amount_minor: 6_900, currency: 'USD', plan_code: '',
  };
  const provider = flutterwaveDouble();
  const pool = poolDouble([
    ['FROM users WHERE id=$1 LIMIT 1', { rows: [user], rowCount: 1 }],
    ['FROM billing_transactions', { rows: [pending], rowCount: 1 }],
  ]);
  const checkout = await billingFor({ provider, pool }).initialize({ userId: user.id, planKey: 'pro', currency: 'USD' });
  assert.equal(provider.requests.length, 0, 'the page Flutterwave already has is reopened, not re-created');
  assert.equal(checkout.reused, true);
  assert.equal(checkout.currency, 'USD');
  assert.equal(checkout.amountMinor, 6_900);
  // The hash has to be for the stored reference, which is not the one that would have been generated now.
  assert.equal(checkout.payloadHash, payloadHash({ amountMinor: 6_900, currency: 'USD', email: user.email, txRef: pending.reference, secretKey: env.FLW_SECRET_KEY }));
});
