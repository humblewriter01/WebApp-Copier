import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { AUTO_TRADING_OFF_NOTE, PLAN_NO_EXECUTION_NOTE, overlayLiveBlocker } from '../services/signal-outcome.js';
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
  assert.ok(update < queue, 'and the annotation is on the row before the job exists at all, because the engine mirrors an order outcome onto these same columns and must never arrive first, only to have `queued` written back over `executed`');
  // The one thing the ordering cannot do on its own: the pushed object must be the row that was written, not
  // the parsed result from before the UPDATE - and nothing may touch it again on the way out.
  const afterTheMerge = body.slice(body.indexOf('Object.assign(signal, recorded[0])'), emit);
  assert.match(afterTheMerge.slice(0, 60), /Object\.assign\(signal, recorded\[0\]\);\s*\n\s*\}/, 'the recorded row is merged in the block that read it');
  assert.equal(/signal\.\w+\s*=|(?:^|[^.\w])signal\s*=/.test(afterTheMerge), false, 'and nothing between the merge and the emit edits the pushed object, so what a client renders is what the database holds');
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

test('the read that refreshes the workspace also answers what the plan allows', () => {
  // The banner and the note under a signal are two renderings of one question - can this trade right now - and
  // the answer needs the plan. Without this the client would have to guess from the account list, which is how
  // a free workspace and a workspace with no account end up described by the same sentence.
  assert.match(index, /pool\.query\('SELECT subscription_status AS status,subscription_plan AS plan FROM users WHERE id=\$1', \[req\.userId\]\)/);
  assert.match(index, /subscription: \{ status: subscription\.rows\[0\]\?\.status \|\| null, plan: subscription\.rows\[0\]\?\.plan \|\| null \}/);
});

/* The contract between the overlay and the queries it is applied to. It exists because the re-decision was once
   silently disarmed by a guard reading `signal.telegramMessageId`, a column no list query selects: the check
   passed in every test that hand-built a row and failed on every row that came from Postgres. */

/** The keys a projection actually returns - aliases where there is one, column name where there is not. */
function projectedKeys(source, from, to) {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start);
  assert.notEqual(start, -1, `${from.slice(0, 32)} is found`);
  assert.ok(end > start, `and ${to.slice(0, 32)} closes it`);
  const list = source.slice(start, end);
  const keys = new Set();
  for (const part of list.split(/\n\s*/).join(',').split(',')) {
    const token = part.trim();
    if (!token || /\$\d|\bFROM\b/i.test(token)) continue;
    const aliased = /^(.+?)\s+AS\s+"([^"]+)"$/i.exec(token);
    if (aliased) keys.add(aliased[2]);
    else if (/^[a-z_]+$/i.test(token)) keys.add(token);
  }
  return keys;
}

test('every column the live-blocker overlay reads is a column the list queries return', () => {
  const overlay = readFileSync(new URL('../services/signal-outcome.js', import.meta.url), 'utf8');
  const body = overlay.slice(overlay.indexOf('export function overlayLiveBlocker'), overlay.indexOf('/**', overlay.indexOf('export function overlayLiveBlocker') + 10));
  const reads = [...new Set([...body.matchAll(/signal\.([A-Za-z_][A-Za-z0-9_]*)/g)].map((match) => match[1]))];
  assert.ok(reads.length >= 3, `the overlay reads a handful of fields, and the test reads ${reads.length}`);
  const dashboard = readFileSync(new URL('../services/dashboard-signals.js', import.meta.url), 'utf8');
  const dashboardKeys = projectedKeys(dashboard, 'export const DASHBOARD_SIGNAL_COLUMNS = `', '`;');
  const signalsKeys = projectedKeys(index, 'SELECT id,channel_title', ' FROM signals WHERE user_id=$1 ORDER BY created_at DESC LIMIT $2');
  for (const key of reads) {
    assert.ok(dashboardKeys.has(key), `the Overview projection selects what the overlay needs: ${key}`);
    assert.ok(signalsKeys.has(key), `and so does the Signals page: ${key}`);
  }
});

test('a row shaped like the dashboard projection is re-decided, not passed through', () => {
  const row = { id: 7, source: 'telegram', executionReady: true, status: 'received', executionNote: AUTO_TRADING_OFF_NOTE };
  const context = { autoTradingEnabled: true, runtimeEnabled: true, paused: false, subscriptionStatus: 'free', accountSelected: false, accountState: null };
  const overlaid = overlayLiveBlocker(row, context);
  assert.equal(overlaid.executionNote, PLAN_NO_EXECUTION_NOTE, 'a Free workspace sees the plan sentence, which is the sentence its banner already shows');
  assert.equal(overlaid.status, 'received', 'and only the sentence moved, never the status');
  const upgraded = overlayLiveBlocker(row, { ...context, subscriptionStatus: 'active', accountSelected: true, accountState: 'DEPLOYED' });
  assert.equal(upgraded.executionNote, null, 'a workspace that has since done everything is left with no warning at all');
  const handWritten = overlayLiveBlocker({ ...row, source: 'manual' }, context);
  assert.equal(handWritten.executionNote, AUTO_TRADING_OFF_NOTE, 'while a note a person wrote is never spoken for');
});

/* ------------------------------------------------------------------ the file no test can execute

   `saveSignal` lives in `index.js`, which boots the server, connects to Postgres and starts timers, so nothing
   here can call it - and a change to its body is therefore only checked as text. That is how an edit which moved
   the outcome decision below the INSERT while leaving `status` reading `outcome.status` in the INSERT's own
   parameter list passed every pin in this repository: a temporal-dead-zone reference is not a syntax error, and
   it throws on the first captured message rather than on the first test run. This is the cheapest thing that
   catches the class. */

test('no name in the capture function is read before the line that declares it', () => {
  const body = index.slice(index.indexOf('async function saveSignal('), index.indexOf('\n}\n\n/*', index.indexOf('async function saveSignal(')));
  assert.ok(body.length > 2000, 'the whole function is in view, not a fragment');
  const stripped = body
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/`(?:[\\\S\\s])*?`/g, ' `` ')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""');
  const offenders = [];
  for (const declaration of stripped.matchAll(/\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=/g)) {
    const name = declaration[1];
    const use = stripped.search(new RegExp(`(^|[^\\w$.])${name}\\b`));
    if (use !== -1 && use < declaration.index) offenders.push(name);
  }
  assert.deepEqual(offenders, [], 'every value the statements hand to a query is declared by the line above them');
});
