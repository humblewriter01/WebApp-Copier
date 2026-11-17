/**
 * Keeps the Flutterwave payment plan for each Signal Desk plan at exactly the stored price, per currency.
 *
 * Flutterwave raises a subscription's recurring charge from the plan, not from the amount a checkout passes, so
 * a price saved in the admin panel is only real once `POST /v3/payment-plans` has applied it. Flutterwave does
 * not allow a payment plan's amount to be changed: whenever a stored plan no longer matches, this synchroniser
 * creates a replacement instead of sending a `PUT`. A Flutterwave plan holds one amount in one currency, which
 * is why this runs per (plan, currency) pair and why a workspace that sells in NGN and USD keeps two mirrored
 * plans per tier.
 *
 * Four rules make this safe:
 *
 * 1. The newly-created provider state is checked against the amount, currency, and interval we asked for. If
 *    Flutterwave reports something else, the sync is marked failed.
 * 2. A failed or unverified sync makes checkout fall back to a one-time charge, so a provider outage can never
 *    raise the wrong recurring amount - and never stops the workspace charging the price just saved.
 * 3. A price is only ever pushed in a currency the plan has a stored price for. "USD is not priced yet" is a
 *    skipped sync with a reason, not a plan created for 0.
 * 4. Replacing a plan persists the replacement id before it is considered usable. Future checkouts read that
 *    id from `plan_provider_sync`, while existing Flutterwave subscriptions remain attached to their old plan.
 */

import { providerPlanName } from './pricing.js';
import { isProviderNotFound } from './flutterwave.js';
import { normalizeCurrency, planPriceMinor } from './billing.js';

const SUCCESS_STATUSES = new Set(['synced', 'in_sync']);

/** Every result names the plan and currency it belongs to, so the panel can label it without guessing. */
function withPlan(plan, currency, sync) {
  return {
    planKey: plan.key,
    planName: plan.name,
    currency,
    amountMinor: planPriceMinor(plan, currency),
    interval: plan.interval,
    ...sync,
  };
}

function sameAmount(a, b) {
  return Number.isFinite(Number(a)) && Number(a) === Number(b);
}

function providerMatches(provider, desired) {
  return Boolean(provider)
    && sameAmount(provider.amountMinor, desired.amountMinor)
    && String(provider.currency || desired.currency).toUpperCase() === String(desired.currency).toUpperCase()
    && String(provider.interval || desired.interval).toLowerCase() === String(desired.interval).toLowerCase();
}

/**
 *
 * @typedef {Object} PlanSynchronizerDeps
 * @property {Record<string, any>} [flutterwave]
 * @property {Record<string, any>} [pricing]
 * @property {Record<string, any>} [config]
 * @property {LoggerMethods} [logger]
 */
export function createPlanSynchronizer(/** @type {PlanSynchronizerDeps} */ { flutterwave, pricing, config, logger = console } = {}) {
  const log = (level, message, extra = {}) => logger?.[level]?.(message, extra);

  async function persist(planKey, currency, sync, actorId) {
    try {
      await pricing.recordPlanSync({ planKey, currency, sync, actorId });
    } catch (error) {
      log('error', 'Flutterwave plan state could not be saved', { planKey, currency, code: error.code || 'PLAN_SYNC_PERSIST_FAILED' });
    }
  }

  /**
   * Creates or replaces the Flutterwave payment plan for one Signal Desk plan in one currency, and verifies the
   * result. Never throws: the returned object always describes what an administrator should do next.
 *
 * @typedef {Object} SyncPlanInput
 * @property {string} [planKey]
 * @property {string|null} [currency]
 * @property {string|null} [actorId]
 */
async function syncPlan(/** @type {SyncPlanInput} */ { planKey, currency = null, actorId = null } = {}) {
    const plan = await pricing.planFor(planKey);
    if (!plan) {
      return { planKey: String(planKey || ''), currency: normalizeCurrency(currency || config?.currency), status: 'failed', message: 'That plan is not available for pricing.', usable: false };
    }
    const code = normalizeCurrency(currency || plan.currency || config?.currency);
    const amountMinor = planPriceMinor(plan, code);
    if (amountMinor === null) {
      return withPlan(plan, code, {
        status: 'not_priced',
        usable: false,
        planId: plan.provider?.[code]?.planId ?? null,
        message: `${plan.name} has no ${code} price, so there is nothing to mirror. Set the ${code} price to enable automatic renewal in that currency.`,
      });
    }

    const desired = {
      name: providerPlanName(plan, code),
      amountMinor,
      interval: plan.interval || config?.interval || 'monthly',
      currency: code,
    };

    if (!flutterwave?.isConfigured?.()) {
      const message = 'Flutterwave is not configured for this workspace, so no plan price was pushed.';
      return withPlan(plan, code, { status: 'not_configured', message, usable: false, planId: plan.provider?.[code]?.planId || null, syncedAmountMinor: null });
    }

    const existingId = plan.provider?.[code]?.planId ?? null;
    try {
      let provider = null;
      if (existingId) {
        try {
          provider = await flutterwave.fetchPlan(existingId);
        } catch (error) {
          if (!isProviderNotFound(error)) throw error;
          log('warn', 'Stored Flutterwave plan id no longer exists; creating a new plan', { planKey: plan.key, planId: existingId, currency: code });
          provider = null;
        }
      }

      if (provider && providerMatches(provider, desired)) {
        const sync = {
          status: 'in_sync',
          planId: provider.planId ?? existingId,
          syncedAmountMinor: provider.amountMinor,
          currency: provider.currency || desired.currency,
          interval: provider.interval || desired.interval,
          name: provider.name || desired.name,
          message: 'Flutterwave already charges this amount, so nothing was changed.',
        };
        await persist(plan.key, code, sync, actorId);
        return withPlan(plan, code, { ...sync, usable: true });
      }

      /* Flutterwave rejects amount updates on existing payment plans. A mismatch therefore always gets a new
         provider plan, even when a record already points at an older plan. Persisting this id below changes
         the plan bound to all future checkouts; Flutterwave leaves customers already subscribed to the old id
         on the price they accepted. */
      const created = await flutterwave.createPlan(desired);
      const replacing = Boolean(provider && existingId);
      const message = replacing
        ? `Flutterwave plan created (${created.planId}) for future subscriptions. Existing subscribers on ${existingId} remain on their original plan.`
        : `Flutterwave plan created (${created.planId}).`;

      const targetId = created?.planId ?? null;
      let verified = { ...created };
      if (!providerMatches(verified, desired)) {
        try {
          verified = (await flutterwave.fetchPlan(targetId)) || verified;
        } catch {
          verified = provider;
        }
      }

      if (!sameAmount(verified?.amountMinor, desired.amountMinor)) {
        const sync = {
          status: 'failed',
          planId: targetId ?? null,
          syncedAmountMinor: verified?.amountMinor ?? null,
          currency: verified?.currency || desired.currency,
          interval: verified?.interval || desired.interval,
          name: verified?.name || desired.name,
          message: 'Flutterwave did not confirm the new plan amount. The price is saved here, and checkouts stay one-time until the plan syncs.',
          error: 'PLAN_AMOUNT_UNCONFIRMED',
        };
        await persist(plan.key, code, sync, actorId);
        return withPlan(plan, code, { ...sync, usable: false });
      }

      if (!providerMatches(verified, desired)) {
        const sync = {
          status: 'failed',
          planId: targetId ?? null,
          syncedAmountMinor: verified?.amountMinor ?? null,
          currency: verified?.currency || null,
          interval: verified?.interval || null,
          name: verified?.name || null,
          message: `Flutterwave reports ${verified?.currency || 'an unknown currency'} ${verified?.interval || 'an unknown interval'} for this plan, which does not match this workspace. Check FLW_CURRENCY and FLW_PLAN_INTERVAL.`,
          error: 'PLAN_MISMATCH',
        };
        await persist(plan.key, code, sync, actorId);
        return withPlan(plan, code, { ...sync, usable: false });
      }

      const sync = {
        status: 'synced',
        planId: verified.planId ?? targetId ?? null,
        planToken: verified.planToken ?? null,
        syncedAmountMinor: verified.amountMinor,
        currency: verified.currency || desired.currency,
        interval: verified.interval || desired.interval,
        name: verified.name || desired.name,
        message,
      };
      await persist(plan.key, code, sync, actorId);
      return withPlan(plan, code, { ...sync, usable: true });
    } catch (error) {
      const sync = {
        status: 'failed',
        planId: existingId ?? null,
        planToken: null,
        syncedAmountMinor: null,
        currency: desired.currency,
        interval: desired.interval,
        name: desired.name,
        message: error.userMessage || 'Flutterwave could not create the replacement plan. The price is saved here, and checkouts stay one-time until the plan syncs.',
        error: error.code || 'PLAN_SYNC_FAILED',
      };
      await persist(plan.key, code, sync, actorId);
      log('error', 'Flutterwave plan synchronisation failed', { planKey: plan.key, currency: code, code: sync.error, detail: error.stack });
      return { ...sync, planKey: plan.key, planName: plan.name, currency: code, usable: false };
    }
  }

  /**
   * Syncs every currency a plan is priced in, unless a list is given.
   *
   * Both currencies are refreshed by default because that is the state an administrator means when they press
   * "Sync": a plan that is in sync in naira and stale in dollars is a plan that will charge an international
   * customer the wrong amount, and the failure would only surface in another country.
   */
    /**
 * @typedef {Object} SyncAllInput
 * @property {string[]} [planKeys] - the plans to push; absent or empty means every plan this app defines
 * @property {string[]|null} [currencies] - and the currencies to push them in, same rule
 * @property {string|null} [actorId] - the administrator whose name goes in the history row
 */
  async function syncAll(/** @type {SyncAllInput} */ { planKeys, currencies = null, actorId = null } = {}) {
    const requested = Array.isArray(planKeys) && planKeys.length ? planKeys : (config?.plans || []).map((plan) => plan.key);
    const results = [];
    for (const planKey of requested) {
      const codes = (Array.isArray(currencies) && currencies.length ? currencies : config?.supportedCurrencies || ['NGN'])
        .map((code) => normalizeCurrency(code));
      for (const code of [...new Set(codes)]) {
        results.push(await syncPlan({ planKey, currency: code, actorId }));
      }
    }
    return results;
  }

  return Object.freeze({ syncPlan, syncAll, isSuccessStatus: (status) => SUCCESS_STATUSES.has(String(status)) });
}
