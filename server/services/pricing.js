/**
 * Database-backed plan pricing, in every currency the workspace sells in.
 *
 * A price is data, so it lives in a table and not in an environment variable:
 *
 *   plans(plan_key, interval, price_ngn_minor, price_usd_minor, price_history, updated_by, ...)
 *     one row per paid plan. Both prices are stored in their currency's smallest unit - kobo and cents -
 *     because "60000" means ₦60,000 in one column and $60,000 in the next, and a migration between two
 *     providers with different unit conventions is exactly where an ambiguous number becomes a wrong charge.
 *     The major unit exists only in the moment Flutterwave is spoken to (`toMajorAmount`).
 *
 *   plan_provider_sync(plan_key, currency, provider_plan_id, sync_status, synced_amount_minor, ...)
 *     the mirror of the Flutterwave payment plan used for recurring charges, one row per (plan, currency),
 *     because a Flutterwave plan holds one amount in one currency.
 *
 * `admin_settings.billing_settings` keeps the two behaviour switches, which are not prices.
 *
 * Three rules make this safe to run a business on:
 *
 * 1. A plan with no stored row, or a column that cannot be read, falls back to the deployed environment price.
 *    A broken setting can never take checkout down.
 * 2. `planChargeDecision` only lets a checkout be raised through a provider plan when the mirror is confirmed
 *    to hold this price in this currency, so a stale or half-finished sync degrades to a verified one-time
 *    charge instead of charging the customer the wrong amount.
 * 3. Deleting one currency's price never touches the other: a save states what it wrote.
 */

import { SUPPORTED_CURRENCIES, formatAmount, planPriceMinor, planPrices, normalizeCurrency } from './billing.js';

export const BILLING_SETTINGS_KEY = 'billing_settings';
export const MAX_PRICE_HISTORY = 10;

/**
 * What each currency may be priced between.
 *
 * The minimum is Flutterwave's own floor for a payment-plan charge; the maximum is the workspace's guard rail
 * against a mistyped price (₦10,000,000 / $10,000,000), which is also the point at which the number stops
 * fitting the columns' expectations. These are validation rails, not a replacement for the provider's answer:
 * a rejected amount surfaces as a sync failure with the provider's message.
 */
export const PLAN_AMOUNT_BOUNDS = Object.freeze({
  NGN: Object.freeze({ minMinor: 10_000, maxMinor: 1_000_000_000 }),
  USD: Object.freeze({ minMinor: 100, maxMinor: 1_000_000_000 }),
});

const SYNC_STATUSES = new Set(['synced', 'in_sync', 'failed', 'not_configured', 'not_priced', 'pending']);
const INTERVALS = new Set(['hourly', 'daily', 'weekly', 'monthly', 'quarterly', 'biannually', 'annually']);

function pricingError(message) {
  const error = new Error(message);
  error.status = 400;
  error.code = 'PRICING_VALIDATION_ERROR';
  return error;
}

function normalizeKey(value) {
  return String(value || '').trim().toLowerCase();
}

function roundMinor(value) {
  return Math.round(Number(value));
}

function optionalText(value, max = 300) {
  const text = value === null || value === undefined ? '' : String(value).trim();
  return text ? text.slice(0, max) : null;
}

function optionalInteger(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

function parseJsonValue(value) {
  if (value && typeof value === 'object') return value;
  if (typeof value === 'string' && value.trim()) {
    try { return JSON.parse(value); } catch { return null; }
  }
  return null;
}

/**
 * Converts an administrator-entered price into the smallest unit of `currency`.
 *
 * `null` for an empty value means "remove the stored price and fall back to the deployed default", which is
 * different from `0` - zero is a price, and a zero price is a way to give the plan away.
 */
export function normalizePlanAmount(value, { planName = 'This plan', currency = 'NGN', bounds = null } = {}) {
  const code = normalizeCurrency(currency);
  const limits = bounds || PLAN_AMOUNT_BOUNDS[code] || PLAN_AMOUNT_BOUNDS.NGN;
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean' || Array.isArray(value)) throw pricingError(`${planName} needs a price such as 2500.`);
  const text = String(value).trim().replace(/[\s,]/g, '');
  if (!text) return null;
  if (!/^-?\d*(\.\d*)?$/.test(text)) throw pricingError(`${planName} needs a plain number such as 2500 or 2499.99.`);
  const parsed = Number(text);
  if (!Number.isFinite(parsed)) throw pricingError(`${planName} needs a price such as 2500.`);
  const minor = parsed * 100;
  if (Math.abs(minor - roundMinor(minor)) > 1e-6) {
    throw pricingError(`${planName} cannot be more precise than two decimal places.`);
  }
  const amountMinor = roundMinor(minor);
  if (amountMinor <= 0) throw pricingError(`${planName} must be greater than zero.`);
  if (amountMinor < limits.minMinor) {
    throw pricingError(`${planName} must be at least ${formatAmount(limits.minMinor, code)}, the minimum Flutterwave charge for a subscription plan in ${code}.`);
  }
  if (amountMinor > limits.maxMinor) {
    throw pricingError(`${planName} cannot be more than ${formatAmount(limits.maxMinor, code)}.`);
  }
  return amountMinor;
}

/** The stored history of a plan's prices, oldest-last and capped, from either a JSONB array or a text column. */
export function sanitizePriceHistory(raw) {
  const value = parseJsonValue(raw);
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_PRICE_HISTORY).map((entry) => ({
    at: optionalText(entry?.at, 40),
    by: optionalText(entry?.by, 160),
    currency: entry?.currency ? normalizeCurrency(entry.currency) : null,
    fromMinor: optionalInteger(entry?.fromMinor ?? entry?.from_minor),
    toMinor: optionalInteger(entry?.toMinor ?? entry?.to_minor),
    note: optionalText(entry?.note, 200),
  }));
}

/** A `plans` row read back into the shape the rest of the workspace consumes. */
export function sanitizeStoredPrice(row) {
  const value = row && typeof row === 'object' ? row : null;
  if (!value) return null;
  const amounts = {};
  for (const code of SUPPORTED_CURRENCIES) {
    const column = code === 'USD'
      ? (value.USD ?? value.usdAmountMinor ?? value.price_usd_minor)
      : (value.NGN ?? value.amountMinor ?? value.price_ngn_minor);
    const minor = optionalInteger(column);
    if (Number.isFinite(minor) && minor > 0) amounts[code] = minor;
  }
  if (!Object.keys(amounts).length) return null;
  const storedInterval = optionalText(value.interval, 20);
  return {
    ...amounts,
    amountMinor: amounts.NGN ?? amounts.USD ?? null,
    currency: normalizeCurrency(value.currency),
    interval: storedInterval && INTERVALS.has(storedInterval.toLowerCase()) ? storedInterval.toLowerCase() : null,
    history: sanitizePriceHistory(value.history ?? value.price_history),
  };
}

/** A `plan_provider_sync` row, or the JSON of a legacy `<plan>_paystack_plan` setting, read defensively. */
export function sanitizeProviderPlan(raw) {
  const value = raw && typeof raw === 'object' ? raw : parseJsonValue(raw);
  if (!value) return null;
  const requestedStatus = String(value.syncStatus ?? value.sync_status ?? '').toLowerCase();
  const planId = optionalInteger(value.planId ?? value.plan_id ?? value.providerPlanId ?? value.provider_plan_id);
  /* The legacy Paystack mirror stored a `planCode` string. It is kept as `legacyCode` on the way in so a
     workspace that migrates mid-subscription can still be told which old plan it is looking at, but it can
     never satisfy a Flutterwave decision: those ids are numeric and belong to a different account. */
  const legacyCode = optionalText(value.planCode ?? value.plan_code ?? value.legacyCode, 60);
  const interval = optionalText(value.interval, 20)?.toLowerCase() || null;
  return {
    planId,
    legacyCode,
    syncStatus: planId !== null && SYNC_STATUSES.has(requestedStatus) ? requestedStatus : 'pending',
    syncedAmountMinor: optionalInteger(value.syncedAmountMinor ?? value.synced_amount_minor),
    syncedAt: optionalText(value.syncedAt ?? value.synced_at, 40),
    currency: optionalText(value.currency, 8)?.toUpperCase() || null,
    interval,
    name: optionalText(value.name, 120),
    message: optionalText(value.message, 300),
    error: optionalText(value.error, 300),
  };
}

/** The per-currency mirror, with an entry for every currency the workspace offers. */
export function emptyProviderMirror() {
  const out = {};
  for (const code of SUPPORTED_CURRENCIES) out[code] = { planId: null, syncStatus: 'pending', syncedAmountMinor: null };
  return out;
}

/**
 * Merges the environment defaults with the stored prices and provider mirrors.
 *
 * The database wins wherever it holds a usable number for that currency, so the site always charges and
 * displays what an administrator last saved - per currency, and never by averaging the two.
 *
 * @typedef {Object} MergePlanPricingInput
 * the three sources of a price, deliberately kept apart: what the app was told, what the app saved, and what the provider says it charges. The answer merges them and never averages them, so a currency that only one of them has is an answer, not an error.
 * @property {Record<string, any>} [config] - the app's own billing config, `plans` included
 * @property {Record<string, any>} [planRows] - rows of `plans` keyed by plan key, each holding the per-currency minor amounts
 * @property {Record<string, any>} [providerPlans] - what Flutterwave says it charges, keyed by plan then currency
 * @property {Record<string, any>} [billingSettings] - the JSONB settings blob, including whether renewals are enabled at all
 */
export function mergePlanPricing(/** @type {MergePlanPricingInput} */ { config, planRows = {}, providerPlans = {}, billingSettings = {} } = {}) {
  const currency = normalizeCurrency(config?.currency);
  const interval = config?.interval || 'monthly';
  const recurringEnabled = billingSettings.recurringEnabled !== false;
  const updateExistingSubscriptions = billingSettings.updateExistingSubscriptions !== false;
  const plans = (config?.plans || []).map((definition) => {
    const stored = planRows[definition.key] || null;
    const amounts = {};
    const sources = {};
    for (const code of SUPPORTED_CURRENCIES) {
      const storedMinor = stored?.[code] ?? null;
      const fallback = planPriceMinor(definition, code);
      amounts[code] = storedMinor ?? fallback;
      sources[code] = storedMinor === null || storedMinor === undefined ? 'environment' : 'database';
    }
    const provider = emptyProviderMirror();
    const storedSync = providerPlans[definition.key] || null;
    for (const code of SUPPORTED_CURRENCIES) {
      const record = storedSync?.[code];
      if (record) provider[code] = { ...provider[code], ...record, currency: code };
    }
    const plan = {
      key: definition.key,
      name: definition.name,
      description: definition.description,
      limits: definition.limits,
      amountMinor: amounts[currency] ?? amounts.NGN ?? null,
      amount: (amounts[currency] ?? amounts.NGN ?? null) === null ? null : (amounts[currency] ?? amounts.NGN) / 100,
      usdAmountMinor: amounts.USD ?? null,
      usdAmount: amounts.USD === null || amounts.USD === undefined ? null : amounts.USD / 100,
      prices: planPrices({ amountMinor: amounts.NGN, usdAmountMinor: amounts.USD }, { interval: stored?.interval || interval }),
      currency,
      interval: stored?.interval || interval,
      source: sources[currency] || 'environment',
      sources,
      environmentAmountMinor: planPriceMinor(definition, currency),
      environmentUsdAmountMinor: planPriceMinor(definition, 'USD'),
      stored: Object.values(sources).includes('database'),
      recurringEnabled,
      updateExistingSubscriptions,
      updatedAt: stored?.updatedAt || null,
      updatedBy: stored?.updatedBy || null,
      history: stored?.history || [],
      provider,
    };
    return Object.freeze({ ...plan, prices: Object.freeze(plan.prices), provider: Object.freeze(plan.provider) });
  });
  const byId = {};
  for (const plan of plans) {
    for (const [code, sync] of Object.entries(plan.provider)) {
      if (sync.planId !== null && sync.planId !== undefined) byId[`${code}:${sync.planId}`] = plan.key;
    }
  }
  return { currency, interval, recurringEnabled, updateExistingSubscriptions, plans, byId, byCode: byId };
}

/**
 * Decides whether a checkout in `currency` may be raised through a Flutterwave payment plan.
 *
 * A plan id makes Flutterwave charge the plan's amount and repeat it every interval, so it is only safe when
 * the mirrored plan is confirmed to carry exactly the price about to be shown - in the same currency, because
 * a plan is single-currency and a USD customer pointed at an NGN plan is a customer charged the wrong thing in
 * a language they cannot read. A discount cannot sit on top of a plan price, so discounted checkouts stay
 * one-time.
 *
 * @typedef {Object} PlanChargeDecisionInput
 * the question the checkout asks: what to charge, and whether to subscribe them. Every field is optional because the caller has already decided what it knows - a plan with no saved price for this currency is a normal state, not a missing argument.
 * @property {Record<string, any>} [plan] - the app's plan definition, not the provider's
 * @property {string|null} [currency]
 * @property {number|null} [amountMinor] - a minor-unit integer for one currency; NUMERIC in the database, so text out of the driver and a number by the time it is here
 * @property {boolean} [recurringEnabled]
 * @property {boolean} [hasDiscount]
 */
export function planChargeDecision(/** @type {PlanChargeDecisionInput} */ { plan, currency = null, amountMinor = null, recurringEnabled = true, hasDiscount = false } = {}) {
  if (!plan) return { usePlan: false, reason: 'plan-unavailable' };
  if (!recurringEnabled) return { usePlan: false, reason: 'recurring-disabled' };
  if (hasDiscount) return { usePlan: false, reason: 'discounted-checkout' };
  const code = normalizeCurrency(currency || plan.currency);
  const expected = amountMinor ?? planPriceMinor(plan, code);
  const sync = plan.provider?.[code] || {};
  if (!sync.planId) return { usePlan: false, reason: 'no-plan-id' };
  if (sync.syncStatus !== 'synced' && sync.syncStatus !== 'in_sync') return { usePlan: false, reason: 'not-synced' };
  if (Number(sync.syncedAmountMinor) !== Number(expected)) return { usePlan: false, reason: 'amount-mismatch' };
  if (sync.currency && String(sync.currency).toUpperCase() !== code) return { usePlan: false, reason: 'currency-mismatch' };
  if (sync.interval && plan.interval && String(sync.interval).toLowerCase() !== String(plan.interval).toLowerCase()) {
    return { usePlan: false, reason: 'interval-mismatch' };
  }
  return { usePlan: true, reason: 'ready', planId: sync.planId, currency: code };
}

/** Names given to Flutterwave payment plans, so an interval or currency change never collides. */
export function providerPlanName(plan, currency) {
  const code = normalizeCurrency(currency);
  return `Signal Desk ${plan.name} ${code === 'NGN' ? '' : `${code} `}(${plan.interval || 'monthly'})`.replace(/\s+/g, ' ').trim().slice(0, 90);
}

/**
 * Plans in the shape the public billing page consumes: no plan ids, no sync state, both currencies.
 *
 * The flat `amountMinor`/`amount` pair is the price in `currency` (the workspace default) and is what a client
 * that has not been taught about currencies reads; `prices` is the map the currency switch toggles against. They
 * are the same number from the same snapshot, so the two can never disagree.
 */
export function publicPricing(snapshot) {
  return (snapshot?.plans || []).map((plan) => ({
    key: plan.key,
    name: plan.name,
    description: plan.description,
    currency: plan.currency,
    interval: plan.interval,
    amountMinor: plan.amountMinor,
    amount: plan.amountMinor === null ? null : plan.amountMinor / 100,
    usdAmountMinor: plan.usdAmountMinor,
    usdAmount: plan.usdAmountMinor === null ? null : plan.usdAmountMinor / 100,
    prices: plan.prices,
    limits: plan.limits,
    renewsAutomatically: Object.fromEntries(SUPPORTED_CURRENCIES.map((code) => [
      code,
      Boolean(snapshot.recurringEnabled && plan.provider?.[code]?.planId !== null && plan.provider?.[code]?.planId !== undefined
        && (plan.provider[code].syncStatus === 'synced' || plan.provider[code].syncStatus === 'in_sync')),
    ])),
  }));
}

function normalizeFlag(value) {
  if (value === undefined) return undefined;
  if (typeof value === 'boolean') return value;
  const text = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(text)) return true;
  if (['false', '0', 'no', 'off'].includes(text)) return false;
  throw pricingError('Billing switches must be true or false.');
}

/**
 * Validates the `PUT /api/admin/pricing` body into storable prices, one per currency.
 *
 * A currency the request does not mention is left alone, which is what lets the panel save one field at a
 * time; `null` clears a price back to its deployed default. Every touched (plan, currency) pair needs a
 * provider re-sync, because the amount a renewal charges changed either way.
 * @param {Record<string, any>} request.input - the administrator's body exactly as it arrived: validating it is this function's whole job, so nothing may assume a field here
 *
 * @typedef {Object} NormalizePricingUpdateInput
 * @property {Record<string, any>} [input] - the administrator's body exactly as it arrived - validating it is this function's whole job, so nothing below may assume a field is present
 * @property {Record<string, any>} [config]
 * @property {boolean} [allowEmpty] - an empty body is a save that changed nothing, which is only an error on the first save
 */
export function normalizePricingUpdate(/** @type {NormalizePricingUpdateInput} */ { input, config, allowEmpty = false } = {}) {
  const plans = input?.plans && typeof input.plans === 'object' && !Array.isArray(input.plans) ? input.plans : {};
  const known = new Set((config.plans || []).map((plan) => plan.key));
  for (const key of Object.keys(plans)) {
    if (!known.has(normalizeKey(key))) throw pricingError('That plan is not available for pricing.');
  }
  const entries = [];
  for (const plan of config.plans || []) {
    if (!Object.hasOwn(plans, plan.key)) continue;
    const raw = plans[plan.key];
    if (raw === null) {
      entries.push({ planKey: plan.key, amounts: { NGN: null, USD: null }, written: { NGN: true, USD: true } });
      continue;
    }
    if (typeof raw !== 'object') {
      const amountMinor = normalizePlanAmount(raw, { planName: plan.name, currency: 'NGN' });
      if (amountMinor === null && !allowEmpty) throw pricingError(`${plan.name} needs a price, or send null to remove the override.`);
      entries.push({ planKey: plan.key, amounts: { NGN: amountMinor }, written: { NGN: true } });
      continue;
    }
    const amounts = {};
    const written = {};
    for (const code of SUPPORTED_CURRENCIES) {
      const majorKeys = code === 'USD' ? ['amountUsd', 'usdAmount'] : ['amount', 'amountNgn', 'ngnAmount'];
      const minorKeys = code === 'USD' ? ['usdAmountMinor', 'amountUsdMinor'] : ['amountMinor'];
      const minorKey = minorKeys.find((key) => Object.hasOwn(raw, key));
      const majorKey = majorKeys.find((key) => Object.hasOwn(raw, key));
      const label = `${plan.name} (${code})`;
      let minor;
      /* An explicit null is a different instruction from an empty field: "stop storing a price in this
         currency" versus "I have not typed one yet". Only the first one reaches here as a value, so it is
         honoured, and an empty field is still the error it has always been. */
      const cleared = (minorKey !== undefined && raw[minorKey] === null) || (minorKey === undefined && majorKey !== undefined && raw[majorKey] === null);
      if (minorKey !== undefined) {
        const value = raw[minorKey];
        minor = value === null || value === undefined || value === '' ? null : normalizePlanAmount(Number(value) / 100, { planName: label, currency: code });
      } else if (majorKey !== undefined) {
        minor = raw[majorKey] === null ? null : normalizePlanAmount(raw[majorKey], { planName: label, currency: code });
      } else {
        continue;
      }
      if (minor === null && !allowEmpty && !cleared) throw pricingError(`${plan.name} needs a price in ${code}, or send null to remove the override.`);
      amounts[code] = minor;
      written[code] = true;
    }
    if (!Object.keys(written).length) continue;
    entries.push({ planKey: plan.key, amounts, written });
  }

  const billing = {};
  const flag = normalizeFlag(input?.billing?.recurringEnabled ?? input?.recurringEnabled);
  if (flag !== undefined) billing.recurringEnabled = flag;
  const migrate = normalizeFlag(input?.billing?.updateExistingSubscriptions ?? input?.updateExistingSubscriptions);
  if (migrate !== undefined) billing.updateExistingSubscriptions = migrate;

  const note = optionalText(input?.note, 200);
  if (!entries.length && !Object.keys(billing).length) throw pricingError('Choose a price or billing switch to save.');
  const syncPlanKeys = entries
    .filter((entry) => Object.keys(entry.written || {}).length)
    .map((entry) => ({ planKey: entry.planKey, currencies: Object.keys(entry.written) }));
  return { entries, billing, note, syncPlanKeys };
}

/**
 * A `*Minor` field is divided by 100 and a bare `amount` is not, and the field name is the only thing that
 * decides which - never the size of the number. Guessing from magnitude is how a workspace ends up charging
 * ₦600,000 because ₦60,000 looked too small to be true.
 */
export function normalizeBillingSettings(input = {}) {
  const settings = {};
  const recurringEnabled = normalizeFlag(input.recurringEnabled);
  if (recurringEnabled !== undefined) settings.recurringEnabled = recurringEnabled;
  const updateExistingSubscriptions = normalizeFlag(input.updateExistingSubscriptions);
  if (updateExistingSubscriptions !== undefined) settings.updateExistingSubscriptions = updateExistingSubscriptions;
  if (!Object.keys(settings).length) throw pricingError('Choose a billing switch to save.');
  return settings;
}

/* ------------------------------------------------------------------------- the store ------------------------------------------------------------------------ */

/* `updated_by` is a foreign key, and an email in an audit column is what a support conversation needs - so the
   read joins the account that saved the price rather than showing a uuid an administrator cannot act on. */
const PLAN_SELECT = `
  SELECT p.plan_key AS "planKey",p.interval,p.price_ngn_minor AS "NGN",p.price_usd_minor AS "USD",
         p.price_history AS history,p.updated_at AS "updatedAt",u.email AS "updatedBy"
  FROM plans p LEFT JOIN users u ON u.id = p.updated_by`

const SYNC_SELECT = `
  SELECT plan_key AS "planKey",currency,provider_plan_id AS "planId",sync_status AS "syncStatus",
         synced_amount_minor AS "syncedAmountMinor",synced_at AS "syncedAt",provider_name AS name,
         message,error,interval
  FROM plan_provider_sync`;

/**
 * Reads and writes prices in the `plans` and `plan_provider_sync` tables.
 *
 * Every failure degrades to the environment price, because billing must keep working even when a setting is
 * unreadable: a pricing table that cannot be read is a reason to log loudly, not a reason a trader cannot
 * start their month.
 * @param {PoolLike} deps.pool
 *
 * @typedef {Object} PricingStoreDeps
 * `pool` and `config` are checked in the body rather than by the signature: the store is built at module scope, where a missing dependency has to name itself in a thrown sentence instead of failing as an undefined-property error two hundred lines later.
 * @property {PoolLike} [pool]
 * @property {Record<string, any>} [config]
 * @property {LoggerMethods} [logger] - any subset of levels - the server hands this store a `warn`-only view of its own log, and a type that demanded a whole `Console` would say that caller is broken
 */
export function createPricingStore(/** @type {PricingStoreDeps} */ { pool, config, logger = console } = {}) {
  const log = (level, message, extra = {}) => logger?.[level]?.(message, extra);

  async function loadRows(sql, label) {
    try {
      const { rows } = await pool.query(sql);
      return rows || [];
    } catch (error) {
      log('warn', `${label} could not be read; falling back to the deployed prices`, { code: error.code || 'PRICING_READ_FAILED' });
      return [];
    }
  }

  async function loadPlanRows() {
    const rows = await loadRows(PLAN_SELECT, 'Stored plan prices');
    const out = {};
    for (const row of rows) {
      const planKey = normalizeKey(row.planKey);
      if (!config.plans.some((plan) => plan.key === planKey)) continue;
      const sanitized = sanitizeStoredPrice(row);
      if (!sanitized) {
        log('warn', 'Ignoring an unreadable stored price', { planKey });
        continue;
      }
      const stamp = row.updatedAt ?? row.updated_at ?? null;
      out[planKey] = {
        ...sanitized,
        updatedAt: stamp ? new Date(stamp).toISOString() : null,
        updatedBy: row.updatedBy || null,
      };
    }
    return out;
  }

  async function loadProviderPlans() {
    const rows = await loadRows(SYNC_SELECT, 'Flutterwave plan mirrors');
    const out = {};
    for (const row of rows) {
      const planKey = normalizeKey(row.planKey);
      if (!config.plans.some((plan) => plan.key === planKey)) continue;
      const code = normalizeCurrency(row.currency);
      const sanitized = sanitizeProviderPlan({ ...row, currency: code });
      if (!sanitized) continue;
      out[planKey] = { ...(out[planKey] || {}), [code]: sanitized };
    }
    return out;
  }

/**
 * Returns the billing settings blob. Open-ended on purpose: it is a JSONB document that accumulates keys
 * (`updatedAt` is one, an operator's note would be another), so the type says "a record" rather than freezing
 * a list that the write path is not allowed to close.
 * 
 * @returns {Promise<Record<string, any>>}
 */
  async function loadBillingSettings() {
    try {
      const { rows } = await pool.query('SELECT setting_value FROM admin_settings WHERE setting_key=$1 LIMIT 1', [BILLING_SETTINGS_KEY]);
      const value = parseJsonValue(rows[0]?.setting_value) || {};
      return {
        recurringEnabled: typeof value.recurringEnabled === 'boolean' ? value.recurringEnabled : undefined,
        updateExistingSubscriptions: typeof value.updateExistingSubscriptions === 'boolean' ? value.updateExistingSubscriptions : undefined,
      };
    } catch (error) {
      log('warn', 'Billing settings could not be read; using the defaults', { code: error.code || 'PRICING_READ_FAILED' });
      return {};
    }
  }

  /** Everything the admin panel and checkout need, in one read of both tables. */
  async function snapshot() {
    const [planRows, providerPlans, billingSettings] = await Promise.all([
      loadPlanRows(),
      loadProviderPlans(),
      loadBillingSettings(),
    ]);
    return mergePlanPricing({ config, planRows, providerPlans, billingSettings });
  }

  async function planFor(planKey) {
    const { plans } = await snapshot();
    return plans.find((plan) => plan.key === normalizeKey(planKey)) || null;
  }

  /**
   * Saves (or clears) the stored prices for one plan.
   *
   * `amounts` states the value per currency and `written` states which currencies this call is allowed to
   * change, which is what stops a save of the naira price from quietly zeroing the dollar one. The history
   * entry is appended here rather than by a trigger, because the row it describes is being assembled anyway.
 * @param {string} request.planKey
 *
 * @typedef {Object} SavePlanPricesInput
 * @property {string} [planKey]
 * @property {Record<string, any>} [amounts] - minor amounts keyed by currency code
 * @property {Record<string, any>} [written] - the amounts actually persisted, same keys
 * @property {string|null} [actorId] - the administrator's row id, as text: a UUID, never a number
 * @property {string|null} [actorEmail]
 * @property {string|null} [note]
 * @property {string|null} [interval]
 */
async function savePlanPrices(/** @type {SavePlanPricesInput} */ { planKey, amounts = {}, written = {}, actorId = null, actorEmail = null, note = null, interval = null } = {}) {
    const definition = (config.plans || []).find((plan) => plan.key === normalizeKey(planKey));
    if (!definition) throw pricingError('That plan is not available for pricing.');
    const currencies = SUPPORTED_CURRENCIES.filter((code) => Object.hasOwn(written, code) || Object.hasOwn(amounts, code));
    if (!currencies.length) return { unchanged: true, planKey: definition.key };

    const { rows: existingRows } = await pool.query(`${PLAN_SELECT} WHERE p.plan_key=$1`, [definition.key]);
    const existing = sanitizeStoredPrice(existingRows[0]) || null;
    const historyEntryFor = (code, toMinor) => ({
      at: new Date().toISOString(),
      by: actorEmail || null,
      currency: code,
      fromMinor: existing?.[code] ?? planPriceMinor(definition, code),
      toMinor,
      note: note || null,
    });
    const entries = currencies.map((code) => historyEntryFor(code, amounts[code] ?? null));
    const changed = entries.filter((entry, index) => Number(existing?.[currencies[index]] ?? -1) !== Number(entry.toMinor));
    const history = [...changed.map((entry) => entry), ...(existing?.history || [])].slice(0, MAX_PRICE_HISTORY);

    const ngn = Object.hasOwn(amounts, 'NGN') ? amounts.NGN : null;
    const usd = Object.hasOwn(amounts, 'USD') ? amounts.USD : null;
    const writeNgn = currencies.includes('NGN');
    const writeUsd = currencies.includes('USD');
    const { rows } = await pool.query(
      `INSERT INTO plans(plan_key,interval,price_ngn_minor,price_usd_minor,price_history,updated_by,created_at,updated_at)
       VALUES($1,$2,$3,$4,$5::jsonb,$6,NOW(),NOW())
       ON CONFLICT(plan_key) DO UPDATE SET
         interval=COALESCE(EXCLUDED.interval,plans.interval),
         price_ngn_minor=CASE WHEN $7::boolean THEN EXCLUDED.price_ngn_minor ELSE plans.price_ngn_minor END,
         price_usd_minor=CASE WHEN $8::boolean THEN EXCLUDED.price_usd_minor ELSE plans.price_usd_minor END,
         price_history=EXCLUDED.price_history,
         updated_by=EXCLUDED.updated_by,
         updated_at=NOW()
       RETURNING plan_key AS "planKey",updated_at AS "updatedAt"`,
      [
        definition.key,
        interval || existing?.interval || config.interval,
        ngn,
        usd,
        JSON.stringify(history),
        actorId,
        writeNgn,
        writeUsd,
      ],
    );
    log('info', 'Plan prices saved', {
      planKey: definition.key,
      from: Object.fromEntries(currencies.map((code) => [code, existing?.[code] ?? planPriceMinor(definition, code)])),
      to: Object.fromEntries(currencies.map((code) => [code, amounts[code] ?? null])),
      actorId,
    });
    return {
      unchanged: changed.length === 0,
      cleared: currencies.every((code) => amounts[code] === null),
      planKey: definition.key,
      amounts: Object.fromEntries(currencies.map((code) => [code, amounts[code] ?? null])),
      previousAmounts: Object.fromEntries(currencies.map((code) => [code, existing?.[code] ?? planPriceMinor(definition, code) ?? null])),
      updatedRow: rows[0] || null,
    };
  }

  /** Persists the outcome of a Flutterwave payment-plan synchronisation for one plan and currency.
 * @param {string} request.planKey
 *
 * @typedef {Object} RecordPlanSyncInput
 * @property {string} [planKey]
 * @property {string|null} [currency]
 * @property {Record<string, any>} [sync] - whatever the synchroniser returned, read field by field below with the guards a provider answer needs - an absent plan id has to stay absent, because `Number(null)` is 0 and 0 looks like an id
 * @property {string|null} [actorId]
 */
async function recordPlanSync(/** @type {RecordPlanSyncInput} */ { planKey, currency, sync = {}, actorId = null } = {}) {
    const definition = (config.plans || []).find((plan) => plan.key === normalizeKey(planKey));
    if (!definition) return null;
    const code = normalizeCurrency(currency || config.currency);
    const requestedStatus = String(sync.status || '').toLowerCase();
    const value = {
      /* `Number(null)` is 0, and 0 is a plausible-looking plan id that nothing in Flutterwave answers to. A
         missing id has to stay missing: it is the difference between "renewals run" and "renewals fall back
         to a verified one-time charge", and it is what the guard two lines below reads. */
      planId: optionalInteger(sync.planId),
      planToken: optionalText(sync.planToken, 60),
      syncStatus: SYNC_STATUSES.has(requestedStatus) ? requestedStatus : 'failed',
      syncedAmountMinor: Number.isFinite(Number(sync.syncedAmountMinor)) ? Number(sync.syncedAmountMinor) : null,
      syncedAt: sync.syncedAt || new Date().toISOString(),
      interval: sync.interval || config.interval,
      name: sync.name || providerPlanName({ name: definition.name, interval: config.interval }, code),
      message: sync.message || null,
      error: sync.error || null,
    };
    if (!value.planId) value.syncStatus = 'pending';
    await pool.query(
      `INSERT INTO plan_provider_sync(plan_key,currency,provider_plan_id,provider_plan_token,sync_status,synced_amount_minor,synced_at,
         provider_name,interval,message,error,updated_by,created_at,updated_at)
       VALUES($1,$2,$3,$4,$5,$6,$7::timestamptz,$8,$9,$10,$11,$12,NOW(),NOW())
       ON CONFLICT(plan_key,currency) DO UPDATE SET
         provider_plan_id=EXCLUDED.provider_plan_id,provider_plan_token=EXCLUDED.provider_plan_token,
         sync_status=EXCLUDED.sync_status,synced_amount_minor=EXCLUDED.synced_amount_minor,synced_at=EXCLUDED.synced_at,
         provider_name=EXCLUDED.provider_name,interval=EXCLUDED.interval,message=EXCLUDED.message,error=EXCLUDED.error,
         updated_by=EXCLUDED.updated_by,updated_at=NOW()`,
      [
        definition.key,
        code,
        value.planId,
        value.planToken,
        value.syncStatus,
        value.syncedAmountMinor,
        value.syncedAt,
        value.name,
        value.interval,
        value.message,
        value.error,
        actorId,
      ],
    );
    log('info', 'Flutterwave plan synchronised', { planKey: definition.key, currency: code, syncStatus: value.syncStatus, planId: value.planId, actorId });
    return { ...value, currency: code };
  }

  async function saveBillingSettings({ settings, actorId = null }) {
    const entries = Object.entries(settings || {});
    if (!entries.length) return null;
    const current = await loadBillingSettings();
    const value = { ...current };
    for (const [key, entry] of entries) value[key] = entry;
    value.updatedAt = new Date().toISOString();
    await pool.query(
      `INSERT INTO admin_settings(setting_key,setting_value,description,updated_by,created_at,updated_at)
       VALUES($1,$2::jsonb,$3,$4,NOW(),NOW())
       ON CONFLICT(setting_key) DO UPDATE SET setting_value=EXCLUDED.setting_value,description=EXCLUDED.description,
         updated_by=EXCLUDED.updated_by,updated_at=NOW()`,
      [
        BILLING_SETTINGS_KEY,
        JSON.stringify(value),
        'Billing behaviour switches (recurring plan charges and plan migration on price changes)',
        actorId,
      ],
    );
    log('info', 'Billing settings saved', { actorId, keys: entries.map(([key]) => key) });
    return value;
  }

  return Object.freeze({
    snapshot,
    planFor,
    loadPlanRows,
    loadProviderPlans,
    loadBillingSettings,
    savePlanPrices,
    recordPlanSync,
    saveBillingSettings,
  });
}
