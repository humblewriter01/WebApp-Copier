# Telegram Signal Desk

A deployable React/Vite and Express app for capturing Telegram channel messages, extracting common trade-signal fields, and organizing channel, account, and risk notes. The current deployment uses Supabase PostgreSQL and Render for the API and static frontend.

## Features

- Password-based user accounts and a responsive dashboard.
- Installable Chrome PWA with a standalone window and branded launcher icon.
- Optional Telegram user-session integration for monitoring selected channels.
- Signal history and manual signal notes.
- Reference-only account notes.
- **MT4/MT5 account setup:** signed-in users can create an account setup and enter broker credentials on a MetaAPI-hosted secure page.
- **Admin panel:** workspace administrators get a `/admin` dashboard with user totals, user management (roles, suspension), promo-code creation, and billing activity.
- **Paystack subscriptions:** a free review-only tier plus Starter, Pro, and Premium plans, with a hosted Paystack checkout, promo codes, verified webhooks, plan-based limits the server enforces, and automatic renewal through Paystack Plan Codes that are kept in step with the price an admin saves.
- **Optional Auto-Trading:** a user can let clearly parsed Telegram signals place market orders on their own connected MT4/MT5 account, behind a chain of safety gates (see [Auto-Trading and break even](#auto-trading-and-break-even)).
- **Break-even stop moves:** the stop of a trade Signal Desk opened is moved to the entry price (plus an optional offset) once the market has travelled the configured distance in favour of the trade.

## Important safety and data notes

- **Live orders are only ever placed for a user who switched Auto-Trading on.** Every new workspace starts with the setting on so the feature is usable immediately, but nothing is submitted until that user also selects an owned, deployed trading account, is on a paid plan, and every safety gate passes. Turning Auto-Trading off is immediate and stops *all* writes to the broker, including break-even stop moves.
- Signal Desk never closes or partially closes a position and never widens a stop loss. It places market orders and, when break even is enabled, moves the stop of a position it opened itself to a price that reduces risk.
- An ambiguous broker or network failure on an order or a stop move is recorded as `unknown` and is **not** retried automatically, because the broker may already have accepted the first request. The activity list says so; reconcile that position on the broker account.
- The API uses `METAAPI_PROVISIONING_TOKEN` only on the server. Users enter their broker login and password on MetaAPI's HTTPS setup page; Signal Desk does not receive or store those credentials.
- The MetaAPI client uses HTTPS and is limited to the operations above: account setup, account reads, market order submission, and stop-loss modification for break even. Trading credentials stay server-side.
- Deleting a Signal Desk account removes that user's Supabase Auth identity, local workspace data, and every MetaAPI trading account this workspace provisioned, so MetaAPI billing for those accounts stops. Accounts a user linked with their own MetaAPI token are left untouched. Unlinking a single account from the Trading Accounts page also deletes it from MetaAPI (same cleanup path); accounts billed to a user's own MetaAPI token are only unlinked.
- An MT4/MT5 account this workspace provisioned is deleted from MetaAPI after 30 days without a sign-in, settings change, or executed signal, so an abandoned account stops being billed. A user on a paid plan is exempt, an account still holding a position or pending order is left alone, and nothing is deleted when the position state cannot be read. See **Idle account cleanup**.
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
4. Return to Signal Desk and refresh the account status. Removing an account you created here deletes it from MetaAPI as well, so provider billing stops; your broker account and any open positions are unaffected. Accounts linked with your own MetaAPI token are only unlinked from Signal Desk.

`META_API_URL` is an optional HTTPS base-URL override. Never add `METAAPI_PROVISIONING_TOKEN` to a `VITE_*` variable, frontend code, or Git.

## Idle account cleanup

A provisioned MetaAPI account keeps billing this workspace for as long as it exists, so an account nobody has used for a month is removed. This is the whole policy, implemented in `server/services/inactivity.js`:

- **Accounts always stay deployed.** Signal Desk never sleeps, wakes, or undeploys an account, because a wake-up would delay execution. The only destructive action is deletion after 30 idle days.
- **The clock is `users.last_active_at`**, refreshed when the user signs in, saves Execution Settings, or has a signal executed. It is read as an age rather than compared with a calendar day, so a service that was asleep or restarted catches up on its next sweep instead of missing its window.
- **Day 25** records a warning notice containing the account name, the days idle, and the days remaining, asking the user to log in. Each idle spell is warned about once; signing in re-arms it.
- **Day 30** deletes the account through MetaAPI (`DELETE /users/current/accounts/:id`), removes the local link, and turns Auto-Trading off for a workspace whose selected execution account disappeared.
- **Two rules outrank the schedule.** A user whose subscription is `active` or `non_renewing` is exempt, because they are paying for the account. And an account whose synchronized state still shows an open position or pending order is *deferred* rather than deleted, so a trade is never stranded with nobody able to close it; the reason is shown to the user and retried on a later sweep.
- **Nothing is destroyed on a guess.** If the position state cannot be read the sweep fails closed and waits. If MetaAPI refuses the deletion the local row is kept so a later sweep can retry, and after ten failed attempts the account is marked `failed` with a notice telling the user to remove it manually rather than looping forever. Each account is handled in its own `try`, so one provider outage cannot take the job down and the workspace is never left with a still-billed account no retry path can reach.

Notices live in `account_activity_notices` (RLS-enabled, user-scoped) and are surfaced in-app as a banner on **Trading Accounts**, under the policy note beside the add-account form. This project has no email transport, so the in-app banner is the delivery channel and `warningText()` is the single seam a later email sender would reuse. The sweep runs at startup and every six hours, `INACTIVITY_SWEEP_LIMIT` accounts per pass, oldest first, and `INACTIVITY_WARNING_DAYS` / `INACTIVITY_DELETION_DAYS` move the thresholds (`INACTIVITY_CLEANUP_ENABLED=false` turns the job off); warnings and deletions are logged with user and account ids and never with tokens.

## Auto-Trading and break even

Automatic execution is opt-in per workspace and lives in **Risk settings → Execution Settings**. The red warning above the toggle is required copy; the toggle saves on click so switching it off never waits for a form submit.

Before an order is submitted the engine re-reads its inputs and fails closed on anything missing: the user's current Auto-Trading setting, the server-side `AUTO_TRADING_RUNTIME_ENABLED` switch, ownership and `DEPLOYED` state of the selected account, signal age (two minutes), synchronized positions/pending orders, the open-trade and daily-trade caps, the UTC-day equity baseline for the daily loss limit, a fresh valid quote, a stop loss on the correct side of that quote, and the broker's own minimum, maximum, and volume step. A signal with an entry price is only executed when the current quote is not worse than that entry for the signal's direction. The record is written to `trades` *before* the SDK call with a stable `clientId`, so a replay cannot duplicate an order.

**Break even** extends the same loop instead of adding a second one. For each executed trade whose broker position is still open, once the market has travelled `breakEvenTriggerPoints` in favour of the trade, the stop is moved to the entry price plus `breakEvenOffsetPoints` — an offset is how you cover spread and commission instead of parking the stop exactly where the quote touches it.

- Distances are MetaTrader **points**, aligned onto the symbol's `tickSize`; a buy rounds down and a sell rounds up, so the stop never lands beyond the intended price. On most FX pairs 10 points is one pip.
- Only positions Signal Desk opened are considered; trades placed in the terminal keep their own stops.
- A stop is only moved in the direction that reduces risk. If the existing stop is already at least that protective, the position is marked handled and nothing is sent.
- The broker's `stopsLevel` and `freezeLevel` are respected. When the break-even price sits inside the minimum stop distance, the move is *deferred* and retried as the price travels further, rather than failing.
- Every decision needs a fresh synchronized quote and symbol specification; missing or stale safety data means no request.
- Results are persisted per broker position in `break_even_moves` with the status `moved`, `already_beyond`, `closed`, `deferred`, `failed`, or `unknown`, the previous and new stop, the quote used, and the sanitized provider message. A terminal status is never retried. Deferrals retry on their own clock (15 seconds while the price is too close, 60 seconds when account data could not be read) without consuming an attempt, a broker rejection retries up to ten times, and `unknown` never retries. Changing either distance re-arms positions that were already handled, because the stored row keeps the settings it was decided under.
- Moves run only while the execution runtime is available, Auto-Trading is on, **and** the user is on a paid plan, so "off" — or a lapsed subscription — always means "Signal Desk is not talking to your broker".

The sweep shares the worker's polling loop, and an order always goes first, so protecting an open position can never delay a fresh signal. A busy stream of signals cannot starve protection either: every fifth iteration also attempts a sweep. `BREAK_EVEN_SWEEP_INTERVAL_MS` throttles the sweep itself (default `5000` ms, floor `1000`), so calling it often costs nothing. No test or deployment path places a live order: the broker adapter is always faked.

## Paystack billing

Signal Desk sells a free tier and three paid plans. Every price, limit, and label comes from `PLAN_DEFINITIONS` and `FREE_PLAN` in `server/services/billing.js`, and the amount charged is always computed on the server, so a modified browser request can never change the charge. Nothing else needs to know how many paid plans exist — pricing storage, Paystack plan synchronisation, the Billing page, and the Admin Panel all iterate over that catalogue.

| Plan | Default price | Trading accounts | Telegram channels | Signals/day |
|---|---|---:|---:|---:|
| Free | ₦0 | none (review only) | 1 | 50 |
| Starter | ₦60,000 / month | 1 | 10 | 200 |
| Pro | ₦105,000 / month | 3 | 50 | 500 |
| Premium | ₦150,000 / month | 5 | 100 | 2,000 |

The paid prices are set against what a MetaAPI account costs this workspace each month, so one automated account is the cheapest paid tier and every step up pays for more accounts and more traffic. **Free cannot execute at all**, which is enforced in two places rather than one: `maxTradingAccounts: 0` blocks a new link, and the execution worker plus the Auto-Trading and Break-even switches require a paid subscription — so a workspace that connected an account while it was paying and later lapsed still cannot place orders.

A limit of `0` is a real limit, not "unset": it survives the `plan_limits` snapshot, and the error says the tier does not include that thing rather than announcing a zero allowance. For any plan the catalogue still lists, the deployed definition outranks the snapshot stored at purchase, so re-pricing or re-limiting a tier cannot leave existing subscribers on allowances nobody advertises; a snapshot only carries a retired plan key.

**Prices are data, not configuration.** An administrator sets the active Starter, Pro, and Premium prices in the Admin Panel (Pricing & Plans), and they are stored in the `admin_settings` table under the keys `starter_price`, `pro_price`, and `premium_price`, each with a short change history and the identity of whoever saved it. The environment variables below are only the fallback used while no price has been saved (and a saved price can be cleared to return to it). Every read order is the same: database first, then `PAYSTACK_PLAN_*_AMOUNT`.

Checkout flow:

1. `POST /api/billing/checkout` recalculates the price from the active (database) price, applies any promo code, creates a `pending` row in `billing_transactions`, then calls Paystack's `POST /transaction/initialize` with that amount and a server-generated reference. When the price is undiscounted and its Paystack Plan Code is confirmed to hold exactly that amount, the request also carries `plan`, which lets Paystack renew the customer automatically.
2. The browser is redirected to the `authorization_url` Paystack returns. Card details are only ever entered on Paystack.
3. Paystack redirects back to `/billing/callback?reference=…`. The page calls `GET /api/billing/verify`, which re-verifies with `GET /transaction/verify/:reference` before granting anything.
4. Paystack also sends events to `POST /api/billing/webhook`: `charge.success` for first payments, and `invoice.create`, `invoice.update`, `invoice.payment_failed`, `subscription.create`, `subscription.enable`, `subscription.not_renew`, `subscription.disable` for the renewal cycle. The handler verifies the `x-paystack-signature` header (HMAC SHA512 of the raw request body using `PAYSTACK_SECRET_KEY`) and ignores everything else.

Both paths share one fulfilment routine: the transaction is marked `success` once, the amount and currency must match the stored row, the user's plan and `plan_limits` are updated, and the promo code's `current_uses` is incremented. Replays are idempotent because the update is conditional on the row not already being `success`.

Recurring billing is driven by Paystack Plan Codes, one per paid plan, kept on the server only (`admin_settings` key `paystack_plan_starter` / `paystack_plan_pro` / `paystack_plan_premium`, with the plan code, plan id, amount, currency, interval, and last sync result). `cancel` marks `cancel_at_period_end` (access continues until the period ends) and Paystack is asked to stop renewing; `resume` re-enables the Paystack subscription and clears the flag. A paid `invoice.update` extends the period from `max(now, current_period_end)` and records a `billing_transactions` row with `source = 'renewal'`; because renewal invoices reuse no local reference, idempotency is keyed on the Paystack `INV_…` invoice code, so a replayed webhook changes nothing. `invoice.payment_failed` sets `past_due` (access continues), and a completed or cancelled subscription keeps its access until the period ends and is then downgraded. An hourly sweep downgrades anyone whose period has passed back to the Free limits.

### Keeping the Plan Code in step with the price

A Paystack plan's amount overrides the amount in `transaction/initialize`, so a stale plan price would silently charge the old figure. Saving a price therefore synchronises the plan immediately (`server/services/plan-sync.js`):

| Situation | Call | Result |
|---|---|---|
| No plan code yet | `POST /plan` with `name`, `amount`, `interval`, currency | `synced`, the returned `PLN_…` code is stored |
| Code exists, amount and interval already match | none | `in_sync` (no write, no churn) |
| Code exists, amount differs | `PUT /plan/:code` with `update_existing_subscriptions` | `synced`, plus the "n subscription(s) affected" count read from the response message |
| Paystack no longer knows the code | `POST /plan` after the failed `GET /plan/:code` | `synced` with a fresh code |

`PUT /plan` returns no body, so every write is followed by a `GET /plan/:code` and the amount, currency, and interval are compared with what this workspace charges. Only a match marks the plan `usable`; any mismatch, provider error, or network error is stored as `failed` with the message shown in the Admin Panel. Because the amount is verified, a failed sync cannot over- or under-charge: the plan code simply stops being sent and checkout continues as a one-time charge at the saved price, and **Re-sync** in the panel repairs it. Cancelling a price (clearing the input) restores the deployed default and re-syncs. Automatic renewal can also be switched off globally (`recurringEnabled`), which stops plan codes being sent without touching the stored prices, and `updateExistingSubscriptions` decides whether a price change moves subscribers who are already on a plan.

Every plan boundary is a server check. `server/services/plan-limits.js` resolves the effective limits for a user and the routes that create resources call `enforcePlanLimit` before writing: adding a monitored channel and connecting a trading account both answer `402` with `code: PLAN_LIMIT_REACHED` and `upgradeRequired: true`, which the frontend uses to route the visitor to the Billing page. `maxDailySignals` is counted per UTC day against `signals`, and an over-limit user keeps read access to everything already stored.

Billing settings and prices are read and written through `GET`/`PUT /api/admin/pricing` and `POST /api/admin/pricing/sync`, all admin-only; plan codes and sync state never leave the server, and `GET /api/billing/plans` only returns names, amounts, intervals, limits, and whether the plan currently renews automatically.

Configure in Render → API service → Environment:

| Variable | Required | Purpose |
|---|---:|---|
| `PAYSTACK_SECRET_KEY` | Yes | Server-only key used for initialize, verify, and webhook signatures. Never expose it to the browser. |
| `PAYSTACK_CURRENCY` | No | Defaults to `NGN`. |
| `PAYSTACK_PLAN_STARTER_AMOUNT` / `PAYSTACK_PLAN_PRO_AMOUNT` / `PAYSTACK_PLAN_PREMIUM_AMOUNT` | No | Fallback price in the smallest currency unit (kobo), used only while no price is saved in `admin_settings`. Defaults `6000000`, `10500000`, and `15000000`. |
| `PAYSTACK_PLAN_INTERVAL` | No | Billing interval for created plans: `monthly` (default), `annually`, `quarterly`, or `biannually`. |
| `PAYSTACK_API_URL` | No | HTTPS base URL override; defaults to `https://api.paystack.co`. |

Then add the webhook URL in the Paystack dashboard (Settings → API Keys & Webhooks), in the same mode as the key (test or live): `https://<api-service-host>/api/billing/webhook`, with `charge.success` and the `invoice.*` and `subscription.*` events above enabled (renewals and cancellations arrive through them). The callback URL is derived from `CLIENT_URL`, so that variable must be the exact public frontend origin.

## Admin panel

Administrators see an **Admin Panel** entry in the sidebar and can open it directly at `/admin`. The route is protected twice: the frontend only renders the panel for an `admin` role, and every `/api/admin/*` endpoint re-reads the caller's role from PostgreSQL on each request (a non-admin receives HTTP 403, a signed-out caller HTTP 401).

Admin access comes from `ADMIN_EMAILS` (comma-separated). The original workspace owner address is always included, and startup promotes those addresses to `role = 'admin'`. Promote or demote any other user from the Admin Panel itself.

The panel provides:

- Dashboard totals: total users, administrators, suspended users, new sign-ups (7/30 days), promo codes, linked trading accounts, signals, and trades.
- User management table: search by name or email, change role, suspend with a required reason, and restore access. An admin cannot demote or suspend their own account.
- Pricing & Plans: the active Starter, Pro, and Premium prices, how many subscribers a change would affect, whether each plan's Paystack plan is in sync (with its `PLN_…` code and last error), the per-plan price history, the two recurring-billing switches, a "Re-sync all plans with Paystack" action, and the promo-code creator: code, percentage or fixed discount, optional maximum uses, and optional expiry. Existing codes can be paused, re-activated, or deleted. Codes are applied at Paystack checkout, and their `current_uses` increment only after a verified payment.
- Billing activity: active subscriptions, successful and pending payments, gross collected, discounts given, and the latest customer transactions.

Suspension blocks new sign-ins with the stored reason. Existing JWT sessions on other devices remain valid until they expire (12 hours, or 30 days with "keep me signed in"), so revoke a role or suspend an account knowing that short window.

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
| `SUPABASE_URL` | For recovery | Supabase project URL (public); also served to the browser by `GET /api/config` |
| `SUPABASE_PUBLISHABLE_KEY` | For recovery | Supabase publishable key (public); also served by `GET /api/config` |
| `SUPABASE_SECRET_KEY` | For recovery | Server-only Supabase secret/service-role key used for Auth admin operations |
| `ADMIN_EMAILS` | No | Comma-separated addresses that always hold the admin role |
| `PAYSTACK_SECRET_KEY` | For billing | Server-only Paystack key for checkout, verification, and webhook signatures |
| `PAYSTACK_CURRENCY` | No | Billing currency; defaults to `NGN` |
| `PAYSTACK_PLAN_STARTER_AMOUNT` / `PAYSTACK_PLAN_PRO_AMOUNT` / `PAYSTACK_PLAN_PREMIUM_AMOUNT` | No | Fallback plan prices in kobo; the Admin Panel can override them at runtime |
| `PAYSTACK_PLAN_INTERVAL` | No | Interval for Paystack plans; defaults to `monthly` |
| `AUTO_TRADING_RUNTIME_ENABLED` | No | `true` enables the MetaAPI execution runtime (orders and break-even stop moves) |
| `BREAK_EVEN_SWEEP_INTERVAL_MS` | No | Milliseconds between break-even sweeps; defaults to `5000` and never runs faster than every `1000` |
| `INACTIVITY_CLEANUP_ENABLED` | No | `false` stops the idle-account sweep entirely; defaults to `true` |
| `INACTIVITY_WARNING_DAYS` / `INACTIVITY_DELETION_DAYS` | No | Idle-account thresholds in days; default to `25` and `30`, and a pair where deletion does not come after the warning falls back to both defaults |
| `INACTIVITY_SWEEP_LIMIT` | No | Accounts examined per sweep pass, oldest first; defaults to `25` |
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

- `GET /api/config` – public Supabase URL/publishable key for the browser
- `POST /api/auth/register`, `POST /api/auth/login`, `GET /api/auth/me`
- `POST /api/auth/prepare-password-reset`, `POST /api/auth/sync-password`, `DELETE /api/auth/account`
- `GET /api/admin/overview`, `GET /api/admin/users`, `PATCH /api/admin/users/:id`
- `GET/POST /api/admin/promo-codes`, `PATCH/DELETE /api/admin/promo-codes/:id`, `GET /api/admin/billing`
- `GET/PUT /api/admin/pricing`, `POST /api/admin/pricing/sync` – admin-only plan prices, recurring-billing settings, and Paystack Plan Code synchronisation
- `GET /api/billing/plans` – public plan catalogue
- `GET /api/billing/subscription`, `GET /api/billing/quote`, `POST /api/billing/checkout`, `GET /api/billing/verify`, `POST /api/billing/cancel`, `POST /api/billing/resume`
- `POST /api/billing/webhook` – Paystack callback, authenticated by signature only
- `GET /api/dashboard`
- `GET/POST /api/channels`, `DELETE /api/channels/:id`
- `GET/POST /api/signals`
- `GET/POST /api/accounts`, `DELETE /api/accounts/:id`
- `GET/PUT /api/settings` – risk limits, lot sizing, selected execution account, and break-even trigger/offset
- `GET /api/trades` – execution activity, including the break-even outcome for each position
- `GET /api/metaapi/provisioning-status`, `GET /api/metaapi/linked-accounts` (each account also carries its idle age and warning state, plus the workspace's inactivity policy), `POST /api/metaapi/provisioned-accounts`, `POST /api/metaapi/provisioned-accounts/:accountId/configuration-link`, `POST /api/metaapi/provisioned-accounts/:accountId/refresh`, `DELETE /api/metaapi/accounts/:accountId`
- `GET /api/telegram/status`, `POST /api/telegram/request-code`, `POST /api/telegram/verify-code`, `POST /api/telegram/verify-password`, `GET /api/telegram/chats`, `POST /api/telegram/disconnect`
- `GET /health`

Authenticated endpoints require `Authorization: Bearer <token>`. Every `/api/admin/*` endpoint additionally requires the caller's current database role to be `admin`.

## Password recovery configuration

Password recovery uses Supabase Auth. The browser needs the public project URL and publishable key; it reads them from `VITE_SUPABASE_URL` / `VITE_SUPABASE_PUBLISHABLE_KEY` at build time and falls back to `GET /api/config` on the API when those variables were missing from the build. The API supplies that endpoint from `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY`, so recovery keeps working even if a static-site build was made before the variables were saved.

If recovery still fails, open the browser console: the client logs the missing configuration source and the exact Supabase error (`message`, `status`, `code`) instead of only showing a friendly message. Add the production `/update-password` URL to Supabase Auth → URL Configuration → Redirect URLs. See [AUTH_SETUP.md](AUTH_SETUP.md).
