# Telegram Signal Desk Phase 3 implementation plan

## Existing project structure

- `client/src/App.jsx` owns the dashboard shell, navigation/page titles, overview, signals, account notes, and preferences.
- `client/src/components/Sidebar.jsx` renders the shared navigation labels; `client/src/components/TelegramConnect.jsx` handles Telegram login and channel selection; `client/src/components/MetaApiPanel.jsx` handles secure MT4/MT5 setup and connected-account display.
- `client/src/components/ExecutionSettings.jsx` owns execution preferences, account selection, the new-workspace default-on Auto-Trading toggle, immediate off control, and the required safety banner.
- `server/index.js` owns authenticated HTTP routes, Telegram listeners, signal capture, MetaAPI account ownership, and worker lifecycle.
- `server/db.js` initializes the existing PostgreSQL schema. It will add execution settings, idempotent Telegram event identifiers, persistent execution jobs, daily equity snapshots, and trade-result fields using idempotent migrations.
- `server/services/signal-parser.js` will replace the basic inline regex parser with a strict, testable parser. Existing signal capture remains available when a message is not executable.
- `server/services/metaapi-trading.js` will own a long-lived `metaapi.cloud-sdk` instance and synchronized streaming connections. It will use the provisioning token for app-created accounts and the user's encrypted token for previously linked accounts.
- `server/services/execution-engine.js` applies the Auto-Trading setting, account, trade-count, daily-loss, signal-freshness, quote, and position-size checks before placing an order.
- `server/services/execution-worker.js` will claim durable Postgres jobs with row locking, record each outcome, and stop cleanly during shutdown. Unit tests will mock the broker adapter; no test or deployment will place a live order.

## Implementation approach

Add an **Execution Settings** section inside Risk Settings. Persist Auto-Trading (default ON for new workspaces; do not silently change existing users), lot size mode (Fixed Lot or Risk-Based), fixed lot size, maximum open trades, maximum daily trades, maximum risk per position, daily loss limit, and one user-selected connected MT4/MT5 account. Keep the required red warning text exactly: “Warning: Enabling Auto-Trading will execute live trades on your connected broker account. Ensure you are using a demo account for testing. You are fully responsible for any financial losses.” Make the OFF action immediate and available even when no account is selected or the execution worker is unavailable; an order already submitted to the broker cannot be recalled by this toggle.

The Telegram listener performs deterministic parsing and validation for an explicit BUY/SELL, symbol, optional single entry, mandatory stop loss, and optional single take-profit. Continue saving every monitored message for review, but queue only new, deduplicated Telegram messages that parse safely and whose user's setting is ON. Do not auto-execute manual notes, unrecognized messages, ambiguous entry ranges, or messages with multiple take-profits. Expire queued signals after two minutes so a sleeping or restarted service cannot execute stale messages.

Run the worker continuously while the API process is online, as the user explicitly requested; set the API's server-side `AUTO_TRADING_RUNTIME_ENABLED` switch to `true`. For new workspaces, Auto-Trading defaults ON as requested; users can turn it off immediately. Existing user settings are not bulk-enabled. No order can be placed until the user has selected an owned deployed account and all execution gates pass. The API and static frontend are separate Render services: UptimeRobot must ping the API `/health` endpoint, not the static website, to keep the worker's service active. The current API is on Render Free and may still sleep or restart, so explain that keep-alive monitoring does not guarantee uninterrupted trading. Expire stale jobs and fail closed when any safety data is missing. Do not change or upgrade the Render service plan.

Before processing an order, re-check the user's current Auto-Trading setting, selected account ownership and deployed state, signal age, synchronized broker connection, current open-position count, Signal Desk orders submitted during the current UTC day, and daily loss. Re-check the toggle and selected account again immediately before broker submission. Count every open broker position against the open-trade cap. Use persisted UTC-day account-equity snapshots for loss limits, including floating account equity; if a required baseline is missing or stale, do not trade. When Auto-Trading is first enabled mid-day, capture current equity as the baseline for the remainder of that UTC day. Keep the execution limits in the UI clear about what is counted.

Require a valid stop loss on the correct side of the current quote. For Fixed Lot, validate the user's amount against the broker's min/max and volume step. For Risk-Based, compute risk cash as account balance multiplied by risk percent, divide by the stop-distance loss per lot using MetaAPI `lossTickValue` and the symbol `tickSize`, then round down to the broker's `volumeStep` and reject values below the minimum. Reject stale quotes and unsupported symbols. Use market buy/sell methods only: when a signal includes an entry price, submit a market trade only if the current quote is not worse than that entry for the signal direction; otherwise skip and record why. Use one explicit TP; multiple targets remain captured but are not auto-traded until their handling is configured.

Create a trade record before submitting the MetaAPI order and update it with a sanitized provider response, broker order/position IDs, execution status, and any safe rejection details. Use a stable `clientId` derived from the signal/job to reduce duplicate orders. Do not automatically retry an ambiguous network failure because the broker may already have accepted the first request; record it as unknown and require reconciliation. Any provider rejection is persisted with its exact sanitized message and code. Do not add a simulation or paper-trading path.

## Design

- **Design movement:** Continue the restrained navy-and-teal dashboard style, with a clear visual distinction between saved preferences and executable settings.
- **Core principles:** Clear default-on notice, one-action immediate off control, fail-closed safeguards, legible status, and mobile-first touch access.
- **Color philosophy:** Preserve navy structure and teal actions; reserve saturated red for the live-trading warning and blocked safety conditions.
- **Layout paradigm:** Keep the existing dashboard shell and present execution controls in a focused section that stacks vertically on mobile.
- **Signature elements:** A prominent red Auto-Trading warning, visible OFF/ON status, and concise execution-result badges.
- **Interaction philosophy:** Auto-Trading starts ON for new workspaces; existing users keep their saved preference. Allow OFF even without an available runtime/account; require a runtime to turn it on from OFF and require an owned deployed account before orders can execute. Show exactly why a signal was skipped or rejected without exposing secrets.
- **Animation:** Reuse existing short transitions and honor `prefers-reduced-motion`; do not add decorative motion.
- **Typography system:** Preserve DM Sans body text and Manrope headings.
- **Brand essence:** A composed workspace for automated Telegram signal execution with clearly visible risk controls; practical, explicit, and transparent.
- **Brand voice:** Plain and direct. Examples: “Auto-Trading is on for new workspaces.” “This signal was skipped because its stop loss was missing.”
- **Wordmark and logo:** Keep the existing Signal Desk mark and installed-app icon.
- **Signature brand color:** Retain teal `#1e6878` for primary actions; use red only for material execution risk.


## MetaAPI contract references

- The official JavaScript SDK README specifies `metaapi.cloud-sdk/esm-node` for native Node.js ECMAScript modules. The streaming guide requires synchronizing before relying on terminal state and shows market buy/sell orders with stop loss, take profit and `clientId`: https://github.com/metaapi/metaapi-javascript-sdk/blob/main/readme.md and https://github.com/metaapi/metaapi-javascript-sdk/blob/master/docs/metaApi/streamingApi.md
- MetaApi's symbol specification exposes `tickSize`, `minVolume`, `maxVolume` and `volumeStep`; current symbol-price objects expose bid, ask, `lossTickValue` and quote time. Risk-based volume therefore uses the synchronized quote's losing tick value and the symbol specification's tick size, while failing closed if either is missing: https://metaapi.cloud/docs/client/models/metatraderSymbolSpecification/ and https://metaapi.cloud/docs/client/models/metatraderSymbolPrice/
- MetaTrader deals classify `entryType` as `DEAL_ENTRY_IN`, `DEAL_ENTRY_OUT`, `DEAL_ENTRY_INOUT` or `DEAL_ENTRY_OUT_BY`; the daily cap counts unique opening order/deal identifiers and skips exits: https://metaapi.cloud/docs/client/models/metatraderDeal/
- MetaApi streaming documentation exposes terminal account state, positions, pending orders, specifications, prices and synchronized history; history is treated as unavailable until deal synchronization completes: https://metaapi.cloud/docs/client/websocket/usingStreamingApi/
