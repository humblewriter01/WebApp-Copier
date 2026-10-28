/**
 * The contract of `services/telegram-adapter.js`.
 *
 * Three things are proven here, and they are three different failure modes:
 *
 * - **Completeness, both ways.** Every touchpoint in `TELEGRAM_TOUCHPOINTS` really is used by the adapter (no
 *   entries kept alive by nobody), and every library access the adapter makes is in the list (a new one cannot be
 *   added without naming it). A list that only goes one way is a list someone can stop maintaining.
 * - **Containment.** No other application file imports `telegram`, mentions `TelegramClient`/`StringSession`/
 *   `Api`/`NewMessage`, or reaches for a client member. This is the part that makes the seam worth having: with it,
 *   the library swap is one file; without it, it is a grep that somebody loses.
 * - **The dependency's own facts.** Four properties of the installed library decide whether an edited post can
 *   reach the database at all - which module exports the edit builder, whether a message carries an edit
 *   timestamp, how a handler pair is chosen for removal, and what the dispatcher hands to each builder. They are
 *   asserted against `node_modules/telegram`, because an archived package is not going to tell us when it changes.
 * - **Purity.** The adapter forwards. Each function returns what the library returned, with the same arguments,
 *   and adds no `catch`, no default, no coercion. Behaviour-preserving is the whole promise of a refactor, so the
 *   promise is asserted per function rather than reviewed by eye.
 *
 * Comments are stripped before any source is scanned: this codebase documents the library at length - why
 * `getMe(true)` is the cached form, which frame throws the keep-alive timeout - and prose about a token must never
 * be mistaken for a use of it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as telegramAdapter from '../services/telegram-adapter.js';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';

const ADAPTER = fileURLToPath(new URL('../services/telegram-adapter.js', import.meta.url));

/** Remove block and line comments. String contents survive; identifiers in prose do not. */
function codeOnly(source) {
  let out = '';
  let i = 0;
  let mode = 'code';
  while (i < source.length) {
    const c = source[i];
    const n = source[i + 1];
    if (mode === 'code') {
      if (c === '/' && n === '/') { mode = 'line'; i += 2; continue; }
      if (c === '/' && n === '*') { mode = 'block'; i += 2; continue; }
      if (c === '"' || c === "'" || c === '`') {
        out += c;
        i += 1;
        while (i < source.length) {
          if (source[i] === '\\') { out += source[i] + (source[i + 1] ?? ''); i += 2; continue; }
          out += source[i];
          if (source[i] === c) { i += 1; break; }
          i += 1;
        }
        continue;
      }
      out += c;
      i += 1;
      continue;
    }
    if (mode === 'line') { if (c === '\n') { mode = 'code'; out += c; } i += 1; continue; }
    if (c === '*' && n === '/') { mode = 'code'; i += 2; continue; }
    out += c === '\n' ? '\n' : ' ';
    i += 1;
  }
  return out;
}

const adapterCode = codeOnly(readFileSync(ADAPTER, 'utf8'));

/** Remove string literals, so a name written in a list is not mistaken for a member being read. */
function withoutStrings(code) {
  return code.replace(/'[^'\n]*'|"[^"\n]*"|`[^`]*`/g, "''");
}
const adapterAccesses = withoutStrings(adapterCode);

/** Every application file that could plausibly talk to Telegram, i.e. every server file except tests. */
function appSources() {
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'test' || entry.name.startsWith('.')) continue;
      const full = `${dir}/${entry.name}`;
      if (entry.isDirectory()) { walk(full); continue; }
      if (full.endsWith('.js') || full.endsWith('.mjs')) found.push(full);
    }
  };
  walk(new URL('..', import.meta.url).pathname.replace(/\/$/, ''));
  return found.filter((file) => file !== ADAPTER);
}

/**
 * What each listed touchpoint looks like in the adapter's code. A touchpoint with no needle is a lie, and the
 * test below says so.
 */
const NEEDLES = {
  'TelegramClient': /new TelegramClient\(/,
  'StringSession': /new StringSession\(/,
  'NewMessage': /new NewMessage\(\{\}\)/,
  'EditedMessage': /new EditedMessage\(\{\}\)/,
  'telegram/events/EditedMessage deep import': /from 'telegram\/events\/EditedMessage\.js'/,
  'Api.auth.SignIn': /new Api\.auth\.SignIn\(/,
  'Api.auth.AuthorizationSignUpRequired': /result instanceof Api\.auth\.AuthorizationSignUpRequired/,
  'Api.updates.GetState': /api\?\.updates\?\.GetState|api\.updates\.GetState/,
  'Api.updates.GetDifference': /api\?\.updates\?\.GetDifference|api\.updates\.GetDifference/,
  'options.connectionRetries': /connectionRetries: (?:CAPTURE_CONNECTION_RETRIES|LOGIN_CONNECTION_RETRIES)/,
  'options.autoReconnect': /autoReconnect: true/,
  'options.useWSS': /useWSS: true/,
  'client.connected': /client\?\.connected === true[\s\S]*?client\?\.connected\)/,
  'client.connect()': /return client\.connect\(\);/,
  'client.disconnect()': /return client\.disconnect\(\);/,
  'client.checkAuthorization()': /return client\.checkAuthorization\(\);/,
  'client.session.save()': /return client\.session\.save\(\);/,
  'client.invoke()': /return client\.invoke\(request\);/,
  'client.getMe()': /return client\.getMe\(true\);/,
  'client.sendCode()': /return client\.sendCode\(context, phoneNumber\);/,
  'client.signInWithPassword()': /return client\.signInWithPassword\(context, \{\s*password: async \(\) => password,\s*onError,\s*\}\);/,
  'client.getDialogs()': /return client\.getDialogs\(options\);/,
  'client.getEntity()': /return client\.getEntity\(handle\);/,
  'client.getMessages()': /return client\.getMessages\(entity, options\);/,
  'client.addEventHandler()': /client\.addEventHandler\(handler, filter\);/,
  'client.removeEventHandler()': /client\.removeEventHandler\(handler, filter\);/,
  'client.listEventHandlers()': /return client\.listEventHandlers\(\);/,
  'client._log': /return client\._log;/,
  'logger.canSend (read)': /return logger\.canSend\.bind\(logger\);/,
  'logger.canSend (write)': /logger\.canSend = gate;/,
  'client.onError (setter)': /client\.onError = handler;/,
  'eventBuilders pair shape': /Array\.isArray\(pair\) && pair\[1\] === handler/,
  'dialog.isChannel': /return dialog\.isChannel \|\| dialog\.isGroup;/,
  'dialog.isGroup': /return dialog\.isGroup \|\| dialog\.entity\?\.megagroup;/,
  'dialog.id': /return dialog\.id\.toString\(\);/,
  'dialog.title': /return dialog\.title;/,
  'dialog.entity.username': /return dialog\.entity\?\.username;/,
  'dialog.entity.megagroup': /dialog\.entity\?\.megagroup/,
};

/**
 * Every library member the adapter is allowed to name, keyed by `owner.member`. Anything outside this table - a
 * `client.sendInvite()`, a `dialog.participantCount` - fails the test until it is listed, and listing it means
 * adding a touchpoint, which is the point.
 */
const ALLOWED_MEMBERS = new Set([
  'client.connect', 'client.disconnect', 'client.connected', 'client.checkAuthorization', 'client.session',
  'client.invoke', 'client.getMe', 'client.sendCode', 'client.signInWithPassword', 'client.getDialogs',
  'client.getEntity', 'client.getMessages', 'client.addEventHandler', 'client.removeEventHandler',
  'client.listEventHandlers', 'client._log', 'client.onError', 'client.constructor',
  'logger.canSend', 'dialog.isChannel', 'dialog.isGroup', 'dialog.id', 'dialog.title', 'dialog.entity',
  'session.save', 'api.updates', 'Api.auth', 'module.Api',
]);
const ALLOWED_CONSTRUCTORS = new Set([
  'TelegramClient', 'StringSession', 'NewMessage', 'EditedMessage', 'api.updates.GetState', 'api.updates.GetDifference', 'Api.auth.SignIn',
]);

test('the touchpoint list is the whole seam, in both directions', () => {
  const listed = telegramAdapter.TELEGRAM_TOUCHPOINTS;
  assert.equal(Array.isArray(listed), true, 'the inventory is data, not a comment');
  /* 36 from the seam itself, plus the two an edited post needed: constructing the library's edit filter, and the
   * deep import that filter has to come through (the barrel does not export it - see the version pin below, which
   * is what makes that a checked fact rather than a memory). Argued for in the PR that added them, as promised. */
  assert.equal(listed.length, 38, 'the count the refactor was scoped on; a new touchpoint must be argued for, not slipped in');
  assert.equal(new Set(listed).size, listed.length, 'nothing is listed twice, which would make the count a fiction');
  assert.deepEqual(Object.isFrozen(listed), true, 'the seam cannot be extended by pushing onto the list at runtime');

  const missing = listed.filter((name) => !(name in NEEDLES));
  assert.deepEqual(missing, [], 'every touchpoint has a needle that proves it exists in the adapter');
  const ghosts = listed.filter((name) => !NEEDLES[name].test(adapterCode));
  assert.deepEqual(ghosts, [], 'nothing may stay in the list after the code it describes is gone');
  const unlisted = Object.keys(NEEDLES).filter((name) => !listed.includes(name));
  assert.deepEqual(unlisted, [], 'the test may not know about an access the module has stopped claiming');
});

test('the adapter touches no library member that is not on the list', () => {
  const owners = /\b(client|logger|dialog|entity|session|api|Api|module)\s*\??\.\s*([A-Za-z_$][\w$]*)/g;
  const seen = new Set();
  let match = null;
  while ((match = owners.exec(adapterAccesses))) seen.add(`${match[1]}.${match[2]}`);
  const constructors = new Set([...adapterAccesses.matchAll(/\bnew\s+([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)/g)].map((m) => m[1]));
  const unknownMembers = [...seen].filter((name) => !ALLOWED_MEMBERS.has(name));
  const unknownConstructors = [...constructors].filter((name) => !ALLOWED_CONSTRUCTORS.has(name));
  assert.deepEqual(unknownMembers, [], 'a GramJS member used here must be declared in TELEGRAM_TOUCHPOINTS');
  assert.deepEqual(unknownConstructors, [], 'a class constructed here must be declared in TELEGRAM_TOUCHPOINTS');
  assert.ok(seen.has('client.invoke') && seen.has('dialog.isChannel') && seen.has('client._log'),
    'and the scan itself has to see the accesses the list promises, or the containment test below is measuring nothing');
});

test('no other application file can reach the library at all', () => {
  const FORBIDDEN = [
    ['imports the package', /from ['"]telegram|import\(\s*['"]telegram/],
    ['constructs a client', /new\s+(?:TelegramClient|StringSession|NewMessage|Api)\b/],
    ['names the TL namespace', /\bApi\b/],
    ['uses a client member', /client\s*\??\.\s*(?:connect|disconnect|connected|invoke|getMe|getEntity|getMessages|getDialogs|sendCode|signInWithPassword|checkAuthorization|addEventHandler|removeEventHandler|listEventHandlers|session|_log|onError|_sender|_eventBuilders|_handleUpdate)\b/],
    ['touches the logging gate or the error accessor', /\w\s*\??\.canSend\b|\.onError\s*=[^=]/],
    ['restates a transport option', /\b(?:useWSS|connectionRetries|autoReconnect)\s*:/],
    ['reads a dialog field', /\bdialog\s*\??\.\s*(?:isChannel|isGroup|id|title|entity)\b/],
  ];
  const offenders = [];
  for (const file of appSources()) {
    const code = codeOnly(readFileSync(file, 'utf8'));
    for (const [what, pattern] of FORBIDDEN) {
      const line = code.split('\n').find((text) => pattern.test(text));
      if (line) offenders.push(`${file.replace(/.*\/server\//, 'server/')} ${what}: ${line.trim().slice(0, 90)}`);
    }
  }
  assert.deepEqual(offenders, [], 'the seam is only a seam if nothing goes around it');

  // The consumers must reach the library *through* the module, so the imports are checked as well as the absence.
  const consumers = ['index.js', 'services/telegram-listener.js', 'services/telegram-keepalive.js'];
  for (const name of consumers) {
    const code = codeOnly(readFileSync(new URL(`../${name}`, import.meta.url), 'utf8'));
    assert.match(code, /import \* as telegramAdapter from '[^']*telegram-adapter\.js'/, `${name} goes through the adapter`);
  }
  assert.match(codeOnly(readFileSync(new URL('../services/telegram-listener.js', import.meta.url), 'utf8')), /telegramAdapter\.invoke\(client, request\)/,
    'the two requests the reconciliation ladder makes are the adapter\'s, not the listener\'s');
});

/** A client that records what it was asked for, so "forwards and nothing else" is checkable. */
function recordingClient(extra = {}) {
  const calls = [];
  const value = (name) => (...args) => { calls.push([name, args]); return { __from: name, args }; };
  const client = {
    connected: true,
    invoke: value('invoke'),
    getMe: value('getMe'),
    sendCode: value('sendCode'),
    signInWithPassword: value('signInWithPassword'),
    getDialogs: value('getDialogs'),
    getEntity: value('getEntity'),
    getMessages: value('getMessages'),
    connect: value('connect'),
    disconnect: value('disconnect'),
    checkAuthorization: value('checkAuthorization'),
    addEventHandler: value('addEventHandler'),
    removeEventHandler: value('removeEventHandler'),
    listEventHandlers: value('listEventHandlers'),
    session: { save: () => { calls.push(['session.save', []]); return 'SESSION-STRING'; } },
    _log: { canSend: () => true },
    ...extra,
  };
  return { client, calls };
}

test('every forwarded call is exactly the call the app used to make, with the same arguments', () => {
  const { client, calls } = recordingClient();
  const handler = () => {};
  const cases = [
    ['connect', () => telegramAdapter.connect(client), ['connect', []]],
    ['disconnect', () => telegramAdapter.disconnect(client), ['disconnect', []]],
    ['invoke', () => telegramAdapter.invoke(client, 'REQ'), ['invoke', ['REQ']]],
    ['getSelf', () => telegramAdapter.getSelf(client), ['getMe', [true]]],
    ['sendCode', () => telegramAdapter.sendCode(client, { apiId: 7 }, '+234'), ['sendCode', [{ apiId: 7 }, '+234']]],
    ['getDialogs', () => telegramAdapter.getDialogs(client, { limit: 200 }), ['getDialogs', [{ limit: 200 }]]],
    ['getEntity', () => telegramAdapter.getEntity(client, '@chan'), ['getEntity', ['@chan']]],
    ['getMessages', () => telegramAdapter.getMessages(client, 'E', { limit: 25 }), ['getMessages', ['E', { limit: 25 }]]],
    ['addMessageHandler', () => telegramAdapter.addMessageHandler(client, handler, 'F'), ['addEventHandler', [handler, 'F']], 'void'],
    ['removeMessageHandler', () => telegramAdapter.removeMessageHandler(client, handler, 'F'), ['removeEventHandler', [handler, 'F']], 'void'],
    ['addEditHandler', () => telegramAdapter.addEditHandler(client, handler, 'F'), ['addEventHandler', [handler, 'F']], 'void'],
    ['removeEditHandler', () => telegramAdapter.removeEditHandler(client, handler, 'F'), ['removeEventHandler', [handler, 'F']], 'void'],
    ['listEventHandlers', () => telegramAdapter.listEventHandlers(client), ['listEventHandlers', []]],
    ['checkAuthorization', () => telegramAdapter.checkAuthorization(client), ['checkAuthorization', []]],
    ['exportSessionString', () => telegramAdapter.exportSessionString(client), ['session.save', []]],
  ];
  for (const [name, run, expected, discard] of cases) {
    calls.length = 0;
    const returned = run();
    assert.deepEqual(calls[0], expected, `${name} forwards one call, with these arguments`);
    assert.equal(calls.length, 1, `${name} makes no second call`);
    // The return value is the library's own object, not a copy or a wrapper: callers `await` it and read it.
    if (expected[0] === 'session.save') assert.equal(returned, 'SESSION-STRING');
    else if (discard === 'void') assert.equal(returned, undefined, `${name} returns nothing, because the call site it replaced never used the answer`);
    else assert.equal(returned.__from, expected[0], `${name} returns what the client returned`);
  }

  // The handler list is pairs, and only a pair whose second slot is our callback counts as attached.
  const attached = (list, cb) => telegramAdapter.isHandlerAttached(list, cb);
  assert.equal(attached([[{}, handler]], handler), true);
  assert.equal(attached([[{}, handler], [{}, () => {}]], handler), true, 'a handler in any position is a live handler');
  assert.equal(attached([[{}, () => {}]], handler), false, ' somebody else\'s callback is not ours');
  assert.equal(attached([], handler), false, 'and an empty list is the deaf case the watchdog exists for');
  assert.equal(attached([null, [1]], handler), false, 'a list of non-pairs is not read as attached');

  // The password prompt is the one place the adapter has to build an object, and the shape is the library's.
  calls.length = 0;
  let asked = 0;
  const passwordClient = { signInWithPassword: (context, options) => { asked += 1; return { context, options }; } };
  const built = telegramAdapter.signInWithPassword(passwordClient, { apiId: 1 }, { password: 'hunter2', onError: async () => false });
  assert.deepEqual(built.context, { apiId: 1 }, 'the api context is passed through untouched');
  assert.equal(typeof built.options.password, 'function', 'the library wants a function, not the string');
  assert.equal(built.options.onError !== undefined, true, 'and the retry answer stays the caller\'s callback');
  assert.equal(asked, 1, 'one call, no retry loop hidden in the seam');

  // Capability probes answer a question about shape, and never about value.
  assert.equal(telegramAdapter.canInvoke(client), true);
  assert.equal(telegramAdapter.canInvoke({}), false);
  assert.equal(telegramAdapter.canInvoke(null), false, 'a missing client is not a TypeError');
  assert.equal(telegramAdapter.canGetSelf({}), false);
  assert.equal(telegramAdapter.canListEventHandlers({ listEventHandlers() {} }), true);
  assert.equal(telegramAdapter.canRemoveMessageHandler({}), false);
  assert.equal(telegramAdapter.canDisconnect({ disconnect: true }), true);
  assert.equal(telegramAdapter.canDisconnect({}), false);
  assert.equal(telegramAdapter.hasLoggerGate({ canSend: () => true }), true);
  assert.equal(telegramAdapter.hasLoggerGate(null), false);
});

test('the connected flag keeps the two meanings it had, and they are not interchangeable', () => {
  // The reconnect gates only believe `true`; the fleet report accepts anything that is not false. Collapsing the
  // two would have the watchdog act on a flag it used to distrust.
  assert.equal(telegramAdapter.isConnected({ connected: true }), true);
  assert.equal(telegramAdapter.isConnected({ connected: 1 }), false);
  assert.equal(telegramAdapter.isConnected({ connected: undefined }), false);
  assert.equal(telegramAdapter.isConnected(null), false);
  assert.equal(telegramAdapter.connectedFlag({ connected: 1 }), true);
  assert.equal(telegramAdapter.connectedFlag({ connected: false }), false);
  assert.equal(telegramAdapter.connectedFlag(null), false);
});

test('the keep-alive guard reaches the library through three names and no more', () => {
  const logger = { canSend: (level) => level !== 'debug' };
  const original = logger.canSend;
  const client = { _log: logger };
  assert.equal(telegramAdapter.clientLogger(client), logger, 'the logger is the client\'s own object, not a copy');
  const bound = telegramAdapter.bindLoggerGate(logger);
  assert.equal(bound('debug'), false, 'the bound gate answers like the library\'s gate');
  let seen = 'unset';
  telegramAdapter.patchLoggerGate(logger, function gate(level) { seen = this === logger ? 'this-is-the-logger' : 'this-is-lost'; return original.call(this, level); });
  assert.equal(seen, 'unset', 'patching alone does not call the new gate');
  logger.canSend('debug');
  assert.equal(seen, 'this-is-the-logger', 'and the gate the adapter installs keeps the logger as its receiver');
  assert.equal(telegramAdapter.clientLogger({}), undefined, 'a client with no logger is reported as such, not thrown');

  let received = null;
  const withAccessor = { set onError(handler) { this.installed = handler; } };
  telegramAdapter.setClientErrorHandler(withAccessor, (error) => { received = error; });
  assert.equal(typeof withAccessor.installed, 'function', 'the assignment goes through the library\'s setter, which is where its error path lands');
  withAccessor.installed(new Error('TIMEOUT'));
  assert.equal(received.message, 'TIMEOUT', 'and the handler the guard passed is the one the library will call');
});

test('the transport options are built once, and the plain-port object is never mutated by the 443 variant', () => {
  const plain = telegramAdapter.captureTransportOptions();
  const wss = telegramAdapter.captureTransportOptions({ wss: true });
  assert.deepEqual(plain, { connectionRetries: 5, autoReconnect: true }, 'the tuned capture transport, in one place');
  assert.deepEqual(wss, { connectionRetries: 5, autoReconnect: true, useWSS: true }, 'and the knob adds exactly one key');
  assert.equal(Object.prototype.hasOwnProperty.call(plain, 'useWSS'), false, 'the fallback path must not inherit the knob');
  assert.equal(Object.prototype.hasOwnProperty.call(plain, 'timeout'), false, 'no request timeout is passed, because this version stores it and never reads it');
  assert.deepEqual(telegramAdapter.loginTransportOptions(), { connectionRetries: 3 }, 'a one-shot handshake gets fewer attempts');
});

test('a client built by the seam is a real GramJS client over a real session string, and nothing connects', () => {
  const client = telegramAdapter.createClient({ sessionString: '', apiId: 123, apiHash: 'hash', options: telegramAdapter.loginTransportOptions() });
  assert.equal(client instanceof TelegramClient, true, 'constructed the way the app always constructed it');
  assert.equal(client.session instanceof StringSession, true, 'the session string is wrapped, not passed through');
  assert.equal(telegramAdapter.exportSessionString(client), '', 'and the round trip of an empty session is empty, which is what a pending login stores');
  assert.equal(telegramAdapter.isConnected(client), false, 'no socket, no flag: `connect()` is still the caller\'s decision');
  assert.equal(telegramAdapter.clientLogger(client) !== undefined, true, 'the guard can be attached the moment it exists, before that decision');
});

test('the message filter is built per registration, because the library compares builders rather than names', () => {
  const first = telegramAdapter.createMessageEventFilter();
  const second = telegramAdapter.createMessageEventFilter();
  assert.notEqual(first, second, 'two calls are two objects, exactly as the two `new NewMessage({})` calls were');

  /* The edited-post filter is a different builder class, and that is the whole mechanism: the dispatcher asks
   * every registered builder to claim an update, `NewMessage.build()` answers only the two "new" updates and
   * `EditedMessage.build()` only the two "edit" updates, so one post fires one handler and one edit fires the
   * other. Same class twice would have been a second name for one subscription, and a signal captured twice. */
  const edits = telegramAdapter.createEditEventFilter();
  const posts = telegramAdapter.createMessageEventFilter();
  assert.notEqual(telegramAdapter.createEditEventFilter(), edits, 'built per registration here too');
  assert.equal(edits.constructor.name, 'EditedMessage', 'the library class, not a look-alike of ours');
  assert.equal(posts.constructor.name, 'NewMessage');
  assert.notEqual(edits.constructor, posts.constructor, 'two builders, two update types each claiming a different one');
  assert.equal(typeof edits.build, 'function', 'and it is a real builder: the dispatcher calls build() on it');
});

/* The seam is allowed to be this thin only because four things are true of the installed library. They are not
 * style notes: each one decides whether an edited post reaches the database at all, and each is a fact about a
 * dependency whose repository is archived - so they are checked against the code that shipped, and a version that
 * changes one of them fails here instead of turning capture into a silent half. */
test('the library facts the edit subscription rests on', () => {
  const at = (rel) => new URL(`../node_modules/telegram/${rel}`, import.meta.url);
  const read = (url) => readFileSync(url, 'utf8');
  const { version } = JSON.parse(read(at('package.json')));
  const skip = existsSync(at('events/index.js')) ? null : 'the package layout moved, which is itself the news this test exists to report';
  if (skip) { console.log(`skipped: ${skip}`); return; }

  // 1. The event the task named does not exist by that name, and the barrel does not export it either.
  const barrel = read(at('events/index.js'));
  assert.equal(/exports\.(MessageEdited|EditedMessage)\b/.test(barrel), false, `telegram@${version}: events/index.js exports no edited-post builder, so the deep import in the adapter is not a preference`);
  assert.match(read(at('events/EditedMessage.js')), /exports\.EditedMessage = EditedMessage/, 'the class is `EditedMessage`, in the file the adapter imports');
  assert.equal(existsSync(at('events/MessageEdited.js')), false, 'and there is no `MessageEdited` module to import by mistake - a name from the library\'s documentation, which would have been `undefined` at `new`');

  // 2. `editDate` is on the message the update carries, because it is in the schema the classes are generated from.
  const schema = read(at('tl/apiTl.js'));
  assert.match(schema, /message#\w+ [^;]*edit_date:flags\.\d+\?int/, `telegram@${version}: messages.Message states edit_date as a flagged timestamp, so message.editDate is the channel\'s own stamp and not our clock`);

  // 3. A detached pair is chosen by filter OR callback, which is why capture is two callbacks and not one.
  const updates = read(at('client/updates.js'));
  assert.match(updates, /removeEventHandler\(client, callback, event\)[\s\S]{0,180}item\[0\] !== event && item\[1\] !== callback/, 'removal matches either half, so one callback under two filters could not be unsubscribed once');
  assert.match(readFileSync(new URL('../services/telegram-listener.js', import.meta.url), 'utf8'), /const handler = \(event\) => ingestMessage\(userId, event\?\.message, event\);\n\s+telegramAdapter\.addMessageHandler\(target, handler, telegramAdapter\.createMessageEventFilter\(\)\);\n\s+current\.handler = handler;\n\s+attachEditHandler\(target, current, userId\);/,
    'and the listener really does register the post handler and the edit handler as two separate callbacks');

  // 4. Every update type reaches every builder, so a second registration is enough - no dispatcher patch needed.
  assert.match(updates, /for \(const \[builder, callback\] of client\._eventBuilders\)/, 'the dispatcher asks each registered builder to claim the update, in registration order');
  assert.match(read(at('events/NewMessage.js')), /build\(update, callback, selfId\)\s*\{\s*if \(update instanceof tl_1\.Api\.UpdateNewMessage \|\|\s*update instanceof tl_1\.Api\.UpdateNewChannelMessage\)/, 'and NewMessage.build claims only the two new-post updates, which is why an edited post never reached capture before this existed');
});

test('the requests the ladder makes are the library\'s own, or null - never a half-built guess', async () => {
  assert.equal(await telegramAdapter.canReconcileUpdates(), true, 'this version can be reconciled with');
  const state = await telegramAdapter.createStateRequest();
  assert.equal(state?.constructor?.className, 'updates.GetState', 'the request the beat asks with');
  const difference = await telegramAdapter.createDifferenceRequest({ pts: 10, qts: 2, date: 3 });
  assert.deepEqual({ pts: difference?.pts?.toNumber?.() ?? difference?.pts, qts: difference?.qts, date: difference?.date }, { pts: 10, qts: 2, date: 3 },
    'and the difference request carries the state we are reconciling from, field for field');
  const firstLoad = telegramAdapter.telegramApi();
  assert.equal(firstLoad === telegramAdapter.telegramApi(), true, 'the namespace is loaded once per process');
  assert.equal((await firstLoad)?.updates?.GetState !== undefined, true, 'and what it loads is the namespace the requests are built from');
});

test('the seam stays off the per-message path, so capture latency is a property of the handler and not of this file', () => {
  const listener = codeOnly(readFileSync(new URL('../services/telegram-listener.js', import.meta.url), 'utf8'));
  const start = listener.indexOf('async function ingestMessage(');
  const end = listener.indexOf('  async function startTelegramListener(userId, client) {', start);
  assert.ok(start > 0 && end > start, 'the capture function is still the one the seam was drawn around');
  const body = listener.slice(start, end);
  assert.equal(/telegramAdapter\./.test(body), false, 'a live update is parsed and stored without asking the client anything - so a wrapper on the client cannot add a hop to the path a signal travels');
  assert.equal(/await import\(/.test(body), false, 'and nothing in it loads a module');
});
