import { createClient } from '@supabase/supabase-js';
import { API_URL } from './api.js';

/*
 * The Supabase browser client needs two public values: the project URL and the
 * publishable key. They are normally baked into the bundle at build time from
 * `VITE_SUPABASE_URL` / `VITE_SUPABASE_PUBLISHABLE_KEY`.
 *
 * Static hosts (including Render static sites) only inject those variables into
 * the build that runs *after* they are saved, so a build made without them ships
 * a bundle where `import.meta.env.VITE_SUPABASE_*` is `undefined`. That used to
 * make password recovery fail with "Password recovery is not configured for this
 * workspace yet." even though the variables were set in the dashboard.
 *
 * To remove that build-time coupling, the client now falls back to the public
 * values the API already holds (`GET /api/config`). Both values are public and
 * are already shipped in the frontend bundle, so no secret is exposed.
 */
const buildTimeUrl = String(import.meta.env.VITE_SUPABASE_URL || '').trim();
const buildTimeKey = String(import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || '').trim();

export const supabaseConfigSource = buildTimeUrl && buildTimeKey ? 'build' : 'runtime';

let client = null;
let readyPromise = null;

function createSupabaseClient(url, key) {
  try {
    return createClient(url, key, {
      auth: {
        autoRefreshToken: true,
        persistSession: true,
        detectSessionInUrl: true,
        flowType: 'pkce',
      },
    });
  } catch (error) {
    console.error('[supabase] Could not create the Supabase browser client', {
      message: error?.message,
      urlHost: (() => { try { return new URL(url).host; } catch { return 'invalid'; } })(),
      hasKey: Boolean(key),
    });
    return null;
  }
}

async function loadRuntimeConfig() {
  let response;
  try {
    response = await fetch(`${API_URL}/api/config`, { headers: { Accept: 'application/json' } });
  } catch (error) {
    console.error('[supabase] Runtime configuration request failed', { apiUrl: API_URL, message: error?.message });
    return null;
  }
  if (!response.ok) {
    console.error('[supabase] Runtime configuration request returned an error', { apiUrl: API_URL, status: response.status });
    return null;
  }
  const payload = await response.json().catch(() => null);
  const url = String(payload?.supabaseUrl || '').trim();
  const key = String(payload?.supabasePublishableKey || '').trim();
  if (!url || !key) {
    console.error('[supabase] The API is missing SUPABASE_URL and/or SUPABASE_PUBLISHABLE_KEY', {
      hasSupabaseUrl: Boolean(url),
      hasPublishableKey: Boolean(key),
    });
    return null;
  }
  return { url, key };
}

/**
 * Resolves the Supabase browser client, creating it from the runtime API
 * configuration when the build did not contain the VITE_* values. Every caller
 * must await this before using auth methods.
 */
export function supabaseReady() {
  if (readyPromise) return readyPromise;
  readyPromise = (async () => {
    if (client) return client;
    if (buildTimeUrl && buildTimeKey) {
      client = createSupabaseClient(buildTimeUrl, buildTimeKey);
      return client;
    }

    console.error(
      '[supabase] VITE_SUPABASE_URL and/or VITE_SUPABASE_PUBLISHABLE_KEY were missing from the production build. '
      + 'Falling back to the public runtime configuration from /api/config. Add both variables to the static site '
      + 'build environment and redeploy to remove this fallback.',
      { hasBuildTimeUrl: Boolean(buildTimeUrl), hasBuildTimeKey: Boolean(buildTimeKey) },
    );

    const config = await loadRuntimeConfig();
    if (!config) return null;
    client = createSupabaseClient(config.url, config.key);
    return client;
  })();
  return readyPromise;
}

/** The already-created client, or null when configuration is still unresolved. */
export function getSupabase() {
  return client;
}
