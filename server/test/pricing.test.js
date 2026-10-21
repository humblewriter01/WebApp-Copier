import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BILLING_SETTINGS_KEY,
  MAX_PRICE_HISTORY,
  PLAN_AMOUNT_BOUNDS,
  createPricingStore,
  mergePlanPricing,
  normalizeBillingSettings,
  normalizePlanAmount,
  normalizePricingUpdate,
  paystackPlanName,
  planChargeDecision,
  planKeyForSetting,
  priceSettingKey,
  providerPlanSettingKey,
  publicPricing,
  sanitizeProviderPlan,
  sanitizeStoredPrice,
} from '../services/pricing.js';
import { billingConfig } from '../services/billing.js';

const config = billingConfig({ PAYSTACK_SECRET_KEY: 'sk_test', PAYSTACK_CURRENCY: 'NGN' });

/** A minimal `admin_settings` + `users` stand-in that round-trips real JSON. */
function fakeStore({ rows = {}, throwOn } = {}) {
  const settings = new Map(Object.entries(rows).map(([key, value]) => [key, { setting_key: key, setting_value: value, updated_at: '2026-10-01T10:00:00.000Z', updated_by_email: null }]));
  const calls = [];
  const pool = {
    calls,
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (throwOn && sql.includes(throwOn.match)) throw Object.assign(new Error(throwOn.message), { code: throwOn.code });
      if (sql.includes('INSERT INTO admin_settings')) {
        settings.set(params[0], { setting_key: params[0], setting_value: JSON.parse(params[1]), updated_at: '2026-10-02T10:00:00.000Z', updated_by_email: 'admin@example.com' });
        return { rows: [{ settingKey: params[0], updatedAt: '2026-10-02T10:00:00.000Z' }], rowCount: 1 };
      }
      if (sql.includes('DELETE FROM admin_settings')) {
        const existed = settings.delete(params[0]);
        return { rows: [], rowCount: existed ? 1 : 0 };
      }
      if (sql.includes('FROM admin_settings')) {
        const found = params.map((key) => settings.get(key)).filter(Boolean);
        return { rows: found, rowCount: found.length };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  return { pool, settings };
}

test('admin prices are entered in the major unit and stored in the minor unit', () => {
  assert.equal(normalizePlanAmount('2500'), 250_000);
  assert.equal(normalizePlanAmount(2499.99), 249_999);
  assert.equal(normalizePlanAmount('1,250.50'), 125_050);
  assert.equal(normalizePlanAmount(''), null);
  assert.equal(normalizePlanAmount(null), null);
  assert.equal(normalizePlanAmount('   '), null);
});

test('prices below or above what Paystack can bill are refused with an explanation', () => {
  assert.throws(() => normalizePlanAmount('0'), /greater than zero/);
  assert.throws(() => normalizePlanAmount('-500'), /greater than zero/);
  assert.throws(() => normalizePlanAmount(String(PLAN_AMOUNT_BOUNDS.minMinor / 100 - 1)), /at least 100\.00/);
  assert.throws(() => normalizePlanAmount(String(PLAN_AMOUNT_BOUNDS.maxMinor / 100 + 1)), /cannot be more than/);
  assert.equal(normalizePlanAmount(String(PLAN_AMOUNT_BOUNDS.minMinor / 100)), PLAN_AMOUNT_BOUNDS.minMinor);
});

test('unreadable prices are refused before anything is written', () => {
  for (const value of ['abc', '12.005', true, {}, [], '1.2.3']) {
    assert.throws(() => normalizePlanAmount(value), /price|decimal|number/i);
  }
});

test('admin_settings keys are per plan and reversible', () => {
  assert.equal(priceSettingKey('pro'), 'pro_price');
  assert.equal(priceSettingKey('PREMIUM'), 'premium_price');
  assert.equal(providerPlanSettingKey('pro'), 'pro_paystack_plan');
  assert.equal(planKeyForSetting('pro_price'), 'pro');
  assert.equal(planKeyForSetting('billing_settings'), 'billing_settings');
});

test('a stored price is only trusted when it can be understood', () => {
  assert.deepEqual(sanitizeStoredPrice('{"amountMinor":300000}').amountMinor, 300000, 'text JSON is accepted');
  assert.equal(sanitizeStoredPrice({ amountMinor: 0 }), null);
  assert.equal(sanitizeStoredPrice({ amount: 'x' }), null);
  assert.equal(sanitizeStoredPrice(null), null);
  assert.equal(sanitizeStoredPrice('[1,2]'), null);
  assert.equal(sanitizeStoredPrice({ amountMinor: 300000, interval: 'fortnightly' }).interval, 'monthly');
  assert.equal(sanitizeStoredPrice({ amountMinor: 300000, interval: 'annually' }).interval, 'annually');
  const withHistory = sanitizeStoredPrice({ amountMinor: 300000, history: Array.from({ length: 25 }, (_value, index) => ({ toMinor: index })) });
  assert.equal(withHistory.history.length, MAX_PRICE_HISTORY, 'history stays bounded');
});

test('a Paystack plan mirror is ignored unless it names a plan code', () => {
  assert.equal(sanitizeProviderPlan({ syncStatus: 'failed' }), null);
  const record = sanitizeProviderPlan({ planCode: 'PLN_a', planId: 42, syncStatus: 'synced', syncedAmountMinor: 300000, currency: 'ngn', interval: 'MONTHLY' });
  assert.equal(record.planCode, 'PLN_a');
  assert.equal(record.planId, 42);
  assert.equal(record.syncStatus, 'synced');
  assert.equal(record.currency, 'NGN');
  assert.equal(record.interval, 'monthly');
  assert.equal(sanitizeProviderPlan({ planCode: 'PLN_a', syncStatus: 'invented' }).syncStatus, 'pending', 'an unknown state never claims to be synced');
});

test('the database price wins and the environment price stays visible', () => {
  const snapshot = mergePlanPricing({
    config,
    overrides: { pro_price: { amountMinor: 300_000, currency: 'NGN', interval: 'monthly', history: [] } },
    providerPlans: { pro_paystack_plan: { planCode: 'PLN_pro', planId: 7, syncStatus: 'synced', syncedAmountMinor: 300_000, currency: 'NGN', interval: 'monthly' } },
  });
  const pro = snapshot.plans.find((plan) => plan.key === 'pro');
  const premium = snapshot.plans.find((plan) => plan.key === 'premium');
  assert.equal(pro.amountMinor, 300_000);
  assert.equal(pro.amount, 3000);
  assert.equal(pro.source, 'database');
  assert.equal(pro.environmentAmountMinor, 250_000);
  assert.equal(pro.paystack.planCode, 'PLN_pro');
  assert.equal(premium.source, 'environment');
  assert.equal(premium.amountMinor, 600_000);
  assert.deepEqual(snapshot.byCode, { PLN_PRO: 'pro' });
  assert.equal(snapshot.recurringEnabled, true);
  assert.equal(snapshot.updateExistingSubscriptions, true);

  const paused = mergePlanPricing({ config, billingSettings: { recurringEnabled: false, updateExistingSubscriptions: false } });
  assert.equal(paused.recurringEnabled, false);
  assert.equal(paused.updateExistingSubscriptions, false);
});

test('a Paystack plan code is only used for a charge when it is verified to match', () => {
  const synced = { amountMinor: 300_000, currency: 'NGN', interval: 'monthly', paystack: { planCode: 'PLN_pro', syncStatus: 'synced', syncedAmountMinor: 300_000, currency: 'NGN', interval: 'monthly' } };
  assert.deepEqual(planChargeDecision({ plan: synced }), { usePlan: true, reason: 'ready', planCode: 'PLN_pro' });
  assert.equal(planChargeDecision({ plan: synced, hasDiscount: true }).reason, 'discounted-checkout');
  assert.equal(planChargeDecision({ plan: synced, recurringEnabled: false }).reason, 'recurring-disabled');
  assert.equal(planChargeDecision({ plan: { ...synced, paystack: {} } }).reason, 'no-plan-code');
  assert.equal(planChargeDecision({ plan: { ...synced, amountMinor: 350_000 } }).reason, 'amount-mismatch');
  assert.equal(planChargeDecision({ plan: { ...synced, paystack: { ...synced.paystack, syncStatus: 'failed' } } }).reason, 'not-synced');
  assert.equal(planChargeDecision({ plan: { ...synced, paystack: { ...synced.paystack, syncStatus: 'in_sync' } } }).usePlan, true, 'an already-matching plan is usable');
  assert.equal(planChargeDecision({ plan: { ...synced, paystack: { ...synced.paystack, currency: 'GHS' } } }).reason, 'currency-mismatch');
  assert.equal(planChargeDecision({ plan: { ...synced, paystack: { ...synced.paystack, interval: 'annually' } } }).reason, 'interval-mismatch');
  assert.equal(planChargeDecision({}).reason, 'plan-unavailable');
});

test('public pricing shows the price but never the provider plan code', () => {
  const snapshot = mergePlanPricing({
    config,
    overrides: { pro_price: { amountMinor: 300_000, currency: 'NGN', interval: 'monthly', history: [] } },
    providerPlans: { pro_paystack_plan: { planCode: 'PLN_secret', syncStatus: 'synced', syncedAmountMinor: 300_000 } },
  });
  const plans = publicPricing(snapshot);
  assert.deepEqual(plans.map((plan) => plan.key), ['pro', 'premium']);
  assert.equal(plans[0].amount, 3000);
  assert.equal(plans[0].renewsAutomatically, true);
  assert.equal(plans[1].renewsAutomatically, false);
  const json = JSON.stringify(plans);
  assert.equal(json.includes('PLN_secret'), false);
  assert.equal(json.includes('syncStatus'), false);

  const manual = publicPricing(mergePlanPricing({ config, billingSettings: { recurringEnabled: false } }));
  assert.equal(manual[0].renewsAutomatically, false);
});

test('Paystack plan names carry the interval so a change cannot collide', () => {
  assert.equal(paystackPlanName({ name: 'Pro', interval: 'monthly' }), 'Signal Desk Pro (monthly)');
});

test('the admin payload is normalised, and unknown plans are refused', () => {
  const update = normalizePricingUpdate({
    input: { plans: { pro: { amount: '3000' }, premium: null }, billing: { recurringEnabled: 'false' }, note: ' October test ' },
    config,
  });
  assert.deepEqual(update.entries, [{ planKey: 'pro', amountMinor: 300_000 }, { planKey: 'premium', amountMinor: null }]);
  assert.deepEqual(update.billing, { recurringEnabled: false });
  assert.equal(update.note, 'October test');
  assert.deepEqual(update.syncPlanKeys, ['pro', 'premium'], 'a cleared price also needs a re-sync');

  assert.throws(() => normalizePricingUpdate({ input: { plans: { platinum: { amount: 1 } } }, config }), /not available/i);
  assert.throws(() => normalizePricingUpdate({ input: { plans: { pro: '3000' } }, config }), /object with an amount/i);
  assert.throws(() => normalizePricingUpdate({ input: {}, config }), /Choose a price or billing switch/);
  assert.throws(() => normalizePricingUpdate({ input: { plans: { pro: {} } }, config }), /needs a price/);
  assert.throws(() => normalizePricingUpdate({ input: { plans: { pro: { amount: 'oops' } } }, config }), /plain number/i);
});

test('billing switches are parsed strictly', () => {
  assert.deepEqual(normalizeBillingSettings({ recurringEnabled: true, updateExistingSubscriptions: 'no' }), { recurringEnabled: true, updateExistingSubscriptions: false });
  assert.throws(() => normalizeBillingSettings({}), /billing switch/i);
  assert.throws(() => normalizeBillingSettings({ recurringEnabled: 'maybe' }), /true or false/i);
});

test('saving a price writes pro_price with a bounded history and preserves the paystack link', async () => {
  const { pool, settings } = fakeStore();
  const store = createPricingStore({ pool, config, logger: { info() {}, warn() {}, error() {} } });

  const saved = await store.savePlanPrice({ planKey: 'pro', amountMinor: 300_000, actorId: 'user-1', actorEmail: 'admin@example.com', note: 'launch' });
  assert.equal(saved.unchanged, false);
  assert.equal(saved.previousAmountMinor, 250_000, 'the first change records the environment price as the previous one');
  const row = settings.get('pro_price').setting_value;
  assert.equal(row.amountMinor, 300_000);
  assert.equal(row.currency, 'NGN');
  assert.equal(row.interval, 'monthly');
  assert.equal(row.history[0].note, 'launch');
  assert.equal(row.history[0].by, 'admin@example.com');
  assert.equal(row.paystack, undefined, 'the price row never stores provider state');

  const again = await store.savePlanPrice({ planKey: 'pro', amountMinor: 300_000, actorId: 'user-1' });
  assert.equal(again.unchanged, true, 'an identical price without a note is a no-op');
  const noted = await store.savePlanPrice({ planKey: 'pro', amountMinor: 300_000, actorId: 'user-1', note: 'audit entry' });
  assert.equal(noted.unchanged, false);
  assert.equal(settings.get('pro_price').setting_value.history.length, 2);

  await assert.rejects(store.savePlanPrice({ planKey: 'platinum', amountMinor: 1000 }), /not available/i);
});

test('clearing a price removes only the price row', async () => {
  const { pool, settings } = fakeStore({ rows: { pro_price: { amountMinor: 300_000 }, pro_paystack_plan: { planCode: 'PLN_pro', syncStatus: 'synced', syncedAmountMinor: 300_000 } } });
  const store = createPricingStore({ pool, config, logger: { info() {}, warn() {}, error() {} } });
  const cleared = await store.savePlanPrice({ planKey: 'pro', amountMinor: null });
  assert.deepEqual(cleared, { cleared: true, removed: true, planKey: 'pro' });
  assert.equal(settings.has('pro_price'), false);
  assert.equal(settings.has('pro_paystack_plan'), true, 'the provider link survives so re-syncing can find the plan');
  const snapshot = await store.snapshot();
  assert.equal(snapshot.plans[0].amountMinor, 250_000, 'the environment price becomes active again');
  assert.equal(snapshot.plans[0].source, 'environment');
  assert.equal(planChargeDecision({ plan: snapshot.plans[0] }).reason, 'amount-mismatch', 'a stale plan code is never charged');
});

test('a sync result is stored next to the price, not inside it', async () => {
  const { pool, settings } = fakeStore({ rows: { pro_price: { amountMinor: 300_000, interval: 'monthly', currency: 'NGN', history: [{ at: 'x', toMinor: 300_000 }] } } });
  const store = createPricingStore({ pool, config, logger: { info() {}, warn() {}, error() {} } });
  await store.recordPlanSync({
    planKey: 'pro',
    actorId: 'user-1',
    sync: { status: 'synced', planCode: 'PLN_pro', planId: 91, syncedAmountMinor: 300_000, message: 'Paystack plan created.' },
  });
  const mirror = settings.get('pro_paystack_plan').setting_value;
  assert.equal(mirror.planCode, 'PLN_pro');
  assert.equal(mirror.planId, 91);
  assert.equal(mirror.syncStatus, 'synced');
  assert.equal(mirror.name, 'Signal Desk Pro (monthly)');
  assert.equal(settings.get('pro_price').setting_value.amountMinor, 300_000, 'the price row is untouched');

  await store.recordPlanSync({ planKey: 'pro', sync: { status: 'invented', planCode: 'PLN_pro' } });
  assert.equal(settings.get('pro_paystack_plan').setting_value.syncStatus, 'failed', 'an unrecognised state cannot claim success');

  const snapshot = await store.snapshot();
  assert.equal(snapshot.plans[0].paystack.planCode, 'PLN_pro');
  assert.equal(snapshot.plans[0].history.length, 1);
});

test('a sync attempt without a stored price does not invent one', async () => {
  const { pool, settings } = fakeStore();
  const store = createPricingStore({ pool, config, logger: { info() {}, warn() {}, error() {} } });
  await store.recordPlanSync({ planKey: 'premium', sync: { status: 'synced', planCode: 'PLN_p', syncedAmountMinor: 600_000 } });
  assert.equal(settings.has('premium_price'), false);
  assert.equal(settings.get('premium_paystack_plan').setting_value.amountMinor, undefined, 'the mirror stores provider state only');
  const snapshot = await store.snapshot();
  assert.equal(snapshot.plans[1].amountMinor, 600_000);
  assert.equal(snapshot.plans[1].source, 'environment');
});

test('billing settings round-trip and merge', async () => {
  const { pool, settings } = fakeStore();
  const store = createPricingStore({ pool, config, logger: { info() {}, warn() {}, error() {} } });
  await store.saveBillingSettings({ settings: { recurringEnabled: false }, actorId: 'user-1' });
  await store.saveBillingSettings({ settings: { updateExistingSubscriptions: false } });
  assert.deepEqual(settings.get(BILLING_SETTINGS_KEY).setting_value.recurringEnabled, false);
  assert.equal(settings.get(BILLING_SETTINGS_KEY).setting_value.updateExistingSubscriptions, false);
  const loaded = await store.loadBillingSettings();
  assert.deepEqual(loaded, { recurringEnabled: false, updateExistingSubscriptions: false });
  const snapshot = await store.snapshot();
  assert.equal(snapshot.recurringEnabled, false);
  assert.equal(snapshot.updateExistingSubscriptions, false);
});

test('a broken settings table or row cannot take checkout down', async () => {
  let warnings = 0;
  const broken = createPricingStore({
    pool: { async query() { throw Object.assign(new Error('down'), { code: '57P01' }); } },
    config,
    logger: { info() {}, warn() { warnings += 1; }, error() {} },
  });
  const snapshot = await broken.snapshot();
  assert.ok(warnings >= 1, 'the degradation is logged, never silent');
  assert.equal(snapshot.plans[0].amountMinor, 250_000, 'falls back to the deployed price');
  assert.equal(snapshot.recurringEnabled, true);

  const unreadable = createPricingStore({
    pool: { async query() { return { rows: [{ setting_key: 'pro_price', setting_value: { nonsense: true } }, { setting_key: 'premium_paystack_plan', setting_value: 'not json' }] }; } },
    config,
    logger: { info() {}, warn() {}, error() {} },
  });
  const second = await unreadable.snapshot();
  assert.equal(second.plans[0].source, 'environment');
  assert.equal(second.plans[0].paystack.planCode, null);
});

test('pricing reads only ask for the settings they own', async () => {
  const { pool } = fakeStore();
  const store = createPricingStore({ pool, config, logger: { info() {}, warn() {}, error() {} } });
  await store.snapshot();
  const selects = pool.calls.filter((call) => call.sql.includes('FROM admin_settings'));
  assert.equal(selects.length, 3);
  const keys = selects.flatMap((call) => call.params);
  assert.deepEqual([...new Set(keys)].sort(), ['billing_settings', 'premium_paystack_plan', 'premium_price', 'pro_paystack_plan', 'pro_price'].sort());
  assert.equal(keys.includes('PAYSTACK_SECRET_KEY'), false);
});
