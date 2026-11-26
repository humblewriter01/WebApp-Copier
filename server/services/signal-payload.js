/** Public list/event shape. Never spread a capture/database row onto the wire. */
export const SIGNAL_PREVIEW_LENGTH = 200;
export const SIGNAL_PUBLIC_FIELDS = Object.freeze([
  'id', 'channelTitle', 'source', 'symbol', 'side', 'entryPrice', 'stopLoss', 'takeProfit',
  'directionInferred', 'executionReady', 'parseError', 'executionNote', 'takeProfitLevels',
  'parsedBy', 'parseConfidence', 'llmUsed', 'stopLossPips', 'takeProfitPips', 'needsReview',
  'orderType', 'orderTypeStated', 'isScalping', 'entryRange', 'status', 'createdAt', 'editedAt',
]);

/** SQL truncates before database transfer; the flag distinguishes exactly 200 characters from a cut. */
export const SIGNAL_MESSAGE_PREVIEW_SQL = `LEFT(message, ${SIGNAL_PREVIEW_LENGTH}) AS message,CHAR_LENGTH(message) > ${SIGNAL_PREVIEW_LENGTH} AS "messageTruncated"`;

/** Capture and execution keep the original text. Only their public copy is shortened. */
export function toSignalPreview(/** @type {Record<string, any>} */ signal) {
  /** @type {Record<string, any>} */
  const payload = {};
  for (const field of SIGNAL_PUBLIC_FIELDS) {
    if (Object.hasOwn(signal, field)) payload[field] = signal[field];
  }
  // PostgreSQL LEFT counts Unicode code points, not JavaScript UTF-16 code units.
  const characters = Array.from(String(signal.message ?? ''));
  payload.message = signal.message == null ? null : characters.slice(0, SIGNAL_PREVIEW_LENGTH).join('');
  payload.messageTruncated = signal.messageTruncated === true || characters.length > SIGNAL_PREVIEW_LENGTH;
  return payload;
}

/** Full text is opt-in, authenticated by the route, and always scoped to its workspace. */
export async function readSignalMessage(/** @type {PoolLike} */ pool, userId, signalId) {
  const { rows } = await pool.query(
    'SELECT id,message,edited_at AS "editedAt" FROM signals WHERE user_id=$1 AND id=$2 LIMIT 1',
    [userId, signalId],
  );
  return rows[0] || null;
}
