import crypto from 'node:crypto';

const DEFAULT_BASE_URL = 'https://mt-provisioning-api-v1.agiliumtrade.agiliumtrade.ai';
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

function providerErrorCode(payload, apiToken) {
  const value = typeof payload?.details === 'string' ? payload.details : payload?.details?.code;
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.-]{1,80}$/.test(value)) return '';
  if (typeof apiToken === 'string' && apiToken.length >= 4 && value.includes(apiToken)) return '';
  return value;
}

function safeProviderMessage(payload, apiToken) {
  const candidates = [payload?.message, payload?.details?.message, payload?.error?.message, payload?.error]
    .filter((value) => typeof value === 'string' && value.trim());
  if (!candidates.length) return '';
  const sanitized = candidates.map((raw) => {
    let safe = raw
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/(https?:\/\/)[^/\s?#]*@([^/\s?#]*)/gi, '$1[redacted]@$2')
    .replace(/["']?\b(authorization|auth[-_ ]?token|access[-_ ]?token|api[-_ ]?token|password|passwd|secret|api[-_ ]?key|token)["']?\s*[:=]\s*(?:Bearer\s+)?["']?[^&\s,"';}]+/gi, '$1=[redacted]')
    .replace(/\b(token|secret|api[-_ ]?key|password|passwd)\s+(?:is\s+)?["']?[A-Za-z0-9._~+/-]{12,}={0,2}["']?/gi, '$1 [redacted]')
    .replace(/\bBearer\s+[^\s,"';}]{4,}/gi, 'Bearer [redacted]')
    .replace(/\s+/g, ' ')
    .trim();
    if (typeof apiToken === 'string' && apiToken.length >= 4) safe = safe.replaceAll(apiToken, '[redacted]');
    return safe;
  });
  const unique = [...new Set(sanitized)];
  const informative = unique.filter((value) => !/^(bad request|validationerror|error|request failed|failed request)$/i.test(value));
  return (informative.length ? informative : unique).join(' — ').slice(0, 1000);
}

function safeNetworkDiagnostics(cause, apiToken) {
  const queue = [cause];
  const seen = new Set();
  const nodes = [];
  while (queue.length && nodes.length < 16) {
    const current = queue.shift();
    if (!current || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    nodes.push(current);
    if (current.cause && typeof current.cause === 'object') queue.push(current.cause);
    if (Array.isArray(current.errors)) queue.push(...current.errors.slice(0, 5));
  }
  const code = nodes.map((node) => node.code).find((value) => typeof value === 'string'
    && /^(?:E[A-Z0-9_]{1,40}|ERR_[A-Z0-9_]{1,56}|UND_ERR_[A-Z0-9_]{1,56}|ABORT_ERR)$/.test(value)
    && !(typeof apiToken === 'string' && apiToken.length >= 4 && value.includes(apiToken)))
    || (nodes.some((node) => node.name === 'TimeoutError') ? 'TIMEOUT' : '');
  const messages = nodes.map((node) => node.message).filter((value) => typeof value === 'string' && value.trim());
  const rawMessage = messages.find((value) => !/^(fetch failed|request failed|network error|all promises were rejected)$/i.test(value.trim())) || messages[0] || '';
  return { code, message: rawMessage ? safeProviderMessage({ message: rawMessage }, apiToken) : '' };
}

function isFundingIssue(status, detail, providerMessage, payload) {
  if (status === 402) return true;
  const source = `${detail} ${providerMessage} ${payload?.message || ''} ${payload?.details?.message || ''} ${typeof payload?.error === 'string' ? payload.error : payload?.error?.message || ''}`;
  return /\binsufficient[\s_-]*(?:funds?|balance|credits?)\b|\bnot[\s_-]+enough[\s_-]*(?:funds?|balance|credits?)\b|\b(?:deposit|funding|top[\s-]?up)\b|\b(?:billing|payment)\s+(?:required|failed|declined|issue|problem|error)\b|\bE_(?:INSUFFICIENT_FUNDS|INSUFFICIENT_BALANCE|NOT_ENOUGH_(?:FUNDS|BALANCE|CREDITS)|NO_CREDITS|PAYMENT_REQUIRED|BILLING_REQUIRED|FUNDING_REQUIRED|DEPOSIT_REQUIRED)\b/i.test(source);
}

function metaApiTransportError(cause, apiToken, responseStatus = null) {
  const { code, message: causeMessage } = safeNetworkDiagnostics(cause, apiToken);
  const diagnostic = [code, causeMessage].filter(Boolean).join(' — ');
  const error = new Error('MetaAPI could not be reached. Try again shortly.');
  error.status = 502;
  error.code = code || 'METAAPI_NETWORK_ERROR';
  error.metaApiErrorCode = code || 'NETWORK_ERROR';
  error.metaApiErrorType = 'transport';
  error.metaApiNetworkDiagnostic = diagnostic || 'fetch failed without an underlying cause';
  if (Number.isInteger(responseStatus)) {
    error.metaApiStatus = responseStatus;
    error.userMessage = `MetaAPI returned HTTP ${responseStatus}, but its response body could not be read${diagnostic ? ` (${diagnostic})` : ''}. No complete provider funding or deposit message was received.`;
  } else {
    error.userMessage = `The request to MetaAPI failed before an HTTP response${diagnostic ? ` (${diagnostic})` : ''}. MetaAPI did not return a deposit or funding message.`;
  }
  return error;
}

function safeMetaApiError(status, payload, unauthorizedMessage, apiToken) {
  const detail = providerErrorCode(payload, apiToken);
  const providerMessage = safeProviderMessage(payload, apiToken);
  const fundingIssue = isFundingIssue(status, detail, providerMessage, payload);
  let message;
  if (fundingIssue) {
    message = providerMessage || 'MetaAPI reported a funding or deposit issue.';
  } else if (status === 401 || status === 403) {
    message = unauthorizedMessage || 'MetaAPI rejected the server token or its account-management permissions.';
  } else if (status === 429) {
    message = 'Too many account requests were made. Wait briefly, then try again.';
  } else if (detail === 'E_SRV_NOT_FOUND' || /server .*not found|\.dat file.*not found/i.test(payload?.message || '')) {
    message = 'That broker server was not recognized. Check its exact name in your MetaTrader account details.';
  } else if (detail === 'E_AUTH') {
    message = 'MetaAPI could not connect with those account details. Check the platform, server, and credentials on the secure setup page.';
  } else if (status === 400) {
    message = 'MetaAPI rejected the account setup request. Check the broker server and platform.';
  } else if (status === 404) {
    message = 'That account could not be found. Refresh the account list and try again.';
  } else {
    message = 'MetaAPI is temporarily unavailable. Please try again shortly.';
  }

  const diagnostics = [detail && `code ${detail}`, providerMessage].filter(Boolean);
  const error = new Error(message);
  error.status = status === 401 || status === 403 || status === 429 ? 503
    : status === 400 ? 422
      : status === 404 ? 404
        : 502;
  error.metaApiStatus = status;
  if (detail) error.metaApiErrorCode = detail;
  if (fundingIssue) {
    error.metaApiErrorType = 'funding';
    error.userMessage = `MetaAPI reported a funding or deposit issue (HTTP ${status}${detail ? `, code ${detail}` : ''}): ${providerMessage || message}`;
  } else {
    error.metaApiErrorType = 'provider';
    error.userMessage = `${message} MetaAPI returned HTTP ${status}${diagnostics.length ? `: ${diagnostics.join(' — ')}` : ''}.`;
  }
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

function normalizeMetaApiToken(token) {
  const normalizedToken = token.replace(/\p{Cf}/gu, '').trim();
  if (/^[\x21-\x7e]+$/.test(normalizedToken)) return normalizedToken;

  const error = new Error('The saved MetaAPI access token contains unsupported characters. Remove any invisible formatting marks, save it again, and retry.');
  error.status = 503;
  error.code = 'METAAPI_TOKEN_ENCODING_INVALID';
  error.metaApiErrorCode = 'INVALID_TOKEN_ENCODING';
  error.metaApiErrorType = 'configuration';
  error.userMessage = error.message;
  throw error;
}

export async function metaApiRequest(apiToken, endpoint, { method = 'GET', body, transactionId, unauthorizedMessage } = {}) {
  if (typeof apiToken !== 'string' || !apiToken.trim()) throw new Error('MetaAPI token is required.');
  const headerToken = normalizeMetaApiToken(apiToken);
  if (!isAllowedRequest(method, endpoint, body)) throw new Error('Unsupported MetaAPI request.');

  let requestUrl;
  try {
    requestUrl = `${getBaseUrl()}${endpoint}`;
  } catch {
    const error = new Error('MetaAPI endpoint configuration is invalid.');
    error.status = 503;
    error.metaApiErrorCode = 'INVALID_ENDPOINT';
    error.userMessage = 'Could not connect to MetaAPI. The account-setup endpoint is misconfigured; please contact the workspace owner.';
    throw error;
  }

  const requestId = method === 'POST' ? (transactionId || crypto.randomUUID().replaceAll('-', '')) : null;
  const startedAt = Date.now();

  while (true) {
    let response;
    try {
      response = await fetch(requestUrl, {
        method,
        headers: {
          'auth-token': headerToken,
          Accept: 'application/json',
          'Content-Type': 'application/json',
          ...(requestId ? { 'transaction-id': requestId } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (cause) {
      throw metaApiTransportError(cause, headerToken);
    }

    let text;
    try { text = await response.text(); }
    catch (cause) { throw metaApiTransportError(cause, headerToken, response.status); }
    let payload = null;
    if (text) {
      try { payload = JSON.parse(text); }
      catch { payload = response.headers.get('content-type')?.toLowerCase().startsWith('text/plain') ? { message: text } : null; }
    }

    if (response.status === 202 && method === 'POST') {
      const delay = retryDelayMs(response.headers.get('retry-after'), payload);
      if (Date.now() - startedAt + delay > MAX_PROVISIONING_WAIT_MS) {
        const error = new Error('Account setup is taking longer than expected. Wait a little, refresh your accounts, and try again if it is still missing.');
        error.status = 503;
        error.userMessage = error.message;
        throw error;
      }
      await sleep(delay);
      continue;
    }

    if (!response.ok) throw safeMetaApiError(response.status, payload, unauthorizedMessage, headerToken);
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
