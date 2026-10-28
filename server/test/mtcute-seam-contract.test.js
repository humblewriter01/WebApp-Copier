/**
 * The seam between the two drivers, checked against the two packages rather than against this repo's own opinion.
 *
 * Every assertion here is a *diff* between something this migration wrote and something a dependency says, which
 * is the only kind of test that still means something in a month:
 *
 *  - the method and arity ledgers in `mtcute-adapter.ts` against the live `telegram-adapter.js` module, so the
 *    seam cannot grow in one file and stay still in the other;
 *  - the four blocker codes against the installed `@mtcute/*` files, in both directions - a blocker that stops
 *    being true has to be deleted here, not left to age into folklore, and a blocker whose evidence no longer
 *    points at the code it quotes is a lie with a citation;
 *  - the storage calls that the library's *own* session-import path makes against the repositories we
 *    implemented, which is the difference between "we wrote a storage provider" and "the first thing the new
 *    driver does at login works";
 *  - the copied `DcOptions`/`InputStringSessionData` interfaces against the declarations they were copied from,
 *    and the seed converter against the real `readStringSession`/`writeStringSession`, executed.
 *
 * Where a check needs a package that is not installed, it says so in the log. `@mtcute/core` is a devDependency
 * (types for the storage interfaces) and `@mtcute/node` is optional (it is not loaded at runtime, and it drags a
 * native build with it), so an install without dev dependencies is a legitimate state - but a package that is
 * *declared* and *missing* is a broken install, and that fails.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as gramjsAdapter from '../services/telegram-adapter.js';
import { MTCUTE_BLOCKERS, MTCUTE_PORTED, TELEGRAM_ADAPTER_ARITY, TELEGRAM_ADAPTER_METHODS, createMtcuteAdapter, mtcuteDriverStatus } from '../services/telegram/mtcute-adapter.ts';
import { POSTGRES_STORAGE_METHODS } from '../services/telegram/postgres-storage.ts';
import { encodeGramjsSession, parseGramjsSession, toDriverSessionSeed, toMtcuteInputSessionData } from '../services/telegram/gramjs-session.ts';
import { StringSession } from 'telegram/sessions/index.js';

const SERVER = fileURLToPath(new URL('..', import.meta.url));
const MTCUTE = new URL('../node_modules/@mtcute/', import.meta.url);
const installed = existsSync(new URL('core/package.json', MTCUTE));
/* A second flag, because the client package is declared optional and an image that cannot build its native
   dependency does not get it at all (measured: `npm ci` exits 0 with `@mtcute/node` silently absent). Anything
   that reads that package has to say it was skipped, while everything that reads `core` - the types the strict
   project compiles against, which a production install always receives - has no excuse for not running. */
const installedNode = existsSync(new URL('node/package.json', MTCUTE));

function readPackage(file) {
  return readFileSync(new URL(file, MTCUTE), 'utf8');
}

/** Every `.d.ts`/`.js` under a package, for a token search that has to be able to say "zero hits". */
function sourceFiles(dir, seen = []) {
  for (const entry of readdirSync(new URL(dir, MTCUTE), { withFileTypes: true })) {
    const relative = `${dir === '.' ? '' : `${dir}/`}${entry.name}`;
    if (entry.isDirectory()) sourceFiles(relative, seen);
    else if (/\.(d\.)?(ts|cts|js|mjs|cjs)$/.test(entry.name)) seen.push(relative);
  }
  return seen;
}

test('the ledger is the seam, both ways', () => {
  const exported = Object.keys(gramjsAdapter);
  const functions = exported.filter((name) => typeof gramjsAdapter[name] === 'function');
  const nonFunctions = exported.filter((name) => typeof gramjsAdapter[name] !== 'function');
  assert.deepEqual(nonFunctions, ['TELEGRAM_TOUCHPOINTS'], 'one list of touchpoints, and nothing else that is not a driver operation');
  assert.deepEqual([...TELEGRAM_ADAPTER_METHODS].sort(), functions.sort(), 'the mtcute ledger names every function the GramJS adapter exports, and no others');
  assert.equal(new Set(TELEGRAM_ADAPTER_METHODS).size, TELEGRAM_ADAPTER_METHODS.length, 'and no name appears twice');
  assert.deepEqual(Object.keys(TELEGRAM_ADAPTER_ARITY).sort(), [...TELEGRAM_ADAPTER_METHODS].sort(), 'with one arity entry each');
  for (const name of TELEGRAM_ADAPTER_METHODS) {
    assert.equal(TELEGRAM_ADAPTER_ARITY[name], gramjsAdapter[name].length, `${name} is declared with the parameters the implementation actually has`);
  }
});

test('nothing is claimed as ported, and the invariant that keeps it that way holds', () => {
  const status = mtcuteDriverStatus();
  assert.deepEqual([...MTCUTE_PORTED].filter((name) => !TELEGRAM_ADAPTER_METHODS.includes(name)), [], 'ported is a subset of the seam');
  assert.equal(status.ported.length, 0, 'and today it is empty, because nothing has been compiled against the client');
  assert.equal(status.pending.length, TELEGRAM_ADAPTER_METHODS.length, 'which makes the whole seam pending, not most of it');
  assert.equal(status.wired, false);
  assert.equal(status.blockers.length, MTCUTE_BLOCKERS.length);
  assert.throws(() => createMtcuteAdapter(), (error) => error.name === 'MtcuteNotWiredError' && error.pending.length === TELEGRAM_ADAPTER_METHODS.length);

  /* The rule that makes the ledger worth reading: `wired` is derived, so it cannot be set to true by an edit
     somewhere else, and a port cannot be "done" by removing a method from the list below - removing it from
     `TELEGRAM_ADAPTER_METHODS` fails the test above, because the GramJS adapter still exports it. */
  assert.equal(status.wired, status.pending.length === 0 && status.blockers.length === 0);
});

test('every blocker still holds, and one that stops holding fails this test', { skip: !installed && '@mtcute packages are not installed' }, (context) => {
  const codes = MTCUTE_BLOCKERS.map((blocker) => blocker.code);
  assert.deepEqual([...codes].sort(), [...new Set(codes)].sort(), 'one entry per code, so two people cannot open the same question twice in the same ledger');

  /* `no-wss-transport`: the package must still contain no websocket transport. If a release ever adds one, the
     443 fallback stops being a blocker and this test is what says so. */
  const hits = sourceFiles('.').filter((file) => /\.(d\.)?(ts|cts)$/.test(file)).filter((file) => /(^|[^a-z0-9])wss([^a-z0-9]|$)/i.test(readFileSync(new URL(file, MTCUTE), 'utf8')));
  assert.deepEqual(hits, [], 'no declaration file in @mtcute mentions wss, as a token (a substring match would find it inside base64 payloads, which is not the question)');
  assert.deepEqual(readdirSync(new URL('core/network/transports/', MTCUTE)).filter((name) => /websocket/i.test(name)), [], 'and the transports directory still has no websocket transport');

  /* `native-dependency`: better-sqlite3 must still be a hard dependency, and still unreachable by subpath. Both
     halves matter: the first is the install cost, the second is why the cost buys us nothing. */
  if (!installedNode) {
    context.diagnostic('this image has no @mtcute/node (the optional package and its native dependency were dropped by the install), so the dependency shape is asserted from the lockfile instead, in the test below');
  } else {
  const nodePackage = JSON.parse(readPackage('node/package.json'));
  assert.equal(typeof nodePackage.dependencies['better-sqlite3'], 'string', 'better-sqlite3 is in dependencies');
  assert.equal(nodePackage.optionalDependencies?.['better-sqlite3'], undefined, 'and was not moved to optionalDependencies, where it would be survivable');
  assert.equal(nodePackage.peerDependencies?.['better-sqlite3'], undefined, 'or to a peer, where it would be someone else\'s problem');
  assert.equal(nodePackage.exports['./sqlite'], undefined, 'and the sqlite directory is still not a subpath anyone can import');
  }

  /* `session-import-unverified`: the evidence has to still be the code we quoted. A blocker whose citation has
     drifted is worse than no blocker, because it reads like an investigation that was done. */
  const base = readPackage('core/highlevel/base.js');
  const importSession = base.slice(base.indexOf('async importSession'));
  assert.ok(importSession.length > 0 && importSession.length < 4000, 'importSession is still a short method');
  for (const line of ['await this.prepare();', 'readStringSession(session)', 'storage.dcs.store(data.primaryDcs)', 'authKeys.deleteAll()', 'authKeys.set(data.primaryDcs.main.id, data.authKey)', 'await this.mt.storage.save();']) {
    assert.match(importSession, new RegExp(line.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `the path still contains ${line}`);
  }
  assert.match(readPackage('core/highlevel/client.d.ts'), /session\?: string \| InputStringSessionData;/, 'and start() still takes the seed object');

  /* `client-surface-unverified`: true precisely while no island file imports the client package at runtime. The
     day one does, this fails and the blocker has to be replaced by whatever the compile actually proved. */
  const islandUrl = new URL('services/telegram/', new URL('..', import.meta.url));
  const island = readdirSync(islandUrl).filter((name) => name.endsWith('.ts'));
  const clientImports = island.filter((name) => /from '@mtcute\/node'/.test(readFileSync(new URL(`services/telegram/${name}`, new URL('..', import.meta.url)), 'utf8')));
  assert.deepEqual(clientImports, [], 'no file in the island imports the client package, whichever way the install went');
  assert.equal(readdirSync(islandUrl).some((name) => name.startsWith('node')), false, 'and no stray file in the island is named after it');
});

test('the storage calls the session bridge makes are all implemented', { skip: !installed && '@mtcute/core is not installed' }, () => {
  /* This is the first thing the new driver would do at login: `importSession` touches the storage provider and
     nothing else. So instead of trusting that our provider is "complete", the calls are read out of the
     library's own method and looked up in the tables the provider is built from. */
  const base = readPackage('core/highlevel/base.js');
  const body = base.slice(base.indexOf('async importSession'), base.indexOf('async importSession') + 3000);
  const calls = [...body.matchAll(/(?:mt\.)?storage\.provider\.(\w+)\.(\w+)\(/g)].map((match) => ({ repository: match[1], method: match[2] }));
  assert.ok(calls.length >= 3, `expected the import path to touch storage several times, found ${calls.length}`);
  for (const call of calls) {
    assert.ok(POSTGRES_STORAGE_METHODS[call.repository], `the provider has no ${call.repository} repository, which importSession calls on`);
    assert.equal(POSTGRES_STORAGE_METHODS[call.repository].includes(call.method), true, `${call.repository}.${call.method}() is called by the library and is not in our table`);
  }

  /* Two calls go through the manager rather than the provider, and a provider cannot satisfy them on its own -
     they are here so that the pairing is written down and checked, not assumed from the interface file. */
  const manager = readPackage('core/storage/storage.d.ts');
  assert.match(manager, /readonly dcs: DefaultDcsService;/, 'StorageManager.dcs, which importSession stores into');
  assert.match(manager, /save\(\): Promise<void>;/, 'and StorageManager.save(), which is what makes a write-through provider correct');
  assert.match(readPackage('core/storage/service/default-dcs.js'), /_kv/, 'and the dcs service is built over the key-value repository, which we do implement');
});

test('the seed converts in the library\'s own normaliser, executed', { skip: !installed && '@mtcute/core is not installed' }, async () => {
  /* The claim the whole first deliverable rests on: an account that has already signed in on GramJS arrives with
     a key the other driver can use. Tested by running the other driver's function, not by reading it. */
  const key = new Uint8Array(Array.from({ length: 256 }, (_, index) => (index * 11 + 5) % 253));
  const stored = (() => {
    const session = new StringSession();
    session._dcId = 5;
    session._serverAddress = '149.154.175.59';
    session._port = 443;
    session._key = Buffer.from(key);
    session._authKey = { getKey: () => Buffer.from(key) };
    return session.save();
  })();

  const parsed = parseGramjsSession(stored);
  assert.ok(parsed);
  const seed = toMtcuteInputSessionData(toDriverSessionSeed(parsed));
  assert.deepEqual(Object.keys(seed).sort(), ['authKey', 'primaryDcs', 'self'], 'no testMode, because a GramJS session cannot say which backend it belongs to');
  assert.equal(seed.self, null, 'and no identity, for the same reason');
  assert.equal(seed.primaryDcs.main, seed.primaryDcs.media, 'one endpoint, one object, which is what the writer tests for');

  const utils = await import('@mtcute/core/utils.js');
  const normalized = utils.readStringSession(seed);
  assert.equal(normalized.version, 3, 'the library stamps its own version, which is the sign it read the object form');
  assert.deepEqual(normalized.primaryDcs.main, { ipAddress: '149.154.175.59', port: 443, id: 5 }, 'host, port and datacenter arrive unchanged - a rewritten port here is a different login');
  assert.equal(normalized.self, null);
  assert.deepEqual([...normalized.authKey], [...key], 'and the key is 256 bytes of the same bytes');

  const asString = utils.writeStringSession(normalized);
  const again = utils.readStringSession(asString);
  assert.deepEqual([...again.authKey], [...key], 'through TL serialisation and base64 the key is still itself');
  /* Compared field by field rather than as objects, because a DC option that has been through the serializer
     comes back with the optional flags materialised as `false` - which is a difference with no meaning, and an
     object comparison would report it as one with meaning. The three fields that decide a connection are
     compared, and one of the materialised flags is then checked on purpose: it is the proof for the sentence in
     `gramjs-session.ts` that leaving `testMode` out is the same as false, not the same as a guess. */
  assert.deepEqual({ ipAddress: again.primaryDcs.main.ipAddress, port: again.primaryDcs.main.port, id: again.primaryDcs.main.id }, { ipAddress: '149.154.175.59', port: 443, id: 5 }, 'the same endpoint, after a round trip through their format');
  assert.equal(normalized.primaryDcs.main.testMode, undefined, 'we wrote no test-mode flag');
  assert.equal(again.primaryDcs.main.testMode, false, 'and the serializer reads it back as false, so "absent" is not a third state');
  assert.equal(again.primaryDcs.media, again.primaryDcs.main, 'the shared object survives as one endpoint, not as a second copy of a lie');

  /* And the reference-equality note in `gramjs-session.ts` is a fact about the library, not a style choice: copy
     the same values into two objects and the writer changes what it emits. */
  const split = utils.writeStringSession({ ...normalized, primaryDcs: { main: { ...normalized.primaryDcs.main }, media: { ...normalized.primaryDcs.media } } });
  assert.ok(split.length > asString.length, 'a media endpoint that is merely equal, not identical, is written as a second one');
});

test('the copied interfaces match the declarations they were copied from', { skip: !installed && '@mtcute/core is not installed' }, () => {
  const dcs = readPackage('core/utils/dcs.d.ts');
  const basic = dcs.slice(dcs.indexOf('export interface BasicDcOption'), dcs.indexOf('}', dcs.indexOf('export interface BasicDcOption')));
  const members = [...basic.matchAll(/^\s+(\w+)(\??):/gm)].map((match) => `${match[1]}${match[2] || ''}`);
  assert.deepEqual(members.sort(), ['id', 'ipAddress', 'ipv6?', 'mediaOnly?', 'port', 'testMode?'], 'BasicDcOption is still the six fields our copy declares');

  const stringSession = readPackage('core/highlevel/utils/string-session.d.ts');
  const input = stringSession.slice(stringSession.indexOf('export interface InputStringSessionData'), stringSession.indexOf('}', stringSession.indexOf('export interface InputStringSessionData')));
  assert.deepEqual([...input.matchAll(/^\s+(\w+)(\??):/gm)].map((match) => `${match[1]}${match[2] || ''}`).sort(), ['authKey', 'primaryDcs?', 'self?', 'testMode?'], 'and InputStringSessionData still has authKey as its only required field');

  assert.equal(stringSession.includes('interface DcOptions'), false, 'DcOptions is not declared here, so the two files are read separately rather than one standing in for the other');
  assert.match(dcs, /export interface DcOptions \{\s+main: BasicDcOption;\s+media: BasicDcOption;\s+\}/, 'as main and media, both required, which is what sharing one object satisfies');
});

test('the way the driver is declared is what makes an install safe, and the lock knows about it', () => {
  /* `npm ci` is a promise that the tree in the image matches the tree in the manifest, and that promise is kept
     only if the lockfile was regenerated. An added devDependency that never reached the lock is invisible to
     every test in this repo and fatal to the first CI run that regenerates node_modules from scratch. */
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
  assert.equal(manifest.optionalDependencies?.['@mtcute/node'], '0.32.7', 'the client package is optional, so a platform that cannot build its native dependency loses the driver and keeps the build');
  assert.equal(manifest.dependencies?.['@mtcute/node'], undefined, 'and it is not a dependency, where a failed install script would stop a deployment');
  assert.equal(manifest.devDependencies?.['@mtcute/core'], '0.32.7', 'the types the strict project compiles against are a devDependency');
  for (const [entry, expected] of [['node_modules/@mtcute/core', manifest.devDependencies['@mtcute/core']], ['node_modules/@mtcute/node', manifest.optionalDependencies['@mtcute/node']]]) {
    const locked = lock.packages[entry];
    assert.ok(locked, `${entry} is in the lockfile, which is what makes \`npm ci\` able to install it`);
    assert.equal(locked.version, expected, `${entry} is locked to the version the manifest names`);
  }
  assert.equal(lock.packages['node_modules/@mtcute/core'].dev, undefined, 'core is not dev-only, because the optional driver depends on it too - which is why a production install still has the declarations the typecheck runs against');
  assert.equal(lock.packages['node_modules/better-sqlite3'].optional, true, 'and the native module inherited optionality from the package that dragged it in, which is the whole reason the arrangement works');
});

test('the strict project covers every TypeScript file in the island', () => {
  /* Read whole, not stripped. The include glob below contains a slash followed by two stars, which is the
     beginning of a block comment to anything that tries to be clever about JSONC, and a reader that ate it would
     be checking a wider pattern than the one written - the exact shape of bug this test is here to catch. A
     config with comments in it is allowed to exist; it will fail this line first, which is the trade. */
  const raw = readFileSync(new URL('../tsconfig.strict.json', import.meta.url), 'utf8');
  const config = JSON.parse(raw);
  assert.equal(config.compilerOptions.strict, true);
  assert.equal(config.compilerOptions.noUncheckedIndexedAccess, true, 'including the one option that turns a `rows[0]` into a compile error rather than a runtime undefined');
  assert.equal(config.compilerOptions.allowJs, false, 'and no JavaScript is quietly pulled into it');
  assert.equal(config.compilerOptions.verbatimModuleSyntax, true, 'type-only imports cannot become runtime ones, which matters while the package they describe is optional');
  assert.deepEqual(config.include, ['services/telegram/**/*.ts']);

  const directory = new URL('services/telegram/', new URL('..', import.meta.url));
  const files = readdirSync(directory);
  assert.deepEqual(files.filter((name) => !name.endsWith('.ts')), [], 'every file in the island is TypeScript, because a .js sibling would be checked by the permissive project and nobody would notice');
  assert.deepEqual(files.filter((name) => name.endsWith('.ts')).sort(), ['gramjs-session.ts', 'mtcute-adapter.ts', 'postgres-storage.ts', 'storage-schema.ts'], 'and the island is these four files, no more, until the report has been read');
});

test('a session string that the other driver can use starts from the same bytes the first one wrote', () => {
  /* The end-to-end version of the bridge, without the library in the loop: what `StringSession.save()` produced
     is what a `TELEGRAM_DRIVER=mtcute` boot would be handed, and the two conversions have to agree on every
     field the connection is built from - including the shape of a host that GramJS stored as an IPv6 literal. */
  const key = new Uint8Array(256).fill(3);
  const value = encodeGramjsSession({ dcId: 4, host: '2001:db8::1', port: 80, authKey: key });
  const parsed = parseGramjsSession(value);
  assert.ok(parsed);
  const seed = toMtcuteInputSessionData(toDriverSessionSeed(parsed));
  assert.deepEqual(seed, {
    primaryDcs: { main: { ipAddress: '2001:db8::1', port: 80, id: 4, ipv6: true }, media: { ipAddress: '2001:db8::1', port: 80, id: 4, ipv6: true } },
    self: null,
    authKey: key,
  }, 'a v6 host is marked as v6, which is the flag the transport family reads, and the port survives, which is the field that decides whether the connection reaches the same server');
  assert.equal(seed.primaryDcs.media, seed.primaryDcs.main, 'still one object, shared');
});
