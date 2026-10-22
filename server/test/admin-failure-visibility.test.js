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

test('every admin mutation the panel exposes runs through the naming wrapper', () => {
  for (const route of [
    "app.patch('/api/admin/users/:id', authenticate, requireAdmin, adminRoute('Updating that account'",
    "app.patch('/api/admin/users/:id/subscription', authenticate, requireAdmin, adminRoute('Adjusting that plan'",
    "app.post('/api/admin/announcements', authenticate, requireAdmin, adminRoute('Publishing that announcement'",
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
