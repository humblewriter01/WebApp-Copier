import {
  billingConfig,
  findPlan,
  applyPromoCode,
  buildReference,
  normalizeReference,
  toSafeTransaction,
  billingIntervalMs,
  FREE_PLAN,
} from './billing.js';

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
  logger = console,
  now = () => Date.now(),
  random,
} = {}) {
  const log = (level, message, extra = {}) => logger?.[level]?.(message, extra);

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
         provider,provider_reference,promo_code,updated_at
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

  async function quote({ planKey, promoCode }) {
    const plan = findPlan(config, planKey);
    if (!plan) throw httpError(400, 'Choose a valid plan.', 'PLAN_INVALID');
    const record = promoCode ? await findPromoCode(promoCode) : null;
    if (promoCode && !record) throw httpError(400, 'That promo code was not found.', 'PROMO_NOT_FOUND');
    const applied = applyPromoCode({ amountMinor: plan.amountMinor, promoCode: record });
    return {
      plan: plan.key,
      planName: plan.name,
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
    const priced = await quote({ planKey, promoCode });
    if (priced.amountMinor <= 0) {
      throw httpError(409, 'That promo code covers the full price. Ask an administrator for a direct upgrade.', 'PROMO_FULL_DISCOUNT');
    }

    // Reuse a recent pending checkout for the same amount instead of opening a
    // second charge attempt for the same user.
    const pending = await pool.query(
      `SELECT reference,authorization_url,amount_minor,currency FROM billing_transactions
       WHERE user_id=$1 AND status='pending' AND amount_minor=$2 AND created_at > NOW() - INTERVAL '2 hours'
       ORDER BY created_at DESC LIMIT 1`,
      [userId, priced.amountMinor],
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
        reused: true,
      };
    }

    const reference = buildReference({ userId, now: now(), random });
    const transaction = await paystack.initializeTransaction({
      email: user.email,
      amountMinor: priced.amountMinor,
      currency: config.currency,
      reference,
      callbackUrl: `${base}/billing/callback`,
      metadata: {
        user_id: user.id,
        plan: priced.plan,
        promo_code: priced.promoCode?.code || null,
        interval: config.interval,
        expected_amount_minor: priced.amountMinor,
        currency: config.currency,
      },
    });

    await pool.query(
      `INSERT INTO billing_transactions(user_id,reference,provider,plan_key,promo_code_id,promo_code,amount_minor,discount_minor,
         currency,status,authorization_url,access_code)
       VALUES($1,$2,'paystack',$3,$4,$5,$6,$7,$8,'pending',$9,$10)`,
      [
        userId,
        transaction.reference,
        priced.plan,
        priced.promoCode?.id || null,
        priced.promoCode?.code || null,
        priced.amountMinor,
        priced.discountMinor,
        config.currency,
        transaction.authorizationUrl,
        transaction.accessCode,
      ],
    );

    log('info', 'Paystack checkout initialized', { userId, plan: priced.plan, amountMinor: priced.amountMinor });
    return {
      reference: transaction.reference,
      authorizationUrl: transaction.authorizationUrl,
      amountMinor: priced.amountMinor,
      discountMinor: priced.discountMinor,
      currency: config.currency,
      plan: priced.plan,
      promoCode: priced.promoCode,
      reused: false,
    };
  }

  async function subscriptionFor(userId) {
    const user = await getUser(userId);
    const subscription = await getSubscriptionRow(userId);
    const { rows: transactions } = await pool.query(
      `SELECT reference,plan_key AS "planKey",status,amount_minor AS "amountMinor",currency,
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

    const plan = findPlan(config, transaction.plan_key) || FREE_PLAN;
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

  /** Webhook entry point. The reference always resolves to a transaction we created. */
  async function handleWebhookEvent(event) {
    const eventName = String(event?.event || '');
    if (eventName !== 'charge.success') return { handled: false, event: eventName };
    const reference = normalizeReference(event?.data?.reference);
    if (!reference) return { handled: false, event: eventName, reason: 'invalid-reference' };
    const { rows } = await pool.query('SELECT user_id FROM billing_transactions WHERE reference=$1 LIMIT 1', [reference]);
    if (!rows[0]) {
      log('warn', 'Paystack webhook for an unknown reference', { reference });
      return { handled: false, event: eventName, reason: 'unknown-reference' };
    }
    const result = await fulfillTransaction(reference, event.data);
    return { handled: true, event: eventName, ...result };
  }

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
    return toSubscriptionView(rows[0], user);
  }

  async function resume({ userId }) {
    const user = await getUser(userId);
    const subscription = await getSubscriptionRow(userId);
    if (!subscription) throw httpError(409, 'There is no subscription to resume.', 'SUBSCRIPTION_NONE');
    if (String(subscription.status) === 'canceled') {
      throw httpError(409, 'That subscription has ended. Choose a plan to start again.', 'SUBSCRIPTION_ENDED');
    }
    const { rows } = await pool.query(
      'UPDATE subscriptions SET cancel_at_period_end=FALSE,canceled_at=NULL,updated_at=NOW() WHERE user_id=$1 RETURNING *',
      [userId],
    );
    return toSubscriptionView(rows[0], user);
  }

  /** Downgrades subscriptions whose paid period has ended. Safe to run repeatedly. */
  async function expireDueSubscriptions() {
    const { rows } = await pool.query(
      `SELECT user_id FROM subscriptions
       WHERE status IN ('active','non_renewing') AND current_period_end IS NOT NULL AND current_period_end <= NOW()`,
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
    subscriptionFor,
    verifyAndFulfill,
    fulfillTransaction,
    handleWebhookEvent,
    cancel,
    resume,
    expireDueSubscriptions,
  });
}
