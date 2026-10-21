import { FREE_PLAN, billingConfig, findPlan } from './billing.js';

const LIMIT_LABELS = Object.freeze({
  maxTradingAccounts: 'connected trading accounts',
  maxTelegramChannels: 'monitored Telegram channels',
  maxDailySignals: 'signals per day',
});

function numericEntries(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value)
    .filter(([key, entry]) => Object.hasOwn(LIMIT_LABELS, key) && Number.isFinite(Number(entry)) && Number(entry) > 0)
    .map(([key, entry]) => [key, Math.trunc(Number(entry))]));
}

/**
 * Effective limits for a user. Paid plans store their limits in `plan_limits`
 * when the subscription activates; anything else falls back to the free plan so
 * an expired subscription can never keep paid limits.
 */
export function planLimitsFor(user, config = billingConfig()) {
  const status = String(user?.subscription_status || 'free').toLowerCase();
  const planKey = String(user?.subscription_plan || 'free').toLowerCase();
  if (status !== 'active' && status !== 'non_renewing') return FREE_PLAN.limits;
  const plan = findPlan(config, planKey);
  const stored = numericEntries(user?.plan_limits);
  if (Object.keys(stored).length) return { ...FREE_PLAN.limits, ...plan?.limits, ...stored };
  if (plan) return plan.limits;
  return FREE_PLAN.limits;
}

export function limitLabel(limitKey) {
  return LIMIT_LABELS[limitKey] || 'items';
}

export function buildLimitError({ limitKey, limit, planKey }) {
  const error = new Error(
    `Your ${planKey === 'free' ? 'Free' : planKey} plan allows ${limit} ${limitLabel(limitKey)}. Upgrade your plan to add more.`,
  );
  error.status = 402;
  error.code = 'PLAN_LIMIT_REACHED';
  error.limitKey = limitKey;
  error.upgradeRequired = true;
  return error;
}
