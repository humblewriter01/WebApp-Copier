# Authentication setup

The frontend uses only the Supabase project URL and publishable key. These are configured by the Render Blueprint as `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY`; the publishable key is safe for browser use.

Static-site variables are applied at build time, so a build made before they were saved contains no Supabase configuration. The client now falls back to `GET /api/config`, which returns the API's own `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY`, and logs the exact reason to the browser console. Redeploy the static site after changing either value so the fallback is not needed.

The API needs the same `SUPABASE_URL`, the public `SUPABASE_PUBLISHABLE_KEY` for sign-in verification, and a server-only `SUPABASE_SECRET_KEY`. In Supabase project API keys, use the secret key (or legacy `service_role` key) for `SUPABASE_SECRET_KEY`. Never put this server secret in a `VITE_` variable, frontend bundle, or client-side settings. The Blueprint declares this value as `sync: false`, so it must be entered in the API service environment before recovery and account deletion can work.

In Supabase Dashboard → Authentication → URL Configuration, add these Redirect URLs:

- `https://telegram-copier-web.onrender.com/update-password`
- `http://localhost:5173/update-password` for local development

The production page sends reset emails through `supabase.auth.resetPasswordForEmail()` and uses `supabase.auth.updateUser()` after Supabase returns the recovery session. The API then syncs the new password hash to the existing Signal Desk login. Existing accounts are linked only after a verified recovery session or a safe first-login bridge.

Both the sign-in and update-password screens log the real Supabase failure (`message`, `status`, `code`) with `console.error` before showing the friendly fallback, so a misconfigured project, redirect URL, or email provider is visible in the browser console.
