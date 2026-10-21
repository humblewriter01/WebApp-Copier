/**
 * Keeps the Paystack plan for each subscription plan at exactly the price stored
 * in the database.
 *
 * Paystack raises a subscription's recurring charge from the plan, not from the
 * amount a checkout passes, so a price saved in the admin panel is only useful
 * once `POST /plan` or `PUT /plan/:id_or_code` has applied it. Two rules make
 * this safe:
 *
 * 1. The provider state is always read back with `GET /plan/:id_or_code` after a
 *    write, because Paystack's update reply carries only a message. If the
 *    amount Paystack reports is not the amount we asked for, the sync is marked
 *    failed.
 * 2. A failed or unverified sync makes checkout fall back to a one-time charge
 *    instead of raising the wrong recurring amount. The saved price is never
 *    rolled back, so a Paystack outage cannot stop the workspace from charging
 *    the price the administrator just set.
 */

import { paystackPlanName } from './pricing.js';
import { isProviderNotFound } from './paystack.js';

const SUCCESS_STATUSES = new Set(['synced', 'in_sync']);

/** Every result names the plan it belongs to, so the admin panel can label it. */
function withPlan(plan, sync) {
  return { planKey: plan.key, planName: plan.name, amountMinor: plan.amountMinor, currency: plan.currency, interval: plan.interval, ...sync };
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

export function createPlanSynchronizer({ paystack, pricing, config, logger = console } = {}) {
  const log = (level, message, extra = {}) => logger?.[level]?.(message, extra);

  async function persist(planKey, sync, actorId) {
    try {
      await pricing.recordPlanSync({ planKey, sync, actorId });
    } catch (error) {
      log('error', 'Paystack plan state could not be saved', { planKey, code: error.code || 'PLAN_SYNC_PERSIST_FAILED' });
    }
  }

  /**
   * Creates or updates the Paystack plan for one Signal Desk plan and verifies
   * the result. Never throws: the returned object always describes what an
   * administrator should do next.
   */
  async function syncPlan({ planKey, actorId = null } = {}) {
    const plan = await pricing.planFor(planKey);
    if (!plan) {
      return { planKey: String(planKey || ''), status: 'failed', message: 'That plan is not available for pricing.', usable: false };
    }

    const desired = {
      name: paystackPlanName(plan),
      amountMinor: plan.amountMinor,
      interval: plan.interval,
      currency: plan.currency,
      description: plan.description,
    };

    if (!paystack?.isConfigured?.()) {
      const message = 'Paystack is not configured for this workspace, so no plan price was pushed.';
      return withPlan(plan, { status: 'not_configured', message, usable: false, planCode: plan.paystack?.planCode || null, syncedAmountMinor: null });
    }

    const existingCode = plan.paystack?.planCode || null;
    try {
      let provider = null;
      if (existingCode) {
        try {
          provider = await paystack.fetchPlan(existingCode);
        } catch (error) {
          if (!isProviderNotFound(error)) throw error;
          log('warn', 'Stored Paystack plan code no longer exists; creating a new plan', { planKey: plan.key, planCode: existingCode });
          provider = null;
        }
      }

      if (provider && providerMatches(provider, desired)) {
        const sync = {
          status: 'in_sync',
          planCode: provider.planCode || existingCode,
          planId: provider.id,
          syncedAmountMinor: provider.amountMinor,
          currency: provider.currency || desired.currency,
          interval: provider.interval || desired.interval,
          name: provider.name || desired.name,
          message: 'Paystack already charges this amount, so nothing was changed.',
        };
        await persist(plan.key, sync, actorId);
        return withPlan(plan, { ...sync, usable: true });
      }

      let message;
      let affectedSubscriptions = null;
      if (provider) {
        const migrated = await paystack.updatePlan(existingCode, {
          ...desired,
          updateExistingSubscriptions: plan.updateExistingSubscriptions !== false,
        });
        affectedSubscriptions = Number.isFinite(Number(migrated?.affectedSubscriptions)) ? Number(migrated.affectedSubscriptions) : null;
        message = migrated?.message || 'Paystack plan updated.';
      } else {
        const created = await paystack.createPlan(desired);
        try {
          provider = await paystack.fetchPlan(created.planCode);
        } catch {
          provider = created;
        }
        message = `Paystack plan created (${created.planCode}).`;
      }

      let verified = provider;
      if (!providerMatches(verified, desired)) {
        try {
          verified = await paystack.fetchPlan(provider?.planCode || existingCode) || provider;
        } catch {
          verified = provider;
        }
      }

      if (!providerMatches(verified, desired) && !sameAmount(verified?.amountMinor, desired.amountMinor)) {
        const sync = {
          status: 'failed',
          planCode: verified?.planCode || existingCode || null,
          planId: verified?.id ?? null,
          syncedAmountMinor: verified?.amountMinor ?? null,
          currency: verified?.currency || desired.currency,
          interval: verified?.interval || desired.interval,
          name: verified?.name || desired.name,
          message: 'Paystack did not confirm the new plan amount. The price is saved here, and checkouts stay one-time until the plan syncs.',
          error: 'PLAN_AMOUNT_UNCONFIRMED',
        };
        await persist(plan.key, sync, actorId);
        return withPlan(plan, { ...sync, usable: false, affectedSubscriptions });
      }

      if (!providerMatches(verified, desired)) {
        const sync = {
          status: 'failed',
          planCode: verified?.planCode || existingCode || null,
          planId: verified?.id ?? null,
          syncedAmountMinor: verified?.amountMinor ?? null,
          currency: verified?.currency || null,
          interval: verified?.interval || null,
          name: verified?.name || null,
          message: `Paystack reports ${verified?.currency || 'an unknown currency'} ${verified?.interval || 'an unknown interval'} for this plan, which does not match this workspace. Check PAYSTACK_CURRENCY and PAYSTACK_PLAN_INTERVAL.`,
          error: 'PLAN_MISMATCH',
        };
        await persist(plan.key, sync, actorId);
        return withPlan(plan, { ...sync, usable: false, affectedSubscriptions });
      }

      const sync = {
        status: 'synced',
        planCode: verified.planCode || existingCode,
        planId: verified.id ?? null,
        syncedAmountMinor: verified.amountMinor,
        currency: verified.currency || desired.currency,
        interval: verified.interval || desired.interval,
        name: verified.name || desired.name,
        message,
      };
      await persist(plan.key, sync, actorId);
      return withPlan(plan, { ...sync, usable: true, affectedSubscriptions });
    } catch (error) {
      const sync = {
        status: 'failed',
        planCode: existingCode || null,
        planId: plan.paystack?.planId ?? null,
        syncedAmountMinor: null,
        currency: desired.currency,
        interval: desired.interval,
        name: desired.name,
        message: error.userMessage || 'Paystack could not update the plan price. The price is saved here, and checkouts stay one-time until the plan syncs.',
        error: error.code || 'PLAN_SYNC_FAILED',
      };
      await persist(plan.key, sync, actorId);
      log("error", "Paystack plan synchronisation failed", { planKey: plan.key, code: sync.error, detail: error.stack });
      return { ...sync, usable: false };
    }
  }

  async function syncAll({ planKeys, actorId = null } = {}) {
    const requested = Array.isArray(planKeys) && planKeys.length ? planKeys : (config.plans || []).map((plan) => plan.key);
    const results = [];
    for (const planKey of requested) {
      results.push(await syncPlan({ planKey, actorId }));
    }
    return results;
  }

  return Object.freeze({ syncPlan, syncAll, isSuccessStatus: (status) => SUCCESS_STATUSES.has(String(status)) });
}
