import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

function safeConfigError() {
  const error = new Error('Supabase Auth server credentials are not configured.');
  error.status = 503;
  error.code = 'SUPABASE_AUTH_NOT_CONFIGURED';
  return error;
}

function isMissingUserError(error) {
  return error?.status === 404
    || error?.code === 'user_not_found'
    || /user.{0,20}not found|not found.{0,20}user/i.test(String(error?.message || ''));
}

function isDuplicateUserError(error) {
  return error?.code === 'email_exists'
    || error?.code === 'user_already_exists'
    || /already registered|already exists|email.{0,20}exists/i.test(String(error?.message || ''));
}

export function createSupabaseAuthBridge({
  env = process.env,
  createClientImpl = createClient,
  createRandomPassword = () => crypto.randomBytes(32).toString('base64url'),
} = {}) {
  let adminClient;
  const url = String(env.SUPABASE_URL || '').trim();
  const secretKey = String(env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  const publishableKey = String(env.SUPABASE_PUBLISHABLE_KEY || '').trim();

  const isAdminConfigured = () => Boolean(url && secretKey);
  const isPublicConfigured = () => Boolean(url && publishableKey);

  function admin() {
    if (!isAdminConfigured()) throw safeConfigError();
    if (!adminClient) {
      adminClient = createClientImpl(url, secretKey, {
        auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
      });
    }
    return adminClient;
  }

  async function findUserByEmail(email) {
    const normalizedEmail = String(email || '').trim().toLowerCase();
    if (!normalizedEmail) return null;
    for (let page = 1; page <= 100; page += 1) {
      const { data, error } = await admin().auth.admin.listUsers({ page, perPage: 100 });
      if (error) throw error;
      const users = data?.users || [];
      const match = users.find((user) => String(user.email || '').toLowerCase() === normalizedEmail);
      if (match) return match;
      if (users.length < 100) return null;
    }
    throw new Error('Supabase Auth user lookup reached its safety limit.');
  }

  async function createAuthUser({ email, password, name }) {
    const { data, error } = await admin().auth.admin.createUser({
      email: String(email).trim().toLowerCase(),
      password,
      email_confirm: true,
      user_metadata: name ? { name: String(name).slice(0, 100) } : {},
    });
    if (error) throw error;
    if (!data?.user?.id) throw new Error('Supabase Auth did not return a user ID.');
    return data.user;
  }

  async function findUserById(userId) {
    const { data, error } = await admin().auth.admin.getUserById(userId);
    if (error) {
      if (isMissingUserError(error)) return null;
      throw error;
    }
    return data?.user || null;
  }

  async function createRegistrationIdentity({ email, password, name }) {
    if (!isAdminConfigured()) return null;
    const existing = await findUserByEmail(email);
    if (existing) {
      const error = new Error('An account with that email already exists.');
      error.status = 409;
      error.code = 'AUTH_EMAIL_EXISTS';
      throw error;
    }
    try {
      return (await createAuthUser({ email, password, name })).id;
    } catch (error) {
      if (isDuplicateUserError(error)) {
        const conflict = new Error('An account with that email already exists.');
        conflict.status = 409;
        conflict.code = 'AUTH_EMAIL_EXISTS';
        throw conflict;
      }
      throw error;
    }
  }

  async function ensureLegacyLoginIdentity({ email, password, name, currentId }) {
    if (!isAdminConfigured()) return null;
    if (currentId) return currentId;
    const existing = await findUserByEmail(email);
    // Do not claim or overwrite an Auth identity discovered only by email.
    // A completed recovery flow links it after validating its access token.
    if (existing) return null;
    try {
      return (await createAuthUser({ email, password, name })).id;
    } catch (error) {
      if (isDuplicateUserError(error)) return null;
      throw error;
    }
  }

  async function prepareRecoveryIdentity({ email, name, currentId }) {
    if (!isAdminConfigured()) throw safeConfigError();
    if (currentId) {
      const currentUser = await findUserById(currentId);
      if (currentUser) return { id: currentUser.id, created: false, linkable: true };
    }
    const existing = await findUserByEmail(email);
    if (existing) return { id: existing.id, created: false, linkable: false };
    try {
      const user = await createAuthUser({ email, name, password: createRandomPassword() });
      return { id: user.id, created: true, linkable: true };
    } catch (error) {
      if (isDuplicateUserError(error)) {
        const racedUser = await findUserByEmail(email);
        if (racedUser) return { id: racedUser.id, created: false, linkable: false };
      }
      throw error;
    }
  }

  async function getUserFromAccessToken(accessToken) {
    if (!String(accessToken || '').trim()) return null;
    const { data, error } = await admin().auth.getUser(accessToken);
    if (error) return null;
    return data?.user || null;
  }

  async function verifyPassword(email, password) {
    if (!isPublicConfigured()) return null;
    const client = createClientImpl(url, publishableKey, {
      auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    });
    const { data, error } = await client.auth.signInWithPassword({
      email: String(email || '').trim().toLowerCase(),
      password: String(password || ''),
    });
    if (error) {
      if (Number(error.status) === 400 || /invalid login credentials/i.test(error.message || '')) return null;
      throw error;
    }
    const user = data?.user;
    await client.auth.signOut({ scope: 'local' }).catch(() => {});
    return user?.id ? { id: user.id, email: user.email } : null;
  }

  async function deleteAuthUser(userId) {
    if (!userId) return false;
    const { error } = await admin().auth.admin.deleteUser(userId, false);
    if (!error) return true;
    if (isMissingUserError(error)) return false;
    throw error;
  }

  return Object.freeze({
    isAdminConfigured,
    isPublicConfigured,
    findUserByEmail,
    findUserById,
    createRegistrationIdentity,
    ensureLegacyLoginIdentity,
    prepareRecoveryIdentity,
    getUserFromAccessToken,
    verifyPassword,
    deleteAuthUser,
  });
}
