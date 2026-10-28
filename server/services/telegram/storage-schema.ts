/**
 * The tables `services/telegram/postgres-storage.ts` needs, and the one function that creates them.
 *
 * This is a migration that is *not* run at boot, on purpose. `server/db.js` owns the schema the application runs
 * on, and it runs on every start of every environment - so anything placed in its statement list is applied to
 * production the moment it is merged, whatever the driver switch says. The mtcute storage tables are only ever
 * read by code that runs when `TELEGRAM_DRIVER=mtcute`, and a half-deployed driver is worse than none: a workspace
 * whose session material lives in a table that gets dropped by a later rollback cannot sign in again. So the
 * preview environment applies this itself (see `ensureTelegramStorageSchema`), and `test/mtcute-postgres-storage.test.js`
 * fails if `db.js` ever starts applying it, which is the rule that keeps "not on production yet" true after
 * whoever wrote it has stopped looking.
 *
 * Statements are kept as one string per table rather than a template literal, because `db.js` documents that a
 * backtick in this project's SQL text has broken a boot before now.
 */

/** The tables this migration owns, in the order they are created. */
export const TELEGRAM_STORAGE_TABLES = Object.freeze([
  'telegram_storage_kv',
  'telegram_storage_auth_keys',
  'telegram_storage_temp_auth_keys',
  'telegram_storage_peers',
  'telegram_storage_ref_messages',
]);

export const TELEGRAM_STORAGE_SCHEMA_STATEMENTS = Object.freeze([
  // Key/value, which is where a driver keeps whatever it decides is worth keeping across a restart.
  'CREATE TABLE IF NOT EXISTS telegram_storage_kv ('
        + ' account_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,'
        + ' key text NOT NULL,'
        + ' value bytea NOT NULL,'
        + ' updated_at timestamptz NOT NULL DEFAULT NOW(),'
        + ' PRIMARY KEY (account_id, key)'
        + ')',
  // The permanent auth key per datacenter. `set(dc, null)` deletes, so there is no tombstone to reason about.
  'CREATE TABLE IF NOT EXISTS telegram_storage_auth_keys ('
        + ' account_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,'
        + ' dc smallint NOT NULL,'
        + ' auth_key bytea NOT NULL,'
        + ' updated_at timestamptz NOT NULL DEFAULT NOW(),'
        + ' PRIMARY KEY (account_id, dc)'
        + ')',
  // Temp auth keys are only valid until `expires_at` (unix seconds), and the expiry is read in the query rather
  // than trusted from memory, because the process that wrote one may not be the process that asks for it.
  'CREATE TABLE IF NOT EXISTS telegram_storage_temp_auth_keys ('
        + ' account_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,'
        + ' dc smallint NOT NULL,'
        + ' idx integer NOT NULL,'
        + ' auth_key bytea NOT NULL,'
        + ' expires_at bigint NOT NULL,'
        + ' PRIMARY KEY (account_id, dc, idx)'
        + ')',
  'CREATE INDEX IF NOT EXISTS telegram_storage_temp_auth_keys_expiry_idx'
        + ' ON telegram_storage_temp_auth_keys (account_id, dc, expires_at DESC)',
  // The peer cache. `complete` is the library's own TL serialization, stored as written: re-encoding it here would
  // mean this file knows a format it has no reason to own and no way to validate.
  'CREATE TABLE IF NOT EXISTS telegram_storage_peers ('
        + ' account_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,'
        + ' peer_id bigint NOT NULL,'
        + ' access_hash text NOT NULL,'
        + ' is_min boolean NOT NULL DEFAULT false,'
        + ' usernames text[] NOT NULL DEFAULT \'{}\','
        + ' phone text,'
        + ' updated bigint NOT NULL,'
        + ' complete bytea NOT NULL,'
        + ' PRIMARY KEY (account_id, peer_id)'
        + ')',
  'CREATE INDEX IF NOT EXISTS telegram_storage_peers_username_idx ON telegram_storage_peers USING GIN (usernames)',
  'CREATE INDEX IF NOT EXISTS telegram_storage_peers_phone_idx ON telegram_storage_peers (account_id, phone) WHERE phone IS NOT NULL',
  // Reference messages, which is how a driver remembers "the last message we saw in that chat" for a gap check.
  'CREATE TABLE IF NOT EXISTS telegram_storage_ref_messages ('
        + ' account_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,'
        + ' peer_id bigint NOT NULL,'
        + ' chat_id bigint NOT NULL,'
        + ' msg_id integer NOT NULL,'
        + ' PRIMARY KEY (account_id, peer_id, msg_id)'
        + ')',
]);

/**
 * Apply the migration. Idempotent by construction - every statement is `IF NOT EXISTS` - so a preview environment
 * can call it on every boot, and a rollback that dropped the tables and re-deployed needs nothing else.
 *
 * One statement at a time, and the error says *which* one failed: a single multi-statement string hides the
 * offending line behind Postgres' first complaint, and the first complaint is usually about a missing `users`
 * table on a database that is mid-migration, which sends the reader to the wrong file.
 *
 * @param pool something that answers `query(text, params)`, which `pg`'s Pool and a test double both do
 */
export async function ensureTelegramStorageSchema(pool: { query(sql: string, params?: readonly unknown[]): Promise<unknown> }, log: (level: string, message: string, extra?: unknown) => void = () => {}): Promise<number> {
  let applied = 0;
  for (const statement of TELEGRAM_STORAGE_SCHEMA_STATEMENTS) {
    try {
      await pool.query(statement);
      applied += 1;
    } catch (error) {
      log('error', 'Telegram storage schema statement failed', {
        statement: statement.slice(0, 72),
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
  return applied;
}
