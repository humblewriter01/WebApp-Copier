/**
 * Facts about the two installed packages, asserted against `node_modules`.
 *
 * The rest of the driver tests read our code. These read theirs, because several of the promises this pilot rests
 * on are promises about a dependency's source, and a dependency is the one thing in the repository that changes
 * underneath a passing suite. If any of these starts failing, the meaning is specific: not "the library changed",
 * but "the reason we chose this library for that behavior no longer holds".
 *
 * The style is copied from `test/telegram-adapter.test.js`, which pins the GramJS touchpoints the same way, for
 * the same reason.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const SERVER = join(import.meta.dirname, '..');
const MODULES = join(SERVER, 'node_modules');

const read = (...parts) => readFileSync(join(MODULES, ...parts), 'utf8');
const packageRoot = (entry) => dirname(require.resolve(entry));
const TELEPROTO = packageRoot('teleproto/package.json');
const GRAMJS = packageRoot('telegram/package.json');
const teleproto = JSON.parse(readFileSync(join(TELEPROTO, 'package.json'), 'utf8'));
const gramjs = JSON.parse(readFileSync(join(GRAMJS, 'package.json'), 'utf8'));
const ours = JSON.parse(readFileSync(join(SERVER, 'package.json'), 'utf8'));

test('the option the fork removed is the one we stopped setting, and the replacement is the one we set', () => {
  const base = read('teleproto', 'client', 'TelegramBaseClient.js');
  const types = read('teleproto', 'client', 'TelegramBaseClient.d.ts');
  assert.equal(/useWSS/.test(base + types), false, 'teleproto does not accept useWSS at all, so our gramjs adapter keeping the flag and our teleproto adapter keeping a transport are both required, not stylistic');
  assert.match(types, /transport\?:\s*Transport/, 'and it accepts a `transport`, which is what `captureTransportOptions` in the fork adapter produces');
  assert.match(base, /networkSocket/, 'the older spelling of the same idea is still read, so it is named in the fork\'s deprecation path and not in ours');

  const gramjsBase = read('telegram', 'client', 'TelegramClient.js') + read('telegram', 'client', 'TelegramClient.d.ts');
  assert.match(gramjsBase, /useWSS/, 'GramJS still spells it a flag, which is why the two adapters are allowed to differ on this one key');
  const gramjsAdapter = readFileSync(join(SERVER, 'services', 'telegram-adapter.js'), 'utf8');
  assert.match(gramjsAdapter, /useWSS:\s*true/, 'and the file that is deployed today still asks for wss://<ip>:443/apiws explicitly - the visible 443 fallback is not allowed to go quietly');
});

test('the timeout vocabulary the keep-alive matcher reads is the vocabulary the packages raise', () => {
  /* This is the pair of pins that makes the widened matcher honest. `telegram-keepalive.js` recognises a GramJS
     `Error: TIMEOUT` thrown from its update loop and the fork's `Ping/Read timeout of Ns expired` from its session
     layer; both sentences are written here, in the library, and if either moves, the matcher must move with it or
     the service starts either hiding real faults or filling the log with a beat nobody asked for. */
  const gramjsUpdates = read('telegram', 'client', 'updates.js');
  /* `reject`, not `throw`: GramJS's `timeout()` helper races the ping against a sleep and rejects, which is why
     the matcher for this vocabulary looks at either of the first two frames instead of insisting on one - the
     frame above a rejected promise is chosen by the microtask queue, not by the source. */
  assert.match(gramjsUpdates, /new Error\("TIMEOUT"\)/, 'GramJS still raises a bare TIMEOUT from its update loop');
  const teleprotoSession = read('teleproto', 'network', 'session', 'Session.js');
  assert.match(teleprotoSession, /['"`]Ping timeout of \$\{[^}]*\}s expired['"`]/, 'the fork raises a ping timeout with the elapsed seconds in the text');
  assert.match(teleprotoSession, /['"`]Read timeout of \$\{[^}]*\}s expired['"`]/, 'and a read timeout, shaped the same way');
  /* The asymmetry that makes two vocabularies necessary rather than one tidy one: GramJS keeps the ping loop
     inside its update dispatcher, and the fork moved that job into a session class of its own. A matcher written
     for the first path finds nothing at the second, which is how a re-swap loses the suppression without any of
     our files changing. */
  assert.equal(existsSync(join(MODULES, 'telegram', 'network', 'session', 'Session.js')), false, 'GramJS has no network/session/Session.js, so its timeout can only ever be matched in client/updates.js');
  assert.equal(existsSync(join(MODULES, 'telegram', 'client', 'updates.js')), true, 'and the fork keeps that file too, which is why the GramJS frame stays valid on both drivers');
});

test('the session string format is the fork of the file we already depend on, in both directions', () => {
  const gramjsSession = read('telegram', 'sessions', 'StringSession.js');
  const teleprotoSession = read('teleproto', 'sessions', 'StringSession.js');
  for (const [label, source] of [['gramjs', gramjsSession], ['teleproto', teleprotoSession]]) {
    assert.match(source, /CURRENT_VERSION\s*=\s*['"]1['"]/, `${label}: the same version prefix, so a string written today loads after the switch`);
    assert.match(source, /==\s*352|===\s*352/, `${label}: the same legacy Telethon branch, decided by body length`);
    assert.match(source, /serverAddressLen\s*>\s*100/, `${label}: the same IPv6 rewind, which is the only place the address length is more than a count`);
    assert.match(source, /read\(-1\)/, `${label}: and the same read-the-rest key, which is why a truncated string is a different error and not a shorter key`);
  }
  /* The one numeric difference, quantified rather than waved at: the fork reads and writes the address length and
     port unsigned. For every real value - a hostname under 100 characters, port 443 - the bytes are identical,
     which `test/telegram-session-bridge.test.js` proves by loading and re-saving in both packages. */
  const signed = (source) => (source.match(/(?:read|write)Int16BE/g) || []).length;
  const unsigned = (source) => (source.match(/(?:read|write)UInt16BE/g) || []).length;
  assert.ok(signed(gramjsSession) > 0, 'GramJS uses the signed forms');
  assert.equal(unsigned(gramjsSession), 0, 'and never the unsigned ones');
  assert.equal(signed(teleprotoSession), 0, 'the fork goes the other way, exclusively');
  assert.ok(unsigned(teleprotoSession) > 0);
  assert.equal(unsigned(teleprotoSession), signed(gramjsSession), 'same number of call sites, so nothing was added to the format and nothing taken away');
});

test('the event-class situation is the opposite in each package, and both adapters read that correctly', () => {
  const gramjsEvents = read('telegram', 'events', 'index.js');
  const teleprotoEvents = read('teleproto', 'events', 'index.js');
  assert.match(teleprotoEvents, /EditedMessage/, 'the fork exports EditedMessage from its events barrel');
  assert.equal(/^\s*exports\.EditedMessage\s*=/m.test(gramjsEvents), false, 'GramJS 2.26.22 does not, which is the only reason the deployed adapter deep-imports it');
  assert.match(readFileSync(join(SERVER, 'services', 'telegram-adapter.js'), 'utf8'), /telegram\/events\/EditedMessage\.js/, 'and that deep import is still needed, so it is still there');
  const teleprotoAdapter = readFileSync(join(SERVER, 'services', 'telegram', 'teleproto-adapter.ts'), 'utf8');
  assert.match(teleprotoAdapter, /from 'teleproto\/events'/, 'the fork adapter takes it from the barrel, with no workaround to delete later');
  /* Node resolves CommonJS named imports from assignment patterns only, which is a fact about the seam rather
     than trivia: the fork's root barrel re-exports via `Object.defineProperty`, so the classes a boot needs
     cannot be taken from `teleproto` alone. */
  assert.match(teleprotoAdapter, /import \{ Api, TelegramClient, WebSocketTransport \} from 'teleproto';/, 'three names from the root');
  assert.match(teleprotoAdapter, /import \{ StringSession \} from 'teleproto\/sessions';/, 'and the sessions and events classes from their own modules');
});

test('the logging gate both drivers patch is a level comparison in both, and closed by default in both', () => {
  /* The keep-alive guard reaches into `client._log.canSend` - one of the three accesses the seam exists to make
     visible - because the library's own logger is what prints the timeout, and the guard suppresses it by
     wrapping that predicate. So the predicate has to mean the same thing in both packages, and the test compares
     the two bodies rather than trusting the file names. */
  const body = (name) => {
    const source = read(name, 'extensions', 'Logger.js');
    const matched = source.match(/canSend\(level\)\s*\{([\s\S]*?)\n\s{4}\}/);
    assert.ok(matched, `${name}: Logger.canSend(level) was found, so a rename here is caught as this failure and not as a silent log flood`);
    return matched[1].replace(/\s+/g, ' ').trim();
  };
  const gramjsGate = body('telegram');
  const teleprotoGate = body('teleproto');
  assert.match(gramjsGate, /this\.levels\.indexOf\(this\._logLevel\) >= this\.levels\.indexOf\(level\)/, 'GramJS ranks by position in its level list');
  assert.match(teleprotoGate, /SEVERITY\[this\._logLevel\] >= SEVERITY\[level\]/, 'the fork ranks by number in a severity map');
  for (const [label, gate] of [['gramjs', gramjsGate], ['teleproto', teleprotoGate]]) {
    assert.match(gate, />=/, `${label}: both are a greater-or-equal comparison against the configured level, so a patch that returns a boolean keeps the meaning`);
    assert.match(gate, /_logLevel/, `${label}: and both read the same field our patch reads, which is the only reason bindLoggerGate has to keep \`this\``);
  }
  /* Closed by default, in both, by different routes: GramJS returns `false` when no level is set, and the fork
     computes `SEVERITY[undefined] >= SEVERITY[level]`, which is false because every comparison with undefined is.
     An unconfigured client therefore stays quiet under either driver - which is what the patch relies on. */
  assert.match(gramjsGate, /\?\s*this[\s\S]*:\s*false/, 'GramJS spells the closed default out');
  assert.equal(/\bfalse\b/.test(teleprotoGate), false, 'the fork gets there by arithmetic, so a reader has to know this');
});

test('installing this driver costs nothing that installing GramJS did not', () => {
  /* The reason the first candidate driver was abandoned was a native module that could not be built in the
     sandbox, let alone in a Render preflight. Zero native install steps is therefore a gate, not a preference. */
  assert.equal(teleproto.scripts?.install, undefined, 'no install script');
  assert.equal(teleproto.scripts?.postinstall, undefined, 'no postinstall script');
  assert.equal(teleproto.gypfile, undefined, 'no node-gyp');
  assert.equal(teleproto.binary, undefined, 'no prebuilt binary to fetch');
  for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
    if (field === 'dependencies') continue;
    assert.equal(teleproto[field], undefined, `no ${field} to pull in a build toolchain`);
  }
  assert.ok(Object.keys(teleproto.dependencies || {}).length > 0, 'it does have ordinary dependencies, and each of them is checked too');
  for (const name of Object.keys(teleproto.dependencies)) {
    const manifest = join(MODULES, name, 'package.json');
    if (!existsSync(manifest)) continue;
    const dep = JSON.parse(readFileSync(manifest, 'utf8'));
    assert.equal(dep.gypfile, undefined, `${name} is not a native build`);
    assert.equal(dep.scripts?.install, undefined, `${name} has no install hook`);
    assert.equal(dep.scripts?.postinstall, undefined, `${name} has no postinstall hook`);
  }
  assert.equal(teleproto.license, 'MIT', 'the fork kept the licence, which is the part of a fork that does not get re-negotiated');
  const nodeFloor = (engines) => Number(/(\d+)/.exec(String(engines?.node || ''))?.[1] || 0);
  assert.ok(nodeFloor(ours.engines) >= 22, 'this service needs Node 22 for the type stripping the island runs under, and for globalThis.WebSocket, which the fork uses instead of `ws`');
  assert.ok(nodeFloor(teleproto.engines) <= nodeFloor(ours.engines), 'and the package does not ask for more than the service already requires');
});

test('the fork is a dependency, pinned to the version that was audited, and the abandoned candidate is gone', () => {
  assert.equal(ours.dependencies.teleproto, teleproto.version, 'pinned exactly, not with a caret: an audited library that moves under a passing suite is worse than an unaudited one that does not');
  assert.equal(ours.devDependencies?.teleproto, undefined, 'in dependencies, because the capture listener needs it in production');
  const lock = JSON.parse(readFileSync(join(SERVER, 'package-lock.json'), 'utf8'));
  /* Not an exact pin, and it would be wrong to make it one in this increment: the caret is how the deployed
     driver has always been declared, and changing the default driver's dependency spec while measuring a second
     driver would move two things at once. The version that actually runs is pinned by the lockfile, which is what
     `npm ci` installs and what the Render preflight builds, so it is the lockfile that gets asserted. */
  assert.match(ours.dependencies.telegram, /^\^\d+\.\d+\.\d+$/, 'GramJS keeps the range it has always had, untouched by this pilot');
  const gramjsRange = Number(ours.dependencies.telegram.slice(1).split('.')[0]);
  assert.equal(gramjs.version.split('.')[0], String(gramjsRange), 'the major the app asks for is the major that is installed, because a GramJS 3.x could not be assumed compatible with this seam');
  const lockedGramjs = (lock.packages || {})['node_modules/telegram'];
  assert.ok(lockedGramjs, 'and the lockfile names it');
  assert.equal(lockedGramjs.version, gramjs.version, 'at exactly the version these tests are reading');
  assert.match(ours.scripts.test, /node --test/, 'and the suite that proves all of this runs in the same command as both typechecks');

  const names = Object.keys(lock.packages || {}).filter((path) => path.startsWith('node_modules/'));
  assert.equal(names.some((path) => /mtcute/.test(path)), false, 'the abandoned driver leaves no residue in the lockfile, which is what makes `npm ci` reproducible after the removal');
  assert.equal(names.some((path) => /better-sqlite3/.test(path)), false, 'and neither does the native module that made it unusable here');
  const entry = (lock.packages || {})['node_modules/teleproto'];
  assert.ok(entry, 'the fork is in the lockfile');
  assert.equal(entry.version, teleproto.version, 'at the version that is installed');
  assert.equal(entry.link, undefined, 'as a real install, not a workspace link');
  assert.match(String(entry.resolved || ''), /registry\.npmjs\.org/, 'from the registry, so a Render preflight can fetch it');
});
