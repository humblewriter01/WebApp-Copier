/**
 * Types for a JavaScript service: the one file the compiler reads and Node never loads.
 *
 * `server/tsconfig.json` runs `allowJs` + `checkJs` over every application source with `strict` off, which
 * means the checker infers almost everything from the code as written. Inference is only as good as the seams
 * it can see, and four kinds of thing are invisible to it from a `.js` file: what a service is allowed to hang
 * on an `Error`, what the logger it is handed looks like, what a database handle accepts, and what a row of
 * `users` or `signals` contains. Those four are this file. Everything else stays next to the code it
 * describes, as a `@typedef` above the function that uses it.
 *
 * Nothing here is invented. Each field below is set somewhere in this service, and the line that sets it is
 * named in the comment, because a declaration nobody can trace is a second source of truth and not a type.
 * When a field is removed from the code, it should be removed here in the same change - the typecheck fails on
 * the read that no longer exists, which is the mechanism that keeps this file honest.
 */

/** Levels `log()` accepts; the transport writes them to stdout as the first word of the line. */
type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Structured facts attached to a log line. Values are serialised, so anything JSON-safe is fair. */
type LogExtra = Record<string, any>;

/** The level-first logging seam: `log('warn', 'a sentence', { facts })`. */
type ServiceLogger = (level: LogLevel, message: string, extra?: LogExtra) => void;

/**
 * The console-shaped seam: `logger.warn('a sentence', { facts })`, with any subset of methods present.
 *
 * Services default this to `console`, which is why the methods are optional rather than required: the server
 * hands several of them a partial logger built over `log()` - `createAccountCleanup` gets only `warn` - and a
 * type that demanded the whole `Console` interface would be a lie about what the code accepts. It is a lie with
 * consequences too: it says a caller who passes `{ warn }` is broken, so the honest shape is the one that lists
 * what is used and marks each one as optional.
 */
type LoggerMethods = {
  debug?: (message: string, extra?: LogExtra) => void;
  info?: (message: string, extra?: LogExtra) => void;
  warn?: (message: string, extra?: LogExtra) => void;
  error?: (message: string, extra?: LogExtra) => void;
};

/** Either logging seam, which is what a service that forwards to `log()` receives from the server. */
type LogSink = ServiceLogger | LoggerMethods;

/** One database read or write, as `pg` resolves it. `rows` is always an array, `rowCount` is null for reads. */
type QueryResult = { rows: any[]; rowCount: number | null; fields?: { name: string }[] };

/**
 * The pool, described by the only things this service does with it.
 *
 * `pg` is not typed here on purpose: `@types/pg` would bring the whole driver surface, every overload and a
 * hundred errors about things this app never calls, in exchange for types no query site uses yet. What is
 * worth pinning is narrower and truer - a statement is text, its parameters are a positional array, and the
 * answer has `rows`. A service that says it takes a pool and then calls `pool.execute` should not typecheck,
 * and does not.
 */
type PoolLike = {
  query: (sql: string, params?: readonly any[]) => Promise<QueryResult>;
  connect?: () => Promise<any>;
  end?: () => Promise<any>;
};

/**
 * What this app puts on an `Error`.
 *
 * Decorated errors are how a service deeper in the stack tells the HTTP layer what to answer, and how the
 * broker's own failure survives a translation into a sentence a trader can read. Merging them onto `Error`
 * rather than inventing an `AppError` class keeps the throw sites exactly as they are and makes the fields
 * checkable: `error.statu = 500` becomes an error instead of an invisible new property, and the sixty places
 * that read `error.code` are reading something the compiler has seen declared.
 *
 * Every one of them is optional, because an `Error` reaching a catch block may be any error at all - that is
 * the honest type, not a wish.
 */
interface Error {
  /** The HTTP status to answer with. Set by the service that knows the reason (`admin.js`, `flutterwave.js`, `auth`), read by the error handler in `index.js`. */
  status?: number;
  /** A stable, machine-readable reason: `PLAN_UPGRADE_REQUIRED`, `TELEGRAM_SESSION_REVOKED`. Read by the client to pick a sentence and by tests to pin behaviour. */
  code?: string;
  /** A sentence already written for the trader, with no provider vocabulary in it. Set beside `code`; `index.js` prefers it over `message` when answering. */
  userMessage?: string;
  /** Telegram's own human text, kept because `code` alone cannot explain an `AUTH_KEY_UNREGISTERED` that arrived as something else. */
  errorMessage?: string;
  /** Whether the failure is the transport's (`timeout`) or the account's, used when choosing between reconnecting and logging the user out of Telegram. */
  upgradeRequired?: boolean;
  /** The HTTP status MetaAPI answered with, kept separate from `status` because the two are different questions: what the broker said, and what we will say. */
  metaApiStatus?: number;
  /** MetaAPI's own error code (`NotSynchronizedError`, `OperationFailed`), which is what decides whether a trade is retried or reported. */
  metaApiErrorCode?: string;
  /** The kind MetaAPI named the failure as, read by `execution-defense.js` when it classifies one order. */
  metaApiErrorType?: string;
  /** The transport detail that goes in the operator log and never in a response body. */
  metaApiNetworkDiagnostic?: string;
  /** Flutterwave's status for a verification that came back not-successful, kept for the reconciliation job. */
  flutterwaveStatus?: string;
  /** The rate-limit bucket that filled, so a 429 can say which one without re-deriving it. */
  limitKey?: string;
  /** A provider timeout, in milliseconds, for the errors that are about time rather than truth. */
  timeoutMs?: number;
  /** The statement that failed, on the schema-migration path in `db.js`, where "which line of the migration" is the only useful fact. */
  sql?: string;
  schemaStatement?: string;
  schemaStatementIndex?: number;
  /** Set by the reconnect route when the session could not be brought back, so the caller can answer 503 with a retry sentence instead of a generic 500. Read only by `index.js`. */
  telegramReconnectFailed?: boolean;
  /** Set when there was no stored session to reconnect at all, which is a different answer to the user than a failed attempt. */
  telegramNoSession?: boolean;
  /** Set by the Telegram transport on a flood wait: how long to wait, and what was being sent. Read by `floodBackoffMs` in `telegram-listener.js`. */
  seconds?: number;
  capture?: unknown;
}


/** A row of `promo_codes`: a discount an administrator issued, read by the checkout and by the plan quote. */
type PromoCodeRow = {
  id: string;
  /** Upper-case, already normalised by `normalizeReference`; the CHECK constraint is what keeps it that way. */
  code: string;
  discount_type: 'percentage' | 'fixed';
  /** NUMERIC: text out of the driver, and a percentage of 100 or less by constraint. */
  discount_value: string;
  /** null means unlimited uses. */
  max_uses: number | null;
  current_uses: number;
  expires_at: Date | null;
  active: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

/* ------------------------------------------------------------------------------------------------------
 * Rows.
 *
 * A row is what `SELECT *` returns, so the keys are the column names in snake_case, exactly as `db.js`
 * creates them - not the camelCase the aliased queries build, which each of those describes for itself.
 *
 * The types encode one fact that has caused more bugs here than any other: `pg` returns `NUMERIC` as a
 * **string**, because a JavaScript number cannot hold a broker's price without rounding it. So
 * `entry_price`, `pnl`, `risk_percent` and the rest are `string | null`, and any arithmetic on them is
 * written `Number(row.entry_price)` - which is the reason the service contains four hundred `Number(` calls
 * and the reason they are not noise. Read a NUMERIC column without coercing it and `row.entry_price > 0`
 * compares a string, which is true for `'-1'`; with this file in place, the compiler says so.
 *
 * `TIMESTAMPTZ` arrives as a `Date`, `JSONB` as a parsed object, `UUID` as text.
 * ------------------------------------------------------------------------------------------------------ */

/** A workspace. `id` is a UUID, and it is used as text everywhere - never coerced to a number, which is how `onSessionUnrecoverable` was once a no-op. */
type UserRow = {
  id: string;
  name: string;
  email: string;
  password_hash: string;
  telegram_session: string | null;
  telegram_phone: string | null;
  telegram_connected: boolean;
  created_at: string;
  /** null until the workspace first signs in. */
  last_login: string | null;
  last_active_at: Date | null;
  role: 'user' | 'admin';
  supabase_user_id: string | null;
  subscription_status: string;
  subscription_plan: string;
  plan_limits: Record<string, any>;
  is_suspended: boolean;
  suspension_reason: string | null;
};

/** A channel a workspace listens to. `channel_id` is the Telegram id as text, `-100…` form included, because a 64-bit id does not fit a number. */
type ChannelRow = {
  id: string;
  user_id: string;
  channel_id: string;
  title: string;
  username: string | null;
  enabled: boolean;
  created_at: string;
};

/** One captured signal, as the capture path writes it and every list read shows it. */
type SignalRow = {
  id: string;
  user_id: string;
  channel_id: string | null;
  channel_title: string | null;
  message: string;
  symbol: string | null;
  side: string | null;
  /** NUMERIC: text out of the driver. */
  entry_price: string | null;
  stop_loss: string | null;
  take_profit: string | null;
  status: string;
  created_at: string;
  sent_at: Date | null;
  source: string;
  telegram_message_id: string | null;
  /** null when the parser took the stop from the workspace's fallback distance rather than from the message. */
  stop_loss_pips: string | null;
  take_profit_pips: string | null;
  take_profit_levels: any[] | Record<string, any> | null;
  entry_range: Record<string, any> | null;
  order_type: string | null;
  order_type_stated: boolean;
  execution_ready: boolean;
  execution_note: string | null;
  technical_note: string | null;
  parse_error: string | null;
  parsed_by: string | null;
  /** NUMERIC, 0-1 confidence from the second layer. */
  parse_confidence: string | null;
  llm_used: boolean;
  needs_review: boolean;
  direction_inferred: boolean;
  is_scalping: boolean;
  expiry_timestamp: Date | null;
};

/** One order, paper or live. `quantity` and every price are NUMERIC, so text; `pnl` defaults to 0 and is not nullable in the schema. */
type TradeRow = {
  id: string;
  user_id: string;
  signal_id: string | null;
  symbol: string | null;
  side: string | null;
  quantity: string | null;
  entry_price: string | null;
  exit_price: string | null;
  pnl: string;
  status: string;
  created_at: string;
  executed_at: Date | null;
  stop_loss: string | null;
  take_profit: string | null;
  drift_points: string | null;
  remaining_volume: string | null;
  metaapi_account_id: string | null;
  broker_order_id: string | null;
  broker_position_id: string | null;
  client_id: string | null;
  execution_job_id: string | null;
  order_type: string | null;
  error_message: string | null;
  provider_response: Record<string, any> | null;
  expiry_timestamp: Date | null;
};

/** The workspace's risk settings (`settings` is keyed by `user_id`, one row per workspace, so there is no `id`). */
type SettingsRow = {
  user_id: string;
  risk_mode: string;
  /** NUMERIC percent, 0.25-step granularity, text out of the driver. */
  risk_percent: string;
  max_open_positions: number;
  daily_loss_limit: string;
  updated_at: string;
};

/**
 * The take-profit plan one trade is about to run: what `planScaleOutLevels` decides and the execution engine
 * carries from the sizing decision to the order, declared globally because three files touch it.
 */
type ScaleOutPlan = {
  /** false means "send the order as the signal described it", not "something failed". */
  eligible: boolean;
  /** Which rule said no, in the vocabulary the engine logs and the panel reads. */
  reason?: string;
  side?: 'buy' | 'sell';
  /** The price the ride's last slice closes at. */
  takeProfit?: number | null;
  rideLevel?: number;
  rideVolume?: number;
  /**
   * Percent of the *position*, not of the budget: a level the broker's minimum lot ruled out returns its share
   * to the ride, and a plan that still claimed 20% would be describing lots nobody holds.
   */
  ridePercent?: number;
  levels?: any[];
  /** The targets this trade could not use, and why each one was dropped. */
  dropped?: any[];
};

/** A socket this server owns, plus the two fields the auth handshake puts on it. */
type DeskSocket = import('socket.io').Socket & { userId?: string; data?: { supportSessionId?: string } };
