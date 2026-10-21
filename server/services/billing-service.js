import {
  billingConfig,
  findPlan,
  applyPromoCode,
  buildReference,
  normalizeReference,
  toSafeTransaction,
  toSafeInvoice,
  toSafeSubscriptionEvent,
  billingIntervalMs,
  FREE_PLAN,
} from './billing.js';
import { mergePlanPricing, planChargeDecision } from './pricing.js';

function httpError(status, message, code) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function addInterval(from, interval) {
  return new Date(new Date(from).getTime() + billingIntervalMs(interval)).toISOString();
}

function normalizeStatus(status) {
  const value = String(status || 'free').toLowerCase();
  return ['free', 'active', 'non_renewing', 'attention', 'canceled', 'past_due'].includes(value) ? value : 'active';
}

/** Subscription state merged from the subscription row and the user's denormalised columns. */
export function toSubscriptionView(subscription, user) {
  const planKey = String(user?.subscription_plan || subscription?.plan_key || 'free').toLowerCase();
  const plan = planKey === FREE_PLAN.key ? FREE_PLAN : findPlan(billingConfig(), planKey);
  return {
    plan: planKey,
    planName: plan?.name || (planKey === 'free' ? FREE_PLAN.name : planKey),
    status: normalizeStatus(user?.subscription_status || subscription?.status),
    interval: subscription?.interval || null,
    currentPeriodEnd: subscription?.current_period_end || null,
    cancelAtPeriodEnd: subscription?.cancel_at_period_end === true,
    startedAt: subscription?.started_at || null,
    canceledAt: subscription?.canceled_at || null,
    provider: subscription?.provider || null,
    startedWithPromoCode: subscription?.promo_code || null,
  };
}

export function createBillingService({
  pool,
  paystack,
  config = billingConfig(),
  pricing = null,
  logger = console,
  now = () => Date.now(),
  random,
} = {}) {
  const log = (level, message, extra = {}) => logger?.[level]?.(message, extra);

  /**
   * Prices come from `admin_settings` when the pricing store is available, and
   * from the environment otherwise. A read failure therefore degrades to the
   * deployed default instead of breaking checkout.
   */
  async function loadSnapshot() {
    if (!pricing?.snapshot) return mergePlanPricing({ config });
    try {
      return await pricing.snapshot();
    } catch (error) {
      log('warn', 'Stored prices could not be read; using the deployed defaults', { code: error.code || 'PRICING_READ_FAILED' });
      return mergePlanPricing({ config });
    }
  }

  function planFromSnapshot(snapshot, planKey) {
    const normalized = String(planKey || '').trim().toLowerCase();
    return (snapshot?.plans || []).find((plan) => plan.key === normalized) || null;
  }

  async function resolvePlan(planKey, snapshot) {
    return planFromSnapshot(snapshot || (await loadSnapshot()), planKey);
  }

  /** Limits always come from the plan definitions, never from the browser. */
  function limitsForPlan(planKey) {
    return findPlan(config, planKey)?.limits || FREE_PLAN.limits;
  }

  async function findUserIdByEmail(email) {
    if (!email) return null;
    const { rows } = await pool.query('SELECT id FROM users WHERE lower(email)=$1 LIMIT 1', [String(email).toLowerCase()]);
    return rows[0]?.id || null;
  }

  function callbackBase() {
    const configured = String(process.env.CLIENT_URL || '').split(',').map((item) => item.trim()).filter(Boolean)[0];
    return configured ? configured.replace(/\/$/, '') : '';
  }

  async function getUser(userId) {
    const { rows } = await pool.query(
      'SELECT id,name,email,subscription_status,subscription_plan,plan_limits FROM users WHERE id=$1 LIMIT 1',
      [userId],
    );
    if (!rows[0]) throw httpError(404, 'That account could not be found.', 'USER_NOT_FOUND');
    return rows[0];
  }

  async function getSubscriptionRow(userId) {
    const { rows } = await pool.query(
      `SELECT id,user_id,plan_key,status,interval,current_period_end,cancel_at_period_end,started_at,canceled_at,
         provider,provider_reference,provider_subscription_code,promo_code,updated_at
       FROM subscriptions WHERE user_id=$1 LIMIT 1`,
      [userId],
    );
    return rows[0] || null;
  }

  async function findPromoCode(code) {
    const normalized = String(code || '').trim().toUpperCase();
    if (!normalized) return null;
    const { rows } = await pool.query(
      `SELECT id,code,discount_type AS "discountType",discount_value AS "discountValue",max_uses AS "maxUses",
         current_uses AS "currentUses",expires_at AS "expiresAt",active
       FROM promo_codes WHERE upper(code)=$1 LIMIT 1`,
      [normalized],
    );
    return rows[0] || null;
  }

  async function quote({ planKey, promoCode, snapshot } = {}) {
    const effective = snapshot || (await loadSnapshot());
    const plan = planFromSnapshot(effective, planKey);
    if (!plan) throw httpError(400, 'Choose a valid plan.', 'PLAN_INVALID');
    const record = promoCode ? await findPromoCode(promoCode) : null;
    if (promoCode && !record) throw httpError(400, 'That promo code was not found.', 'PROMO_NOT_FOUND');
    const applied = applyPromoCode({ amountMinor: plan.amountMinor, promoCode: record });
    const decision = planChargeDecision({ plan, recurringEnabled: effective.recurringEnabled, hasDiscount: Boolean(applied.promoCode) });
    return {
      plan: plan.key,
      planName: plan.name,
      priceSource: plan.source,
      renewsAutomatically: decision.usePlan,
      amountMinor: applied.amountMinor,
      amount: applied.amountMinor / 100,
      discountMinor: applied.discountMinor,
      promoCode: applied.promoCode,
      currency: config.currency,
      interval: config.interval,
      limits: plan.limits,
    };
  }

  async function initialize({ userId, planKey, promoCode }) {
    if (!paystack?.isConfigured?.()) {
      throw httpError(503, 'Payments are not configured for this workspace yet.', 'PAYSTACK_NOT_CONFIGURED');
    }
    const base = callbackBase();
    if (!base) throw httpError(503, 'Payments are temporarily unavailable. Please try again later.', 'PAYSTACK_CALLBACK_MISSING');

    const user = await getUser(userId);
    const snapshot = await loadSnapshot();
    const priced = await quote({ planKey, promoCode, snapshot });
    const plan = planFromSnapshot(snapshot, priced.plan);
    if (priced.amountMinor <= 0) {
      throw httpError(409, 'That promo code covers the full price. Ask an administrator for a direct upgrade.', 'PROMO_FULL_DISCOUNT');
    }

    /**
     * A Paystack plan code makes the provider charge its own amount and repeat it
     * every interval, so it is only used when the mirrored plan is confirmed to
     * hold exactly this price and no discount is involved. Everything else stays
     * a verified one-time charge, which is what the workspace did before
     * recurring billing existed.
     */
    const decision = planChargeDecision({ plan, recurringEnabled: snapshot.recurringEnabled, hasDiscount: Boolean(priced.promoCode) });
    const planCode = decision.usePlan ? decision.planCode : null;
    if (!planCode && decision.reason !== 'recurring-disabled' && decision.reason !== 'discounted-checkout') {
      log('warn', 'Checkout falling back to a one-time charge', { planKey: priced.plan, reason: decision.reason });
    }

    // Reuse a recent pending checkout only when it was raised the same way, so a
    // reused Paystack page can never switch between plan and one-time charging.
    const pending = await pool.query(
      `SELECT reference,authorization_url,amount_minor,currency,COALESCE(plan_code,'') AS plan_code FROM billing_transactions
       WHERE user_id=$1 AND status='pending' AND amount_minor=$2 AND COALESCE(plan_code,'')=$3
         AND created_at > NOW() - INTERVAL '2 hours'
       ORDER BY created_at DESC LIMIT 1`,
      [userId, priced.amountMinor, planCode || ''],
    );
    const reusable = pending.rows[0];
    if (reusable?.authorization_url) {
      return {
        reference: reusable.reference,
        authorizationUrl: reusable.authorization_url,
        amountMinor: Number(reusable.amount_minor),
        discountMinor: priced.discountMinor,
        currency: reusable.currency,
        plan: priced.plan,
        promoCode: priced.promoCode,
        renewsAutomatically: Boolean(reusable.plan_code),
        reused: true,
      };
    }

    const reference = buildReference({ userId, now: now(), random });
    const transaction = await paystack.initializeTransaction({
      email: user.email,
      amountMinor: priced.amountMinor,
      currency: snapshot.currency,
      reference,
      planCode,
      callbackUrl: `${base}/billing/callback`,
      metadata: {
        user_id: user.id,
        plan: priced.plan,
        paystack_plan_code: planCode,
        promo_code: priced.promoCode?.code || null,
        interval: snapshot.interval,
        billing_mode: planCode ? 'subscription' : 'one-time',
        expected_amount_minor: priced.amountMinor,
        currency: snapshot.currency,
      },
    });

    await pool.query(
      `INSERT INTO billing_transactions(user_id,reference,provider,source,plan_key,promo_code_id,promo_code,amount_minor,discount_minor,
         currency,status,authorization_url,access_code,plan_code)
       VALUES($1,$2,'paystack','checkout',$3,$4,$5,$6,$7,$8,'pending',$9,$10,$11)`,
      [
        userId,
        transaction.reference,
        priced.plan,
        priced.promoCode?.id || null,
        priced.promoCode?.code || null,
        priced.amountMinor,
        priced.discountMinor,
        snapshot.currency,
        transaction.authorizationUrl,
        transaction.accessCode,
        planCode,
      ],
    );

    log('info', 'Paystack checkout initialized', { userId, plan: priced.plan, amountMinor: priced.amountMinor, billingMode: planCode ? 'subscription' : 'one-time' });
    return {
      reference: transaction.reference,
      authorizationUrl: transaction.authorizationUrl,
      amountMinor: priced.amountMinor,
      discountMinor: priced.discountMinor,
      currency: snapshot.currency,
      plan: priced.plan,
      promoCode: priced.promoCode,
      renewsAutomatically: Boolean(planCode),
      reused: false,
    };
  }

  async function subscriptionFor(userId) {
    const user = await getUser(userId);
    const subscription = await getSubscriptionRow(userId);
    const { rows: transactions } = await pool.query(
      `SELECT reference,plan_key AS "planKey",status,source,plan_code AS "planCode",amount_minor AS "amountMinor",currency,
         promo_code AS "promoCode",paid_at AS "paidAt",created_at AS "createdAt"
       FROM billing_transactions WHERE user_id=$1 ORDER BY created_at DESC LIMIT 10`,
      [userId],
    );
    return {
      subscription: toSubscriptionView(subscription, user),
      recentTransactions: transactions.map((row) => ({ ...row, amountMinor: Number(row.amountMinor) })),
      configured: Boolean(paystack?.isConfigured?.()),
      interval: config.interval,
      currency: config.currency,
    };
  }

  /**
   * Marks a verified transaction as paid and activates the subscription exactly
   * once. Safe to call from both the browser redirect and the webhook.
   */
  async function fulfillTransaction(reference, providerData) {
    const normalized = normalizeReference(reference);
    if (!normalized) throw httpError(400, 'That payment reference is not valid.', 'REFERENCE_INVALID');
    const safe = toSafeTransaction(providerData || {});

    const { rows } = await pool.query('SELECT * FROM billing_transactions WHERE reference=$1 LIMIT 1', [normalized]);
    const transaction = rows[0];
    if (!transaction) throw httpError(404, 'That payment reference was not found.', 'REFERENCE_NOT_FOUND');

    if (safe.status === 'success' && Number(transaction.amount_minor) !== safe.amountMinor) {
      log('error', 'Paystack amount mismatch', { reference: normalized, expected: Number(transaction.amount_minor), received: safe.amountMinor });
      throw httpError(409, 'That payment amount does not match the expected subscription price.', 'AMOUNT_MISMATCH');
    }
    if (safe.status === 'success' && transaction.currency && safe.currency
      && String(transaction.currency).toUpperCase() !== safe.currency) {
      throw httpError(409, 'That payment currency does not match the expected currency.', 'CURRENCY_MISMATCH');
    }

    if (safe.status !== 'success') {
      const nextStatus = safe.status === 'abandoned' ? 'abandoned' : safe.status === 'failed' ? 'failed' : 'pending';
      if (nextStatus !== 'pending') {
        await pool.query(
          "UPDATE billing_transactions SET status=$2,gateway_response=$3,updated_at=NOW() WHERE reference=$1 AND status='pending'",
          [normalized, nextStatus, safe.gatewayResponse],
        );
      }
      return { fulfilled: false, status: safe.status || 'pending', plan: transaction.plan_key };
    }

    if (transaction.status === 'success') {
      return { fulfilled: false, alreadyProcessed: true, status: 'success', plan: transaction.plan_key };
    }

    const plan = { key: transaction.plan_key, limits: limitsForPlan(transaction.plan_key) };
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const claimed = await client.query(
        `UPDATE billing_transactions SET status='success',paid_at=COALESCE($2::timestamptz,NOW()),
           gateway_response=$3,channel=$4,updated_at=NOW()
         WHERE reference=$1 AND status<>'success' RETURNING id`,
        [normalized, safe.paidAt || null, safe.gatewayResponse, safe.channel],
      );
      if (!claimed.rowCount) {
        await client.query('ROLLBACK');
        return { fulfilled: false, alreadyProcessed: true, status: 'success', plan: transaction.plan_key };
      }

      const { rows: userRows } = await client.query(
        'SELECT id,subscription_plan,subscription_status FROM users WHERE id=$1 FOR UPDATE',
        [transaction.user_id],
      );
      const user = userRows[0];
      if (!user) {
        await client.query('ROLLBACK');
        throw httpError(404, 'That account could not be found.', 'USER_NOT_FOUND');
      }

      // Renewing the same plan extends the current paid period; anything else starts today.
      const { rows: existing } = await client.query('SELECT plan_key,current_period_end FROM subscriptions WHERE user_id=$1', [user.id]);
      const samePlan = String(existing[0]?.plan_key || '') === String(transaction.plan_key);
      const extendFrom = samePlan && existing[0]?.current_period_end && new Date(existing[0].current_period_end).getTime() > now()
        ? existing[0].current_period_end
        : new Date(now()).toISOString();
      const periodEnd = addInterval(extendFrom, config.interval);

      await client.query(
        "UPDATE users SET subscription_status='active',subscription_plan=$2,plan_limits=$3 WHERE id=$1",
        [user.id, transaction.plan_key, JSON.stringify(plan.limits || {})],
      );
      await client.query(
        `INSERT INTO subscriptions(user_id,plan_key,status,interval,current_period_end,cancel_at_period_end,started_at,canceled_at,provider,provider_reference,promo_code,updated_at)
         VALUES($1,$2,'active',$3,$4,FALSE,NOW(),NULL,'paystack',$5,$6,NOW())
         ON CONFLICT(user_id) DO UPDATE SET plan_key=EXCLUDED.plan_key,status='active',interval=EXCLUDED.interval,
           current_period_end=EXCLUDED.current_period_end,cancel_at_period_end=FALSE,
           started_at=COALESCE(subscriptions.started_at,NOW()),canceled_at=NULL,provider='paystack',
           provider_reference=EXCLUDED.provider_reference,promo_code=COALESCE(EXCLUDED.promo_code,subscriptions.promo_code),
           updated_at=NOW()`,
        [user.id, transaction.plan_key, config.interval, periodEnd, normalized, transaction.promo_code],
      );
      if (transaction.promo_code_id) {
        await client.query('UPDATE promo_codes SET current_uses=current_uses+1,updated_at=NOW() WHERE id=$1', [transaction.promo_code_id]);
      }
      await client.query('COMMIT');
      log('info', 'Subscription activated', { userId: user.id, plan: transaction.plan_key, reference: normalized });
      return { fulfilled: true, status: 'success', plan: transaction.plan_key, currentPeriodEnd: periodEnd };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  /** Verifies with Paystack first, then fulfils. Used by the browser redirect. */
  async function verifyAndFulfill({ userId, reference }) {
    const normalized = normalizeReference(reference);
    if (!normalized) throw httpError(400, 'That payment reference is not valid.', 'REFERENCE_INVALID');
    const { rows } = await pool.query(
      'SELECT user_id,status FROM billing_transactions WHERE reference=$1 LIMIT 1',
      [normalized],
    );
    const transaction = rows[0];
    if (!transaction) throw httpError(404, 'That payment reference was not found.', 'REFERENCE_NOT_FOUND');
    if (String(transaction.user_id) !== String(userId)) {
      throw httpError(403, 'That payment does not belong to your account.', 'REFERENCE_FORBIDDEN');
    }
    if (transaction.status === 'success') {
      return { ...(await subscriptionFor(userId)), alreadyProcessed: true, reference: normalized };
    }

    const providerData = await paystack.verifyTransaction(normalized);
    await fulfillTransaction(normalized, providerData);
    return { ...(await subscriptionFor(userId)), reference: normalized };
  }

  /**
   * Recurring billing events. Paystack raises the next charge itself, so a
   * renewal arrives as a paid invoice rather than as a checkout we created:
   *
   *   invoice.create / invoice.update  -> the invoice for a renewal (paid when
   *                                        the stored card was charged)
   *   invoice.payment_failed           -> the renewal charge failed
   *   subscription.create              -> gives us the Paystack subscription code
   *   subscription.not_renew           -> the customer cancelled for next cycle
   *   subscription.disable             -> the subscription ended
   *   subscription.enable              -> the subscription was restarted
   *
   * Everything is keyed on the customer email we sent Paystack, and any event we
   * cannot map to an account is ignored instead of changing someone's access.
   */
  async function fulfillRenewal(invoice) {
    if (!invoice.invoiceCode) return { handled: false, reason: 'invalid-invoice' };
    if (!invoice.paid) return { handled: false, reason: 'invoice-not-paid' };
    if (invoice.amountMinor === null) return { handled: false, reason: 'unknown-amount' };
    const userId = await findUserIdByEmail(invoice.email);
    if (!userId) return { handled: false, reason: 'unmapped-customer' };

    const { rows } = await pool.query(
      `SELECT id,plan_key,status,interval,current_period_end FROM subscriptions WHERE user_id=$1 LIMIT 1`,
      [userId],
    );
    const subscription = rows[0];
    if (!subscription) return { handled: false, reason: 'no-subscription' };

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // The invoice code is unique, so replaying the same event is a no-op.
      const inserted = await client.query(
        `INSERT INTO billing_transactions(user_id,reference,provider,source,plan_key,amount_minor,currency,status,paid_at,plan_code)
         VALUES($1,$2,'paystack','renewal',$3,$4,$5,'success',COALESCE($6::timestamptz,NOW()),$7)
         ON CONFLICT(reference) DO NOTHING RETURNING id`,
        [userId, invoice.invoiceCode, subscription.plan_key, invoice.amountMinor, invoice.currency || config.currency, invoice.paidAt || null, invoice.planCode || null],
      );
      if (!inserted.rowCount) {
        await client.query('COMMIT');
        return { handled: true, fulfilled: false, alreadyProcessed: true, kind: 'renewal', plan: subscription.plan_key };
      }

      const from = subscription.current_period_end && new Date(subscription.current_period_end).getTime() > now()
        ? subscription.current_period_end
        : new Date(now()).toISOString();
      const periodEnd = addInterval(from, subscription.interval || config.interval);
      await client.query(
        "UPDATE users SET subscription_status='active',subscription_plan=$2,plan_limits=$3 WHERE id=$1",
        [userId, subscription.plan_key, JSON.stringify(limitsForPlan(subscription.plan_key))],
      );
      await client.query(
        `UPDATE subscriptions SET status='active',cancel_at_period_end=FALSE,canceled_at=NULL,current_period_end=$2,updated_at=NOW()
         WHERE id=$1`,
        [subscription.id, periodEnd],
      );
      await client.query('COMMIT');
      if (Number(invoice.amountMinor) !== Number(await currentPlanPriceMinor(subscription.plan_key))) {
        log('warn', 'Renewal amount differs from the current plan price', { userId, plan: subscription.plan_key, paid: invoice.amountMinor, invoice: invoice.invoiceCode });
      }
      log('info', 'Subscription renewed', { userId, plan: subscription.plan_key, invoice: invoice.invoiceCode, currentPeriodEnd: periodEnd });
      return { handled: true, fulfilled: true, kind: 'renewal', plan: subscription.plan_key, currentPeriodEnd: periodEnd, invoice: invoice.invoiceCode };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async function currentPlanPriceMinor(planKey) {
    const snapshot = await loadSnapshot();
    return planFromSnapshot(snapshot, planKey)?.amountMinor ?? null;
  }

  async function updateSubscriptionForEvent({ data, apply, reason }) {
    const email = data?.email || data?.customer?.email || null;
    const userId = await findUserIdByEmail(email);
    if (!userId) return { handled: false, reason: reason || 'unmapped-customer' };
    const { rows } = await pool.query(`SELECT id,user_id AS "userId",current_period_end FROM subscriptions WHERE user_id=$1 LIMIT 1`, [userId]);
    const subscription = rows[0];
    if (!subscription) return { handled: false, reason: 'no-subscription' };
    const result = await apply({ userId, subscription, data });
    return { handled: true, ...result };
  }

  /** Stores the Paystack subscription code so cancel and resume can use it. */
  async function rememberProviderSubscription(event) {
    const code = event.subscriptionCode;
    if (!code) return { handled: false, reason: 'no-subscription-code' };
    return updateSubscriptionForEvent({
      data: event,
      apply: async ({ subscription }) => {
        await pool.query(
          "UPDATE subscriptions SET provider_subscription_code=$2,provider='paystack',updated_at=NOW() WHERE id=$1 AND COALESCE(provider_subscription_code,'')<>$2",
          [subscription.id, code],
        );
        return { kind: 'provider-code', subscriptionCode: code };
      },
    });
  }

  async function markRenewalDisabled(event) {
    return updateSubscriptionForEvent({
      data: event,
      apply: async ({ subscription }) => {
        await pool.query(
          "UPDATE subscriptions SET status='non_renewing',cancel_at_period_end=TRUE,updated_at=NOW() WHERE id=$1",
          [subscription.id],
        );
        await pool.query("UPDATE users SET subscription_status='non_renewing' WHERE id=$1 AND subscription_status='active'", [subscription.userId]);
        return { kind: 'non_renewing' };
      },
    });
  }

  async function markProviderCanceled(event) {
    return updateSubscriptionForEvent({
      data: event,
      apply: async ({ userId, subscription }) => {
        const stillPaid = subscription.current_period_end && new Date(subscription.current_period_end).getTime() > now();
        await pool.query(
          "UPDATE subscriptions SET status='canceled',cancel_at_period_end=TRUE,canceled_at=COALESCE(canceled_at,NOW()),updated_at=NOW() WHERE id=$1",
          [subscription.id],
        );
        if (stillPaid) {
          await pool.query("UPDATE users SET subscription_status='non_renewing' WHERE id=$1", [userId]);
        } else {
          await pool.query("UPDATE users SET subscription_status='free',subscription_plan='free',plan_limits=$2 WHERE id=$1", [userId, JSON.stringify(FREE_PLAN.limits)]);
        }
        return { kind: 'canceled', accessUntil: subscription.current_period_end || null };
      },
    });
  }

  async function markPaymentFailed(event) {
    return updateSubscriptionForEvent({
      data: event,
      apply: async ({ subscription }) => {
        await pool.query("UPDATE subscriptions SET status='past_due',updated_at=NOW() WHERE id=$1 AND status IN ('active','non_renewing')", [subscription.id]);
        await pool.query("UPDATE users SET subscription_status='past_due' WHERE id=$1 AND subscription_status IN ('active','non_renewing')", [subscription.userId ?? null]);
        return { kind: 'past_due' };
      },
    });
  }

  async function markRenewalEnabled(event) {
    return updateSubscriptionForEvent({
      data: event,
      apply: async ({ subscription }) => {
        await pool.query(
          "UPDATE subscriptions SET status='active',cancel_at_period_end=FALSE,canceled_at=NULL,updated_at=NOW() WHERE id=$1",
          [subscription.id],
        );
        await pool.query("UPDATE users SET subscription_status='active' WHERE id=$1 AND subscription_status IN ('non_renewing','past_due')", [subscription.userId ?? null]);
        return { kind: 'active' };
      },
    });
  }

  /** Webhook entry point. Charges we started resolve by reference; renewals by customer. */
  async function handleWebhookEvent(event) {
    const eventName = String(event?.event || '');
    const data = event?.data || {};
    if (eventName === 'charge.success') {
      const reference = normalizeReference(data.reference);
      if (!reference) return { handled: false, event: eventName, reason: 'invalid-reference' };
      const { rows } = await pool.query('SELECT user_id FROM billing_transactions WHERE reference=$1 LIMIT 1', [reference]);
      if (!rows[0]) {
        log('warn', 'Paystack webhook for an unknown reference', { reference });
        return { handled: false, event: eventName, reason: 'unknown-reference' };
      }
      const result = await fulfillTransaction(reference, data);
      return { handled: true, event: eventName, ...result };
    }

    if (eventName === 'invoice.create' || eventName === 'invoice.update') {
      const invoice = toSafeInvoice(data);
      const result = await fulfillRenewal(invoice);
      return { handled: Boolean(result.handled), event: eventName, ...result };
    }
    if (eventName === 'invoice.payment_failed') {
      const result = await markPaymentFailed(toSafeInvoice(data));
      return { handled: Boolean(result.handled), event: eventName, ...result };
    }
    if (eventName === 'subscription.create') {
      const payload = toSafeSubscriptionEvent(data);
      const stored = await rememberProviderSubscription(payload);
      // A subscription created from a plan code also needs the paid invoice
      // recorded, which Paystack reports separately, so only the code is stored.
      return { handled: Boolean(stored.handled), event: eventName, ...stored };
    }
    if (eventName === 'subscription.not_renew') {
      const result = await markRenewalDisabled(toSafeSubscriptionEvent(data));
      return { handled: Boolean(result.handled), event: eventName, ...result };
    }
    if (eventName === 'subscription.disable') {
      const result = await markProviderCanceled(toSafeSubscriptionEvent(data));
      return { handled: Boolean(result.handled), event: eventName, ...result };
    }
    if (eventName === 'subscription.enable') {
      const result = await markRenewalEnabled(toSafeSubscriptionEvent(data));
      return { handled: Boolean(result.handled), event: eventName, ...result };
    }
    return { handled: false, event: eventName };
  }

  /**
   * Cancelling keeps the paid period, but a Paystack-backed subscription must
   * also be disabled at the provider or the customer is charged again. A provider
   * failure is reported rather than blocking the local change, matching how the
   * rest of the workspace treats third-party cleanup.
   */
  async function cancel({ userId }) {
    const user = await getUser(userId);
    const subscription = await getSubscriptionRow(userId);
    if (!subscription || ['canceled', 'free'].includes(String(subscription.status))) {
      throw httpError(409, 'There is no active subscription to cancel.', 'SUBSCRIPTION_NONE');
    }
    const { rows } = await pool.query(
      'UPDATE subscriptions SET cancel_at_period_end=TRUE,canceled_at=NOW(),updated_at=NOW() WHERE user_id=$1 RETURNING *',
      [userId],
    );
    log('info', 'Subscription set to cancel at period end', { userId: user.id, plan: rows[0]?.plan_key });
    const provider = await disableAtProvider({ code: subscription.provider_subscription_code });
    return { ...toSubscriptionView(rows[0], user), provider };
  }

  async function resume({ userId }) {
    const user = await getUser(userId);
    const subscription = await getSubscriptionRow(userId);
    if (!subscription) throw httpError(409, 'There is no subscription to resume.', 'SUBSCRIPTION_NONE');
    if (String(subscription.status) === 'canceled') {
      throw httpError(409, 'That subscription has ended. Choose a plan to start again.', 'SUBSCRIPTION_ENDED');
    }
    const { rows } = await pool.query(
      'UPDATE subscriptions SET cancel_at_period_end=FALSE,updated_at=NOW() WHERE user_id=$1 RETURNING *',
      [userId],
    );
    log('info', 'Subscription renewal resumed', { userId: user.id, plan: rows[0]?.plan_key });
    const provider = await enableAtProvider({ code: subscription.provider_subscription_code });
    return { ...toSubscriptionView(rows[0], user), provider };
  }

  async function disableAtProvider({ code }) {
    if (!code) {
      return { status: 'local-only', message: 'No Paystack subscription is linked to this account yet, so only renewals in Signal Desk were stopped.' };
    }
    if (!paystack?.isConfigured?.()) {
      return { status: 'not_configured', message: 'Paystack is not configured, so renewal was stopped only in Signal Desk.' };
    }
    try {
      const result = await paystack.disableSubscription(code);
      return { status: 'disabled', subscriptionCode: code, message: result?.message || 'Paystack will not bill this subscription again.' };
    } catch (error) {
      log('error', 'Paystack subscription could not be disabled', { code, errorCode: error.code || 'SUBSCRIPTION_DISABLE_FAILED' });
      return {
        status: 'failed',
        subscriptionCode: code,
        message: `${error.userMessage || 'Paystack could not be reached.'} You may still be charged next cycle, so try cancelling again.`,
      };
    }
  }

  async function enableAtProvider({ code }) {
    if (!code) {
      return { status: 'local-only', message: 'Renewals resume in Signal Desk. Paystack will charge you again only if a subscription is linked to this account.' };
    }
    if (!paystack?.isConfigured?.()) {
      return { status: 'not_configured', message: 'Paystack is not configured, so renewal was resumed only in Signal Desk.' };
    }
    try {
      const detail = await paystack.fetchSubscription(code);
      await paystack.enableSubscription({ code, token: detail?.emailToken, authorization: detail?.authorizationCode });
      return { status: 'enabled', subscriptionCode: code, message: 'Paystack will bill this subscription again each period.' };
    } catch (error) {
      log('error', 'Paystack subscription could not be re-enabled', { code, errorCode: error.code || 'SUBSCRIPTION_ENABLE_FAILED' });
      return {
        status: 'failed',
        subscriptionCode: code,
        message: `${error.userMessage || 'Paystack could not be reached.'} Your plan stays active until the period ends; contact support to restart billing.`,
      };
    }
  }

  /** Downgrades subscriptions whose paid period has ended. Safe to run repeatedly. */
  async function expireDueSubscriptions() {
    const { rows } = await pool.query(
      `SELECT s.user_id FROM subscriptions s JOIN users u ON u.id=s.user_id
       WHERE s.current_period_end IS NOT NULL AND s.current_period_end <= NOW()
         AND (s.status IN ('active','non_renewing','past_due') OR u.subscription_status IN ('active','non_renewing','past_due'))
       GROUP BY s.user_id`,
    );
    const expired = [];
    for (const row of rows) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          "UPDATE subscriptions SET status='canceled',updated_at=NOW() WHERE user_id=$1 AND current_period_end <= NOW()",
          [row.user_id],
        );
        await client.query(
          "UPDATE users SET subscription_status='free',subscription_plan='free',plan_limits=$2 WHERE id=$1",
          [row.user_id, JSON.stringify(FREE_PLAN.limits)],
        );
        await client.query('COMMIT');
        expired.push(row.user_id);
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        log('warn', 'Subscription expiry failed', { userId: row.user_id, code: error.code || 'SUBSCRIPTION_EXPIRY_FAILED' });
      } finally {
        client.release();
      }
    }
    if (expired.length) log('info', 'Expired subscriptions downgraded', { count: expired.length });
    return expired;
  }

  return Object.freeze({
    initialize,
    quote,
    resolvePlan,
    loadSnapshot,
    subscriptionFor,
    verifyAndFulfill,
    fulfillTransaction,
    fulfillRenewal,
    handleWebhookEvent,
    cancel,
    resume,
    expireDueSubscriptions,
  });
}
