import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { gunzipSync } from 'node:zlib';
import express from 'express';
import compression from 'compression';
import { signalFeedPayload } from '../services/signal-feed-payload.js';
import { buildDashboardActionableSignalsQuery, buildDashboardRecentSignalsQuery } from '../services/dashboard-signals.js';

const index = readFileSync(new URL('../index.js', import.meta.url), 'utf8');

test('compression is installed before routes and negotiates gzip JSON without changing its content', async () => {
  assert.match(index, /import compression from 'compression'/);
  assert.ok(index.indexOf('app.use(compression())') < index.indexOf("app.post('/api/webhooks/resend'"));
  const app = express();
  app.use(compression());
  const json = { signals: Array.from({ length: 20 }, (_, i) => ({ id: i, message: 'BUY EURUSD '.repeat(50) })) };
  app.get('/api/test', (_req, res) => res.json(json));
  const server = createServer(app).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const response = await new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: server.address().port, path: '/api/test', headers: { 'Accept-Encoding': 'gzip' } }, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve({ headers: res.headers, body: Buffer.concat(chunks) }));
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(response.headers['content-encoding'], 'gzip');
    assert.deepEqual(JSON.parse(gunzipSync(response.body).toString()), json);
    assert.ok(response.body.length < Buffer.byteLength(JSON.stringify(json)));
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test('dashboard queries send a bounded preview and indicate when it was shortened', () => {
  for (const query of [buildDashboardActionableSignalsQuery(), buildDashboardRecentSignalsQuery()]) {
    assert.match(query.sql, /LEFT\(message, 200\) AS message/);
    assert.match(query.sql, /length\(message\) > 200\) AS "messageTruncated"/);
  }
  // History intentionally remains full: SignalTable displays the complete message there.
  const history = index.slice(index.indexOf("app.get('/api/signals'"), index.indexOf("app.post('/api/signals'"));
  assert.match(history, /source,message,symbol/);
});

test('socket cards omit internal fields and cap the preview without breaking Unicode', () => {
  const row = { id: 12, symbol: 'EURUSD', side: 'buy', status: 'queued', createdAt: '2026-01-01', message: '😀'.repeat(201), telegramMessageId: 'secret', channelId: 'internal', rawPayload: 'secret' };
  const preview = signalFeedPayload(row);
  assert.deepEqual(preview, { id: 12, symbol: 'EURUSD', side: 'buy', status: 'queued', createdAt: '2026-01-01', message: '😀'.repeat(200), messageTruncated: true });
  assert.equal(row.message.length, 402, 'the captured row is not changed');
  assert.equal(signalFeedPayload({ message: 'hello' }).messageTruncated, false);
  assert.equal(signalFeedPayload({ message: null }).message, null);
  assert.match(index, /emit\('signal:received', signalFeedPayload\(signal\)\)/);
  assert.match(index, /emit\('signal:received', signalFeedPayload\(row\)\)/);
});
