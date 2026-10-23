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
- **Optional Auto-Trading:** a user can let clearly parsed Telegram signals place market orders on their own connected MT4/MT5 account, behind a chain of safety gates, with break-even and trailing stop protection for the positions it opened (see [Auto-Trading and break even](#auto-trading-and-break-even)).
- **Break-even stop moves:** the stop of a trade Signal Desk opened is moved to the entry price (plus an optional offset) once the market has travelled the configured distance in favour of the trade.

## Important safety and data notes

- **Live orders are only ever placed for a user who switched Auto-Trading on.** Every new workspace starts with the setting on so the feature is usable immediately, but nothing is submitted until that user also selects an owned, deployed trading account, is on a paid plan, and every safety gate passes. Turning Auto-Trading off is immediate and stops *all* writes to the broker, including break-even stop moves.
- **Capturing signals is not a paid feature and is never a trading decision.** A workspace that has connected Telegram and chosen at least one channel receives and stores every message from those channels, whatever its plan and whether or not it has a MetaAPI account at all. What a plan decides is whether the stored signal is *queued* for the broker; a signal that could not be executed is saved with the reason written next to it (`Not executed`, with the upgrade sentence where a plan is what is missing), so an inactive workspace reads an explanation instead of an empty panel.
- **A captured signal can be deleted; the trade it produced cannot.** Removing a signal - by its owner from `Signals`, or by an administrator from Data management - unlinks any trade that points at it and leaves that trade's row, entry, and profit and loss exactly where they were, in one transaction, so clearing a history can never orphan or delete order history. A signal still queued for execution loses its pending job, which means an order that had not been sent will not be sent; both confirmations say so. See **Signal history: deletion**.
- **The live-trading warning is a decision, not wallpaper.** The first time a workspace switches Auto-Trading on, a dialog states that live orders will be placed and that the losses are theirs, and asks for `I Understand`; the answer is stored on the workspace (`settings.has_accepted_risk_warning`) and the panel afterwards carries one quiet line under the switch. `Cancel` leaves the switch exactly where it was and is never reported as a failure.
- Signal Desk never closes or partially closes a position and never widens a stop loss. It places market orders and, when break even or a trailing stop is enabled, moves the stop of a position it opened itself to a price that reduces risk — once, or repeatedly at a fixed distance.
- An ambiguous broker or network failure on an order or a stop move is recorded as `unknown` and is **not** retried automatically, because the broker may already have accepted the first request. The activity list says so; reconcile that position on the broker account.
- The API uses `METAAPI_PROVISIONING_TOKEN` only on the server. Users enter their broker login and password on MetaAPI's HTTPS setup page; Signal Desk does not receive or store those credentials.
- The MetaAPI client uses HTTPS and is limited to the operations above: account setup, account reads, market order submission, and stop-loss modification for break even. Trading credentials stay server-side.
- Deleting a Signal Desk account removes that user's Supabase Auth identity, local workspace data, and every MetaAPI trading account this workspace provisioned, so MetaAPI billing for those accounts stops. Accounts a user linked with their own MetaAPI token are left untouched. Unlinking a single account from the Trading Accounts page also deletes it from MetaAPI (same cleanup path); accounts billed to a user's own MetaAPI token are only unlinked.
- An MT4/MT5 account this workspace provisioned is deleted from MetaAPI after 30 days without a sign-in, settings change, or executed signal, so an abandoned account stops being billed. A user on a paid plan or with the admin role is exempt, an account still holding a position or pending order is left alone, and nothing is deleted when the position state cannot be read. See **Idle account cleanup**.
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

## Telegram connection state in the UI

Everything that mentions the Telegram source reads one shared value: `TelegramStatusProvider` in `client/src/components/TelegramStatus.jsx`, exposed to the app through `useTelegramStatus()`. No page, panel, or empty state fetches `/api/telegram/status` or keeps a local copy, because that is how a page ends up showing a connection prompt it has not been told about.

The rule the state machine enforces is that **the connection is unknown, never `false`, until the backend answers**:

| Confirmed state | Topbar pill | Empty signal list (Dashboard and Signals) | Trading Accounts |
|---|---|---|---|
| Nothing back yet | skeleton, "Checking Telegram…" | skeleton + "Checking your sources", no button | no note at all |
| `connected: true` | Telegram connected | "Telegram is connected. Waiting for messages from your selected channels…" | nothing to warn about |
| `connected: true`, no channels selected | Telegram connected | "Choose channels to monitor" (never a sign-in prompt) | note: no channels selected |
| `connected: false` | Telegram not connected | "Connect Telegram" | note: not connected, with the connect link |
| `configured: false` | Telegram unavailable | explains the service is unavailable, no button | note: unavailable |
| check failed, last answer known | last answer marked stale | unchanged | unchanged |
| check failed, nothing ever known | Status unavailable + Check again | Check again, no connect button | no note |

`GET /api/telegram/status` answers more than connected/not-connected: along with those flags it returns `listening`, `monitoredChannels`, `messagesSeen`, `signalsSaved`, `lastMessageAt`, `lastChatId`, and `lastError`, read from the live listener for that account. `listening` is the field that makes a silent drop visible - a client can be connected with no event handler attached, which is precisely how every message went missing once - and the endpoint attaches the handler on the spot when it finds that state instead of waiting for a restart. Nothing in the UI infers either fact.

The refresh is deduplicated, re-runs when the tab regains focus or becomes visible again (the API can sleep between visits), and polls every 30 seconds. Connect and disconnect flows publish their outcome through `applyStatus()`/`markDisconnected()` instead of waiting on a second round trip, so the pill, both empty states, and the Trading Accounts note change together. A failed check keeps the last confirmed answer and marks it stale rather than inventing a disconnection, and the `showConnectCallToAction` flag is the only way any component may render a connect prompt — `client/test/telegram-status-ui.test.mjs` asserts that invariant against the source tree, along with the rule that exactly one module may call the status endpoint. The same fetch lifecycle and failure policy are shared with the MetaAPI setup indicator through `client/src/lib/status-resource.js`; see [MetaAPI setup availability](#metaapi-setup-availability).

## MetaAPI setup availability

The **Trading Accounts** pill follows the same rulebook, because a page must not explain a problem it has not observed. `MetaApiStatusProvider` in `client/src/components/MetaApiStatus.jsx` is the only module that calls `GET /api/metaapi/provisioning-status`; `useMetaApiStatus()` shares it and `MetaApiStatusPill` renders it:

| Confirmed state | Panel pill | Create-account card |
|---|---|---|
| Nothing back yet | skeleton, "Checking setup…" | skeleton and "Checking whether account setup is available…" — no verdict, no form |
| `available: true` | Setup ready | the account name, platform, and broker server form |
| `available: false` | Setup unavailable | "Account setup is not available yet" with the owner instruction, and no form |
| check failed, last answer known | last answer, marked stale | unchanged |
| check failed, nothing ever known | Status unavailable + Check again | says the check failed, without claiming anything about the configuration |

`allowSetupForm` is stricter than "not told otherwise": the form submits a real provider request, so it appears only on a confirmed yes, exactly as a connect prompt appears only on a confirmed no. Both indicators get their fetch lifecycle and failure policy from `client/src/lib/status-resource.js`, so the rules that stop a status defaulting to its negative value exist once and cannot drift apart between the two endpoints. `client/test/metaapi-status-ui.test.mjs` holds that line, including a source-wide rule that no component may initialise a fetched status flag with `useState(true)` or `useState(false)`.

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
- **Three rules outrank the schedule.** A user whose subscription is `active` or `non_renewing` is exempt, because they are paying for the account. An account whose synchronized state still shows an open position or pending order is *deferred* rather than deleted, so a trade is never stranded with nobody able to close it; the reason is shown to the user and retried on a later sweep. And a user with the `admin` role is never swept at all — an operator running the product must not watch their own test accounts disappear, and warning about a deletion that will never happen is noise. The exemptions are applied twice: the candidate query filters them out so they cannot occupy a sweep slot, and the decision function re-checks them, so an exempt account is not even read from MetaAPI.
- **Nothing is destroyed on a guess.** If the position state cannot be read the sweep fails closed and waits. If MetaAPI refuses the deletion the local row is kept so a later sweep can retry, and after ten failed attempts the account is marked `failed` with a notice telling the user to remove it manually rather than looping forever. Each account is handled in its own `try`, so one provider outage cannot take the job down and the workspace is never left with a still-billed account no retry path can reach.

Notices live in `account_activity_notices` (RLS-enabled, user-scoped) and are surfaced in-app as a banner on **Trading Accounts**, under the policy note beside the add-account form. This project has no email transport, so the in-app banner is the delivery channel and `warningText()` is the single seam a later email sender would reuse. The sweep runs at startup and every six hours, `INACTIVITY_SWEEP_LIMIT` accounts per pass, oldest first, and `INACTIVITY_WARNING_DAYS` / `INACTIVITY_DELETION_DAYS` move the thresholds (`INACTIVITY_CLEANUP_ENABLED=false` turns the job off); warnings and deletions are logged with user and account ids and never with tokens.

## Auto-Trading and break even

Automatic execution is opt-in per workspace and lives in **Advanced Settings** (`/advanced`). The red warning above the toggle is required copy; the toggle saves on click so switching it off never waits for a form submit.

Before an order is submitted the engine re-reads its inputs and fails closed on anything missing: the user's current Auto-Trading setting, the server-side `AUTO_TRADING_RUNTIME_ENABLED` switch, ownership and `DEPLOYED` state of the selected account, signal age (two minutes), synchronized positions/pending orders, the open-trade and daily-trade caps, the UTC-day equity baseline for the daily loss limit, a fresh valid quote, a stop loss on the correct side of that quote, and the broker's own minimum, maximum, and volume step. A signal with an entry price is only executed when the current quote is not worse than that entry for the signal's direction. The record is written to `trades` *before* the SDK call with a stable `clientId`, so a replay cannot duplicate an order.

**Break even** extends the same loop instead of adding a second one. For each executed trade whose broker position is still open, once the market has travelled `breakEvenTriggerPoints` in favour of the trade, the stop is moved to the entry price plus `breakEvenOffsetPoints` — an offset is how you cover spread and commission instead of parking the stop exactly where the quote touches it.

- Distances are MetaTrader **points**, aligned onto the symbol's `tickSize`; a buy rounds down and a sell rounds up, so the stop never lands beyond the intended price. On most FX pairs 10 points is one pip.
- Only positions Signal Desk opened are considered; trades placed in the terminal keep their own stops.
- A stop is only moved in the direction that reduces risk. If the existing stop is already at least that protective, the position is marked handled and nothing is sent.
- The broker's `stopsLevel` and `freezeLevel` are respected. When the break-even price sits inside the minimum stop distance, the move is *deferred* and retried as the price travels further, rather than failing.
- Every decision needs a fresh synchronized quote and symbol specification; missing or stale safety data means no request.
- Results are persisted per broker position in `break_even_moves` with the status `moved`, `already_beyond`, `closed`, `deferred`, `failed`, or `unknown`, the previous and new stop, the quote used, and the sanitized provider message. A terminal status is never retried. Deferrals retry on their own clock (15 seconds while the price is too close, 60 seconds when account data could not be read) without consuming an attempt, a broker rejection retries up to ten times, and `unknown` never retries. Changing either distance re-arms positions that were already handled, because the stored row keeps the settings it was decided under.
- Moves run only while the execution runtime is available, Auto-Trading is on, **and** the user is on a paid plan, so "off" — or a lapsed subscription — always means "Signal Desk is not talking to your broker".

### Trailing stop

**Break even moves a stop once; a trailing stop keeps moving it.** `trailing_stop_enabled` and `trailing_stop_distance_points` sit beside the break-even settings and feed the same `sweepBreakEven()` — deliberately the same sweep, so there is only one code path that may write to a broker position and only one set of rules to audit. When both protections are on, the engine computes both targets and takes the **more protective** one (higher for a buy, lower for a sell), so turning trailing on can never weaken break even and turning break even on can never stall a trail.

- The trail keeps the stop `trailingStopDistancePoints` from the market: `bid − distance` for a buy, `ask + distance` for a sell, aligned onto the symbol's `tickSize`.
- **It only ever tightens.** If the market retraces, the price the trail would ask for is looser than the stop the position already holds, so the decision is `wait` and nothing is sent. That is also why a trail turns break-even's terminal `already_beyond` into a `wait`: the position stays in the sweep rather than being settled and forgotten.
- **It never acts on a stale quote.** As with break even, the price, the position's current stop, and the symbol specification all come from one synchronized account read inside the sweep; `waitForFreshPrice` refuses a quote older than the freshness window, and a failure to read is a deferral, never a guess. Nothing from a previous sweep is reused as evidence.
- **Ambiguous provider answers fail closed.** `classifyBreakEvenFailure` still decides the follow-up: a broker condition that can clear is deferred and retried on its own clock, a definite rejection retries up to ten times, and an unconfirmed change is recorded as `unknown` with **no** scheduled retry. `unknown` and `closed` rows are never re-offered to the sweep, so a trail cannot resend a modification the broker may already have applied.
- Each position keeps exactly one ledger row, with `move_count` incremented for every applied move and `trailing_distance_points` recorded, so the activity list can say "Stop trailed (1.1020) · 4 moves, 30 points behind" instead of implying a one-off break-even edit.
- Cadence and rate limits are unchanged: one sweep per `BREAK_EVEN_SWEEP_INTERVAL_MS`, at most `BREAK_EVEN_SWEEP_LIMIT` positions, `stopsLevel` and `freezeLevel` honoured, and Auto-Trading off (or a lapsed plan) stopping every write.
- With more open trades than the sweep limit, the queue is ordered so a position that has never been protected goes first, then due retries, then ratchets — a full set of established trails can never starve a fresh move. Within each class the row touched longest ago is served first, which rotates the trails.

The sweep shares the worker's polling loop, and an order always goes first, so protecting an open position can never delay a fresh signal. A busy stream of signals cannot starve protection either: every fifth iteration also attempts a sweep. `BREAK_EVEN_SWEEP_INTERVAL_MS` throttles the sweep itself (default `5000` ms, floor `1000`), so calling it often costs nothing. No test or deployment path places a live order: the broker adapter is always faked.

### Scale-out on a signal that numbered its targets

A channel that posts `TP 1 : 4029.50`, `TP 2 : 4027.50`, `TP 3 : OPEN` is publishing one trade with a plan for it. The parser reads the whole list into `signals.take_profit_levels` (and `take_profit` stays the first target it named), and what the workspace does with the rest is a setting: `settings.multiple_target_handling`, one of `first_target` (default), `final_target`, or `scale_out`. The list is stored rather than re-derived at execution time so that a parser change can never move the target of a signal somebody had already reviewed.

All three answers are decided in one module, `server/services/scale-out.js`, which never touches a broker — the engine asks it what to send and the sweep asks it what to close, which is what makes the whole policy auditable without a connection.

- **First Target Only** exits at TP1 and leaves the rest of the plan unread: the earliest of the channel's own exits, so it cannot be a looser trade than the message described. This is what every workspace did before the setting existed, and it is the default an absent value reads as.
- **Final Target Only** holds the trade to the last price the channel named, with no partial closes.
- **Split & Scale-Out** opens the full size with the **final** target on the position, and writes one `trade_tp_levels` row per earlier target: level 1 closes 50% of the original volume, level 2 closes 30%, and the remainder rides to the broker-held target. With exactly two targets the split is 50/50, and with more than three the swept levels share the same 80% budget evenly — the ride never falls below a fifth of the position, because it is the only leg the broker is still holding.
- A level the broker could not trade is dropped rather than invented: prices are kept only in the order the channel wrote them and only on the profitable side of the quote the order went out at, and any slice below the symbol's minimum lot returns its share to the ride. A position too small to halve and still leave a legal remainder is **not** scaled out of at all — it keeps its first target, and no plan rows are written. `signals.execution_note` records the plan that was made, so the trade row can be read years later.

`trade_tp_levels` is the idempotency key (`UNIQUE(trade_id, level_index)`), and a sweep claims a row to `submitting` before the call, so two sweeps or a restart cannot take the same piece out twice. A row left in `submitting` by a process that died is settled as `unknown` after five minutes, and `unknown` is never re-offered — the broker may already have closed the volume, and a second close would be a trade nobody asked for. A refusal that is a broker condition (a stop too close, a market that is closed) defers and retries on the same clocks the stop moves use; a close that cannot ever be legal at this size is settled as `skipped` with the sentence the provider gave, rather than retried forever.

**The stop moves with the profit, in the same pass.** When a level marked `break_even` — always the first one — is banked, the position's stop is moved to break even immediately, whether or not the workspace has break-even switched on, because the ride must not be able to give back what was just taken. The price is `entry + offset` (the workspace's own break-even offset when that switch is on, otherwise exactly entry), and it goes through `calculateStopGuard`, so it is never wider than the stop the position holds, `stopsLevel` and `freezeLevel` are honoured, and the outcome still lands in `break_even_moves` where the panel already reads stop moves from. If the close succeeded but the stop move was refused, the *level* stays settled and only the stop move is retried — a retry of the whole row would close the volume a second time.

`trades.remaining_volume` is written when a plan is attached and updated after every close, so it is the size still open right now — and it stays `NULL` on a trade that never had a plan, which keeps "nothing to scale out" distinct from "the plan ran and the whole position is gone". `GET /api/trades` returns it with the plan rows, which is what lets the activity list say `0.1 lots · 0.05 lots left` and `Scale-out: 1.12 closed · 1.15 pending` without a second query.

Cadence is its own: `SCALE_OUT_SWEEP_INTERVAL_MS` (default `5000`, floor `1000`), one account read per account and symbol per pass, at most 20 levels, and Auto-Trading off or a lapsed plan stops every write. A **platform pause** does not: taking profit and moving a stop to entry reduce exposure, which is the same reasoning that keeps break-even moves running while new orders are held.

### Settings are three folded bars on one page

The panel used to be one long page called **Risk settings** that mixed what a trade may cost with what may be sent to a broker with the button that deletes the workspace. That is three different kinds of decision, and only two of them are made twice a year, so they are three sidebar entries now — and `PUT /api/settings` did not change at all: the client still holds one `settings` object and saves that whole object, so whichever page saves writes the row as the server last returned it, and a save on one page cannot blank what another page set.

- **Risk Settings** — the sidebar entry, still served from `/` because it has never had a path of its own — the four numbers: risk percent per position, maximum open trades, maximum daily trades, daily loss limit. No toggles, nothing folded, and the Auto-Trading switch is not there: this page changes what a trade risks, not whether one happens.
- **Advanced Settings** (`/advanced`) — everything that decides what an order does, as three folded bars (`SettingsSection.jsx`): **Core Execution** (open) with the Auto-Trading toggle and its required red warning, the connected trading account and the lot size; **Trade Management** (closed) with break even, the trailing stop and **Multiple Target Handling**; and **Advanced Safety Nets** (closed) with the two blocks and the two fallback distances. It is the power-user page, and the runtime and platform-pause notices lead it above the bars, because they explain why nothing is moving.
- **Profile** (`/profile`) — the name, email, role and age of the account, the password flow, and the **Danger Zone** at the bottom. Identity is read-only because it is the credential, not a setting: the password is changed through the same emailed reset link the sign-in screen uses (`/api/auth/prepare-password-reset` then Supabase `resetPasswordForEmail`, redirecting to `/update-password`), which is one client helper — `src/lib/password-reset.js` — so the two surfaces cannot drift into preparing-or-not preparing separately. Account deletion is unchanged: same `DELETE /api/auth/account`, same password-plus-`DELETE` confirmation, now nowhere near a number that sizes a live position.

Both settings pages own the fields they show, and no field is editable on two of them — `client/test/settings-navigation-ui.test.mjs` derives the field list from the route itself (`req.body.*` in `PUT /api/settings`) and fails if a field gains or loses an owner. The three pages are also the app's routes: `/advanced` and `/profile` are in `client/public/manus-routes.json` next to `/admin` and `/billing`, because a path the static host does not know is a 404 on refresh.

The fold is a `<details>` element with a chevron that turns on the browser's own open state, so a bar is readable with no script, keyboard-operable, and reported as expanded or collapsed without anyone maintaining an `aria-expanded` by hand. Two of the three bars are closed by default, and the one that is open is the one a reader most often changes. Each header carries a one-line state — `Auto-Trading OFF`, `No stop moves · First Target Only`, `Blocking` — because a folded bar that only named itself would be a click to find out whether anything is protecting a trade; every sentence longer than that lives in the body, where it is read by the person about to change the value.

Inside **Advanced Safety Nets** are two refusals and two rescues, and the engine applies them in one fixed order: **the signal's own value, then the workspace's fallback distance, then the block**. A level the channel actually stated is never overwritten by a setting. Several targets are not decided here at all: that is the mode in Trade Management, and the list below says so.

- **Block execution if Stop Loss is missing** and **Block execution if Take Profit is missing** — both on by default, and an absent value reads as on, so a settings object written before either switch existed cannot become the permissive one. The summary line says `Blocking` while *either* is on: one relaxed rule does not make this group permissive.
- **On, no fallback** (default): a signal missing that leg is saved for review and never sent, and the refusal quotes the workspace's own rule ("your workspace requires one before an order is sent", "your Safety settings require a take-profit target") rather than a generic parse failure, so a reader can tell a provider's omission from the guard they chose.
- **On, fallback set**: the leg the provider forgot is completed at execution time from a live quote — `order price ∓ points × tick size`, aligned onto the symbol's tick grid *away* from the market so a rounding step can never tighten risk or trip `stopsLevel`. A trade sent this way is not naked; it carries a stop. `signals.execution_note` says the level came from the workspace rather than the channel, and the trade row stores the prices that were actually sent.
- **Off, no fallback**: the order goes out without that leg and is described as what it is — `Trade executed without Stop Loss (User Override).` in the log, and the same on the signal row. The stop side relaxes **in Fixed Lot mode only**: Risk-Based sizing is arithmetic on the distance from entry to stop, and there is no distance to divide by, so those signals are still refused.
- **A fallback the broker would refuse is never quietly dropped.** No tick size for the symbol, a distance inside `stopsLevel`, a result at or below zero, or a leg too small to sit on the correct side of the spread is reported on the refusal, which names both facts ("the broker requires stops at least 50 points from the market, and the fallback distance is 10"), and the block then applies to that leg as if no fallback existed. A setting that cannot be honoured is a thing to fix, not a thing to ignore.
- Switching a block off relaxes nothing else. The symbol, the direction, a fresh price inside the capture window, the workspace's own Auto-Trading switch, the runtime switch, the platform kill switch, the plan check, and `DEPLOYED`-and-managed account all still have to hold.
- A direction that had to be **inferred** from the entry and target prices is never executed whatever any of this says — see below.

Distances are MetaTrader **points**, the same unit as the break-even and trailing settings, and are stored as `settings.fallback_stop_loss_points` and `settings.fallback_take_profit_points` (`NUMERIC`, nullable: no row value means no net). `PUT /api/settings` accepts a whole number in `1…1000000` or blank, and answers anything else with one sentence naming the field — a distance is never clamped, because `0` and `1000000` are opposite mistakes and guessing which one was meant is how a trade ends up with the wrong stop. Both the capture-time eligibility answer and the at-send-time price arithmetic live in one module, `server/services/signal-safety.js`, so a signal can never be stored as executable and then refused for the same reason, nor stored as refused and then traded.

### What a captured message says about itself

The parser returns facts, and the row stores them, so the panel never has to guess: `directionInferred`, and the three `missing` prices are what `Signals` renders as **Inferred**, **Missing SL**, and **Missing TP** badges. A message that yielded no trading data at all reads **No clear signal**; a message that was legible but unusable reads **Needs review** with the server's own sentence under it, because "unclear" was sent to people whose channel had written a perfectly readable note with one line missing.

Direction inference is deliberately narrow and never silent: it runs only when the message names no direction word at all, has an entry and exactly one target, and the two differ - target above entry is a buy, below is a sell. The row is then flagged `direction_inferred = TRUE`, `execution_ready = FALSE`, and a blocker (`The trade direction was inferred…`) that keeps it out of the queue. An inferred direction is shown, never traded.

Channel matching is by *both* spellings of a chat id. A supergroup or channel is `-100xxxxxxxxxx` when marked and `xxxxxxxxxx` when not, and GramJS hands over whichever shape the accessor in use happens to produce, so `channels.channel_id` is compared with the full variant set (`= ANY($2::text[])`); a single exact-string comparison dropped every live message the first time the two sides disagreed. Basic-group ids are never rewritten - only matched - because canonicalising `-7` into `-1007` would create a chat that does not exist.

Nothing a monitored message does is quiet any more: the listener logs an `info`/`warn` line for every update it sees, including the ones it ignores and why (no text, chat not monitored, no id to match on), and a failure while storing is logged rather than swallowed. Unparseable and refused messages are still stored: a captured signal is the record that Telegram said something, not a reward for parsing cleanly.

## Signal history: deletion

Captured messages are removable, by their owner and by an administrator. Trades are not, from either place.

- `DELETE /api/signals/:id` and `DELETE /api/signals` (clear history) for the signed-in workspace; `DELETE /api/admin/signals/:id`, `DELETE /api/admin/users/:id/signals`, and `POST /api/admin/signals/purge` (`olderThanDays`, default 30, with `GET /api/admin/signals/purge-preview` for the count first) for administrators.
- Every one of them runs a matched **pair** of statements in one transaction: `UPDATE trades SET signal_id=NULL …` then `DELETE FROM signals …`. `trades.signal_id` is `ON DELETE SET NULL`, so the unlink is belt-and-braces, and an executed trade keeps its own row, entry price, profit and loss, and broker ids whatever happens to the message that produced it.
- `execution_jobs.signal_id` is `ON DELETE CASCADE`, so a signal that was queued but not yet sent loses its pending job: that order will not go out. Both confirmation dialogs say so rather than letting it be discovered.
- The user-facing delete binds the owner inside the statement (`WHERE id=$1 AND user_id=$2`), so a route that forgot its checks still cannot reach another account's row; support-view tokens are read-only at the authentication layer and the panel renders no delete control in that mode.
- Every administrator deletion is written to `admin_audit_logs` (`signal.delete`, `signal.clearUser`, `signal.purgeOld`) with the account it touched, the count removed, and the count of trades unlinked, and is logged at `warn` for the bulk forms - the numbers are read back from `rowCount`, not from what was expected.
- The panel reports what the database actually did: the notice after a delete quotes the `deleted` and `unlinkedTrades` counts from the response.

Two indexes ship with this so a purge stays cheap instead of scanning: `signals(created_at)` and the partial `trades(signal_id) WHERE signal_id IS NOT NULL`.

## Paystack billing

Signal Desk sells a free tier and three paid plans. Every price, limit, and label comes from `PLAN_DEFINITIONS` and `FREE_PLAN` in `server/services/billing.js`, and the amount charged is always computed on the server, so a modified browser request can never change the charge. Nothing else needs to know how many paid plans exist — pricing storage, Paystack plan synchronisation, the Billing page, and the Admin Panel all iterate over that catalogue.

| Plan | Default price | Trading accounts | Telegram channels | Signals/day |
|---|---|---:|---:|---:|
| Free | ₦0 | none (review only) | 1 | 50 |
| Starter | ₦60,000 / month | 1 | 10 | 200 |
| Pro | ₦105,000 / month | 3 | 50 | 500 |
| Premium | ₦150,000 / month | 5 | 100 | 2,000 |

The paid prices are set against what a MetaAPI account costs this workspace each month, so one automated account is the cheapest paid tier and every step up pays for more accounts and more traffic. **Free cannot execute at all**, and that is enforced where an order would be created rather than where a preference is stored: `maxTradingAccounts: 0` blocks a new link, the execution worker refuses an order for an unpaid workspace, and the same refusal is re-checked immediately before the broker call — so a workspace that connected an account while it was paying and later lapsed still cannot place orders. Signal capture and the workspace's own switches (Auto-Trading, break even, trailing stop) are *not* plan-gated: a Free user can state their intent, sees every captured signal, and is told per signal that execution needs an upgrade. Gating the switches themselves produced a red banner for a setting nobody could change and added no safety.

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

## Failure messages that survive the round trip

Any request can fail for a reason the frontend has no way to invent, so the rule in `client/src/lib/api.js` is that the server's own sentence is what the user reads. Three cases are told apart, because they need different advice:

- **A refusal with a status** (`400`, `402`, `409`, `429`) keeps its message, since that sentence was written for the person who just pressed the button.
- **A server error with a body** returns `userMessage` when the route set one — administrative mutations do, through `adminActionError(action, error)` in `server/services/admin.js`, which names the action that failed (`Adjusting that plan did not complete: …`) — plus a `code` (`UNEXPECTED` when nothing chose one) and a short `requestId`. The sentence ends with what the administrator can still do about it: `Nothing was changed - please try again…` while the write had not happened, and `Part of this may already be saved - reload the list before you try it again.` once `markApplied(req)` has recorded that it did. The same reference is on the `Request failed` log line, together with the method and path, so "the admin panel said no" becomes a searchable line instead of a screenshot. The raw internal message is never the headline for a status-less failure, because it can name a table or a column.
- **A response that never came from the app** — an empty body or an HTML error page from the proxy, typical of a service that is waking up — is described as that, and says plainly that the change may not have been applied. `error.retryable` is set so a panel can offer a retry instead of implying the user's data is wrong.

## A statement and its values are checked together

`pg` sends a statement and its bind values as a pair, and Postgres refuses the pair when the two
halves disagree: `bind message supplies 5 parameters, but prepared statement "" requires 4`. That
message arrives from the driver, far from the code that assembled the SQL, and it says nothing about
which query or which value was wrong. So the pair is checked where it is built:

- `server/services/query-params.js` counts placeholders (the highest `$n`, because `$1` used twice is
  still one slot) and compares that with the length of the value array. `assertQueryParameters` throws
  `QUERY_PARAMETER_MISMATCH` naming the statement's label and the missing or surplus numbers.
- `withParameterChecks` wraps the one pool the app owns **and** the clients it hands out, so a
  statement inside `BEGIN … COMMIT` is checked like any other. A rejected call never reaches the
  socket, which is why a mismatch can no longer half-apply anything.
- The admin statements whose columns or period depend on what the administrator filled in are built by
  `buildUserAdminUpdate`, `buildSubscriptionGrantStatements`, `buildSubscriptionExtendStatement`,
  `buildSubscriptionReleaseStatements`, `buildSubscriptionMirrorStatement`, and the five signal-deletion
  builders (`buildSignalOwnershipDelete`, `buildAdminSignalDelete`, `buildSignalsPurgeForUser`,
  `buildSignalsPurgeOlderThan`, `buildSignalsPurgeCount`) in `server/services/admin.js`. Each returns `{ sql, params }` from one expression and asserts them
  against each other, so a variant that mentions `$5` only sometimes cannot be written again.
- `server/test/query-parameter-contract.test.js` reads every `pool.query` / `client.query` call site in
  the server (212 sites, 200 of them statically resolvable, the rest being statements assembled at
  runtime) and fails if any of them binds a different number of values than its statement asks for -
  **per branch**, by expanding `condition ? 'sql A' : 'sql B'`. One of its tests feeds the scan the
  exact statement shape that reached production and requires it to be flagged, so the net is tested and
  not merely asserted.

This is why the manual subscription adjustment now states its period as
`COALESCE($5::timestamptz, NOW() + ($4::text)::interval)` in both the insert and the conflict update,
instead of choosing between two SQL strings: an explicit end date still wins and a number of days is
still counted from now, but both bindings exist in every branch.

The same scan reads **qualifiers** as well as counts, because a statement can bind perfectly and still
be illegible to Postgres. `server/services/announcements.js` used to hand its `a.`-qualified column
list to the `RETURNING` clause of its own inserts and updates, and a write has no `a` to resolve - an
`INSERT` cannot alias its target at all - so publishing, editing and retiring an announcement all failed
with `missing FROM-clause entry for table "a"` before anything was stored. `undeclaredQualifiers` now
lists the relations a statement actually declares (its targets, their aliases, `EXCLUDED`, the trigger
records) and fails on any `x.column` outside that set, over the same statically resolvable call sites.
Announcement columns are described once and rendered twice from that single field table - qualified for
the joined reads, bare for every `RETURNING` - so the two forms cannot drift apart.

## Admin panel

Administrators see an **Admin Panel** entry in the sidebar and can open it directly at `/admin`. The route is protected twice: the frontend only renders the panel for an `admin` role, and every `/api/admin/*` endpoint re-reads the caller's role from PostgreSQL on each request (a non-admin receives HTTP 403, a signed-out caller HTTP 401).

Admin access comes from `ADMIN_EMAILS` (comma-separated). The original workspace owner address is always included, and startup promotes those addresses to `role = 'admin'`. Promote or demote any other user from the Admin Panel itself.

The panel provides:

- Dashboard totals: total users, administrators, suspended users, new sign-ups (7/30 days), promo codes, linked trading accounts, signals, and trades.
- User management table: search by name or email, change role, suspend with a required reason, and restore access. Suspend, Adjust plan, and Impersonate open centred over the panel in a dialog rather than inside the row that was pressed: a seven-column cell could not hold a paragraph and three fields, and on a phone it held nothing readable. Escape and a click outside cancel, the first field takes focus, and both buttons are held while the request is in flight. An admin cannot demote or suspend their own account, and that refusal is now visible in three places at once: the panel shows the server's own sentence, `log('warn', 'Admin account edit refused', …)` prints the actor, the target, the status, and the *field names* that arrived (never their values), and a refused suspension writes a `user.suspension.refused` row to the audit trail. Before this, a refused account edit left no server-side trace at all, which is why "Suspend does nothing" could not be answered from the logs.
- Pricing & Plans: the active Starter, Pro, and Premium prices, how many subscribers a change would affect, whether each plan's Paystack plan is in sync (with its `PLN_…` code and last error), the per-plan price history, the two recurring-billing switches, a "Re-sync all plans with Paystack" action, and the promo-code creator: code, percentage or fixed discount, optional maximum uses, and optional expiry. Existing codes can be paused, re-activated, or deleted. Codes are applied at Paystack checkout, and their `current_uses` increment only after a verified payment.
- Billing activity: active subscriptions, successful and pending payments, gross collected, discounts given, and the latest customer transactions.
- System health: the platform switch, the execution queue, and the newest MetaAPI and Telegram errors, with the **global auto-trading kill switch** at the top of the tab.
- Announcements: publish, correct, schedule, and retire the dashboard banner every signed-in user sees.
- Audit log: who did what, with the admin's email address and the timestamp, filterable by action and searchable by address or wording.
- Data management: the captured-signal history of every workspace, searchable by user email or name, monitored channel, symbol, and a date range, with the number of trades each signal is linked to. Three deletions are offered - **Delete signal** (one row), **Delete all for this user**, and a **Purge old signals** retention action defaulting to 30 days - each of which shows a server-read count in its confirmation, and none of which can remove a trade. The purge preview and the purge share one SQL age expression, so the number an administrator confirms is the number that goes.

Suspension blocks new sign-ins with the stored reason. Existing JWT sessions on other devices remain valid until they expire (12 hours, or 30 days with "keep me signed in"), so revoke a role or suspend an account knowing that short window. Suspending an account also closes any open support session on it.

That edit is a three-field contract between two packages - `client/src/components/AdminPanel.jsx` sends
`{ role }`, or `{ isSuspended, suspensionReason }`, and `normalizeUserUpdate` in
`server/services/admin.js` reads exactly those names - so `client/test/platform-admin-ui.test.mjs`
extracts the field names from the server's reader and requires the panel to send each one. The endpoint
also accepts a suspension flag that arrived as the text `"true"`/`"false"` (a boolean is what the panel
sends; the words mean the same and only ever select between two statements that are validated anyway),
and every rejection names what arrived - `it sent "suspended", "reason"`, `suspensionReason arrived
blank`, `received a number` - because "Choose at least one change to save." on a filled-in form reads as
a broken button rather than a naming problem. Field *names* are echoed after an identifier check; values
never are. The form carries the account it was opened for, so paging or searching with it open closes
it instead of submitting against a row that is no longer on screen.

### Global auto-trading kill switch

`AUTO_TRADING_RUNTIME_ENABLED` is read once when the process boots, so it can stop execution but it cannot be flipped while the service is running. The kill switch is the runtime half of that decision: it lives in `admin_settings` under `auto_trading_kill_switch`, and `processJob()` reads it from the database before it touches the broker and again immediately before it records a trade and sends the order. Turning it off therefore stops new trades for every workspace on the next job - no deploy, no restart - and the trade is never half-submitted.

While it is engaged, eligible signals are skipped with the reason recorded on the job, so the user can read why in their own activity list. A database read that fails, or a stored value that cannot be understood, is treated as paused rather than as permission.

Two things deliberately keep running, and both are stated in the panel rather than left to inference:

- **Protective stop moves.** Break-even and trailing-stop updates continue, because removing a stop an open position already has in the middle of an incident increases risk. `settings.auto_trading_enabled` remains the switch that stops all broker writes for one workspace.
- **Signal capture and review.** Telegram messages are still parsed and stored; the pause is about orders, not about data.

Releasing the switch does not replay what the pause skipped - signals older than two minutes are refused by the freshness rule regardless.

### System health and monitoring

`GET /api/admin/health?hours=24&limit=25` reads the failure records the platform already writes, rather than a second copy of them: MetaAPI order outcomes on `trades` (`rejected`/`unknown` with an error message) and `execution_jobs` (`failed`/`unknown`, skipping a row whose trade already carries the failure so one incident is not listed twice), stop-move outcomes on `break_even_moves`, and Telegram parsing refusals on `signals.parse_error`. That means the tab is useful for incidents recorded before it existed, and there is no error table that can drift from the truth. The console log is not part of it: a server log is not queryable and gets rotated away.

The response also carries `checks` - one label, headline, and sentence per area (switch, runtime, queue, and each error source). The wording is produced server-side so the panel cannot invent a reassuring sentence, and a section that could not be read reports `unknown`: it is never coloured as healthy. `errorsAvailable` distinguishes "nothing went wrong in this window" from "this could not be read".

The errors list has a **Clear parsing errors** button, and `DELETE /api/admin/health/errors` is the whole of it: it unsets `signals.parse_error` on every row that carries one - the same condition the `telegram_parse` tab selects on, minus that tab's time window - and answers with the count it actually removed. The captured message itself is never touched, so a message that was misread can still be reviewed or deleted one at a time afterwards. MetaAPI order rows and stop-move rows are deliberately out of scope: they are the broker's answer about money, and that evidence has to outlive a tidy screen.

`capture` in the same response is the admin-only read of whether anything is receiving at all: sessions held in memory, handlers verified, listening, messages seen, signals stored, monitored channels, the last message time, and how long this instance has been up. `buildCaptureHealth()` derives the state from the gap between what this process holds and what the database expects (`connectedUsers`, `restorableSessions`, `monitoredChannels`, `lastSignalAt`) - which is how a service that was asleep when a channel posted is told apart from a listener that is not attached. The panel shows the numbers and the derived state, and nothing else: those are the actionable part, and the paragraph that used to explain the host was removed as clutter.

### Support access (impersonation)

Each row in the user table has **Impersonate**, which opens a **one-hour read-only support session** on that workspace. The administrator supplies a reason; it is stored in the audit log. The session is a separate JWT carrying `purpose: 'impersonation'`, `sub` (the customer), and `act` (the admin); the customer's password is never read, reset, referenced, or needed, and nothing about them is written.

The server enforces what the banner promises:

- **One hour, twice over.** The signature expires in 60 minutes, and `support_sessions.expires_at` carries its own expiry, so neither can outlive the other.
- **Revocable.** Only a SHA-256 hash of a random session id is stored. Closing the session - from the banner or `POST /api/admin/support/stop` - revokes the row and the token stops working on the next request.
- **Read-only.** Every non-`GET` request with a support token is refused with 403, so nothing in the customer's workspace can be changed by accident; the only permitted write is the session closing itself (`POST /api/auth/support/exit`).
- **Not an admin path.** `requireAdmin` rejects any request carrying a support session, even when the account being viewed is itself an administrator.
- **Visible.** The browser holds the token in `sessionStorage` (so it dies with the tab), and the dashboard renders a bar naming the workspace being viewed with an **Exit support view** action.

### Manual adjustments

`PATCH /api/admin/users/:id/subscription` grants a plan, extends the expiry, or both, with a mandatory reason:

- `plan` (`free`, `starter`, `pro`, `premium`) writes `users.subscription_plan`, `subscription_status`, and a `plan_limits` snapshot, and upserts the matching `subscriptions` row. Granting with `days` or `endsAt` honours that period instead of adding it on top of the plan interval, so "Pro for 14 days" means fourteen days.
- `days` (1-365) or `endsAt` moves `subscriptions.current_period_end` from the later of now and the current end, so extending never shortens a paid period. A `canceled` or expired row is revived as `non_renewing` with `cancel_at_period_end` set - paid to the new date, but not silently re-subscribed.
- Moving an account to `free` clears the paid plan and its period in one step.

Paystack is not touched: the response says so, and says so again when a gateway subscription is attached, because that renewal keeps its own schedule until it is cancelled in Payments. Every adjustment is written to `admin_audit_logs` (`subscription.grant`, `subscription.extend`, `subscription.clear`).

### Announcements

Publishing is one insert, answered with the stored row, then audited with the target id. A failed publish answers with `Publishing that announcement did not complete: …` — the action named, the cause quoted, and the reference that ties it to a log line — and the panel keeps what was typed so the retry is one click.

`announcements` rows carry the message, a severity (`info`, `warning`, `critical`), an optional start and end window, and an active flag. A user's dashboard shows up to three live banners at the top of the workspace through `GET /api/announcements/active`, and dismissal is stored per user in `announcement_dismissals` - dismissing on one device does not dismiss it for anybody else, and it does not come back on reload. Retiring an announcement keeps the row (with its dismissal counts and audit trail) instead of deleting it - which is why the history list only ever grew, and why it now has a **Clear history** button. `DELETE /api/admin/announcements/history` removes the rows that can never come back: retired ones and ones whose end date has passed, which is exactly `announcementState()`'s `retired` and `ended`. Live and upcoming banners are outside the predicate, and each banner's `announcement_dismissals` follow it through `ON DELETE CASCADE` instead of orphaning. Severity only changes presentation, except `critical`, which is announced to screen readers as an alert.

### Audit trail

Every administrator mutation appends to `admin_audit_logs`: `pricing.update`, `pricing.sync`, `promo_code.create/update/delete`, `user.update`, `user.role`, `user.suspend`, `user.unsuspend`, `subscription.grant/extend/clear`, `execution.pause`, `execution.resume`, `announcement.publish/update/retire`, `impersonation.start`, `impersonation.stop`, and the three history clears - `health.clearParseErrors`, `audit.clear`, and `announcement.purgeHistory`. Each row holds the action, a plain-language summary, the target, the admin's email **as it was at the time** (denormalised on purpose, so renaming or deleting an account cannot rewrite history), scrubbed metadata, and the timestamp.

The one way rows leave the table is the panel's **Clear history** button, backed by `DELETE /api/admin/audit-logs`: it is confirmed in a dialog, and it records its own action (`audit.clear`) *after* the delete - so an emptied log still says who emptied it and when, rather than looking like a platform nobody administered. Nothing else updates or deletes an entry, and metadata is stripped of credential-shaped keys and values before it is stored because the panel renders it in a browser. A failed audit write is logged as an error but never turns a successful admin action into an HTTP 500 - the alternative is an admin who cannot tell whether the price was saved.

Fixing the catalogue exposed one latent schema bug: `subscriptions.plan_key` still checked `('free','pro','premium')` after Starter became purchasable, which would have rejected the row written when a Starter payment was verified. The constraint is now re-created idempotently to include `starter`.

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
| `AUTO_TRADING_RUNTIME_ENABLED` | No | `true` enables the MetaAPI execution runtime (orders and break-even stop moves). It is read at boot and cannot change while the process runs - the Admin Panel's global kill switch is the runtime control, and it sits above this flag rather than replacing it |
| `BREAK_EVEN_SWEEP_INTERVAL_MS` | No | Milliseconds between break-even sweeps; defaults to `5000` and never runs faster than every `1000` |
| `SCALE_OUT_SWEEP_INTERVAL_MS` | No | Milliseconds between scale-out target sweeps, which price each `trade_tp_levels` row and close its share; defaults to `5000` and never runs faster than every `1000` |
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
- `GET /api/admin/health`, `GET/PUT /api/admin/execution-switch` – recent MetaAPI and Telegram errors with queue state, and the global auto-trading kill switch
- `GET /api/admin/audit-logs` – the administrator audit trail (filter by action, search by admin email or wording)
- `DELETE /api/admin/health/errors` – clear the recorded Telegram parsing reason from every captured message that carries one
- `DELETE /api/admin/audit-logs` – delete every audit entry, behind a confirmation, and record the clearing as the entry that remains
- `DELETE /api/admin/announcements/history` – delete the banners that are retired or past their end date, keeping live and upcoming ones
- `GET /api/admin/signals` – captured signals across every workspace, searchable by email, name, channel, or symbol and by date range (`from` inclusive, `to` exclusive at day granularity, each trade-linked count included); `DELETE /api/admin/signals/:id`, `DELETE /api/admin/users/:id/signals`, `GET /api/admin/signals/purge-preview`, `POST /api/admin/signals/purge` – the Data management tab's deletion paths, which unlink trades and never remove them
- `GET/POST /api/admin/announcements`, `PATCH/DELETE /api/admin/announcements/:id` – banner administration (`DELETE` retires; it does not delete)
- `POST /api/admin/users/:id/impersonate`, `GET /api/admin/support-sessions`, `POST /api/admin/support/stop` – one-hour read-only support access; `POST /api/auth/support/exit` closes the caller's own session
- `PATCH /api/admin/users/:id/subscription` – manual plan grant, expiry extension, or removal, with a mandatory reason
- `GET /api/announcements/active`, `POST /api/announcements/:id/dismiss` – the dashboard banner and its per-user dismissal
- `GET /api/billing/plans` – public plan catalogue
- `GET /api/billing/subscription`, `GET /api/billing/quote`, `POST /api/billing/checkout`, `GET /api/billing/verify`, `POST /api/billing/cancel`, `POST /api/billing/resume`
- `POST /api/billing/webhook` – Paystack callback, authenticated by signature only
- `GET /api/dashboard`
- `GET/POST /api/channels`, `DELETE /api/channels/:id`
- `GET/POST /api/signals`, `DELETE /api/signals/:id`, `DELETE /api/signals` — every stored message with its outcome: `status` (`received`, `queued`, `unexecuted`, `expired`, `unparsed`, `executed`), `executionNote` (the sentence explaining an outcome that was not a trade), `directionInferred`, and the parsed prices; `DELETE` removes captured messages only and unlinks any trade they produced
- `GET/POST /api/accounts`, `DELETE /api/accounts/:id`
- `GET/PUT /api/settings` – risk limits, lot sizing, selected execution account, break-even trigger/offset, trailing distance, and Advanced Safety: `blockExecutionWithoutStopLoss`, `blockExecutionWithoutTakeProfit` (both default `true`) and `fallbackStopLossPoints` / `fallbackTakeProfitPoints` (points, `null` for no fallback); `GET` also reports the platform's own execution switch so the panel can explain a pause instead of leaving a user to hunt for a toggle that is already on
- `GET /api/trades` – execution activity, including the break-even outcome for each position
- `GET /api/metaapi/provisioning-status`, `GET /api/metaapi/linked-accounts` (each account also carries its idle age and warning state, plus the workspace's inactivity policy), `POST /api/metaapi/provisioned-accounts`, `POST /api/metaapi/provisioned-accounts/:accountId/configuration-link`, `POST /api/metaapi/provisioned-accounts/:accountId/refresh`, `DELETE /api/metaapi/accounts/:accountId`
- `GET /api/telegram/status` – connection plus listener health (`listening`, `monitoredChannels`, `messagesSeen`, `signalsSaved`, `lastMessageAt`, `lastChatId`, `lastError`), and it re-attaches a missing handler, `POST /api/telegram/request-code`, `POST /api/telegram/verify-code`, `POST /api/telegram/verify-password`, `GET /api/telegram/chats`, `POST /api/telegram/disconnect`
- `GET /health`

Authenticated endpoints require `Authorization: Bearer <token>`. Every `/api/admin/*` endpoint additionally requires the caller's current database role to be `admin`.

## Password recovery configuration

Password recovery uses Supabase Auth. The browser needs the public project URL and publishable key; it reads them from `VITE_SUPABASE_URL` / `VITE_SUPABASE_PUBLISHABLE_KEY` at build time and falls back to `GET /api/config` on the API when those variables were missing from the build. The API supplies that endpoint from `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY`, so recovery keeps working even if a static-site build was made before the variables were saved.

If recovery still fails, open the browser console: the client logs the missing configuration source and the exact Supabase error (`message`, `status`, `code`) instead of only showing a friendly message. Add the production `/update-password` URL to Supabase Auth → URL Configuration → Redirect URLs. See [AUTH_SETUP.md](AUTH_SETUP.md).
