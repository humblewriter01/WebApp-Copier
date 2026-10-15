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

test('polls an accepted account-creation request with the same transaction ID and no credentials', async () => {
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

test('returns a MetaAPI-hosted HTTPS configuration link', async () => {
  process.env.META_API_URL = 'https://metaapi.example.test';
  globalThis.fetch = async () => new Response(JSON.stringify({ configurationLink: 'https://app.metaapi.cloud/configure-trading-account-credentials/account-1/opaque-link' }), { status: 200 });
  try {
    const link = await createMetaApiConfigurationLink('server-token', 'account-1');
    assert.match(link, /^https:\/\/app\.metaapi\.cloud\/configure-trading-account-credentials\//);
  } finally { restoreGlobals(); }
});

test('rejects configuration links to an unexpected destination', async () => {
  process.env.META_API_URL = 'https://metaapi.example.test';
  globalThis.fetch = async () => new Response(JSON.stringify({ configurationLink: 'https://example.org/collect-password' }), { status: 200 });
  try {
    await assert.rejects(createMetaApiConfigurationLink('server-token', 'account-1'), /could not be verified/);
  } finally { restoreGlobals(); }
});

test('maps unauthorized errors to a safe message without echoing provider response details', async () => {
  process.env.META_API_URL = 'https://metaapi.example.test';
  globalThis.fetch = async () => new Response(JSON.stringify({ message: 'private token detail' }), { status: 401 });
  try {
    await assert.rejects(
      metaApiRequest('server-token', '/users/current/accounts', { unauthorizedMessage: 'Account setup is temporarily unavailable.' }),
      (error) => error.status === 503 && error.message === 'Account setup is temporarily unavailable.' && !error.message.includes('private token detail'),
    );
  } finally { restoreGlobals(); }
});

test('only exposes safe MetaAPI account metadata', () => {
  const safe = toSafeMetaApiAccount({ id: 'account-1', login: '12345', name: 'Demo', platform: 'mt5', state: 'DRAFT', password: 'private' });
  assert.deepEqual(safe, { id: 'account-1', login: '12345', name: 'Demo', platform: 'mt5', state: 'DRAFT', type: '' });
  assert.equal(Object.hasOwn(safe, 'password'), false);
});
