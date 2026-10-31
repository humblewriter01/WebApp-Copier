/**
 * The memory-leak fixes, each with the failure it prevents written next to the assertion.
 *
 * Four of these five groups are behavioural and one is not, and the split is deliberate. The mechanisms
 * (`single-flight`, the guard's eviction, the handler-pair clear, the paged listing) live in modules that can be
 * driven directly, so they are driven. The *wiring* of them lives in `index.js`, which is a server: importing it
 * would bind a port and start a migration, so those assertions read the file instead - which is the same
 * technique `telegram-adapter.test.js` uses for the seam, and it fails for a missing call rather than for a
 * refactor that renamed something harmlessly.
 *
 * What is being protected is a specific outage: the Render container hit 512 MB and was killed. Two of the causes
 * are visible in these tests as objects that would otherwise accumulate, and the third - an orphaned Telegram
 * client, which is a socket with a live update loop that nothing points at - is the one that actually cost the
 * memory, so it gets the most assertions.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createOccupancySet, createPassGuard, createSingleFlight, DEFAULT_STALE_AFTER_MS } from '../services/single-flight.js';
import { createTelegramKeepAliveGuard } from '../services/telegram-keepalive.js';
import { CATCH_UP_CHANNEL_LIMIT, CATCH_UP_CHANNEL_PAGES, createTelegramListener } from '../services/telegram-listener.js';
import * as telegramAdapter from '../services/telegram-adapter.js';
import { StringSession } from 'telegram/sessions/index.js';

const keepAliveTimeout = () => Object.assign(new Error('TIMEOUT'), { stack: `Error: TIMEOUT\n    at file:///app/node_modules/telegram/client/updates.js:12:1` });

/**
 * ---------------------------------------------------------------------------------------------
 * 1. `createSingleFlight` - the latch that keeps one workspace from being rebuilt twice.
 * ---------------------------------------------------------------------------------------------
 */
test('a second arrival on a held key does not run, and says how long it waited', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let runs = 0;
  const contentions = [];
  const flight = createSingleFlight({ onContention: (key, info) => contentions.push({ key, ...info }) });

  const first = flight.run('u1', async () => { runs += 1; await gate; return 'client-A'; });
  const second = await flight.run('u1', async () => { runs += 1; return 'client-B'; });

  assert.equal(second.ran, false, 'the duplicate rebuild never started, so it never built a second client');
  assert.equal(runs, 1);
  assert.equal(second.value, undefined, 'and it is not pretending to have produced a client');
  assert.equal(flight.size(), 1, 'the key is still held by the one that is running');
  assert.equal(contentions.length, 1);
  assert.equal(contentions[0].key, 'u1', 'the log line gets the key, because "a rebuild was skipped" without a workspace is unreadable');

  release();
  const done = await first;
  assert.deepEqual({ ran: done.ran, value: done.value }, { ran: true, value: 'client-A' }, 'the first caller is unaffected by the second one giving up');
  assert.equal(flight.size(), 0, 'and the key is released when it finishes');
});

test('the key is released when the work throws, and the error still reaches the caller', async () => {
  const flight = createSingleFlight();
  const outcome = await flight.run('u1', async () => { throw new Error('Telegram credentials are not configured'); });
  assert.equal(outcome.ran, true, 'a failed attempt is still an attempt, so the caller can rethrow rather than swallow');
  assert.match(outcome.error.message, /not configured/);
  assert.equal(flight.size(), 0, 'a throw does not leave the key held, which would lock this workspace out of ever reconnecting');

  let ran = 0;
  await flight.run('u1', async () => { ran += 1; });
  assert.equal(ran, 1, 'and the next arrival runs normally');
});

test('a wedged holder is taken over, and its late completion does not unlock the new holder', async () => {
  let clock = 0;
  let holdRelease;
  const held = new Promise((resolve) => { holdRelease = resolve; });
  const takeovers = [];
  const flight = createSingleFlight({ now: () => clock, staleAfterMs: 1_000, onTakeover: (key, info) => takeovers.push({ key, heldForMs: info.elapsedMs }) });

  let releaseA;
  let releaseB;
  const gateA = new Promise((resolve) => { releaseA = resolve; });
  const gateB = new Promise((resolve) => { releaseB = resolve; });
  void held; void holdRelease;

  const wedged = flight.run('u1', () => gateA.then(() => 'stale-client'));
  clock = 5_000;
  const takeover = flight.run('u1', () => gateB.then(() => 'taken-over'));
  assert.deepEqual(takeovers, [{ key: 'u1', heldForMs: 5_000 }], 'after the stale window the next arrival is allowed through - one dead socket must not be able to freeze a workspace forever');

  clock = 5_100;
  const blocked = await flight.run('u1', async () => 'never');
  assert.equal(blocked.ran, false, 'the new holder is held in turn, immediately');

  releaseA();
  await wedged;
  clock = 5_200;
  const afterLateFinish = await flight.run('u1', async () => 'also-never');
  assert.equal(afterLateFinish.ran, false, 'the displaced holder finishing late must not unlock the key somebody else is holding - this is what the token in `finally` is for');

  releaseB();
  await takeover;
  const free = await flight.run('u1', async () => 'free-at-last');
  assert.deepEqual({ ran: free.ran, value: free.value }, { ran: true, value: 'free-at-last' }, 'and once the real holder is done, the key is open again');
});

test('the finished callback sees duration and failure, which is how an overrun is logged', async () => {
  let clock = 0;
  const seen = [];
  const flight = createSingleFlight({ now: () => (clock += 1_000), onFinished: (key, info) => seen.push({ key, ...info }) });
  await flight.run('u1', async () => 'ok');
  await flight.run('u2', async () => { throw new Error('nope'); });
  assert.deepEqual(seen.map((entry) => [entry.key, entry.ok]), [['u1', true], ['u2', false]]);
  assert.equal(seen[0].elapsedMs > 0, true);
  assert.match(seen[1].error.message, /nope/);
  assert.equal(DEFAULT_STALE_AFTER_MS, 300_000, 'the default grace is five minutes: long enough for a slow fleet pass, short enough that a wedged key is not permanent');
});

/**
 * ---------------------------------------------------------------------------------------------
 * 2. `createPassGuard` - a sweep that outruns its own interval skips instead of stacking.
 * ---------------------------------------------------------------------------------------------
 */
test('a pass that outlives its interval causes the next tick to be refused, not queued', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const skips = [];
  let clock = 0;
  const guard = createPassGuard({ name: 'telegram-sweep', onSkip: (info) => skips.push(info), now: () => clock });

  let runs = 0;
  const first = guard.run(async () => { runs += 1; clock = 41_000; await gate; return 'done'; });
  const second = await guard.run(async () => { runs += 1; });

  assert.equal(second.ran, false, 'the overlapping tick did no work');
  assert.equal(runs, 1, 'so its queries, its client constructions and its memory are all absent');
  assert.deepEqual({ pass: skips[0].name, skipped: skips.length }, { pass: 'telegram-sweep', skipped: 1 }, 'and the skip is attributable to a named pass');
  assert.ok(skips[0].runningForMs >= 0, 'with how long the running pass has been going, which is the number that says "70s on a 60s interval"');

  release();
  const done = await first;
  assert.deepEqual({ ran: done.ran, value: done.value }, { ran: true, value: 'done' });
  const third = await guard.run(async () => { clock += 1; return 'next'; });
  assert.equal(third.ran, true, 'the guard is not sticky once the pass ends');
  assert.deepEqual(guard.stats, { passes: 2, skipped: 1, slowestMs: 41_000 }, 'the counts are the shape of the outage: two passes, one refused, and the slowest at 41 seconds on a 60-second interval');
});

test('a pass that throws releases the guard and propagates, so one failure cannot stop the sweeps permanently', async () => {
  const guard = createPassGuard({ name: 'beat', overrunAfterMs: 0 });
  await assert.rejects(() => guard.run(async () => { throw new Error('pool is exhausted'); }), /pool is exhausted/);
  assert.equal(guard.isRunning(), false, 'the key was released on the way out, which is the difference between a bad minute and a dead service');
  const outcome = await guard.run(async () => 'fine');
  assert.deepEqual({ ran: outcome.ran, value: outcome.value }, { ran: true, value: 'fine' });
});

test('the overrun hook reports duration against the interval it was given', async () => {
  let clock = 1_000;
  const overruns = [];
  const guard = createPassGuard({ name: 'telegram-sweep', overrunAfterMs: 60_000, now: () => clock, onOverrun: (info) => overruns.push(info) });
  clock = 62_000;
  await guard.run(async () => { clock = 122_000; });
  assert.deepEqual(overruns, [], 'a pass of 60 seconds on a 60-second threshold has not overrun it, and the comparison is strict');
  await guard.run(async () => { clock += 61_000; });
  assert.deepEqual(overruns, [{ name: 'telegram-sweep', elapsedMs: 61_000, thresholdMs: 60_000 }], 'a pass slower than its interval is a fact to say out loud, not a memory graph to interpret');
});

test('the occupancy set is the same rule without a promise, for work already serialised', () => {
  let clock = 0;
  const occupied = createOccupancySet({ now: () => clock, staleAfterMs: 1_000 });
  assert.equal(occupied.claim('u1'), true);
  assert.equal(occupied.claim('u1'), false, 'a second claim while the first is fresh is refused');
  assert.equal(occupied.has('u1'), true);
  clock = 1_001;
  assert.equal(occupied.claim('u1'), true, 'and after the stale window the next claimer takes it, as with the flight');
  occupied.release('u1');
  assert.equal(occupied.size(), 0);
  occupied.release('never-held');
  assert.equal(occupied.has('never-held'), false, 'releasing an unheld key is not an error - callers are cleanup paths');
});

/**
 * ---------------------------------------------------------------------------------------------
 * 3. The keep-alive guard's own records, which used to be permanent.
 * ---------------------------------------------------------------------------------------------
 */
test('a disconnected client stops being guarded, and what it swallowed stays counted', () => {
  const logs = [];
  const guard = createTelegramKeepAliveGuard({ log: (level, message) => logs.push({ level, message }), now: () => 1_000 });
  const live = { _log: { canSend: () => true } };
  const state = guard.attach(live, { userId: 'u1' });
  assert.equal(guard.guardedCount(), 1);
  assert.equal(guard.stats().clients, 1);

  guard.note(keepAliveTimeout(), state);
  assert.equal(guard.stats().count, 1, 'the timeout is counted while the client is ours');
  assert.equal(guard.release(live), true, 'and releasing the exact client that was dropped is a real answer, not a no-op');
  assert.equal(guard.guardedCount(), 0, 'the record goes with it, so a service that rebuilds 500 sessions does not carry 500 records');
  /* The fleet total, on the other hand, does not go with it. `stats()` used to add the records up, which made the
     panel's "timeouts swallowed since boot" a function of who was still attached - so a release subtracted real
     work from the total, and a client whose update loop outlived its record (the prod case: `count: 1081`,
     `suppressedTotal: 0`) was invisible forever. The leak this file exists to prevent is the *set* growing, not
     the arithmetic remembering. */
  assert.equal(guard.stats().count, 1, 'the record is bounded, the fact is not un-counted');
  guard.note(keepAliveTimeout(), state);
  assert.equal(guard.stats().count, 2, 'including timeouts earned after the record was dropped, because the handler the guard installed is still on the client and the counter is not attached to the registry');
  assert.equal(guard.flapFor(live).count, 0, 'the watchdog can no longer be told this phantom flapped');
  assert.equal(guard.stats().clients, 0, 'and the registry is still empty, which is the half of the fix that must not regress');
  assert.equal(guard.release(live), false, 'releasing twice is safe, because disconnect paths run more than once by design');
  assert.equal(guard.release(null), false, 'and releasing a client the guard never saw is not an error, because the caller is a catch block');
});

test('the cap makes unbounded growth impossible even if a drop path forgets to release', () => {
  const logs = [];
  const guard = createTelegramKeepAliveGuard({ log: (level, message, meta) => logs.push({ level, message, meta }), now: () => 1_000 });
  // Enough unreachable clients to pass any cap, with no reference kept on purpose.
  for (let index = 0; index < 600; index += 1) guard.attach({ _log: { canSend: () => true } }, { userId: `u${index}` });
  const survivor = { _log: { canSend: () => true } };
  const state = guard.attach(survivor, { userId: 'survivor' });
  assert.equal(guard.flapFor(survivor) !== undefined, true, 'the most recent client is never the one evicted');
  assert.ok(guard.guardedCount() <= 512, `the set is capped absolutely, not "eventually, once the collector feels like it" (${guard.guardedCount()})`);
  assert.equal(logs.some((entry) => entry.message.includes('cap')), true, 'and hitting it is said out loud: a silent truncation of a diagnostic structure is a diagnostic structure nobody can trust');
  assert.equal(guard.flapFor(survivor) !== undefined, true, 'a client that is still referenced keeps its record through the cap, because its counts are still about a live session');
  guard.note(keepAliveTimeout(), state);
  assert.equal(guard.stats().count, 1);
});

/**
 * ---------------------------------------------------------------------------------------------
 * 4. Handler pairs: one registration per half, whatever the bookkeeping lost.
 * ---------------------------------------------------------------------------------------------
 */
test('attaching capture clears a handler this process cannot account for', async () => {
  const client = telegramAdapter.createClient({ sessionString: new StringSession().save() || '', apiId: 1, apiHash: 'h', options: telegramAdapter.loginTransportOptions() });
  /* The state this file exists for: an edit pair is on the client, and the entry that is about to be re-armed has
     no reference to it. That happens when a client outlives the bookkeeping written for it, and before this fix
     the re-attach added a second pair - permanently, on a session that looks healthy enough that nothing rebuilds
     it, which is the worst possible place for a duplicate because every edit then arrives twice and every count
     stays plausible. */
  const orphan = function orphanEditHandler() {};
  telegramAdapter.addEditHandler(client, orphan, telegramAdapter.createEditEventFilter());
  assert.equal(telegramAdapter.listEventHandlers(client).length, 1, 'the orphan is really there before we start');

  const clients = new Map([['u1', { client }]]);
  const listener2 = createTelegramListener({ clients, pool: { query: async () => ({ rows: [] }) }, log: () => {}, saveSignal: async () => ({ stored: true }) });
  await listener2.startTelegramListener('u1', client);
  const pairs = telegramAdapter.listEventHandlers(client);
  assert.equal(pairs.length, 2, 'exactly two pairs afterwards: one for new messages, one for edits');
  assert.equal(pairs.some((pair) => pair[1] === orphan), false, 'and the unaccounted handler is gone rather than merely counted');
  assert.equal(pairs.filter((pair) => pair[0]?.constructor?.name === 'NewMessage').length, 1, 'the builders are still distinct, which is what makes the two halves a partition and not a union');
  assert.equal(pairs.filter((pair) => pair[0]?.constructor?.name === 'EditedMessage').length, 1);

  /* Attaching again must be idempotent in the strong sense - the count does not move - because this function is
     called from the status route, the boot sweep, a channel toggle and the watchdog. */
  await listener2.startTelegramListener('u1', client);
  assert.equal(telegramAdapter.listEventHandlers(client).length, 2, 'a second attach does not add a third pair');
});

/**
 * ---------------------------------------------------------------------------------------------
 * 5. The paged channel listing, pinned as behaviour rather than as a SQL substring.
 * ---------------------------------------------------------------------------------------------
 */
test('the catch-up channel listing is bounded per page and keeps paging while pages are full', async () => {
  const queries = [];
  const rows = (count, offset) => Array.from({ length: count }, (_, index) => ({ channelId: `-100${offset + index}`, title: `c${offset + index}`, username: null }));
  const pool = { query: async (sql, params) => {
    queries.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params });
    if (!sql.includes('FROM channels')) return { rows: [] };
    const [, limit, offset] = params;
    const remaining = 120 - offset;
    const taken = Math.min(limit, remaining);
    return { rows: rows(taken, offset) };
  } };
  const listener = createTelegramListener({
    clients: new Map([['u1', { client: { connected: true }, needsCatchUp: true }]]),
    pool,
    log: () => {},
    saveSignal: async () => ({ stored: true }),
    now: () => 0,
    catchUpLimit: 3,
    // The cooldown is a protection for the live service, not for a test that wants to see one pass run.
    catchUpCooldownMs: 0,
    // Same reasoning for the throttle's timer: this file asks whether two passes can overlap and whether a page
    // bound is honoured, and it has to be able to answer that in milliseconds. Where the pauses go is pinned in
    // `test/telegram-listener-flow.test.mjs`, against a recorder that reads the gaps rather than waiting on them.
    // Left to the real `setTimeout`, this one test spent 119 s asleep - and a suite that slow is a suite someone
    // shortens by deleting a file.
    catchUpSleep: async () => {},
  });
  const result = await listener.runCatchUp('u1');
  assert.equal(result.ran, true);
  const listing = queries.filter((entry) => entry.sql.includes('FROM channels'));
  assert.ok(listing.length >= 2, `a full page is followed by another page (${listing.length} listing queries), so a workspace with more channels than one page is not silently truncated`);
  assert.match(listing[0].sql, /LIMIT \$2 OFFSET \$3/, 'the bound is in the query, not applied afterwards to an already-materialised array');
  assert.equal(CATCH_UP_CHANNEL_LIMIT, listing[0].params[1], 'and the page size the code asks for is the exported one, so a caller can change it');
  assert.deepEqual(listing[0].params, ['u1', 50, 0], 'a page asks for exactly its size, and a short answer is the last page');
  assert.deepEqual(listing[1].params, ['u1', 50, 50], 'and the next page starts where the last one ended');
  assert.equal(listing.length, 3, '120 channels in pages of 50 is three queries, the third of which comes back short and stops the loop');
  assert.ok(listing.length <= CATCH_UP_CHANNEL_PAGES, 'the page count is bounded, so paging cannot itself become the unbounded thing');
});

/**
 * ---------------------------------------------------------------------------------------------
 * 6. The wiring in `index.js`, which cannot be imported and so is read.
 * ---------------------------------------------------------------------------------------------
 */
const boot = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
const code = (source) => source.split('\n').filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line)).join('\n');

test('every rebuild goes through the latch, and a lost race disconnects its own client', () => {
  const body = code(boot);
  assert.equal((body.match(/rebuildTelegramClient\(/g) || []).length, 2, 'declared once and called from exactly one place: the wrapper that holds the key');
  assert.match(body, /telegramRestoreFlight\.run\(userId, \(\) => rebuildTelegramClient\(/, 'and that place is inside the flight');
  assert.equal(body.includes('await rebuildTelegramClient('), false, 'no caller may reach past the latch, which is why the inner function is not exported');

  const cas = body.slice(body.indexOf('const holder = telegramClients.get(userId);'), body.indexOf('const holder = telegramClients.get(userId);') + 620);
  assert.match(cas, /if \(holder && holder !== current\)/, 'the map is compared against what this pass read, at the moment it writes');
  assert.match(cas, /await telegramAdapter\.destroyClient\(client\)/, 'and the losing client is ENDED before it is dropped - an authorized GramJS client does not stop because nothing points at it, and `disconnect()` is not what stops it: the loop lives on until `_destroyed` is set');
  assert.match(cas, /telegramKeepAlive\.release\(client\)/, 'with its guard record released alongside it');
  assert.match(cas, /log\('warn'/, 'and it is a warning, not a debug line: reaching this branch at all means something bypassed the latch');
});

test('both timers are guarded, on a named interval, and the beat reports memory every tick', () => {
  const body = code(boot);
  assert.match(body, /const TELEGRAM_SWEEP_INTERVAL_MS = 60_000;/, 'the sweep interval is named once');
  assert.match(body, /\}, TELEGRAM_SWEEP_INTERVAL_MS\);/, 'and the timer reads it, so the guard threshold and the schedule cannot disagree');
  assert.equal(/setInterval\([\s\S]{0,400}?, 60 \* 1000\)/.test(body), false, 'no literal 60 * 1000 is left on the telegram sweep');
  assert.match(body, /telegramSweepGuard\.run\(async \(\) => \{\s*await resumeTelegramSessions/, 'the sweep chain runs inside the guard, as one unit, because the three stages are one pass');
  assert.match(body, /void telegramSweepGuard\.run\(\(\) => resumeTelegramSessions\(\{ reason: 'boot' \}\)\)/, 'and the boot pass shares the guard, which is the pair that actually overlapped');
  assert.match(body, /telegramBeatGuard\.run\(async \(\) => \{/, 'the heartbeat is guarded too, on its own faster clock');
  assert.match(body, /memorySampleLine\(reason, outcome\);/, 'and every beat writes one memory line');
  assert.ok(body.indexOf('telegramBeatGuard.run') < body.indexOf('memorySampleLine(reason, outcome)'), 'after the pass, so a skipped beat still reports - a fixed sample interval is what makes a curve readable');

  /* The slice ends at the next declaration rather than at a marker that could move above it: `lastMemorySample`
     is now declared *before* the function that reads it, and an end marker that lands earlier than the start
     produces an empty slice, which fails every assertion below it for the wrong reason. */
  const sampleStart = boot.indexOf('function memorySample()');
  const sample = boot.slice(sampleStart, boot.indexOf('async function restoreTelegramClient(', sampleStart));
  for (const field of ['heapUsedMb', 'externalMb', 'arrayBuffersMb', 'rssMb', 'telegramClients', 'keepAliveGuardedClients']) {
    assert.match(sample, new RegExp(field), `the sample carries ${field}`);
  }
  assert.match(sample, /process\.memoryUsage\(\)/, 'read once per beat, not per client');
  /* The redactor in `log` deletes by *key name*, so a field called `session` would vanish from the line and the
     person reading Render would conclude the beat stopped logging. Asserted on the keys of the object rather than
     on the whole function, because the prose beside it legitimately contains some of these words - a comment
     about an MTProto session is not a field named `session`. */
  const fields = [...sample.matchAll(/^\s{4}([A-Za-z][\w$]*):/gm)].map((match) => match[1]);
  assert.deepEqual(fields, ['heapUsedMb', 'externalMb', 'arrayBuffersMb', 'rssMb', 'telegramClients', 'telegramLogins', 'keepAliveGuardedClients', 'rebuildsInFlight'], 'the sample is these eight numbers, in order, and no more');
  const redacted = ['phoneNumber', 'token', 'apiToken', 'metaApiToken', 'session', 'password'];
  for (const field of fields) assert.equal(redacted.includes(field), false, `${field} is not a name the log line silently drops`);
});

test('a dropped client is ended, not merely disconnected, and its guard record goes with it', () => {
  const body = code(boot);
  const releases = (body.match(/telegramKeepAlive\.release\(/g) || []).length;
  /* Why `disconnect()` is not a teardown, in the library's own words (2.26.22): `telegramBaseClient.js:158-178`
     closes the senders and never touches `_destroyed`, while `client/updates.js:166` runs
     `while (!client._destroyed) { await sleep(PING_INTERVAL) ... }`. So every client this process "dropped" kept a
     9-second ping loop against a closed sender for the life of the process, timing out `PING_FAIL_ATTEMPTS` x
     `PING_TIMEOUT` on every cycle - one `Error: TIMEOUT` every 39 seconds, forever, per abandoned session. That
     loop is what the keep-alive summary was counting (1081 timeouts in 11h45m = one per 39.1 s), and it is what a
     released record went on accumulating after `release()` had already forgotten it. `destroy()` is the only call
     in the public surface that sets the flag, so "drop the client" has to mean that word. */
  const bare = (body.match(/telegramAdapter\.disconnect\(/g) || []).length;
  assert.equal(bare, 0, `no drop path may stop at disconnect() - ${bare} of them do, and each one is a permanent timer`);
  const ended = (body.match(/telegramAdapter\.destroyClient\(/g) || []).length;
  assert.ok(ended >= 15, `every discard path ends its client (${ended} of them)`);
  assert.ok(releases >= 3, `a release sits beside each of the drop paths (${releases} releases)`);
  assert.match(body, /await telegramAdapter\.destroyClient\(current\.client\)[\s\S]{0,240}telegramKeepAlive\.release\(current\.client\)/, 'the rebuild path releases the client it just ended');
  assert.match(body, /telegramKeepAlive\.release\(entry\?\.client\)[\s\S]{0,80}telegramClients\.delete\(userId\)/, 'and so does the unrecoverable path, before the map entry goes');
  /* The one branch that keeps its client must keep it *listening*: `destroy()` clears `_eventBuilders` as a side
     effect, so applying it to a reused session would trade a stack trace for a deaf workspace. */
  const from = body.indexOf('if (current?.client && !telegramAdapter.isConnected(current.client)) {');
  const to = body.indexOf('return current.client;', from);
  assert.ok(from > -1 && to > from + 80, 'the reconnect-in-place branch is really there for this pin to bound');
  assert.equal(body.slice(from, to).includes('destroyClient('), false, 'the reconnect-in-place path destroys nothing');
});
