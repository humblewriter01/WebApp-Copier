/**
 * The reconnect race, proved in both directions.
 *
 * `index.js` cannot be imported by a test - loading it starts the server, binds the port and opens the database -
 * so the two halves of this file do different jobs and say which is which. The decision logic (`classify`,
 * `forget`, the two flags) runs *here, for real*, against a real `createSingleFlight` and a real `Map`, driven by
 * a harness whose rebuild body mirrors the order of statements in `rebuildTelegramClient`: read the entry, end
 * the client, forget it, and only then read the stored session, connect, authorize and install. The wiring in
 * `index.js` - that the discard block calls `forget`, that the answering caller is the strict one, that the
 * database is written after the map - is pinned on the source text, which is the method the rest of this suite
 * uses for everything in that file.
 *
 * One test keeps the pre-fix wrapper alongside the fixed one and shows what each answers to the same second click,
 * because the claim under review is about a report, and a report is best disproved by producing both.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createSingleFlight } from '../services/single-flight.js';
import {
  createTelegramReconnectPolicy,
  RECONNECTED,
  IN_FLIGHT,
  NO_SESSION,
  UNAVAILABLE,
  FAILED,
  RECONNECT_BUSY_FLAG,
  RECONNECT_UNAVAILABLE_FLAG,
} from '../services/telegram-reconnect.js';

const index = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
const USER = 'workspace-1';

function section(start, end, label) {
  const from = index.indexOf(start);
  assert.notEqual(from, -1, `the pinned region for ${label} has moved: ${start}`);
  const to = index.indexOf(end, from);
  assert.notEqual(to, -1, `the pinned region for ${label} has no end marker: ${end}`);
  return index.slice(from, to);
}

/**
 * One workspace, one latch, one map - and a rebuild that holds still until the test says otherwise.
 *
 * `settle()` releases the oldest rebuild sitting in its network window, which is the only part of a real rebuild a
 * second click cannot see the end of, and therefore the only part it can be answered about wrongly.
 */
function createHarness({ staleAfterMs = 300_000, live = true, forgetEndedClient = true } = {}) {
  const clients = new Map();
  const ended = [];
  const dbWrites = [];
  const rebuildCalls = [];
  const heldInWindow = [];
  const log = [];
  const gates = [];
  const config = { live, error: null };
  let clock = 1_000;
  let seq = 0;

  const flight = createSingleFlight({
    staleAfterMs,
    now: () => clock,
    onContention: (key, held) => log.push(['debug', 'contention', { key, elapsedMs: held.elapsedMs }]),
    onTakeover: (key, held) => log.push(['warn', 'takeover', { key, elapsedMs: held.elapsedMs }]),
    onFinished: (key, outcome) => log.push(['info', 'finished', { key, ok: outcome.ok }]),
  });
  const policy = createTelegramReconnectPolicy({ clients, isConnected: (client) => client?.connected === true });

  const makeClient = (connected) => ({ id: `client-${++seq}`, connected, handler: null });
  function end(client) { client.connected = false; client.endedAt = clock; ended.push(client.id); }
  function seed() { const client = makeClient(true); clients.set(USER, { client, handler: null }); return client; }

  async function rebuildTelegramClient(userId, { force = false } = {}) {
    const current = clients.get(userId);
    rebuildCalls.push({ userId, force });
    if (current?.client && (!current.client.connected || force)) {
      end(current.client);
      if (forgetEndedClient) policy.forget(userId, current);
    }
    await new Promise((resolve) => gates.push(resolve));
    // What a second click would be told at the worst possible moment: after the old client is gone, before the
    // new one exists. This one expression is the whole bug.
    heldInWindow.push(policy.held(userId)?.id ?? null);
    if (config.error) throw config.error;
    const client = makeClient(config.live);
    const holder = clients.get(userId);
    // The compare-and-swap, in the same place `rebuildTelegramClient` puts it: the loser ends its own client and
    // hands back the winner's, without touching the map or the database on its way out.
    if (holder && holder !== current) { end(client); return holder.client; }
    clients.set(userId, { client, handler: null });
    dbWrites.push({ telegram_connected: true, via: client.id });
    return client;
  }

  async function restoreTelegramClient(userId, { force = false, strict = false } = {}) {
    const outcome = await flight.run(userId, () => rebuildTelegramClient(userId, { force }));
    const state = policy.classify(outcome, policy.held(userId));
    if (state.status === IN_FLIGHT) { if (strict) throw policy.busyError(state.waitedForMs); return state.client; }
    if (state.status === FAILED) throw state.error;
    if (state.status === UNAVAILABLE) { if (strict) throw policy.unavailableError(); return null; }
    return state.client;
  }

  /**
   * The wrapper as this file was written before the fix, kept on purpose so the mechanism is demonstrated instead
   * of asserted in prose: a refused click returned whatever the map held, and reported it to a human as a
   * reconnect. Nothing here is used to prove the current behaviour is correct - it exists to prove what changed.
   */
  async function restoreWithoutPolicy(userId, { force = false } = {}) {
    const outcome = await flight.run(userId, () => rebuildTelegramClient(userId, { force }));
    if (!outcome.ran) return clients.get(userId)?.client || null;
    if (outcome.error) throw outcome.error;
    return outcome.value;
  }

  return {
    clients, policy, config, ended, dbWrites, rebuildCalls, heldInWindow, log, flight, seed,
    restore: (options) => restoreTelegramClient(USER, options),
    restoreWithoutPolicy: (options) => restoreWithoutPolicy(USER, options),
    settle: () => { const release = gates.shift(); assert.ok(release, 'a test tried to settle a rebuild that was never started'); release(); },
    settleAll: () => { while (gates.length) gates.shift()(); },
    advance: (ms) => { clock += ms; },
    snapshot: () => ({ size: clients.size, live: Boolean(clients.get(USER)?.client?.connected), ids: [...clients.values()].map((entry) => entry.client?.id) }),
  };
}

/* ---------------------------------------------------------------------------
   The policy on its own: five outcomes, and only one of them may be called a reconnect.
   --------------------------------------------------------------------------- */

test('a refused attempt, a failed one and a finished one are three different answers', () => {
  const clients = new Map();
  const policy = createTelegramReconnectPolicy({ clients, isConnected: (client) => client?.connected === true });
  const live = { id: 'live', connected: true };
  const dead = { id: 'dead', connected: false };

  assert.deepEqual(policy.classify({ ran: true, value: live }), { status: RECONNECTED, client: live }, 'a rebuild that ended with a live client is the only answer that says so');
  assert.equal(policy.classify({ ran: true, value: dead }).status, UNAVAILABLE, 'a client with no live socket is not a connected workspace, whoever the map holds');
  assert.equal(policy.classify({ ran: true, value: null }).status, NO_SESSION, 'no stored session is its own answer, neither a failure nor a success');
  assert.equal(policy.classify({ ran: true, error: 'boom' }).error, 'boom', 'the caller keeps its own error rather than a paraphrase of it');
  const refused = policy.classify({ ran: false, elapsedMs: 0, skippedAfterMs: 4_200 }, live);
  assert.equal(refused.status, IN_FLIGHT, 'the second arrival is told that it built nothing');
  assert.equal(refused.client, live, 'and is shown what the workspace holds, so a status caller can still report it');
  assert.equal(refused.waitedForMs, 4_200, 'with how long the holder has had the key, the number that separates a slow rebuild from a wedged one');
  assert.equal(policy.classify(undefined).status, IN_FLIGHT, 'and a caller that received nothing at all is not handed a success either');

  const busy = policy.busyError(12);
  assert.equal(busy[RECONNECT_BUSY_FLAG], true, 'the refusal carries a flag a route can answer with a status code');
  assert.equal(busy.waitedForMs, 12);
  assert.equal(policy.isBusy(busy), true);
  assert.equal(policy.isBusy(policy.unavailableError()), false, 'and the two refusals are not interchangeable');
  assert.equal(policy.isUnavailable(policy.unavailableError()), true);
  assert.equal(policy.isUnavailable(new Error('Telegram did not accept the new connection.')), false, 'a wrapped failure stays a wrapped failure');

  assert.throws(() => createTelegramReconnectPolicy({}), /client map itself/, 'the policy is refused without the real map, because a policy that forgets a copy enforces nothing');
});

test('forget removes only the entry the caller still owns', () => {
  const clients = new Map();
  const policy = createTelegramReconnectPolicy({ clients });
  const mine = { client: { id: 'a' } };
  clients.set(USER, mine);
  assert.equal(policy.forget(USER, null), false, 'nothing to forget is answered, not thrown');
  assert.equal(policy.forget(USER, { client: { id: 'other' } }), false, 'an entry nobody installed is not this caller\'s to remove');
  assert.equal(clients.has(USER), true, 'and the workspace keeps what it had');
  assert.equal(policy.forget(USER, mine), true);
  assert.equal(clients.has(USER), false, 'the ended client leaves the map in the same breath it was ended in');
  assert.equal(policy.held(USER), null, 'so the next caller is handed nothing rather than a corpse');
});

/* ---------------------------------------------------------------------------
   The race, driven through the real latch.
   --------------------------------------------------------------------------- */

test('one reconnect ends the client it replaces, installs exactly one, and says so once', async () => {
  const harness = createHarness();
  const first = harness.seed();
  const pending = harness.restore({ force: true, strict: true });
  harness.settle();
  const result = await pending;
  assert.equal(result.id, harness.snapshot().ids[0], 'the answer is the client the map holds');
  assert.equal(harness.snapshot().live, true);
  assert.deepEqual(harness.ended, [first.id], 'the old client was ended, once');
  assert.equal(harness.rebuildCalls.length, 1, 'one click is one rebuild');
  assert.equal(harness.dbWrites.length, 1, 'one successful rebuild is one write, and it names the client that won');
  assert.equal(harness.dbWrites[0].via, result.id);
});

test('two rapid clicks: one rebuild, one honest refusal, and no corpse to report', async () => {
  const harness = createHarness();
  const first = harness.seed();
  const clicks = [harness.restore({ force: true, strict: true }), harness.restore({ force: true, strict: true })];
  harness.settle();
  const [won, refused] = await Promise.allSettled(clicks);
  assert.equal(won.status, 'fulfilled', 'the click that got the latch reconnects the workspace');
  assert.equal(refused.status, 'rejected', 'the click that did not is refused');
  assert.equal(refused.reason[RECONNECT_BUSY_FLAG], true, 'and the refusal is the refusal, not a generic failure dressed up as one');
  assert.equal(harness.rebuildCalls.length, 1, 'a second click does not build a second client');
  assert.deepEqual(harness.ended, [first.id], 'and the old client is ended exactly once, by the pass that replaced it');
  assert.deepEqual(harness.snapshot(), { size: 1, live: true, ids: ['client-2'] }, 'memory holds one live client');
  assert.equal(harness.dbWrites.length, 1, 'the database was written once, by that same pass');
  assert.equal(harness.flight.size(), 0, 'and the latch is free again, so the watchdog can reach this workspace');
});

test('three rapid clicks leave one live client, one write, and no client that outlived its own map entry', async () => {
  const harness = createHarness();
  const first = harness.seed();
  const clicks = [
    harness.restore({ force: true, strict: true }),
    harness.restore({ force: true, strict: true }),
    harness.restore({ force: true, strict: true }),
  ];
  harness.settle();
  const settled = await Promise.allSettled(clicks);
  assert.deepEqual(settled.map((outcome) => outcome.status), ['fulfilled', 'rejected', 'rejected'], 'one reconnect happened, and the two other presses were told the truth');
  const snapshot = harness.snapshot();
  assert.equal(snapshot.size, 1, 'exactly one client in memory');
  assert.equal(snapshot.live, true, 'and it is a live one');
  assert.deepEqual(harness.ended, [first.id], 'the only client ever ended is the one this pass replaced');
  assert.equal(harness.heldInWindow.length, 1, 'one pass went through the window');
  assert.equal(harness.heldInWindow[0], null, 'and for its whole duration the map held no client at all, because the ended one was forgotten');
  assert.deepEqual(harness.dbWrites, [{ telegram_connected: true, via: 'client-2' }], 'the database and memory name the same client');
  for (const entry of harness.clients.values()) assert.notEqual(entry.client.connected, false, 'nothing in the map is a client this process ended');
  assert.equal(harness.log.some(([, kind]) => kind === 'takeover'), false, 'a refusal inside the stale window is contention, not a takeover');
  assert.equal(harness.flight.size(), 0);
});

test('what the fix changed: one click arriving mid-window, answered by the old wrapper and by the policy', async () => {
  /* The shape that matters is a click that lands while another pass is still in its network window, which is what
     a human double-pressing a button produces: seconds of reads, connects and a resync between the discard and the
     install. So the second click is awaited *before* the first is settled. */
  const broken = createHarness({ forgetEndedClient: false });
  const corpse = broken.seed();
  const running = broken.restoreWithoutPolicy({ force: true });
  const answered = await broken.restoreWithoutPolicy({ force: true });
  assert.equal(answered, corpse, 'the pre-fix wrapper reported the client the winning pass had just ended as the result of this click');
  assert.equal(answered.connected, false, 'ended, and handed over as connected');
  assert.equal(broken.rebuildCalls.length, 1, 'without building a second client on the way');
  broken.settle();
  assert.equal((await running).id, 'client-2', 'the winning pass itself was fine, which is the point: the damage was in the answer');

  const fixed = createHarness();
  const previous = fixed.seed();
  const alsoRunning = fixed.restore({ force: true, strict: true });
  const refusedMidWindow = await fixed.restore({ force: true, strict: true }).then(() => 'answered', (error) => error);
  assert.equal(refusedMidWindow[RECONNECT_BUSY_FLAG], true, 'the same click, answered by the policy, is a refusal');
  assert.notEqual(refusedMidWindow, previous, 'and not the previous client under any name');
  assert.equal(fixed.clients.size, 0, 'and the map held no client of any kind while that answer was given, because the ended one had been forgotten');
  fixed.settle();
  assert.equal((await alsoRunning).connected, true, 'the pass that holds the latch still finishes the job');
  assert.deepEqual(fixed.ended, [previous.id], 'and the client it replaced was ended once');
});

test('a reconnect that fails mid-flight leaves no client in memory and no write behind', async () => {
  const harness = createHarness();
  harness.config.error = new Error('ETIMEDOUT: socket died during connect');
  const first = harness.seed();
  first.connected = false;
  const clicks = [harness.restore({ force: true, strict: true }), harness.restore({ force: true, strict: true })];
  harness.settle();
  const [failed, refused] = await Promise.allSettled(clicks);
  assert.equal(failed.status, 'rejected', 'the pass that ran reports the socket error unchanged');
  assert.match(failed.reason.message, /socket died during connect/);
  assert.equal(refused.reason[RECONNECT_BUSY_FLAG], true, 'and the pass that was refused is refused, not failed on somebody else\'s behalf');
  assert.equal(harness.clients.size, 0, 'nothing is left in memory pointing at an ended client');
  assert.deepEqual(harness.dbWrites, [], 'a reconnect that did not happen writes nothing claiming that it did');
  assert.deepEqual(harness.ended, [first.id], 'the old client is ended once, not twice');
  assert.equal(harness.flight.size(), 0, 'the latch is released even though the pass threw');

  harness.config.error = null;
  const recovery = harness.restore({ force: true, strict: true });
  harness.settle();
  const recovered = await recovery;
  assert.equal(recovered.connected, true, 'a later attempt is granted the latch and fixes the workspace');
  assert.deepEqual(harness.snapshot(), { size: 1, live: true, ids: ['client-2'] }, 'and ends with exactly one live client');
  assert.equal(harness.rebuildCalls.length, 2, 'two passes ran, one after the other, never at the same time');
  assert.equal(harness.ended.length, 1, 'the pass that threw allocated nothing, so there is no second client to end: a failure inside the window leaves no orphan behind');
});

test('a rebuild that ends without a live socket is never reported as connected, to either caller', async () => {
  const harness = createHarness({ live: false });
  const first = harness.seed();
  const clicks = [harness.restore({ force: true, strict: true }), harness.restore({ force: true })];
  harness.settle();
  const [strict, loose] = await Promise.allSettled(clicks);
  assert.equal(strict.status, 'rejected', 'the operator is told the socket is not live');
  assert.equal(strict.reason[RECONNECT_UNAVAILABLE_FLAG], true);
  assert.equal(loose.value, null, 'and the status caller is given nothing to call connected');
  assert.equal(first.connected, false);
  assert.deepEqual(harness.ended, [first.id], 'the client that was replaced is ended once');
  assert.equal(harness.log.filter(([level, kind]) => level === 'warn' && kind === 'takeover').length, 0);
});

test('past the stale window a takeover may run, and the loser still leaves one live client behind', async () => {
  const harness = createHarness({ staleAfterMs: 60_000 });
  const first = harness.seed();
  const wedged = harness.restore({ force: true, strict: true });
  harness.advance(60_001);
  const takeover = harness.restore({ force: true, strict: true });
  assert.equal(harness.rebuildCalls.length, 2, 'the second pass is granted the key once the holder is past the stale window');
  assert.equal(harness.log.some(([level, kind]) => level === 'warn' && kind === 'takeover'), true, 'and it is announced, because two passes are now building for one workspace');
  harness.settleAll();
  const settled = await Promise.allSettled([wedged, takeover]);
  const snapshot = harness.snapshot();
  assert.equal(snapshot.size, 1, 'one client in memory when the dust settles');
  assert.equal(snapshot.live, true, 'and it is live');
  assert.equal(harness.ended.filter((id) => id === first.id).length, 1, 'the client that was there at the start is ended once, not twice');
  assert.equal(harness.dbWrites.length, 1, 'and exactly one pass recorded a success, whichever of the two it was');
  for (const outcome of settled) assert.equal(outcome.status, 'fulfilled', 'both passes end holding a client - the loser hands back the winner\'s instead of its own');
  const inMap = new Set([...harness.clients.values()].map((entry) => entry.client.id));
  for (const id of harness.ended) assert.equal(inMap.has(id), false, `the ended client ${id} is not left in the map, so nothing here is a zombie`);
});

/* ---------------------------------------------------------------------------
   The wiring, pinned where it lives.
   --------------------------------------------------------------------------- */

test('the flag the route reads is the flag the helper rethrows, unwrapped', () => {
  const helper = section('async function forceTelegramReconnect(', '\n/** Re-attach anything in memory', 'the manual reconnect');
  assert.match(helper, /restoreTelegramClient\(userId, \{ reason, force: true, strict: true \}\)/, 'the answering caller is the strict one');
  assert.match(helper, /if \(telegramReconnect\.isBusy\(error\)\) \{[\s\S]{0,320}throw error;/, 'a refusal is rethrown as itself: the wrapper that turns every failure into "Telegram did not accept the new connection" would describe a refusal as a rejected handshake, which is the opposite instruction');
  assert.ok(helper.indexOf('isBusy(error)') < helper.indexOf('await auditLog.record('), 'and it happens before the audit row, so a refused click cannot leave a line saying a session was reconnected by hand');
  assert.match(helper, /if \(telegramReconnect\.isUnavailable\(error\)\) \{[\s\S]{0,240}throw error;/, 'and so does a rebuild that ended without a live socket');
  assert.ok(helper.indexOf('await restoreTelegramClient(') < helper.indexOf('const capture = telegramCapture.heartbeatSummary();'), 'the reconnect is answered before any of the reporting is built, so nothing on the success path runs for a refused attempt');
});

test('the wiring in index.js: one latch, one forget, and the database last', () => {
  assert.equal((index.match(/telegramRestoreFlight\.run\(/g) || []).length, 1, 'exactly one place enters the per-workspace latch, so "one rebuild at a time" stays a property of the file');
  const restore = section('async function restoreTelegramClient(', 'async function rebuildTelegramClient(', 'the latch wrapper');
  assert.match(restore, /const state = telegramReconnect\.classify\(outcome, telegramClients\.get\(userId\)\?\.client \|\| null\);/, 'its answer goes through the policy');
  assert.match(restore, /if \(strict\) throw telegramReconnect\.busyError\(state\.waitedForMs\);/, 'a refusal is fatal for a strict caller');
  assert.match(restore, /if \(strict\) throw telegramReconnect\.unavailableError\(\);/, 'and so is a client with no live socket');
  assert.match(restore, /reason = 'restore', force = false, escalate = false, strict = false/, 'strict is opt-in, so every sweep keeps the behaviour it was written against');

  const discard = section('if (current?.client && (!telegramAdapter.isConnected(current.client) || mustRebuild)) {', '\n  const { rows } = await pool.query', 'the discard block');
  assert.match(discard, /await telegramAdapter\.destroyClient\(current\.client\)\.catch\(\(\) => \{\}\);/, 'the replaced client is ended, not merely disconnected');
  assert.ok(discard.indexOf('telegramKeepAlive.release(current.client);') < discard.indexOf('telegramReconnect.forget(userId, current)'), 'its guard record goes with it, and the map entry goes in the same block');
  assert.match(discard, /if \(!telegramReconnect\.forget\(userId, current\)\) \{/, 'and a forget that found somebody else\'s entry is logged rather than left silent');

  const rebuild = section('async function rebuildTelegramClient(', '\n/** Re-attach anything in memory', 'the rebuild');
  assert.ok(rebuild.indexOf('telegramClients.set(userId, { client, handler: null') < rebuild.indexOf('UPDATE users SET telegram_connected=TRUE'),
    'the map adopts the client before the database is told, so a `TRUE` can never describe a client memory has not accepted');
  const route = section("app.post('/api/admin/users/:id/telegram/reconnect'", '\napp.post', 'the route');
  assert.match(route, /fail\(res, 409, `\$\{error\.message\} The one already running will replay the backlog by itself/, 'a refused click is a 409 about the click');
  assert.match(route, /fail\(res, 503, `\$\{error\.message\} The heartbeat keeps retrying/, 'and a rebuild without a live socket is a 503 about the socket');
});
