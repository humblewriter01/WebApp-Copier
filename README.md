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
- **Limit and stop orders, with an expiry:** a signal that publishes a price the market has not reached is placed as a pending order on the broker instead of being skipped, carries that expiry as its own `ORDER_TIME_SPECIFIED` deadline, and is cancelled and reconciled by a sweeper if it never fills. A market order is judged against a drift allowance the workspace sets, and a fill better than the published price is always taken.

## Important safety and data notes

- **Live orders are only ever placed for a user who switched Auto-Trading on.** Every new workspace starts with the setting on so the feature is usable immediately, but nothing is submitted until that user also selects an owned, deployed trading account, is on a paid plan, and every safety gate passes. Turning Auto-Trading off is immediate and stops *all* writes to the broker, including break-even stop moves.
- **Capturing signals is not a paid feature and is never a trading decision.** A workspace that has connected Telegram and chosen at least one channel receives and stores every message from those channels, whatever its plan and whether or not it has a MetaAPI account at all. What a plan decides is whether the stored signal is *queued* for the broker; a signal that could not be executed is saved with the reason written next to it (`Not executed`, with the upgrade sentence where a plan is what is missing), so an inactive workspace reads an explanation instead of an empty panel.
- **A captured signal can be deleted; the trade it produced cannot.** Removing a signal - by its owner from `Signals`, or by an administrator from Data management - unlinks any trade that points at it and leaves that trade's row, entry, and profit and loss exactly where they were, in one transaction, so clearing a history can never orphan or delete order history. A signal still queued for execution loses its pending job, which means an order that had not been sent will not be sent; both confirmations say so. See **Signal history: deletion**.
- **The live-trading warning is a decision, not wallpaper.** The first time a workspace switches Auto-Trading on, a dialog states that live orders will be placed and that the losses are theirs, and asks for `I Understand`; the answer is stored on the workspace (`settings.has_accepted_risk_warning`) and the panel afterwards carries one quiet line under the switch. `Cancel` leaves the switch exactly where it was and is never reported as a failure.
- Signal Desk never closes or partially closes a position and never widens a stop loss. It places market orders and, when a signal published a price the market had not reached, limit or stop orders that carry their own expiry; and, when break even or a trailing stop is enabled, it moves the stop of a position it opened itself to a price that reduces risk — once, or repeatedly at a fixed distance. Taking a resting order off the book is the one write it makes for an order it has not filled.
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

Notices live in `account_activity_notices` (RLS-enabled, user-scoped) and are surfaced in-app as a banner on **Trading Accounts**, under the policy note beside the add-account form. A separate, quieter row belongs to the account itself: when the execution engine decides an account cannot trade at all it writes `metaapi_accounts.execution_note`, the panel renders it under that account, and the next executed order clears it. This project has no email transport, so the in-app banner is the delivery channel and `warningText()` is the single seam a later email sender would reuse. The sweep runs at startup and every six hours, `INACTIVITY_SWEEP_LIMIT` accounts per pass, oldest first, and `INACTIVITY_WARNING_DAYS` / `INACTIVITY_DELETION_DAYS` move the thresholds (`INACTIVITY_CLEANUP_ENABLED=false` turns the job off); warnings and deletions are logged with user and account ids and never with tokens.

## Auto-Trading and break even

Automatic execution is opt-in per workspace and lives in **Advanced Settings** (`/advanced`). The red warning above the toggle is required copy; the toggle saves on click so switching it off never waits for a form submit.

Before an order is submitted the engine re-reads its inputs and fails closed on anything missing: the user's current Auto-Trading setting, the server-side `AUTO_TRADING_RUNTIME_ENABLED` switch, ownership and `DEPLOYED` state of the selected account, signal age (two minutes), synchronized positions/pending orders, the open-trade and daily-trade caps, the UTC-day equity baseline for the daily loss limit, a fresh valid quote, a stop loss on the correct side of that quote, and the broker's own minimum, maximum, and volume step. The order type and the published price are decided together: a market order is sent when the quote is not worse than the entry by more than the workspace's drift allowance, and a limit or stop whose level the market has not reached is placed as a pending order rather than skipped. The record is written to `trades` *before* the SDK call with a stable `clientId`, so a replay cannot duplicate an order — for a resting order that row stays `pending` until the fill, the cancellation or the expiry is confirmed.

An unexecuted row names the one condition that stopped it, in this order: the workspace switch, the plan, the trading account, the account's deployment, and only then the two things that are true of every workspace on the service - the execution runtime and the platform kill switch. `services/signal-outcome.js` holds that order and the sentences, and the four a trader can act on are these: `Auto-Trading is off, so this signal was saved for review only.` on a switch that is off; `Auto-Trading is on, but your plan does not include automatic execution. Upgrade to execute signals.` on a plan that does not include it; `Auto-Trading is on, but no trading account is connected. Connect one to execute signals.` with no account; and no warning at all once everything is set. The order is not decoration. A row that reads "Auto-Trading is off" beside a banner that reads "Auto-Trading is ON, but no trading account is connected" tells the reader the panel contradicts itself, so the generic switch sentence is only ever produced by a switch that is off - and the account and plan sentences come first, which is also the order the Overview banner walks (`autoTradingBannerView`, which is handed the plan for exactly this reason: a component that cannot see the plan must not speak about it). Because the note is written when a signal arrives and the conditions behind it are settings, the read paths re-derive a blocked row's sentence from the live picture before it is shown (`overlayLiveBlocker`): the status stays what happened, because whether an order went out is a fact about the past, and the sentence becomes the one that is true now. A note that came from anywhere else - a broker's answer mirrored from a job, a parser's reason - is never rewritten, and a row that carried no blocker sentence is never given one. The re-decision is allowed to depend on **one** thing: the sentence itself. It used to ask more - first `telegram_message_id`, then `source === 'telegram'`, then `execution_ready === true` - and every extra question was a way for the correction to switch itself off for exactly the rows it exists for. The id is not a column either projection selects, so the check failed for every row that came from Postgres and passed for every row a unit test had hand-built; `execution_ready` is the parser's verdict on the *message*, and releases that had no separate outcome flag wrote false there for rows the workspace's own conditions had blocked, which is how a fix that was correct in the unit test still left a trader reading a sentence their workspace had outgrown. So eligibility is now only this: the row carries a sentence this module owns, in `execution_note` or - where an older build left it - in `parse_error`, matched after whitespace is normalised, because a doubled space or a wrapped line is not a different sentence. The single exception is a hand-written row, because a note a person typed is theirs however wrong it reads. The live sentence is written into `execution_note`, the field the card reads first, which shadows the legacy copy; that copy is dropped from the response and never from the table, so the admin panel, the operator log and `Clear parsing errors` still see what was actually stored, and `status` never moves, because whether an order went out is a fact about the past. Both halves are pinned rather than described: `server/test/read-freshness.test.js` reads the field names out of `overlayLiveBlocker` and asserts each one is aliased by both projections, `server/test/signal-live-blocker-read.test.js` drives the read itself - `createSignalOutcomeReader`, shared by the two routes - against a fake pool, including the branch where the live picture cannot be read and the stored sentence is shown unchanged rather than replaced by a guess, and the Overview's own composition (both statements, both lists annotated, *then* the either/or) moved into `readDashboardSignals` in `services/dashboard-signals.js` so that a route cannot serve one list corrected and the other not.

The banner above the tabs says what is actually in force, in one sentence, and it is derived from the same reading of the settings as the Overview - not from a copy kept beside it: `autoTradingBannerView` in `client/src/lib/platform-view.js` walks the precedence `decideSignalOutcome` uses (the server-side runtime switch, then a platform pause, then a selected account in an executable state, then the workspace toggle) and answers `off`, `unavailable`, `paused`, `no-account`, `not-deployed` or `ready`. Two of those are the ones that used to be read as a bug, because a switch that is on is not a promise that anything will trade: with Auto-Trading on and no account at all the sentence is `Auto-Trading is ON, but no trading account is connected. Connect your account or upgrade your plan to execute signals.` with a button to the Trading Accounts tab, and `Advanced Settings` repeats that same sentence under the switch, where the switch was clicked, instead of leaving a green toggle to imply more than it knows. `Account not deployed` says the account exists but is not ready to trade, and the counter beside the Auto-Trading card carries the short form of whichever state is live (`Waiting for a trading account`), so number and sentence cannot disagree. Nothing here warns the user about the host, the connection or the age of the data: those belong to Admin Panel -> System Health.

### Three layers between a signal and an order

Real-world failures are the ones that cost money, so the order path carries three guards, decided in
`server/services/execution-defense.js` and each of which stops the order *before* MetaAPI is asked for
anything. Nothing in that module touches the database or the network: every layer is a pure decision over
values the engine already holds, so each one can be tested against a mocked adapter.

- **Stale quote (slippage).** An order is only sent against a quote no older than `MAX_QUOTE_AGE_MS`
  (2 seconds, measured from the timestamp MetaAPI stamped on the price against this service's own clock)
  and only while the account reports itself connected and synchronized. A price dated in the *future* past
  the same window is refused too, because clock skew must not be able to look like permanent freshness, and
  a price with no timestamp is refused, because a number that cannot be dated cannot be bounded. The check
  runs twice - when the snapshot arrives, and again at the last gate before the trade row is opened - since
  the sizing, the safety nets and the settings re-read in between are fast but not instant. Skipping is the
  only safe remedy: slippage is prevented by not trading, never by hoping the market holds still. The
  adapter keeps a deliberately looser 15-second tolerance for the *protection* sweeps, because moving a
  stop on a slightly aged price still beats leaving a position naked.
- **Exposure caps.** `guardExposure` compares the live terminal state against the workspace's own numbers,
  never against this app's idea of what is open: `max_open_positions` counts open positions *and* resting
  orders, the day's drawdown is measured against the UTC-day equity baseline and `daily_loss_limit`, and
  `max_daily_trades` is compared with the greater of the broker's own deal count and the local trade rows.
  A missing baseline blocks instead of counting as "no loss yet", and all three bounds are inclusive.
- **What a broker failure proves.** Every refusal - returned or thrown, since MetaAPI's SDK documents its
  order methods with `@throws {TradeError}`, so a thrown refusal is the common case - is classified against
  the return codes MetaAPI publishes, and the classification answers one question: can this request be
  *shown* not to have reached the trading server? Only then is a retry allowed.
  - Transient and provably never delivered (`TRADE_RETCODE_DISCONNECTED_BEFORE_TRADE`,
    `ERR_NOT_SYNCHRONIZED`, `ERR_NO_QUOTES`, a requote, `MARKET_CLOSED`, `TOO_MANY_REQUESTS`) puts the job
    back on the queue with an exponential wait (`1.5s`, `3s`, `6s`, capped, at most three attempts in
    total). `execution_jobs.next_attempt_at` is the wait, so a worker restart cannot lose it or resume
    early, and the signal's own two-minute window still bounds everything: a signal that outlives it
    expires rather than being traded late.
  - Anything whose delivery is *unknown* - `TRADE_RETCODE_TIMEOUT`, `DISCONNECTED_DURING_TRADE`, a socket
    that hung up mid-request - is recorded as `unknown` on the trade and the job and is never retried
    automatically. An accidental second market order on top of a filled first one is the one failure this
    service cannot take back, so it is the one thing no backoff makes safe. A human reconciles it, and the
    row says so.
  - Permanent and account-level (`E_AUTH`, an HTTP 401/403, an investor password, a broker server MetaAPI
    cannot serve, auto-trading disabled on the account) fails the job once, does not retry, and leaves a
    sentence on `metaapi_accounts.execution_note` - *"Broker connection failed. Please check your
    credentials."* - which **Trading Accounts** shows on that account's row. It lives on the account rather
    than on every signal because the account is what is broken, and the engine clears it the moment an order
    goes through, so a fixed problem stops being announced. A refusal of *this order* (invalid volume, a
    symbol rule, a broker cap) stays a rejection on the signal and leaves no note to alarm anybody with.

The client id is the piece that makes the middle bullet survivable. `buildClientId` produces
`SD_<SYMBOL>_<hash of the job id>` - the shape MetaAPI documents (`${strategyId}_${positionId}_${orderId}`),
inside the two lengths it documents too: `clientId` on its own is published as 24 characters at most, and the
comment and the id share a budget of 26 because MetaAPI stores them in one field. The builder caps the symbol
at 6 and the whole id at 23 - `SD_` + 6 + `_` + 12 hex - so a full-length id lands at 22 characters, 24 of the
26 with the `SD` comment, one spare for the servers that join the two fields with a separator. The symbol is
what truncates, because it is decoration for whoever reads the broker's own trade history; the 48 bits in the
tail are what `findOrderByClientId` matches a previous attempt against, so they never yield to it.
`execution-defense.test.js` pins the arithmetic and walks every symbol shape the code can be handed, and an id
that could not fit throws before the terminal is touched (`createMarketOrder`,
`createPendingOrder` and `closePositionPartially` refuse an order with no id or one too long). It is
stable for the life of a job rather than per attempt, on purpose, and it is *not* a promise the broker keeps:
MetaAPI publishes no unique constraint over `clientId`, so a duplicate is not refused for us. What the id
buys is discovery - before a retry sends a job's order a second time, the engine asks the account for a
position, pending order or deal carrying that id (`findOrderByClientId`) and reconciles the trade row
instead of re-sending. An adapter that cannot answer that question is treated as an answer of "unknown",
and nothing is sent on an unknown.

**Break even** extends the same loop instead of adding a second one. For each executed trade whose broker position is still open, once the market has travelled `breakEvenTriggerPoints` in favour of the trade, the stop is moved to the entry price plus `breakEvenOffsetPoints` — an offset is how you cover spread and commission instead of parking the stop exactly where the quote touches it.

- Distances are MetaTrader **points**, aligned onto the symbol's `tickSize`; a buy rounds down and a sell rounds up, so the stop never lands beyond the intended price. On most FX pairs 10 points is one pip.
- Only positions Signal Desk opened are considered; trades placed in the terminal keep their own stops.
- A stop is only moved in the direction that reduces risk. If the existing stop is already at least that protective, the position is marked handled and nothing is sent.
- The broker's `stopsLevel` and `freezeLevel` are respected. When the break-even price sits inside the minimum stop distance, the move is *deferred* and retried as the price travels further, rather than failing.
- Every decision needs a fresh synchronized quote and symbol specification; missing or stale safety data means no request.
- Results are persisted per broker position in `break_even_moves` with the status `moved`, `already_beyond`, `closed`, `deferred`, `failed`, or `unknown`, the previous and new stop, the quote used, and the sanitized provider message. A terminal status is never retried. Deferrals retry on their own clock (15 seconds while the price is too close, 60 seconds when account data could not be read) without consuming an attempt, a broker rejection retries up to ten times, and `unknown` never retries. Changing either distance re-arms positions that were already handled, because the stored row keeps the settings it was decided under.
- Moves run only while the execution runtime is available, Auto-Trading is on, **and** the user is on a paid plan, so "off" — or a lapsed subscription — always means "Signal Desk is not talking to your broker".

### What an order type means here, and how long it waits

A signal that names a price the market has not reached is a request to wait at that price, and a copier that
skips it tells the user nothing useful: the signal looks unread, and the price they were offered is gone by the
time they notice. So the engine now reads the type and routes on it, all of it decided in
`server/services/order-routing.js` (pure: no pool, no adapter, no clock of its own) with the words themselves
coming from `server/services/signal-parser.js`.

- **Which type a message asked for.** An instruction line (`BUY GOLD LIMIT 4011 SL 4005 TP 4030`) is
  authoritative: `LIMIT`/`STOP` next to the direction word, `MARKET ORDER`/`AT MARKET`, and `NOW`/`CMP`/`AT
  ANY PRICE` are all read, and the immediate forms win over a `LIMIT` sitting in the same message. A bare
  `STOP 4005` is a stop-loss leg, not a stop-entry order — that stays true when a `LIMIT` elsewhere in the
  line makes the entry type explicit. When nothing is stated and a *single* entry price was published, the
  order rests at that price as a limit (`order_type_stated = false`, because Signal Desk chose it). A price
  **zone** rests too, at the bound the row is credited with - the least favourable edge for that side - and the
  market's position relative to the range decides which of three things happens, every one of them answered
  where a live quote exists (`pendingOrderPlan`, not the parser): **above** the zone the order waits at the near
  edge for the price to come into it; **inside** the zone it is taken at the current price and the signal row
  says the range was honoured rather than ignored; **past the far edge** it is refused, because a market that
  has run through the entire range a channel described is a dead setup, not a bargain - which is the one case
  where "the fill would have been better than published" is not a reason to take the trade. A zone with no
  direction in it has no bound to rest at and stays a market order. Adding a word to a channel's message is the
  change the reader can make: `NOW` overrules all of it.
- **A market order is judged in the broker's points, not in prices.** `max_slippage_points` (the **Price Drift
  Guard**) is how far worse than the published entry a fill may be. Better is always taken, and the trade note
  says how many points in the user's favour. Blank or `0` — what every workspace starts on — keeps the old
  strict behaviour: refuse and say so, naming the symbol's tick size in the sentence. A symbol whose broker
  published no tick size cannot be measured in points at all, so the order is refused rather than guessed at,
  and a level with nothing to compare it against is not a guard.
- **A resting order carries its own deadline.** `limit_order_expiry_value` + `limit_order_expiry_unit`
  (minutes, hours, days; 1 minute to 30 days, default 30 minutes) become both the row's `expires_at` and the
  `ORDER_TIME_SPECIFIED` expiration sent to the platform, so an unfilled order does not survive Signal Desk
  being offline — the ceiling exists because MT4 accepts only that one type and an unexpired pending order is
  the failure this feature would otherwise create. A signal marked `SCALPING` overrides the setting with two
  minutes and is taken as a market order at once if the market is already at its level. The word is read wherever the channel
  puts it in its own command — on the instruction line, or standing alone on a line of its own (`SCALPING`, `🔥 SCALPING 🔥`),
  which is how a label is written — but a *sentence* about scalping is not a label, so "this is not a scalping setup, hold
  for hours" does not set a two-minute fuse. A stop whose level the
  market has already passed is a market order too, and a level within the broker's `stops_level` is refused with
  the number named rather than nudged onto a price the channel never published. A limit waiting at the edge of
  an entry zone is swept by the same deadline: an order that never saw the market come into its range is taken
  off the book at the expiry, recorded as `expired`, and the signal stops promising a trade.
- **Nothing rests unwatched.** `sweepExpiredOrders` (in the same engine, hooked into the worker's
  every-`N`-seconds block) reads the rows `trades.status = 'pending'` keeps in `trades_pending_expiry_idx`,
  groups them by account, and asks the broker once per account for positions, deals and open orders. Order gone
  before its deadline → `cancelled`; gone after it → `expired` (a cancel we sent *because* the deadline passed
  is an expiry by any name); a position or a deal found instead → `executed`, booked at the price and size the
  broker actually produced, with the note that break-even and scale-out were not set up for it. An account that
  cannot be read leaves every row exactly as it was; a row with no broker reference to match is `unknown` rather
  than a guess. The sweep gates **writes** on the runtime switch but not reads, because reconciling history is
  what protects a user while execution is paused.
- **The vocabulary that goes with it.** `pending` and `cancelled` were added to the signal status check, the
  job-status mirror and the client's outcome map; `expired` already existed and now means what the sweep does. A
  resting order counts against the workspace's open-position cap and its scale-out plan is suppressed — there
  is no position to split yet. Every one of these states is one the UI can render: `Waiting at your price` on
  the signal, `on the book` on the trade, and a line under the row that says the level and how long is left.

`server/test/order-routing.test.js` pins the arithmetic and the boundaries; `server/test/order-type-execution.test.js`
runs the whole flow — parse to job to broker call to settled row — against a fake adapter, including the six
end-to-end cases this feature is judged by (three of them the positions of a market relative to an entry zone,
and the sweep that cancels a zone order nobody came to); `server/test/metaapi-trading.test.js` pins the shape of the trade
request both platforms receive.

### Trailing stop

**Break even moves a stop once; a trailing stop keeps moving it.** `trailing_stop_enabled` and `trailing_stop_distance_points` sit beside the break-even settings and feed the same `sweepBreakEven()` — deliberately the same sweep, so there is only one code path that may write to a broker position and only one set of rules to audit. When both protections are on, the engine computes both targets and takes the **more protective** one (higher for a buy, lower for a sell), so turning trailing on can never weaken break even and turning break even on can never stall a trail.

- The trail keeps the stop `trailingStopDistancePoints` from the market: `bid − distance` for a buy, `ask + distance` for a sell, aligned onto the symbol's `tickSize`.
- **It only ever tightens.** If the market retraces, the price the trail would ask for is looser than the stop the position already holds, so the decision is `wait` and nothing is sent. That is also why a trail turns break-even's terminal `already_beyond` into a `wait`: the position stays in the sweep rather than being settled and forgotten.
- **It never acts on a stale quote.** As with break even, the price, the position's current stop, and the symbol specification all come from one synchronized account read inside the sweep; `waitForFreshPrice` refuses a quote older than the freshness window, and a failure to read is a deferral, never a guess. Nothing from a previous sweep is reused as evidence.
- **Ambiguous provider answers fail closed.** `classifyBreakEvenFailure` still decides the follow-up: a broker condition that can clear is deferred and retried on its own clock, a definite rejection retries up to ten times, and an unconfirmed change is recorded as `unknown` with **no** scheduled retry. `unknown` and `closed` rows are never re-offered to the sweep, so a trail cannot resend a modification the broker may already have applied.
- Each position keeps exactly one ledger row, with `move_count` incremented for every applied move and `trailing_distance_points` recorded, so the activity list can say "Stop trailed (1.1020) · 4 moves, 30 points behind" instead of implying a one-off break-even edit.
- Cadence and rate limits are unchanged: one sweep per `BREAK_EVEN_SWEEP_INTERVAL_MS`, at most `BREAK_EVEN_SWEEP_LIMIT` positions, `stopsLevel` and `freezeLevel` honoured, and Auto-Trading off (or a lapsed plan) stopping every write.
- With more open trades than the sweep limit, the queue is ordered so a position that has never been protected goes first, then due retries, then ratchets — a full set of established trails can never starve a fresh move. Within each class the row touched longest ago is served first, which rotates the trails.

The sweep shares the worker's polling loop, and an order always goes first, so protecting an open position can never delay a fresh signal. A busy stream of signals cannot starve protection either: every fifth iteration also attempts a sweep.

**The queue is woken, not polled.** `pollIntervalMs` (1200) is the *idle* wait, not the wait a signal sits in: the capture path calls `executionWorker.notify()` the moment it has inserted a job, which starts a pass on the spot, and a pass that claimed a job goes straight into another one — up to `followUpLimit` (8) times — so a burst of signals is drained in consecutive round trips instead of one per interval. A wake that lands mid-pass sets a flag instead of starting a second pass, so the loop is never re-entered concurrently, and `notify()` is never awaited by the capture path: an order that takes a second must not hold up the row the trader is waiting to see. Before the wake-up existed, the first order after a quiet minute waited up to 1.2 s — a sixtieth of the two-minute window in which the channel's price is still the price that was meant — and a burst waited 1.2 s per signal on top of that. `BREAK_EVEN_SWEEP_INTERVAL_MS` throttles the sweep itself (default `5000` ms, floor `1000`), so calling it often costs nothing. No test or deployment path places a live order: the broker adapter is always faked.

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
- **Advanced Settings** (`/advanced`) — everything that decides what an order does, as three folded bars (`SettingsSection.jsx`): **Core Execution** (open) with the Auto-Trading toggle and its required red warning, the connected trading account, the lot size and the **Price Drift Guard**; **Trade Management** (closed) with break even, the trailing stop, **Multiple Target Handling** and **Limit Order Expiry**; and **Advanced Safety Nets** (closed) with the two blocks and the two fallback distances. It is the power-user page, and the runtime and platform-pause notices lead it above the bars, because they explain why nothing is moving.
- **Profile** (`/profile`) — the name, email, role and age of the account, the password flow, and the **Danger Zone** at the bottom. Identity is read-only because it is the credential, not a setting: the password is changed through the same emailed reset link the sign-in screen uses (`/api/auth/prepare-password-reset` then Supabase `resetPasswordForEmail`, redirecting to `/update-password`), which is one client helper — `src/lib/password-reset.js` — so the two surfaces cannot drift into preparing-or-not preparing separately. Account deletion is unchanged: same `DELETE /api/auth/account`, same password-plus-`DELETE` confirmation, now nowhere near a number that sizes a live position.

Both settings pages own the fields they show, and no field is editable on two of them — `client/test/settings-navigation-ui.test.mjs` derives the field list from the route itself (`req.body.*` in `PUT /api/settings`) and fails if a field gains or loses an owner. The three pages are also the app's routes: `/advanced` and `/profile` are in `client/public/manus-routes.json` next to `/admin` and `/billing`, because a path the static host does not know is a 404 on refresh - see **Render deployment** for the rewrite that answers every path with the app shell.

The fold is a `<details>` element with a chevron that turns on the browser's own open state, so a bar is readable with no script, keyboard-operable, and reported as expanded or collapsed without anyone maintaining an `aria-expanded` by hand. Two of the three bars are closed by default, and the one that is open is the one a reader most often changes. Each header carries a one-line state — `Auto-Trading OFF`, `No stop moves · First Target Only`, `Blocking` — because a folded bar that only named itself would be a click to find out whether anything is protecting a trade; every sentence longer than that lives in the body, where it is read by the person about to change the value.

Under the title, a bar states itself in one short line: `Decide if and how signals become orders.`, `Manage Break Even, Trailing Stops, and Multiple Targets.`, `Configure fallback SL/TP and safety blocks.` At 760px and below the header becomes a two-row grid — title and state sharing the first row at either end, the description taking the full width underneath — because on a wrapping flex line the badge would not shrink and the description got whatever was left of a 360px row, which is a word per line. `display:contents` on the heading wrapper is what moves the title and the description into the grid without a second copy of the markup to keep in sync.

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

The parser returns facts, and the row stores them, so the panel never has to guess: `directionInferred`, and the three `missing` prices are what `Signals` renders as **Inferred**, **Missing SL**, and **Missing TP** badges. A message that yielded no trading data at all reads **No clear signal**; a message that was legible but unusable reads **Needs review** with the server's own sentence under it, because "unclear" was sent to people whose channel had written a perfectly readable note with one line missing. A row whose entry was published as a zone shows the range - `Entry 4016 - 4026` - rather than the one bound the order was credited with, because a single number on a row the channel wrote as a range reads like a price somebody invented; the bound in force, why it is the worst edge for that side, and what the order does at each position of the market relative to the zone are the hover text.

A channel that writes `Gold Buy now` and `SL: 4041.50` has said everything it intends to say: the metal, the direction, and the level that kills the trade. The entry is absent *on purpose*, and it is the one leg that must never be treated as a defect, so the parse yields `entry_price = NULL` with no blocker and no error, and the execution engine's entry guard - which refuses a limit-style entry when the live quote has moved past it - is skipped because there is nothing to be worse than. The order goes to MetaAPI as a true market order (no price field is ever sent) at the ask for a buy and the bid for a sell, and a missing target is completed from the workspace's fallback distance measured from that live price. The only refusal this shape can earn is the take-profit block the user switched on themselves, which is worded as such. `Market` is shown as a badge next to `Missing SL`/`Missing TP` so the absent entry reads as a decision and not as a gap: it appears when a Telegram message carries a stop or a target but no entry, and never on a message that named no price at all. The asset half of this depends on a symbol surviving the punctuation real channels use, so alias matching is bounded by alphanumerics only - `Gold,` `Gold.` `Gold:` `#Gold` and `*Gold*` all resolve, while `DOWN` still does not contain `DOW` and `ETHICAL` still does not contain `ETH`.

### Two readers, and only one of them may spend money

Telegram signals arrive as advertising copy, so the parser is two layers with a rule between them.

**Layer 1 is deterministic and free** (`services/signal-parser.js`, with number handling in `signal-numbers.js`). It reads the aliases channels use (`GOLD` → `XAUUSD`, `SILVER` → `XAGUSD`, `LONG`/`CALL` → buy, `SHORT`/`PUT` → sell), both decimal traditions (`1,0850` and `1.0850`), the separators that are not colons (`SL - 4011.00`, `Invalidation: 4011.00`, `TP 3 : 4029.50`), entries written as a zone (`4026.00 - 4016.00`, whose *least favourable* bound is the one the row is credited with, and whose two bounds are stored beside it as `entry_range`) or as a DCA ladder (whose first level is the entry), `@`- and `$`-decorated prices, and legs given as distances (`TP 50 pips`, and the reversed `30 pips SL`). Emoji, join-links and risk disclaimers are stripped before any of that is read. A number that could only be read by guessing - `4,011` with nothing nearby to anchor it - is *not* guessed: the message's own unambiguous numbers vote, and a tie leaves the leg flagged as ambiguous and unreadable rather than missing, so no fallback can quietly stand in for a coin flip.

**Layer 2 is a language model** (`services/signal-llm.js`) and fires only when Layer 1 found something price-shaped and could not finish reading it, which keeps the cost at zero for a well-formed channel and for hype. It is asked to answer with `symbol`, `side`, `entry`, `stop_loss`, `take_profit`, `confidence` - `null` for anything unclear, refusal explicitly preferred - and three things are then true of its answer:

- **A model may complete a signal; it may not create one.** A tradeable row still needs the instrument, the direction, and at least one price from Layer 1. If only the model understood the message, the row is stored and marked for review.
- **A price the message does not contain is not a price.** Every number the model returns is checked against the digits in the raw text; an invented one voids the reading and says so (`The AI reader reported a price (7.77) that does not appear in the message`).
- **Confidence below `LLM_MIN_CONFIDENCE` (default 0.85) is a refusal**, as is a missing symbol or side, a timeout, a non-JSON reply, or an unreachable endpoint. Every one of those lands on *saved and blocked*, never on a guess.

Degradation is a supported state: with no `LLM_API_KEY`, the boot log says `[Parser] LLM Fallback disabled (no API key).`, Layer 2 is never attempted, and a signal Layer 1 could not finish is stored for review rather than traded.

**The model is a shared resource, so it has a queue in front of it** (`services/llm-gate.js`). A message Layer 1 finished never enters the gate at all, so nothing about the ordinary well-formed signal depends on a remote server; a message that needs the model asks the gate, which keeps at most `LLM_MAX_CONCURRENT` requests open, serves a live capture before a replayed one, and refuses a *live* request never - a live signal is the one where seconds decide whether the level is still there. A replayed message that cannot get a slot within `20000 ms`, or cannot fit in the waiting line of `8`, is answered `gated`, which the pipeline treats exactly like an unreachable endpoint: the row is stored for review with the sentence `The AI reader is already catching up on this channel, so this message was left for review.` A catch-up row that waits is still a stored row; a live signal that misses its level is a trade that did not happen. What the queue is doing is visible in Admin Panel -> System Health rather than in a log.

The missing-leg pills are advice, so they have to be earned: `Missing SL` and `Missing TP` appear only on a row that states at least one price or distance, because a captured "should I post more setups?" is not a signal with a hole in it, and two pills telling a user to fix a trade that never existed reads like a parser failure. A card with no direction in it shows no `received` pill either - the outcome pill already says what happened. The row's delete control sits inside the wrapping badge group rather than beside it, so on a phone it wraps with the pills instead of landing alone on a line of its own.

**Two sentences sit on a captured row, and only one of them is for the trader.** `signals.execution_note` and `signals.parse_error` are rendered on the card, in the list, on a phone, in front of somebody deciding whether to trust the app with money; they say what happened and what to do, and they never say how. `signals.technical_note` is the other half: the status code, the provider's own body, the exception, the model that was asked. It is written by the same code paths and selected by exactly one query - `adminSignalColumns` - so it can be read in the admin panel and in the log and cannot reach a browser; the socket payload and the two user-facing list routes do not carry it, which `read-freshness.test.js` and `signal-capture-outcome.test.js` hold. Nothing is thrown away when a sentence is filtered: `friendlySignalNote` in `services/signal-wording.js` classifies the text (a reading failure, a broker decline, a missing leg, or nothing recognisable), puts the matching friendly sentence on the row, and stores the original beside it - redacting anything that looks like a credential on the way in, because a provider error body is exactly the kind of text that arrives containing one. The same filter runs on the client before anything reaches the DOM - `client/src/lib/user-note.js` is what a signal card, a row in Recent execution activity and an account's note all call - because the database still holds rows written before the rule existed, and because a trade's `error_message` is written by a code path that has never promised to be friendly. What a sentence may not contain is one regular expression, `TECHNICAL_NOTE_MARKERS`, and the client's copy of it is compared to the server's character for character by `test/signal-wording.test.js`, so the two halves of the same column cannot drift into disagreeing about what is safe to show.

A row that needs review is blocked from auto-execution **even when the workspace has fallback distances set** - that is the whole point of the flag: `needs_review` is enforced again inside the execution engine, immediately after the job claims its signal, so a row cannot trade on the strength of a queue entry alone. `needsReview` renders as **Needs Review**, `parsedBy = 'llm'` as a purple **AI Parsed** badge carrying the model's own confidence figure in its hover text, and a leg given in pips as **Pips TP 50** - with the meta line writing `TP 50 pips`, never a bare `TP 50`, because a distance rendered as a price reads like a level that does not exist.

Pips are stored as distances and converted at the moment an order is built (`pipSizeFor` in `signal-safety.js`), never at parse time: a pip is 0.0001 on a currency pair and 0.01 on a yen pair, and on gold, an index or a crypto asset there is no agreed pip at all, so such a leg is refused out loud (`take-profit-pips-unusable`) instead of priced on a hunch. A leg stated in pips also counts as *present*, which is what stops a workspace's fallback distance from overwriting the number a trader actually wrote down.

New workspaces start with a net - `fallback_stop_loss_points` 500 and `fallback_take_profit_points` 1000, as column defaults, so existing rows are untouched and an upgrade cannot hand forty-five historical signals a safety net nobody asked for. A missing leg is completed from the live quote; nothing is executed from a direction alone, because `BUY GOLD` is enthusiasm rather than an instruction, and a message with no price anywhere in it is refused with a sentence that says so.

Direction inference is deliberately narrow and never silent: it runs only when the message names no direction word at all, has an entry and exactly one target, and the two differ - target above entry is a buy, below is a sell. The row is then flagged `direction_inferred = TRUE`, `execution_ready = FALSE`, and a blocker (`The trade direction was inferred…`) that keeps it out of the queue. An inferred direction is shown, never traded.

**A headline is not a signal, and is never asked about.** Market news has the shape a signal scanner is built to notice - instruments, prices, and verbs about prices moving - so `signal-parser.js` classifies the message before anything is stored from it. News wording (a `JUST IN` / `BREAKING` / `HEADLINES` lead, a journalism noun such as `report`, `news` or `analysts`, a price described as `dumping`, `plunging`, `rising above` or `falling under` a level, or a list of three or more cashtags) *and no instruction of its own* - no `BUY`/`SELL`/`LONG`/`SHORT`, no labelled entry, zone, stop or target - makes it a bulletin. Then every field is cleared rather than left half-read, so the row shows **No clear signal** with the reason `This message is market news rather than a trade instruction, so nothing was taken from it.` instead of a symbol nobody was told to trade; the legs stay `missing`, so a workspace's fallback distance cannot finish a headline into an order. The order of those two tests is what keeps this from becoming a keyword blocklist: `JUST IN 🚨 SELL GOLD 4016 SL 4010 TP 4050` is a genuine signal with a shout in front of it and is read as one. Layer 2 is not consulted about a news row at all - asking a model what trade a headline implies is how a headline acquires a direction - and where a bulletin does quote verifiable levels, the model may complete a price while `mergeGaps` refuses to give it a direction. `signal-parser.test.js` and `signal-two-layer.test.js` pin the bulletin from the brief: no request made, no symbol stored, no direction inferred, no fallback distance applied.

**A management update is not a new instruction either.** A channel talking about a trade it already gave reads like one to a scanner built to notice prices and verbs about prices: `HIT TP 1 ✅ +50 PIPS`, `CLOSE NOW`, `set BE`, `move SL to BE`, `TP 2 HIT` each used to become a row with a symbol, a direction and a `Market` badge, on the strength of a sentence that asked for nothing to be placed. What decides it is the shape of the message, not a keyword list - a target being *reached*, a stop being moved to break even, or an instruction to close, with no entry, stop or target labelled as new levels. `signal-parser.js` classifies that shape before anything is stored, and one classifier is consulted in four places on purpose: Layer 1 clears every field, the gate in front of Layer 2 (`needsLayer2`) refuses to ask a model what trade a management note implies, the pipeline's merge cannot let a model hand a direction back, and `signal-safety.js` refuses the row - so no path can disagree with another about what the message was. The row reads **No clear signal** with the sentence `This message manages a trade that is already open - a target hit, a stop moved to break even, or an instruction to close - rather than giving a new entry, so nothing was taken from it.` (`signals.parse_error`, code `trade-management-update`). Two details are deliberate: the distance in `+50 PIPS` is a settlement of a target the channel already published, so it is not copied into a leg, and `BE` is not a symbol - a marker regex that cannot match a sign is how that one was found.

Channel matching is by *both* spellings of a chat id. A supergroup or channel is `-100xxxxxxxxxx` when marked and `xxxxxxxxxx` when not, and GramJS hands over whichever shape the accessor in use happens to produce, so `channels.channel_id` is compared with the full variant set (`= ANY($2::text[])`); a single exact-string comparison dropped every live message the first time the two sides disagreed. Basic-group ids are never rewritten - only matched - because canonicalising `-7` into `-1007` would create a chat that does not exist.

Nothing a monitored message does is quiet any more: the listener logs an `info`/`warn` line for every update it sees, including the ones it ignores and why (no text, chat not monitored, no id to match on), and a failure while storing is logged rather than swallowed. Unparseable and refused messages are still stored: a captured signal is the record that Telegram said something, not a reward for parsing cleanly.

## Live delivery: a new signal reaches the screen, and old ones do not

The Signals tab used to be one 20-second timer, which made the honest description of the product "a signal appears within twenty seconds of Telegram saying it" - and made that same timer the only thing keeping the settings the Auto-Trading banner reads up to date. It is now a push with a poll behind it.

**The server announces the row it has finished writing.** `saveSignal` emits `signal:received` to the room `user:<userId>` after the outcome `UPDATE` and after any queued job is in `execution_jobs`, so the object a client renders from a push is the decided row rather than the pre-decision one. Those two writes have a fixed order of their own: the row is annotated **before** the job exists, because the engine mirrors an order's outcome onto the same `status`/`execution_note` columns, and a queue that opened first could be answered first and have `queued` written back over `executed` — a trade that happened, displayed as one that did not. That single emit is the only place a captured row is announced, and it targets the workspace the row belongs to, so a signal captured while an operator is inside a support session lands in the workspace being watched.

**The browser listens, and keeps the timer as a fallback.** `client/src/lib/signal-feed.js` opens one Socket.IO connection authenticated with the same bearer token the REST routes use (websocket transport only, so a proxy that does not speak `Upgrade` fails fast instead of half-connecting) and merges a pushed row into the head of the list (`mergeSignalRows`) without ever growing the page. A push is treated as a *hint*, not as the truth: one debounced refresh follows 1.5 s later (`createReconciler`), which is the reading that agrees with the database and with the counters. While the connection is up the poll slows to `60000 ms`; when it is not, it is the old `20000 ms` loop, so a blocked socket costs latency and never costs data. A closed feed ignores rows that arrive late instead of resurrecting state, and a tab becoming visible refreshes once, because a phone whose tab slept through a signal is the case a live connection cannot cover on its own.

**Nothing on the live path waits for the model or for the backlog.** Layer 1 is synchronous and free, and only a message that needs Layer 2 enters the gate above. A catch-up pass (`runCatchUpPass` in `services/telegram-listener.js`) pulls at most `25` messages, runs at most once every five minutes per client, gives up after a `20000 ms` budget, yields to the event loop between messages so a replay cannot starve a live capture, and marks its rows `replayed: true` - which is how they end up served *after* live ones by the model queue instead of in front of them.

**Ordering is the database's job.** The Signals tab, the dashboard strips and the history are each read `ORDER BY created_at DESC`, and the client never re-sorts, so a pushed row, a refetched page and the Overview agree about what is newest. Each of those reads answers `Cache-Control: no-store` (as the settings and trades routes already did), so neither a browser nor a proxy can put an older page between the user and the row that just arrived. `test/read-freshness.test.js` holds the server to both halves.

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
| Free | ₦0 | none (review only) | 2 | 50 |
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

### A dialog that survives the panel underneath it

Suspend, Impersonate, and Adjust plan are dialogs, not rows: `AdminActionModal` is one component used by all
three, and `ConfirmModal` stands in front of every permanent clear. Four rules make them usable, and each one
exists because a real interaction broke without it.

- **The dialog is portal-rendered into `document.body`.** A form that lives inside a conditionally rendered
  subtree is a form that subtree can close: the panel refreshed its list, or swapped to a loading state, and
  the reason an administrator had typed was gone with it. Its *state* stays with the caller - the panel needs
  the reason to send it - but its place in the tree does not.
- **The panel replaces itself with a spinner only on its first paint.** Gating the content on `loading` (or on
  "the overview read worked") means every later search or page turn blanks the panel, which unmounts whatever
  was open on top of it. `painted` is set in a `finally`, so a section that failed still counts as read and
  the panel stays on screen showing what it knows.
- **A refresh cannot close a dialog.** Suspension targets the account id captured when the dialog opened, and
  the write uses that id and nothing else, so paging or searching the list behind it has no bearing on who is
  about to be suspended. The old code closed the form on both paths, which discarded typed text to protect
  against a mis-targeting that was already impossible.
- **Focus is placed once per opening, and only if the caret is not already inside.** An effect that re-ran per
  render re-focused the *first* field on every keystroke - out of the Reason input and into a `<select>`, which
  on a phone closes the keyboard as it does so. Likewise Escape and the backdrop read the live `busy` flag
  through a ref rather than as an effect dependency, so the wiring is not torn down and rebuilt per character,
  and the backdrop only dismisses a press that *started* on it: closing a mobile keyboard shifts the layout
  under the finger, and the release then lands outside the dialog.

`client/test/admin-modal-interaction.test.mjs` mounts the panel in jsdom and drives it - open, type, search,
switch tabs, press every button on every tab - because "the dialog is still open after a keystroke" is not a
property static markup can show. That file is why `jsdom` is a devDependency of the client; nothing in `src/`
imports it. The route behind each button is pinned too: every path the panel calls is walked through the
server's router in declaration order, so a button whose endpoint was renamed or shadowed by a `:param` route
fails a test instead of a user's afternoon.

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

`ai_reader` in the same list is the AI reading assistant, and it exists because `LLM_MODEL_NAME` was otherwise only answerable by reading a boot log: the headline is the model this process is actually asking for, or `Off` with the reason when no key is configured. The sentence beside it names the endpoint, the concurrency ceiling, how many requests are in flight and how many are waiting, and how many replayed messages were left for review because the queue was full - which is the only place a `gated` or `reader-failed` refusal is explained as an instance-wide condition instead of as somebody's single odd-looking signal row. A row that could not be read is never coloured healthy, and the payload never contains a key: `gsk_` appearing in it is a test failure.

`ai_reader` reports the last time this process could not consult the reading assistant - the code, the model it asked, and the sentence the card was not shown - because that is the one part of a failed read that has never been visible anywhere an operator looks. It reads process state, not a table, so a reader that is off says `Off` with the reason rather than pretending to have failed, and a reader that is merely busy is reported by its queue depth. The `telegram_parse` rows in the errors list lead with `technical_note` and fall back to the friendly sentence, which is the whole point of splitting the two: the admin screen is where the status code belongs. `Clear parsing errors` clears both halves together, so a row cannot keep a raw provider body after its complaint has been acknowledged.

The errors list has a **Clear parsing errors** button, and `DELETE /api/admin/health/errors` is the whole of it: it unsets `signals.parse_error` on every row that carries one - the same condition the `telegram_parse` tab selects on, minus that tab's time window - and answers with the count it actually removed. The captured message itself is never touched, so a message that was misread can still be reviewed or deleted one at a time afterwards. MetaAPI order rows and stop-move rows are deliberately out of scope: they are the broker's answer about money, and that evidence has to outlive a tidy screen.

The counters are laid out for the reader's width, not the panel's: six across on a desktop, three on a tablet, and two on a phone, where a nested rule that used to fix four columns regardless of the viewport was cutting `Monitored channels` and the last-message time off mid-word.

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

`announcements` rows carry the message, a severity (`info`, `warning`, `critical`), an optional start and end window, and an active flag. A user's dashboard shows up to three live banners at the top of the workspace through `GET /api/announcements/active`, and dismissal is stored per user in `announcement_dismissals` - dismissing on one device does not dismiss it for anybody else, and it does not come back on reload. Retiring an announcement keeps the row (with its dismissal counts and audit trail) instead of deleting it - which is why the history list only ever grew, and why it now has a **Clear history** button. That route is deliberately declared *before* `DELETE /api/admin/announcements/:id`: Express matches in registration order, so a later static path under the same prefix is captured as the id, and the clear would answer `Choose a valid announcement.` instead of clearing anything. `server/test/route-order.test.js` sweeps every literal route in the app for exactly that shadowing. `DELETE /api/admin/announcements/history` removes the rows that can never come back: retired ones and ones whose end date has passed, which is exactly `announcementState()`'s `retired` and `ended`. Live and upcoming banners are outside the predicate, and each banner's `announcement_dismissals` follow it through `ON DELETE CASCADE` instead of orphaning. Severity only changes presentation, except `critical`, which is announced to screen readers as an alert.

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
| `LLM_API_KEY` | No | Enables Layer 2 of the parser (see below). Groq keys start with `gsk_`. Unset means the AI reading assistant is switched off, which is a supported state, not a broken one |
| `LLM_API_URL` | No | OpenAI-compatible chat-completions endpoint. Defaults to `https://api.groq.com/openai/v1/chat/completions` |
| `LLM_MODEL_NAME` | No | Defaults to `llama-3.1-8b-instant` |
| `LLM_TIMEOUT_MS` / `LLM_MIN_CONFIDENCE` / `LLM_MAX_MESSAGE_CHARS` | No | Request budget (default 6000 ms, capped at 30000), the confidence a reading must reach to be usable (default 0.85), and how much of a message is sent (default 2000 characters) |
| `LLM_MAX_CONCURRENT` | No | How many AI-reading requests may be open at once across the instance; defaults to `2`, floor `1`. Replayed messages share a waiting line of `8` in front of that gate and are left for review after `20000 ms` of waiting, which is what stops a reconnect's catch-up from spending the latency of a live signal |
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
| `PG_MIGRATION_LOCK_TIMEOUT_MS` | No | How long one schema statement may queue for a lock before it gives up and retries; defaults to `5000` |
| `PG_MIGRATION_STATEMENT_TIMEOUT_MS` | No | Ceiling on a single schema statement, so a migration cannot run past the deploy; defaults to `120000` |
| `PG_MIGRATION_LOCK_ATTEMPTS` | No | Tries per schema statement before the boot reports it; defaults to `3` |
| `PG_BOOT_CONNECT_TIMEOUT_MS` | No | How long the startup waits for a connection that never answers; defaults to `10000` |
| `PGSSL_VERIFY` | No | `true` also verifies the database certificate. Off by default because `sslmode=require` - what these hosts document - encrypts without verifying, and a deployment should not lose its database over a CA bundle |

The UI/API can be used without Telegram credentials; Telegram is shown as unavailable until `API_ID` and `API_HASH` are configured. Never commit real credentials to Git.

## Render deployment

The deployed architecture uses two Render services because the frontend is a static site and the API is a Node web service. The API connects to Supabase PostgreSQL through its private `DATABASE_URL`; the Render Blueprint no longer provisions a second Render database. The static site uses `VITE_API_URL` to target the API service. Both services are configured to deploy each commit pushed to `main` (`autoDeployTrigger: commit` in `render.yaml`).

**Refreshing a deep link needs a rewrite.** A static host answers a path it has no file for with its own plain `Not Found` page: `index.html` never loads, so the router never runs and `/advanced` looks like a broken app.

Render takes redirect and rewrite rules from two places, and only these two:

1. the static service's **Settings → Redirects/Rewrites → Add rule** in the dashboard, and
2. the `routes:` block in `render.yaml`, which is what `telegram-copier-web` carries (`type: rewrite`, `source: /*`, `destination: /index.html`).

Three things about that rule are easy to get wrong. The action has to be **Rewrite**, not *Redirect* — a 301 replaces the address bar and destroys the very path the router needed. Render never applies a rule where a real file exists, so `/assets/...`, `/manifest.json` and `/service-worker.js` keep being served as themselves and a catch-all cannot swallow them. And `render.yaml` configures **only the services the blueprint created**: a static site added by hand in the dashboard — which is how a second `onrender.com` host usually appears — never receives those `routes:`, so on that service the rule belongs in its own Settings, added once.

`client/public/_redirects` is in the repo too, with `/*  /index.html  200`. On Render that file is inert — it is the Netlify and Cloudflare Pages convention, not a Render one — and it is kept for exactly two reasons: the same fallback is then correct on any host that does read it, and the intent is written down next to the app instead of living only in somebody's dashboard. `client/test/mobile-admin-and-routing-ui.test.mjs` asserts the file, the blueprint entry, and that the two describe the same rewrite, so they cannot drift into pointing at different sites.

The client is the last line rather than the first: `TAB_FOR_PATH` in `App.jsx` falls back to Overview for a path it does not recognise, so a served-but-unknown address — `/risk settings`, typed with a space in it — renders a workspace instead of a blank shell.

Required API variables: `DATABASE_URL`, `JWT_SECRET`, `SESSION_ENCRYPTION_KEY`, and `CLIENT_URL`. Add `API_ID` and `API_HASH` for Telegram sign-in. Add `METAAPI_PROVISIONING_TOKEN` to the API service's Environment settings to enable MT4/MT5 account setup. Keep it out of the static-site environment.

### The port opens before the database, on purpose

`node index.js` used to bind its port at the end of startup, after the schema migration. It is now the first
thing that happens, and the migration runs behind it. That order is the whole difference between a degraded
app and an unreachable one. A deploy that binds nothing for fifteen minutes is reported by Render as
`Port scan timeout reached, no open ports detected` - no error, no cause, no application - and that is what a
held lock looks like from the outside.

Three properties of the old boot made it fail that way rather than noisily:

1. **The schema was one query.** `server/db.js` holds the entire schema as a single block of text, and a
   multi-statement string is one implicit transaction in Postgres: every `ALTER TABLE` in it takes its lock at
   the start and keeps it until the last statement commits. Any other session reading one of those tables -
   the worker, a dashboard query, the previous instance that is still serving traffic while a deploy waits to
   be marked healthy - parks the whole migration, and everything after it parks behind the migration.
   `splitSchemaStatements` in `server/services/schema-sql.js` cuts the text at the semicolons that really end
   statements (a `DO $$ ... $$` body, a string literal, and a comment all contain semicolons that do not), and
   each statement now runs alone, so a lock is held for the length of one `ALTER` instead of one file. The
   string in `db.js` is unchanged: it is still one template literal, so the rule about backticks inside it
   still applies.
2. **Nothing had a timeout.** A statement now runs under `lock_timeout`, gives up, tries again a couple of
   times, and if it still cannot proceed the boot *names the statement* instead of waiting indefinitely. The
   connection itself is raced against a deadline too, because a host that accepts a TCP connection and then
   never replies is the one failure a TCP timeout does not cover.
3. **A failed migration killed the process.** It no longer does: the service stays up, retries with a capped
   backoff, and heals itself as soon as the lock clears. Missing configuration (`DATABASE_URL`,
   `JWT_SECRET`) still exits immediately, because there is nothing to retry and nothing to serve.

While the schema is not ready, every route that would touch a table answers one short sentence with a `503`
(`Signal Desk is still starting up. Please try again in a moment.`) rather than half-working against a table
that has not been created yet. `/health` and `/api/health` stay answering throughout, and no longer wait on
the database: a health check whose answer depends on the thing it is checking turns one stalled dependency
into a restarted instance and a lost log. They report what the boot is actually doing -
`{"database":"unknown","startup":{"ready":false,"step":"connecting","attempts":1}}` - and the same `startup`
snapshot appears in Admin Panel -> System Health.

Two environment consequences are worth knowing. `DATABASE_URL` is now connected to with TLS for any non-local
host unless the URL itself already says otherwise, since a managed database that requires encryption does not
always say so - some simply stop answering, and "stalled" is what that looks like from a deploy log. And
`PG_MIGRATION_LOCK_TIMEOUT_MS` is the knob to raise if a migration legitimately needs to wait behind a long
write on a big table.

`server/test/boot-readiness.test.js` spawns the real server against a database that accepts the connection and
then says nothing, and asserts the port is open anyway, that `/health` answers, that a data route replies with
the 503 rather than hanging, and that the process is still alive retrying. `server/test/schema-migration.test.js`
holds the splitting and timeout rules. Both were confirmed to fail against the boot sequence they replaced.

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
- `GET /api/dashboard` – the Overview's counts, settings and `signals`: at most **three** rows, and only ones that state a price (`execution_ready`, a status that has outlived `unparsed`, or a non-null entry/stop/target). A workspace with nothing actionable gets its three most recent messages instead and `signalsScope: "recent"`, which is the one case in which the panel says so in a line of its own. The full history is `GET /api/signals`, which the Overview's **View all** opens
- `GET/POST /api/channels`, `DELETE /api/channels/:id`
- `GET/POST /api/signals`, `DELETE /api/signals/:id`, `DELETE /api/signals` — every stored message with its outcome: `status` (`received`, `queued`, `unexecuted`, `expired`, `unparsed`, `executed`, `rejected`, `unknown`, `failed` — the last one meaning the account was blocked, not the signal), `executionNote` (the sentence explaining an outcome that was not a trade), `directionInferred`, and the parsed prices; `DELETE` removes captured messages only and unlinks any trade they produced
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
