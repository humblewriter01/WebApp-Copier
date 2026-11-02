/**
 * That a workspace starts with Auto-Trading off, and that nothing in the schema can put it back on.
 *
 * `auto_trading_enabled` decides whether a signal becomes an order at a broker. It was `DEFAULT TRUE`, which is the
 * wrong way round for a column with that consequence: a signup created the settings row, inherited the default, and
 * the workspace was executing live trades with real money before its owner had opened a single panel. Every guard
 * built to protect that switch was passed without anyone using it - `PUT /api/settings` refuses an *increase*
 * without the risk acknowledgement, and the panel asks before raising the switch - and an account born already on
 * performs no increase, so neither gate was ever reached on the path that mattered.
 *
 * The three places that answer "is auto-trading on for a row that has just been created" are pinned here to agree:
 * the column default, the signup insert, and the read fallback in `GET /api/settings`. They were not always
 * consistent - the last said `false` while the first said `TRUE`, which is how a default like this survives: any one
 * of them read alone looks fine.
 *
 * The second half is the part a `DEFAULT FALSE` change usually gets wrong: an upgrade must not touch the traders
 * who had already switched themselves on. That is argued from the shape of the migration, not asserted as a hope -
 * `ADD COLUMN IF NOT EXISTS` is a no-op on a table that already has the column, `ALTER COLUMN … SET DEFAULT`
 * changes only what the next insert inherits, and there is no `UPDATE` of this column anywhere in the schema.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { schemaStatements } from '../db.js';

const SERVER = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const indexSource = fs.readFileSync(path.join(SERVER, 'index.js'), 'utf8');
const statements = schemaStatements().map((sql) => sql.replace(/\s+/g, ' ').trim());
const COLUMN = 'auto_trading_enabled';

/** Every shipped statement that mentions the column at all, so "we only changed the default" cannot hide a third one. */
const about = statements.filter((sql) => new RegExp(`\\b${COLUMN}\\b`).test(sql));
const added = about.filter((sql) => /^ALTER TABLE settings ADD COLUMN IF NOT EXISTS auto_trading_enabled\b/.test(sql));
const altered = about.filter((sql) => /^ALTER TABLE settings ALTER COLUMN auto_trading_enabled SET DEFAULT\b/.test(sql));
const defaultOf = (sql, at) => { const m = /DEFAULT\s+('[^']*'|[a-z0-9_.]+)/i.exec(sql); assert.ok(m, `${at} states a default`); return m[1].replace(/'/g, '').toUpperCase(); };

test('the column that arms live execution is created off, and no other statement speaks for it', () => {
  assert.equal(added.length, 1, 'exactly one ADD for this column');
  assert.equal(altered.length, 1, 'exactly one SET DEFAULT for this column');
  assert.equal(about.length, 2, `only those two, and nothing else in the schema mentions ${COLUMN}: ${about.join(' | ')}`);
  assert.equal(defaultOf(added[0], 'the new-table default'), 'FALSE', 'a first deploy starts every workspace with execution off');
  assert.equal(defaultOf(altered[0], 'the inherited default'), 'FALSE', 'an upgrade changes what the next row inherits, and only downward');
  assert.match(added[0], /NOT NULL/, 'a settings row cannot hold an unknown answer, because absent has to mean off');
  assert.doesNotMatch(
    statements.find((sql) => /^CREATE TABLE IF NOT EXISTS settings\b/.test(sql)) || '',
    new RegExp(COLUMN),
    'the table itself does not carry a competing default, so the ADD above is the statement that actually decides a fresh database',
  );
});

test('the migration rewrites no row, so a trader who switched it on stays on', () => {
  /* The two shapes are chosen for this property. An `UPDATE` would decide, for every account in the database, what
     the owner had decided for themselves - arming those who never were, or disarming those who were. */
  assert.ok(added[0].includes('IF NOT EXISTS'), 'adding to a table that already has the column does nothing at all');
  assert.match(altered[0], /^ALTER TABLE settings ALTER COLUMN auto_trading_enabled SET DEFAULT FALSE$/, 'a default change touches future inserts, never stored rows');
  assert.ok(!statements.some((sql) => /\bUPDATE settings\b/i.test(sql) && new RegExp(COLUMN).test(sql)), 'no backfill of this column exists in the schema');
  // A `WHERE s.auto_trading_enabled=TRUE` filter is how the engine finds the armed workspaces and must stay; what
  // must not exist is a route that *writes* TRUE into rows nobody asked about.
  assert.ok(!/UPDATE\s+settings[\s\S]{0,120}auto_trading_enabled\s*=\s*TRUE/i.test(indexSource), 'and no route backfills it either');

  // Same fact, modelled: Postgres applies a column default to a row that does not name the column and never to one
  // that already stores a value, so the stored TRUE of an opted-in workspace survives the upgrade untouched.
  assert.equal(applyDefaults({}, [added[0]])[COLUMN], false, 'a row created by an insert that omits it inherits FALSE');
  assert.equal(applyDefaults({ [COLUMN]: true }, [added[0]])[COLUMN], true, 'a row that already says TRUE is left alone');
});

/** Apply the schema's defaults to a row the way Postgres does: only columns the insert did not name get one. */
function applyDefaults(row, sqls) {
  const out = { ...row };
  for (const sql of sqls) {
    const m = sql.match(/ADD COLUMN IF NOT EXISTS (\w+) [^;]*/i);
    if (m && !(m[1] in out)) out[m[1]] = cast(defaultOf(sql, 'statement'));
  }
  return out;
}
const cast = (literal) => (literal === 'FALSE' ? false : literal === 'TRUE' ? true : Number.isNaN(Number(literal)) ? literal : Number(literal));

test('signup writes the safe value itself instead of inheriting it', () => {
  const register = indexSource.slice(indexSource.indexOf("app.post('/api/auth/register'"));
  const block = register.slice(0, register.indexOf('INSERT INTO settings') + 400);
  const insert = /INSERT INTO settings\(([^)]*)\)\s*VALUES\(([^)]*)\)([^']*)/.exec(block);
  assert.ok(insert, 'the signup insert is found in the registration route');
  const columns = insert[1].split(',').map((s) => s.trim());
  const values = insert[2].split(',').map((s) => s.trim());
  assert.equal(columns.length, values.length, 'one value per column, or the insert is not what it looks like');
  assert.ok(columns.includes(COLUMN), 'a new settings row names the column, so its value does not depend on a default');
  assert.equal(values[columns.indexOf(COLUMN)].toUpperCase(), 'FALSE', 'and names it FALSE');

  const named = columns.map((column, i) => ({ column, value: values[i] })).filter((part) => !part.value.startsWith('$'));
  const asPostgresWould = applyDefaults(Object.fromEntries(named.map((part) => [part.column, cast(part.value)])), about);
  assert.equal(asPostgresWould[COLUMN], false, 'the row that exists the moment the transaction commits is an unarmed one');
  // Written inside the same transaction as the user row, so a workspace never exists without its settings row - and
  // `ON CONFLICT DO NOTHING`, so a re-run of the bridge cannot overwrite the choices of an account that already has one.
  assert.ok(block.indexOf('BEGIN') < block.indexOf('INSERT INTO settings'), 'after BEGIN');
  assert.match(block.slice(block.indexOf('INSERT INTO settings')), /ON CONFLICT DO NOTHING/, 'idempotent');
});

test('the read fallback agrees with the column, and the increase is still refused without the acknowledgement', () => {
  assert.match(indexSource, /autoTradingEnabled: false/, 'GET /api/settings says false for a workspace with no row');
  assert.doesNotMatch(indexSource, /autoTradingEnabled: true[,}]/, 'and no read path defaults upward - that fallback is the contradiction this file exists to close');
  assert.match(indexSource, /if \(autoTradingEnabled\) \{[\s\S]{0,400}Confirm the live-trading warning before Auto-Trading is turned on\. Nothing has been changed\./,
    'the server still makes the confirmation mandatory for an increase, which is the gate a new workspace now reaches on its first switch upward');
  assert.match(indexSource, /Auto-Trading is off by default for new workspaces; review your Risk Settings and confirm the live-trading warning before turning it on\./,
    'the dashboard status message agrees with the safe default and explicit-confirmation flow');
});
