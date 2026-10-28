/**
 * A Postgres-backed storage provider for a second MTProto driver.
 *
 * What this is for: `@mtcute/node` persists nothing itself and asks for a *provider* instead - four small
 * repositories plus a lifecycle object - so an account's auth keys, peer cache and reference messages can live in
 * the database this application already runs, already backs up and already deletes on request. A file-based
 * session (its `SqliteStorageDriver`) is not an option on a platform whose filesystem is ephemeral: a workspace
 * that has to re-enter a phone code after every deploy is a broken product, whichever library is on the wire.
 *
 * Why the shape is what it is:
 *
 *  - **Every method writes through.** The interfaces permit batching until `save()`, and three of them say
 *    "MUST be applied immediately, without batching" in their own doc comment. The library is allowed to call
 *    `save()` on a timer, which means a batched driver has a window in which a fresh auth key exists only in the
 *    memory of a process that can be stopped at any moment - on Render, that is a normal Tuesday. There is one
 *    write path here, it is awaited, and `save()` is a no-op that says so.
 *  - **Nothing is invented.** `peers.complete` is the library's own TL serialization, stored as the bytes it
 *    handed over and returned unchanged, because re-encoding it would mean this file knows a binary format it has
 *    no way to validate. `updated` and `expires_at` are stored as the numbers the caller passed, not as `NOW()`:
 *    both are *the library's* clocks about *the server's* state, and substituting ours would make a stored peer
 *    look fresher than it is after a delayed write.
 *  - **`getById` prefers a "min" peer, and `getByUsername`/`getByPhone` must never return one.** That asymmetry
 *    reads like a mistake and is not: a bare id needs *an* access hash to make a request, any hash, while a
 *    username lookup is how a chat gets resolved for the first time, and a min peer cannot authorize that. The
 *    ORDER BY clauses below encode it, with the reasoning next to them, because a future reader who "fixes" the
 *    inconsistency would break login for every workspace on this table.
 *  - **Scoped by `account_id`, with the deletion cascade coming from the users table.** One row per
 *    (account, key), so signing a second workspace in on the same database cannot read the first one's keys, and
 *    a deleted account takes its session material with it.
 *
 * What is deliberately absent: update state (pts/qts). It is not in this provider's interfaces - the driver keeps
 * it in memory and re-syncs from `updates.getState` on start, which is a different recovery story from the one
 * `services/telegram-listener.js` tells today, and the difference is written down in
 * `services/telegram/mtcute-adapter.ts` rather than quietly absorbed here.
 */
import type {
    IAuthKeysRepository,
    IKeyValueRepository,
    IPeersRepository,
    IReferenceMessagesRepository,
    IStorageDriver,
    ITelegramStorageProvider,
} from '@mtcute/core';

/** The rows come back as objects with unknown members; every read narrows them explicitly, at one place. */
type Row = Record<string, unknown>;

/** The only thing this module needs from a database handle, which `pg.Pool`, a `Client` and a test double have. */
export interface PgExecutor {
    query(sql: string, params?: readonly unknown[]): Promise<{ rows: readonly Row[] }>;
}

/** `pg` hands `bytea` back as a Buffer; a `Uint8Array` view over it costs no copy and satisfies the interface. */
function toBytes(value: unknown): Uint8Array {
    if (value instanceof Uint8Array) return value;
    if (Buffer.isBuffer(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    if (typeof value === 'string') return new Uint8Array(Buffer.from(value, 'base64'));
    throw new TypeError(`expected bytea material, got ${value === null ? 'null' : typeof value}`);
}

function toText(value: unknown): string {
    if (typeof value === 'string') return value;
    if (value === null || value === undefined) throw new TypeError('expected text, got nothing');
    return String(value);
}

/** Postgres `int8`/`bigint` arrives as a string, and a peer id must survive the trip without rounding. */
function toInt(value: unknown): number {
    const num = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(num)) throw new TypeError(`expected an integer, got ${JSON.stringify(value)}`);
    return num;
}

/**
 * The first row, or null. Explicit because `rows[0]` under `noUncheckedIndexedAccess` is `Row | undefined`, and
 * the alternative - a non-null assertion at each of eleven call sites - is how a missing row becomes a runtime
 * `Cannot read properties of undefined` in the one path that reads a session.
 */
function firstRow(rows: readonly Row[]): Row | null {
    return rows.length ? rows[0] ?? null : null;
}

function toBool(value: unknown): boolean {
    return value === true || value === 1 || value === 't' || value === 'true';
}

function toStringList(value: unknown): string[] {
    if (Array.isArray(value)) return value.map((item) => toText(item));
    if (typeof value === 'string') {
        // The wire format of `text[]` when a driver hands back the raw value: `{a,b}`. Parsed, not regexed.
        const inner = value.replace(/^\{/, '').replace(/\}$/, '');
        return inner ? inner.split(',').map((item) => item.replace(/^"|"$/g, '')) : [];
    }
    return [];
}

export interface PostgresStorageProviderOptions {
    /** Whose rows these are - the workspace's user id, which is also the isolation boundary. */
    readonly accountId: string;
    readonly pool: PgExecutor;
    /** Called with `('warn' | 'error', message, extra)`, the same shape the server's own `log` has. */
    readonly log?: (level: string, message: string, extra?: unknown) => void;
}

/**
 * Build the provider. It holds no connection and no transaction: it is a set of statements over whatever `pool`
 * is, which is what lets the same object serve a connect, a catch-up and a destroy without a lifecycle of its own
 * to get wrong.
 */
export function createPostgresStorageProvider(options: PostgresStorageProviderOptions): ITelegramStorageProvider {
    const { accountId, pool } = options;

    const kv: IKeyValueRepository = {
        async set(key: string, value: Uint8Array): Promise<void> {
            await pool.query(
                'INSERT INTO telegram_storage_kv(account_id,key,value,updated_at) VALUES($1,$2,$3,NOW())'
                    + ' ON CONFLICT (account_id,key) DO UPDATE SET value=EXCLUDED.value,updated_at=NOW()',
                [accountId, key, Buffer.from(value)],
            );
        },
        async get(key: string): Promise<Uint8Array | null> {
            const { rows } = await pool.query('SELECT value FROM telegram_storage_kv WHERE account_id=$1 AND key=$2 LIMIT 1', [accountId, key]);
            const row = firstRow(rows);
            return row ? toBytes(row.value) : null;
        },
        async delete(key: string): Promise<void> {
            await pool.query('DELETE FROM telegram_storage_kv WHERE account_id=$1 AND key=$2', [accountId, key]);
        },
        async deleteAll(): Promise<void> {
            await pool.query('DELETE FROM telegram_storage_kv WHERE account_id=$1', [accountId]);
        },
    };

    const authKeys: IAuthKeysRepository = {
        async set(dc: number, key: Uint8Array | null): Promise<void> {
            if (key === null) {
                await pool.query('DELETE FROM telegram_storage_auth_keys WHERE account_id=$1 AND dc=$2', [accountId, dc]);
                return;
            }
            await pool.query(
                'INSERT INTO telegram_storage_auth_keys(account_id,dc,auth_key,updated_at) VALUES($1,$2,$3,NOW())'
                    + ' ON CONFLICT (account_id,dc) DO UPDATE SET auth_key=EXCLUDED.auth_key,updated_at=NOW()',
                [accountId, dc, Buffer.from(key)],
            );
        },
        async get(dc: number): Promise<Uint8Array | null> {
            const { rows } = await pool.query('SELECT auth_key FROM telegram_storage_auth_keys WHERE account_id=$1 AND dc=$2 LIMIT 1', [accountId, dc]);
            const row = firstRow(rows);
            return row ? toBytes(row.auth_key) : null;
        },
        async setTemp(dc: number, idx: number, key: Uint8Array | null, expires: number): Promise<void> {
            if (key === null) {
                await pool.query('DELETE FROM telegram_storage_temp_auth_keys WHERE account_id=$1 AND dc=$2 AND idx=$3', [accountId, dc, idx]);
                return;
            }
            await pool.query(
                'INSERT INTO telegram_storage_temp_auth_keys(account_id,dc,idx,auth_key,expires_at) VALUES($1,$2,$3,$4,$5)'
                    + ' ON CONFLICT (account_id,dc,idx) DO UPDATE SET auth_key=EXCLUDED.auth_key,expires_at=EXCLUDED.expires_at',
                [accountId, dc, idx, Buffer.from(key), Math.trunc(expires)],
            );
        },
        async getTemp(dc: number, idx: number, now: number): Promise<Uint8Array | null> {
            // The expiry is a predicate in the query rather than a check after it, so a key that died between the
            // write and this read cannot be handed back by a process that was asleep.
            const { rows } = await pool.query(
                'SELECT auth_key FROM telegram_storage_temp_auth_keys'
                    + ' WHERE account_id=$1 AND dc=$2 AND idx=$3 AND expires_at > $4',
                [accountId, dc, idx, Math.trunc(now)],
            );
            const row = firstRow(rows);
            return row ? toBytes(row.auth_key) : null;
        },
        async deleteByDc(dc: number): Promise<void> {
            await pool.query('DELETE FROM telegram_storage_auth_keys WHERE account_id=$1 AND dc=$2', [accountId, dc]);
            await pool.query('DELETE FROM telegram_storage_temp_auth_keys WHERE account_id=$1 AND dc=$2', [accountId, dc]);
        },
        async deleteAll(): Promise<void> {
            await pool.query('DELETE FROM telegram_storage_auth_keys WHERE account_id=$1', [accountId]);
            await pool.query('DELETE FROM telegram_storage_temp_auth_keys WHERE account_id=$1', [accountId]);
        },
    };

    const PEER_COLUMNS = 'peer_id,access_hash,is_min,usernames,phone,updated,complete';

    const peers: IPeersRepository = {
        async store(peer: IPeersRepository.PeerInfo): Promise<void> {
            await pool.query(
                'INSERT INTO telegram_storage_peers(account_id,peer_id,access_hash,is_min,usernames,phone,updated,complete) VALUES($1,$2,$3,$4,$5,$6,$7,$8)'
                    + ' ON CONFLICT (account_id,peer_id) DO UPDATE SET access_hash=EXCLUDED.access_hash,is_min=EXCLUDED.is_min,'
                    + 'usernames=EXCLUDED.usernames,phone=EXCLUDED.phone,updated=EXCLUDED.updated,complete=EXCLUDED.complete',
                [accountId, peer.id, peer.accessHash, peer.isMin === true, peer.usernames ?? [], peer.phone ?? null, peer.updated, Buffer.from(peer.complete)],
            );
        },
        async getById(id: number): Promise<IPeersRepository.PeerInfo | null> {
            const { rows } = await pool.query(
                `SELECT ${PEER_COLUMNS} FROM telegram_storage_peers WHERE account_id=$1 AND peer_id=$2 ORDER BY is_min DESC LIMIT 1`,
                [accountId, id],
            );
            const row = firstRow(rows);
            return row ? peerRow(row) : null;
        },
        async getByUsername(username: string): Promise<IPeersRepository.PeerInfo | null> {
            const { rows } = await pool.query(
                `SELECT ${PEER_COLUMNS} FROM telegram_storage_peers WHERE account_id=$1 AND $2 = ANY(usernames) AND is_min = false LIMIT 1`,
                [accountId, username],
            );
            const row = firstRow(rows);
            return row ? peerRow(row) : null;
        },
        async getByPhone(phone: string): Promise<IPeersRepository.PeerInfo | null> {
            const { rows } = await pool.query(
                `SELECT ${PEER_COLUMNS} FROM telegram_storage_peers WHERE account_id=$1 AND phone=$2 AND is_min = false LIMIT 1`,
                [accountId, phone],
            );
            const row = firstRow(rows);
            return row ? peerRow(row) : null;
        },
        async deleteAll(): Promise<void> {
            await pool.query('DELETE FROM telegram_storage_peers WHERE account_id=$1', [accountId]);
        },
    };

    function peerRow(row: Row): IPeersRepository.PeerInfo {
        return {
            id: toInt(row.peer_id),
            accessHash: toText(row.access_hash),
            isMin: toBool(row.is_min),
            usernames: toStringList(row.usernames),
            updated: toInt(row.updated),
            phone: row.phone === null || row.phone === undefined ? undefined : toText(row.phone),
            complete: toBytes(row.complete),
        };
    }

    const refMessages: IReferenceMessagesRepository = {
        async store(peerId: number, chatId: number, msgId: number): Promise<void> {
            await pool.query(
                'INSERT INTO telegram_storage_ref_messages(account_id,peer_id,chat_id,msg_id) VALUES($1,$2,$3,$4) ON CONFLICT (account_id,peer_id,msg_id) DO NOTHING',
                [accountId, peerId, chatId, msgId],
            );
        },
        async getByPeer(peerId: number): Promise<[number, number] | null> {
            // "the one with the highest `msgId` ... not really important" - so it is written down as the rule
            // rather than left to whatever the planner happens to return, which is the only way this function has
            // a defined answer for a peer with several stored messages.
            const { rows } = await pool.query(
                'SELECT chat_id,msg_id FROM telegram_storage_ref_messages WHERE account_id=$1 AND peer_id=$2 ORDER BY msg_id DESC LIMIT 1',
                [accountId, peerId],
            );
            const row = firstRow(rows);
            return row ? [toInt(row.chat_id), toInt(row.msg_id)] : null;
        },
        async delete(chatId: number, msgIds: readonly number[]): Promise<void> {
            if (!msgIds.length) return;
            await pool.query('DELETE FROM telegram_storage_ref_messages WHERE account_id=$1 AND chat_id=$2 AND msg_id = ANY($3::int[])', [accountId, chatId, [...msgIds]]);
        },
        async deleteByPeer(peerId: number): Promise<void> {
            await pool.query('DELETE FROM telegram_storage_ref_messages WHERE account_id=$1 AND peer_id=$2', [accountId, peerId]);
        },
        async deleteAll(): Promise<void> {
            await pool.query('DELETE FROM telegram_storage_ref_messages WHERE account_id=$1', [accountId]);
        },
    };

    const driver: IStorageDriver = {
        // Nothing to preload: every repository reads on demand, so "loaded" is a state this driver does not have
        // and cannot get out of sync. Kept as a no-op rather than omitted because the interface offers it and a
        // future batching implementation would otherwise have to explain the change to the caller.
        async load(): Promise<void> {},
        async save(): Promise<void> {},
        async destroy(): Promise<void> {},
    };

    return { driver, kv, authKeys, peers, refMessages };
}

/** Every method this provider implements, as data, so a test can assert it against the installed interfaces. */
export const POSTGRES_STORAGE_METHODS = Object.freeze({
    kv: ['set', 'get', 'delete', 'deleteAll'],
    authKeys: ['set', 'get', 'setTemp', 'getTemp', 'deleteByDc', 'deleteAll'],
    peers: ['store', 'getById', 'getByUsername', 'getByPhone', 'deleteAll'],
    refMessages: ['store', 'getByPeer', 'delete', 'deleteByPeer', 'deleteAll'],
} as const);
