import crypto from 'node:crypto';
import { SUPPORTED_CURRENCIES, DEFAULT_CURRENCY, toMajorAmount } from './flutterwave.js';

/**
 * Signal Desk billing plans: one free tier plus three paid tiers, priced in every currency the workspace offers.
 *
 * Prices are *catalogue defaults*. The active price for each paid plan lives in the `plans` table and is managed
 * from Admin Panel -> Pricing & Plans, which also keeps a matching Flutterwave payment plan in step per currency
 * so renewals use the saved price. `FLW_PLAN_<KEY>_AMOUNT` and `FLW_PLAN_<KEY>_USD_AMOUNT` override the
 * fallbacks, always in the currency's smallest unit (kobo, cents).
 *
 * The two prices are not a conversion. An international customer is not charged a naira figure converted at the
 * moment of checkout, because the exchange rate the workspace would use is somebody else's business and a
 * Monday price that becomes Tuesday revenue is not a price. Each currency has its own stored number, and an
 * administrator sets both.
 *
 * Limits are the deployed truth for a tier: `users.plan_limits` keeps the snapshot that was purchased, and
 * `plan-limits.js` lets the definition below win, so re-pricing a tier does not silently leave old subscribers
 * with limits nobody advertises any more.
 */
export const PLAN_DEFINITIONS = Object.freeze({
  starter: Object.freeze({
    key: 'starter',
    name: 'Starter',
    description: 'One automated trading account with room for the channels you actually follow.',
    defaultAmountMinor: 6_000_000,
    defaultUsdAmountMinor: 3_900,
    limits: Object.freeze({ maxTradingAccounts: 1, maxTelegramChannels: 10, maxDailySignals: 200 }),
  }),
  pro: Object.freeze({
    key: 'pro',
    name: 'Pro',
    description: 'A few accounts and busier channels for active traders who automate.',
    defaultAmountMinor: 10_500_000,
    defaultUsdAmountMinor: 6_900,
    limits: Object.freeze({ maxTradingAccounts: 3, maxTelegramChannels: 50, maxDailySignals: 500 }),
  }),
  premium: Object.freeze({
    key: 'premium',
    name: 'Premium',
    description: 'The highest limits for running several accounts and busy channels.',
    defaultAmountMinor: 15_000_000,
    defaultUsdAmountMinor: 9_900,
    limits: Object.freeze({ maxTradingAccounts: 5, maxTelegramChannels: 100, maxDailySignals: 2000 }),
  }),
});

/**
 * The free tier reads signals only. `maxTradingAccounts: 0` is deliberate and is a real limit, not "unset":
 * nobody can connect a trading account on Free, so there is nothing for Auto-Trading to execute on. Accounts
 * linked while a paid plan was active stay connected and usable for review; only new links are refused.
 *
 * Two monitored channels, not one: a trader comparing the signal source they already follow against a second
 * one is the question Free exists to answer, and the limit still stands where it is enforced
 * (`enforcePlanLimit` on the channel-add route) rather than in the copy. The refusal sentence is built from this
 * number, so the plan card, the error a user reads, and the count the server enforces cannot disagree with each
 * other.
 */
export const FREE_PLAN = Object.freeze({
  key: 'free',
  name: 'Free',
  description: 'Signal capture and review, with no automated execution.',
  limits: Object.freeze({ maxTradingAccounts: 0, maxTelegramChannels: 2, maxDailySignals: 50 }),
});

/**
 * What each offered currency costs the workspace to be wrong about.
 *
 * `minorPerUnit` is the multiplier Flutterwave does NOT want (it takes the major unit) and `minimumMajor` is
 * the smallest charge the provider accepts, which is what a promo code is not allowed to fall below. The
 * minimums are provider facts, not preferences: below them Flutterwave refuses the transaction, so a discount
 * that lands there has to be rejected here with a sentence an administrator can act on.
 */
export const CURRENCIES = Object.freeze({
  NGN: Object.freeze({ code: 'NGN', symbol: '\u20a6', locale: 'en-NG', minimumMajor: 100 }),
  USD: Object.freeze({ code: 'USD', symbol: '$', locale: 'en-US', minimumMajor: 1 }),
});

export const DEFAULT_INTERVAL = 'monthly';

/* Re-exported from the provider module so a consumer that only ever thinks about billing - the admin panel's
   payload, the pricing table, a test - can ask which currencies exist without importing Flutterwave's client.
   There is exactly one list of them, and this is a pointer to it, not a copy. */
export { SUPPORTED_CURRENCIES, DEFAULT_CURRENCY } from './flutterwave.js';

/** The smallest charge, in the currency's minor unit, that Flutterwave will accept. */
export function minimumChargeMinor(currency) {
  const meta = CURRENCIES[normalizeCurrency(currency)] || CURRENCIES.NGN;
  return meta.minimumMajor * 100;
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? '').trim(), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/** Uppercases and validates a currency the workspace can charge in. Anything else is NGN. */
export function normalizeCurrency(value) {
  const code = String(value ?? '').trim().toUpperCase();
  return SUPPORTED_CURRENCIES.includes(code) ? code : DEFAULT_CURRENCY;
}

/** True only for a currency the workspace offers, with no silent default - what a request must be checked against. */
export function isSupportedCurrency(value) {
  const code = String(value ?? '').trim().toUpperCase();
  return SUPPORTED_CURRENCIES.includes(code);
}

export function billingConfig(env = process.env) {
  const currency = normalizeCurrency(env.FLW_CURRENCY || DEFAULT_CURRENCY);
  const interval = String(env.FLW_PLAN_INTERVAL || DEFAULT_INTERVAL).trim().toLowerCase();
  const plans = Object.values(PLAN_DEFINITIONS).map((definition) => {
    const upper = definition.key.toUpperCase();
    return Object.freeze({
      ...definition,
      amountMinor: positiveInteger(env[`FLW_PLAN_${upper}_AMOUNT`], definition.defaultAmountMinor),
      usdAmountMinor: positiveInteger(env[`FLW_PLAN_${upper}_USD_AMOUNT`], definition.defaultUsdAmountMinor),
    });
  });
  const secretKey = String(env.FLW_SECRET_KEY || '').trim();
  return Object.freeze({
    secretKey,
    publicKey: String(env.FLW_PUBLIC_KEY || '').trim(),
    encryptionKey: String(env.FLW_ENCRYPTION_KEY || '').trim(),
    webhookHash: String(env.FLW_WEBHOOK_HASH || '').trim(),
    baseUrl: String(env.FLW_API_URL || 'https://api.flutterwave.com').trim().replace(/\/+$/, ''),
    currency,
    supportedCurrencies: [...SUPPORTED_CURRENCIES],
    /**
     * Where a customer is sent back to after paying, as the first entry of the comma-separated CLIENT_URL the
     * app already publishes. Read here rather than at the moment of use so the whole payment configuration comes
     * from one place - and so a test can build a config that knows its own base URL.
     */
    callbackBase: String(env.CLIENT_URL || '').split(',').map((item) => item.trim()).filter(Boolean)[0] || '',
    interval: ['monthly', 'annually', 'quarterly', 'biannually'].includes(interval) ? interval : DEFAULT_INTERVAL,
    plans,
    /** Checkout needs a secret key; a webhook needs its own hash, and the two are configured separately on purpose. */
    configured: Boolean(secretKey),
    webhookConfigured: Boolean(String(env.FLW_WEBHOOK_HASH || '').trim()),
  });
}

/**
 * The price of a plan in one currency, in that currency's minor unit. `null` when the plan is not priced there.
 *
 * `null` is the whole point of this function, and it is why the field is tested before it is converted:
 * `Number(null)` is `0`, and a price read as `0` is a checkout that charges somebody nothing - or, once the
 * provider refuses it, a customer sent to a page that cannot work. An unpriced currency must stay unpriced all
 * the way from the `plans` row to the toggle that hides the button.
 */
export function planPriceMinor(plan, currency) {
  if (!plan) return null;
  const code = normalizeCurrency(currency);
  const raw = code === 'USD' ? plan.usdAmountMinor : plan.amountMinor;
  if (raw === null || raw === undefined || raw === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/** Every price of a plan, keyed by currency, in the shape the API and the billing page read. */
export function planPrices(plan, { interval = DEFAULT_INTERVAL } = {}) {
  /* Keyed by currency code, and open-ended on purpose: a second supported currency is a constant change in
     `SUPPORTED_CURRENCIES`, not a type change here, and the whole point of the freeze below is that a caller
     cannot invent a third entry. */
  const out = /** @type {Record<string, any>} */ ({});
  for (const code of SUPPORTED_CURRENCIES) {
    const amountMinor = planPriceMinor(plan, code);
    if (amountMinor === null) continue;
    out[code] = Object.freeze({
      currency: code,
      amountMinor,
      amount: amountMinor / 100,
      /** What Flutterwave is sent for this price: the major unit, never the minor one. */
      providerAmount: toMajorAmount(amountMinor),
      interval,
    });
  }
  return Object.freeze(out);
}

/** Plans safe to send to a browser. Never includes a key of any kind, public or otherwise. */
export function publicPlans(config = billingConfig()) {
  return config.plans.map((plan) => {
    const prices = planPrices(plan, { interval: config.interval });
    return {
      key: plan.key,
      name: plan.name,
      description: plan.description,
      currency: config.currency,
      interval: config.interval,
      amountMinor: prices[config.currency]?.amountMinor ?? plan.amountMinor,
      amount: prices[config.currency]?.amount ?? plan.amountMinor / 100,
      usdAmountMinor: prices.USD?.amountMinor ?? plan.usdAmountMinor,
      usdAmount: prices.USD?.amount ?? plan.usdAmountMinor / 100,
      prices,
      limits: plan.limits,
    };
  });
}

export function findPlan(config, planKey) {
  const normalized = String(planKey || '').trim().toLowerCase();
  return config.plans.find((plan) => plan.key === normalized) || null;
}

/** A price entered in the major unit, as stored: the smallest unit of that currency. */
export function toMinorUnits(amount) {
  const parsed = Number(amount);
  if (!Number.isFinite(parsed)) return null;
  return Math.round(parsed * 100);
}

/** The number Flutterwave is told to charge. Kept here so every call site converts the same way. */
export function toProviderAmount(amountMinor) {
  return toMajorAmount(amountMinor);
}

function roundMoney(value) {
  return Math.round(value * 100) / 100;
}

/**
 * Applies an admin-created promo code to a plan price, in the currency being charged.
 *
 * A percentage discount is relative, so it survives the currency split untouched, and it is capped at 100%.
 * A fixed discount lives in one column (`promo_codes.discount_value`) with no currency of its own, so it is read
 * as "this many major units of whatever the trader is charged in" - ₦2,000 off a naira price, $2,000 off a
 * dollar one, which is the only meaning a single admin field can honestly carry.
 *
 * Neither may take the price below that currency's minimum Flutterwave charge: a ₦50 or $0.40 payment is not
 * refused by a policy here, it is refused by the provider after the customer has already been sent to a
 * checkout page, which is the worse place to discover it.
 *
 * @typedef {Object} PromoDescriptor
 * @property {string|null} [id] - the `promo_codes` row id, a UUID as text
 * @property {string} [code]
 * @property {'percentage'|'fixed'} [discountType]
 * @property {string|number|null} [discountValue] - NUMERIC in the database, so text until it is coerced below,
 *   where a value that will not coerce is refused rather than read as zero
 * @property {number|null} [maxUses] - null or absent means unlimited
 * @property {number} [currentUses]
 * @property {boolean} [active]
 * @property {string|Date|null} [expiresAt]
 */
/**
 * @typedef {Object} ApplyPromoCodeInput
 * @property {number|null} [amountMinor]
 * @property {PromoDescriptor|null} [promoCode] - the row already normalised for this function, camelCase and all:
 *   a raw `promo_codes` row has snake_case keys and `applyPromoCode` would read `undefined` off it, which is a
 *   discount of zero and a 200 where the answer should have been 409
 * @property {string|null} [currency]
 */
export function applyPromoCode(/** @type {ApplyPromoCodeInput} */ { amountMinor, promoCode, currency = DEFAULT_CURRENCY } = {}) {
  if (!promoCode) return { amountMinor, discountMinor: 0, promoCode: null };
  if (promoCode.active !== true) throw promoError('This promo code is no longer active.', 409, 'PROMO_INACTIVE');
  if (promoCode.expiresAt && new Date(promoCode.expiresAt).getTime() <= Date.now()) {
    throw promoError('This promo code has expired.', 409, 'PROMO_EXPIRED');
  }
  if (promoCode.maxUses !== null && promoCode.maxUses !== undefined && promoCode.currentUses >= promoCode.maxUses) {
    throw promoError('This promo code has reached its usage limit.', 409, 'PROMO_EXHAUSTED');
  }

  const discountValue = Number(promoCode.discountValue);
  if (!Number.isFinite(discountValue) || discountValue <= 0) {
    throw promoError('This promo code is not valid.', 409, 'PROMO_INVALID');
  }
  const discountMinor = promoCode.discountType === 'percentage'
    ? Math.round(amountMinor * (Math.min(discountValue, 100) / 100))
    : toMinorUnits(discountValue);
  const nextAmount = Math.max(0, amountMinor - discountMinor);
  const minimum = minimumChargeMinor(currency);
  if (nextAmount > 0 && nextAmount < minimum) {
    throw promoError(`This promo code leaves an amount below the minimum Flutterwave charge in ${normalizeCurrency(currency)}.`, 409, 'PROMO_AMOUNT_TOO_LOW');
  }
  return {
    amountMinor: nextAmount,
    discountMinor: roundMoney(discountMinor),
    promoCode: {
      id: promoCode.id || null,
      code: promoCode.code,
      discountType: promoCode.discountType,
      discountValue,
    },
  };
}

function promoError(message, status, code) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

const REFERENCE_PATTERN = /^[A-Za-z0-9._=-]{6,120}$/;

export function normalizeReference(reference) {
  const value = String(reference || '').trim();
  return REFERENCE_PATTERN.test(value) ? value : null;
}

/**
 * Reference format: sdb_<user uuid without dashes>_<unix seconds>_<random hex>. It is what Flutterwave calls
 * `tx_ref`, and it must be unique per attempt - a replayed reference is a second customer paying into the same
 * transaction. The user id prefix lets a webhook find the account even before it is verified, and the random
 * suffix keeps two checkouts by the same person distinct.
 *
 * The prefix is unchanged from the Paystack integration on purpose: references already issued outlive this
 * migration, and `userIdFromReference` still has to read them.
 */
export function buildReference({ userId, now = Date.now(), random }) {
  const suffix = random || crypto.randomBytes(6).toString('hex');
  return `sdb_${String(userId).replaceAll('-', '')}_${Math.floor(now / 1000)}_${suffix}`;
}

export function userIdFromReference(reference) {
  const match = /^sdb_([0-9a-f]{32})_/i.exec(String(reference || ''));
  if (!match) return null;
  const hex = match[1].toLowerCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Subscription length in milliseconds, used to compute the next renewal date. */
export function billingIntervalMs(interval) {
  switch (String(interval || '').toLowerCase()) {
    case 'annually':
    case 'yearly': return 365 * 24 * 60 * 60 * 1000;
    case 'biannually':
    case 'bi-annually': return 182 * 24 * 60 * 60 * 1000;
    case 'quarterly': return 91 * 24 * 60 * 60 * 1000;
    case 'monthly':
    default: return 30 * 24 * 60 * 60 * 1000;
  }
}

/**
 * Money for a human, from a stored minor unit.
 *
 * The unit is the whole hazard of this migration, so this function is the only place a price is made readable,
 * and it divides: a row that already holds the major unit would be shown a hundred times too small, which is
 * why nothing here takes a "provider amount".
 */
export function formatAmount(amountMinor, currency = DEFAULT_CURRENCY) {
  const code = String(currency || DEFAULT_CURRENCY).trim().toUpperCase() || DEFAULT_CURRENCY;
  const meta = CURRENCIES[code];
  const value = Number(amountMinor || 0) / 100;
  try {
    return new Intl.NumberFormat(meta?.locale || 'en-US', { style: 'currency', currency: code, maximumFractionDigits: 2 }).format(value);
  } catch {
    /* A currency this workspace does not sell in is still a currency a stored row can name, and "GBP 12.00"
       is a better answer than a crash on a billing table render. */
    return `${code} ${value.toFixed(2)}`;
  }
}
