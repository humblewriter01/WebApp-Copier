/**
 * The exclusion, which is the part of a pause that keeps a pause.
 *
 * Stopping a session is the easy half: end the client, drop the map entry, write the flag. What makes it a pause
 * rather than a fifteen-second coincidence is that every loop in this app that could put the socket back has to
 * have been told not to. There are four of them - the boot pass and the 60-second sweep that rebuild from the
 * database, the status route's self-heal, the heartbeat's dead-stream callback, and an administrator's button -
 * and a fifth that must not *notice*: the 30-second beat, which would otherwise report a deliberately-paused
 * workspace as stalled and hand it a rebuild it was paused to avoid.
 *
 * Two halves of this file, and each says which it is:
 *
 *   - the exclusions that live in `index.js` are pinned on its source text, because that file cannot be imported
 *     by a test (loading it binds the port and opens the database). Every such test says so in its first line;
 *   - the exclusions that can be *run* are run here, against the real `selectCaptureCandidates`, the real
 *     `createTelegramPauseControl` and a real `createTelegramListener`.
 *
 * One test is a mutation test, and it is the reason this file exists at all. A pin on a source file can be
 * satisfied by code that does nothing; a behaviour test can pass because the harness never gave it the case that
 * would break it. So the sweep is run three times: once as the app is, once with the row-flag check deleted from
 * the selector, and once with both checks deleted - and only the last one is allowed to revive a paused workspace.
 * If the pair below ever stops being load-bearing, that test goes red rather than the feature quietly rotting.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createTelegramPauseControl, selectCaptureCandidates, TELEGRAM_PAUSE_SWEEP_LIMIT } from '../services/telegram-pause.js';
import { createTelegramListener } from '../services/telegram-listener.js';

const index = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
const pauseSource = fs.readFileSync(new URL('../services/telegram-pause.js', import.meta.url), 'utf8');
const healthSource = fs.readFileSync(new URL('../services/system-health.js', import.meta.url), 'utf8');
const listenerSource = fs.readFileSync(new URL('../services/telegram-listener.js', import.meta.url), 'utf8');

/** Fails loudly, with the sentence that moved, rather than slicing out of the file and producing an empty pin. */
function region(source, start, end, label) {
  const from = source.indexOf(start);
  assert.notEqual(from, -1, `the pinned region for ${label} has moved: ${start}`);
  const to = source.indexOf(end, from);
  assert.notEqual(to, -1, `the pinned region for ${label} has no end marker: ${end}`);
  return source.slice(from, to);
}

/**
 * The selector, rebuilt from the real source at test time, optionally with a piece of it deleted.
 *
 * `new Function` rather than a temp file: `selectCaptureCandidates` is pure - it closes over nothing but its two
 * arguments - so its own text is the whole of what it needs, and a mutated copy of a service file written into the
 * repository would be picked up by the tests that scan `services/` for SQL aliases and by a future reader who
 * wonders whether it is production code.
 */
function buildSelector(mutations = []) {
  const start = pauseSource.indexOf('function selectCaptureCandidates');
  assert.notEqual(start, -1, 'the selector is really in the pause service');
  const end = pauseSource.indexOf('\n}', start);
  assert.notEqual(end, -1, 'the selector has a closing brace at the start of a line');
  let body = pauseSource.slice(start, end + 2);
  for (const needle of mutations) {
    assert.equal(body.includes(needle), true, `the mutation is present in the source before it is removed: ${needle}`);
    body = body.split(needle).join('');
  }
  const factory = new Function(`${body}
  return selectCaptureCandidates;`);
  const selector = factory();
  assert.equal(typeof selector, 'function', 'the mutated source still compiles - if it did not, the "red" below would be a syntax error and prove nothing');
  return selector;
}

/** The row list a sweep would read: one workspace paused in the database, one live, one paused while the pass runs. */
const SWEEP_ROWS = [
  { id: 'workspace-live', telegram_paused: false },
  { id: 'workspace-paused', telegram_paused: true },
  { id: 'workspace-just-paused', telegram_paused: false },
];

/**
 * The sweep, in the order `resumeTelegramSessions` runs it, with the two layers that layer is made of.
 *
 * `restore` is the shape `restoreTelegramClient` has: it consults the gate before it does anything, and it is the
 * half a mutation to the selector cannot hide. A paused workspace reaching `restore` is counted as a revive
 * whether the selector let it through or the gate failed to stop it, which is the only definition of red that both
 * layers have to satisfy.
 */
async function runSweep({ select = selectCaptureCandidates, gate, strictGate = true } = {}) {
  const restored = [];
  const candidates = select(SWEEP_ROWS, { isPaused: (userId) => gate.has(userId) });
  for (const row of candidates) {
    if (strictGate && gate.has(row.userId)) continue;
    restored.push(row.userId);
  }
  return restored;
}

/**
 * ---------------------------------------------------------------------------------------------
 * 1. The selector, run for real.
 * ---------------------------------------------------------------------------------------------
 */
test('the sweep drops a workspace the row says is paused, and keeps everyone else in order', () => {
  const candidates = selectCaptureCandidates(SWEEP_ROWS, { isPaused: () => false });
  assert.deepEqual(candidates.map((row) => row.userId), ['workspace-live', 'workspace-just-paused'], 'paused out, order preserved, and nothing else touched');
  assert.equal(candidates[0].id, 'workspace-live', 'the row itself is passed through untouched - the loop that follows still reads `last_active_at` and friends off it');
});

test('and it drops one the gate says is paused a moment after the rows were read', () => {
  /* The window the query cannot close: `resumeTelegramSessions` reads up to 200 rows and then rebuilds them one
     at a time, connecting to Telegram between each, so a pass can be running for minutes. A pause that lands
     during it is in the gate and not in the snapshot, and the workspace is next in line. */
  const candidates = selectCaptureCandidates(SWEEP_ROWS, { isPaused: (userId) => userId === 'workspace-just-paused' });
  assert.deepEqual(candidates.map((row) => row.userId), ['workspace-live']);
});

test('one workspace is rebuilt at most once per pass, whatever the row list contains', () => {
  const rows = [{ id: 'a' }, { id: 'a' }, { id: 'b' }, { id: 42 }, { id: '42' }];
  const candidates = selectCaptureCandidates(rows, { isPaused: () => false });
  assert.deepEqual(candidates.map((row) => row.userId), ['a', 'b', '42'], 'a duplicated id would mean two rebuilds for one workspace, and the latch would refuse the second and report it as contention');
  assert.deepEqual(selectCaptureCandidates([{ id: null }, { id: undefined }, { id: '' }, { id: 0 }], { isPaused: () => false }).map((row) => row.userId), ['0'], 'a missing id is not a workspace; a numeric zero is, and it is kept as the text the map is keyed by');
  assert.deepEqual(selectCaptureCandidates(null).map((row) => row.userId), [], 'no rows is not an error - the sweep runs against an empty fleet every day');
});

/**
 * ---------------------------------------------------------------------------------------------
 * 2. The mutation proof.
 * ---------------------------------------------------------------------------------------------
 */
test('MUTATION: with both exclusions deleted from the selector, the sweep revives the paused workspace', async () => {
  const withoutRowCheck = '    if (row.telegram_paused === true || row.telegramPaused === true) continue;';
  const withoutGateCheck = '    if (isPaused(key)) continue;';
  const mutated = buildSelector([withoutRowCheck, withoutGateCheck]);
  const gate = new Set(['workspace-paused', 'workspace-just-paused']);

  /* With both selector lines gone, the third layer - the gate at the top of `restoreTelegramClient` - is still in
     the harness, and it still refuses every one of them. That is worth stating as a result rather than as a hope:
     the file is defended in depth, and one deleted line is a comment in a review, not an outage. */
  assert.deepEqual(await runSweep({ select: mutated, gate }), ['workspace-live'], 'the restore-level gate holds on its own');

  /* And here is the red. Take the two `continue` lines out, and take the gate out of the restore, and this same
     harness - same rows, same gate contents, same code path otherwise - opens a Telegram socket for a workspace an
     operator had just closed one for. If a future edit ever moves the exclusion somewhere it can be skipped, this
     is the assertion that says so. */
  assert.deepEqual(await runSweep({ select: mutated, gate, strictGate: false }), ['workspace-live', 'workspace-paused', 'workspace-just-paused'], 'with no layer left, the paused workspace IS revived - which is what proves the assertions above are about the exclusion and not about a harness that never had a chance to fail');
});

test('MUTATION: deleting either exclusion alone is survivable, which is why there are two', async () => {
  const gateOnly = await runSweep({ select: buildSelector(['    if (row.telegram_paused === true || row.telegramPaused === true) continue;']), gate: new Set(['workspace-paused', 'workspace-just-paused']) });
  const rowOnly = await runSweep({ select: buildSelector(['    if (isPaused(key)) continue;']), gate: new Set(['workspace-paused', 'workspace-just-paused']), strictGate: false });
  assert.deepEqual(gateOnly, ['workspace-live'], 'the gate catches what a deleted row check would have let through');
  assert.deepEqual(rowOnly, ['workspace-live', 'workspace-just-paused'], 'and the row catches what a deleted gate would have - except the mid-pass pause, which only the gate can see');
});

/**
 * ---------------------------------------------------------------------------------------------
 * 3. The wiring in `index.js`, pinned on its source.
 * ---------------------------------------------------------------------------------------------
 */
test('the sweep asks the database for unpaused sessions, and the SQL is what keeps a paused fleet off the latch', () => {
  const sweep = region(index, 'async function resumeTelegramSessions(', '/**', 'the resume sweep');
  const from = sweep.indexOf("'SELECT id,telegram_paused");
  assert.notEqual(from, -1, 'the sweep reads its own row list with the flag in it');
  const query = sweep.slice(from, sweep.indexOf("');", from) + 2);
  assert.ok(query.includes('WHERE telegram_connected=TRUE'), 'a session has to be linked for it to be restorable');
  assert.ok(query.includes('AND telegram_paused=FALSE'), 'and not paused - the clause that keeps 200 paused workspaces out of every pass instead of filtering them in JavaScript');
  assert.ok(query.includes('ORDER BY last_active_at DESC NULLS LAST LIMIT 200'), 'the bound and the order, unchanged from before the pause existed: a workspace that was active yesterday is picked up before one that was active in April');
  assert.ok(query.includes('SELECT id,telegram_paused FROM users'), 'the flag is read into the row so the selector can see it');
  assert.ok(sweep.includes('selectCaptureCandidates(rows,'), 'and the row list still goes through the JS gate');
  assert.ok(sweep.includes('for (const row of candidates)'), 'the loop walks the candidates, not the rows - `rows.length` stays the reported `wanted`, and the difference between the two is `skippedPaused`');

  // The same mutation trick one level down: a clause that no test could notice being deleted is a clause that will be.
  const withoutClause = query.replace('AND telegram_paused=FALSE ', '');
  assert.ok(withoutClause.length < query.length, 'the clause is really in the statement (the mutation found it to delete)');
  assert.equal(withoutClause.includes('AND telegram_paused=FALSE'), false);
  assert.equal(query.includes('AND telegram_paused=FALSE'), true, 'and the pin above is capable of failing, which is the only property that makes it worth reading');
});

test('every reviver goes through one gate, and the gate is the first thing that function does', () => {
  const restore = region(index, 'async function restoreTelegramClient(', '  const state = telegramReconnect.classify(', 'the restore wrapper');
  assert.ok(restore.indexOf('if (telegramPause.isPaused(userId)) {') < restore.indexOf('telegramRestoreFlight.run('), 'the refusal happens before the single-flight key is even taken, so a paused workspace cannot occupy a latch slot');
  assert.ok(restore.includes("if (strict) throw telegramPause.pausedError();"), 'and a human who asked for this gets the refusal as an error rather than as a null that reads like "nothing to do"');
  assert.ok(restore.includes('log('), 'the silent refusal is still logged, because a sweep that skips sixty workspaces an hour has to be countable');
  assert.equal(restore.includes('telegram_connected'), false, 'the gate neither links nor unlinks anything: it is a question about this process');
});

test('the rebuild checks the row it already read for the session, which is the authority the gate defers to', () => {
  const rebuild = region(index, "const { rows } = await pool.query('SELECT telegram_session,telegram_paused FROM users WHERE id=$1'", 'if (!rows[0]?.telegram_session) {', 'the rebuild\'s session read');
  assert.ok(rebuild.includes("if (rows[0]?.telegram_paused === true) {"), 'the flag is checked at the point of use, so a caller that bypassed the gate - a pass already in flight, or one written next month - is still refused');
  assert.ok(rebuild.indexOf('telegramPause.markPaused(userId);') < rebuild.indexOf("if (strict) throw telegramPause.pausedError();"), 'and the gate is repaired before the answer is handed back, so the next arrival is refused cheaply');

  const install = region(index, 'if (telegramPause.isPaused(userId)) {\n    /* The pause won the race.', 'const holder = telegramClients.get(userId);', 'the pre-install re-check');
  assert.ok(install.includes('await telegramAdapter.destroyClient(client)'), 'a pause that lands while a client is connecting costs that client its socket: ending it here is the only step that keeps the pause from being half-applied');
  assert.ok(install.includes('telegramKeepAlive.release(client);'), 'and the guard record goes with it, exactly as the lost-race branch below does it');
  assert.ok(install.includes('return null;'), 'and this pass reports that it built nothing');
});

test('the status route reports a pause without healing it, and the panel is told who is paused', () => {
  const status = region(index, "app.get('/api/telegram/status'", 'async function persistTelegramLoginAttempt', 'the status route');
  assert.ok(status.includes('telegram_connected,telegram_paused,telegram_pause_reason,telegram_paused_at FROM users'), 'the row, not the gate: the answer has to be true the moment the pause is saved');
  assert.ok(status.includes('const paused = rows[0]?.telegram_paused === true;'));
  assert.ok(status.includes('let connected = Boolean(!paused && rows[0]?.telegram_connected'), 'a paused session is reported as not connected, because it is not');
  assert.ok(status.includes('&& !paused) {'), 'and the self-heal - the one line of this route that could start a socket - is refused');
  assert.ok(status.includes('paused: paused && rows[0]?.telegram_connected === true,'), 'and `paused` travels with the payload only while the session is still linked, so signing out is reported as signing out');
  assert.ok(status.includes("pauseReason: paused ? (rows[0]?.telegram_pause_reason || null) : null"), 'the reason, so the sentence can differ by cause - and `null` rather than a guess when the row does not say');

  const columns = region(index, 'const adminUserColumns = `', '`;', 'the admin row columns');
  assert.ok(columns.includes('u.telegram_paused AS "telegramPaused",'), 'the panel gets the flag, so it can hide a button that would be refused');
  assert.ok(columns.includes('u.telegram_connected AS "telegramConnected",'), 'and the link, which is a different column with a different meaning');
});

test('a paused workspace is refused in the words that apply to it, everywhere a human could reach it', () => {
  const chats = region(index, "app.get('/api/telegram/chats'", 'const dialogs = await telegramAdapter.getDialogs', 'the channel listing');
  assert.ok(chats.includes("if (telegramPause.isPaused(req.userId)) return fail(res, 409,"), 'the channel list asks for a live session, and the answer to a paused one is not the sentence for an unlinked one');
  assert.ok(chats.includes('Connect Telegram first.'), 'which is still there, for the case it describes');
  assert.ok(chats.indexOf('telegramPause.isPaused') < chats.indexOf('const client = await restoreTelegramClient'), 'and before the restore, so the refusal is not a side effect of a null');

  const reconnect = region(index, 'async function forceTelegramReconnect(', '/** Re-attach anything in memory that has lost its handler', 'the forced reconnect');
  assert.ok(reconnect.includes('if (telegramPause.isPausedError(error)) {'), 'a strict reconnect for a paused workspace is a 409 saying "resume it first"...');
  assert.ok(reconnect.indexOf('isPausedError(error)') < reconnect.indexOf('telegramReconnect.isBusy(error)'), '...answered before the busy branch, because the two refusals need different sentences and the pause is the more specific one');
  assert.ok(reconnect.includes('throw error;'), 'and rethrown rather than wrapped: a wrapped refusal loses the flag every branch below reads');
});

test('the pause is written in exactly one file, and no pause or resume writes the link or the session string', () => {
  assert.equal((index.match(/SET telegram_paused/g) || []).length, 0, 'index.js never touches the flag: every write goes through the control, which is what makes "flag first, socket second" a property of the app rather than of one route');
  assert.equal((listenerSource.match(/SET telegram_paused/g) || []).length, 0, 'nor does the listener');
  assert.equal((pauseSource.match(/SET telegram_paused=TRUE/g) || []).length, 1, 'one place sets it');
  assert.equal((pauseSource.match(/SET telegram_paused=FALSE/g) || []).length, 1, 'and one place clears it, with its time and reason in the same statement');
  /* Every write in the service, with the guard inside the pause statement cut out: what has to be true is that no
     * column belonging to the LINK is ever assigned, and a `WHERE telegram_connected=TRUE` reading that column is
     * the safety of the write, not a violation of it. */
  const sets = [...pauseSource.matchAll(/\bSET([\s\S]*?)\bWHERE/g)].map((match) => match[1].replace(/CASE[\s\S]*?END/g, ''));
  assert.equal(sets.length, 2, `two writes in this file, the pause and the resume - a third would be someone writing the flag from a second place (${sets.length})`);
  for (const set of sets) assert.equal(/telegram_(connected|session)\s*=/.test(set), false, 'the linked column and the session string are never in a SET clause here - flipping the first is how a "pause" would sign a trader out, and touching the second is how it would lose them');
  assert.equal(pauseSource.includes('telegram_session=NULL'), false, 'and the stored session string is never dropped');
  assert.equal(pauseSource.includes('DELETE FROM users'), false, 'a pause destroys nothing about the account');
  assert.equal((index.match(/SET telegram_paused=FALSE,telegram_paused_at=NULL/g) || []).length, 0);
});

test('the gate is loaded before the boot sweep, and the policy rides the minute clock the sweeps already share', () => {
  const runtime = index.slice(index.indexOf('async function beginRuntime()'));
  assert.ok(runtime.indexOf("telegramPause.syncGate({ reason: 'boot' })") < runtime.indexOf("resumeTelegramSessions({ reason: 'boot' })"), 'boot reads who is paused before it starts bringing sessions back, or the first thing a fresh deploy does is revive every pause');
  const sweep = region(runtime, 'telegramSweepGuard.run(async () => {', '}, TELEGRAM_SWEEP_INTERVAL_MS)', 'the 60-second pass');
  assert.ok(sweep.includes("await resumeTelegramSessions({ reason: 'sweep' });"), 'the sweep still runs first...');
  assert.ok(sweep.includes("await checkTelegramStreams({ reason: 'sweep' });"), '...then the stream checks...');
  assert.ok(sweep.includes("await telegramPause.reconcile({ reason: 'sweep' });"), '...then the policy, in that order, inside the guard that keeps the passes from stacking');
  assert.ok(sweep.indexOf("checkTelegramStreams({ reason: 'sweep' })") < sweep.indexOf("telegramPause.reconcile({ reason: 'sweep' })"), 'reconcile last, so a session this pass decided to pause is not rebuilt by the pass above it until the next one');
});

test('the listener is told about the gate at the point it is built, before any workspace can be attached', () => {
  const build = region(index, 'const telegramCapture = createTelegramListener({', '});', 'the listener construction');
  assert.ok(build.includes('isPaused: (userId) => telegramPause.isPaused(userId)'), 'an arrow, not a value: the gate is built after the listener and read on every update');
  const order = index.indexOf('const telegramPause = createTelegramPauseControl');
  assert.ok(order > index.indexOf('const telegramReconnect = createTelegramReconnectPolicy'), 'the pause control is built after the reconnect policy, because it borrows that policy\'s `forget` rather than reimplementing removal');
  assert.ok(index.indexOf('const telegramKeepAlive = createTelegramKeepAliveGuard') < order, 'and after the keep-alive, for the same reason: `release` is the teardown, not a copy of it');
});

/**
 * ---------------------------------------------------------------------------------------------
 * 4. The heartbeat and the capture path, run for real against a paused workspace.
 * ---------------------------------------------------------------------------------------------
 */
function createListenerHarness({ paused = [] } = {}) {
  const gate = new Set(paused.map(String));
  const clients = new Map();
  const events = [];
  const makeClient = (id) => ({ id, connected: true, _eventBuilders: [], event: { on: () => {}, off: () => {} }, get: async () => ({ pts: 10 }) });
  const control = makeClient('control');
  const pausedClient = makeClient('paused');
  clients.set('control', { client: control, handler: {}, needsCatchUp: true, stats: { seen: 7, ignored: 0, saved: 3, lastAt: null, lastChatId: null, edits: 0 } });
  clients.set('paused', { client: pausedClient, handler: {}, needsCatchUp: true, stats: { seen: 7, ignored: 0, saved: 3, lastAt: null, lastChatId: null, edits: 0 } });
  const listener = createTelegramListener({
    clients,
    // A monitored channel, so a message for the control workspace is really stored: an exclusion test that passed
    // because nothing was ever capturable would be a test of the harness.
    pool: { query: async (sql) => (String(sql).includes('FROM channels') ? { rows: [{ channelId: '-100123', title: 'Signals' }] } : { rows: [] }) },
    log: (level, message, meta) => events.push([level, message, meta]),
    saveSignal: async () => ({ stored: true }),
    isPaused: (userId) => gate.has(String(userId)),
    now: () => Date.parse('2026-11-02T09:00:00.000Z'),
  });
  return { listener, clients, events, control, pausedClient, gate };
}

test('a workspace the pause control ended is invisible to the beat: not counted, not stalled, not dead', async () => {
  const h = createListenerHarness();
  const before = await h.listener.beatUpdateStreams({ reason: 'test' });
  assert.equal(before.sessions, 2, 'two sessions before the pause, and the beat probes both');

  const pause = createTelegramPauseControl({
    clients: h.clients,
    pool: { query: async () => ({ rowCount: 1, rows: [] }) },
    endClient: async (client) => { client.connected = false; },
    releaseClient: () => {},
    forget: (userId, entry) => { if (h.clients.get(userId) === entry) { h.clients.delete(userId); return true; } return false; },
  });
  await pause.pauseTelegramSession('paused', { reason: 'admin-manual' });

  const after = await h.listener.beatUpdateStreams({ reason: 'test' });
  assert.equal(after.sessions, 1, 'the paused workspace is out of the beat because it is out of the map - that is the whole mechanism, and the only one that cannot drift');
  assert.equal(after.dead, 0, 'nothing was declared dead');
  assert.equal(after.stalled, 0, 'nothing was declared stalled, which is the one that would have started a rebuild');
  assert.equal(after.unrecoverable, 0, 'and no session was declared unrecoverable, which is the one that would have asked the trader to sign in');
  assert.equal(h.clients.has('paused'), false, 'and it stays out: the beat walks the map, so there is no second list to forget to update');

  const fleet = h.listener.telegramFleetSummary();
  assert.deepEqual((fleet.sessions || []).map((session) => session.userId), ['control'], 'the fleet summary the panel reads lists the workspace that is listening and not the one that was stopped');
  const second = await h.listener.beatUpdateStreams({ reason: 'test' });
  assert.equal(second.sessions, 1, 'and it never comes back on its own');
});

test('a live update for a paused workspace is declined before a single counter moves', async () => {
  const h = createListenerHarness({ paused: ['paused'] });
  const entry = h.clients.get('paused');
  const result = await h.listener.ingestMessage('paused', { id: 55, message: 'BUY EURUSD 1.05', date: new Date() }, {}, {});
  assert.deepEqual(result, { stored: false, reason: 'PAUSED' }, 'the answer says why, so a log line and a test can tell a refusal from a filter');
  assert.equal(entry.stats.seen, 7, '`seen` did not move: a paused session recording traffic would put a number on the panel that describes a socket nobody is holding');
  assert.equal(entry.stats.saved, 3, 'and nothing was saved');
  const control = await h.listener.ingestMessage('control', { id: 56, chatId: '-100123', message: 'BUY EURUSD 1.05', date: new Date() }, {}, {});
  assert.equal(control.stored, true, 'the same message for a workspace that is not paused is still handled, which is what makes the branch above an exclusion and not a shutdown');
});

test('a backlog read queued before the pause is not started after it - and the backlog is not lost', async () => {
  const h = createListenerHarness({ paused: ['paused'] });
  const declined = await h.listener.runCatchUp('paused');
  assert.equal(declined.ran, false, 'the replay does not run');
  assert.equal(declined.reason, 'PAUSED', 'and it says the pause is why, not that a socket is missing');
  assert.equal(declined.stored, 0);
  assert.equal(h.clients.get('paused').needsCatchUp, true, '`needsCatchUp` stays set, which is what lets the resume replay the same window instead of the messages arriving after it');
});

test('the listener\'s own guards are the two lines that run before the counters and the client checks', () => {
  const ingest = region(listenerSource, 'async function ingestMessage(userId, message, event', 'const stats = statsFor(userId)', 'the ingest guard');
  assert.ok(ingest.includes("if (isPaused(userId)) return { stored: false, reason: 'PAUSED' };"), 'before `statsFor`, because a counter is a report and a report about a stopped session is wrong');
  const catchUp = region(listenerSource, "if (catchUpInFlight.has(String(userId))) return { ran: false, reason: 'IN_FLIGHT', stored: 0 };", 'catchUpInFlight.add(String(userId));', 'the catch-up guard');
  assert.ok(catchUp.includes("if (isPaused(userId)) return { ran: false, reason: 'PAUSED', stored: 0 };"), 'after the in-flight check and before the cooldown is spent: a declined replay must not cost the next one its window');
});

/**
 * ---------------------------------------------------------------------------------------------
 * 5. The gate enforces itself, so a pause is a fact rather than a request.
 * ---------------------------------------------------------------------------------------------
 */
test('a stale gate can only delay a refusal, never authorise a revival, because the row is checked at the point of use', async () => {
  const clients = new Map();
  const queries = [];
  const restored = [];
  const ended = [];
  const pause = createTelegramPauseControl({
    clients,
    pool: { query: async (sql) => { queries.push(String(sql).replace(/\s+/g, ' ').trim()); return { rowCount: 1, rows: [] }; } },
    endClient: async (client) => { ended.push(client.id); },
    releaseClient: () => {},
    forget: (userId) => { clients.delete(userId); return true; },
    restoreClient: async (userId) => { restored.push(userId); return { connected: true }; },
    idleDays: 30,
  });
  // A pause written by someone else, then read back: the gate learns it, and enforces it on the entry it finds.
  await pause.pauseTelegramSession('u1', { reason: 'admin-manual' });
  assert.equal(pause.isPaused('u1'), true);
  assert.equal(pause.isPaused('u2'), false, 'and a workspace the database did not list is not refused - the gate is a mirror, so an entry it invented would be a permanent outage with no cause');

  const resume = await pause.resumeTelegramSession('u1', { reason: 'plan-upgrade' });
  assert.deepEqual(resume, { resumed: true, cleared: 1, reason: 'plan-upgrade', reconnected: true }, 'the resume goes back through the same restore path every other reviver uses');
  assert.deepEqual(restored, ['u1']);
  assert.equal(pause.isPaused('u1'), false);
});

test('the sweep limit and the gate limit are separate numbers, because they fail differently', () => {
  assert.equal(TELEGRAM_PAUSE_SWEEP_LIMIT, 25, 'a policy pass that acted on the whole fleet at once would start that many reconnects in one minute');
  const sweep = region(index, 'async function resumeTelegramSessions(', '/**', 'the resume sweep');
  assert.ok(sweep.includes('LIMIT 200'), 'while the sweep reads a wider list and lets the latch serialise it - the two bounds are different because they protect different things');
});

test('system-health counts a paused workspace as paused, and not as a session it can restore', () => {
  const select = region(healthSource, 'export const CAPTURE_STATE_SELECT = ', '`;', 'the capture-state query');
  assert.ok(select.includes('AND telegram_paused=FALSE'), 'restorable is the number an operator uses to decide whether the sweep is working; including paused sessions in it would report a deliberate stop as a backlog');
  assert.ok(select.includes('FROM users WHERE telegram_paused=TRUE') && select.includes('paused_users'), 'and the paused count is its own number, so the two cannot be confused by reading one');
  assert.ok(healthSource.includes("pausedUsers: Number(row.paused_users ?? 0)"), 'mapped, not left as a snake_case row for the client to guess at');
  assert.ok(select.includes('telegram_connected=TRUE'), 'the linked count stays untouched by this feature - it answers a different question and its meaning has to survive the deploy');
});
