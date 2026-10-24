/**
 * How the schema is sent, which is a different question from what is in it.
 *
 * `server/db.js` keeps the whole schema as one block of text. Read that way it is easy to review and, sent
 * that way, dangerous: a multi-statement string is one implicit transaction, so every `ALTER TABLE` in it
 * holds its lock until the last statement commits. The outage that produced this file was a deploy whose
 * migration queued behind a lock that never freed, with no timeout to give up, no log line to read, and no
 * port bound - fifteen minutes of silence and a platform message about ports that named nothing.
 *
 * So the rules here are about the shape of the execution: the text is split, each statement runs alone with
 * a lock timeout, a stalled connection is given a deadline, and the connection is encrypted unless the URL
 * says otherwise.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { splitSchemaStatements, sqlPreview, withDeadline, timeoutSetting } from '../services/schema-sql.js';
import { schemaStatements, resolvePoolSsl } from '../db.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const dbSource = readFileSync(path.join(here, '..', 'db.js'), 'utf8');
const indexSource = readFileSync(path.join(here, '..', 'index.js'), 'utf8');

/* ---------------------------------------------------------------- the splitter ---------------------------------------------------------------- */

test('a schema is cut at semicolons that are really statement ends', () => {
  assert.deepEqual(splitSchemaStatements('SELECT 1; SELECT 2;'), ['SELECT 1', 'SELECT 2']);
  assert.deepEqual(splitSchemaStatements('  ;  ;  '), [], 'and an empty fragment is not a statement');
  assert.deepEqual(splitSchemaStatements('SELECT a;-- trailing note\n'), ['SELECT a'], 'a trailing comment cannot invent an empty statement');
});

test('semicolons inside a DO body, a string, or a comment do not split anything', () => {
  const [block] = splitSchemaStatements("DO $$ BEGIN IF TRUE THEN ALTER TABLE t ADD COLUMN c TEXT; END IF; END $$;");
  assert.match(block, /^DO \$\$ BEGIN[\s\S]+END \$\$$/, 'the whole body is one statement, because Postgres needs all of it');

  const [guarded] = splitSchemaStatements("ALTER TABLE users ADD COLUMN role TEXT; ALTER TABLE users ADD CONSTRAINT role_check CHECK (role IN ('user', 'admin'));");
  assert.equal(guarded, 'ALTER TABLE users ADD COLUMN role TEXT');

  const [tricky] = splitSchemaStatements("SELECT 'a;b'; SELECT 2;");
  assert.equal(tricky, "SELECT 'a;b'", 'a semicolon inside a string literal is data');

  const [insideComment] = splitSchemaStatements("/* note; still a note */ SELECT 1;");
  assert.equal(insideComment, 'SELECT 1', 'and a semicolon inside a comment is prose');
});

test('comments are dropped and nothing is left with a dangling semicolon', () => {
  const statements = schemaStatements();
  // A count far below this means the splitter stopped early or cut at the wrong places, not that the
  // schema shrank: the statements are `CREATE TABLE`/`ALTER`/`CREATE INDEX` lines, and there are ~130.
  assert.ok(statements.length > 100, `the real schema split into ${statements.length} statements - a small number means the splitter stopped working`);
  assert.ok(statements.length < 400, `${statements.length} statements means something is being cut into pieces it should not be`);
  for (const statement of statements) {
    assert.ok(statement.length > 3, 'no empty statements');
    assert.ok(!statement.trimEnd().endsWith(';'), `statement must not be sent with its semicolon: ${sqlPreview(statement)}`);
    assert.ok(!/^--/.test(statement) && !/^\/\*/.test(statement), 'a comment is not a statement of its own');
    assert.equal((statement.match(/\$\$/g) || []).length % 2, 0, 'dollar quoting is balanced, so no body was cut in half');
  }
});

test('the columns this app ships are each their own statement', () => {
  const statements = schemaStatements();
  const find = (needle) => statements.filter((statement) => statement.includes(needle));
  for (const needle of [
    'execution_jobs ADD COLUMN IF NOT EXISTS next_attempt_at',
    'metaapi_accounts ADD COLUMN IF NOT EXISTS execution_note ',
    'execution_jobs_backoff_idx',
  ]) {
    assert.equal(find(needle).length, 1, `${needle} appears exactly once, as one statement`);
  }
  // The comment above a statement is prose; it must never be able to look like the end of one.
  assert.ok(!find('next_attempt_at').some((statement) => statement.includes('the wait is the point')));
});

test('the schema is never handed to the driver as one query again', () => {
  // Substring checks rather than patterns, because every one of these is a rule about text that must not be
  // there, and a mangled regex quietly turns "must not be there" into a test that asserts nothing.
  assert.ok(dbSource.includes('const SCHEMA_SQL = '), 'the schema text lives in a named constant');
  assert.ok(!dbSource.includes('await pool.query(' + '`'), 'nothing may send the whole schema as one query - that is what holds every lock at once');
  assert.ok(dbSource.includes('SET lock_timeout = '), 'a blocked statement gives up rather than waiting out the deploy');
  assert.ok(dbSource.includes('schemaStatements()'), 'and it is executed statement by statement');
  assert.ok(dbSource.includes("await client.query(statement)"), 'each one through the same connection, one after another');
});

test('initializeDatabase sends the schema statement by statement, and nothing else', async () => {
  const { pool, initializeDatabase, schemaStatements } = await import('../db.js');
  const sent = [];
  const steps = [];
  const client = {
    query: async (sql) => { sent.push(sql); return { rows: [] }; },
    release: () => {},
  };
  const original = { connect: pool.connect, query: pool.query };
  pool.connect = async () => client;
  pool.query = async (sql) => { sent.push(sql); return { rows: [] }; };
  try {
    const summary = await initializeDatabase({ onStep: (step) => steps.push(step) });
    const statements = schemaStatements();
    assert.equal(summary.statements, statements.length);
    assert.deepEqual(sent.slice(2, 2 + statements.length), statements, 'every schema statement is sent on its own, in order, and no call carries two of them');
    assert.ok(sent[0].startsWith('SET lock_timeout = '), 'the session is configured before the first ALTER, so a held lock cannot park the boot');
    assert.ok(sent[1].startsWith('SET statement_timeout = '), 'and a slow statement cannot run past the deploy either');
    assert.equal(sent.at(-1), 'SELECT 1', 'the schema is verified with one cheap round trip');
    assert.deepEqual(steps.map((step) => step.step), ['connecting', 'ready']);
    assert.equal(steps[1].total, statements.length, 'the caller is told how much was applied');
  } finally {
    pool.connect = original.connect;
    pool.query = original.query;
  }
});

test('a statement that cannot get its lock is retried, and the retry is reported', async () => {
  const { pool, initializeDatabase } = await import('../db.js');
  const lockError = () => { const error = new Error('canceling statement due to lock timeout'); error.code = '55P03'; return error; };
  // One specific statement is made to collide with a lock once. `ALTER TABLE users` alone would match
  // several statements in the file and count their attempts too, which is a test bug masquerading as a
  // product fact.
  const target = "ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'user'";
  let attempts = 0;
  const steps = [];
  const client = {
    query: async (sql) => {
      if (sql === target) {
        attempts += 1;
        if (attempts === 1) throw lockError();
      }
      return { rows: [] };
    },
    release: () => {},
  };
  const original = { connect: pool.connect, query: pool.query };
  pool.connect = async () => client;
  pool.query = async () => ({ rows: [] });
  try {
    const summary = await initializeDatabase({ onStep: (step) => steps.push(step) });
    assert.equal(attempts, 2, 'the blocked statement ran twice and the boot carried on');
    assert.equal(summary.statements > 0, true);
    const waiting = steps.find((step) => step.step === 'waiting-for-lock');
    assert.ok(waiting, 'and it said so, with the statement that was waiting');
    assert.match(waiting.statement, /^ALTER TABLE users ADD COLUMN IF NOT EXISTS role/);
    assert.equal(waiting.attempt, 1);
  } finally {
    pool.connect = original.connect;
    pool.query = original.query;
  }
});

test('a statement that fails for a real reason names itself instead of stalling the boot', async () => {
  const { pool, initializeDatabase } = await import('../db.js');
  const client = {
    query: async (sql) => {
      if (sql.includes('execution_jobs_backoff_idx')) {
        const error = new Error('relation "execution_jobs" does not exist');
        error.code = '42P01';
        throw error;
      }
      return { rows: [] };
    },
    release: () => {},
  };
  const original = { connect: pool.connect, query: pool.query };
  pool.connect = async () => client;
  try {
    await assert.rejects(
      () => initializeDatabase(),
      (error) => {
        assert.match(error.message, /Schema statement \d+ of \d+ failed: CREATE INDEX IF NOT EXISTS execution_jobs_backoff_idx/);
        assert.equal(error.schemaStatementIndex > 0, true, 'the position in the file is reported, so the line can be found');
        return true;
      },
    );
  } finally {
    pool.connect = original.connect;
    pool.query = original.query;
  }
});

/* ---------------------------------------------------------------- the deadline ---------------------------------------------------------------- */

test('a promise that never settles is turned into an error that names the step', async () => {
  const stalled = new Promise(() => {});
  await assert.rejects(
    () => withDeadline(stalled, 20, 'a database connection for the schema'),
    (error) => {
      assert.equal(error.code, 'BOOT_DEADLINE_EXCEEDED');
      assert.match(error.message, /Timed out after 20 ms waiting for a database connection for the schema/);
      return true;
    },
  );
  assert.equal(await withDeadline(Promise.resolve(7), 500, 'a fast thing'), 7, 'a thing that finishes in time is untouched');
});

test('work that arrives after its deadline is still handed back, so nothing is leaked', async () => {
  let released = null;
  const late = { release: () => { released = true; } };
  let settle;
  const slow = new Promise((resolve) => { settle = () => resolve(late); });
  await assert.rejects(() => withDeadline(slow, 15, 'a checkout', { onLate: (value) => { value.release(); } }), /BOOT_DEADLINE_EXCEEDED|Timed out/);
  assert.equal(released, null, 'nothing to release yet');
  settle();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(released, true, 'the abandoned connection was returned to the pool instead of being held');
});

test('a timeout setting is always a number of milliseconds, never a fragment of SQL', () => {
  assert.equal(timeoutSetting(5000, 5_000), '5000ms');
  assert.equal(timeoutSetting('nonsense', 12_000), '12000ms');
  assert.equal(timeoutSetting(-1, 900), '900ms');
  assert.equal(timeoutSetting(1500.7, 900), '1501ms');
});

/* ------------------------------------------------------------------ the socket ------------------------------------------------------------------ */

test('a managed database is given TLS unless the URL already chose it', () => {
  assert.deepEqual(
    resolvePoolSsl('postgresql://u:p@db.example.supabase.co:5432/postgres', {}),
    { rejectUnauthorized: false },
    'Supabase is the production target and it does not complete a plaintext handshake - or sometimes it only stops answering, which is the worse of the two',
  );
  assert.deepEqual(resolvePoolSsl('postgresql://u:p@host.us-east-1.render.com:5432/db', {}), { rejectUnauthorized: false }, 'the same rule covers Render, whose hostname is not in its certificate');
  assert.equal(resolvePoolSsl('postgresql://u:p@localhost:5432/db', {}), undefined, 'a local database is reached however the developer set it up');
  assert.equal(resolvePoolSsl('postgresql://u:p@127.0.0.1:5432/db', {}), undefined);
  assert.equal(resolvePoolSsl('postgresql://u:p@db.example.com:5432/db?sslmode=require', {}), undefined, "an explicit sslmode is the operator's choice and is not overridden");
  assert.equal(resolvePoolSsl('', {}), undefined, 'no URL yet, so nothing to decide about');
  assert.deepEqual(resolvePoolSsl('postgresql://u:p@db.example.com:5432/db', { PGSSL_VERIFY: 'true' }), { rejectUnauthorized: true }, 'and verification is one variable away for a deployment that wants it');
});

test('a public health answer never carries the failure text', () => {
  // `/health` is unauthenticated, and the app has a standing rule that a database error message - which can
  // name a table, a column, or a host - belongs in a log and in the admin snapshot, not in a browser.
  const lines = indexSource.split('\n');
  const healthLines = lines.filter((line) => line.includes("app.get('/health'") || line.includes("app.get('/api/health'"));
  assert.equal(healthLines.length, 2, 'both health routes exist, each on its own line');
  for (const line of healthLines) {
    assert.ok(line.includes('startupStatus()'), 'they answer with the startup state');
    assert.ok(!line.includes('...boot'), 'with the trimmed copy of it, never the whole boot object');
  }
  assert.ok(
    indexSource.includes('const publicStartup = () => ({ ready: boot.ready, step: boot.step, database: boot.database, statements: boot.statements, attempts: boot.attempts });'),
    'the public shape is exactly those five fields, with no lastError in it',
  );
  assert.ok(indexSource.includes('startup: { ...boot }'), 'while the admin System Health snapshot may carry the reason');
});
