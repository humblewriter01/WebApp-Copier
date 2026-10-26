import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { schemaStatements } from '../db.js';
import { BACKFILL_COLUMNS } from '../services/signal-backfill.js';
import { buildDashboardRecentSignalsQuery, buildDashboardActionableSignalsQuery } from '../services/dashboard-signals.js';

/*
 * A hand-written SQL string has no compiler between the typo and the outage. This codebase shipped one: the
 * admin signals column list lost its `s.` prefixes and gained them on the end - `parsed_bys. AS "parsedBy"` -
 * which is not a wrong number or a missing row but a syntax error that fires the moment an administrator
 * opens the page. Nothing caught it, because that route is never exercised with a fake pool, and a JS syntax
 * check is indifferent to the contents of a string literal.
 *
 * Two guards, both at the level the failure happened at:
 *
 *  1. no column reference in an alias list ends in a dot;
 *  2. every column a signal column list reads is declared in `SCHEMA_SQL`, and every column the capture path
 *     writes is too - which is also the check that a new column is not added to a SELECT and forgotten in the
 *     migration, a failure that only shows up on a database that has already been created.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.join(here, '..');
const indexSource = readFileSync(path.join(serverRoot, 'index.js'), 'utf8');

function declaredColumns(table) {
  const columns = new Set();
  for (const statement of schemaStatements()) {
    if (new RegExp(`^\\s*CREATE TABLE IF NOT EXISTS ${table}\\s*\\(`, 'i').test(statement)) {
      for (const line of statement.split('\n')) {
        const match = /^\s*([a-z_]+)\s+(?:TEXT|NUMERIC|BOOLEAN|INTEGER|SMALLINT|BIGINT|JSONB|TIMESTAMPTZ|DATE|UUID|VARCHAR)/i.exec(line);
        if (match) columns.add(match[1]);
      }
      continue;
    }
    for (const match of statement.matchAll(new RegExp(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ([a-z_]+)`, 'gi'))) columns.add(match[1]);
  }
  assert.ok(columns.size > 3, `no columns were declared for ${table}`);
  return columns;
}

const TABLES = {
  s: declaredColumns('signals'),
  t: declaredColumns('trades'),
  u: declaredColumns('users'),
  bm: declaredColumns('break_even_moves'),
  l: declaredColumns('trade_tp_levels'),
};

const aliasList = (name, end = '`') => {
  const start = indexSource.indexOf(`const ${name} = `);
  assert.notEqual(start, -1, `${name} was not found in index.js, so this test is no longer reading the list it was written for`);
  const open = indexSource.indexOf('`', start);
  const close = indexSource.indexOf(end, open + 1);
  return indexSource.slice(open + 1, close);
};

test('a signal column list never contains a column reference with a dangling prefix', () => {
  const lists = {
    adminSignalColumns: aliasList('adminSignalColumns'),
    saveSignalColumns: indexSource.match(/INSERT INTO signals\(([\s\S]*?)\)\s*\n\s*VALUES/)[1],
    recentSignals: buildDashboardRecentSignalsQuery({ limit: 20, offset: 0 }).sql,
    actionableSignals: buildDashboardActionableSignalsQuery({ limit: 20 }).sql,
  };
  for (const [label, sql] of Object.entries(lists)) {
    for (const entry of sql.replace(/\s+/g, ' ').split(',')) {
      const candidate = entry.trim();
      // `parsed_bys. AS "parsedBy"` is the shape: a name, a dot, then the alias with nothing in between.
      assert.equal(
        /^[a-z_]+\.\s+AS\s+"/i.test(candidate) || /[a-z_]+\.\s*$/.test(candidate.split(/\s+AS\s+/)[0]),
        false,
        `${label} contains "${candidate}" - a column reference whose table prefix was lost, which Postgres refuses to parse at request time.`,
      );
    }
  }
});

test('every column the admin signals list reads is declared in the schema', () => {
  const sql = aliasList('adminSignalColumns');
  const seen = new Set();
  for (const match of sql.matchAll(/\b([a-z]+)\.([a-z_]+)\b/g)) {
    const [, alias, column] = match;
    const table = TABLES[alias];
    if (!table) continue;
    seen.add(`${alias}.${column}`);
    assert.ok(table.has(column), `adminSignalColumns reads ${alias}.${column}, which ${alias === 's' ? 'signals' : alias} does not declare`);
  }
  // The bug this file exists for was in the parser-era columns; if the list ever stops referencing them the
  // check above has stopped covering them, so say so here instead of quietly passing.
  for (const column of ['parsed_by', 'needs_review', 'order_type', 'is_scalping', 'expiry_timestamp']) {
    assert.ok(seen.has(`s.${column}`), `adminSignalColumns no longer reads s.${column}`);
  }
});

test('the capture path writes only columns the signals table declares', () => {
  const insert = indexSource.match(/INSERT INTO signals\(([\s\S]*?)\)\s*\n\s*VALUES/)[1];
  const columns = new Set(insert.split(/[,\n]/).map((entry) => entry.trim()).filter(Boolean));
  const declared = TABLES.s;
  for (const column of columns) {
    assert.ok(declared.has(column), `signals INSERT writes ${column}, which the schema does not declare`);
  }
  // The order type is stored on the row rather than re-derived at execution time, so a parser change can
  // never silently alter a trade somebody had already reviewed. Both halves of that have to exist.
  assert.ok(columns.has('order_type') && columns.has('is_scalping'));
});

test('the backfill writes only stored signal columns, and never a live one', () => {
  for (const column of BACKFILL_COLUMNS) {
    assert.ok(TABLES.s.has(column), `the backfill would write ${column}, which the signals table does not declare`);
  }
  // An expiry timestamp belongs to an order that has been placed. A re-parse has not placed one, and
  // rewriting it would either cancel a live order or extend one nobody asked about.
  assert.equal(BACKFILL_COLUMNS.includes('expiry_timestamp'), false);
  assert.equal(BACKFILL_COLUMNS.includes('status'), false, 'a re-parse never touches the outcome columns of a row that has already traded');
});

test('the dashboard signal queries read declared columns', () => {
  for (const build of [buildDashboardRecentSignalsQuery, buildDashboardActionableSignalsQuery]) {
    const sql = build({ limit: 20, offset: 0 }).sql;
    for (const match of sql.matchAll(/(?:^|[\s,(])([a-z_]+)\s+AS\s+"/gm)) {
      const column = match[1];
      if (['count', 'max', 'min', 'json_agg', 'json_build_object', 'coalesce', 'left', 'array_agg'].includes(column)) continue;
      assert.ok(TABLES.s.has(column), `a dashboard query selects ${column} from signals, which does not declare it`);
    }
  }
});

test('the two signal lists the workspace reads are ordered newest first, in SQL', () => {
  /* "The newest signal is not at the top" cannot be a sorting bug in the browser, because the client never
     sorts: it renders the rows in the order the query returned them, and the live feed merges a pushed row into
     that same order. So the order is a property of these two statements, and both of them have to keep it -
     the Signals tab and the Overview would otherwise be able to disagree about which message is the latest. */
  assert.match(indexSource, /FROM signals WHERE user_id=\$1 ORDER BY created_at DESC LIMIT \$2/, 'the signals page is one bounded query, newest first, that the client can render as-is');
  const dashboard = readFileSync(new URL('../services/dashboard-signals.js', import.meta.url), 'utf8');
  const ordered = dashboard.match(/ORDER BY created_at DESC LIMIT \$?\{?[A-Z_]+\}?/g) || [];
  assert.equal(ordered.length, 2, 'both dashboard queries - the actionable list and the recent one - carry the same ordering');
  assert.equal(/ORDER BY created_at ASC|ORDER BY created_at\b(?! DESC)/.test(dashboard), false, 'and neither quietly flips to oldest first');
  assert.equal(/signals\.sort\(|\.sort\(\(a, b\) => a\.createdAt/.test(readFileSync(path.join(here, '..', '..', 'client', 'src', 'App.jsx'), 'utf8')), false, 'the client renders this order rather than inventing its own');
});

test('no camelCase alias in any server statement is left unquoted', () => {
  /* `AS autoTrading` is not a style choice and no linter says so: the statement is a string, and Postgres
     answers an unquoted alias with `autotrading`. The row then has no `autoTrading` key, `=== true` is false,
     and every decision built from that row is built on `undefined` - in this codebase that meant a workspace's
     Auto-Trading switch, its plan, its account, its safety switches and its fallback distances, silently
     reading as off. Two shipped instances of it, both invisible to a suite whose fake pools returned whatever
     keys the code asked for. So the shape of the alias is checked in every statement, in every file, here. */
  const files = ['index.js', 'db.js', ...readdirSync(path.join(here, '..', 'services')).filter((name) => name.endsWith('.js')).map((name) => `services/${name}`)];
  const offenders = [];
  for (const file of files) {
    const source = readFileSync(path.join(here, '..', file), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    for (const literal of source.match(/'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g) || []) {
      if (!/\b(SELECT|UPDATE|INSERT|WITH)\b/i.test(literal)) continue;
      for (const match of literal.matchAll(/\bAS\s+([A-Za-z_][A-Za-z0-9_]*)/g)) {
        if (/[A-Z]/.test(match[1])) offenders.push(`${file}: AS ${match[1]}`);
      }
    }
  }
  assert.deepEqual(offenders, [], 'every camelCase alias in a statement is double-quoted');
});
