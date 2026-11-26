/**
 * What a `signal:received` socket event carries.
 *
 * The event used to push whatever object the write path happened to be holding: the capture's full RETURNING
 * row (the whole Telegram message, up to 5000 characters, plus the channel id, the Telegram message id and the
 * channel clock - none of which the card renders), and on one branch of the edit path the `SELECT *` row, which
 * also carried `user_id`, `expiry_timestamp` and the internal `technical_note`. Every byte of that went out
 * through Render's egress for every captured message, to every socket in the workspace room.
 *
 * The push is an accelerator, not the record: the client merges it and then schedules one reconciling refresh
 * (`createReconciler` in `client/src/lib/signal-feed.js`) that re-reads `/api/signals` and `/api/dashboard` a
 * moment later. So the event needs exactly what one signal card renders for that moment, and nothing else:
 *
 *   - the fields `SignalTable`, `signalOutcomeView` and `signalBadges` read, under the names they read them;
 *   - the message as a preview, with `messageTruncated` saying whether it was cut, so the card can show an
 *     ellipsis instead of presenting a fragment as the whole post. The full text arrives with the refresh.
 *
 * Both spellings of each column are accepted (the camelCase alias a projection returns and the raw snake_case a
 * `SELECT *` returns), because the edit path can fall back to the stored row - and that fallback is precisely
 * where the internal columns used to escape. A key that is not on this list cannot reach a browser.
 */

/** How much of a message the live push carries. The Overview card shows at most 150 characters of it. */
export const SIGNAL_PUSH_MESSAGE_PREVIEW_CHARS = 200;

/** [key the client reads, raw column name] for every field a signal card renders. */
const SIGNAL_PUSH_FIELDS = Object.freeze([
  ['id', 'id'],
  ['channelTitle', 'channel_title'],
  ['source', 'source'],
  ['symbol', 'symbol'],
  ['side', 'side'],
  ['status', 'status'],
  ['createdAt', 'created_at'],
  ['entryPrice', 'entry_price'],
  ['stopLoss', 'stop_loss'],
  ['takeProfit', 'take_profit'],
  ['takeProfitLevels', 'take_profit_levels'],
  ['stopLossPips', 'stop_loss_pips'],
  ['takeProfitPips', 'take_profit_pips'],
  ['entryRange', 'entry_range'],
  ['executionReady', 'execution_ready'],
  ['executionNote', 'execution_note'],
  ['parseError', 'parse_error'],
  ['directionInferred', 'direction_inferred'],
  ['needsReview', 'needs_review'],
  ['parsedBy', 'parsed_by'],
  ['parseConfidence', 'parse_confidence'],
  ['llmUsed', 'llm_used'],
  ['orderType', 'order_type'],
  ['orderTypeStated', 'order_type_stated'],
  ['isScalping', 'is_scalping'],
]);

/** The keys a push can ever contain, for tests and for anyone asking "is X sent to the browser?". */
export const SIGNAL_PUSH_KEYS = Object.freeze([...SIGNAL_PUSH_FIELDS.map(([key]) => key), 'message', 'messageTruncated']);

/**
 * The socket payload for one signal row.
 *
 * @param {Record<string, any> | null | undefined} row
 * @param {{ previewChars?: number }} [options]
 * @returns {Record<string, any> | null}
 */
export function toSignalPush(row, { previewChars = SIGNAL_PUSH_MESSAGE_PREVIEW_CHARS } = {}) {
  if (!row || typeof row !== 'object') return null;
  /** @type {Record<string, any>} */
  const payload = {};
  for (const [key, column] of SIGNAL_PUSH_FIELDS) {
    const value = row[key] !== undefined ? row[key] : row[column];
    if (value !== undefined) payload[key] = value;
  }
  const text = row.message == null ? '' : String(row.message);
  // Code points, not UTF-16 units, so an emoji at the boundary is never split into half a surrogate pair.
  const characters = Array.from(text);
  const clipped = characters.length > previewChars;
  payload.message = clipped ? characters.slice(0, previewChars).join('') : text;
  payload.messageTruncated = clipped;
  return payload;
}
