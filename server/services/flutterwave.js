import crypto from 'node:crypto';

/**
 * Flutterwave v3 client: the three calls this workspace makes, and nothing else.
 *
 * Collections:      POST /v3/payments                          (hosted checkout link)
 * Verification:     GET  /v3/transactions/verify_by_reference  (by the reference we generated)
 * Payment plans:    POST /v3/payment-plans, GET|PUT /v3/payment-plans/:id   (recurring mirror)
 * Subscriptions:    GET  /v3/subscriptions/:id, PUT /v3/subscriptions/:id/cancel|activate
 *
 * The secret key never leaves this process, every reply is reduced to the fields we persist, and provider
 * failures are re-thrown with a `userMessage` that is safe to show a browser.
 *
 * ------------------------------------------------------------------ why this file is hand-written
 *
 * `flutterwave-node-v3@1.4.1` was installed and read before this was written, and two findings decided it:
 *
 * 1. It has no `Transaction.initialize`. `lib/rave.transactions.js` exposes event, fee, refund, resend_hooks,
 *    fetch, verify and verify_by_tx - that is all. The call this workspace needs (`POST /v3/payments`, the
 *    endpoint that returns the hosted link) is not in the SDK, and the SDK offers no generic request method
 *    (`services/rave.custom.request.js` is commented out, along with the `CustomRequest` wiring in index.js).
 * 2. Every call is instrumented. Constructing the client fires `telemetry.init(publicKey)`, which resolves the
 *    merchant name from `api.ravepay.co` and POSTs to a SigNoz ingestion host, and `logRequest` is awaited
 *    inside `RaveBase.request` before the payment call is made. Its `_post` has no timeout. A checkout that
 *    waits on somebody else's analytics endpoint - and fails slowly when that endpoint is unreachable - is a
 *    checkout that fails, so the payment path gets its own two-fetch implementation with a hard
 *    `AbortSignal.timeout`, which is also what makes every call here mockable in tests.
 *
 * `flutterwave-react-v3@1.3.3` was rejected for the same class of reason: after a successful payment its
 * callback POSTs your public key to `cors-anywhere.herokuapp.com` and on to the package author's own AWS
 * endpoint. `client/src/lib/flutterwave.js` implements the same `useFlutterwave` shape without the trip.
 *
 * Both packages can be adopted later without touching a call site: this file and that one are the only two
 * places in the workspace that know Flutterwave exists.
 */

const REQUEST_TIMEOUT_MS = 20_000;
const DEFAULT_BASE_URL = 'https://api.flutterwave.com';

/** Currency the workspace charges by default, and the two it can offer. */
export const SUPPORTED_CURRENCIES = Object.freeze(['NGN', 'USD']);
export const DEFAULT_CURRENCY = 'NGN';

/** Flutterwave's own intervals. `annually`/`biannually` are Paystack words we still accept from the env. */
export const INTERVAL_MAP = Object.freeze({
  hourly: 'hourly',
  daily: 'daily',
  weekly: 'weekly',
  monthly: 'monthly',
  quarterly: 'quarterly',
  biannually: 'bi-annually',
  'bi-annually': 'bi-annually',
  annually: 'yearly',
  yearly: 'yearly',
});

/**
 * How a checkout is *presented*, per currency - which country the provider renders and which rails it offers.
 *
 * Flutterwave decides what a payer sees from the country it believes the payment is happening in, and when a
 * request says nothing it infers that from the payer's IP. A trader in Lagos paying a dollar price is therefore
 * shown the Nigerian page: bank transfer, ussd, and a naira amount field, none of which can settle a card
 * charge in USD. The currency in the request was correct; the page was still wrong, which is the whole reason
 * these two fields exist rather than being left to inference.
 *
 * They are keyed on the currency, because the currency is the only thing that decides which methods can settle
 * at all: naira has local rails, dollars have cards. `card` on its own is not a limitation to work around - it
 * is what makes "Pay with USD" a possible action on the page instead of a price you cannot pay.
 */
export const CURRENCY_CHECKOUT_PRESENTATION = Object.freeze({
  NGN: Object.freeze({ country: 'NG', paymentOptions: 'card,banktransfer,ussd' }),
  USD: Object.freeze({ country: 'US', paymentOptions: 'card' }),
});

/** A plan-bound charge is settled by the provider, by card, every interval - so the local rails are not offered. */
export const PLAN_BOUND_PAYMENT_OPTIONS = 'card';

/**
 * The two fields for a currency, with the plan-bound exception already applied.
 *
 * A currency this workspace has no rule for sends neither field: it is better for the provider to render what
 * it thinks is right for an unexpected currency than to be told a country that does not charge in it.
 */
export function checkoutPresentation(currency, { planBound = false } = {}) {
  const rule = CURRENCY_CHECKOUT_PRESENTATION[String(currency || '').toUpperCase().trim()] || null;
  return Object.freeze({
    country: rule ? rule.country : null,
    paymentOptions: planBound ? PLAN_BOUND_PAYMENT_OPTIONS : (rule ? rule.paymentOptions : null),
  });
}

function networkError(cause) {
  const error = new Error('Flutterwave could not be reached. Please try again shortly.');
  error.status = 502;
  error.code = 'FLUTTERWAVE_NETWORK_ERROR';
  error.userMessage = `The payment provider could not be reached${cause?.code ? ` (${cause.code})` : ''}. No payment was taken.`;
  return error;
}

function providerError(status, payload) {
  const message = typeof payload?.message === 'string' && payload.message.trim()
    ? payload.message.trim().slice(0, 300)
    : '';
  const error = new Error(message || 'Flutterwave rejected the payment request.');
  error.status = status === 401 || status === 403 ? 503 : status === 429 ? 503 : 502;
  error.code = 'FLUTTERWAVE_PROVIDER_ERROR';
  error.flutterwaveStatus = status;
  error.userMessage = status === 401 || status === 403
    ? 'Payments are temporarily unavailable because the payment provider rejected the workspace credentials. No payment was taken.'
    : status === 429
      ? 'Too many payment attempts were made. Wait a moment, then try again.'
      : `The payment provider rejected the request${message ? `: ${message}` : ''}. No payment was taken.`;
  return error;
}

/* ------------------------------------------------------------------------ money ------------------------------------------------------------------- */

/**
 * The number Flutterwave is charged, in the currency's *major* unit.
 *
 * This is the conversion that decides whether a customer pays the right amount: Paystack was fed kobo (x100),
 * Flutterwave is fed naira and dollars. Prices are stored in minor units everywhere in this workspace -
 * `billing_transactions.amount_minor`, the `plans` columns, the promo arithmetic - and the divisor happens at
 * the single moment the provider is spoke to, then never again.
 */
export function toMajorAmount(amountMinor) {
  const parsed = Number(amountMinor);
  if (!Number.isFinite(parsed)) return null;
  const major = Math.round(parsed) / 100;
  return major > 0 ? Math.round(major * 100) / 100 : null;
}

/** The exact string form the provider will hash, so the payload hash cannot disagree with the amount sent. */
export function amountString(amountMinor) {
  const major = toMajorAmount(amountMinor);
  return major === null ? '' : String(major);
}

/**
 * Flutterwave's checksum for a checkout (`payload_hash`, not the legacy `integrity_hash`).
 *
 * The order is the documented one and is not negotiable: `amount`, `currency`, `customer_email`, `tx_ref`,
 * then a sha256 of the secret key - concatenated with no separators, then hashed again. Its job is to let the
 * browser open the payment modal with values the browser did not choose: Flutterwave recomputes the hash from
 * whatever arrives and refuses the checkout when a field has been edited. So the server computes it from the
 * price in the database, never from the request body.
 */
export function payloadHash({ amountMinor, currency, email, txRef, secretKey }) {
  if (!secretKey) return null;
  const amount = amountString(amountMinor);
  if (!amount || !currency || !email || !txRef) return null;
  const hashedSecret = crypto.createHash('sha256').update(String(secretKey), 'utf8').digest('hex');
  const joined = `${amount}${String(currency).toUpperCase()}${String(email)}${txRef}${hashedSecret}`;
  return crypto.createHash('sha256').update(joined, 'utf8').digest('hex');
}

/* -------------------------------------------------------------------- webhook hashing ----------------------------------------------------------------- */

/**
 * Compares the `verif-hash` header with the secret hash set in the Flutterwave dashboard.
 *
 * There is no HMAC in this protocol and no body signature to verify - Flutterwave's documented check is that
 * the header is present and equal to the value we chose, and that anything else is discarded. Length is
 * compared before `timingSafeEqual` because that function throws on a length mismatch, which would turn a
 * garbage request into a 500. An unset hash refuses everything rather than accepting everything: a workspace
 * that has not finished configuring must not be able to hand out plans to whoever knocks.
 */
/**
 * @typedef {Object} VerifyWebhookHashInput
 * @property {any} [header] - the `verif-hash` header exactly as it arrived: anything that is not a string has to
 *   be refused rather than coerced into a comparison, which is why the value is not typed as a string here
 * @property {any} [expectedHash] - the secret this deployment chose in the dashboard
 */
export function verifyWebhookHash(/** @type {VerifyWebhookHashInput} */ { header, expectedHash } = {}) {
  const expected = String(expectedHash || '').trim();
  const provided = String(header ?? '').trim();
  if (!expected || !provided || provided.length !== expected.length) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* ----------------------------------------------------------------------- payload shapes ---------------------------------------------------------------------- */

/** A successful Flutterwave status. The API says `successful`; the older docs said `success`, so both are read. */
const PAID_STATUSES = new Set(['successful', 'success']);
const FAILED_STATUSES = new Set(['failed', 'cancelled', 'canceled', 'reversed', 'duplicate', 'invalid']);

/** Maps a Flutterwave transaction to the fields we persist. Card data is deliberately not read. */
export function toSafeTransaction(data = {}) {
  const status = String(data.status || '').toLowerCase();
  const paid = PAID_STATUSES.has(status);
  return {
    reference: String(data.tx_ref || data.reference || ''),
    transactionId: Number.isFinite(Number(data.id)) ? Number(data.id) : null,
    providerReference: data.flw_ref ? String(data.flw_ref).slice(0, 80) : null,
    status: paid ? 'success' : FAILED_STATUSES.has(status) ? 'failed' : 'pending',
    providerStatus: status || null,
    /** Always minor units, whatever the provider's unit was, so `amount_minor` means one thing in this schema. */
    amountMinor: Number.isFinite(Number(data.amount)) ? Math.round(Number(data.amount) * 100) : null,
    chargedAmountMinor: Number.isFinite(Number(data.charged_amount)) ? Math.round(Number(data.charged_amount) * 100) : null,
    currency: String(data.currency || '').toUpperCase(),
    channel: data.payment_type ? String(data.payment_type).slice(0, 40) : null,
    gatewayResponse: data.processor_response ? String(data.processor_response).slice(0, 200) : null,
    paidAt: data.created_at || null,
    planId: data.plan?.id ? Number(data.plan.id) : (data.plan_id ? Number(data.plan_id) : null),
  };
}

export function eventCustomerEmail(data = {}) {
  const email = data?.customer?.email || data?.email || data?.transaction?.customer?.email || '';
  const value = String(email).trim().toLowerCase();
  return value && value.includes('@') ? value.slice(0, 200) : null;
}

/** A `subscribe.*` payload, which is the only place a renewal tells us anything. */
export function toSafeSubscriptionEvent(data = {}) {
  const status = String(data.status || '').toLowerCase();
  const amount = Number(data.amount ?? data.charged_amount);
  return {
    subscriptionId: Number.isFinite(Number(data.id)) ? Number(data.id) : (Number.isFinite(Number(data.subscription_id)) ? Number(data.subscription_id) : null),
    subscriptionCode: data.subscription_reference ? String(data.subscription_reference).slice(0, 80) : null,
    reference: data.tx_ref ? String(data.tx_ref) : (data.reference ? String(data.reference) : null),
    status: status || null,
    paid: PAID_STATUSES.has(status) || data.status === 'renewed' || data.status === 'active',
    /** Minor units, or null when the payload did not carry an amount we can trust. */
    amountMinor: Number.isFinite(amount) ? Math.round(amount * 100) : null,
    currency: String(data.currency || data.plan?.currency || '').toUpperCase() || null,
    email: eventCustomerEmail(data),
    planId: data.plan?.id ? Number(data.plan.id) : (data.plan_id ? Number(data.plan_id) : null),
    paidAt: data.created_at || null,
  };
}

export function toSafePlan(data) {
  if (!data || typeof data !== 'object') return null;
  return {
    planId: Number.isFinite(Number(data.id)) ? Number(data.id) : null,
    planToken: data.plan_token ? String(data.plan_token).slice(0, 60) : null,
    name: data.name ? String(data.name).slice(0, 120) : null,
    /** Flutterwave reports a plan amount in major units; everything downstream is minor. */
    amountMinor: Number.isFinite(Number(data.amount)) ? Math.round(Number(data.amount) * 100) : null,
    interval: data.interval ? String(data.interval).toLowerCase() : null,
    duration: Number.isFinite(Number(data.duration)) ? Number(data.duration) : null,
    currency: data.currency ? String(data.currency).toUpperCase() : null,
    status: data.status ? String(data.status).toLowerCase() : null,
  };
}

export function toSafeSubscription(data) {
  if (!data || typeof data !== 'object') return null;
  return {
    subscriptionId: Number.isFinite(Number(data.id)) ? Number(data.id) : null,
    status: data.status ? String(data.status).toLowerCase() : null,
    amountMinor: Number.isFinite(Number(data.amount)) ? Math.round(Number(data.amount) * 100) : null,
    currency: data.currency ? String(data.currency).toUpperCase() : null,
    nextPaymentDate: data.next_payed || data.next_payment_date || null,
    planId: data.plan_id ?? data.plan?.id ?? null,
    customerEmail: data.email ? String(data.email) : null,
  };
}

/**
 * A `subscribe.renewed` payload, reduced to what extending somebody's access needs.
 *
 * A renewal is not a checkout we started: Flutterwave charges the saved card on its own schedule and the only
 * record of that cycle is this event, whose `tx_ref` we do not control. So the extension is keyed on the
 * subscription id and the date it belongs to, which makes a retry of the same notification land on the same row
 * instead of quietly granting a second month. `next_due_date` is the field the dashboard shows, and
 * `created_at` is the fallback for a plan that has no next date yet.
 */
export function toSafeRenewal(data = {}) {
  const subscriptionId = Number.isFinite(Number(data.id)) ? Number(data.id) : (Number.isFinite(Number(data.subscription_id)) ? Number(data.subscription_id) : null);
  const amount = Number(data.amount ?? data.charged_amount);
  const stamp = String(data.next_due_date || data.created_at || '').slice(0, 10);
  const day = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(stamp) ? stamp.replaceAll('-', '') : null;
  const candidate = subscriptionId !== null && day ? `sdb_flwsub_${subscriptionId}_${day}` : (data.tx_ref ? String(data.tx_ref) : null);
  return {
    subscriptionId,
    renewalKey: candidate && candidate.length <= 120 ? candidate : null,
    email: eventCustomerEmail(data),
    /** Minor units of the plan currency, so it is comparable with `plans.price_*_minor`. */
    amountMinor: Number.isFinite(amount) ? Math.round(amount * 100) : null,
    currency: String(data.currency || data.plan?.currency || '').toUpperCase() || null,
    interval: data.plan?.interval ? String(data.plan.interval).toLowerCase() : null,
    planId: data.plan?.id ? Number(data.plan.id) : (data.plan_id ? Number(data.plan_id) : null),
    paidAt: data.created_at || null,
  };
}

/**
 * Only a Flutterwave checkout page may be where a customer types a card number.
 *
 * The link comes back from the provider, and a response that pointed elsewhere would send a customer's card
 * details to whoever controls that host - so the hostname is checked the same way Paystack's was.
 */
function safeCheckoutLink(link) {
  const value = String(link || '').trim();
  if (!value) return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== 'https:') return null;
  return /(^|\.)flutterwave\.com$/i.test(url.hostname) ? url.href : null;
}

/** True when Flutterwave answered "not found" - e.g. a plan id that no longer exists on the account. */
export function isProviderNotFound(error) {
  // The status is authoritative when we have it. The message patterns are for the answers that arrive without
  // one - Flutterwave's own wording is "No plan was found for this id", which is not the phrase above.
  return Number(error?.flutterwaveStatus) === 404
    || /not found|does not exist|no [a-z ]{0,20}(was )?found/i.test(String(error?.message || ''));
}

/* ------------------------------------------------------------------------- the client ------------------------------------------------------------------------
 */
/**
 * The client's two seams: the settings it reads and the function it sends with.
 *
 * @typedef {Object} FlutterwaveClientDeps
 * @property {Record<string, any>} [config] - the resolved provider settings; absent means every call answers "not configured", which is the shape a test and a misconfigured deploy both arrive at
 * @property {(input: any, init?: any) => Promise<any>} [fetchImpl] - injected so a test can answer without a network
 */
export function createFlutterwaveClient(/** @type {FlutterwaveClientDeps} */ { config, fetchImpl } = {}) {
  const settings = config || {};
  const doFetch = fetchImpl || globalThis.fetch;
  const base = String(settings.baseUrl || DEFAULT_BASE_URL).trim().replace(/\/+$/, '');
  const baseUrl = /\/v3$/.test(base) ? base : `${base}/v3`;

  function ensureConfigured() {
    if (!settings.secretKey) {
      const error = new Error('Payments are not configured for this workspace yet.');
      error.status = 503;
      error.code = 'FLUTTERWAVE_NOT_CONFIGURED';
      error.userMessage = 'Payments are temporarily unavailable. Please try again later.';
      throw error;
    }
  }

/**
 *
 * @typedef {Object} CallInput
 * @property {string} [method]
 * @property {Record<string, any>|null} [body]
 */
  async function call(path, /** @type {CallInput} */ { method = 'GET', body } = {}) {
    ensureConfigured();
    let response;
    try {
      response = await doFetch(`${baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${settings.secretKey}`,
          Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (cause) {
      throw networkError(cause);
    }
    let payload = null;
    try { payload = await response.json(); } catch { payload = null; }
    /* Flutterwave answers 200 with `status:"error"` for a rejected payload, so the envelope is checked too:
       a body that says "Invalid amount" must never be read as a transaction that happened. */
    if (!response.ok || payload?.status === 'error') throw providerError(response.status, payload);
    return payload;
  }

  /**
   * Creates the charge and returns the hosted link.
   *
   * `amount` is the major unit - the whole reason this migration is careful about units - and the reference is
   * ours, which is what makes verification immune to anything the browser sends back.
   */
  async function initializeTransaction({ email, name, amountMinor, currency, reference, redirectUrl, planId, metadata, payloadHashValue, paymentOptions, country, title }) {
    const amount = amountString(amountMinor);
    if (!amount) {
      const error = new Error('The amount to charge could not be determined.');
      error.status = 500;
      error.code = 'FLUTTERWAVE_AMOUNT_INVALID';
      error.userMessage = 'The price for this plan could not be read. No payment was taken.';
      throw error;
    }
    const body = {
      tx_ref: reference,
      amount,
      currency: String(currency || DEFAULT_CURRENCY).toUpperCase(),
      redirect_url: redirectUrl,
      customer: { email, ...(name ? { name: String(name).slice(0, 80) } : {}) },
      customizations: { title: String(title || 'Signal Desk subscription').slice(0, 80) },
    };
    /* What the payer is shown, decided here rather than inferred from their IP. A caller that already worked the
       rule out (the billing service does, because its response has to carry the same values to the browser)
       passes them in; anyone who does not still gets the correct page for the currency in the request. */
    const presentation = checkoutPresentation(body.currency, { planBound: Boolean(planId) });
    const settledCountry = String(country || presentation.country || '').trim().slice(0, 2).toUpperCase();
    const settledOptions = String(paymentOptions || presentation.paymentOptions || '').trim();
    if (metadata) body.meta = metadata;
    if (planId) body.payment_plan = planId;
    if (settledCountry) body.country = settledCountry;
    if (settledOptions) body.payment_options = settledOptions;
    const hash = payloadHashValue ?? payloadHash({ amountMinor, currency: body.currency, email, txRef: reference, secretKey: settings.secretKey });
    if (hash) body.payload_hash = hash;

    const payload = await call('/payments', { method: 'POST', body });
    const link = safeCheckoutLink(payload?.data?.link);
    if (!link) {
      const error = new Error('Flutterwave did not return a usable checkout link.');
      error.status = 502;
      error.code = 'FLUTTERWAVE_INVALID_RESPONSE';
      error.userMessage = 'The payment provider did not return a checkout page. No payment was taken.';
      throw error;
    }
    return {
      link,
      reference: String(payload?.data?.tx_ref || reference),
      accessCode: payload?.data?.access_code ? String(payload.data.access_code) : null,
      country: settledCountry || null,
      paymentOptions: settledOptions || null,
    };
  }

  async function verifyTransaction(reference) {
    const payload = await call(`/transactions/verify_by_reference?tx_ref=${encodeURIComponent(String(reference))}`);
    if (!payload?.data) {
      const error = new Error('Flutterwave did not return transaction details.');
      error.status = 502;
      error.code = 'FLUTTERWAVE_INVALID_RESPONSE';
      throw error;
    }
    return payload.data;
  }

  /* No "fetch one subscription" call, and none is needed: Flutterwave's activate takes only the id, so the
     email token and authorization code Paystack demanded on restart have no counterpart here. */
  async function fetchSubscription(id) {
    const payload = await call(`/subscriptions?${new URLSearchParams({ id: String(id) }).toString()}`);
    const found = Array.isArray(payload?.data) ? payload.data[0] : payload?.data;
    return toSafeSubscription(found);
  }

  async function cancelSubscription(id) {
    const payload = await call(`/subscriptions/${encodeURIComponent(String(id))}/cancel`, { method: 'PUT', body: {} });
    return { message: typeof payload?.message === 'string' ? payload.message.slice(0, 300) : 'Subscription cancelled' };
  }

  async function activateSubscription(id) {
    const payload = await call(`/subscriptions/${encodeURIComponent(String(id))}/activate`, { method: 'PUT', body: {} });
    return { message: typeof payload?.message === 'string' ? payload.message.slice(0, 300) : 'Subscription reactivated' };
  }

  /* ------------------------------ Payment plans (the recurring mirror) ------------------------------
   * A Flutterwave plan carries an amount and a currency, so a two-currency workspace needs one plan per
   * (Signal Desk plan, currency). `PUT /v3/payment-plans/:id` rewrites the plan itself, which - unlike
   * Paystack - is what existing subscribers are charged next cycle, so the admin panel says so plainly.
   */
  async function createPlan({ name, amountMinor, interval, currency }) {
    const body = {
      name: String(name).slice(0, 90),
      amount: amountString(amountMinor),
      interval: INTERVAL_MAP[String(interval || 'monthly').toLowerCase()] || 'monthly',
      currency: String(currency || DEFAULT_CURRENCY).toUpperCase(),
    };
    const payload = await call('/payment-plans', { method: 'POST', body });
    const plan = toSafePlan(payload?.data);
    if (!plan?.planId) {
      const error = new Error('Flutterwave did not return a payment plan id.');
      error.status = 502;
      error.code = 'FLUTTERWAVE_INVALID_RESPONSE';
      throw error;
    }
    return plan;
  }

  async function fetchPlan(id) {
    const payload = await call(`/payment-plans/${encodeURIComponent(String(id))}`);
    return toSafePlan(payload?.data);
  }

  async function updatePlan(id, { name, amountMinor, interval, currency }) {
    const body = {
      amount: amountString(amountMinor),
      interval: INTERVAL_MAP[String(interval || 'monthly').toLowerCase()] || 'monthly',
      currency: String(currency || DEFAULT_CURRENCY).toUpperCase(),
    };
    if (name) body.name = String(name).slice(0, 90);
    const payload = await call(`/payment-plans/${encodeURIComponent(String(id))}`, { method: 'PUT', body });
    return {
      message: typeof payload?.message === 'string' ? payload.message.slice(0, 300) : 'Plan updated',
      plan: toSafePlan(payload?.data),
    };
  }

  return Object.freeze({
    isConfigured: () => Boolean(settings.secretKey),
    initializeTransaction,
    verifyTransaction,
    createPlan,
    fetchPlan,
    updatePlan,
    fetchSubscription,
    cancelSubscription,
    activateSubscription,
  });
}
