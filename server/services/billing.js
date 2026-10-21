import crypto from 'node:crypto';

/**
 * Paystack billing plans.
 *
 * Prices are configured with environment variables so the deployed amounts can
 * change without a code change: `PAYSTACK_PLAN_<KEY>_AMOUNT` overrides the amount
 * in the smallest currency unit (kobo for NGN). Checkout is a verified one-time
 * Paystack charge; Signal Desk tracks the paid period and asks the user to renew
 * when it ends, so no Paystack plan code is required.
 */
export const PLAN_DEFINITIONS = Object.freeze({
  pro: Object.freeze({
    key: 'pro',
    name: 'Pro',
    description: 'Higher limits for active traders with automated execution.',
    defaultAmountMinor: 250_000,
    limits: Object.freeze({ maxTradingAccounts: 5, maxTelegramChannels: 25, maxDailySignals: 500 }),
  }),
  premium: Object.freeze({
    key: 'premium',
    name: 'Premium',
    description: 'The highest limits for running multiple accounts and busy channels.',
    defaultAmountMinor: 600_000,
    limits: Object.freeze({ maxTradingAccounts: 15, maxTelegramChannels: 100, maxDailySignals: 2000 }),
  }),
});

export const FREE_PLAN = Object.freeze({
  key: 'free',
  name: 'Free',
  description: 'Core signal capture, review, and execution controls.',
  limits: Object.freeze({ maxTradingAccounts: 1, maxTelegramChannels: 3, maxDailySignals: 50 }),
});

export const DEFAULT_CURRENCY = 'NGN';
export const DEFAULT_INTERVAL = 'monthly';

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? '').trim(), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function billingConfig(env = process.env) {
  const currency = String(env.PAYSTACK_CURRENCY || DEFAULT_CURRENCY).trim().toUpperCase();
  const interval = String(env.PAYSTACK_PLAN_INTERVAL || DEFAULT_INTERVAL).trim().toLowerCase();
  const plans = Object.values(PLAN_DEFINITIONS).map((definition) => {
    const upper = definition.key.toUpperCase();
    return Object.freeze({
      ...definition,
      amountMinor: positiveInteger(env[`PAYSTACK_PLAN_${upper}_AMOUNT`], definition.defaultAmountMinor),
    });
  });
  return Object.freeze({
    secretKey: String(env.PAYSTACK_SECRET_KEY || '').trim(),
    baseUrl: String(env.PAYSTACK_API_URL || 'https://api.paystack.co').trim().replace(/\/$/, ''),
    currency,
    interval: ['monthly', 'annually', 'quarterly', 'biannually'].includes(interval) ? interval : DEFAULT_INTERVAL,
    plans,
    configured: Boolean(String(env.PAYSTACK_SECRET_KEY || '').trim()),
  });
}

/** Plans safe to send to a browser (never includes the secret key or plan codes). */
export function publicPlans(config = billingConfig()) {
  return config.plans.map((plan) => ({
    key: plan.key,
    name: plan.name,
    description: plan.description,
    amountMinor: plan.amountMinor,
    amount: plan.amountMinor / 100,
    currency: config.currency,
    interval: config.interval,
    limits: plan.limits,
  }));
}

export function findPlan(config, planKey) {
  const normalized = String(planKey || '').trim().toLowerCase();
  return config.plans.find((plan) => plan.key === normalized) || null;
}

/** Paystack expects an integer in the currency's smallest unit. */
export function toMinorUnits(amount) {
  const parsed = Number(amount);
  if (!Number.isFinite(parsed)) return null;
  return Math.round(parsed * 100);
}

function roundMoney(value) {
  return Math.round(value * 100) / 100;
}

/**
 * Applies an admin-created promo code to a plan price. Percentage discounts are
 * capped at 100%; fixed discounts cannot reduce a price below the Paystack
 * minimum charge (1.00 in the smallest-unit/100 terms).
 */
export function applyPromoCode({ amountMinor, promoCode }) {
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
  if (nextAmount > 0 && nextAmount < 100) {
    throw promoError('This promo code leaves an amount below the minimum Paystack charge.', 409, 'PROMO_AMOUNT_TOO_LOW');
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

/** Verifies the `x-paystack-signature` header (HMAC SHA512 of the raw body). */
export function verifyPaystackSignature({ rawBody, signature, secretKey }) {
  if (!rawBody || !signature || !secretKey) return false;
  const expected = crypto.createHmac('sha512', secretKey).update(rawBody).digest('hex');
  const provided = String(signature).trim().toLowerCase();
  if (!/^[0-9a-f]{128}$/.test(provided)) return false;
  return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(provided, 'hex'));
}

export function verifyWebhookSignature(rawBody, signature, env = process.env) {
  return verifyPaystackSignature({ rawBody, signature, secretKey: String(env.PAYSTACK_SECRET_KEY || '').trim() });
}

const REFERENCE_PATTERN = /^[A-Za-z0-9._=-]{6,120}$/;

export function normalizeReference(reference) {
  const value = String(reference || '').trim();
  return REFERENCE_PATTERN.test(value) ? value : null;
}

/**
 * Reference format: sdb_<user uuid without dashes>_<unix seconds>_<random hex>.
 * The user id prefix lets a webhook find the account even before it is verified,
 * while the random suffix keeps references unique per checkout attempt.
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

/** Maps a Paystack transaction payload to the fields we persist. */
export function toSafeTransaction(data = {}) {
  return {
    reference: String(data.reference || ''),
    status: String(data.status || '').toLowerCase(),
    amountMinor: Number.isFinite(Number(data.amount)) ? Number(data.amount) : null,
    currency: String(data.currency || '').toUpperCase(),
    channel: data.channel ? String(data.channel).slice(0, 40) : null,
    gatewayResponse: data.gateway_response ? String(data.gateway_response).slice(0, 200) : null,
    paidAt: data.paid_at || null,
    planCode: data.plan?.plan_code || data.plan_code || null,
  };
}

/**
 * Recurring billing arrives as invoice and subscription events rather than a
 * checkout we started, so their payloads are read through these helpers. Only
 * fields documented at https://paystack.com/docs/api/invoice/ and
 * https://paystack.com/docs/api/subscription/ are used, and everything is
 * optional: an unrecognised payload is ignored instead of changing access.
 */
const PAID_INVOICE_STATUSES = new Set(['success', 'paid']);

export function eventCustomerEmail(data = {}) {
  const email = data?.customer?.email || data?.email || data?.transaction?.customer?.email || data?.authorization?.email || '';
  const value = String(email).trim().toLowerCase();
  return value && value.includes('@') ? value.slice(0, 200) : null;
}

export function toSafeInvoice(data = {}) {
  const candidate = String(data.invoice_code || (data.id ? `invt_${data.id}` : '')).trim();
  const status = String(data.status || '').toLowerCase();
  const amount = Number(data.amount ?? data.total_amount);
  return {
    invoiceCode: REFERENCE_PATTERN.test(candidate) ? candidate : null,
    status,
    paid: data.paid === true || PAID_INVOICE_STATUSES.has(status),
    amountMinor: Number.isFinite(amount) ? Math.trunc(amount) : null,
    currency: String(data.currency || data.total_currency || '').toUpperCase() || null,
    paidAt: data.paid_at || null,
    email: eventCustomerEmail(data),
    subscriptionCode: data.subscription?.subscription_code || data.subscription_code || null,
    planCode: data.plan?.plan_code || data.subscription?.plan?.plan_code || null,
    nextPaymentDate: data.subscription?.next_payment_date || data.next_payment_date || null,
  };
}

export function toSafeSubscriptionEvent(data = {}) {
  return {
    subscriptionCode: data.subscription_code || data.code || null,
    status: String(data.status || '').toLowerCase() || null,
    amountMinor: Number.isFinite(Number(data.amount)) ? Math.trunc(Number(data.amount)) : null,
    email: eventCustomerEmail(data),
    planCode: data.plan?.plan_code || data.plan_code || null,
    nextPaymentDate: data.next_payment_date || null,
  };
}

/** Subscription length in milliseconds, used to compute the next renewal date. */
export function billingIntervalMs(interval) {
  switch (interval) {
    case 'annually': return 365 * 24 * 60 * 60 * 1000;
    case 'biannually': return 182 * 24 * 60 * 60 * 1000;
    case 'quarterly': return 91 * 24 * 60 * 60 * 1000;
    case 'monthly':
    default: return 30 * 24 * 60 * 60 * 1000;
  }
}

export function formatAmount(amountMinor, currency = DEFAULT_CURRENCY) {
  const value = Number(amountMinor) / 100;
  try {
    return new Intl.NumberFormat('en-NG', { style: 'currency', currency, maximumFractionDigits: 2 }).format(value);
  } catch {
    return `${currency} ${value.toFixed(2)}`;
  }
}
