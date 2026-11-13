import { Webhook } from 'svix';

const EMAIL_AUDIENCES = Object.freeze(['all', 'free', 'starter', 'pro', 'premium']);
const EMAIL_PATTERN = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BREVO_BATCH_SIZE = 50;
const BREVO_CONCURRENCY = 3;
const MAX_SUBJECT_LENGTH = 200;
const MAX_BODY_LENGTH = 100_000;
const BREVO_API_URL = 'https://api.brevo.com/v3/smtp/email';
const RESEND_API_URL = 'https://api.resend.com/emails/receiving';

function emailError(status, message, code = 'EMAIL_SYSTEM_ERROR') {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

export function normalizeEmailAudience(value) {
  const audience = String(value ?? '').trim().toLowerCase();
  if (!EMAIL_AUDIENCES.includes(audience)) {
    throw emailError(400, 'Choose an audience: all, free, starter, pro, or premium.', 'INVALID_EMAIL_AUDIENCE');
  }
  return audience;
}

function normalizeBroadcastDraft(input = {}) {
  const targetAudience = normalizeEmailAudience(input.targetAudience);
  const subject = String(input.subject ?? '').trim();
  const body = String(input.body ?? '').trim();
  if (!subject) throw emailError(400, 'Enter a subject for the broadcast.', 'INVALID_EMAIL_SUBJECT');
  if (subject.length > MAX_SUBJECT_LENGTH) {
    throw emailError(400, `Keep the subject to ${MAX_SUBJECT_LENGTH} characters or fewer.`, 'INVALID_EMAIL_SUBJECT');
  }
  if (!body) throw emailError(400, 'Write a message before sending the broadcast.', 'INVALID_EMAIL_BODY');
  if (body.length > MAX_BODY_LENGTH) {
    throw emailError(400, `Keep the message to ${MAX_BODY_LENGTH} characters or fewer.`, 'INVALID_EMAIL_BODY');
  }
  return { targetAudience, subject, body };
}

function normalizeIndividualEmailDraft(input = {}) {
  const userId = String(input.userId ?? '').trim();
  const to = String(input.to ?? '').trim().toLowerCase();
  if (userId && to) {
    throw emailError(400, 'Choose a user account or enter a direct email address, not both.', 'INVALID_EMAIL_RECIPIENT');
  }
  if (!userId && !to) throw emailError(400, 'Choose a user account or enter an email address.', 'INVALID_EMAIL_RECIPIENT');
  if (userId && !UUID_PATTERN.test(userId)) {
    throw emailError(400, 'Choose a valid user account.', 'INVALID_EMAIL_RECIPIENT');
  }
  if (to && (to.length > 254 || !EMAIL_PATTERN.test(to))) {
    throw emailError(400, 'Enter a valid recipient email address.', 'INVALID_EMAIL_RECIPIENT');
  }

  const subject = String(input.subject ?? '').trim();
  const body = String(input.body ?? '').trim();
  if (!subject) throw emailError(400, 'Enter a subject for the email.', 'INVALID_EMAIL_SUBJECT');
  if (subject.length > MAX_SUBJECT_LENGTH) {
    throw emailError(400, `Keep the subject to ${MAX_SUBJECT_LENGTH} characters or fewer.`, 'INVALID_EMAIL_SUBJECT');
  }
  if (!body) throw emailError(400, 'Write a message before sending the email.', 'INVALID_EMAIL_BODY');
  if (body.length > MAX_BODY_LENGTH) {
    throw emailError(400, `Keep the message to ${MAX_BODY_LENGTH} characters or fewer.`, 'INVALID_EMAIL_BODY');
  }
  return { userId: userId || null, to: to || null, subject, body };
}

function audienceFilter(targetAudience) {
  if (targetAudience === 'all') return { sql: '', params: [] };
  return {
    sql: ' AND LOWER(COALESCE(subscription_plan, \'free\')) = $1',
    params: [targetAudience],
  };
}

function chunk(items, size) {
  const batches = [];
  for (let index = 0; index < items.length; index += size) batches.push(items.slice(index, index + size));
  return batches;
}

async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character]);
}

function plainTextToHtml(value) {
  return `<div>${escapeHtml(value).replace(/\r\n?/g, '\n').replace(/\n/g, '<br />')}</div>`;
}

function emailAddress(value) {
  if (value && typeof value === 'object') return emailAddress(value.email || value.address || '');
  const raw = String(value ?? '').trim();
  const bracketed = raw.match(/<\s*([^<>]+?)\s*>/);
  return String(bracketed?.[1] || raw).trim().toLowerCase();
}

function firstText(...values) {
  for (const value of values) {
    if (typeof value === 'string') return value;
    if (typeof value === 'number') return String(value);
  }
  return null;
}

function emailBodies(data = {}) {
  const nested = data.body && typeof data.body === 'object' ? data.body : {};
  return {
    html: firstText(data.html, data.body_html, data.bodyHtml, nested.html),
    text: firstText(data.text, data.body_text, data.bodyText, nested.text),
  };
}

function headerValue(headers, wantedName) {
  if (!headers) return null;
  const wanted = wantedName.toLowerCase();
  if (Array.isArray(headers)) {
    const match = headers.find((header) => String(header?.name || header?.key || '').toLowerCase() === wanted);
    return firstText(match?.value, match?.values?.join?.(', '));
  }
  if (typeof headers !== 'object') return null;
  const key = Object.keys(headers).find((name) => name.toLowerCase() === wanted);
  const value = key ? headers[key] : null;
  if (Array.isArray(value)) return value.map((part) => String(part)).join(', ');
  return firstText(value);
}

function webhookHeaders(headers = {}) {
  const value = (name) => {
    const found = headers[name] ?? headers[name.toLowerCase()] ?? headers[name.toUpperCase()];
    return Array.isArray(found) ? found.join(', ') : String(found ?? '');
  };
  return {
    'svix-id': value('svix-id'),
    'svix-timestamp': value('svix-timestamp'),
    'svix-signature': value('svix-signature'),
  };
}

function safeResponseJson(response) {
  if (typeof response?.json === 'function') return response.json();
  if (typeof response?.text === 'function') return response.text().then((text) => JSON.parse(text));
  return Promise.resolve({});
}

/**
 * @typedef {Object} EmailSystemDependencies
 * @property {{query: (sql: string, params?: any[]) => Promise<{rows: any[]}>} | undefined} [pool]
 * @property {{record?: (input: any) => Promise<any>}|undefined} [audit]
 * @property {Record<string, any>} [env]
 * @property {typeof fetch} [fetchImpl]
 * @property {{error?: (message: string, extra?: any) => void, warn?: (message: string, extra?: any) => void}} [logger]
 */

/**
 * The admin broadcast, inbox reads, and Resend receiver share one small boundary around the database and
 * provider APIs. The admin route selects its own recipients on every send (the browser's preview is only a
 * confirmation aid), and the inbound route verifies the original raw bytes before parsing any event data.
 */
export function createEmailSystem(/** @type {EmailSystemDependencies} */ {
  pool,
  audit,
  env = process.env,
  fetchImpl = globalThis.fetch,
  logger = console,
} = {}) {
  if (!pool?.query) throw new TypeError('The email system needs a database pool.');
  if (typeof fetchImpl !== 'function') throw new TypeError('The email system needs fetch.');

  async function countBroadcastRecipients(rawAudience) {
    const targetAudience = normalizeEmailAudience(rawAudience);
    const filter = audienceFilter(targetAudience);
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS count
       FROM users
       WHERE COALESCE(marketing_opt_out, FALSE) = FALSE
         AND email IS NOT NULL
         AND BTRIM(email) <> ''${filter.sql}`,
      filter.params,
    );
    return { targetAudience, recipientCount: Number(rows[0]?.count || 0) };
  }

  async function selectBroadcastRecipients(targetAudience) {
    const filter = audienceFilter(targetAudience);
    const { rows } = await pool.query(
      `SELECT id, name, email
       FROM users
       WHERE COALESCE(marketing_opt_out, FALSE) = FALSE
         AND email IS NOT NULL
         AND BTRIM(email) <> ''${filter.sql}
       ORDER BY created_at ASC, id ASC`,
      filter.params,
    );
    return rows;
  }

  async function recordBroadcastAudit({ targetAudience, recipientCount, sentRecipients, failedRecipients, batchCount, actorId, actorEmail }) {
    if (!audit?.record) return;
    const summary = failedRecipients
      ? `Admin broadcast was accepted for ${sentRecipients} of ${recipientCount} users`
      : `Admin sent broadcast to ${sentRecipients} users`;
    try {
      await audit.record({
        actorId,
        actorEmail,
        action: 'email.broadcast',
        targetType: 'broadcast',
        summary,
        metadata: { targetAudience, recipientCount, sentRecipients, failedRecipients, batchCount },
      });
    } catch (error) {
      logger?.error?.('Email broadcast audit entry could not be written', { code: error?.code || 'AUDIT_WRITE_FAILED' });
    }
  }

  async function sendBroadcast(input = {}) {
    const draft = normalizeBroadcastDraft(input);
    const recipients = await selectBroadcastRecipients(draft.targetAudience);
    const recipientCount = recipients.length;
    const batches = chunk(recipients, BREVO_BATCH_SIZE);
    const apiKey = String(env.BREVO_API_KEY || '').trim();
    const senderEmail = String(env.BREVO_SENDER_EMAIL || '').trim().toLowerCase();
    const replyToEmail = String(env.RESEND_REPLY_TO || '').trim().toLowerCase();

    if (recipientCount > 0) {
      if (!apiKey) throw emailError(503, 'Brevo is not configured for broadcasts.', 'BREVO_NOT_CONFIGURED');
      if (!EMAIL_PATTERN.test(senderEmail)) {
        throw emailError(503, 'Set a valid BREVO_SENDER_EMAIL address before sending broadcasts.', 'BREVO_SENDER_NOT_CONFIGURED');
      }
      if (!EMAIL_PATTERN.test(replyToEmail)) {
        throw emailError(503, 'Set a valid RESEND_REPLY_TO address before sending broadcasts.', 'RESEND_REPLY_TO_NOT_CONFIGURED');
      }
    }

    const sendBatch = async (batch, index) => {
      const messageVersions = batch.map((recipient) => ({
        to: [{
          email: String(recipient.email).trim(),
          ...(recipient.name ? { name: String(recipient.name).trim() } : {}),
        }],
      }));
      const payload = {
        sender: {
          email: senderEmail,
          name: String(env.BREVO_SENDER_NAME || 'Signal Desk').trim() || 'Signal Desk',
        },
        replyTo: { email: replyToEmail },
        subject: draft.subject,
        htmlContent: plainTextToHtml(draft.body),
        textContent: draft.body,
        messageVersions,
      };

      try {
        const response = await fetchImpl(BREVO_API_URL, {
          method: 'POST',
          headers: { accept: 'application/json', 'content-type': 'application/json', 'api-key': apiKey },
          body: JSON.stringify(payload),
          ...(typeof AbortSignal?.timeout === 'function' ? { signal: AbortSignal.timeout(20_000) } : {}),
        });
        if (!response?.ok) {
          logger?.error?.('Brevo broadcast batch was rejected', {
            batch: index + 1,
            status: Number(response?.status) || 0,
            recipientCount: batch.length,
          });
          return { accepted: 0, failed: batch.length };
        }
        return { accepted: batch.length, failed: 0 };
      } catch (error) {
        logger?.error?.('Brevo broadcast batch failed', {
          batch: index + 1,
          code: error?.code || error?.name || 'BREVO_REQUEST_FAILED',
          recipientCount: batch.length,
        });
        return { accepted: 0, failed: batch.length };
      }
    };

    const results = await mapWithConcurrency(batches, BREVO_CONCURRENCY, sendBatch);
    const sentRecipients = results.reduce((total, result) => total + (result?.accepted || 0), 0);
    const failedRecipients = recipientCount - sentRecipients;
    await recordBroadcastAudit({
      targetAudience: draft.targetAudience,
      recipientCount,
      sentRecipients,
      failedRecipients,
      batchCount: batches.length,
      actorId: input.actorId,
      actorEmail: input.actorEmail,
    });
    return {
      targetAudience: draft.targetAudience,
      recipientCount,
      sentRecipients,
      failedRecipients,
      batchCount: batches.length,
    };
  }

  async function sendUserEmail(input = {}) {
    const draft = normalizeIndividualEmailDraft(input);
    let recipient;
    if (draft.userId) {
      const { rows } = await pool.query(
        'SELECT id, name, email FROM users WHERE id=$1 LIMIT 1',
        [draft.userId],
      );
      recipient = rows[0];
      if (!recipient) throw emailError(404, 'That user account could not be found.', 'EMAIL_USER_NOT_FOUND');
      const email = String(recipient.email ?? '').trim().toLowerCase();
      if (email.length > 254 || !EMAIL_PATTERN.test(email)) {
        throw emailError(422, 'That user account does not have a valid email address.', 'EMAIL_USER_ADDRESS_INVALID');
      }
      recipient = { ...recipient, email };
    } else {
      recipient = { email: draft.to };
    }

    const apiKey = String(env.BREVO_API_KEY || '').trim();
    const senderEmail = String(env.BREVO_SENDER_EMAIL || '').trim().toLowerCase();
    const replyToEmail = String(env.RESEND_REPLY_TO || '').trim().toLowerCase();
    if (!apiKey) throw emailError(503, 'Brevo is not configured for individual email.', 'BREVO_NOT_CONFIGURED');
    if (!EMAIL_PATTERN.test(senderEmail)) {
      throw emailError(503, 'Set a valid BREVO_SENDER_EMAIL address before sending individual email.', 'BREVO_SENDER_NOT_CONFIGURED');
    }
    if (!EMAIL_PATTERN.test(replyToEmail)) {
      throw emailError(503, 'Set a valid RESEND_REPLY_TO address before sending individual email.', 'RESEND_REPLY_TO_NOT_CONFIGURED');
    }

    const payload = {
      sender: {
        email: senderEmail,
        name: String(env.BREVO_SENDER_NAME || 'Signal Desk').trim() || 'Signal Desk',
      },
      to: [{
        email: recipient.email,
        ...(recipient.name ? { name: String(recipient.name).trim() } : {}),
      }],
      replyTo: { email: replyToEmail },
      subject: draft.subject,
      htmlContent: plainTextToHtml(draft.body),
      textContent: draft.body,
    };

    let response;
    try {
      response = await fetchImpl(BREVO_API_URL, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json', 'api-key': apiKey },
        body: JSON.stringify(payload),
        ...(typeof AbortSignal?.timeout === 'function' ? { signal: AbortSignal.timeout(20_000) } : {}),
      });
    } catch (error) {
      logger?.error?.('Brevo individual email request failed', { code: error?.code || error?.name || 'BREVO_REQUEST_FAILED' });
      throw emailError(502, 'Brevo could not be reached. Try again in a moment.', 'BREVO_REQUEST_FAILED');
    }
    if (!response?.ok) {
      logger?.error?.('Brevo rejected an individual email', { status: Number(response?.status) || 0 });
      throw emailError(502, 'Brevo could not accept the email. Check the provider settings and try again.', 'BREVO_EMAIL_REJECTED');
    }

    if (audit?.record) {
      try {
        await audit.record({
          actorId: input.actorId,
          actorEmail: input.actorEmail,
          action: 'email.user',
          targetType: draft.userId ? 'user' : 'email',
          targetId: draft.userId || recipient.email,
          summary: `Admin sent an individual email to ${recipient.email}.`,
          metadata: {
            recipientEmail: recipient.email,
            recipientKind: draft.userId ? 'user' : 'direct',
            subject: draft.subject,
          },
        });
      } catch (error) {
        logger?.error?.('Individual email audit entry could not be written', { code: error?.code || 'AUDIT_WRITE_FAILED' });
      }
    }

    return { sent: true, recipientEmail: recipient.email };
  }

  async function fetchResendEmail(emailId, apiKey) {
    const response = await fetchImpl(`${RESEND_API_URL}/${encodeURIComponent(emailId)}`, {
      method: 'GET',
      headers: { accept: 'application/json', authorization: `Bearer ${apiKey}` },
      ...(typeof AbortSignal?.timeout === 'function' ? { signal: AbortSignal.timeout(15_000) } : {}),
    });
    if (!response?.ok) {
      const error = new Error(`Resend receiving-email lookup returned HTTP ${Number(response?.status) || 0}.`);
      error.status = Number(response?.status) || 502;
      throw error;
    }
    const payload = await safeResponseJson(response);
    return payload?.data && typeof payload.data === 'object' ? payload.data : payload;
  }

  /** @param {{rawBody?: Buffer|string, headers?: Record<string, any>}} [input] */
  async function handleResendWebhook({ rawBody, headers = {} } = {}) {
    const secret = String(env.RESEND_WEBHOOK_SECRET || '').trim();
    if (!secret) return { status: 503, body: { error: 'Resend inbound email is not configured.' } };
    if (!Buffer.isBuffer(rawBody) && typeof rawBody !== 'string') {
      return { status: 400, body: { error: 'The webhook body must be raw JSON.' } };
    }

    const signedHeaders = webhookHeaders(headers);
    if (!signedHeaders['svix-id'] || !signedHeaders['svix-timestamp'] || !signedHeaders['svix-signature']) {
      return { status: 400, body: { error: 'The webhook signature headers are missing.' } };
    }

    let event;
    try {
      new Webhook(secret).verify(rawBody, signedHeaders);
      event = JSON.parse(Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : rawBody);
    } catch {
      return { status: 400, body: { error: 'The Resend webhook signature or payload is invalid.' } };
    }

    if (event?.type !== 'email.received') {
      return { status: 200, body: { received: true, ignored: true } };
    }
    const data = event?.data && typeof event.data === 'object' ? event.data : null;
    if (!data) return { status: 400, body: { error: 'The inbound email event has no data.' } };

    const emailId = firstText(data.email_id, data.emailId);
    let contentData = data;
    let bodies = emailBodies(contentData);
    if (bodies.html === null && bodies.text === null) {
      if (!emailId) {
        return { status: 422, body: { error: 'The inbound email did not include a body or a Resend email ID.' } };
      }
      const apiKey = String(env.RESEND_API_KEY || '').trim();
      if (!apiKey) return { status: 503, body: { error: 'Set RESEND_API_KEY to retrieve inbound email bodies from Resend.' } };
      try {
        const receivedEmail = await fetchResendEmail(emailId, apiKey);
        contentData = { ...receivedEmail, ...data };
        bodies = emailBodies(contentData);
      } catch (error) {
        logger?.warn?.('Resend inbound email content could not be retrieved', {
          code: error?.code || 'RESEND_RECEIVING_LOOKUP_FAILED',
          status: Number(error?.status) || 0,
        });
        return { status: 502, body: { error: 'The inbound email body could not be retrieved from Resend.' } };
      }
    }

    const fromEmail = emailAddress(data.from ?? data.from_email ?? data.fromEmail ?? contentData.from);
    if (!EMAIL_PATTERN.test(fromEmail)) {
      return { status: 422, body: { error: 'The inbound email sender address is invalid.' } };
    }
    const subject = firstText(data.subject, contentData.subject) || '';
    const inReplyTo = firstText(
      data.in_reply_to,
      data.inReplyTo,
      headerValue(data.headers, 'in-reply-to'),
      headerValue(contentData.headers, 'in-reply-to'),
    );

    try {
      const { rows: users } = await pool.query(
        'SELECT id FROM users WHERE LOWER(email)=LOWER($1) LIMIT 1',
        [fromEmail],
      );
      const { rows } = await pool.query(
        `INSERT INTO email_replies(user_id,from_email,subject,body_html,body_text,in_reply_to,resend_email_id)
         VALUES($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (resend_email_id) DO NOTHING
         RETURNING id`,
        [users[0]?.id || null, fromEmail, subject, bodies.html, bodies.text, inReplyTo, emailId || null],
      );
      return {
        status: 200,
        body: { received: true, duplicate: rows.length === 0, replyId: rows[0]?.id || null },
      };
    } catch (error) {
      logger?.error?.('Resend inbound email could not be saved', { code: error?.code || 'EMAIL_REPLY_WRITE_FAILED' });
      return { status: 500, body: { error: 'The inbound email could not be saved.' } };
    }
  }

  async function listReplies() {
    const { rows } = await pool.query(
      `SELECT id,user_id AS "userId",from_email AS "fromEmail",subject,
        body_html AS "bodyHtml",body_text AS "bodyText",received_at AS "receivedAt",
        in_reply_to AS "inReplyTo","read" AS "read"
       FROM email_replies
       ORDER BY received_at DESC`,
    );
    return rows;
  }

  async function markReplyRead(id) {
    const replyId = String(id ?? '').trim();
    if (!UUID_PATTERN.test(replyId)) throw emailError(400, 'Choose a valid reply.', 'INVALID_REPLY_ID');
    const { rows } = await pool.query(
      'UPDATE email_replies SET "read"=TRUE WHERE id=$1 RETURNING id,"read" AS "read"',
      [replyId],
    );
    if (!rows[0]) throw emailError(404, 'That reply could not be found.', 'REPLY_NOT_FOUND');
    return rows[0];
  }

  return {
    countBroadcastRecipients,
    sendBroadcast,
    sendUserEmail,
    handleResendWebhook,
    listReplies,
    markReplyRead,
  };
}
