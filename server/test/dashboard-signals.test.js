/**
 * The Overview's signal list, which is a different question from the Signals page's.
 *
 * A summary screen that quotes ten captured messages verbatim is a log dump: on a busy channel the setups
 * the user came for are somewhere in the middle of the news bulletins. So this route is short, prefers the
 * rows that could actually be traded, and says which of the two it is returning. These tests hold those three
 * promises, because each one is a sentence the client prints or an index the query planner uses, and neither
 * is visible from the route itself.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DASHBOARD_SIGNAL_LIMIT,
  DASHBOARD_SIGNAL_COLUMNS,
  buildDashboardActionableSignalsQuery,
  buildDashboardRecentSignalsQuery,
  chooseDashboardSignals,
  readDashboardSignals,
} from '../services/dashboard-signals.js';
import { AUTO_TRADING_OFF_NOTE, PLAN_NO_EXECUTION_NOTE, createSignalOutcomeReader } from '../services/signal-outcome.js';
import { assertQueryParameters } from '../services/query-params.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const routes = readFileSync(path.join(here, '..', 'index.js'), 'utf8');

test('the Overview shows three signals, and the Signals page is untouched', () => {
  assert.equal(DASHBOARD_SIGNAL_LIMIT, 3);
  for (const build of [buildDashboardActionableSignalsQuery, buildDashboardRecentSignalsQuery]) {
    const { sql } = build();
    assert.match(sql, new RegExp(`LIMIT ${DASHBOARD_SIGNAL_LIMIT}$`), 'the query itself is bounded, not just the render');
    assert.equal(sql.includes('LIMIT 10'), false, 'the old ten-row wall is gone from both branches');
  }
  // The full history is a separate route, and it must stay that way: shortening the dashboard by shrinking
  // `/api/signals` would take the history away instead of tidying the summary.
  assert.match(routes, /FROM signals WHERE user_id=\$1 ORDER BY created_at DESC LIMIT \$2/, 'the Signals page keeps its own limit');
});

test('the filter asks for setups, and the fallback asks for whatever arrived', () => {
  const { sql: actionable } = buildDashboardActionableSignalsQuery();
  assert.match(actionable, /execution_ready = TRUE/, 'the server\'s own verdict at the moment the row was written');
  assert.match(actionable, /status <> 'unparsed'/, 'or a row that entered the execution lifecycle, whatever it decided there');
  for (const price of ['entry_price', 'stop_loss', 'take_profit']) {
    assert.match(actionable, new RegExp(`${price} IS NOT NULL`), `or a stated ${price}, which is what separates a setup from a sales pitch`);
  }
  // The two clauses that look right and are not, on the live data: every row is 'unparsed', and almost none
  // carry a parse_error. Naming them here keeps the next reader from "simplifying" the filter back to them.
  assert.equal(actionable.includes('parse_error IS NULL'), false, 'a missing refusal sentence is not evidence of a setup');
  assert.equal(actionable.includes('symbol IS NOT NULL'), false, 'and a symbol word alone was matched by a promo post that said "Should I show you"');
  assert.equal(actionable.includes('side IS NOT NULL'), false, 'as was a direction, from "REASON WHY ATC BUY GOLD"');

  const { sql: recent } = buildDashboardRecentSignalsQuery();
  assert.equal(recent.includes('execution_ready = TRUE'), false, 'the fallback is deliberately unfiltered');
  assert.match(recent, /ORDER BY created_at DESC/, 'both branches are newest-first');
});

test('a workspace with nothing priced falls back instead of showing a filtered wall', () => {
  // The shape of the live table: rows captured, none execution-ready, none with a price.
  const hype = (id, message) => ({ id, status: 'unparsed', symbol: null, side: 'buy', message, parseError: null });
  const actionableRows = [hype('a'), hype('b')].filter((row) => row.status !== 'unparsed' || row.executionReady || row.entryPrice != null || row.stopLoss != null || row.takeProfit != null);
  assert.deepEqual(actionableRows, [], 'the same three clauses the SQL runs reject both of these rows');
  const chosen = chooseDashboardSignals({ actionable: actionableRows, recent: [hype('a'), hype('b'), hype('c'), hype('d')] });
  assert.equal(chosen.scope, 'recent');
  assert.deepEqual(chosen.rows.map((row) => row.id), ['a', 'b', 'c'], 'three of the recent messages, not the four that arrived');
});

test('both queries bind exactly one value, so the route can pass both in one fan-out', () => {
  for (const build of [buildDashboardActionableSignalsQuery, buildDashboardRecentSignalsQuery]) {
    const { sql, params } = build();
    assert.equal(params, 1);
    assert.doesNotThrow(() => assertQueryParameters(sql, ['user-id'], 'dashboard signals'));
    for (const column of ['"channelTitle"', '"entryPrice"', '"stopLoss"', '"takeProfit"', '"executionNote"', '"createdAt"']) {
      assert.ok(sql.includes(column), `the card needs ${column}`);
    }
  }
  assert.equal(DASHBOARD_SIGNAL_COLUMNS.includes('message'), true, 'the message is still sent, because the card truncates it rather than the server dropping it');
});

test('setups win, and only three of them', () => {
  const setup = (id) => ({ id, status: 'executed', message: 'BUY EURUSD' });
  const noise = (id) => ({ id, status: 'unparsed', message: 'Weekly performance recap…' });

  const preferred = chooseDashboardSignals({ actionable: [setup('a'), setup('b')], recent: [setup('a'), noise('n'), setup('b')] });
  assert.deepEqual(preferred.rows.map((row) => row.id), ['a', 'b'], 'the noise row in the middle of the recent list does not reach the dashboard');
  assert.equal(preferred.scope, 'actionable');

  const fallback = chooseDashboardSignals({ actionable: [], recent: [noise('n1'), noise('n2')] });
  assert.deepEqual(fallback.rows.map((row) => row.id), ['n1', 'n2'], 'with nothing tradeable the panel shows recent traffic rather than an empty box');
  assert.equal(fallback.scope, 'recent', 'and says so, so the client can print that sentence instead of the user guessing');

  const crowded = chooseDashboardSignals({ actionable: [setup('1'), setup('2'), setup('3'), setup('4'), setup('5')], recent: [] });
  assert.deepEqual(crowded.rows.map((row) => row.id), ['1', '2', '3'], 'a caller that passes more still gets the dashboard limit');

  const nothing = chooseDashboardSignals({});
  assert.deepEqual(nothing.rows, []);
  assert.equal(nothing.scope, 'recent', 'an empty workspace is described as "nothing actionable", which is true, and the Telegram empty state takes over');
});

test('the dashboard read owns both lists and the re-decision, and the route cannot skip either', () => {
  const service = readFileSync(path.join(here, '..', 'services', 'dashboard-signals.js'), 'utf8');
  const start = service.indexOf('export async function readDashboardSignals');
  assert.notEqual(start, -1, 'the Overview strip is composed in one function');
  const block = service.slice(start, service.indexOf('\n}', start));
  assert.match(block, /pool\.query\(buildDashboardActionableSignalsQuery\(\)\.sql, \[userId\]\)/);
  assert.match(block, /pool\.query\(buildDashboardRecentSignalsQuery\(\)\.sql, \[userId\]\)/);
  assert.match(block, /Promise\.all\(\[\n\s*pool\.query\(buildDashboardActionableSignalsQuery/, 'both statements go out together, not one after the other');
  assert.match(block, /withLiveBlockers\(userId, actionable\.rows\)/, 'and both lists are re-read against the state the workspace is in now');
  assert.match(block, /withLiveBlockers\(userId, recent\.rows\)/, 'including the fallback list, which is the one a quiet workspace actually sees');
  assert.match(block, /chooseDashboardSignals\(\{ actionable: actionableLive, recent: recentLive \}\)/, 'picked after the re-read, never before');
  assert.match(block, /typeof withLiveBlockers !== 'function'[\s\S]*throw new TypeError/, 'a caller without the reader is refused rather than served stale');

  /* And the route is allowed to be boring, which is the point: it never sees an un-annotated row, so there is
     no step left inside it to forget. The overlay itself was always correct - it was the route that stopped
     calling it, and the trader kept a sentence their workspace had outgrown. Composition belongs where a test
     can drive it, so the raw statements, the pick and the reader all live above, and this handler's whole
     involvement is one call. */
  const at = routes.indexOf("app.get('/api/dashboard'");
  assert.notEqual(at, -1);
  const handler = routes.slice(at, routes.indexOf("\napp.get('", at + 1));
  assert.match(handler, /readDashboardSignals\(\{ pool, userId: req\.userId, withLiveBlockers \}\)/);
  assert.equal(handler.includes('withLiveBlockers('), false, 'the handler does not annotate a list itself, so it cannot annotate one of two');
  assert.equal(handler.includes('buildDashboard'), false, 'nor reaches past the service for the queries');
  assert.equal(/from '\.\/services\/dashboard-signals\.js'.*buildDashboard/s.test(routes), false, 'and the builders are not even imported by the server any more');
  assert.match(routes, /signals: dashboardSignals\.rows,/, 'the payload key the client already reads is unchanged');
  assert.match(routes, /signalsScope: dashboardSignals\.scope/, 'plus which list it is, so the wording cannot disagree with the query');
  assert.equal(routes.includes('ORDER BY created_at DESC LIMIT 10'), false, 'no ten-row dashboard query is left anywhere');
});

test('GET /api/dashboard on a legacy off-note row and a Free workspace answers with the plan sentence', async () => {
  /* The report, end to end: the switch is on, the plan is not, and the Overview still reads "Auto-Trading is
     off". Everything between the two is what the client calls, with the two statements the route issues and the
     same context read the route performs - no fake of the overlay in sight. */
  const legacy = {
    id: 'sig-1',
    source: 'telegram',
    message: 'XAUUSD SELL\nEntry 4016.70 - 4023.70\nSL: 4030\nTP 1: 4014.70',
    symbol: 'XAUUSD', side: 'sell', entryPrice: 4016.7, stopLoss: 4030, takeProfit: 4014.7,
    // The shape an older release wrote: the flag was the parser's verdict, and a row the workspace's own
    // conditions blocked arrived marked as though it had never been readable at all.
    executionReady: false,
    status: 'unexecuted',
    executionNote: AUTO_TRADING_OFF_NOTE,
    parseError: null,
  };
  const seen = [];
  let contextReads = 0;
  const pool = {
    async query(sql, params) {
      seen.push(sql);
      if (!sql.includes('FROM signals')) throw new Error(`unexpected statement: ${sql.slice(0, 60)}`);
      /* Only the actionable statement finds the row - `execution_ready` is false and the status is the one a
         refusal carries - which is how the Overview ends up on its fallback list, and why both lists have to
         be annotated rather than just the first. */
      const actionable = sql.includes('execution_ready = TRUE');
      return { rows: actionable ? [] : [legacy] };
    },
  };
  const reader = createSignalOutcomeReader({
    pool: {
      async query() {
        contextReads += 1;
        // Free plan, auto-trading on, an account deployed: the only thing missing is the plan.
        return { rows: [{ autoTrading: true, executionAccountId: 'acct-1', accountState: 'DEPLOYED', subscriptionStatus: 'free' }] };
      },
    },
    platformControls: { async read() { return { state: 'live' }; } },
    runtimeEnabled: () => true,
  });

  const dashboard = await readDashboardSignals({ pool, userId: 'user-1', withLiveBlockers: reader.withLiveBlockers });
  assert.equal(dashboard.scope, 'recent', 'the fallback list is what this workspace sees');
  assert.equal(dashboard.rows.length, 1);
  const [row] = dashboard.rows;
  assert.equal(row.executionNote, PLAN_NO_EXECUTION_NOTE, 'the card says the plan is what is missing, because the plan is what is missing');
  assert.equal(row.status, 'unexecuted', 'and only the sentence moved');
  assert.equal(row.executionReady, false, 'the stored verdict on the message is left for the reviewer to read');
  assert.equal(seen.filter((sql) => sql.includes('FROM signals')).length, 2, 'two bounded statements, as the Overview has always issued');
  assert.equal(contextReads, 1, 'read once for the whole strip - and once only, because the actionable list came back empty rather than full of rows to re-decide');
});

test('a workspace with nothing to re-decide is not a workspace worth a context read', async () => {
  // The overlay costs one query per list, and only when a row actually carries one of our sentences. A user who
  // polls the Overview every second and has nothing blocked must not pay for the guarantee.
  let contextReads = 0;
  const pool = {
    async query(sql) {
      if (sql.includes('FROM signals')) return { rows: [{ id: 'sig-2', source: 'telegram', executionReady: true, status: 'queued', executionNote: null, parseError: null }] };
      contextReads += 1;
      return { rows: [] };
    },
  };
  const reader = createSignalOutcomeReader({ pool, platformControls: { async read() { return { state: 'live' }; } }, runtimeEnabled: () => true });
  const dashboard = await readDashboardSignals({ pool, userId: 'user-1', withLiveBlockers: reader.withLiveBlockers });
  assert.equal(dashboard.rows[0].executionNote, null);
  assert.equal(contextReads, 0, 'nothing was re-decided, so nothing was read to decide it with');
});

test('the Overview selects the columns the re-decision reads', () => {
  /* A gate that looks at a column no query selects is a gate that is always false, which is how this bug
     survived its own unit tests. The list is therefore pinned against the reader's needs, in the projection
     the route actually uses, rather than against prose in a comment. */
  const keys = DASHBOARD_SIGNAL_COLUMNS.split(',').map((part) => {
    const alias = part.match(/AS "([^"]+)"/);
    return (alias ? alias[1] : part.trim().split(/\s+/).at(-1)).trim();
  });
  for (const needed of ['executionNote', 'parseError', 'source', 'executionReady', 'status', 'id', 'createdAt']) {
    assert.ok(keys.includes(needed), `${needed} is selected, or the overlay cannot see it`);
  }
});
