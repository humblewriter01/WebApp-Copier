/**
 * Renewals, cancellations, and the way a provider notification is allowed to change a customer's access.
 *
 * A Flutterwave renewal is not a checkout this server started: the provider charges the saved card on its own
 * schedule and tells us afterwards, through a `subscribe.*` event whose fields we do not control. So every path
 * in here is judged on three questions - can this event be tied to exactly one account, has the money for this
 * cycle already been recorded, and does a second copy of the same notification change anything? - and an event
 * that cannot answer all three is dropped rather than guessed at.
 *
 * The provider is a scripted double, the pool a pattern matcher, and the prices come from the real merge in
 * `pricing.js`, because a test that fakes the pricing too has quietly stopped testing the part where a currency
 * is decided.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { billingConfig } from '../services/billing.js';
import { mergePlanPricing } from '../services/pricing.js';
import { createBillingService } from '../services/billing-service.js';

const config = billingConfig({ FLW_SECRET_KEY: 'sk_test', FLW_WEBHOOK_HASH: 'hash', CLIENT_URL: 'https://app.example.test' });
const silent = { info() {}, warn() {}, error() {} };

/** A snapshot in the shape the store produces: Pro at ₦105,000 and $69, NGN mirrored in Flutterwave. */
const snapshot = mergePlanPricing({
  config,
  planRows: { pro: { NGN: 10_500_000, USD: 6_900 } },
  providerPlans: { pro: { NGN: { planId: 42, syncStatus: 'synced', syncedAmountMinor: 10_500_000, currency: 'NGN', interval: 'monthly' } } },
});

/** Answers queries by SQL fragment, and records everything asked. */
function fakePool(handlers = []) {
  const calls = [];
  const query = async (sql, params = []) => {
    calls.push({ sql, params });
    for (const [pattern, answer] of handlers) {
      if (sql.includes(pattern)) {
        const value = typeof answer === 'function' ? answer({ sql, params }) : answer;
        return value ?? { rows: [], rowCount: 0 };
      }
    }
    return { rows: [], rowCount: 0 };
  };
  return { calls, query, async connect() { return { query, release() {} }; } };
}

function service({ handlers, flutterwave, pricing } = {}) {
  const pool = fakePool(handlers);
  const configured = { isConfigured: () => true, verifyTransaction: async () => ({}), cancelSubscription: async () => ({ message: 'ok' }), activateSubscription: async () => ({ message: 'ok' }) };
  return {
    pool,
    service: createBillingService({
      pool,
      flutterwave: flutterwave || configured,
      config,
      logger: silent,
      pricing: pricing === null ? null : { snapshot: async () => snapshot, planFor: async (key) => snapshot.plans.find((plan) => plan.key === key) || null },
    }),
  };
}

const payer = { id: 'u1', name: 'Payer', email: 'payer@example.com', subscription_status: 'active', subscription_plan: 'pro', plan_limits: {} };
const subscriptionRow = {
  id: 's1', user_id: 'u1', plan_key: 'pro', status: 'active', interval: 'monthly', currency: 'NGN',
  current_period_end: '2026-11-01T00:00:00.000Z', cancel_at_period_end: false, provider_subscription_code: '4242',
};
const byEmail = ['FROM users WHERE lower(email)=$1', { rows: [{ id: 'u1' }], rowCount: 1 }];
const subById = ['FROM subscriptions WHERE user_id=$1 LIMIT 1', { rows: [subscriptionRow], rowCount: 1 }];
const subForEvent = ['FROM subscriptions WHERE user_id=$1 LIMIT 1', { rows: [{ id: 's1', userId: 'u1', current_period_end: '2026-11-01T00:00:00.000Z' }], rowCount: 1 }];

/* ------------------------------- event routing ------------------------------- */

test('a charge event finds its own row, and anything it cannot name is dropped', async () => {
  const stored = { user_id: 'u1', plan_key: 'pro', amount_minor: 10_500_000, currency: 'NGN', status: 'pending', promo_code_id: null, promo_code: null };
  const { service: billing } = service({ handlers: [
    byEmail,
    // One reference belongs to this workspace; every other is unknown to it - which is exactly the
    // distinction a webhook must not get wrong, so the double answers by parameter, not by shape.
    ['SELECT user_id FROM billing_transactions WHERE reference=$1', ({ params }) => (params[0] === 'sdb_u1_1_abc' ? { rows: [{ user_id: 'u1' }], rowCount: 1 } : { rows: [], rowCount: 0 })],
    ['SELECT * FROM billing_transactions WHERE reference=$1', ({ params }) => (params[0] === 'sdb_u1_1_abc' ? { rows: [stored], rowCount: 1 } : { rows: [], rowCount: 0 })],
    ['FOR UPDATE', { rows: [payer], rowCount: 1 }],
    ['SELECT plan_key,current_period_end FROM subscriptions', { rows: [{ plan_key: 'pro', current_period_end: '2026-11-01T00:00:00.000Z' }], rowCount: 1 }],
    ["UPDATE billing_transactions SET status='success'", { rows: [{ id: 't1' }], rowCount: 1 }],
  ] });

  const result = await billing.handleWebhookEvent({
    event: 'charge.completed',
    data: { id: 991, tx_ref: 'sdb_u1_1_abc', flw_ref: 'FLW-1', status: 'successful', amount: 105000, currency: 'NGN', payment_type: 'card', created_at: '2026-10-01T10:00:00.000Z' },
  });
  assert.equal(result.handled, true);
  assert.equal(result.fulfilled, true, 'a verified charge grants the plan exactly once');
  assert.equal(result.currency, 'NGN');
  assert.equal(result.event, 'charge.completed');

  const unknown = await billing.handleWebhookEvent({ event: 'charge.completed', data: { tx_ref: 'sdb_nobody_1_def', status: 'successful', amount: 1, currency: 'NGN' } });
  assert.equal(unknown.handled, false);
  assert.equal(unknown.reason, 'unknown-reference', 'a payment for a reference we never issued changes nothing');

  assert.equal((await billing.handleWebhookEvent({ event: 'charge.completed', data: { tx_ref: '!!', status: 'successful' } })).reason, 'invalid-reference');
  assert.deepEqual(await billing.handleWebhookEvent({ event: 'payout.issued', data: {} }), { handled: false, event: 'payout.issued' });
  assert.deepEqual(await billing.handleWebhookEvent({}), { handled: false, event: '' });
});

test('an event that says the charge did not succeed never grants access', async () => {
  const stored = { user_id: 'u1', plan_key: 'pro', amount_minor: 10_500_000, currency: 'NGN', status: 'pending' };
  const { pool, service: billing } = service({ handlers: [
    ['SELECT user_id FROM billing_transactions WHERE reference=$1', { rows: [{ user_id: 'u1' }], rowCount: 1 }],
    ['SELECT * FROM billing_transactions WHERE reference=$1', { rows: [stored], rowCount: 1 }],
    ['UPDATE billing_transactions SET status=$2', { rows: [], rowCount: 1 }],
  ] });
  const result = await billing.fulfillTransaction('sdb_u1_1_abc', { tx_ref: 'sdb_u1_1_abc', status: 'failed', amount: 105000, currency: 'NGN', processor_response: 'card declined' });
  assert.equal(result.fulfilled, false);
  assert.equal(result.status, 'failed');
  const marked = pool.calls.find((call) => call.sql.includes('UPDATE billing_transactions SET status=$2'));
  assert.ok(marked, 'the row is marked so the panel can say why');
  assert.equal(marked.params[1], 'failed');
  assert.equal(marked.params[2], 'card declined', 'the processor response is kept, because it is the only sentence a customer can be told');
  assert.equal(pool.calls.some((call) => call.sql.includes('UPDATE users SET subscription_status')), false);
});

test('an unmapped subscribe event is logged and left alone, not guessed', async () => {
  const logged = [];
  const pool = fakePool([byEmail, subForEvent]);
  const billing = createBillingService({
    pool,
    flutterwave: { isConfigured: () => true },
    config,
    logger: { info: (message, extra) => logged.push([message, extra]), warn() {}, error() {} },
    pricing: { snapshot: async () => snapshot },
  });
  const result = await billing.handleWebhookEvent({ event: 'subscribe.something_new', data: { id: 5, customer: { email: 'payer@example.com' } } });
  assert.equal(result.handled, false);
  assert.equal(logged.some(([message]) => /unmapped/i.test(message)), true, 'a name we do not know is a line in the log, not silence');
});

/* -------------------------------- renewals --------------------------------- */

test('a renewal extends the period once, in the currency of the plan, and records the charge', async () => {
  const { pool, service: billing } = service({ handlers: [
    byEmail,
    subById,
    ['ON CONFLICT(reference) DO NOTHING RETURNING id', { rows: [{ id: 't1' }], rowCount: 1 }],
  ] });
  const result = await billing.handleWebhookEvent({
    event: 'subscribe.renewed',
    data: {
      id: 4242, status: 'renewed', amount: '105000.00', currency: 'NGN', created_at: '2026-11-01T08:00:00.000Z', next_due_date: '2026-12-01T08:00:00.000Z',
      plan: { id: 42, interval: 'monthly', currency: 'NGN' }, customer: { email: 'payer@example.com' },
    },
  });
  assert.equal(result.handled, true);
  assert.equal(result.fulfilled, true);
  assert.equal(result.kind, 'renewal');
  assert.equal(result.plan, 'pro');
  assert.equal(result.currency, 'NGN');
  assert.ok(new Date(result.currentPeriodEnd).getTime() > new Date('2026-11-01T00:00:00.000Z').getTime(), 'a renewal during a paid period adds time instead of resetting it');

  const insert = pool.calls.find((call) => call.sql.includes('INSERT INTO billing_transactions'));
  assert.equal(insert.params[1], 'sdb_flwsub_4242_20261201', 'the reference is the cycle, so a replay lands on the same row');
  assert.equal(insert.params[3], 10_500_000, '₦105,000 is stored as 10,500,000 of the smallest unit');
  assert.equal(insert.params[4], 'NGN');
  assert.equal(insert.sql.includes("'renewal'"), true, 'renewals are distinguishable from checkouts');
  assert.equal(insert.sql.includes("'flutterwave'"), true);
  const userUpdate = pool.calls.find((call) => call.sql.includes('UPDATE users SET'));
  assert.match(userUpdate.sql, /subscription_status='active'/);
});

test('a replayed renewal changes nothing, and an unknown customer or plan is ignored', async () => {
  const { pool, service: billing } = service({ handlers: [
    byEmail,
    subById,
    ['ON CONFLICT(reference) DO NOTHING RETURNING id', { rows: [], rowCount: 0 }],
  ] });
  const replay = await billing.fulfillRenewal({ renewalKey: 'sdb_flwsub_4242_20261201', email: 'payer@example.com', amountMinor: 10_500_000, currency: 'NGN', subscriptionId: 4242, planId: 42, paidAt: null, interval: 'monthly' });
  assert.equal(replay.alreadyProcessed, true);
  assert.equal(replay.fulfilled, false);
  assert.equal(pool.calls.filter((call) => call.sql.includes('UPDATE users')).length, 0, 'no second extension, ever');

  const empty = service();
  assert.equal((await empty.service.fulfillRenewal({})).reason, 'invalid-renewal-reference');
  assert.equal((await empty.service.fulfillRenewal({ renewalKey: 'k', amountMinor: null })).reason, 'unknown-amount');
  assert.equal((await empty.service.fulfillRenewal({ renewalKey: 'k', amountMinor: 100, email: 'ghost@example.com' })).reason, 'unmapped-customer');

  const noSubscription = service({ handlers: [byEmail, ['FROM subscriptions WHERE user_id=$1 LIMIT 1', { rows: [], rowCount: 0 }]] });
  assert.equal((await noSubscription.service.fulfillRenewal({ renewalKey: 'k', amountMinor: 100, email: 'payer@example.com' })).reason, 'no-subscription');
});

test('a renewal in a currency nobody priced is still attributed to the account, but stated in the plan currency', async () => {
  const { pool, service: billing } = service({ handlers: [
    byEmail,
    subById,
    ['ON CONFLICT(reference) DO NOTHING RETURNING id', { rows: [{ id: 't1' }], rowCount: 1 }],
  ] });
  const result = await billing.fulfillRenewal({ renewalKey: 'sdb_flwsub_4242_20270101', email: 'payer@example.com', amountMinor: 69_00, currency: 'USD', subscriptionId: 4242, planId: 42, paidAt: null, interval: 'monthly' });
  assert.equal(result.fulfilled, true);
  assert.equal(result.currency, 'USD', 'the currency the provider charged is stored, not assumed from the workspace default');
  const insert = pool.calls.find((call) => call.sql.includes('INSERT INTO billing_transactions'));
  assert.equal(insert.params[4], 'USD');
});

/* ------------------------------ lifecycle events ----------------------------- */

test('a cancellation at the provider keeps access until the paid period ends', async () => {
  const future = service({ handlers: [
    byEmail,
    ['FROM subscriptions WHERE user_id=$1 LIMIT 1', { rows: [{ id: 's1', userId: 'u1', current_period_end: new Date(Date.now() + 864000000).toISOString() }], rowCount: 1 }],
  ] });
  const stillPaid = await future.service.handleWebhookEvent({ event: 'subscribe.cancelled', data: { id: 4242, customer: { email: 'payer@example.com' } } });
  assert.equal(stillPaid.kind, 'canceled');
  const futureUpdate = future.pool.calls.find((call) => call.sql.includes('UPDATE users SET'));
  assert.match(futureUpdate.sql, /subscription_status='non_renewing'/, 'access continues until the paid period ends');

  const past = service({ handlers: [
    byEmail,
    ['FROM subscriptions WHERE user_id=$1 LIMIT 1', { rows: [{ id: 's1', userId: 'u1', current_period_end: '2020-01-01T00:00:00.000Z' }], rowCount: 1 }],
  ] });
  await past.service.handleWebhookEvent({ event: 'subscribe.disabled', data: { id: 4242, customer: { email: 'payer@example.com' } } });
  const downgrade = past.pool.calls.find((call) => call.sql.includes('UPDATE users SET'));
  assert.match(downgrade.sql, /subscription_status='free'/, 'an ended period drops to the free plan');
});

test('a failed charge marks the subscription past due, and a resumed one active again', async () => {
  for (const [event, kind] of [['subscribe.payment_failed', 'past_due'], ['subscribe.failed', 'past_due'], ['subscribe.enabled', 'active'], ['subscribe.reactivated', 'active']]) {
    const { pool, service: billing } = service({ handlers: [byEmail, subForEvent] });
    const result = await billing.handleWebhookEvent({ event, data: { id: 4242, customer: { email: 'payer@example.com' } } });
    assert.equal(result.kind, kind, event);
    assert.ok(pool.calls.some((call) => call.sql.includes('UPDATE')), `${event} writes state`);
    assert.equal(pool.calls.some((call) => call.sql.includes('INSERT INTO billing_transactions')), false, `${event} does not invent a payment`);
  }
});

test('the subscription id from a create event is stored so cancel and resume have something to call', async () => {
  const { pool, service: billing } = service({ handlers: [byEmail, subForEvent] });
  const result = await billing.handleWebhookEvent({ event: 'subscribe.created', data: { id: 9999, status: 'active', customer: { email: 'payer@example.com' } } });
  assert.equal(result.kind, 'provider-code');
  assert.equal(result.subscriptionId, 9999);
  const written = pool.calls.find((call) => call.sql.includes('provider_subscription_code=$2'));
  assert.equal(written.params[1], '9999', 'the id is stored as text, which is what the provider echoes back');

  const noId = await billing.handleWebhookEvent({ event: 'subscribe.created', data: { customer: { email: 'payer@example.com' } } });
  assert.equal(noId.reason, 'no-subscription-id');

  const stranger = service({ handlers: [['FROM users WHERE lower(email)=$1', { rows: [], rowCount: 0 }]] });
  assert.equal((await stranger.service.handleWebhookEvent({ event: 'subscribe.created', data: { id: 1, customer: { email: 'nobody@example.com' } } })).reason, 'unmapped-customer');
});

/* ---------------------------- cancel and resume ---------------------------- */

test('cancelling a Flutterwave subscription also cancels it at Flutterwave, and resume needs only the id', async () => {
  const calls = [];
  const flutterwave = {
    isConfigured: () => true,
    cancelSubscription: async (id) => { calls.push(`cancel:${id}`); return { message: 'Subscription cancelled' }; },
    activateSubscription: async (id) => { calls.push(`activate:${id}`); return { message: 'ok' }; },
  };
  const { service: billing } = service({
    flutterwave,
    handlers: [
      ['FROM users WHERE id=$1 LIMIT 1', { rows: [payer], rowCount: 1 }],
      subById,
      ['UPDATE subscriptions SET cancel_at_period_end=TRUE', { rows: [{ ...subscriptionRow, cancel_at_period_end: true }], rowCount: 1 }],
      ['UPDATE subscriptions SET cancel_at_period_end=FALSE', { rows: [{ ...subscriptionRow, cancel_at_period_end: false }], rowCount: 1 }],
    ],
  });

  const canceled = await billing.cancel({ userId: 'u1' });
  assert.deepEqual(calls, ['cancel:4242']);
  assert.equal(canceled.provider.status, 'cancelled');
  assert.equal(canceled.cancelAtPeriodEnd, true);
  assert.equal(canceled.plan, 'pro', 'cancelling does not remove access');

  const resumed = await billing.resume({ userId: 'u1' });
  assert.deepEqual(calls[1], 'activate:4242', 'restarting takes only the subscription id - no email token, no authorization code');
  assert.equal(resumed.provider.status, 'activated');
});

test('a provider failure is reported but never blocks the user action', async () => {
  const down = new Error('down');
  down.status = 502;
  down.code = 'FLUTTERWAVE_NETWORK_ERROR';
  down.userMessage = 'The payment provider could not be reached.';
  const flutterwave = {
    isConfigured: () => true,
    cancelSubscription: async () => { throw down; },
    activateSubscription: async () => { throw down; },
  };
  const { service: billing } = service({
    flutterwave,
    handlers: [
      ['FROM users WHERE id=$1 LIMIT 1', { rows: [payer], rowCount: 1 }],
      subById,
      ['UPDATE subscriptions SET cancel_at_period_end=TRUE', { rows: [{ ...subscriptionRow, cancel_at_period_end: true }], rowCount: 1 }],
      ['UPDATE subscriptions SET cancel_at_period_end=FALSE', { rows: [{ ...subscriptionRow, cancel_at_period_end: false }], rowCount: 1 }],
    ],
  });
  const canceled = await billing.cancel({ userId: 'u1' });
  assert.equal(canceled.provider.status, 'failed');
  assert.match(canceled.provider.message, /try cancelling again/i);
  const resumed = await billing.resume({ userId: 'u1' });
  assert.equal(resumed.provider.status, 'failed');
  assert.match(resumed.provider.message, /contact support/i);
});

test('without a linked subscription the action stays local and says so; without a key it says that too', async () => {
  const unlinked = service({
    handlers: [
      ['FROM users WHERE id=$1 LIMIT 1', { rows: [payer], rowCount: 1 }],
      ['FROM subscriptions WHERE user_id=$1 LIMIT 1', { rows: [{ ...subscriptionRow, provider_subscription_code: null }], rowCount: 1 }],
      ['UPDATE subscriptions SET cancel_at_period_end=TRUE', { rows: [{ ...subscriptionRow, cancel_at_period_end: true }], rowCount: 1 }],
      ['UPDATE subscriptions SET cancel_at_period_end=FALSE', { rows: [{ ...subscriptionRow, cancel_at_period_end: false }], rowCount: 1 }],
    ],
  });
  assert.match((await unlinked.service.cancel({ userId: 'u1' })).provider.status, /local-only/);
  assert.match((await unlinked.service.resume({ userId: 'u1' })).provider.status, /local-only/);

  const notConfigured = service({
    flutterwave: { isConfigured: () => false },
    handlers: [
      ['FROM users WHERE id=$1 LIMIT 1', { rows: [payer], rowCount: 1 }],
      subById,
      ['UPDATE subscriptions SET cancel_at_period_end=TRUE', { rows: [{ ...subscriptionRow, cancel_at_period_end: true }], rowCount: 1 }],
      ['UPDATE subscriptions SET cancel_at_period_end=FALSE', { rows: [{ ...subscriptionRow, cancel_at_period_end: false }], rowCount: 1 }],
    ],
  });
  assert.equal((await notConfigured.service.cancel({ userId: 'u1' })).provider.status, 'not_configured');
});

test('an ended subscription cannot be resumed, and a free account has nothing to cancel', async () => {
  const ended = service({
    handlers: [
      ['FROM users WHERE id=$1 LIMIT 1', { rows: [payer], rowCount: 1 }],
      ['FROM subscriptions WHERE user_id=$1 LIMIT 1', { rows: [{ ...subscriptionRow, status: 'canceled' }], rowCount: 1 }],
    ],
  });
  await assert.rejects(ended.service.resume({ userId: 'u1' }), (error) => error.code === 'SUBSCRIPTION_ENDED' && error.status === 409);
  await assert.rejects(ended.service.cancel({ userId: 'u1' }), (error) => error.code === 'SUBSCRIPTION_NONE');

  const nothing = service({ handlers: [['FROM users WHERE id=$1 LIMIT 1', { rows: [payer], rowCount: 1 }]] });
  await assert.rejects(nothing.service.cancel({ userId: 'u1' }), (error) => error.code === 'SUBSCRIPTION_NONE');
});

/* --------------------------------- expiry ---------------------------------- */

test('a period that has ended is closed once, and a failing row does not stop the sweep', async () => {
  const pool = fakePool([
    ['FROM subscriptions s JOIN users u', { rows: [{ user_id: 'u1' }, { user_id: 'u2' }], rowCount: 2 }],
    ["UPDATE subscriptions SET status='canceled'", { rows: [], rowCount: 1 }],
    ["UPDATE users SET subscription_status='free'", { rows: [], rowCount: 1 }],
  ]);
  const billing = createBillingService({
    pool,
    flutterwave: { isConfigured: () => true },
    config,
    logger: silent,
    pricing: { snapshot: async () => snapshot },
  });
  const expired = await billing.expireDueSubscriptions();
  assert.deepEqual(expired, ['u1', 'u2'], 'both accounts are swept, each in its own transaction');

  const failing = fakePool([
    ['FROM subscriptions s JOIN users u', { rows: [{ user_id: 'u1' }, { user_id: 'u2' }], rowCount: 2 }],
    ["UPDATE subscriptions SET status='canceled'", ({ params }) => { if (params[0] === 'u2') throw new Error('lock timeout'); return { rows: [], rowCount: 1 }; }],
  ]);
  const billing2 = createBillingService({ pool: failing, flutterwave: { isConfigured: () => true }, config, logger: silent, pricing: { snapshot: async () => snapshot } });
  assert.deepEqual(await billing2.expireDueSubscriptions(), ['u1'], 'one account that will not move does not roll the others back');
});

test('the store is optional: with no pricing table the environment prices are what is charged', async () => {
  const { service: billing } = service({ pricing: null, handlers: [['FROM users WHERE id=$1 LIMIT 1', { rows: [payer], rowCount: 1 }]] });
  const quote = await billing.quote({ planKey: 'pro', currency: 'NGN' });
  assert.equal(quote.amountMinor, 10_500_000);
  assert.equal(quote.currency, 'NGN');
  assert.equal(quote.providerAmount, 105_000, 'a one-time charge is still the major unit');
  const dollar = await billing.quote({ planKey: 'pro', currency: 'USD' });
  assert.equal(dollar.amountMinor, 6_900);
  assert.equal(dollar.providerAmount, 69);
  assert.equal(dollar.priceSource, 'environment', 'nothing is stored, so the deployed default is named as the source');
});
