const DEFAULT_BASE_URL = 'https://mt-provisioning-api-v1.agiliumtrade.ai';
const REQUEST_TIMEOUT_MS = 30_000;

function getBaseUrl() {
  const base = process.env.META_API_URL || DEFAULT_BASE_URL;
  const parsed = new URL(base);
  if (parsed.protocol !== 'https:') throw new Error('MetaAPI must be accessed over HTTPS.');
  return parsed.toString().replace(/\/$/, '');
}

export async function metaApiRequest(apiToken, endpoint, { method = 'GET', body } = {}) {
  if (typeof apiToken !== 'string' || !apiToken.trim()) throw new Error('MetaAPI token is required.');
  if (method !== 'GET' || body !== undefined) throw new Error('This MetaAPI integration is read-only.');
  if (!/^\/users\/current\/accounts(?:\/|$)/.test(endpoint)) throw new Error('Unsupported MetaAPI endpoint.');

  let response;
  try {
    response = await fetch(`${getBaseUrl()}${endpoint}`, {
      method,
      headers: {
        'auth-token': apiToken,
        Accept: 'application/json',
        'Content-Type': 'application/json',
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
  if (!response.ok) {
    const error = new Error(response.status === 401 || response.status === 403
      ? 'MetaAPI rejected this token or its permissions. Check the token and try again.'
      : response.status === 429
        ? 'MetaAPI rate limit reached. Wait briefly, then retry.'
        : `MetaAPI request failed (HTTP ${response.status}).`);
    error.status = response.status === 401 || response.status === 403 ? 422 : response.status === 429 ? 503 : 502;
    throw error;
  }
  return payload;
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
