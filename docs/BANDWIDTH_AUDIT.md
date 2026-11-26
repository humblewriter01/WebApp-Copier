# Backend bandwidth audit

## Findings and changes

- **HTTP compression was already correct.** `compression` is in both the server manifest and lockfile, imported in `server/index.js`, and registered with `app.use(compression())` before routes. Its default filter compresses JSON when the client negotiates an encoding and the response meets the default ~1 KB threshold. Kept it unchanged; no dependency reinstall/update was necessary. Added an HTTP regression test using the actual middleware registration and signals handler: gzip content negotiation, `Vary: Accept-Encoding`, JSON round-trip, identity fallback, and `Cache-Control: no-store`.
- **`GET /api/signals` and both dashboard query branches transferred full messages.** They already selected explicit columns (not `SELECT *`); the largest avoidable field was `message`, stored up to 5,000 characters. Both now select `LEFT(message, 200) AS message` in SQL, plus a `messageTruncated` flag. This bounds the database-to-app transfer too. Kept fields used for prices, outcomes, badges and the live blocker overlay. Removed the dashboard's unused `expiryTimestamp` column. Added `editedAt` so an edited message invalidates locally expanded text, even when the first 200 characters have not changed. Existing list limits, ordering, workspace filters and private-response `no-store` remain unchanged.
- **The Signals page actually displayed full messages.** Rather than remove access, it now displays a preview with a “Show full message” action. `GET /api/signals/:id/message` returns only `id`, `message`, and `editedAt`, requires the existing authentication middleware, validates the UUID, filters by both workspace and signal ID, and sets `no-store`. Another workspace's ID returns 404. Full text is fetched only on a click, reused while that message component remains mounted, and not fetched on every poll. Failures remain retryable; short messages need no request. Full originals remain stored and available to parsing, execution, edit handling and admin diagnostics.
- **Socket.IO sent the entire selected capture object, including full text.** This was not literally `SELECT *` or the whole Telegram object, but it included transport IDs and the original message. Both emit paths (ordinary captures and text-only Telegram edits) now call `toSignalPreview`, which copies an explicit allowlist, limits the message to 200 Unicode characters, and omits `channelId`, `telegramMessageId`, `sentAt` and any unrecognized/raw/private fields. Parsed prices, status/outcome, source, timestamps and badges remain available for the client's immediate row merge. The manual-create POST response uses the same safe shape. Internal rows are never mutated. Express compression does **not** compress Socket.IO WebSocket frames, so smaller event bodies help independently of gzip.
- **Static asset caching is not a backend concern here.** `render.yaml` deploys `telegram-copier-web` as a separate Render Static Site, and Express does not serve frontend assets. No cache changes made, per the task. Authenticated trading data is intentionally not given public caching headers.

## Reproducible size estimates

Run from the repository root:

```sh
node server/scripts/measure-bandwidth.mjs
```

The script uses deterministic, synthetic ASCII trading/news text, representative public field values, and the before/after projections. It reads no production data or credentials. Numbers below are **JSON response bodies / event objects only**: the dashboard measurement is its three-row signal strip, not its unchanged stats/settings/trading envelope. HTTP headers, WebSocket/Socket.IO framing, TLS, pings, other endpoints and optional full-message requests are excluded. Gzip values are zlib estimates, not a measurement at Render's edge.

| Message chars | Payload | JSON bytes before → after | JSON reduction | Gzip bytes before → after | Gzip reduction |
| ---: | --- | ---: | ---: | ---: | ---: |
| 120 | Signals (50 rows) | 36,313 → 38,363 | -5.6% | 2,140 → 2,239 | -4.6% |
| 120 | Dashboard signal strip (3 rows) | 2,260 → 2,314 | -2.4% | 547 → 554 | -1.3% |
| 120 | Socket event (1 row) | 832 → 766 | 7.9% | 464 → 442 | 4.7% |
| 1,000 | Signals (50 rows) | 80,313 → 42,313 | 47.3% | 10,333 → 3,148 | 69.5% |
| 1,000 | Dashboard signal strip (3 rows) | 4,900 → 2,551 | 47.9% | 1,263 → 636 | 49.6% |
| 1,000 | Socket event (1 row) | 1,712 → 845 | 50.6% | 755 → 484 | 35.9% |
| 5,000 | Signals (50 rows) | 280,313 → 42,313 | 84.9% | 42,908 → 3,148 | 92.7% |
| 5,000 | Dashboard signal strip (3 rows) | 16,900 → 2,551 | 84.9% | 3,661 → 636 | 82.6% |
| 5,000 | Socket event (1 row) | 5,712 → 845 | 85.2% | 1,677 → 484 | 71.1% |

The **message field alone** is 80% shorter at 1,000 characters and 96% shorter at 5,000 characters. Entire payload savings are smaller because useful metadata is retained. Already-short messages gain small list metadata overhead (`messageTruncated`, `editedAt`); negative reductions above disclose this rather than assuming all traffic improves. Socket rows still shrink because unused fields are removed. Compare **gzip-before to gzip-after** for incremental HTTP savings: gzip was already enabled, so its pre-existing savings are not credited to this PR. Socket.IO WebSocket compression is not enabled by this change; use the JSON column for event-body estimates.

Actual monthly egress savings depend on real message lengths/compressibility, active users, polling, channel activity and how often readers expand messages. These synthetic results cannot guarantee staying below 5 GB or restore a suspended Render service. No production traffic/database measurements or infrastructure changes were performed.

## Validation and rollout

- `npm test --prefix server`: both TypeScript checks + **1,015 passing tests**.
- `npm test --prefix client`: **325 passing tests**.
- `npm run build --prefix client`: passes. Build warns about missing local Supabase build variables (existing runtime-config fallback) and a >500 KB chunk; neither blocks the build.
- New tests cover SQL projection bounds, safe/Unicode preview serialization, both socket call sites, authenticated/tenant-scoped full text, gzip/identity HTTP negotiation and UI expansion/retry/cache invalidation.
- The sandbox Node is 22.22.3, below the repository's existing >=22.23.4 pin; npm warned, but all checks above passed. No engine/dependency changes made.
- No schema migration. Deploy the API and updated static client together (API first if ordered); old cached clients will receive previews but need the updated client for the expansion action. No deployment or merge is performed by this audit.
- After deployment, compare Render outbound transfer per active user and representative compressed response sizes over a comparable traffic window. If costs remain high, measure polling and other endpoints before changing freshness or execution behavior. Existing polling cadence is deliberately unchanged here.
