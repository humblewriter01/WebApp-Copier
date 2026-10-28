/**
 * Re-reading stored signals with the current parser, without changing what was ever *done*.
 *
 * A captured row is a record of two separate things: what the message said, and what the platform decided
 * about it. This touches only the first. The columns it writes are the ones the parser owns - symbol, side,
 * the three price legs, the two distances in pips, the scale-out levels, whether the direction was inferred,
 * and the sentence explaining a reading that could not be completed. What it deliberately leaves alone is
 * everything with a consequence: `status` and `execution_note` (the outcome, and the reason that was true of
 * the settings at capture time), `execution_ready` (which is what an enqueue decision was made from),
 * `needs_review` (which a reviewer may have set or accepted), the provenance columns, and of course `trades`
 * - a position that exists was opened from the numbers as they stood, and rewriting them would make the
 * history disagree with the broker.
 *
 * `parse_error` is taken from Layer 1 alone rather than from `captureSafety`, and that is not an oversight.
 * The workspace's Safety settings produced the *policy* half of that sentence, and those settings have moved
 * on since; recomputing them would put a 23 October row's refusal under the lens of today's switches, and
 * the row would then be quoting a decision nobody made. What the parser could not read from the text is a
 * fact about the text, and it is the only thing refreshed here.
 *
 * The plan is a pure function of the rows in and the rows out, so it can be tested with no database, run
 * against a dump, or turned into SQL for a console - and running it twice changes nothing the second time,
 * because a row whose reading already matches is not a change.
 */

import { parseSignal } from './signal-parser.js';
import { ORDER_TYPES } from './order-routing.js';

/** The columns a backfill may write. Everything else on the table is out of scope by definition. */
export const BACKFILL_COLUMNS = Object.freeze([
  'symbol', 'side', 'entry_price', 'stop_loss', 'take_profit',
  'stop_loss_pips', 'take_profit_pips', 'take_profit_levels',
  'direction_inferred', 'order_type', 'order_type_stated', 'is_scalping', 'parse_error',
]);

/**
 * Rows eligible for a re-read, in one statement.
 *
 * Both exclusions are re-checked in the `WHERE` of every update as well, so a trade or a job that appears
 * between the read and the write still protects itself: the update then matches nothing rather than
 * rewriting the numbers a live position was opened from.
 */
/**
 * The candidate rows, oldest first.
 *
 * A builder rather than a constant string, because a filter bolted onto the end of a statement that already
 * ends in `ORDER BY` is a syntax error that only appears when someone narrows the run to one workspace -
 * which is the first thing anybody does with a maintenance script on a shared database.
 */
export function backfillSelect({ userId = null } = {}) {
  const params = [];
  const scope = userId ? ' AND s.user_id = $1' : '';
  if (userId) params.push(userId);
  return {
    text: `  SELECT s.id, s.user_id, s.source, s.message, s.symbol, s.side, s.entry_price, s.stop_loss, s.take_profit,
           s.stop_loss_pips, s.take_profit_pips, s.take_profit_levels, s.direction_inferred,
           s.order_type, s.order_type_stated, s.is_scalping, s.parse_error,
           s.status, s.execution_ready, s.created_at
      FROM signals s
     WHERE NOT EXISTS (SELECT 1 FROM trades t WHERE t.signal_id = s.id)
       AND NOT EXISTS (SELECT 1 FROM execution_jobs ej WHERE ej.signal_id = s.id)${scope}
     ORDER BY s.created_at ASC`,
    params,
  };
}

/** The same guards, applied again at write time. */
export const BACKFILL_WRITE_GUARDS = `
     AND NOT EXISTS (SELECT 1 FROM trades t WHERE t.signal_id = s.id)
     AND NOT EXISTS (SELECT 1 FROM execution_jobs ej WHERE ej.signal_id = s.id)`;

/** Postgres returns NUMERIC as a string and booleans as booleans; compare on the number, not the spelling. */
const numeric = (value) => (value === null || value === undefined || value === '' ? null : Number(value));
const text = (value) => {
  const cleaned = value === null || value === undefined ? null : String(value).trim();
  return cleaned === '' ? null : cleaned;
};
const bool = (value) => value === true || value === 'true' || value === 1;
const levels = (value) => {
  const list = Array.isArray(value)
    ? value
    : (typeof value === 'string' && value.trim() ? (() => { try { return JSON.parse(value); } catch { return null; } })() : null);
  const numbers = Array.isArray(list) ? list.map(Number).filter((number) => Number.isFinite(number)) : [];
  return numbers.length > 1 ? numbers : null;
};

/** The parse and the reading, kept apart so a caller can refuse a leg without re-parsing the message. */
export function readMessage(message) {
  const parsed = parseSignal(message);
  return { parsed, values: valuesFromParse(parsed) };
}

/**
 * What the current parser says about a message, in the shape the table stores.
 *
 * Exported because it is the only definition of "how a reading becomes a row": the offline re-read writes through
 * it, and `services/signal-edit.js` writes an edited message through it, so the two cannot drift into two
 * different answers about the same text.
 */
export function valuesFromParse(parsed) {
  return {
    symbol: text(parsed.symbol),
    side: text(parsed.side),
    entry_price: numeric(parsed.entryPrice),
    stop_loss: numeric(parsed.stopLoss),
    take_profit: numeric(parsed.takeProfit),
    stop_loss_pips: numeric(parsed.stopLossPips),
    take_profit_pips: numeric(parsed.takeProfitPips),
    take_profit_levels: levels(parsed.takeProfitLevels),
    direction_inferred: parsed.directionInferred === true,
    // Never null: the column is NOT NULL with a default precisely so an unknown order type cannot be written
    // as an empty value, because the only honest meaning of "we do not know" is a market order.
    order_type: ORDER_TYPES.includes(parsed.orderType) ? parsed.orderType : 'market',
    order_type_stated: parsed.orderTypeStated === true,
    is_scalping: parsed.isScalping === true,
    parse_error: text(parsed.parseError),
  };
}

export function reparseMessage(message) {
  return readMessage(message).values;
}

/** The columns that hold a price, as opposed to a distance or a name. */
const PRICE_LEGS = Object.freeze(['entry_price', 'stop_loss', 'take_profit', 'take_profit_levels']);

/**
 * Which price legs this reading earned the right to write.
 *
 * Layer 1 is allowed to be opportunistic about *live* signals: a channel that writes `BUY GOLD 4011` with no
 * labels at all is a trade the subscriber means to take, and the number next to the metal is the best
 * evidence of the level. The same instinct applied by a script to six weeks of a broadcaster's chatter is a
 * different matter, because a headline about Bitcoin at 79,000 has no entry price in it - it has a *number*,
 * which is not the same thing, and the old parser was right to leave the column null.
 *
 * So a leg is only rewritten when the message is directed (a BUY or a SELL, which is what makes a price an
 * order rather than a quote), when no number in it is readable two ways, and - for the entry, which is the
 * leg most often supplied by inference - when the price was labelled or a zone rather than picked up beside
 * the symbol name. Everything refused here keeps whatever the row already had, so the operation is still a
 * no-op on a row nobody has changed: refusing to write is not the same as writing a null.
 *
 * Which is also why the run never *clears* a price. A re-read that finds no stop loss in a message says
 * something about the message; it does not establish that the stored level is wrong, and the two ways a level
 * can be there anyway - the channel edited its own post, or a person fixed the row - are indistinguishable
 * from a parser regression at this altitude. Filling and refining are allowed, deletion is not.
 */
export function writableLegs(parsed) {
  const reasons = {};
  const ambiguous = Array.isArray(parsed.ambiguousLevels) && parsed.ambiguousLevels.length > 0;
  if (!parsed.side) for (const column of PRICE_LEGS) reasons[column] = 'no BUY or SELL in the message, so a number in it is a quote, not a level';
  if (ambiguous) for (const column of PRICE_LEGS) reasons[column] ??= 'a number in the message reads two ways, and a backfill must not choose';
  if (parsed.entryWasBare === true) reasons.entry_price ??= 'the entry is a bare number beside the symbol name, not a stated price';
  return { allow: PRICE_LEGS.filter((column) => !reasons[column]), reasons };
}

/**
 * Values as the table holds them, so a comparison is between like things and not `4011` against `'4011.00'`.
 *
 * The same reason `valuesFromParse` is exported: a row that "did not change" has to be decided by the code that
 * decides what a row *is*, and an edit that reads a change where the re-read sees none is two policies again.
 */
export function storedValues(row) {
  return {
    symbol: text(row.symbol),
    side: text(row.side),
    entry_price: numeric(row.entry_price),
    stop_loss: numeric(row.stop_loss),
    take_profit: numeric(row.take_profit),
    stop_loss_pips: numeric(row.stop_loss_pips),
    take_profit_pips: numeric(row.take_profit_pips),
    take_profit_levels: levels(row.take_profit_levels),
    direction_inferred: bool(row.direction_inferred),
    order_type: ORDER_TYPES.includes(row.order_type) ? row.order_type : 'market',
    order_type_stated: bool(row.order_type_stated),
    is_scalping: bool(row.is_scalping),
    parse_error: text(row.parse_error),
  };
}

export const same = (left, right) => {
  if (Array.isArray(left) || Array.isArray(right)) return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
  return (left ?? null) === (right ?? null);
};

/**
 * The rows that would change, and the values they would change to.
 *
 * `untouched` counts rows whose stored reading already matches what the current parser produces - which is
 * what makes the operation safe to re-run, and what tells an operator the schema and the code have caught up.
 */
export function planBackfill(rows = [], { userId = null } = {}) {
  const wanted = text(userId);
  const changes = [];
  let skipped = 0;
  for (const row of rows) {
    if (wanted && String(row.user_id ?? '') !== wanted) { skipped += 1; continue; }
    // `message_b64` exists for the case where the rows were taken out of the database by a tool that cannot
    // carry a newline, an emoji, or a quote without changing what they look like. A message is decoded and
    // then re-checked at write time against the stored text, so a row that arrived damaged is skipped by the
    // guard below rather than parsed wrong.
    const message = row.message_b64
      ? Buffer.from(String(row.message_b64), 'base64').toString('utf8')
      : (typeof row.message === 'string' ? row.message : '');
    if (!message.trim()) { skipped += 1; continue; }
    const before = storedValues(row);
    const { parsed, values: read } = readMessage(message);
    const legs = writableLegs(parsed);
    // A refused leg is not written *and* not cleared: the row keeps what it had, because "the current parser
    // would not put a price here" is a statement about this reading, not evidence that the stored number is wrong.
    const after = { ...read };
    const refusedColumns = [];
    for (const column of PRICE_LEGS) {
      if (same(before[column], read[column])) continue;
      /* Two different refusals, in this order, and the second one is the rule that matters most.
         - The reading is not confident: do not overwrite.
         - The row holds a price and this message yields none: never delete it. Signals are re-sent, quoted,
           truncated and edited, and a level can also have been corrected by hand - none of which a bulk re-read
           can tell apart from a parser regression. A backfill may *add* and may *refine*; removing a number a
           trade might have been guarded by is not what anybody asked it to do. */
      if (before[column] !== null && (read[column] === null || read[column] === undefined)) {
        after[column] = before[column];
        refusedColumns.push({ column, reason: 'the row already holds a price and this message yields none, so it is left alone' });
        continue;
      }
      if (!legs.allow.includes(column)) {
        after[column] = before[column];
        refusedColumns.push({ column, reason: legs.reasons[column] ?? null });
      }
    }
    const differing = BACKFILL_COLUMNS.filter((column) => !same(before[column], after[column]));
    if (!differing.length) continue;
    changes.push({
      id: row.id, createdAt: row.created_at ?? null, message, before, after,
      columns: differing,
      refused: refusedColumns,
      sets: differing.map((column) => ({ column, value: after[column] })),
    });
  }
  return { changes, untouched: Math.max(0, rows.length - changes.length - skipped), skipped };
}

const literal = (value, column) => {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
  if (Array.isArray(value)) return `'${JSON.stringify(value).replace(/'/g, "''")}'::jsonb`;
  if (column === 'side' || column === 'symbol') return `'${String(value).replace(/'/g, "''")}'`;
  return `'${String(value).replace(/'/g, "''")}'`;
};

/**
 * The statements, as literal SQL.
 *
 * Written for the case a live connection is not the way in - a console, a migration file, or a host where the
 * only door is a query box. Only ever our own values go into it: instrument codes, sides, numbers, our
 * sentences from the parser, and a JSON array of numbers. No message text is interpolated anywhere, which is
 * what makes escaping a footnote here rather than the interesting part.
 */
/**
 * The statements, one per row.
 *
 * `guard: 'base64'` compares the stored message with its own base64 instead of its text. Same property, one
 * line per statement, and no newline or emoji in the SQL at all - which is what the form is for: a script
 * whose output has to be pasted into someone else's web console cannot afford a literal that a clipboard,
 * a textarea, or a proxy is free to re-wrap, because a re-wrapped message literal does not fail loudly, it
 * simply stops matching and the row is silently skipped. The encoded text is compared exactly as
 * `replace(encode(...), E'\n', '')` produces it, which is how a dump is taken.
 */
export function backfillStatements(changes, { table = 'signals', guard = 'message' } = {}) {
  return (changes ?? []).map((change) => {
    const sets = change.sets.map((item) => `${item.column} = ${literal(item.value, item.column)}`).join(',\n           ');
    const check = guard === 'base64'
      ? `replace(encode(convert_to(s.message, 'UTF8'), 'base64'), E'\\n', '') = ${literal(change.message === null ? null : Buffer.from(String(change.message), 'utf8').toString('base64'), null)}`
      : `s.message ${change.message === null ? 'IS NULL' : `= ${literal(change.message, null)}`}`;
    return `UPDATE ${table} AS s
        SET ${sets}
      WHERE s.id = ${literal(change.id, null)}::uuid
       AND ${check}
${BACKFILL_WRITE_GUARDS.trimEnd()}`;
  });
}

/** The same updates with placeholders, for the pool. */
export function backfillParameterized(changes, { table = 'signals' } = {}) {
  return (changes ?? []).map((change) => {
    const values = [change.id];
    // The JSONB leg is serialised here rather than in a second pass over the array: `$n::jsonb` with a JS
    // array in the slot is what pg hands to the driver as a string it does not understand, and the failure
    // only shows up on a row that actually has a scale-out plan - the rare one, i.e. the one to get wrong.
    const sets = change.sets.map((item, index) => {
      const jsonb = item.column === 'take_profit_levels';
      values.push(jsonb && item.value !== null && item.value !== undefined ? JSON.stringify(item.value) : item.value);
      return `${item.column} = $${index + 2}${jsonb ? '::jsonb' : ''}`;
    });
    values.push(change.message ?? null);
    const messageSlot = values.length;
    return {
      text: `UPDATE ${table} AS s\n        SET ${sets.join(',\n           ')}\n      WHERE s.id = $1::uuid\n       AND s.message IS NOT DISTINCT FROM $${messageSlot}\n${BACKFILL_WRITE_GUARDS.trimEnd()}`,
      values,
    };
  });
}

/** A one-line summary of one row, for the report. Prices only - the message itself is not reprinted. */
export function describeChange(change) {
  const shape = (side) => `${side.symbol ?? '-'} ${side.side ?? '-'} E${side.entry_price ?? '-'} SL${side.stop_loss ?? '-'}${side.stop_loss_pips ? `(${side.stop_loss_pips}p)` : ''} TP${side.take_profit ?? '-'}${side.take_profit_pips ? `(${side.take_profit_pips}p)` : ''}`;
  const refused = (change.refused ?? []).map((leg) => `\n    not written: ${leg.column}${leg.reason ? ` - ${leg.reason}` : ''}`).join('');
  /* The refusals are the part an operator has to be able to see. A row that could have had an entry written and
     did not is the whole difference between a conservative script and a silently incomplete one. */
  return `${String(change.id).slice(0, 8)}  ${change.columns.join(', ')}\n    was: ${shape(change.before)}\n    now: ${shape(change.after)}${refused}`;
}
