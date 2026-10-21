import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlanSynchronizer } from '../services/plan-sync.js';
import { createPaystackClient, isProviderNotFound, parseAffectedSubscriptions } from '../services/paystack.js';
import { billingConfig } from '../services/billing.js';

const config = billingConfig({ PAYSTACK_SECRET_KEY: 'sk_test_secret', PAYSTACK_CURRENCY: 'NGN' });
const silentLogger = { info() {}, warn() {}, error() {} };

/** Records every provider call and replays a scripted answer per method. */
function fakePaystack(script = {}, { configured = true } = {}) {
  const calls = [];
  const respond = async (name, args) => {
    calls.push({ name, args });
    const entry = script[name];
    if (typeof entry === 'function') return entry(args);
    if (entry instanceof Error) throw entry;
    return entry ?? null;
  };
  return {
    calls,
    isConfigured: () => configured,
    createPlan: (input) => respond('createPlan', input),
    fetchPlan: (idOrCode) => respond('fetchPlan', { idOrCode }),
    updatePlan: (idOrCode, input) => respond('updatePlan', { idOrCode, ...input }),
  };
}

/** A pricing store stand-in: the plan we hand out is the whole input. */
function fakePricing(plan, saves = []) {
  return {
    saves,
    async planFor(planKey) {
      return plan && plan.key === String(planKey).toLowerCase() ? plan : null;
    },
    async recordPlanSync(input) { saves.push(input); return input.sync; },
  };
}

const proPlan = (overrides = {}) => ({
  key: 'pro',
  name: 'Pro',
  description: 'Higher limits for active traders.',
  amountMinor: 300_000,
  amount: 3000,
  currency: 'NGN',
  interval: 'monthly',
  updateExistingSubscriptions: true,
  paystack: { planCode: null, syncStatus: 'pending', syncedAmountMinor: null },
  ...overrides,
});

const providerPlan = (overrides = {}) => ({
  id: 91,
  planCode: 'PLN_pro',
  name: 'Signal Desk Pro (monthly)',
  amountMinor: 300_000,
  interval: 'monthly',
  currency: 'NGN',
  ...overrides,
});

test('a plan that does not exist at Paystack is created and then verified', async () => {
  const paystack = fakePaystack({
    createPlan: () => providerPlan(),
    fetchPlan: () => providerPlan(),
  });
  const saves = [];
  const sync = createPlanSynchronizer({ paystack, pricing: fakePricing(proPlan(), saves), config, logger: silentLogger });
  const result = await sync.syncPlan({ planKey: 'pro', actorId: 'user-1' });

  assert.equal(result.status, 'synced');
  assert.equal(result.usable, true);
  assert.equal(result.planCode, 'PLN_pro');
  assert.equal(result.syncedAmountMinor, 300_000);
  assert.match(result.message, /plan created/i);
  assert.deepEqual(paystack.calls.map((call) => call.name), ['createPlan', 'fetchPlan'], 'the created plan is read back before it is trusted');
  assert.equal(result.planKey, 'pro');
  assert.equal(result.amountMinor, 300_000);
  assert.deepEqual(paystack.calls[0].args, {
    name: 'Signal Desk Pro (monthly)',
    amountMinor: 300_000,
    interval: 'monthly',
    currency: 'NGN',
    description: 'Higher limits for active traders.',
  });
  assert.equal(saves.length, 1);
  assert.equal(saves[0].planKey, 'pro');
  assert.equal(saves[0].sync.status, 'synced');
  assert.equal(saves[0].actorId, 'user-1');
});

test('an already correct Paystack plan is left alone', async () => {
  const paystack = fakePaystack({ fetchPlan: () => providerPlan() });
  const saves = [];
  const sync = createPlanSynchronizer({
    paystack,
    pricing: fakePricing(proPlan({ paystack: { planCode: 'PLN_pro', syncStatus: 'synced', syncedAmountMinor: 250_000 } }), saves),
    config,
    logger: silentLogger,
  });
  const result = await sync.syncPlan({ planKey: 'pro' });
  assert.equal(result.status, 'in_sync');
  assert.equal(result.usable, true);
  assert.match(result.message, /nothing was changed/i);
  assert.deepEqual(paystack.calls.map((call) => call.name), ['fetchPlan'], 'no write happens when the amount already matches');
  assert.equal(saves.length, 1);
});

test('a price change updates the existing plan and re-reads the amount', async () => {
  const seen = [];
  const paystack = fakePaystack({
    fetchPlan: ({ idOrCode }) => { seen.push(idOrCode); return providerPlan({ amountMinor: seen.length === 1 ? 250_000 : 300_000 }); },
    updatePlan: () => ({ message: 'Plan updated. 3 subscription(s) affected', affectedSubscriptions: 3, plan: null }),
  });
  const saves = [];
  const sync = createPlanSynchronizer({
    paystack,
    pricing: fakePricing(proPlan({ paystack: { planCode: 'PLN_pro', planId: 91, syncStatus: 'synced', syncedAmountMinor: 250_000 } }), saves),
    config,
    logger: silentLogger,
  });
  const result = await sync.syncPlan({ planKey: 'pro' });

  assert.equal(result.status, 'synced');
  assert.equal(result.affectedSubscriptions, 3);
  assert.equal(result.message, 'Plan updated. 3 subscription(s) affected');
  assert.deepEqual(seen, ['PLN_pro', 'PLN_pro'], 'the update reply is confirmed by a fetch');
  const update = paystack.calls.find((call) => call.name === 'updatePlan');
  assert.equal(update.args.idOrCode, 'PLN_pro');
  assert.equal(update.args.amountMinor, 300_000);
  assert.equal(update.args.interval, 'monthly');
  assert.equal(update.args.currency, 'NGN');
  assert.equal(update.args.updateExistingSubscriptions, true);
});

test('the migrate flag is honoured for administrators who only want new subscribers charged', async () => {
  const paystack = fakePaystack({
    fetchPlan: () => providerPlan({ amountMinor: 250_000 }),
    updatePlan: () => ({ message: 'Plan updated. 0 subscription(s) affected', affectedSubscriptions: 0, plan: null }),
  });
  const sync = createPlanSynchronizer({
    paystack,
    pricing: fakePricing(proPlan({
      updateExistingSubscriptions: false,
      paystack: { planCode: 'PLN_pro', syncStatus: 'synced', syncedAmountMinor: 250_000 },
    })),
    config,
    logger: silentLogger,
  });
  await sync.syncPlan({ planKey: 'pro' });
  assert.equal(paystack.calls.find((call) => call.name === 'updatePlan').args.updateExistingSubscriptions, false);
});

test('a plan code Paystack no longer knows about is recreated', async () => {
  const missing = Object.assign(new Error('Plan not found'), { paystackStatus: 404, code: 'PAYSTACK_PROVIDER_ERROR' });
  let fetched = 0;
  const paystack = fakePaystack({
    fetchPlan: () => { fetched += 1; if (fetched === 1) throw missing; return providerPlan({ planCode: 'PLN_fresh' }); },
    createPlan: () => providerPlan({ planCode: 'PLN_fresh', id: 120 }),
  });
  const saves = [];
  const sync = createPlanSynchronizer({
    paystack,
    pricing: fakePricing(proPlan({ paystack: { planCode: 'PLN_gone', syncStatus: 'synced', syncedAmountMinor: 300_000 } }), saves),
    config,
    logger: silentLogger,
  });
  const result = await sync.syncPlan({ planKey: 'pro' });
  assert.equal(result.status, 'synced');
  assert.equal(result.planCode, 'PLN_fresh');
  assert.deepEqual(paystack.calls.map((call) => call.name), ['fetchPlan', 'createPlan', 'fetchPlan']);
  assert.equal(saves[0].sync.planCode, 'PLN_fresh', 'the new code replaces the dead one');
});

test('Paystack reporting a different amount fails loudly and keeps the price usable for one-time checkout', async () => {
  const paystack = fakePaystack({
    createPlan: () => providerPlan({ amountMinor: 100_000 }),
    fetchPlan: () => providerPlan({ amountMinor: 100_000 }),
  });
  const saves = [];
  let warned = 0;
  const sync = createPlanSynchronizer({
    paystack,
    pricing: fakePricing(proPlan(), saves),
    config,
    logger: { info() {}, warn() { warned += 1; }, error() {} },
  });
  const result = await sync.syncPlan({ planKey: 'pro' });
  assert.equal(result.status, 'failed');
  assert.equal(result.usable, false);
  assert.match(result.message, /did not confirm the new plan amount/);
  assert.equal(result.syncedAmountMinor, 100_000, 'the amount Paystack really holds is recorded');
  assert.equal(saves[0].sync.status, 'failed');
  assert.equal(saves[0].sync.error, 'PLAN_AMOUNT_UNCONFIRMED');
  assert.equal(warned, 0, 'a mismatch is a normal outcome, not an exception');
});

test('a provider or network failure never throws and never loses the saved price', async () => {
  for (const failure of [
    Object.assign(new Error('Paystack rejected the payment request.'), { status: 502, code: 'PAYSTACK_PROVIDER_ERROR', userMessage: 'The payment provider rejected the request: amount invalid. No payment was taken.' }),
    Object.assign(new Error('Paystack could not be reached.'), { status: 502, code: 'PAYSTACK_NETWORK_ERROR', userMessage: 'The payment provider could not be reached. No payment was taken.' }),
  ]) {
    const paystack = fakePaystack({ fetchPlan: () => { throw failure; } });
    const saves = [];
    let logged = 0;
    const sync = createPlanSynchronizer({
      paystack,
      pricing: fakePricing(proPlan({ paystack: { planCode: 'PLN_pro', syncStatus: 'synced', syncedAmountMinor: 300_000 } }), saves),
      config,
      logger: { info() {}, warn() {}, error() { logged += 1; } },
    });
    const result = await sync.syncPlan({ planKey: 'pro' });
    assert.equal(result.status, 'failed');
    assert.equal(result.usable, false);
    assert.equal(result.message, failure.userMessage);
    assert.equal(result.planCode, 'PLN_pro', 'the old code is kept so a retry can update the same plan');
    assert.equal(saves[0].sync.status, 'failed', 'the stale amount is invalidated so checkout stops using the plan');
    assert.equal(saves[0].sync.planCode, 'PLN_pro');
    assert.equal(saves[0].sync.syncedAmountMinor ?? null, null);
    assert.equal(logged, 1);
  }
});

test('an unconfigured workspace stores the price but touches no provider', async () => {
  const paystack = fakePaystack({}, { configured: false });
  const saves = [];
  const sync = createPlanSynchronizer({ paystack, pricing: fakePricing(proPlan(), saves), config, logger: silentLogger });
  const result = await sync.syncPlan({ planKey: 'pro' });
  assert.equal(result.status, 'not_configured');
  assert.equal(result.usable, false);
  assert.match(result.message, /not configured/i);
  assert.equal(paystack.calls.length, 0);
  assert.equal(saves.length, 0, 'nothing is written to the provider mirror without a key');
});

test('an unknown plan key is refused without touching Paystack', async () => {
  const paystack = fakePaystack({});
  const sync = createPlanSynchronizer({ paystack, pricing: fakePricing(proPlan()), config, logger: silentLogger });
  const result = await sync.syncPlan({ planKey: 'platinum' });
  assert.equal(result.status, 'failed');
  assert.match(result.message, /not available for pricing/i);
  assert.equal(paystack.calls.length, 0);
});

test('syncAll walks every configured plan exactly once', async () => {
  const amounts = new Map();
  const paystack = fakePaystack({
    createPlan: (input) => {
      const planCode = `PLN_${input.name}`;
      amounts.set(planCode, input.amountMinor);
      return providerPlan({ planCode, amountMinor: input.amountMinor, name: input.name });
    },
    fetchPlan: ({ idOrCode }) => providerPlan({ planCode: idOrCode, amountMinor: amounts.get(idOrCode) ?? 0 }),
  });
  const plans = new Map([
    ['pro', proPlan()],
    ['premium', proPlan({ key: 'premium', name: 'Premium', amountMinor: 600_000 })],
  ]);
  const sync = createPlanSynchronizer({
    paystack,
    pricing: { async planFor(key) { return plans.get(String(key)) || null; }, async recordPlanSync() { return null; } },
    config,
    logger: silentLogger,
  });
  const results = await sync.syncAll({});
  assert.deepEqual(results.map((result) => result.planKey), ['pro', 'premium']);
  assert.deepEqual(paystack.calls.filter((call) => call.name === 'createPlan').map((call) => call.args.amountMinor), [300_000, 600_000]);
  assert.deepEqual(results.map((result) => result.status), ['synced', 'synced'], 'each plan is verified against its own price');
  const subset = await sync.syncAll({ planKeys: ['premium'] });
  assert.deepEqual(subset.map((result) => result.planKey), ['premium']);
});

/* ------------------------- the Paystack client itself ------------------------ */

function clientWith(handler) {
  return createPaystackClient({ config: { ...config, baseUrl: 'https://api.paystack.test' }, fetchImpl: handler });
}
const jsonResponse = (payload, status = 200) => new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });

test('createPlan posts the documented body and maps the reply', async () => {
  const seen = [];
  const client = clientWith(async (url, options) => {
    seen.push({ url, options });
    return jsonResponse({ status: true, message: 'Plan created', data: { id: 49122, plan_code: 'PLN_u4cqud8vabi89hx', name: 'Signal Desk Pro (monthly)', amount: 300000, interval: 'monthly', currency: 'NGN' } });
  });
  const plan = await client.createPlan({ name: 'Signal Desk Pro (monthly)', amountMinor: 300_000, interval: 'monthly', currency: 'NGN', description: 'Higher limits' });
  assert.equal(seen[0].url, 'https://api.paystack.test/plan');
  assert.equal(seen[0].options.method, 'POST');
  assert.deepEqual(JSON.parse(seen[0].options.body), {
    name: 'Signal Desk Pro (monthly)', amount: 300000, interval: 'monthly', currency: 'NGN', send_invoices: true, description: 'Higher limits',
  });
  assert.equal(seen[0].options.headers.Authorization, 'Bearer sk_test_secret');
  assert.deepEqual(plan, { id: 49122, planCode: 'PLN_u4cqud8vabi89hx', name: 'Signal Desk Pro (monthly)', amountMinor: 300000, interval: 'monthly', currency: 'NGN' });
});

test('a create reply without a plan code is refused instead of trusted', async () => {
  const client = clientWith(async () => jsonResponse({ status: true, message: 'Plan created', data: { id: 1 } }));
  await assert.rejects(client.createPlan({ name: 'x', amountMinor: 100, interval: 'monthly', currency: 'NGN' }), /did not return a plan code/);
});

test('updatePlan uses PUT on the plan code and reads the affected count from the message', async () => {
  const seen = [];
  const client = clientWith(async (url, options) => {
    seen.push({ url, options });
    return jsonResponse({ status: true, message: 'Plan updated. 2 subscription(s) affected' });
  });
  const result = await client.updatePlan('PLN_pro', { name: 'Signal Desk Pro (monthly)', amountMinor: 450_000, interval: 'monthly', currency: 'NGN', updateExistingSubscriptions: false });
  assert.equal(seen[0].url, 'https://api.paystack.test/plan/PLN_pro');
  assert.equal(seen[0].options.method, 'PUT');
  assert.deepEqual(JSON.parse(seen[0].options.body), {
    amount: 450000, interval: 'monthly', currency: 'NGN', send_invoices: true, name: 'Signal Desk Pro (monthly)', update_existing_subscriptions: false,
  });
  assert.equal(result.affectedSubscriptions, 2);
  assert.equal(result.plan, null, 'the update reply carries no data, so callers must re-fetch');
  assert.equal(parseAffectedSubscriptions('Plan updated. 12 subscription(s) affected'), 12);
  assert.equal(parseAffectedSubscriptions('Plan updated'), null);
});

test('fetchPlan 404 is identifiable so a dead code can be recreated', async () => {
  const client = clientWith(async () => jsonResponse({ status: false, message: 'Plan not found' }, 404));
  const error = await client.fetchPlan('PLN_gone').then(() => null, (caught) => caught);
  assert.equal(error.paystackStatus, 404);
  assert.equal(isProviderNotFound(error), true);
  assert.equal(isProviderNotFound(Object.assign(new Error('x'), { paystackStatus: 500 })), false);
  assert.equal(isProviderNotFound(new Error('network')), false);
});

test('subscription endpoints use the documented shapes', async () => {
  const seen = [];
  const client = clientWith(async (url, options) => {
    seen.push({ url, method: options.method, body: options.body ? JSON.parse(options.body) : undefined });
    if (options.method === 'GET') {
      return jsonResponse({ status: true, message: 'Subscription retrieved', data: { subscription_code: 'SUB_1', status: 'active', amount: 300000, email_token: 'tok_1', next_payment_date: '2026-11-01T00:00:00.000Z', authorization: { authorization_code: 'AUTH_9' }, plan: { plan_code: 'PLN_pro' }, customer: { email: 'payer@example.com' } } });
    }
    return jsonResponse({ status: true, message: 'Subscription cancelled' });
  });
  const detail = await client.fetchSubscription('SUB_1');
  assert.deepEqual(detail, {
    subscriptionCode: 'SUB_1', status: 'active', amountMinor: 300000, emailToken: 'tok_1',
    nextPaymentDate: '2026-11-01T00:00:00.000Z', authorizationCode: 'AUTH_9', planCode: 'PLN_pro', customerEmail: 'payer@example.com',
  });
  assert.equal((await client.disableSubscription('SUB_1')).message, 'Subscription cancelled');
  await client.enableSubscription({ code: 'SUB_1', token: detail.emailToken, authorization: detail.authorizationCode });
  assert.deepEqual(seen.map((call) => `${call.method} ${call.url}`), [
    'GET https://api.paystack.test/subscription/SUB_1',
    'POST https://api.paystack.test/subscription/disable',
    'POST https://api.paystack.test/subscription/enable',
  ]);
  assert.deepEqual(seen[1].body, { code: 'SUB_1' });
  assert.deepEqual(seen[2].body, { code: 'SUB_1', token: 'tok_1', authorization: 'AUTH_9' });
});

test('an unconfigured client refuses plan and subscription calls before any network access', async () => {
  let fetched = 0;
  const client = createPaystackClient({ config: { baseUrl: 'https://api.paystack.test' }, fetchImpl: async () => { fetched += 1; return jsonResponse({}); } });
  await assert.rejects(client.createPlan({ name: 'x', amountMinor: 100, interval: 'monthly' }), /not configured/i);
  await assert.rejects(client.fetchPlan('PLN_1'), /not configured/i);
  await assert.rejects(client.disableSubscription('SUB_1'), /not configured/i);
  assert.equal(fetched, 0);
});
