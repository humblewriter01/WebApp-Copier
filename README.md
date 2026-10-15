# Telegram Signal Desk

A deployable MVP for capturing Telegram channel messages, extracting common trade-signal fields, and organizing channel/account/risk notes. The project includes a React/Vite client, Express API, PostgreSQL persistence, password-based accounts, and optional Telegram user-session integration.

## Important scope and safety limits

- **Live broker execution is deliberately disabled.** This app does not submit, modify, or close broker orders. Account entries are reference notes only; never enter broker passwords or trading API secrets.
- Risk settings are planning preferences and do not cause trades.
- Telegram sessions are encrypted in the database with `SESSION_ENCRYPTION_KEY`. Telegram login codes and 2FA passwords are not logged or stored.
- A single-instance, always-on backend is needed for continuous Telegram monitoring. Render's free web services can sleep, so this configuration is for evaluation, not unattended signal monitoring.
- The Render free PostgreSQL plan is suitable for a temporary test deployment only; use a durable paid database plan before storing important account data.
- This software is not financial advice. Review and test all signals independently.

## Stack

- Client: React 18 + Vite
- API: Node.js 18+, Express, Socket.IO
- Persistence: Render PostgreSQL / PostgreSQL 13+
- Telegram client: GramJS (`telegram` npm package)

## Local development

1. Install Node.js 18 or later and PostgreSQL.
2. Create a PostgreSQL database and copy `.env.example` to `server/.env` (or load its values through your shell).
3. Set `DATABASE_URL` and a random `JWT_SECRET` of at least 32 characters.
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

6. Open the Vite URL printed in the client terminal. The API health endpoint is `http://localhost:5000/health`.

Database tables and indexes are created automatically at first server start.

## Render deployment

`render.yaml` describes a Render web service, static site, and PostgreSQL database. The selected deployment uses the `free` plans to avoid creating billable resources; the free database is temporary and the backend can sleep. Upgrade only after selecting a durable production plan.

Required backend variables:

| Variable | Required | Purpose |
|---|---:|---|
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `JWT_SECRET` | Yes | Signs user access tokens; use at least 32 random characters |
| `CLIENT_URL` | Yes in production | Exact frontend origin for CORS |
| `SESSION_ENCRYPTION_KEY` | For Telegram | Encrypts saved Telegram StringSessions; keep stable and secret |
| `API_ID` / `API_HASH` | For Telegram | Telegram application credentials from `my.telegram.org` |
| `PORT` | No | Render supplies this automatically |

The initial UI/API work without Telegram credentials; Telegram login is shown as unavailable until `API_ID` and `API_HASH` are configured. Create and verify Telegram application credentials at [my.telegram.org](https://my.telegram.org). Do not commit real credentials to Git.

## API overview

- `POST /api/auth/register`, `POST /api/auth/login`, `GET /api/auth/me`
- `GET /api/dashboard`
- `GET/POST /api/channels`, `DELETE /api/channels/:id`
- `GET/POST /api/signals`
- `GET/POST /api/accounts`, `DELETE /api/accounts/:id`
- `GET/PUT /api/settings`
- `GET /api/telegram/status`, `POST /api/telegram/request-code`, `POST /api/telegram/verify-code`, `POST /api/telegram/verify-password`, `GET /api/telegram/chats`, `POST /api/telegram/disconnect`
- `GET /health`

Authenticated endpoints require `Authorization: Bearer <token>`.
