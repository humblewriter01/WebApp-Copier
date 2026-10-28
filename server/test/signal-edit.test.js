/**
 * What an edited Telegram post is allowed to do to a signal row.
 *
 * The product rule this service exists to enforce is narrow, and every case below is one of its edges:
 *
 *  - A correction may **fill** a leg the first message never stated, and it may **refine** a number the channel
 *    changed. Both are the channel telling us the truth about the same post later.
 *  - A correction may never **delete** a price the row already holds. A provider who replaces a signal with a
 *    headline or an apology must not be able to un-make a trade instruction that was already published - the text
 *    refreshes, the numbers stay. It is the same rule `services/signal-backfill.js` enforces for the admin
 *    re-parse, arriving from the other direction.
 *  - A row that has moved - queued, sent, filled, closed, refused - is not a row an edit rewrites, and the
 *    refusal is stated twice: here, and in the `WHERE` clause of the statement that writes it, because a re-read
 *    and a re-decision are not the same moment, and only the database can see an order landing in between.
 *
 * Two more properties are pinned here because nothing else in the suite would catch their loss: provenance and
 * eligibility travel with the *prices* rather than with the wording, and the channel's own clock is never moved by
 * an edit - which is what keeps a three-day-old corrected signal stale to the execution engine.
 *
 * The merge is driven through the **real** parser rather than hand-written `parsed` objects. A fixture invented
 * here would drift from the shape Layer 1 actually produces, and the drift would be silent in exactly the
 * direction that matters: a field the parser stopped setting looks identical to a field the merge ignored.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EDITABLE_SIGNAL_STATUSES, isEditAppliedTo, mergeEditedReading, planSignalEdit } from '../services/signal-edit.js';
import { parseSignalTwoLayer } from '../services/signal-parse-pipeline.js';
import { captureSafety } from '../services/signal-safety.js';
import { SIGNAL_STATUSES, decideSignalOutcome } from '../services/signal-outcome.js';

const BLOCKED_TEXT = 'GOLD SELL NOW';
const FULL_TEXT = 'GOLD SELL\nEntry: 3300\nSL: 3280\nTP: 3350';
const ZONE_TEXT = 'GOLD SELL\nEntry: 3295-3305\nSL: 3280\nTP: 3350';
const SENT_AT = '2026-10-23T12:59:00.000Z';
/** GramJS stores `editDate` in *seconds*, and the conversion to a timestamp happens exactly once, in the plan. */
const EDITED_AT_SECONDS = Math.floor(Date.parse('2026-10-23T12:59:40.000Z') / 1000);
const EDITED_AT_ISO = new Date(EDITED_AT_SECONDS * 1000).toISOString();

const indexSource = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
const saveSignal = indexSource.slice(
  indexSource.indexOf('async function saveSignal('),
  indexSource.indexOf('\nconst telegramCapture = createTelegramListener('),
);

/** Layer 1 for real: no Layer 2 config, so no model call and no network in any case in this file. */
function parse(message) {
  return parseSignalTwoLayer(message, { source: 'telegram' });
}

/**
 * The row as the table holds it, built from a reading - the only honest way to feed a merge. The capture path
 * writes the parser's numbers into typed columns, and a test that invented its own row shape would be testing the
 * merge against a database that does not exist.
 *
 * Two details are load-bearing rather than tidy: `pg` returns NUMERIC as a *string*, and jsonb already parsed.
 * Both are what convinced an earlier draft of this merge that every edit had changed a price, so they are
 * reproduced here on purpose.
 */
function rowFromReading(message, reading, overrides = {}) {
  const parsed = reading.parsed;
  const provenance = reading.provenance;
  const numeric = (value) => (value == null ? null : String(value));
  return {
    id: 'signal-1',
    user_id: '11111111-1111-4111-8111-111111111111',
    source: 'telegram',
    channel_id: '-1002440709664',
    telegram_message_id: 77,
    message,
    symbol: parsed.symbol,
    side: parsed.side,
    entry_price: numeric(parsed.entryPrice),
    stop_loss: numeric(parsed.stopLoss),
    take_profit: numeric(parsed.takeProfit),
    stop_loss_pips: numeric(parsed.stopLossPips),
    take_profit_pips: numeric(parsed.takeProfitPips),
    take_profit_levels: parsed.takeProfitLevels || [],
    entry_range: parsed.entryRange || null,
    order_type: parsed.orderType,
    order_type_stated: parsed.orderTypeStated === true,
    is_scalping: parsed.isScalping === true,
    direction_inferred: parsed.directionInferred === true,
    needs_review: reading.review.required === true,
    parsed_by: provenance.parsedBy,
    parse_confidence: provenance.confidence,
    llm_used: provenance.llmUsed === true,
    execution_ready: parsed.executionReady === true,
    parse_error: parsed.parseError,
    status: parsed.executionReady === true ? 'received' : 'unparsed',
    technical_note: null,
    created_at: '2026-10-23T13:00:00.000Z',
    first_seen_at: '2026-10-23T13:00:00.000Z',
    sent_at: SENT_AT,
    edited_at: null,
    ...overrides,
  };
}

async function planFor({ from = BLOCKED_TEXT, to = FULL_TEXT, rowOverrides = {}, editedAt = EDITED_AT_SECONDS } = {}) {
  const [original, edit] = [await parse(from), await parse(to)];
  const row = rowFromReading(from, original, rowOverrides);
  return {
    plan: planSignalEdit({ row, parsed: edit.parsed, review: edit.review, provenance: edit.provenance, savedText: to, editedAt }),
    original, edit, row,
  };
}

/* ----------------------------------------------------------------------- the shape of an answer -------------------------------------------------------------------- */

test('a message with no row behind it is not an edit at all', async () => {
  const edit = await parse(FULL_TEXT);
  const fresh = planSignalEdit({ row: null, parsed: edit.parsed, review: edit.review, provenance: edit.provenance, savedText: FULL_TEXT, editedAt: EDITED_AT_SECONDS });
  assert.deepEqual(Object.keys(fresh).sort(), ['action', 'editedAt'],
    'no row for that message id means the ordinary capture path owns the message, and the plan hands it back with nothing but the stamp to store');
  assert.equal(fresh.action, 'insert');
  assert.equal(fresh.editedAt, EDITED_AT_ISO, 'a correction that arrives before the row does is still a correction, and the row says so');
});

test('the five answers, and the row each one is allowed to touch', async () => {
  const cases = {
    insert: { plan: planSignalEdit({ row: null, editedAt: EDITED_AT_SECONDS }) },
    update: { plan: (await planFor({})).plan },
    text: { plan: (await planFor({ from: FULL_TEXT, to: FULL_TEXT.replace('\n', ', ') })).plan },
    none: { plan: (await planFor({ from: FULL_TEXT, to: FULL_TEXT })).plan },
    refuse: { plan: (await planFor({ rowOverrides: { status: 'executed' } })).plan },
  };
  for (const [name, { plan }] of Object.entries(cases)) {
    assert.equal(plan.action, name, `the ${name} case`);
    assert.equal(typeof plan.editedAt, 'string', 'every answer carries the stamp through, even a refusal: the writer needs it for the row it returns');
  }
  /* `columns: null` and `reading: null` on every non-write is the contract that makes the writer simple: there is
   * nothing to bind, so a caller cannot half-apply an edit that was declined. `insert` is the exception with an
   * empty object, because "no plan" and "no change" are different answers to different questions. */
  assert.equal(cases.text.plan.columns, null, 'a text refresh is not a column list');
  assert.equal(cases.none.plan.columns, null);
  assert.equal('columns' in cases.refuse.plan, false, 'a refusal produces no columns at all, so nothing can be written by accident');
  assert.equal(cases.refuse.plan.detail.includes('`executed`'), true, 'and it says why in a sentence a log line can carry');
  for (const name of ['text', 'none', 'refuse']) {
    assert.equal(cases[name].plan.reading, name === 'refuse' ? undefined : null, 'no reading is offered for a row that is not being rewritten - so no caller can re-decide eligibility on a declined edit');
  }
});

test('the edit stamp is the channel clock in seconds, and its absence is stored as nothing', () => {
  assert.equal(planSignalEdit({ row: null, editedAt: EDITED_AT_SECONDS }).editedAt, EDITED_AT_ISO, 'unix seconds, because that is what `messages.Message.edit_date` holds');
  assert.equal(planSignalEdit({ row: null, editedAt: null }).editedAt, null, 'a message the library handed over without an edit date gets NULL');
  assert.equal(planSignalEdit({ row: null, editedAt: 'not a stamp' }).editedAt, null, 'and not our own clock: an invented stamp would claim we know when the channel amended the post');
  assert.equal(planSignalEdit({ row: null, editedAt: 0 }).editedAt, null, 'zero is the absence of a stamp in this library, not the epoch');
});

test('nothing an edit writes can move the channel clock, the identity, or the audit trail', async () => {
  /* One invariant, checked over the whole table. The columns are built here and bound by name into a
     parameterised statement there, so a single stray key would let a provider's typo rewrite when a signal was
     posted - and `sent_at` is the value the execution engine's age guard measures against. A test that looked only
     at the happy path would not notice a `created_at` appearing in one branch, which is where a careless
     `Object.assign` of the whole row would hide. */
  const froms = [BLOCKED_TEXT, FULL_TEXT, ZONE_TEXT];
  const tos = [FULL_TEXT, BLOCKED_TEXT, 'GOLD BUY\nEntry: 3300\nSL: 3280\nTP: 3350', 'GOLD SELL see the chart', ZONE_TEXT.replace('3280', '3270')];
  for (const from of froms) {
    for (const to of tos) {
      const { plan } = await planFor({ from, to });
      const columns = Object.keys(plan.columns || {});
      for (const forbidden of ['id', 'user_id', 'channel_id', 'telegram_message_id', 'source', 'sent_at', 'created_at', 'first_seen_at', 'edited_at', 'execution_note']) {
        assert.equal(columns.includes(forbidden), false, `${from.split('\n')[0]} -> ${to.split('\n')[0]}: ${forbidden} is never in the merge's column list`);
      }
      assert.equal(plan.row?.entry_range === undefined, false, 'and the row itself is always handed back for the paths that return it');
    }
  }
});

/* ------------------------------------------------------------------- the case the task is about ------------------------------------------------------------------ */

test('a signal blocked for a missing stop loss becomes executable when the edit supplies it', async () => {
  const { plan, row } = await planFor({});
  assert.equal(row.execution_ready, false, 'the first message was not tradable, and the row says so');
  assert.equal(row.status, 'unparsed', 'stored for review, not queued');
  assert.match(String(row.parse_error), /stop loss/i, 'with the reason on the row');

  assert.equal(plan.action, 'update');
  assert.equal(plan.reason, null, 'an applied edit has nothing to explain, so there is no reason to log');
  assert.equal(plan.wasBlocked, true, 'the block is what makes this an upgrade rather than a re-description');
  assert.equal(plan.legsChanged, true, 'prices moved, so this row is a new trade instruction');
  assert.deepEqual(plan.changedColumns, ['entry_price', 'stop_loss', 'take_profit'], 'in the order the columns are declared, and only the three that were filled');
  assert.deepEqual(plan.filled, [], '`filled` counts what the *row* contributed, and a row with no legs had nothing to contribute');
  assert.deepEqual(plan.dropped, [], 'and nothing was refused, because there was no stored price for a stated one to contradict');
  assert.equal(plan.columns.entry_price, 3300, 'as numbers from the parse - the statement casts, the service does not');
  assert.equal(plan.columns.take_profit, 3350);
  assert.equal(plan.columns.message, undefined, 'the text itself is bound by the writer, not carried in the merge list');
  assert.equal(plan.eligibility, 'recompute', 'a filled leg is a fresh claim about tradability, so the safety nets run again');

  /* The merged reading is handed to the real policy in the same order the writer does it. That is the difference
     between "the plan says update" and "the corrected signal actually trades": the merge, the safety nets and the
     workspace settings are three separate decisions, and only the third produces the `execution_ready` column. */
  const settings = { blockExecutionWithoutStopLoss: true, blockExecutionWithoutTakeProfit: true };
  const safety = captureSafety({ parsed: plan.reading, source: 'telegram', settings, review: plan.review });
  assert.equal(safety.executionReady, true, 'with the legs filled there is nothing for a net to catch');
  assert.equal(plan.reading.parseError, null, 'and the refusal sentence goes away with the block that caused it');
  const outcome = decideSignalOutcome({
    executionReady: safety.executionReady, manual: false, autoTradingEnabled: true, runtimeEnabled: true,
    paused: false, subscriptionStatus: 'active', accountSelected: true, accountState: 'DEPLOYED',
  });
  assert.equal(outcome.queue, true, 'every gate the workspace owns is open, so the corrected signal is handed to the queue - which is the whole point of the edit');
  assert.equal(outcome.status, 'queued', 'and the row is described as queued, which is the status the tail of the capture writes');
  assert.equal(outcome.note ?? null, null, 'with nothing to apologise for');

  // The same correction, into a workspace that still has no target to trade, must not become executable.
  const halfFilled = { ...plan.reading, takeProfit: null, missing: { ...plan.reading.missing, takeProfit: true }, blockers: [{ code: 'take-profit-missing', message: 'A target is required.' }] };
  const strict = captureSafety({ parsed: halfFilled, source: 'telegram', settings, review: plan.review });
  assert.equal(strict.executionReady, false, 'an edit fills what the channel supplied and nothing more');

  // And with auto-trading off, the row is corrected and *not* queued: the edit is not a licence.
  const parked = decideSignalOutcome({
    executionReady: safety.executionReady, manual: false, autoTradingEnabled: false, runtimeEnabled: true,
    paused: false, subscriptionStatus: 'active', accountSelected: true, accountState: 'DEPLOYED',
  });
  assert.equal(parked.queue, false, 'the user\'s own switch outranks the provider\'s correction');
  assert.equal(parked.status, 'received', 'and the row is stored as a signal that simply is not being traded - not as a failure, and not as something the user has to fix');
  assert.equal(typeof parked.note, 'string', 'with one sentence on it saying why, which is the same note every other capture path would have written');

  // A DEPLOYED-but-paused workspace sees the same shape: corrected, not queued.
  const paused = decideSignalOutcome({
    executionReady: safety.executionReady, manual: false, autoTradingEnabled: true, runtimeEnabled: true,
    paused: true, subscriptionStatus: 'active', accountSelected: true, accountState: 'DEPLOYED',
  });
  assert.equal(paused.queue, false, 'a pause is a pause, whether the signal arrived whole or arrived corrected');
});

test('a corrected row keeps the age of the message it corrects', async () => {
  /* The staleness guard is what stops a re-posted signal from being traded as a fresh one, and an edit is the
     case where it could plausibly be argued away: the channel *just now* said this. It does not get to: the
     signal is as old as its posting, and a correction three days late is a three-day-late correction. */
  const { plan } = await planFor({});
  assert.equal(plan.row.sent_at, SENT_AT, 'the row the plan was built from is not rewritten');
  assert.equal('sent_at' in plan.columns, false, 'the merge does not offer it');
  assert.equal('sent_at' in plan.reading, false, 'nor does the reading pretend to carry it');
  assert.equal(saveSignal.includes('sent_at=$'), false, 'and no statement in the capture path can assign it, on the edit path or any other');
  assert.equal(/UPDATE signals[\s\S]{0,700}sent_at=/.test(saveSignal), false, 'in either of the two UPDATEs');
});

test('a refined price moves that leg and inherits the rest', async () => {
  const { plan } = await planFor({ from: FULL_TEXT, to: 'GOLD SELL\nEntry: 3310\nSL: 3280\nTP: 3350' });
  assert.equal(plan.action, 'update');
  assert.deepEqual(plan.changedColumns, ['entry_price'], 'only the leg that moved counts as changed');
  assert.equal(plan.legsChanged, true);
  assert.equal(plan.eligibility, 'recompute');
  assert.equal(plan.reading.entryPrice, 3310, 'the corrected number wins');
  assert.equal(plan.reading.stopLoss, 3280, 'the legs the edit was silent about are kept from the row, not dropped');
  assert.equal(plan.reading.takeProfit, 3350);
  assert.equal(plan.wasBlocked, false, 'and a row that was already tradable is not described as an upgrade');
});

/* ------------------------------------------------------------------------ the refusals ------------------------------------------------------------------------- */

test('a row that has moved is refused, in the service and again in the statement', async () => {
  for (const status of ['queued', 'sent', 'executed', 'filled', 'closed', 'skipped', 'expired', 'invalid', 'cancelled']) {
    const { plan } = await planFor({ rowOverrides: { status } });
    assert.equal(plan.action, 'refuse', `${status}: a signal with a history is not a signal an edit rewrites`);
    assert.equal(plan.reason, 'ALREADY_MOVING', 'one reason for all of them, because the reason is the fact "it has moved", not nine separate rules');
    assert.equal(plan.editedAt, EDITED_AT_ISO, 'the stamp is still computed, since the caller returns the row and the panel reads the stamp');
    assert.equal(plan.row.status, status, 'the row is handed back exactly as it was read, so the caller can show the trader what is actually stored');
    assert.equal(isEditAppliedTo(plan.row), false, 'and the gate that decided it is the same function the list is derived from');
  }
  assert.deepEqual([...EDITABLE_SIGNAL_STATUSES], ['received', 'unparsed', 'unexecuted'], 'the whole editable set, in one place, shared by the reader and the writer');
  assert.equal(EDITABLE_SIGNAL_STATUSES.every((status) => Object.values(SIGNAL_STATUSES).includes(status)), true, 'and every one of them is a status this product really produces');
  assert.equal(isEditAppliedTo({ status: 'received' }), true);
  assert.equal(isEditAppliedTo({ status: 'unexecuted' }), true, 'a row blocked by the workspace\'s own switches is still corrected, so the numbers are right when the switch flips');
  assert.equal(isEditAppliedTo(null), false, 'a missing row is not an editable one');
  assert.equal(isEditAppliedTo({}), true, 'a row with no status is treated as open, deliberately: the only writer that leaves it unset is a fixture, and refusing an edit quietly would hide the refusal instead of reporting it - while the statement that would have written it carries the same gate in its WHERE clause, where no fixture is involved');
});

test('an edit that replaces a signal with a headline refreshes the words and keeps every price', async () => {
  const { plan } = await planFor({ from: FULL_TEXT, to: 'GOLD SELL NOW - discussion below, ignore the numbers' });
  assert.equal(plan.reading.entry_price, undefined, 'the reading is a reading, not a row, and it speaks in the parser\'s own names');
  assert.equal(plan.reading.entryPrice, 3300, 'every price the row held survives a channel that stopped stating it');
  assert.equal(plan.reading.stopLoss, 3280);
  assert.equal(plan.reading.takeProfit, 3350);
  assert.deepEqual(plan.lost, [], 'and the deletion tripwire stays quiet, because the merge is fill-only by construction');
  assert.equal(plan.action, 'update', 'with one thing moved: the wording about how to send the order, which is a fact the new text states and the old one did not');
  assert.deepEqual(plan.changedColumns, ['order_type', 'order_type_stated']);
  assert.equal(plan.legsChanged, false, 'no price moved, so the stored verdict is kept');
  assert.equal(plan.eligibility, 'stored');

  /* A blocked message edited into another blocked message is the same shape one step down: the text moves, the
   * row\'s verdict does not, and nothing is promoted. */
  const stillBlocked = await planFor({ to: 'GOLD SELL NOW see the chart' });
  assert.equal(stillBlocked.plan.action, 'text');
  assert.equal(stillBlocked.plan.reason, 'WORDING_ONLY');
  assert.deepEqual(stillBlocked.plan.changedColumns, [], 'the merge found nothing at all to write');
  assert.equal(stillBlocked.plan.textChanged, true, 'while the text is recorded as changed, which is what the writer\'s own guard compares');
  assert.equal(stillBlocked.plan.reading, null, 'and no reading exists for a wording-only edit, so nothing can re-decide eligibility from it');
});

test('an edit the parser agrees with completely writes nothing', async () => {
  const { plan } = await planFor({ from: FULL_TEXT, to: FULL_TEXT });
  assert.equal(plan.action, 'none');
  assert.equal(plan.reason, 'NO_CHANGE');
  assert.equal(plan.textChanged, false, 'the same text, the same reading, the same row: the statement is not even prepared');
  assert.equal(plan.reading, null, 'and a no-op cannot re-decide eligibility, because it hands the writer no reading to decide from');

  /* This branch is also what a duplicate delivery lands in, which is why the replay path can compare text and
   * skip: an unchanged re-read costs one SELECT and no write at all. */
  const wording = await planFor({ from: FULL_TEXT, to: FULL_TEXT.replace('\n', ', ') });
  assert.equal(wording.plan.action, 'text', 'a comma for a newline is a different message, so it is stored');
  assert.equal(wording.plan.columns, null, 'but the refresh is two columns of the writer\'s choosing, not a column list from the merge');
});

/* --------------------------------------------------------------- what a merge may inherit, and why --------------------------------------------------------------- */

test('a wording fix keeps the provenance the row earned, and new prices do not inherit it', async () => {
  /* `needs_review`, `parsed_by`, `parse_confidence` and `llm_used` describe how the *numbers* were arrived at.
     They are not a property of the wording. The case that makes this worth a test is a post the AI reader had to
     interpret: an edit that only fixes a spelling must not launder the row into `parsed_by = regex, needs_review
     = false`, because a reviewer would then be looking at an approval for a reading nobody ever produced. */
  const reviewed = await planFor({
    from: FULL_TEXT,
    to: 'GOLD SELL, entry 3300, SL 3280, TP 3350 (scalping)',
    rowOverrides: { needs_review: true, parsed_by: 'llm', parse_confidence: '0.80', llm_used: true, order_type: 'limit', order_type_stated: true },
  });
  assert.equal(reviewed.plan.action, 'update');
  assert.equal(reviewed.plan.legsChanged, false, 'every price is the same price');
  assert.deepEqual(reviewed.plan.changedColumns, ['is_scalping'], 'so the flag the new text states is the one thing that moves');
  assert.equal(reviewed.plan.review.required, true, 'the review that was already asked for is still asked for');
  assert.equal(reviewed.plan.provenance.parsedBy, 'llm', 'the reading is still the model\'s');
  assert.equal(reviewed.plan.provenance.confidence, '0.80', 'with the confidence the model gave it, as pg returned it');
  assert.equal(reviewed.plan.provenance.llmUsed, true, 'and the flag that says so');
  assert.equal(reviewed.plan.eligibility, 'stored', 'and the verdict is inherited, not re-decided on the strength of a bracket');
  assert.equal(reviewed.plan.columns.is_scalping, true, 'while a field the new text states is taken from the new text');

  /* The mirror image: when the prices themselves are the thing that moved, the row\'s provenance describes numbers
     that are no longer on the row, and keeping it would mislabel the new ones. */
  const moved = await planFor({
    from: FULL_TEXT,
    to: 'GOLD SELL\nEntry: 3310\nSL: 3280\nTP: 3350',
    rowOverrides: { needs_review: true, parsed_by: 'llm', parse_confidence: '0.80', llm_used: true },
  });
  assert.equal(moved.plan.legsChanged, true);
  assert.equal(moved.plan.provenance.parsedBy, 'regex', 'the numbers now on the row came from Layer 1, and the row has to say that');
  assert.equal(moved.plan.review.required, false, 'and a message the regex read on its own is not held for review by an edit');
  assert.equal(moved.plan.eligibility, 'recompute', 'so the safety nets run again on the reading that is now on the row');

  // A corrected direction is a corrected trade, and it moves the row even when every number is identical.
  const flipped = await planFor({ from: FULL_TEXT, to: 'GOLD BUY\nEntry: 3300\nSL: 3280\nTP: 3350' });
  assert.deepEqual(flipped.plan.changedColumns, ['side'], 'the side is a column of the row, and it is what the order will be built from');
  assert.equal(flipped.plan.legsChanged, true, 'the same prices on the other side of the book are a different trade, which is why this is not a wording change');
  assert.equal(flipped.plan.columns.side, 'buy');
  assert.equal(flipped.plan.reading.side, 'buy');
});

test('a zone the row holds survives an edit that says nothing about it', async () => {
  const { plan, row } = await planFor({ from: ZONE_TEXT, to: 'GOLD SELL\nSL: 3270\nTP: 3350' });
  assert.deepEqual(row.entry_range, { low: 3295, high: 3305 }, 'the capture stored the range the message published');
  assert.equal(plan.action, 'update');
  assert.deepEqual(plan.changedColumns, ['stop_loss'], 'the only leg the edit restated, and the zone it said nothing about is not reported as touched');
  assert.deepEqual(plan.filled, ['entryPrice'], 'while the entry bound came from the row, which is what `filled` has always counted');
  assert.deepEqual(plan.reading.entryRange, { low: 3295, high: 3305 }, 'and the zone the edit went silent about is kept, because the order router refuses on it');
  assert.equal(plan.reading.entryPrice, 3295, 'with the bound the row was credited with');
  assert.equal('entry_range' in plan.columns, false,
    'the zone is not in the merge\'s column list at all: the writer binds it from the merged reading through `entryRangeValue`, the same converter a new row goes through, so a stored zone and a freshly captured one cannot be encoded two different ways');
  assert.equal((saveSignal.match(/entry_range=\$10::jsonb/g) || []).length, 1, 'and exactly one of the three statements writes it, from that one converter');
});

test('the merge takes the edit\'s own prices, keeps a stored zone, and never clears one', () => {
  /* `mergeEditedReading` driven directly, with numbers a real message would not produce in this combination,
   * because the three things worth pinning are each invisible to a parse-driven case: a leg the edit states
   * outright, a leg only the row holds, and a zone only the row holds.
   *
   * The interesting one is the zone. The edit here states a single entry of 3300 while the row holds the range
   * 3295-3305 that the original post published. The price moves and the zone stays, which is not the merge being
   * timid about a contradiction - it is the order of precedence the whole file runs on: the newer text outranks
   * the older text wherever the newer text speaks, and fills the gaps where it does not. The consequence of a
   * correction landing *outside* a stale zone is that the router refuses the order, which is the direction this
   * product refuses in everywhere: an entry that can no longer be filled is a worse outcome than an entry that is
   * not filled at all, and clearing a stored column to make an edit consistent is the one thing rule 4 forbids. */
  const row = {
    symbol: 'XAUUSD', side: 'sell', entry_price: '3295', stop_loss: null, take_profit: '3350',
    entry_range: { low: 3295, high: 3305 }, take_profit_levels: [3350], stop_loss_pips: null, take_profit_pips: null,
    order_type: 'limit', order_type_stated: true, is_scalping: false, direction_inferred: false,
  };
  const merged = mergeEditedReading({
    row,
    parsed: {
      symbol: 'XAUUSD', side: 'sell', entryPrice: 3300, stopLoss: 3280, takeProfit: null,
      entryRange: null, takeProfitLevels: [], stopLossPips: null, takeProfitPips: null,
      orderType: 'market', orderTypeStated: false, isScalping: false, directionInferred: false,
      missing: { entryPrice: false, stopLoss: false, takeProfit: true }, blockers: [{ code: 'take-profit-missing', message: 'A target is required.' }],
    },
  });
  assert.equal(merged.reading.entryPrice, 3300, 'the corrected price wins: the channel said 3300 in the newer message, and the newer message is the one being captured');
  assert.deepEqual(merged.dropped, [], 'nothing was refused on the way in - the refusal this pipeline keeps is a *distance* read as a price, and this is a price');
  assert.deepEqual(merged.reading.entryRange, { low: 3295, high: 3305 }, 'while the zone the edit said nothing about is kept, bound for bound, and is what the router will refuse against');
  assert.equal(merged.changedColumns.includes('entry_range'), false, 'and kept quietly: a merge that reported an untouched zone as changed would call every edit of a zoned row a rewrite');
  assert.equal(merged.reading.stopLoss, 3280, 'a leg the row does not hold is taken from the edit');
  assert.equal(merged.reading.takeProfit, 3350, 'and a leg the row holds and the edit is silent about keeps the row\'s');
  assert.deepEqual(merged.filled, ['takeProfit'], 'which is the one leg the row supplied - the log has to be able to tell the channel\'s numbers from ours');
  assert.deepEqual(merged.changedColumns, ['entry_price', 'stop_loss'], 'the two columns the write actually moves, and no others');
  assert.equal(merged.legsChanged, true, 'a stop loss arriving is a price changing, whatever else did or did not');
  assert.deepEqual(merged.reading.blockers, [{ code: 'take-profit-missing', message: 'A target is required.' }],
    'and a leg the row filled does NOT buy back a blocked target on the merge\'s own authority: `mergeGaps` answers a stop-loss block, because a stored stop is the same fact the channel was asked for, and leaves a take-profit block standing, because whether a stored target is good enough is the safety pass\'s question and never a merge\'s');
  assert.equal(merged.reading.executionReady, false, 'so the reading still describes itself as blocked, which is exactly why the writer re-runs `captureSafety` rather than trusting `merged.executionReady`');
  /* And the policy agrees with the reading rather than overruling it. The block came from the parse, the merge
     filled a leg beside it without touching it, and `captureSafety` honours what is still on the list - which is
     the same refusal it would have made about this reading had it arrived from Layer 2 instead of from a row. The
     only thing that lifts a block on the edit path is the edited text stating the leg, and that is the case the
     flagship test above drives: no blocker survives a message that wrote the number itself. */
  assert.equal(captureSafety({
    parsed: merged.reading, source: 'telegram', review: { required: false },
    settings: { blockExecutionWithoutStopLoss: true, blockExecutionWithoutTakeProfit: true },
  }).executionReady, false, 'a leg the merge filled from the row does not lift a blocker the parse wrote, even for the safety pass that follows');
  assert.deepEqual(merged.lost, [], 'nothing the row held was cleared on the way');
});

/* ---------------------------------------------------------------------------- the writer, pinned -----------------------------------------------------------------

   Everything above is a service returning data. What turns it into a row is the hundred lines in `saveSignal`,
   and a service that decides correctly is worth nothing if the statement forgets the guard. These pins are the
   ones no reviewer catches by eye, because they are about which of three statements is which and what each may
   carry.

   --------------------------------------------------------------------------------------------- */

test('the capture path routes an edit through the plan and writes it with its own statement', () => {
  // The lookup is the unique index\'s own key, so "the row for that message" cannot mean two things.
  assert.match(saveSignal, /SELECT \* FROM signals WHERE user_id=\$1 AND channel_id=\$2 AND telegram_message_id=\$3 AND source='telegram' LIMIT 1/,
    'the edit reads the stored row by exactly the columns the partial unique index is built on');
  assert.match(saveSignal, /editPlan = planSignalEdit\(\{ row: stored\.rows\[0\] \|\| null, parsed, review, provenance, savedText, editedAt: channel\.editedAt \?\? null \}\)/,
    'one plan, from the reading the pipeline produced and the row as stored - not from a second parse of the same text');
  assert.match(saveSignal, /if \(editPlan\.action === 'refuse' \|\| editPlan\.action === 'none'\) \{[\s\S]{0,400}?return editPlan\.row;/,
    'both no-write answers leave before any statement is built, and take the stored row with them');
  assert.match(saveSignal, /if \(editPlan\.action === 'text'\) \{[\s\S]{0,1400}?return row;/,
    'and the wording refresh has its own two-column statement and its own return');

  const updateAt = saveSignal.indexOf('SET symbol=$2');
  assert.ok(updateAt > 0, 'the edit has a statement of its own, and it is not built out of the plan');
  const editStatement = saveSignal.slice(updateAt, saveSignal.indexOf('RETURNING', updateAt));
  assert.match(editStatement, /WHERE id=\$1 AND telegram_message_id=\$25 AND status = ANY\(\$26::text\[\]\)/,
    'the status gate is re-asserted by the database at the instant of writing, so a row that moved between the read and the write cannot be overwritten');
  assert.match(editStatement, /AND telegram_message_id=\$25/,
    'and the message id is in the WHERE clause too, because a write keyed on the primary key alone could hit a row the plan never read');
  assert.match(editStatement, /edited_at=\$24/, 'the stamp rides in the statement that carries the correction');
  assert.match(editStatement, /message=\$22/, 'the text is written from the message, not from a re-read of the parse');
  assert.match(editStatement, /technical_note=COALESCE\(\$23,technical_note\)/,
    'the admin half is only overwritten when the new reading has something to say, so a corrected message never erases a broker response');
  assert.equal(editStatement.includes('sent_at'), false, 'the posting time is absent from the update: not carried, not recomputed');
  assert.equal(/NOW\(\)|CURRENT_TIMESTAMP/.test(editStatement), false, 'and no clock of ours sneaks in on the way');
  assert.match(saveSignal, /EDITABLE_SIGNAL_STATUSES\]/, 'the gate is the service\'s own constant as a parameter, so the SQL cannot drift from the list that decided it');
  /* The plan's values are read, its column *names* never are. This is the line a reviewer would otherwise skip
     and the reason the statement above can stay a literal: if the SET list were built by mapping over
     `plan.columns`, a future merge that ever put an expression in a key would be composing SQL out of a parse. */
  assert.equal((editStatement.match(/\$\{/g) || []).length, 0, 'not one interpolation in the SET clause or the WHERE clause, so nothing a reading produces can reach the SQL text');
  assert.match(saveSignal, /const columns = editPlan\.columns;/, 'the plan supplies values into one binding, and every value is bound by name as a parameter');
  assert.match(saveSignal, /columns\.entry_price, columns\.stop_loss, columns\.take_profit/, 'named one by one, in the order the statement lists them');

  /* The zero-rows case is the race this shape exists to close, and it is a result rather than an exception: it has
     to say so, and it must not announce or queue a row that was not written. */
  const racedAt = saveSignal.indexOf('if (!applied.length) {');
  const raced = saveSignal.slice(racedAt, racedAt + 320);
  assert.match(raced, /log\('warn'/, 'logged at warn, because a row that moved mid-edit means the trader is looking at a card that just went stale');
  assert.match(raced, /return signal;/, 'and the row handed back is the one that was read, unmodified');
  assert.equal(/emit|execution_jobs|UPDATE signals SET status/.test(raced.slice(0, raced.indexOf('return signal;'))), false,
    'nothing is pushed, nothing is queued, and no status is annotated for a write that did not happen');

  // Eligibility is decided by one call, for one reason.
  assert.equal(saveSignal.match(/captureSafety\(/g).length, 1, 'the safety nets are consulted once, on the merged reading, and never again for the edit');
  assert.match(saveSignal, /const safety = editPlan\?\.action === 'update' && editPlan\.eligibility === 'stored'/,
    'and an edit that moved no price inherits the stored verdict instead of re-deciding it');
  assert.equal(saveSignal.includes('editPlan.columns.parse_error'), false, 'a refusal sentence is never copied out of a column list - it comes from the safety result');
  assert.match(saveSignal, /if \(editPlan\.wasBlocked && executionReady\) \{/, 'and the promotion is said out loud, on the row\'s own terms');
});

test('the schema carries the stamp once, and the insert keeps it beside the channel clock', () => {
  const schema = readFileSync(new URL('../db.js', import.meta.url), 'utf8');
  assert.match(schema, /ALTER TABLE signals ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ;/,
    'added idempotently, so a running workspace gains the column on the next boot with no migration step');
  assert.equal((schema.match(/ADD COLUMN IF NOT EXISTS edited_at/g) || []).length, 1, 'in one statement');
  const at = schema.indexOf('ADD COLUMN IF NOT EXISTS edited_at');
  const uniqueIndex = schema.indexOf('CREATE UNIQUE INDEX IF NOT EXISTS signals_telegram_event_unique_idx');
  assert.ok(at > 0 && uniqueIndex > 0 && at < uniqueIndex, 'and before the partial unique index, so a fresh database never builds that index against a column the migration has not made yet');

  assert.match(saveSignal, /sent_at,edited_at\)\n\s+VALUES/, 'a new message stores the stamp too, so a replay that arrives as a correction has somewhere to put it');
  assert.match(saveSignal, /channel\.editedAt \? new Date\(channel\.editedAt\) : null\]/, 'and NULL when the source gave no edit time, rather than a claim about now');
  assert.match(saveSignal, /UPDATE signals\n           SET message=\$2,edited_at=\$3/, 'the wording refresh writes the same two columns and nothing else');
});

test('the listener is what decides an arrival is an edit, and says so in the payload', () => {
  const listener = readFileSync(new URL('../services/telegram-listener.js', import.meta.url), 'utf8');
  assert.match(listener, /function attachEditHandler\(client, entry, userId\) \{/, 'the edit subscription is attached by its own function, with its own filter and callback');
  assert.match(listener, /telegramAdapter\.addEditHandler\(client, handler, telegramAdapter\.createEditEventFilter\(\)\);\n\s+entry\.editHandler = handler;/,
    'through the adapter seam - the only door the project allows, and the reason an edit handler and a new-message handler cannot be folded into one');
  assert.match(listener, /const handler = \(event\) => ingestMessage\(userId, event\?\.message, event\);/,
    'the post handler passes no `edited`, so a new post is never described as a correction');
  assert.match(listener, /ingestMessage\(userId, event\?\.message, event, \{ edited: true \}\)/, 'and the edit handler passes exactly that');
  assert.match(listener, /editedAt: message\?\.editDate \?\? null/, 'the stamp is read off the message and defaults to nothing, never to a date we invented');
  assert.match(listener, /edited: true, editedAt: message\?\.editDate \?\? null/, 'and it rides in the payload the writer reads, so `saveSignal` needed no new parameter to learn about edits');
  assert.equal(/MessageEdited/.test(listener.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '')), false,
    'the class the task was written against is never named in code, because it does not exist in the library we ship');
});
