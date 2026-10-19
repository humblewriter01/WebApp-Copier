import pg from 'pg';

const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('render.com')
    ? { rejectUnauthorized: false }
    : undefined,
  max: Number(process.env.PG_POOL_MAX || 5),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

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
    ALTER TABLE settings ADD COLUMN IF NOT EXISTS auto_trading_enabled BOOLEAN NOT NULL DEFAULT FALSE;
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
    CREATE TABLE IF NOT EXISTS telegram_login_attempts (
      user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      encrypted_state TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS signals_user_created_idx ON signals(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS channels_user_enabled_idx ON channels(user_id, enabled);
    CREATE INDEX IF NOT EXISTS metaapi_accounts_user_created_idx ON metaapi_accounts(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS telegram_login_attempts_expiry_idx ON telegram_login_attempts(expires_at);
    ALTER TABLE metaapi_credentials ENABLE ROW LEVEL SECURITY;
    ALTER TABLE metaapi_accounts ENABLE ROW LEVEL SECURITY;
    ALTER TABLE telegram_login_attempts ENABLE ROW LEVEL SECURITY;
  `);
  await pool.query('SELECT 1');
}
