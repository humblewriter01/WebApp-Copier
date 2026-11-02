/**
 * What a pause actually does, and what it is forbidden to do.
 *
 * The claim under review is a narrow one and easy to say without proving: "pause the bot without logging the user
 * out". It is worth restating as the four things a test can see, because a feature like this is usually broken by
 * the fifth thing it does by accident.
 *
 *   1. the socket is *ended* - `destroyClient`, not `disconnect`, and not "we stopped pointing at it";
 *   2. the keep-alive record is released and the entry leaves the client map through the reconnect path's own
 *      identity-guarded `forget` (a real `createTelegramReconnectPolicy` is used here for exactly that reason: a
 *      fake `forget` would let this file pass while the production one refused to delete the entry);
 *   3. the database says paused, and says *nothing else* - the `SET` clause is asserted to be exactly the three
 *      pause columns, which is the whole of "the user is not signed out";
 *   4. a resume is the same reconnect everyone else uses, reached through the injected `restoreClient`.
 *
 * `index.js` cannot be imported by a test - loading it binds the port and opens the database - so the ordering that
 * lives there (flag before socket, socket before answer) is asserted here against the service that owns it, and the
 * wiring in `index.js` is pinned in `telegram-pause-exclusion.test.js`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTelegramReconnectPolicy } from '../services/telegram-reconnect.js';
import {
  createTelegramPauseControl,
  PAUSE_REASON_ADMIN,
  PAUSE_REASON_IDLE,
  PAUSE_REASONS,
  isValidPauseReason,
} from '../services/telegram-pause.js';

const USER = '7c0f5b3e-1111-42b7-9a1a-9f0d2b5b0001';
const CLIENT = 'the-live-client';

/**
 * One workspace, one map, and a pool that records every statement in the order it was asked.
 *
 * `events` is the point of the whole harness: a pause is a sequence (flag, then socket, then answer), and the only
 * way to test a sequence is to record one rather than assert four separate facts about four separate mocks.
 */
function createHarness({
  rows = [],
  updateRowCount = 1,
  failOn = () => false,
  live = true,
  installEntry = true,
  restoreClient = async () => ({ caughtUp: 3, fresh: true }),
  restoreThrows = null,
  resetBaselineThrows = false,
  endThrows = false,
  auditThrows = false,
} = {}) {
  const clients = new Map();
  const events = [];
  const queries = [];
  const endedClients = [];
  const released = [];
  const restored = [];
  const baselines = [];
  const auditRows = [];
  const log = [];
  const client = { id: CLIENT, connected: live, handler: null };
  if (installEntry) clients.set(USER, { client, handler: live ? {} : null, stats: { seen: 4, saved: 2 } });
  const policy = createTelegramReconnectPolicy({ clients, isConnected: (candidate) => candidate?.connected === true });

  const pause = createTelegramPauseControl({
    clients,
    pool: {
      query: async (sql, params) => {
        const text = String(sql).replace(/\s+/g, ' ').trim();
        const kind = /^UPDATE/i.test(text) ? 'update' : /^SELECT/i.test(text) ? 'select' : 'other';
        queries.push({ text, kind, params });
        events.push(`${kind}:${text.slice(0, 24)}`);
        if (failOn(text, kind)) throw new Error('the pool said no');
        if (kind === 'update') return { rowCount: updateRowCount, rows: [] };
        return { rows: typeof rows === 'function' ? rows(text) : rows };
      },
    },
    log: (level, message, meta) => log.push([level, message, meta]),
    endClient: async (target) => {
      endedClients.push(target.id);
      events.push('endClient');
      if (endThrows) throw new Error('the socket would not die');
      target.connected = false;
    },
    releaseClient: (target) => { released.push(target.id); events.push('release'); },
    forget: (userId, entry) => { events.push('forget'); return policy.forget(userId, entry); },
    isLive: (target) => target?.connected === true,
    resetBaseline: (userId) => { baselines.push(userId); events.push('resetBaseline'); if (resetBaselineThrows) throw new Error('no such stream record'); },
    restoreClient: async (userId, options) => {
      restored.push([userId, options]);
      events.push('restore');
      if (restoreThrows) throw restoreThrows;
      return restoreClient(userId, options);
    },
    audit: { record: async (entry) => { if (auditThrows) throw new Error('the audit insert failed'); auditRows.push(entry); return entry; } },
    now: () => Date.parse('2026-11-02T09:00:00.000Z'),
  });

  const updateStatements = () => queries.filter((query) => query.kind === 'update');
  /**
   * The columns a `SET` clause assigns, in the order it assigns them - the only shape that can prove "nothing else
   * moved". `CASE ... END` is cut out first: the guard inside this very statement reads `WHEN telegram_paused=TRUE`,
   * and a column list that counted a condition as a write would be a list that could not be trusted either way.
   */
  const setBody = (text) => text.slice(text.indexOf('SET') + 3, text.search(/\bWHERE\b/)).replace(/CASE[\s\S]*?END/g, '');
  const setColumns = (text) => [...setBody(text).matchAll(/([a-z_]+)\s*=/g)].map((match) => match[1]);

  return { pause, clients, client, events, queries, endedClients, released, restored, baselines, auditRows, log, updateStatements, setBody, setColumns, policy };
}

test('a pause ends the socket, releases its guard record, and drops the entry - and says so', async () => {
  const h = createHarness();
  const result = await h.pause.pauseTelegramSession(USER, { reason: PAUSE_REASON_ADMIN, actorId: 'admin-1', actorEmail: 'admin@example.com' });

  assert.deepEqual(Object.keys(result).sort(), ['already', 'clientEnded', 'paused', 'reason', 'wasLive'], 'the answer the route turns into a notice, and no invented extras');
  assert.deepEqual(result, { paused: true, reason: PAUSE_REASON_ADMIN, clientEnded: true, wasLive: true, already: false });
  assert.equal(result.wasLive, true, 'and it says the socket really was open, which is the difference between "stopped a capture" and "changed a flag"');
  assert.deepEqual(h.endedClients, [CLIENT], 'the client was ENDED once - `destroyClient` is the call that stops the update loop');
  assert.deepEqual(h.released, [CLIENT], 'and its keep-alive record was released, so the guard is not left pinging a client nobody owns');
  assert.equal(h.clients.has(USER), false, 'the workspace is gone from the map, which is what makes the heartbeat, the re-arm sweep and the fleet summary stop seeing it');
  assert.deepEqual(h.baselines, [USER], 'and the listener\'s stream memory for it was wiped, so a resume does not inherit an accusation');
  assert.equal(h.pause.isPaused(USER), true, 'the in-memory gate says paused');
  assert.equal(h.pause.size(), 1);
});

test('the pause is written before the socket is touched, so a failed write leaves nothing half-done', async () => {
  const h = createHarness();
  await h.pause.pauseTelegramSession(USER, { reason: PAUSE_REASON_ADMIN });
  const order = h.events.map((event) => event.split(':')[0]).filter((kind) => ['update', 'endClient', 'release', 'forget', 'resetBaseline'].includes(kind));
  assert.deepEqual(order.slice(0, 2), ['update', 'endClient'], 'flag first: anything that starts from the moment of the write must already be refused');

  const failing = createHarness({ failOn: (text, kind) => kind === 'update' });
  await assert.rejects(() => failing.pause.pauseTelegramSession(USER, { reason: PAUSE_REASON_ADMIN }), /the pool said no/);
  assert.deepEqual(failing.endedClients, [], 'the write failed, so no socket was ended and no client was orphaned by a pause that did not happen');
  assert.equal(failing.clients.has(USER), true, 'the map entry is still there: a refused pause is a workspace that keeps working, not one left in between');
  assert.equal(failing.pause.isPaused(USER), false, 'and the gate was rolled back, so the refusal is the whole answer rather than a silent stop');
});

test('a pause writes the three pause columns and nothing else, which is the "not logged out" guarantee', async () => {
  const h = createHarness();
  await h.pause.pauseTelegramSession(USER, { reason: PAUSE_REASON_IDLE });
  const updates = h.updateStatements();
  assert.equal(updates.length, 1, 'one statement for one pause');
  const text = updates[0].text;
  assert.deepEqual(h.setColumns(text), ['telegram_paused', 'telegram_paused_at', 'telegram_pause_reason'], 'the SET clause is exactly the pause columns');
  /* One exact statement rather than four regexes: this line is the whole of "a pause writes the pause columns and 
     nothing else", and a pin that spelled out the sentence catches the edit that a `SET telegram_connected=FALSE` 
     would sneak into a `WHERE` clause no regex below was looking at. */
  assert.equal(text, 'UPDATE users SET telegram_paused=TRUE, telegram_paused_at=COALESCE(telegram_paused_at, NOW()), telegram_pause_reason=CASE WHEN telegram_paused=TRUE THEN telegram_pause_reason ELSE $2 END WHERE id=$1 AND telegram_connected=TRUE',
    'the flag, the time that keeps its first value, the cause that keeps its first cause, and no other column');
  const written = h.setBody(text);
  assert.equal(written.includes('telegram_connected'), false, 'telegram_connected is never written by a pause - that column is what gates the login flow, and writing it FALSE is how a "pause" signs somebody out');
  assert.equal(written.includes('telegram_session'), false, 'and the stored session string is untouched, so resuming is a reconnect and not a re-authorisation');
  assert.equal(text.includes('DELETE'), false, 'a pause deletes nothing');
  assert.deepEqual(updates[0].params, [USER, PAUSE_REASON_IDLE], 'the reason travels as a parameter, never as interpolated text');
});

test('pausing an already-paused workspace is refused a second socket rather than silently re-pausing', async () => {
  const h = createHarness();
  await h.pause.pauseTelegramSession(USER, { reason: PAUSE_REASON_ADMIN });
  const afterFirst = h.updateStatements().length;
  h.clients.set(USER, { client: { id: 'a-socket-that-should-not-exist', connected: true }, handler: {} });

  const second = await h.pause.pauseTelegramSession(USER, { reason: PAUSE_REASON_ADMIN, actorId: 'admin-2' });
  assert.equal(second.already, true, 'the answer says this was already paused, which is what the route needs to avoid claiming it just stopped something');
  assert.equal(afterFirst, 1);
  assert.equal(h.updateStatements().length, 2, 'the write is re-issued - it is cheap, idempotent, and it is how a second process converges');
  assert.deepEqual(h.endedClients, [CLIENT, 'a-socket-that-should-not-exist'], 'and an entry that is there is ended, because "already paused" must not mean "leave the stray socket running"');
  assert.equal(h.clients.has(USER), false, 'the pause leaves no live socket for a workspace it has paused, whichever order the calls arrived in');
});

test('a workspace with no linked session is a 409, not a green "paused"', async () => {
  const h = createHarness({ updateRowCount: 0 });
  await assert.rejects(
    () => h.pause.pauseTelegramSession(USER, { reason: PAUSE_REASON_ADMIN }),
    (error) => {
      assert.equal(error.telegramPauseNoSession, true, 'flagged, so the route answers with the sentence that tells the operator what is missing');
      assert.match(error.message, /no linked Telegram session to pause/);
      return true;
    },
  );
  assert.equal(h.pause.isPaused(USER), false, 'the gate was rolled back: a flag the database does not agree with would refuse a session that is still capturing');
  assert.equal(h.clients.has(USER), true, 'and the live socket was left alone, because nothing was asked of it');
  assert.deepEqual(h.endedClients, [], 'no client was ended for a pause that did not happen');
});

test('a resume lifts the flag through the same three columns, then reconnects through the one restore path', async () => {
  const h = createHarness();
  await h.pause.pauseTelegramSession(USER, { reason: PAUSE_REASON_ADMIN, actorId: 'admin-1' });
  h.clients.clear();
  const result = await h.pause.resumeTelegramSession(USER, { reason: 'admin-resume', actorId: 'admin-1', actorEmail: 'admin@example.com', reconnect: true });

  const resume = h.updateStatements().at(-1).text;
  assert.deepEqual(h.setColumns(resume), ['telegram_paused', 'telegram_paused_at', 'telegram_pause_reason'], 'the same three columns, and no others');
  assert.match(resume, /SET telegram_paused=FALSE,telegram_paused_at=NULL,telegram_pause_reason=NULL/);
  assert.match(resume, /WHERE id=\$1 AND telegram_paused=TRUE/, 'a resume only ever acts on a workspace that is paused');
  assert.equal(h.setBody(resume).includes('telegram_connected'), false, 'a resume does not "re-link" a session: the link was never the thing that changed');
  assert.equal(result.reconnected, true, 'and it reports that the restore ran');

  const [restoredId, restoredOptions] = h.restored[0];
  assert.equal(restoredId, USER);
  assert.equal(restoredOptions.force, true, 'force, because a workspace the sweep last saw as paused may still be holding the client the pause left in some other process\'s memory');
  assert.equal(restoredOptions.reason, 'admin-resume', 'and the reason survives the hop, so the log line can be read back');
  assert.equal(h.pause.isPaused(USER), false, 'the gate is opened before the reconnect, or the restore would refuse itself');
});

test('a resume whose reconnect fails reports both halves truthfully', async () => {
  const refused = new Error('A Telegram reconnect for this workspace is already running.');
  refused.telegramReconnectInFlight = true;
  const h = createHarness({ restoreThrows: refused });
  await h.pause.pauseTelegramSession(USER, { reason: PAUSE_REASON_ADMIN });
  await assert.rejects(() => h.pause.resumeTelegramSession(USER, { reason: 'admin-resume' }), (error) => {
    assert.equal(error, refused, 'the refusal is rethrown rather than wrapped, so the route can still answer 409 instead of 500');
    assert.equal(error.telegramResumeReconnectFailed, true, 'and it says the pause was already lifted when this happened');
    return true;
  });
  assert.equal(h.pause.isPaused(USER), false, 'the flag stays lifted: the pause is over, and the reconnect is the sweep\'s job from here');
  assert.equal(h.updateStatements().at(-1).text.includes('telegram_paused=FALSE'), true, 'the lift was really written, not merely attempted');
});

test('a resume that found nothing paused says so instead of pretending to have done something', async () => {
  const h = createHarness({ updateRowCount: 0 });
  const result = await h.pause.resumeTelegramSession(USER, { reason: 'admin-resume', reconnect: false });
  assert.equal(result.cleared, 0, '`WHERE ... AND telegram_paused=TRUE` matched no row');
  assert.equal(result.reconnected, false, 'and with reconnect declined the answer is exactly "nothing to do"');
  assert.deepEqual(h.restored, [], 'no restore was started for a workspace that was not paused');
});

test('an automatic pause is audited as the sweep\'s doing and a manual one as a person\'s', async () => {
  const manual = createHarness();
  await manual.pause.pauseTelegramSession(USER, { reason: PAUSE_REASON_ADMIN, actorId: 'admin-1', actorEmail: 'admin@example.com' });
  const automatic = createHarness();
  await automatic.pause.pauseTelegramSession(USER, { reason: PAUSE_REASON_IDLE });

  assert.equal(manual.auditRows.length, 1);
  assert.equal(manual.auditRows[0].action, 'telegram.sessionPaused');
  assert.equal(manual.auditRows[0].targetId, USER);
  assert.equal(manual.auditRows[0].actorId, 'admin-1', 'an operator pressed a button and the row says who');
  assert.equal(automatic.auditRows[0].actorId, null, 'the sweep pressed nothing, and an audit row that blurred the two would make a policy unreadable as a list of decisions');
  assert.equal(automatic.auditRows[0].metadata.reason, PAUSE_REASON_IDLE);
  assert.match(automatic.auditRows[0].summary, /idle-free-plan/, 'the reason is in the sentence a human reads, not only in the metadata');
});

test('an audit row that cannot be written does not fail a pause that did happen', async () => {
  const h = createHarness({ auditThrows: true });
  const result = await h.pause.pauseTelegramSession(USER, { reason: PAUSE_REASON_ADMIN });
  assert.equal(result.paused, true, 'the pause is a fact about the socket and the flag, and the audit is a record of it');
  assert.deepEqual(h.endedClients, [CLIENT]);
  assert.equal(h.log.some(([level, message]) => level === 'warn' && message === 'Telegram pause could not be audited'), true, 'but it is warned about');
});

test('a socket that refuses to die is reported and does not stop the pause', async () => {
  const h = createHarness({ endThrows: true });
  const result = await h.pause.pauseTelegramSession(USER, { reason: PAUSE_REASON_ADMIN });
  assert.equal(result.paused, true, 'the flag is already saved; a pause that stopped here would leave a workspace capturing under a "paused" row');
  assert.equal(result.clientEnded, true, 'the end was attempted once, which is all this path can promise');
  assert.equal(h.clients.has(USER), false, 'and the entry is dropped regardless, because keeping it would keep the socket in the loop that reports it healthy');
  assert.equal(h.log.some(([level, message]) => level === 'warn' && message === 'Telegram pause could not end the client cleanly'), true);
});

test('a failing stream-baseline reset is swallowed rather than turned into a failed pause', async () => {
  const h = createHarness({ resetBaselineThrows: true });
  const result = await h.pause.pauseTelegramSession(USER, { reason: PAUSE_REASON_ADMIN });
  assert.equal(result.paused, true);
  assert.deepEqual(h.baselines, [USER], 'it was still attempted, which is the only courtesy a diagnostic reset owes');
});

test('the gate is keyed by the string form of the id, because the map and the database disagree about types', async () => {
  const h = createHarness({ installEntry: false });
  h.pause.markPaused(42);
  assert.equal(h.pause.isPaused('42'), true, 'a numeric id in and a text id out is the same workspace');
  assert.equal(h.pause.isPaused(42), true);
  assert.equal(h.pause.isPaused('43'), false);
  h.pause.markResumed('42');
  assert.equal(h.pause.isPaused(42), false, 'and one form is enough to let it back in');
});

test('pausing a workspace this process is not holding is a flag write, not an error', async () => {
  const h = createHarness({ installEntry: false });
  const result = await h.pause.pauseTelegramSession(USER, { reason: PAUSE_REASON_ADMIN });
  assert.equal(result.clientEnded, false);
  assert.equal(result.wasLive, false, 'the audit row and the notice both have to say no socket was open, or a second process looks like a bug');
  assert.deepEqual(h.endedClients, []);
  assert.deepEqual(h.released, []);
});

test('the pause control refuses to be built without the teardown it exists to perform', () => {
  const deps = { clients: new Map(), pool: { query: async () => ({ rows: [] }) }, endClient: () => {}, releaseClient: () => {}, forget: () => true };
  assert.ok(createTelegramPauseControl(deps), 'the complete set is accepted');
  for (const missing of ['clients', 'pool', 'endClient', 'releaseClient', 'forget']) {
    const partial = { ...deps };
    delete partial[missing];
    assert.throws(() => createTelegramPauseControl(partial), /createTelegramPauseControl requires/, `without ${missing} a pause would only be a database write`);
  }
});

test('the two reasons are the whole vocabulary, and an unknown one is answered before it reaches a user', () => {
  assert.deepEqual([...PAUSE_REASONS], [PAUSE_REASON_ADMIN, PAUSE_REASON_IDLE]);
  assert.equal(isValidPauseReason(PAUSE_REASON_ADMIN), true);
  assert.equal(isValidPauseReason('admin-panel'), false, 'the reconnect reason is not a pause reason, and the trader\'s sentence is chosen from this value');
  assert.equal(isValidPauseReason(''), false);
  assert.equal(isValidPauseReason(undefined), false);

  const h = createHarness();
  return h.pause.pauseTelegramSession(USER, { reason: 'idle-free-plannn' }).then((result) => {
    assert.equal(result.reason, PAUSE_REASON_ADMIN, 'a caller that got past the route is coerced to the one reason that promises nothing about why');
    assert.deepEqual(h.updateStatements()[0].params[1], PAUSE_REASON_ADMIN, 'and the coercion happens before the write, so nothing invented is ever stored');
  });
});

test('stats say what the gate is holding and what it has done, for the log line and the panel', async () => {
  const h = createHarness();
  await h.pause.pauseTelegramSession(USER, { reason: PAUSE_REASON_ADMIN });
  const stats = h.pause.stats();
  assert.equal(stats.paused, 1, 'how many sessions this process is refusing, which is the number a heap curve needs beside it');
  assert.equal(stats.pauses, 1);
  assert.equal(stats.autoPaused, 0, 'one of the two was a person');
  assert.equal(stats.resumes, 0);
  assert.equal(stats.lastSweepAt, null, 'and it is null until a gate refresh has run: "never swept" and "swept a long time ago" must not look alike in a log');
});

test('the gate is rebuilt from the database, and only from the database', async () => {
  const pausedIds = [{ id: USER }, { id: 'workspace-2' }];
  // `installEntry: false` keeps this test about the mirror rather than the teardown: the enforcement half has its
  // own test below, and a socket left in the map here would be ended by the refresh, which is what it is for.
  const h = createHarness({ installEntry: false, rows: (text) => (text.includes('telegram_paused=TRUE ORDER BY') ? pausedIds : []) });
  h.pause.markPaused('a-stale-refusal');
  const gate = await h.pause.syncGate({ reason: 'boot' });
  assert.deepEqual(gate, { paused: 2, enforced: 0 }, 'the refresh reports the size and how much of it it had to enforce - a bare number cannot tell "nothing was paused" from "nothing was holding a socket"');
  assert.equal(h.pause.isPaused('a-stale-refusal'), false, 'a refusal the row does not agree with is dropped: the gate is a mirror, and a mirror that keeps an image of its own is how a pause outlives its resume');
  assert.equal(h.pause.isPaused(USER), true);
  const select = h.queries.find((query) => query.kind === 'select');
  assert.match(select.text, /SELECT id FROM users WHERE telegram_paused=TRUE ORDER BY telegram_paused_at ASC NULLS LAST LIMIT \$1/, 'one indexed read, oldest pause first, bounded');
  assert.deepEqual(select.params, [500], 'the bound is the gate\'s own constant, so a fleet with more paused workspaces than that loses refusals, not revivals');
  assert.equal(typeof h.pause.stats().lastSweepAt, 'string', 'and the refresh stamps the clock, so "never swept" is distinguishable from "swept just now"');
});

test('a pause this process did not perform still takes its socket away on the next gate refresh', async () => {
  /* The one case a Set cannot cover by itself: the flag was written somewhere else (another instance, an
     operator's UPDATE, a restored snapshot), so the workspace is paused in the database and still capturing here.
     Refreshing a gate is not stopping a session - if the refresh did not look for this, the pause would be a
     refusal of the *next* reconnect and nothing more, and the current socket would carry on copying signals under
     a row that says it is not supposed to be running. */
  const h = createHarness({ rows: (text) => (text.includes('telegram_paused=TRUE ORDER BY') ? [{ id: USER }] : []) });
  assert.equal(h.clients.has(USER), true, 'the map holds a live client for a workspace the database says is paused');
  const gate = await h.pause.syncGate({ reason: 'sweep' });
  assert.deepEqual(gate, { paused: 1, enforced: 1 }, 'and the refresh says it enforced one');
  assert.equal(h.pause.isPaused(USER), true, 'the refusal is in place before the teardown, so nothing revives it on the way out');
  assert.deepEqual(h.endedClients, [CLIENT], 'the socket was ended, not merely forgotten');
  assert.deepEqual(h.released, [CLIENT], 'with its keep-alive record');
  assert.equal(h.clients.has(USER), false);

  const again = await h.pause.syncGate({ reason: 'sweep' });
  assert.deepEqual(again, { paused: 1, enforced: 0 }, 'the next refresh finds nothing new to enforce: enforcement is for the ids the gate had not seen yet');
});
