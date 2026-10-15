import crypto from 'node:crypto';

const DEFAULT_BASE_URL = 'https://mt-provisioning-api-v1.agiliumtrade.ai';
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_PROVISIONING_WAIT_MS = 240_000;
const ACCOUNT_ENDPOINT = '/users/current/accounts';
const ACCOUNT_ID_PATTERN = /^[A-Za-z0-9_-]{1,200}$/;

function getBaseUrl() {
  const base = process.env.META_API_URL || DEFAULT_BASE_URL;
  const parsed = new URL(base);
  if (parsed.protocol !== 'https:') throw new Error('MetaAPI must be accessed over HTTPS.');
  return parsed.toString().replace(/\/$/, '');
}

function isAllowedRequest(method, endpoint, body) {
  if (method === 'GET' && body === undefined) {
    return endpoint === ACCOUNT_ENDPOINT || new RegExp(`^${ACCOUNT_ENDPOINT}/[A-Za-z0-9_-]{1,200}$`).test(endpoint);
  }
  if (method === 'POST' && endpoint === ACCOUNT_ENDPOINT && body && typeof body === 'object' && !Array.isArray(body)) {
    return Object.keys(body).every((key) => ['name', 'server', 'platform', 'magic'].includes(key))
      && typeof body.name === 'string'
      && typeof body.server === 'string'
      && ['mt4', 'mt5'].includes(body.platform)
      && body.magic === 0;
  }
  return method === 'PUT' && body === undefined && new RegExp(`^${ACCOUNT_ENDPOINT}/[A-Za-z0-9_-]{1,200}/configuration-link$`).test(endpoint);
}

function safeMetaApiError(status, payload, unauthorizedMessage) {
  const detail = typeof payload?.details === 'string' ? payload.details : payload?.details?.code;
  let message;
  if (status === 401 || status === 403) {
    message = unauthorizedMessage || 'MetaAPI rejected that connection. Check the token and try again.';
  } else if (status === 429) {
    message = 'Too many account requests were made. Wait briefly, then try again.';
  } else if (detail === 'E_SRV_NOT_FOUND' || /server .*not found|\.dat file.*not found/i.test(payload?.message || '')) {
    message = 'That broker server was not recognized. Check its exact name in your MetaTrader account details.';
  } else if (detail === 'E_AUTH') {
    message = 'MetaAPI could not connect with those account details. Check the platform, server, and credentials on the secure setup page.';
  } else if (status === 400) {
    message = 'We could not set up that account. Check the broker server and platform, then try again.';
  } else if (status === 404) {
    message = 'That account could not be found. Refresh the account list and try again.';
  } else {
    message = 'MetaAPI is temporarily unavailable. Please try again shortly.';
  }

  const error = new Error(message);
  error.status = status === 401 || status === 403 || status === 429 ? 503
    : status === 400 ? 422
      : status === 404 ? 404
        : 502;
  return error;
}

function retryDelayMs(headerValue, payload) {
  if (headerValue && /^\d+$/.test(headerValue.trim())) return Number(headerValue) * 1000;
  if (headerValue) {
    const date = Date.parse(headerValue);
    if (Number.isFinite(date)) return Math.max(1000, date - Date.now());
  }
  const seconds = /retry in (\d+) seconds?/i.exec(payload?.message || '');
  return seconds ? Math.max(1000, Number(seconds[1]) * 1000) : 5000;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function metaApiRequest(apiToken, endpoint, { method = 'GET', body, transactionId, unauthorizedMessage } = {}) {
  if (typeof apiToken !== 'string' || !apiToken.trim()) throw new Error('MetaAPI token is required.');
  if (!isAllowedRequest(method, endpoint, body)) throw new Error('Unsupported MetaAPI request.');

  const requestId = method === 'POST' ? (transactionId || crypto.randomUUID().replaceAll('-', '')) : null;
  const startedAt = Date.now();

  while (true) {
    let response;
    try {
      response = await fetch(`${getBaseUrl()}${endpoint}`, {
        method,
        headers: {
          'auth-token': apiToken,
          Accept: 'application/json',
          'Content-Type': 'application/json',
          ...(requestId ? { 'transaction-id': requestId } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      const error = new Error('MetaAPI could not be reached. Try again shortly.');
      error.status = 502;
      throw error;
    }

    const text = await response.text();
    let payload = null;
    if (text) {
      try { payload = JSON.parse(text); } catch { payload = null; }
    }

    if (response.status === 202 && method === 'POST') {
      const delay = retryDelayMs(response.headers.get('retry-after'), payload);
      if (Date.now() - startedAt + delay > MAX_PROVISIONING_WAIT_MS) {
        const error = new Error('Account setup is taking longer than expected. Wait a little, refresh your accounts, and try again if it is still missing.');
        error.status = 503;
        throw error;
      }
      await sleep(delay);
      continue;
    }

    if (!response.ok) throw safeMetaApiError(response.status, payload, unauthorizedMessage);
    return payload;
  }
}

export async function createMetaApiConfigurationLink(apiToken, accountId) {
  if (typeof accountId !== 'string' || !ACCOUNT_ID_PATTERN.test(accountId)) throw new Error('A valid account is required.');
  const payload = await metaApiRequest(apiToken, `${ACCOUNT_ENDPOINT}/${encodeURIComponent(accountId)}/configuration-link`, { method: 'PUT' });
  let link;
  try { link = new URL(payload?.configurationLink); } catch {
    const error = new Error('A secure account setup link could not be created. Please try again.');
    error.status = 502;
    throw error;
  }
  if (link.protocol !== 'https:' || link.hostname !== 'app.metaapi.cloud' || !link.pathname.startsWith('/configure-trading-account-credentials/')) {
    const error = new Error('A secure account setup link could not be verified. Please try again.');
    error.status = 502;
    throw error;
  }
  return link.href;
}

export function toSafeMetaApiAccount(account) {
  const id = String(account?.id || '').trim();
  if (!id) return null;
  return {
    id,
    login: account.login === undefined || account.login === null ? null : String(account.login).slice(0, 100),
    name: String(account.name || '').slice(0, 160),
    platform: String(account.platform || '').slice(0, 30),
    state: String(account.state || account.connectionStatus || '').slice(0, 60),
    type: String(account.type || '').slice(0, 40),
  };
}
