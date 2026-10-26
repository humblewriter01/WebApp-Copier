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
import { format } from 'node:util';
import test from 'node:test';

import { createSignalOutcomeReader, describeOverlayDiagnostics } from '../services/signal-outcome.js';
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

/**
 * A fake result set keyed the way Postgres keys one.
 *
 * The whole reason this exists: an unquoted alias is folded to lowercase by the server, so
 * `AS autoTrading` arrives as `autotrading`, `row.autoTrading` is `undefined`, `undefined === true` is false,
 * and a workspace with its switch ON is decided as though it were OFF. Every fake pool in the suite handed
 * back exactly the camelCase keys the code asked for, so three releases of this bug passed their tests.
 * This one reads the aliases out of the statement it is handed and folds the unquoted ones, which makes the
 * projection itself part of the contract under test.
 */
function foldedRow(sql, source) {
  const lookup = new Map(Object.entries(source).map(([key, value]) => [key.toLowerCase(), value]));
  const list = sql.slice(sql.search(/\bSELECT\b/i) + 6, sql.search(/\bFROM\b/i));
  const row = {};
  for (const part of list.split(',')) {
    const token = part.replace(/`/g, '').trim();
    if (!token) continue;
    const aliased = /\sAS\s+("(?:[^"]+)"|[A-Za-z_]\w*)$/i.exec(token);
    if (!aliased) {
      const bare = /^[a-z_][a-z0-9_]*$/i.exec(token.includes('.') ? token.split('.').pop() : token);
      if (bare) row[bare[1].toLowerCase()] = lookup.get(bare[1].toLowerCase()) ?? null;
      continue;
    }
    const raw = aliased[1];
    const key = raw.startsWith('"') ? raw.slice(1, -1) : raw.toLowerCase();
    row[key] = lookup.get(key.toLowerCase()) ?? null;
  }
  return row;
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

/* --------------------------------------------------------------------------- *
 * The instrumentation an operator reads when a card and the truth disagree.
 * --------------------------------------------------------------------------- */

test('a list whose only stale sentence sits in parse_error still costs a read', async () => {
  /* The overlay was taught to look in the fallback field, but the short-circuit in front of it decides whether
     a read happens at all. If that one asks only about `execution_note`, the fix is unreachable from a route -
     which is the difference between a unit test passing and a trader seeing the truth. */
  const row = { id: 'sig-parse-held', source: 'telegram', status: 'unparsed', executionNote: null, parseError: AUTO_TRADING_OFF_NOTE };
  const { reader, queries } = harness({ settingsRow: { autoTrading: true, executionAccountId: 'acct-1', accountState: 'DEPLOYED', subscriptionStatus: 'free' } });
  const [out] = await reader.withLiveBlockers('user-1', [row]);
  assert.equal(queries.length, 1, 'the context was read, because the row does carry one of ours');
  assert.equal(out.executionNote, PLAN_NO_EXECUTION_NOTE);
  assert.equal(out.parseError, null, 'and the legacy copy is not left to be picked up by the card again');
});

test('every decision the read path takes is counted, and the lines themselves can be turned off', async () => {
  const rewrite = { id: 'sig-counted-1', source: 'telegram', status: 'unexecuted', executionNote: AUTO_TRADING_OFF_NOTE };
  const foreign = { id: 'sig-counted-2', source: 'telegram', status: 'unexecuted', executionNote: 'The broker declined this order.' };
  const before = describeOverlayDiagnostics();
  assert.equal(before.registry, 6, 'six sentences are this module to rewrite, and no more');

  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(format(...args));
  try {
    const { reader } = harness({ settingsRow: { autoTrading: true, executionAccountId: 'acct-1', accountState: 'DEPLOYED', subscriptionStatus: 'free' } });
    await reader.withLiveBlockers('user-counted', [rewrite, foreign]);
  } finally {
    console.log = original;
  }
  const after = describeOverlayDiagnostics();
  assert.equal(after.rewrites - before.rewrites, 1, 'one row re-decided');
  assert.equal(after.skips - before.skips, 1, 'one row left alone, and counted as left alone');
  assert.equal(after.reads - before.reads, 1, 'one list read');
  assert.equal(after.rows - before.rows, 2);
  assert.equal(after.eligible - before.eligible, 1, 'only the row carrying our sentence was eligible');
  assert.equal(after.lastSkipReason, 'note-not-in-registry');
  assert.match(after.lastSkippedNote, /broker declined/, 'and the note an operator would want to see is on the record');

  assert.ok(lines.some((line) => line.includes('overlay: read') && line.includes('user-counted')), 'a line per read, with who it was for');
  assert.ok(lines.some((line) => line.includes('overlay: rewriting') && line.includes('sig-counted-1')), 'the rewrite is announced with the row id');
  assert.ok(lines.some((line) => line.includes('overlay: skipped') && line.includes('sig-counted-2')), 'so is the skip, with the sentence that caused it');

  // Off is off: the counters keep their meaning, stdout goes quiet.
  const counted = describeOverlayDiagnostics().rewrites;
  process.env.SIGNAL_OVERLAY_DEBUG = 'off';
  const muted = [];
  console.log = (...args) => muted.push(format(...args));
  try {
    const { reader } = harness({ settingsRow: { autoTrading: true, executionAccountId: 'acct-1', accountState: 'DEPLOYED', subscriptionStatus: 'free' } });
    await reader.withLiveBlockers('user-quiet', [{ ...rewrite, id: 'sig-counted-3' }]);
  } finally {
    console.log = original;
    delete process.env.SIGNAL_OVERLAY_DEBUG;
  }
  assert.deepEqual(muted, [], 'not one line while it is silenced');
  assert.equal(describeOverlayDiagnostics().rewrites, counted + 1, 'still counted, because /health reports it');
});

test('a read path that cannot see the workspace says so out loud instead of failing quietly', async () => {
  // This is the branch that leaves a stale sentence on the screen on purpose, so it is the one line an
  // operator needs first: without it, "the overlay did nothing" and "the overlay could not run" are the same
  // shape from the outside.
  const before = describeOverlayDiagnostics();
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(format(...args));
  try {
    const { reader } = harness({ failContext: true });
    const rows = [blockedRow(AUTO_TRADING_OFF_NOTE)];
    const [out] = await reader.withLiveBlockers('user-broken', rows);
    assert.equal(out.executionNote, AUTO_TRADING_OFF_NOTE, 'the stored sentence stands');
  } finally {
    console.log = original;
  }
  const after = describeOverlayDiagnostics();
  assert.equal(after.contextFailures - before.contextFailures, 1);
  assert.ok(lines.some((line) => line.includes('overlay: skipped-list') && line.includes('context-unreadable')), 'and the reason is in the log, not only in the code');
});

test('the context read is proven against the names the database actually returns', async () => {
  /* Not "does the SQL look right" - it looked right for three releases. The question is whether the row that
     comes back has the keys the code reads, and the only honest way to ask it is to fold the aliases the way
     the server does. Unquoted camelCase here, and every assertion below fails. */
  const pool = {
    async query(sql) {
      return { rows: [foldedRow(sql, {
        autoTrading: true,
        executionAccountId: null,
        accountState: null,
        subscriptionStatus: 'free',
        userId: 'user-1',
      })] };
    },
  };
  const reader = createSignalOutcomeReader({ pool, platformControls: { async read() { return { state: 'live' }; } }, runtimeEnabled: () => true });
  const context = await reader.readOutcomeContext('user-1');
  assert.equal(context.autoTradingEnabled, true, 'the workspace switch survives the round trip');
  assert.equal(context.subscriptionStatus, 'free', 'and so does the plan');
  assert.equal(context.accountSelected, false, 'and the absence of an account is still an absence');

  const [row] = await reader.withLiveBlockers('user-1', [blockedRow(AUTO_TRADING_OFF_NOTE)]);
  assert.equal(row.executionNote, PLAN_NO_EXECUTION_NOTE, 'so a Free workspace is told the truth about its plan instead of a switch that is on');
});
