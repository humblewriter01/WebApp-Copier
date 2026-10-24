/**
 * The contract of a script that edits other people's history.
 *
 * A backfill is the one operation in this codebase whose failure mode is silent: it changes stored rows that
 * every screen and every later decision reads, it runs once, and if it is wrong the evidence of what it was
 * given is gone. So what is pinned here is mostly *absence* - the columns it must not write, the places its
 * SQL must be guarded, the fact that no message text is ever interpolated - and the property that makes it
 * safe to run again after a partial night: a row whose reading already matches is not a change.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  planBackfill, backfillStatements, backfillParameterized, reparseMessage, backfillSelect, describeChange, BACKFILL_COLUMNS,
} from '../services/signal-backfill.js';

/** The row the panel holds today for a real captured message: a heading mistaken for a symbol, and no legs. */
const MANAGE_MESSAGE = 'GOLD BUY MORE NOW !\n\nPrice : 4026.00 - 4016.00\n\nSL - 4011.00\nTP - 50Pips / 100Pips\n\nManage Layering And Money Management !';
const staleManageRow = {
  id: 'aaaa0000-0000-4000-8000-000000000001',
  user_id: 'user-1',
  source: 'telegram',
  message: MANAGE_MESSAGE,
  symbol: 'MANAGE', side: null, entry_price: null, stop_loss: null, take_profit: null,
  stop_loss_pips: null, take_profit_pips: null, take_profit_levels: null,
  direction_inferred: false, parse_error: 'A stop loss is required for automatic execution.',
  status: 'unparsed', execution_ready: false, created_at: '2026-10-23T16:01:30.000Z',
};

test('a stored row that the current parser can finish is refreshed, and only in the parse columns', () => {
  const plan = planBackfill([staleManageRow]);
  assert.equal(plan.changes.length, 1);
  const [change] = plan.changes;
  assert.equal(change.after.symbol, 'XAUUSD', 'the metal from the word GOLD, not the heading that was stored');
  assert.equal(change.after.side, 'buy');
  assert.equal(change.after.entry_price, 4026, 'the zone, at the bound least favourable to a buy');
  assert.equal(change.after.stop_loss, 4011, 'and the dashed `SL - 4011.00` is a stop loss, so `Missing SL` goes away');
  assert.equal(change.after.take_profit_pips, 50, 'the first of two pip targets, kept as a distance');
  assert.equal(change.after.parse_error, null, 'nothing is unreadable about it now, so no sentence is kept');

  // `stop_loss_pips` is deliberately absent from that list: this message states a stop *price*, so the
  // distance column stays null, and a backfill that "corrected" it would be inventing a second leg.
  for (const column of ['symbol', 'side', 'entry_price', 'stop_loss', 'parse_error', 'take_profit_pips']) {
    assert.ok(change.columns.includes(column), `${column} is a parse fact and is rewritten`);
  }
});

test('the outcome columns are out of scope, by name, on every statement', () => {
  const plan = planBackfill([staleManageRow]);
  const forbidden = ['status', 'execution_note', 'execution_ready', 'needs_review', 'parsed_by', 'llm_used',
    'parse_confidence', 'message', 'created_at', 'user_id', 'channel_id', 'telegram_message_id', 'id'];
  assert.deepEqual([...BACKFILL_COLUMNS].filter((column) => forbidden.includes(column)), [], 'the writable set names no outcome column');

  for (const statement of [...backfillStatements(plan.changes), ...backfillParameterized(plan.changes).map((item) => item.text)]) {
    const setClause = /SET\s+([\s\S]*?)\s+WHERE/i.exec(statement)[1];
    const assignments = [...setClause.matchAll(/([a-z_]+)\s*=/g)].map((match) => match[1]);
    assert.ok(assignments.length, 'every statement writes something');
    for (const column of assignments) {
      assert.ok(BACKFILL_COLUMNS.includes(column), `${column} is not a column a backfill may write`);
      assert.equal(forbidden.includes(column), false, `${column} belongs to the outcome, not the reading`);
    }
  }
});

test('running it twice changes nothing the second time, and numeric spelling is not a difference', () => {
  /* Postgres answers NUMERIC as a string, so `'4011.00'` against `4011` is the same price; if that counted as
     a change, the script would rewrite every row forever and its report would be noise. */
  const first = planBackfill([staleManageRow]);
  const afterRow = { ...staleManageRow };
  for (const column of BACKFILL_COLUMNS) afterRow[column] = first.changes[0].after[column];
  assert.equal(planBackfill([afterRow]).changes.length, 0, 'a refreshed row is already current');

  const typed = planBackfill([{
    ...staleManageRow,
    symbol: 'XAUUSD', side: 'buy', entry_price: '4026.0000', stop_loss: '4011.00', take_profit: null,
    take_profit_pips: '50', parse_error: null,
  }]);
  assert.deepEqual(typed.changes.map((change) => change.id), [], 'and a row stored with trailing zeroes is not "different"');
});

test('a message that still cannot be read gets the current sentence, not the stale one', () => {
  const row = { ...staleManageRow, message: 'Good morning everyone ☀️ have a blessed trade week', symbol: 'MANAGE', side: null, parse_error: 'No supported trading symbol was found.' };
  const [change] = planBackfill([row]).changes;
  assert.equal(change.after.symbol, null, 'the heading is not a symbol, whatever the old parser stored');
  assert.equal(change.after.parse_error, 'A BUY or SELL direction was not found.', 'and the sentence is the one this message earns today, not the stale one');
  assert.equal(change.columns.includes('execution_ready'), false, 'while the row is not quietly promoted to tradeable');
  // A row with no sentence at all is not left silent. Layer 1 names the reason it found nothing - here, that
  // no direction was written - so the backfill gives the reader something to act on instead of a blank reason.
  const chatter = { ...row, symbol: null, parse_error: null };
  const [refreshed] = planBackfill([chatter]).changes;
  assert.deepEqual(refreshed.columns, ['parse_error'], 'the one thing that changes is the reason, and nothing else');
  assert.equal(refreshed.after.parse_error, 'A BUY or SELL direction was not found.');
});

test('the write re-checks the exclusions, and refuses a row whose message is not the one parsed', () => {
  const plan = planBackfill([staleManageRow, { ...staleManageRow, id: 'aaaa0000-0000-4000-8000-000000000002', message: "it's a trap'; DROP TABLE signals;--" }]);
  const [manage, trap] = backfillStatements(plan.changes);
  for (const statement of [manage, trap]) {
    assert.match(statement, /AND s\.message = '/, 'the update only lands on the text it was computed from');
    assert.match(statement, /NOT EXISTS \(SELECT 1 FROM trades t WHERE t\.signal_id = s\.id\)/, 'a row that acquired a trade between read and write is not updated');
    assert.match(statement, /NOT EXISTS \(SELECT 1 FROM execution_jobs ej WHERE ej\.signal_id = s\.id\)/, 'nor is one that was queued in the meantime');
  }
  /* Somebody's chat text does reach the statement - as a quoted literal, which is what the guard needs - so
     what has to be true is that it cannot end the literal it sits in. Doubling every apostrophe and balancing
     the quotes is that property; a stray quote would otherwise be the last thing between a message and a
     statement of its own. */
  assert.ok(trap.includes("it''s a trap''"), 'an apostrophe in a message is doubled, not backslash-escaped in a way Postgres may or may not honour');
  assert.equal(trap.split("'").length % 2, 1, 'and the quotes balance, so the semicolon stays inside the literal');
  assert.equal(manage.includes('trap'), false, 'while the row that had nothing to do with it does not carry it');
});

test('the console form of the guard is one line per row and still cannot be fooled by an edited message', () => {
  const plan = planBackfill([staleManageRow]);
  const [statement] = backfillStatements(plan.changes, { guard: 'base64' });
  assert.equal(statement.includes('\n       AND s.message ='), false, 'no message text is inlined');
  assert.match(statement, /AND replace\(encode\(convert_to\(s\.message, 'UTF8'\), 'base64'\), E'\\n', ''\) = '[A-Za-z0-9+/=]+'/, 'the check is a base64 literal on one line');
  assert.equal([...statement.matchAll(/'/g)].length % 2, 0, 'and the quotes still balance');
  // A single changed character of the message - one space, one re-wrapped newline - must stop the write.
  const edited = backfillStatements([{ ...plan.changes[0], message: `${plan.changes[0].message} ` }], { guard: 'base64' })[0];
  assert.notEqual(edited, statement, 'so a row that does not match the text that was parsed cannot be updated by it');
  assert.equal(plan.changes[0].refused.length, 0, 'while the confident reading still stands, refused or not');
});

test('the candidates exclude anything with a trade or a job, and a workspace filter lands in the WHERE', () => {
  const all = backfillSelect();
  assert.deepEqual(all.params, []);
  assert.equal(all.text.includes('s.user_id = $1'), false, 'unscoped: no filter, though user_id is still selected for the report');
  const scoped = backfillSelect({ userId: 'user-1' });
  assert.deepEqual(scoped.params, ['user-1']);
  /* The order of the clauses is the whole test: appending a filter to a statement that ends in ORDER BY is a
     syntax error, and it is the kind that only appears the first time somebody runs the script for one user. */
  assert.ok(scoped.text.indexOf('s.user_id = $1') < scoped.text.indexOf('ORDER BY'), 'the filter precedes the sort');
  for (const guard of ['FROM trades t WHERE t.signal_id = s.id', 'FROM execution_jobs ej WHERE ej.signal_id = s.id']) {
    assert.ok(all.text.includes(guard), `${guard} keeps executed rows out of the run`);
  }
});

test('a scale-out plan is stored as JSONB in both emitters, and only when there is a plan', () => {
  const parsed = reparseMessage('BUY EURUSD 1.0850 SL 1.0800 TP1: 1.0900 TP2: 1.0950');
  assert.deepEqual(parsed.take_profit_levels, [1.09, 1.095], 'two targets is a plan');
  const single = reparseMessage('BUY EURUSD 1.0850 SL 1.0800 TP1: 1.0900');
  assert.equal(single.take_profit_levels, null, 'one target is just the target');

  const row = { ...staleManageRow, message: 'BUY EURUSD 1.0850 SL 1.0800 TP1: 1.0900 TP2: 1.0950' };
  const plan = planBackfill([row]);
  const [statement] = backfillParameterized(plan.changes);
  assert.match(statement.text, /take_profit_levels = \$\d+::jsonb/, 'the cast is on the placeholder that carries the array');
  assert.equal(statement.values.filter((value) => typeof value === 'string' && value.startsWith('[')).length, 1, 'and exactly one slot holds the serialised list');
  assert.equal(Array.isArray(statement.values.find((value) => typeof value === 'string' && value.startsWith('['))), false, 'pg must not be handed a raw array');
  const [literal] = backfillStatements(plan.changes);
  assert.match(literal, /take_profit_levels = '\[1\.09,1\.095\]'::jsonb/);
});

test('placeholders and values line up in every generated statement', () => {
  const plan = planBackfill([staleManageRow, { ...staleManageRow, id: 'x-2', symbol: 'SHOULD', side: null, parse_error: null, entry_price: null, stop_loss: null }]);
  assert.equal(plan.changes.length, 2);
  // A rollback that lost its guard would write the old values onto *any* row, including one edited since.
  const [forward] = backfillStatements(plan.changes);
  const [undo] = backfillStatements([{ id: plan.changes[0].id, message: plan.changes[0].message, sets: plan.changes[0].columns.map((column) => ({ column, value: plan.changes[0].before[column] })) }]);
  assert.match(undo, /AND s\.message = '/, 'the undo script is guarded the same way the change is');
  assert.equal(undo.includes('message IS NULL'), false, 'and it does not silently match only empty messages');
  assert.equal(forward.split('\n')[0].startsWith('UPDATE signals AS s'), true);
  for (const statement of backfillParameterized(plan.changes)) {
    const highest = Math.max(...[...statement.text.matchAll(/\$(\d+)/g)].map((match) => Number(match[1])));
    assert.equal(highest, statement.values.length, 'the last slot has a value and every value has a slot');
  }
  assert.match(describeChange(plan.changes[1]), /was: /, 'the report shows before and after, so a dry run is reviewable');
});

test('a row the parser already reads correctly is left out of the plan entirely', () => {
  const current = reparseMessage('BUY XAUUSD Entry: 4010.00 SL: 4000.00 TP: 4050.00');
  const stored = { id: 'row-1', source: 'telegram', message: 'BUY XAUUSD Entry: 4010.00 SL: 4000.00 TP: 4050.00', ...current };
  const plan = planBackfill([stored]);
  assert.equal(plan.changes.length, 0);
  assert.equal(plan.untouched, 1, 'which is what a re-run on a table that has been backfilled should say');
});

test('a price the parser had to infer is not written over a row that never had one', () => {
  /* `#Bitcoin 79,000$` is a headline. Layer 1's opportunistic pass finds a number next to the symbol name and
     calls it an entry, which is the right call for `BUY GOLD 4011` on a live channel and the wrong call for a
     broadcast the subscriber never intended as an order. A script must not turn that reading into stored
     history: the symbol is corrected, the price is refused, and the refusal is reported. */
  const headline = { ...staleManageRow, id: 'row-news', message: '#Bitcoin 79,000$', symbol: null, side: null, parse_error: 'A BUY or SELL direction was not found.' };
  const [change] = planBackfill([headline]).changes;
  assert.equal(change.after.symbol, 'BTCUSD', 'the metal the post is about, which the old parser missed');
  assert.equal(change.after.entry_price, null, 'and no entry');
  assert.equal(change.columns.includes('entry_price'), false, 'the column is not even in the write');
  // Only the leg that *would* have changed is reported as refused: a column that was null and stays null had
  // nothing to refuse, and a report that listed four would be a report about nothing.
  assert.deepEqual(change.refused.map((leg) => leg.column), ['entry_price']);
  assert.match(change.refused[0].reason, /no BUY or SELL/, 'with the reason stated in the report');
});

test('a leg the row already had is kept when the current reading would not have written it', () => {
  /* The gate is about *writing*, not about clearing. A headline that mentions 3999 is no evidence that the
     4011 stored on this row is wrong, so the row keeps its number - and a backfill that "corrected" it to a
     null, or to the headline's number, would be destroying data it was never given permission to judge. */
  const plan = planBackfill([{
    ...staleManageRow, symbol: 'XAUUSD', side: null, entry_price: 4011, stop_loss: null, take_profit: null, parse_error: null,
    message: 'Bitcoin drifted to 3999 today, nothing else to say',
  }]);
  const [change] = plan.changes;
  assert.equal(change.after.entry_price, 4011, 'the stored entry survives the run');
  assert.equal(change.columns.includes('entry_price'), false, 'the column is not in the write at all');
  assert.deepEqual(change.refused.map((leg) => leg.column), ['entry_price'], 'and the run says it declined to touch it');
  assert.match(change.refused[0].reason, /no BUY or SELL/, 'naming the reason, which is the missing direction here');

  // The other shape of refusal, with a direction present: the price is real-looking but unlabeled, so it is
  // still not something a script should overwrite a stored level with.
  const [bare] = planBackfill([{
    ...staleManageRow, symbol: 'XAUUSD', side: 'buy', entry_price: 4011, stop_loss: 4000, take_profit: null, parse_error: null,
    message: 'BUY GOLD 3999',
  }]).changes;
  assert.equal(bare.after.entry_price, 4011, 'the labelled-at-capture entry the row already carries is not replaced by an inference');
  assert.match(bare.refused.find((leg) => leg.column === 'entry_price').reason, /bare number/);
  assert.equal(bare.columns.includes('stop_loss'), false, 'and a leg the message does not mention is left alone');
  assert.match(bare.refused.find((leg) => leg.column === 'stop_loss').reason, /already holds a price/, 'because a re-read may not delete a level, only add or refine one');
});

test('a stated signal is not refused by the gate, only an inferred one', () => {
  const [change] = planBackfill([staleManageRow]).changes;
  assert.deepEqual(change.refused, [], 'the zone and the dashed SL are labelled in the message, so they are written');
  assert.equal(change.after.stop_loss, 4011);
});

test('rows with no message, and other workspaces when one is named, are skipped rather than emptied', () => {
  const plan = planBackfill([
    { id: 'blank', message: '   ', symbol: null },
    { ...staleManageRow },
    { ...staleManageRow, id: 'other', user_id: 'user-2' },
  ], { userId: 'user-1' });
  assert.equal(plan.skipped, 2, 'the blank row is skipped for having nothing to re-read, and the other workspace for being out of scope');
  assert.deepEqual(plan.changes.map((change) => change.id), [staleManageRow.id], 'and only the named workspace is in scope');
});
