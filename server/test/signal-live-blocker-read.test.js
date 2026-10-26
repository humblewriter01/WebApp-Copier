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
  isExecutionBlockerNote,
  matchExecutionBlockerNote,
  overlayLiveBlocker,
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

/* --------------------------------------------------------------------------- *
 * The eligibility test itself, on the shapes a live table actually holds.
 *
 * These four cases are the difference between "the unit works" and "the trader sees the truth": every one of
 * them is a row the shipped function let through with a sentence its workspace had outgrown, because the gate
 * asked about a column instead of about the sentence.
 * --------------------------------------------------------------------------- */

test('every legacy shape of a blocked row is still re-decided', () => {
  /* Free plan, auto-trading on: the state the report was written in, and the reason the card should read
     "your plan does not include automatic execution" rather than blaming the switch. */
  const context = { autoTradingEnabled: true, subscriptionStatus: 'free' };
  // `execution_ready` is the parser's verdict on the message, and releases before it was a separate flag wrote
  // false here for rows the workspace conditions blocked; `source` has carried more than one label for "a
  // channel sent this"; and a sentence can be stored with a line break from a console fix-up.
  const legacy = [
    ['execution_ready false', { executionReady: false, source: 'telegram', executionNote: AUTO_TRADING_OFF_NOTE }],
    ['execution_ready missing', { source: 'telegram', executionNote: AUTO_TRADING_OFF_NOTE }],
    ['an older source label', { executionReady: true, source: 'telegram_channel', executionNote: AUTO_TRADING_OFF_NOTE }],
    ['no source at all', { executionReady: true, source: null, executionNote: AUTO_TRADING_OFF_NOTE }],
    ['a wrapped line', { executionReady: true, source: 'telegram', executionNote: 'Auto-Trading is off, so this\n   signal was saved for review only.\n' }],
    ['a doubled space', { executionReady: true, source: 'telegram', executionNote: 'Auto-Trading is off,  so this signal was saved for review only.' }],
  ];
  for (const [label, row] of legacy) {
    const out = overlayLiveBlocker(row, context);
    assert.equal(out.executionNote, PLAN_NO_EXECUTION_NOTE, `${label}: kept the stored sentence`);
    assert.equal(out.status, row.status, `${label}: changed the status`);
  }
});

test('a sentence the card falls back to is corrected too, in the response only', () => {
  // Some builds put the blocker where the parser's refusal goes, and the card reads that field when the note is
  // empty - so the legacy sentence there would win by being the only text on the row.
  const row = { executionReady: true, source: 'telegram', executionNote: null, parseError: `  ${AUTO_TRADING_OFF_NOTE} ` };
  const out = overlayLiveBlocker(row, { autoTradingEnabled: true, subscriptionStatus: 'free' });
  assert.equal(out.executionNote, PLAN_NO_EXECUTION_NOTE);
  assert.equal(out.parseError, null);
  assert.equal(row.parseError, `  ${AUTO_TRADING_OFF_NOTE} `, 'the stored row was mutated');
});

test('a row with nothing of ours to say is not given a blocker', () => {
  const rows = [
    // An unreadable message in a workspace that cannot auto-trade: `unparsed`, and nothing this module wrote.
    { executionReady: false, source: 'telegram', status: 'unparsed', executionNote: null, parseError: 'No usable price appeared in this message.' },
    // A clean row in a workspace that can trade: it goes to the broker, and the card says so.
    { executionReady: true, source: 'telegram', status: 'unexecuted', executionNote: null },
    // A review flag from a person, with the parser's own explanation beside it.
    { executionReady: true, source: 'telegram', status: 'needs-review', executionNote: 'Check the lot before sending.', parseError: 'No usable price appeared in this message.' },
  ];
  for (const row of rows) {
    assert.equal(overlayLiveBlocker(row, { autoTradingEnabled: true, subscriptionStatus: 'free' }), row);
  }
});

test('a hand-written note belongs to the person who wrote it, however wrong it reads', () => {
  const row = { executionReady: true, source: 'manual', executionNote: AUTO_TRADING_OFF_NOTE };
  assert.equal(overlayLiveBlocker(row, { autoTradingEnabled: true, subscriptionStatus: 'active', accountSelected: true, accountState: 'DEPLOYED' }), row);
});

test('a row that already tells the truth is handed back untouched, not copied', () => {
  const row = { executionReady: true, source: 'telegram', status: 'unexecuted', executionNote: PLAN_NO_EXECUTION_NOTE };
  const out = overlayLiveBlocker(row, { autoTradingEnabled: true, subscriptionStatus: 'free' });
  assert.equal(out, row, 'the same object, so a list of correct rows changes nothing on the screen');
  // ...and a row whose sentence is the same words with different spacing is still normalised.
  const mangled = { ...row, executionNote: 'Auto-Trading is on,  but your plan\ndoes not include automatic execution. Upgrade to execute signals.' };
  assert.equal(overlayLiveBlocker(mangled, { autoTradingEnabled: true, subscriptionStatus: 'free' }).executionNote, PLAN_NO_EXECUTION_NOTE);
});

test('the registry matches on words, and on nothing looser', () => {
  assert.equal(matchExecutionBlockerNote(AUTO_TRADING_OFF_NOTE), AUTO_TRADING_OFF_NOTE);
  assert.equal(matchExecutionBlockerNote(' Auto-Trading\tis off, so this signal was saved for review only.\n'), AUTO_TRADING_OFF_NOTE);
  assert.equal(matchExecutionBlockerNote('Auto-Trading is off, so this signal was saved for review only maybe'), null);
  assert.equal(matchExecutionBlockerNote(null), null);
  assert.equal(matchExecutionBlockerNote(42), null);
  // A paraphrase is not ours to rewrite, however close it reads.
  assert.equal(isExecutionBlockerNote('Auto-Trading is OFF so this signal was saved for review only.'), false);
});
