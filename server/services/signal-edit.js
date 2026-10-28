/**
 * What an edited Telegram message may do to the row that message was captured into.
 *
 * Telegram replaces a post in place. `UpdateEditChannelMessage` carries the *same* message id and the new text,
 * and every reader of the channel now sees only the corrected version. The capture had no answer for that: a
 * provider who posts `GOLD SELL NOW` and two minutes later edits in the entry, the stop and the target has fixed
 * the message everybody can read, while the row on the trader's screen still holds the first version — and the
 * first version was blocked for having no stop, so the correction never reaches the engine either. The signal was
 * published, improved, and lost.
 *
 * Four rules, applied in this order:
 *
 *   1. **A row that has already moved is not touched.** An edit may be applied while the status is `received`,
 *      `unparsed` or `unexecuted` — the states in which nothing has been asked of a broker. Once it is `queued`,
 *      `pending`, `executed`, `expired` or anything else, the numbers on that row are the numbers an order was
 *      built from, and a later edit may not quietly disagree with them. The same rule is written into the UPDATE's
 *      `WHERE` clause, so a row that moves between this decision and that statement is refused by the database
 *      rather than by this function's honesty.
 *   2. **An edit states something, or it is silent; silence never removes.** Every leg the new text reads comes
 *      from the new text — including where it contradicts the row, because the edited message is what the channel
 *      is showing. Every leg it does not read keeps the stored value. The merge is delegated to `mergeGaps`, the
 *      function that already decides what Layer 2 may complete, so an edit is *a reader* rather than a second
 *      policy: it cannot hand a price to a leg the text wrote as a distance, it cannot replace a published zone
 *      with one number, and a message that reads as market news is not filled in at all.
 *   3. **The provenance travels with the values.** `needs_review`, `parse_error` and `parsed_by` describe how the
 *      numbers were obtained. When an edit changes or completes a leg, the new reading's provenance governs the
 *      row; when it changes no leg, the stored verdict is kept, so a provider fixing a typo cannot demote a
 *      signal that is numerically the same signal, and cannot promote one by re-wording it.
 *   4. **A stored leg is never blanked.** If the merged reading would lose a price the row already holds, the
 *      reading is not written and only the text is refreshed. That is what turns "the channel replaced the signal
 *      with a headline" into an honest row instead of a destroyed one — and it is checked against the row rather
 *      than against the reasons `mergeGaps` declined, because a refusal this file has not imagined is still a
 *      refusal to lose data.
 *
 * The two directions a stored value can move in are therefore asymmetric on purpose: **filling and refining are
 * allowed, deletion is not** — which is the same rule `services/signal-backfill.js` states for the six weeks of
 * rows it re-reads offline, and the reason this file imports its column vocabulary rather than inventing one.
 * A row's numbers, a row's distances, a row's ladder and the comparison that decides "did anything change" all
 * come from there, so a live edit and a maintenance re-read of the same message cannot disagree about what the
 * message says. Where the two differ is authority: the backfill refuses a bare number beside a symbol name,
 * because it is guessing at old chatter, and a live edit takes one, because the channel wrote it just now.
 *
 * `sent_at` appears in none of these lists, on purpose. It is when the channel wrote the post; it is what the age
 * guard, the expiry and every "stale" skip measure against; and an edit does not make a three-day-old signal
 * fresh. A correction that arrives late is stored late and stays exactly as stale as the post it amends.
 *
 * One number type runs through all of this: a price read out of `signals` is **text**, because `pg` returns NUMERIC
 * as a string, while a price produced by the parser is a number. `storedValues` and `valuesFromParse` are the only
 * two shapes this file compares, and both are already normalised to numbers - which is why the comparison
 * underneath `changedColumns` is arithmetic rather than `'3300.00' !== 3300`.
 */

import { mergeGaps } from './signal-parse-pipeline.js';
import { SIGNAL_STATUSES } from './signal-outcome.js';
import { valuesFromParse, storedValues, same } from './signal-backfill.js';

/**
 * The statuses a correction may still be applied to. Every one of them says "no order has been asked for";
 * `queued` and everything after it says the opposite. `unexecuted` is in because a signal that could not be
 * delivered is still a signal nobody traded, and `expired` is out because that row is closed by definition.
 */
/** `readonly string[]`, not the three literal strings: `isEditAppliedTo` asks about a status it read out of a
 * row, and a row may hold one this list has never heard of - which is an answer of "no", not a compile error. */
export const EDITABLE_SIGNAL_STATUSES = /** @type {readonly string[]} */ (Object.freeze([
  SIGNAL_STATUSES.received,
  SIGNAL_STATUSES.unparsed,
  SIGNAL_STATUSES.unexecuted,
]));

/** The columns whose values are prices, and are therefore filled rather than cleared. */
const PRICE_COLUMNS = Object.freeze(['entry_price', 'stop_loss', 'take_profit', 'take_profit_levels', 'stop_loss_pips', 'take_profit_pips']);

/** The five legs `mergeGaps` completes, in the two shapes they exist in: the reading's and the table's. */
const MERGE_LEGS = Object.freeze([
  { reading: 'symbol', column: 'symbol' },
  { reading: 'side', column: 'side' },
  { reading: 'entryPrice', column: 'entry_price' },
  { reading: 'stopLoss', column: 'stop_loss' },
  { reading: 'takeProfit', column: 'take_profit' },
]);

/**
 * Is this row open to a correction?
 *
 * A row with no status is treated as open, because the only writer that leaves one unset is a test fixture, and
 * refusing an edit because a fixture forgot a column would hide the refusal instead of reporting it.
 */
export function isEditAppliedTo(row) {
  if (!row) return false;
  if (row.status === null || row.status === undefined) return true;
  return EDITABLE_SIGNAL_STATUSES.includes(String(row.status));
}

/**
 * The row's own values, in the reading's shape rather than the table's.
 *
 * `mergeGaps` is Layer 2's merge and speaks the model's names (`entry`, `stop_loss`), so the stored row is put
 * through the same translation the model's answer goes through. Nothing is invented here: a column the table holds
 * as `''` states nothing, which is the answer `storedValues` already gives.
 */
function rowAsFields(stored) {
  return {
    symbol: stored.symbol,
    side: stored.side,
    entry: stored.entry_price,
    stop_loss: stored.stop_loss,
    take_profit: stored.take_profit,
  };
}

/**
 * Merge one reading into another, and report what the edit actually changed.
 *
 * The *edited message* is Layer 1 here, because the new text outranks the stored row wherever both state a leg;
 * the row is the fallback for the legs the new text is silent about. `filled` is what the row contributed.
 *
 * @typedef {Object} MergeEditedReadingInput
 * @property {Record<string, any>|null} [row] - the stored row, in the table's own column names
 * @property {Record<string, any>|null} [parsed] - what the edit parsed to, from `parseSignalTwoLayer`
 */
export function mergeEditedReading(/** @type {MergeEditedReadingInput} */ { row = null, parsed = null } = {}) {
  const stored = storedValues(row || {});
  const { merged, filled, dropped } = mergeGaps(parsed || {}, rowAsFields(stored), {
    // The pipeline's own guard, kept: a number the *edited text* wrote as a distance is not a price, and the
    // row's stored price must not be poured in behind it as though the channel had given one.
    pipValues: new Set([parsed?.stopLossPips, parsed?.takeProfitPips].filter((value) => value !== null && value !== undefined).map(Number)),
  });

  /* The fields that are not legs, and why each one merges the way it does.
   *
   * A distance in pips is a price the channel stated, so it is kept exactly like a leg. `directionInferred` is
   * AND-ed rather than taken from the edit: it means "no version of this message ever said buy or sell", and the
   * original wording is evidence the edit cannot erase. `isScalping` is OR-ed for the mirror-image reason.
   * `order_type` only moves when the new text actually states one, because a parse that defaults to `market` has
   * read nothing and must not overwrite a limit the channel wrote the first time.
   *
   * They are carried onto the *reading* rather than onto the columns, so `valuesFromParse` stays the only place
   * that knows how a reading becomes a row - and so the entry zone a row already holds survives an edit that
   * says nothing about the zone, in the shape `entryRangeBounds` reads back. */
  const carried = {
    stopLossPips: merged.stopLossPips ?? stored.stop_loss_pips,
    takeProfitPips: merged.takeProfitPips ?? stored.take_profit_pips,
    takeProfitLevels: Array.isArray(merged.takeProfitLevels) && merged.takeProfitLevels.length
      ? merged.takeProfitLevels
      : (Array.isArray(row?.take_profit_levels) ? row.take_profit_levels : (merged.takeProfitLevels ?? null)),
    directionInferred: merged.directionInferred === true && row?.direction_inferred !== false,
    isScalping: merged.isScalping === true || stored.is_scalping === true,
    orderType: merged.orderTypeStated === true ? merged.orderType : (row?.order_type ?? merged.orderType ?? null),
    orderTypeStated: merged.orderTypeStated === true || stored.order_type_stated === true,
    entryRange: merged.entryRange ?? (row?.entry_range && typeof row.entry_range === 'object' ? row.entry_range : null),
  };
  const reading = { ...merged, ...carried };
  const columns = valuesFromParse(reading);
  /* Not a value the reading owns. The sentence on the row is what `captureSafety` decided about this workspace's
     rules - "your Safety settings require a take-profit target" - and the backfill's `parse_error` is what the
     *parser* said. Comparing the two would report a change on every edit, and writing the parser's sentence over
     the policy's would replace an explanation with a symptom. `index.js` writes the policy's, from the same
     `captureSafety` call the capture path uses. */
  delete columns.parse_error;

  /** Rule 4's trigger: a price the table holds that this reading would clear. */
  const lost = PRICE_COLUMNS.filter((column) => stored[column] !== null && columns[column] === null);
  /** Which columns the write would move, in either direction, on the numbers rather than their spellings. */
  const changedColumns = Object.keys(columns).filter((column) => column !== 'entry_range' && !same(stored[column], columns[column]));
  /* The zone is compared bound by bound, never with `same`: that helper is `===` for anything that is not an
   * array, `entryBoundsOf` builds a fresh object on every call, and the column holds JSON text where a read row
   * hands back a parsed object - so all three ways of saying "equal" to a human are unequal to the helper. A merge
   * that reported a zone as changed on every edit would rewrite a whole row where one leg moved, which is only
   * wasteful, and it would lie in the log line, which is the one place anyone can see what an edit did to a
   * signal. `entry_range` is excluded from the generic pass rather than corrected after it, so there is exactly
   * one comparison for it in either direction - including the case where the row has a zone and the reading does
   * not, which the `carried` block above makes impossible and which still has to come out "unchanged". */
  const zoneBefore = entryBoundsOf(row?.entry_range);
  const zoneAfter = entryBoundsOf(carried.entryRange);
  if ((zoneBefore?.low ?? null) !== (zoneAfter?.low ?? null) || (zoneBefore?.high ?? null) !== (zoneAfter?.high ?? null)) changedColumns.push('entry_range');

  return {
    reading,
    columns,
    stored,
    /** Which legs the row contributed to the new reading - what a reader of the log line wants to see. */
    filled,
    dropped,
    lost,
    changedColumns,
    /** Rule 3's test: did a *price* move? Only then does the reading's provenance take the row's verdict with it. */
    legsChanged: MERGE_LEGS.some((leg) => changedColumns.includes(leg.column)),
  };
}

/** `{low, high}` from whatever shape a row or a reading carries, or null. */
function entryBoundsOf(value) {
  if (!value || typeof value !== 'object') return null;
  const low = Number(value.low);
  const high = Number(value.high);
  return Number.isFinite(low) && Number.isFinite(high) ? { low, high } : null;
}

/**
 * Decide what to do with an edit, given the row it belongs to and the reading of the new text.
 *
 * The plan is data: `index.js` writes it, and nothing in this file knows SQL exists. That is what makes the four
 * rules testable without a database, and what keeps the UPDATE and the INSERT from growing two copies of one
 * judgement - the two statements share everything after this function returns.
 *
 * @typedef {Object} PlanSignalEditInput
 * @property {Record<string, any>|null} [row] - the row the original message was captured into, in the table's own
 *   column names, or null when this workspace has no row for that `telegram_message_id` (the post was edited
 *   before it was ever seen, or the row has since been purged)
 * @property {Record<string, any>|null} [parsed] - the edited text's own reading
 * @property {Record<string, any>|null} [review] - the pipeline's review verdict for the edited text
 * @property {Record<string, any>|null} [provenance] - how the edited text was read
 * @property {string} [savedText] - the text about to be stored, already truncated the way capture truncates
 * @property {string|number|null} [editedAt] - the message's own edit stamp, in the seconds Telegram uses
 * @returns {SignalEditPlan} one shape for five answers, declared in `types/app.d.ts` because the writer that
 *   reads it lives in another file
 */
export function planSignalEdit(/** @type {PlanSignalEditInput} */ { row = null, parsed = null, review = null, provenance = null, savedText = '', editedAt = null } = {}) {
  const stamp = Number(editedAt);
  const editedAtIso = Number.isFinite(stamp) && stamp > 0 ? new Date(stamp * 1000).toISOString() : null;
  // No row to correct: the ordinary capture path writes this message as though it had just arrived, and
  // `edited_at` is what records that the text it stored was already a correction.
  if (!row) return { action: 'insert', editedAt: editedAtIso };
  if (!isEditAppliedTo(row)) {
    return {
      action: 'refuse',
      reason: 'ALREADY_MOVING',
      editedAt: editedAtIso,
      row,
      detail: `the row is \`${row.status}\`, and those numbers are what an order was built from`,
    };
  }
  const merge = mergeEditedReading({ row, parsed });
  const textChanged = String(savedText || '') !== String(row.message ?? '');
  const base = { editedAt: editedAtIso, textChanged, filled: merge.filled, dropped: merge.dropped, lost: merge.lost, changedColumns: merge.changedColumns };

  // Rule 4, and the shape of every refusal this file has not specifically imagined: a reading that drops a price
  // the row holds does not get to be the row's reading. The text still moves, because the text is what the channel
  // is showing, and a reader comparing the card with the post has to see the same words.
  if (merge.lost.length) {
    return { ...base, action: 'text', reason: 'REFUSES_TO_DROP_A_PRICE', row, reading: null, columns: null };
  }
  if (!merge.changedColumns.length) {
    // Nothing in the reading moved. The row keeps its verdict, its provenance and its eligibility, and the only
    // column that changes is the one that records what the message says now - which is why a provider fixing a
    // typo cannot demote a signal into `needs_review` by phrasing it oddly, and cannot promote one by re-wording.
    return { ...base, action: textChanged ? 'text' : 'none', reason: textChanged ? 'WORDING_ONLY' : 'NO_CHANGE', row, reading: null, columns: null };
  }

  /* Rule 3. A price moved, so how that price was obtained has to move with it: when the edited text is the thing
     that finished the signal, the row's verdict is the verdict about the edited text - `parsedBy: 'regex'`,
     `required: false` for a message Layer 1 read on its own, which is exactly what turns a row that was blocked
     for a missing stop into one the engine may trade. When only a non-price field moved, the stored verdict still
     describes these numbers, so it is carried over as it stands rather than re-decided. */
  const verdict = merge.legsChanged
    ? {
      review: review || { required: false, reason: null, code: null, technical: null },
      provenance: provenance || { llmUsed: false, parsedBy: 'regex', confidence: null, filled: merge.filled, dropped: merge.dropped },
    }
    : {
      review: { required: row.needs_review === true, reason: row.parse_error || null, code: null, technical: null },
      provenance: { llmUsed: row.llm_used === true, parsedBy: row.parsed_by || 'regex', confidence: row.parse_confidence ?? null, filled: [], dropped: merge.dropped },
    };
  return {
    ...base,
    action: 'update',
    reason: null,
    row,
    reading: merge.reading,
    columns: merge.columns,
    legsChanged: merge.legsChanged,
    review: verdict.review,
    provenance: verdict.provenance,
    /* Whether the write re-runs the eligibility policy or carries the row's own. The same test as rule 3, for the
     same reason: a wording-only edit has to be able to refresh a row without promoting it. A row can hold all
     three legs and still not be executable - the workspace's rules moved since it was written, or a person fixed
     a column - and re-deciding that on the strength of a typo fix is the channel's edit doing something the
     channel did not ask for. */
    eligibility: merge.legsChanged ? 'recompute' : 'stored',
    /** The one edit a trader will care about: this row could not be traded, and now it can be decided again. */
    wasBlocked: row.execution_ready !== true,
  };
}
