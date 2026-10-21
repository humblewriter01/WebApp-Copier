import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  createPlatformControls,
  KILL_SWITCH_SETTING_KEY,
  normalizeKillSwitchInput,
  readKillSwitchValue,
} from '../services/platform-controls.js';
import {
  buildHealthChecks,
  createSystemHealthService,
  normalizeHealthQuery,
  RECENT_ERROR_COUNTS_SELECT,
  RECENT_ERRORS_SELECT,
} from '../services/system-health.js';

function settingsPool({ row, error = null } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (error) throw error;
      if (sql.includes('INSERT INTO admin_settings')) return { rows: [{ settingKey: KILL_SWITCH_SETTING_KEY, updatedAt: '2026-03-04T05:00:00.000Z' }], rowCount: 1 };
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    },
  };
}

test('an absent switch means live, and only an explicit false means live', () => {
  assert.deepEqual(readKillSwitchValue(undefined), { state: 'live', paused: false, reason: null, updatedAt: null, updatedByEmail: null, stored: false });
  assert.equal(readKillSwitchValue({ settingValue: { paused: false } }).state, 'live');
  const paused = readKillSwitchValue({ settingValue: { paused: true, reason: 'Database maintenance' }, updatedAt: 'x', updatedByEmail: 'admin@example.com' });
  assert.equal(paused.state, 'paused');
  assert.equal(paused.reason, 'Database maintenance');
  assert.equal(paused.updatedByEmail, 'admin@example.com');
});

test('anything that is not a definite answer is treated as paused', () => {
  for (const value of [{}, { paused: 'false' }, null, 'not json', 7]) {
    const state = readKillSwitchValue({ settingValue: value });
    assert.equal(state.state, 'unavailable', JSON.stringify(value));
    assert.equal(state.paused, true, 'fail closed: no trade goes out on a switch nobody can read');
    assert.match(state.reason, /could not be read/);
  }
});

test('the engine question is answered from the database every time', async () => {
  const pool = settingsPool({ row: { settingValue: { paused: true, reason: 'Broker incident' } } });
  const controls = createPlatformControls({ pool });
  assert.equal(await controls.isPaused(), true);
  assert.equal(await controls.isPaused(), true);
  assert.equal(pool.calls.length, 2, 'never cached, so releasing the switch is felt on the next job');
  assert.match(pool.calls[0].sql, /FROM admin_settings a LEFT JOIN users u/);
  assert.deepEqual(pool.calls[0].params, [KILL_SWITCH_SETTING_KEY]);
});

test('a database that cannot be read pauses execution instead of trusting the absence of an answer', async () => {
  const logged = [];
  const controls = createPlatformControls({
    pool: { async query() { throw Object.assign(new Error('connection reset'), { code: '08006' }); } },
    logger: { error: (message, extra) => logged.push({ message, extra }) },
  });
  const snapshot = await controls.read();
  assert.equal(snapshot.state, 'unavailable');
  assert.equal(await controls.isPaused(), true);
  assert.equal(logged[0].message, 'Platform kill switch could not be read; automatic execution stays blocked');
  assert.equal(logged[0].extra.code, '08006');
});

test('engaging the switch stores the reason and the admin behind it, then reads back the new state', async () => {
  const pool = settingsPool({ row: { settingValue: { paused: true, reason: 'MetaAPI incident MT5-2291' } } });
  const logged = [];
  const controls = createPlatformControls({ pool, logger: { warn: (message, extra) => logged.push({ message, extra }), info: () => {} } });
  const result = await controls.setPaused({ paused: true, reason: 'MetaAPI incident MT5-2291', actorId: 'admin-1' });
  assert.equal(result.state, 'paused');
  assert.equal(result.paused, true);
  assert.equal(result.writtenAt, '2026-03-04T05:00:00.000Z');
  const insert = pool.calls.find(({ sql }) => sql.includes('INSERT INTO admin_settings'));
  assert.match(insert.sql, /ON CONFLICT\(setting_key\) DO UPDATE SET/);
  assert.equal(insert.params[0], KILL_SWITCH_SETTING_KEY);
  const written = JSON.parse(insert.params[1]);
  assert.equal(written.paused, true);
  assert.equal(written.reason, 'MetaAPI incident MT5-2291');
  assert.ok(typeof written.changedAt === 'string', 'the write carries its own timestamp');
  assert.equal(insert.params[2], 'Platform-wide switch that stops new automatic orders for every workspace.');
  assert.equal(insert.params[3], 'admin-1');
  assert.equal(logged[0].message, 'Platform auto-trading kill switch engaged');
});

test('the switch payload is validated, and pausing without a reason is refused', () => {
  assert.deepEqual(normalizeKillSwitchInput({ paused: false }), { paused: false, reason: null });
  assert.deepEqual(normalizeKillSwitchInput({ enabled: false, reason: 'Incident 2291' }), { paused: true, reason: 'Incident 2291' });
  // Turning the switch on is a platform-wide pause, so the reason is required whichever
  // spelling the caller used.
  assert.throws(() => normalizeKillSwitchInput({ enabled: false }), /short reason for the pause/);
  assert.equal(normalizeKillSwitchInput({ paused: 'true', reason: '  Rolling   restart  ' }).reason, 'Rolling restart');
  assert.equal(normalizeKillSwitchInput({ paused: true, reason: 'x'.repeat(400) }).reason.length, 300);
  assert.throws(() => normalizeKillSwitchInput({ paused: true }), /short reason for the pause/);
  assert.throws(() => normalizeKillSwitchInput({ paused: true, reason: 'no' }), /short reason for the pause/);
  assert.throws(() => normalizeKillSwitchInput({ enabled: 'maybe' }), /Say whether automatic execution should be paused/);
  assert.throws(() => normalizeKillSwitchInput({}), /Say whether automatic execution should be paused/);
});

/* ------------------------------ health read model ------------------------------ */

function healthPool({ errors = null, counts = null, execution = null, killSwitch = null } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes('FROM admin_settings')) return { rows: killSwitch ? [killSwitch] : [] };
      if (sql.includes('FROM recent ORDER BY')) {
        if (errors instanceof Error) throw errors;
        return { rows: errors || [] };
      }
      if (sql.includes('FROM recent GROUP BY')) {
        if (counts instanceof Error) throw counts;
        return { rows: counts || [] };
      }
      if (sql.includes('queued_jobs')) {
        if (execution instanceof Error) throw execution;
        return { rows: execution ? [execution] : [] };
      }
      return { rows: [] };
    },
  };
}

test('the health window is one parameter, bounded, and shared by the list and the counts', () => {
  assert.deepEqual(normalizeHealthQuery({}), { hours: 24, limit: 20 });
  assert.deepEqual(normalizeHealthQuery({ hours: '3', limit: '5' }), { hours: 3, limit: 5 });
  assert.deepEqual(normalizeHealthQuery({ hours: 0 }), { hours: 24, limit: 20 });
  assert.deepEqual(normalizeHealthQuery({ hours: 100_000 }), { hours: 24, limit: 20 });
  assert.equal(normalizeHealthQuery({ limit: 5000 }).limit, 200, 'a huge limit is clamped, never rejected');
  for (const sql of [RECENT_ERRORS_SELECT, RECENT_ERROR_COUNTS_SELECT]) {
    // four branches, one shared parameter, so the list and the counts cannot describe
    // different periods
    assert.equal(sql.match(/NOW\(\) - \(\$1::int \* INTERVAL '1 hour'\)/g).length, 4);
  }
});

test('the error feed reads the records the platform already wrote and never shows routine skips', () => {
  assert.match(RECENT_ERRORS_SELECT, /t\.status IN \('unknown','rejected'\) AND t\.error_message IS NOT NULL/);
  assert.match(RECENT_ERRORS_SELECT, /ej\.status IN \('failed','unknown'\)/);
  assert.doesNotMatch(RECENT_ERRORS_SELECT, /ej\.status = 'skipped'/);
  assert.match(RECENT_ERRORS_SELECT, /AND NOT EXISTS \(SELECT 1 FROM trades te WHERE te\.execution_job_id=ej\.id AND te\.error_message IS NOT NULL\)/, 'a job whose trade already carries the failure is not listed twice');
  assert.match(RECENT_ERRORS_SELECT, /m\.status IN \('failed','unknown'\)/);
  assert.match(RECENT_ERRORS_SELECT, /s\.parse_error IS NOT NULL/);
  assert.match(RECENT_ERRORS_SELECT, /FROM signals s JOIN users u ON u\.id=s\.user_id/, 'workspace identity is joined so the admin sees who was affected');
  assert.match(RECENT_ERRORS_SELECT, /ORDER BY occurred_at DESC LIMIT \$2/);
  assert.match(RECENT_ERROR_COUNTS_SELECT, /COUNT\(DISTINCT user_id\)::int AS "affectedUsers"/);
});

test('the recent-error queries are complete statements, not a bare CTE body', () => {
  // A string that starts `recent AS (` is a syntax error on the server, and because each health
  // section catches its own read failure, the symptom would have been a permanently unreadable
  // errors panel rather than a crash. Both forms were run against a live PostgreSQL to be sure.
  for (const sql of [RECENT_ERRORS_SELECT, RECENT_ERROR_COUNTS_SELECT]) {
    assert.match(sql, /^WITH recent AS \(/, 'the WITH has to be on the statement that is executed');
    assert.equal(/^\s*(WITH|SELECT|INSERT|UPDATE|DELETE)\b/.test(sql), true, 'a query handed to the pool must be a whole statement');
  }
});

test('no service in this feature hands the pool a fragment instead of a statement', () => {
  const services = ['system-health.js', 'audit.js', 'announcements.js', 'support-sessions.js', 'platform-controls.js'];
  for (const name of services) {
    const source = readFileSync(new URL(`../services/${name}`, import.meta.url), 'utf8');
    const queries = [...source.matchAll(/pool\.query\(\s*(`(?:[^`\\]|\\.)*`|[A-Z_][A-Z0-9_]*)/g)].map((match) => match[1]);
    assert.ok(queries.length, `${name} was expected to run at least one query`);
    for (const raw of queries) {
      let body = raw.startsWith('`') ? raw.slice(1, -1) : null;
      if (body === null) {
        const definition = source.match(new RegExp(`(?:const|export const) ${raw} = \`([\\s\\S]*?)\`;`, 'm'));
        assert.ok(definition, `${name}.${raw} is executed as a query but is not a template literal in this file`);
        body = definition[1];
      }
      const statement = body.replace(/\$\{[^}]*\}/g, 'x');
      assert.match(statement, /^\s*(WITH|SELECT|INSERT|UPDATE|DELETE)\b/, `${name}: ${raw} is not a complete statement`);
    }
  }
});

test('a health snapshot composes the switch, the queue, the counts, and the newest failures', async () => {
  const pool = healthPool({
    killSwitch: { settingValue: { paused: false }, updatedAt: '2026-03-01T00:00:00.000Z', updatedByEmail: 'ops@example.com' },
    errors: [
      { kind: 'metaapi_execution', occurredAt: new Date('2026-03-04T04:00:00.000Z'), status: 'rejected', message: 'TRADE_RETCODE_INVALID_STOPS', symbol: 'EURUSD', side: 'buy', accountId: 'acc-1', userId: 'user-1', email: 'trader@example.com', name: 'Trader' },
      { kind: 'telegram_parse', occurredAt: new Date('2026-03-04T03:00:00.000Z'), status: 'received', message: 'No stop loss found in the message.', symbol: null, side: null, accountId: null, userId: 'user-2', email: 'other@example.com', name: 'Other' },
    ],
    counts: [
      { kind: 'metaapi_execution', count: 3, affectedUsers: 2, lastSeen: new Date('2026-03-04T04:00:00.000Z') },
      { kind: 'telegram_parse', count: 12, affectedUsers: 5, lastSeen: new Date('2026-03-04T03:30:00.000Z') },
    ],
    execution: { queued_jobs: 2, processing_jobs: 1, overdue_jobs: 0, dead_jobs: 1, oldest_queued_seconds: 4, last_claim_at: new Date('2026-03-04T04:30:00.000Z'), executed_trades: 9, auto_trading_workspaces: 30, active_users: 100 },
  });
  const controls = createPlatformControls({ pool });
  const health = createSystemHealthService({ pool, controls, runtimeEnabled: true, now: () => new Date('2026-03-04T05:00:00.000Z') });
  const snapshot = await health.snapshot({ hours: 6, limit: 2 });

  assert.equal(snapshot.generatedAt, '2026-03-04T05:00:00.000Z');
  assert.equal(snapshot.windowHours, 6);
  assert.deepEqual(snapshot.killSwitch, { state: 'live', paused: false, reason: null, updatedAt: '2026-03-01T00:00:00.000Z', updatedByEmail: 'ops@example.com' });
  assert.equal(snapshot.runtimeEnabled, true);
  assert.equal(snapshot.errorsAvailable, true);
  assert.equal(snapshot.errors.length, 2);
  assert.equal(snapshot.errors[0].kindLabel, 'MetaAPI order errors');
  assert.equal(snapshot.errors[0].occurredAt, '2026-03-04T04:00:00.000Z');
  assert.equal(snapshot.errorsTruncated, true, 'the page is full, so the panel must not claim it is everything');
  assert.deepEqual(snapshot.counts.metaapi_execution, { count: 3, affectedUsers: 2, lastSeen: '2026-03-04T04:00:00.000Z' });
  assert.deepEqual(snapshot.queue, {
    queuedJobs: 2, processingJobs: 1, overdueJobs: 0, deadJobs: 1, oldestQueuedSeconds: 4,
    lastClaimAt: '2026-03-04T04:30:00.000Z', executedTrades: 9, autoTradingWorkspaces: 30, activeUsers: 100,
  });
  assert.deepEqual(snapshot.checks.map((check) => [check.key, check.state]), [
    ['kill_switch', 'ok'], ['runtime', 'ok'], ['queue', 'ok'], ['metaapi_execution', 'watch'], ['metaapi_stop_move', 'ok'], ['telegram_parse', 'watch'],
  ]);
  const telegram = snapshot.checks.find((check) => check.key === 'telegram_parse');
  assert.equal(telegram.headline, '12 in the last 6h');
  assert.match(telegram.detail, /Affecting 5 workspaces/);
  // every section is one read of the same window
  assert.deepEqual(pool.calls.map((call) => call.params[0]), [KILL_SWITCH_SETTING_KEY, 6, 6, 6]);
});

test('unreadable sections are reported as unknown, never as fine', async () => {
  const pool = healthPool({ errors: new Error('read failed'), counts: new Error('read failed'), execution: new Error('read failed') });
  const controls = createPlatformControls({ pool });
  const health = createSystemHealthService({ pool, controls, runtimeEnabled: false, now: () => new Date('2026-03-04T05:00:00.000Z') });
  const snapshot = await health.snapshot();
  assert.equal(snapshot.errorsAvailable, false);
  assert.deepEqual(snapshot.errors, []);
  assert.equal(snapshot.counts.available, false);
  assert.equal(snapshot.queue, null);
  assert.equal(snapshot.killSwitch.state, 'live', 'the switch row is readable here, unlike the error tables');
  const byKey = Object.fromEntries(snapshot.checks.map((check) => [check.key, check]));
  assert.equal(byKey.runtime.state, 'unavailable');
  assert.match(byKey.runtime.detail, /AUTO_TRADING_RUNTIME_ENABLED/);
  assert.equal(byKey.queue.state, 'unknown');
  assert.equal(byKey.metaapi_execution.state, 'unknown');
  assert.match(byKey.metaapi_execution.detail, /could not be read/);
});

test('queued jobs that are past their expiry are a failure the panel can explain', () => {
  const checks = buildHealthChecks({
    killSwitch: { state: 'paused', paused: true, reason: 'Broker incident', updatedByEmail: 'ops@example.com' },
    runtimeEnabled: true,
    queue: { queuedJobs: 9, processingJobs: 0, overdueJobs: 9, oldestQueuedSeconds: 600 },
    counts: { available: true, windowHours: 24, metaapi_execution: { count: 40, affectedUsers: 12, lastSeen: null }, metaapi_stop_move: { count: 0, affectedUsers: 0, lastSeen: null }, telegram_parse: { count: 0, affectedUsers: 0, lastSeen: null } },
  });
  const byKey = Object.fromEntries(checks.map((check) => [check.key, check]));
  assert.equal(byKey.kill_switch.state, 'paused');
  assert.match(byKey.kill_switch.detail, /Broker incident — set by ops@example\.com\./);
  assert.equal(byKey.queue.state, 'fail');
  assert.equal(byKey.queue.headline, 'Backed up');
  assert.match(byKey.queue.detail, /9 queued jobs already past their expiry/);
  assert.equal(byKey.metaapi_execution.state, 'fail', 'a handful of rejections is a warning; a flood is a failure');
  assert.equal(byKey.telegram_parse.state, 'ok');
  assert.match(byKey.telegram_parse.detail, /Messages captured from channels/);
});

test('a health panel with no switch wired up still refuses to claim trading is live', () => {
  const pool = healthPool({});
  const health = createSystemHealthService({ pool, runtimeEnabled: true, now: () => new Date('2026-03-04T05:00:00.000Z') });
  return health.snapshot().then((snapshot) => {
    assert.equal(snapshot.killSwitch.state, 'unavailable');
    assert.equal(snapshot.killSwitch.paused, true);
    assert.equal(snapshot.checks[0].state, 'fail');
    assert.match(snapshot.checks[0].detail, /not wired up/);
  });
});
