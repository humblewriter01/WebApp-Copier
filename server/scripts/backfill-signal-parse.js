#!/usr/bin/env node
/**
 * Re-parse stored signals with the current parser - a maintenance command, not a route.
 *
 * Why a script and not a button: what it does is rewrite history in a controlled way, and the day that
 * history includes rows somebody has traded on, the guard is in the SQL rather than in someone's memory. It
 * is dry-run by default, and it will not touch a row that has a trade or an execution job beside it, at read
 * time *or* again at write time.
 *
 *   node scripts/backfill-signal-parse.js                        # read the database, report what would change
 *   node scripts/backfill-signal-parse.js --apply                # the same, writing it
 *   node scripts/backfill-signal-parse.js --user <uuid>         # one workspace only
 *   node scripts/backfill-signal-parse.js --dump-json rows.json # take the rows out, change nothing
 *   node scripts/backfill-signal-parse.js --from-json rows.json --emit-sql out.sql
 *                                                               # plan and SQL from a dump, no connection at all
 *
 * The last form exists because a host where the only way in is a query box is a normal situation, and it is
 * also the form that can be reviewed as a file before anyone runs it. A rollback script is written next to it
 * unconditionally: a change you cannot undo is not a maintenance task, it is a gamble.
 */

import 'dotenv/config';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { planBackfill, backfillStatements, backfillParameterized, describeChange, backfillSelect } from '../services/signal-backfill.js';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const option = (name) => {
  const index = argv.indexOf(`--${name}`);
  return index > -1 && argv[index + 1] && !argv[index + 1].startsWith('--') ? argv[index + 1] : null;
};

function usage(message) {
  if (message) console.error(`${message}\n`);
  console.error('Usage: node scripts/backfill-signal-parse.js [--apply] [--user <uuid>] [--limit <n>]');
  console.error('       node scripts/backfill-signal-parse.js --dump-json <path>');
  console.error('       node scripts/backfill-signal-parse.js --from-json <path> [--emit-sql <path>] [--apply]');
  process.exit(message ? 1 : 0);
}

const asRows = (value) => (Array.isArray(value) ? value : (Array.isArray(value?.rows) ? value.rows : null));

async function main() {
  if (flag('help')) usage(null);
  const fromJson = option('from-json');
  const toJson = option('dump-json');
  const sqlPath = option('emit-sql');
  const limit = Math.max(1, Number(option('limit') || 100_000) || 100_000);
  const userId = option('user');

  let rows = null;
  let pool = null;
  if (fromJson) {
    rows = asRows(JSON.parse(readFileSync(resolve(fromJson), 'utf8')));
    if (!rows) usage('--from-json expects an array of rows, or an object with a `rows` array.');
  }
  if (rows === null) {
    // Imported only when a database is genuinely needed, so a plan from a dump works with no connection
    // string in the environment at all.
    ({ pool } = await import('../db.js'));
    const { text, params } = backfillSelect({ userId });
    const { rows: fetched } = await pool.query(text, params);
    rows = fetched;
    if (toJson) {
      writeFileSync(resolve(toJson), `${JSON.stringify({ rows }, null, 2)}\n`);
      console.log(`${rows.length} candidate rows written to ${toJson}. Nothing was changed.`);
      return;
    }
  }

  const capped = rows.slice(0, limit);
  const plan = planBackfill(capped, { userId });
  console.log(`${capped.length} candidate rows · ${plan.changes.length} would change · ${plan.untouched} already current · ${plan.skipped} skipped (no message${userId ? ', other workspace' : ''})`);
  if (!plan.changes.length) {
    console.log('Nothing to do: every stored reading already matches what the current parser produces.');
    return;
  }
  for (const change of plan.changes) console.log(`\n${describeChange(change)}`);

  if (sqlPath) {
    const statements = backfillStatements(plan.changes);
    writeFileSync(resolve(sqlPath), `${statements.join(';\n')};\n`);
    // The undo script is generated from the values that were there before, with the same write-time guards,
    // so a rollback cannot land on a row that has since acquired a trade.
    // The rollback carries the same message guard as the forward run, for a reason worth stating: undoing a
    // backfill must only undo it on the row that was parsed. A change of heart on a row whose message has
    // since been edited would otherwise write 23 October values into a 24 October signal, and the point of a
    // rollback file is that it is safe to run blind.
    const rollback = backfillStatements(plan.changes.map((change) => ({
      id: change.id,
      message: change.message,
      sets: change.columns.map((column) => ({ column, value: change.before[column] })),
    })));
    const rollbackPath = `${resolve(sqlPath).replace(/\.sql$/, '')}.rollback.sql`;
    writeFileSync(rollbackPath, `${rollback.join(';\n')};\n`);
    console.log(`\n${statements.length} statements written to ${resolve(sqlPath)} (undo: ${rollbackPath}).`);
  }

  if (toJson && !fromJson) {
    writeFileSync(resolve(toJson), `${JSON.stringify({ rows: capped }, null, 2)}\n`);
    console.log(`Rows kept for review in ${resolve(toJson)}.`);
  }

  if (!flag('apply')) {
    console.log('\nDry run - nothing was written. Re-run with --apply, or run the emitted SQL.');
    return;
  }
  if (!pool) ({ pool } = await import('../db.js'));
  const statements = backfillParameterized(plan.changes);
  await pool.query('BEGIN');
  let updated = 0;
  try {
    for (const statement of statements) {
      const result = await pool.query(statement.text, statement.values);
      updated += Number(result.rowCount ?? 0);
    }
    await pool.query('COMMIT');
  } catch (error) {
    await pool.query('ROLLBACK').catch(() => {});
    console.error(`Rolled back without writing: ${error.message}`);
    process.exitCode = 1;
    return;
  }
  console.log(`\nApplied: ${updated} of ${statements.length} rows updated${updated < statements.length ? ' (the rest acquired a trade or a job, or disappeared, between read and write)' : ''}.`);
}

main().catch((error) => {
  console.error(`Backfill stopped before writing: ${error.message}`);
  process.exitCode = 1;
});
