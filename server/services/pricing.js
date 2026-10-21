/**
 * Database-backed plan pricing.
 *
 * Prices live in the existing `admin_settings` table, one row per plan, so an
 * administrator can change them from the admin panel without a deploy.
 *
 *   `<plan>_price` (e.g. `pro_price`, `premium_price`) — the active price:
 *     { "amountMinor": 250000, "interval": "monthly", "currency": "NGN",
 *       "history": [ { "at": "ISO", "by": "admin@example.com", "fromMinor": 250000,
 *                      "toMinor": 300000, "note": "October price update" } ] }
 *
 *   `<plan>_paystack_plan` — the mirror of the Paystack plan used for recurring
 *     charges: { "planCode": "PLN_x", "planId": 49122, "name": "...",
 *       "syncStatus": "synced", "syncedAmountMinor": 250000, "syncedAt": "ISO",
 *       "currency": "NGN", "interval": "monthly", "message": "...", "error": null }
 *
 * Keeping the mirror separate means an environment-priced plan can still have a
 * synced Paystack plan code, and deleting a price override never destroys the
 * provider link. `updated_by` is stored in the table column too, and any row
 * that cannot be understood (or is missing) falls back to the environment price,
 * so a broken setting can never take checkout down.
 */

const PRICE_SETTING_SUFFIX = '_price';
const PROVIDER_PLAN_SUFFIX = '_paystack_plan';
export const BILLING_SETTINGS_KEY = 'billing_settings';
export const MAX_PRICE_HISTORY = 10;

/**
 * Paystack rejects plan amounts below NGN 100 ("Amount is invalid. It must be a
 * number and be 100 NGN or greater") and charges above 10,000,000 in the major
 * unit. The bounds are validation guard rails, not a replacement for Paystack's
 * own answer: a rejected amount is surfaced as a sync failure with the provider
 * message.
 */
export const PLAN_AMOUNT_BOUNDS = Object.freeze({ minMinor: 10_000, maxMinor: 1_000_000_000 });

const SYNC_STATUSES = new Set(['synced', 'in_sync', 'failed', 'not_configured', 'pending']);
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

export function priceSettingKey(planKey) {
  return `${normalizeKey(planKey)}${PRICE_SETTING_SUFFIX}`;
}

export function planKeyForSetting(settingKey) {
  const value = String(settingKey || '').trim().toLowerCase();
  return value.endsWith(PRICE_SETTING_SUFFIX) ? value.slice(0, -PRICE_SETTING_SUFFIX.length) : value;
}

export function providerPlanSettingKey(planKey) {
  return `${normalizeKey(planKey)}${PROVIDER_PLAN_SUFFIX}`;
}

export function priceSettingKeys(config) {
  return (config?.plans || []).map((plan) => priceSettingKey(plan.key));
}

export function providerPlanSettingKeys(config) {
  return (config?.plans || []).map((plan) => providerPlanSettingKey(plan.key));
}

function roundMinor(value) {
  return Math.round(Number(value));
}

/**
 * Converts an administrator-entered price (major units, e.g. naira) into the
 * smallest currency unit Paystack expects. Returns `null` for an empty value,
 * which means "remove the override and fall back to the environment price".
 */
export function normalizePlanAmount(value, { planName = 'This plan', bounds = PLAN_AMOUNT_BOUNDS } = {}) {
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
  if (amountMinor < bounds.minMinor) {
    throw pricingError(`${planName} must be at least ${(bounds.minMinor / 100).toFixed(2)}, the minimum Paystack charge for a subscription plan.`);
  }
  if (amountMinor > bounds.maxMinor) {
    throw pricingError(`${planName} cannot be more than ${(bounds.maxMinor / 100).toLocaleString('en-US')}.`);
  }
  return amountMinor;
}

function optionalText(value, max = 300) {
  const text = value === null || value === undefined ? '' : String(value).trim();
  return text ? text.slice(0, max) : null;
}

function optionalInteger(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

function parseJsonObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function toSyncState(raw, { currency, interval }) {
  const value = raw && typeof raw === 'object' ? raw : {};
  const syncStatus = SYNC_STATUSES.has(String(value.syncStatus || '').toLowerCase()) ? String(value.syncStatus).toLowerCase() : 'pending';
  const planCode = optionalText(value.planCode || value.plan_code, 60);
  return {
    planCode,
    planId: optionalInteger(value.planId ?? value.plan_id),
    syncStatus: planCode ? syncStatus : 'pending',
    syncedAmountMinor: optionalInteger(value.syncedAmountMinor ?? value.synced_amount_minor),
    syncedAt: optionalText(value.syncedAt ?? value.synced_at, 40),
    currency: (optionalText(value.currency || currency, 8) || '').toUpperCase() || null,
    interval: (optionalText(value.interval || interval, 20) || '').toLowerCase() || null,
    message: optionalText(value.message, 300),
    error: optionalText(value.error, 300),
  };
}

/** Reads a stored `admin_settings` value, ignoring anything unusable. */
export function sanitizeStoredPrice(raw, { currency = 'NGN', interval = 'monthly' } = {}) {
  const value = parseJsonObject(raw);
  if (!value) return null;
  const amountMinor = optionalInteger(value.amountMinor ?? value.amount_minor);
  if (!Number.isFinite(amountMinor) || amountMinor <= 0) return null;
  const storedInterval = optionalText(value.interval, 20);
  const history = Array.isArray(value.history)
    ? value.history.slice(0, MAX_PRICE_HISTORY).map((entry) => ({
      at: optionalText(entry?.at, 40),
      by: optionalText(entry?.by, 160),
      fromMinor: optionalInteger(entry?.fromMinor ?? entry?.from_minor),
      toMinor: optionalInteger(entry?.toMinor ?? entry?.to_minor),
      note: optionalText(entry?.note, 200),
    }))
    : [];
  return {
    amountMinor,
    currency: (optionalText(value.currency, 8) || currency).toUpperCase(),
    interval: storedInterval && INTERVALS.has(storedInterval.toLowerCase()) ? storedInterval.toLowerCase() : interval,
    history,
  };
}

/** Reads the stored Paystack plan mirror for a plan. */
export function sanitizeProviderPlan(raw) {
  const value = parseJsonObject(raw);
  if (!value) return null;
  const sync = toSyncState(value, { currency: value.currency, interval: value.interval });
  if (!sync.planCode && sync.syncStatus === 'pending') return null;
  return { ...sync, name: optionalText(value.name, 120) };
}

/**
 * Merges the environment defaults with any stored overrides. The database wins
 * whenever it holds a usable price, so the site always charges and displays the
 * price an administrator last saved.
 */
export function mergePlanPricing({ config, overrides = {}, providerPlans = {}, billingSettings = {} } = {}) {
  const currency = config.currency;
  const interval = config.interval;
  const recurringEnabled = billingSettings.recurringEnabled !== false;
  const updateExistingSubscriptions = billingSettings.updateExistingSubscriptions !== false;
  const plans = (config.plans || []).map((definition) => {
    const override = overrides[priceSettingKey(definition.key)] || null;
    const amountMinor = override?.amountMinor ?? definition.amountMinor;
    const plan = {
      key: definition.key,
      name: definition.name,
      description: definition.description,
      limits: definition.limits,
      amountMinor,
      amount: amountMinor / 100,
      currency,
      interval: override?.interval || interval,
      source: override ? 'database' : 'environment',
      environmentAmountMinor: definition.amountMinor,
      stored: Boolean(override),
      recurringEnabled,
      updateExistingSubscriptions,
      updatedAt: override?.updatedAt || null,
      updatedBy: override?.updatedBy || null,
      history: override?.history || [],
      paystack: providerPlans[providerPlanSettingKey(definition.key)]
        || { planCode: null, syncStatus: 'pending', syncedAmountMinor: null },
    };
    return Object.freeze({ ...plan, paystack: Object.freeze(plan.paystack) });
  });
  const byCode = {};
  for (const plan of plans) {
    const code = plan.paystack?.planCode;
    if (code) byCode[code.toUpperCase()] = plan.key;
  }
  return {
    currency,
    interval,
    recurringEnabled,
    updateExistingSubscriptions,
    plans,
    byCode,
  };
}

/**
 * Decides whether a checkout may be raised through a Paystack plan code.
 *
 * A plan code makes Paystack charge the plan amount and bill the customer again
 * on every interval, so it is only safe when the stored plan is confirmed to
 * carry exactly the price we are about to show the user. A discount cannot be
 * applied on top of a plan price, so discounted checkouts stay one-time.
 */
export function planChargeDecision({ plan, recurringEnabled = true, hasDiscount = false } = {}) {
  if (!plan) return { usePlan: false, reason: 'plan-unavailable' };
  if (!recurringEnabled) return { usePlan: false, reason: 'recurring-disabled' };
  if (hasDiscount) return { usePlan: false, reason: 'discounted-checkout' };
  const sync = plan.paystack || {};
  if (!sync.planCode) return { usePlan: false, reason: 'no-plan-code' };
  if (sync.syncStatus !== 'synced' && sync.syncStatus !== 'in_sync') return { usePlan: false, reason: 'not-synced' };
  if (Number(sync.syncedAmountMinor) !== Number(plan.amountMinor)) return { usePlan: false, reason: 'amount-mismatch' };
  if (sync.currency && String(sync.currency).toUpperCase() !== String(plan.currency).toUpperCase()) return { usePlan: false, reason: 'currency-mismatch' };
  if (sync.interval && String(sync.interval).toLowerCase() !== String(plan.interval).toLowerCase()) return { usePlan: false, reason: 'interval-mismatch' };
  return { usePlan: true, reason: 'ready', planCode: sync.planCode };
}

/** Names given to Paystack plans, so an interval change never collides. */
export function paystackPlanName(plan) {
  return `Signal Desk ${plan.name} (${plan.interval})`.slice(0, 90);
}

/** Plans in the shape the public billing page consumes: no codes, no sync state. */
export function publicPricing(snapshot) {
  return snapshot.plans.map((plan) => ({
    key: plan.key,
    name: plan.name,
    description: plan.description,
    amountMinor: plan.amountMinor,
    amount: plan.amount,
    currency: plan.currency,
    interval: plan.interval,
    limits: plan.limits,
    renewsAutomatically: Boolean(snapshot.recurringEnabled && plan.paystack?.planCode
      && (plan.paystack.syncStatus === 'synced' || plan.paystack.syncStatus === 'in_sync')),
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

/** Validates the `PUT /api/admin/pricing` body into a storable plan. */
export function normalizePricingUpdate({ input, config, allowEmpty = false } = {}) {
  const plans = input?.plans && typeof input.plans === 'object' && !Array.isArray(input.plans) ? input.plans : {};
  const known = new Set((config.plans || []).map((plan) => plan.key));
  for (const key of Object.keys(plans)) {
    if (!known.has(normalizeKey(key))) throw pricingError('That plan is not available for pricing.');
  }
  const entries = [];
  for (const plan of config.plans || []) {
    if (!Object.hasOwn(plans, plan.key)) continue;
    const raw = plans[plan.key];
    if (raw === null) { entries.push({ planKey: plan.key, amountMinor: null }); continue; }
    if (typeof raw !== 'object') throw pricingError(`${plan.name} pricing must be an object with an amount.`);
    const amountMinor = normalizePlanAmount(raw.amount ?? raw.amountMinor, { planName: plan.name });
    if (amountMinor === null && !allowEmpty) throw pricingError(`${plan.name} needs a price, or send null to remove the override.`);
    entries.push({ planKey: plan.key, amountMinor });
  }

  const billing = {};
  const flag = normalizeFlag(input?.billing?.recurringEnabled ?? input?.recurringEnabled);
  if (flag !== undefined) billing.recurringEnabled = flag;
  const migrate = normalizeFlag(input?.billing?.updateExistingSubscriptions ?? input?.updateExistingSubscriptions);
  if (migrate !== undefined) billing.updateExistingSubscriptions = migrate;

  const note = optionalText(input?.note, 200);
  if (!entries.length && !Object.keys(billing).length) throw pricingError('Choose a price or billing switch to save.');
  // Every touched plan needs a Paystack sync, including a cleared override,
  // because the price users are charged changed either way.
  return { entries, billing, note, syncPlanKeys: [...new Set(entries.map((entry) => entry.planKey))] };
}

export function normalizeBillingSettings(input = {}) {
  const settings = {};
  const recurringEnabled = normalizeFlag(input.recurringEnabled);
  if (recurringEnabled !== undefined) settings.recurringEnabled = recurringEnabled;
  const updateExistingSubscriptions = normalizeFlag(input.updateExistingSubscriptions);
  if (updateExistingSubscriptions !== undefined) settings.updateExistingSubscriptions = updateExistingSubscriptions;
  if (!Object.keys(settings).length) throw pricingError('Choose a billing switch to save.');
  return settings;
}

/**
 * Reads and writes pricing in `admin_settings`. Every failure mode degrades to
 * the environment price, because billing must keep working even if a setting is
 * unreadable.
 */
export function createPricingStore({ pool, config, logger = console } = {}) {
  const log = (level, message, extra = {}) => logger?.[level]?.(message, extra);
  const priceKeys = priceSettingKeys(config);
  const providerKeys = providerPlanSettingKeys(config);
  const allKeys = [...priceKeys, ...providerKeys, BILLING_SETTINGS_KEY];

  async function loadRows(keys, label) {
    if (!keys.length) return new Map();
    const placeholders = keys.map((_key, index) => `$${index + 1}`).join(',');
    try {
      const { rows } = await pool.query(
        `SELECT a.setting_key,a.setting_value,a.description,a.updated_at,u.email AS updated_by_email
         FROM admin_settings a LEFT JOIN users u ON u.id=a.updated_by
         WHERE a.setting_key IN (${placeholders})`,
        keys,
      );
      return new Map(rows.map((row) => [row.setting_key, row]));
    } catch (error) {
      log('warn', `${label} could not be read; falling back to defaults`, { code: error.code || 'PRICING_READ_FAILED' });
      return new Map();
    }
  }

  /** Stored per-plan prices keyed by `<plan>_price`. */
  async function loadOverrides() {
    const rows = await loadRows(priceKeys, 'Pricing settings');
    const overrides = {};
    for (const [settingKey, row] of rows) {
      const planKey = planKeyForSetting(settingKey);
      if (!config.plans.some((plan) => plan.key === planKey)) continue;
      const sanitized = sanitizeStoredPrice(row.setting_value, { currency: config.currency, interval: config.interval });
      if (!sanitized) {
        log('warn', 'Ignoring unreadable pricing setting', { settingKey });
        continue;
      }
      overrides[settingKey] = {
        ...sanitized,
        updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
        updatedBy: row.updated_by_email || null,
      };
    }
    return overrides;
  }

  /** Stored Paystack plan mirrors keyed by `<plan>_paystack_plan`. */
  async function loadProviderPlans() {
    const rows = await loadRows(providerKeys, 'Paystack plan settings');
    const records = {};
    for (const [settingKey, row] of rows) {
      const sanitized = sanitizeProviderPlan(row.setting_value);
      if (!sanitized) {
        log('warn', 'Ignoring unreadable Paystack plan setting', { settingKey });
        continue;
      }
      records[settingKey] = { ...sanitized, updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null };
    }
    return records;
  }

  async function loadBillingSettings() {
    const rows = await loadRows([BILLING_SETTINGS_KEY], 'Billing settings');
    const value = parseJsonObject(rows.get(BILLING_SETTINGS_KEY)?.setting_value) || {};
    return {
      recurringEnabled: typeof value.recurringEnabled === 'boolean' ? value.recurringEnabled : undefined,
      updateExistingSubscriptions: typeof value.updateExistingSubscriptions === 'boolean' ? value.updateExistingSubscriptions : undefined,
    };
  }

  /** Everything the admin panel and checkout need, in one read. */
  async function snapshot() {
    const [overrides, providerPlans, billingSettings] = await Promise.all([
      loadOverrides(),
      loadProviderPlans(),
      loadBillingSettings(),
    ]);
    return mergePlanPricing({ config, overrides, providerPlans, billingSettings });
  }

  async function planFor(planKey) {
    const { plans } = await snapshot();
    return plans.find((plan) => plan.key === normalizeKey(planKey)) || null;
  }

  async function writeRow({ settingKey, value, actorId, description }) {
    const { rows } = await pool.query(
      `INSERT INTO admin_settings(setting_key,setting_value,description,updated_by,created_at,updated_at)
       VALUES($1,$2::jsonb,$3,$4,NOW(),NOW())
       ON CONFLICT(setting_key) DO UPDATE SET setting_value=EXCLUDED.setting_value,description=EXCLUDED.description,
         updated_by=EXCLUDED.updated_by,updated_at=NOW()
       RETURNING setting_key AS "settingKey",updated_at AS "updatedAt"`,
      [settingKey, JSON.stringify(value), description ?? null, actorId ?? null],
    );
    return rows[0] || null;
  }

  /**
   * Saves (or clears) an administrator price for one plan. The Paystack plan
   * mirror is left untouched: `planChargeDecision` compares the mirrored amount
   * with the saved amount, so a stale plan code stops being used automatically.
   */
  async function savePlanPrice({ planKey, amountMinor, actorId = null, actorEmail = null, note = null }) {
    const definition = (config.plans || []).find((plan) => plan.key === normalizeKey(planKey));
    if (!definition) throw pricingError('That plan is not available for pricing.');
    const settingKey = priceSettingKey(definition.key);
    if (amountMinor === null) {
      const result = await pool.query('DELETE FROM admin_settings WHERE setting_key=$1', [settingKey]);
      log('info', 'Pricing override removed', { planKey: definition.key, removed: result.rowCount > 0, actorId });
      return { cleared: true, removed: result.rowCount > 0, planKey: definition.key };
    }

    const overrides = await loadOverrides();
    const existing = overrides[settingKey] || null;
    if (existing && existing.amountMinor === amountMinor && !note) {
      return { unchanged: true, planKey: definition.key, amountMinor, override: existing };
    }
    const historyEntry = {
      at: new Date().toISOString(),
      by: actorEmail || null,
      fromMinor: existing?.amountMinor ?? definition.amountMinor,
      toMinor: amountMinor,
      note: note || null,
    };
    const value = {
      amountMinor,
      interval: existing?.interval || config.interval,
      currency: config.currency,
      history: [historyEntry, ...(existing?.history || [])].slice(0, MAX_PRICE_HISTORY),
    };
    await writeRow({
      settingKey,
      value,
      actorId,
      description: `${definition.name} plan price in ${config.currency} per ${value.interval}`,
    });
    log('info', 'Plan price saved', { planKey: definition.key, fromMinor: historyEntry.fromMinor, toMinor: amountMinor, actorId });
    return {
      unchanged: false,
      planKey: definition.key,
      amountMinor,
      previousAmountMinor: historyEntry.fromMinor,
      override: sanitizeStoredPrice(value, { currency: config.currency, interval: value.interval }),
    };
  }

  /** Persists the outcome of a Paystack plan synchronisation for one plan. */
  async function recordPlanSync({ planKey, sync, actorId = null }) {
    const definition = (config.plans || []).find((plan) => plan.key === normalizeKey(planKey));
    if (!definition) return null;
    const settingKey = providerPlanSettingKey(definition.key);
    const existingRows = await loadRows([settingKey], 'Paystack plan settings');
    const existing = sanitizeProviderPlan(existingRows.get(settingKey)?.setting_value);
    const interval = sync.interval || existing?.interval || config.interval;
    const value = {
      planCode: sync.planCode ?? existing?.planCode ?? null,
      planId: sync.planId ?? existing?.planId ?? null,
      name: sync.name || existing?.name || paystackPlanName({ name: definition.name, interval }),
      syncStatus: SYNC_STATUSES.has(String(sync.status).toLowerCase()) ? String(sync.status).toLowerCase() : 'failed',
      syncedAmountMinor: Number.isFinite(Number(sync.syncedAmountMinor)) ? Number(sync.syncedAmountMinor) : null,
      syncedAt: sync.syncedAt || new Date().toISOString(),
      currency: sync.currency || config.currency,
      interval,
      message: sync.message || null,
      error: sync.error || null,
    };
    await writeRow({
      settingKey,
      value,
      actorId,
      description: `Paystack plan mirroring the ${definition.name} price`,
    });
    log('info', 'Paystack plan synchronised', { planKey: definition.key, syncStatus: value.syncStatus, planCode: value.planCode, actorId });
    return value;
  }

  async function saveBillingSettings({ settings, actorId = null }) {
    const entries = Object.entries(settings || {});
    if (!entries.length) return null;
    const rows = await loadRows([BILLING_SETTINGS_KEY], 'Billing settings');
    const existing = parseJsonObject(rows.get(BILLING_SETTINGS_KEY)?.setting_value) || {};
    const value = { ...existing };
    for (const [key, entry] of entries) value[key] = entry;
    value.updatedAt = new Date().toISOString();
    await writeRow({
      settingKey: BILLING_SETTINGS_KEY,
      value,
      actorId,
      description: 'Billing behaviour switches (recurring plan charges and plan migration on price changes)',
    });
    log('info', 'Billing settings saved', { actorId, keys: entries.map(([key]) => key) });
    return value;
  }

  return Object.freeze({
    priceKeys,
    providerKeys,
    allKeys,
    loadOverrides,
    loadProviderPlans,
    loadBillingSettings,
    snapshot,
    planFor,
    savePlanPrice,
    recordPlanSync,
    saveBillingSettings,
  });
}
