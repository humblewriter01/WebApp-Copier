# Telegram Signal Desk

A deployable React/Vite and Express app for capturing Telegram channel messages, extracting common trade-signal fields, and organizing channel, account, and risk notes. The current deployment uses Supabase PostgreSQL and Render for the API and static frontend.

## Features

- Password-based user accounts and a responsive dashboard.
- Installable Chrome PWA with a standalone window and branded launcher icon.
- Optional Telegram user-session integration for monitoring selected channels.
- Signal history and manual signal notes.
- Reference-only account notes.
- **MT4/MT5 account setup:** signed-in users can create an account setup and enter broker credentials on a MetaAPI-hosted secure page.
- Risk preferences for planning only.

## Important safety and data notes

- **No trading orders are placed.** Signal Desk can create and connect an account through MetaAPI, but it does not submit, modify, or close trades.
- The API uses `METAAPI_PROVISIONING_TOKEN` only on the server. Users enter their broker login and password on MetaAPI's HTTPS setup page; Signal Desk does not receive or store those credentials.
- The MetaAPI client uses HTTPS and an allowlist of account-setup and account-read operations. It does not include order-placement or position-modification functions.
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

## MetaAPI account setup

1. The workspace owner adds a MetaAPI provisioning token to the backend environment as `METAAPI_PROVISIONING_TOKEN`.
2. In Signal Desk, open **Trading Accounts** and enter an account name, MT4/MT5 platform, and the exact broker server name.
3. Signal Desk creates the account setup and returns a secure link hosted by MetaAPI. Enter the trading login and password only on that page. For monitoring, choose an investor/read-only password if your broker offers one.
4. Return to Signal Desk and refresh the account status. Removing an account from Signal Desk removes only its local link; it does not delete the MetaAPI or broker account.

`META_API_URL` is an optional HTTPS base-URL override. Never add `METAAPI_PROVISIONING_TOKEN` to a `VITE_*` variable, frontend code, or Git.

## Backend environment variables

| Variable | Required | Purpose |
|---|---:|---|
| `DATABASE_URL` | Yes | PostgreSQL connection string (Supabase or another PostgreSQL provider) |
| `JWT_SECRET` | Yes | Signs user access tokens; use at least 32 random characters |
| `SESSION_ENCRYPTION_KEY` | Yes | Stable private key for encrypting Telegram sessions and MetaAPI API tokens |
| `CLIENT_URL` | Production | Exact frontend origin for CORS |
| `API_ID` / `API_HASH` | For Telegram | Telegram application credentials from [my.telegram.org](https://my.telegram.org) |
| `METAAPI_PROVISIONING_TOKEN` | For MT4/MT5 setup | Server-only MetaAPI token used to create accounts and secure setup links |
| `META_API_URL` | No | Optional MetaAPI HTTPS base URL override; defaults to `https://mt-provisioning-api-v1.agiliumtrade.agiliumtrade.ai` |
| `PORT` | No | Render supplies this automatically |

The UI/API can be used without Telegram credentials; Telegram is shown as unavailable until `API_ID` and `API_HASH` are configured. Never commit real credentials to Git.

## Render deployment

The deployed architecture uses two Render services because the frontend is a static site and the API is a Node web service. The API connects to Supabase PostgreSQL through its private `DATABASE_URL`; the Render Blueprint no longer provisions a second Render database. The static site uses `VITE_API_URL` to target the API service. Both services are configured to deploy each commit pushed to `main` (`autoDeployTrigger: commit` in `render.yaml`).

Required API variables: `DATABASE_URL`, `JWT_SECRET`, `SESSION_ENCRYPTION_KEY`, and `CLIENT_URL`. Add `API_ID` and `API_HASH` for Telegram sign-in. Add `METAAPI_PROVISIONING_TOKEN` to the API service's Environment settings to enable MT4/MT5 account setup. Keep it out of the static-site environment.

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
- `GET /api/metaapi/provisioning-status`, `GET /api/metaapi/linked-accounts`, `POST /api/metaapi/provisioned-accounts`, `POST /api/metaapi/provisioned-accounts/:accountId/configuration-link`, `POST /api/metaapi/provisioned-accounts/:accountId/refresh`, `DELETE /api/metaapi/accounts/:accountId`
- `GET /api/telegram/status`, `POST /api/telegram/request-code`, `POST /api/telegram/verify-code`, `POST /api/telegram/verify-password`, `GET /api/telegram/chats`, `POST /api/telegram/disconnect`
- `GET /health`

Authenticated endpoints require `Authorization: Bearer <token>`.
