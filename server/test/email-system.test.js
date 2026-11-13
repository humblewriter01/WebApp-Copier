import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Webhook } from 'svix';

import { createEmailSystem } from '../services/email-system.js';

const SERVER = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ADMIN_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const REPLY_ID = '33333333-3333-4333-8333-333333333333';
const RESEND_EMAIL_ID = 'recv-email-1';
const SIGNING_SECRET = `whsec_${Buffer.from('test resend signing secret').toString('base64')}`;

function responseJson(data, { ok = true, status = 200 } = {}) {
  return { ok, status, async json() { return data; } };
}

function signedWebhook(event, { body = JSON.stringify(event), eventId = 'msg_email_1', timestamp = new Date() } = {}) {
  const signer = new Webhook(SIGNING_SECRET);
  return {
    rawBody: Buffer.from(body),
    headers: {
      'svix-id': eventId,
      'svix-timestamp': String(Math.floor(timestamp.getTime() / 1000)),
      'svix-signature': signer.sign(eventId, timestamp, body),
    },
  };
}

function recordingPool({ users = [], matchedUser = { id: USER_ID }, insertRows = [{ id: REPLY_ID }] } = {}) {
  const calls = [];
  const pool = {
    calls,
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes('SELECT COUNT(*)::int AS count')) {
        const audience = params[0];
        const count = users.filter((user) => user.marketing_opt_out !== true
          && String(user.email || '').trim()
          && (!audience || String(user.subscription_plan || 'free').toLowerCase() === audience)).length;
        return { rows: [{ count }] };
      }
      if (sql.includes('SELECT id, name, email FROM users WHERE id=$1 LIMIT 1')) {
        return { rows: users.filter((user) => user.id === params[0]).map(({ id, name, email }) => ({ id, name, email })) };
      }
      if (sql.includes('SELECT id, name, email') && sql.includes('FROM users')) {
        const audience = params[0];
        const eligible = users.filter((user) => user.marketing_opt_out !== true
          && String(user.email || '').trim()
          && (!audience || String(user.subscription_plan || 'free').toLowerCase() === audience));
        return { rows: eligible.map(({ id, name, email }) => ({ id, name, email })) };
      }
      if (sql.includes('SELECT id FROM users WHERE LOWER(email)')) return { rows: matchedUser ? [matchedUser] : [] };
      if (sql.includes('INSERT INTO email_replies')) return { rows: insertRows };
      if (sql.includes('FROM email_replies') && sql.includes('ORDER BY received_at DESC')) return { rows: [] };
      if (sql.includes('UPDATE email_replies SET')) return { rows: [{ id: REPLY_ID, read: true }] };
      throw new Error(`Unexpected SQL in test: ${sql}`);
    },
  };
  return pool;
}

const broadcastEnv = {
  BREVO_API_KEY: 'brevo-test-key',
  BREVO_SENDER_EMAIL: 'broadcast@example.com',
  BREVO_SENDER_NAME: 'Signal Desk',
  RESEND_REPLY_TO: 'replies@example.com',
};

test('Brevo broadcast excludes opted-out users and submits groups of at most 50 with replyTo', async () => {
  const users = [
    ...Array.from({ length: 52 }, (_, index) => ({
      id: `user-${index + 1}`,
      name: `Trader ${index + 1}`,
      email: `trader${index + 1}@example.com`,
      subscription_plan: 'starter',
      marketing_opt_out: false,
    })),
    { id: 'opted-out-1', name: 'Opted Out', email: 'stop@example.com', subscription_plan: 'starter', marketing_opt_out: true },
    { id: 'opted-out-2', name: 'Opted Out Two', email: 'stop2@example.com', subscription_plan: 'starter', marketing_opt_out: true },
    { id: 'other-plan', name: 'Pro Trader', email: 'pro@example.com', subscription_plan: 'pro', marketing_opt_out: false },
  ];
  const pool = recordingPool({ users });
  const calls = [];
  const auditRows = [];
  const emailSystem = createEmailSystem({
    pool,
    env: broadcastEnv,
    logger: { error() {}, warn() {} },
    audit: { async record(row) { auditRows.push(row); } },
    fetchImpl: async (url, options) => {
      calls.push({ url, options, payload: JSON.parse(options.body) });
      return responseJson({ messageIds: ['provider-message'] }, { status: 201 });
    },
  });

  const result = await emailSystem.sendBroadcast({
    targetAudience: 'starter',
    subject: '  A market update  ',
    body: 'Hello <traders>\nYour weekly update is ready.',
    actorId: ADMIN_ID,
    actorEmail: 'admin@example.com',
  });

  assert.equal(pool.calls.length, 1, 'the audience is loaded by one query');
  assert.match(pool.calls[0].sql, /COALESCE\(marketing_opt_out, FALSE\) = FALSE/, 'the exclusion is part of the database query itself');
  assert.deepEqual(pool.calls[0].params, ['starter']);
  assert.equal(calls.length, 2, '52 recipients require two provider requests, not 52 individual sends');
  assert.deepEqual(calls.map(({ payload }) => payload.messageVersions.length), [50, 2]);
  assert.equal(calls[0].url, 'https://api.brevo.com/v3/smtp/email');
  assert.equal(calls[0].options.headers['api-key'], 'brevo-test-key');
  assert.deepEqual(calls[0].payload.replyTo, { email: 'replies@example.com' });
  assert.equal(calls[0].payload.sender.email, 'broadcast@example.com');
  assert.equal(calls[0].payload.subject, 'A market update');
  assert.equal(calls[0].payload.textContent, 'Hello <traders>\nYour weekly update is ready.');
  assert.match(calls[0].payload.htmlContent, /Hello &lt;traders&gt;<br \/>/, 'the plain-text body is escaped before being sent as HTML');
  const emailed = calls.flatMap(({ payload }) => payload.messageVersions.map((version) => version.to[0].email));
  assert.equal(emailed.length, 52);
  assert.equal(emailed.includes('stop@example.com'), false);
  assert.equal(emailed.includes('stop2@example.com'), false);
  assert.equal(emailed.includes('pro@example.com'), false, 'the selected plan is applied too');
  assert.deepEqual(result, {
    targetAudience: 'starter',
    recipientCount: 52,
    sentRecipients: 52,
    failedRecipients: 0,
    batchCount: 2,
  });
  assert.equal(auditRows.length, 1);
  assert.equal(auditRows[0].action, 'email.broadcast');
  assert.equal(auditRows[0].summary, 'Admin sent broadcast to 52 users');
  assert.deepEqual(auditRows[0].metadata, {
    targetAudience: 'starter', recipientCount: 52, sentRecipients: 52, failedRecipients: 0, batchCount: 2,
  });
});

test('broadcast audience preview uses the same opt-out and plan filters as sending', async () => {
  const pool = recordingPool({ users: [
    { id: 'free-1', email: 'free@example.com', subscription_plan: 'free', marketing_opt_out: false },
    { id: 'free-2', email: 'stop@example.com', subscription_plan: 'free', marketing_opt_out: true },
    { id: 'starter-1', email: 'starter@example.com', subscription_plan: 'starter', marketing_opt_out: false },
  ] });
  const system = createEmailSystem({ pool, env: broadcastEnv, fetchImpl: async () => responseJson({}) });
  assert.deepEqual(await system.countBroadcastRecipients('free'), { targetAudience: 'free', recipientCount: 1 });
  assert.match(pool.calls[0].sql, /COALESCE\(marketing_opt_out, FALSE\) = FALSE/);
  assert.deepEqual(pool.calls[0].params, ['free']);
  await assert.rejects(() => system.countBroadcastRecipients('enterprise'), /Choose an audience/);
});

test('single-user Brevo email resolves the user from Supabase Postgres, sets replyTo, and records an audit row', async () => {
  const user = { id: USER_ID, name: 'Ada Trader', email: 'ADA@example.com' };
  const pool = recordingPool({ users: [user] });
  const providerCalls = [];
  const auditRows = [];
  const system = createEmailSystem({
    pool,
    env: broadcastEnv,
    logger: { error() {}, warn() {} },
    audit: { async record(row) { auditRows.push(row); } },
    fetchImpl: async (url, options) => {
      providerCalls.push({ url, options, payload: JSON.parse(options.body) });
      return responseJson({ messageId: 'brevo-message-1' }, { status: 201 });
    },
  });

  const result = await system.sendUserEmail({
    userId: USER_ID,
    subject: '  Account update  ',
    body: 'Hello Ada\nYour account is ready.',
    actorId: ADMIN_ID,
    actorEmail: 'admin@example.com',
  });

  assert.equal(pool.calls.length, 1);
  assert.match(pool.calls[0].sql, /SELECT id, name, email FROM users WHERE id=\$1 LIMIT 1/);
  assert.deepEqual(pool.calls[0].params, [USER_ID]);
  assert.equal(providerCalls.length, 1, 'an individual email creates one provider request');
  assert.equal(providerCalls[0].url, 'https://api.brevo.com/v3/smtp/email');
  assert.equal(providerCalls[0].options.headers['api-key'], 'brevo-test-key');
  assert.deepEqual(providerCalls[0].payload.to, [{ email: 'ada@example.com', name: 'Ada Trader' }]);
  assert.deepEqual(providerCalls[0].payload.replyTo, { email: 'replies@example.com' });
  assert.equal(providerCalls[0].payload.sender.email, 'broadcast@example.com');
  assert.equal(providerCalls[0].payload.subject, 'Account update');
  assert.equal(providerCalls[0].payload.textContent, 'Hello Ada\nYour account is ready.');
  assert.match(providerCalls[0].payload.htmlContent, /Hello Ada<br \/>/);
  assert.deepEqual(result, { sent: true, recipientEmail: 'ada@example.com' });
  assert.deepEqual(auditRows, [{
    actorId: ADMIN_ID,
    actorEmail: 'admin@example.com',
    action: 'email.user',
    targetType: 'user',
    targetId: USER_ID,
    summary: 'Admin sent an individual email to ada@example.com.',
    metadata: { recipientEmail: 'ada@example.com', recipientKind: 'user', subject: 'Account update' },
  }]);
});

test('Inbox compose can send a validated direct address and a missing user is never sent to', async () => {
  const pool = recordingPool();
  const providerCalls = [];
  const auditRows = [];
  const system = createEmailSystem({
    pool,
    env: broadcastEnv,
    logger: { error() {}, warn() {} },
    audit: { async record(row) { auditRows.push(row); } },
    fetchImpl: async (_url, options) => {
      providerCalls.push(JSON.parse(options.body));
      return responseJson({}, { status: 201 });
    },
  });

  const result = await system.sendUserEmail({ to: ' Someone@Example.com ', subject: 'A direct note', body: 'Hello there' });
  assert.deepEqual(result, { sent: true, recipientEmail: 'someone@example.com' });
  assert.equal(pool.calls.length, 0, 'the user supplied a direct address rather than a database account');
  assert.deepEqual(providerCalls[0].to, [{ email: 'someone@example.com' }]);
  assert.deepEqual(providerCalls[0].replyTo, { email: 'replies@example.com' });
  assert.equal(auditRows[0].targetType, 'email');
  assert.equal(auditRows[0].targetId, 'someone@example.com');
  assert.equal(auditRows[0].action, 'email.user');

  await assert.rejects(
    () => system.sendUserEmail({ userId: USER_ID, subject: 'Missing', body: 'Do not send' }),
    (error) => error.status === 404 && /could not be found/.test(error.message),
  );
  assert.equal(providerCalls.length, 1, 'a user ID that is not in Supabase is not sent to');
});

test('the Resend webhook verifies Svix against raw bytes before saving sender, bodies, and In-Reply-To', async () => {
  const pool = recordingPool();
  const event = {
    type: 'email.received',
    created_at: '2026-11-13T10:00:00.000Z',
    data: {
      email_id: RESEND_EMAIL_ID,
      from: 'Ada Trader <ADA@example.com>',
      subject: 'Re: Your account',
      html: '<p>Thanks for the note.</p>',
      text: 'Thanks for the note.',
      headers: { 'In-Reply-To': '<original-message@example.com>' },
    },
  };
  const request = signedWebhook(event);
  const system = createEmailSystem({
    pool,
    env: { RESEND_WEBHOOK_SECRET: SIGNING_SECRET },
    logger: { error() {}, warn() {} },
    fetchImpl: async () => { throw new Error('no content lookup should be needed'); },
  });

  const result = await system.handleResendWebhook(request);
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { received: true, duplicate: false, replyId: REPLY_ID });
  assert.equal(pool.calls.length, 2, 'one sender lookup and one reply insert were made');
  assert.deepEqual(pool.calls[0].params, ['ada@example.com']);
  assert.match(pool.calls[1].sql, /ON CONFLICT \(resend_email_id\) DO NOTHING/);
  assert.deepEqual(pool.calls[1].params, [
    USER_ID,
    'ada@example.com',
    'Re: Your account',
    '<p>Thanks for the note.</p>',
    'Thanks for the note.',
    '<original-message@example.com>',
    RESEND_EMAIL_ID,
  ]);

  const tampered = Buffer.from(request.rawBody.toString().replace('Thanks for the note.', 'changed after signing'));
  const invalid = await system.handleResendWebhook({ ...request, rawBody: tampered });
  assert.equal(invalid.status, 400, 'a changed payload is refused');
  assert.equal(pool.calls.length, 2, 'invalid signatures never reach the database');
});

test('Resend inbound email bodies are fetched by email_id when the signed event has only metadata', async () => {
  const pool = recordingPool();
  const event = {
    type: 'email.received',
    data: { email_id: RESEND_EMAIL_ID, from: 'trader@example.com', subject: 'Reply' },
  };
  const request = signedWebhook(event);
  const apiCalls = [];
  const system = createEmailSystem({
    pool,
    env: { RESEND_WEBHOOK_SECRET: SIGNING_SECRET, RESEND_API_KEY: 'resend-test-key' },
    logger: { error() {}, warn() {} },
    fetchImpl: async (url, options) => {
      apiCalls.push({ url, options });
      return responseJson({ data: {
        html: '<p>Fetched HTML</p>',
        text: 'Fetched plain text',
        headers: { 'in-reply-to': '<thread@example.com>' },
      } });
    },
  });

  const result = await system.handleResendWebhook(request);
  assert.equal(result.status, 200);
  assert.equal(apiCalls.length, 1);
  assert.equal(apiCalls[0].url, `https://api.resend.com/emails/receiving/${RESEND_EMAIL_ID}`);
  assert.equal(apiCalls[0].options.headers.authorization, 'Bearer resend-test-key');
  assert.deepEqual(pool.calls[1].params, [
    USER_ID,
    'trader@example.com',
    'Reply',
    '<p>Fetched HTML</p>',
    'Fetched plain text',
    '<thread@example.com>',
    RESEND_EMAIL_ID,
  ]);
});

test('reply listing is newest-first and a read update is constrained to its UUID', async () => {
  const pool = recordingPool();
  const system = createEmailSystem({ pool, env: broadcastEnv, fetchImpl: async () => responseJson({}) });
  assert.deepEqual(await system.listReplies(), []);
  assert.match(pool.calls[0].sql, /FROM email_replies[\s\S]*ORDER BY received_at DESC/);
  assert.deepEqual(await system.markReplyRead(REPLY_ID), { id: REPLY_ID, read: true });
  assert.match(pool.calls[1].sql, /UPDATE email_replies SET "read"=TRUE WHERE id=\$1/);
  assert.deepEqual(pool.calls[1].params, [REPLY_ID]);
  await assert.rejects(() => system.markReplyRead('not-a-uuid'), /valid reply/);
});

test('the admin email routes are mounted behind administrator authentication', () => {
  const index = readFileSync(path.join(SERVER, 'index.js'), 'utf8');
  for (const route of [
    "app.post('/api/admin/broadcast', authenticate, requireAdmin",
    "app.post('/api/admin/email/user', authenticate, requireAdmin",
    "app.get('/api/admin/replies', authenticate, requireAdmin",
    "app.patch('/api/admin/replies/:id/read', authenticate, requireAdmin",
  ]) {
    assert.ok(index.includes(route), `${route} is admin-only`);
  }
  assert.match(index, /emailSystem\.sendBroadcast\(\{/);
  assert.match(index, /emailSystem\.sendUserEmail\(\{/);
  assert.match(index, /emailSystem\.listReplies\(\)/);
  assert.match(index, /emailSystem\.markReplyRead\(req\.params\.id\)/);
});

test('the Resend raw JSON route is mounted before the global JSON parser', () => {
  const index = readFileSync(path.join(SERVER, 'index.js'), 'utf8');
  const rawRouteAt = index.indexOf("app.post('/api/webhooks/resend'");
  const rawParserAt = index.indexOf("express.raw({ type: 'application/json'", rawRouteAt);
  const jsonParserAt = index.indexOf('app.use(express.json(');
  assert.ok(rawRouteAt >= 0, 'the public Resend webhook route is mounted');
  assert.ok(rawParserAt > rawRouteAt && rawParserAt < jsonParserAt, 'express.raw handles the route before express.json is registered');
  assert.match(index.slice(rawRouteAt, jsonParserAt), /emailSystem\.handleResendWebhook\(\{ rawBody: req\.body, headers: req\.headers \}\)/);
});
