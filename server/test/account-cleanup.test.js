import test from 'node:test';
import assert from 'node:assert/strict';
import { deleteMetaApiAccount, metaApiRequest } from '../services/metaapi.js';
import { createAccountCleanup } from '../services/account-cleanup.js';

const originalFetch = globalThis.fetch;
const originalBaseUrl = process.env.META_API_URL;

function restoreGlobals() {
  globalThis.fetch = originalFetch;
  if (originalBaseUrl === undefined) delete process.env.META_API_URL;
  else process.env.META_API_URL = originalBaseUrl;
}

test('MetaAPI account deletion uses the documented DELETE contract', async () => {
  process.env.META_API_URL = 'https://metaapi.example.test';
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return new Response(null, { status: 204 });
  };
  try {
    const result = await deleteMetaApiAccount('provisioning-token', 'account-1');
    assert.deepEqual(result, { accountId: 'account-1', deleted: true, alreadyMissing: false });
    assert.equal(request.url, 'https://metaapi.example.test/users/current/accounts/account-1');
    assert.equal(request.options.method, 'DELETE');
    assert.equal(request.options.headers['auth-token'], 'provisioning-token');
    assert.equal(request.options.body, undefined);
  } finally { restoreGlobals(); }
});

test('the request allow-list still rejects unrelated MetaAPI writes', async () => {
  process.env.META_API_URL = 'https://metaapi.example.test';
  globalThis.fetch = async () => { throw new Error('must not be called'); };
  try {
    await assert.rejects(metaApiRequest('token', '/users/current/accounts/account-1/deploy', { method: 'POST', body: {} }), /Unsupported MetaAPI request/);
    await assert.rejects(metaApiRequest('token', '/users/current/accounts/account-1', { method: 'DELETE', body: {} }), /Unsupported MetaAPI request/);
    await assert.rejects(metaApiRequest('token', '/users/current/accounts/account-1/configuration-link', { method: 'DELETE' }), /Unsupported MetaAPI request/);
  } finally { restoreGlobals(); }
});

test('an already-removed MetaAPI account is treated as deleted', async () => {
  process.env.META_API_URL = 'https://metaapi.example.test';
  globalThis.fetch = async () => new Response(JSON.stringify({ message: 'Account not found', details: { code: 'E_ACCOUNT_NOT_FOUND' } }), { status: 404 });
  try {
    assert.deepEqual(await deleteMetaApiAccount('token', 'missing-account'), { accountId: 'missing-account', deleted: false, alreadyMissing: true });
  } finally { restoreGlobals(); }
});

test('cleanup removes only workspace-billed accounts and never throws', async () => {
  const removed = [];
  const warnings = [];
  const cleanup = createAccountCleanup({
    removeAccount: async (token, accountId) => {
      removed.push({ token, accountId });
      if (accountId === 'failing') throw Object.assign(new Error('nope'), { metaApiStatus: 500, metaApiErrorCode: 'E_SERVER' });
      if (accountId === 'gone') return { accountId, deleted: false, alreadyMissing: true };
      return { accountId, deleted: true, alreadyMissing: false };
    },
    logger: { warn: (message, extra) => warnings.push({ message, ...extra }) },
  });

  const summary = await cleanup.removeProviderAccounts({
    accounts: [
      { metaapi_account_id: 'managed-1', managed_by_app: true },
      { metaapi_account_id: 'user-owned', managed_by_app: false },
      { metaapi_account_id: 'gone', managed_by_app: true },
      { metaapi_account_id: 'failing', managed_by_app: true },
    ],
    resolveToken: async () => 'provisioning-token',
  });

  assert.deepEqual(removed.map((entry) => entry.accountId), ['managed-1', 'gone', 'failing']);
  assert.equal(summary.total, 4);
  assert.equal(summary.attempted, 3);
  assert.equal(summary.deleted, 1);
  assert.equal(summary.alreadyMissing, 1);
  assert.equal(summary.failed, 1);
  assert.equal(summary.skipped, 1);
  assert.deepEqual(summary.failures, [{ accountId: 'failing', status: 500, code: 'E_SERVER' }]);
  assert.equal(JSON.stringify(summary).includes('provisioning-token'), false);
  assert.equal(warnings.some((entry) => /could not be removed/.test(entry.message)), true);
});

test('cleanup skips accounts when no MetaAPI token is available', async () => {
  let removed = 0;
  const cleanup = createAccountCleanup({
    removeAccount: async () => { removed += 1; return { deleted: true }; },
    logger: { warn: () => {} },
  });

  const noToken = await cleanup.removeProviderAccounts({
    accounts: [{ metaapi_account_id: 'managed-1', managed_by_app: true }],
    resolveToken: () => null,
  });
  assert.equal(noToken.attempted, 0);
  assert.equal(noToken.skipped, 1);
  assert.equal(removed, 0);

  const throwingToken = await cleanup.removeProviderAccounts({
    accounts: [{ metaapi_account_id: 'managed-2', managed_by_app: true }],
    resolveToken: () => { throw new Error('decrypt failed'); },
  });
  assert.equal(throwingToken.attempted, 0);
  assert.equal(throwingToken.skipped, 1);
  assert.equal(removed, 0);
});

test('cleanup can be asked to include user-managed accounts explicitly', async () => {
  const removed = [];
  const cleanup = createAccountCleanup({
    removeAccount: async (_token, accountId) => { removed.push(accountId); return { deleted: true }; },
    logger: { warn: () => {} },
  });
  const summary = await cleanup.removeProviderAccounts({
    accounts: [{ metaapi_account_id: 'user-owned', managed_by_app: false }],
    resolveToken: () => 'user-token',
    includeUserManaged: true,
  });
  assert.deepEqual(removed, ['user-owned']);
  assert.equal(summary.deleted, 1);
});
