import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { adminActionError } from '../services/admin.js';

const index = readFileSync(new URL('../index.js', import.meta.url), 'utf8');

test('a status-less database failure becomes an answer that names the action and the cause', () => {
  const cause = new Error('insert or update on table "announcements" violates\n   not-null constraint');
  cause.code = '23502';
  const error = adminActionError('Publishing that announcement', cause);
  assert.equal(error.status, 500, 'an unexpected failure is still a server error');
  assert.equal(error.code, '23502', 'the database state is kept for the log');
  assert.match(error.userMessage, /^Publishing that announcement did not complete: /);
  assert.match(error.userMessage, /violates not-null constraint/, 'whitespace is folded so one line stays readable');
  assert.match(error.userMessage, /Nothing was changed/);
  assert.notEqual(error.userMessage, cause.message, 'the raw sentence never reaches the browser as the headline');
});

test('an error that already carries a status is answered on its own terms', () => {
  const deliberate = new Error('Those dates do not fit together, so the announcement was not published.');
  deliberate.status = 400;
  assert.equal(adminActionError('Publishing that announcement', deliberate), deliberate, 'a validation is returned untouched');

  const upstream = new Error('MetaAPI is not accepting orders right now.');
  upstream.status = 502;
  upstream.userMessage = 'The broker gateway is unavailable, so nothing was sent. Please retry in a moment.';
  const wrapped = adminActionError('Adjusting that plan', upstream);
  assert.equal(wrapped.status, 502);
  assert.equal(wrapped.userMessage, upstream.userMessage, 'a sentence written for this exact failure is not overwritten');
});

test('an error with no detail at all still tells the reader what to do next', () => {
  const wrapped = adminActionError('Suspending that account', new Error(''));
  assert.equal(wrapped.status, 500);
  assert.equal(wrapped.userMessage, 'Suspending that account did not complete. Nothing was changed - please try again, and send us this reference if it fails twice.');
});

test('a long internal message is shortened rather than dumped', () => {
  // Postgres puts the actionable sentence first and the noise after it, so the kept half is the front.
  const cause = new Error(`column "nope" does not exist - ${'context '.repeat(200)}`);
  const wrapped = adminActionError('Updating that account', cause);
  const quoted = wrapped.userMessage
    .slice('Updating that account did not complete: '.length)
    .split('. Nothing was changed')[0];
  assert.ok(quoted.length <= 180, `the quoted cause stays short, got ${quoted.length}`);
  assert.match(quoted, /^column "nope" does not exist - context /, 'the part that names the column is the part that is kept');
});

test('a failure after the write stops promising that nothing was changed', () => {
  const cause = new Error('connection terminated');
  const before = adminActionError('Suspend that account', cause);
  assert.match(before.userMessage, /Nothing was changed - please try again/);
  const after = adminActionError('Suspend that account', cause, { applied: true });
  assert.match(after.userMessage, /Part of this may already be saved - reload the list before you try it again\./);
  assert.equal(after.userMessage.includes('Nothing was changed'), false, 'a claim that contradicts the row the admin can already see is worse than no claim');
  assert.match(after.userMessage, /^Suspend that account did not complete: connection terminated\. /, 'the action and the cause are still named');
});

test('each admin mutation route marks the moment its write landed, and not before', () => {
  const routes = [
    ["app.patch('/api/admin/users/:id', authenticate", 'markApplied(req)', 'const { rows } = await pool.query(statement.sql, statement.params);'],
    ["app.post('/api/admin/announcements', authenticate", 'markApplied(req)', 'announcement = await announcementService.publish({ draft, actorId: req.userId });'],
    ["app.patch('/api/admin/users/:id/subscription', authenticate", 'markApplied(req)', "await client.query('COMMIT');"],
    /* The three clears. They are in this list because a delete is the worst case for the sentence
     * "Nothing was changed": if the audit write fails after a wipe, an answer that still promises that
     * nothing happened tells the administrator to do the destructive thing again. */
    ["app.delete('/api/admin/health/errors', authenticate", 'markApplied(req)', 'const { rowCount } = await pool.query(statement.sql, statement.params);'],
    ["app.delete('/api/admin/audit-logs', authenticate", 'markApplied(req)', 'const { rowCount } = await pool.query(statement.sql, statement.params);'],
    ["app.delete('/api/admin/announcements/history', authenticate", 'markApplied(req)', 'const { rowCount } = await pool.query(statement.sql, statement.params);'],
  ];
  for (const [start, marker, write] of routes) {
    const from = index.indexOf(start);
    assert.notEqual(from, -1, start);
    const body = index.slice(from, index.indexOf('\n}));', from));
    const markerAt = body.indexOf(marker);
    const writeAt = body.indexOf(write);
    assert.notEqual(markerAt, -1, `${start} marks its write`);
    assert.notEqual(writeAt, -1, `${start} contains the statement it marks`);
    assert.ok(markerAt > writeAt, `${start} reports a mutation as applied only after ${write.slice(0, 28)}…`);
  }
  assert.match(index, /req\.adminMutation = \{ applied: false \};/);
  assert.match(index, /adminActionError\(action, error, \{ applied: req\.adminMutation\.applied === true \}\)/);
});

test('every admin mutation the panel exposes runs through the naming wrapper', () => {
  for (const route of [
    "app.patch('/api/admin/users/:id', authenticate, requireAdmin, adminRoute('Updating that account'",
    "app.patch('/api/admin/users/:id/subscription', authenticate, requireAdmin, adminRoute('Adjusting that plan'",
    "app.post('/api/admin/announcements', authenticate, requireAdmin, adminRoute('Publishing that announcement'",
    "app.delete('/api/admin/health/errors', authenticate, requireAdmin, adminRoute('Clearing the Telegram parsing errors'",
    "app.delete('/api/admin/audit-logs', authenticate, requireAdmin, adminRoute('Clearing the audit log'",
    "app.delete('/api/admin/announcements/history', authenticate, requireAdmin, adminRoute('Clearing the banner history'",
  ]) {
    assert.ok(index.includes(route), `${route} is wrapped`);
  }
});

test('an unexpected failure is logged with the request that caused it and answered with a reference', () => {
  const handler = index.slice(index.indexOf("app.use((error, req, res, _next)"));
  assert.ok(handler.length > 200, 'the global error handler is present');
  const body = handler.slice(0, handler.indexOf('res.status('));
  for (const needed of ['requestId', 'method: req.method', "path: String(req.originalUrl", 'status: Number(error.status) || 500']) {
    assert.ok(body.includes(needed), `the log line carries ${needed}`);
  }
  assert.match(body, /\.\.\.\(error\.code \? \{ code: error\.code \} : \{ code: 'UNEXPECTED' \}\)/, 'a status-less failure still has a code a client can branch on');
  assert.match(body, /requestId,/);
  assert.match(body, /error\.status \? \(typeof error\.userMessage === 'string' \? error\.userMessage : error\.message\)/, 'an authored status message is returned, a raw one is not');
});

test('the risk acknowledgement is read, written, and asked for only once', () => {
  const settingsPut = index.slice(index.indexOf("app.put('/api/settings'"), index.indexOf("app.get('/api/trades'"));
  assert.match(settingsPut, /let hasAcceptedRiskWarning = req\.body\.hasAcceptedRiskWarning === true;/);
  assert.match(settingsPut, /if \(previousRows\[0\]\?\.hasAcceptedRiskWarning === true\) hasAcceptedRiskWarning = true;/);
  assert.match(settingsPut, /has_accepted_risk_warning=\$16|has_accepted_risk_warning=EXCLUDED\.has_accepted_risk_warning/);
  assert.match(index, /has_accepted_risk_warning AS "hasAcceptedRiskWarning" FROM settings WHERE user_id=\$1/);
  assert.match(index, /hasAcceptedRiskWarning: false/);

  const db = readFileSync(new URL('../db.js', import.meta.url), 'utf8');
  assert.match(db, /ALTER TABLE settings ADD COLUMN IF NOT EXISTS has_accepted_risk_warning BOOLEAN NOT NULL DEFAULT FALSE;/);
  assert.match(db, /ALTER TABLE signals ADD COLUMN IF NOT EXISTS execution_note TEXT;/);
  assert.equal(/has_accepted_risk_warning[^;]*REFERENCES/.test(db), false, 'a flag is not a key');
});

/* ---------------------------------------------------------------------------------------------
 * The suspension route, specifically. This is the endpoint that was reported as "throws a generic
 * error and records nothing", and both halves of that sentence were true for structural reasons:
 * a target id that failed the shape check returned 400 from outside the route's logging, and a
 * successful UPDATE was followed by a second, unrelated SELECT whose failure was then reported as
 * if the write itself had failed. So the invariants below are about traceability and ordering, not
 * about SQL - the SQL was already valid, which is exactly why three rounds of guessing missed it.
 * ------------------------------------------------------------------------------------------- */

const suspensionRoute = (() => {
  const start = index.indexOf("app.patch('/api/admin/users/:id'");
  assert.notEqual(start, -1, 'the admin user PATCH route is present');
  const end = index.indexOf('/* ------------------------------------------------------------------ data management (admin)', start);
  return index.slice(start, end === -1 ? index.length : end);
})();

test('a suspension is answered from the statement that wrote it', async () => {
  const { buildUserAdminUpdate } = await import('../services/admin.js');
  const suspended = buildUserAdminUpdate({ isSuspended: true, suspensionReason: 'chargeback' }, '3f2f26a4-fc8c-4b69-9c44-2be36b65e1a7');
  assert.match(suspended.sql, /RETURNING id AS "userId",is_suspended AS "isSuspended",suspension_reason AS "suspensionReason"/);
  assert.deepEqual(suspended.params, [true, 'chargeback', '3f2f26a4-fc8c-4b69-9c44-2be36b65e1a7']);
  const lifted = buildUserAdminUpdate({ isSuspended: false }, '3f2f26a4-fc8c-4b69-9c44-2be36b65e1a7');
  assert.match(lifted.sql, /is_suspended AS "isSuspended"/, 'a lift answers with the flag too, so the panel can be told the truth without another read');
  assert.match(lifted.sql, /suspension_reason AS "suspensionReason"/);

  // The route keeps the row it wrote, marks the write applied, and only then tries the richer re-read.
  assert.match(suspensionRoute, /applied = rows\[0\];/, 'the applied row is kept');
  assert.ok(
    suspensionRoute.indexOf('markApplied(req)') < suspensionRoute.indexOf('could not be re-read'),
    'the re-read happens after the write is marked applied',
  );
  assert.match(
    suspensionRoute,
    /catch \(error\) \{\s*\n\s*log\('warn', 'Admin user details could not be re-read after an applied change'/,
    'a failed re-read is logged and does not reach the browser as a failure',
  );
  const afterApplied = suspensionRoute.slice(suspensionRoute.indexOf('markApplied(req)'));
  assert.equal(/return fail\(res, 500/.test(afterApplied), false, 'nothing after the write can answer with a bare 500');
});

test('every way the endpoint says no leaves a trace in the log, and a suspension refusal in the audit trail', () => {
  assert.match(suspensionRoute, /const refuse = async \(status, message, fields\) => \{/, 'refusals go through one helper');
  assert.match(suspensionRoute, /log\('warn', 'Admin account edit refused'/);
  assert.match(suspensionRoute, /action: 'user\.suspend\.refused'/);
  // The shape check used to answer 400 from before any of that, which is why the audit table could
  // hold no rows at all while the panel kept showing an error.
  const guard = suspensionRoute.slice(0, suspensionRoute.indexOf('let update;'));
  assert.match(guard, /if \(!UUID_PATTERN\.test\(targetId\)\) return refuse\(400, 'Choose a valid user account\.', sentFields\);/);
  assert.equal(/return fail\(res, 400/.test(guard), false, 'no silent early return is left in this route');
  const refusalAudit = suspensionRoute.slice(suspensionRoute.indexOf('const refuse ='), suspensionRoute.indexOf('const sentFields'));
  assert.match(refusalAudit, /fields\.includes\('isSuspended'\)/, 'a suspension refusal is audited whatever else was sent');
});

test('an unexpected database failure says the account was not changed, and names the reason', () => {
  const cause = new Error('column "fallback_stop_loss_points" does not exist');
  cause.code = '42703';
  const error = adminActionError('Updating that account', cause);
  assert.match(error.userMessage, /Updating that account did not complete/);
  assert.match(error.userMessage, /Nothing was changed/);
  assert.equal(error.status, 500);
  // The route does not leave that sentence to the wrapper: it answers its own write failure so the
  // administrator is never told "something went wrong" about a statement that is this specific.
  assert.match(suspensionRoute, /The change could not be written to the database, so this account has not been updated\./);
});

test('the deployment says which build is running, so a stale deploy is not mistaken for a failed fix', () => {
  // Every symptom in this file's history had a second explanation available: the code that was merged
  // was not the code that was running. Both the public health routes and the admin health snapshot now
  // carry the boot stamp, so that question is answered by the app instead of by a guess.
  assert.match(index, /const healthPayload = \(\) => \(\{/);
  assert.match(index, /bootedAt: BOOTED_AT\.toISOString\(\)/);
  assert.match(index, /uptimeSeconds: Math\.round\(\(Date\.now\(\) - BOOTED_AT\.getTime\(\)\) \/ 1000\)/);
  assert.match(index, /gitCommit: process\.env\.RENDER_GIT_COMMIT \|\| process\.env\.GIT_COMMIT \|\| null/);
  for (const route of ["app.get('/health'", "app.get('/api/health'"]) {
    const at = index.indexOf(route);
    assert.notEqual(at, -1, `${route} is served`);
    assert.match(index.slice(at, at + 200), /healthPayload\(\)/, `${route} answers with the boot stamp`);
    assert.match(index.slice(at, at + 200), /Cache-Control', 'no-store'/, `${route} is never cached by a proxy`);
  }
  // The same facts reach the admin panel through the health snapshot, which is the only place the
  // mechanism behind an idle listener may be explained to anyone.
  assert.match(index, /const systemHealth = createSystemHealthService\(\{[^}]*capture: \(\) =>/, 'the collector is wired at construction');
  assert.match(index, /telegramCapture\.telegramFleetSummary\(\)/);
});
