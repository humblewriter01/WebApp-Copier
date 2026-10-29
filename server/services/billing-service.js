import {
  billingConfig,
  findPlan,
  applyPromoCode,
  buildReference,
  normalizeReference,
  normalizeCurrency,
  isSupportedCurrency,
  planPriceMinor,
  toProviderAmount,
  billingIntervalMs,
  FREE_PLAN,
} from './billing.js';
import { toSafeTransaction, toSafeSubscriptionEvent, toSafeRenewal, payloadHash, checkoutPresentation } from './flutterwave.js';
import { mergePlanPricing, planChargeDecision } from './pricing.js';

/**
 * The billing engine: what a plan costs in the currency a visitor picked, how a charge is raised for it, and
 * what it takes to believe that the charge happened.
 *
 * Three properties hold across the whole file, and they are the reason the code is longer than a fetch:
 *
 *   - the amount a customer pays is the number in the database, converted once, at the provider boundary, into
 *     Flutterwave's major unit. Nothing in a browser, a webhook payload, or a redirect query selects a price;
 *   - a payment is credited to an account only through a reference this server issued, so neither a stranger's
 *     successful Flutterwave transaction nor a forged `charge.completed` can upgrade anyone;
 *   - every provider failure - a refused key, a timeout, a plan that never synced - is a degraded experience
 *     (one-time charge, saved-for-review, a sentence in the log) and never a lost payment or a wrong amount.
 */

function httpError(status, message, code) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function addInterval(from, interval) {
  const ms = billingIntervalMs(interval);
  return new Date(new Date(from).getTime() + ms).toISOString();
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
    /** The currency the last successful payment was made in, so the panel can label an amount correctly. */
    currency: subscription?.currency || null,
    startedWithPromoCode: subscription?.promo_code || null,
  };
}

/* --------------------------------------------------------------------------- events --------------------------------------------------------------------------- */

/**
 * Flutterwave's subscription event names, grouped by what they mean for access.
 *
 * The exact spellings have moved between dashboard versions (`subscribe.cancelled` and `subscribe.disabled`
 * both appear in the wild), and an unmapped event must not cost somebody their plan, so the routing is by these
 * sets rather than a switch on one string. An unknown `subscribe.*` is logged and ignored, which leaves a
 * subscription alone until a human reads the log - the correct outcome when the alternative is guessing.
 */
const RENEWAL_EVENTS = new Set(['subscribe.renewed', 'subscribe.renew', 'subscribe.payment.success']);
const RENEWAL_FAILED_EVENTS = new Set(['subscribe.payment_failed', 'subscribe.failed']);
const SUBSCRIPTION_CANCELED_EVENTS = new Set(['subscribe.cancelled', 'subscribe.canceled', 'subscribe.disabled', 'subscribe.deactivated']);
const SUBSCRIPTION_ACTIVE_EVENTS = new Set(['subscribe.enabled', 'subscribe.activated', 'subscribe.reactivated']);
const SUBSCRIPTION_LINKED_EVENTS = new Set(['subscribe.created', 'subscribe.create']);
/** `charge.completed` is the documented event; `charge.success` is accepted because the docs have used both. */
const CHARGE_EVENTS = new Set(['charge.completed', 'charge.success']);

/** Which currency a stored price should be compared against for a renewal that arrived in an unknown one. */
function currencyForRenewal(renewal, snapshot) {
  const code = String(renewal?.currency || '').toUpperCase();
  if (isSupportedCurrency(code)) return code;
  return normalizeCurrency(snapshot?.currency);
}

/**
 *
 * @typedef {Object} BillingServiceDeps
 * @property {PoolLike} [pool]
 * @property {Record<string, any>} [flutterwave]
 * @property {Record<string, any>} [config]
 * @property {Record<string, any>} [pricing]
 * @property {LoggerMethods} [logger]
 * @property {Function} [now]
 * @property {Function} [random]
 */
/** Rows per page and pages per run, for the expiry sweep: `batchSize * pages` subscriptions in one call. */
const EXPIRY_BATCH_SIZE = 100;
const EXPIRY_BATCH_PAGES = 20;

export function createBillingService(/** @type {BillingServiceDeps} */ {
  pool,
  flutterwave,
  config = billingConfig(),
  pricing = null,
  logger = console,
  now = () => Date.now(),
  random,
} = {}) {
  const log = (level, message, extra = {}) => logger?.[level]?.(message, extra);

  /**
   * Prices come from the `plans` table when the pricing store is available, and from the environment
   * otherwise. A read failure therefore degrades to the deployed default instead of breaking checkout.
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
    // The config is the answer whenever it was built from a real environment; the direct read stays as the
    // fallback for a service constructed with a hand-made config, which is what the tests do.
    const configured = config.callbackBase || String(process.env.CLIENT_URL || '').split(',').map((item) => item.trim()).filter(Boolean)[0];
    return configured ? String(configured).replace(/\/$/, '') : '';
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
      `SELECT id,user_id,plan_key,status,interval,currency,current_period_end,cancel_at_period_end,started_at,canceled_at,
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

  /**
   * The price a customer is about to be shown, in the currency they picked.
   *
   * `currency` is validated rather than defaulted here, because an unsupported code is a bug in the caller or
   * an attack, and "we quietly charged you naira for a dollar price" is the failure this whole layer exists to
   * make impossible.
 *
 * @typedef {Object} QuoteInput
 * @property {string} [planKey]
 * @property {string|null} [promoCode]
 * @property {string|null} [currency]
 * @property {Record<string, any>|null} [snapshot]
 */
async function quote(/** @type {QuoteInput} */ { planKey, promoCode, currency = null, snapshot } = {}) {
    const requested = currency === null || currency === undefined || currency === ''
      ? normalizeCurrency(config.currency)
      : String(currency).trim().toUpperCase();
    if (!isSupportedCurrency(requested)) {
      throw httpError(400, `That currency is not available. Choose ${config.supportedCurrencies.join(' or ')}.`, 'CURRENCY_UNSUPPORTED');
    }
    const effective = snapshot || (await loadSnapshot());
    const plan = planFromSnapshot(effective, planKey);
    if (!plan) throw httpError(400, 'Choose a valid plan.', 'PLAN_INVALID');
    const priceMinor = planPriceMinor(plan, requested);
    if (priceMinor === null) throw httpError(409, `That plan has no ${requested} price yet. Choose another currency or contact support.`, 'PLAN_NOT_PRICED');
    const record = promoCode ? await findPromoCode(promoCode) : null;
    if (promoCode && !record) throw httpError(400, 'That promo code was not found.', 'PROMO_NOT_FOUND');
    const applied = applyPromoCode({ amountMinor: priceMinor, promoCode: record, currency: requested });
    const decision = planChargeDecision({
      plan,
      currency: requested,
      amountMinor: applied.amountMinor,
      recurringEnabled: effective.recurringEnabled,
      hasDiscount: Boolean(applied.promoCode),
    });
    return {
      plan: plan.key,
      planName: plan.name,
      priceSource: plan.sources?.[requested] || plan.source,
      currency: requested,
      interval: plan.interval || config.interval,
      renewsAutomatically: decision.usePlan,
      amountMinor: applied.amountMinor,
      amount: applied.amountMinor / 100,
      /** The number Flutterwave is asked for. Kept in the quote so a test, a log, and a receipt agree on it. */
      providerAmount: toProviderAmount(applied.amountMinor),
      discountMinor: applied.discountMinor,
      promoCode: applied.promoCode,
      limits: plan.limits,
    };
  }

  async function initialize({ userId, planKey, promoCode, currency = null }) {
    if (!flutterwave?.isConfigured?.()) {
      throw httpError(503, 'Payments are not configured for this workspace yet.', 'FLUTTERWAVE_NOT_CONFIGURED');
    }
    const base = callbackBase();
    if (!base) throw httpError(503, 'Payments are temporarily unavailable. Please try again later.', 'FLUTTERWAVE_CALLBACK_MISSING');

    const user = await getUser(userId);
    const snapshot = await loadSnapshot();
    const priced = await quote({ planKey, promoCode, currency, snapshot });
    const plan = planFromSnapshot(snapshot, priced.plan);
    if (priced.amountMinor <= 0) {
      throw httpError(409, 'That promo code covers the full price. Ask an administrator for a direct upgrade.', 'PROMO_FULL_DISCOUNT');
    }

    /**
     * A Flutterwave payment plan makes the provider charge its own amount and repeat it every interval, so the
     * id is only attached when the mirror is confirmed to hold exactly this price in this currency. Everything
     * else is a verified one-time charge - the shape this workspace used before recurring billing existed, and
     * the shape it falls back to the moment a sync is stale.
     */
    const decision = planChargeDecision({
      plan,
      currency: priced.currency,
      amountMinor: priced.amountMinor,
      recurringEnabled: snapshot.recurringEnabled,
      hasDiscount: Boolean(priced.promoCode),
    });
    const planId = decision.usePlan ? decision.planId : null;
    if (!planId && decision.reason !== 'recurring-disabled' && decision.reason !== 'discounted-checkout') {
      log('warn', 'Checkout falling back to a one-time charge', { planKey: priced.plan, currency: priced.currency, reason: decision.reason });
    }

    /* Which country Flutterwave renders and which methods it offers, decided from the currency and from whether
       this charge is bound to a payment plan - and returned to the browser alongside the amount, because the
       inline modal is configured by the browser and the hosted page by this request. If the two ever disagreed,
       a trader could be shown a payment method the server did not intend, which is how a dollar price ends up
       offering a naira bank transfer. */
    const presentation = checkoutPresentation(priced.currency, { planBound: Boolean(planId) });

    const redirectUrl = `${base}/billing/callback`;

    // Reuse a recent pending checkout only when it was raised the same way, so a reused Flutterwave page can
    // never switch between a plan charge and a one-time charge, or between currencies.
    const pending = await pool.query(
      `SELECT reference,authorization_url,amount_minor,currency,COALESCE(plan_code,'') AS plan_code FROM billing_transactions
       WHERE user_id=$1 AND status='pending' AND amount_minor=$2 AND currency=$3 AND COALESCE(plan_code,'')=$4
         AND created_at > NOW() - INTERVAL '2 hours'
       ORDER BY created_at DESC LIMIT 1`,
      [userId, priced.amountMinor, priced.currency, planId === null ? '' : String(planId)],
    );
    const reusable = pending.rows[0];
    if (reusable?.authorization_url) {
      /* Safe to reuse the presentation computed above: the query only returns a row whose currency, amount and
         plan code are identical to this checkout's, so the page being re-presented is the same shape by
         construction. A row that had drifted would have been a new checkout, not a reuse. */
      return {
        reference: reusable.reference,
        link: reusable.authorization_url,
        authorizationUrl: reusable.authorization_url,
        amountMinor: Number(reusable.amount_minor),
        amount: Number(reusable.amount_minor) / 100,
        providerAmount: toProviderAmount(reusable.amount_minor),
        discountMinor: priced.discountMinor,
        currency: reusable.currency,
        country: presentation.country,
        paymentOptions: presentation.paymentOptions,
        plan: priced.plan,
        planName: priced.planName,
        promoCode: priced.promoCode,
        renewsAutomatically: Boolean(reusable.plan_code),
        redirectUrl,
        customer: { email: user.email, name: user.name || null },
        publicKey: config.publicKey || null,
        // Recomputed for the stored reference, which is the one the reused page was opened with.
        payloadHash: payloadHash({ amountMinor: Number(reusable.amount_minor), currency: reusable.currency, email: user.email, txRef: reusable.reference, secretKey: config.secretKey }),
        reused: true,
      };
    }

    const reference = buildReference({ userId, now: now(), random });
    /* The hash covers the reference, so it is computed for the reference that is about to be sent and for no
       other. `payload_hash` is what lets the browser open Flutterwave's own modal with these values: the
       provider recomputes it and refuses the checkout if a field is edited in between. */
    const finalHash = payloadHash({
      amountMinor: priced.amountMinor,
      currency: priced.currency,
      email: user.email,
      txRef: reference,
      secretKey: config.secretKey,
    });
    const transaction = await flutterwave.initializeTransaction({
      email: user.email,
      name: user.name || null,
      amountMinor: priced.amountMinor,
      currency: priced.currency,
      reference,
      redirectUrl,
      planId,
      payloadHashValue: finalHash,
      country: presentation.country,
      paymentOptions: presentation.paymentOptions,
      title: `Signal Desk ${priced.planName}`,
      metadata: {
        user_id: user.id,
        plan: priced.plan,
        flutterwave_plan_id: planId,
        promo_code: priced.promoCode?.code || null,
        interval: priced.interval,
        billing_mode: planId ? 'subscription' : 'one-time',
        /* Minor units, in `currency`: what a webhook is checked against, and deliberately not the number
           Flutterwave was sent, which is the same price in a different unit. */
        expected_amount_minor: priced.amountMinor,
        expected_currency: priced.currency,
      },
    });

    await pool.query(
      `INSERT INTO billing_transactions(user_id,reference,provider,source,plan_key,promo_code_id,promo_code,amount_minor,discount_minor,
         currency,status,authorization_url,plan_code)
       VALUES($1,$2,'flutterwave','checkout',$3,$4,$5,$6,$7,$8,'pending',$9,$10)`,
      [
        userId,
        transaction.reference,
        priced.plan,
        priced.promoCode?.id || null,
        priced.promoCode?.code || null,
        priced.amountMinor,
        priced.discountMinor,
        priced.currency,
        transaction.link,
        planId === null ? null : String(planId),
      ],
    );

    log('info', 'Flutterwave checkout initialized', {
      userId,
      plan: priced.plan,
      currency: priced.currency,
      amountMinor: priced.amountMinor,
      providerAmount: priced.providerAmount,
      billingMode: planId ? 'subscription' : 'one-time',
      country: presentation.country,
      paymentOptions: presentation.paymentOptions,
    });
    return {
      reference: transaction.reference,
      link: transaction.link,
      // Kept as the old name for anything still reading it; both point at the same hosted page.
      authorizationUrl: transaction.link,
      amountMinor: priced.amountMinor,
      amount: priced.amount,
      providerAmount: priced.providerAmount,
      discountMinor: priced.discountMinor,
      currency: priced.currency,
      // What the modal must be configured with, so the browser never re-derives a payment rule of its own.
      country: presentation.country,
      paymentOptions: presentation.paymentOptions,
      plan: priced.plan,
      planName: priced.planName,
      promoCode: priced.promoCode,
      renewsAutomatically: Boolean(planId),
      redirectUrl,
      customer: { email: user.email, name: user.name || null },
      publicKey: config.publicKey || null,
      payloadHash: finalHash,
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
      configured: Boolean(flutterwave?.isConfigured?.()),
      webhookConfigured: Boolean(config.webhookHash),
      interval: config.interval,
      currency: normalizeCurrency(config.currency),
      supportedCurrencies: [...config.supportedCurrencies],
    };
  }

  /**
   * Marks a verified transaction as paid and activates the subscription exactly once. Safe to call from both
   * the browser redirect and the webhook, which is why the row itself is the claim: the update that moves a
   * pending row to `success` is the only thing that grants access, and it can only win once.
   */
  async function fulfillTransaction(reference, providerData) {
    const normalized = normalizeReference(reference);
    if (!normalized) throw httpError(400, 'That payment reference is not valid.', 'REFERENCE_INVALID');
    const safe = toSafeTransaction(providerData || {});

    const { rows } = await pool.query('SELECT * FROM billing_transactions WHERE reference=$1 LIMIT 1', [normalized]);
    const transaction = rows[0];
    if (!transaction) throw httpError(404, 'That payment reference was not found.', 'REFERENCE_NOT_FOUND');

    const expectedMinor = Number(transaction.amount_minor);
    const expectedCurrency = String(transaction.currency || '').toUpperCase();
    if (safe.status === 'success') {
      /* Flutterwave's own verification guidance is "greater than or equal": a customer who overpays has paid
         for the plan, and the right answer is to give them the plan and note the difference, not to strand
         their money in a refused checkout. An underpayment is the opposite case and is refused. */
      if (safe.amountMinor !== null && safe.amountMinor < expectedMinor) {
        log('error', 'Flutterwave amount mismatch', { reference: normalized, expectedMinor, receivedMinor: safe.amountMinor });
        throw httpError(409, 'That payment amount does not match the expected plan price.', 'AMOUNT_MISMATCH');
      }
      if (safe.amountMinor !== null && safe.amountMinor > expectedMinor) {
        log('warn', 'Flutterwave payment exceeded the plan price', { reference: normalized, expectedMinor, receivedMinor: safe.amountMinor, currency: expectedCurrency });
      }
      if (expectedCurrency && safe.currency && safe.currency !== expectedCurrency) {
        log('error', 'Flutterwave currency mismatch', { reference: normalized, expectedCurrency, receivedCurrency: safe.currency });
        throw httpError(409, 'That payment currency does not match the expected currency.', 'CURRENCY_MISMATCH');
      }
    }

    if (safe.status !== 'success') {
      const nextStatus = safe.status === 'failed' ? 'failed' : 'pending';
      if (nextStatus !== 'pending') {
        await pool.query(
          "UPDATE billing_transactions SET status=$2,gateway_response=$3,updated_at=NOW() WHERE reference=$1 AND status='pending'",
          [normalized, nextStatus, safe.gatewayResponse],
        );
      }
      return { fulfilled: false, status: safe.status || 'pending', plan: transaction.plan_key, currency: expectedCurrency };
    }

    if (transaction.status === 'success') {
      return { fulfilled: false, alreadyProcessed: true, status: 'success', plan: transaction.plan_key, currency: expectedCurrency };
    }

    const plan = { key: transaction.plan_key, limits: limitsForPlan(transaction.plan_key) };
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const claimed = await client.query(
        `UPDATE billing_transactions SET status='success',paid_at=COALESCE($2::timestamptz,NOW()),
           gateway_response=$3,channel=$4,provider_reference=$5,updated_at=NOW()
         WHERE reference=$1 AND status<>'success' RETURNING id`,
        [normalized, safe.paidAt || null, safe.gatewayResponse, safe.channel, safe.providerReference],
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
        `INSERT INTO subscriptions(user_id,plan_key,status,interval,currency,current_period_end,cancel_at_period_end,started_at,canceled_at,
           provider,provider_reference,promo_code,updated_at)
         VALUES($1,$2,'active',$3,$4,$5,FALSE,NOW(),NULL,'flutterwave',$6,$7,NOW())
         ON CONFLICT(user_id) DO UPDATE SET plan_key=EXCLUDED.plan_key,status='active',interval=EXCLUDED.interval,
           currency=EXCLUDED.currency,current_period_end=EXCLUDED.current_period_end,cancel_at_period_end=FALSE,
           started_at=COALESCE(subscriptions.started_at,NOW()),canceled_at=NULL,provider='flutterwave',
           provider_reference=EXCLUDED.provider_reference,promo_code=COALESCE(EXCLUDED.promo_code,subscriptions.promo_code),
           updated_at=NOW()`,
        [user.id, transaction.plan_key, config.interval, expectedCurrency, periodEnd, normalized, transaction.promo_code],
      );
      if (transaction.promo_code_id) {
        await client.query('UPDATE promo_codes SET current_uses=current_uses+1,updated_at=NOW() WHERE id=$1', [transaction.promo_code_id]);
      }
      await client.query('COMMIT');
      log('info', 'Subscription activated', {
        userId: user.id,
        plan: transaction.plan_key,
        currency: expectedCurrency,
        amountMinor: expectedMinor,
        reference: normalized,
      });
      return { fulfilled: true, status: 'success', plan: transaction.plan_key, currency: expectedCurrency, currentPeriodEnd: periodEnd };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Verifies with Flutterwave first, then fulfils. Used by the browser redirect and by the modal callback.
   *
   * The reference is the only thing the browser contributes, and it is looked up against this workspace's own
   * `billing_transactions` row before the provider is asked - so a customer cannot hand in somebody else's
   * successful transaction, and `transaction_id` from the redirect query is never trusted for anything.
   */
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

    const providerData = await flutterwave.verifyTransaction(normalized);
    await fulfillTransaction(normalized, providerData);
    return { ...(await subscriptionFor(userId)), reference: normalized };
  }

  /**
   * Recurring billing arrives as `subscribe.*` events rather than as a checkout we started, so their payloads
   * are read through the helpers in `flutterwave.js`. Everything is keyed on the customer email Flutterwave
   * holds (a Flutterwave subscription is tied to an email and cannot be moved), and any event that cannot be
   * mapped to an account is ignored instead of changing somebody's access.
   */
  async function fulfillRenewal(renewal) {
    if (!renewal?.renewalKey) return { handled: false, reason: 'invalid-renewal-reference' };
    if (renewal.amountMinor === null) return { handled: false, reason: 'unknown-amount' };
    const userId = await findUserIdByEmail(renewal.email);
    if (!userId) return { handled: false, reason: 'unmapped-customer' };

    const { rows } = await pool.query(
      'SELECT id,plan_key,status,interval,currency,current_period_end FROM subscriptions WHERE user_id=$1 LIMIT 1',
      [userId],
    );
    const subscription = rows[0];
    if (!subscription) return { handled: false, reason: 'no-subscription' };

    const snapshot = await loadSnapshot();
    const currency = currencyForRenewal(renewal, snapshot);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // The renewal key is unique per cycle, so replaying the same notification is a no-op.
      const inserted = await client.query(
        `INSERT INTO billing_transactions(user_id,reference,provider,source,plan_key,amount_minor,currency,status,paid_at,plan_code,provider_reference)
         VALUES($1,$2,'flutterwave','renewal',$3,$4,$5,'success',COALESCE($6::timestamptz,NOW()),$7,$8)
         ON CONFLICT(reference) DO NOTHING RETURNING id`,
        [
          userId,
          renewal.renewalKey,
          subscription.plan_key,
          renewal.amountMinor,
          currency,
          renewal.paidAt || null,
          renewal.planId === null ? null : String(renewal.planId),
          renewal.subscriptionId === null ? null : `flw_sub_${renewal.subscriptionId}`,
        ],
      );
      if (!inserted.rowCount) {
        await client.query('COMMIT');
        return { handled: true, fulfilled: false, alreadyProcessed: true, kind: 'renewal', plan: subscription.plan_key, currency };
      }

      const from = subscription.current_period_end && new Date(subscription.current_period_end).getTime() > now()
        ? subscription.current_period_end
        : new Date(now()).toISOString();
      const periodEnd = addInterval(from, subscription.interval || renewal.interval || config.interval);
      await client.query(
        "UPDATE users SET subscription_status='active',subscription_plan=$2,plan_limits=$3 WHERE id=$1",
        [userId, subscription.plan_key, JSON.stringify(limitsForPlan(subscription.plan_key))],
      );
      await client.query(
        `UPDATE subscriptions SET status='active',cancel_at_period_end=FALSE,canceled_at=NULL,currency=$2,current_period_end=$3,updated_at=NOW()
         WHERE id=$1`,
        [subscription.id, currency, periodEnd],
      );
      await client.query('COMMIT');

      const expectedMinor = planPriceMinor(planFromSnapshot(snapshot, subscription.plan_key), currency);
      if (expectedMinor !== null && Number(renewal.amountMinor) < Number(expectedMinor)) {
        log('warn', 'Renewal amount is below the current plan price', {
          userId, plan: subscription.plan_key, currency, paid: renewal.amountMinor, expectedMinor, renewal: renewal.renewalKey,
        });
      }
      log('info', 'Subscription renewed', {
        userId, plan: subscription.plan_key, currency, amountMinor: renewal.amountMinor, renewal: renewal.renewalKey, currentPeriodEnd: periodEnd,
      });
      return { handled: true, fulfilled: true, kind: 'renewal', plan: subscription.plan_key, currency, currentPeriodEnd: periodEnd, subscriptionId: renewal.subscriptionId };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async function currentPlanPriceMinor(planKey, currency = null) {
    const snapshot = await loadSnapshot();
    return planPriceMinor(planFromSnapshot(snapshot, planKey), currency || config.currency);
  }

/**
 *
 * @typedef {Object} UpdateSubscriptionForEventInput
 * a webhook or a verification, already reduced to the two things the writer needs: what the provider said, and how to apply it inside one transaction
 * @property {Record<string, any>} [data]
 * @property {({ subscription }: any) => Promise<any>} [apply]
 * @property {string|null} [reason]
 */
  async function updateSubscriptionForEvent(/** @type {UpdateSubscriptionForEventInput} */ { data, apply, reason }) {
    const email = data?.email || data?.customer?.email || null;
    const userId = await findUserIdByEmail(email);
    if (!userId) return { handled: false, reason: reason || 'unmapped-customer' };
    const { rows } = await pool.query('SELECT id,user_id AS "userId",current_period_end FROM subscriptions WHERE user_id=$1 LIMIT 1', [userId]);
    const subscription = rows[0];
    if (!subscription) return { handled: false, reason: 'no-subscription' };
    const result = await apply({ userId, subscription, data });
    return { handled: true, ...result };
  }

  /** Stores the Flutterwave subscription id so cancel and resume can use it. */
  async function rememberProviderSubscription(event) {
    const id = event.subscriptionId;
    if (id === null || id === undefined) return { handled: false, reason: 'no-subscription-id' };
    return updateSubscriptionForEvent({
      data: event,
      apply: async ({ subscription }) => {
        await pool.query(
          "UPDATE subscriptions SET provider_subscription_code=$2,provider='flutterwave',updated_at=NOW() WHERE id=$1 AND COALESCE(provider_subscription_code,'')<>$2",
          [subscription.id, String(id)],
        );
        return { kind: 'provider-code', subscriptionId: id };
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
        await pool.query("UPDATE users SET subscription_status='non_renewing' WHERE id=$1 AND subscription_status='active'", [subscription.userId ?? null]);
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
      apply: async ({ subscription, userId }) => {
        await pool.query("UPDATE subscriptions SET status='past_due',updated_at=NOW() WHERE id=$1 AND status IN ('active','non_renewing')", [subscription.id]);
        await pool.query("UPDATE users SET subscription_status='past_due' WHERE id=$1 AND subscription_status IN ('active','non_renewing')", [userId ?? null]);
        return { kind: 'past_due' };
      },
    });
  }

  async function markRenewalEnabled(event) {
    return updateSubscriptionForEvent({
      data: event,
      apply: async ({ subscription, userId }) => {
        await pool.query(
          "UPDATE subscriptions SET status='active',cancel_at_period_end=FALSE,canceled_at=NULL,updated_at=NOW() WHERE id=$1",
          [subscription.id],
        );
        await pool.query("UPDATE users SET subscription_status='active' WHERE id=$1 AND subscription_status IN ('non_renewing','past_due')", [userId ?? null]);
        return { kind: 'active' };
      },
    });
  }

  /** Webhook entry point. Charges we started resolve by reference; renewals by the customer on the plan. */
  async function handleWebhookEvent(event) {
    const eventName = String(event?.event || '');
    const data = event?.data || {};

    if (CHARGE_EVENTS.has(eventName)) {
      const reference = normalizeReference(data.tx_ref ?? data.reference);
      if (!reference) return { handled: false, event: eventName, reason: 'invalid-reference' };
      const { rows } = await pool.query('SELECT user_id FROM billing_transactions WHERE reference=$1 LIMIT 1', [reference]);
      if (!rows[0]) {
        log('warn', 'Flutterwave webhook for an unknown reference', { reference });
        return { handled: false, event: eventName, reason: 'unknown-reference' };
      }
      const result = await fulfillTransaction(reference, data);
      return { handled: true, event: eventName, ...result };
    }

    if (RENEWAL_EVENTS.has(eventName)) {
      const renewal = toSafeRenewal(data);
      const linked = renewal.subscriptionId ? await rememberProviderSubscription({ ...data, email: renewal.email, subscriptionId: renewal.subscriptionId }) : { handled: false };
      const result = await fulfillRenewal(renewal);
      return { handled: Boolean(result.handled), event: eventName, providerCodeLinked: Boolean(linked.handled), ...result };
    }

    const subscriptionEvent = toSafeSubscriptionEvent(data);
    if (SUBSCRIPTION_LINKED_EVENTS.has(eventName)) {
      // A created subscription carries the id nothing else tells us, and no payment of its own to record.
      const stored = await rememberProviderSubscription({ ...data, email: subscriptionEvent.email, subscriptionId: subscriptionEvent.subscriptionId });
      return { handled: Boolean(stored.handled), event: eventName, ...stored };
    }
    if (RENEWAL_FAILED_EVENTS.has(eventName)) {
      const result = await markPaymentFailed({ ...data, email: subscriptionEvent.email });
      return { handled: Boolean(result.handled), event: eventName, ...result };
    }
    if (SUBSCRIPTION_CANCELED_EVENTS.has(eventName)) {
      const result = await markProviderCanceled({ ...data, email: subscriptionEvent.email });
      return { handled: Boolean(result.handled), event: eventName, ...result };
    }
    if (SUBSCRIPTION_ACTIVE_EVENTS.has(eventName)) {
      const result = await markRenewalEnabled({ ...data, email: subscriptionEvent.email });
      return { handled: Boolean(result.handled), event: eventName, ...result };
    }
    if (eventName.startsWith('subscribe.')) {
      log('info', 'Ignoring an unmapped Flutterwave subscription event', { event: eventName, subscriptionId: subscriptionEvent.subscriptionId ?? null });
    }
    return { handled: false, event: eventName };
  }

  /**
   * Cancelling keeps the paid period, but a Flutterwave-backed subscription must also be cancelled at the
   * provider or the customer is charged again. A provider failure is reported rather than blocking the local
   * change, matching how the rest of the workspace treats third-party cleanup: a customer who cannot be
   * unmade a member by an API that is down is still protected by the expiry sweep.
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
    const provider = await cancelAtProvider({ id: subscription.provider_subscription_code });
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
    const provider = await activateAtProvider({ id: subscription.provider_subscription_code });
    return { ...toSubscriptionView(rows[0], user), provider };
  }

  async function cancelAtProvider({ id }) {
    if (!id) {
      return { status: 'local-only', message: 'No Flutterwave subscription is linked to this account yet, so only renewals in Signal Desk were stopped.' };
    }
    if (!flutterwave?.isConfigured?.()) {
      return { status: 'not_configured', message: 'Flutterwave is not configured, so renewal was stopped only in Signal Desk.' };
    }
    try {
      const result = await flutterwave.cancelSubscription(id);
      return { status: 'cancelled', subscriptionId: id, message: result?.message || 'Flutterwave will not bill this subscription again.' };
    } catch (error) {
      log('error', 'Flutterwave subscription could not be cancelled', { id, errorCode: error.code || 'SUBSCRIPTION_CANCEL_FAILED' });
      return {
        status: 'failed',
        subscriptionId: id,
        message: `${error.userMessage || 'Flutterwave could not be reached.'} You may still be charged next cycle, so try cancelling again.`,
      };
    }
  }

  async function activateAtProvider({ id }) {
    if (!id) {
      return { status: 'local-only', message: 'Renewals resume in Signal Desk. Flutterwave will charge you again only if a subscription is linked to this account.' };
    }
    if (!flutterwave?.isConfigured?.()) {
      return { status: 'not_configured', message: 'Flutterwave is not configured, so renewal was resumed only in Signal Desk.' };
    }
    try {
      /* Unlike Paystack, restarting needs only the subscription id - no email token and no authorization code -
         which is one less thing for a support conversation to be missing. */
      const result = await flutterwave.activateSubscription(id);
      return { status: 'activated', subscriptionId: id, message: result?.message || 'Flutterwave will bill this subscription again each period.' };
    } catch (error) {
      log('error', 'Flutterwave subscription could not be reactivated', { id, errorCode: error.code || 'SUBSCRIPTION_ACTIVATE_FAILED' });
      return {
        status: 'failed',
        subscriptionId: id,
        message: `${error.userMessage || 'Flutterwave could not be reached.'} Your plan stays active until the period ends; contact support to restart billing.`,
      };
    }
  }

  /**
   * Downgrades subscriptions whose paid period has ended. Safe to run repeatedly.
   *
   * Batched, and the batching is the fix rather than a tuning knob. The listing query was cross-tenant with no
   * bound of any kind - `SELECT s.user_id FROM subscriptions … WHERE current_period_end <= NOW()` - so its memory
   * was "everyone whose billing has lapsed", materialised in one pass, once an hour, on a 512 MB container that is
   * also holding every Telegram session. `LIMIT` plus a keyset cursor on the user id means one batch in memory at a
   * time, and the cursor is why a batch that *fails* cannot wedge the sweep: the next page starts after the last id
   * we looked at whether or not its rows changed underneath us, so progress does not depend on the UPDATE landing.
   */
  async function expireDueSubscriptions() {
    const expired = [];
    let afterId = '';
    let pages = 0;
    let sawMore = false;
    for (; pages < EXPIRY_BATCH_PAGES; pages += 1) {
      const { rows } = await pool.query(
        `SELECT s.user_id FROM subscriptions s JOIN users u ON u.id=s.user_id
         WHERE s.current_period_end IS NOT NULL AND s.current_period_end <= NOW()
           AND (s.status IN ('active','non_renewing','past_due') OR u.subscription_status IN ('active','non_renewing','past_due'))
           AND s.user_id::text > $1
         GROUP BY s.user_id ORDER BY s.user_id::text LIMIT $2`,
        [afterId, EXPIRY_BATCH_SIZE + 1],
      );
      /* One row more than the batch is asked for, so a page that comes back exactly full is the only page that
         needs a successor - which is a fact about the result rather than a second query. The short-page exit
         belongs *after* the batch has been worked through; written before it, the sweep skipped the only page of
         rows on every run smaller than the batch, which is to say on every run the product actually does. The
         test fake is what caught it: a fake answers a query without reading its parameters, so it hands the same
         two rows back on every page, and a loop that exits only on "no rows" would spend all twenty pages on one
         account whose downgrade had already thrown. */
      sawMore = rows.length > EXPIRY_BATCH_SIZE;
      const batch = rows.slice(0, EXPIRY_BATCH_SIZE);
      afterId = String(batch[batch.length - 1]?.user_id ?? afterId);
      for (const row of batch) {
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
      if (!sawMore) break;
    }
    if (expired.length) log('info', 'Expired subscriptions downgraded', { count: expired.length, pages: pages + 1 });
    /* Not a failure and not a completion either: the sweep stopped at its page bound with rows still matching, so
       the rest wait for the next hour. Saying so is the difference between a queue that drains slowly and a queue
       nobody knows exists - and the bound stays, because an unbounded drain loop on an hourly timer is how a
       long database outage turns into a permanently busy process. */
    if (sawMore) log('warn', 'Subscription expiry sweep stopped at its batch bound with work remaining', { pages, batchSize: EXPIRY_BATCH_SIZE, deferred: true });
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
