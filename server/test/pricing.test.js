/**
 * The pricing table: what is stored, how it is read back, and what may be written to it.
 *
 * `plans` holds the price a customer is charged, `plan_provider_sync` holds what Flutterwave was told to charge
 * on renewal, and the gap between the two is the whole risk of this feature. So these tests are mostly about
 * three things: a stored price beating the environment without ever averaging with it, a currency nobody priced
 * staying unpriced instead of becoming zero, and a write that touches one currency not quietly clearing the other.
 *
 * The database is a double that answers by SQL fragment. That is enough here because the assertions are about
 * the parameters sent and the shape read back, not about Postgres' behaviour - the constraints themselves
 * (`CHECK (price_usd_minor > 0)`, the composite primary key) are pinned in `db.js` by the migration test.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BILLING_SETTINGS_KEY,
  MAX_PRICE_HISTORY,
  PLAN_AMOUNT_BOUNDS,
  createPricingStore,
  emptyProviderMirror,
  mergePlanPricing,
  normalizeBillingSettings,
  normalizePricingUpdate,
  planChargeDecision,
  providerPlanName,
  publicPricing,
  sanitizePriceHistory,
  sanitizeProviderPlan,
  sanitizeStoredPrice,
} from '../services/pricing.js';
import { billingConfig, planPriceMinor } from '../services/billing.js';

const config = billingConfig({ FLW_SECRET_KEY: 'sk_test', FLW_PLAN_PRO_AMOUNT: '10500000', FLW_PLAN_PRO_USD_AMOUNT: '6900' });
const silent = { info() {}, warn() {}, error() {} };

/** Answers queries by SQL fragment, recording every call. */
function fakePool(handlers = []) {
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
  return { calls, query };
}

function store(handlers = [], overrides = {}) {
  const pool = fakePool(handlers);
  return { pool, store: createPricingStore({ pool, config, logger: silent, ...overrides }) };
}

const planRow = (planKey, { NGN = null, USD = null, interval = 'monthly', history = [], updatedBy = null } = {}) => ({
  planKey,
  interval,
  NGN,
  USD,
  history,
  updatedAt: '2026-10-01T00:00:00.000Z',
  updatedBy,
});

const syncRow = (planKey, currency, extra = {}) => ({
  planKey,
  currency,
  planId: 42,
  syncStatus: 'synced',
  syncedAmountMinor: 10_500_000,
  syncedAt: '2026-10-01T00:00:00.000Z',
  name: `Signal Desk Pro ${currency === 'USD' ? 'USD ' : ''}(monthly)`,
  message: null,
  error: null,
  interval: 'monthly',
  ...extra,
});

/* ---------------------------------------------------------------------- reading a stored price -------------------------------------------------------------------- */

test('a stored price is read per currency, and an unusable one is no price at all', () => {
  assert.deepEqual(sanitizeStoredPrice(planRow('pro', { NGN: 10_500_000, USD: 6_900 })), {
    NGN: 10_500_000,
    USD: 6_900,
    amountMinor: 10_500_000,
    currency: 'NGN',
    interval: 'monthly',
    history: [],
  });

  // One currency priced and the other not is a normal state, not a broken row.
  assert.deepEqual(Object.keys(sanitizeStoredPrice(planRow('pro', { NGN: 10_500_000 }))), ['NGN', 'amountMinor', 'currency', 'interval', 'history']);
  assert.equal(sanitizeStoredPrice(planRow('pro', { USD: 6_900 })).USD, 6_900);

  for (const bad of [null, undefined, {}, planRow('pro', { NGN: 0 }), planRow('pro', { NGN: -5 }), planRow('pro', { NGN: 'abc', USD: null })]) {
    assert.equal(sanitizeStoredPrice(bad), null, `${JSON.stringify(bad)} is not a price`);
  }
  // An interval Flutterwave has never heard of is dropped rather than sent on and rejected there.
  assert.equal(sanitizeStoredPrice(planRow('pro', { NGN: 100_000, interval: 'fortnightly' })).interval, null);
  assert.equal(sanitizeStoredPrice(planRow('pro', { NGN: 100_000, interval: 'ANNUALLY' })).interval, 'annually');
});

test('price history is capped, oldest-last, and survives being stored as text', () => {
  const entries = Array.from({ length: 14 }, (unused, index) => ({
    at: `2026-01-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`,
    by: 'admin@example.test',
    currency: index % 2 ? 'usd' : 'ngn',
    from_minor: 1000 * index,
    toMinor: 1000 * (index + 1),
    note: `change ${index}`,
  }));
  const sanitized = sanitizePriceHistory(JSON.stringify(entries));
  assert.equal(sanitized.length, MAX_PRICE_HISTORY);
  assert.equal(sanitized[0].currency, 'NGN');
  assert.equal(sanitized[0].fromMinor, 0);
  assert.deepEqual(sanitizePriceHistory('not json'), []);
  assert.deepEqual(sanitizePriceHistory({}), []);
  assert.deepEqual(sanitizePriceHistory(null), []);
});

test('a provider mirror is read row by row, and a legacy Paystack code cannot satisfy it', () => {
  const mirror = sanitizeProviderPlan({ planKey: 'pro', currency: 'ngn', planId: 42, syncStatus: 'IN_SYNC', synced_amount_minor: '10500000', interval: 'MONTHLY', name: 'x', message: 'ok' });
  assert.equal(mirror.planId, 42);
  assert.equal(mirror.syncStatus, 'in_sync');
  assert.equal(mirror.syncedAmountMinor, 10_500_000);
  assert.equal(mirror.currency, 'NGN');
  assert.equal(mirror.interval, 'monthly');

  // The old integration stored a plan *code*; it is remembered for the panel and treated as "never synced".
  const legacy = sanitizeProviderPlan({ planCode: 'PLN9ZQTNXUC2', syncStatus: 'synced', amountMinor: 10_500_000, currency: 'NGN' });
  assert.equal(legacy.planId, null);
  assert.equal(legacy.legacyCode, 'PLN9ZQTNXUC2');
  assert.equal(legacy.syncStatus, 'pending', 'a Paystack plan code is not a Flutterwave plan id');

  assert.equal(sanitizeProviderPlan(null), null);
  assert.equal(sanitizeProviderPlan('{"planId":7,"sync_status":"synced","currency":"usd","amount":39}').planId, 7);
  assert.deepEqual(Object.keys(emptyProviderMirror()), ['NGN', 'USD']);
});

/* ------------------------------------------------------------------------- merging --------------------------------------------------------------------------------- */

test('the database wins per currency, and the environment fills only the gaps', () => {
  const merged = mergePlanPricing({
    config,
    planRows: { pro: { NGN: 8_900_000, USD: null, interval: null, history: [], updatedAt: null, updatedBy: null } },
  });
  const pro = merged.plans.find((plan) => plan.key === 'pro');
  assert.equal(planPriceMinor(pro, 'NGN'), 8_900_000);
  assert.equal(pro.sources.NGN, 'database');
  assert.equal(planPriceMinor(pro, 'USD'), 6_900, 'a currency with no stored row falls back to the deployed default');
  assert.equal(pro.sources.USD, 'environment');
  assert.equal(pro.amount, 89_000);
  assert.equal(pro.usdAmount, 69);
  assert.equal(pro.environmentAmountMinor, 10_500_000);
  assert.deepEqual(Object.keys(pro.prices), ['NGN', 'USD']);
  assert.equal(mergePlanPricing({ config }).plans.find((plan) => plan.key === 'starter').prices.NGN.providerAmount, 60_000);
});

test('a plan id is indexed by currency and id, because a Flutterwave plan is single-currency', () => {
  const merged = mergePlanPricing({
    config,
    planRows: { pro: planRow('pro', { NGN: 10_500_000, USD: 6_900 }) },
    providerPlans: { pro: { NGN: syncRow('pro', 'NGN', { planId: 42 }), USD: syncRow('pro', 'USD', { planId: 43, syncedAmountMinor: 6_900 }) } },
  });
  assert.deepEqual(merged.byId, { 'NGN:42': 'pro', 'USD:43': 'pro' });
  const pro = merged.plans.find((plan) => plan.key === 'pro');
  assert.equal(pro.provider.USD.planId, 43);
  assert.equal(pro.provider.USD.syncedAmountMinor, 6_900);
});

test('the public view carries both prices and no provider detail', () => {
  const merged = mergePlanPricing({ config, planRows: { pro: planRow('pro', { NGN: 10_500_000, USD: 6_900 }) }, providerPlans: { pro: { NGN: syncRow('pro', 'NGN') } } });
  const [pro] = publicPricing(merged).filter((plan) => plan.key === 'pro');
  assert.equal(pro.amountMinor, 10_500_000);
  assert.equal(pro.usdAmountMinor, 6_900);
  assert.deepEqual(pro.renewsAutomatically, { NGN: true, USD: false });
  assert.equal(JSON.stringify(pro).includes('"planId"'), false, 'a provider plan id is never sent to a browser');
  assert.equal(pro.prices.USD.providerAmount, 69);
});

/* -------------------------------------------------------------------------- charging ---------------------------------------------------------------------------------- */

test('a checkout is raised through a payment plan only when the mirror says so in this currency', () => {
  const priced = mergePlanPricing({
    config,
    planRows: { pro: planRow('pro', { NGN: 10_500_000, USD: 6_900 }) },
    providerPlans: { pro: { NGN: syncRow('pro', 'NGN'), USD: syncRow('pro', 'USD', { planId: 43, syncedAmountMinor: 6_900 }) } },
  }).plans.find((plan) => plan.key === 'pro');

  assert.deepEqual(planChargeDecision({ plan: priced, currency: 'NGN' }), { usePlan: true, reason: 'ready', planId: 42, currency: 'NGN' });
  assert.equal(planChargeDecision({ plan: priced, currency: 'USD' }).planId, 43);
  const cases = [
    [{ plan: null }, 'plan-unavailable'],
    [{ plan: priced, currency: 'NGN', recurringEnabled: false }, 'recurring-disabled'],
    [{ plan: priced, currency: 'NGN', hasDiscount: true }, 'discounted-checkout'],
    [{ plan: priced, currency: 'USD', amountMinor: 1 }, 'amount-mismatch'],
    [{ plan: { ...priced, provider: emptyProviderMirror() }, currency: 'NGN' }, 'no-plan-id'],
    [{ plan: { ...priced, provider: { ...priced.provider, NGN: { ...priced.provider.NGN, syncStatus: 'failed' } } }, currency: 'NGN' }, 'not-synced'],
    [{ plan: { ...priced, provider: { ...priced.provider, NGN: { ...priced.provider.NGN, currency: 'USD' } } }, currency: 'NGN' }, 'currency-mismatch'],
    [{ plan: { ...priced, provider: { ...priced.provider, NGN: { ...priced.provider.NGN, interval: 'annually' } } }, currency: 'NGN' }, 'interval-mismatch'],
  ];
  for (const [input, reason] of cases) {
    const decision = planChargeDecision(input);
    assert.equal(decision.usePlan, false, reason);
    assert.equal(decision.reason, reason);
  }
});

test('a provider plan is named per currency so two prices never collide', () => {
  assert.equal(providerPlanName({ name: 'Pro', interval: 'monthly' }, 'NGN'), 'Signal Desk Pro (monthly)');
  assert.equal(providerPlanName({ name: 'Pro', interval: 'monthly' }, 'USD'), 'Signal Desk Pro USD (monthly)');
  assert.equal(providerPlanName({ name: 'Pro', interval: 'annually' }, 'usd'), 'Signal Desk Pro USD (annually)');
  assert.ok(providerPlanName({ name: 'x'.repeat(60), interval: 'monthly' }, 'NGN').length <= 90, 'Flutterwave caps a plan name');
});

/* ------------------------------------------------------------------------- writing ---------------------------------------------------------------------------------- */

test('an update states which currency it touched, in which field, and nulls what it means to clear', () => {
  const update = normalizePricingUpdate({
    input: { plans: { pro: { amount: '89000', usdAmountMinor: 6900 } }, note: 'October', billing: { recurringEnabled: false } },
    config,
  });
  assert.deepEqual(update.entries, [{ planKey: 'pro', amounts: { NGN: 8_900_000, USD: 6_900 }, written: { NGN: true, USD: true } }]);
  assert.deepEqual(update.billing, { recurringEnabled: false });
  assert.equal(update.note, 'October');
  assert.deepEqual(update.syncPlanKeys, [{ planKey: 'pro', currencies: ['NGN', 'USD'] }]);

  // A bare number is the legacy shape: naira, in the major unit.
  assert.deepEqual(normalizePricingUpdate({ input: { plans: { pro: '99000' } }, config }).entries[0].amounts, { NGN: 9_900_000 });
  // An empty field is not a price and not a clear: the request is refused rather than guessed at.
  assert.deepEqual(normalizePricingUpdate({ input: { plans: { pro: { amount: null, usdAmount: '69' } } }, config }).entries[0], {
    planKey: 'pro', amounts: { NGN: null, USD: 6_900 }, written: { NGN: true, USD: true },
  });
  assert.throws(() => normalizePricingUpdate({ input: { plans: { pro: { amount: '' } } }, config }), /needs a price in NGN/);
  assert.throws(() => normalizePricingUpdate({ input: { plans: { mystery: { amount: 1 } } }, config }), /not available for pricing/);
  assert.throws(() => normalizePricingUpdate({ input: { plans: {}, billing: { recurringEnabled: 'maybe' } }, config }), /true or false/);
  assert.throws(() => normalizePricingUpdate({ input: { plans: { pro: { amount: '100', usdAmount: 0.001 } } }, config }), /two decimal places/);
  // A currency the workspace does not sell in is not a price field, so the request says "nothing to save".
  assert.throws(() => normalizePricingUpdate({ input: { plans: { pro: { amountGbp: 20 } } }, config }), /Choose a price/);
});

test('prices are bounded by the provider minimum and by the workspace guard rail, per currency', () => {
  assert.deepEqual(PLAN_AMOUNT_BOUNDS.NGN, { minMinor: 10_000, maxMinor: 1_000_000_000 });
  assert.throws(() => normalizePricingUpdate({ input: { plans: { pro: { amount: '50' } } }, config }), /must be at least ₦100.00/);
  assert.throws(() => normalizePricingUpdate({ input: { plans: { pro: { usdAmount: '0.5' } } }, config }), /must be at least \$1.00/);
  assert.throws(() => normalizePricingUpdate({ input: { plans: { pro: { amount: '20000000000' } } }, config }), /cannot be more than/);
  assert.equal(normalizePricingUpdate({ input: { plans: { pro: { amount: '100' } } }, config }).entries[0].amounts.NGN, 10_000);
});

test('the billing switches are the only behaviour stored outside the price row', () => {
  assert.deepEqual(normalizeBillingSettings({ recurringEnabled: 'true', updateExistingSubscriptions: false }), { recurringEnabled: true, updateExistingSubscriptions: false });
  assert.deepEqual(normalizeBillingSettings({ recurringEnabled: true }), { recurringEnabled: true });
  assert.throws(() => normalizeBillingSettings({}), /billing switch to save/);
});

/* --------------------------------------------------------------------------- store --------------------------------------------------------------------------- */

test('a snapshot reads both tables and the settings row in one go', async () => {
  const { store: pricing } = store([
    ['FROM plans p LEFT JOIN users u', { rows: [planRow('pro', { NGN: 9_000_000, USD: 5_900, updatedBy: 'admin@example.test' })], rowCount: 1 }],
    ['FROM plan_provider_sync', { rows: [syncRow('pro', 'NGN', { planId: 7 }), syncRow('pro', 'USD', { planId: 8, syncedAmountMinor: 5_900, syncStatus: 'in_sync' })], rowCount: 2 }],
    ['FROM admin_settings WHERE setting_key=$1', { rows: [{ setting_value: JSON.stringify({ recurringEnabled: false, updateExistingSubscriptions: true }) }], rowCount: 1 }],
  ]);
  const snapshot = await pricing.snapshot();
  const pro = snapshot.plans.find((plan) => plan.key === 'pro');
  assert.equal(planPriceMinor(pro, 'NGN'), 9_000_000);
  assert.equal(pro.updatedBy, 'admin@example.test');
  assert.equal(pro.provider.USD.planId, 8);
  assert.equal(pro.provider.USD.syncStatus, 'in_sync');
  assert.equal(snapshot.recurringEnabled, false, 'a switch stored as false is honoured, not read as missing');
  assert.equal(snapshot.updateExistingSubscriptions, true);
  assert.equal(snapshot.plans.find((plan) => plan.key === 'starter').sources.NGN, 'environment');
  assert.deepEqual((await pricing.planFor(' PRO ')).key, 'pro');
  assert.equal(await pricing.planFor('nothing'), null);
  assert.equal(store().pool.calls.length, 0, 'nothing is read until a snapshot is asked for');
  assert.equal((await store([['FROM plans p LEFT JOIN users u', { rows: [planRow('mystery', { NGN: 1 })], rowCount: 1 }]]).store.snapshot()).plans.every((plan) => plan.sources.NGN === 'environment'), true, 'a row for a plan nobody sells is ignored');
});

test('a pricing table that cannot be read falls back to the deployed prices instead of breaking checkout', async () => {
  const logged = [];
  const { store: pricing } = store([
    // An empty result is "nothing stored"; only a failure to ask is a reason to say so in the log.
    ['FROM plans p LEFT JOIN users u', () => { throw Object.assign(new Error('boom'), { code: '57P01' }); }],
    ['FROM plan_provider_sync', () => { throw new Error('boom'); }],
    ['FROM admin_settings WHERE setting_key=$1', () => { throw new Error('boom'); }],
  ], { logger: { info() {}, warn: (message, extra) => logged.push([message, extra]), error() {} } });
  const snapshot = await pricing.snapshot();
  assert.equal(snapshot.plans.find((plan) => plan.key === 'pro').amountMinor, 10_500_000);
  assert.equal(logged.filter(([message]) => /falling back/i.test(message)).length, 2, 'both unreadable tables say so');
  assert.equal(snapshot.recurringEnabled, true, 'an unreadable settings row defaults to the documented behaviour');

  const broken = createPricingStore({ pool: { query: async () => { throw Object.assign(new Error('boom'), { code: '57P01' }); } }, config, logger: silent });
  assert.equal((await broken.snapshot()).plans.length, config.plans.length, 'a snapshot always answers');
});

test('saving one currency does not disturb the other, and history records both moves', async () => {
  const { pool, store: pricing } = store([
    ['FROM plans p LEFT JOIN users u', { rows: [planRow('pro', { NGN: 10_500_000, USD: 6_900 })], rowCount: 1 }],
  ]);
  const result = await pricing.savePlanPrices({
    planKey: 'pro',
    amounts: { USD: 7_900 },
    written: { USD: true },
    actorId: 'a1',
    actorEmail: 'admin@example.test',
    note: 'dollars up',
  });
  const insert = pool.calls.find((call) => call.sql.includes('INSERT INTO plans'));
  assert.equal(insert.params[0], 'pro');
  assert.equal(insert.params[3], 7_900, 'the dollar column is what was written');
  assert.equal(insert.params[6], false, 'the naira CASE flag says: do not touch this column');
  assert.equal(insert.params[7], true);
  assert.deepEqual(result.amounts, { USD: 7_900 });
  assert.equal(result.unchanged, false);
  const history = JSON.parse(insert.params[4]);
  assert.equal(history.length, 1);
  assert.deepEqual({ currency: history[0].currency, fromMinor: history[0].fromMinor, toMinor: history[0].toMinor, note: history[0].note }, {
    currency: 'USD', fromMinor: 6_900, toMinor: 7_900, note: 'dollars up',
  });

  // Saving the identical number is not an event worth a history entry.
  const same = await pricing.savePlanPrices({ planKey: 'pro', amounts: { NGN: 10_500_000 }, written: { NGN: true } });
  assert.equal(same.unchanged, true);
  assert.equal(JSON.parse(pool.calls.at(-1).params[4]).length, 0);

  // Clearing a price falls back to the environment, and says so.
  const cleared = await pricing.savePlanPrices({ planKey: 'pro', amounts: { NGN: null }, written: { NGN: true } });
  assert.equal(cleared.cleared, true);
  assert.equal(cleared.amounts.NGN, null);

  await assert.rejects(pricing.savePlanPrices({ planKey: 'mystery', amounts: { NGN: 1000 }, written: { NGN: true } }), /not available for pricing/);
  assert.deepEqual(await pricing.savePlanPrices({ planKey: 'pro', amounts: {}, written: {} }), { unchanged: true, planKey: 'pro' });
});

test('a sync result is stored per currency, and an unverified one is never called synced', async () => {
  const { pool, store: pricing } = store();
  const stored = await pricing.recordPlanSync({
    planKey: 'pro',
    currency: 'USD',
    actorId: 'a1',
    sync: { status: 'synced', planId: 99, planToken: 'PLN-99', syncedAmountMinor: 6_900, message: 'ok', interval: 'monthly' },
  });
  assert.equal(stored.currency, 'USD');
  assert.equal(stored.syncStatus, 'synced');
  assert.equal(stored.name, 'Signal Desk Pro USD (monthly)');
  const insert = pool.calls.find((call) => call.sql.includes('INSERT INTO plan_provider_sync'));
  assert.ok(insert.sql.includes('ON CONFLICT(plan_key,currency) DO UPDATE'));
  assert.deepEqual(insert.params.slice(0, 3), ['pro', 'USD', 99]);

  // Without a plan id there is nothing to charge from, whatever the caller called it.
  const orphan = await pricing.recordPlanSync({ planKey: 'pro', currency: 'NGN', sync: { status: 'synced', planId: null } });
  assert.equal(orphan.syncStatus, 'pending');
  assert.equal((await pricing.recordPlanSync({ planKey: 'pro', currency: 'NGN', sync: { status: 'exploded', planId: 5 } })).syncStatus, 'failed', 'an unknown word is never quietly called synced');
  assert.equal((await pricing.recordPlanSync({ planKey: 'pro', currency: 'NGN', sync: { status: 'synced', planId: 0 } })).syncStatus, 'pending', 'zero is not a Flutterwave plan id');
  assert.equal(await pricing.recordPlanSync({ planKey: 'mystery', currency: 'NGN', sync: {} }), null);
});

test('billing settings are merged, not replaced, and live in the settings table', async () => {
  const { pool, store: pricing } = store([
    ['FROM admin_settings WHERE setting_key=$1', { rows: [{ setting_value: { recurringEnabled: true, updateExistingSubscriptions: false, updatedAt: '2026-01-01T00:00:00.000Z' } }], rowCount: 1 }],
  ]);
  const saved = await pricing.saveBillingSettings({ settings: { updateExistingSubscriptions: true }, actorId: 'a1' });
  assert.equal(saved.recurringEnabled, true, 'a switch nobody touched keeps its value');
  assert.equal(saved.updateExistingSubscriptions, true);
  const insert = pool.calls.find((call) => call.sql.includes('INSERT INTO admin_settings'));
  assert.equal(insert.params[0], BILLING_SETTINGS_KEY);
  assert.equal(JSON.parse(insert.params[1]).updateExistingSubscriptions, true);

  assert.equal(await pricing.saveBillingSettings({ settings: {} }), null, 'nothing to save is not a write');
});
