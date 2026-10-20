# Authentication setup

The frontend uses only the Supabase project URL and publishable key. These are configured by the Render Blueprint as `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY`; the publishable key is safe for browser use.

The API needs the same `SUPABASE_URL`, the public `SUPABASE_PUBLISHABLE_KEY` for sign-in verification, and a server-only `SUPABASE_SECRET_KEY`. In Supabase project API keys, use the secret key (or legacy `service_role` key) for `SUPABASE_SECRET_KEY`. Never put this server secret in a `VITE_` variable, frontend bundle, or client-side settings. The Blueprint declares this value as `sync: false`, so it must be entered in the API service environment before recovery and account deletion can work.

In Supabase Dashboard → Authentication → URL Configuration, add these Redirect URLs:

- `https://telegram-copier-web.onrender.com/update-password`
- `http://localhost:5173/update-password` for local development

The production page sends reset emails through `supabase.auth.resetPasswordForEmail()` and uses `supabase.auth.updateUser()` after Supabase returns the recovery session. The API then syncs the new password hash to the existing Signal Desk login. Existing accounts are linked only after a verified recovery session or a safe first-login bridge.
