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
 * Minimal Paystack REST client. Both endpoints used here are documented at
 * https://paystack.com/docs/api/transaction/ — initialize and verify.
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

  return Object.freeze({ isConfigured: () => Boolean(settings.secretKey), initializeTransaction, verifyTransaction });
}
