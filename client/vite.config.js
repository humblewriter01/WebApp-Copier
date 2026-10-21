import { defineConfig, loadEnv } from 'vite';

/**
 * Warns in the build log when the public Supabase browser configuration is not
 * available at build time. The app still works in that case (it reads the same
 * public values from `GET /api/config`), but seeing the warning here makes a
 * missing Render static-site variable obvious.
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  const missing = ['VITE_SUPABASE_URL', 'VITE_SUPABASE_PUBLISHABLE_KEY']
    .filter((key) => !String(env[key] || '').trim());

  if (missing.length) {
    console.warn(
      `[signal-desk] ${missing.join(' and ')} missing from this build environment. `
      + 'Password recovery will fall back to the public runtime configuration from GET /api/config. '
      + 'Add both variables to the static site build environment and redeploy to bundle them.',
    );
  }

  return {
    build: {
      // Keep the existing behaviour: emit assets under /assets and no source maps.
      sourcemap: false,
    },
  };
});
