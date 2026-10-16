import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createMetaApiConfigurationLink,
  metaApiRequest,
  toSafeMetaApiAccount,
} from '../services/metaapi.js';

const originalFetch = globalThis.fetch;
const originalBaseUrl = process.env.META_API_URL;

function restoreGlobals() {
  globalThis.fetch = originalFetch;
  if (originalBaseUrl === undefined) delete process.env.META_API_URL;
  else process.env.META_API_URL = originalBaseUrl;
}

test('defaults to the documented MetaAPI provisioning host and auth-token header', async () => {
  delete process.env.META_API_URL;
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return new Response('[]', { status: 200 });
  };
  try {
    const result = await metaApiRequest('server-token', '/users/current/accounts');
    assert.deepEqual(result, []);
    assert.equal(request.url, 'https://mt-provisioning-api-v1.agiliumtrade.agiliumtrade.ai/users/current/accounts');
    assert.equal(request.options.headers['auth-token'], 'server-token');
    assert.equal(request.options.headers.Authorization, undefined);
  } finally { restoreGlobals(); }
});

test('removes copied Unicode direction marks from the MetaAPI auth-token header', async () => {
  process.env.META_API_URL = 'https://metaapi.example.test';
  let sentToken;
  globalThis.fetch = async (_url, options) => {
    sentToken = options.headers['auth-token'];
    return new Response('[]', { status: 200 });
  };
  try {
    await metaApiRequest('\u200e server-token\u200f', '/users/current/accounts');
    assert.equal(sentToken, 'server-token');
  } finally { restoreGlobals(); }
});

test('rejects unsupported token characters with safe guidance before calling fetch', async () => {
  process.env.META_API_URL = 'https://metaapi.example.test';
  let fetchCalled = false;
  globalThis.fetch = async () => { fetchCalled = true; return new Response('[]', { status: 200 }); };
  try {
    await assert.rejects(
      metaApiRequest('server-🔒-token', '/users/current/accounts'),
      (error) => error.status === 503
        && error.metaApiErrorCode === 'INVALID_TOKEN_ENCODING'
        && error.metaApiErrorType === 'configuration'
        && error.userMessage.includes('unsupported characters')
        && !error.userMessage.includes('server-🔒-token'),
    );
    assert.equal(fetchCalled, false);
  } finally { restoreGlobals(); }
});

test('creates an account without accepting login or password fields', async () => {
  process.env.META_API_URL = 'https://metaapi.example.test';
  globalThis.fetch = async () => new Response(JSON.stringify({ id: 'account-1', state: 'DRAFT' }), { status: 201 });
  try {
    await assert.rejects(
      metaApiRequest('server-token', '/users/current/accounts', {
        method: 'POST',
        body: { name: 'Test', server: 'Broker-Demo', platform: 'mt5', magic: 0, password: 'never-allowed' },
      }),
      /Unsupported MetaAPI request/,
    );
  } finally { restoreGlobals(); }
});

test('polls an accepted account-creation request with the same transaction ID and documented payload', async () => {
  process.env.META_API_URL = 'https://metaapi.example.test';
  const seen = [];
  globalThis.fetch = async (url, options) => {
    seen.push({ url, options });
    if (seen.length === 1) return new Response(JSON.stringify({ message: 'Automatic broker settings detection is in progress' }), { status: 202, headers: { 'retry-after': '0' } });
    return new Response(JSON.stringify({ id: 'account-1', state: 'DRAFT' }), { status: 201 });
  };
  try {
    const result = await metaApiRequest('server-token', '/users/current/accounts', {
      method: 'POST',
      body: { name: 'Demo account', server: 'Broker-Demo', platform: 'mt5', magic: 0 },
      transactionId: '0123456789abcdef0123456789abcdef',
    });
    assert.equal(result.id, 'account-1');
    assert.equal(seen.length, 2);
    assert.equal(seen[0].options.headers['transaction-id'], '0123456789abcdef0123456789abcdef');
    assert.equal(seen[1].options.headers['transaction-id'], '0123456789abcdef0123456789abcdef');
    assert.deepEqual(JSON.parse(seen[0].options.body), { name: 'Demo account', server: 'Broker-Demo', platform: 'mt5', magic: 0 });
    assert.equal(seen[0].options.headers['auth-token'], 'server-token');
  } finally { restoreGlobals(); }
});

test('returns a MetaAPI-hosted HTTPS configuration link using the documented PUT contract', async () => {
  process.env.META_API_URL = 'https://metaapi.example.test';
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return new Response(JSON.stringify({ configurationLink: 'https://app.metaapi.cloud/configure-trading-account-credentials/account-1/opaque-link' }), { status: 200 });
  };
  try {
    const link = await createMetaApiConfigurationLink('server-token', 'account-1');
    assert.match(link, /^https:\/\/app\.metaapi\.cloud\/configure-trading-account-credentials\//);
    assert.equal(request.url, 'https://metaapi.example.test/users/current/accounts/account-1/configuration-link');
    assert.equal(request.options.method, 'PUT');
    assert.equal(request.options.headers['auth-token'], 'server-token');
    assert.equal(request.options.body, undefined);
  } finally { restoreGlobals(); }
});

test('rejects configuration links to an unexpected destination', async () => {
  process.env.META_API_URL = 'https://metaapi.example.test';
  globalThis.fetch = async () => new Response(JSON.stringify({ configurationLink: 'https://example.org/collect-password' }), { status: 200 });
  try {
    await assert.rejects(createMetaApiConfigurationLink('server-token', 'account-1'), /could not be verified/);
  } finally { restoreGlobals(); }
});

test('returns the MetaAPI status and sanitized provider message without echoing credentials', async () => {
  process.env.META_API_URL = 'https://metaapi.example.test';
  globalThis.fetch = async () => new Response(JSON.stringify({
    message: 'Authentication failed; auth-token: super-secret-token',
    details: { code: 'E_TOKEN_INVALID' },
  }), { status: 401 });
  try {
    await assert.rejects(
      metaApiRequest('server-token', '/users/current/accounts', { unauthorizedMessage: 'Check the server token and its account-management access.' }),
      (error) => error.status === 503
        && error.message === 'Check the server token and its account-management access.'
        && error.userMessage.includes('HTTP 401')
        && error.userMessage.includes('E_TOKEN_INVALID')
        && error.userMessage.includes('Authentication failed')
        && !error.userMessage.includes('super-secret-token')
        && error.metaApiStatus === 401
        && error.metaApiErrorCode === 'E_TOKEN_INVALID',
    );
  } finally { restoreGlobals(); }
});

test('includes the actual sanitized MetaAPI validation message for server-name errors', async () => {
  process.env.META_API_URL = 'https://metaapi.example.test';
  globalThis.fetch = async () => new Response(JSON.stringify({
    message: 'Broker server Demo-Server was not found. Suggested server names: Demo-MT5.',
    details: { code: 'E_SRV_NOT_FOUND' },
  }), { status: 400 });
  try {
    await assert.rejects(
      metaApiRequest('server-token', '/users/current/accounts', { method: 'POST', body: { name: 'Demo', server: 'Demo-Server', platform: 'mt5', magic: 0 } }),
      (error) => error.status === 422
        && error.userMessage.includes('HTTP 400')
        && error.userMessage.includes('E_SRV_NOT_FOUND')
        && error.userMessage.includes('Suggested server names: Demo-MT5'),
    );
  } finally { restoreGlobals(); }
});

test('returns funding-related provider errors verbatim with a funding classification', async () => {
  process.env.META_API_URL = 'https://metaapi.example.test';
  globalThis.fetch = async () => new Response(JSON.stringify({
    message: 'Bad Request',
    details: { code: 'E_INSUFFICIENT_FUNDS', message: 'Insufficient balance. Please deposit funds before creating another account.' },
  }), { status: 402 });
  try {
    await assert.rejects(
      metaApiRequest('server-token', '/users/current/accounts'),
      (error) => error.metaApiStatus === 402
        && error.metaApiErrorType === 'funding'
        && error.userMessage.includes('HTTP 402')
        && error.userMessage.includes('E_INSUFFICIENT_FUNDS')
        && error.userMessage.includes('Insufficient balance. Please deposit funds before creating another account.')
        && !error.userMessage.includes('Bad Request'),
    );
  } finally { restoreGlobals(); }
});

test('detects funding text in details.message even when the provider code is generic', async () => {
  process.env.META_API_URL = 'https://metaapi.example.test';
  globalThis.fetch = async () => new Response(JSON.stringify({
    message: 'Bad Request',
    details: { code: 'E_VALIDATION_ERROR', message: 'Your MetaAPI balance is insufficient; a deposit is required.' },
  }), { status: 400 });
  try {
    await assert.rejects(
      metaApiRequest('server-token', '/users/current/accounts'),
      (error) => error.metaApiErrorType === 'funding'
        && error.userMessage.includes('HTTP 400')
        && error.userMessage.includes('E_VALIDATION_ERROR')
        && error.userMessage.includes('Your MetaAPI balance is insufficient; a deposit is required.')
        && !error.userMessage.includes('Bad Request'),
    );
  } finally { restoreGlobals(); }
});

test('redacts a bare provisioning token echoed in a provider message', async () => {
  process.env.META_API_URL = 'https://metaapi.example.test';
  globalThis.fetch = async () => new Response(JSON.stringify({ message: 'The token super-secret-token-value was rejected.' }), { status: 401 });
  try {
    await assert.rejects(
      metaApiRequest('super-secret-token-value', '/users/current/accounts'),
      (error) => error.userMessage.includes('The token [redacted] was rejected.')
        && !error.userMessage.includes('super-secret-token-value'),
    );
  } finally { restoreGlobals(); }
});

test('does not return a provisioning token echoed as a provider error code', async () => {
  process.env.META_API_URL = 'https://metaapi.example.test';
  globalThis.fetch = async () => new Response(JSON.stringify({
    message: 'Authorization failed.',
    details: { code: 'super-secret-token-value' },
  }), { status: 401 });
  try {
    await assert.rejects(
      metaApiRequest('super-secret-token-value', '/users/current/accounts'),
      (error) => !error.userMessage.includes('super-secret-token-value')
        && error.metaApiErrorCode === undefined,
    );
  } finally { restoreGlobals(); }
});

test('redacts URL userinfo and short token query parameters from nested transport causes', async () => {
  process.env.META_API_URL = 'https://metaapi.example.test';
  const cause = Object.assign(new Error('Request to https://username:short@pass@metaapi.example.test/status?api_token=short&access_token=xy failed'), { code: 'ECONNRESET' });
  globalThis.fetch = async () => { throw new TypeError('fetch failed', { cause }); };
  try {
    await assert.rejects(
      metaApiRequest('server-token', '/users/current/accounts'),
      (error) => error.userMessage.includes('https://[redacted]@metaapi.example.test/status?api_token=[redacted]&access_token=[redacted]')
        && !error.userMessage.includes('username')
        && !error.userMessage.includes('short@pass')
        && !error.userMessage.includes('api_token=short')
        && !error.userMessage.includes('access_token=xy'),
    );
  } finally { restoreGlobals(); }
});

test('includes safe connection error codes when MetaAPI cannot be reached', async () => {
  process.env.META_API_URL = 'https://metaapi.example.test';
  const nestedCause = Object.assign(new Error('getaddrinfo EAI_AGAIN mt-provisioning-api-v1.agiliumtrade.agiliumtrade.ai'), { code: 'EAI_AGAIN' });
  const aggregateCause = new AggregateError([nestedCause], 'All promises were rejected');
  const cause = new TypeError('fetch failed', { cause: aggregateCause });
  globalThis.fetch = async () => { throw cause; };
  try {
    await assert.rejects(
      metaApiRequest('server-token', '/users/current/accounts'),
      (error) => error.status === 502
        && error.userMessage.includes('EAI_AGAIN')
        && error.userMessage.includes('getaddrinfo EAI_AGAIN mt-provisioning-api-v1.agiliumtrade.agiliumtrade.ai')
        && error.userMessage.includes('did not return a deposit or funding message')
        && error.metaApiErrorCode === 'EAI_AGAIN'
        && error.metaApiErrorType === 'transport',
    );
  } finally { restoreGlobals(); }
});

test('reports a network cause when the MetaAPI response body cannot be read', async () => {
  process.env.META_API_URL = 'https://metaapi.example.test';
  const response = {
    status: 403,
    headers: new Headers({ 'content-type': 'application/json' }),
    text: async () => { throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }); },
  };
  globalThis.fetch = async () => response;
  try {
    await assert.rejects(
      metaApiRequest('server-token', '/users/current/accounts'),
      (error) => error.status === 502
        && error.metaApiStatus === 403
        && error.metaApiErrorCode === 'ECONNRESET'
        && error.userMessage.includes('HTTP 403')
        && error.userMessage.includes('ECONNRESET')
        && error.userMessage.includes('No complete provider funding or deposit message was received'),
    );
  } finally { restoreGlobals(); }
});

test('only exposes safe MetaAPI account metadata', () => {
  const safe = toSafeMetaApiAccount({ id: 'account-1', login: '12345', name: 'Demo', platform: 'mt5', state: 'DRAFT', password: 'private' });
  assert.deepEqual(safe, { id: 'account-1', login: '12345', name: 'Demo', platform: 'mt5', state: 'DRAFT', type: '' });
  assert.equal(Object.hasOwn(safe, 'password'), false);
});
