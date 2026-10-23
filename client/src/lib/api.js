const configuredApiUrl = import.meta.env.VITE_API_URL || '';
const apiUrl = import.meta.env.PROD && configuredApiUrl.includes('telegram-copier-api.onrender.com')
  ? 'https://telegram-copier-api-l1mj.onrender.com'
  : configuredApiUrl || (import.meta.env.PROD ? 'https://telegram-copier-api-l1mj.onrender.com' : 'http://localhost:5000');
export const API_URL = apiUrl.replace(/\/$/, '');

import { WAKE_RETRY_DELAY_MS, isUnansweredRequestFailure, withWakeRetry } from './wake-retry.js';

export async function request(path, token, options = {}) {
  const { retryWhenUnanswered = false, retryDelayMs = WAKE_RETRY_DELAY_MS, sleep, ...send } = options;
  if (!retryWhenUnanswered) return sendRequest(path, token, send);
  // The rule itself lives in `lib/wake-retry.js`, where it can be tested without an API origin.
  return withWakeRetry(() => sendRequest(path, token, send), { retryDelayMs, sleep });
}

async function sendRequest(path, token, options = {}) {
  const response = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  /* A response is not automatically a readable JSON payload. The service's own words, a gateway page
     from a waking instance, and an empty body are three different facts, and rewriting all of them
     into one fixed sentence - as this used to do for every 5xx - destroyed the only description of a
     failure that existed. So the server's message is kept whenever it sent one, and when it did not,
     the sentence says what is actually known, including that the change may not have been applied. */
  const body = await response.text().catch(() => '');
  let payload = null;
  let answeredAsJson = false;
  if (body) {
    try {
      const parsed = JSON.parse(body);
      answeredAsJson = Boolean(parsed && typeof parsed === 'object');
      payload = answeredAsJson ? parsed : null;
    } catch {
      payload = null;
    }
  }
  payload = payload || {};
  if (!response.ok && response.status !== 202) {
    const said = (value) => (typeof value === 'string' && value.trim() ? value.trim() : '');
    const described = said(payload.userMessage) || said(payload.error) || said(payload.message);
    let message = described;
    const answered = { answered: true };
    if (!message && response.status >= 500) {
      // An empty JSON body is still an answer from Signal Desk; an HTML error page is not.
      message = answeredAsJson
        ? 'We could not complete that request. Please try again in a moment.'
        : `Signal Desk did not answer that request (HTTP ${response.status}), so it may never have been applied. Nothing you can see here is a lie, but this section may be stale - reload it, and try again after a few seconds.`;
      // Recorded on the error so a caller can tell "the service said no" from "nobody was home".
      if (!answeredAsJson) answered.answered = false;
    }
    // A reference the user can read out beats any sentence this file could invent about the cause.
    if (response.status >= 500 && typeof payload.requestId === 'string' && payload.requestId) {
      message = `${message} (Reference ${payload.requestId})`;
    }
    if (!message) message = 'Please check your details and try again.';
    const error = new Error(message);
    Object.assign(error, answered);
    error.status = response.status;
    if (!described && response.status >= 500) error.retryable = true;
    if (typeof payload.requestId === 'string' && payload.requestId) error.requestId = payload.requestId;
    if (payload.telegramErrorCode) error.telegramErrorCode = payload.telegramErrorCode;
    if (Number.isInteger(payload.metaApiStatus)) error.metaApiStatus = payload.metaApiStatus;
    if (typeof payload.metaApiErrorCode === 'string') error.metaApiErrorCode = payload.metaApiErrorCode;
    if (typeof payload.metaApiErrorType === 'string') error.metaApiErrorType = payload.metaApiErrorType;
    if (typeof payload.metaApiNetworkDiagnostic === 'string') error.metaApiNetworkDiagnostic = payload.metaApiNetworkDiagnostic;
    if (typeof payload.code === 'string') error.code = payload.code;
    if (payload.upgradeRequired === true) error.upgradeRequired = true;
    throw error;
  }
  return payload;
}
