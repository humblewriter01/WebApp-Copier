/**
 * The read that decides what a blocked row says today, driven end to end.
 *
 * `overlayLiveBlocker` was unit-tested, and its unit tests passed, while every row that reached a trader kept a
 * sentence its workspace had outgrown: the function bailed out on a field no list query selects. These tests are
 * written against the reader the routes actually call - statements issued, failures swallowed on purpose, rows
 * handed back untouched - because that is the level at which the bug lived and the level at which "the card
 * agrees with the banner" is either true or not.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createSignalOutcomeReader } from '../services/signal-outcome.js';
import {
  ACCOUNT_NOT_READY_NOTE,
  AUTO_TRADING_OFF_NOTE,
  NO_ACCOUNT_NOTE,
  PAUSED_NOTE,
  PLAN_NO_EXECUTION_NOTE,
  RUNTIME_OFF_NOTE,
} from '../services/signal-outcome.js';

/** A pool that answers the two statements the reader issues and records that it saw them. */
function harness({ settingsRow = null, pause = { state: 'live' }, runtimeEnabled = true, controlsFails = false, controls = null, failContext = false } = {}) {
  const queries = [];
  const pool = {
    async query(sql, params) {
      queries.push({ sql, params });
      if (sql.includes('FROM users u')) {
        if (failContext) throw new Error('connection pool exhausted');
        return { rows: settingsRow ? [settingsRow] : [] };
      }
      throw new Error(`unexpected statement: ${sql.slice(0, 60)}`);
    },
  };
  const platform = controls ?? {
    async read() {
      if (controlsFails) throw new Error('the pause table is unreachable');
      return pause;
    },
  };
  let live = runtimeEnabled;
  const readerUnderTest = createSignalOutcomeReader({ pool, platformControls: platform, runtimeEnabled: () => live });
  return { queries, reader: readerUnderTest, setRuntime: (value) => { live = value; } };
}

const blockedRow = (executionNote, extra = {}) => ({ id: 1, source: 'telegram', executionReady: true, status: 'unexecuted', executionNote, ...extra });
const paid = { autoTrading: true, executionAccountId: 'acct-1', accountState: 'DEPLOYED', subscriptionStatus: 'active' };

test('a legacy row is answered from the state the workspace is in now, on the read the UI performs', async () => {
  // The report, reproduced: the banner says the plan is what is missing, the card still blames the switch.
  const { reader, queries } = harness({ settingsRow: { autoTrading: true, executionAccountId: '', accountState: null, subscriptionStatus: 'free' } });
  const [row] = await reader.withLiveBlockers('user-1', [blockedRow(AUTO_TRADING_OFF_NOTE)]);
  assert.equal(row.executionNote, PLAN_NO_EXECUTION_NOTE, 'a Free workspace gets the plan sentence, which is the sentence its banner already shows');
  assert.equal(row.status, 'unexecuted', 'and only the sentence moved');
  assert.equal(queries.length, 1, 'one statement answers the whole list, not one per row');
});

test('each state the workspace can be in produces its own sentence, and a cleared workspace produces none', async () => {
  const cases = [
    ['free plan', { autoTrading: true, executionAccountId: '', accountState: null, subscriptionStatus: 'free' }, PLAN_NO_EXECUTION_NOTE],
    ['no account', { autoTrading: true, executionAccountId: '', accountState: null, subscriptionStatus: 'active' }, NO_ACCOUNT_NOTE],
    ['account not deployed', { autoTrading: true, executionAccountId: 'acct-1', accountState: 'STOPPED', subscriptionStatus: 'active' }, ACCOUNT_NOT_READY_NOTE],
    ['everything set', paid, null],
  ];
  for (const [name, settingsRow, expected] of cases) {
    const { reader } = harness({ settingsRow });
    const [row] = await reader.withLiveBlockers('user-1', [blockedRow(AUTO_TRADING_OFF_NOTE)]);
    assert.equal(row.executionNote, expected, `${name}: the row says what ${name} means, and nothing else`);
  }
});

test('what nobody on this workspace can act on is only ever named once everything they can is settled', async () => {
  const withAccount = { ...paid };
  const pausedRead = harness({ settingsRow: withAccount, pause: { state: 'paused', reason: 'Maintenance' } });
  const [pausedRow] = await pausedRead.reader.withLiveBlockers('user-1', [blockedRow(NO_ACCOUNT_NOTE)]);
  assert.equal(pausedRow.executionNote, PAUSED_NOTE, 'a workspace that is ready but held by Signal Desk says so');

  const unavailable = harness({ settingsRow: withAccount, runtimeEnabled: false });
  const [offRow] = await unavailable.reader.withLiveBlockers('user-1', [blockedRow(NO_ACCOUNT_NOTE)]);
  assert.equal(offRow.executionNote, RUNTIME_OFF_NOTE, 'and a service that cannot reach a broker says that instead');

  // The platform conditions never outrank the switch or the plan: those are the two the reader can act on.
  const freeAndPaused = harness({ settingsRow: { ...withAccount, subscriptionStatus: 'free' }, pause: { state: 'paused' } });
  const [freeRow] = await freeAndPaused.reader.withLiveBlockers('user-1', [blockedRow(NO_ACCOUNT_NOTE)]);
  assert.equal(freeRow.executionNote, PLAN_NO_EXECUTION_NOTE, 'a Free workspace is told to upgrade, not to wait');
});

test('the runtime switch is read when the row is read, not when the process started', async () => {
  const { reader, setRuntime } = harness({ settingsRow: paid, runtimeEnabled: true });
  const [before] = await reader.withLiveBlockers('user-1', [blockedRow(RUNTIME_OFF_NOTE)]);
  assert.equal(before.executionNote, null, 'while the runtime is up, a row that blamed it stops blaming it');
  setRuntime(false);
  const [after] = await reader.withLiveBlockers('user-1', [blockedRow(RUNTIME_OFF_NOTE)]);
  assert.equal(after.executionNote, RUNTIME_OFF_NOTE, 'and a runtime turned off mid-day is reflected on the next read');
});

test('a read path that cannot see the workspace shows the stored sentence, and never invents one', async () => {
  const deadContext = harness({ settingsRow: null });
  const rows = [blockedRow(AUTO_TRADING_OFF_NOTE)];
  const passed = await deadContext.reader.withLiveBlockers('user-1', rows);
  assert.equal(passed[0].executionNote, AUTO_TRADING_OFF_NOTE, 'no settings row, no claim about the switch');

  const unreachablePause = harness({ settingsRow: paid, controlsFails: true });
  const second = await unreachablePause.reader.withLiveBlockers('user-1', [blockedRow(AUTO_TRADING_OFF_NOTE)]);
  assert.equal(second[0].executionNote, AUTO_TRADING_OFF_NOTE, 'a kill switch that cannot be read is not a reason to say it is paused');

  const brokenPool = harness({ settingsRow: paid, failContext: true });
  const third = await brokenPool.reader.withLiveBlockers('user-1', [blockedRow(AUTO_TRADING_OFF_NOTE)]);
  assert.equal(third[0].executionNote, AUTO_TRADING_OFF_NOTE, 'and a statement that threw is swallowed here, because a list is not allowed to fail over a sentence');
});

test('a list with nothing to re-decide is not a list worth querying', async () => {
  const { reader, queries } = harness({ settingsRow: paid });
  const untouched = await reader.withLiveBlockers('user-1', [
    blockedRow(null),
    blockedRow('The broker declined this order. Check your account and try again.'),
    blockedRow('A note a person typed for themselves.'),
  ]);
  assert.equal(queries.length, 0, 'no execution sentence in, no read issued at all');
  assert.equal(untouched[1].executionNote, 'The broker declined this order. Check your account and try again.', 'and a mirrored broker answer survives verbatim whatever the workspace looks like');
  assert.equal(untouched[2].executionNote, 'A note a person typed for themselves.', 'so does a sentence nobody else may speak over');

  const manual = await reader.withLiveBlockers('user-1', [blockedRow(AUTO_TRADING_OFF_NOTE, { source: 'manual' })]);
  assert.equal(manual[0].executionNote, AUTO_TRADING_OFF_NOTE, 'a hand-written row is not a channel row, and is left as written');
});

test('the reader keeps the array identity it was handed when there is no work to do', async () => {
  const { reader } = harness({ settingsRow: paid });
  const rows = [{ id: 2, source: 'telegram', executionNote: null }];
  assert.equal(await reader.withLiveBlockers('user-1', rows), rows, 'the same array, so a route that spread rows into a payload did not build a new list to nothing');
  assert.equal(await reader.withLiveBlockers('user-1', null), null, 'and a missing list is passed through rather than turned into an empty one');
});
