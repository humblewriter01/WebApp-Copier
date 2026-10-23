import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  countQueryParameters,
  assertQueryParameters,
  queryArguments,
  withParameterChecks,
} from '../services/query-params.js';
import {
  buildUserAdminUpdate,
  buildSubscriptionGrantStatements,
  buildSubscriptionExtendStatement,
  buildSubscriptionReleaseStatements,
  buildSubscriptionMirrorStatement,
  SUBSCRIPTION_PERIOD_EXPRESSION,
} from '../services/admin.js';
import { createAnnouncementService, announcementColumns, announcementReturnColumns } from '../services/announcements.js';
import { createAuditLogger } from '../services/audit.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.join(here, '..');
const sources = ['index.js', 'db.js', ...readdirSync(path.join(serverRoot, 'services')).filter((name) => name.endsWith('.js')).map((name) => path.join('services', name))];

/* ------------------------------------------------------------------ the contract itself ------------------------------------------------------------------ */

test('the count Postgres prepares is the highest placeholder, not the number of tokens', () => {
  assert.deepEqual(countQueryParameters('SELECT * FROM t WHERE a=$1 OR b=$1 LIMIT $2'), { count: 2, occurrences: 3, used: [1, 2], unreferenced: [] });
  assert.deepEqual(countQueryParameters('SELECT 1'), { count: 0, occurrences: 0, used: [], unreferenced: [] });
  // A hole in the numbering means a value was dropped on the way in, which is the same bug wearing
  // a different hat: the statement still asks for $3 and the caller still has to supply it.
  assert.deepEqual(countQueryParameters('INSERT INTO t(a,b,c) VALUES($1,$3)').unreferenced, [2]);
});

test('a bind that does not match its statement is named instead of being left to the driver', () => {
  const sql = 'UPDATE users SET a=$1,b=$2 WHERE id=$3';
  assert.deepEqual(assertQueryParameters(sql, [1, 2, 3]), { count: 3, occurrences: 3, used: [1, 2, 3], unreferenced: [], values: 3, checked: true });

  // The exact production failure: a value with no slot.
  assert.throws(
    () => assertQueryParameters('UPDATE users SET a=$1 WHERE id=$2', ['a', 'b', 'c']),
    (error) => {
      assert.equal(error.code, 'QUERY_PARAMETER_MISMATCH');
      assert.match(error.message, /binds 2 parameters \(\$1-\$2\) but 3 values were supplied/);
      return true;
    },
  );
  // ...and its mirror: a slot with no value.
  assert.throws(
    () => assertQueryParameters('INSERT INTO t(a,b) VALUES($1,$2)', ['only one']),
    (error) => {
      assert.match(error.message, /binds 2 parameters \(\$1-\$2\) but 1 value was supplied/);
      return true;
    },
  );
  // A hole in the numbering is reported with the sentence that names the missing slot, because the
  // caller almost always has a value for it in hand and simply never passed it in.
  assert.throws(
    () => assertQueryParameters('UPDATE t SET a=$1 WHERE id=$3', ['a', 'id']),
    /binds 3 parameters \(\$1-\$3\) but 2 values were supplied; the statement never mentions \$2/,
  );
  // A gap that the caller did fill is legal to Postgres ($2 is an unused value), so it is described
  // by the shape rather than rejected: refusing it would turn working queries into failures.
  assert.deepEqual(countQueryParameters('UPDATE t SET a=$1 WHERE id=$3').unreferenced, [2]);
  assert.equal(assertQueryParameters('UPDATE t SET a=$1 WHERE id=$3', ['a', 'junk', 'id']).checked, true);

  // Nothing to compare, so nothing to complain about - these are legal calls.
  assert.equal(assertQueryParameters('SELECT NOW()').checked, false);
  assert.equal(assertQueryParameters('SELECT NOW()', []).count, 0);
  assert.equal(assertQueryParameters('SELECT $1', undefined).checked, false);
  assert.equal(assertQueryParameters('SELECT $1', () => {}).checked, false, 'a callback-style call is not a bind');
});

test('both pg call shapes are read, and only a text/values pair is compared', () => {
  assert.deepEqual(queryArguments('SELECT $1', [[7]]), { sql: 'SELECT $1', values: [7] }, 'the second argument is the value list');
  assert.deepEqual(queryArguments({ text: 'SELECT $1', values: [7] }), { sql: 'SELECT $1', values: [7] });
  assert.deepEqual(queryArguments({ query: 'SELECT $1', values: [7] }), { sql: 'SELECT $1', values: [7] });
  assert.deepEqual(queryArguments(() => {}, []), { sql: null, values: undefined });
});

test('the pool and the clients it hands out check every statement before sending it', async () => {
  const sent = [];
  const fake = {
    query(...args) { sent.push(args); return Promise.resolve({ rows: [], rowCount: 0 }); },
    async connect() {
      return { query(...args) { sent.push(args); return { rows: [], rowCount: 0 }; }, release() {} };
    },
  };
  withParameterChecks(fake, 'pool');
  await fake.query('SELECT $1', [1]);
  await fake.query({ text: 'SELECT $1', values: [1] });
  await fake.query('BEGIN');
  // Thrown at the call, before anything is written to the socket - the statement never runs.
  assert.throws(() => fake.query('SELECT $1', [1, 2]), /pool binds 1 parameter \(\$1-\$1\) but 2 values were supplied/);
  assert.equal(sent.length, 3, 'the rejected call never reached the database');

  const client = await fake.connect();
  assert.deepEqual(await client.query('UPDATE t SET a=$1 WHERE id=$2', ['x', 2]), { rows: [], rowCount: 0 });
  assert.throws(() => client.query('UPDATE t SET a=$1 WHERE id=$2', ['x']), /binds 2 parameters/);
  assert.deepEqual(sent.map(([first]) => (typeof first === 'string' ? first : first.text)), [
    'SELECT $1',
    'SELECT $1',
    'BEGIN',
    'UPDATE t SET a=$1 WHERE id=$2',
  ], 'every call that passed the check reached the driver, in order, and nothing else did');
  assert.equal(fake.__parameterChecksWrapped, true);
  assert.equal(withParameterChecks(fake) === fake, true, 'wrapping twice does not double-check or double-send');
});

/* ------------------------------------------------------------------ the three reported actions ------------------------------------------------------------------ */

function expectBound(statement, values, label) {
  assert.doesNotThrow(() => assertQueryParameters(statement.sql, statement.params, label), `${label} binds its values`);
  assert.deepEqual(statement.params.length, countQueryParameters(statement.sql).count, `${label}: every value has a slot and every slot has a value`);
  assert.deepEqual(values, statement.params, `${label} binds exactly these values`);
}

test('Adjust Plan: a grant by days and a grant to an explicit date bind the same five slots', () => {
  const plan = { key: 'pro', name: 'Pro', limits: { maxTelegramChannels: 20 } };

  // This is the shape that reached production broken: the period came from `days`, so the statement
  // was assembled without `$5` while the caller still supplied the (empty) end date.
  const byDays = buildSubscriptionGrantStatements({ targetId: 'u-1', plan, limits: plan.limits, interval: 'monthly', period: '14 days', endsAt: null });
  expectBound(byDays.subscription, ['u-1', 'pro', 'monthly', '14 days', null], 'Adjust Plan (grant, by days)');
  assert.ok(byDays.subscription.sql.includes('$5'), 'the days branch still binds the end date it was given, as null');
  assert.ok(byDays.subscription.sql.includes(SUBSCRIPTION_PERIOD_EXPRESSION), 'the insert and the conflict update count the period with one expression');
  expectBound(byDays.userUpdate, ['u-1', 'pro', JSON.stringify(plan.limits)], 'Adjust Plan (account mirror)');
  // A plan without limits in the catalogue still writes an object, never a null the column rejects.
  assert.equal(buildSubscriptionGrantStatements({ targetId: 'u-1', plan: { key: 'pro' } }).userUpdate.params[2], '{}');

  const byDate = buildSubscriptionGrantStatements({ targetId: 'u-1', plan, limits: plan.limits, interval: 'monthly', period: '1 month', endsAt: '2026-12-01T00:00:00.000Z' });
  expectBound(byDate.subscription, ['u-1', 'pro', 'monthly', '1 month', '2026-12-01T00:00:00.000Z'], 'Adjust Plan (grant, explicit end)');
  assert.equal(byDate.subscription.sql.split(SUBSCRIPTION_PERIOD_EXPRESSION).length - 1, 2, 'both the new period and the GREATEST comparison use the same rule');

  // A plan with no interval in the billing config still states one, so the column is never null.
  const noConfig = buildSubscriptionGrantStatements({ targetId: 'u-1', plan, limits: plan.limits, interval: undefined, period: '7 days' });
  expectBound(noConfig.subscription, ['u-1', 'pro', 'monthly', '7 days', null], 'Adjust Plan (grant, no billing interval)');
});

test('Adjust Plan: release, extension, and the mirror each bind what they use', () => {
  const released = buildSubscriptionReleaseStatements({ targetId: 'u-9', limits: { maxTelegramChannels: 1 } });
  expectBound(released.userUpdate, ['u-9', JSON.stringify({ maxTelegramChannels: 1 })], 'Adjust Plan (release)');
  expectBound(released.subscription, ['u-9'], 'Adjust Plan (release, subscription row)');

  const extended = buildSubscriptionExtendStatement({ targetId: 'u-9', days: 30 });
  expectBound(extended, ['u-9', 30], 'Adjust Plan (extension by days)');
  const dated = buildSubscriptionExtendStatement({ targetId: 'u-9', endsAt: '2026-11-01T00:00:00.000Z' });
  expectBound(dated, ['u-9', '2026-11-01T00:00:00.000Z'], 'Adjust Plan (extension to a date)');

  const mirror = buildSubscriptionMirrorStatement({ targetId: 'u-9', status: 'active', planKey: 'pro', limits: {} });
  expectBound(mirror, ['u-9', 'active', 'pro', '{}'], 'Adjust Plan (mirror)');

  assert.throws(() => buildSubscriptionGrantStatements({ targetId: 'u-1' }), /Choose a plan to grant/);
});

test('Suspend User: one statement per combination of fields the admin filled in', () => {
  expectBound(buildUserAdminUpdate({ isSuspended: true, suspensionReason: 'abuse' }, 'u-1'), [true, 'abuse', 'u-1'], 'Suspend');
  expectBound(buildUserAdminUpdate({ isSuspended: false }, 'u-1'), [false, 'u-1'], 'Unsuspend');
  expectBound(buildUserAdminUpdate({ suspensionReason: '' }, 'u-1'), [null, 'u-1'], 'Clearing a reason stores null, not an empty string');
  assert.match(buildUserAdminUpdate({ isSuspended: true, suspensionReason: 'abuse' }, 'u-1').sql, /^UPDATE users SET is_suspended=\$1,suspension_reason=\$2 WHERE id=\$3/, 'the columns and their slots are numbered as they are pushed');
  expectBound(buildUserAdminUpdate({ role: 'admin' }, 'u-1'), ['admin', 'u-1'], 'Role change');
  expectBound(buildUserAdminUpdate({ role: 'user', isSuspended: true, suspensionReason: 'x' }, 'u-1'), ['user', true, 'x', 'u-1'], 'All three at once');

  const where = (sql) => Number(sql.match(/WHERE id=\$(\d+)/)[1]);
  assert.equal(where(buildUserAdminUpdate({ role: 'admin' }, 'u-1').sql), 2, 'the id always binds last, after every column');
  assert.equal(where(buildUserAdminUpdate({ role: 'admin', isSuspended: true, suspensionReason: 'x' }, 'u-1').sql), 4);
  assert.throws(() => buildUserAdminUpdate({}, 'u-1'), /Choose at least one change to save/);
});

/** A pool that records what it was asked to run, so a service's own SQL is measured, not assumed. */
function recordingPool(rows = []) {
  const calls = [];
  return {
    calls,
    async query(sql, params = []) {
      const statement = typeof sql === 'string' ? sql : sql.text;
      assertQueryParameters(statement, params, 'recorded query');
      calls.push({ sql: statement, params });
      return { rows, rowCount: rows.length };
    },
  };
}

test('Publish Announcement: the insert, the edits, the retirement, and the audit row all bind cleanly', async () => {
  const pool = recordingPool([{ id: 'a-1', message: 'Maintenance at midnight', level: 'warning', active: true }]);
  const announcements = createAnnouncementService({ pool, now: () => new Date('2026-10-23T00:00:00.000Z') });

  const published = await announcements.publish({
    draft: { message: 'Maintenance at midnight', level: 'warning', active: true, startsAt: null, endsAt: '2026-10-24T00:00:00.000Z' },
    actorId: 'admin-1',
  });
  assert.equal(published.id, 'a-1');
  const insert = pool.calls[0];
  assert.match(insert.sql, /^INSERT INTO announcements/);
  assert.equal(insert.sql.includes('$?'), false);
  assert.deepEqual(insert.params, ['Maintenance at midnight', 'warning', true, null, '2026-10-24T00:00:00.000Z', 'admin-1']);

  // Every subset of a partial edit renumbers from one, which is where a hand-written `$2` drifts.
  for (const draft of [
    { message: 'Retext only' },
    { active: false },
    { startsAt: '2026-10-23T06:00:00.000Z', endsAt: null },
    { message: 'Everything', level: 'critical', active: true, startsAt: '2026-10-23T06:00:00.000Z', endsAt: null },
  ]) {
    pool.calls.length = 0;
    await announcements.update({ id: 'a-1', draft });
    assert.equal(pool.calls.length, 1, `the edit of ${Object.keys(draft).join(', ')} is one statement`);
    assertQueryParameters(pool.calls[0].sql, pool.calls[0].params, 'announcement update');
    const positions = [...pool.calls[0].sql.matchAll(/\$(\d+)/g)].map((match) => Number(match[1]));
    assert.equal(Math.max(...positions), pool.calls[0].params.length, `no placeholder is left without a value (${pool.calls[0].sql})`);
  }

  for (const status of ['all', 'live', 'retired', 'scheduled']) {
    pool.calls.length = 0;
    await announcements.list({ limit: 25, offset: 50, status });
    assertQueryParameters(pool.calls[0].sql, pool.calls[0].params, `announcement list (${status})`);
  }

  pool.calls.length = 0;
  await announcements.retire({ id: 'a-1' });
  assertQueryParameters(pool.calls[0].sql, pool.calls[0].params, 'announcement retire');
  assert.equal(pool.calls[0].params.length, 1);

  const auditPool = recordingPool([]);
  const auditLog = createAuditLogger({ pool: auditPool, logger: { warn() {}, error() {}, info() {} } });
  await auditLog.record({
    actorId: 'admin-1',
    actorEmail: 'admin@example.com',
    action: 'announcement.publish',
    targetType: 'announcement',
    targetId: 'a-1',
    summary: 'Published an announcement',
    metadata: { level: 'warning' },
  });
  const audit = auditPool.calls.find(({ sql }) => sql.includes('INSERT INTO admin_audit_logs'));
  assert.ok(audit, 'the audit trail is written');
  assertQueryParameters(audit.sql, audit.params, 'audit insert');
});

/* ------------------------------------------------------------------ every call site in the app ------------------------------------------------------------------ */

const QUERIED = /\b(?:pool|client|dbClient)\.query\(/g;
const QUOTES = ['`', "'", '"'];
const MAX_VARIANTS = 12;

/**
 * Reads one string or template literal. A template's `${}` holes are resolved against the literals
 * the same file declares, which turns one call site into one variant per branch - that is what makes
 * a statement whose text depends on a condition checkable instead of skipped.
 */
function readLiteral(source, start) {
  const quote = source[start];
  if (!QUOTES.includes(quote)) return null;
  let chunk = '';
  let variants = null;
  let dynamic = false;
  let index = start + 1;
  while (index < source.length) {
    const char = source[index];
    if (char === '\\') { chunk += source[index + 1] ?? ''; index += 2; continue; }
    if (char === quote) {
      const tail = chunk;
      const texts = variants === null ? [decodeEscapes(chunk)] : variants.map((prefix) => decodeEscapes(prefix + tail));
      return {
        text: quote === '`' ? (variants === null ? chunk : decodeEscapes(variants[0] + tail)) : decodeEscapes(chunk),
        variants: dynamic ? null : texts,
        end: index + 1,
        dynamic,
      };
    }
    if (quote === '`' && char === '$' && source[index + 1] === '{') {
      let depth = 1;
      let cursor = index + 2;
      while (cursor < source.length && depth > 0) {
        if (source[cursor] === '{') depth += 1;
        else if (source[cursor] === '}') depth -= 1;
        cursor += 1;
      }
      const resolved = constantVariants(source, source.slice(index + 2, cursor - 1).trim());
      const base = variants === null ? [''] : variants;
      // An unresolvable hole, or too many combinations to enumerate, marks the site as unreadable
      // rather than guessed at - and the pool check is still there for those at runtime.
      if (!resolved || base.length * resolved.length > MAX_VARIANTS) dynamic = true;
      else {
        variants = base.flatMap((prefix) => resolved.map((inserted) => prefix + chunk + inserted));
        chunk = '';
      }
      index = cursor;
      continue;
    }
    chunk += char;
    index += 1;
  }
  return null;
}

function decodeEscapes(text) {
  return text.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\'/g, "'").replace(/\\"/g, '"').replace(/\\\\/g, '\\');
}

/**
 * The strings `NAME` can hold in this file: one when it is `const NAME = 'text'` (or a template),
 * two when it is `const NAME = condition ? 'text' : 'other'`. Anything else - a function call, a
 * joined list of columns, a value from another module - is not statically knowable and is reported
 * as such, which is what keeps the scan honest instead of quietly optimistic.
 */
function constantVariants(source, expression) {
  const name = /^([A-Za-z_$][\w$]*)$/.exec(expression)?.[1];
  if (!name) return null;
  const declaration = new RegExp(`(?:const|let)\\s+${name}\\s*=([^;\\n]*(?:\\n[ \\t]+[^;\\n]*)*);`).exec(source);
  if (!declaration) return null;
  const body = declaration[1];
  const arms = [];
  for (let cursor = 0; cursor < body.length; cursor += 1) {
    if (!QUOTES.includes(body[cursor])) continue;
    const literal = readLiteral(body, cursor);
    if (!literal || literal.dynamic) return null;
    arms.push(literal.text);
    cursor = literal.end - 1;
  }
  if (!arms.length) return null;
  const conditional = body.includes('?') && body.includes(':');
  if (conditional && arms.length === 2) return arms;
  if (!conditional && arms.length === 1) return arms;
  return null;
}

function readArray(source, start) {
  if (source[start] !== '[') return null;
  let depth = 0;
  let index = start;
  while (index < source.length) {
    const char = source[index];
    if (QUOTES.includes(char)) {
      const literal = readLiteral(source, index);
      if (!literal) return null;
      index = literal.end;
      continue;
    }
    if ('([{'.includes(char)) depth += 1;
    else if (')]}'.includes(char)) depth -= 1;
    if (depth === 0) break;
    index += 1;
  }
  if (source[index] !== ']') return null;
  const body = source.slice(start + 1, index);
  const items = [];
  let current = '';
  let level = 0;
  for (let cursor = 0; cursor < body.length; cursor += 1) {
    const char = body[cursor];
    if (QUOTES.includes(char)) {
      const literal = readLiteral(body, cursor);
      current += body.slice(cursor, literal.end);
      cursor = literal.end - 1;
      continue;
    }
    if ('([{'.includes(char)) level += 1;
    if (')]}'.includes(char)) level -= 1;
    if (char === ',' && level === 0) { items.push(current.trim()); current = ''; continue; }
    current += char;
  }
  if (current.trim()) items.push(current.trim());
  if (items.some((item) => item.includes('...'))) return null;
  return { count: items.length, end: index + 1 };
}

/**
 * Which relation names a statement may legally write in front of a column: the tables it names, the
 * aliases it declares, `EXCLUDED` inside an ON CONFLICT update, and the trigger records. A qualifier
 * outside this set is not a style problem - Postgres refuses the statement with
 * `missing FROM-clause entry for table "x"`, which in a write route arrives as a status-less failure.
 */
function declaredRelations(sql) {
  const names = new Set(['excluded', 'new', 'old', 'only']);
  const keywords = /^(set|where|on|values|returning|select|from|inner|left|right|full|cross|join|order|group|limit|offset|conflict|do|and|or|as|using|with)$/;
  for (const match of sql.matchAll(/\b(?:FROM|JOIN|UPDATE|INTO|DELETE\s+FROM)\s+([a-z_][\w]*)(?:\s+(?:AS\s+)?([a-z_][\w]*))?/gi)) {
    names.add(match[1].toLowerCase());
    if (match[2] && !keywords.test(match[2].toLowerCase())) names.add(match[2].toLowerCase());
  }
  for (const match of sql.matchAll(/\b([a-z_][\w]*)\s+AS\s*\(/gi)) names.add(match[1].toLowerCase());
  return names;
}

function undeclaredQualifiers(sql) {
  const stripped = String(sql ?? '').replace(/'(?:[^']|'')*'/g, "''").replace(/"(?:[^"]|"")*"/g, '""');
  const declared = declaredRelations(stripped);
  const offenders = [];
  for (const match of stripped.matchAll(/\b([a-z_][\w]*)\.([a-z_][\w]*)/gi)) {
    if (!declared.has(match[1].toLowerCase())) offenders.push({ qualifier: match[1], column: match[2] });
  }
  return offenders;
}

function lineOf(source, index) {
  return source.slice(0, index).split('\n').length;
}

function auditCallSites(source, file) {
  const sites = [];
  for (const match of source.matchAll(QUERIED)) {
    const after = source.slice(match.index + match[0].length).match(/^\s*/)?.[0] || '';
    let cursor = match.index + match[0].length + after.length;
    if (source[cursor] === '{') {
      const textMatch = source.slice(cursor, cursor + 4000).match(/\{\s*text:\s*/);
      if (!textMatch) continue;
      cursor += textMatch[0].length;
    }
    const literal = readLiteral(source, cursor);
    if (!literal) continue;
    const rest = source.slice(literal.end, literal.end + 6000);
    const comma = rest.match(/^\s*,/);
    if (!comma) {
      sites.push({ file, line: lineOf(source, match.index), variants: [literal.text], values: 0, skipped: literal.dynamic });
      continue;
    }
    const arrayStart = literal.end + comma[0].length + (source.slice(literal.end + comma[0].length).match(/^\s*/)?.[0].length || 0);
    const array = readArray(source, arrayStart);
    sites.push({
      file,
      line: lineOf(source, match.index),
      variants: literal.variants || [literal.text],
      values: array ? array.count : null,
      skipped: literal.dynamic || array === null,
    });
  }
  return sites;
}

/** A site is broken when *any* statement it can become binds a different number of values. */
function brokenSites(sites) {
  return sites.filter((site) => !site.skipped && site.variants.some((sql) => countQueryParameters(sql).count !== site.values));
}

const allSites = sources.flatMap((file) => auditCallSites(readFileSync(path.join(serverRoot, file), 'utf8'), file));
const checked = allSites.filter((site) => !site.skipped);
const broken = brokenSites(allSites);

test('the source scan is wide enough to be worth trusting', () => {
  assert.ok(allSites.length > 90, `every query call site in the server was found, got ${allSites.length}`);
  // A call site can be legitimately unresolvable - a query with no values, or a text/params pair that
  // only exists at runtime - but the scan is worthless if it quietly checks nothing, so the ratio is
  // pinned. A new query that cannot be read here is also caught at the pool, and by the builders.
  assert.ok(checked.length >= 140, `the scan must keep checking at least 140 literal call sites, got ${checked.length}`);
  assert.ok(checked.length >= allSites.length * 0.7, `${checked.length} of ${allSites.length} call sites are statically resolvable, which has to stay most of them`);
});

test('no query in the server supplies a value its statement has no slot for, or a slot with no value', () => {
  assert.deepEqual(
    broken.map((site) => ({
      file: site.file,
      line: site.line,
      values: site.values,
      // Per branch of the statement, so a conditional that only *sometimes* mentions $5 is visible.
      placeholders: site.variants.map((sql) => countQueryParameters(sql).count),
    })),
    [],
    'every statically readable call site binds exactly what its statement asks for',
  );
});

test('no query qualifies a column with a relation its FROM clause does not declare', () => {
  const offenders = [];
  for (const site of checked) {
    site.variants.forEach((sql, index) => {
      const bad = undeclaredQualifiers(sql);
      if (bad.length) offenders.push(`${site.file}:${site.line} branch ${index + 1} -> ${bad.map((entry) => `${entry.qualifier}.${entry.column}`).join(', ')}`);
    });
  }
  assert.deepEqual(offenders, [], 'every alias used in front of a column is declared by the statement that uses it');
});

test('the RETURNING clause of a write is unqualified, because a write has no alias to use', () => {
  const broken = "INSERT INTO announcements(message,level) VALUES($1,$2) RETURNING a.id,a.message";
  const fixed = "INSERT INTO announcements(message,level) VALUES($1,$2) RETURNING id AS \"id\",message";
  assert.deepEqual(undeclaredQualifiers(broken).map((entry) => entry.qualifier), ['a', 'a'], 'both qualified columns of the RETURNING list are reported');
  // The two renderings of the same field list have to stay in lockstep: the reads keep their alias,
  // the writes drop it, and neither may silently gain or lose a column.
  assert.equal(announcementColumns.split(',').length, announcementReturnColumns.split(',').length);
  assert.deepEqual(undeclaredQualifiers(`INSERT INTO announcements(message,level,active,starts_at,ends_at,created_by,created_at,updated_at)
     VALUES($1,$2,$3,$4,$5,$6,NOW(),NOW())
     RETURNING ${announcementReturnColumns}`), [], 'the write path is legal SQL');
  assert.deepEqual(undeclaredQualifiers(`SELECT ${announcementColumns} FROM announcements a`), [], 'the read path keeps qualifying against its alias');
  assert.deepEqual(undeclaredQualifiers(fixed), []);
  // A read that joins the table under an alias keeps its qualifiers.
  assert.deepEqual(undeclaredQualifiers('SELECT a.id FROM announcements a WHERE a.active=TRUE'), []);
  // EXCLUDED and the target table's own name are legal inside ON CONFLICT DO UPDATE.
  assert.deepEqual(undeclaredQualifiers(`INSERT INTO subscriptions(user_id,plan_key) VALUES($1,$2)
     ON CONFLICT(user_id) DO UPDATE SET plan_key=EXCLUDED.plan_key,
       current_period_end=GREATEST(COALESCE(subscriptions.current_period_end,NOW()),$3)`), []);
});

test('the scan catches the deployed defect, so it is a net and not a comfort', () => {
  const fixture = [
    "const periodSql = adjustment.endsAt ? '$5::timestamptz' : 'NOW() + ($4::text)::interval';",
    'const pool = { query() {} };',
    'pool.query(',
    "  `INSERT INTO subscriptions(user_id,plan_key,current_period_end) VALUES($1,$2,'x',${periodSql})`,",
    "  [targetId, plan.key, 'monthly', '14 days', adjustment.endsAt],",
    ');',
    "pool.query('UPDATE subscriptions SET current_period_end=$2 WHERE user_id=$1', [targetId, 3]);",
  ].join('\n');
  const sites = auditCallSites(fixture, 'fixture.js');
  assert.equal(sites.length, 2, JSON.stringify(sites));
  const flagged = brokenSites(sites);
  assert.equal(flagged.length, 1, 'the days branch binds 4 slots while five values are supplied; the other branch is fine');
  assert.deepEqual(
    { line: flagged[0].line, values: flagged[0].values, placeholders: flagged[0].variants.map((sql) => countQueryParameters(sql).count) },
    { line: 3, values: 5, placeholders: [5, 4] },
  );
});

test('a conditional period expression cannot exist without binding both of its halves', () => {
  // The regression itself, as a rule for the future: the statement is chosen from `days` or `endsAt`,
  // so the value list has to be the same length in either case and every `$n` has to appear.
  const sql = `INSERT INTO subscriptions(user_id,plan_key,current_period_end) VALUES($1,$2,${SUBSCRIPTION_PERIOD_EXPRESSION})`;
  assert.doesNotThrow(() => assertQueryParameters(sql.replace('$1,$2,', '$1,$2,$3,$4,'), [1, 2, 3, 4, null]));
  assert.equal(SUBSCRIPTION_PERIOD_EXPRESSION.includes('$5'), true);
  assert.equal(SUBSCRIPTION_PERIOD_EXPRESSION.includes('$4'), true);
  const index = readFileSync(path.join(serverRoot, 'index.js'), 'utf8');
  assert.equal(index.includes('periodSql'), false, 'no route may pick between two placeholder counts by choosing between two SQL strings');
  assert.equal(/const \w+ = adjustment\.endsAt \? /.test(index), false, 'the same rule, phrased as the pattern that caused it');
});
