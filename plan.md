# Telegram Signal Desk update plan

## Existing structure

- `client/src/App.jsx` holds the dashboard shell and top-level routes.
- `client/src/components/TelegramConnect.jsx` owns Telegram authentication, chat selection, and monitoring controls.
- `client/src/components/MetaApiPanel.jsx` owns the user-facing MT4/MT5 setup workflow.
- `server/index.js` owns authenticated API routes, rate limiting, and database ownership checks.
- `server/services/metaapi.js` owns the allowlisted HTTPS calls to MetaAPI.
- `server/db.js` initializes the PostgreSQL schema used by the Render API and Supabase.
- `render.yaml` defines the API and static-site services.

## Implementation approach

Reuse the current product styling. Keep the existing Telegram chat search and plain-language copy. Rename the sidebar item from “MetaAPI” to “Trading Accounts,” which describes the page’s purpose rather than the provider.

The recent setup failure is caused by a non-resolving MetaAPI base hostname: Render logs show the request could not reach MetaAPI, and a no-token check confirms the current single-`agiliumtrade.ai` hostname fails DNS while the hostname in MetaAPI's official examples responds. Use `https://mt-provisioning-api-v1.agiliumtrade.agiliumtrade.ai` as the server-side endpoint in the helper, Render configuration, and documentation. Keep the official `auth-token` request header; the current account body (`name`, `server`, `platform`, `magic: 0`) is valid and intentionally omits login/password.

Improve error reporting without exposing secrets. Keep explicit friendly mapping for known MetaAPI errors, attach a sanitized provider message/status/error code to errors returned from the MetaAPI helper, and let the server return a separate safe `userMessage`. The shared frontend request helper must display that field for MetaAPI errors even when the HTTP status is 5xx, while unexpected server failures continue to use the existing generic message. Never return tokens, broker credentials, stack traces, or unfiltered provider payloads.

Keep the existing secure account setup flow, ownership checks, and no-trading-order boundary. Configure Express to trust the Render reverse-proxy hop before the rate limiters so per-client rate limiting uses the forwarded client IP without trusting all proxy hops.

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
