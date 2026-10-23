import pg from 'pg';
import { createAdminAccess } from './services/admin.js';
import { withParameterChecks } from './services/query-params.js';

const { Pool } = pg;

/* The one pool this app owns, wrapped so every statement it carries is checked against its own
   placeholders before it is sent. A hand-assembled statement whose values and placeholders disagree
   otherwise fails deep in the driver with `bind message supplies N parameters, but prepared statement
   requires M`, which no route, log line, or test names. */
export const pool = withParameterChecks(new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('render.com')
    ? { rejectUnauthorized: false }
    : undefined,
  max: Number(process.env.PG_POOL_MAX || 5),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
}), 'pool');

export async function initializeDatabase() {
  await pool.query(`
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
    CREATE INDEX IF NOT EXISTS execution_jobs_ready_idx ON execution_jobs(status,created_at) WHERE status='queued';
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
  `);
  const adminAccess = createAdminAccess();
  if (adminAccess.emails.length) {
    await pool.query(
      "UPDATE users SET role='admin' WHERE lower(email) = ANY($1::text[]) AND role <> 'admin'",
      [adminAccess.emails],
    );
  }
  await pool.query('SELECT 1');
}
