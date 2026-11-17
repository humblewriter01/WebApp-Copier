/**
 * Mirroring a stored price into a Flutterwave payment plan, one currency at a time.
 *
 * A Flutterwave payment plan is what makes a renewal charge the amount it should, so "the price is saved" and
 * "the price is live" are two different facts and the admin panel must be able to tell them apart. Every case
 * below therefore asks for three things: what the provider was asked to do, what it answered, and what was
 * written down about it. The last one matters most on a failure - a sync that could not be verified has to be
 * recorded as failed, because the alternative is a workspace that believes a stale plan is charging the new
 * price and lets a customer renew at the old one.
 *
 * The provider is a double with scripted answers, so these tests run with no network and no account, and the
 * "Flutterwave lied about the amount" case is expressible at all.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { billingConfig, planPriceMinor } from '../services/billing.js';
import { mergePlanPricing, planChargeDecision } from '../services/pricing.js';
import { createPlanSynchronizer } from '../services/plan-sync.js';

const config = billingConfig({ FLW_SECRET_KEY: 'sk_test' });
const silent = { info() {}, warn() {}, error() {} };

/** A plan in the shape the pricing store produces, with the mirror the caller describes. */
function planWith({ NGN = 10_500_000, USD = 6_900, provider = {} , updateExistingSubscriptions } = {}) {
  const merged = mergePlanPricing({
    config,
    planRows: { pro: { NGN, USD, interval: 'monthly', history: [], updatedAt: null, updatedBy: null } },
    providerPlans: { pro: provider },
    billingSettings: updateExistingSubscriptions === undefined ? {} : { updateExistingSubscriptions },
  });
  return merged.plans.find((plan) => plan.key === 'pro');
}

function fakePricing(plan, saves = []) {
  return {
    saves,
    planFor: async (key) => (key === plan.key ? plan : null),
    recordPlanSync: async ({ planKey, currency, sync, actorId }) => { saves.push({ planKey, currency, ...sync, actorId }); },
  };
}

/** The provider double: every call is recorded, and each answer is scripted per method. */
function fakeFlutterwave({ plan, creates, throwsError = null, configured = true } = {}) {
  const calls = [];
  return {
    calls,
    isConfigured: () => configured,
    fetchPlan: async (id) => {
      calls.push(['fetchPlan', id]);
      if (throwsError === 'fetch') throw throwsErrorWith();
      return typeof plan === 'function' ? plan(id, calls.length) : plan;
    },
    createPlan: async (desired) => {
      calls.push(['createPlan', desired]);
      if (throwsError === 'create') throw throwsErrorWith();
      return typeof creates === 'function' ? creates(desired) : { planId: 100, ...creates, ...desired };
    },
  };
}

function throwsErrorWith(message = 'Flutterwave could not be reached.', code = 'FLUTTERWAVE_NETWORK_ERROR') {
  return Object.assign(new Error(message), { code, status: 502, userMessage: message });
}

const providerPlan = (over = {}) => ({ planId: 42, planToken: 'PLN-42', name: 'Signal Desk Pro (monthly)', amountMinor: 10_500_000, currency: 'NGN', interval: 'monthly', status: 'active', ...over });

/* --------------------------------------------------------------------------- creating -------------------------------------------------------------------------- */

test('a plan with no mirror yet is created at the stored price, in the right currency', async () => {
  const pricing = fakePricing(planWith({}));
  const flutterwave = fakeFlutterwave({ creates: { planId: 777, amountMinor: 10_500_000, currency: 'NGN', interval: 'monthly' } });
  const sync = createPlanSynchronizer({ flutterwave, pricing, config, logger: silent });
  const result = await sync.syncPlan({ planKey: 'pro', currency: 'NGN', actorId: 'a1' });

  const [method, desired] = flutterwave.calls[0];
  assert.equal(method, 'createPlan');
  assert.deepEqual(desired, { name: 'Signal Desk Pro (monthly)', amountMinor: 10_500_000, interval: 'monthly', currency: 'NGN' });
  assert.equal(desired.amountMinor, planPriceMinor(planWith({}), 'NGN'), 'what is sent is the stored price in minor units, and the client divides it');
  assert.equal(result.status, 'synced');
  assert.equal(result.usable, true);
  assert.equal(result.planId, 777);
  assert.equal(result.currency, 'NGN');
  assert.equal(result.syncedAmountMinor, 10_500_000);
  // What was stored is what the panel shows later without asking the provider again.
  assert.equal(pricing.saves.length, 1);
  assert.equal(pricing.saves[0].planKey, 'pro');
  assert.equal(pricing.saves[0].currency, 'NGN');
  assert.equal(pricing.saves[0].status, 'synced');
  assert.equal(pricing.saves[0].planId, 777);
  assert.equal(pricing.saves[0].syncedAmountMinor, 10_500_000);
  assert.equal(pricing.saves[0].actorId, 'a1');
});

test('the dollar mirror is a different provider plan with a different name and amount', async () => {
  const pricing = fakePricing(planWith({}));
  const flutterwave = fakeFlutterwave({ creates: { planId: 778, amountMinor: 6_900, currency: 'USD', interval: 'monthly' } });
  const sync = createPlanSynchronizer({ flutterwave, pricing, config, logger: silent });
  const result = await sync.syncPlan({ planKey: 'pro', currency: 'usd' });
  assert.equal(flutterwave.calls[0][1].name, 'Signal Desk Pro USD (monthly)');
  assert.equal(flutterwave.calls[0][1].amountMinor, 6_900);
  assert.equal(flutterwave.calls[0][1].currency, 'USD');
  assert.equal(result.currency, 'USD');
  assert.equal(result.amountMinor, 6_900, 'the result states which price it mirrored');
  assert.equal(pricing.saves[0].currency, 'USD', 'one sync row per currency, not one per plan');
});

test('a currency the plan is not priced in is skipped with a reason, and never created for zero', async () => {
  /* A cleared price normally falls back to the deployed default, which is priced; this is the state that can
     still happen - a plan the environment does not carry a price for, or a row read as unusable. What matters
     is that the sync refuses to invent one: "amount 0" at a provider is a plan that charges nobody. */
  const unpriced = { key: 'pro', name: 'Pro', interval: 'monthly', prices: { NGN: { amountMinor: 10_500_000 } }, amountMinor: 10_500_000, usdAmountMinor: null, provider: { USD: { planId: null, syncStatus: 'pending', syncedAmountMinor: null } } };
  const pricing = { planFor: async (key) => (key === 'pro' ? unpriced : null), recordPlanSync: async () => {}, saves: [] };
  const flutterwave = fakeFlutterwave({});
  const sync = createPlanSynchronizer({ flutterwave, pricing, config, logger: silent });
  const result = await sync.syncPlan({ planKey: 'pro', currency: 'USD' });
  assert.equal(result.status, 'not_priced');
  assert.equal(result.usable, false);
  assert.match(result.message, /no USD price/);
  assert.equal(flutterwave.calls.length, 0, 'nothing is sent to the provider for a price nobody set');
  assert.equal(pricing.saves.length, 0, 'and nothing is written down, so the panel keeps saying "not synced yet"');
});

/* ------------------------------------------------------------------------- already in sync ------------------------------------------------------------------------ */

test('an unchanged price is confirmed without a write', async () => {
  const pricing = fakePricing(planWith({ provider: { NGN: { planId: 42, syncStatus: 'synced', syncedAmountMinor: 10_500_000, currency: 'NGN', interval: 'monthly' } } }));
  const flutterwave = fakeFlutterwave({ plan: providerPlan() });
  const sync = createPlanSynchronizer({ flutterwave, pricing, config, logger: silent });
  const result = await sync.syncPlan({ planKey: 'pro', currency: 'NGN' });
  assert.equal(result.status, 'in_sync');
  assert.equal(result.usable, true);
  assert.deepEqual(flutterwave.calls.map((call) => call[0]), ['fetchPlan'], 'read once, written never');
  assert.equal(pricing.saves[0].syncedAmountMinor, 10_500_000);
});

/* ---------------------------------------------------------------------------- re-pricing -------------------------------------------------------------------------- */

test('a price update creates a replacement Flutterwave plan, stores its id, and makes that id checkout-ready', async () => {
  const pricing = fakePricing(planWith({ NGN: 12_000_000, provider: { NGN: { planId: 42, syncStatus: 'synced', syncedAmountMinor: 10_500_000, currency: 'NGN', interval: 'monthly' } } }));
  const calls = [];
  const flutterwave = {
    isConfigured: () => true,
    fetchPlan: async (id) => { calls.push(['fetchPlan', id]); return providerPlan({ amountMinor: 10_500_000 }); },
    createPlan: async (desired) => { calls.push(['createPlan', desired]); return { planId: 501, ...desired }; },
    // Deliberately no updatePlan: Flutterwave rejects amount updates, so calling one would fail this sync.
  };
  const sync = createPlanSynchronizer({ flutterwave, pricing, config, logger: silent });
  const result = await sync.syncPlan({ planKey: 'pro', currency: 'NGN', actorId: 'a1' });

  assert.deepEqual(calls, [
    ['fetchPlan', 42],
    ['createPlan', { name: 'Signal Desk Pro (monthly)', amountMinor: 12_000_000, interval: 'monthly', currency: 'NGN' }],
  ], 'a changed amount replaces the old provider plan instead of attempting a PUT');
  assert.equal(result.status, 'synced');
  assert.equal(result.planId, 501);
  assert.match(result.message, /future subscriptions/);

  // `recordPlanSync` upserts this exact value to plan_provider_sync in production.
  assert.equal(pricing.saves.length, 1);
  assert.deepEqual(pricing.saves[0], {
    planKey: 'pro',
    currency: 'NGN',
    status: 'synced',
    planId: 501,
    planToken: null,
    syncedAmountMinor: 12_000_000,
    interval: 'monthly',
    name: 'Signal Desk Pro (monthly)',
    message: result.message,
    actorId: 'a1',
  });

  // Checkout asks `planChargeDecision` for the persisted mirror, so the replacement id is automatically bound
  // to all future subscriptions rather than the old id 42.
  const checkoutPlan = planWith({ NGN: 12_000_000, provider: { NGN: { ...pricing.saves[0], syncStatus: 'synced' } } });
  assert.deepEqual(planChargeDecision({ plan: checkoutPlan, currency: 'NGN', amountMinor: 12_000_000 }), {
    usePlan: true, reason: 'ready', planId: 501, currency: 'NGN',
  });
});

test('a replacement plan whose amount is not confirmed is recorded as failed, with checkout left one-time', async () => {
  const pricing = fakePricing(planWith({ NGN: 12_000_000, provider: { NGN: { planId: 42, syncStatus: 'synced', syncedAmountMinor: 10_500_000, currency: 'NGN', interval: 'monthly' } } }));
  const flutterwave = {
    isConfigured: () => true,
    fetchPlan: async () => providerPlan({ amountMinor: 10_500_000 }),
    createPlan: async (desired) => ({ planId: 501, ...desired, amountMinor: 11_000_000 }),
  };
  const sync = createPlanSynchronizer({ flutterwave, pricing, config, logger: silent });
  const result = await sync.syncPlan({ planKey: 'pro', currency: 'NGN' });
  assert.equal(result.usable, false);
  assert.equal(result.error, 'PLAN_AMOUNT_UNCONFIRMED');
  assert.match(result.message, /one-time until the plan syncs/);
  assert.equal(pricing.saves[0].status, 'failed', 'the failed state is written down, not just returned');
  assert.equal(pricing.saves[0].planId, 501, 'the failed replacement id is retained for support to inspect');
  assert.match(String(pricing.saves[0].message), /did not confirm/);
});

test('a replacement plan in the wrong currency or interval is a mismatch, not a near enough', async () => {
  const pricing = fakePricing(planWith({ provider: { NGN: { planId: 42, syncStatus: 'synced', syncedAmountMinor: 10_500_000, currency: 'NGN', interval: 'monthly' } } }));
  const flutterwave = {
    isConfigured: () => true,
    fetchPlan: async (id) => providerPlan({ planId: Number(id), currency: 'USD', interval: 'annually' }),
    createPlan: async (desired) => ({ planId: 501, ...desired, currency: 'USD', interval: 'annually' }),
  };
  const sync = createPlanSynchronizer({ flutterwave, pricing, config, logger: silent });
  const result = await sync.syncPlan({ planKey: 'pro', currency: 'NGN' });
  assert.equal(result.error, 'PLAN_MISMATCH');
  assert.equal(pricing.saves[0].planId, 501);
  assert.match(result.message, /FLW_CURRENCY and FLW_PLAN_INTERVAL/);
});

/* --------------------------------------------------------------------------- lost plan --------------------------------------------------------------------------- */

test('a stored plan id the provider no longer recognises is replaced, not retried', async () => {
  const pricing = fakePricing(planWith({ provider: { NGN: { planId: 42, syncStatus: 'synced', syncedAmountMinor: 10_500_000, currency: 'NGN', interval: 'monthly' } } }));
  const notFound = Object.assign(new Error('No plan was found for this id'), { flutterwaveStatus: 404 });
  const flutterwave = {
    isConfigured: () => true,
    fetchPlan: async () => { throw notFound; },
    createPlan: async (desired) => ({ planId: 900, ...desired }),
  };
  const sync = createPlanSynchronizer({ flutterwave, pricing, config, logger: silent });
  const result = await sync.syncPlan({ planKey: 'pro', currency: 'NGN' });
  assert.equal(result.status, 'synced');
  assert.equal(result.planId, 900);
  assert.match(result.message, /created \(900\)/);
});

/* ----------------------------------------------------------------- existing subscribers, new price ---------------------------------------------------------------- */

test('a replacement leaves existing subscribers on the old Flutterwave plan', async () => {
  const pricing = fakePricing(planWith({
    NGN: 12_000_000,
    provider: { NGN: { planId: 42, syncStatus: 'synced', syncedAmountMinor: 10_500_000, currency: 'NGN', interval: 'monthly' } },
    updateExistingSubscriptions: false,
  }));
  const flutterwave = {
    isConfigured: () => true,
    fetchPlan: async () => providerPlan({ amountMinor: 10_500_000 }),
    createPlan: async (desired) => ({ planId: 501, ...desired }),
  };
  const sync = createPlanSynchronizer({ flutterwave, pricing, config, logger: silent });
  const result = await sync.syncPlan({ planKey: 'pro', currency: 'NGN' });
  assert.equal(result.status, 'synced');
  assert.equal(result.planId, 501);
  assert.match(result.message, /Existing subscribers on 42 remain on their original plan/);
});

/* ---------------------------------------------------------------------------- failures ---------------------------------------------------------------------------- */

test('an unconfigured workspace reports it and asks for nothing', async () => {
  const pricing = fakePricing(planWith({}));
  const flutterwave = fakeFlutterwave({ configured: false });
  const sync = createPlanSynchronizer({ flutterwave, pricing, config, logger: silent });
  const result = await sync.syncPlan({ planKey: 'pro', currency: 'NGN' });
  assert.equal(result.status, 'not_configured');
  assert.equal(result.usable, false);
  assert.equal(flutterwave.calls.length, 0);
  assert.equal(pricing.saves.length, 0, 'there is nothing worth writing down');
});

test('a provider outage is a reported failure, and the price the workspace saved still charges', async () => {
  const pricing = fakePricing(planWith({ provider: { NGN: { planId: 42, syncStatus: 'synced', syncedAmountMinor: 10_500_000, currency: 'NGN', interval: 'monthly' } } }));
  const flutterwave = {
    isConfigured: () => true,
    fetchPlan: async () => { throw Object.assign(new Error('socket hang up'), { code: 'FLUTTERWAVE_NETWORK_ERROR', userMessage: 'The payment provider could not be reached. No payment was taken.' }); },
    createPlan: async () => ({ planId: 1 }),
  };
  const logged = [];
  const sync = createPlanSynchronizer({ flutterwave, pricing, config, logger: { info() {}, warn() {}, error: (message, extra) => logged.push([message, extra]) } });
  const result = await sync.syncPlan({ planKey: 'pro', currency: 'NGN' });
  assert.equal(result.usable, false);
  assert.equal(result.status, 'failed');
  assert.equal(result.error, 'FLUTTERWAVE_NETWORK_ERROR');
  assert.equal(result.userMessage, undefined, 'the machine code stays out of the sentence a person reads');
  assert.equal(result.message, 'The payment provider could not be reached. No payment was taken.', 'the provider-safe sentence is what is stored');
  assert.match(String(logged.at(-1)[0]), /synchronisation failed/);
  assert.equal(logged.at(-1)[1].detail !== undefined, true, 'the stack goes to the log, not to the customer');
});

test('a failure to persist a sync never loses the answer the administrator needs', async () => {
  const plan = planWith({});
  const flutterwave = fakeFlutterwave({ creates: { planId: 888, amountMinor: 10_500_000, currency: 'NGN', interval: 'monthly' } });
  const pricing = {
    planFor: async () => plan,
    recordPlanSync: async () => { throw new Error('db down'); },
  };
  const logged = [];
  const sync = createPlanSynchronizer({ flutterwave, pricing, config, logger: { info() {}, warn() {}, error: (message) => logged.push(message) } });
  const result = await sync.syncPlan({ planKey: 'pro', currency: 'NGN' });
  assert.equal(result.status, 'synced');
  assert.equal(result.usable, true);
  assert.ok(logged.includes('Flutterwave plan state could not be saved'));
});

test('an unknown plan is refused before the provider is touched', async () => {
  const flutterwave = fakeFlutterwave({});
  const sync = createPlanSynchronizer({ flutterwave, pricing: fakePricing(planWith({})), config, logger: silent });
  const result = await sync.syncPlan({ planKey: 'mystery', currency: 'NGN' });
  assert.equal(result.status, 'failed');
  assert.match(result.message, /not available for pricing/);
  assert.equal(flutterwave.calls.length, 0);
});

/* ---------------------------------------------------------------------------- syncAll ---------------------------------------------------------------------------- */

test('a re-sync of everything means every plan in every currency it sells in', async () => {
  const plan = planWith({});
  const pricing = { planFor: async () => plan, recordPlanSync: async () => {}, saves: [] };
  const flutterwave = fakeFlutterwave({ creates: (desired) => ({ planId: desired.currency === 'NGN' ? 1 : 2, ...desired }) });
  const sync = createPlanSynchronizer({ flutterwave, pricing, config, logger: silent });
  const results = await sync.syncAll({ planKeys: ['pro'], actorId: 'a1' });
  assert.deepEqual(results.map((result) => `${result.planKey}:${result.currency}:${result.status}`), ['pro:NGN:synced', 'pro:USD:synced']);
  assert.deepEqual(flutterwave.calls.map((call) => call[1].currency), ['NGN', 'USD']);

  const one = await sync.syncAll({ planKeys: ['pro'], currencies: ['usd'], actorId: 'a1' });
  assert.deepEqual(one.map((result) => result.currency), ['USD']);

  const everything = await sync.syncAll({});
  assert.equal(everything.length, config.plans.length * 2, 'the button an administrator presses does the whole catalogue');
  assert.equal(sync.isSuccessStatus('in_sync'), true);
  assert.equal(sync.isSuccessStatus('failed'), false);
});
