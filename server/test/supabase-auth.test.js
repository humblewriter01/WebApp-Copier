import test from 'node:test';
import assert from 'node:assert/strict';
import { createSupabaseAuthBridge } from '../services/supabase-auth.js';

function makeFakeAuth({ users = [], signInUser = null, deleteError = null } = {}) {
  const state = { users: [...users], created: [], deleted: [], listCalls: [], lastSignIn: null };
  const admin = {
    auth: {
      admin: {
        async listUsers({ page, perPage }) {
          state.listCalls.push({ page, perPage });
          const start = (page - 1) * perPage;
          return { data: { users: state.users.slice(start, start + perPage) }, error: null };
        },
        async createUser(attributes) {
          const user = { id: `auth-${state.users.length + 1}`, email: attributes.email, user_metadata: attributes.user_metadata };
          state.created.push({ attributes, user });
          state.users.push(user);
          return { data: { user }, error: null };
        },
        async getUserById(id) {
          const user = state.users.find((item) => item.id === id);
          return user ? { data: { user }, error: null } : { data: { user: null }, error: Object.assign(new Error('User not found'), { status: 404 }) };
        },
        async deleteUser(id) {
          state.deleted.push(id);
          return { error: deleteError };
        },
      },
      async getUser(token) {
        return { data: { user: token === 'recovery-token' ? { id: 'auth-1', email: 'person@example.com' } : null }, error: token === 'recovery-token' ? null : new Error('invalid token') };
      },
    },
  };
  const publicClient = {
    auth: {
      async signInWithPassword(credentials) {
        state.lastSignIn = credentials;
        if (!signInUser || credentials.password !== 'correct-password') return { data: {}, error: Object.assign(new Error('Invalid login credentials'), { status: 400 }) };
        return { data: { user: signInUser }, error: null };
      },
      async signOut() { return { error: null }; },
    },
  };
  const createClientImpl = (_url, key) => key === 'secret-key' ? admin : key === 'publishable-key' ? publicClient : null;
  return { state, createClientImpl };
}

const env = { SUPABASE_URL: 'https://project.example.test', SUPABASE_SECRET_KEY: 'secret-key', SUPABASE_PUBLISHABLE_KEY: 'publishable-key' };

test('does not create a registration identity when the server secret is not configured', async () => {
  const bridge = createSupabaseAuthBridge({ env: { SUPABASE_URL: env.SUPABASE_URL }, createClientImpl: () => { throw new Error('must not be called'); } });
  assert.equal(bridge.isAdminConfigured(), false);
  assert.equal(await bridge.createRegistrationIdentity({ email: 'a@example.com', password: 'password123', name: 'A' }), null);
});

test('creates a confirmed Supabase identity for a new registration', async () => {
  const fake = makeFakeAuth();
  const bridge = createSupabaseAuthBridge({ env, createClientImpl: fake.createClientImpl });
  const id = await bridge.createRegistrationIdentity({ email: 'Person@Example.com', password: 'correct-password', name: 'Person' });
  assert.equal(id, 'auth-1');
  assert.equal(fake.state.created[0].attributes.email, 'person@example.com');
  assert.equal(fake.state.created[0].attributes.email_confirm, true);
  assert.equal(fake.state.created[0].attributes.password, 'correct-password');
});

test('does not claim or overwrite an existing Auth identity during legacy login', async () => {
  const fake = makeFakeAuth({ users: [{ id: 'external-id', email: 'person@example.com' }] });
  const bridge = createSupabaseAuthBridge({ env, createClientImpl: fake.createClientImpl });
  const id = await bridge.ensureLegacyLoginIdentity({ email: 'person@example.com', password: 'local-password', name: 'Person' });
  assert.equal(id, null);
  assert.equal(fake.state.created.length, 0);
});

test('prepares a random-password recovery identity without returning its password', async () => {
  const fake = makeFakeAuth();
  const bridge = createSupabaseAuthBridge({ env, createClientImpl: fake.createClientImpl, createRandomPassword: () => 'random-secret-not-returned' });
  const result = await bridge.prepareRecoveryIdentity({ email: 'person@example.com', name: 'Person' });
  assert.deepEqual(result, { id: 'auth-1', created: true, linkable: true });
  assert.equal(fake.state.created[0].attributes.password, 'random-secret-not-returned');
  assert.equal(JSON.stringify(result).includes('random-secret-not-returned'), false);
});

test('does not link a pre-existing Auth identity until its reset session proves ownership', async () => {
  const fake = makeFakeAuth({ users: [{ id: 'existing-id', email: 'person@example.com' }] });
  const bridge = createSupabaseAuthBridge({ env, createClientImpl: fake.createClientImpl });
  const result = await bridge.prepareRecoveryIdentity({ email: 'person@example.com', name: 'Person' });
  assert.deepEqual(result, { id: 'existing-id', created: false, linkable: false });
});

test('replaces a stale identity reference when its Auth user no longer exists', async () => {
  const fake = makeFakeAuth();
  const bridge = createSupabaseAuthBridge({ env, createClientImpl: fake.createClientImpl, createRandomPassword: () => 'fresh-random-secret' });
  const result = await bridge.prepareRecoveryIdentity({ email: 'person@example.com', name: 'Person', currentId: 'deleted-id' });
  assert.deepEqual(result, { id: 'auth-1', created: true, linkable: true });
});

test('validates Supabase recovery access tokens and verifies a password without persisting a browser session', async () => {
  const fake = makeFakeAuth({ signInUser: { id: 'auth-1', email: 'person@example.com' } });
  const bridge = createSupabaseAuthBridge({ env, createClientImpl: fake.createClientImpl });
  assert.equal((await bridge.getUserFromAccessToken('recovery-token')).id, 'auth-1');
  assert.equal(await bridge.getUserFromAccessToken('bad-token'), null);
  assert.deepEqual(await bridge.verifyPassword('Person@Example.com', 'correct-password'), { id: 'auth-1', email: 'person@example.com' });
  assert.deepEqual(fake.state.lastSignIn, { email: 'person@example.com', password: 'correct-password' });
});

test('treats deletion of an already-missing Auth identity as idempotent', async () => {
  const fake = makeFakeAuth({ deleteError: Object.assign(new Error('User not found'), { status: 404 }) });
  const bridge = createSupabaseAuthBridge({ env, createClientImpl: fake.createClientImpl });
  assert.equal(await bridge.deleteAuthUser('missing-id'), false);
  assert.deepEqual(fake.state.deleted, ['missing-id']);
});
