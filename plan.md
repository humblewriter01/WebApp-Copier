# Telegram Signal Desk update plan

## Existing structure

- `client/src/App.jsx` holds the dashboard shell and top-level routes.
- `client/src/components/TelegramConnect.jsx` owns Telegram authentication, chat selection, and monitoring controls.
- `client/src/components/MetaApiPanel.jsx` owns the user-facing MT4/MT5 setup workflow.
- `server/index.js` owns authenticated API routes and database ownership checks.
- `server/services/metaapi.js` owns the allowlisted HTTPS calls to MetaAPI.
- `server/db.js` initializes the PostgreSQL schema used by the Render API and Supabase.
- `render.yaml` defines the API and static-site services.

## Implementation approach

Reuse the current product styling. Add live client-side search over Telegram chat names and handles, replace infrastructure-specific copy with plain language, and provide a standard not-financial-advice disclaimer. Audit user-visible error paths and use friendly generic text for unexpected system errors while preserving safe, actionable Telegram and MetaAPI errors.

Use a server-only `METAAPI_PROVISIONING_TOKEN` for the account setup flow. The authenticated backend creates a MetaAPI account without receiving the trading login or password, requests a MetaAPI-hosted configuration link, and associates only safe account metadata with the signed-in user. The user enters credentials on MetaAPI's HTTPS page. The app supports refreshing account status and regenerating the setup link, but does not submit, modify, or close trades, nor delete the underlying MetaAPI account when removing its local association. Enforce user ownership before every account-specific MetaAPI call. Keep this feature unavailable with a friendly message until the server secret is configured.

Add idempotent schema changes to the existing account table for app-provisioned-account provenance and broker-server metadata. Extend the MetaAPI client with a strict method/path and request-body allowlist plus safe error mapping. Do not send MetaAPI service credentials or broker passwords to the browser or logs.

Declare `autoDeployTrigger: commit` for both `main`-branch services in `render.yaml`. Preserve the existing Render resources, build commands, URLs, and environment settings otherwise.

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
