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
import { Api, TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { NewMessage } from 'telegram/events/index.js';
import { pool, initializeDatabase } from './db.js';
import { createMetaApiConfigurationLink, metaApiRequest, toSafeMetaApiAccount } from './services/metaapi.js';
import { getTelegramErrorCode, isTelegramPasswordNeeded, shouldDiscardTelegramLogin, telegramAuthErrorPayload } from './services/telegram-auth.js';
import { parseSignal } from './services/signal-parser.js';
import { createMetaApiTradingAdapter } from './services/metaapi-trading.js';
import { createExecutionEngine } from './services/execution-engine.js';
import { createExecutionWorker } from './services/execution-worker.js';

const app = express();
app.set('trust proxy', 1);
const httpServer = createServer(app);
const allowedOrigins = (process.env.CLIENT_URL || '').split(',').map((item) => item.trim()).filter(Boolean);
const io = new Server(httpServer, { cors: { origin: allowedOrigins.length ? allowedOrigins : true, credentials: true } });
const PORT = Number(process.env.PORT || 5000);
const telegramClients = new Map();
const telegramLogins = new Map();
const autoTradingRuntimeEnabled = String(process.env.AUTO_TRADING_RUNTIME_ENABLED || '').toLowerCase() === 'true';
const tradingAdapter = createMetaApiTradingAdapter();

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

function getMetaApiProvisioningToken() {
  return process.env.METAAPI_PROVISIONING_TOKEN?.trim() || null;
}

async function resolveExecutionToken(userId, accountId, managedByApp) {
  if (managedByApp === true) return getMetaApiProvisioningToken();
  return getMetaApiToken(userId);
}

const executionEngine = createExecutionEngine({
  pool,
  trading: tradingAdapter,
  resolveToken: resolveExecutionToken,
  runtimeEnabled: autoTradingRuntimeEnabled,
});
const executionWorker = createExecutionWorker({ pool, engine: executionEngine, logger: console });

async function saveSignal(userId, message, channel = {}) {
  const parsed = parseSignal(message);
  const source = channel.source === 'manual' ? 'manual' : 'telegram';
  const telegramMessageId = source === 'telegram' && channel.telegramMessageId != null ? String(channel.telegramMessageId) : null;
  const savedText = String(message || '').slice(0, 5000);
  const { rows } = await pool.query(
    `INSERT INTO signals(user_id,channel_id,channel_title,telegram_message_id,source,message,symbol,side,entry_price,stop_loss,take_profit,execution_ready,parse_error,status)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     ON CONFLICT DO NOTHING
     RETURNING id,channel_id AS "channelId",channel_title AS "channelTitle",telegram_message_id AS "telegramMessageId",source,message,symbol,side,
       entry_price AS "entryPrice",stop_loss AS "stopLoss",take_profit AS "takeProfit",execution_ready AS "executionReady",parse_error AS "parseError",status,created_at AS "createdAt"`,
    [userId, channel.channelId || null, channel.title || null, telegramMessageId, source, savedText, parsed.symbol, parsed.side, parsed.entryPrice, parsed.stopLoss, parsed.takeProfit, parsed.executionReady, parsed.parseError || null, parsed.executionReady ? 'received' : 'unparsed'],
  );
  let signal = rows[0];
  if (!signal && telegramMessageId) {
    const existing = await pool.query(
      `SELECT id,channel_id AS "channelId",channel_title AS "channelTitle",telegram_message_id AS "telegramMessageId",source,message,symbol,side,
         entry_price AS "entryPrice",stop_loss AS "stopLoss",take_profit AS "takeProfit",execution_ready AS "executionReady",parse_error AS "parseError",status,created_at AS "createdAt"
       FROM signals WHERE user_id=$1 AND channel_id=$2 AND telegram_message_id=$3 AND source='telegram' LIMIT 1`,
      [userId, channel.channelId, telegramMessageId],
    );
    signal = existing.rows[0];
    return signal;
  }
  if (!signal) throw new Error('The signal could not be saved.');

  if (source === 'telegram' && telegramMessageId && parsed.executionReady) {
    const { rows: settingsRows } = await pool.query('SELECT auto_trading_enabled FROM settings WHERE user_id=$1 LIMIT 1', [userId]);
    if (settingsRows[0]?.auto_trading_enabled === true) {
      await pool.query(
        `INSERT INTO execution_jobs(user_id,signal_id,status,expires_at)
         VALUES($1,$2,'queued',NOW()+INTERVAL '2 minutes') ON CONFLICT(signal_id) DO NOTHING`,
        [userId, signal.id],
      );
    }
  }
  io.to(`user:${userId}`).emit('signal:received', signal);
  return signal;
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
      if (rows.length) await saveSignal(userId, text, { source: 'telegram', channelId: chatId, title: rows[0].title, telegramMessageId: message.id });
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
    pool.query('SELECT risk_mode AS "riskMode",risk_percent AS "riskPercent",max_open_positions AS "maxOpenPositions",daily_loss_limit AS "dailyLossLimit",auto_trading_enabled AS "autoTradingEnabled" FROM settings WHERE user_id=$1', [req.userId]),
  ]);
  res.json({
    stats: { totalSignals: signalsCount.rows[0].count, activeChannels: channelsCount.rows[0].count, accounts: accountsCount.rows[0].count },
    signals: recentSignals.rows,
    settings: settings.rows[0] || { riskMode: 'fixed', riskPercent: 1, maxOpenPositions: 5, dailyLossLimit: 5 },
    trading: { liveExecutionEnabled: autoTradingRuntimeEnabled, autoTradingEnabled: settings.rows[0]?.autoTradingEnabled === true, message: autoTradingRuntimeEnabled ? 'Live execution is available only when explicitly enabled in Risk Settings.' : 'Live execution is currently unavailable.' },
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
  const { rows } = await pool.query(`SELECT id,channel_title AS "channelTitle",message,symbol,side,entry_price AS "entryPrice",stop_loss AS "stopLoss",take_profit AS "takeProfit",execution_ready AS "executionReady",parse_error AS "parseError",status,created_at AS "createdAt" FROM signals WHERE user_id=$1 ORDER BY created_at DESC LIMIT $2`, [req.userId, limit]);
  res.json({ signals: rows });
}));
app.post('/api/signals', authenticate, asyncRoute(async (req, res) => {
  const message = String(req.body.message || '').trim().slice(0, 5000);
  if (!message) return fail(res, 400, 'Enter a signal message.');
  const signal = await saveSignal(req.userId, message, { source: 'manual', title: 'Manual entry' });
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
app.get('/api/metaapi/provisioning-status', authenticate, (_req, res) => {
  res.set('Cache-Control', 'no-store').json({ available: Boolean(getMetaApiProvisioningToken()) });
});
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
  await pool.query('DELETE FROM metaapi_accounts WHERE user_id=$1 AND managed_by_app=FALSE', [req.userId]);
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
    `SELECT id,metaapi_account_id AS "metaApiAccountId",login,name,platform,state,server,
       managed_by_app AS "managedByApp",created_at AS "createdAt"
     FROM metaapi_accounts WHERE user_id=$1 ORDER BY created_at DESC`,
    [req.userId],
  );
  res.json({ accounts: rows });
}));
app.post('/api/metaapi/provisioned-accounts', authenticate, asyncRoute(async (req, res) => {
  const apiToken = getMetaApiProvisioningToken();
  if (!apiToken) return fail(res, 503, 'Account setup is temporarily unavailable. Please contact the workspace owner.');
  if (Object.hasOwn(req.body || {}, 'login') || Object.hasOwn(req.body || {}, 'password')) {
    return fail(res, 400, 'For your security, enter your trading login and password only on the secure MetaAPI page.');
  }
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  const server = typeof req.body?.server === 'string' ? req.body.server.trim() : '';
  const platform = typeof req.body?.platform === 'string' ? req.body.platform.trim().toLowerCase() : '';
  if (!name || name.length > 100) return fail(res, 400, 'Enter an account name of 1 to 100 characters.');
  if (!server || server.length > 160) return fail(res, 400, 'Enter the broker server name shown in your MetaTrader account details.');
  if (!['mt4', 'mt5'].includes(platform)) return fail(res, 400, 'Choose MetaTrader 4 or MetaTrader 5.');

  const accountData = await metaApiRequest(apiToken, '/users/current/accounts', {
    method: 'POST',
    body: { name, server, platform, magic: 0 },
    transactionId: crypto.randomUUID().replaceAll('-', ''),
    unauthorizedMessage: 'Account setup is temporarily unavailable. Please contact the workspace owner.',
  });
  const account = toSafeMetaApiAccount(accountData);
  if (!account) return fail(res, 502, 'The account could not be added. Please try again.');

  const { rows } = await pool.query(
    `INSERT INTO metaapi_accounts(user_id,metaapi_account_id,login,name,platform,state,server,managed_by_app)
     VALUES($1,$2,$3,$4,$5,$6,$7,TRUE)
     ON CONFLICT(user_id,metaapi_account_id) DO UPDATE SET login=EXCLUDED.login,name=EXCLUDED.name,
       platform=EXCLUDED.platform,state=EXCLUDED.state,server=EXCLUDED.server,managed_by_app=TRUE
     RETURNING id,metaapi_account_id AS "metaApiAccountId",login,name,platform,state,server,
       managed_by_app AS "managedByApp",created_at AS "createdAt"`,
    [req.userId, account.id, account.login, account.name || name, account.platform || platform, account.state || accountData.state || 'DRAFT', server],
  );

  let configurationLink = null;
  let setupError = null;
  try {
    configurationLink = await createMetaApiConfigurationLink(apiToken, account.id);
  } catch (error) {
    setupError = {
      message: typeof error.userMessage === 'string' ? error.userMessage : error.message,
      ...(Number.isInteger(error.metaApiStatus) ? { metaApiStatus: error.metaApiStatus } : {}),
      ...(typeof error.metaApiErrorCode === 'string' ? { metaApiErrorCode: error.metaApiErrorCode } : {}),
      ...(typeof error.metaApiErrorType === 'string' ? { metaApiErrorType: error.metaApiErrorType } : {}),
      ...(typeof error.metaApiNetworkDiagnostic === 'string' ? { metaApiNetworkDiagnostic: error.metaApiNetworkDiagnostic } : {}),
    };
    log('warn', 'Secure MetaAPI setup link could not be created', {
      userId: req.userId,
      metaApiAccountId: account.id,
      error: error.message,
      metaApiStatus: error.metaApiStatus,
      metaApiErrorCode: error.metaApiErrorCode,
      metaApiErrorType: error.metaApiErrorType,
      metaApiNetworkDiagnostic: error.metaApiNetworkDiagnostic,
    });
  }
  res.set('Cache-Control', 'no-store').status(201).json({ account: rows[0], configurationLink, setupError });
}));
app.post('/api/metaapi/provisioned-accounts/:accountId/configuration-link', authenticate, asyncRoute(async (req, res) => {
  const apiToken = getMetaApiProvisioningToken();
  if (!apiToken) return fail(res, 503, 'Account setup is temporarily unavailable. Please contact the workspace owner.');
  const accountId = String(req.params.accountId || '');
  const { rows } = await pool.query(
    'SELECT metaapi_account_id FROM metaapi_accounts WHERE user_id=$1 AND metaapi_account_id=$2 AND managed_by_app=TRUE',
    [req.userId, accountId],
  );
  if (!rows[0]) return fail(res, 404, 'That account is not available in your workspace.');
  const configurationLink = await createMetaApiConfigurationLink(apiToken, rows[0].metaapi_account_id);
  res.set('Cache-Control', 'no-store').json({ configurationLink });
}));
app.post('/api/metaapi/provisioned-accounts/:accountId/refresh', authenticate, asyncRoute(async (req, res) => {
  const apiToken = getMetaApiProvisioningToken();
  if (!apiToken) return fail(res, 503, 'Account setup is temporarily unavailable. Please contact the workspace owner.');
  const accountId = String(req.params.accountId || '');
  const { rows: ownedAccounts } = await pool.query(
    `SELECT metaapi_account_id AS "metaApiAccountId",name,platform,server
     FROM metaapi_accounts WHERE user_id=$1 AND metaapi_account_id=$2 AND managed_by_app=TRUE`,
    [req.userId, accountId],
  );
  const ownedAccount = ownedAccounts[0];
  if (!ownedAccount) return fail(res, 404, 'That account is not available in your workspace.');

  const accountData = await metaApiRequest(apiToken, `/users/current/accounts/${encodeURIComponent(accountId)}`, {
    unauthorizedMessage: 'Account setup is temporarily unavailable. Please contact the workspace owner.',
  });
  const account = toSafeMetaApiAccount(accountData);
  if (!account || account.id !== accountId) return fail(res, 502, 'We could not refresh this account. Please try again.');
  const { rows } = await pool.query(
    `UPDATE metaapi_accounts SET login=$1,name=$2,platform=$3,state=$4,server=$5
     WHERE user_id=$6 AND metaapi_account_id=$7 AND managed_by_app=TRUE
     RETURNING id,metaapi_account_id AS "metaApiAccountId",login,name,platform,state,server,
       managed_by_app AS "managedByApp",created_at AS "createdAt"`,
    [account.login, account.name || ownedAccount.name, account.platform || ownedAccount.platform, account.state || 'DRAFT', ownedAccount.server, req.userId, accountId],
  );
  res.set('Cache-Control', 'no-store').json({ account: rows[0] });
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
  await pool.query('UPDATE settings SET auto_trading_enabled=FALSE,execution_account_id=NULL,updated_at=NOW() WHERE user_id=$1 AND execution_account_id=$2', [req.userId, req.params.accountId]);
  const result = await pool.query('DELETE FROM metaapi_accounts WHERE user_id=$1 AND metaapi_account_id=$2', [req.userId, req.params.accountId]);
  if (!result.rowCount) return fail(res, 404, 'Linked MetaAPI account not found.');
  res.json({ ok: true });
}));

app.get('/api/settings', authenticate, asyncRoute(async (req, res) => {
  const { rows } = await pool.query('SELECT risk_mode AS "riskMode",risk_percent AS "riskPercent",max_open_positions AS "maxOpenPositions",daily_loss_limit AS "dailyLossLimit",auto_trading_enabled AS "autoTradingEnabled",lot_size_mode AS "lotSizeMode",fixed_lot_size AS "fixedLotSize",max_daily_trades AS "maxDailyTrades",execution_account_id AS "executionAccountId" FROM settings WHERE user_id=$1', [req.userId]);
  res.set('Cache-Control', 'no-store').json({
    settings: { riskMode: 'fixed', riskPercent: 1, maxOpenPositions: 3, dailyLossLimit: 5, autoTradingEnabled: false, lotSizeMode: 'fixed', fixedLotSize: 0.01, maxDailyTrades: 10, executionAccountId: '', ...(rows[0] || {}) },
    runtimeEnabled: autoTradingRuntimeEnabled,
  });
}));
app.put('/api/settings', authenticate, asyncRoute(async (req, res) => {
  const riskMode = ['fixed', 'percent'].includes(req.body.riskMode) ? req.body.riskMode : 'fixed';
  const numeric = (value, fallback) => value === '' || value === null || value === undefined ? fallback : Number(value);
  const riskPercent = numeric(req.body.riskPercent, 1);
  const maxOpenPositions = Math.trunc(numeric(req.body.maxOpenPositions, 3));
  const dailyLossLimit = numeric(req.body.dailyLossLimit, 5);
  const maxDailyTrades = Math.trunc(numeric(req.body.maxDailyTrades, 10));
  const fixedLotSize = numeric(req.body.fixedLotSize, 0.01);
  const lotSizeMode = req.body.lotSizeMode === 'risk_based' ? 'risk_based' : req.body.lotSizeMode === 'fixed' ? 'fixed' : null;
  const autoTradingEnabled = req.body.autoTradingEnabled === true;
  const executionAccountId = typeof req.body.executionAccountId === 'string' ? req.body.executionAccountId.trim() : '';
  if (!lotSizeMode) return fail(res, 400, 'Choose a valid lot size mode.');
  if (!Number.isFinite(riskPercent) || riskPercent < 0.1 || riskPercent > 5) return fail(res, 400, 'Risk percent must be between 0.1 and 5.');
  if (!Number.isInteger(maxOpenPositions) || maxOpenPositions < 1 || maxOpenPositions > 50) return fail(res, 400, 'Maximum open trades must be between 1 and 50.');
  if (!Number.isFinite(dailyLossLimit) || dailyLossLimit < 0.1 || dailyLossLimit > 25) return fail(res, 400, 'Daily loss limit must be between 0.1% and 25%.');
  if (!Number.isInteger(maxDailyTrades) || maxDailyTrades < 1 || maxDailyTrades > 100) return fail(res, 400, 'Maximum daily trades must be between 1 and 100.');
  if (!Number.isFinite(fixedLotSize) || fixedLotSize < 0.01 || fixedLotSize > 100) return fail(res, 400, 'Fixed lot size must be between 0.01 and 100.');
  if (autoTradingEnabled && !autoTradingRuntimeEnabled) return fail(res, 409, 'Auto-Trading is not available on this service right now.');
  if (autoTradingEnabled && !executionAccountId) return fail(res, 400, 'Select a connected trading account before enabling Auto-Trading.');
  let ownedAccount = null;
  if (executionAccountId) {
    const { rows: accountRows } = await pool.query(
      'SELECT metaapi_account_id,managed_by_app,state FROM metaapi_accounts WHERE user_id=$1 AND metaapi_account_id=$2 LIMIT 1',
      [req.userId, executionAccountId],
    );
    ownedAccount = accountRows[0];
    if (!ownedAccount) return fail(res, 404, 'The selected trading account is not connected to your workspace.');
    if (autoTradingEnabled && String(ownedAccount.state || '').toUpperCase() !== 'DEPLOYED') return fail(res, 409, 'The selected trading account must be deployed before Auto-Trading can be enabled.');
  }
  const { rows: previousRows } = await pool.query('SELECT auto_trading_enabled AS "autoTradingEnabled",execution_account_id AS "executionAccountId" FROM settings WHERE user_id=$1 LIMIT 1', [req.userId]);
  const previous = previousRows[0] || {};
  if (autoTradingEnabled && (!previous.autoTradingEnabled || previous.executionAccountId !== executionAccountId)) {
    try { await executionEngine.captureDailyBaseline(req.userId, executionAccountId); }
    catch { return fail(res, 409, 'A safe daily loss baseline could not be captured. Confirm the account is deployed and connected, then try again. Auto-Trading remains off.'); }
  }
  const { rows } = await pool.query(
    `INSERT INTO settings(user_id,risk_mode,risk_percent,max_open_positions,daily_loss_limit,auto_trading_enabled,lot_size_mode,fixed_lot_size,max_daily_trades,execution_account_id)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(user_id) DO UPDATE SET risk_mode=EXCLUDED.risk_mode,risk_percent=EXCLUDED.risk_percent,max_open_positions=EXCLUDED.max_open_positions,daily_loss_limit=EXCLUDED.daily_loss_limit,auto_trading_enabled=EXCLUDED.auto_trading_enabled,lot_size_mode=EXCLUDED.lot_size_mode,fixed_lot_size=EXCLUDED.fixed_lot_size,max_daily_trades=EXCLUDED.max_daily_trades,execution_account_id=EXCLUDED.execution_account_id,updated_at=NOW()
     RETURNING risk_mode AS "riskMode",risk_percent AS "riskPercent",max_open_positions AS "maxOpenPositions",daily_loss_limit AS "dailyLossLimit",auto_trading_enabled AS "autoTradingEnabled",lot_size_mode AS "lotSizeMode",fixed_lot_size AS "fixedLotSize",max_daily_trades AS "maxDailyTrades",execution_account_id AS "executionAccountId"`,
    [req.userId, riskMode, riskPercent, maxOpenPositions, dailyLossLimit, autoTradingEnabled, lotSizeMode, fixedLotSize, maxDailyTrades, executionAccountId || null],
  );
  res.set('Cache-Control', 'no-store').json({ settings: rows[0], runtimeEnabled: autoTradingRuntimeEnabled });
}));
app.get('/api/trades', authenticate, asyncRoute(async (req, res) => {
  const { rows } = await pool.query('SELECT id,signal_id AS "signalId",metaapi_account_id AS "metaApiAccountId",symbol,side,quantity,entry_price AS "entryPrice",stop_loss AS "stopLoss",take_profit AS "takeProfit",exit_price AS "exitPrice",pnl,status,broker_order_id AS "brokerOrderId",broker_position_id AS "brokerPositionId",error_message AS "errorMessage",created_at AS "createdAt",executed_at AS "executedAt" FROM trades WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50', [req.userId]);
  res.set('Cache-Control', 'no-store').json({ trades: rows, liveExecutionEnabled: autoTradingRuntimeEnabled });
}));

app.get('/api/telegram/status', authenticate, asyncRoute(async (req, res) => {
  const { rows } = await pool.query('SELECT telegram_connected FROM users WHERE id=$1', [req.userId]);
  const configured = Boolean(process.env.API_ID && process.env.API_HASH && process.env.SESSION_ENCRYPTION_KEY);
  let connected = Boolean(rows[0]?.telegram_connected && telegramClients.get(req.userId)?.client?.connected);
  if (rows[0]?.telegram_connected && !connected && configured) {
    try { connected = Boolean(await restoreTelegramClient(req.userId)); } catch (error) { log('warn', 'Telegram session restore deferred', { userId: req.userId, error: error.message }); }
  }
  res.json({ configured, connected, message: configured ? null : 'Telegram sign-in is temporarily unavailable. Please try again later.' });
}));
async function persistTelegramLoginAttempt(userId, attempt) {
  const stringSession = attempt.client.session.save();
  if (!stringSession) throw new Error('Telegram returned an empty pending session');
  const encryptedState = encryptSecret(JSON.stringify({ phoneNumber: attempt.phoneNumber, phoneCodeHash: attempt.phoneCodeHash, stringSession }));
  await pool.query(
    `INSERT INTO telegram_login_attempts(user_id,encrypted_state,expires_at)
     VALUES($1,$2,$3)
     ON CONFLICT(user_id) DO UPDATE SET encrypted_state=EXCLUDED.encrypted_state,expires_at=EXCLUDED.expires_at,updated_at=NOW()`,
    [userId, encryptedState, new Date(attempt.expiresAt)],
  );
}

async function loadTelegramLoginAttempt(userId) {
  const inMemory = telegramLogins.get(userId);
  if (inMemory && inMemory.expiresAt > Date.now()) return inMemory;
  if (inMemory?.client) await inMemory.client.disconnect().catch(() => {});
  telegramLogins.delete(userId);

  const { rows } = await pool.query(
    'SELECT encrypted_state,expires_at FROM telegram_login_attempts WHERE user_id=$1',
    [userId],
  );
  const row = rows[0];
  if (!row) return null;
  const expiresAt = new Date(row.expires_at).getTime();
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    await pool.query('DELETE FROM telegram_login_attempts WHERE user_id=$1', [userId]);
    return null;
  }

  let state;
  try { state = JSON.parse(decryptSecret(row.encrypted_state)); }
  catch {
    await pool.query('DELETE FROM telegram_login_attempts WHERE user_id=$1', [userId]);
    return null;
  }
  if (!state.phoneNumber || !state.phoneCodeHash || !state.stringSession) {
    await pool.query('DELETE FROM telegram_login_attempts WHERE user_id=$1', [userId]);
    return null;
  }
  const apiId = Number(process.env.API_ID);
  const client = new TelegramClient(new StringSession(state.stringSession), apiId, process.env.API_HASH, { connectionRetries: 3 });
  try { await client.connect(); }
  catch (error) {
    await client.disconnect().catch(() => {});
    throw error;
  }
  const attempt = { client, phoneNumber: state.phoneNumber, phoneCodeHash: state.phoneCodeHash, expiresAt };
  telegramLogins.set(userId, attempt);
  return attempt;
}

async function loadTelegramLoginAttemptOrRespond(userId, res) {
  try { return await loadTelegramLoginAttempt(userId); }
  catch (error) {
    const code = getTelegramErrorCode(error);
    if (shouldDiscardTelegramLogin(code)) await pool.query('DELETE FROM telegram_login_attempts WHERE user_id=$1', [userId]);
    log('warn', 'Pending Telegram login restore failed', { userId, telegramErrorCode: code || 'TELEGRAM_LOGIN_RESTORE_FAILED' });
    res.status(503).json({
      error: 'Could not resume the pending Telegram login right now. Retry, or request a fresh code if it continues.',
      telegramErrorCode: code || 'TELEGRAM_LOGIN_RESTORE_FAILED',
    });
    return undefined;
  }
}

async function discardTelegramLoginAttempt(userId, attempt = telegramLogins.get(userId)) {
  telegramLogins.delete(userId);
  if (attempt?.client) await attempt.client.disconnect().catch(() => {});
  await pool.query('DELETE FROM telegram_login_attempts WHERE user_id=$1', [userId]);
}

app.post('/api/telegram/request-code', authenticate, asyncRoute(async (req, res) => {
  if (!process.env.API_ID || !process.env.API_HASH || !process.env.SESSION_ENCRYPTION_KEY) {
    return fail(res, 503, 'Telegram sign-in is temporarily unavailable. Please try again later.');
  }
  const apiId = Number(process.env.API_ID);
  if (!Number.isSafeInteger(apiId) || apiId <= 0) return res.status(503).json({ ...telegramAuthErrorPayload({ errorMessage: 'API_ID_INVALID' }) });
  const phoneNumber = String(req.body.phoneNumber || '').trim();
  if (!/^\+[1-9]\d{7,14}$/.test(phoneNumber)) return fail(res, 400, 'Use an international phone number, such as +15551234567.');

  const client = new TelegramClient(new StringSession(''), apiId, process.env.API_HASH, { connectionRetries: 3 });
  let sentToTelegram = false;
  try {
    await client.connect();
    const sent = await client.sendCode({ apiId, apiHash: process.env.API_HASH }, phoneNumber);
    sentToTelegram = true;
    if (!sent?.phoneCodeHash) {
      const error = new Error('Telegram did not return a phone code hash');
      error.errorMessage = 'PHONE_CODE_HASH_EMPTY';
      throw error;
    }
    const attempt = { client, phoneNumber, phoneCodeHash: sent.phoneCodeHash, expiresAt: Date.now() + 5 * 60_000 };
    await persistTelegramLoginAttempt(req.userId, attempt);
    const previous = telegramLogins.get(req.userId);
    if (previous?.client && previous.client !== client) await previous.client.disconnect().catch(() => {});
    telegramLogins.set(req.userId, attempt);
    return res.json({ ok: true, message: 'Telegram sent a login code. Enter the newest code here to continue.' });
  } catch (error) {
    await client.disconnect().catch(() => {});
    if (sentToTelegram && !getTelegramErrorCode(error)) {
      log('error', 'Pending Telegram login could not be stored', { userId: req.userId, errorType: error?.constructor?.name || 'Error' });
      return fail(res, 500, 'Telegram sent a code, but the secure login state could not be saved. Request a new code and try again.');
    }
    const details = telegramAuthErrorPayload(error);
    log('warn', 'Telegram code request failed', { userId: req.userId, telegramErrorCode: details.telegramErrorCode });
    return res.status(400).json(details);
  }
}));

async function finishTelegramLogin(req, res, attempt) {
  const session = attempt.client.session.save();
  const encrypted = encryptSecret(session);
  await pool.query('UPDATE users SET telegram_session=$1,telegram_connected=TRUE,telegram_phone=$2 WHERE id=$3', [encrypted, attempt.phoneNumber, req.userId]);
  await pool.query('DELETE FROM telegram_login_attempts WHERE user_id=$1', [req.userId]);
  telegramLogins.delete(req.userId);
  telegramClients.set(req.userId, { client: attempt.client, handler: null });
  await startTelegramListener(req.userId, attempt.client);
  return res.json({ ok: true, connected: true });
}

app.post('/api/telegram/verify-code', authenticate, asyncRoute(async (req, res) => {
  const attempt = await loadTelegramLoginAttemptOrRespond(req.userId, res);
  if (attempt === undefined) return;
  if (!attempt) return res.status(400).json({ error: 'This Telegram login attempt expired. Request a fresh code.', telegramErrorCode: 'TELEGRAM_LOGIN_SESSION_EXPIRED' });
  const code = String(req.body.code || '').replace(/\s/g, '');
  if (!/^\d{3,10}$/.test(code)) return fail(res, 400, 'Enter the numeric code sent by Telegram.');

  try {
    const result = await attempt.client.invoke(new Api.auth.SignIn({
      phoneNumber: attempt.phoneNumber,
      phoneCodeHash: attempt.phoneCodeHash,
      phoneCode: code,
    }));
    if (result instanceof Api.auth.AuthorizationSignUpRequired) {
      await discardTelegramLoginAttempt(req.userId, attempt);
      return res.status(409).json({ error: 'This phone number is not registered to a Telegram account (PHONE_NUMBER_UNOCCUPIED).', telegramErrorCode: 'PHONE_NUMBER_UNOCCUPIED' });
    }
    return await finishTelegramLogin(req, res, attempt);
  } catch (error) {
    const codeName = getTelegramErrorCode(error);
    if (isTelegramPasswordNeeded(error)) {
      await persistTelegramLoginAttempt(req.userId, attempt);
      return res.status(202).json({ ok: false, requiresPassword: true, message: 'This Telegram account requires its two-step verification password.', telegramErrorCode: 'SESSION_PASSWORD_NEEDED' });
    }
    if (shouldDiscardTelegramLogin(codeName)) await discardTelegramLoginAttempt(req.userId, attempt);
    else {
      try { await persistTelegramLoginAttempt(req.userId, attempt); }
      catch (persistError) { log('error', 'Pending Telegram login state refresh failed', { userId: req.userId, errorType: persistError?.constructor?.name || 'Error' }); }
    }
    const details = telegramAuthErrorPayload(error);
    log('warn', 'Telegram code verification failed', { userId: req.userId, telegramErrorCode: details.telegramErrorCode });
    return res.status(400).json(details);
  }
}));

app.post('/api/telegram/verify-password', authenticate, asyncRoute(async (req, res) => {
  const attempt = await loadTelegramLoginAttemptOrRespond(req.userId, res);
  if (attempt === undefined) return;
  if (!attempt) return res.status(400).json({ error: 'This Telegram login attempt expired. Request a fresh code.', telegramErrorCode: 'TELEGRAM_LOGIN_SESSION_EXPIRED' });
  const password = String(req.body.password || '');
  if (!password) return fail(res, 400, 'Enter your Telegram two-step verification password.');

  let passwordAuthError = null;
  try {
    await attempt.client.signInWithPassword(
      { apiId: Number(process.env.API_ID), apiHash: process.env.API_HASH },
      {
        password: async () => password,
        onError: async (error) => { passwordAuthError = error; return true; },
      },
    );
    return await finishTelegramLogin(req, res, attempt);
  } catch (error) {
    const actualError = passwordAuthError || error;
    const codeName = getTelegramErrorCode(actualError);
    if (shouldDiscardTelegramLogin(codeName)) await discardTelegramLoginAttempt(req.userId, attempt);
    else {
      try { await persistTelegramLoginAttempt(req.userId, attempt); }
      catch (persistError) { log('error', 'Pending Telegram login state refresh failed', { userId: req.userId, errorType: persistError?.constructor?.name || 'Error' }); }
    }
    const details = telegramAuthErrorPayload(actualError);
    log('warn', 'Telegram password verification failed', { userId: req.userId, telegramErrorCode: details.telegramErrorCode });
    return res.status(400).json(details);
  }
}));

app.get('/api/telegram/chats', authenticate, asyncRoute(async (req, res) => {
  const client = await restoreTelegramClient(req.userId);
  if (!client) return fail(res, 409, 'Connect Telegram first.');
  const dialogs = await client.getDialogs({ limit: 200 });
  const chats = dialogs
    .filter((dialog) => dialog.isChannel || dialog.isGroup)
    .map((dialog) => ({
      channelId: dialog.id.toString(),
      title: dialog.title || 'Telegram chat',
      username: dialog.entity?.username || null,
      type: dialog.isGroup || dialog.entity?.megagroup ? 'Group' : 'Channel',
    }));
  res.json({ chats, limit: 200 });
}));
app.post('/api/telegram/disconnect', authenticate, asyncRoute(async (req, res) => {
  const current = telegramClients.get(req.userId);
  if (current?.client) await current.client.disconnect().catch(() => {});
  const login = telegramLogins.get(req.userId);
  if (login?.client) await login.client.disconnect().catch(() => {});
  telegramClients.delete(req.userId);
  telegramLogins.delete(req.userId);
  await pool.query('DELETE FROM telegram_login_attempts WHERE user_id=$1', [req.userId]);
  await pool.query('UPDATE users SET telegram_session=NULL,telegram_phone=NULL,telegram_connected=FALSE WHERE id=$1', [req.userId]);
  res.json({ ok: true });
}));

app.use((req, res) => res.status(404).json({ error: 'We could not find that page or action. Return to your workspace and try again.' }));
app.use((error, _req, res, _next) => {
  log('error', 'Request failed', {
    error: error.message,
    code: error.code,
    metaApiStatus: error.metaApiStatus,
    metaApiErrorCode: error.metaApiErrorCode,
    metaApiErrorType: error.metaApiErrorType,
    metaApiNetworkDiagnostic: error.metaApiNetworkDiagnostic,
  });
  if (res.headersSent) return;
  const payload = { error: error.status ? error.message : 'Something went wrong. Please try again in a moment.' };
  if (typeof error.userMessage === 'string') payload.userMessage = error.userMessage;
  if (Number.isInteger(error.metaApiStatus)) payload.metaApiStatus = error.metaApiStatus;
  if (typeof error.metaApiErrorCode === 'string') payload.metaApiErrorCode = error.metaApiErrorCode;
  if (typeof error.metaApiErrorType === 'string') payload.metaApiErrorType = error.metaApiErrorType;
  if (typeof error.metaApiNetworkDiagnostic === 'string') payload.metaApiNetworkDiagnostic = error.metaApiNetworkDiagnostic;
  res.status(error.status || 500).json(payload);
});

async function start() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) throw new Error('JWT_SECRET must contain at least 32 characters');
  await initializeDatabase();
  await pool.query('DELETE FROM telegram_login_attempts WHERE expires_at <= NOW()');
  executionWorker.start();
  httpServer.listen(PORT, '0.0.0.0', () => log('info', 'Server listening', { port: PORT }));
  const { rows: telegramUsers } = await pool.query('SELECT id FROM users WHERE telegram_connected=TRUE AND telegram_session IS NOT NULL');
  for (const row of telegramUsers) {
    void restoreTelegramClient(row.id).catch((error) => log('warn', 'Telegram listener restore failed', { userId: row.id, errorType: error?.constructor?.name || 'Error' }));
  }
}
start().catch((error) => { log('error', 'Startup failed', { error: error.message }); process.exit(1); });

async function shutdown() {
  const serverClosed = new Promise((resolve) => {
    if (!httpServer.listening) return resolve();
    httpServer.close(resolve);
  });
  await executionWorker.stop();
  await serverClosed;
  for (const entry of telegramClients.values()) await entry.client.disconnect().catch(() => {});
  for (const entry of telegramLogins.values()) await entry.client.disconnect().catch(() => {});
  await tradingAdapter.close().catch(() => {});
  await pool.end().catch(() => {});
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
