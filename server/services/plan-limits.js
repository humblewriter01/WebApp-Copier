import { FREE_PLAN, billingConfig, findPlan } from './billing.js';

const LIMIT_LABELS = Object.freeze({
  maxTradingAccounts: 'connected trading accounts',
  maxTelegramChannels: 'monitored Telegram channels',
  maxDailySignals: 'signals per day',
});

function numericEntries(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  // Zero is a real limit here (Free allows no trading accounts), so it must survive
  // the round trip through the stored snapshot instead of being read as "unset".
  return Object.fromEntries(Object.entries(value)
    .filter(([key, entry]) => Object.hasOwn(LIMIT_LABELS, key) && Number.isFinite(Number(entry)) && Number(entry) >= 0)
    .map(([key, entry]) => [key, Math.trunc(Number(entry))]));
}

/** The statuses that still hold a paid workspace: renewing, or cancelling but paid until the period ends. */
export const PAID_STATUSES = Object.freeze(['active', 'non_renewing']);

export function isPaidSubscriber(user) {
  const status = String(user?.subscription_status ?? user?.subscriptionStatus ?? 'free').toLowerCase();
  return PAID_STATUSES.includes(status);
}

/**
 * Effective limits for a user. Paid plans store a `plan_limits` snapshot when the
 * subscription activates; the deployed plan definition wins over that snapshot, so a
 * re-priced or re-limited tier applies to existing subscribers too instead of leaving
 * them on limits the catalogue no longer offers. A snapshot still fills any limit the
 * current definition does not name, which is what a retired plan key needs. Anything
 * that is not an active or non-renewing subscription falls back to the free plan, so an
 * expired subscription can never keep paid limits.
 */
export function planLimitsFor(user, config = billingConfig()) {
  const status = String(user?.subscription_status || 'free').toLowerCase();
  const planKey = String(user?.subscription_plan || 'free').toLowerCase();
  if (!PAID_STATUSES.includes(status)) return FREE_PLAN.limits;
  const plan = findPlan(config, planKey);
  const stored = numericEntries(user?.plan_limits);
  if (Object.keys(stored).length) return { ...FREE_PLAN.limits, ...stored, ...plan?.limits };
  if (plan) return plan.limits;
  return FREE_PLAN.limits;
}

export function limitLabel(limitKey) {
  return LIMIT_LABELS[limitKey] || 'items';
}

/** A limit of zero means the tier does not include the thing at all, which reads
 * badly as "allows 0 of them", so it gets its own sentence. */
export function buildLimitError({ limitKey, limit, planKey }) {
  const name = planKey === 'free' ? 'Free' : planKey.charAt(0).toUpperCase() + planKey.slice(1);
  const message = Number(limit) === 0
    ? `The ${name} plan does not include ${limitLabel(limitKey)}. Upgrade to Starter or higher to add one.`
    : `Your ${name} plan allows ${limit} ${limitLabel(limitKey)}. Upgrade your plan to add more.`;
  const error = new Error(message);
  error.status = 402;
  error.code = 'PLAN_LIMIT_REACHED';
  error.limitKey = limitKey;
  error.upgradeRequired = true;
  return error;
}
