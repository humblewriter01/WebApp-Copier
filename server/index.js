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
import * as telegramAdapter from './services/telegram-adapter.js';
import { pool, initializeDatabase } from './db.js';
import { withDeadline } from './services/schema-sql.js';
import { createMetaApiConfigurationLink, metaApiRequest, toSafeMetaApiAccount } from './services/metaapi.js';
import { getTelegramErrorCode, isTelegramPasswordNeeded, shouldDiscardTelegramLogin, telegramAuthErrorPayload } from './services/telegram-auth.js';
import { CAPTURE_PARSE_BUDGET_MS, parseSignalTwoLayer } from './services/signal-parse-pipeline.js';
import { llmConfig, describeLlmConfig, describeLastReaderFailure } from './services/signal-llm.js';
import { createLlmGate } from './services/llm-gate.js';
import { TARGET_MODES } from './services/scale-out.js';
import { captureSafety, readFallbackPoints } from './services/signal-safety.js';
import { entryRangeBounds, readExpirySetting, readSlippageSetting, ORDER_TYPES } from './services/order-routing.js';
import { readDashboardSignals } from './services/dashboard-signals.js';
import { HEARTBEAT_INTERVAL_MS, createTelegramListener, isValidWorkspaceId } from './services/telegram-listener.js';
import { createTelegramKeepAliveGuard, createUnhandledRejectionGuard, isProviderKeepAliveTimeout } from './services/telegram-keepalive.js';
import { createPassGuard, createSingleFlight } from './services/single-flight.js';
import { createMetaApiTradingAdapter } from './services/metaapi-trading.js';
import { createExecutionEngine, PLATFORM_PAUSE_MESSAGE } from './services/execution-engine.js';
import { createExecutionWorker } from './services/execution-worker.js';
import { createSupabaseAuthBridge } from './services/supabase-auth.js';
import { createAdminAccess, normalizePromoCodeInput, normalizePromoCodeUpdate, normalizeUserUpdate, assertAllowedSelfUpdate, normalizeSubscriptionAdjustment, assertAllowedImpersonation, adminActionError, buildUserAdminUpdate, buildSubscriptionGrantStatements, buildSubscriptionExtendStatement, buildSubscriptionReleaseStatements, buildSubscriptionMirrorStatement, buildSignalOwnershipDelete, buildAdminSignalDelete, buildSignalsPurgeForUser, buildSignalsPurgeOlderThan, buildSignalsPurgeCount } from './services/admin.js';
import { createAccountCleanup } from './services/account-cleanup.js';
import { billingConfig, normalizeReference, findPlan, normalizeCurrency, isSupportedCurrency, formatAmount, FREE_PLAN } from './services/billing.js';
import { createFlutterwaveClient, verifyWebhookHash } from './services/flutterwave.js';
import { createBillingService } from './services/billing-service.js';
import { createPricingStore, normalizePricingUpdate, normalizeBillingSettings, planChargeDecision, publicPricing } from './services/pricing.js';
import { createPlanSynchronizer } from './services/plan-sync.js';
import { planLimitsFor, buildLimitError } from './services/plan-limits.js';
import { SIGNAL_OUTCOME_CONTEXT_SQL, createSignalOutcomeReader, decideSignalOutcome, overlayLiveBlocker, describeOverlayDiagnostics } from './services/signal-outcome.js';
import { friendlySignalNote } from './services/signal-wording.js';
import { planSignalEdit, EDITABLE_SIGNAL_STATUSES } from './services/signal-edit.js';
import {
  createInactivityService, daysInactiveSince,
  INACTIVITY_WARNING_DAYS, INACTIVITY_DELETION_DAYS, INACTIVITY_SWEEP_LIMIT,
} from './services/inactivity.js';
import { createAuditLogger, normalizeAuditQuery, buildAuditLogClear } from './services/audit.js';
import { createPlatformControls, normalizeKillSwitchInput, KILL_SWITCH_SETTING_KEY } from './services/platform-controls.js';
import { createSystemHealthService, normalizeHealthQuery, buildParseErrorClear } from './services/system-health.js';
import { createAnnouncementService, normalizeAnnouncementDraft, normalizeAnnouncementListQuery, buildRetiredAnnouncementClear } from './services/announcements.js';
import { createSupportSessionService, normalizeSupportReason, buildSupportClaims, SUPPORT_SESSION_MINUTES } from './services/support-sessions.js';

const app = express();
app.set('trust proxy', 1);
const httpServer = createServer(app);
const allowedOrigins = (process.env.CLIENT_URL || '').split(',').map((item) => item.trim()).filter(Boolean);
const io = new Server(httpServer, { cors: { origin: allowedOrigins.length ? allowedOrigins : true, credentials: true } });
const PORT = Number(process.env.PORT || 5000);

/* Startup order, and why it is the opposite of the obvious one.
 *
 * The port used to be bound at the very end of `start()`, after the schema migration and after a
 * housekeeping query. That shape is fine until the database is slow - held by another session's lock, or
 * simply not answering - and then the process is alive, silent, and bound to nothing. The platform waits
 * fifteen minutes, reports only "Port scan timeout reached, no open ports detected", and a stalled
 * migration is indistinguishable from a broken build, a bad credential, or a dead host.
 *
 * So: listen first, bring the database up behind the open port. Until the schema is ready, everything that
 * would touch a table is answered with one short sentence and a 503, so no route can half-work against a
 * schema that has not been applied yet; `/health` keeps answering, and answers *without* waiting on the
 * database, because a health check that depends on the thing it is checking is how a restart storm starts.
 * The migration retries on its own, so a lock that clears in two minutes costs two minutes, not a human.
 */
const boot = {
  ready: false,
  step: 'listening',
  database: 'unknown',
  statements: 0,
  attempts: 0,
  lastError: null,
  runtimeStarted: false,
};
const BOOT_RETRY_BASE_MS = 5_000;
const BOOT_RETRY_MAX_MS = 60_000;
// A probe longer than this would make the health check slower than Render's own patience with it.
const HEALTH_PROBE_TIMEOUT_MS = 1_500;
const STARTUP_GATE_EXEMPT = new Set(['/health', '/api/health']);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const telegramClients = new Map();
const telegramLogins = new Map();
const autoTradingRuntimeEnabled = String(process.env.AUTO_TRADING_RUNTIME_ENABLED || '').toLowerCase() === 'true';
const tradingAdapter = createMetaApiTradingAdapter();
const supabaseAuthBridge = createSupabaseAuthBridge();
const adminAccess = createAdminAccess();
/* Layer 2 is configured entirely from the environment, once, at boot: a key rotated by a deployment is a
   key the process should pick up by restarting, not one it re-reads between two messages of the same
   capture. `disabledReason` is what the startup log below quotes, and it is the only place an operator finds
   out that the AI reading assistant is switched off. */
const parserConfig = llmConfig(process.env);
/* The queue in front of the AI reader, shared by every user in this process: it exists so that a reconnect
   replaying 25 messages cannot make a live signal wait for somebody else's model request. The number is small
   on purpose - a Groq key is rate limited per model, so more concurrent requests buy queueing at the provider,
   not throughput. */
const llmGate = createLlmGate({ maxConcurrent: Number(process.env.LLM_MAX_CONCURRENT) || undefined });

const accountCleanup = createAccountCleanup({ logger: { warn: (message, extra = {}) => log('warn', message, extra) } });
const flutterwaveConfig = billingConfig();
const flutterwaveClient = createFlutterwaveClient({ config: flutterwaveConfig });
const serviceLogger = {
  info: (message, extra = {}) => log('info', message, extra),
  warn: (message, extra = {}) => log('warn', message, extra),
  error: (message, extra = {}) => log('error', message, extra),
};
// Prices live in the `plans` table (one row per plan, one column per currency) and are maintained from the
// admin panel, with the environment as the fallback whenever a plan has no stored price.
const pricingStore = createPricingStore({ pool, config: flutterwaveConfig, logger: serviceLogger });
const planSynchronizer = createPlanSynchronizer({
  flutterwave: flutterwaveClient,
  pricing: pricingStore,
  config: flutterwaveConfig,
  logger: serviceLogger,
});
const billingService = createBillingService({
  pool,
  pricing: pricingStore,
  flutterwave: flutterwaveClient,
  config: flutterwaveConfig,
  logger: serviceLogger,
});

/**
 * The one log line this process writes, and the last place anything can be redacted before it reaches stdout.
 *
 * `safe` is a copy rather than the caller's object, and every key that names a credential is deleted from the
 * copy: a provider token, a Telegram session string, a phone number and a password all arrive here as part of
 * the facts a route attaches to a line, and the log is the one surface in this deployment that is read by
 * anyone who has not authenticated. The list is a string-match away from silent rot, so `
 * test/log-redaction.test.js` pins the six names, pins that the line is built from the redacted copy and not
 * from `extra`, and pins that no second writer of structured logs exists beside this one.
 *
 * @param {LogLevel} level
 * @param {string} message
 * @param {LogExtra} [extra]
 */
const log = (level, message, extra = {}) => {
  const safe = /** @type {Record<string, any>} */ ({ ...extra });
  delete safe.phoneNumber; delete safe.token; delete safe.apiToken; delete safe.metaApiToken; delete safe.session; delete safe.password;
  console[level]?.(JSON.stringify({ at: new Date().toISOString(), level, message, ...safe }));
};
const asyncRoute = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
const fail = (res, status, error) => res.status(status).json({ error });

const adminRoute = (action, handler) => asyncRoute(async (req, res) => {
  req.adminMutation = { applied: false };
  try {
    await handler(req, res);
  } catch (error) {
    throw adminActionError(action, error, { applied: req.adminMutation.applied === true });
  }
});

/** Called the moment a write has landed, so a later failure in the same request stops denying it. */
const markApplied = (req) => {
  if (req.adminMutation) req.adminMutation.applied = true;
};

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
// The raw body is captured so a Flutterwave webhook can be refused for a malformed payload before the JSON is
// trusted. Flutterwave does not sign its body - the `verif-hash` header is the check - so nothing here is
// hashed, but reading the exact bytes the provider sent is still what makes "we could not parse it" a fact
// rather than an inference from a re-serialised object.
app.use(express.json({
  limit: '1mb',
  verify: (req, _res, buffer) => { req.rawBody = Buffer.from(buffer); },
}));
app.use('/api/auth', rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false }));
app.use('/api/metaapi', rateLimit({ windowMs: 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false }));
const passwordResetLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 5, standardHeaders: true, legacyHeaders: false });
const billingLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false });
const webhookLimiter = rateLimit({ windowMs: 60 * 1000, limit: 120, standardHeaders: true, legacyHeaders: false });

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

/* A support session is signed with the same secret but a purpose claim, a one-hour life, and a
 * random id whose hash is the only thing kept in the database. It is read-only, it can never use
 * the admin API, and it dies the moment its row is revoked - which is why no customer password is
 * involved and why nothing here can outlive an hour even if the browser keeps the token. */
function issueSupportToken(claims) {
  return jwt.sign(claims, process.env.JWT_SECRET, { expiresIn: `${SUPPORT_SESSION_MINUTES}m` });
}

/** The only writes a support session may perform: closing itself. */
const SUPPORT_SESSION_WRITE_PATHS = new Set(['/api/auth/support/exit']);

function authenticate(req, res, next) {
  const token = req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) return fail(res, 401, 'Sign in to continue.');
  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return fail(res, 401, 'Your session has expired. Please sign in again.');
  }
  req.userId = payload.sub;
  req.userEmail = payload.email;
  if (String(payload.purpose || '') !== 'impersonation') return next();
  Promise.resolve()
    .then(() => supportSessions.redeem(payload.jti))
    .then((session) => {
      if (!session || String(session.userId) !== String(payload.sub)) {
        return fail(res, 401, 'This support session is no longer active.');
      }
      if (!SUPPORT_SESSION_WRITE_PATHS.has(req.path) && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
        return fail(res, 403, 'Support access is read-only, so nothing in this workspace can be changed.');
      }
      req.impersonatedBy = session.adminId;
      req.supportSessionId = session.id;
      return next();
    })
    .catch(() => fail(res, 401, 'This support session could not be verified.'));
}
function publicUser(row) { return { id: row.id, name: row.name, email: row.email, role: row.role === 'admin' ? 'admin' : 'user', createdAt: row.created_at }; }
function isAdminRole(role) { return adminAccess.isAdminRole(role); }
async function loadUserRole(userId) {
  const { rows } = await pool.query('SELECT role FROM users WHERE id=$1 LIMIT 1', [userId]);
  return rows[0]?.role || null;
}
const requireAdmin = asyncRoute(async (req, res, next) => {
  // A support token carries the target user's id, so the role lookup alone would let an admin
  // impersonating another admin keep using admin tools through that session. Refuse it outright.
  if (req.impersonatedBy) {
    log('warn', 'Admin API denied for a support session', { userId: req.userId, adminId: req.impersonatedBy });
    return fail(res, 403, 'Admin tools are not available while viewing another workspace.');
  }
  const role = await loadUserRole(req.userId);
  if (!isAdminRole(role)) {
    log('warn', 'Admin endpoint denied', { userId: req.userId, role: role || 'missing' });
    return fail(res, 403, 'You do not have access to the admin panel.');
  }
  return next();
});

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

/* ------------------------- platform administration -------------------------
 * The kill switch, the audit trail, the health read model, announcements, and support
 * sessions are all built before the engine so the engine can be handed the switch as a
 * dependency instead of knowing where it lives.
 */
const platformControls = createPlatformControls({ pool, logger: console });
const auditLog = createAuditLogger({ pool, logger: console });
const systemHealth = createSystemHealthService({ pool, controls: platformControls, runtimeEnabled: autoTradingRuntimeEnabled, logger: console, capture: () => ({ ...telegramCapture.telegramFleetSummary(), gitCommit: process.env.RENDER_GIT_COMMIT || process.env.GIT_COMMIT || null, startup: { ...boot } }), llm: () => ({ ...describeLlmConfig(parserConfig), ...llmGate.summary(), lastFailure: describeLastReaderFailure() }) });
const announcementService = createAnnouncementService({ pool, logger: console });
const supportSessions = createSupportSessionService({ pool, logger: console });

const executionEngine = createExecutionEngine({
  pool,
  trading: tradingAdapter,
  resolveToken: resolveExecutionToken,
  runtimeEnabled: autoTradingRuntimeEnabled,
  // Re-read per job, never cached: the point of the switch is that it bites immediately.
  isTradingPaused: () => platformControls.isPaused(),
  breakEvenIntervalMs: Number(process.env.BREAK_EVEN_SWEEP_INTERVAL_MS) || 5_000,
  // The plan sweep is throttled on its own clock so a slow provider read for one symbol cannot delay the
  // other, and so either can be retuned independently of the other during an incident.
  takeProfitSweepIntervalMs: Number(process.env.SCALE_OUT_SWEEP_INTERVAL_MS) || 5_000,
  logger: console,
});
const executionWorker = createExecutionWorker({ pool, engine: executionEngine, logger: console });

/* Abandoned MetaAPI accounts keep billing the workspace forever, so idle ones are
 * warned about on day 25 and deleted on day 30. Accounts stay deployed the whole time
 * (execution must never wait for a wake-up); only genuinely unused accounts go. */
function readInactivityConfig(env = process.env) {
  const enabled = String(env.INACTIVITY_CLEANUP_ENABLED ?? 'true').trim().toLowerCase() !== 'false';
  let warningDays = Math.max(1, Number(env.INACTIVITY_WARNING_DAYS) || INACTIVITY_WARNING_DAYS);
  let deletionDays = Math.max(2, Number(env.INACTIVITY_DELETION_DAYS) || INACTIVITY_DELETION_DAYS);
  // Warning after the deletion date would promise a countdown that has already run out,
  // so a misconfigured pair falls back to the shipped policy rather than trusting it.
  if (deletionDays <= warningDays) {
    log('warn', 'INACTIVITY_DELETION_DAYS must be greater than INACTIVITY_WARNING_DAYS; using the default policy', { warningDays, deletionDays });
    warningDays = INACTIVITY_WARNING_DAYS;
    deletionDays = INACTIVITY_DELETION_DAYS;
  }
  const sweepLimit = Math.max(1, Number(env.INACTIVITY_SWEEP_LIMIT) || INACTIVITY_SWEEP_LIMIT);
  return Object.freeze({ enabled, warningDays, deletionDays, sweepLimit });
}
const inactivityConfig = readInactivityConfig();
const inactivityService = createInactivityService({
  pool,
  trading: tradingAdapter,
  accountCleanup,
  // Only workspace-provisioned accounts are eligible, and those are always billed to
  // the server's provisioning token, which is the only token this sweep may use.
  resolveToken: async () => getMetaApiProvisioningToken(),
  warningDays: inactivityConfig.warningDays,
  deletionDays: inactivityConfig.deletionDays,
  sweepLimit: inactivityConfig.sweepLimit,
  logger: {
    info: (message, extra = {}) => log('info', message, extra),
    warn: (message, extra = {}) => log('warn', message, extra),
    error: (message, extra = {}) => log('error', message, extra),
  },
});

/**
 * The channel's numbered targets, kept exactly as the parser read them and only when there is more than
 * one of them. It is stored beside `take_profit` rather than re-derived at execution time so that a trade
 * carries the plan a reader saw on the signal row, and `null` means the message named a single exit -
 * which is what makes "no ladder" distinguishable from "a ladder we forgot to store".
 */
/**
 * The entry zone a message published, kept as the two bounds the channel wrote and nothing else.
 *
 * It is stored rather than re-derived for the two readers that need it after capture: the execution engine,
 * which refuses an order once the market has passed through the whole range, and the signal row, which can
 * then show what was offered instead of only the bound it was credited with. A message that named a single
 * price stores NULL - not an empty object, so "no zone" stays distinguishable from "a zone we lost".
 */
function entryRangeValue(parsed) {
  // The same reader the execution engine uses, so the bounds stored and the bounds acted on cannot drift.
  const bounds = entryRangeBounds(parsed?.entryRange);
  return bounds ? JSON.stringify(bounds) : null;
}

function scaleOutLadder(parsed) {
  const levels = Array.isArray(parsed?.takeProfitLevels) ? parsed.takeProfitLevels.filter((value) => Number.isFinite(Number(value)) && Number(value) > 0).map(Number) : [];
  return levels.length > 1 ? JSON.stringify(levels) : null;
}

/* The re-decision a list route performs is not written here: it is a factory over the same `overlayLiveBlocker`
   the write path uses, so the read can be driven from a test without booting this file, and so the Overview and
   the Signals tab cannot grow two different answers to one question. */
const { withLiveBlockers } = createSignalOutcomeReader({
  pool,
  platformControls,
  runtimeEnabled: () => autoTradingRuntimeEnabled,
});

/* The capture's read of one signal row, in the camelCase every reader of it uses: the row pushed to the socket,
   the row a redelivered message answers with, and the row an edited message returns after its UPDATE. One list
   rather than three, because "what a captured signal contains" is one fact, and the day it is written out twice
   is the day a client renders a field the write path stopped selecting. */
const SIGNAL_CAPTURE_ROW_COLUMNS = `id,channel_id AS "channelId",channel_title AS "channelTitle",telegram_message_id AS "telegramMessageId",source,message,symbol,side,
  entry_price AS "entryPrice",stop_loss AS "stopLoss",take_profit AS "takeProfit",execution_ready AS "executionReady",parse_error AS "parseError",execution_note AS "executionNote",status,created_at AS "createdAt",
  direction_inferred AS "directionInferred",take_profit_levels AS "takeProfitLevels",parsed_by AS "parsedBy",parse_confidence AS "parseConfidence",llm_used AS "llmUsed",stop_loss_pips AS "stopLossPips",take_profit_pips AS "takeProfitPips",needs_review AS "needsReview",order_type AS "orderType",order_type_stated AS "orderTypeStated",is_scalping AS "isScalping",entry_range AS "entryRange",sent_at AS "sentAt",edited_at AS "editedAt"`;

async function saveSignal(userId, message, channel = {}) {
  const source = channel.source === 'manual' ? 'manual' : 'telegram';
  /* Which end of the AI reader's queue this message stands in. A message pushed by Telegram is live; a
     message catch-up is replaying is already late, and must not be served first. */
  const llmPriority = channel.replayed === true ? 'replay' : 'realtime';
  const telegramMessageId = source === 'telegram' && channel.telegramMessageId != null ? String(channel.telegramMessageId) : null;
  const savedText = String(message || '').slice(0, 5000);
  /* The one thing that has to be known before the row is written is how strict this workspace wants
     capture to be. Nothing about the plan, the trading account, or the runtime belongs here: the
     message is stored whatever those say, and they decide only what happens afterwards. */
    /* Quoted aliases, for the reason spelled out on `SIGNAL_OUTCOME_CONTEXT_SQL` - and the consequences here are
     worse than a wrong sentence. Every one of these five values is read as `settings.<camelCase>` by
     `captureSafety`, so folded to lowercase they all arrived as `undefined`: the two block-unless switches
     (which must fail closed) read as off, and the fallback distances read as unset. */
  const guardSql = 'SELECT lot_size_mode AS "lotSizeMode",block_execution_without_stop_loss AS "blockExecutionWithoutStopLoss",block_execution_without_take_profit AS "blockExecutionWithoutTakeProfit",fallback_stop_loss_points AS "fallbackStopLossPoints",fallback_take_profit_points AS "fallbackTakeProfitPoints" FROM settings WHERE user_id=$1 LIMIT 1';
  /* The one read that has to happen before the parse is the workspace's own strictness, so it does not happen
     *before* the parse: the two are issued together and the row is written as soon as both are back. A third
     round trip used to sit in front of every captured message, which on a quiet workspace is a millisecond and
     on a busy one is a place in the pool queue in front of a signal that is already late.

     What the parse is not joined by is the plan, the account and the kill switch - those are read after the
     insert, deliberately, so a workspace that toggles Auto-Trading on while a slow message is being read is
     answered from the state at the moment the row is annotated rather than the moment it arrived. Failures are
     captured rather than thrown so a rejection cannot become unhandled while the parse is still running; the
     await below is where any of them surfaces. */
  /**
   * The capture prelude, settled rather than resolved: a parse that rejects has to surface at the `await`
   * below and not as an unhandled rejection while the insert is still running, which is why both arms are
   * objects and why each half is optional rather than one of them being absent by construction.
   *
   * @type {Promise<{ value?: [any, Record<string, any>], error?: any }>}
   */
  const prelude = Promise.all([
    pool.query(guardSql, [userId]),
    parseSignalTwoLayer(savedText, { source, config: parserConfig, logger: serviceLogger, gate: llmGate, priority: llmPriority, captureBudgetMs: CAPTURE_PARSE_BUDGET_MS }),
  ]).then((value) => ({ value }), (error) => ({ error }));
  /* Both layers, in order, and the review decision with them. The model is asked here and nowhere else, and
     only when Layer 1 could not finish the message - a signal the regex reading completed is never held up by a
     provider call, and the row a reader sees later is the row that was written, provenance and all, rather than
     a row upgraded after the fact by whatever the fallback layer managed to read while the panel was already
     showing it. */
  const pre = await prelude;
  if (pre.error) throw pre.error;
  const [guardResult, reading] = pre.value;
  /* `parsed` is the reading the row is written from, and two lines below it may be replaced by the *merged* one.
     That is why these are bindings rather than a destructure in place: every judgement after them - the safety
     nets, the status, the sentence, whether a job is queued - has to be about the text and the numbers the row
     will actually hold, and there has to be one set of them. A second `captureSafety` call for the edit path is how
     a signal ends up stored as executable and refused by the engine for the same reason it was stored as one. */
  let parsed = reading.parsed;
  let review = reading.review;
  let provenance = reading.provenance;
  const guard = guardResult.rows[0] || {};
  /* An edited message is not a new signal. It is the same post, with the channel's own correction in it, and the
     row that post was captured into is the thing to fix - which is what `services/signal-edit.js` decides, in the
     open, as data: the read below answers "what does the row hold", the plan answers "what may this edit change",
     and only then does anything write. The row is looked up by `telegram_message_id`, the same three columns the
     unique index is built on, so "the row for that message" is one question with one answer.
     A note on the round trip: this read is deliberately *not* folded into the prelude above. A new message - the
     path every trader is waiting on - never takes it, and an edit is a channel amending an old post, for which one
     extra query is not the thing worth saving. */
  let editPlan = null;
  if (channel.edited === true && source === 'telegram' && telegramMessageId) {
    const stored = await pool.query(
      `SELECT * FROM signals WHERE user_id=$1 AND channel_id=$2 AND telegram_message_id=$3 AND source='telegram' LIMIT 1`,
      [userId, channel.channelId, telegramMessageId],
    );
    editPlan = planSignalEdit({ row: stored.rows[0] || null, parsed, review, provenance, savedText, editedAt: channel.editedAt ?? null });
    /* Two answers cost the row nothing. `refuse` is the status gate - the signal has been queued or traded, and
       those numbers are what an order was built from - and `none` is an edit the parser agrees with completely.
       Both return the row as the database holds it, because "the edit was seen" is not the same claim as "the edit
       was applied", and only the second one would justify a socket event. */
    if (editPlan.action === 'refuse' || editPlan.action === 'none') {
      log('info', editPlan.action === 'refuse' ? 'Telegram edit ignored: that signal has already moved' : 'Telegram edit changed nothing the row does not already hold', {
        userId, messageId: telegramMessageId, signalId: editPlan.row?.id ?? null, status: editPlan.row?.status ?? null, reason: editPlan.reason,
      });
      return editPlan.row;
    }
    if (editPlan.action === 'text') {
      const { rows: refreshed } = await pool.query(
        `UPDATE signals
           SET message=$2,edited_at=$3
           WHERE id=$1 AND status = ANY($4::text[])
           RETURNING ${SIGNAL_CAPTURE_ROW_COLUMNS}`,
        [editPlan.row.id, savedText, editPlan.editedAt ? new Date(editPlan.editedAt) : null, EDITABLE_SIGNAL_STATUSES],
      );
      const row = refreshed[0] || editPlan.row;
      /* The reading is untouched, and the log says so in the same breath as the write: a provider replacing a
         signal with a headline is the case this branch exists for, and "the text moved, the trade did not" is the
         whole answer to the question a trader asks next. */
      log('info', 'Telegram edit refreshed the message only', { userId, messageId: telegramMessageId, signalId: row?.id ?? null, reason: editPlan.reason, lost: editPlan.lost?.length ? editPlan.lost.join('|') : null });
      io.to(`user:${userId}`).emit('signal:received', row);
      return row;
    }
    /* The row is being rewritten from a reading that is not this message alone, so from here down every judgement
       below is made about the merged one. */
    if (editPlan.action === 'update') {
      parsed = editPlan.reading;
      review = editPlan.review;
      provenance = editPlan.provenance;
    }
  }
  /* Which refusals this workspace's own safety rules can answer: a fallback distance may complete a leg
     the channel forgot, an override may send the order without it, and neither is true when the block is
     up and no net is set. A direction inferred from the prices never becomes eligible at all - reading a
     channel is not the same as being told to trade. The prices themselves are computed later, against a
     live quote and the broker's own symbol rules, so the row never claims to be executable for a leg the
     broker would refuse, and never claims to be unusable for a leg the workspace has a net for. */
  /* `needs_review` is the pipeline's answer, kept separate from `execution_ready` on purpose: a row can be
     complete and still need a human, and a reviewer cannot tell a blocked signal from a broken one if both
     collapse into the same flag. */
  const safetyResult = captureSafety({ parsed, source, settings: guard, review });
  /* Rule 3 of `services/signal-edit.js`, applied to the row rather than to the reading. An edit that moved no
     price does not get to re-decide eligibility, because a stored row can hold all three prices and still be
     refused - the workspace's rules moved since it was written, or a person fixed one column - and promoting that
     row into an order on the strength of a typo fix is the provider's edit doing something nobody asked for. */
  const safety = editPlan?.action === 'update' && editPlan.eligibility === 'stored'
    ? {
      executionReady: editPlan.row.execution_ready === true,
      parseError: editPlan.row.parse_error || null,
      technicalNote: null,
      reviewRequired: editPlan.row.needs_review === true,
    }
    : safetyResult;
  const executionReady = safety.executionReady === true;
  const parseError = safety.parseError || null;
  const { rows } = await pool.query(
    /* `sent_at` is the channel's own timestamp, not ours, and it is the only way the difference between "the
       channel was quiet" and "we were deaf" survives past the log buffer. The age guard, expiry and every
       "stale" skip already measure against the moment the message was *written by the trader*, so a signal that
       reaches us five minutes late must not be described as five minutes fresh - which is what a row with only
       `created_at` would say. */
    `INSERT INTO signals(user_id,channel_id,channel_title,telegram_message_id,source,message,symbol,side,entry_price,stop_loss,take_profit,execution_ready,parse_error,status,direction_inferred,take_profit_levels,
       needs_review,parsed_by,parse_confidence,llm_used,stop_loss_pips,take_profit_pips,order_type,order_type_stated,is_scalping,entry_range,technical_note,sent_at,edited_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26::jsonb,$27,$28::timestamptz,$29::timestamptz)
     ON CONFLICT DO NOTHING
     RETURNING ${SIGNAL_CAPTURE_ROW_COLUMNS}`,
    [userId, channel.channelId || null, channel.title || null, telegramMessageId, source, savedText, parsed.symbol, parsed.side, parsed.entryPrice, parsed.stopLoss, parsed.takeProfit, executionReady, parseError, executionReady ? 'received' : 'unparsed', parsed.directionInferred === true, scaleOutLadder(parsed),
      review.required === true, provenance.parsedBy, provenance.confidence, provenance.llmUsed === true, parsed.stopLossPips, parsed.takeProfitPips, ORDER_TYPES.includes(parsed.orderType) ? parsed.orderType : 'market', parsed.orderTypeStated === true, parsed.isScalping === true, entryRangeValue(parsed),
      /* What the reader or the broker actually said. Stored for the admin panel and never selected by a route a
         user reads. */
      safety.technicalNote || review.technical || null,
      channel.sentAt ? new Date(channel.sentAt) : null,
      /* An edit whose row this workspace never saw (the post was corrected while we were not connected, or the row
         has since been purged) is stored as the capture it is and stamped as the correction it carries: there is
         nothing to update, and losing the fact that the text we stored was already amended is how a later reader
         audits the wrong message. */
      channel.editedAt ? new Date(channel.editedAt) : null],
  );
  let signal = rows[0];
  if (!signal && telegramMessageId) {
    const existing = await pool.query(
      `SELECT ${SIGNAL_CAPTURE_ROW_COLUMNS}
       FROM signals WHERE user_id=$1 AND channel_id=$2 AND telegram_message_id=$3 AND source='telegram' LIMIT 1`,
      [userId, channel.channelId, telegramMessageId],
    );
    signal = existing.rows[0];
    /* Two writers can reach here, and they want different things from the row they found. A redelivered *post* is a
       duplicate: the row that exists is the whole answer, and annotating it again would move a status the engine
       may already have written over. An *edit* whose own insert lost that race is not: the message is stored, it is
       stored once, and the reading below is what decides whether it trades. */
    if (!editPlan) return signal;
  }
  if (!signal) throw new Error('The signal could not be saved.');

  /* The correction itself, one statement, guarded twice over: on the status list this file shares with
     `services/signal-edit.js` (so the decision and the write cannot disagree about what "still open" means) and on
     the message id (so an id that belongs to another channel's row is never touched by accident). If it matches
     nothing, the row moved between the read above and this statement - a job claimed, an order sent - and the
     answer is to stop: not to annotate a signal the engine has taken over, and not to queue one behind it. */
  if (editPlan?.action === 'update') {
    const columns = editPlan.columns;
    const { rows: applied } = await pool.query(
      `UPDATE signals
         SET symbol=$2,side=$3,entry_price=$4,stop_loss=$5,take_profit=$6,stop_loss_pips=$7,take_profit_pips=$8,
             take_profit_levels=$9::jsonb,entry_range=$10::jsonb,order_type=$11,order_type_stated=$12,is_scalping=$13,
             direction_inferred=$14,needs_review=$15,parsed_by=$16,parse_confidence=$17,llm_used=$18,execution_ready=$19,
             parse_error=$20,status=$21,message=$22,technical_note=COALESCE($23,technical_note),edited_at=$24
         WHERE id=$1 AND telegram_message_id=$25 AND status = ANY($26::text[])
         RETURNING ${SIGNAL_CAPTURE_ROW_COLUMNS}`,
      [signal.id, columns.symbol, columns.side, columns.entry_price, columns.stop_loss, columns.take_profit, columns.stop_loss_pips, columns.take_profit_pips,
        scaleOutLadder(parsed), entryRangeValue(parsed), columns.order_type, columns.order_type_stated, columns.is_scalping,
        columns.direction_inferred, review.required === true, provenance.parsedBy, provenance.confidence, provenance.llmUsed === true, executionReady,
        parseError, executionReady ? 'received' : 'unparsed', savedText, safety.technicalNote || review.technical || null,
        editPlan.editedAt ? new Date(editPlan.editedAt) : null, telegramMessageId, EDITABLE_SIGNAL_STATUSES],
    );
    if (!applied.length) {
      log('warn', 'Telegram edit could not be applied: that signal had already moved', { userId, messageId: telegramMessageId, signalId: signal.id, status: signal.status || null });
      return signal;
    }
    signal = applied[0];
    /* The sentence a trader would want if they asked why this signal traded when the channel's first version said
       nothing tradeable: the block was real, the edit lifted it, and the decision to queue is made below by the
       same code that decides it for every other signal - not by a rule this path invented. The two lists say who
       supplied what, which is the question that gets asked next: did the channel give that stop loss, or did the
       platform quietly make one up? `changed` is the edit's doing and `keptFromRow` is the row's own, and the case
       this line exists for - a bare "SELL NOW" corrected into a full signal - has every leg in the first list and
       nothing in the second, which is what `filled` has always meant in this pipeline. */
    if (editPlan.wasBlocked && executionReady) {
      log('info', 'Edited signal became executable', { userId, messageId: telegramMessageId, signalId: signal.id, changed: editPlan.changedColumns?.join('|') || null, keptFromRow: editPlan.filled?.join('|') || null });
    }
  }

  /* Nothing below decides whether the message is stored - it already is. Plan, linked accounts,
     the execution runtime and the platform switch decide only whether a job is queued, and the
     outcome recorded on the signal row. A free workspace with no MetaAPI account therefore
     captures every message exactly like a paid one and sees it as unexecuted, instead of the
     listener staying quiet because trading could never have started.

     The two reads the decision needs are independent of each other, so they are issued together: on a stalled
     pool the pause check used to be a second round trip paid for after the first one, for a value that only
     decides a sentence - the engine asks `isTradingPaused` again when it claims the job. */
  const [contextResult, pausedNow] = await Promise.all([
    pool.query(SIGNAL_OUTCOME_CONTEXT_SQL, [userId]),
    platformControls.isPaused().catch(() => true),
  ]);
  const context = contextResult.rows[0] || {};
  const deliverable = source === 'telegram' && Boolean(telegramMessageId) && executionReady;
  const outcome = decideSignalOutcome({
    manual: !deliverable,
    executionReady,
    autoTradingEnabled: context.autoTrading === true,
    runtimeEnabled: autoTradingRuntimeEnabled,
    // A pause and an upgrade are only worth mentioning for a signal that could have traded;
    // a note on a manual entry or an unparseable message would just be noise.
    paused: deliverable ? pausedNow === true : false,
    subscriptionStatus: context.subscriptionStatus,
    accountSelected: Boolean(context.executionAccountId),
    accountState: context.accountState,
  });
  if (outcome.status !== signal.status || (outcome.note || '') !== (signal.executionNote || '')) {
    /* The decision sentence goes through the same filter as everything else that reaches a row. Today
       `decideSignalOutcome` is clean by construction; the filter is what turns that into a property of the write
       path rather than a promise about one module, and a sentence that ever carries internals is stored clean
       with its raw text beside it instead of on the card.

       This happens before the job exists, on purpose. The engine mirrors an order's outcome onto the same two
       columns, and a row that was queued and then annotated would be able to arrive *after* that mirror and
       write 'queued' over 'executed' - a signal that traded, displayed as one that did not. Annotate, then
       hand it over, and the two writers can only ever run in that order. */
    const recordedNote = friendlySignalNote(outcome.note, { fallback: '' });
    const { rows: recorded } = await pool.query('UPDATE signals SET status=$2,execution_note=$3,technical_note=COALESCE($4,technical_note) WHERE id=$1 RETURNING status,execution_note AS "executionNote"', [signal.id, outcome.status, recordedNote.text || null, recordedNote.original]);
    if (recorded[0]) Object.assign(signal, recorded[0]);
  }
  if (outcome.queue) {
    await pool.query(
      `INSERT INTO execution_jobs(user_id,signal_id,status,expires_at)
       VALUES($1,$2,'queued',NOW()+INTERVAL '2 minutes') ON CONFLICT(signal_id) DO NOTHING`,
      [userId, signal.id],
    );
    /* The order is not waited for - it is *started*. Waking the worker here is what turns "queued" into "on the
       way to the broker" in the same event-loop turn instead of on the next poll, and it is fire-and-forget by
       design: an order that takes a second must not hold up the row the trader is waiting to see. */
    executionWorker.notify();
  }
  io.to(`user:${userId}`).emit('signal:received', signal);
  return signal;
}

/*
 * The live capture path, and the reason it used to be invisible.
 *
 * This block used to be a function in this file reading `message.chatId` and comparing it with one
 * exact string. Both halves were wrong in the same direction: that property is not on every update
 * shape GramJS delivers, and a channel id has two spellings (`-1001234567890` and `1234567890`)
 * depending on which accessor produced it - so a message either had no id to read or an id that did
 * not equal the stored one, and the handler returned. No error, no row, no line in the log: a
 * workspace could monitor a channel for weeks and see only "Waiting for signals".
 *
 * It now lives in `services/telegram-listener.js` with its dependencies injected, for two reasons.
 * The first is that the fix can only be believed when a test can drive a real GramJS update through
 * the real dispatcher into the real storage call, which a closure over module state cannot be. The
 * second is that three separate things had to be guaranteed and were not: that a handler is attached
 * to the client that is actually connected (verified against GramJS's own handler list, not against
 * a flag of ours), that channel ids are matched in every spelling on both sides, and that the
 * messages which arrived while this instance was not running are pulled back out of Telegram -
 * `catchUp()` in this version of the library is an empty stub, so nothing else ever will.
 */
/* Every client this process owns gets the same guard, and it has to be attached before `connect()` because that
   is where GramJS starts the update loop whose ping race produces the noise. What it does is narrow: it
   recognises the provider's own keep-alive timeout - `TIMEOUT` from `client/updates.js` on GramJS, and
   `Ping`/`Read timeout of Ns expired` from `network/session/Session.js` on teleproto - counts it per client, and answers the
   library's own logging gate "no" for that one print. Everything else the library logs - and everything our
   handlers throw while the library is on the call stack, which is the failure mode a stack-substring filter
   would have eaten - goes to the log untouched. */
const telegramKeepAlive = createTelegramKeepAliveGuard({ log: (level, message, meta) => log(level, message, meta) });

const telegramCapture = createTelegramListener({
  clients: telegramClients,
  pool,
  log: (level, message, meta) => log(level, message, meta),
  saveSignal: (userId, message, channel) => saveSignal(userId, message, channel),
  /* The listener decides *when* a stream is not a stream; only this file can rebuild one, because a rebuild is
     a disconnect, a fresh authorized client, a re-attach and a replay. Handing the callback down instead of
     importing it keeps the watchdog testable without a server: a test injects a spy and asserts it fired.
     `force` is the human override - the cooldown protects Telegram from a watchdog that misread a quiet channel,
     and it has no argument with an operator reading the evidence - and a restore retakes the beat's baseline,
     because a session that starts from zero counters would otherwise be accused of its own first minute. */
  onDeadStream: (userId, reason, { force = false, escalate = false } = {}) => restoreTelegramClient(userId, { reason, force, escalate }),
  /* The last rung of the ladder, and the only one this file can climb with a database write rather than a socket:
     `pts` still unreconciled three beats after a brand-new session was handed to it, or an auth key Telegram no
     longer recognises. Both mean the same thing - the account has stopped treating *this login* as a live session -
     and only the user can mint a new one, so the verdict is written where the app already looks for "is Telegram
     linked" instead of being invented here. The session string is deliberately left in place:
     `telegram_connected=FALSE` stops the resume loop and shows the user the connect flow, while the stored session
     survives for an admin's forced reconnect, which is the one thing worth trying before asking a human for their
     phone. Nulling it, as the unauthorised path in `restoreTelegramClient` does, is right when the key is provably
     dead and wrong when we merely failed to prove it alive. */
  // What the provider's own ping loop last did to this client, so a beat that finds an unanswered socket during a
  // flap waits one cycle instead of rebuilding a session the library was about to hand back.
  transportFlap: (client) => telegramKeepAlive.flapFor(client),
  onSessionUnrecoverable: async (userId, reason, details = {}) => {
    /* Text, not a number, and validated as text: `users.id` is a UUID and the map below is keyed by `req.userId`,
       which is that UUID. The first version of this guard coerced the id to a number and refused anything the
       coercion did not turn into a positive integer, so in production it refused every single workspace, this
       whole block never ran, and a session that was already known dead was reported as healthy for as long as the
       process lived. The shape of the check is pinned by a test because the shape is the bug. */
    if (!isValidWorkspaceId(userId)) return;
    await pool.query('UPDATE users SET telegram_connected=FALSE WHERE id=$1', [userId]).catch((error) => {
      log('warn', 'Telegram re-auth marking could not be saved', { userId, reason, error: error.message });
    });
    const entry = telegramClients.get(userId);
    if (telegramAdapter.canDisconnect(entry?.client)) await telegramAdapter.disconnect(entry.client).catch(() => {});
    telegramKeepAlive.release(entry?.client);
    telegramClients.delete(userId);
    log('warn', 'Telegram session left for the user to sign in again', {
      userId, reason, pts: details?.pts ?? null, gap: details?.gap ?? null, strikes: details?.strikes ?? null, error: details?.error ?? null,
    });
  },
});
const startTelegramListener = (userId, client) => telegramCapture.startTelegramListener(userId, client);

/** How far back the platform purge goes unless the administrator says otherwise. */
const SIGNAL_PURGE_DEFAULT_DAYS = 30;

/**
 * Unlink first, then delete, inside one transaction.
 *
 * Both statements come from the same builder, so the pair cannot drift apart, and the transaction is
 * what makes "the signal is gone but the order it produced still points at it" impossible: if either
 * half fails, neither happens. `rowCount` from the delete is the number returned to the panel, so the
 * panel states what the database actually removed rather than what was expected.
 */
async function runSignalDelete(pair) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const unlinked = await client.query(pair.unlink.sql, pair.unlink.params);
    const removed = await client.query(pair.remove.sql, pair.remove.params);
    const deleted = removed.rowCount ?? 0;
    await client.query('COMMIT');
    return { deleted, unlinked: unlinked.rowCount ?? 0, rows: removed.rows || [] };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/**
 * How the capture client reaches Telegram, and what that option is really for.
 *
 * GramJS on Node has no WebSocket transport: `useWSS` moves the data centre from port 80 to 443 and leaves the
 * Node socket layer (`PromisedNetSockets`) speaking the same obfuscated MTProto over it - the WebSocket framing
 * only exists in the browser build. So the honest description of `TELEGRAM_TRANSPORT=wss` is "carry the
 * connection on 443 instead of 80", which is still worth being able to ask for: hosts that shape or reap idle
 * flows on the API's plain port are common, and a different destination port is a different flow. The real
 * defence against that reaping is the 30-second beat, not this; what this buys is a knob an operator can turn
 * in one environment variable, and because a refused handshake would otherwise mean *no capture at all*, a
 * connect that fails with the option on retries once on the default transport and says so.
 */
function telegramCaptureTransport({ wss = null } = {}) {
  /* `connectionRetries` is how many times the sender tries to *establish* a connection at `retryDelay` (1 s) apart
     before it gives up, and `autoReconnect` is what lets it try again after that. Five, not three: the keep-alive
     loop in `client/updates.js` gives the transport about forty seconds of its own retrying (a 9-second interval
     and three 10-second races), so a session that stops trying at three is a session our watchdog then has to
     rebuild from nothing - a longer outage than the one the library was already fixing, plus a fresh auth
     handshake for a hiccup that would have healed. There is deliberately no request-timeout option here: this
     version accepts `timeout` and stores it as `_connectTimeout`, which nothing reads, and an option that is not
     read is worse than no option, because the next person to tune the file will believe it did something. */
  const fromEnv = String(process.env.TELEGRAM_TRANSPORT || '').toLowerCase() !== 'wss' ? { wss: false } : { wss: true };
  const overWss = wss === null ? fromEnv.wss : wss === true;
  return { wss: overWss, options: telegramAdapter.captureTransportOptions({ wss: overWss }) };
}

/**
 * Bring one workspace's Telegram session up, and make sure something is listening on it.
 *
 * An entry whose client is present but not connected used to be left exactly as it was found: the
 * handler stayed attached to a socket that had already closed, `users.telegram_connected` still said
 * true, and the workspace was told it was connected forever. Reconnecting the same client and
 * re-attaching the handler is what a sleeping host needs, because a wake is a new process while the
 * flag in the database is inherited from the old one.
 */

/** The interval the listener re-arm sweep runs on, named once so the guard's overrun threshold cannot disagree. */
const TELEGRAM_SWEEP_INTERVAL_MS = 60_000;

/* One rebuild per workspace, and one pass per sweep, for the length of the pass.
 *
 * This is the fix for the orphaned-client leak, and the reason it is a latch rather than a check: two passes that
 * both decide a session must be rebuilt each construct a `TelegramClient`, each `await` a connect (which is real
 * network time, seconds per workspace), and each then write `telegramClients`. The later write wins the map, and
 * the loser keeps its socket open, its update loop running, and its receive buffers live, referenced by nothing
 * that could ever close it. Under a host whose network is slow enough that a 60-second pass takes 90, that is one
 * orphan per workspace per minute.
 *
 * `staleAfterMs` is what keeps the latch from becoming the outage: a rebuild wedged on a socket that never answers
 * must not be able to lock a workspace out of ever being restored again, so after five minutes the next arrival
 * takes the key and the wedged call's completion is discarded by token. */
const telegramRestoreFlight = createSingleFlight({
  onContention: (userId, info) => log('debug', 'Telegram rebuild already running for this workspace', { userId, runningForMs: info.elapsedMs }),
  onTakeover: (userId, info) => log('warn', 'Telegram rebuild lock taken over from a wedged attempt', { userId, heldForMs: info.elapsedMs }),
  onFinished: (userId, info) => { if (info.ok && info.elapsedMs > TELEGRAM_SWEEP_INTERVAL_MS) log('warn', 'Telegram rebuild outlived the sweep interval', { userId, elapsedMs: info.elapsedMs, intervalMs: TELEGRAM_SWEEP_INTERVAL_MS }); },
});

const telegramSweepGuard = createPassGuard({
  name: 'telegram-sweep',
  overrunAfterMs: TELEGRAM_SWEEP_INTERVAL_MS,
  onSkip: (info) => log('info', 'Telegram sweep skipped: the previous pass is still running', { pass: info.name, runningForMs: info.runningForMs }),
  onOverrun: (info) => log('warn', 'Telegram sweep took longer than its interval, so overlapping passes are being refused', { pass: info.name, elapsedMs: info.elapsedMs, thresholdMs: info.thresholdMs }),
});

const telegramBeatGuard = createPassGuard({
  name: 'telegram-heartbeat',
  overrunAfterMs: HEARTBEAT_INTERVAL_MS,
  onSkip: (info) => log('info', 'Telegram heartbeat skipped: the previous beat is still running', { pass: info.name, runningForMs: info.runningForMs }),
  onOverrun: (info) => log('warn', 'Telegram heartbeat took longer than its interval', { pass: info.name, elapsedMs: info.elapsedMs, thresholdMs: info.thresholdMs }),
});

/** The previous beat's numbers, so one line can say "climbing" instead of making a human compare two lines. */
let lastMemorySample = null;

/** The counters worth reading when the memory graph is climbing, in the order they explain each other. */
function memorySample() {
  const usage = process.memoryUsage();
  const mb = (bytes) => Math.round((bytes / 1024 / 1024) * 10) / 10;
  const sample = {
    heapUsedMb: mb(usage.heapUsed),
    externalMb: mb(usage.external || 0),
    arrayBuffersMb: mb(usage.arrayBuffers || 0),
    rssMb: mb(usage.rss),
    /* `external` and `arrayBuffers` are not in `heapUsed`: an MTProto socket leak shows up there and nowhere
       else, which is why a memory line that logs only the heap can look flat while the process is dying. Render
       caps the container on RSS, so RSS is the number the alert was actually fired on. */
    telegramClients: telegramClients.size,
    telegramLogins: telegramLogins.size,
    keepAliveGuardedClients: telegramKeepAlive.stats().clients,
    rebuildsInFlight: telegramRestoreFlight.size(),
  };
  const previous = lastMemorySample;
  lastMemorySample = sample;
  return previous ? { ...sample, heapDeltaMb: Math.round((sample.heapUsedMb - previous.heapUsedMb) * 10) / 10, rssDeltaMb: Math.round((sample.rssMb - previous.rssMb) * 10) / 10 } : sample;
}

/**
 * Bring one workspace's session up, one attempt at a time.
 *
 * The wrapper is the whole of the concurrency control; `rebuildTelegramClient` below is the work itself and is
 * not called from anywhere else, which is what makes "only one rebuild can be in flight" a property of the file
 * rather than a habit of its callers.
 */
async function restoreTelegramClient(userId, { reason = 'restore', force = false, escalate = false } = {}) {
  const outcome = await telegramRestoreFlight.run(userId, () => rebuildTelegramClient(userId, { reason, force, escalate }));
  if (!outcome.ran) {
    /* Another pass is already rebuilding this workspace, and this one leaves with whatever the map holds right
       now - possibly the old client, possibly null. That is deliberately not an error: every caller here is a
       sweep or a watchdog that will run again, and a rebuild that returns the previous client is a rebuild that
       reports "not yet", which is what the status route already knows how to show. */
    return telegramClients.get(userId)?.client || null;
  }
  if (outcome.error) throw outcome.error;
  return outcome.value;
}

async function rebuildTelegramClient(userId, { reason = 'restore', force = false, escalate = false } = {}) {
  const current = telegramClients.get(userId);
  /* Two reasons to step past the "already listening" shortcut, and they are different asks. `escalate` is the
     watchdog's: the socket is up and the handler is attached, and the stream is still deaf, so the session itself
     has to go and the update state has to be reconciled before anything else is trusted. `force` is the operator's
     - the same rebuild, without waiting for the cooldown. Before this, both flags reached a function that ignored
     them and returned the connected client, which is why a "forced" reconnect of a deaf session changed nothing
     but the timestamp on the audit row. */
  const mustRebuild = force === true || escalate === true;
  if (!mustRebuild && telegramAdapter.isConnected(current?.client) && current.handler && telegramCapture.handlerIsLive(current.client, current.handler)) return current.client;
  if (current?.client && !telegramAdapter.isConnected(current.client)) {
    try { await telegramAdapter.connect(current.client); } catch (error) { log('warn', 'Telegram reconnect deferred', { userId, error: error.message }); }
    if (telegramAdapter.isConnected(current.client)) {
      /* A socket that came back is a socket whose update state may not have: Telegram stops pushing to a session
         that never reconciled the updates it missed, and GramJS never reconciles one. Asking now - two cheap
         requests, `updates.GetState` and, only if the account moved while we were out, `updates.GetDifference` -
         is what turns "reconnected" into "listening again". */
      await telegramCapture.resyncUpdateState(current.client, { userId, reason: `${reason}:reconnected` });
      await startTelegramListener(userId, current.client);
      void telegramCapture.runCatchUp(userId).catch(() => {});
      return current.client;
    }
  }
  // Whatever half-connected object was here is dropped before a new one replaces it, so a wake does
  // not leave a second authorized session polling with the same StringSession - and so an escalated rebuild of a
  // session that still looks fine does not leave the deaf one attached and receiving.
  if (current?.client && (!telegramAdapter.isConnected(current.client) || mustRebuild)) {
    await telegramAdapter.disconnect(current.client).catch(() => {});
    // The keep-alive guard keeps one record per client it has ever seen; a client that has just been disconnected
    // is never going to time out again, so its record is dropped here rather than left for the backstop sweep.
    telegramKeepAlive.release(current.client);
  }
  const { rows } = await pool.query('SELECT telegram_session FROM users WHERE id=$1', [userId]);
  if (!rows[0]?.telegram_session) {
    if (current) telegramClients.delete(userId);
    return null;
  }
  if (!process.env.API_ID || !process.env.API_HASH) throw new Error('Telegram API credentials are not configured');
  const sessionString = decryptSecret(rows[0].telegram_session);
  const transport = telegramCaptureTransport();
  let client = telegramAdapter.createClient({ sessionString, apiId: Number(process.env.API_ID), apiHash: process.env.API_HASH, options: transport.options });
  telegramKeepAlive.attach(client, { userId });
  try {
    await telegramAdapter.connect(client);
  } catch (error) {
    if (!transport.wss) throw error;
    // The experiment is allowed to fail; capture is not allowed to be the thing that pays for it.
    log('warn', 'Telegram WSS transport could not connect; reconnecting over the default transport', { userId, error: `${error?.message || error}`.slice(0, 160) });
    await telegramAdapter.disconnect(client).catch(() => {});
    // The same tuned options over the plain port - restating them here is how a retry path ends up with the
    // settings the primary one stopped having three releases ago.
    client = telegramAdapter.createClient({ sessionString, apiId: Number(process.env.API_ID), apiHash: process.env.API_HASH, options: telegramCaptureTransport({ wss: false }).options });
    telegramKeepAlive.attach(client, { userId });
    await telegramAdapter.connect(client);
  }
  if (!(await telegramAdapter.checkAuthorization(client))) {
    await telegramAdapter.disconnect(client).catch(() => {});
    await pool.query('UPDATE users SET telegram_connected=FALSE,telegram_session=NULL WHERE id=$1', [userId]);
    telegramClients.delete(userId);
    log('warn', 'Telegram session is no longer authorized', { userId, reason });
    return null;
  }
  /* Before the handler, before the catch-up, and only after `checkAuthorization` has answered: a new client from
     a stored StringSession inherits the *account's* stream, and unless somebody tells Telegram where this session
     stands it keeps believing we are behind. `resyncUpdateState` is that sentence - it seeds the cached `pts` on a
     session that has none, and closes a real gap with a difference request instead of waiting for a push that will
     never come. */
  await telegramCapture.resyncUpdateState(client, { userId, reason: `${reason}:new-session`, force: mustRebuild });
  /* The compare-and-swap, and it is here rather than at the top of the function because this is the first moment
     at which our client is finished: somebody else may have restored this workspace while we were connecting, and
     if they did, *theirs* is the one in the map and ours is the orphan. Disconnecting before discarding is the
     whole point - an authorized GramJS client with a live socket does not stop because nothing points at it.
     The per-workspace latch above makes this branch unreachable in the ordinary case, which is why it logs at
     warn when it is not: it means a path reached a rebuild that did not come through here. */
  const holder = telegramClients.get(userId);
  if (holder && holder !== current) {
    log('warn', 'Telegram rebuild lost the race and is discarding its own client', { userId, reason, heldSince: holder.attachedAt || null });
    await telegramAdapter.disconnect(client).catch(() => {});
    telegramKeepAlive.release(client);
    return holder.client;
  }
  telegramClients.set(userId, { client, handler: null, stats: telegramCapture.EMPTY_STATS() });
  telegramCapture.resetStreamBaseline(userId);
  await startTelegramListener(userId, client);
  await pool.query('UPDATE users SET telegram_connected=TRUE WHERE id=$1', [userId]);
  telegramCapture.markSessionResumed();
  log('info', 'Telegram session restored for capture', { userId, reason, transport: transport.wss ? '443' : 'default', forced: force === true, escalated: escalate === true });
  // The messages this session missed while nothing was running are pulled back in the background,
  // so a workspace that was asleep during a channel's signal does not have to wait for the next one.
  void telegramCapture.runCatchUp(userId).catch((error) => log('warn', 'Telegram catch-up failed', { userId, error: error.message }));
  return client;
}

/**
 * Every workspace with a stored session gets a live listener, whether or not anyone opens the app.
 *
 * The first pass happens at boot; the sweep that repeats it is what covers the other case - a
 * process that survives while its socket dies, which is what a paused host looks like from inside.
 * Each pass is cheap: an entry already connected with a verified handler costs one boolean check.
 */
async function resumeTelegramSessions({ reason = 'restore' } = {}) {
  const { rows } = await pool.query('SELECT id FROM users WHERE telegram_connected=TRUE AND telegram_session IS NOT NULL ORDER BY last_active_at DESC NULLS LAST LIMIT 200');
  let restored = 0;
  for (const row of rows) {
    try {
      if (await restoreTelegramClient(row.id, { reason })) restored += 1;
    } catch (error) {
      log('warn', 'Telegram listener restore failed', { userId: row.id, error: error.message });
    }
  }
  if (rows.length) log('info', 'Telegram sessions swept for capture', { reason, wanted: rows.length, restored });
  return { wanted: rows.length, restored };
}

/**
 * Prove that every "listening" session is actually receiving, once a minute.
 *
 * `connected === true` and a handler in GramJS's own list are both facts about objects in memory. Neither is a
 * fact about the socket, and a socket can be open and entirely deaf - a `pts` gap Telegram stopped filling, an
 * idle connection reaped by the host's NAT and quietly half-resumed, a reconnect that left the update manager
 * attached to the previous transport. The old answer to that was `streamIdle` in the health panel, reported
 * after fifteen quiet minutes, which on a scalping channel is fifteen minutes of missed entries and one
 * unanswered support message. So the sweep now asks the question directly, and the two answers it can get are
 * both acted on: a socket that will not answer a bounded request is torn down and rebuilt (which re-attaches
 * and catches up), and a socket that answers but has heard nothing is cross-checked against the channel.
 */
async function checkTelegramStreams({ reason = 'sweep' } = {}) {
  const results = { checked: 0, gapChecked: 0, caughtUp: 0 };
  const checks = [];
  for (const [userId] of telegramClients.entries()) {
    const health = telegramCapture.streamHealth(userId);
    if (!health.listening) continue; // a session with no handler is `rearmTelegramListeners'` business
    results.checked += 1;
    checks.push((async () => {
      /* The periodic question, asked on the workspace's own offset: `pts` desync, a Telegram-side drop, a
         mid-stream gap that leaves another channel still arriving - every one of those keeps `lastAt` fresh
         while a message sits unread, so a silence clock alone would never ask. The dedupe index makes the
         overlap with a live push free, which is what lets this be a schedule rather than an accusation.

         The socket itself is no longer this function's job: `beatUpdateStreams` asks every connected session an
         active question every 30 seconds, so "can you still answer" is never older than half a minute and is
         never decided by whether a channel happened to post. What is left here is the question a ping cannot
         answer - what did the channel say - and a replay that finds a message posted while the handler was
         attached asks for a rebuild of its own. */
      if (health.catchUpOverdue) {
        const outcome = await telegramCapture.runCatchUp(userId);
        if (outcome?.ran) {
          results.gapChecked += 1;
          results.caughtUp += Number(outcome.stored) || 0;
        }
      }
    })().catch((error) => log('warn', 'Telegram stream check failed', { userId, error: error.message })));
  }
  if (checks.length) await Promise.allSettled(checks);
  if (results.gapChecked) log('info', 'Telegram streams checked', { reason, ...results });
  return results;
}

/**
 * One heartbeat cycle, with a failure of the cycle logged rather than thrown.
 *
 * An interval callback that rejects once would otherwise stop the keep-alive permanently and quietly, which is
 * the exact failure this exists to prevent, so nothing here is allowed to propagate.
 */
async function beatTelegramStreams({ reason = 'interval' } = {}) {
  const outcome = await telegramBeatGuard.run(async () => {
    try {
      return await telegramCapture.beatUpdateStreams({ reason });
    } catch (error) {
      log('warn', 'Telegram heartbeat cycle failed', { reason, error: `${error?.message || error}`.slice(0, 200) });
      return null;
    }
  });
  /* Every beat, on purpose, whether or not any session is connected. A memory curve you can read needs a fixed
     sample interval, and the failure this line exists for - clients accumulating in `telegramClients` while RSS
     climbs - is only visible against a clock. The numbers are also the only way to tell a heap leak from a
     socket leak without attaching a profiler to production. */
  memorySampleLine(reason, outcome);
  return outcome.ran ? outcome.value : null;
}

function memorySampleLine(reason, outcome) {
  const sample = memorySample();
  const guard = telegramKeepAlive.stats();
  log(sample.telegramClients > sample.telegramLogins && sample.heapDeltaMb !== undefined && sample.heapDeltaMb > 8 ? 'warn' : 'info', 'Telegram heartbeat memory', {
    reason,
    ...sample,
    beatSkipped: outcome.ran === false,
    suppressedTimeouts: guard.count,
  });
}

/**
 * The operator's override, for the case the panel says "Listening" while nothing arrives.
 *
 * This is the one reconnect that does not depend on a detector being right, and it is deliberately outside the
 * watchdog's throttle: a rebuild is a disconnect, a fresh authorized client, a re-attach and a replay of the
 * backlog, which is exactly what a person wants when the logs already show a stream that is not delivering. The
 * answer carries what that replay found, because the honest response to "reconnect it" is "the session is new,
 * and here is what it had to catch up on" rather than `ok`. Both halves of the audit row matter here: "someone
 * forced this at 14:02" is the first question after a rebuild that fixed something, and "we rebuilt it by hand
 * twice" is the answer that rules the server out.
 */
async function forceTelegramReconnect(userId, { reason = 'manual-reconnect', actorId = null, actorEmail = null } = {}) {
  let client;
  try {
    client = await restoreTelegramClient(userId, { reason, force: true });
  } catch (error) {
    log('warn', 'Telegram forced reconnect failed', { userId, actorId, reason, error: `${error?.message || error}`.slice(0, 200) });
    const failure = new Error('Telegram did not accept the new connection.');
    failure.telegramReconnectFailed = true;
    failure.cause = error;
    throw failure;
  }
  if (!client) {
    const missing = new Error('There is no saved Telegram session to reconnect.');
    missing.telegramNoSession = true;
    throw missing;
  }
  const capture = telegramCapture.heartbeatSummary();
  const outcome = await telegramCapture.runCatchUp(userId).catch((error) => {
    // The reconnect itself landed, and a backlog read that fails afterwards is a note on the response rather
    // than a failure of the action: the re-attach already flagged the catch-up, so the next sweep takes it from
    // here, and saying so is what stops a person pressing the button twice.
    log('warn', 'Telegram backlog after a forced reconnect did not run', { userId, error: error.message });
    return null;
  });
  const caughtUp = Number(outcome?.stored) || 0;
  const fresh = Number(outcome?.fresh) || 0;
  await auditLog.record({
    actorId,
    actorEmail,
    action: 'telegram.reconnectForced',
    targetType: 'user',
    targetId: userId,
    summary: `Reconnected a workspace's Telegram session by hand and replayed its channels: ${caughtUp} missed message(s) stored, ${fresh} of them posted while the old handler was already attached.`,
    metadata: { reason, caughtUp, fresh, heartbeatCycles: capture.cycles, deadBeats: capture.dead, stalledBeats: capture.stalled },
  }).catch((error) => log('warn', 'Telegram forced reconnect could not be audited', { userId, error: error.message }));
  log('warn', 'Telegram session reconnected by hand', { userId, actorId, reason, caughtUp, fresh, heartbeatCycles: capture.cycles, deadBeats: capture.dead, stalledBeats: capture.stalled });
  return { caughtUp, fresh, heartbeat: { cycles: capture.cycles, dead: capture.dead, stalled: capture.stalled } };
}

/** Re-attach anything in memory that has lost its handler, and run the catch-up it flagged. */
async function rearmTelegramListeners() {
  let rearmed = 0;
  const catchUps = [];
  for (const [userId, entry] of telegramClients.entries()) {
    if (telegramAdapter.isConnected(entry.client) && (!entry.handler || !telegramCapture.handlerIsLive(entry.client, entry.handler))) {
      await startTelegramListener(userId, entry.client);
      rearmed += 1;
    }
    /* Replays are started together and never awaited here. A catch-up is a run of Telegram API calls on a
       connection that may be throttled, and awaiting it per user meant the twelfth workspace's missed messages
       waited behind the first workspace's flood wait - while every one of those workspaces was still receiving
       live updates on their own clients. Nothing in this loop needs another user's result, so nothing in it
       may wait for one. */
    if (entry.needsCatchUp && telegramAdapter.isConnected(entry.client)) {
      catchUps.push(telegramCapture.runCatchUp(userId).catch((error) => log('warn', 'Telegram catch-up failed', { userId, error: error.message })));
    }
  }
  if (catchUps.length) await Promise.allSettled(catchUps);
  return rearmed;
}

io.use((/** @type {DeskSocket} */ socket, next) => {
  let payload;
  try {
    payload = jwt.verify(socket.handshake.auth?.token, process.env.JWT_SECRET);
  } catch { return next(new Error('Authentication required')); }
  socket.userId = payload.sub;
  /*
   * One rule from `authenticate` has to be repeated here, because the socket is now a second door into the same
   * rows: an impersonation token is only valid while the support session behind it is. Verified once at the
   * handshake, and remembered on the socket, so closing the session can also stop the stream - which the REST
   * half of the same guarantee already implied and this door did not, until the live signal feed opened it.
   */
  if (String(payload.purpose || '') !== 'impersonation') return next();
  Promise.resolve()
    .then(() => supportSessions.redeem(payload.jti))
    .then((session) => {
      if (!session || String(session.userId) !== String(payload.sub)) return next(new Error('Authentication required'));
      socket.data.supportSessionId = session.id;
      return next();
    })
    .catch(() => next(new Error('Authentication required')));
});
io.on('connection', (/** @type {DeskSocket} */ socket) => {
  socket.join(`user:${socket.userId}`);
  socket.emit('connected', { ok: true });
});

/**
 * Ends the sockets a closed support session left open. The room it joined belongs to the workspace it was
 * looking at, so the real owner's sockets share it and are untouched: only sockets tagged with this session id
 * are dropped.
 */
function disconnectSupportSockets(sessionId) {
  if (!io || !sessionId) return 0;
  let dropped = 0;
  for (const socket of io.sockets.sockets.values()) {
    if (socket.data && socket.data.supportSessionId === sessionId) {
      dropped += 1;
      socket.disconnect(true);
    }
  }
  return dropped;
}

/*
 * The answer to a question this workspace has had to guess at repeatedly: is the code I just merged
 * the code that is running? A boot stamp costs nothing to expose, and without it "the fix is not
 * working" and "the fix was never deployed" are the same observation. `RENDER_GIT_COMMIT` is set by
 * Render for a Git-connected service; when it is absent the stamp says so rather than inventing one.
 */
const BOOTED_AT = new Date();
const healthPayload = () => ({
  status: 'ok',
  /* Whether the read-path re-decision is running, in counts only: `/health` is not authenticated, so a note's
     text or a workspace id has no business in it. It is here because a screen that looks wrong and a code path
     that never ran are indistinguishable from the outside, and this settles which one it is without a log
     search. The lines themselves - with the reason each row was skipped - go to stdout. */
  overlay: describeOverlayDiagnostics(),
  timestamp: new Date().toISOString(),
  bootedAt: BOOTED_AT.toISOString(),
  uptimeSeconds: Math.round((Date.now() - BOOTED_AT.getTime()) / 1000),
  gitCommit: process.env.RENDER_GIT_COMMIT || process.env.GIT_COMMIT || null,
  /* The keep-alive watchdog, in counts only, for the same reason the block above is here: this route is public,
     so it can say that every session was asked a question half a minute ago and how many had to be rebuilt, and
     it can never say whose session was. `stale: true` is the one value on this route that means "look at the
     logs now": the interval itself stopped, which is a different failure from a stream being deaf. */
  telegram: telegramHeartbeatHealth(),
});

/** The public shape of the heartbeat: cycle counters and a session count, with no per-workspace detail. */
function telegramHeartbeatHealth() {
  try {
    const { beats, ...counters } = telegramCapture.heartbeatSummary();
    /* One number from the keep-alive guard, on the endpoint an operator reads when something is wrong: how many
       of the provider's own ping timeouts this process has swallowed since boot. A count rather than a stack
       trace is the whole argument for the guard, and it belongs here rather than on the user's status route
       because a trader can do nothing with it - while whoever is deciding whether to restart a fleet can. */
    return { ...counters, keepAliveTimeouts: telegramKeepAlive.stats().count, sessions: Array.isArray(beats) ? beats.length : 0 };
  } catch {
    // A diagnostic must not be able to take the endpoint the platform's health check depends on with it.
    return null;
  }
}
/**
 * Whether the database answers, decided on a short deadline. A health route that awaits the database with
 * no limit hangs exactly as long as the database is hung, which turns one stalled dependency into an
 * unresponsive service and, on Render, into a killed instance and a lost log.
 */
const databaseProbe = async () => {
  try {
    await withDeadline(pool.query('SELECT 1'), HEALTH_PROBE_TIMEOUT_MS, 'the health probe');
    return 'ok';
  } catch {
    return boot.database === 'ok' ? 'unreachable' : boot.database;
  }
};
/* The public shape of the startup state, deliberately without `lastError`: a migration failure message can
   name a table, a column, or a host, and `/health` is not authenticated. The administrator sees the full
   object through the System Health snapshot below. */
const publicStartup = () => ({ ready: boot.ready, step: boot.step, database: boot.database, statements: boot.statements, attempts: boot.attempts });
const startupStatus = async () => ({ database: await databaseProbe(), startup: publicStartup() });
app.get('/health', asyncRoute(async (_req, res) => { res.set('Cache-Control', 'no-store').json({ ...healthPayload(), ...(await startupStatus()) }); }));
app.get('/api/health', asyncRoute(async (_req, res) => { res.set('Cache-Control', 'no-store').json({ ...healthPayload(), ...(await startupStatus()) }); }));

/* Declared after the health routes so a starting service can still be asked how it is doing; the exempt set
   is the same promise in code, so moving these routes cannot accidentally gate the endpoint the platform
   and the status page depend on. */
app.use((req, res, next) => {
  if (boot.ready || STARTUP_GATE_EXEMPT.has(req.path)) return next();
  res.set('Cache-Control', 'no-store').status(503).json({
    error: 'Signal Desk is still starting up. Please try again in a moment.',
    code: 'STARTING',
  });
});

// Public browser configuration. These two values are safe to ship to a browser
// (they are already bundled into every frontend build); exposing them at runtime
// means password recovery works even when the static-site build did not receive
// the VITE_SUPABASE_* variables.
app.get('/api/config', (_req, res) => {
  res.set('Cache-Control', 'no-store').json({
    supabaseUrl: String(process.env.SUPABASE_URL || '').trim(),
    supabasePublishableKey: String(process.env.SUPABASE_PUBLISHABLE_KEY || '').trim(),
    passwordRecoveryConfigured: supabaseAuthBridge.isAdminConfigured(),
  });
});

app.post('/api/auth/register', asyncRoute(async (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 100);
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  if (!name || !/^\S+@\S+\.\S+$/.test(email) || password.length < 10) return fail(res, 400, 'Enter a name, valid email, and password with at least 10 characters.');
  const duplicate = await pool.query('SELECT id FROM users WHERE email=$1 LIMIT 1', [email]);
  if (duplicate.rows.length) return fail(res, 409, 'An account with that email already exists.');
  let supabaseUserId = null;
  try { supabaseUserId = await supabaseAuthBridge.createRegistrationIdentity({ email, password, name }); }
  catch (error) {
    if (error.status === 409) return fail(res, 409, error.message);
    log('warn', 'Supabase Auth registration bridge failed', { code: error.code || 'AUTH_PROVIDER_ERROR' });
    return fail(res, 503, 'Account registration is temporarily unavailable. Please try again later.');
  }
  const hash = await bcrypt.hash(password, 12);
  const dbClient = await pool.connect();
  try {
    await dbClient.query('BEGIN');
    const { rows } = await dbClient.query("INSERT INTO users(name,email,password_hash,supabase_user_id,role) VALUES($1,$2,$3,$4,$5) RETURNING id,name,email,role,created_at", [name, email, hash, supabaseUserId, adminAccess.isAdminEmail(email) ? 'admin' : 'user']);
    await dbClient.query('INSERT INTO settings(user_id) VALUES($1) ON CONFLICT DO NOTHING', [rows[0].id]);
    await dbClient.query('COMMIT');
    const user = publicUser(rows[0]);
    res.status(201).json({ token: issueToken(user, req.body.rememberMe === true), user });
  } catch (error) {
    await dbClient.query('ROLLBACK').catch(() => {});
    if (supabaseUserId) await supabaseAuthBridge.deleteAuthUser(supabaseUserId).catch((cleanupError) => log('error', 'Orphan Supabase Auth registration cleanup failed', { code: cleanupError.code || 'AUTH_PROVIDER_ERROR' }));
    if (error.code === '23505') return fail(res, 409, 'An account with that email already exists.');
    throw error;
  } finally { dbClient.release(); }
}));
app.post('/api/auth/login', asyncRoute(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const { rows } = await pool.query('SELECT id,name,email,password_hash,supabase_user_id,role,is_suspended,suspension_reason,created_at FROM users WHERE email=$1', [email]);
  if (!rows[0]) return fail(res, 401, 'Email or password is incorrect.');
  const localPasswordValid = await bcrypt.compare(password, rows[0].password_hash);
  if (rows[0].supabase_user_id && supabaseAuthBridge.isPublicConfigured()) {
    let authUser;
    try { authUser = await supabaseAuthBridge.verifyPassword(email, password); }
    catch (error) {
      log('warn', 'Supabase Auth sign-in verification failed', { userId: rows[0].id, code: error.code || 'AUTH_PROVIDER_ERROR' });
      return fail(res, 503, 'Sign-in could not be verified right now. Please try again.');
    }
    if (!authUser || authUser.id !== rows[0].supabase_user_id) return fail(res, 401, 'Email or password is incorrect.');
    if (!localPasswordValid) {
      const hash = await bcrypt.hash(password, 12);
      await pool.query('UPDATE users SET password_hash=$1 WHERE id=$2', [hash, rows[0].id]);
    }
  } else if (!localPasswordValid && supabaseAuthBridge.isPublicConfigured()) {
    let authUser;
    try { authUser = await supabaseAuthBridge.verifyPassword(email, password); }
    catch (error) {
      log('warn', 'Supabase Auth recovery sign-in verification failed', { userId: rows[0].id, code: error.code || 'AUTH_PROVIDER_ERROR' });
      return fail(res, 503, 'Sign-in could not be verified right now. Please try again.');
    }
    if (!authUser) return fail(res, 401, 'Email or password is incorrect.');
    const hash = await bcrypt.hash(password, 12);
    const linked = await pool.query('UPDATE users SET password_hash=$1,supabase_user_id=$2 WHERE id=$3 AND (supabase_user_id IS NULL OR supabase_user_id=$2)', [hash, authUser.id, rows[0].id]);
    if (!linked.rowCount) return fail(res, 409, 'This sign-in could not be linked to your Signal Desk account. Please contact support.');
    rows[0].supabase_user_id = authUser.id;
    rows[0].password_hash = hash;
  } else if (!localPasswordValid) return fail(res, 401, 'Email or password is incorrect.');
  if (!rows[0].supabase_user_id) {
    try {
      const linkedId = await supabaseAuthBridge.ensureLegacyLoginIdentity({ email, password, name: rows[0].name });
      if (linkedId) {
        await pool.query('UPDATE users SET supabase_user_id=$1 WHERE id=$2 AND supabase_user_id IS NULL', [linkedId, rows[0].id]);
        rows[0].supabase_user_id = linkedId;
      }
    } catch (error) {
      log('warn', 'Legacy account Auth bridge deferred', { userId: rows[0].id, code: error.code || 'AUTH_PROVIDER_ERROR' });
    }
  }
  if (rows[0].is_suspended === true) {
    log('warn', 'Suspended account sign-in blocked', { userId: rows[0].id });
    return res.status(403).json({
      error: 'This account is suspended. Contact the workspace administrator if you believe this is a mistake.',
      suspensionReason: String(rows[0].suspension_reason || '').slice(0, 200) || null,
    });
  }
  // Signing in also keeps the workspace's MetaAPI accounts, so activity is recorded here.
  await pool.query('UPDATE users SET last_login=NOW(),last_active_at=NOW() WHERE id=$1', [rows[0].id]);
  const user = publicUser(rows[0]);
  res.json({ token: issueToken(user, req.body.rememberMe === true), user });
}));
app.post('/api/auth/prepare-password-reset', passwordResetLimiter, asyncRoute(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  if (!/^\S+@\S+\.\S+$/.test(email)) return res.json({ ok: true });
  if (!supabaseAuthBridge.isAdminConfigured()) return fail(res, 503, 'Password recovery is temporarily unavailable. Please try again later.');
  const { rows } = await pool.query('SELECT id,name,email,supabase_user_id FROM users WHERE email=$1 LIMIT 1', [email]);
  if (rows[0]) {
    try {
      const prepared = await supabaseAuthBridge.prepareRecoveryIdentity({ email, name: rows[0].name, currentId: rows[0].supabase_user_id });
      if (prepared.created && prepared.linkable) await pool.query('UPDATE users SET supabase_user_id=$1 WHERE id=$2 AND (supabase_user_id IS NULL OR supabase_user_id=$3)', [prepared.id, rows[0].id, rows[0].supabase_user_id]);
    } catch (error) {
      // Keep the response identical for known and unknown emails to avoid account enumeration.
      log('warn', 'Password recovery identity preparation failed', { code: error.code || 'AUTH_PROVIDER_ERROR' });
    }
  }
  res.json({ ok: true });
}));
app.post('/api/auth/sync-password', asyncRoute(async (req, res) => {
  const accessToken = req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  const password = String(req.body.password || '');
  if (!accessToken) return fail(res, 401, 'The password reset session is invalid or expired. Request a new reset link.');
  if (password.length < 10) return fail(res, 400, 'Use at least 10 characters for your new password.');
  const authUser = await supabaseAuthBridge.getUserFromAccessToken(accessToken);
  const email = String(authUser?.email || '').trim().toLowerCase();
  if (!authUser?.id || !email) return fail(res, 401, 'The password reset session is invalid or expired. Request a new reset link.');
  const { rows } = await pool.query('SELECT id,supabase_user_id FROM users WHERE email=$1 LIMIT 1', [email]);
  const localUser = rows[0];
  if (!localUser || (localUser.supabase_user_id && localUser.supabase_user_id !== authUser.id)) return fail(res, 404, 'We could not match this reset session to a Signal Desk account.');
  const hash = await bcrypt.hash(password, 12);
  const updated = await pool.query('UPDATE users SET password_hash=$1,supabase_user_id=$2 WHERE id=$3 AND (supabase_user_id IS NULL OR supabase_user_id=$2)', [hash, authUser.id, localUser.id]);
  if (!updated.rowCount) return fail(res, 409, 'This password reset session is no longer linked to your account. Request a new link.');
  res.json({ ok: true });
}));
app.delete('/api/auth/account', authenticate, asyncRoute(async (req, res) => {
  if (String(req.body.confirmation || '').trim() !== 'DELETE') return fail(res, 400, 'Type DELETE to confirm account removal.');
  const password = String(req.body.password || '');
  if (!password) return fail(res, 400, 'Enter your current password to confirm account removal.');
  const { rows } = await pool.query('SELECT id,email,password_hash,supabase_user_id FROM users WHERE id=$1 LIMIT 1', [req.userId]);
  const user = rows[0];
  if (!user) return fail(res, 404, 'This Signal Desk account no longer exists.');
  let passwordValid = false;
  if (user.supabase_user_id && supabaseAuthBridge.isPublicConfigured()) {
    try {
      const verified = await supabaseAuthBridge.verifyPassword(user.email, password);
      if (verified?.id === user.supabase_user_id) {
        passwordValid = true;
        const hash = await bcrypt.hash(password, 12);
        await pool.query('UPDATE users SET password_hash=$1 WHERE id=$2', [hash, user.id]);
      } else {
        const linkedAuthUser = await supabaseAuthBridge.findUserById(user.supabase_user_id);
        passwordValid = !linkedAuthUser && await bcrypt.compare(password, user.password_hash);
      }
    } catch (error) {
      log('warn', 'Account deletion password verification unavailable', { userId: user.id, code: error.code || 'AUTH_PROVIDER_ERROR' });
      return fail(res, 503, 'We could not verify your password right now. Please try again.');
    }
  } else passwordValid = await bcrypt.compare(password, user.password_hash);
  if (!passwordValid) return fail(res, 401, 'Your current password is incorrect.');
  await pool.query('UPDATE settings SET auto_trading_enabled=FALSE WHERE user_id=$1', [user.id]);

  if (user.supabase_user_id) {
    try { await supabaseAuthBridge.deleteAuthUser(user.supabase_user_id); }
    catch (error) {
      log('error', 'Supabase Auth account deletion failed', { userId: user.id, code: error.code || 'AUTH_PROVIDER_ERROR' });
      return fail(res, 503, 'We could not complete account deletion. No Signal Desk data was removed. Please try again later.');
    }
  } else {
    if (!supabaseAuthBridge.isAdminConfigured()) return fail(res, 503, 'Account deletion is temporarily unavailable. Please try again later.');
    try {
      const existingAuthUser = await supabaseAuthBridge.findUserByEmail(user.email);
      if (existingAuthUser) return fail(res, 409, 'Verify your email with the Forgot Password link before deleting this account.');
    } catch (error) {
      log('error', 'Supabase Auth account ownership lookup failed', { userId: user.id, code: error.code || 'AUTH_PROVIDER_ERROR' });
      return fail(res, 503, 'We could not verify account ownership. No Signal Desk data was removed. Please try again later.');
    }
  }

  // Stop MetaAPI billing for trading accounts this workspace provisioned. This runs
  // after the Auth identity is gone (so a failed Auth deletion leaves everything
  // intact) and before the local rows are removed (so we still know the account IDs).
  // Provider failures are logged and reported, but they never block deletion.
  let metaApiCleanup = { total: 0, attempted: 0, deleted: 0, alreadyMissing: 0, failed: 0, skipped: 0, failures: [] };
  try {
    const { rows: providerAccounts } = await pool.query(
      'SELECT metaapi_account_id,managed_by_app FROM metaapi_accounts WHERE user_id=$1 AND managed_by_app=TRUE',
      [user.id],
    );
    metaApiCleanup = await accountCleanup.removeProviderAccounts({
      accounts: providerAccounts,
      resolveToken: () => getMetaApiProvisioningToken(),
    });
    if (metaApiCleanup.failed) log('warn', 'MetaAPI account deletion finished with failures', { userId: user.id, failed: metaApiCleanup.failed });
  } catch (error) {
    log('warn', 'MetaAPI account cleanup could not run during account deletion', { userId: user.id, code: error.code || 'METAAPI_CLEANUP_FAILED' });
  }

  const dbClient = await pool.connect();
  try {
    await dbClient.query('BEGIN');
    const deleted = await dbClient.query('DELETE FROM users WHERE id=$1', [user.id]);
    if (!deleted.rowCount) { await dbClient.query('ROLLBACK'); return fail(res, 404, 'This Signal Desk account no longer exists.'); }
    await dbClient.query('COMMIT');
  } catch (error) {
    await dbClient.query('ROLLBACK').catch(() => {});
    log('error', 'Local account data cleanup failed after Auth deletion', { userId: user.id, code: error.code || 'DATABASE_ERROR' });
    return fail(res, 503, 'Your Auth account was removed, but workspace cleanup could not finish. Please retry account deletion to finish cleanup.');
  } finally { dbClient.release(); }

  for (const map of [telegramClients, telegramLogins]) {
    const entry = map.get(user.id);
    if (entry?.client) await telegramAdapter.disconnect(entry.client).catch(() => {});
    map.delete(user.id);
  }
  io.in(`user:${user.id}`).disconnectSockets(true);
  log('info', 'Account deleted', { userId: user.id, metaApiDeleted: metaApiCleanup.deleted, metaApiFailed: metaApiCleanup.failed });
  res.json({ ok: true, metaApiCleanup });
}));
app.get('/api/auth/me', authenticate, asyncRoute(async (req, res) => {
  const { rows } = await pool.query('SELECT id,name,email,role,created_at FROM users WHERE id=$1', [req.userId]);
  if (!rows[0]) return fail(res, 404, 'User not found.');
  res.json({ user: publicUser(rows[0]) });
}));

app.get('/api/dashboard', authenticate, asyncRoute(async (req, res) => {
  /*
   * Two lists rather than one filtered query, because the Overview either shows setups or says it could not:
   * both statements are bounded and complete, they are read in the same round-trip fan-out as the counts
   * beside them, and `readDashboardSignals` makes the call. The full history belongs to the Signals tab,
   * which is why this route is allowed to be short - and the strip arrives already re-decided against this
   * workspace's live settings, because that read is part of the service and not a step this route can skip.
   */
  const [signalsCount, channelsCount, accountsCount, dashboardSignals, settings, subscription] = await Promise.all([
    pool.query('SELECT COUNT(*)::int AS count FROM signals WHERE user_id=$1', [req.userId]),
    pool.query('SELECT COUNT(*)::int AS count FROM channels WHERE user_id=$1 AND enabled=TRUE', [req.userId]),
    pool.query('SELECT COUNT(*)::int AS count FROM accounts WHERE user_id=$1', [req.userId]),
    readDashboardSignals({ pool, userId: req.userId, withLiveBlockers }),
    pool.query('SELECT risk_mode AS "riskMode",risk_percent AS "riskPercent",max_open_positions AS "maxOpenPositions",daily_loss_limit AS "dailyLossLimit",auto_trading_enabled AS "autoTradingEnabled" FROM settings WHERE user_id=$1', [req.userId]),
    // The plan is part of the execution picture, not a billing detail: `Auto-Trading is on, but your plan does
    // not include automatic execution` is a sentence about the switch, and the banner cannot say it without it.
    pool.query('SELECT subscription_status AS status,subscription_plan AS plan FROM users WHERE id=$1', [req.userId]),
  ]);
  res.set('Cache-Control', 'no-store').json({
    stats: { totalSignals: signalsCount.rows[0].count, activeChannels: channelsCount.rows[0].count, accounts: accountsCount.rows[0].count },
    signals: dashboardSignals.rows,
    signalsScope: dashboardSignals.scope,
    // The two keys that let the panel say "and here is why the newest message is not one of these" instead of
    // leaving a filtered list of three to look like a feed that stopped. They come from the service, so the
    // route cannot report a number it did not read.
    signalsNewerCaptures: dashboardSignals.newerCaptures,
    signalsLastCaptureAt: dashboardSignals.lastCaptureAt,
    settings: settings.rows[0] || { riskMode: 'fixed', riskPercent: 1, maxOpenPositions: 5, dailyLossLimit: 5, autoTradingEnabled: false },
    subscription: { status: subscription.rows[0]?.status || null, plan: subscription.rows[0]?.plan || null },
    trading: { liveExecutionEnabled: autoTradingRuntimeEnabled, autoTradingEnabled: settings.rows[0]?.autoTradingEnabled === true, message: autoTradingRuntimeEnabled ? 'Auto-Trading starts on for new workspaces; review the live-trading warning and turn it off in Advanced Settings whenever you want.' : 'Automatic execution is unavailable right now. Signals can still be reviewed.' },
  });
}));

app.get('/api/channels', authenticate, asyncRoute(async (req, res) => {
  const { rows } = await pool.query('SELECT id,channel_id AS "channelId",title,username,enabled,created_at AS "createdAt" FROM channels WHERE user_id=$1 ORDER BY created_at DESC', [req.userId]);
  res.set('Cache-Control', 'no-store').json({ channels: rows });
}));
app.post('/api/channels', authenticate, asyncRoute(async (req, res) => {
  const channelId = String(req.body.channelId || '').trim();
  const title = String(req.body.title || '').trim().slice(0, 160);
  const username = String(req.body.username || '').trim().slice(0, 100) || null;
  if (!channelId || !title) return fail(res, 400, 'Channel ID and title are required.');
  await enforcePlanLimit(req.userId, 'maxTelegramChannels', 'SELECT COUNT(*)::int AS count FROM channels WHERE user_id=$1');
  const { rows } = await pool.query(
    `INSERT INTO channels(user_id,channel_id,title,username) VALUES($1,$2,$3,$4)
     ON CONFLICT(user_id,channel_id) DO UPDATE SET title=EXCLUDED.title,username=EXCLUDED.username,enabled=TRUE
     RETURNING id,channel_id AS "channelId",title,username,enabled,created_at AS "createdAt"`,
    [req.userId, channelId, title, username],
  );
  /*
   * Choosing a channel to monitor is the moment a workspace expects capture to begin, so it is also
   * the moment a session that is not in memory is brought back - waiting for the next status poll was
   * how "I switched Monitor on and nothing ever arrived" stayed true.
   */
  const held = telegramClients.get(req.userId)?.client;
  if (held?.connected === true) await startTelegramListener(req.userId, held);
  else await restoreTelegramClient(req.userId, { reason: 'channel-monitored' })
    .catch((error) => log('warn', 'Telegram session restore deferred after a channel was added', { userId: req.userId, error: error.message }));
  res.status(201).json({ channel: rows[0] });
}));
app.delete('/api/channels/:id', authenticate, asyncRoute(async (req, res) => {
  const result = await pool.query('DELETE FROM channels WHERE id=$1 AND user_id=$2', [req.params.id, req.userId]);
  if (!result.rowCount) return fail(res, 404, 'Channel not found.');
  res.json({ ok: true });
}));

app.get('/api/signals', authenticate, asyncRoute(async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);
  const { rows } = await pool.query(`SELECT id,channel_title AS "channelTitle",source,message,symbol,side,entry_price AS "entryPrice",stop_loss AS "stopLoss",take_profit AS "takeProfit",direction_inferred AS "directionInferred",execution_ready AS "executionReady",parse_error AS "parseError",execution_note AS "executionNote",take_profit_levels AS "takeProfitLevels",parsed_by AS "parsedBy",parse_confidence AS "parseConfidence",llm_used AS "llmUsed",stop_loss_pips AS "stopLossPips",take_profit_pips AS "takeProfitPips",needs_review AS "needsReview",order_type AS "orderType",order_type_stated AS "orderTypeStated",is_scalping AS "isScalping",entry_range AS "entryRange",status,created_at AS "createdAt" FROM signals WHERE user_id=$1 ORDER BY created_at DESC LIMIT $2`, [req.userId, limit]);
  // A row carries the sentence its workspace is in *now*, so the list can never contradict the banner above
  // it. See `withLiveBlockers`: when the live picture cannot be read, the stored sentences are shown as they
  // were written, because an unavailable setting is not a reason to invent one.
  const signals = await withLiveBlockers(req.userId, rows);
  res.set('Cache-Control', 'no-store').json({ signals });
}));
app.post('/api/signals', authenticate, asyncRoute(async (req, res) => {
  const message = String(req.body.message || '').trim().slice(0, 5000);
  if (!message) return fail(res, 400, 'Enter a signal message.');
  const signal = await saveSignal(req.userId, message, { source: 'manual', title: 'Manual entry' });
  res.status(201).json({ signal });
}));

/* ------------------------------------------------------------------ signal history deletion
   *
   * A captured signal is the message the workspace read; a trade is what it did with that message.
   * Only the first of those is deletable here, and the unlink runs in the same transaction as the
   * delete, so a signal can never vanish while an order still points at it - and an order can never
   * lose its profit and loss because somebody cleared their list. `execution_jobs` is on
   * ON DELETE CASCADE, so a queued-but-unsent job for a cleared signal disappears with it, which is
   * the only correct reading of "I do not want that signal".
   */
app.delete('/api/signals/:id', authenticate, asyncRoute(async (req, res) => {
  const signalId = String(req.params.id || '').trim();
  if (!UUID_PATTERN.test(signalId)) return fail(res, 400, 'Choose a signal to remove.');
  const pair = buildSignalOwnershipDelete({ userId: req.userId, signalId });
  const result = await runSignalDelete(pair);
  if (!result.deleted) return fail(res, 404, 'That signal is not in your history.');
  res.json({ deleted: result.deleted, unlinkedTrades: result.unlinked });
}));

app.delete('/api/signals', authenticate, asyncRoute(async (req, res) => {
  const pair = buildSignalsPurgeForUser({ userId: req.userId });
  const result = await runSignalDelete(pair);
  log('info', 'Signal history cleared', { userId: req.userId, deleted: result.deleted, unlinkedTrades: result.unlinked });
  res.json({ deleted: result.deleted, unlinkedTrades: result.unlinked });
}));

app.get('/api/accounts', authenticate, asyncRoute(async (req, res) => {
  const { rows } = await pool.query('SELECT id,label,broker,platform,account_reference AS "accountReference",created_at AS "createdAt" FROM accounts WHERE user_id=$1 ORDER BY created_at DESC', [req.userId]);
  res.set('Cache-Control', 'no-store').json({ accounts: rows });
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
    `SELECT ma.id,ma.metaapi_account_id AS "metaApiAccountId",ma.login,ma.name,ma.platform,ma.state,ma.server,
       ma.managed_by_app AS "managedByApp",ma.created_at AS "createdAt",
       ma.inactivity_status AS "inactivityStatus",ma.inactivity_reason AS "inactivityReason",
       ma.execution_note AS "executionNote",ma.execution_note_at AS "executionNoteAt",
       COALESCE(u.last_active_at,u.last_login,u.created_at) AS "lastActiveAt"
     FROM metaapi_accounts ma JOIN users u ON u.id=ma.user_id
     WHERE ma.user_id=$1 ORDER BY ma.created_at DESC`,
    [req.userId],
  );
  const activity = await inactivityService.statusFor(req.userId);
  res.set('Cache-Control', 'no-store').json({
    accounts: rows.map((account) => ({
      ...account,
      daysInactive: account.managedByApp ? daysInactiveSince(account.lastActiveAt) : null,
    })),
    inactivity: {
      warningDays: activity.warningDays,
      deletionDays: activity.deletionDays,
      lastActiveAt: activity.lastActiveAt,
      daysInactive: activity.daysInactive,
      exempt: activity.exempt,
      notices: activity.notices,
    },
  });
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
  await enforcePlanLimit(req.userId, 'maxTradingAccounts', 'SELECT COUNT(*)::int AS count FROM metaapi_accounts WHERE user_id=$1');

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
  const accountId = String(req.params.accountId || '').trim();
  const { rows } = await pool.query(
    'SELECT metaapi_account_id,managed_by_app FROM metaapi_accounts WHERE user_id=$1 AND metaapi_account_id=$2 LIMIT 1',
    [req.userId, accountId],
  );
  const account = rows[0];
  if (!account) return fail(res, 404, 'Linked MetaAPI account not found.');

  // Unlinking also stops provider billing: delete the account from MetaAPI itself,
  // using the same cleanup path as full account deletion. A provider failure is
  // logged and reported but never blocks the local unlink.
  let metaApiCleanup = { total: 1, attempted: 0, deleted: 0, alreadyMissing: 0, failed: 0, skipped: 0, failures: [] };
  try {
    metaApiCleanup = await accountCleanup.removeProviderAccounts({
      accounts: [account],
      resolveToken: () => getMetaApiProvisioningToken(),
    });
    if (metaApiCleanup.failed) log('warn', 'MetaAPI account deletion failed during unlink', { userId: req.userId, accountId });
  } catch (error) {
    log('warn', 'MetaAPI account cleanup could not run during unlink', { userId: req.userId, accountId, code: error.code || 'METAAPI_CLEANUP_FAILED' });
  }

  await pool.query('UPDATE settings SET auto_trading_enabled=FALSE,execution_account_id=NULL,updated_at=NOW() WHERE user_id=$1 AND execution_account_id=$2', [req.userId, accountId]);
  const result = await pool.query('DELETE FROM metaapi_accounts WHERE user_id=$1 AND metaapi_account_id=$2', [req.userId, accountId]);
  if (!result.rowCount) return fail(res, 404, 'Linked MetaAPI account not found.');
  log('info', 'Trading account unlinked', { userId: req.userId, accountId, metaApiDeleted: metaApiCleanup.deleted, metaApiFailed: metaApiCleanup.failed });
  res.json({ ok: true, metaApiCleanup });
}));

app.get('/api/settings', authenticate, asyncRoute(async (req, res) => {
  const { rows } = await pool.query('SELECT risk_mode AS "riskMode",risk_percent AS "riskPercent",max_open_positions AS "maxOpenPositions",daily_loss_limit AS "dailyLossLimit",auto_trading_enabled AS "autoTradingEnabled",lot_size_mode AS "lotSizeMode",fixed_lot_size AS "fixedLotSize",max_daily_trades AS "maxDailyTrades",execution_account_id AS "executionAccountId",break_even_enabled AS "breakEvenEnabled",break_even_trigger_points AS "breakEvenTriggerPoints",break_even_offset_points AS "breakEvenOffsetPoints",trailing_stop_enabled AS "trailingStopEnabled",trailing_stop_distance_points AS "trailingStopDistancePoints",has_accepted_risk_warning AS "hasAcceptedRiskWarning",block_execution_without_stop_loss AS "blockExecutionWithoutStopLoss",block_execution_without_take_profit AS "blockExecutionWithoutTakeProfit",fallback_stop_loss_points AS "fallbackStopLossPoints",fallback_take_profit_points AS "fallbackTakeProfitPoints",multiple_target_handling AS "multipleTargetHandling",limit_order_expiry_value AS "limitOrderExpiryValue",limit_order_expiry_unit AS "limitOrderExpiryUnit",max_slippage_points AS "maxSlippagePoints" FROM settings WHERE user_id=$1', [req.userId]);
  res.set('Cache-Control', 'no-store').json({
    settings: { riskMode: 'fixed', riskPercent: 1, maxOpenPositions: 3, dailyLossLimit: 5, autoTradingEnabled: false, lotSizeMode: 'fixed', fixedLotSize: 0.01, maxDailyTrades: 10, executionAccountId: '', breakEvenEnabled: false, breakEvenTriggerPoints: 20, breakEvenOffsetPoints: 0, trailingStopEnabled: false, trailingStopDistancePoints: 10, hasAcceptedRiskWarning: false, blockExecutionWithoutStopLoss: true, blockExecutionWithoutTakeProfit: true, fallbackStopLossPoints: null, fallbackTakeProfitPoints: null, multipleTargetHandling: 'first_target', limitOrderExpiryValue: 30, limitOrderExpiryUnit: 'minutes', maxSlippagePoints: null, ...(rows[0] || {}) },
    runtimeEnabled: autoTradingRuntimeEnabled,
    // The user's own toggle being on is not the same as orders being possible: if the platform
    // switch is engaged, say so here instead of letting the panel imply their setting is at fault.
    executionPaused: await platformControls.read().then((state) => ({ paused: state.state !== 'live', state: state.state, reason: state.reason })),
  });
}));
app.put('/api/settings', authenticate, asyncRoute(async (req, res) => {
  let hasAcceptedRiskWarning = req.body.hasAcceptedRiskWarning === true;
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
  const breakEvenEnabled = req.body.breakEvenEnabled === true;
  const breakEvenTriggerPoints = Math.trunc(numeric(req.body.breakEvenTriggerPoints, 20));
  const breakEvenOffsetPoints = Math.trunc(numeric(req.body.breakEvenOffsetPoints, 0));
  const trailingStopEnabled = req.body.trailingStopEnabled === true;
  const trailingStopDistancePoints = Math.trunc(numeric(req.body.trailingStopDistancePoints, 10));
  // Absent means ON: a client that does not know about the switch cannot silently widen what the
  // workspace is willing to send to a broker without a stop.
  const blockExecutionWithoutStopLoss = req.body.blockExecutionWithoutStopLoss !== false;
  const blockExecutionWithoutTakeProfit = req.body.blockExecutionWithoutTakeProfit !== false;
  /* A fallback is either a usable whole number of points or no net at all. It is never clamped: the
     difference between 0, 5 and 500000 points is the difference between no stop and a wrong one. */
  /* Absent means the behaviour every workspace already had - exit at the first target - so a client that
     predates this setting cannot widen what gets traded by not knowing about it. A value that is present
     but not one of the three is refused rather than guessed at, because the difference between the three
     is how much of a trade stays open. */
  /* How long a resting order stays on the broker's book, and how far from the published price a market
     order is still allowed to fill. Both are validated by the same functions the engine reads its values
     through, so the number the panel saves is the number an order is built with. */
  const expiry = readExpirySetting({ value: req.body.limitOrderExpiryValue, unit: req.body.limitOrderExpiryUnit });
  if (expiry.error) return fail(res, 400, expiry.error);
  const maxSlippagePoints = readSlippageSetting(req.body.maxSlippagePoints);
  if (maxSlippagePoints.error) return fail(res, 400, maxSlippagePoints.error);
  const requestedTargetMode = req.body.multipleTargetHandling;
  const multipleTargetHandling = requestedTargetMode === undefined || requestedTargetMode === null || requestedTargetMode === ''
    ? 'first_target'
    : (TARGET_MODES.includes(requestedTargetMode) ? requestedTargetMode : null);
  if (!multipleTargetHandling) return fail(res, 400, 'Choose how a signal with several targets should be handled.');
  const fallbackStopLoss = readFallbackPoints(req.body.fallbackStopLossPoints, 'The fallback stop-loss distance');
  const fallbackTakeProfit = readFallbackPoints(req.body.fallbackTakeProfitPoints, 'The fallback take-profit distance');
  if (fallbackStopLoss.error || fallbackTakeProfit.error) return fail(res, 400, fallbackStopLoss.error || fallbackTakeProfit.error);
  if (!lotSizeMode) return fail(res, 400, 'Choose a valid lot size mode.');
  if (!Number.isFinite(riskPercent) || riskPercent < 0.1 || riskPercent > 5) return fail(res, 400, 'Risk percent must be between 0.1 and 5.');
  if (!Number.isInteger(maxOpenPositions) || maxOpenPositions < 1 || maxOpenPositions > 50) return fail(res, 400, 'Maximum open trades must be between 1 and 50.');
  if (!Number.isFinite(dailyLossLimit) || dailyLossLimit < 0.1 || dailyLossLimit > 25) return fail(res, 400, 'Daily loss limit must be between 0.1% and 25%.');
  if (!Number.isInteger(maxDailyTrades) || maxDailyTrades < 1 || maxDailyTrades > 100) return fail(res, 400, 'Maximum daily trades must be between 1 and 100.');
  if (!Number.isFinite(fixedLotSize) || fixedLotSize < 0.01 || fixedLotSize > 100) return fail(res, 400, 'Fixed lot size must be between 0.01 and 100.');
  if (autoTradingEnabled && !autoTradingRuntimeEnabled) return fail(res, 409, 'Auto-Trading is not available on this service right now.');
  if (!Number.isInteger(breakEvenTriggerPoints) || breakEvenTriggerPoints < 1 || breakEvenTriggerPoints > 100_000) return fail(res, 400, 'The break-even trigger must be between 1 and 100000 points.');
  if (!Number.isInteger(breakEvenOffsetPoints) || breakEvenOffsetPoints < 0 || breakEvenOffsetPoints > 10_000) return fail(res, 400, 'The break-even offset must be between 0 and 10000 points.');
  if (breakEvenEnabled && !autoTradingRuntimeEnabled) return fail(res, 409, 'Break-even stop moves need the execution runtime, which is unavailable on this service right now.');
  // A trail is the stricter request of the two: it writes to the broker repeatedly, so a
  // distance that is missing or absurd is rejected instead of clamped into something real.
  if (!Number.isInteger(trailingStopDistancePoints) || trailingStopDistancePoints < 1 || trailingStopDistancePoints > 100_000) return fail(res, 400, 'The trailing distance must be between 1 and 100000 points.');
  if (trailingStopEnabled && !autoTradingRuntimeEnabled) return fail(res, 409, 'Trailing stop moves need the execution runtime, which is unavailable on this service right now.');
  // A scale-out plan is a broker write per target, so it needs the same runtime the stop moves need;
  // the other two modes only change which price the order carries and need nothing extra.
  if (multipleTargetHandling === 'scale_out' && !autoTradingRuntimeEnabled) return fail(res, 409, 'Scale-out closes need the execution runtime, which is unavailable on this service right now.');
  // The execution switches are not a paid feature. Free is review-only because the engine refuses
  // to send an order without a linked trading account and a paid plan, and that refusal happens per
  // signal where the user can read it - gating the switch here only turned a harmless preference into
  // a red banner and left the workspace unable to state its own intent.
  const acceptsRiskNow = req.body.hasAcceptedRiskWarning === true;
  if (autoTradingEnabled) {
    const { rows: ackRows } = await pool.query('SELECT has_accepted_risk_warning AS "hasAcceptedRiskWarning" FROM settings WHERE user_id=$1 LIMIT 1', [req.userId]);
    hasAcceptedRiskWarning = ackRows[0]?.hasAcceptedRiskWarning === true || acceptsRiskNow;
    if (hasAcceptedRiskWarning !== true) {
      return fail(res, 409, 'Confirm the live-trading warning before Auto-Trading is turned on. Nothing has been changed.');
    }
  }
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
  const { rows: previousRows } = await pool.query('SELECT auto_trading_enabled AS "autoTradingEnabled",execution_account_id AS "executionAccountId",has_accepted_risk_warning AS "hasAcceptedRiskWarning" FROM settings WHERE user_id=$1 LIMIT 1', [req.userId]);
  // The acknowledgement is sticky: saving any other part of the panel must never quietly revoke it.
  if (previousRows[0]?.hasAcceptedRiskWarning === true) hasAcceptedRiskWarning = true;
  const previous = previousRows[0] || {};
  if (autoTradingEnabled && executionAccountId && (!previous.autoTradingEnabled || previous.executionAccountId !== executionAccountId)) {
    try { await executionEngine.captureDailyBaseline(req.userId, executionAccountId); }
    catch { return fail(res, 409, 'A safe daily loss baseline could not be captured. Confirm the account is deployed and connected, then try again. Auto-Trading remains off.'); }
  }
  const { rows } = await pool.query(
    `INSERT INTO settings(user_id,risk_mode,risk_percent,max_open_positions,daily_loss_limit,auto_trading_enabled,lot_size_mode,fixed_lot_size,max_daily_trades,execution_account_id,break_even_enabled,break_even_trigger_points,break_even_offset_points,trailing_stop_enabled,trailing_stop_distance_points,has_accepted_risk_warning,block_execution_without_stop_loss,block_execution_without_take_profit,fallback_stop_loss_points,fallback_take_profit_points,multiple_target_handling,limit_order_expiry_value,limit_order_expiry_unit,max_slippage_points)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24) ON CONFLICT(user_id) DO UPDATE SET risk_mode=EXCLUDED.risk_mode,risk_percent=EXCLUDED.risk_percent,max_open_positions=EXCLUDED.max_open_positions,daily_loss_limit=EXCLUDED.daily_loss_limit,auto_trading_enabled=EXCLUDED.auto_trading_enabled,lot_size_mode=EXCLUDED.lot_size_mode,fixed_lot_size=EXCLUDED.fixed_lot_size,max_daily_trades=EXCLUDED.max_daily_trades,execution_account_id=EXCLUDED.execution_account_id,break_even_enabled=EXCLUDED.break_even_enabled,break_even_trigger_points=EXCLUDED.break_even_trigger_points,break_even_offset_points=EXCLUDED.break_even_offset_points,trailing_stop_enabled=EXCLUDED.trailing_stop_enabled,trailing_stop_distance_points=EXCLUDED.trailing_stop_distance_points,has_accepted_risk_warning=EXCLUDED.has_accepted_risk_warning,block_execution_without_stop_loss=EXCLUDED.block_execution_without_stop_loss,block_execution_without_take_profit=EXCLUDED.block_execution_without_take_profit,fallback_stop_loss_points=EXCLUDED.fallback_stop_loss_points,fallback_take_profit_points=EXCLUDED.fallback_take_profit_points,multiple_target_handling=EXCLUDED.multiple_target_handling,limit_order_expiry_value=EXCLUDED.limit_order_expiry_value,limit_order_expiry_unit=EXCLUDED.limit_order_expiry_unit,max_slippage_points=EXCLUDED.max_slippage_points,updated_at=NOW()
     RETURNING risk_mode AS "riskMode",risk_percent AS "riskPercent",max_open_positions AS "maxOpenPositions",daily_loss_limit AS "dailyLossLimit",auto_trading_enabled AS "autoTradingEnabled",lot_size_mode AS "lotSizeMode",fixed_lot_size AS "fixedLotSize",max_daily_trades AS "maxDailyTrades",execution_account_id AS "executionAccountId",break_even_enabled AS "breakEvenEnabled",break_even_trigger_points AS "breakEvenTriggerPoints",break_even_offset_points AS "breakEvenOffsetPoints",trailing_stop_enabled AS "trailingStopEnabled",trailing_stop_distance_points AS "trailingStopDistancePoints",has_accepted_risk_warning AS "hasAcceptedRiskWarning",block_execution_without_stop_loss AS "blockExecutionWithoutStopLoss",block_execution_without_take_profit AS "blockExecutionWithoutTakeProfit",fallback_stop_loss_points AS "fallbackStopLossPoints",fallback_take_profit_points AS "fallbackTakeProfitPoints",multiple_target_handling AS "multipleTargetHandling",limit_order_expiry_value AS "limitOrderExpiryValue",limit_order_expiry_unit AS "limitOrderExpiryUnit",max_slippage_points AS "maxSlippagePoints"`,
    [req.userId, riskMode, riskPercent, maxOpenPositions, dailyLossLimit, autoTradingEnabled, lotSizeMode, fixedLotSize, maxDailyTrades, executionAccountId || null, breakEvenEnabled, breakEvenTriggerPoints, breakEvenOffsetPoints, trailingStopEnabled, trailingStopDistancePoints, hasAcceptedRiskWarning === true, blockExecutionWithoutStopLoss, blockExecutionWithoutTakeProfit, fallbackStopLoss.value, fallbackTakeProfit.value, multipleTargetHandling, expiry.value, expiry.unit, maxSlippagePoints.value],
  );
  // Saving execution settings counts as activity for the inactivity policy.
  await inactivityService.touchQuietly(req.userId);
  res.set('Cache-Control', 'no-store').json({ settings: rows[0], runtimeEnabled: autoTradingRuntimeEnabled });
}));
app.get('/api/trades', authenticate, asyncRoute(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT t.id,t.signal_id AS "signalId",t.metaapi_account_id AS "metaApiAccountId",t.symbol,t.side,t.quantity,
            t.entry_price AS "entryPrice",t.stop_loss AS "stopLoss",t.take_profit AS "takeProfit",t.exit_price AS "exitPrice",
            t.pnl,t.status,t.remaining_volume AS "remainingVolume",
            t.order_type AS "orderType",t.expiry_timestamp AS "expiryTimestamp",t.drift_points AS "driftPoints",
            (SELECT json_agg(json_build_object(
                       'level', l.level_index, 'price', l.target_price, 'percent', l.close_percent,
                       'volume', l.planned_volume, 'closed', l.closed_volume, 'status', l.status,
                       'breakEven', l.break_even, 'breakEvenStatus', l.break_even_status,
                       'error', l.error_message, 'filledAt', l.filled_at) ORDER BY l.level_index)
             FROM trade_tp_levels l WHERE l.trade_id=t.id) AS "tpLevels",
            t.broker_order_id AS "brokerOrderId",t.broker_position_id AS "brokerPositionId",
            t.error_message AS "errorMessage",t.created_at AS "createdAt",t.executed_at AS "executedAt",
            bm.status AS "breakEvenStatus",bm.stop_loss AS "breakEvenStopLoss",bm.previous_stop_loss AS "breakEvenPreviousStopLoss",
            bm.updated_at AS "breakEvenAt",bm.error_message AS "breakEvenError",
            bm.move_count AS "breakEvenMoveCount",bm.trailing_distance_points AS "breakEvenTrailingDistancePoints"
     FROM trades t
     LEFT JOIN break_even_moves bm ON bm.user_id=t.user_id AND bm.metaapi_account_id=t.metaapi_account_id AND bm.broker_position_id=t.broker_position_id
     WHERE t.user_id=$1 ORDER BY t.created_at DESC LIMIT 50`,
    [req.userId],
  );
  res.set('Cache-Control', 'no-store').json({ trades: rows, liveExecutionEnabled: autoTradingRuntimeEnabled });
}));

/* -------------------------------- Billing --------------------------------
 * Flutterwave checkout, verification, and webhooks, in NGN and USD.
 *
 * Prices live in the plan definitions and the `plans` table and are never trusted from the browser: the server
 * recalculates the amount for the currency the visitor picked (including any promo code) before charging, and
 * only ever sends Flutterwave that number. The one thing the browser does choose is the currency, and it chooses
 * between two prices that both came from the database - so the worst a tampered request can do is ask to be
 * charged the dollar price while looking at the naira one, which is refused at verification because the stored
 * row says which currency it quoted.
 */
async function currentPlanLimits(userId) {
  const { rows } = await pool.query(
    'SELECT subscription_status,subscription_plan,plan_limits FROM users WHERE id=$1 LIMIT 1',
    [userId],
  );
  return planLimitsFor(rows[0] || {});
}

async function enforcePlanLimit(userId, limitKey, countSql) {
  const limits = await currentPlanLimits(userId);
  const limit = Number(limits[limitKey]);
  if (!Number.isFinite(limit)) return;
  const { rows } = await pool.query(countSql, [userId]);
  const current = Number(rows[0]?.count || 0);
  if (current >= limit) {
    const { rows: userRows } = await pool.query('SELECT subscription_plan FROM users WHERE id=$1 LIMIT 1', [userId]);
    throw buildLimitError({ limitKey, limit, planKey: userRows[0]?.subscription_plan || 'free' });
  }
}

app.get('/api/billing/plans', asyncRoute(async (_req, res) => {
  // Prices are read per request so a price saved in the admin panel is what the
  // visitor sees and pays, with no cache or stale build to wait for. Both currencies
  // go out in the same response, because the toggle on the billing page has to work
  // offline-ish (instantly, without a round trip) and a price that only exists after a
  // fetch is a price a visitor can be shown the wrong side of.
  const snapshot = await pricingStore.snapshot();
  res.set('Cache-Control', 'no-store').json({
    plans: publicPricing(snapshot),
    configured: flutterwaveConfig.configured,
    currency: snapshot.currency,
    supportedCurrencies: [...flutterwaveConfig.supportedCurrencies],
    interval: snapshot.interval,
    recurringEnabled: snapshot.recurringEnabled,
  });
}));

app.get('/api/billing/subscription', authenticate, asyncRoute(async (req, res) => {
  const data = await billingService.subscriptionFor(req.userId);
  const limits = await currentPlanLimits(req.userId);
  res.set('Cache-Control', 'no-store').json({ ...data, limits });
}));

app.get('/api/billing/quote', authenticate, billingLimiter, asyncRoute(async (req, res) => {
  const quote = await billingService.quote({ planKey: req.query.plan, promoCode: req.query.code, currency: req.query.currency });
  res.set('Cache-Control', 'no-store').json({ quote });
}));

app.post('/api/billing/checkout', authenticate, billingLimiter, asyncRoute(async (req, res) => {
  /* The currency is validated at this edge rather than defaulted deep inside the service: an unsupported code
     is a bug in the caller or an attempt to be charged something else, and both deserve a 400 that names it. */
  const requested = req.body?.currency === undefined || req.body?.currency === null || req.body?.currency === ''
    ? normalizeCurrency(flutterwaveConfig.currency)
    : String(req.body.currency).trim().toUpperCase();
  if (!isSupportedCurrency(requested)) {
    return fail(res, 400, `Choose ${flutterwaveConfig.supportedCurrencies.join(' or ')} as the currency to pay in.`);
  }
  const checkout = await billingService.initialize({
    userId: req.userId,
    planKey: req.body?.plan,
    promoCode: req.body?.promoCode,
    currency: requested,
  });
  res.set('Cache-Control', 'no-store').json({ checkout });
}));

app.get('/api/billing/verify', authenticate, billingLimiter, asyncRoute(async (req, res) => {
  const reference = normalizeReference(req.query.reference);
  if (!reference) return fail(res, 400, 'That payment reference is not valid.');
  const result = await billingService.verifyAndFulfill({ userId: req.userId, reference });
  res.set('Cache-Control', 'no-store').json(result);
}));

app.post('/api/billing/cancel', authenticate, billingLimiter, asyncRoute(async (req, res) => {
  const subscription = await billingService.cancel({ userId: req.userId });
  res.set('Cache-Control', 'no-store').json({ subscription });
}));

app.post('/api/billing/resume', authenticate, billingLimiter, asyncRoute(async (req, res) => {
  const subscription = await billingService.resume({ userId: req.userId });
  res.set('Cache-Control', 'no-store').json({ subscription });
}));

/* Flutterwave posts here. Its documented check is a `verif-hash` header equal to the secret hash configured in
   the dashboard - there is no body signature to recompute - so the header is compared first, in constant time,
   and nothing else in the request is read until it matches. A missing FLW_WEBHOOK_HASH refuses every request:
   a workspace that has not finished configuring must not be able to hand out plans to whoever knocks.
   Flutterwave requires a 200 and does not read the body, so a webhook that was understood-but-ignored answers
   200 too (otherwise the provider retries for an hour over an event we have deliberately dropped), while a
   refused or unreadable request answers 401/400 because those are not us acknowledging anything. */
app.post('/api/billing/webhook', webhookLimiter, asyncRoute(async (req, res) => {
  const header = req.headers['verif-hash'];
  if (!flutterwaveConfig.webhookHash) {
    log('error', 'Flutterwave webhook received but FLW_WEBHOOK_HASH is not configured');
    return res.status(503).json({ error: 'Payments are not configured.' });
  }
  if (!verifyWebhookHash({ header, expectedHash: flutterwaveConfig.webhookHash })) {
    log('warn', 'Flutterwave webhook hash rejected', { hasHeader: Boolean(header) });
    return res.status(401).json({ error: 'Invalid webhook hash.' });
  }
  let event;
  try { event = JSON.parse(req.rawBody.toString('utf8')); }
  catch {
    log('warn', 'Flutterwave webhook body was not valid JSON');
    return res.status(400).json({ error: 'Invalid payload.' });
  }
  const result = await billingService.handleWebhookEvent(event);
  log('info', 'Flutterwave webhook processed', { event: result.event, handled: result.handled, reason: result.reason });
  res.json({ received: true, result });
}));

/* --------------------------------- Admin ---------------------------------
 * Every route below is authenticated and re-checks the caller's current role in
 * the database on each request, so a stale token cannot keep admin access after
 * the role is removed.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/*
 * The columns the admin panel is allowed to see about an account, in one list because the list is read by the
 * user table, the user detail, the impersonation hand-off and the row it just refreshed - and a column that
 * exists in one of those and not the others is how a panel ends up rendering `undefined` as a fact.
 *
 * `telegramConnected` and `monitorCount` are here for the same reason they are on the row at all: the panel offers
 * a manual Telegram reconnect, and a button that can only fail on an account that never linked Telegram is worse
 * than no button, while a missing button on an account with three monitored channels is the reason somebody ends
 * up reading logs at 2am. A linked session watching no channel is a different problem from a linked session that
 * has stopped hearing, and the count is what tells them apart before the click. Every camelCase alias here is
 * quoted: Postgres folds an unquoted one to lowercase, the property arrives `undefined`, and the client then
 * states something false with a straight face - which is exactly how "Auto-Trading is off" once appeared on every
 * row in the table.
 */
const adminUserColumns = `u.id,u.name,u.email,u.role,u.subscription_status AS "subscriptionStatus",
  u.subscription_plan AS "subscriptionPlan",u.is_suspended AS "isSuspended",
  u.suspension_reason AS "suspensionReason",u.created_at AS "createdAt",u.last_login AS "lastLogin",
  u.last_active_at AS "lastActiveAt",
  (u.supabase_user_id IS NOT NULL) AS "authLinked",
  u.telegram_connected AS "telegramConnected",
  (SELECT COUNT(*)::int FROM channels c WHERE c.user_id=u.id AND c.enabled=TRUE) AS "monitorCount",

  (SELECT COUNT(*)::int FROM signals s WHERE s.user_id=u.id) AS "signalCount",
  (SELECT s.current_period_end FROM subscriptions s WHERE s.user_id=u.id) AS "periodEnd",
  (SELECT s.status FROM subscriptions s WHERE s.user_id=u.id) AS "subscriptionRowStatus",
  (SELECT s.provider_subscription_code FROM subscriptions s WHERE s.user_id=u.id) IS NOT NULL AS "hasProviderSubscription"`;
const promoCodeColumns = `id,code,discount_type AS "discountType",discount_value AS "discountValue",
  max_uses AS "maxUses",current_uses AS "currentUses",expires_at AS "expiresAt",active,
  created_at AS "createdAt",updated_at AS "updatedAt"`;

app.get('/api/admin/overview', authenticate, requireAdmin, asyncRoute(async (_req, res) => {
  const { rows } = await pool.query(`SELECT
    (SELECT COUNT(*)::int FROM users) AS total_users,
    (SELECT COUNT(*)::int FROM users WHERE role='admin') AS admin_users,
    (SELECT COUNT(*)::int FROM users WHERE is_suspended=TRUE) AS suspended_users,
    (SELECT COUNT(*)::int FROM users WHERE created_at >= NOW() - INTERVAL '7 days') AS new_users_7d,
    (SELECT COUNT(*)::int FROM users WHERE created_at >= NOW() - INTERVAL '30 days') AS new_users_30d,
    (SELECT COUNT(*)::int FROM users WHERE subscription_plan <> 'free') AS paid_users,
    (SELECT COUNT(*)::int FROM promo_codes) AS total_promo_codes,
    (SELECT COUNT(*)::int FROM promo_codes WHERE active=TRUE AND (expires_at IS NULL OR expires_at > NOW())) AS active_promo_codes,
    (SELECT COUNT(*)::int FROM signals) AS total_signals,
    (SELECT COUNT(*)::int FROM metaapi_accounts) AS linked_trading_accounts,
    (SELECT COUNT(*)::int FROM trades) AS total_trades`);
  const stats = rows[0] || {};
  res.set('Cache-Control', 'no-store').json({
    stats: {
      totalUsers: stats.total_users ?? 0,
      adminUsers: stats.admin_users ?? 0,
      suspendedUsers: stats.suspended_users ?? 0,
      newUsers7d: stats.new_users_7d ?? 0,
      newUsers30d: stats.new_users_30d ?? 0,
      paidUsers: stats.paid_users ?? 0,
      totalPromoCodes: stats.total_promo_codes ?? 0,
      activePromoCodes: stats.active_promo_codes ?? 0,
      totalSignals: stats.total_signals ?? 0,
      linkedTradingAccounts: stats.linked_trading_accounts ?? 0,
      totalTrades: stats.total_trades ?? 0,
    },
    runtimeEnabled: autoTradingRuntimeEnabled,
  });
}));

app.get('/api/admin/users', authenticate, requireAdmin, asyncRoute(async (req, res) => {
  const search = String(req.query.search || '').trim().slice(0, 100);
  const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 25));
  const offset = Math.max(0, Number.parseInt(req.query.offset, 10) || 0);
  const filter = `WHERE ($1::text = '' OR position(lower($1) in lower(u.name)) > 0 OR position(lower($1) in lower(u.email)) > 0)`;
  const [list, count] = await Promise.all([
    pool.query(`SELECT ${adminUserColumns} FROM users u ${filter} ORDER BY u.created_at DESC LIMIT $2 OFFSET $3`, [search, limit, offset]),
    pool.query(`SELECT COUNT(*)::int AS count FROM users u ${filter}`, [search]),
  ]);
  res.set('Cache-Control', 'no-store').json({
    users: list.rows,
    total: count.rows[0]?.count ?? 0,
    limit,
    offset,
    search,
  });
}));

app.patch('/api/admin/users/:id', authenticate, requireAdmin, adminRoute('Updating that account', async (req, res) => {
  const targetId = String(req.params.id || '').trim();
  /*
   * A target that is not an account id used to return a 400 from outside the route's logging and
   * outside the audit trail, which is why "the Suspend button fails" could never be answered from the
   * server side: the request that arrived with a garbled id left no trace at all, and neither did a
   * refusal. Every way this endpoint can say no now says it in the log and in the audit trail, so
   * "the audit table has no user rows" means something precise: the request never reached this
   * handler, which is a deployment or a network fact, not a business rule.
   */
  const refuse = async (status, message, fields) => {
    log('warn', 'Admin account edit refused', { actorId: req.userId, targetId, status, fields, reason: message });
    if (fields.includes('isSuspended')) {
      await auditLog.record({
        actorId: req.userId,
        actorEmail: req.userEmail,
        action: 'user.suspend.refused',
        targetType: 'user',
        targetId,
        summary: `Refused a suspension request: ${message}`,
        metadata: { status, fields },
      }).catch(() => {});
    }
    return fail(res, status, message);
  };
  const sentFields = Object.keys(req.body || {});
  if (!UUID_PATTERN.test(targetId)) return refuse(400, 'Choose a valid user account.', sentFields);
  let update;
  try {
    update = normalizeUserUpdate(req.body || {});
    assertAllowedSelfUpdate({ actorId: req.userId, targetId, update });
  } catch (error) {
    /* A refused account edit used to leave no trace at all: the panel showed a sentence for a second
       and then forgot it, and the audit log recorded only successes - so "the Suspend button fails"
       could not be answered from the server side. The field names that arrived, the status, and the
       sentence go to the log, and a refusal of a suspension attempt goes to the audit trail too. */
    return refuse(Number(error.status) || 400, error.message, sentFields);
  }

  // The statement and its values are built together, and checked against each other, in one place:
  // which columns exist at all depends on which fields the administrator filled in.
  let statement;
  try { statement = buildUserAdminUpdate(update, targetId); }
  catch (error) { return refuse(Number(error.status) || 400, error.message, sentFields); }

  let applied;
  try {
    const { rows } = await pool.query(statement.sql, statement.params);
    if (!rows[0]) return refuse(404, 'That user could not be found.', sentFields);
    applied = rows[0];
  } catch (error) {
    /* The database itself refused. This is the only case where the change is genuinely unknown, so
       the sentence has to say that rather than blame the form. */
    log('error', 'Admin account edit failed in the database', { actorId: req.userId, targetId, code: error.code || null, error: error.message });
    return fail(res, 500, 'The change could not be written to the database, so this account has not been updated. Try again in a moment.');
  }
  // Everything below happens after the account really has changed. None of it may turn a completed
  // suspension into a failure: the applied values are already in hand, so a follow-up that throws is
  // reported and the request still answers with what was written.
  markApplied(req);
  let updated = { id: targetId, role: applied.role, isSuspended: applied.isSuspended, suspensionReason: applied.suspensionReason };
  try {
    const { rows: updatedRows } = await pool.query(`SELECT ${adminUserColumns} FROM users u WHERE u.id=$1`, [targetId]);
    if (updatedRows[0]) updated = updatedRows[0];
  } catch (error) {
    log('warn', 'Admin user details could not be re-read after an applied change', { actorId: req.userId, targetId, error: error.message });
  }
  // An account that just lost access also loses anyone looking at it through support.
  let revokedSessions = 0;
  if (update.isSuspended === true) {
    revokedSessions = (await supportSessions.revokeForUser(targetId).catch(() => ({ revoked: 0 }))).revoked || 0;
  }
  const changes = [];
  if (update.role !== undefined) changes.push(`role ${update.role}`);
  if (update.isSuspended === true) changes.push(`suspended (${update.suspensionReason})`);
  if (update.isSuspended === false) changes.push('suspension lifted');
  if (update.isSuspended === undefined && update.suspensionReason !== undefined) changes.push(`suspension reason updated (${update.suspensionReason || 'cleared'})`);
  await auditLog.record({
    actorId: req.userId,
    actorEmail: req.userEmail,
    action: update.isSuspended === true ? 'user.suspend' : update.isSuspended === false ? 'user.unsuspend' : update.role !== undefined ? 'user.role' : 'user.update',
    targetType: 'user',
    targetId,
    summary: `${updated.name || 'Account'} <${updated.email || 'unknown'}>: ${changes.join(', ') || 'no visible change'}.`,
    metadata: { ...update, revokedSupportSessions: revokedSessions || undefined },
  });
  log('info', 'Admin updated user', { actorId: req.userId, targetId, role: update.role, isSuspended: update.isSuspended, changes: changes.join(', ') });
  res.set('Cache-Control', 'no-store').json({ user: updated, ...(revokedSessions ? { notice: `${revokedSessions} support session(s) on that workspace were closed.` } : {}) });
}));

/* ------------------------------------------------------------------ data management (admin)
   *
   * The same two guarantees as the user-facing deletes - trades are unlinked, never removed - and
   * every action is audited with the numbers it moved, because "how many signals did the platform
   * lose on 4 April" has to be answerable from the audit log alone.
   */
const adminSignalColumns = `s.id,s.user_id AS "userId",u.name AS "userName",u.email AS "userEmail",
  s.channel_id AS "channelId",s.channel_title AS "channelTitle",s.source,s.symbol,s.side,
  s.entry_price AS "entryPrice",s.stop_loss AS "stopLoss",s.take_profit AS "takeProfit",
  s.direction_inferred AS "directionInferred",s.execution_ready AS "executionReady",
  s.parse_error AS "parseError",s.execution_note AS "executionNote",s.technical_note AS "technicalNote",s.status,s.created_at AS "createdAt",
  s.parsed_by AS "parsedBy",s.parse_confidence AS "parseConfidence",s.llm_used AS "llmUsed",s.stop_loss_pips AS "stopLossPips",s.take_profit_pips AS "takeProfitPips",s.needs_review AS "needsReview",
  s.order_type AS "orderType",s.is_scalping AS "isScalping",s.expiry_timestamp AS "expiryTimestamp",s.entry_range AS "entryRange",
  (SELECT COUNT(*)::int FROM trades t WHERE t.signal_id=s.id) AS "tradeCount",
  left(s.message,300) AS "message",COUNT(*) OVER()::int AS "totalCount"`;
const ADMIN_SIGNAL_FILTER = `WHERE ($1::text=''
     OR position(lower($1) in lower(u.email))>0
     OR position(lower($1) in lower(u.name))>0
     OR position(lower($1) in lower(coalesce(s.channel_title,'')))>0
     OR position(lower($1) in lower(coalesce(s.symbol,'')))>0)
   AND ($2::uuid IS NULL OR s.user_id=$2)
   AND ($3::timestamptz IS NULL OR s.created_at>=$3)
   AND ($4::timestamptz IS NULL OR s.created_at<$4)`;

/**
 * A date the administrator typed. A bare day is UTC midnight, and for the upper bound that means the
 * whole day: a range of "4 April to 4 April" has to return 4 April, so the day-only form is pushed to
 * the next midnight while the filter stays `created_at < $4`. A value with a time in it is taken exactly
 * as written, because then the reader has said what they meant.
 */
function readSignalDateFilter(value, label, { endOfDay = false } = {}) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const dayOnly = /^\d{4}-\d{2}-\d{2}$/.test(text);
  const instant = new Date(dayOnly ? `${text}T00:00:00.000Z` : text);
  if (!Number.isFinite(instant.getTime())) {
    const error = new Error(`${label} is not a date I can read.`);
    error.status = 400;
    throw error;
  }
  if (endOfDay && dayOnly) instant.setUTCDate(instant.getUTCDate() + 1);
  return instant.toISOString();
}

app.get('/api/admin/signals', authenticate, requireAdmin, asyncRoute(async (req, res) => {
  const search = String(req.query.search || '').trim().slice(0, 100);
  const userId = String(req.query.userId || '').trim();
  if (userId && !UUID_PATTERN.test(userId)) return fail(res, 400, 'Choose a valid user account.');
  let from = null;
  let to = null;
  try {
    from = readSignalDateFilter(req.query.from, 'The starting date');
    to = readSignalDateFilter(req.query.to, 'The ending date', { endOfDay: true });
  } catch (error) { return fail(res, error.status || 400, error.message); }
  const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 25));
  const offset = Math.max(0, Number.parseInt(req.query.offset, 10) || 0);
  const { rows } = await pool.query(
    `SELECT ${adminSignalColumns} FROM signals s JOIN users u ON u.id=s.user_id ${ADMIN_SIGNAL_FILTER}
      ORDER BY s.created_at DESC LIMIT $5 OFFSET $6`,
    [search, userId || null, from, to, limit, offset],
  );
  res.set('Cache-Control', 'no-store').json({ signals: rows, total: rows[0]?.totalCount ?? 0, limit, offset, search, from, to });
}));

/** What a bulk delete would take, read before anything is asked to confirm it. */
app.get('/api/admin/signals/purge-preview', authenticate, requireAdmin, asyncRoute(async (req, res) => {
  const days = Math.trunc(Number(req.query.olderThanDays) || SIGNAL_PURGE_DEFAULT_DAYS);
  if (!Number.isInteger(days) || days < 1 || days > 3650) return fail(res, 400, 'Choose an age between 1 and 3650 days.');
  const { rows } = await pool.query(buildSignalsPurgeCount({ days }).sql, buildSignalsPurgeCount({ days }).params);
  res.set('Cache-Control', 'no-store').json({
    olderThanDays: days,
    signals: rows[0]?.signals ?? 0,
    unlinkableTrades: rows[0]?.unlinkable_trades ?? 0,
  });
}));

app.delete('/api/admin/signals/:id', authenticate, requireAdmin, adminRoute('Deleting that signal', async (req, res) => {
  const signalId = String(req.params.id || '').trim();
  if (!UUID_PATTERN.test(signalId)) return fail(res, 400, 'Choose a signal to remove.');
  const { rows: found } = await pool.query(
    `SELECT s.id,u.email AS "userEmail",(SELECT COUNT(*)::int FROM trades t WHERE t.signal_id=s.id) AS "tradeCount"
       FROM signals s JOIN users u ON u.id=s.user_id WHERE s.id=$1 LIMIT 1`,
    [signalId],
  );
  const target = found[0];
  if (!target) return fail(res, 404, 'That signal is no longer in the history.');
  const result = await runSignalDelete(buildAdminSignalDelete({ signalId }));
  if (!result.deleted) return fail(res, 404, 'That signal is no longer in the history.');
  markApplied(req);
  await auditLog.record({
    actorId: req.userId,
    actorEmail: req.userEmail,
    action: 'signal.delete',
    targetType: 'signal',
    targetId: signalId,
    summary: `Removed 1 captured signal from ${target.userEmail}. ${Number(target.tradeCount) || 0} trade record(s) kept, unlinked.`,
    metadata: { user: target.userEmail, trades: Number(target.tradeCount) || 0 },
  });
  res.json({ deleted: result.deleted, unlinkedTrades: result.unlinked });
}));

app.delete('/api/admin/users/:id/signals', authenticate, requireAdmin, adminRoute('Clearing that workspace\'s signal history', async (req, res) => {
  const targetId = String(req.params.id || '').trim();
  if (!UUID_PATTERN.test(targetId)) return fail(res, 400, 'Choose a valid user account.');
  const { rows: userRows } = await pool.query('SELECT id,email FROM users WHERE id=$1 LIMIT 1', [targetId]);
  const target = userRows[0];
  if (!target) return fail(res, 404, 'That user could not be found.');
  const preview = await pool.query(buildSignalsPurgeCount({ userId: targetId }).sql, buildSignalsPurgeCount({ userId: targetId }).params);
  const scope = Number(preview.rows[0]?.signals) || 0;
  if (!scope) return fail(res, 409, `${target.email} has no captured signals left to remove. Nothing was changed.`);
  const result = await runSignalDelete(buildSignalsPurgeForUser({ userId: targetId }));
  markApplied(req);
  await auditLog.record({
    actorId: req.userId,
    actorEmail: req.userEmail,
    action: 'signal.clearUser',
    targetType: 'user',
    targetId,
    summary: `Cleared ${result.deleted} captured signal(s) for ${target.email}. ${result.unlinked} trade record(s) kept, unlinked.`,
    metadata: { user: target.email, deleted: result.deleted, unlinkedTrades: result.unlinked },
  });
  log('warn', 'Admin cleared a workspace signal history', { actorId: req.userId, targetId, deleted: result.deleted, unlinkedTrades: result.unlinked });
  res.json({ deleted: result.deleted, unlinkedTrades: result.unlinked, user: target.email });
}));

app.post('/api/admin/signals/purge', authenticate, requireAdmin, adminRoute('Purging the oldest signals', async (req, res) => {
  const days = Math.trunc(Number(req.body?.olderThanDays) || SIGNAL_PURGE_DEFAULT_DAYS);
  if (!Number.isInteger(days) || days < 1 || days > 3650) return fail(res, 400, `Choose an age between 1 and 3650 days (the confirmation was for ${days > 0 ? days : SIGNAL_PURGE_DEFAULT_DAYS} days).`);
  const result = await runSignalDelete(buildSignalsPurgeOlderThan({ days }));
  markApplied(req);
  await auditLog.record({
    actorId: req.userId,
    actorEmail: req.userEmail,
    action: 'signal.purgeOld',
    targetType: 'platform',
    targetId: null,
    summary: `Purged ${result.deleted} signal(s) older than ${days} days across every workspace. ${result.unlinked} trade record(s) kept, unlinked.`,
    metadata: { olderThanDays: days, deleted: result.deleted, unlinkedTrades: result.unlinked },
  });
  log('warn', 'Platform signal purge completed', { actorId: req.userId, olderThanDays: days, deleted: result.deleted, unlinkedTrades: result.unlinked });
  res.json({ deleted: result.deleted, unlinkedTrades: result.unlinked, olderThanDays: days });
}));

app.get('/api/admin/promo-codes', authenticate, requireAdmin, asyncRoute(async (_req, res) => {
  const { rows } = await pool.query(`SELECT ${promoCodeColumns} FROM promo_codes ORDER BY created_at DESC LIMIT 200`);
  res.set('Cache-Control', 'no-store').json({ promoCodes: rows });
}));

app.post('/api/admin/promo-codes', authenticate, requireAdmin, asyncRoute(async (req, res) => {
  let input;
  try { input = normalizePromoCodeInput(req.body || {}); }
  catch (error) { return fail(res, error.status || 400, error.message); }
  try {
    const { rows } = await pool.query(
      `INSERT INTO promo_codes(code,discount_type,discount_value,max_uses,expires_at,created_by)
       VALUES($1,$2,$3,$4,$5,$6) RETURNING ${promoCodeColumns}`,
      [input.code, input.discountType, input.discountValue, input.maxUses, input.expiresAt, req.userId],
    );
    await auditLog.record({
      actorId: req.userId,
      actorEmail: req.userEmail,
      action: 'promo_code.create',
      targetType: 'promo_code',
      targetId: rows[0].id,
      summary: `Created promo code ${input.code} for ${describeDiscount(input)}.`,
      metadata: { ...input },
    });
    log('info', 'Admin created promo code', { actorId: req.userId, promoCodeId: rows[0].id, discountType: input.discountType });
    res.set('Cache-Control', 'no-store').status(201).json({ promoCode: rows[0] });
  } catch (error) {
    if (error.code === '23505') return fail(res, 409, 'That promo code already exists. Choose a different code.');
    throw error;
  }
}));

app.patch('/api/admin/promo-codes/:id', authenticate, requireAdmin, asyncRoute(async (req, res) => {
  const promoCodeId = String(req.params.id || '').trim();
  if (!UUID_PATTERN.test(promoCodeId)) return fail(res, 400, 'Choose a valid promo code.');
  let update;
  try { update = normalizePromoCodeUpdate(req.body || {}); }
  catch (error) { return fail(res, error.status || 400, error.message); }

  const assignments = [];
  const values = [];
  const push = (column, value) => { values.push(value); assignments.push(`${column}=$${values.length}`); };
  if (update.active !== undefined) push('active', update.active);
  if (update.maxUses !== undefined) push('max_uses', update.maxUses);
  if (update.expiresAt !== undefined) push('expires_at', update.expiresAt);
  values.push(promoCodeId);
  const { rows } = await pool.query(
    `UPDATE promo_codes SET ${assignments.join(',')},updated_at=NOW() WHERE id=$${values.length} RETURNING ${promoCodeColumns}`,
    values,
  );
  if (!rows[0]) return fail(res, 404, 'That promo code could not be found.');
  await auditLog.record({
    actorId: req.userId,
    actorEmail: req.userEmail,
    action: 'promo_code.update',
    targetType: 'promo_code',
    targetId: promoCodeId,
    summary: `Updated promo code ${rows[0].code}: ${describePromoUpdate(update)}.`,
    metadata: { ...update },
  });
  log('info', 'Admin updated promo code', { actorId: req.userId, promoCodeId, active: update.active });
  res.set('Cache-Control', 'no-store').json({ promoCode: rows[0] });
}));

app.delete('/api/admin/promo-codes/:id', authenticate, requireAdmin, asyncRoute(async (req, res) => {
  const promoCodeId = String(req.params.id || '').trim();
  if (!UUID_PATTERN.test(promoCodeId)) return fail(res, 400, 'Choose a valid promo code.');
  const { rows: deletedRows } = await pool.query('DELETE FROM promo_codes WHERE id=$1 RETURNING code', [promoCodeId]);
  if (!deletedRows[0]) return fail(res, 404, 'That promo code could not be found.');
  const deletedCode = deletedRows[0].code;
  await auditLog.record({
    actorId: req.userId,
    actorEmail: req.userEmail,
    action: 'promo_code.delete',
    targetType: 'promo_code',
    targetId: promoCodeId,
    summary: `Removed the ${deletedCode ? `“${deletedCode}” ` : ''}promo code.`,
    metadata: { promoCodeId },
  });
  log('info', 'Admin deleted promo code', { actorId: req.userId, promoCodeId });
  res.json({ ok: true });
}));

/* --------------------------- Admin: pricing control -------------------------
 * Prices live in the `plans` table - one row per plan, one column per currency - and every write
 * also mirrors the price into a Flutterwave payment plan per currency, so a renewal charges exactly
 * what the site advertises. A sync problem is reported, never hidden, and never blocks saving the
 * price: the worst case is a customer who pays once instead of being subscribed, which is a billing
 * conversation, not a broken login.
 */
/** Money for audit summaries only: minor units are the stored truth, the label is for humans. */
function describeMoney(amountMinor, currency = 'NGN') {
  if (amountMinor === null || amountMinor === undefined || amountMinor === '') return 'not priced';
  return formatAmount(amountMinor, currency);
}

function describeDiscount(input = {}) {
  const discount = input.discountType === 'percentage' ? `${Number(input.discountValue)}% off` : `${describeMoney(Math.round(Number(input.discountValue) * 100))} off`;
  const uses = input.maxUses ? ` up to ${input.maxUses} time${Number(input.maxUses) === 1 ? '' : 's'}` : ' with no usage cap';
  const expiry = input.expiresAt ? `, expiring ${new Date(input.expiresAt).toISOString().slice(0, 10)}` : ', with no expiry';
  return `${discount}${uses}${expiry}`;
}

function describePromoUpdate(update = {}) {
  const parts = [];
  if (update.active !== undefined) parts.push(update.active ? 'reactivated' : 'deactivated');
  if (update.maxUses !== undefined) parts.push(`usage cap ${update.maxUses === null ? 'removed' : update.maxUses}`);
  if (update.expiresAt !== undefined) parts.push(`expiry ${update.expiresAt ? new Date(update.expiresAt).toISOString().slice(0, 16).replace('T', ' ') : 'removed'}`);
  return parts.join(', ') || 'nothing changed';
}

/** One provider mirror, in the shape the panel renders. `null` when that currency has never been synced. */
function describeProviderMirror(sync, currency) {
  if (!sync || (sync.planId === null && sync.syncStatus === 'pending')) {
    return { planId: null, syncStatus: 'pending', syncedAmountMinor: null, currency, message: null, error: null, name: null, interval: null, syncedAt: null };
  }
  return {
    planId: sync.planId ?? null,
    legacyCode: sync.legacyCode || null,
    syncStatus: sync.syncStatus || 'pending',
    syncedAmountMinor: sync.syncedAmountMinor ?? null,
    syncedAt: sync.syncedAt || null,
    currency: sync.currency || currency,
    interval: sync.interval || null,
    name: sync.name || null,
    message: sync.message || null,
    error: sync.error || null,
  };
}

async function adminPricingPayload() {
  const snapshot = await pricingStore.snapshot();
  let subscribers = [];
  try {
    const { rows } = await pool.query(
      `SELECT plan_key,COUNT(*)::int AS active_subscriptions FROM subscriptions
       WHERE status IN ('active','non_renewing','past_due') GROUP BY plan_key`,
    );
    subscribers = rows;
  } catch (error) {
    log('warn', 'Subscription counts could not be read for the pricing panel', { code: error.code || 'PRICING_COUNTS_FAILED' });
  }
  const counts = new Map(subscribers.map((row) => [String(row.plan_key), Number(row.active_subscriptions || 0)]));
  return {
    currency: snapshot.currency,
    supportedCurrencies: [...flutterwaveConfig.supportedCurrencies],
    interval: snapshot.interval,
    configured: flutterwaveConfig.configured,
    webhookConfigured: flutterwaveConfig.webhookConfigured,
    billing: {
      recurringEnabled: snapshot.recurringEnabled,
      updateExistingSubscriptions: snapshot.updateExistingSubscriptions,
    },
    plans: snapshot.plans.map((plan) => ({
      key: plan.key,
      name: plan.name,
      description: plan.description,
      limits: plan.limits,
      amountMinor: plan.amountMinor,
      amount: plan.amount,
      usdAmountMinor: plan.usdAmountMinor,
      usdAmount: plan.usdAmount,
      currency: plan.currency,
      interval: plan.interval,
      source: plan.source,
      sources: plan.sources,
      prices: plan.prices,
      environmentAmountMinor: plan.environmentAmountMinor,
      environmentAmount: plan.environmentAmountMinor === null ? null : plan.environmentAmountMinor / 100,
      environmentUsdAmountMinor: plan.environmentUsdAmountMinor,
      environmentUsdAmount: plan.environmentUsdAmountMinor === null ? null : plan.environmentUsdAmountMinor / 100,
      updatedAt: plan.updatedAt,
      updatedBy: plan.updatedBy,
      history: plan.history,
      activeSubscribers: counts.get(plan.key) || 0,
      provider: Object.fromEntries([...flutterwaveConfig.supportedCurrencies].map((code) => [
        code,
        describeProviderMirror(plan.provider?.[code], code),
      ])),
      renewsAutomatically: Object.fromEntries([...flutterwaveConfig.supportedCurrencies].map((code) => [
        code,
        planChargeDecision({ plan, currency: code, recurringEnabled: snapshot.recurringEnabled }).usePlan,
      ])),
    })),
  };
}

app.get('/api/admin/pricing', authenticate, requireAdmin, asyncRoute(async (_req, res) => {
  res.set('Cache-Control', 'no-store').json(await adminPricingPayload());
}));

app.put('/api/admin/pricing', authenticate, requireAdmin, asyncRoute(async (req, res) => {
  let update;
  try {
    update = normalizePricingUpdate({ input: req.body || {}, config: flutterwaveConfig });
  } catch (error) {
    return fail(res, error.status || 400, error.userMessage || error.message);
  }

  const before = new Map((await adminPricingPayload()).plans.map((plan) => [plan.key, plan]));
  const saved = [];
  for (const entry of update.entries) {
    const result = await pricingStore.savePlanPrices({
      planKey: entry.planKey,
      amounts: entry.amounts,
      written: entry.written,
      actorId: req.userId,
      actorEmail: req.userEmail,
      note: update.note,
    });
    saved.push({ planKey: entry.planKey, amounts: entry.amounts, ...result });
  }
  if (Object.keys(update.billing).length) {
    await pricingStore.saveBillingSettings({ settings: update.billing, actorId: req.userId });
  }

  /* Only the currencies whose price actually moved are re-synced, and a `not_priced` result is a state to show,
     not a failure: an administrator who edits the naira price has not broken the dollar plan. */
  const syncs = [];
  for (const entry of update.syncPlanKeys) {
    for (const currency of entry.currencies) {
      const result = await planSynchronizer.syncPlan({ planKey: entry.planKey, currency, actorId: req.userId });
      syncs.push(result);
    }
  }
  const failed = syncs.filter((sync) => !sync.usable && sync.status !== 'not_priced');
  const skipped = syncs.filter((sync) => sync.status === 'not_priced');
  const priceChanges = update.entries.flatMap((entry) => Object.entries(entry.amounts || {}).map(([currency, amountMinor]) => {
    const prior = before.get(entry.planKey);
    const from = describeMoney(prior?.prices?.[currency]?.amountMinor ?? null, currency);
    const to = amountMinor === null || amountMinor === undefined ? 'cleared (environment price)' : describeMoney(amountMinor, currency);
    return `${entry.planKey} ${currency}: ${from} → ${to}`;
  }));
  await auditLog.record({
    actorId: req.userId,
    actorEmail: req.userEmail,
    action: 'pricing.update',
    targetType: 'plan',
    targetId: priceChanges.length === 1 ? update.entries[0].planKey : null,
    summary: `Changed pricing - ${priceChanges.join('; ') || 'billing settings only'}.${update.note ? ` Note: ${update.note}` : ''}`,
    metadata: {
      plans: update.entries.map((entry) => ({
        planKey: entry.planKey,
        beforeMinor: Object.fromEntries(Object.keys(entry.amounts || {}).map((code) => [code, before.get(entry.planKey)?.prices?.[code]?.amountMinor ?? null])),
        afterMinor: Object.fromEntries(Object.entries(entry.amounts || {}).map(([code, value]) => [code, value ?? null])),
      })),
      note: update.note || null,
      billing: update.billing || null,
      syncStatuses: syncs.map((item) => `${item.planKey}:${item.currency}:${item.status}`),
    },
  });
  log('info', 'Admin updated pricing', {
    actorId: req.userId,
    plans: saved.map((item) => ({ planKey: item.planKey, amounts: item.amounts ?? null, cleared: Boolean(item.cleared) })),
    syncStatuses: syncs.map((item) => `${item.planKey}:${item.currency}:${item.status}`),
  });
  res.set('Cache-Control', 'no-store').json({
    pricing: await adminPricingPayload(),
    saved,
    syncs,
    notice: failed.length
      ? `Saved, but Flutterwave could not confirm ${failed.map((item) => `${item.planKey} in ${item.currency}`).join(', ')}: ${failed[0].message} Users are charged the saved price as a one-time payment until the plan syncs.`
      : skipped.length
        ? `Prices saved and mirrored to Flutterwave. ${skipped.map((item) => `${item.planKey} has no ${item.currency} price, so that currency renews as a one-time payment.`).join(' ')}`
        : 'Prices saved and mirrored to Flutterwave.',
  });
}));

app.post('/api/admin/pricing/sync', authenticate, requireAdmin, asyncRoute(async (req, res) => {
  const requested = req.body?.plan ? [String(req.body.plan)] : flutterwaveConfig.plans.map((plan) => plan.key);
  for (const planKey of requested) {
    if (!flutterwaveConfig.plans.some((plan) => plan.key === String(planKey).trim().toLowerCase())) {
      return fail(res, 400, 'Choose a valid plan to sync.');
    }
  }
  const currencies = Array.isArray(req.body?.currencies) && req.body.currencies.length
    ? req.body.currencies.map((code) => String(code).trim().toUpperCase())
    : [...flutterwaveConfig.supportedCurrencies];
  const unsupported = currencies.filter((code) => !isSupportedCurrency(code));
  if (unsupported.length) return fail(res, 400, `That currency is not offered here: ${unsupported.join(', ')}.`);
  let billing;
  if (req.body && (Object.hasOwn(req.body, 'recurringEnabled') || Object.hasOwn(req.body, 'updateExistingSubscriptions'))) {
    try { billing = normalizeBillingSettings(req.body); }
    catch (error) { return fail(res, error.status || 400, error.message); }
    await pricingStore.saveBillingSettings({ settings: billing, actorId: req.userId });
  }
  const syncs = [];
  for (const planKey of requested) {
    for (const currency of currencies) {
      syncs.push(await planSynchronizer.syncPlan({ planKey, currency, actorId: req.userId }));
    }
  }
  await auditLog.record({
    actorId: req.userId,
    actorEmail: req.userEmail,
    action: 'pricing.sync',
    targetType: 'plan',
    summary: `Re-synced Flutterwave payment plans for ${requested.join(', ')} in ${currencies.join(', ')} (${syncs.map((item) => `${item.planKey}:${item.currency}:${item.status}`).join(', ')}).`,
    metadata: { plans: [...requested], currencies: [...currencies], billingSaved: Boolean(billing) },
  });
  log('info', 'Admin re-synced Flutterwave payment plans', { actorId: req.userId, results: syncs.map((item) => `${item.planKey}:${item.currency}:${item.status}`) });
  res.set('Cache-Control', 'no-store').json({ pricing: await adminPricingPayload(), syncs, billingSaved: Boolean(billing) });
}));

app.get('/api/admin/billing', authenticate, requireAdmin, asyncRoute(async (_req, res) => {
  const [summary, byCurrencyRows, recent, subscriptions] = await Promise.all([
    pool.query(`SELECT
      (SELECT COUNT(*)::int FROM users WHERE subscription_plan <> 'free' AND subscription_status='active') AS active_subscriptions,
      (SELECT COUNT(*)::int FROM billing_transactions WHERE status='success') AS successful_payments,
      (SELECT COUNT(*)::int FROM billing_transactions WHERE status='pending') AS pending_payments`),
    // Revenue is grouped by currency and never summed across one: ₦6,000,000 and $39 added together is a
    // number that describes neither, and a dashboard total nobody can spend is worse than two totals.
    pool.query(`SELECT currency,COALESCE(SUM(amount_minor),0)::bigint AS gross_minor,COALESCE(SUM(discount_minor),0)::bigint AS discounts_minor,
        COUNT(*)::int AS successful_payments
      FROM billing_transactions WHERE status='success' GROUP BY currency ORDER BY currency`),
    pool.query(`SELECT t.reference,t.plan_key AS "planKey",t.source,t.plan_code AS "planCode",t.status,t.amount_minor AS "amountMinor",t.currency,
        t.promo_code AS "promoCode",t.paid_at AS "paidAt",t.created_at AS "createdAt",u.email
      FROM billing_transactions t JOIN users u ON u.id=t.user_id ORDER BY t.created_at DESC LIMIT 25`),
    pool.query(`SELECT s.plan_key AS "planKey",s.status,s.interval,s.currency,s.current_period_end AS "currentPeriodEnd",
        s.cancel_at_period_end AS "cancelAtPeriodEnd",u.email,u.name
      FROM subscriptions s JOIN users u ON u.id=s.user_id ORDER BY s.updated_at DESC LIMIT 25`),
  ]);
  const row = summary.rows[0] || {};
  const byCurrency = byCurrencyRows.rows.map((item) => ({
    currency: String(item.currency || '').toUpperCase() || normalizeCurrency(flutterwaveConfig.currency),
    grossMinor: Number(item.gross_minor || 0),
    discountsMinor: Number(item.discounts_minor || 0),
    successfulPayments: Number(item.successful_payments || 0),
  }));
  const primary = normalizeCurrency(flutterwaveConfig.currency);
  const primaryTotals = byCurrency.find((item) => item.currency === primary) || { grossMinor: 0, discountsMinor: 0 };
  res.set('Cache-Control', 'no-store').json({
    summary: {
      activeSubscriptions: row.active_subscriptions ?? 0,
      successfulPayments: row.successful_payments ?? 0,
      pendingPayments: row.pending_payments ?? 0,
      // `grossMinor` stays the naira-equivalent figure for anything still reading one number, and `revenue`
      // is where the honest split lives.
      grossMinor: primaryTotals.grossMinor,
      discountsMinor: primaryTotals.discountsMinor,
      currency: primary,
      revenue: byCurrency,
    },
    transactions: recent.rows.map((item) => ({ ...item, amountMinor: Number(item.amountMinor) })),
    subscriptions: subscriptions.rows.map((item) => ({ ...item, currency: item.currency || null })),
    configured: flutterwaveConfig.configured,
  });
}));

/* --------------------- Admin: system health and the kill switch ---------------------
 * The health read model reads the failure records the platform already keeps (trades, jobs,
 * stop moves, parsed signals), and the switch that stops every workspace from trading. Both
 * halves are needed together: an operator looking at a pile of MetaAPI errors needs the button
 * that makes it stop right now, in the same screen.
 */
app.get('/api/admin/health', authenticate, requireAdmin, asyncRoute(async (req, res) => {
  res.set('Cache-Control', 'no-store').json(await systemHealth.snapshot(normalizeHealthQuery(req.query || {})));
}));

/* The errors list gets a clear button here, because this is the only place the parsing reasons are shown,
 * and no row is lost by removing one: the captured message stays in `signals`, only the recorded reason
 * goes. The statement is `buildParseErrorClear`: its WHERE is the condition the list's `telegram_parse`
 * branch selects on, without that branch's window, so the button clears every recorded reason rather than
 * only the ones currently on screen - and an emptied tab and a count of zero then always agree.
 */
app.delete('/api/admin/health/errors', authenticate, requireAdmin, adminRoute('Clearing the Telegram parsing errors', async (req, res) => {
  const statement = buildParseErrorClear();
  const { rowCount } = await pool.query(statement.sql, statement.params);
  markApplied(req);
  const cleared = Number(rowCount || 0);
  await auditLog.record({
    actorId: req.userId,
    actorEmail: req.userEmail,
    action: 'health.clearParseErrors',
    targetType: 'platform',
    targetId: 'signals.parse_error',
    summary: `Cleared the recorded parsing reason from ${cleared} captured message(s).`,
    metadata: { cleared },
  });
  res.set('Cache-Control', 'no-store').json({
    cleared,
    notice: cleared
      ? `${cleared} captured message(s) no longer carry a parsing reason. The messages themselves are untouched.`
      : 'No captured message carried a parsing reason, so nothing was removed.',
  });
}));

app.get('/api/admin/execution-switch', authenticate, requireAdmin, asyncRoute(async (_req, res) => {
  const state = await platformControls.read();
  res.set('Cache-Control', 'no-store').json({
    switch: state,
    runtimeEnabled: autoTradingRuntimeEnabled,
    pauseMessage: PLATFORM_PAUSE_MESSAGE,
    settingKey: KILL_SWITCH_SETTING_KEY,
  });
}));

app.put('/api/admin/execution-switch', authenticate, requireAdmin, asyncRoute(async (req, res) => {
  let input;
  try { input = normalizeKillSwitchInput(req.body || {}); }
  catch (error) { return fail(res, error.status || 400, error.message); }
  const state = await platformControls.setPaused({ paused: input.paused, reason: input.reason, actorId: req.userId });
  await auditLog.record({
    actorId: req.userId,
    actorEmail: req.userEmail,
    action: input.paused ? 'execution.pause' : 'execution.resume',
    targetType: 'platform',
    targetId: KILL_SWITCH_SETTING_KEY,
    summary: input.paused
      ? `Paused automatic execution for every workspace. Reason: ${input.reason}`
      : 'Resumed automatic execution for every workspace.',
    metadata: { state: state.state, reason: input.reason },
  });
  res.set('Cache-Control', 'no-store').json({
    switch: state,
    runtimeEnabled: autoTradingRuntimeEnabled,
    notice: input.paused
      ? 'The engine reads this switch before every order, so new trades stop on the next job claim. Open positions keep the stops they already have.'
      : 'Eligible workspaces can execute again. Signals skipped while the switch was engaged are not replayed.',
  });
}));

/* ----------------------------- Admin: audit trail -----------------------------
 * The only writer of an entry is the record() call each admin mutation makes, and no route edits one.
 * There is one way rows are removed, below: the administrator clearing the history on purpose, from a
 * button the panel only renders for an admin, behind a confirmation it has to answer. That route writes
 * its own entry afterwards, so an emptied table is still evidence of having been emptied - which is the
 * only difference between this button and a cover-up.
 */
app.get('/api/admin/audit-logs', authenticate, requireAdmin, asyncRoute(async (req, res) => {
  let query;
  try { query = normalizeAuditQuery(req.query || {}); }
  catch (error) { return fail(res, error.status || 400, error.message); }
  res.set('Cache-Control', 'no-store').json(await auditLog.list(query));
}));

app.delete('/api/admin/audit-logs', authenticate, requireAdmin, adminRoute('Clearing the audit log', async (req, res) => {
  const statement = buildAuditLogClear();
  const { rowCount } = await pool.query(statement.sql, statement.params);
  markApplied(req);
  const removed = Number(rowCount || 0);
  // Recorded after the delete, from the route that deleted: the entry describing the wipe has to survive
  // it, and it is the row an admin sees when they ask when the history went.
  await auditLog.record({
    actorId: req.userId,
    actorEmail: req.userEmail,
    action: 'audit.clear',
    targetType: 'platform',
    targetId: 'admin_audit_logs',
    summary: `Cleared the admin audit log - ${removed} entr${removed === 1 ? 'y' : 'ies'} removed.`,
    metadata: { removed },
  });
  res.set('Cache-Control', 'no-store').json({
    removed,
    notice: removed
      ? `${removed} entr${removed === 1 ? 'y' : 'ies'} deleted. This clearing is recorded as the log's only entry.`
      : 'The audit log was already empty.',
  });
}));

/* --------------------------- Admin: announcements --------------------------- */
app.get('/api/admin/announcements', authenticate, requireAdmin, asyncRoute(async (req, res) => {
  let query;
  try { query = normalizeAnnouncementListQuery(req.query || {}); }
  catch (error) { return fail(res, error.status || 400, error.message); }
  res.set('Cache-Control', 'no-store').json(await announcementService.list(query));
}));

app.post('/api/admin/announcements', authenticate, requireAdmin, adminRoute('Publishing that announcement', async (req, res) => {
  let draft;
  try { draft = normalizeAnnouncementDraft(req.body || {}); }
  catch (error) { return fail(res, error.status || 400, error.message); }
  let announcement;
  try {
    announcement = await announcementService.publish({ draft, actorId: req.userId });
    markApplied(req);
  } catch (error) {
    if (error.code === '23514') return fail(res, 400, 'Those dates do not fit together, so the announcement was not published.');
    throw error;
  }
  await auditLog.record({
    actorId: req.userId,
    actorEmail: req.userEmail,
    action: 'announcement.publish',
    targetType: 'announcement',
    targetId: announcement?.id || null,
    summary: `Published a ${announcement?.level || draft.level} announcement: ${draft.message}`,
    metadata: { level: draft.level, active: draft.active, startsAt: draft.startsAt, endsAt: draft.endsAt },
  });
  res.set('Cache-Control', 'no-store').status(201).json({
    announcement,
    notice: draft.active ? 'The banner is live on every dashboard now.' : 'Saved as inactive - nothing is displayed yet.',
  });
}));

/* Retiring keeps the row on purpose, so the history list is the one place that only ever grows. This
 * route deletes from it: everything no user can still see and never will again, which is `retired` plus
 * `ended` as `announcementState` defines them. Live and upcoming banners are outside the predicate, and a
 * banner's per-user dismissals follow their banner (`ON DELETE CASCADE`) rather than orphaning.
 *
 * It is mounted BEFORE the `/api/admin/announcements/:id` routes, and that is not a style choice. Express
 * matches in registration order, so `DELETE /api/admin/announcements/history` declared after
 * `DELETE /api/admin/announcements/:id` is a route that can never be reached: `history` becomes `:id`, the
 * UUID check refuses it, and the administrator who pressed one button is handed back
 * `Choose a valid announcement.` - a sentence about a row they were not trying to touch, from the endpoint
 * that retires one. `test/route-order.test.js`, required by `test/admin-clear-history.test.js`, walks
 * every literal route in this file for that shadowing, so grouping the two deletes together "for tidiness"
 * fails a test rather than shipping.
 */
app.delete('/api/admin/announcements/history', authenticate, requireAdmin, adminRoute('Clearing the banner history', async (req, res) => {
  const statement = buildRetiredAnnouncementClear();
  const { rowCount } = await pool.query(statement.sql, statement.params);
  markApplied(req);
  const removed = Number(rowCount || 0);
  await auditLog.record({
    actorId: req.userId,
    actorEmail: req.userEmail,
    action: 'announcement.purgeHistory',
    targetType: 'announcement',
    targetId: 'history',
    summary: `Deleted ${removed} banner(s) that were retired or past their end date.`,
    metadata: { removed },
  });
  res.set('Cache-Control', 'no-store').json({
    removed,
    notice: removed
      ? `${removed} banner(s) deleted. Live and upcoming banners were kept.`
      : 'Nothing to delete - every banner in the history is live or still scheduled.',
  });
}));

app.patch('/api/admin/announcements/:id', authenticate, requireAdmin, asyncRoute(async (req, res) => {
  const id = String(req.params.id || '').trim();
  if (!UUID_PATTERN.test(id)) return fail(res, 400, 'Choose a valid announcement.');
  let draft;
  try { draft = normalizeAnnouncementDraft(req.body || {}, { partial: true }); }
  catch (error) { return fail(res, error.status || 400, error.message); }
  let announcement;
  try {
    announcement = await announcementService.update({ id, draft });
  } catch (error) {
    if (error.code === '23514') return fail(res, 400, 'Those dates do not fit the existing window, so nothing was changed.');
    throw error;
  }
  if (!announcement) return fail(res, 404, 'That announcement could not be found, or nothing needed changing.');
  await auditLog.record({
    actorId: req.userId,
    actorEmail: req.userEmail,
    action: 'announcement.update',
    targetType: 'announcement',
    targetId: id,
    summary: `Changed an announcement (${Object.keys(draft).filter((key) => draft[key] !== undefined).join(', ')}).`,
    metadata: { changed: Object.fromEntries(Object.entries(draft).filter(([, value]) => value !== undefined)) },
  });
  res.set('Cache-Control', 'no-store').json({ announcement });
}));

app.delete('/api/admin/announcements/:id', authenticate, requireAdmin, asyncRoute(async (req, res) => {
  const id = String(req.params.id || '').trim();
  if (!UUID_PATTERN.test(id)) return fail(res, 400, 'Choose a valid announcement.');
  const announcement = await announcementService.retire({ id });
  if (!announcement) return fail(res, 404, 'That announcement is already retired.');
  await auditLog.record({
    actorId: req.userId,
    actorEmail: req.userEmail,
    action: 'announcement.retire',
    targetType: 'announcement',
    targetId: id,
    summary: `Retired the announcement: ${announcement.message}`,
    metadata: { message: announcement.message },
  });
  res.set('Cache-Control', 'no-store').json({ announcement, notice: 'Retired - it no longer appears on dashboards, and the record stays for audit.' });
}));

/* ---------------------------- Admin: support access ----------------------------
 * A support session is a one-hour, read-only token minted by an administrator. It never reads,
 * resets, or references the customer's password, and closing it revokes the token server-side.
 */
/* The manual reconnect, for the moment an operator has already read the heartbeat counters and decided the
   stream is dead. It answers with what the backlog recovery found rather than `ok`, and it is the one path in
   this file that steps around the rebuild cooldown - by design, and only for an authenticated admin. */
app.post('/api/admin/users/:id/telegram/reconnect', authenticate, requireAdmin, adminRoute('Reconnecting a Telegram session by hand', async (req, res) => {
  const target = await pool.query('SELECT id, email FROM users WHERE id=$1', [req.params.id]);
  if (!target.rows.length) return fail(res, 404, 'No workspace has that id, so there is no Telegram session to reconnect.');
  markApplied(req);
  try {
    const result = await forceTelegramReconnect(target.rows[0].id, {
      reason: String(req.body?.reason || 'manual-reconnect').slice(0, 160),
      actorId: req.userId,
      actorEmail: req.userEmail,
    });
    res.set('Cache-Control', 'no-store').json({ ok: true, ...result });
  } catch (error) {
    if (error.telegramNoSession) return fail(res, 409, `${error.message} The phone number has to sign in again from the workspace settings first.`);
    return fail(res, 502, `${error.message} Try again in a minute - if it keeps failing, the stored session has to be re-authorised.`);
  }
}));

app.post('/api/admin/users/:id/impersonate', authenticate, requireAdmin, asyncRoute(async (req, res) => {
  const targetId = String(req.params.id || '').trim();
  if (!UUID_PATTERN.test(targetId)) return fail(res, 400, 'Choose a valid user account.');
  let reason;
  try { reason = normalizeSupportReason(req.body?.reason); }
  catch (error) { return fail(res, error.status || 400, error.message); }

  const { rows } = await pool.query(`SELECT ${adminUserColumns} FROM users u WHERE u.id=$1 LIMIT 1`, [targetId]);
  const target = rows[0];
  try { assertAllowedImpersonation({ actorId: req.userId, target }); }
  catch (error) { return fail(res, error.status || 400, error.message); }

  const session = await supportSessions.start({ adminId: req.userId, userId: targetId, reason });
  let token;
  try {
    token = issueSupportToken(buildSupportClaims({
      sessionId: session.sessionId,
      jti: session.jti,
      adminId: req.userId,
      adminEmail: req.userEmail,
      userId: targetId,
      userEmail: target.email,
    }));
  } catch (error) {
    await supportSessions.stop({ sessionId: session.sessionId }).catch(() => {});
    log('error', 'Support session token could not be signed', { code: error.code || 'SUPPORT_TOKEN_FAILED' });
    return fail(res, 500, 'Support access is not available on this server right now.');
  }
  await auditLog.record({
    actorId: req.userId,
    actorEmail: req.userEmail,
    action: 'impersonation.start',
    targetType: 'user',
    targetId,
    summary: `Opened a ${session.ttlMinutes}-minute read-only support session on ${target.email}. Reason: ${reason}`,
    metadata: { sessionId: session.sessionId, reason, expiresAt: session.expiresAt },
  });
  log('warn', 'Admin opened a support session', { actorId: req.userId, targetId, sessionId: session.sessionId });
  res.set('Cache-Control', 'no-store').status(201).json({
    token,
    sessionId: session.sessionId,
    expiresAt: session.expiresAt,
    minutes: session.ttlMinutes,
    readOnly: true,
    user: { id: target.id, name: target.name, email: target.email },
    notice: 'Read-only support view: signals, settings, and account state as this workspace sees them, with no ability to change anything.',
  });
}));

app.get('/api/admin/support-sessions', authenticate, requireAdmin, asyncRoute(async (req, res) => {
  const rawLimit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 25));
  const rawOffset = Math.max(0, Number.parseInt(req.query.offset, 10) || 0);
  res.set('Cache-Control', 'no-store').json(await supportSessions.list({ limit: rawLimit, offset: rawOffset }));
}));

app.post('/api/admin/support/stop', authenticate, requireAdmin, asyncRoute(async (req, res) => {
  const sessionId = String(req.body?.sessionId || '').trim();
  if (!UUID_PATTERN.test(sessionId)) return fail(res, 400, 'Choose a support session to close.');
  const result = await supportSessions.stop({ sessionId, adminId: req.userId });
  disconnectSupportSockets(sessionId);
  if (!result.revoked) return fail(res, 404, 'That support session is already closed.');
  await auditLog.record({
    actorId: req.userId,
    actorEmail: req.userEmail,
    action: 'impersonation.stop',
    targetType: 'support_session',
    targetId: sessionId,
    summary: 'Closed a support session early.',
    metadata: { sessionId },
  });
  res.set('Cache-Control', 'no-store').json({ ok: true, sessionId });
}));

/**
 * Lets the person holding the support token close their own session without needing the admin
 * token again - it is the one write a support session is allowed to perform, and it can only
 * revoke the session it is already inside.
 */
app.post('/api/auth/support/exit', authenticate, asyncRoute(async (req, res) => {
  if (!req.supportSessionId) return fail(res, 400, 'This is not a support session.');
  const result = await supportSessions.stop({ sessionId: req.supportSessionId, adminId: req.impersonatedBy });
  disconnectSupportSockets(req.supportSessionId);
  res.set('Cache-Control', 'no-store').json({ ok: true, revoked: result.revoked });
}));

/* --------------------------- Admin: manual adjustments ---------------------------
 * Support needs to hand out a plan or buy time on an existing one without touching Flutterwave.
 * `users` carries the plan the product enforces, `subscriptions` carries the period the expiry
 * sweeps read, so both are written together inside one transaction and the response always
 * reports the provider situation instead of implying this cancels a real subscription.
 */
const PLAN_PERIOD_INTERVALS = Object.freeze({
  daily: '1 day', weekly: '7 days', monthly: '1 month', quarterly: '3 months', biannually: '6 months', annually: '1 year',
});
const MANUAL_SUBSCRIPTION_ACTIONS = Object.freeze({ free: 'subscription.clear', grant: 'subscription.grant', extend: 'subscription.extend' });

function planPeriodInterval(interval) {
  return PLAN_PERIOD_INTERVALS[String(interval || '').trim().toLowerCase()] || '1 month';
}

function planDisplayName(plan) {
  return String(plan?.name || plan?.key || 'the plan');
}

function dateLabel(value) {
  if (!value) return 'no end date';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'no end date' : date.toISOString().slice(0, 10);
}

app.patch('/api/admin/users/:id/subscription', authenticate, requireAdmin, adminRoute('Adjusting that plan', async (req, res) => {
  const targetId = String(req.params.id || '').trim();
  if (!UUID_PATTERN.test(targetId)) return fail(res, 400, 'Choose a valid user account.');
  let adjustment;
  try { adjustment = normalizeSubscriptionAdjustment(req.body || {}, { plans: flutterwaveConfig.plans }); }
  catch (error) { return fail(res, error.status || 400, error.message); }

  const { rows: targetRows } = await pool.query(`SELECT ${adminUserColumns} FROM users u WHERE u.id=$1 LIMIT 1`, [targetId]);
  const target = targetRows[0];
  if (!target) return fail(res, 404, 'That user could not be found.');
  const plan = adjustment.planKey && adjustment.planKey !== 'free' ? findPlan(flutterwaveConfig, adjustment.planKey) : null;
  if (adjustment.planKey && adjustment.planKey !== 'free' && !plan) {
    return fail(res, 400, 'That plan is not available in the live catalogue.');
  }
  const extending = adjustment.days !== null || Boolean(adjustment.endsAt);
  const { rows: existingRows } = await pool.query(
    'SELECT id,plan_key AS "planKey",status,current_period_end AS "periodEnd",provider_subscription_code AS "providerSubscriptionCode" FROM subscriptions WHERE user_id=$1 LIMIT 1',
    [targetId],
  );
  const existing = existingRows[0] || null;
  if (!adjustment.planKey && !existing) {
    return fail(res, 409, 'That workspace has no subscription record to extend yet, so there is no expiry date to move. Grant a plan first.');
  }

  const entries = [];
  let periodEnd = existing?.periodEnd || null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (adjustment.planKey === 'free') {
      const released = buildSubscriptionReleaseStatements({ targetId, limits: FREE_PLAN.limits });
      await client.query(released.userUpdate.sql, released.userUpdate.params);
      await client.query(released.subscription.sql, released.subscription.params);
      entries.push({
        action: MANUAL_SUBSCRIPTION_ACTIONS.free,
        summary: `Moved ${target.email} to Free, ending the ${target.subscriptionPlan || 'paid'} plan. Reason: ${adjustment.reason}`,
        metadata: { previousPlan: target.subscriptionPlan, reason: adjustment.reason },
      });
    } else if (plan) {
      // A grant with an explicit period honours that period instead of the plan's own interval,
      // so "Pro for 14 days" means fourteen days and not a month plus two weeks - and the choice is
      // one COALESCE that always references both bindings, so no branch can supply a value the
      // statement has no slot for.
      const granted = buildSubscriptionGrantStatements({
        targetId,
        plan,
        limits: plan.limits || {},
        interval: flutterwaveConfig.interval,
        period: adjustment.days ? `${adjustment.days} days` : planPeriodInterval(flutterwaveConfig.interval),
        endsAt: adjustment.endsAt,
      });
      await client.query(granted.userUpdate.sql, granted.userUpdate.params);
      const { rows: upserted } = await client.query(granted.subscription.sql, granted.subscription.params);
      periodEnd = upserted[0]?.periodEnd || periodEnd;
      entries.push({
        action: MANUAL_SUBSCRIPTION_ACTIONS.grant,
        summary: `Granted ${planDisplayName(plan)} to ${target.email} for free until ${dateLabel(periodEnd)}. Reason: ${adjustment.reason}`,
        metadata: { previousPlan: target.subscriptionPlan, planKey: plan.key, days: adjustment.days, endsAt: adjustment.endsAt, reason: adjustment.reason, limits: plan.limits || null },
      });
    }
    if (extending && !plan) {
      const extendedStatement = buildSubscriptionExtendStatement({ targetId, days: adjustment.days, endsAt: adjustment.endsAt });
      const { rows: extended } = await client.query(extendedStatement.sql, extendedStatement.params);
      periodEnd = extended[0]?.periodEnd || periodEnd;
      entries.push({
        action: MANUAL_SUBSCRIPTION_ACTIONS.extend,
        summary: `Extended the subscription of ${target.email} ${adjustment.endsAt ? `to ${dateLabel(periodEnd)}` : `by ${adjustment.days} day${adjustment.days === 1 ? '' : 's'}, now ${dateLabel(periodEnd)}`}. Reason: ${adjustment.reason}`,
        metadata: { days: adjustment.days, endsAt: adjustment.endsAt, reason: adjustment.reason, periodEnd: periodEnd || null },
      });
    }
    // The mirror on `users` is what the product enforces, so it is always re-derived from the
    // subscription row rather than written twice from two different ideas of the truth.
    const { rows: syncedRows } = await client.query(
      'SELECT plan_key AS "planKey",status,current_period_end AS "periodEnd",cancel_at_period_end AS "cancelAtPeriodEnd",interval FROM subscriptions WHERE user_id=$1 LIMIT 1',
      [targetId],
    );
    const synced = syncedRows[0] || null;
    if (synced) {
      const limits = findPlan(flutterwaveConfig, synced.planKey)?.limits || FREE_PLAN.limits;
      const mirror = buildSubscriptionMirrorStatement({ targetId, status: synced.status, planKey: synced.planKey, limits });
      await client.query(mirror.sql, mirror.params);
      periodEnd = synced.periodEnd;
    }
    await client.query('COMMIT');
    // Everything this route wrote is committed here, so a failure after this point - the read-back,
    // the audit entries - must not be reported as though the adjustment had been rolled back.
    markApplied(req);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  // Only after the commit: an audit row describes what actually happened, and a failed audit
  // write must never look like it could roll the adjustment back.
  for (const entry of entries) {
    await auditLog.record({ actorId: req.userId, actorEmail: req.userEmail, targetType: 'user', targetId, ...entry });
  }

  const { rows: updatedRows } = await pool.query(`SELECT ${adminUserColumns} FROM users u WHERE u.id=$1`, [targetId]);
  log('info', 'Admin adjusted a subscription manually', { actorId: req.userId, targetId, planKey: adjustment.planKey, days: adjustment.days });
  res.set('Cache-Control', 'no-store').json({
    user: updatedRows[0] || target,
    subscription: {
      planKey: updatedRows[0]?.subscriptionPlan || null,
      status: updatedRows[0]?.subscriptionStatus || null,
      periodEnd: periodEnd || null,
    },
    auditEntries: entries.length,
    notice: existing?.providerSubscriptionCode
      ? 'Flutterwave still bills on its own schedule: this moved the expiry Signal Desk enforces, not the payment plan. Cancel or resume the renewal in Payments if the charge should stop.'
      : 'Saved. No gateway charge was created by this adjustment.',
  });
}));

/* ------------------------- User-facing: announcement banner -------------------------
 * The dashboard asks for its own view, so a dismissed banner never comes back and a hidden one is
 * simply absent. A read failure yields an empty list rather than an error the user cannot act on.
 */
app.get('/api/announcements/active', authenticate, asyncRoute(async (req, res) => {
  const announcements = await announcementService.activeFor(req.userId).catch(() => null);
  res.set('Cache-Control', 'no-store').json({ announcements: announcements || [], unavailable: announcements === null });
}));

app.post('/api/announcements/:id/dismiss', authenticate, asyncRoute(async (req, res) => {
  const id = String(req.params.id || '').trim();
  if (!UUID_PATTERN.test(id)) return fail(res, 400, 'Choose a valid announcement.');
  const result = await announcementService.dismiss({ userId: req.userId, id });
  res.set('Cache-Control', 'no-store').json({ ok: true, dismissed: true, recorded: result.recorded });
}));

app.get('/api/telegram/status', authenticate, asyncRoute(async (req, res) => {
  const { rows } = await pool.query('SELECT telegram_connected FROM users WHERE id=$1', [req.userId]);
  const configured = Boolean(process.env.API_ID && process.env.API_HASH && process.env.SESSION_ENCRYPTION_KEY);
  let connected = Boolean(rows[0]?.telegram_connected && telegramAdapter.connectedFlag(telegramClients.get(req.userId)?.client));
  if (rows[0]?.telegram_connected && !connected && configured) {
    try { connected = Boolean(await restoreTelegramClient(req.userId)); } catch (error) { log('warn', 'Telegram session restore deferred', { userId: req.userId, error: error.message }); }
  }
  const entry = telegramClients.get(req.userId);
  // A connected client whose handler is not in GramJS's own list is the exact shape of the
  // silent-drop failure this workspace keeps hitting, so it is repaired here, before the answer is
  // composed, rather than being reported as a healthy session that receives nothing.
  if (telegramAdapter.connectedFlag(entry?.client) && (!entry.handler || !telegramCapture.handlerIsLive(entry.client, entry.handler))) await startTelegramListener(req.userId, entry.client).catch(() => {});
  const { rows: channelRows } = await pool.query('SELECT COUNT(*)::int AS count FROM channels WHERE user_id=$1 AND enabled=TRUE', [req.userId]);
  const stats = entry?.stats || {};
  res.json({
    configured,
    connected,
    listening: Boolean(telegramAdapter.connectedFlag(entry?.client) && entry.handler && telegramCapture.handlerIsLive(entry.client, entry.handler)),
    catchUpQueued: entry?.needsCatchUp === true,
    /* Set when the reconciliation ladder ran out of rungs: the stream is not slow, it is finished, and the fix is a
       sign-in. Phrased for the log and the panel and never for the trader UI, which has no idea what a `pts` is. */
    reauthRequired: entry?.reauthRequired === true,
    monitoredChannels: channelRows[0]?.count ?? 0,
    messagesSeen: Number(stats.seen) || 0,
    messagesIgnored: Number(stats.ignored) || 0,
    signalsSaved: Number(stats.saved) || 0,
    lastMessageAt: stats.lastAt || null,
    lastChatId: stats.lastChatId || null,
    lastError: stats.lastError || null,
    message: configured ? null : 'Telegram sign-in is temporarily unavailable. Please try again later.',
  });
}));
async function persistTelegramLoginAttempt(userId, attempt) {
  const stringSession = telegramAdapter.exportSessionString(attempt.client);
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
  if (inMemory?.client) await telegramAdapter.disconnect(inMemory.client).catch(() => {});
  telegramKeepAlive.release(inMemory?.client);
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
  const client = telegramAdapter.createClient({ sessionString: state.stringSession, apiId, apiHash: process.env.API_HASH, options: telegramAdapter.loginTransportOptions() });
  /* Guarded before it connects, exactly like the two capture clients, for the same reason and with the same
     narrow scope: `TelegramClient.js:1090` starts `_updateLoop` *inside* `connect()` - on the failed-connect
     branch as well as the good one - so a client that is only on screen for a code prompt still owns a ping loop
     that can print `Error: TIMEOUT` once every nine seconds to `console.error`, un-JSON-wrapped, for as long as
     the attempt lives. `attach` only counts that noise and answers the client's own logging gate for it; the
     handler GramJS hands it (`onError`) is not used by the sign-in flow, whose `onError` is a `signInWithPassword`
     argument (`client/auth.js:97`) and never reaches `client._errorHandler`. */
  telegramKeepAlive.attach(client, { userId });
  try { await telegramAdapter.connect(client); }
  catch (error) {
    await telegramAdapter.disconnect(client).catch(() => {});
    telegramKeepAlive.release(client);
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
  if (attempt?.client) await telegramAdapter.disconnect(attempt.client).catch(() => {});
  // The record goes with the client it describes, here and nowhere later: nothing else in this file will ever
  // hold this client again, so leaving it would make `guardedClients` climb one per abandoned login.
  telegramKeepAlive.release(attempt?.client);
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

  const client = telegramAdapter.createClient({ sessionString: '', apiId, apiHash: process.env.API_HASH, options: telegramAdapter.loginTransportOptions() });
  // Same rule as the restore path above, where the reason is written out: `connect()` starts the update loop, so
  // the guard has to be on the client before it, and this client can be waiting for a phone for five minutes.
  telegramKeepAlive.attach(client, { userId: req.userId });
  let sentToTelegram = false;
  try {
    await telegramAdapter.connect(client);
    const sent = await telegramAdapter.sendCode(client, { apiId, apiHash: process.env.API_HASH }, phoneNumber);
    sentToTelegram = true;
    if (!sent?.phoneCodeHash) {
      const error = new Error('Telegram did not return a phone code hash');
      error.errorMessage = 'PHONE_CODE_HASH_EMPTY';
      throw error;
    }
    const attempt = { client, phoneNumber, phoneCodeHash: sent.phoneCodeHash, expiresAt: Date.now() + 5 * 60_000 };
    await persistTelegramLoginAttempt(req.userId, attempt);
    const previous = telegramLogins.get(req.userId);
    if (previous?.client && previous.client !== client) {
      await telegramAdapter.disconnect(previous.client).catch(() => {});
      telegramKeepAlive.release(previous.client);
    }
    telegramLogins.set(req.userId, attempt);
    return res.json({ ok: true, message: 'Telegram sent a login code. Enter the newest code here to continue.' });
  } catch (error) {
    await telegramAdapter.disconnect(client).catch(() => {});
    telegramKeepAlive.release(client);
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
  const session = telegramAdapter.exportSessionString(attempt.client);
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
    const result = await telegramAdapter.invoke(attempt.client, telegramAdapter.createSignInRequest({
      phoneNumber: attempt.phoneNumber,
      phoneCodeHash: attempt.phoneCodeHash,
      phoneCode: code,
    }));
    if (telegramAdapter.isSignUpRequired(result)) {
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
    await telegramAdapter.signInWithPassword(
      attempt.client,
      { apiId: Number(process.env.API_ID), apiHash: process.env.API_HASH },
      {
        password,
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
  const dialogs = await telegramAdapter.getDialogs(client, { limit: 200 });
  const chats = dialogs
    .filter((dialog) => telegramAdapter.dialogIsChannelLike(dialog))
    .map((dialog) => ({
      channelId: telegramAdapter.dialogPeerIdText(dialog),
      title: telegramAdapter.dialogTitle(dialog) || 'Telegram chat',
      username: telegramAdapter.dialogUsername(dialog) || null,
      type: telegramAdapter.dialogIsGroupLike(dialog) ? 'Group' : 'Channel',
    }));
  res.json({ chats, limit: 200 });
}));
app.post('/api/telegram/disconnect', authenticate, asyncRoute(async (req, res) => {
  const current = telegramClients.get(req.userId);
  if (current?.client) await telegramAdapter.disconnect(current.client).catch(() => {});
  const login = telegramLogins.get(req.userId);
  if (login?.client) await telegramAdapter.disconnect(login.client).catch(() => {});
  telegramClients.delete(req.userId);
  telegramLogins.delete(req.userId);
  await pool.query('DELETE FROM telegram_login_attempts WHERE user_id=$1', [req.userId]);
  await pool.query('UPDATE users SET telegram_session=NULL,telegram_phone=NULL,telegram_connected=FALSE WHERE id=$1', [req.userId]);
  res.json({ ok: true });
}));

app.use((req, res) => res.status(404).json({ error: 'We could not find that page or action. Return to your workspace and try again.' }));
app.use((error, req, res, _next) => {
  /* An error with no status is an unexpected one: its message may name a table, a column, or a
     dependency, none of which belongs in a browser. So the message stays generic while the *where*
     is logged next to a short reference, and that same reference is returned. A user reporting
     "it failed" becomes a line that can be found in the service log, which is the difference
     between a reproducible defect and a screenshot. */
  const requestId = crypto.randomBytes(4).toString('hex');
  log('error', 'Request failed', {
    requestId,
    method: req.method,
    path: String(req.originalUrl || req.url || '').split('?')[0],
    status: Number(error.status) || 500,
    error: error.message,
    code: error.code,
    metaApiStatus: error.metaApiStatus,
    metaApiErrorCode: error.metaApiErrorCode,
    metaApiErrorType: error.metaApiErrorType,
    metaApiNetworkDiagnostic: error.metaApiNetworkDiagnostic,
  });
  if (res.headersSent) return;
  /**
   * The error body every route answers with.
   *
   * Written as a type because which fields may leave this process is the point of it: `error` is the only text a
   * trader is shown, `userMessage` is the only text a service is allowed to choose for that slot, and the four
   * `metaApi*` keys exist so a support ticket can be answered without reading a log - each added only when the
   * error actually carries it, and never a provider sentence forwarded verbatim.
   *
   * @typedef {Object} ErrorResponseBody
   * @property {string} error
   * @property {string} code
   * @property {string} requestId
   * @property {boolean} [upgradeRequired]
   * @property {string} [userMessage]
   * @property {number} [metaApiStatus]
   * @property {string} [metaApiErrorCode]
   * @property {string} [metaApiErrorType]
   * @property {string} [metaApiNetworkDiagnostic]
   */
  const payload = /** @type {ErrorResponseBody} */ ({
    error: error.status ? (typeof error.userMessage === 'string' ? error.userMessage : error.message) : 'Something went wrong. Please try again in a moment.',
    ...(error.code ? { code: error.code } : { code: 'UNEXPECTED' }),
    requestId,
    ...(error.upgradeRequired ? { upgradeRequired: true } : {}),
  });
  if (typeof error.userMessage === 'string') payload.userMessage = error.userMessage;
  if (Number.isInteger(error.metaApiStatus)) payload.metaApiStatus = error.metaApiStatus;
  if (typeof error.metaApiErrorCode === 'string') payload.metaApiErrorCode = error.metaApiErrorCode;
  if (typeof error.metaApiErrorType === 'string') payload.metaApiErrorType = error.metaApiErrorType;
  if (typeof error.metaApiNetworkDiagnostic === 'string') payload.metaApiNetworkDiagnostic = error.metaApiNetworkDiagnostic;
  res.status(error.status || 500).json(payload);
});

/** Opens the port and resolves once it is listening, so a bind failure is reported instead of thrown. */
const listen = () => new Promise((resolve, reject) => {
  const onError = (error) => reject(error);
  httpServer.once('error', onError);
  httpServer.listen(PORT, '0.0.0.0', () => {
    httpServer.removeListener('error', onError);
    log('info', 'Server listening', { port: PORT });
    /* Said out loud once, at boot, because a fallback layer that is silently absent is indistinguishable from
       a fallback layer that is not needed: a channel's malformed signal would be refused with no hint that a
       second reader exists to be turned on. */
    log(parserConfig.enabled ? 'info' : 'warn', parserConfig.enabled
      ? `[Parser] LLM fallback enabled (${parserConfig.model}).`
      : `[Parser] LLM Fallback disabled (${parserConfig.disabledReason}).`, { parsedBy: parserConfig.enabled ? 'regex+llm' : 'regex' });
    resolve();
  });
});

/**
 * Everything that needs the schema. Started once, after the migration has been applied.
 *
 * Each step is guarded on its own because they are not equally important: the worker is the part that
 * trades, so a housekeeping query that fails must not be able to leave it stopped, and the sweeps below are
 * already fire-and-forget. The `runtimeStarted` latch is what keeps a later retry of the migration from
 * arming a second interval or a second worker.
 */
async function beginRuntime() {
  if (boot.runtimeStarted) return;
  boot.runtimeStarted = true;
  executionWorker.start();
  await pool.query('DELETE FROM telegram_login_attempts WHERE expires_at <= NOW()')
    .catch((error) => log('warn', 'Could not clear expired login attempts', { error: error.message }));
  void billingService.expireDueSubscriptions().catch((error) => log('warn', 'Subscription expiry sweep failed', { code: error.code || 'SUBSCRIPTION_SWEEP_FAILED' }));
  const billingSweep = setInterval(() => {
    void billingService.expireDueSubscriptions().catch((error) => log('warn', 'Subscription expiry sweep failed', { code: error.code || 'SUBSCRIPTION_SWEEP_FAILED' }));
  }, 60 * 60 * 1000);
  billingSweep.unref?.();
  // Every six hours rather than once a day, because a free Render service sleeps: the
  // policy is driven by each user's last activity, so waking up late still acts correctly.
  if (inactivityConfig.enabled) {
    const runInactivitySweep = () => inactivityService.sweepOnce().then((summary) => {
      if (summary.warned || summary.deleted || summary.deferred || summary.failed) log('info', 'Inactivity sweep finished', summary);
      return summary;
    }).catch((error) => log('warn', 'Inactivity sweep failed', { code: error?.code || 'INACTIVITY_SWEEP_FAILED' }));
    void runInactivitySweep();
    const inactivitySweep = setInterval(() => { void runInactivitySweep(); }, 6 * 60 * 60 * 1000);
    inactivitySweep.unref?.();
  } else {
    log('warn', 'Idle MetaAPI account cleanup is disabled by configuration; provisioned accounts will accumulate', {});
  }
  // The listener is re-armed in the background, after the port is open: a workspace with a stored
  // session must be listening whether or not anyone opens the dashboard, and a Telegram handshake
  // must never be able to hold up the first request the host is woken for.
  /* The boot pass and the 60-second sweep share one guard, which is the pair that can actually overlap: boot
     restores every workspace serially, so on a host with many sessions it is still working long after the first
     tick of the interval, and before this the two passes each rebuilt every workspace they found not listening. */
  void telegramSweepGuard.run(() => resumeTelegramSessions({ reason: 'boot' }))
    .catch((error) => log('warn', 'Telegram session sweep failed', { error: error.message }));
  /* The keep-alive, on its own faster clock than everything else here.

     This is the part that keeps the connection *existing* rather than the part that notices it died: an idle
     MTProto session in this library sends no bytes at all until it has something to say, and an idle flow is
     what a hosting NAT evicts. One request per session per half-minute costs nothing at Telegram (the answer is
     the cheapest reply the API serves) and it is also the only measurement of `pts` movement we take - which is
     how a live transport with a dead update loop is told apart from a quiet channel. */
  void beatTelegramStreams({ reason: 'boot' });
  const telegramHeartbeat = setInterval(() => {
    void beatTelegramStreams({ reason: 'interval' });
  }, HEARTBEAT_INTERVAL_MS);
  telegramHeartbeat.unref?.();
  const telegramSweep = setInterval(() => {
    void telegramSweepGuard.run(async () => {
      await resumeTelegramSessions({ reason: 'sweep' });
      await rearmTelegramListeners();
      await checkTelegramStreams({ reason: 'sweep' });
    }).catch((error) => log('warn', 'Telegram listener sweep failed', { error: error.message }));
  }, TELEGRAM_SWEEP_INTERVAL_MS);
  telegramSweep.unref?.();
}

/**
 * The migration, retried until it lands.
 *
 * Failing here must not kill the process: the port is already open, the service is already answering
 * `/health`, and every data route is saying that it is starting. Exiting instead would trade a readable
 * degraded state for a crash loop whose only trace is a platform log about ports - which is the outage this
 * file is now written to prevent. Backoff is capped, because the common cause is a lock held by the
 * instance that is still serving traffic while a deploy waits to become healthy.
 */
async function bringUpDatabase() {
  for (let attempt = 1; ; attempt += 1) {
    boot.attempts = attempt;
    boot.step = `applying the schema (attempt ${attempt})`;
    try {
      const summary = await initializeDatabase({
        onStep: (step) => {
          boot.step = step.step === 'ready' ? 'ready' : step.step;
          if (step.total) boot.statements = step.total;
          if (step.step === 'waiting-for-lock') log('warn', 'A schema statement is waiting for a lock held by another session', step);
        },
      });
      boot.ready = true;
      boot.database = 'ok';
      boot.step = 'ready';
      boot.lastError = null;
      log('info', 'Schema ready', { statements: summary.statements, elapsedMs: summary.elapsedMs, attempts: attempt });
      boot.step = 'starting runtime';
      await beginRuntime().catch((error) => log('error', 'The schema is ready but a runtime step failed to start', { error: error.message }));
      return;
    } catch (error) {
      boot.database = 'unreachable';
      boot.step = 'schema failed';
      boot.lastError = error.message;
      const retryInMs = Math.min(BOOT_RETRY_BASE_MS * 2 ** (attempt - 1), BOOT_RETRY_MAX_MS);
      log('error', 'Startup could not prepare the database; the service is listening and will keep trying', {
        attempt,
        retryInMs,
        error: error.message,
        code: error.code,
      });
      await sleep(retryInMs);
    }
  }
}

async function start() {
  /* A missing URL or secret is a misconfiguration, not a slow dependency: there is nothing to retry and
     nothing to serve, so it fails fast and says which of the two it is. */
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) throw new Error('JWT_SECRET must contain at least 32 characters');
  await listen();
  void bringUpDatabase();
}
start().catch((error) => { log('error', 'Startup failed', { error: error.message }); process.exit(1); });

async function shutdown() {
  const serverClosed = new Promise((resolve) => {
    if (!httpServer.listening) return resolve();
    httpServer.close(resolve);
  });
  await executionWorker.stop();
  await serverClosed;
  for (const entry of telegramClients.values()) await telegramAdapter.disconnect(entry.client).catch(() => {});
  for (const entry of telegramLogins.values()) await telegramAdapter.disconnect(entry.client).catch(() => {});
  await tradingAdapter.close().catch(() => {});
  await pool.end().catch(() => {});
  process.exit(0);
}
/* Node ends the process on an unhandled rejection, and that is the right default for anything of ours. The one
   exception this installs is the provider's keep-alive timeout: `Error: TIMEOUT` from inside
   `telegram/client/updates.js`, which GramJS produces when its own ping does not come back, prints itself, and is
   recovered from by its own reconnect - a rejection of that shape is not a fault in this application, and a
   deploy should not restart because of it. Everything the predicate does not recognise is rethrown on the next
   tick, so it becomes the uncaught exception it would have been anyway: same crash, same stack. Suppressing at
   the printer is what stops the log flood; this is what stops the *process* from being killable by a ping, and
   the two are deliberately separate because they are two different risks. */
process.on('unhandledRejection', createUnhandledRejectionGuard({
  isNoise: isProviderKeepAliveTimeout,
  onNoise: (reason) => { telegramKeepAlive.observe(reason); },
  onOther: (reason) => { process.nextTick(() => { throw reason instanceof Error ? reason : new Error(`${reason}`); }); },
}));
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
