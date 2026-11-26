// Synthetic, deterministic estimates only; no production messages or credentials are read.
// Run: node server/scripts/measure-bandwidth.mjs
import { gzipSync } from 'node:zlib';
import { toSignalPreview } from '../services/signal-payload.js';

const vocabulary = 'market price entry stop target analysis momentum session support resistance breakout range candle volume dollar euro gold trend risk trade channel update liquidity buy sell watch confirmed pending position daily weekly news levels profit loss'.split(' ');
function messageFor(index, length) {
  let state = index + 1;
  let text = 'BUY EURUSD\nEntry 1.0850\nSL 1.0800\nTP 1.0950\n';
  while (text.length < length) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    text += `${vocabulary[state % vocabulary.length]} `;
  }
  return text.slice(0, length);
}
function capture(index, length) {
  return {
    id: `00000000-0000-0000-0000-${String(index).padStart(12, '0')}`,
    channelId: '-100123456789', channelTitle: 'FX Signals', telegramMessageId: String(1000 + index),
    source: 'telegram', message: messageFor(index, length), symbol: 'EURUSD', side: 'buy',
    entryPrice: '1.085', stopLoss: '1.08', takeProfit: '1.095', executionReady: true, parseError: null,
    executionNote: 'Auto-Trading is off.', status: 'unexecuted', createdAt: `2026-11-26T12:00:${String(index).padStart(2, '0')}.000Z`,
    directionInferred: false, takeProfitLevels: ['1.095', '1.10'], parsedBy: 'regex', parseConfidence: null,
    llmUsed: false, stopLossPips: null, takeProfitPips: null, needsReview: false,
    orderType: 'market', orderTypeStated: false, isScalping: false, entryRange: null,
    sentAt: '2026-11-26T12:00:00.000Z', editedAt: null,
  };
}
function oldList(row, dashboard = false) {
  const { channelId, telegramMessageId, sentAt, editedAt, ...list } = row;
  return dashboard ? { ...list, expiryTimestamp: null } : list;
}
function bytes(payload) {
  const json = JSON.stringify(payload);
  return { raw: Buffer.byteLength(json), gzip: gzipSync(json).length };
}
const shrink = (before, after) => `${((1 - after / before) * 100).toFixed(1)}%`;
console.log('| Message chars | Payload | JSON bytes before → after | JSON reduction | Gzip bytes before → after | Gzip reduction |');
console.log('| ---: | --- | ---: | ---: | ---: | ---: |');
for (const length of [120, 1000, 5000]) {
  const rows = Array.from({ length: 50 }, (_, index) => capture(index, length));
  const cases = [
    ['Signals (50 rows)', { signals: rows.map((row) => oldList(row)) }, { signals: rows.map(toSignalPreview) }],
    ['Dashboard signal strip (3 rows)', { signals: rows.slice(0, 3).map((row) => oldList(row, true)) }, { signals: rows.slice(0, 3).map(toSignalPreview) }],
    ['Socket event (1 row)', rows[0], toSignalPreview(rows[0])],
  ];
  for (const [label, before, after] of cases) {
    const a = bytes(before), b = bytes(after);
    console.log(`| ${length} | ${label} | ${a.raw} → ${b.raw} | ${shrink(a.raw, b.raw)} | ${a.gzip} → ${b.gzip} | ${shrink(a.gzip, b.gzip)} |`);
  }
}
console.log('\nNegative reduction = small metadata overhead for already-short messages.');
console.log('Gzip is already enabled for HTTP; compare gzip-before to gzip-after for incremental HTTP savings.');
console.log('Socket.IO WebSockets are not covered by Express compression; JSON bytes approximate the event body (framing excluded).');
