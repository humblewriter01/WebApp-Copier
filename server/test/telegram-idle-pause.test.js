/**
 * The idle policy: who gets paused by the machine, who is exempt, and who it is forbidden to touch.
 *
 * The rule is one sentence - a Free workspace that has not been seen for thirty days stops holding a Telegram
 * socket - and a sentence like that is entirely about its exemptions. So this file is mostly the exemptions, and it
 * checks each of them twice on purpose: once in the SQL that decides which rows a pass reads at all (the term that
 * keeps 20,000 quiet accounts off the reconnect path), and once in `decideIdlePause`, the pure function that decides
 * whether to act on a row it was handed. The overlap is not redundancy for its own sake: the query is a filter and
 * the function is the enforcement, and the one that can be edited by accident tomorrow is the query.
 *
 * `resumeTelegramSessions`, the sign-in flow and the routes are in `index.js`, which a test cannot import (loading
 * it binds the port), so the parts of this feature that live there are pinned on its text and said to be pinned.
 * Everything else here runs: the real decision function, the real sweeps, against a fake pool that records.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  createTelegramPauseControl,
  decideIdlePause,
  decideIdleResume,
  PAUSE_REASON_ADMIN,
  PAUSE_REASON_IDLE,
  TELEGRAM_GATE_SYNC_LIMIT,
  TELEGRAM_IDLE_PAUSE_DAYS,
  TELEGRAM_PAUSE_CANDIDATES_SQL,
  TELEGRAM_PAUSE_SWEEP_LIMIT,
  TELEGRAM_RESUME_PAID_SQL,
} from '../services/telegram-pause.js';

const index = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
const DAY_MS = 86_400_000;
const NOW = Date.parse('2026-11-02T09:00:00.000Z');

/** A workspace the policy would pause: Free, linked, has a session, idle past the threshold, nobody special. */
const IDLE_FREE = {
  id: 'free-1',
  role: 'user',
  is_suspended: false,
  subscription_status: 'free',
  telegram_connected: true,
  telegram_paused: false,
  has_session: true,
  days_inactive: TELEGRAM_IDLE_PAUSE_DAYS + 4,
};

const daysAgo = (days) => new Date(NOW - days * DAY_MS).toISOString();

/**
 * A pool that answers the three statements the pause control writes and reads, and records the order.
 *
 * `rowsFor` is consulted by query text rather than by call number, because a pass that gains a read in the middle
 * should not silently renumber every assertion below it.
 */
function createSweepHarness({ candidates = [], paid = [], pausedIds = [], updateRowCount = 1, failWrites = false } = {}) {
  const calls = [];
  const clients = new Map();
  const ended = [];
  const restored = [];
  const auditRows = [];
  const log = [];
  const pause = createTelegramPauseControl({
    clients,
    pool: {
      query: async (sql, params) => {
        const text = String(sql).replace(/\s+/g, ' ').trim();
        calls.push({ text, params });
        if (text.startsWith('UPDATE users SET telegram_paused=TRUE')) {
          if (failWrites) throw new Error('the pool said no');
          return { rowCount: updateRowCount, rows: [] };
        }
        if (text.startsWith('UPDATE users SET telegram_paused=FALSE')) return { rowCount: 1, rows: [] };
        if (text.includes('EXTRACT(EPOCH')) return { rows: candidates };
        if (text.includes('telegram_pause_reason=') && text.startsWith('SELECT')) return { rows: paid };
        if (text.startsWith('SELECT id FROM users WHERE telegram_paused=TRUE')) return { rows: pausedIds };
        return { rows: [] };
      },
    },
    log: (level, message, meta) => log.push([level, message, meta]),
    endClient: async (client) => { ended.push(client.id); client.connected = false; },
    releaseClient: () => {},
    forget: (userId) => { clients.delete(userId); return true; },
    isLive: (client) => client?.connected === true,
    restoreClient: async (userId) => { restored.push(userId); return { connected: true }; },
    audit: { record: async (entry) => { auditRows.push(entry); return entry; } },
    now: () => NOW,
  });
  const updates = () => calls.filter((call) => call.text.startsWith('UPDATE'));
  const selects = () => calls.filter((call) => call.text.startsWith('SELECT'));
  return { pause, calls, updates, selects, ended, restored, auditRows, log, clients };
}

/**
 * ---------------------------------------------------------------------------------------------
 * 1. The decision, one exemption at a time.
 * ---------------------------------------------------------------------------------------------
 */
test('a Free workspace idle past the threshold is paused, and the reason says it was the machine', () => {
  const decision = decideIdlePause(IDLE_FREE, { now: () => NOW });
  assert.deepEqual(decision, { action: 'pause', reason: PAUSE_REASON_IDLE, daysInactive: TELEGRAM_IDLE_PAUSE_DAYS + 4 });
  assert.equal(decision.reason, 'idle-free-plan', 'the value the user\'s own dashboard reads to choose its sentence');
});

test('every exemption is honoured, and each is named, so a declined pause can be explained', () => {
  const cases = [
    [{ telegram_paused: true }, 'already-paused', 'a pass that re-paused a paused workspace would rewrite the audit trail every minute'],
    [{ role: 'admin' }, 'admin', 'an operator testing the app must not lose their own session to the clock'],
    [{ is_suspended: true }, 'suspended', 'a workspace that has already lost access has nothing left to stop'],
    [{ subscription_status: 'active' }, 'paid', 'the plan is what this policy is about - a paying workspace is never paused for idling'],
    [{ subscription_status: 'non_renewing' }, 'paid', 'cancelling but paid until the period ends is still paid until the period ends'],
    [{ subscription_status: 'trialing' }, 'pause', 'only the two statuses the billing service writes hold a workspace exempt, and a status it never writes is not secretly paid'],
    [{ telegram_connected: false }, 'not-linked', 'there is no session to pause, and pausing the flag of an unlinked workspace is how a later resume invents a socket'],
    [{ has_session: false }, 'no-session', 'linked without a stored session string is a row the sweep cannot rebuild anyway'],
    [{ days_inactive: TELEGRAM_IDLE_PAUSE_DAYS - 1 }, 'under-threshold', 'one day short is one day short'],
    [{ days_inactive: null }, 'under-threshold', 'an unreadable clock is never treated as infinite age'],
  ];
  for (const [patch, expected, why] of cases) {
    const row = { ...IDLE_FREE, ...patch };
    const decision = decideIdlePause(row, { now: () => NOW });
    if (expected === 'pause') { assert.equal(decision.action, 'pause', why); continue; }
    assert.deepEqual(decision, { action: 'skip', reason: expected }, why);
  }
});

test('the threshold is thirty days, measured in whole days, and the boundary is inclusive', () => {
  assert.equal(TELEGRAM_IDLE_PAUSE_DAYS, 30, 'the number the task sets, named in one place');
  assert.equal(decideIdlePause({ ...IDLE_FREE, days_inactive: 29.9 }, { now: () => NOW }).reason, 'under-threshold', '29.9 days is not 30');
  assert.equal(decideIdlePause({ ...IDLE_FREE, days_inactive: 30 }, { now: () => NOW }).action, 'pause', '30 is');
  assert.equal(decideIdlePause({ ...IDLE_FREE, days_inactive: 30.05 }, { now: () => NOW }).action, 'pause');
  assert.equal(decideIdlePause(IDLE_FREE, { idleDays: 7, now: () => NOW }).action, 'pause', 'and the threshold is injectable, which is the only way a policy like this stays testable');
});

test('an expired Pro row is still pausable, because the plan name is not the fact', () => {
  /* `subscription_plan='free'` would be the tempting predicate and it would be wrong: an account that paid last
     year keeps the name `pro` on its row for ever after the period lapses, and the point of the policy is who is
     *paying now*, which is the question `plan-limits.js` already answers for every other limit in the app. */
  const expired = { ...IDLE_FREE, subscription_status: 'expired' };
  assert.equal(decideIdlePause(expired, { now: () => NOW }).action, 'pause');
  assert.ok(TELEGRAM_PAUSE_CANDIDATES_SQL.includes("u.subscription_status NOT IN ('active','non_renewing')"), 'and the query asks the same question the code does');
});

test('only an idle pause is undone by a plan change - a human decision is not', () => {
  assert.deepEqual(decideIdleResume({ telegram_paused: true, telegram_pause_reason: PAUSE_REASON_IDLE, subscription_status: 'active' }), { action: 'resume', reason: 'plan-upgrade' }, 'upgrading out of the penalty box is the whole point of calling it a penalty box');
  assert.equal(decideIdleResume({ telegram_paused: true, telegram_pause_reason: PAUSE_REASON_IDLE, subscription_status: 'non_renewing' }).action, 'resume', 'a renewal that is off but paid is still a paid customer');
  assert.deepEqual(decideIdleResume({ telegram_paused: true, telegram_pause_reason: PAUSE_REASON_ADMIN, subscription_status: 'active' }), { action: 'skip', reason: 'not-an-idle-pause' }, 'paying does not unpause a session support stopped on purpose, and the two would otherwise be indistinguishable in the row');
  assert.deepEqual(decideIdleResume({ telegram_paused: true, telegram_pause_reason: null, subscription_status: 'active' }), { action: 'skip', reason: 'not-an-idle-pause' }, 'a pause with no cause recorded is not assumed to have been the free-plan one');
  assert.deepEqual(decideIdleResume({ telegram_paused: false, subscription_status: 'active' }), { action: 'skip', reason: 'not-paused' });
  assert.deepEqual(decideIdleResume({ telegram_paused: true, telegram_pause_reason: PAUSE_REASON_IDLE, subscription_status: 'free' }), { action: 'skip', reason: 'not-paid' }, 'and a Free account staying idle does not earn itself back by waiting');
});

test('signing in is not a resume: nothing in the login path lifts the flag', () => {
  /* The rule with the most ways to be broken by accident. A trader whose session was paused for idling comes back,
     signs in, and finds capture running again would make the policy a suggestion - and the sign-in path is the one
     that already writes `telegram_connected`, so the wrong edit is one column away. */
  const resume = decideIdleResume({ telegram_paused: true, telegram_pause_reason: PAUSE_REASON_IDLE, subscription_status: 'free' });
  assert.equal(resume.action, 'skip', 'a returning Free user is exempt from nothing: the plan is what resumes them');
  const loginWrites = index.slice(index.indexOf("UPDATE users SET telegram_connected=TRUE"), index.indexOf("UPDATE users SET telegram_connected=TRUE") + 200);
  assert.equal(loginWrites.includes('telegram_paused=FALSE'), false, 'the reconnect write does not clear the pause beside it');
  assert.equal((index.match(/telegram_paused=FALSE/g) || []).length, 1, 'and in the whole of index.js the value appears exactly once: the sweep\'s own filter, not a write');
  assert.equal(index.includes('SET telegram_paused'), false, 'the flag is written by the pause control and by nothing else in this file');
});

/**
 * ---------------------------------------------------------------------------------------------
 * 2. The queries, pinned as text - they are what a 20,000-row fleet is actually filtered by.
 * ---------------------------------------------------------------------------------------------
 */
test('the candidate query is the policy, in SQL, with the exemptions in the WHERE clause', () => {
  const sql = TELEGRAM_PAUSE_CANDIDATES_SQL.replace(/\s+/g, ' ');
  for (const term of [
    'WHERE u.telegram_paused=FALSE',
    'AND u.telegram_connected=TRUE',
    'AND u.telegram_session IS NOT NULL',
    "AND u.role<>'admin'",
    'AND u.is_suspended=FALSE',
    "AND u.subscription_status NOT IN ('active','non_renewing')",
  ]) {
    assert.ok(sql.includes(term), `the filter carries ${term} - a pass that read the whole fleet and decided per row would rebuild and discard thousands of sessions to arrive at the same answer`);
  }
  assert.ok(sql.includes("COALESCE(u.last_active_at,u.last_login,u.created_at) < NOW() - ($1::text || ' days')::interval"), 'the inactivity clock is the same COALESCE the account-cleanup policy uses, so an account predating last_active_at is measured rather than excused');
  assert.ok(sql.includes('ORDER BY COALESCE(u.last_active_at,u.last_login,u.created_at) ASC'), 'oldest first, so the limit spends the pass on the workspaces furthest past the line');
  assert.ok(sql.includes('LIMIT $2'), 'and the limit is a parameter, not a literal, so the constant in the service is the only number');
  assert.equal(sql.includes('DELETE'), false, 'the policy writes a flag and nothing else');
  assert.equal(sql.includes('telegram_session=NULL'), false, 'and it never reaches for the session string');
});

test('the paid-resume query is bounded by the pause reason, which is the term that keeps an admin pause alive', () => {
  const sql = TELEGRAM_RESUME_PAID_SQL.replace(/\s+/g, ' ');
  assert.ok(sql.includes('WHERE u.telegram_paused=TRUE'), 'it reads the paused set, not the fleet');
  assert.ok(sql.includes('AND u.telegram_pause_reason=$2'), 'and it filters on the cause in SQL, so a manual pause never reaches the code that would undo it');
  assert.ok(sql.includes("AND u.subscription_status IN ('active','non_renewing')"), 'the same two statuses the decision uses, not a looser "plan is not free"');
  assert.ok(sql.includes('ORDER BY u.telegram_paused_at ASC NULLS LAST'), 'the longest-paused paying workspace is resumed first');
  assert.ok(sql.includes('LIMIT $1'), 'with the same per-pass bound');
});

/**
 * ---------------------------------------------------------------------------------------------
 * 3. The sweeps, run.
 * ---------------------------------------------------------------------------------------------
 */
test('one pass pauses the idle workspaces it was given, through the same function a button calls', async () => {
  const h = createSweepHarness({ candidates: [{ ...IDLE_FREE, id: 'free-1' }, { ...IDLE_FREE, id: 'free-2', subscription_status: 'active' }] });
  const summary = await h.pause.sweepIdlePauses({ reason: 'sweep' });
  assert.deepEqual(summary, { reason: 'sweep', scanned: 2, paused: 1, skipped: 1, failed: 0 }, 'the row the query returned is a suggestion: the paid one is declined here, a second time');

  const write = h.updates()[0].text;
  const manual = await (async () => { const h2 = createSweepHarness(); await h2.pause.pauseTelegramSession('free-9', { reason: PAUSE_REASON_ADMIN }); return h2.updates()[0].text; })();
  assert.equal(write, manual, 'the automatic pause and the button run the identical statement - there is no second implementation of "pause" for the policy to drift away from');
  assert.ok(write.includes('telegram_paused=TRUE'), 'the flag');
  assert.ok(write.includes('COALESCE(telegram_paused_at, NOW())'), 'the time, kept from the first pause');
  assert.ok(!write.includes('telegram_connected=FALSE'), 'and not the link');

  assert.equal(h.auditRows.length, 1, 'an automatic pause is audited');
  assert.equal(h.auditRows[0].actorId, null, 'against nobody, which is what makes the row readable as a policy decision rather than a person');
  assert.equal(h.auditRows[0].metadata.reason, PAUSE_REASON_IDLE);
});

test('the pass is bounded, and the bound is the same number for both directions', async () => {
  const h = createSweepHarness({ candidates: Array.from({ length: 3 }, (_, i) => ({ ...IDLE_FREE, id: `free-${i}` })) });
  await h.pause.sweepIdlePauses({ reason: 'sweep' });
  const select = h.selects()[0];
  assert.deepEqual(select.params, [String(TELEGRAM_IDLE_PAUSE_DAYS), TELEGRAM_PAUSE_SWEEP_LIMIT], 'days and limit, both as parameters');
  assert.equal(TELEGRAM_PAUSE_SWEEP_LIMIT, 25, 'a pass that paused the whole fleet at once would be a pass that ended every socket in one tick');
  assert.equal(TELEGRAM_GATE_SYNC_LIMIT, 500, 'while the gate read is wider, because a refusal is cheap and a rebuild is not');
  assert.equal(h.calls.filter((call) => call.text.startsWith('UPDATE')).length, 3, 'three idle rows is three pauses, inside the bound');
});

test('a pause that the database refuses is reported and the pass carries on', async () => {
  const h = createSweepHarness({ candidates: [{ ...IDLE_FREE, id: 'a' }, { ...IDLE_FREE, id: 'b' }], failWrites: true });
  const summary = await h.pause.sweepIdlePauses({ reason: 'sweep' });
  assert.deepEqual(summary, { reason: 'sweep', scanned: 2, paused: 0, skipped: 0, failed: 2 }, 'two failures, zero pauses, and no exception escaping a minute clock');
  assert.equal(h.log.some(([level, message]) => level === 'warn' && message === 'Telegram inactivity pause failed'), true, 'each one logged with its workspace');
  assert.equal(h.pause.size(), 0, 'and the gate is left alone - a workspace the database would not accept as paused is not refused here either');

  const gone = createSweepHarness({ candidates: [{ ...IDLE_FREE, id: 'deleted' }], updateRowCount: 0 });
  const second = await gone.pause.sweepIdlePauses({ reason: 'sweep' });
  assert.deepEqual({ scanned: second.scanned, paused: second.paused, failed: second.failed }, { scanned: 1, paused: 0, failed: 1 }, 'a row that stopped existing between the read and the write is the same shape of failure, and it is counted rather than believed');
});

test('a sweep whose query fails returns a code instead of throwing into the timer', async () => {
  const pause = createTelegramPauseControl({
    clients: new Map(),
    pool: { query: async () => { throw new Error('connection terminated'); } },
    endClient: async () => {}, releaseClient: () => {}, forget: () => true,
  });
  const summary = await pause.sweepIdlePauses({ reason: 'sweep' });
  assert.equal(summary.failed, 1);
  assert.equal(summary.code, 'TELEGRAM_PAUSE_SWEEP_FAILED', 'a database that is down is a fact to report, not a reason for the 60-second pass to reject unhandled');
  const resumed = await pause.resumePaidPauses({ reason: 'sweep' });
  assert.equal(resumed.code, 'TELEGRAM_RESUME_SWEEP_FAILED', 'and the other direction is guarded the same way');
});

test('the second pass over the same idle fleet pauses nobody twice', async () => {
  const row = { ...IDLE_FREE, id: 'free-1' };
  const first = await createSweepHarness({ candidates: [row] }).pause.sweepIdlePauses({ reason: 'sweep' });
  assert.equal(first.paused, 1);
  /* The next pass reads the row again, and the row now says paused - which is the only reason the second pass is
     free. A policy whose candidate list did not shrink as it acted would pause the same workspace every minute of
     its life, each time writing a fresh audit row for a state that had not changed. */
  const second = decideIdlePause({ ...row, telegram_paused: true, telegram_pause_reason: PAUSE_REASON_IDLE }, { now: () => NOW });
  assert.deepEqual(second, { action: 'skip', reason: 'already-paused' });
});

test('a paid workspace is put back by the same pass, and the resume goes through the shared path', async () => {
  const h = createSweepHarness({ paid: [{ id: 'free-1', subscription_status: 'active', telegram_paused: true, telegram_pause_reason: PAUSE_REASON_IDLE }] });
  const summary = await h.pause.resumePaidPauses({ reason: 'sweep' });
  assert.deepEqual(summary, { reason: 'sweep', scanned: 1, resumed: 1, skipped: 0, failed: 0 });
  const write = h.updates()[0].text;
  assert.ok(write.includes('SET telegram_paused=FALSE,telegram_paused_at=NULL,telegram_pause_reason=NULL'), 'the flag, its time and its cause, all three, in one statement');
  assert.ok(write.includes('WHERE id='), 'scoped to the workspace');
  assert.ok(!write.includes('telegram_connected=FALSE'), 'and the link is left alone on the way back too');
  assert.deepEqual(h.restored, ['free-1'], 'a resume reconnects through the same restore every other reviver uses');
  assert.equal(h.auditRows[0].action, 'telegram.sessionResumed');
  assert.equal(h.auditRows[0].actorId, null, 'the sweep resumed it, and the row says so');
  assert.equal(h.auditRows[0].metadata.reason, 'plan-upgrade');
});

test('a paid resume whose reconnect fails still lifts the flag, and says so', async () => {
  /* The half that matters is the one that is already committed: the workspace has paid, the pause is over, and a
     Telegram handshake that went wrong is the sweep's business from here - the minute clock will bring the socket
     up. Rolling the flag back instead would put a paying customer back in the penalty box because of a network. */
  const log = [];
  let attempts = 0;
  const pause = createTelegramPauseControl({
    clients: new Map(),
    pool: {
      query: async (sql) => (String(sql).trim().startsWith('SELECT')
        ? { rows: [{ id: 'free-1', subscription_status: 'active', telegram_paused: true, telegram_pause_reason: PAUSE_REASON_IDLE }] }
        : { rowCount: 1, rows: [] }),
    },
    log: (level, message, meta) => log.push([level, message, meta]),
    endClient: async () => {},
    releaseClient: () => {},
    forget: () => true,
    // The handshake fails once and succeeds the next time, which is the whole reason the flag is committed before
    // the socket is attempted: a transient Telegram failure must not become a permanent pause.
    restoreClient: async () => { attempts += 1; if (attempts === 1) throw new Error('Telegram said the auth key is unregistered'); return { connected: true }; },
  });
  const summary = await pause.resumePaidPauses({ reason: 'sweep' });
  assert.equal(summary.resumed, 0, 'the pass does not claim a resume it could not finish: the workspace has no socket, and a count that said otherwise would be the number an operator believes');
  assert.equal(summary.failed, 1, 'it is counted as a failure, which is the only way this pass says "look at this one"');
  assert.equal(pause.isPaused('free-1'), false, 'but the flag stays lifted, and the gate with it - the penalty box is open, because a handshake going wrong is not a reason to keep a paying workspace paused');
  assert.equal(log.filter(([, message]) => message === 'Telegram session resumed').length, 1, 'the lift is logged as happening, separately from the socket that did not');
  assert.equal(log.some(([level, message]) => level === 'warn' && message === 'Telegram session unpaused but could not be reconnected'), true, 'and the failure is a warning with the workspace on it, not a swallowed throw');

  const next = await pause.resumePaidPauses({ reason: 'sweep' });
  assert.deepEqual({ scanned: next.scanned, resumed: next.resumed, failed: next.failed }, { scanned: 1, resumed: 1, failed: 0 }, 'the next pass reads the row again - the paid-resume query selects on the flag, not on this process memory - and finishes what the handshake interrupted');
  assert.equal(attempts, 2, 'two attempts, one per pass: the retry is the minute clock, not a queue this file keeps');
});

test('reconcile refreshes the gate before it acts, so a pause written elsewhere is honoured first', async () => {
  const h = createSweepHarness({ pausedIds: [{ id: 'other-process' }] });
  const summary = await h.pause.reconcile({ reason: 'sweep' });
  const order = h.calls.map((call) => call.text.split(' ').slice(0, 2).join(' '));
  assert.ok(order[0].startsWith('SELECT id'), 'the gate read is the first statement of the pass');
  assert.equal(summary.gate, 1, 'and its size is in the summary, because "the sweep ran" without "and what it saw" is not an answer');
  assert.deepEqual({ paused: summary.paused, resumed: summary.resumed, failed: summary.failed }, { paused: 0, resumed: 0, failed: 0 }, 'nothing to do on a fleet with no idle rows');
  assert.equal(h.pause.isPaused('other-process'), true, 'the workspace paused by someone else is refused here now, before anything could be rebuilt for it');
});

test('the flag survives a restart, because the database is the truth and the Set is only a refusal', async () => {
  const first = createSweepHarness({ candidates: [{ ...IDLE_FREE, id: 'free-1' }], pausedIds: [{ id: 'free-1' }] });
  await first.pause.sweepIdlePauses({ reason: 'sweep' });
  assert.equal(first.pause.isPaused('free-1'), true);

  // A new process: empty map, empty gate, and one row that says paused.
  const rebooted = createSweepHarness({ pausedIds: [{ id: 'free-1' }] });
  assert.equal(rebooted.pause.isPaused('free-1'), false, 'nothing is known yet');
  await rebooted.pause.syncGate({ reason: 'boot' });
  assert.equal(rebooted.pause.isPaused('free-1'), true, 'one read later it is, and the sweep that follows will not rebuild it');
});
