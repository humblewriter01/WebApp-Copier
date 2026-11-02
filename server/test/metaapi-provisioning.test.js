import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createMetaApiProvisionedAccountHandler,
  METAAPI_FUNDING_USER_MESSAGE,
  shouldDeleteMetaApiAccountOnUnlink,
} from '../services/metaapi-provisioning.js';

const CUSTOM_TOKEN = 'byo_metaapi_token_secret_0123456789';

function makeResponse() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    status(code) { this.statusCode = code; return this; },
    set(name, value) { this.headers[name] = value; return this; },
    json(body) { this.body = body; return this; },
  };
}

function makeHandler({
  metaApiRequest = async () => ({ id: 'acct-1', name: 'Demo MT5', platform: 'mt5', state: 'DRAFT' }),
  createConfigurationLink = async () => 'https://app.metaapi.cloud/configure-trading-account-credentials/acct-1/opaque',
  getProvisioningToken = () => 'platform_master_token_0123456789',
  pool = { query: async () => ({ rows: [{ id: 'row-1', metaApiAccountId: 'acct-1' }] }) },
  encryptSecret = (value) => `encrypted:${value}`,
  logs = [],
} = {}) {
  const handler = createMetaApiProvisionedAccountHandler({
    pool,
    getProvisioningToken,
    encryptSecret,
    enforcePlanLimit: async () => {},
    metaApiRequest,
    createConfigurationLink,
    toSafeAccount: (account) => account?.id ? { id: account.id, login: null, name: account.name, platform: account.platform, state: account.state } : null,
    log: (...entry) => logs.push(entry),
  });
  return { handler, logs };
}

const validBody = { name: 'My account', platform: 'mt5', server: 'Broker-Demo' };

test('a 403 funding response returns the friendly API error and logs provider diagnostics without the token', async () => {
  const rawProviderMessage = `Insufficient balance; deposit required. Rejected token ${CUSTOM_TOKEN}`;
  const logs = [];
  const { handler } = makeHandler({
    getProvisioningToken: () => null,
    logs,
    metaApiRequest: async () => {
      const error = new Error(rawProviderMessage);
      Object.assign(error, {
        status: 503,
        metaApiStatus: 403,
        metaApiErrorCode: 'E_INSUFFICIENT_FUNDS',
        metaApiErrorType: 'funding',
        userMessage: rawProviderMessage,
        metaApiRawResponse: JSON.stringify({ details: { message: rawProviderMessage, api_token: CUSTOM_TOKEN } }),
      });
      throw error;
    },
  });
  const res = makeResponse();
  await handler({ userId: 'user-1', body: { ...validBody, metaapi_token: CUSTOM_TOKEN } }, res);

  assert.equal(res.statusCode, 503);
  assert.deepEqual(res.body, { error: METAAPI_FUNDING_USER_MESSAGE });
  assert.equal(JSON.stringify(res.body).includes(CUSTOM_TOKEN), false, 'the token and provider detail never leave in the API response');
  assert.equal(logs.length, 1, 'the provider failure is written to the service log');
  const logged = JSON.stringify(logs[0]);
  assert.match(logged, /Insufficient balance; deposit required/, 'raw provider details are retained internally');
  assert.match(logged, /E_INSUFFICIENT_FUNDS/);
  assert.equal(logged.includes(CUSTOM_TOKEN), false, 'custom MetaAPI tokens are redacted from every logged field');
});

test('the custom MetaAPI token provisions and configures the account and is encrypted per account', async () => {
  const providerCalls = [];
  const queryCalls = [];
  const { handler } = makeHandler({
    pool: { query: async (sql, params) => {
      queryCalls.push({ sql, params });
      return { rows: [{ id: 'row-1', metaApiAccountId: 'acct-1', managedByApp: false, hasCustomMetaApiToken: true }] };
    } },
    metaApiRequest: async (token, endpoint, options) => {
      providerCalls.push({ token, endpoint, options });
      return { id: 'acct-1', name: 'My account', platform: 'mt5', state: 'DRAFT' };
    },
    createConfigurationLink: async (token, accountId) => {
      providerCalls.push({ token, endpoint: 'configuration-link', accountId });
      return 'https://app.metaapi.cloud/configure-trading-account-credentials/acct-1/opaque';
    },
  });
  const res = makeResponse();
  await handler({ userId: 'user-1', body: { ...validBody, metaapi_token: CUSTOM_TOKEN } }, res);

  assert.equal(res.statusCode, 201);
  assert.equal(providerCalls[0].token, CUSTOM_TOKEN, 'the custom token reaches account provisioning instead of the master token');
  assert.equal(providerCalls[1].token, CUSTOM_TOKEN, 'the same token creates the secure setup link');
  assert.equal(providerCalls[0].options.body.password, undefined, 'broker credentials remain on MetaAPI');
  assert.equal(queryCalls.length, 1);
  assert.match(queryCalls[0].sql, /managed_by_app,encrypted_api_token/);
  assert.equal(queryCalls[0].params[7], false, 'BYO accounts are not billed to the platform');
  assert.equal(queryCalls[0].params[8], `encrypted:${CUSTOM_TOKEN}`, 'the token is encrypted before persistence');
  assert.equal(JSON.stringify(res.body).includes(CUSTOM_TOKEN), false, 'the API never returns the supplied token');
});

test('the platform master token remains the default when no custom token is supplied', async () => {
  const providerTokens = [];
  const queryCalls = [];
  const { handler } = makeHandler({
    pool: { query: async (_sql, params) => { queryCalls.push(params); return { rows: [{ id: 'row-1' }] }; } },
    metaApiRequest: async (token) => { providerTokens.push(token); return { id: 'acct-1', state: 'DRAFT' }; },
    createConfigurationLink: async (token) => { providerTokens.push(token); return 'https://app.metaapi.cloud/configure-trading-account-credentials/acct-1/opaque'; },
  });
  const res = makeResponse();
  await handler({ userId: 'user-1', body: validBody }, res);

  assert.equal(res.statusCode, 201);
  assert.deepEqual(providerTokens, ['platform_master_token_0123456789', 'platform_master_token_0123456789']);
  assert.equal(queryCalls[0][7], true, 'platform-provisioned accounts remain marked as platform-billed');
  assert.equal(queryCalls[0][8], null, 'the platform secret is not copied into per-account storage');
});

test('unlinking a BYO-token account is local-only, while platform-billed accounts may be deleted upstream', () => {
  assert.equal(shouldDeleteMetaApiAccountOnUnlink({ managed_by_app: false, encrypted_api_token: 'ciphertext' }), false);
  assert.equal(shouldDeleteMetaApiAccountOnUnlink({ managedByApp: false, hasCustomMetaApiToken: true }), false);
  assert.equal(shouldDeleteMetaApiAccountOnUnlink({ managed_by_app: true }), true);
});
