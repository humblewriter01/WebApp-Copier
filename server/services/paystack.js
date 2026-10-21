const REQUEST_TIMEOUT_MS = 20_000;

function networkError(cause) {
  const error = new Error('Paystack could not be reached. Please try again shortly.');
  error.status = 502;
  error.code = 'PAYSTACK_NETWORK_ERROR';
  error.userMessage = `The payment provider could not be reached${cause?.code ? ` (${cause.code})` : ''}. No payment was taken.`;
  return error;
}

function providerError(status, payload) {
  const message = typeof payload?.message === 'string' && payload.message.trim()
    ? payload.message.trim().slice(0, 300)
    : '';
  const error = new Error(message || 'Paystack rejected the payment request.');
  error.status = status === 401 || status === 403 ? 503 : status === 429 ? 503 : 502;
  error.code = 'PAYSTACK_PROVIDER_ERROR';
  error.paystackStatus = status;
  error.userMessage = status === 401 || status === 403
    ? 'Payments are temporarily unavailable because the payment provider rejected the workspace credentials. No payment was taken.'
    : status === 429
      ? 'Too many payment attempts were made. Wait a moment, then try again.'
      : `The payment provider rejected the request${message ? `: ${message}` : ''}. No payment was taken.`;
  return error;
}

/**
 * Minimal Paystack REST client.
 *
 * Transactions: https://paystack.com/docs/api/transaction/ (initialize, verify).
 * Plans: https://paystack.com/docs/api/plan/ (create, fetch, update) — used to
 * keep a Paystack plan code at exactly the price set in the admin panel.
 * Subscriptions: https://paystack.com/docs/api/subscription/ (fetch, disable,
 * enable) — used so cancelling in Signal Desk also stops Paystack re-charging.
 *
 * Only these documented endpoints are called, the secret key never leaves the
 * server, and provider failures are re-thrown with a `userMessage` that is safe
 * to show in a browser.
 */
export function createPaystackClient({ config, fetchImpl } = {}) {
  const settings = config || {};
  const doFetch = fetchImpl || globalThis.fetch;

  function ensureConfigured() {
    if (!settings.secretKey) {
      const error = new Error('Payments are not configured for this workspace yet.');
      error.status = 503;
      error.code = 'PAYSTACK_NOT_CONFIGURED';
      error.userMessage = 'Payments are temporarily unavailable. Please try again later.';
      throw error;
    }
  }

  async function call(path, { method = 'GET', body } = {}) {
    ensureConfigured();
    let response;
    try {
      response = await doFetch(`${settings.baseUrl}${path}`, {
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
    if (!response.ok || payload?.status === false) throw providerError(response.status, payload);
    return payload;
  }

  async function initializeTransaction({ email, amountMinor, currency, reference, callbackUrl, planCode, metadata }) {
    const body = {
      email,
      amount: amountMinor,
      currency,
      reference,
      callback_url: callbackUrl,
      metadata,
    };
    if (planCode) body.plan = planCode;
    const payload = await call('/transaction/initialize', { method: 'POST', body });
    const data = payload?.data;
    if (!data?.authorization_url || !data?.access_code) {
      const error = new Error('Paystack did not return a checkout URL.');
      error.status = 502;
      error.code = 'PAYSTACK_INVALID_RESPONSE';
      throw error;
    }
    let url;
    try { url = new URL(data.authorization_url); } catch { url = null; }
    if (!url || url.protocol !== 'https:' || !/(^|\.)paystack\.com$/i.test(url.hostname)) {
      const error = new Error('Paystack returned an unexpected checkout URL.');
      error.status = 502;
      error.code = 'PAYSTACK_INVALID_RESPONSE';
      throw error;
    }
    return {
      authorizationUrl: url.href,
      accessCode: String(data.access_code),
      reference: String(data.reference || reference),
    };
  }

  async function verifyTransaction(reference) {
    const payload = await call(`/transaction/verify/${encodeURIComponent(reference)}`);
    if (!payload?.data) {
      const error = new Error('Paystack did not return transaction details.');
      error.status = 502;
      error.code = 'PAYSTACK_INVALID_RESPONSE';
      throw error;
    }
    return payload.data;
  }

  /* ------------------------------- Plans ----------------------------------
   * https://paystack.com/docs/api/plan/ — create (`POST /plan`), fetch
   * (`GET /plan/:id_or_code`) and update (`PUT /plan/:id_or_code`). Update
   * replies with a message only, so callers re-fetch the plan to confirm the
   * amount that Paystack actually stored.
   */
  async function createPlan({ name, amountMinor, interval, currency, description, sendInvoices = true, invoiceLimit }) {
    const body = { name, amount: amountMinor, interval, currency: currency || 'NGN', send_invoices: sendInvoices !== false };
    if (description) body.description = String(description).slice(0, 300);
    if (Number.isFinite(Number(invoiceLimit)) && Number(invoiceLimit) > 0) body.invoice_limit = Number(invoiceLimit);
    const payload = await call('/plan', { method: 'POST', body });
    const plan = toSafePlan(payload?.data);
    if (!plan?.planCode) {
      const error = new Error('Paystack did not return a plan code.');
      error.status = 502;
      error.code = 'PAYSTACK_INVALID_RESPONSE';
      throw error;
    }
    return plan;
  }

  async function fetchPlan(idOrCode) {
    const payload = await call(`/plan/${encodeURIComponent(String(idOrCode))}`);
    return toSafePlan(payload?.data);
  }

  async function updatePlan(idOrCode, { name, amountMinor, interval, currency, description, sendInvoices = true, updateExistingSubscriptions = true }) {
    const body = { amount: amountMinor, interval, currency: currency || 'NGN', send_invoices: sendInvoices !== false };
    if (name) body.name = name;
    if (description) body.description = String(description).slice(0, 300);
    body.update_existing_subscriptions = updateExistingSubscriptions !== false;
    const payload = await call(`/plan/${encodeURIComponent(String(idOrCode))}`, { method: 'PUT', body });
    return {
      message: typeof payload?.message === 'string' ? payload.message.slice(0, 300) : 'Plan updated',
      affectedSubscriptions: parseAffectedSubscriptions(payload?.message),
      plan: toSafePlan(payload?.data),
    };
  }

  /* --------------------------- Provider subscriptions ----------------------
   * A checkout raised with a plan code creates a Paystack subscription, which
   * is what bills the customer again each interval. `POST /subscription/disable`
   * stops those future charges; `POST /subscription/enable` restarts them and
   * needs the email token and authorization from the subscription itself.
   */
  async function fetchSubscription(code) {
    const payload = await call(`/subscription/${encodeURIComponent(String(code))}`);
    return toSafeSubscription(payload?.data);
  }

  async function disableSubscription(code) {
    const payload = await call('/subscription/disable', { method: 'POST', body: { code: String(code) } });
    return { message: typeof payload?.message === 'string' ? payload.message.slice(0, 300) : 'Subscription cancelled' };
  }

  async function enableSubscription({ code, token, authorization }) {
    const body = { code: String(code) };
    if (token) body.token = String(token);
    if (authorization) body.authorization = String(authorization);
    const payload = await call('/subscription/enable', { method: 'POST', body });
    return {
      message: typeof payload?.message === 'string' ? payload.message.slice(0, 300) : 'Subscription reactivated',
      subscription: toSafeSubscription(payload?.data),
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
    disableSubscription,
    enableSubscription,
  });
}

/** Number of existing subscriptions Paystack moved to the new plan details. */
export function parseAffectedSubscriptions(message) {
  const match = /(\d+)\s+subscription/i.exec(String(message || ''));
  return match ? Number(match[1]) : null;
}

export function toSafePlan(data) {
  if (!data || typeof data !== 'object') return null;
  return {
    id: Number.isFinite(Number(data.id)) ? Number(data.id) : null,
    planCode: data.plan_code ? String(data.plan_code) : null,
    name: data.name ? String(data.name).slice(0, 120) : null,
    amountMinor: Number.isFinite(Number(data.amount)) ? Number(data.amount) : null,
    interval: data.interval ? String(data.interval).toLowerCase() : null,
    currency: data.currency ? String(data.currency).toUpperCase() : null,
  };
}

export function toSafeSubscription(data) {
  if (!data || typeof data !== 'object') return null;
  return {
    subscriptionCode: data.subscription_code ? String(data.subscription_code) : null,
    status: data.status ? String(data.status).toLowerCase() : null,
    amountMinor: Number.isFinite(Number(data.amount)) ? Number(data.amount) : null,
    emailToken: data.email_token ? String(data.email_token) : null,
    nextPaymentDate: data.next_payment_date ? String(data.next_payment_date) : null,
    authorizationCode: data.authorization?.authorization_code ? String(data.authorization.authorization_code) : null,
    planCode: data.plan?.plan_code ? String(data.plan.plan_code) : null,
    customerEmail: data.customer?.email ? String(data.customer.email) : null,
  };
}

/** True when Paystack answered "not found", e.g. a plan code we no longer own. */
export function isProviderNotFound(error) {
  return Number(error?.paystackStatus) === 404;
}
