/**
 * The three "Clear history" buttons on the admin panels.
 *
 * Each one deletes something an administrator cannot get back, so the invariants here are about scope and
 * traceability rather than about SQL style: the statement must remove exactly the rows that panel says it
 * removes and nothing else, the route must run through the wrapper that tells the browser whether the
 * write landed, and the action must still be visible in the audit trail afterwards - including the clear
 * of the audit trail itself, which is the one case where forgetting to write the entry would look like
 * the log having always been empty.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildParseErrorClear, RECENT_ERRORS_CTE } from '../services/system-health.js';
import { buildAuditLogClear, AUDIT_ACTIONS, AUDIT_TARGET_TYPES } from '../services/audit.js';
import { buildRetiredAnnouncementClear, announcementState } from '../services/announcements.js';

const index = readFileSync(new URL('../index.js', import.meta.url), 'utf8');

function routeBody(start) {
  const from = index.indexOf(start);
  assert.notEqual(from, -1, `${start} is mounted`);
  return index.slice(from, index.indexOf('\n}));', from));
}

test('clearing the parsing errors removes the reason, never the message or another table', () => {
  const statement = buildParseErrorClear();
  assert.match(statement.sql, /^UPDATE signals SET parse_error=NULL\b/);
  assert.equal(/\bFROM (trades|users|settings|channels|execution_jobs|announcements)\b/.test(statement.sql), false, 'no join, so no other table is touched');
  assert.equal(/DELETE/.test(statement.sql), false, 'the captured row survives - only the recorded reason is unset');
  assert.deepEqual(statement.params, [], 'there is nothing to bind, so nothing can be scoped away');
  // The WHERE has to be the list's own condition or the tab keeps rows the count says are gone.
  const predicate = "parse_error IS NOT NULL AND parse_error <> ''";
  assert.ok(statement.sql.includes(predicate), 'the same predicate the errors list selects on');
  // Read the tab's own branch rather than trusting that the two sentences still rhyme: if either side
  // drifts, the button would clear a set of rows that is not the set the list was showing.
  const branch = (/SELECT 'telegram_parse'[\s\S]*?WHERE ([^\n]+)/.exec(RECENT_ERRORS_CTE) || [])[1] || '';
  assert.ok(branch, 'the telegram_parse branch is still in the health read model');
  assert.equal(
    statement.sql.split(' WHERE ')[1].replace(/\s+/g, ' '),
    branch.replace(/\bs\./g, '').replace(/\s+/g, ' ').trim(),
    "the clear's WHERE is the branch's WHERE, with only its time window dropped",
  );
});

test('the audit log has one delete statement, and it is the whole table', () => {
  const statement = buildAuditLogClear();
  assert.equal(statement.sql, 'DELETE FROM admin_audit_logs');
  assert.deepEqual(statement.params, []);
  assert.equal(/WHERE/.test(statement.sql), false, 'a filtered wipe would leave entries the panel just claimed were gone');
});

test('the banner purge reaches retired and finished banners, and cannot reach a live one', () => {
  const statement = buildRetiredAnnouncementClear();
  assert.match(statement.sql, /^DELETE FROM announcements WHERE /);
  assert.deepEqual(statement.params, []);
  assert.ok(statement.sql.includes('active = FALSE'), 'what retire has always meant, in SQL');
  assert.ok(statement.sql.includes('ends_at <= NOW()'), 'a banner whose window closed is finished history too');

  // Rather than trust the reading of the sentence, ask the panel's own state function for each row shape.
  const now = new Date('2024-03-10T12:00:00Z');
  const past = new Date('2024-03-09T12:00:00Z').toISOString();
  const future = new Date('2024-03-11T12:00:00Z').toISOString();
  const cases = [
    [{ active: false, startsAt: null, endsAt: null }, 'retired'],
    [{ active: false, startsAt: past, endsAt: future }, 'retired'],
    [{ active: true, startsAt: past, endsAt: past }, 'ended'],
    [{ active: true, startsAt: null, endsAt: past }, 'ended'],
    [{ active: true, startsAt: null, endsAt: null }, 'live'],
    [{ active: true, startsAt: past, endsAt: future }, 'live'],
    [{ active: true, startsAt: future, endsAt: future }, 'scheduled'],
  ];
  const deletedWhere = (row) => row.active === false || (row.endsAt !== null && Date.parse(row.endsAt) <= now.getTime());
  for (const [row, expected] of cases) {
    assert.equal(announcementState(row, now), expected, `${JSON.stringify(row)} is ${expected}`);
    assert.equal(deletedWhere(row), expected === 'retired' || expected === 'ended', `${expected} banners match the delete, and no others`);
  }
});

test('every clear is a word the audit vocabulary already knows', () => {
  // `buildAuditEntry` refuses an unknown key, and it is called after the rows are gone - a typo here
  // would therefore delete the history and then answer with a 500 about the record of it.
  for (const action of ['health.clearParseErrors', 'audit.clear', 'announcement.purgeHistory']) {
    assert.ok(Object.keys(AUDIT_ACTIONS).includes(action), `${action} is in the closed vocabulary`);
    assert.match(AUDIT_ACTIONS[action], /[a-z]{4,}/, `${action} has a label a human wrote`);
  }
});

test('each clear route is admin-only, names its action, and marks the write when it lands', () => {
  const routes = [
    ['app.delete(\'/api/admin/health/errors\', authenticate, requireAdmin, adminRoute(\'Clearing the Telegram parsing errors\'', 'buildParseErrorClear()', 'health.clearParseErrors', 'platform'],
    ['app.delete(\'/api/admin/audit-logs\', authenticate, requireAdmin, adminRoute(\'Clearing the audit log\'', 'buildAuditLogClear()', 'audit.clear', 'platform'],
    ['app.delete(\'/api/admin/announcements/history\', authenticate, requireAdmin, adminRoute(\'Clearing the banner history\'', 'buildRetiredAnnouncementClear()', 'announcement.purgeHistory', 'announcement'],
  ];
  for (const [start, builder, action, targetType] of routes) {
    const body = routeBody(start);
    const builderAt = body.indexOf(builder);
    const queryAt = body.indexOf('await pool.query(statement.sql, statement.params)');
    const appliedAt = body.indexOf('markApplied(req)');
    const auditAt = body.indexOf(`action: '${action}'`);
    assert.notEqual(builderAt, -1, `${start} builds its statement in one place`);
    assert.notEqual(queryAt, -1, `${start} runs exactly that statement`);
    assert.ok(builderAt < queryAt, `${start} builds before it runs`);
    assert.ok(queryAt < appliedAt, `${start} reports the mutation as applied only after the delete`);
    assert.ok(appliedAt < auditAt, `${start} records the entry after the write, so a failed audit cannot claim a wipe that did not happen`);
    assert.match(body, new RegExp(`targetType: '${targetType}'`), `${start} points the entry at a known target type`);
    assert.ok(AUDIT_TARGET_TYPES.includes(targetType), `${targetType} is a target type the service accepts`);
    assert.match(body, /res\.set\('Cache-Control', 'no-store'\)\.json\(\{/, `${start} answers with a fresh read for the panel to reload from`);
    assert.match(body, /notice/, `${start} tells the administrator how many rows went, including when it is zero`);
    assert.equal(/return fail\(/.test(body.slice(appliedAt)), false, `${start} cannot call the delete a failure once it has landed`);
  }
});

test('clearing the audit log is itself the entry that survives it', () => {
  const body = routeBody("app.delete('/api/admin/audit-logs'");
  const deleteAt = body.indexOf('await pool.query(statement.sql, statement.params)');
  const recordAt = body.indexOf('await auditLog.record({');
  assert.ok(deleteAt < recordAt, 'the delete happens first, so the record of it is not among the rows removed');
  assert.match(body, /action: 'audit\.clear'/);
  assert.match(body, /Cleared the admin audit log - \$\{removed\} entr/);
  assert.match(body, /this clearing is recorded/i, 'and the answer says so, because an empty log looks identical to a platform nobody ever administered');
});

test('the panel used to promise these lists could never be cleared, and no longer does', () => {
  // A comment that contradicts the routes under it is how the next reader decides the button is a bug.
  const auditSection = index.slice(index.indexOf('/* ----------------------------- Admin: audit trail'), index.indexOf("app.get('/api/admin/audit-logs'"));
  assert.equal(/there is deliberately no route that edits or removes/i.test(auditSection), false);
  assert.match(auditSection, /clearing the history on purpose/i);
});
