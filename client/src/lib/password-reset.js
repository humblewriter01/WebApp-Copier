import { request } from './api.js';
import { supabaseReady } from './supabase.js';

/**
 * The one path to a password reset email.
 *
 * Two surfaces ask for one: the sign-in screen ("Forgot password?") and Profile ("Change password").
 * Both must prepare the request on the API first - `/api/auth/prepare-password-reset` is where the rate
 * limit and the "does this account exist" handling live - and both must hand Supabase the same redirect,
 * because the link it emails is what opens `/update-password`. A second copy of these eight lines is how
 * one of the two ends up silently skipping the prepare call, or pointing the link somewhere the app has
 * no page for.
 */
export const PASSWORD_RESET_UNAVAILABLE = 'Password recovery is temporarily unavailable. Please try again shortly or contact support.';
export const PASSWORD_RESET_FAILED = 'We could not process that reset request right now. Please try again later.';
/** What both surfaces say afterwards, deliberately without confirming that the address exists. */
export const PASSWORD_RESET_SENT = 'If an account exists for that address, a password reset link has been sent. Check your inbox and spam folder.';
export const PASSWORD_RESET_REDIRECT_PATH = '/update-password';

/** Resolves once the email has been accepted by Supabase; throws with a sentence to show the reader. */
export async function sendPasswordResetEmail(email) {
  const normalized = String(email || '').trim().toLowerCase();
  if (!normalized) throw new Error('Enter the email address for your Signal Desk account first.');
  const client = await supabaseReady();
  if (!client) {
    console.error('[password-reset] Supabase browser configuration is missing, so no reset email can be sent.', {
      hint: 'Set VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY in the static-site build environment, and SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY on the API service, then redeploy. GET /api/config must return both values.',
    });
    throw new Error(PASSWORD_RESET_UNAVAILABLE);
  }
  await request('/api/auth/prepare-password-reset', null, { method: 'POST', body: { email: normalized } });
  const { error: resetError } = await client.auth.resetPasswordForEmail(normalized, {
    redirectTo: `${window.location.origin}${PASSWORD_RESET_REDIRECT_PATH}`,
  });
  if (resetError) {
    console.error('[password-reset] Supabase resetPasswordForEmail failed', {
      message: resetError.message,
      status: resetError.status,
      code: resetError.code,
      name: resetError.name,
    });
    throw new Error(PASSWORD_RESET_FAILED);
  }
  return normalized;
}
