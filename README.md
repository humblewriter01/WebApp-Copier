# Telegram Signal Desk

A deployable React/Vite and Express app for capturing Telegram channel messages, extracting common trade-signal fields, and organizing channel, account, and risk notes. The current deployment uses Supabase PostgreSQL and Render for the API and static frontend.

## Features

- Password-based user accounts and a responsive dashboard.
- Installable Chrome PWA with a standalone window and branded launcher icon.
- Optional Telegram user-session integration for monitoring selected channels.
- Signal history and manual signal notes.
- Reference-only account notes.
- **MetaAPI connection:** each signed-in user can securely save their MetaAPI API token, discover existing MT4/MT5 accounts, and link account references to their workspace.
- Risk preferences for planning only.

## Important safety and data notes

- **Live broker execution is disabled.** This application does not submit, modify, or close trading orders. The MetaAPI integration only lists account metadata and verifies/links existing accounts; it does not create or deploy accounts.
- MetaAPI tokens are submitted over HTTPS, encrypted at rest with AES-256-GCM, stored in a private per-user database table, and never returned to the frontend after saving. `SESSION_ENCRYPTION_KEY` is the server-side encryption key; keep it private and stable. Do not send it or an API token in chat or commit it to Git.
- The MetaAPI REST client follows the FX Telegram Copier's provisioning API base URL, `auth-token` request header, 30-second timeout, and strict HTTPS behavior. It intentionally does not include the source bot's order-placement or position-modification functions.
- Telegram sessions are encrypted in the database with the same server encryption key. Rotating that key without re-encrypting existing values will invalidate saved sessions/tokens.
- Render free web services can sleep, so continuous Telegram monitoring is not reliable on the free tier. Use an always-on backend before relying on unattended monitoring.
- The app is not financial advice. Review all signals independently.

## Stack

- Client: React 18 + Vite
- API: Node.js 18+, Express, Socket.IO
- Persistence: Supabase PostgreSQL (or another PostgreSQL 13+ database)
- Telegram client: GramJS (`telegram` npm package)
- MetaAPI access: HTTPS REST API via Node's built-in `fetch`

## Local development

1. Install Node.js 18 or later and PostgreSQL.
2. Copy `.env.example` to `server/.env` (or load the variables through your shell).
3. Set `DATABASE_URL`, a `JWT_SECRET` with at least 32 characters, and a stable `SESSION_ENCRYPTION_KEY`.
4. Install and start the backend:

   ```bash
   cd server
   npm install
   npm run dev
   ```

5. In another terminal, start the frontend:

   ```bash
   cd client
   npm install
   VITE_API_URL=http://localhost:5000 npm run dev
   ```

6. Open the Vite URL printed by the client. The API health endpoint is `http://localhost:5000/health`.

The app creates its PostgreSQL tables and indexes on backend startup. The new `metaapi_credentials` and `metaapi_accounts` tables have row-level security enabled; the backend uses its private database role.

## MetaAPI setup

1. Obtain an API token directly from your MetaAPI account.
2. Sign in to the web app and open **MetaAPI** in the left navigation.
3. Paste the token into the password field and choose **Verify and save token**. The backend validates it by listing your existing accounts, then stores it encrypted for your signed-in user.
4. Link only the accounts you want shown in this workspace. Unlinking removes the app's reference; it does not change the MetaAPI account.

No service-wide `META_API_KEY` is needed. The optional `META_API_URL` only overrides the MetaAPI HTTPS API base URL.

## Backend environment variables

| Variable | Required | Purpose |
|---|---:|---|
| `DATABASE_URL` | Yes | PostgreSQL connection string (Supabase or another PostgreSQL provider) |
| `JWT_SECRET` | Yes | Signs user access tokens; use at least 32 random characters |
| `SESSION_ENCRYPTION_KEY` | Yes | Stable private key for encrypting Telegram sessions and MetaAPI API tokens |
| `CLIENT_URL` | Production | Exact frontend origin for CORS |
| `API_ID` / `API_HASH` | For Telegram | Telegram application credentials from [my.telegram.org](https://my.telegram.org) |
| `META_API_URL` | No | Optional MetaAPI HTTPS base URL override; defaults to `https://mt-provisioning-api-v1.agiliumtrade.ai` |
| `PORT` | No | Render supplies this automatically |

The UI/API can be used without Telegram credentials; Telegram is shown as unavailable until `API_ID` and `API_HASH` are configured. Never commit real credentials to Git.

## Render deployment

The deployed architecture uses two Render services because the frontend is a static site and the API is a Node web service. The API connects to Supabase PostgreSQL through its private `DATABASE_URL`; the Render Blueprint no longer provisions a second Render database. The static site uses `VITE_API_URL` to target the API service.

Required API variables: `DATABASE_URL`, `JWT_SECRET`, `SESSION_ENCRYPTION_KEY`, and `CLIENT_URL`. Add `API_ID` and `API_HASH` only if Telegram integration is enabled. MetaAPI users add their own API token in the authenticated MetaAPI page; it is not a shared Render environment variable.

### Add Telegram API credentials in Render

1. Sign in to [my.telegram.org/apps](https://my.telegram.org/apps), create or open your Telegram application, and copy its **API ID** and **API Hash**.
2. In the Render dashboard, open the **`telegram-copier-api`** web service and go to **Environment**.
3. Add `API_ID` with the numeric ID and `API_HASH` with the hash, then save changes and wait for the API service to redeploy.
4. Do not add these as `VITE_*` frontend variables, commit them to GitHub, or paste the hash into chat.

### Install from Chrome

The static site is served over HTTPS and includes a linked web app manifest, 192×192 and 512×512 icons (including a maskable icon), and standalone display metadata. Open [Telegram Signal Desk](https://telegram-copier-web.onrender.com/) in Chrome. Use Chrome's **Install app** menu item, or the in-app **Install app** button when Chrome exposes it. Chrome may wait for a page interaction and some time on the site before offering its install prompt. On Android, the exact menu wording can vary by Chrome/device version.

## API overview

- `POST /api/auth/register`, `POST /api/auth/login`, `GET /api/auth/me`
- `GET /api/dashboard`
- `GET/POST /api/channels`, `DELETE /api/channels/:id`
- `GET/POST /api/signals`
- `GET/POST /api/accounts`, `DELETE /api/accounts/:id`
- `GET/PUT /api/settings`
- `GET /api/metaapi/status`, `PUT/DELETE /api/metaapi/connection`, `GET /api/metaapi/accounts`, `GET /api/metaapi/linked-accounts`, `POST /api/metaapi/accounts/link`, `DELETE /api/metaapi/accounts/:accountId`
- `GET /api/telegram/status`, `POST /api/telegram/request-code`, `POST /api/telegram/verify-code`, `POST /api/telegram/verify-password`, `GET /api/telegram/chats`, `POST /api/telegram/disconnect`
- `GET /health`

Authenticated endpoints require `Authorization: Bearer <token>`.
