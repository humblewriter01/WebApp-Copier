import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/*
 * The other half of "the front end should get a new signal immediately, and never show an old one". The client
 * side of it is `client/src/lib/signal-feed.js` (subscribe to a push, keep a slow poll as the fallback, read
 * live values instead of cached ones); this file holds the server to its share.
 *
 * Two hazards a screenshot of stale rows actually comes from:
 *   1. a data route the browser or a proxy is allowed to cache - every read the workspace polls on a timer and
 *      the route a push is reconciled against must answer `Cache-Control: no-store`, as the settings and trades
 *      reads already did before this file existed;
 *   2. a row pushed to the socket before the database has finished with it, so the client renders a signal
 *      whose status, note and queue state are still whatever the INSERT left behind, and then never re-reads
 *      because it believes it was told the final answer.
 */

const here = fileURLToPath(new URL('.', import.meta.url));
const index = readFileSync(new URL('../index.js', import.meta.url), 'utf8');

/** The routes `refresh()` in the client reads on a timer, on a push, and on the tab becoming visible. */
const WORKSPACE_READS = [
  '/api/dashboard', '/api/channels', '/api/signals', '/api/accounts', '/api/metaapi/linked-accounts', '/api/trades',
];

function handler(route) {
  const start = index.indexOf(`app.get('${route}'`);
  assert.notEqual(start, -1, `${route} is served`);
  const next = index.indexOf("\napp.get('", start + 1);
  const nextAny = index.indexOf("\napp.post('", start + 1);
  const end = Math.min(...[next, nextAny, index.length].filter((n) => n > start));
  return index.slice(start, end);
}

test('every read the workspace refreshes from is answered without caching', () => {
  for (const route of WORKSPACE_READS) {
    const block = handler(route);
    const lines = block.split('\n').filter((line) => line.includes('.json('));
    assert.ok(lines.length > 0, `${route} answers`);
    for (const line of lines) {
      assert.match(line, /res\.set\('Cache-Control', 'no-store'\)\.json\(|res\.status\(\d+\)\.json\(\{ error:/, `${route}: ${line.trim()} is a response, and it is marked fresh or is an error`);
    }
  }
});

test('the signal list and the dashboard strips are read newest-first', () => {
  const signals = handler('/api/signals');
  assert.match(signals, /FROM signals WHERE user_id=\$1 ORDER BY created_at DESC LIMIT \$2/, 'the Signals tab, in SQL, not in the browser');
  const dashboard = readFileSync(new URL('../services/dashboard-signals.js', import.meta.url), 'utf8');
  for (const build of ['buildDashboardRecentSignalsQuery', 'buildDashboardActionableSignalsQuery']) {
    const start = dashboard.indexOf(`export function ${build}`);
    assert.notEqual(start, -1, `${build} exists`);
    const block = dashboard.slice(start, dashboard.indexOf('\n}', start));
    assert.match(block, /ORDER BY created_at DESC LIMIT \$\{DASHBOARD_SIGNAL_LIMIT\}/, `${build} is short and newest-first, which is what the Overview's three rows rely on`);
  }
});

test('a row is pushed to the socket only once the database has finished deciding it', () => {
  const at = index.indexOf('async function saveSignal(');
  assert.notEqual(at, -1, 'the capture writes through one function');
  const body = index.slice(at, index.indexOf('\nfunction ', index.indexOf('INSERT INTO execution_jobs', at)));
  const insert = body.indexOf('INSERT INTO signals');
  const update = body.indexOf('UPDATE signals SET status=$2');
  const emit = body.indexOf("emit('signal:received'");
  const queue = body.indexOf("INSERT INTO execution_jobs");
  assert.notEqual(insert, -1, 'the row is stored');
  assert.notEqual(update, -1, 'then the outcome is written onto it');
  assert.notEqual(emit, -1, 'then the row is announced on the socket');
  assert.ok(insert < update && update < emit, 'in that order: a client must never render a row whose status is still the INSERT default');
  assert.ok(queue < emit, 'and the queued job it schedules is already in `execution_jobs`, so the refresh a push triggers finds it');
  // The one thing the ordering cannot do on its own: the pushed object must be the row that was written, not
  // the parsed result from before the UPDATE.
  assert.match(body, /if \(recorded\[0\]\) Object\.assign\(signal, recorded\[0\]\);[\s\S]{0,80}emit\('signal:received', signal\)/, 'the pushed payload carries the recorded status and note');
});

test('a push can only reach the workspace that owns the row', () => {
  // Room scope is the audit requirement that decides whether this feature is safe at all: one socket server,
  // many workspaces, and a row that must never be announced to the wrong one.
  const use = index.indexOf('io.use((socket, next) => {');
  const connection = index.indexOf("io.on('connection'", use);
  const guard = index.slice(use, connection);
  assert.match(guard, /jwt\.verify\(socket\.handshake\.auth\?\.token, process\.env\.JWT_SECRET\)/, 'the handshake token is verified with the same secret the REST routes use');
  assert.match(guard, /socket\.userId = payload\.sub;/, 'and the identity the room is built from is the token\'s, not anything the client claims');
  assert.match(index.slice(connection, connection + 260), /socket\.join\(`user:\$\{socket\.userId\}`\)/, 'so a connection joins exactly one workspace room');
  assert.match(index, /io\.to\(`user:\$\{userId\}`\)\.emit\('signal:received', signal\);[\s\S]{0,60}return signal;\s*\}/, 'and the only emit targets that room, using the row owner\'s id');
  const emits = index.match(/emit\('signal:received'/g) || [];
  assert.equal(emits.length, 1, 'one place announces a captured row, so no capture path can forget it');
});

test('a closed support session stops streaming, not just stops reading', () => {
  // The REST half of this rule already existed; the live feed is a second door into the same rows, and a door
  // that authenticates once at the handshake would keep a closed session fed. Both halves are pinned together
  // so the pair cannot drift apart again.
  const use = index.indexOf('io.use((socket, next) => {');
  const guard = index.slice(use, index.indexOf("io.on('connection'", use));
  assert.match(guard, /payload\.purpose \|\| ''\) !== 'impersonation'\) return next\(\);/, 'a normal user socket is not asked for a support session');
  assert.match(guard, /supportSessions\.redeem\(payload\.jti\)/, 'an impersonation socket is checked against the session table');
  assert.match(guard, /socket\.data\.supportSessionId = session\.id;/, 'and remembers which session it belongs to');
  const helper = index.slice(index.indexOf('function disconnectSupportSockets('), index.indexOf('\n}', index.indexOf('function disconnectSupportSockets(')));
  assert.match(helper, /socket\.disconnect\(true\)/, 'dropping the sockets of that session id alone');
  assert.ok(index.includes('disconnectSupportSockets(sessionId);'), 'the admin route that ends a session drops its sockets');
  assert.ok(index.includes('disconnectSupportSockets(req.supportSessionId);'), 'and so does the exit a support session can perform on itself');
});
