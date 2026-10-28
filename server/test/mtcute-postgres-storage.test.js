/**
 * The Postgres storage provider for a second MTProto driver, and the migration it depends on.
 *
 * Two claims are worth the test, and neither is "the SQL runs".
 *
 * 1. **The provider satisfies the interface the library asks for, in the version we installed.** That is checked
 *    below against the declarations in `node_modules/@mtcute/core`, by reading them: a mirrored method list that
 *    quietly falls behind an upstream rename is the failure mode of every adapter written before its library is
 *    upgraded, and it is invisible to a type-checker the day the dependency is not installed. If the package is
 *    absent (a `--omit=dev` install, where the types-only dependency is not needed at runtime), the test says so
 *    out loud rather than passing for free.
 * 2. **The provider's statements and the migration agree on every column.** Two files that both describe a table
 *    will drift, and the drift shows up as `column does not exist` inside a login. So the columns are extracted
 *    from each and compared, which is the same trick the GramJS session test uses on the byte layout: assert the
 *    two sources of truth against each other, not against a belief.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import { POSTGRES_STORAGE_METHODS, createPostgresStorageProvider } from '../services/telegram/postgres-storage.ts';
import { TELEGRAM_STORAGE_SCHEMA_STATEMENTS, TELEGRAM_STORAGE_TABLES, ensureTelegramStorageSchema } from '../services/telegram/storage-schema.ts';

const ACCOUNT = '7f0e2f2c-0000-4000-8000-000000000001';

/** A pool that records every statement and answers from a table of canned rows. */
function fakePool(responses = []) {
  const calls = [];
  return {
    calls,
    async query(sql, params = []) {
      calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
      const next = responses[calls.length - 1];
      return { rows: next === undefined ? [] : next };
    },
  };
}

test('the provider answers each repository with a statement scoped to one account', async () => {
  const pool = fakePool();
  const provider = createPostgresStorageProvider({ accountId: ACCOUNT, pool });

  await provider.kv.set('self', new Uint8Array([1, 2, 3]));
  assert.deepEqual(pool.calls[0].sql, 'INSERT INTO telegram_storage_kv(account_id,key,value,updated_at) VALUES($1,$2,$3,NOW()) ON CONFLICT (account_id,key) DO UPDATE SET value=EXCLUDED.value,updated_at=NOW()');
  assert.equal(pool.calls[0].params[0], ACCOUNT, 'the first parameter is always the account, on every statement');
  assert.deepEqual([...pool.calls[0].params[2]], [1, 2, 3], 'bytes are handed over as a Buffer, which is what pg binds to bytea');

  await provider.authKeys.set(2, new Uint8Array(256));
  assert.match(pool.calls[1].sql, /INSERT INTO telegram_storage_auth_keys\(account_id,dc,auth_key,updated_at\)/);
  assert.deepEqual(pool.calls[1].params.slice(0, 2), [ACCOUNT, 2]);

  /* `set(dc, null)` is the library's way of saying "forget this key", and a driver that INSERTed a null would
     leave a row that reads back as a key of zero length - the worst possible answer, because it is a key. */
  await provider.authKeys.set(2, null);
  assert.match(pool.calls[2].sql, /^DELETE FROM telegram_storage_auth_keys WHERE account_id=\$1 AND dc=\$2$/, 'so the delete is a delete');

  await provider.peers.deleteAll();
  await provider.refMessages.deleteAll();
  assert.deepEqual(pool.calls.map((call, index) => (index > 2 ? call.sql : '')).slice(3), [
    'DELETE FROM telegram_storage_peers WHERE account_id=$1',
    'DELETE FROM telegram_storage_ref_messages WHERE account_id=$1',
  ], 'and a wipe is scoped to the account, never to the table');
});

test('a stored peer comes back in the shape the library wrote', async () => {
  const pool = fakePool([
    [{ peer_id: '1000234', access_hash: '1234abc', is_min: false, usernames: ['golddesk', 'xau'], phone: null, updated: 1760000000, complete: Buffer.from([9, 8, 7]) }],
  ]);
  const provider = createPostgresStorageProvider({ accountId: ACCOUNT, pool });
  const peer = await provider.peers.getById(1000234);
  assert.deepEqual(Object.keys(peer).sort(), ['accessHash', 'complete', 'id', 'isMin', 'phone', 'updated', 'usernames']);
  assert.equal(peer.id, 1000234, 'a bigint column arrives as text and is turned into a number here, not by a driver cast');
  assert.deepEqual([...peer.complete], [9, 8, 7], 'and the TL serialization is returned as the bytes that were stored');
  assert.equal('phone' in peer, true, 'phone is present as a key');
  assert.equal(peer.phone, undefined, 'but undefined rather than null, because the interface says `phone?: string`');

  const empty = await createPostgresStorageProvider({ accountId: ACCOUNT, pool: fakePool([]) }).peers.getById(1);
  assert.equal(empty, null, 'a miss is null, not an object of undefineds');
});

test('the peer reads keep the min-peer rules the interface states', async () => {
  const pool = fakePool([[], [], []]);
  const provider = createPostgresStorageProvider({ accountId: ACCOUNT, pool });
  await provider.peers.getById(7);
  await provider.peers.getByUsername('golddesk');
  await provider.peers.getByPhone('2348012345678');

  assert.match(pool.calls[0].sql, /ORDER BY is_min DESC LIMIT 1/, 'a lookup by id prefers the min peer, which is what the doc comment asks for');
  assert.match(pool.calls[1].sql, /\$2 = ANY\(usernames\) AND is_min = false/, 'a lookup by username must never return one');
  assert.match(pool.calls[2].sql, /phone=\$2 AND is_min = false/, 'nor must a lookup by phone');
});

test('auth keys and temp auth keys are written through, not batched', async () => {
  const pool = fakePool([[], [], []]);
  const provider = createPostgresStorageProvider({ accountId: ACCOUNT, pool });
  await provider.authKeys.setTemp(2, 4, new Uint8Array([1]), 1800000000);
  assert.match(pool.calls[0].sql, /ON CONFLICT \(account_id,dc,idx\) DO UPDATE SET auth_key=EXCLUDED.auth_key,expires_at=EXCLUDED.expires_at/);
  assert.deepEqual(pool.calls[0].params[4], 1800000000, 'the expiry is the number the caller passed, not a duration from our clock');

  await provider.authKeys.getTemp(2, 4, 1799999990);
  assert.match(pool.calls[1].sql, /expires_at > \$4/, 'and it is enforced in the read, so a row that expired while nobody was looking is not returned');
  assert.deepEqual(pool.calls[1].params, [ACCOUNT, 2, 4, 1799999990]);

  /* `deleteByDc` is what the library calls when a session is torn down. A temp key left behind for a dead DC is
     a key that can be picked up by the next session that happens to use that id. */
  await provider.authKeys.deleteByDc(2);
  assert.deepEqual(pool.calls.slice(2).map((call) => call.sql), [
    'DELETE FROM telegram_storage_auth_keys WHERE account_id=$1 AND dc=$2',
    'DELETE FROM telegram_storage_temp_auth_keys WHERE account_id=$1 AND dc=$2',
  ], 'both tables, in one call, because the interface promises both');
});

test('the lifecycle methods exist and do nothing, which is the point', async () => {
  const pool = fakePool();
  const provider = createPostgresStorageProvider({ accountId: ACCOUNT, pool });
  await provider.driver.load?.();
  await provider.driver.save?.();
  await provider.driver.destroy?.();
  assert.deepEqual(pool.calls, [], 'no statement belongs to a lifecycle hook when every write already went through on its own');
});

test('reference messages answer with the highest message id they hold', async () => {
  /* One canned answer per statement, in the order they are issued: the store, then the hit, then the miss, then
     the delete - the fake pool hands out rows by call number, so a list that is off by one is a test that fails
     for a reason that has nothing to do with the code. */
  const pool = fakePool([[], [{ chat_id: -100123, msg_id: 42 }], [], []]);
  const provider = createPostgresStorageProvider({ accountId: ACCOUNT, pool });
  await provider.refMessages.store(100123, -100123, 42);
  assert.match(pool.calls[0].sql, /ON CONFLICT \(account_id,peer_id,msg_id\) DO NOTHING/, 'a repeat sighting of the same message is not an update');

  assert.deepEqual(await provider.refMessages.getByPeer(100123), [-100123, 42], 'a hit is the pair, in the order the interface names them');
  assert.match(pool.calls[1].sql, /ORDER BY msg_id DESC LIMIT 1/, 'highest message id wins, because the interface asks for a defined answer');
  assert.equal(await provider.refMessages.getByPeer(9), null, 'and a miss is null');

  await provider.refMessages.delete(-100123, []);
  assert.equal(pool.calls.length, 3, 'an empty id list issues no statement at all, rather than `= ANY(\'{}\')`');
  await provider.refMessages.delete(-100123, [1, 2]);
  assert.match(pool.calls[3].sql, /msg_id = ANY\(\$3::int\[\]\)/, 'a real list is one statement with an array parameter');
});

test('every column the provider names exists in the migration', () => {
  const schema = TELEGRAM_STORAGE_SCHEMA_STATEMENTS.join('\n');
  const rawSource = readFileSync(new URL('../services/telegram/postgres-storage.ts', import.meta.url), 'utf8');
  /* The peers reads share one column list, and the check has to see through it: a `SELECT ${PEER_COLUMNS}` that a
   * migration forgot a column for is the same bug as a spelled-out list that did, and skipping it because the
   * name was interpolated would quietly exempt the largest table in the file. */
  const peerColumns = (rawSource.match(/const PEER_COLUMNS = '([^']+)'/) || [])[1];
  assert.ok(peerColumns, 'the peer column list is one const, so it can be resolved here');
  const source = rawSource.replace(/\$\{PEER_COLUMNS\}/g, peerColumns);
  const tables = new Map(TELEGRAM_STORAGE_TABLES.map((table) => [table, columnsOf(table, schema)]));
  const used = [...source.matchAll(/(?:INTO|FROM|UPDATE) (telegram_storage_\w+)/g)].map((match) => match[1]);
  assert.ok(used.length > 15, `the provider should name its tables many times, saw ${used.length}`);
  for (const table of new Set(used)) {
    assert.equal(tables.has(table), true, `${table} is written to but never created`);
  }

  for (const match of source.matchAll(/INSERT INTO (telegram_storage_\w+)\(([^)]+)\)/g)) {
    const [, table, list] = match;
    for (const column of list.split(',')) {
      assert.equal(tables.get(table).has(column.trim()), true, `${table}.${column.trim()} is inserted but not declared`);
    }
  }
  for (const match of source.matchAll(/SELECT ([^]+?) FROM (telegram_storage_\w+)/g)) {
    const [, list, table] = match;
    for (const column of list.split(',')) {
      const name = column.trim();
      if (!/^[a-z_]+$/.test(name)) continue;
      assert.equal(tables.get(table).has(name), true, `${table}.${name} is selected but not declared`);
    }
  }
});

function columnsOf(table, schema) {
  const head = `CREATE TABLE IF NOT EXISTS ${table} (`;
  const at = schema.indexOf(head);
  assert.notEqual(at, -1, `${table} is in the table list but has no CREATE`);
  let depth = 1;
  let end = at + head.length;
  while (end < schema.length && depth > 0) {
    if (schema[end] === '(') depth += 1;
    else if (schema[end] === ')') { depth -= 1; if (depth === 0) break; }
    end += 1;
  }
  const body = schema.slice(at + head.length, end);
  const columns = new Set();
  for (const line of body.split(',').map((part) => part.trim())) {
    const name = line.split(/\s+/)[0];
    if (/^[a-z_]+$/.test(name) && !['primary', 'unique', 'constraint', 'foreign'].includes(name)) columns.add(name);
  }
  return columns;
}

test('the migration is idempotent, ordered, and applied one statement at a time', async () => {
  assert.ok(TELEGRAM_STORAGE_SCHEMA_STATEMENTS.length >= TELEGRAM_STORAGE_TABLES.length, 'indexes are extra statements, tables are not');
  for (const statement of TELEGRAM_STORAGE_SCHEMA_STATEMENTS) {
    assert.match(statement, /^CREATE (TABLE|INDEX) IF NOT EXISTS/, 'every statement can be run twice, because a preview environment boots this on every start');
    assert.equal(statement.includes('`'), false, 'and none of them contains a backtick, which is how this project has broken a boot before');
  }

  const pool = fakePool();
  const applied = await ensureTelegramStorageSchema(pool);
  assert.equal(applied, TELEGRAM_STORAGE_SCHEMA_STATEMENTS.length, 'one call per statement, so the failure names the one that failed');
  assert.equal(pool.calls.length, applied);

  const failed = fakePool([]);
  const original = failed.query;
  failed.query = async (sql) => { if (/telegram_storage_peers/.test(sql)) throw new Error('relation "users" does not exist'); return original(sql); };
  const logs = [];
  await assert.rejects(
    ensureTelegramStorageSchema(failed, (level, message, extra) => logs.push({ level, message, extra })),
    /relation "users" does not exist/,
    'a failure is re-thrown, not swallowed: a half-applied migration must not look like a booted driver',
  );
  assert.equal(logs.length, 1, 'and exactly one line is written, naming the statement that failed');
  assert.equal(logs[0].level, 'error');
  assert.equal(logs[0].message, 'Telegram storage schema statement failed');
  assert.match(logs[0].extra.statement, /CREATE TABLE IF NOT EXISTS telegram_storage_peers/);
  assert.equal(logs[0].extra.error, 'relation "users" does not exist', 'with the database\'s own complaint beside it');
});

test('the production schema does not apply this migration', () => {
  const db = readFileSync(new URL('../db.js', import.meta.url), 'utf8');
  assert.equal(/storage-schema|TELEGRAM_STORAGE_SCHEMA/.test(db), false,
    'db.js runs on every boot in every environment, so a table that only the mtcute driver needs must not be created there - a rollback that drops the driver would otherwise leave a table of session material behind with nothing that deletes it');
  const appFiles = ['../index.js', '../services/telegram-listener.js'];
  for (const file of appFiles) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.equal(/postgres-storage|storage-schema/.test(source), false, `${file} does not reach for the new storage yet`);
  }
});

test('the method list matches the interfaces of the installed library, when there is one', () => {
  const root = new URL('../node_modules/@mtcute/core/', import.meta.url);
  const files = {
    kv: 'storage/repository/key-value.d.ts',
    authKeys: 'storage/repository/auth-keys.d.ts',
    peers: 'highlevel/storage/repository/peers.d.ts',
    refMessages: 'highlevel/storage/repository/ref-messages.d.ts',
  };
  if (!existsSync(new URL(files.kv, root))) {
    console.log('skipped: @mtcute/core is not installed in this environment (it is a types-only devDependency), so there is nothing to compare the mirror against');
    return;
  }
  for (const [name, file] of Object.entries(files)) {
    const declaration = readFileSync(new URL(file, root), 'utf8');
    const declared = [...declaration.matchAll(/^\s{4}(?:readonly )?(\w+):/gm)].map((match) => match[1]).filter((entry) => entry !== 'PeerInfo');
    assert.deepEqual([...POSTGRES_STORAGE_METHODS[name]].sort(), declared.sort(), `${name} implements exactly the members ${file} declares`);
  }

  const providerShape = createPostgresStorageProvider({ accountId: ACCOUNT, pool: fakePool() });
  assert.deepEqual(Object.keys(providerShape).sort(), ['authKeys', 'driver', 'kv', 'peers', 'refMessages'], 'and the object handed to the client is the provider the interface names');
  for (const method of ['load', 'save', 'destroy']) {
    assert.equal(typeof providerShape.driver[method], 'function', `the driver lifecycle offers ${method}`);
  }
});
