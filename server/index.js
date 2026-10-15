import 'dotenv/config';
import express from 'express';
import { createServer } from 'node:http';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import { Server } from 'socket.io';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { NewMessage } from 'telegram/events/index.js';
import { pool, initializeDatabase } from './db.js';
import { metaApiRequest, toSafeMetaApiAccount } from './services/metaapi.js';

const app = express();
const httpServer = createServer(app);
const allowedOrigins = (process.env.CLIENT_URL || '').split(',').map((item) => item.trim()).filter(Boolean);
const io = new Server(httpServer, { cors: { origin: allowedOrigins.length ? allowedOrigins : true, credentials: true } });
const PORT = Number(process.env.PORT || 5000);
const telegramClients = new Map();
const telegramLogins = new Map();

const log = (level, message, extra = {}) => {
  const safe = { ...extra };
  delete safe.phoneNumber; delete safe.token; delete safe.apiToken; delete safe.metaApiToken; delete safe.session; delete safe.password;
  console[level]?.(JSON.stringify({ at: new Date().toISOString(), level, message, ...safe }));
};
const asyncRoute = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
const fail = (res, status, error) => res.status(status).json({ error });

app.disable('x-powered-by');
app.use(helmet());
app.use(compression());
app.use(cors({
  origin(origin, callback) {
    if (!origin || !allowedOrigins.length || allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error('Origin not allowed'));
  },
  credentials: true,
}));
app.use(express.json({ limit: '1mb' }));
app.use('/api/auth', rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false }));
app.use('/api/metaapi', rateLimit({ windowMs: 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false }));

function parseSignal(message) {
  const sideMatch = /\b(BUY|SELL|LONG|SHORT)\b/i.exec(message);
  const symbolMatch = /\b(?:XAU\/?USD|XAG\/?USD|BTC\/?USD|ETH\/?USD|[A-Z]{3}\/?[A-Z]{3}|[A-Z]{2,10}USDT)\b/i.exec(message.toUpperCase());
  const findNumber = (pattern) => { const match = pattern.exec(message); return match ? Number(match[1]) : null; };
  return {
    symbol: symbolMatch?.[0]?.replace('/', '') || null,
    side: sideMatch ? (['BUY', 'LONG'].includes(sideMatch[1].toUpperCase()) ? 'buy' : 'sell') : null,
    entryPrice: findNumber(/\b(?:ENTRY|PRICE|AT)\s*[:=@-]?\s*(\d+(?:\.\d+)?)/i),
    stopLoss: findNumber(/\b(?:SL|STOP(?:\s+LOSS)?)\s*[:=@-]?\s*(\d+(?:\.\d+)?)/i),
    takeProfit: findNumber(/\b(?:TP\d*|TAKE\s+PROFIT)\s*[:=@-]?\s*(\d+(?:\.\d+)?)/i),
  };
}

function encryptSecret(value) {
  const secret = process.env.SESSION_ENCRYPTION_KEY;
  if (!secret) throw new Error('Application credential encryption is not configured');
  const key = crypto.createHash('sha256').update(secret).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return `${iv.toString('base64')}.${cipher.getAuthTag().toString('base64')}.${ciphertext.toString('base64')}`;
}

function decryptSecret(value) {
  const secret = process.env.SESSION_ENCRYPTION_KEY;
  if (!secret) throw new Error('Application credential encryption is not configured');
  const [ivText, tagText, bodyText] = value.split('.');
  const key = crypto.createHash('sha256').update(secret).digest();
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivText, 'base64'));
  decipher.setAuthTag(Buffer.from(tagText, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(bodyText, 'base64')), decipher.final()]).toString('utf8');
}

function issueToken(user, rememberMe = false) {
  return jwt.sign({ sub: user.id, email: user.email }, process.env.JWT_SECRET, { expiresIn: rememberMe ? '30d' : '12h' });
}
function authenticate(req, res, next) {
  const token = req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) return fail(res, 401, 'Sign in to continue.');
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.userId = payload.sub;
    req.userEmail = payload.email;
    return next();
  } catch {
    return fail(res, 401, 'Your session has expired. Please sign in again.');
  }
}
function publicUser(row) { return { id: row.id, name: row.name, email: row.email, createdAt: row.created_at }; }

async function getMetaApiToken(userId) {
  const { rows } = await pool.query('SELECT encrypted_api_token FROM metaapi_credentials WHERE user_id=$1', [userId]);
  return rows[0]?.encrypted_api_token ? decryptSecret(rows[0].encrypted_api_token) : null;
}

async function saveSignal(userId, message, channel = {}) {
  const parsed = parseSignal(message);
  const { rows } = await pool.query(
    `INSERT INTO signals(user_id,channel_id,channel_title,message,symbol,side,entry_price,stop_loss,take_profit)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING id,channel_id AS "channelId",channel_title AS "channelTitle",message,symbol,side,
       entry_price AS "entryPrice",stop_loss AS "stopLoss",take_profit AS "takeProfit",status,created_at AS "createdAt"`,
    [userId, channel.channelId || null, channel.title || null, message, parsed.symbol, parsed.side, parsed.entryPrice, parsed.stopLoss, parsed.takeProfit],
  );
  io.to(`user:${userId}`).emit('signal:received', rows[0]);
  return rows[0];
}

async function startTelegramListener(userId, client) {
  const current = telegramClients.get(userId);
  if (!current || current.handler) return;
  const handler = async (event) => {
    try {
      const message = event.message;
      const chatId = message?.chatId?.toString();
      const text = message?.message?.trim();
      if (!chatId || !text) return;
      const { rows } = await pool.query(
        'SELECT channel_id AS "channelId",title FROM channels WHERE user_id=$1 AND channel_id=$2 AND enabled=TRUE',
        [userId, chatId],
      );
      if (rows.length) await saveSignal(userId, text, { channelId: chatId, title: rows[0].title });
    } catch (error) {
      log('error', 'Telegram update processing failed', { userId, error: error.message });
    }
  };
  client.addEventHandler(handler, new NewMessage({}));
  current.handler = handler;
}

async function restoreTelegramClient(userId) {
  const current = telegramClients.get(userId);
  if (current?.client?.connected) return current.client;
  const { rows } = await pool.query('SELECT telegram_session FROM users WHERE id=$1', [userId]);
  if (!rows[0]?.telegram_session) return null;
  if (!process.env.API_ID || !process.env.API_HASH) throw new Error('Telegram API credentials are not configured');
  const client = new TelegramClient(new StringSession(decryptSecret(rows[0].telegram_session)), Number(process.env.API_ID), process.env.API_HASH, { connectionRetries: 3 });
  await client.connect();
  if (!(await client.checkAuthorization())) {
    await client.disconnect();
    await pool.query('UPDATE users SET telegram_connected=FALSE,telegram_session=NULL WHERE id=$1', [userId]);
    return null;
  }
  telegramClients.set(userId, { client, handler: null });
  await startTelegramListener(userId, client);
  await pool.query('UPDATE users SET telegram_connected=TRUE WHERE id=$1', [userId]);
  return client;
}

io.use((socket, next) => {
  try {
    const payload = jwt.verify(socket.handshake.auth?.token, process.env.JWT_SECRET);
    socket.userId = payload.sub;
    next();
  } catch { next(new Error('Authentication required')); }
});
io.on('connection', (socket) => {
  socket.join(`user:${socket.userId}`);
  socket.emit('connected', { ok: true });
});

app.get('/health', asyncRoute(async (_req, res) => { await pool.query('SELECT 1'); res.json({ status: 'ok', timestamp: new Date().toISOString() }); }));
app.get('/api/health', asyncRoute(async (_req, res) => { await pool.query('SELECT 1'); res.json({ status: 'ok', timestamp: new Date().toISOString() }); }));

app.post('/api/auth/register', asyncRoute(async (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 100);
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  if (!name || !/^\S+@\S+\.\S+$/.test(email) || password.length < 10) return fail(res, 400, 'Enter a name, valid email, and password with at least 10 characters.');
  const hash = await bcrypt.hash(password, 12);
  try {
    const { rows } = await pool.query('INSERT INTO users(name,email,password_hash) VALUES($1,$2,$3) RETURNING id,name,email,created_at', [name, email, hash]);
    await pool.query('INSERT INTO settings(user_id) VALUES($1) ON CONFLICT DO NOTHING', [rows[0].id]);
    const user = publicUser(rows[0]);
    res.status(201).json({ token: issueToken(user, req.body.rememberMe === true), user });
  } catch (error) {
    if (error.code === '23505') return fail(res, 409, 'An account with that email already exists.');
    throw error;
  }
}));
app.post('/api/auth/login', asyncRoute(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const { rows } = await pool.query('SELECT id,name,email,password_hash,created_at FROM users WHERE email=$1', [email]);
  if (!rows[0] || !(await bcrypt.compare(password, rows[0].password_hash))) return fail(res, 401, 'Email or password is incorrect.');
  await pool.query('UPDATE users SET last_login=NOW() WHERE id=$1', [rows[0].id]);
  const user = publicUser(rows[0]);
  res.json({ token: issueToken(user, req.body.rememberMe === true), user });
}));
app.get('/api/auth/me', authenticate, asyncRoute(async (req, res) => {
  const { rows } = await pool.query('SELECT id,name,email,created_at FROM users WHERE id=$1', [req.userId]);
  if (!rows[0]) return fail(res, 404, 'User not found.');
  res.json({ user: publicUser(rows[0]) });
}));

app.get('/api/dashboard', authenticate, asyncRoute(async (req, res) => {
  const [signalsCount, channelsCount, accountsCount, recentSignals, settings] = await Promise.all([
    pool.query('SELECT COUNT(*)::int AS count FROM signals WHERE user_id=$1', [req.userId]),
    pool.query('SELECT COUNT(*)::int AS count FROM channels WHERE user_id=$1 AND enabled=TRUE', [req.userId]),
    pool.query('SELECT COUNT(*)::int AS count FROM accounts WHERE user_id=$1', [req.userId]),
    pool.query(`SELECT id,channel_title AS "channelTitle",message,symbol,side,entry_price AS "entryPrice",stop_loss AS "stopLoss",take_profit AS "takeProfit",status,created_at AS "createdAt" FROM signals WHERE user_id=$1 ORDER BY created_at DESC LIMIT 10`, [req.userId]),
    pool.query('SELECT risk_mode AS "riskMode",risk_percent AS "riskPercent",max_open_positions AS "maxOpenPositions",daily_loss_limit AS "dailyLossLimit" FROM settings WHERE user_id=$1', [req.userId]),
  ]);
  res.json({
    stats: { totalSignals: signalsCount.rows[0].count, activeChannels: channelsCount.rows[0].count, accounts: accountsCount.rows[0].count },
    signals: recentSignals.rows,
    settings: settings.rows[0] || { riskMode: 'fixed', riskPercent: 1, maxOpenPositions: 5, dailyLossLimit: 5 },
    trading: { liveExecutionEnabled: false, message: 'Signal capture only. This deployment does not send live orders.' },
  });
}));

app.get('/api/channels', authenticate, asyncRoute(async (req, res) => {
  const { rows } = await pool.query('SELECT id,channel_id AS "channelId",title,username,enabled,created_at AS "createdAt" FROM channels WHERE user_id=$1 ORDER BY created_at DESC', [req.userId]);
  res.json({ channels: rows });
}));
app.post('/api/channels', authenticate, asyncRoute(async (req, res) => {
  const channelId = String(req.body.channelId || '').trim();
  const title = String(req.body.title || '').trim().slice(0, 160);
  const username = String(req.body.username || '').trim().slice(0, 100) || null;
  if (!channelId || !title) return fail(res, 400, 'Channel ID and title are required.');
  const { rows } = await pool.query(
    `INSERT INTO channels(user_id,channel_id,title,username) VALUES($1,$2,$3,$4)
     ON CONFLICT(user_id,channel_id) DO UPDATE SET title=EXCLUDED.title,username=EXCLUDED.username,enabled=TRUE
     RETURNING id,channel_id AS "channelId",title,username,enabled,created_at AS "createdAt"`,
    [req.userId, channelId, title, username],
  );
  const client = telegramClients.get(req.userId)?.client;
  if (client) await startTelegramListener(req.userId, client);
  res.status(201).json({ channel: rows[0] });
}));
app.delete('/api/channels/:id', authenticate, asyncRoute(async (req, res) => {
  const result = await pool.query('DELETE FROM channels WHERE id=$1 AND user_id=$2', [req.params.id, req.userId]);
  if (!result.rowCount) return fail(res, 404, 'Channel not found.');
  res.json({ ok: true });
}));

app.get('/api/signals', authenticate, asyncRoute(async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);
  const { rows } = await pool.query(`SELECT id,channel_title AS "channelTitle",message,symbol,side,entry_price AS "entryPrice",stop_loss AS "stopLoss",take_profit AS "takeProfit",status,created_at AS "createdAt" FROM signals WHERE user_id=$1 ORDER BY created_at DESC LIMIT $2`, [req.userId, limit]);
  res.json({ signals: rows });
}));
app.post('/api/signals', authenticate, asyncRoute(async (req, res) => {
  const message = String(req.body.message || '').trim().slice(0, 5000);
  if (!message) return fail(res, 400, 'Enter a signal message.');
  const signal = await saveSignal(req.userId, message, { title: 'Manual entry' });
  res.status(201).json({ signal });
}));

app.get('/api/accounts', authenticate, asyncRoute(async (req, res) => {
  const { rows } = await pool.query('SELECT id,label,broker,platform,account_reference AS "accountReference",created_at AS "createdAt" FROM accounts WHERE user_id=$1 ORDER BY created_at DESC', [req.userId]);
  res.json({ accounts: rows });
}));
app.post('/api/accounts', authenticate, asyncRoute(async (req, res) => {
  const label = String(req.body.label || '').trim().slice(0, 100);
  if (!label) return fail(res, 400, 'Account label is required.');
  const { rows } = await pool.query(
    'INSERT INTO accounts(user_id,label,broker,platform,account_reference) VALUES($1,$2,$3,$4,$5) RETURNING id,label,broker,platform,account_reference AS "accountReference",created_at AS "createdAt"',
    [req.userId, label, String(req.body.broker || '').trim().slice(0, 100) || null, String(req.body.platform || '').trim().slice(0, 50) || null, String(req.body.accountReference || '').trim().slice(0, 100) || null],
  );
  res.status(201).json({ account: rows[0] });
}));
app.delete('/api/accounts/:id', authenticate, asyncRoute(async (req, res) => {
  const result = await pool.query('DELETE FROM accounts WHERE id=$1 AND user_id=$2', [req.params.id, req.userId]);
  if (!result.rowCount) return fail(res, 404, 'Account not found.');
  res.json({ ok: true });
}));

app.get('/api/metaapi/status', authenticate, asyncRoute(async (req, res) => {
  const [{ rows: credentials }, { rows: linked }] = await Promise.all([
    pool.query('SELECT updated_at FROM metaapi_credentials WHERE user_id=$1', [req.userId]),
    pool.query('SELECT COUNT(*)::int AS count FROM metaapi_accounts WHERE user_id=$1', [req.userId]),
  ]);
  res.json({ configured: Boolean(credentials[0]), linkedAccounts: linked[0].count, updatedAt: credentials[0]?.updated_at || null });
}));
app.put('/api/metaapi/connection', authenticate, asyncRoute(async (req, res) => {
  const apiToken = typeof req.body.apiToken === 'string' ? req.body.apiToken.trim() : '';
  if (apiToken.length < 20 || apiToken.length > 4096) return fail(res, 400, 'Enter a valid MetaAPI token.');
  const accounts = await metaApiRequest(apiToken, '/users/current/accounts');
  if (!Array.isArray(accounts)) return fail(res, 502, 'MetaAPI returned an unexpected account list.');
  const encryptedApiToken = encryptSecret(apiToken);
  await pool.query(
    `INSERT INTO metaapi_credentials(user_id,encrypted_api_token) VALUES($1,$2)
     ON CONFLICT(user_id) DO UPDATE SET encrypted_api_token=EXCLUDED.encrypted_api_token,updated_at=NOW()`,
    [req.userId, encryptedApiToken],
  );
  res.json({ configured: true, accountCount: accounts.length });
}));
app.delete('/api/metaapi/connection', authenticate, asyncRoute(async (req, res) => {
  await pool.query('DELETE FROM metaapi_credentials WHERE user_id=$1', [req.userId]);
  await pool.query('DELETE FROM metaapi_accounts WHERE user_id=$1', [req.userId]);
  res.json({ configured: false, ok: true });
}));
app.get('/api/metaapi/accounts', authenticate, asyncRoute(async (req, res) => {
  const apiToken = await getMetaApiToken(req.userId);
  if (!apiToken) return fail(res, 409, 'Connect a MetaAPI token first.');
  const accounts = await metaApiRequest(apiToken, '/users/current/accounts');
  if (!Array.isArray(accounts)) return fail(res, 502, 'MetaAPI returned an unexpected account list.');
  res.json({ accounts: accounts.map(toSafeMetaApiAccount).filter(Boolean) });
}));
app.get('/api/metaapi/linked-accounts', authenticate, asyncRoute(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id,metaapi_account_id AS "metaApiAccountId",login,name,platform,state,created_at AS "createdAt"
     FROM metaapi_accounts WHERE user_id=$1 ORDER BY created_at DESC`,
    [req.userId],
  );
  res.json({ accounts: rows });
}));
app.post('/api/metaapi/accounts/link', authenticate, asyncRoute(async (req, res) => {
  const apiToken = await getMetaApiToken(req.userId);
  if (!apiToken) return fail(res, 409, 'Connect a MetaAPI token first.');
  const accountId = String(req.body.accountId || '').trim();
  if (!accountId || accountId.length > 200) return fail(res, 400, 'A valid MetaAPI account ID is required.');
  const accountDetails = await metaApiRequest(apiToken, `/users/current/accounts/${encodeURIComponent(accountId)}`);
  const account = toSafeMetaApiAccount(accountDetails);
  if (!account || account.id !== accountId) return fail(res, 502, 'MetaAPI returned invalid account details.');
  const { rows } = await pool.query(
    `INSERT INTO metaapi_accounts(user_id,metaapi_account_id,login,name,platform,state)
     VALUES($1,$2,$3,$4,$5,$6)
     ON CONFLICT(user_id,metaapi_account_id) DO UPDATE SET login=EXCLUDED.login,name=EXCLUDED.name,platform=EXCLUDED.platform,state=EXCLUDED.state
     RETURNING id,metaapi_account_id AS "metaApiAccountId",login,name,platform,state,created_at AS "createdAt"`,
    [req.userId, account.id, account.login, account.name, account.platform, account.state],
  );
  res.status(201).json({ account: rows[0] });
}));
app.delete('/api/metaapi/accounts/:accountId', authenticate, asyncRoute(async (req, res) => {
  const result = await pool.query('DELETE FROM metaapi_accounts WHERE user_id=$1 AND metaapi_account_id=$2', [req.userId, req.params.accountId]);
  if (!result.rowCount) return fail(res, 404, 'Linked MetaAPI account not found.');
  res.json({ ok: true });
}));

app.get('/api/settings', authenticate, asyncRoute(async (req, res) => {
  const { rows } = await pool.query('SELECT risk_mode AS "riskMode",risk_percent AS "riskPercent",max_open_positions AS "maxOpenPositions",daily_loss_limit AS "dailyLossLimit" FROM settings WHERE user_id=$1', [req.userId]);
  res.json({ settings: rows[0] || { riskMode: 'fixed', riskPercent: 1, maxOpenPositions: 5, dailyLossLimit: 5 } });
}));
app.put('/api/settings', authenticate, asyncRoute(async (req, res) => {
  const riskMode = ['fixed', 'percent'].includes(req.body.riskMode) ? req.body.riskMode : 'fixed';
  const riskPercent = Math.min(Math.max(Number(req.body.riskPercent) || 1, 0.1), 5);
  const maxOpenPositions = Math.min(Math.max(Math.trunc(Number(req.body.maxOpenPositions) || 5), 1), 50);
  const dailyLossLimit = Math.min(Math.max(Number(req.body.dailyLossLimit) || 5, 1), 25);
  const { rows } = await pool.query(
    `INSERT INTO settings(user_id,risk_mode,risk_percent,max_open_positions,daily_loss_limit)
     VALUES($1,$2,$3,$4,$5) ON CONFLICT(user_id) DO UPDATE SET risk_mode=EXCLUDED.risk_mode,risk_percent=EXCLUDED.risk_percent,max_open_positions=EXCLUDED.max_open_positions,daily_loss_limit=EXCLUDED.daily_loss_limit,updated_at=NOW()
     RETURNING risk_mode AS "riskMode",risk_percent AS "riskPercent",max_open_positions AS "maxOpenPositions",daily_loss_limit AS "dailyLossLimit"`,
    [req.userId, riskMode, riskPercent, maxOpenPositions, dailyLossLimit],
  );
  res.json({ settings: rows[0] });
}));
app.get('/api/trades', authenticate, asyncRoute(async (req, res) => {
  const { rows } = await pool.query('SELECT id,symbol,side,quantity,entry_price AS "entryPrice",exit_price AS "exitPrice",pnl,status,created_at AS "createdAt" FROM trades WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50', [req.userId]);
  res.json({ trades: rows, liveExecutionEnabled: false });
}));

app.get('/api/telegram/status', authenticate, asyncRoute(async (req, res) => {
  const { rows } = await pool.query('SELECT telegram_connected FROM users WHERE id=$1', [req.userId]);
  const configured = Boolean(process.env.API_ID && process.env.API_HASH && process.env.SESSION_ENCRYPTION_KEY);
  let connected = Boolean(rows[0]?.telegram_connected && telegramClients.get(req.userId)?.client?.connected);
  if (rows[0]?.telegram_connected && !connected && configured) {
    try { connected = Boolean(await restoreTelegramClient(req.userId)); } catch (error) { log('warn', 'Telegram session restore deferred', { userId: req.userId, error: error.message }); }
  }
  res.json({ configured, connected, message: configured ? null : 'Add Telegram API ID and API hash in the service environment to enable Telegram.' });
}));
app.post('/api/telegram/request-code', authenticate, asyncRoute(async (req, res) => {
  if (!process.env.API_ID || !process.env.API_HASH) return fail(res, 503, 'Telegram API credentials are not configured on the service.');
  const phoneNumber = String(req.body.phoneNumber || '').trim();
  if (!/^\+[1-9]\d{7,14}$/.test(phoneNumber)) return fail(res, 400, 'Use an international phone number, such as +15551234567.');
  const previous = telegramLogins.get(req.userId);
  if (previous?.client) await previous.client.disconnect().catch(() => {});
  const client = new TelegramClient(new StringSession(''), Number(process.env.API_ID), process.env.API_HASH, { connectionRetries: 3 });
  await client.connect();
  try {
    const sent = await client.sendCode({ apiId: Number(process.env.API_ID), apiHash: process.env.API_HASH }, phoneNumber);
    telegramLogins.set(req.userId, { client, phoneNumber, phoneCodeHash: sent.phoneCodeHash, expiresAt: Date.now() + 5 * 60_000 });
    res.json({ ok: true, message: 'Telegram sent a login code to your account. Enter it here to continue.' });
  } catch (error) {
    await client.disconnect().catch(() => {});
    log('warn', 'Telegram code request failed', { userId: req.userId, error: error.message });
    fail(res, 400, 'Telegram could not send a login code. Check the phone number and try again.');
  }
}));

async function finishTelegramLogin(req, res, client) {
  const session = client.session.save();
  const encrypted = encryptSecret(session);
  await pool.query('UPDATE users SET telegram_session=$1,telegram_connected=TRUE,telegram_phone=$2 WHERE id=$3', [encrypted, telegramLogins.get(req.userId)?.phoneNumber || null, req.userId]);
  telegramLogins.delete(req.userId);
  telegramClients.set(req.userId, { client, handler: null });
  await startTelegramListener(req.userId, client);
  res.json({ ok: true, connected: true });
}
app.post('/api/telegram/verify-code', authenticate, asyncRoute(async (req, res) => {
  const attempt = telegramLogins.get(req.userId);
  if (!attempt || attempt.expiresAt < Date.now()) return fail(res, 400, 'Login attempt expired. Request a fresh code.');
  const code = String(req.body.code || '').replace(/\s/g, '');
  if (!code) return fail(res, 400, 'Enter the code sent by Telegram.');
  try {
    await attempt.client.signIn({ phoneNumber: attempt.phoneNumber, phoneCodeHash: attempt.phoneCodeHash, phoneCode: code });
    return await finishTelegramLogin(req, res, attempt.client);
  } catch (error) {
    if (/SESSION_PASSWORD_NEEDED|password is required/i.test(error.message || '')) return res.status(202).json({ ok: false, requiresPassword: true, message: 'This Telegram account requires its two-step verification password.' });
    log('warn', 'Telegram code verification failed', { userId: req.userId, error: error.message });
    return fail(res, 400, 'The code was not accepted. Check it and try again.');
  }
}));
app.post('/api/telegram/verify-password', authenticate, asyncRoute(async (req, res) => {
  const attempt = telegramLogins.get(req.userId);
  if (!attempt || attempt.expiresAt < Date.now()) return fail(res, 400, 'Login attempt expired. Request a fresh code.');
  const password = String(req.body.password || '');
  if (!password) return fail(res, 400, 'Enter your Telegram two-step verification password.');
  try {
    await attempt.client.signInWithPassword({ apiId: Number(process.env.API_ID), apiHash: process.env.API_HASH }, { password });
    return await finishTelegramLogin(req, res, attempt.client);
  } catch (error) {
    log('warn', 'Telegram password verification failed', { userId: req.userId, error: error.message });
    return fail(res, 400, 'Telegram did not accept that password.');
  }
}));
app.get('/api/telegram/chats', authenticate, asyncRoute(async (req, res) => {
  const client = await restoreTelegramClient(req.userId);
  if (!client) return fail(res, 409, 'Connect Telegram first.');
  const dialogs = await client.getDialogs({ limit: 100 });
  const chats = dialogs.filter((dialog) => dialog.isChannel || dialog.isGroup).map((dialog) => ({ channelId: dialog.id.toString(), title: dialog.title || 'Telegram chat', username: dialog.entity?.username || null }));
  res.json({ chats });
}));
app.post('/api/telegram/disconnect', authenticate, asyncRoute(async (req, res) => {
  const current = telegramClients.get(req.userId);
  if (current?.client) await current.client.disconnect().catch(() => {});
  const login = telegramLogins.get(req.userId);
  if (login?.client) await login.client.disconnect().catch(() => {});
  telegramClients.delete(req.userId);
  telegramLogins.delete(req.userId);
  await pool.query('UPDATE users SET telegram_session=NULL,telegram_phone=NULL,telegram_connected=FALSE WHERE id=$1', [req.userId]);
  res.json({ ok: true });
}));

app.use((req, res) => res.status(404).json({ error: `Not found: ${req.method} ${req.path}` }));
app.use((error, _req, res, _next) => {
  log('error', 'Request failed', { error: error.message, code: error.code });
  if (res.headersSent) return;
  res.status(error.status || 500).json({ error: error.status ? error.message : 'Unexpected server error' });
});

async function start() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) throw new Error('JWT_SECRET must contain at least 32 characters');
  await initializeDatabase();
  httpServer.listen(PORT, '0.0.0.0', () => log('info', 'Server listening', { port: PORT }));
}
start().catch((error) => { log('error', 'Startup failed', { error: error.message }); process.exit(1); });

process.on('SIGTERM', async () => {
  for (const entry of telegramClients.values()) await entry.client.disconnect().catch(() => {});
  for (const entry of telegramLogins.values()) await entry.client.disconnect().catch(() => {});
  await pool.end().catch(() => {});
  httpServer.close(() => process.exit(0));
});
