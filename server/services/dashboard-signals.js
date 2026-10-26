/**
 * What the Overview shows under "Recent signals".
 *
 * The dashboard used to quote the ten most recent captured messages, whatever they were. On a workspace
 * wired to a busy channel that meant a wall of text: news bulletins, performance recaps, and rows whose
 * only content is the parser's refusal - because a message that could not be read as a signal is captured
 * all the same, and it is stored, and it is recent. A summary screen became a log dump, and the one thing
 * the screen exists to show - a setup that could actually be traded - was somewhere in the middle.
 *
 * Both lists are annotated here as well as chosen here. A row's note is a claim about the workspace's *live*
 * settings - is the switch on, is the plan paid, is there an account - so a read that returns a stored sentence
 * returns a claim that may have stopped being true the moment the user opened Billing. `readDashboardSignals`
 * therefore takes the same re-decision the Signals tab performs, and the route is not handed the raw rows: a
 * surface cannot forget a step it cannot see.
 *
 * So the dashboard asks for something different from the Signals page, and the difference is stated here
 * rather than embedded in a route:
 *
 *   - **three rows, not ten.** The Overview is a glance; the full history is one click away on the Signals
 *     tab, whose `View all` button already points there.
 *   - **actionable rows first, and only actionable rows when there are any.** A message is actionable when
 *     it was read as a signal at all (`execution_ready`) or has outgrown the "could not be parsed" label -
 *     a row the engine was told about, whatever it decided. `status = 'unparsed'` with a refusal recorded
 *     against it is the noise, and it is what the panel is not for.
 *   - **a fallback, not a blank.** When a workspace has nothing tradeable, showing an empty box invites the
 *     conclusion that capture is broken. The three most recent messages are shown instead, and the caller is
 *     told that is what happened, so the panel can say so in one line instead of leaving the user to guess.
 */

/** The most recent messages this screen will ever hold. The Signals page has no such limit. */
export const DASHBOARD_SIGNAL_LIMIT = 3;

/** The columns the Overview card renders, aliased the way the client reads them. */
export const DASHBOARD_SIGNAL_COLUMNS = `id,channel_title AS "channelTitle",source,message,symbol,side,entry_price AS "entryPrice",stop_loss AS "stopLoss",take_profit AS "takeProfit",direction_inferred AS "directionInferred",execution_ready AS "executionReady",parse_error AS "parseError",execution_note AS "executionNote",status,created_at AS "createdAt",
  needs_review AS "needsReview",parsed_by AS "parsedBy",parse_confidence AS "parseConfidence",
  llm_used AS "llmUsed",stop_loss_pips AS "stopLossPips",take_profit_pips AS "takeProfitPips",
  order_type AS "orderType",order_type_stated AS "orderTypeStated",is_scalping AS "isScalping",expiry_timestamp AS "expiryTimestamp",
  entry_range AS "entryRange"`;

/* Which rows are worth a place on a summary screen, decided against the production table rather than
 * against the column names that look like they would work:
 *
 *   - `status <> 'unparsed'` and `parse_error IS NULL` are useless here on their own. On a live workspace,
 *     all 45 captured rows are `status = 'unparsed'` (nothing has been executed yet) and 43 of the 45 have
 *     no `parse_error` at all, because a refusal sentence is only recorded when the parser knew enough to
 *     write one. Either clause lets almost the whole wall through.
 *   - "the parser found something" is not a setup either. The same 45 rows include promotional posts that
 *     yielded `side = 'buy'` (from "REASON WHY ATC BUY GOLD") and even `symbol = 'SHOULD'` (from "Should I
 *     show you why I decided to BUY?"). Words are copyable; a channel's own sales pitch has them.
 *   - a *price* is the line. Of those 45 rows, not one carried `entry_price`, `stop_loss` or `take_profit`.
 *     A message that states a number to act on is a setup, and a workspace whose channels have only been
 *     talking has nothing actionable at all - which is when the fallback below earns its place.
 *
 * So a row is shown when the server itself thought it tradeable, when it entered the execution lifecycle for
 * any outcome, or when it names a price. This is deliberately stricter than the client's
 * `signalHasTradingData`, which answers a different question: whether a row may be labelled "No clear
 * signal" at all. A row with a direction and no price is honest there - it says "Needs review" - and does
 * not belong on a summary screen.
 */
const STATES_A_PRICE = 'entry_price IS NOT NULL OR stop_loss IS NOT NULL OR take_profit IS NOT NULL';
const ACTIONABLE_FILTER = `AND (execution_ready = TRUE OR status <> 'unparsed' OR ${STATES_A_PRICE})`;

/** The actionable list, newest first. */
export function buildDashboardActionableSignalsQuery() {
  return {
    sql: `SELECT ${DASHBOARD_SIGNAL_COLUMNS} FROM signals WHERE user_id=$1 ${ACTIONABLE_FILTER} ORDER BY created_at DESC LIMIT ${DASHBOARD_SIGNAL_LIMIT}`,
    params: 1,
  };
}

/** The same window over every captured message, for a workspace with nothing tradeable yet. */
export function buildDashboardRecentSignalsQuery() {
  return {
    sql: `SELECT ${DASHBOARD_SIGNAL_COLUMNS} FROM signals WHERE user_id=$1 ORDER BY created_at DESC LIMIT ${DASHBOARD_SIGNAL_LIMIT}`,
    params: 1,
  };
}

/**
 * The either/or, kept in one place so the rule and its wording cannot drift apart.
 *
 * Both queries are issued together - one round trip each, both bounded to three rows, no branch that sends
 * a different number of values to a different statement - and the choice is made here. `scope` is what the
 * client is told, because "showing your recent messages" is a sentence the panel can only print if the
 * server said which list it handed over.
 */
export function chooseDashboardSignals({ actionable = [], recent = [] } = {}) {
  if (actionable.length) return { rows: actionable.slice(0, DASHBOARD_SIGNAL_LIMIT), scope: 'actionable' };
  return { rows: recent.slice(0, DASHBOARD_SIGNAL_LIMIT), scope: 'recent' };
}

/**
 * The Overview's signal strip, read and annotated in one call.
 *
 * Both statements go out together - one round trip each, both bounded - and each list is re-decided against the
 * workspace as it is now before the either/or is made. The choice happens *after* annotation on purpose: a row
 * is actionable because of what it holds, not because of what it said about execution.
 *
 * `withLiveBlockers` is required rather than optional. Without it this function returns sentences the
 * workspace has outgrown, and every caller in the product is a trader looking at one.
 */
export async function readDashboardSignals({ pool, userId, withLiveBlockers } = {}) {
  if (!pool?.query) throw new TypeError('The dashboard signal read needs a pool to read from');
  if (typeof withLiveBlockers !== 'function') {
    throw new TypeError('The dashboard signal read needs the live-blocker reader, or its notes are history');
  }
  const [actionable, recent] = await Promise.all([
    pool.query(buildDashboardActionableSignalsQuery().sql, [userId]),
    pool.query(buildDashboardRecentSignalsQuery().sql, [userId]),
  ]);
  const [actionableLive, recentLive] = await Promise.all([
    withLiveBlockers(userId, actionable.rows),
    withLiveBlockers(userId, recent.rows),
  ]);
  return chooseDashboardSignals({ actionable: actionableLive, recent: recentLive });
}
