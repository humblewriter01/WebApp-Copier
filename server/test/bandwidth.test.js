import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { gunzipSync } from 'node:zlib';
import express from 'express';
import compression from 'compression';

import { SIGNAL_PUSH_KEYS, SIGNAL_PUSH_MESSAGE_PREVIEW_CHARS, toSignalPush } from '../services/signal-push.js';
import { DASHBOARD_MESSAGE_PREVIEW_CHARS, DASHBOARD_SIGNAL_COLUMNS } from '../services/dashboard-signals.js';

/*
 * Render's free tier stops the API at 5 GB of egress a month, so the size of what this server sends is an
 * availability concern, not a tidiness one. These pins hold the three reductions in place:
 *   1. every response body is eligible for gzip, because `compression()` runs before any route;
 *   2. the Overview is sent a 200-character preview of each message, not the whole post;
 *   3. a socket push carries one card's worth of fields, never the raw row.
 */

const index = readFileSync(new URL('../index.js', import.meta.url), 'utf8');

test('compression is mounted before the first route, so every JSON answer can be gzipped', () => {
  assert.match(index, /^import compression from 'compression';$/m, 'the middleware is imported');
  const mounted = index.indexOf('app.use(compression());');
  assert.notEqual(mounted, -1, 'and mounted');
  const firstRoute = index.search(/\napp\.(get|post|put|patch|delete)\('/);
  assert.ok(firstRoute > 0, 'routes exist');
  assert.ok(mounted < firstRoute, 'before any route is registered - Express only runs middleware mounted ahead of the handler');
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.ok(pkg.dependencies.compression, 'and it is a runtime dependency, so `npm ci` on Render installs it');
});

test('a JSON response through the same middleware actually leaves gzipped', async () => {
  const app = express();
  app.use(compression());
  const rows = Array.from({ length: 50 }, (_, i) => ({ id: i, symbol: 'XAUUSD', side: 'buy', status: 'received', message: 'BUY XAUUSD now\nEntry 3310\nSL 3295\nTP1 3320\nTP2 3335', createdAt: '2026-11-26T10:00:00.000Z' }));
  app.get('/rows', (_req, res) => res.set('Cache-Control', 'no-store').json({ signals: rows }));
  const server = app.listen(0);
  try {
    const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
    const { headers, body } = await new Promise((resolve, reject) => {
      http.get({ port, path: '/rows', headers: { 'Accept-Encoding': 'gzip' } }, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve({ headers: res.headers, body: Buffer.concat(chunks) }));
      }).on('error', reject);
    });
    assert.equal(headers['content-encoding'], 'gzip', 'application/json is compressible and above the 1 kB threshold');
    const raw = Buffer.byteLength(JSON.stringify({ signals: rows }));
    assert.ok(body.length < raw / 4, `the wire carries ${body.length} bytes for ${raw} bytes of JSON`);
    assert.deepEqual(JSON.parse(gunzipSync(body).toString('utf8')).signals.length, 50, 'and the body is intact');
  } finally {
    server.close();
  }
});

test('the Overview is sent a preview of each message, and told when it was cut', () => {
  assert.equal(DASHBOARD_MESSAGE_PREVIEW_CHARS, 200);
  assert.ok(DASHBOARD_SIGNAL_COLUMNS.includes('LEFT(message, 200) AS message'), 'the database cuts it, so the full text never leaves Postgres for this route');
  assert.ok(DASHBOARD_SIGNAL_COLUMNS.includes('(char_length(message) > 200) AS "messageTruncated"'), 'and the card can still say "…" for a preview that fits its own budget');
  assert.equal(DASHBOARD_SIGNAL_COLUMNS.includes('source,message,'), false, 'the bare column is not selected as well');
  assert.equal(DASHBOARD_SIGNAL_COLUMNS.includes('expiryTimestamp'), false, 'and a column no card reads is not selected at all');
});

test('the Signals page still reads the whole message, because that is the screen where it is read', () => {
  const start = index.indexOf("app.get('/api/signals'");
  const block = index.slice(start, index.indexOf('\n}));', start));
  assert.match(block, /"channelTitle",source,message,symbol/, 'the full column, not a preview');
  assert.equal(block.includes('LEFT(message'), false);
});

test('a socket push carries one card, not the row', () => {
  const longText = `BUY XAUUSD\nEntry 3310\nSL 3295\n${'Market commentary. '.repeat(250)}`;
  const raw = {
    id: 'sig-1', channelId: '-1001234567890', channelTitle: 'Gold Desk', telegramMessageId: '98765', source: 'telegram',
    message: longText, symbol: 'XAUUSD', side: 'buy', entryPrice: '3310', stopLoss: '3295', takeProfit: '3320',
    executionReady: true, parseError: null, executionNote: null, status: 'queued', createdAt: '2026-11-26T10:00:00.000Z',
    directionInferred: false, takeProfitLevels: ['3320', '3335'], parsedBy: 'regex', parseConfidence: null, llmUsed: false,
    stopLossPips: null, takeProfitPips: null, needsReview: false, orderType: 'limit', orderTypeStated: false, isScalping: false,
    entryRange: null, sentAt: '2026-11-26T09:59:58.000Z', editedAt: null,
  };
  const push = toSignalPush(raw);
  for (const key of Object.keys(push)) assert.ok(SIGNAL_PUSH_KEYS.includes(key), `${key} is on the push list`);
  for (const dropped of ['channelId', 'telegramMessageId', 'sentAt', 'editedAt']) assert.equal(dropped in push, false, `${dropped} is not sent - no card reads it`);
  assert.equal(push.symbol, 'XAUUSD');
  assert.equal(push.side, 'buy');
  assert.equal(push.status, 'queued');
  assert.equal(push.createdAt, raw.createdAt);
  assert.deepEqual(push.takeProfitLevels, ['3320', '3335']);
  assert.equal(push.message.length, SIGNAL_PUSH_MESSAGE_PREVIEW_CHARS, 'the message is a preview');
  assert.ok(raw.message.startsWith(push.message), 'and it is the head of the post, unaltered');
  assert.equal(push.messageTruncated, true);
  const bytesBefore = Buffer.byteLength(JSON.stringify(raw));
  const bytesAfter = Buffer.byteLength(JSON.stringify(push));
  assert.ok(bytesAfter < bytesBefore / 4, `a long post shrinks from ${bytesBefore} to ${bytesAfter} bytes on the socket`);

  const short = toSignalPush({ ...raw, message: 'SELL EURUSD' });
  assert.equal(short.message, 'SELL EURUSD');
  assert.equal(short.messageTruncated, false, 'a short message is sent whole and not flagged');
});

test('the stored-row fallback of the edit path cannot leak internal columns through the socket', () => {
  // `SELECT *` returns snake_case, including `user_id` and the admin-only `technical_note`.
  const stored = {
    id: 'sig-2', user_id: 'user-1', channel_id: '-100', channel_title: 'FX Desk', telegram_message_id: '5', source: 'telegram',
    message: 'BUY EURUSD 1.0850', symbol: 'EURUSD', side: 'buy', status: 'received', created_at: '2026-11-26T10:00:00.000Z',
    entry_price: '1.0850', stop_loss: null, take_profit: null, execution_note: null, technical_note: 'MetaApiError: 500 at /users/current',
    expiry_timestamp: null, edited_at: null, sent_at: null,
  };
  const push = toSignalPush(stored);
  assert.equal(push.channelTitle, 'FX Desk', 'the snake_case spelling is read under the name the card uses');
  assert.equal(push.entryPrice, '1.0850');
  assert.equal(push.createdAt, stored.created_at);
  for (const key of ['user_id', 'technical_note', 'technicalNote', 'channel_id', 'telegram_message_id', 'expiry_timestamp']) {
    assert.equal(key in push, false, `${key} never reaches a browser`);
  }
  assert.equal(JSON.stringify(push).includes('MetaApiError'), false);
});

test('a preview never splits an emoji in half', () => {
  const text = `${'a'.repeat(SIGNAL_PUSH_MESSAGE_PREVIEW_CHARS - 1)}🚀🚀`;
  const push = toSignalPush({ id: 1, message: text });
  assert.equal(push.message, `${'a'.repeat(SIGNAL_PUSH_MESSAGE_PREVIEW_CHARS - 1)}🚀`);
  assert.equal(push.messageTruncated, true);
  assert.equal(toSignalPush(null), null);
});

test('a pushed row carries every field the polled Signals row does, so the card renders the same', () => {
  const start = index.indexOf("app.get('/api/signals'");
  const select = index.slice(index.indexOf('SELECT ', start), index.indexOf(' FROM signals', start));
  const keys = select.replace(/^SELECT /, '').split(',').map((part) => {
    const alias = /AS "([^"]+)"/.exec(part);
    return alias ? alias[1] : part.trim();
  });
  for (const key of keys) assert.ok(SIGNAL_PUSH_KEYS.includes(key), `${key} is pushed`);
});
