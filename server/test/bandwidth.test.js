import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import { gunzipSync } from 'node:zlib';
import express from 'express';
import compression from 'compression';
import { SIGNAL_MESSAGE_PREVIEW_SQL, SIGNAL_PUBLIC_FIELDS, toSignalPreview, readSignalMessage } from '../services/signal-payload.js';
import { buildDashboardActionableSignalsQuery, buildDashboardRecentSignalsQuery } from '../services/dashboard-signals.js';

const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
const uuid = '00000000-0000-0000-0000-000000000001';

test('public signal events whitelist UI fields, bound Unicode text and never mutate capture rows', () => {
  const row = Object.fromEntries(SIGNAL_PUBLIC_FIELDS.map((field) => [field, `${field}-value`]));
  Object.assign(row, { message: '📈'.repeat(201), user_id: 'private', telegramMessageId: '123', channelId: '456', technicalNote: 'private', rawTelegramPayload: { huge: 'x'.repeat(5000) } });
  const preview = toSignalPreview(row);
  assert.deepEqual(Object.keys(preview), [...SIGNAL_PUBLIC_FIELDS, 'message', 'messageTruncated']);
  assert.equal(preview.message, '📈'.repeat(200));
  assert.equal(preview.messageTruncated, true);
  for (const field of SIGNAL_PUBLIC_FIELDS) assert.equal(preview[field], row[field]);
  assert.equal(row.message, '📈'.repeat(201), 'parsing, execution and persistence still have the original');
  for (const message of ['', 'x'.repeat(199), 'x'.repeat(200), null]) {
    assert.equal(toSignalPreview({ message }).message, message);
    assert.equal(toSignalPreview({ message }).messageTruncated, false);
  }
  assert.equal(toSignalPreview({ message: 'preview', messageTruncated: true }).messageTruncated, true);
  const broadcasts = source.match(/emit\('signal:received', [^;]+/g);
  assert.equal(broadcasts.length, 2, 'new captures and text-only edits are both covered');
  for (const broadcast of broadcasts) assert.match(broadcast, /toSignalPreview\((row|signal)\)/);
  assert.match(source, /res.status\(201\).json\(\{ signal: toSignalPreview\(signal\) \}\)/);
});

test('both dashboard query branches truncate in SQL; no full message or wildcard leaks', () => {
  for (const { sql } of [buildDashboardActionableSignalsQuery(), buildDashboardRecentSignalsQuery()]) {
    assert.ok(sql.includes(SIGNAL_MESSAGE_PREVIEW_SQL));
    assert.match(sql, /LEFT\(message, 200\) AS message/);
    assert.match(sql, /CHAR_LENGTH\(message\) > 200 AS "messageTruncated"/);
    assert.doesNotMatch(sql, /SELECT \*|source,message,/);
    assert.match(sql, /WHERE user_id=\$1/);
  }
});

async function startApi(t, pool) {
  const app = express();
  // Execute the production middleware registration and production handlers without booting external services.
  const middleware = source.match(/^app.use\(compression\(\)\);$/m)?.[0];
  assert.ok(middleware);
  assert.ok(source.indexOf(middleware) < source.indexOf("app.get('/api/dashboard'"));
  new Function('app', 'compression', middleware)(app, compression);
  const routes = source.slice(source.indexOf("app.get('/api/signals',"), source.indexOf("app.post('/api/signals',"));
  const authenticate = (req, res, next) => {
    if (!req.headers.authorization) return res.status(401).json({ error: 'Sign in' });
    req.userId = req.headers.authorization;
    next();
  };
  const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
  new Function('app', 'authenticate', 'asyncRoute', 'pool', 'withLiveBlockers', 'SIGNAL_MESSAGE_PREVIEW_SQL', 'readSignalMessage', 'UUID_PATTERN', 'fail', routes)(
    app, authenticate, asyncRoute, pool, async (_id, rows) => rows, SIGNAL_MESSAGE_PREVIEW_SQL, readSignalMessage,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    (res, status, error) => res.status(status).json({ error }),
  );
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  return (path, headers = {}) => new Promise((resolve, reject) => {
    request({ hostname: '127.0.0.1', port: server.address().port, path, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject).end();
  });
}

test('actual signals handler negotiates gzip JSON, retains no-store and caps/scopes the SQL list', async (t) => {
  const signals = Array.from({ length: 50 }, (_, i) => ({ id: String(i), message: 'Preview '.repeat(25), symbol: 'EURUSD', status: 'unexecuted', messageTruncated: true }));
  const send = await startApi(t, { async query(sql, params) {
    assert.ok(sql.includes(SIGNAL_MESSAGE_PREVIEW_SQL));
    assert.match(sql, /WHERE user_id=\$1 ORDER BY created_at DESC LIMIT \$2/);
    assert.deepEqual(params, ['owner', 100]);
    return { rows: signals };
  } });
  const zipped = await send('/api/signals?limit=999', { Authorization: 'owner', 'Accept-Encoding': 'gzip' });
  assert.equal(zipped.status, 200);
  assert.equal(zipped.headers['content-encoding'], 'gzip');
  assert.match(zipped.headers['content-type'], /application\/json/);
  assert.match(zipped.headers.vary, /Accept-Encoding/);
  assert.equal(zipped.headers['cache-control'], 'no-store');
  assert.deepEqual(JSON.parse(gunzipSync(zipped.body)), { signals });
  const identity = await send('/api/signals?limit=999', { Authorization: 'owner', 'Accept-Encoding': 'identity' });
  assert.equal(identity.headers['content-encoding'], undefined);
  assert.deepEqual(JSON.parse(identity.body), { signals });
  assert.ok(zipped.body.length < identity.body.length / 2);
});

test('on-demand message route requires authentication, validates IDs and cannot cross workspaces', async (t) => {
  let reads = 0;
  const full = 'Unabridged Telegram message '.repeat(100);
  const send = await startApi(t, { async query(sql, params) {
    reads++;
    assert.equal(sql, 'SELECT id,message,edited_at AS "editedAt" FROM signals WHERE user_id=$1 AND id=$2 LIMIT 1');
    assert.equal(params[1], uuid);
    return { rows: params[0] === 'owner' ? [{ id: uuid, message: full, editedAt: null }] : [] };
  } });
  assert.equal((await send(`/api/signals/${uuid}/message`)).status, 401);
  assert.equal((await send('/api/signals/bad-id/message', { Authorization: 'owner' })).status, 400);
  assert.equal(reads, 0);
  const missing = await send(`/api/signals/${uuid}/message`, { Authorization: 'other-workspace' });
  assert.equal(missing.status, 404);
  assert.equal(missing.headers['cache-control'], 'no-store');
  const detail = await send(`/api/signals/${uuid}/message`, { Authorization: 'owner' });
  assert.equal(detail.status, 200);
  assert.equal(detail.headers['cache-control'], 'no-store');
  assert.equal(JSON.parse(detail.body).signal.message, full);
});

test('frontend is a separate Render static service, not backend-served assets', () => {
  const blueprint = readFileSync(new URL('../../render.yaml', import.meta.url), 'utf8');
  assert.match(blueprint, /name: telegram-copier-web\s+runtime: static/);
  assert.doesNotMatch(source, /express\.static\(/);
});
