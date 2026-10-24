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
} from '../services/dashboard-signals.js';
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

test('the dashboard route asks for both and picks, rather than filtering in JavaScript', () => {
  assert.match(routes, /pool\.query\(buildDashboardActionableSignalsQuery\(\)\.sql, \[req\.userId\]\)/);
  assert.match(routes, /pool\.query\(buildDashboardRecentSignalsQuery\(\)\.sql, \[req\.userId\]\)/);
  assert.match(routes, /const dashboardSignals = chooseDashboardSignals\(\{ actionable: actionableSignals\.rows, recent: recentSignals\.rows \}\);/);
  assert.match(routes, /signals: dashboardSignals\.rows,/, 'the payload key the client already reads is unchanged');
  assert.match(routes, /signalsScope: dashboardSignals\.scope/, 'plus which list it is, so the wording cannot disagree with the query');
  assert.equal(routes.includes('ORDER BY created_at DESC LIMIT 10'), false, 'no ten-row dashboard query is left anywhere');
});
