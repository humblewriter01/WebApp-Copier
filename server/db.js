import pg from 'pg';
import { createAdminAccess } from './services/admin.js';
import { withParameterChecks } from './services/query-params.js';
import { splitSchemaStatements, sqlPreview, withDeadline, timeoutSetting } from './services/schema-sql.js';

const { Pool } = pg;

/* The one pool this app owns, wrapped so every statement it carries is checked against its own
   placeholders before it is sent. A hand-assembled statement whose values and placeholders disagree
   otherwise fails deep in the driver with `bind message supplies N parameters, but prepared statement
   requires M`, which no route, log line, or test names. */
/**
 * Whether the pool must wrap its socket in TLS, inferred from the connection string it was given.
 *
 * The rule used to be `if the host is render.com`, which was true of the database this app was written
 * against and stopped being true the day the schema moved to Supabase. Encryption is not optional at most
 * managed hosts, and a server that requires it does not always say so: some answer the startup packet with
 * nothing at all, which is indistinguishable from a machine that is merely slow - no error, no log line,
 * and a process that waits forever before it ever binds a port. So TLS is on for any non-local host unless
 * the URL itself already chose, in which case the choice is the operator's and is left alone.
 */
export function resolvePoolSsl(connectionString, env = process.env) {
  const url = String(connectionString ?? '');
  if (!url) return undefined;
  // Whatever the operator put in the connection string wins, including `sslmode=disable` for a local
  // database and `sslmode=verify-full` for anyone who wants the certificate checked.
  if (/sslmode=|[?&]ssl=/.test(url)) return undefined;
  if (/@(localhost|127\.0\.0\.1|::1|\[::1\])(?::\d+)?[/?]/i.test(url)) return undefined;
  // Encryption without verification is what `sslmode=require` means, and it is what every documented
  // connection string for these hosts uses, so it is the setting this app can adopt without changing what
  // already works. Verification is one variable away for a deployment that wants it.
  const rejectUnauthorized = String(env?.PGSSL_VERIFY ?? '').toLowerCase() === 'true';
  return { rejectUnauthorized };
}

export const pool = withParameterChecks(new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: resolvePoolSsl(process.env.DATABASE_URL, process.env),
  max: Number(process.env.PG_POOL_MAX || 5),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
}), 'pool');

/* Everything below is one string, and Postgres receives it statement by statement, not as one query.
   Sending it as a single query would hold every lock it takes until the last statement commits, which is
   how a routine deploy turns into a stalled database that no request can get past.
   The text is also a template literal, so a backtick or a dollar-brace anywhere inside it - including in a
   comment - would end the string or interpolate into it. Quote identifiers in the comments below with
   nothing at all. */
const SCHEMA_SQL = `
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      telegram_session TEXT,
      telegram_phone TEXT,
      telegram_connected BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_login TIMESTAMPTZ
    );
    ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'user';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS supabase_user_id UUID;
    CREATE UNIQUE INDEX IF NOT EXISTS users_supabase_user_id_unique_idx ON users(supabase_user_id) WHERE supabase_user_id IS NOT NULL;
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_role_check' AND conrelid = 'users'::regclass) THEN
        ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('user', 'admin'));
      END IF;
    END $$;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_status TEXT NOT NULL DEFAULT 'free';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_plan TEXT NOT NULL DEFAULT 'free';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS plan_limits JSONB NOT NULL DEFAULT '{}'::jsonb;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS is_suspended BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS suspension_reason TEXT;
    CREATE TABLE IF NOT EXISTS channels (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      channel_id TEXT NOT NULL,
      title TEXT NOT NULL,
      username TEXT,
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(user_id, channel_id)
    );
    CREATE TABLE IF NOT EXISTS signals (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      channel_id TEXT,
      channel_title TEXT,
      message TEXT NOT NULL,
      symbol TEXT,
      side TEXT,
      entry_price NUMERIC,
      stop_loss NUMERIC,
      take_profit NUMERIC,
      status TEXT NOT NULL DEFAULT 'received',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS accounts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      label TEXT NOT NULL,
      broker TEXT,
      platform TEXT,
      account_reference TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS settings (
      user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      risk_mode TEXT NOT NULL DEFAULT 'fixed',
      risk_percent NUMERIC NOT NULL DEFAULT 1,
      max_open_positions INTEGER NOT NULL DEFAULT 5,
      daily_loss_limit NUMERIC NOT NULL DEFAULT 5,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS trades (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      signal_id UUID REFERENCES signals(id) ON DELETE SET NULL,
      symbol TEXT,
      side TEXT,
      quantity NUMERIC,
      entry_price NUMERIC,
      exit_price NUMERIC,
      pnl NUMERIC NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'paper',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS metaapi_credentials (
      user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      encrypted_api_token TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS metaapi_accounts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      metaapi_account_id TEXT NOT NULL,
      login TEXT,
      name TEXT,
      platform TEXT,
      state TEXT,
      server TEXT,
      managed_by_app BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(user_id, metaapi_account_id)
    );
    ALTER TABLE metaapi_accounts ADD COLUMN IF NOT EXISTS server TEXT;
    ALTER TABLE metaapi_accounts ADD COLUMN IF NOT EXISTS managed_by_app BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE signals ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'legacy';
    ALTER TABLE signals ADD COLUMN IF NOT EXISTS telegram_message_id TEXT;
    ALTER TABLE signals ADD COLUMN IF NOT EXISTS execution_ready BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE signals ADD COLUMN IF NOT EXISTS parse_error TEXT;
    ALTER TABLE settings ADD COLUMN IF NOT EXISTS auto_trading_enabled BOOLEAN NOT NULL DEFAULT TRUE;
    ALTER TABLE settings ALTER COLUMN auto_trading_enabled SET DEFAULT TRUE;
    ALTER TABLE settings ADD COLUMN IF NOT EXISTS lot_size_mode TEXT NOT NULL DEFAULT 'fixed';
    ALTER TABLE settings ADD COLUMN IF NOT EXISTS fixed_lot_size NUMERIC NOT NULL DEFAULT 0.01;
    ALTER TABLE settings ADD COLUMN IF NOT EXISTS max_daily_trades INTEGER NOT NULL DEFAULT 10;
    ALTER TABLE settings ADD COLUMN IF NOT EXISTS execution_account_id TEXT;
    CREATE TABLE IF NOT EXISTS execution_jobs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      signal_id UUID NOT NULL UNIQUE REFERENCES signals(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'queued',
      attempt_count INTEGER NOT NULL DEFAULT 0,
      locked_at TIMESTAMPTZ,
      expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '2 minutes'),
      error_message TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS daily_equity_snapshots (
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      metaapi_account_id TEXT NOT NULL,
      utc_date DATE NOT NULL,
      baseline_equity NUMERIC NOT NULL,
      captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY(user_id, metaapi_account_id, utc_date)
    );
    ALTER TABLE trades ADD COLUMN IF NOT EXISTS execution_job_id UUID;
    ALTER TABLE trades ADD COLUMN IF NOT EXISTS metaapi_account_id TEXT;
    ALTER TABLE trades ADD COLUMN IF NOT EXISTS stop_loss NUMERIC;
    ALTER TABLE trades ADD COLUMN IF NOT EXISTS take_profit NUMERIC;
    ALTER TABLE trades ADD COLUMN IF NOT EXISTS broker_order_id TEXT;
    ALTER TABLE trades ADD COLUMN IF NOT EXISTS broker_position_id TEXT;
    ALTER TABLE trades ADD COLUMN IF NOT EXISTS client_id TEXT;
    ALTER TABLE trades ADD COLUMN IF NOT EXISTS provider_response JSONB;
    ALTER TABLE trades ADD COLUMN IF NOT EXISTS error_message TEXT;
    ALTER TABLE trades ADD COLUMN IF NOT EXISTS executed_at TIMESTAMPTZ;
    CREATE UNIQUE INDEX IF NOT EXISTS trades_execution_job_unique_idx ON trades(execution_job_id) WHERE execution_job_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS signals_telegram_event_unique_idx
      ON signals(user_id,channel_id,telegram_message_id)
      WHERE source='telegram' AND channel_id IS NOT NULL AND telegram_message_id IS NOT NULL;
    /* A transient broker failure is retried, and the wait is the point: next_attempt_at is when the queue
     * may look at the job again, and the worker's claim refuses anything whose time has not come. It is a
     * column on the job rather than a timer in the process because a worker that restarts must not lose the
     * backoff - or, worse, resume without it and hammer a broker that had just asked it to stop.
     * No backticks in this comment, on purpose: it sits inside the template literal that holds the whole
     * schema, so a backtick here ends that string and the service dies at boot on a SyntaxError. */
    ALTER TABLE execution_jobs ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ;
    CREATE INDEX IF NOT EXISTS execution_jobs_ready_idx ON execution_jobs(status,created_at) WHERE status='queued';
    CREATE INDEX IF NOT EXISTS execution_jobs_backoff_idx ON execution_jobs(next_attempt_at) WHERE status='queued' AND next_attempt_at IS NOT NULL;
    /* The one sentence a user needs when their trading account cannot trade at all, kept on the account
     * rather than on each signal: it is the account that is broken, and every signal would otherwise
     * repeat the same explanation. Cleared by the engine the moment an order goes through, so a resolved
     * problem stops being announced. */
    ALTER TABLE metaapi_accounts ADD COLUMN IF NOT EXISTS execution_note TEXT;
    ALTER TABLE metaapi_accounts ADD COLUMN IF NOT EXISTS execution_note_at TIMESTAMPTZ;
    CREATE INDEX IF NOT EXISTS execution_jobs_stale_idx ON execution_jobs(status,locked_at) WHERE status='processing';
    CREATE INDEX IF NOT EXISTS trades_user_created_idx ON trades(user_id,created_at DESC);
    /* Break-even stop management for positions Signal Desk opened. One row per
     * broker position is the idempotency key: a terminal status means the stop is
     * never sent to the broker again, while deferred and failed rows carry the next
     * retry time so a sweep can never spam modify requests. */
    ALTER TABLE settings ADD COLUMN IF NOT EXISTS break_even_enabled BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE settings ADD COLUMN IF NOT EXISTS break_even_trigger_points NUMERIC NOT NULL DEFAULT 20;
    ALTER TABLE settings ADD COLUMN IF NOT EXISTS break_even_offset_points NUMERIC NOT NULL DEFAULT 0;
    /* A true trailing stop continues where break even stops: instead of parking the stop at
     * entry once, it keeps ratcheting the stop in the trade's favour at a fixed distance from
     * the market. It reuses the same sweep, the same freshness rules, and the same ledger, so
     * "never widen a stop" and "never act on a stale quote" are enforced once, not per mode. */
    ALTER TABLE settings ADD COLUMN IF NOT EXISTS trailing_stop_enabled BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE settings ADD COLUMN IF NOT EXISTS trailing_stop_distance_points NUMERIC NOT NULL DEFAULT 10;
    /* The signal row carries the reason nothing was sent to your broker, not just a status code,
     * so "saved but not executed" is explainable to the user long after the worker moved on.
     * Capture itself never depends on this: the message is stored before any of it is consulted. */
    ALTER TABLE signals ADD COLUMN IF NOT EXISTS execution_note TEXT;
    /* The live-trading warning is shown once per workspace and the answer is remembered here, so
     * the settings panel can keep a one-line reminder instead of a permanent wall of red. */
    ALTER TABLE settings ADD COLUMN IF NOT EXISTS has_accepted_risk_warning BOOLEAN NOT NULL DEFAULT FALSE;
    CREATE TABLE IF NOT EXISTS break_even_moves (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      trade_id UUID REFERENCES trades(id) ON DELETE SET NULL,
      metaapi_account_id TEXT NOT NULL,
      broker_position_id TEXT NOT NULL,
      symbol TEXT,
      side TEXT,
      open_price NUMERIC,
      trigger_points NUMERIC NOT NULL,
      offset_points NUMERIC NOT NULL,
      previous_stop_loss NUMERIC,
      stop_loss NUMERIC,
      status TEXT NOT NULL DEFAULT 'moved',
      attempt_count INTEGER NOT NULL DEFAULT 1,
      market_bid NUMERIC,
      market_ask NUMERIC,
      provider_response JSONB,
      error_message TEXT,
      next_attempt_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(user_id, metaapi_account_id, broker_position_id),
      CONSTRAINT break_even_moves_status_check CHECK (status IN ('moved', 'already_beyond', 'closed', 'deferred', 'failed', 'unknown'))
    );
    /* A trailing stop moves the same position more than once, so the row counts the moves and
     * records the distance it was decided under - an audit of the setting, not of intent. */
    ALTER TABLE break_even_moves ADD COLUMN IF NOT EXISTS move_count INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE break_even_moves ADD COLUMN IF NOT EXISTS trailing_distance_points NUMERIC;
    CREATE INDEX IF NOT EXISTS break_even_moves_retry_idx ON break_even_moves(status, next_attempt_at);
    ALTER TABLE break_even_moves ENABLE ROW LEVEL SECURITY;
    /* ---------------- scale-out on a signal that numbered its targets ----------------
     * A channel that writes TP 1 / TP 2 / TP 3 is publishing a plan for one trade, and a copier that
     * holds a single position has to decide what to do with the rest of it. The workspace's answer is a
     * setting; the ladder itself is stored with the signal, because re-reading the message at execution
     * time would let a parser change alter a trade someone had already reviewed.
     */
    ALTER TABLE signals ADD COLUMN IF NOT EXISTS take_profit_levels JSONB;
    ALTER TABLE settings ADD COLUMN IF NOT EXISTS multiple_target_handling TEXT NOT NULL DEFAULT 'first_target';
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'settings_multiple_target_handling_check' AND conrelid = 'settings'::regclass) THEN
        ALTER TABLE settings ADD CONSTRAINT settings_multiple_target_handling_check CHECK (multiple_target_handling IN ('first_target', 'final_target', 'scale_out'));
      END IF;
    END $$;
    /* The open trade's share of that plan. One row per numbered target, keyed by the trade it belongs
     * to, is what makes a partial close idempotent: 'submitting' means a call is in flight and nothing
     * may send it again, 'unknown' means the broker may already have closed it and a human has to look,
     * and a filled row keeps the stop-move it triggered retryable without re-closing any volume. */
    CREATE TABLE IF NOT EXISTS trade_tp_levels (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      trade_id UUID NOT NULL REFERENCES trades(id) ON DELETE CASCADE,
      metaapi_account_id TEXT NOT NULL,
      broker_position_id TEXT NOT NULL,
      symbol TEXT,
      side TEXT,
      level_index SMALLINT NOT NULL,
      target_price NUMERIC NOT NULL,
      close_percent SMALLINT NOT NULL DEFAULT 0,
      planned_volume NUMERIC,
      closed_volume NUMERIC NOT NULL DEFAULT 0,
      remaining_volume NUMERIC,
      break_even BOOLEAN NOT NULL DEFAULT FALSE,
      break_even_status TEXT,
      break_even_stop_loss NUMERIC,
      break_even_attempts INTEGER NOT NULL DEFAULT 0,
      break_even_error TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      attempt_count INTEGER NOT NULL DEFAULT 0,
      market_bid NUMERIC,
      market_ask NUMERIC,
      provider_response JSONB,
      error_message TEXT,
      next_attempt_at TIMESTAMPTZ,
      filled_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(trade_id, level_index),
      CONSTRAINT trade_tp_levels_status_check CHECK (status IN ('pending', 'submitting', 'filled', 'deferred', 'failed', 'unknown', 'skipped', 'closed')),
      CONSTRAINT trade_tp_levels_break_even_status_check CHECK (break_even_status IS NULL OR break_even_status IN ('pending', 'moved', 'already_beyond', 'deferred', 'failed', 'unknown')),
      CONSTRAINT trade_tp_levels_percent_check CHECK (close_percent >= 0 AND close_percent <= 100)
    );
    CREATE INDEX IF NOT EXISTS trade_tp_levels_sweep_idx ON trade_tp_levels(status, next_attempt_at) WHERE status IN ('pending', 'submitting', 'deferred', 'failed');
    CREATE INDEX IF NOT EXISTS trade_tp_levels_trade_idx ON trade_tp_levels(trade_id, level_index);
    /* A trade whose size has been cut down by a partial close. NULL means nothing has been closed yet,
     * which is the difference between "full size still open" and "we lost count of the plan". */
    ALTER TABLE trades ADD COLUMN IF NOT EXISTS remaining_volume NUMERIC;
    ALTER TABLE trade_tp_levels ENABLE ROW LEVEL SECURITY;
    /* Inactivity cleanup for MetaAPI accounts the workspace pays for. */
    ALTER TABLE users ADD COLUMN IF NOT EXISTS last_active_at TIMESTAMPTZ;
    UPDATE users SET last_active_at = COALESCE(last_login, created_at, NOW()) WHERE last_active_at IS NULL;
    ALTER TABLE metaapi_accounts ADD COLUMN IF NOT EXISTS inactivity_status TEXT NOT NULL DEFAULT 'none';
    ALTER TABLE metaapi_accounts ADD COLUMN IF NOT EXISTS inactivity_for TIMESTAMPTZ;
    ALTER TABLE metaapi_accounts ADD COLUMN IF NOT EXISTS inactivity_checked_at TIMESTAMPTZ;
    ALTER TABLE metaapi_accounts ADD COLUMN IF NOT EXISTS inactivity_reason TEXT;
    ALTER TABLE metaapi_accounts ADD COLUMN IF NOT EXISTS inactivity_attempts INTEGER NOT NULL DEFAULT 0;
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'metaapi_accounts_inactivity_status_check' AND conrelid = 'metaapi_accounts'::regclass) THEN
        ALTER TABLE metaapi_accounts ADD CONSTRAINT metaapi_accounts_inactivity_status_check CHECK (inactivity_status IN ('none', 'warned', 'deferred', 'failed'));
      END IF;
    END $$;
    CREATE INDEX IF NOT EXISTS metaapi_accounts_inactivity_idx ON metaapi_accounts(inactivity_status, inactivity_checked_at) WHERE managed_by_app = TRUE;
    CREATE TABLE IF NOT EXISTS account_activity_notices (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      metaapi_account_id TEXT,
      kind TEXT NOT NULL,
      days_inactive INTEGER NOT NULL DEFAULT 0,
      account_name TEXT,
      message TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT account_activity_notices_kind_check CHECK (kind IN ('warning', 'deferred', 'deleted', 'failed'))
    );
    CREATE INDEX IF NOT EXISTS account_activity_notices_user_idx ON account_activity_notices(user_id, created_at DESC);
    ALTER TABLE account_activity_notices ENABLE ROW LEVEL SECURITY;
    CREATE TABLE IF NOT EXISTS telegram_login_attempts (
      user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      encrypted_state TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS admin_settings (
      setting_key TEXT PRIMARY KEY,
      setting_value JSONB NOT NULL,
      description TEXT,
      updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS promo_codes (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      code TEXT NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9][A-Z0-9_-]{2,49}$'),
      discount_type TEXT NOT NULL CHECK (discount_type IN ('percentage', 'fixed')),
      discount_value NUMERIC NOT NULL CHECK (discount_value > 0),
      max_uses INTEGER CHECK (max_uses IS NULL OR max_uses > 0),
      current_uses INTEGER NOT NULL DEFAULT 0 CHECK (current_uses >= 0),
      expires_at TIMESTAMPTZ,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_by UUID REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT promo_codes_percentage_max CHECK (discount_type <> 'percentage' OR discount_value <= 100)
    );
    CREATE TABLE IF NOT EXISTS password_reset_tokens (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TIMESTAMPTZ NOT NULL,
      used_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS subscriptions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
      plan_key TEXT NOT NULL DEFAULT 'free',
      status TEXT NOT NULL DEFAULT 'free',
      interval TEXT NOT NULL DEFAULT 'monthly',
      current_period_end TIMESTAMPTZ,
      cancel_at_period_end BOOLEAN NOT NULL DEFAULT FALSE,
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      canceled_at TIMESTAMPTZ,
      provider TEXT,
      provider_reference TEXT,
      promo_code TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT subscriptions_plan_check CHECK (plan_key IN ('free', 'pro', 'premium')),
      CONSTRAINT subscriptions_status_check CHECK (status IN ('free', 'active', 'non_renewing', 'attention', 'past_due', 'canceled'))
    );
    CREATE TABLE IF NOT EXISTS billing_transactions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      reference TEXT NOT NULL UNIQUE,
      provider TEXT NOT NULL DEFAULT 'paystack',
      plan_key TEXT NOT NULL,
      promo_code_id UUID REFERENCES promo_codes(id) ON DELETE SET NULL,
      promo_code TEXT,
      amount_minor BIGINT NOT NULL CHECK (amount_minor >= 0),
      discount_minor BIGINT NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT 'NGN',
      status TEXT NOT NULL DEFAULT 'pending',
      authorization_url TEXT,
      access_code TEXT,
      channel TEXT,
      gateway_response TEXT,
      paid_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT billing_transactions_status_check CHECK (status IN ('pending', 'success', 'failed', 'abandoned', 'reversed', 'refunded'))
    );
    ALTER TABLE billing_transactions ADD COLUMN IF NOT EXISTS plan_code TEXT;
    ALTER TABLE billing_transactions ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'checkout';
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'billing_transactions_source_check' AND conrelid = 'billing_transactions'::regclass) THEN
        ALTER TABLE billing_transactions ADD CONSTRAINT billing_transactions_source_check CHECK (source IN ('checkout', 'renewal', 'manual'));
      END IF;
    END $$;
    ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS provider_subscription_code TEXT;
    CREATE INDEX IF NOT EXISTS billing_transactions_user_created_idx ON billing_transactions(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS billing_transactions_pending_idx ON billing_transactions(status, created_at) WHERE status='pending';
    CREATE INDEX IF NOT EXISTS subscriptions_period_end_idx ON subscriptions(status, current_period_end);
    CREATE INDEX IF NOT EXISTS billing_transactions_source_idx ON billing_transactions(source, created_at DESC);
    CREATE INDEX IF NOT EXISTS subscriptions_provider_code_idx ON subscriptions(provider_subscription_code) WHERE provider_subscription_code IS NOT NULL;
    ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
    ALTER TABLE billing_transactions ENABLE ROW LEVEL SECURITY;
    ALTER TABLE admin_settings ENABLE ROW LEVEL SECURITY;
    ALTER TABLE promo_codes ENABLE ROW LEVEL SECURITY;
    ALTER TABLE password_reset_tokens ENABLE ROW LEVEL SECURITY;
    CREATE INDEX IF NOT EXISTS signals_user_created_idx ON signals(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS channels_user_enabled_idx ON channels(user_id, enabled);
    CREATE INDEX IF NOT EXISTS metaapi_accounts_user_created_idx ON metaapi_accounts(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS telegram_login_attempts_expiry_idx ON telegram_login_attempts(expires_at);
    CREATE INDEX IF NOT EXISTS password_reset_tokens_user_expiry_idx ON password_reset_tokens(user_id, expires_at DESC);
    CREATE INDEX IF NOT EXISTS promo_codes_active_expiry_idx ON promo_codes(active, expires_at);
    ALTER TABLE metaapi_credentials ENABLE ROW LEVEL SECURITY;
    ALTER TABLE metaapi_accounts ENABLE ROW LEVEL SECURITY;
    ALTER TABLE telegram_login_attempts ENABLE ROW LEVEL SECURITY;
    /* The Starter tier is purchasable, so its plan key has to survive the subscription
     * mirror; the check predates the tier and would reject the row during webhook
     * activation. Replacing the constraint is idempotent and never loses data. */
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'subscriptions_plan_check' AND conrelid = 'subscriptions'::regclass) THEN
        ALTER TABLE subscriptions DROP CONSTRAINT subscriptions_plan_check;
      END IF;
    END $$;
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'subscriptions_plan_check' AND conrelid = 'subscriptions'::regclass) THEN
        ALTER TABLE subscriptions ADD CONSTRAINT subscriptions_plan_check CHECK (plan_key IN ('free', 'starter', 'pro', 'premium'));
      END IF;
    END $$;
    /* ---------------- platform administration ---------------- */
    /* Every administrator mutation appends one row here: the action, the admin's email as it
     * was at the time (denormalised on purpose - an audit trail must not change when the
     * account behind it is renamed or deleted), and the timestamp. Metadata is scrubbed of
     * credential-shaped keys before it is stored. Nothing in the app deletes these rows. */
    CREATE TABLE IF NOT EXISTS admin_audit_logs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
      actor_email TEXT NOT NULL,
      action TEXT NOT NULL,
      target_type TEXT,
      target_id TEXT,
      summary TEXT NOT NULL,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS admin_audit_logs_created_idx ON admin_audit_logs(created_at DESC);
    CREATE INDEX IF NOT EXISTS admin_audit_logs_action_idx ON admin_audit_logs(action,created_at DESC);
    CREATE INDEX IF NOT EXISTS admin_audit_logs_actor_idx ON admin_audit_logs(actor_id,created_at DESC);
    ALTER TABLE admin_audit_logs ENABLE ROW LEVEL SECURITY;
    /* One global banner at a time is the intent, but several rows may be scheduled, so the
     * user-facing query picks the newest live one and dismissal is stored per user. */
    CREATE TABLE IF NOT EXISTS announcements (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      message TEXT NOT NULL CHECK (char_length(message) BETWEEN 4 AND 500),
      level TEXT NOT NULL DEFAULT 'info',
      active BOOLEAN NOT NULL DEFAULT TRUE,
      starts_at TIMESTAMPTZ,
      ends_at TIMESTAMPTZ,
      created_by UUID REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT announcements_level_check CHECK (level IN ('info', 'warning', 'critical')),
      CONSTRAINT announcements_window_check CHECK (ends_at IS NULL OR starts_at IS NULL OR ends_at > starts_at)
    );
    CREATE INDEX IF NOT EXISTS announcements_active_idx ON announcements(active,created_at DESC);
    ALTER TABLE announcements ENABLE ROW LEVEL SECURITY;
    CREATE TABLE IF NOT EXISTS announcement_dismissals (
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      announcement_id UUID NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
      dismissed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY(user_id,announcement_id)
    );
    ALTER TABLE announcement_dismissals ENABLE ROW LEVEL SECURITY;
    /* Support ("impersonation") sessions. Only the SHA-256 hash of the token identifier is
     * stored, never the token itself, so the database cannot be used to replay a session;
     * revoking the row cuts a live token off immediately, and the row also carries the hard
     * one-hour expiry independently of the signed token. */
    CREATE TABLE IF NOT EXISTS support_sessions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      token_hash TEXT NOT NULL UNIQUE,
      admin_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      reason TEXT,
      revoked_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL,
      CONSTRAINT support_sessions_expiry_after_creation CHECK (expires_at > created_at)
    );
    CREATE INDEX IF NOT EXISTS support_sessions_user_idx ON support_sessions(user_id,created_at DESC);
    CREATE INDEX IF NOT EXISTS support_sessions_live_idx ON support_sessions(expires_at) WHERE revoked_at IS NULL;
    ALTER TABLE support_sessions ENABLE ROW LEVEL SECURITY;
    /* A direction that was read off the prices instead of written down is stored as derived, so the
     * Signals page can badge it and the execution path can keep refusing it. Nothing inferred is ever
     * traded as though the channel had said it. */
    ALTER TABLE signals ADD COLUMN IF NOT EXISTS direction_inferred BOOLEAN NOT NULL DEFAULT FALSE;
    /* Signals are now deletable, by their owner and by an administrator, so both the age sweep and the
     * unlink of a trade that was placed from a deleted signal need an index to be a cheap statement
     * rather than a table scan on the largest table in the workspace. */
    CREATE INDEX IF NOT EXISTS signals_created_at_idx ON signals(created_at);
    CREATE INDEX IF NOT EXISTS trades_signal_idx ON trades(signal_id) WHERE signal_id IS NOT NULL;
    /* Advanced Safety: a workspace can require a stop loss on every automatic order, which is the
     * default and the behaviour the parser has always enforced, or allow an order out without one.
     * Turning it off changes what is sent to the broker, so it is stored beside the other execution
     * limits and read on every capture instead of being remembered in memory. */
    ALTER TABLE settings ADD COLUMN IF NOT EXISTS block_execution_without_stop_loss BOOLEAN NOT NULL DEFAULT TRUE;
    /* Fallback safety nets. A provider that forgets a stop is not a reason to trade naked, so a
     * workspace may state its own distance - in broker points, the same unit as the break-even and
     * trailing settings - which is applied to whichever leg the signal did not carry. NULL means "no
     * net", which is every workspace's starting state, and a distance is validated by the settings
     * route rather than clamped here, so a typo can never silently become somebody's stop. */
    ALTER TABLE settings ADD COLUMN IF NOT EXISTS fallback_stop_loss_points NUMERIC;
    ALTER TABLE settings ADD COLUMN IF NOT EXISTS fallback_take_profit_points NUMERIC;
    ALTER TABLE settings ADD COLUMN IF NOT EXISTS block_execution_without_take_profit BOOLEAN NOT NULL DEFAULT TRUE;
    /* Where a number on the row came from. needs_review is the gate the execution path reads: a row can be
     * complete, well-formed and still untrustworthy, and the flag is what keeps a signal the platform could
     * only guess at away from a live account even when the workspace has fallback distances set.
     * parsed_by, parse_confidence and llm_used are the provenance beside it, so a reader can tell a price the
     * channel wrote from a price a model reported. The two pip columns store a distance the message stated
     * (TP 50 pips), never a price, because the broker's tick size is the only honest converter and it is not
     * known until the order is built.
     * Every column is nullable with no default, on purpose: a table default would backfill every existing
     * workspace with a fallback distance, and a workspace that never asked for a safety net must not be given
     * one by an upgrade. */
    ALTER TABLE signals ADD COLUMN IF NOT EXISTS needs_review BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE signals ADD COLUMN IF NOT EXISTS parsed_by TEXT NOT NULL DEFAULT 'regex';
    ALTER TABLE signals ADD COLUMN IF NOT EXISTS parse_confidence NUMERIC;
    ALTER TABLE signals ADD COLUMN IF NOT EXISTS llm_used BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE signals ADD COLUMN IF NOT EXISTS stop_loss_pips NUMERIC;
    ALTER TABLE signals ADD COLUMN IF NOT EXISTS take_profit_pips NUMERIC;
    /* New workspaces start with a net, existing ones do not: DEFAULT on the column is what makes that
     * distinction without touching a single stored row, because the signup insert omits both columns. */
    ALTER TABLE settings ALTER COLUMN fallback_stop_loss_points SET DEFAULT 500;
    ALTER TABLE settings ALTER COLUMN fallback_take_profit_points SET DEFAULT 1000;
    /* ---------------- what kind of order a signal is, and how long it lives ----------------
     * Until now every executable signal was a market order, because that was the only kind this product
     * could send. A channel that publishes 'BUY GOLD LIMIT 4011' is asking for a resting order at 4011, and
     * filling it at the current price is a different trade - so the type is read from the message and stored
     * on the row, rather than re-derived at execution time where a parser change could quietly alter a trade
     * somebody had already reviewed (the same reason the target ladder is stored).
     *
     * DEFAULT 'market' on every row is not a convenience: it is what keeps the several hundred signals this
     * product has already executed from being re-read as pending orders by any code that looks at history.
     * expiry_timestamp is NULL for a market order and for anything that never reached a broker; on a resting
     * order it is the deadline both this app and the platform were told about, and the sweeper's only cue.
     * max_slippage_points is nullable with no default on purpose, like the fallback distances above: an unset
     * drift guard means "never fill worse than the published price", which is the behaviour every existing
     * workspace already has, and a table default would have quietly loosened it for all of them.
     */
    ALTER TABLE signals ADD COLUMN IF NOT EXISTS order_type TEXT NOT NULL DEFAULT 'market';
    /* Whether the channel asked for that order type or the shape of the message implied it. Kept because the
     * difference is a fact about the trade, not a detail: 'GOLD SELL 4024' never asked to be a limit order,
     * Signal Desk read it that way because a published price is a price the trader meant to get, and a
     * reviewer looking at a resting order is entitled to know which of the two it was. 'direction_inferred'
     * is the same idea, already on this table. */
    ALTER TABLE signals ADD COLUMN IF NOT EXISTS order_type_stated BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE signals ADD COLUMN IF NOT EXISTS is_scalping BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE signals ADD COLUMN IF NOT EXISTS expiry_timestamp TIMESTAMPTZ;
    ALTER TABLE trades ADD COLUMN IF NOT EXISTS order_type TEXT NOT NULL DEFAULT 'market';
    ALTER TABLE trades ADD COLUMN IF NOT EXISTS expiry_timestamp TIMESTAMPTZ;
    ALTER TABLE trades ADD COLUMN IF NOT EXISTS drift_points NUMERIC;
    ALTER TABLE settings ADD COLUMN IF NOT EXISTS limit_order_expiry_value INTEGER NOT NULL DEFAULT 30;
    ALTER TABLE settings ADD COLUMN IF NOT EXISTS limit_order_expiry_unit TEXT NOT NULL DEFAULT 'minutes';
    ALTER TABLE settings ADD COLUMN IF NOT EXISTS max_slippage_points NUMERIC;
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'settings_limit_order_expiry_unit_check' AND conrelid = 'settings'::regclass) THEN
        ALTER TABLE settings ADD CONSTRAINT settings_limit_order_expiry_unit_check CHECK (limit_order_expiry_unit IN ('minutes', 'hours', 'days'));
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'signals_order_type_check' AND conrelid = 'signals'::regclass) THEN
        ALTER TABLE signals ADD CONSTRAINT signals_order_type_check CHECK (order_type IN ('market', 'limit', 'stop'));
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'trades_order_type_check' AND conrelid = 'trades'::regclass) THEN
        ALTER TABLE trades ADD CONSTRAINT trades_order_type_check CHECK (order_type IN ('market', 'limit', 'stop'));
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'settings_limit_order_expiry_value_check' AND conrelid = 'settings'::regclass) THEN
        ALTER TABLE settings ADD CONSTRAINT settings_limit_order_expiry_value_check CHECK (limit_order_expiry_value BETWEEN 1 AND 43200);
      END IF;
    END $$;
    /* The sweep that cancels expired orders and notices the ones the user deleted by hand runs every minute
     * against a table that is mostly history. A partial index on the live rows is the difference between a
     * cheap lookup and a scan of every trade the workspace has ever made. */
    CREATE INDEX IF NOT EXISTS trades_pending_expiry_idx ON trades(expiry_timestamp) WHERE status = 'pending';
`;

/** The schema exactly as it will be sent: one entry per statement, in the order it is written above. */
export function schemaStatements() {
  return splitSchemaStatements(SCHEMA_SQL);
}

/* How long one statement may queue for a lock, how many times it tries, and how long the whole connection
   may take to establish itself. The numbers are small on purpose: an application that waits briefly and
   then says what it was waiting for is diagnosable, and one that waits indefinitely is only a mystery with
   a longer timeout. A `lock_timeout` also ends the pile-up rather than adding to it - a migration that
   cannot get its lock walks away, so the reads that were queued behind it get their turn. */
const LOCK_TIMEOUT_MS = Number(process.env.PG_MIGRATION_LOCK_TIMEOUT_MS || 5_000);
const STATEMENT_TIMEOUT_MS = Number(process.env.PG_MIGRATION_STATEMENT_TIMEOUT_MS || 120_000);
const LOCK_ATTEMPTS = Math.max(1, Number(process.env.PG_MIGRATION_LOCK_ATTEMPTS || 3));
const CONNECT_TIMEOUT_MS = Number(process.env.PG_BOOT_CONNECT_TIMEOUT_MS || 10_000);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Postgres saying "the lock did not arrive in time", which is a reason to try again, not to give up. */
function isLockWaitFailure(error) {
  return error?.code === '55P03' || error?.code === '40P01' || /lock timeout|deadlock detected/i.test(String(error?.message ?? ''));
}

/** An error that names its own statement, because "the schema failed" is not an answer anyone can act on. */
function nameSchemaError(error, { statement, position, total, attempts }) {
  const reason = attempts > 1 ? `never got the lock it needed after ${attempts} attempts` : 'failed';
  error.message = `Schema statement ${position + 1} of ${total} ${reason}: ${sqlPreview(statement)} - ${error.message}`;
  error.schemaStatement = sqlPreview(statement);
  error.schemaStatementIndex = position;
  error.code = error.code || 'SCHEMA_STATEMENT_FAILED';
  return error;
}

async function runStatement(client, statement, position, total, onStep) {
  let lastError = null;
  for (let attempt = 1; attempt <= LOCK_ATTEMPTS; attempt += 1) {
    try {
      await client.query(statement);
      return;
    } catch (error) {
      if (!isLockWaitFailure(error)) throw nameSchemaError(error, { statement, position, total, attempt });
      lastError = error;
      if (attempt === LOCK_ATTEMPTS) break;
      onStep({ step: 'waiting-for-lock', position, total, attempt, statement: sqlPreview(statement) });
      await sleep(Math.min(1_000 * 2 ** (attempt - 1), 8_000));
    }
  }
  throw nameSchemaError(lastError, { statement, position, total, attempts: LOCK_ATTEMPTS });
}

/**
 * Bring the schema up to date, and report where the boot is while doing it.
 *
 * `onStep` exists because a deploy that fails between two `console` calls leaves nothing to read: the
 * caller gets told when the connection is being opened, when a statement is queueing behind a lock, and
 * when the work is done, so the service log says which of those is the one that never finished.
 */
export async function initializeDatabase({ onStep = () => {} } = {}) {
  const startedAt = Date.now();
  onStep({ step: 'connecting', total: 0 });
  // A connection that never completes is the failure mode this whole function is built around, so even
  // the checkout is raced against a deadline. If it lands afterwards it is released rather than kept.
  const client = await withDeadline(
    pool.connect(),
    CONNECT_TIMEOUT_MS,
    'a database connection for the schema',
    { onLate: (late) => { try { late?.release?.(); } catch { /* the pool has already given the slot back */ } } },
  );
  const statements = schemaStatements();
  try {
    await client.query(`SET lock_timeout = '${timeoutSetting(LOCK_TIMEOUT_MS, 5_000)}'`);
    await client.query(`SET statement_timeout = '${timeoutSetting(STATEMENT_TIMEOUT_MS, 120_000)}'`);
    let position = 0;
    for (const statement of statements) {
      await runStatement(client, statement, position, statements.length, onStep);
      position += 1;
    }
  } finally {
    client.release();
  }
  const adminAccess = createAdminAccess();
  if (adminAccess.emails.length) {
    await pool.query(
      "UPDATE users SET role='admin' WHERE lower(email) = ANY($1::text[]) AND role <> 'admin'",
      [adminAccess.emails],
    );
  }
  await pool.query('SELECT 1');
  const elapsedMs = Date.now() - startedAt;
  onStep({ step: 'ready', total: statements.length, elapsedMs });
  return { statements: statements.length, elapsedMs };
}
