/**
 * The live card is a preview until the debounced history refresh supplies the full row.
 * Explicitly allowlist card fields: capture rows also contain Telegram identifiers and other
 * internal data, and must not silently grow the socket payload as capture evolves.
 */
const CARD_FIELDS = [
  'id', 'channelTitle', 'source', 'symbol', 'side', 'entryPrice', 'stopLoss', 'takeProfit',
  'directionInferred', 'executionReady', 'parseError', 'executionNote', 'takeProfitLevels',
  'parsedBy', 'parseConfidence', 'llmUsed', 'stopLossPips', 'takeProfitPips', 'needsReview',
  'orderType', 'orderTypeStated', 'isScalping', 'entryRange', 'status', 'createdAt',
];

/** @param {Record<string, any>} row */
export function signalFeedPayload(row) {
  const payload = {};
  for (const key of CARD_FIELDS) {
    if (Object.hasOwn(row, key)) payload[key] = row[key];
  }
  if (typeof row.message === 'string') {
    // PostgreSQL LEFT counts Unicode code points, not UTF-16 code units.
    const characters = Array.from(row.message);
    payload.message = characters.slice(0, 200).join('');
    payload.messageTruncated = characters.length > 200;
  } else {
    payload.message = row.message ?? null;
    payload.messageTruncated = false;
  }
  return payload;
}
