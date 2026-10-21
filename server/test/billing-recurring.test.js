import test from 'node:test';
import assert from 'node:assert/strict';
import { eventCustomerEmail, toSafeInvoice, toSafeSubscriptionEvent } from '../services/billing.js';
import { createBillingService } from '../services/billing-service.js';
import { billingConfig } from '../services/billing.js';

const config = billingConfig({ PAYSTACK_SECRET_KEY: 'sk_test' });
const silent = { info() {}, warn() {}, error() {} };

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

function service({ handlers, paystack, pricing } = {}) {
  const pool = fakePool(handlers);
  return { pool, service: createBillingService({ pool, paystack: paystack || { isConfigured: () => true }, config, pricing: pricing ?? null, logger: silent }) };
}

/* ------------------------------ payload parsing ----------------------------- */

test('invoice payloads are read defensively', () => {
  const paid = toSafeInvoice({
    invoice_code: 'INV_thy2vkmirn2urwv', status: 'success', paid: true, paid_at: '2026-10-02T10:00:06.000Z', amount: 300000, currency: 'ngn',
    customer: { email: 'Payer@Example.com' }, subscription: { subscription_code: 'SUB_1', next_payment_date: '2026-11-02T00:00:00.000Z' },
  });
  assert.equal(paid.invoiceCode, 'INV_thy2vkmirn2urwv');
  assert.equal(paid.paid, true);
  assert.equal(paid.amountMinor, 300000);
  assert.equal(paid.currency, 'NGN');
  assert.equal(paid.email, 'payer@example.com');
  assert.equal(paid.subscriptionCode, 'SUB_1');

  const upcoming = toSafeInvoice({ invoice_code: 'INV_pending_1', status: 'pending', amount: 100 });
  assert.equal(upcoming.paid, false);
  assert.equal(toSafeInvoice({ id: 42, status: 'paid', total_amount: 2500 }).invoiceCode, 'invt_42', 'an id is used when no invoice code is present');
  assert.equal(toSafeInvoice({ invoice_code: 'nope!!', id: 1 }).invoiceCode, null, 'an unusable key cannot become a transaction reference');
  assert.equal(toSafeInvoice({}).amountMinor, null);
  assert.equal(toSafeInvoice().paid, false);
  assert.equal(eventCustomerEmail({ authorization: { email: 'a@b.com' } }), 'a@b.com');
  assert.equal(eventCustomerEmail({ email: 'not-an-email' }), null);
  assert.equal(toSafeSubscriptionEvent({ subscription_code: 'SUB_2', amount: '300000', status: 'ACTIVE', plan: { plan_code: 'PLN_x' }, customer: { email: 'x@y.com' } }).subscriptionCode, 'SUB_2');
  assert.equal(toSafeSubscriptionEvent({}).planCode, null);
});

/* ------------------------------- renewals ---------------------------------- */

const subscriptionRow = { id: 's1', plan_key: 'pro', status: 'active', interval: 'monthly', current_period_end: '2026-11-01T00:00:00.000Z' };

test('a paid renewal invoice extends the period once and records the charge', async () => {
  const handlers = [
    ['FROM users WHERE lower(email)', { rows: [{ id: 'u1' }], rowCount: 1 }],
    ['FROM subscriptions WHERE user_id', { rows: [subscriptionRow], rowCount: 1 }],
    ['ON CONFLICT(reference) DO NOTHING', { rows: [{ id: 't1' }], rowCount: 1 }],
  ];
  const { pool, service: billing } = service({ handlers });
  const invoice = toSafeInvoice({ invoice_code: 'INV_renew_1', status: 'success', paid: true, amount: 300000, currency: 'NGN', customer: { email: 'payer@example.com' } });
  const result = await billing.fulfillRenewal(invoice);

  assert.equal(result.fulfilled, true);
  assert.equal(result.kind, 'renewal');
  assert.equal(result.plan, 'pro');
  assert.ok(result.currentPeriodEnd > subscriptionRow.current_period_end, 'a renewal during a paid period adds time instead of resetting it');
  const insert = pool.calls.find((call) => call.sql.includes('INSERT INTO billing_transactions'));
  assert.equal(insert.params[0], 'u1');
  assert.equal(insert.params[1], 'INV_renew_1');
  assert.equal(insert.params[2], 'pro');
  assert.equal(insert.params[3], 300000);
  assert.equal(insert.sql.includes("'renewal'"), true, 'renewals are distinguishable from checkouts');
  const userUpdate = pool.calls.find((call) => call.sql.includes('UPDATE users SET'));
  assert.match(userUpdate.sql, /subscription_status='active'/);
  const subscriptionUpdate = pool.calls.find((call) => call.sql.includes('UPDATE subscriptions SET'));
  assert.match(subscriptionUpdate.sql, /cancel_at_period_end=FALSE/);
});

test('a replayed renewal invoice changes nothing', async () => {
  const { pool, service: billing } = service({ handlers: [
    ['FROM users WHERE lower(email)', { rows: [{ id: 'u1' }], rowCount: 1 }],
    ['FROM subscriptions WHERE user_id', { rows: [subscriptionRow], rowCount: 1 }],
    ['ON CONFLICT(reference) DO NOTHING', { rows: [], rowCount: 0 }],
  ] });
  const result = await billing.fulfillRenewal(toSafeInvoice({ invoice_code: 'INV_renew_1', paid: true, amount: 300000, currency: 'NGN', customer: { email: 'payer@example.com' } }));
  assert.equal(result.alreadyProcessed, true);
  assert.equal(result.fulfilled, false);
  assert.equal(pool.calls.filter((call) => call.sql.includes('UPDATE users')).length, 0, 'no second extension, ever');
});

test('unpaid, unmapped, and unknown invoices are ignored, not guessed', async () => {
  const { service: billing } = service();
  assert.equal((await billing.fulfillRenewal(toSafeInvoice({ invoice_code: 'INV_pending_2', status: 'pending', customer: { email: 'a@b.com' } }))).reason, 'invoice-not-paid');
  assert.equal((await billing.fulfillRenewal(toSafeInvoice({ status: 'success', customer: { email: 'a@b.com' } }))).reason, 'invalid-invoice');
  assert.equal((await billing.fulfillRenewal(toSafeInvoice({ invoice_code: 'INV_nocust_1', paid: true, amount: 100, customer: {} }))).reason, 'unmapped-customer');
  assert.equal((await billing.fulfillRenewal(toSafeInvoice({ invoice_code: 'INV_noamount_1', paid: true, customer: { email: 'a@b.com' } }))).reason, 'unknown-amount');

  const noUser = service({ handlers: [['FROM users WHERE lower(email)', { rows: [], rowCount: 0 }]] });
  assert.equal((await noUser.service.fulfillRenewal(toSafeInvoice({ invoice_code: 'INV_ghost_1', paid: true, amount: 100, customer: { email: 'ghost@example.com' } }))).reason, 'unmapped-customer');

  const noSubscription = service({ handlers: [['FROM users WHERE lower(email)', { rows: [{ id: 'u1' }], rowCount: 1 }], ['FROM subscriptions WHERE user_id', { rows: [], rowCount: 0 }]] });
  assert.equal((await noSubscription.service.fulfillRenewal(toSafeInvoice({ invoice_code: 'INV_nosub_1', paid: true, amount: 100, customer: { email: 'a@b.com' } }))).reason, 'no-subscription');
});

/* ------------------------------ event routing ------------------------------ */

test('webhook events are routed by name and unknown events are inert', async () => {
  const { service: billing } = service({ handlers: [
    ['FROM users WHERE lower(email)', { rows: [{ id: 'u1' }], rowCount: 1 }],
    ['FROM subscriptions WHERE user_id', { rows: [subscriptionRow], rowCount: 1 }],
    ['ON CONFLICT(reference) DO NOTHING', { rows: [{ id: 't1' }], rowCount: 1 }],
  ] });
  assert.deepEqual(await billing.handleWebhookEvent({ event: 'transfer.success', data: {} }), { handled: false, event: 'transfer.success' });
  assert.deepEqual(await billing.handleWebhookEvent({}), { handled: false, event: '' });

  const renewed = await billing.handleWebhookEvent({ event: 'invoice.update', data: { invoice_code: 'INV_r2', status: 'success', paid: true, amount: 300000, currency: 'NGN', customer: { email: 'payer@example.com' } } });
  assert.equal(renewed.handled, true);
  assert.equal(renewed.kind, 'renewal');

  const upcoming = await billing.handleWebhookEvent({ event: 'invoice.create', data: { invoice_code: 'INV_r3', status: 'pending', customer: { email: 'payer@example.com' } } });
  assert.equal(upcoming.handled, false);
  assert.equal(upcoming.reason, 'invoice-not-paid');
});

test('subscription lifecycle events keep Signal Desk and Paystack in step', async () => {
  const cases = [
    { event: 'subscription.create', expect: { kind: 'provider-code' }, data: { subscription_code: 'SUB_new', customer: { email: 'payer@example.com' } } },
    { event: 'subscription.not_renew', expect: { kind: 'non_renewing' }, data: { subscription_code: 'SUB_new', customer: { email: 'payer@example.com' } } },
    { event: 'subscription.enable', expect: { kind: 'active' }, data: { subscription_code: 'SUB_new', customer: { email: 'payer@example.com' } } },
    { event: 'invoice.payment_failed', expect: { kind: 'past_due' }, data: { invoice_code: 'INV_fail', status: 'pending', customer: { email: 'payer@example.com' } } },
  ];
  for (const testCase of cases) {
    const { pool, service: billing } = service({ handlers: [
      ['FROM users WHERE lower(email)', { rows: [{ id: 'u1' }], rowCount: 1 }],
      ['FROM subscriptions WHERE user_id', { rows: [{ ...subscriptionRow, userId: 'u1' }], rowCount: 1 }],
    ] });
    const result = await billing.handleWebhookEvent({ event: testCase.event, data: testCase.data });
    assert.equal(result.handled, true, testCase.event);
    assert.equal(result.kind, testCase.expect.kind, testCase.event);
    const written = pool.calls.filter((call) => call.sql.includes('UPDATE'));
    assert.ok(written.length >= 1, `${testCase.event} writes state`);
    assert.equal(pool.calls.some((call) => call.sql.includes('INSERT INTO billing_transactions')), false, `${testCase.event} does not invent a payment`);
  }
});

test('a provider cancellation ends access only when the paid period is over', async () => {
  const future = service({ handlers: [
    ['FROM users WHERE lower(email)', { rows: [{ id: 'u1' }], rowCount: 1 }],
    ['FROM subscriptions WHERE user_id', { rows: [{ ...subscriptionRow, current_period_end: new Date(Date.now() + 864000000).toISOString() }], rowCount: 1 }],
  ] });
  const stillPaid = await future.service.handleWebhookEvent({ event: 'subscription.disable', data: { subscription_code: 'SUB_new', customer: { email: 'payer@example.com' } } });
  assert.equal(stillPaid.kind, 'canceled');
  const futureUpdate = future.pool.calls.find((call) => call.sql.includes('UPDATE users'));
  assert.match(futureUpdate.sql, /subscription_status='non_renewing'/, 'access continues until the paid period ends');

  const past = service({ handlers: [
    ['FROM users WHERE lower(email)', { rows: [{ id: 'u1' }], rowCount: 1 }],
    ['FROM subscriptions WHERE user_id', { rows: [{ ...subscriptionRow, current_period_end: '2020-01-01T00:00:00.000Z' }], rowCount: 1 }],
  ] });
  await past.service.handleWebhookEvent({ event: 'subscription.disable', data: { subscription_code: 'SUB_new', customer: { email: 'payer@example.com' } } });
  const downgrade = past.pool.calls.find((call) => call.sql.includes('UPDATE users'));
  assert.match(downgrade.sql, /subscription_status='free'/, 'an ended period drops to the free plan');
});

test('a subscription event for a stranger is ignored', async () => {
  const { service: billing } = service({ handlers: [['FROM users WHERE lower(email)', { rows: [], rowCount: 0 }]] });
  const result = await billing.handleWebhookEvent({ event: 'subscription.create', data: { subscription_code: 'SUB_x', customer: { email: 'nobody@example.com' } } });
  assert.equal(result.handled, false);
  assert.equal(result.reason, 'unmapped-customer');
  const noCode = await billing.handleWebhookEvent({ event: 'subscription.create', data: { customer: { email: 'nobody@example.com' } } });
  assert.equal(noCode.reason, 'no-subscription-code');
});

/* --------------------------- cancel and resume ----------------------------- */

const payerUser = { id: 'u1', name: 'Payer', email: 'payer@example.com', subscription_status: 'active', subscription_plan: 'pro', plan_limits: {} };

test('cancelling a Paystack-backed subscription also disables it at Paystack', async () => {
  const calls = [];
  const paystack = {
    isConfigured: () => true,
    disableSubscription: async (code) => { calls.push(code); return { message: 'Subscription cancelled' }; },
    fetchSubscription: async () => ({ emailToken: 'tok', authorizationCode: 'AUTH_1' }),
    enableSubscription: async (input) => { calls.push(`enable:${input.code}:${input.token}:${input.authorization}`); return { message: 'ok' }; },
  };
  const { pool, service: billing } = service({
    paystack,
    handlers: [
      ['FROM users WHERE id=$1', { rows: [payerUser], rowCount: 1 }],
      ['FROM subscriptions WHERE user_id=$1 LIMIT 1', { rows: [{ id: 's1', user_id: 'u1', plan_key: 'pro', status: 'active', interval: 'monthly', provider_subscription_code: 'SUB_1', current_period_end: '2026-11-01T00:00:00.000Z', cancel_at_period_end: false }], rowCount: 1 }],
      ['UPDATE subscriptions SET cancel_at_period_end=TRUE', { rows: [{ id: 's1', user_id: 'u1', plan_key: 'pro', status: 'active', interval: 'monthly', provider_subscription_code: 'SUB_1', cancel_at_period_end: true, current_period_end: '2026-11-01T00:00:00.000Z' }], rowCount: 1 }],
      ['UPDATE subscriptions SET cancel_at_period_end=FALSE', { rows: [{ id: 's1', user_id: 'u1', plan_key: 'pro', status: 'active', interval: 'monthly', provider_subscription_code: 'SUB_1', cancel_at_period_end: false, current_period_end: '2026-11-01T00:00:00.000Z' }], rowCount: 1 }],
    ],
  });

  const canceled = await billing.cancel({ userId: 'u1' });
  assert.deepEqual(calls, ['SUB_1']);
  assert.equal(canceled.provider.status, 'disabled');
  assert.equal(canceled.cancelAtPeriodEnd, true);
  assert.equal(canceled.plan, 'pro', 'cancelling does not remove access');

  const resumed = await billing.resume({ userId: 'u1' });
  assert.equal(resumed.provider.status, 'enabled');
  assert.equal(calls[1], 'enable:SUB_1:tok:AUTH_1', 'Paystack needs the email token and authorization to restart a subscription');
  assert.ok(pool.calls.some((call) => call.sql.includes('RETURNING *')));
});

test('a Paystack failure is reported but never blocks the user action', async () => {
  const paystack = {
    isConfigured: () => true,
    disableSubscription: async () => { throw Object.assign(new Error('down'), { status: 502, code: 'PAYSTACK_NETWORK_ERROR', userMessage: 'The payment provider could not be reached.' }); },
    fetchSubscription: async () => { throw Object.assign(new Error('down'), { status: 502, code: 'PAYSTACK_NETWORK_ERROR', userMessage: 'The payment provider could not be reached.' }); },
  };
  const { service: billing } = service({
    paystack,
    handlers: [
      ['FROM users WHERE id=$1', { rows: [payerUser], rowCount: 1 }],
      ['FROM subscriptions WHERE user_id=$1 LIMIT 1', { rows: [{ id: 's1', user_id: 'u1', plan_key: 'pro', status: 'active', interval: 'monthly', provider_subscription_code: 'SUB_1', cancel_at_period_end: false }], rowCount: 1 }],
      ['UPDATE subscriptions SET cancel_at_period_end=TRUE', { rows: [{ id: 's1', user_id: 'u1', plan_key: 'pro', status: 'active', interval: 'monthly', provider_subscription_code: 'SUB_1', cancel_at_period_end: true }], rowCount: 1 }],
      ['UPDATE subscriptions SET cancel_at_period_end=FALSE', { rows: [{ id: 's1', user_id: 'u1', plan_key: 'pro', status: 'active', interval: 'monthly', provider_subscription_code: 'SUB_1', cancel_at_period_end: false }], rowCount: 1 }],
    ],
  });
  const canceled = await billing.cancel({ userId: 'u1' });
  assert.equal(canceled.provider.status, 'failed');
  assert.match(canceled.provider.message, /try cancelling again/i);
  const resumed = await billing.resume({ userId: 'u1' });
  assert.equal(resumed.provider.status, 'failed');
  assert.match(resumed.provider.message, /contact support/i);
});

test('without a linked Paystack subscription the action stays local and says so', async () => {
  const { service: billing } = service({
    handlers: [
      ['FROM users WHERE id=$1', { rows: [payerUser], rowCount: 1 }],
      ['FROM subscriptions WHERE user_id=$1 LIMIT 1', { rows: [{ id: 's1', user_id: 'u1', plan_key: 'pro', status: 'active', interval: 'monthly', provider_subscription_code: null, cancel_at_period_end: false }], rowCount: 1 }],
      ['UPDATE subscriptions SET cancel_at_period_end=TRUE', { rows: [{ id: 's1', user_id: 'u1', plan_key: 'pro', status: 'active', interval: 'monthly', cancel_at_period_end: true }], rowCount: 1 }],
      ['UPDATE subscriptions SET cancel_at_period_end=FALSE', { rows: [{ id: 's1', user_id: 'u1', plan_key: 'pro', status: 'active', interval: 'monthly', cancel_at_period_end: false }], rowCount: 1 }],
    ],
  });
  assert.match((await billing.cancel({ userId: 'u1' })).provider.status, /local-only/);
  assert.match((await billing.resume({ userId: 'u1' })).provider.status, /local-only/);
});
