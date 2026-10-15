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
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(user_id, metaapi_account_id)
    );
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
