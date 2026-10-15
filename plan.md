# Telegram Signal Desk update plan

## Existing structure

- `client/src/navigation.js` defines the shared navigation keys and labels used by the app shell and sidebar.
- `client/src/App.jsx` holds the dashboard shell, page titles, and account-note screens.
- `client/src/components/Sidebar.jsx` renders the shared navigation labels.
- `client/src/components/TelegramConnect.jsx` owns Telegram authentication, chat selection, and monitoring controls.
- `client/src/components/MetaApiPanel.jsx` owns the user-facing MT4/MT5 setup workflow and diagnostic display.
- `server/index.js` owns authenticated API routes, safe error responses, and database ownership checks.
- `server/services/metaapi.js` owns allowlisted HTTPS calls, provider/network error details, credential redaction, and funding classification.
- `server/db.js` initializes the PostgreSQL schema used by the Render API and Supabase.

## Implementation approach

Use one shared navigation definition for the sidebar and top-level page title so they cannot drift. Name the reference-only section **Account Notes** and the MetaAPI provisioning/connected-account section **Trading Accounts**. Update related metric, section headings, and the account-note cross-link to use these terms consistently; keep descriptive action labels such as “Add an MT4/MT5 account.”

MetaAPI's documented create-account responses include validation, authorization, permission, provisioning-profile, and broker/account errors. The docs do not specify a deposit or insufficient-funds response for this flow, although they note separately billed resource options and possible charges for repeated credential/settings errors. Preserve any provider-supplied message and HTTP status/code, redact tokens and passwords, and detect funding/billing language (for example insufficient funds/balance, deposit, or payment) so such a provider response is labeled accurately without paraphrasing away its exact text. If `fetch` fails before an HTTP response, capture the safe nested cause/code (including nested causes or aggregate errors), state that MetaAPI returned no provider response, and do not present it as a confirmed funding issue. Keep internal logs useful but secret-free.

The shared frontend API helper must display the backend's safe diagnostic message for MetaAPI failures rather than replacing it with a generic connection message. Keep unexpected internal errors generic. The initial account-creation route must continue to show a configuration-link failure even when MetaAPI has already created the draft account. Do not expose stack traces, raw payloads, tokens, or broker credentials, and do not add trading order operations.

Reuse the existing navy/teal product styling and secure hosted-credentials flow. No new infrastructure or external service integration is needed.

## Design

- **Design movement:** Continue the existing restrained dark-navy and teal dashboard aesthetic, with high-contrast white cards and compact information hierarchy.
- **Core principles:** Clear, trustworthy, calm, and mobile-first.
- **Color philosophy:** Preserve navy for structure, teal for positive actions and connection states, and muted neutrals for secondary information; use warm amber only for caution.
- **Layout paradigm:** Keep the familiar dashboard shell and focused two-panel workspace, collapsing into a single column on narrow screens.
- **Signature elements:** Retain the compact status pills and softly bordered cards; use a distinct secure-link card to make the hosted MetaAPI step obvious.
- **Interaction philosophy:** Make progress and success visible, disable duplicate submissions, and keep sensitive credentials on MetaAPI rather than in Signal Desk.
- **Animation:** Reuse existing short transitions and honor `prefers-reduced-motion`; do not introduce decorative motion.
- **Typography system:** Preserve the existing DM Sans body and Manrope heading pairing, with consistent readable sizes and line heights.
- **Brand essence:** A focused workspace for reviewing Telegram signals and organizing account connections; practical, composed, and transparent.
- **Brand voice:** Plain and reassuring. Example: “Search your Telegram chats.” “Your trading password is entered on MetaAPI, not here.”
- **Wordmark and logo:** Keep the current Signal Desk wordmark and installed-app icon; do not replace existing brand assets.
- **Signature brand color:** Retain the current teal (`#1e6878`) as the primary action color.
