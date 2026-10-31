/**
 * The two drivers, the same inputs, the same answers.
 *
 * This is the file the deployment gate is judged on. "Behavior unchanged" is a claim about 45 functions, so it is
 * tested as 45 functions: every one of them is called with the same arguments through the GramJS adapter and the
 * teleproto adapter, and the two results have to agree. Where a call would need a live socket, the client is a
 * recorder instead, which is what proves the *forwarding* - the method called, the arguments passed, the value
 * handed back unchanged - rather than the library's behavior. Where a call touches only our data (a dialog row, a
 * transport option), it runs on the real thing.
 *
 * Three things in here are worth more than the rest:
 *
 *  - **The handler-pair test runs against two real, connected-nothing clients**, and requires each driver to keep
 *    the same `[builder, handler]` list and the same detach semantics. That is the property the edited-message
 *    capture rests on, and it is the one a fork could silently change.
 *  - **`instanceof` does not cross package lines.** `isSignUpRequired` is true for the request class of its *own*
 *    package and false for the other's, so one process must have exactly one adapter. If this ever starts
 *    returning true for both, the packages have begun sharing a prototype chain and the seam has a new failure to
 *    think about.
 *  - **The transport options differ by exactly one key**, on purpose, because `useWSS` does not exist in the fork.
 *    Removing the `transport` entry has to leave the GramJS object identical - so the pilot measures one change,
 *    not two.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import * as gramjs from '../services/telegram-adapter.js';
import * as teleproto from '../services/telegram/teleproto-adapter.ts';
import { StringSession as GramjsStringSession } from 'telegram/sessions/index.js';
import { Api as GramjsApi } from 'telegram';
import { Api as TeleprotoApi } from 'teleproto';
import { resolveTelegramAdapter } from '../services/telegram-driver.js';

const DRIVERS = { gramjs, teleproto };
const KEY = new Uint8Array(Array.from({ length: 256 }, (_, index) => (index * 13 + 9) % 247));

/** A client that records what was asked of it and answers with the same sentinel, for both drivers alike. */
function recorder() {
  const calls = [];
  const sentinel = { sent: true };
  const method = (name) => (...args) => { calls.push({ name, args }); return sentinel; };
  const client = {
    calls,
    sentinel,
    connect: method('connect'),
    disconnect: method('disconnect'),
    destroy: method('destroy'),
    checkAuthorization: method('checkAuthorization'),
    invoke: method('invoke'),
    getMe: method('getMe'),
    getEntity: method('getEntity'),
    getMessages: method('getMessages'),
    getDialogs: method('getDialogs'),
    sendCode: method('sendCode'),
    signInWithPassword: method('signInWithPassword'),
    addEventHandler: method('addEventHandler'),
    removeEventHandler: method('removeEventHandler'),
    listEventHandlers: () => { calls.push({ name: 'listEventHandlers', args: [] }); return sentinel; },
    session: { save: method('session.save') },
    _log: { canSend: () => 'gate' },
  };
  return client;
}

/** Every method whose whole job is to call one thing on the client and hand back exactly what it returned. */
const FORWARDS = [
  ['connect', (adapter, client) => adapter.connect(client), 'connect', []],
  ['disconnect', (adapter, client) => adapter.disconnect(client), 'disconnect', []],
  ['destroyClient', (adapter, client) => adapter.destroyClient(client), 'destroy', []],
  ['checkAuthorization', (adapter, client) => adapter.checkAuthorization(client), 'checkAuthorization', []],
  ['exportSessionString', (adapter, client) => adapter.exportSessionString(client), 'session.save', []],
  ['invoke', (adapter, client) => adapter.invoke(client, { _: 'a.request' }), 'invoke', [{ _: 'a.request' }]],
  ['getSelf', (adapter, client) => adapter.getSelf(client), 'getMe', [true]],
  ['getEntity', (adapter, client) => adapter.getEntity(client, 'golddesk'), 'getEntity', ['golddesk']],
  ['getMessages', (adapter, client) => adapter.getMessages(client, 123, { limit: 20 }), 'getMessages', [123, { limit: 20 }]],
  ['getDialogs', (adapter, client) => adapter.getDialogs(client, { limit: 50 }), 'getDialogs', [{ limit: 50 }]],
  ['sendCode', (adapter, client) => adapter.sendCode(client, { apiId: 1, apiHash: 'h' }, '+2348012345678'), 'sendCode', [{ apiId: 1, apiHash: 'h' }, '+2348012345678']],
  ['addMessageHandler', (adapter, client) => adapter.addMessageHandler(client, function handler() {}, { tag: 'message' }), 'addEventHandler', [undefined, { tag: 'message' }]],
  ['addEditHandler', (adapter, client) => adapter.addEditHandler(client, function handler() {}, { tag: 'edit' }), 'addEventHandler', [undefined, { tag: 'edit' }]],
  ['removeMessageHandler', (adapter, client) => adapter.removeMessageHandler(client, function handler() {}, { tag: 'message' }), 'removeEventHandler', [undefined, { tag: 'message' }]],
  ['removeEditHandler', (adapter, client) => adapter.removeEditHandler(client, function handler() {}, { tag: 'edit' }), 'removeEventHandler', [undefined, { tag: 'edit' }]],
  ['listEventHandlers', (adapter, client) => adapter.listEventHandlers(client), 'listEventHandlers', []],
];

test('the two adapters expose exactly the same surface', () => {
  const gramjsNames = Object.keys(gramjs).filter((name) => typeof gramjs[name] === 'function').sort();
  const teleprotoNames = Object.keys(teleproto).filter((name) => typeof teleproto[name] === 'function').sort();
  assert.deepEqual(teleprotoNames, gramjsNames, 'no operation exists on one driver and not the other');
  for (const name of gramjsNames) {
    assert.equal(teleproto[name].length, gramjs[name].length, `${name} takes the same number of parameters`);
  }
  assert.ok(gramjsNames.length >= 45, `the seam is ${gramjsNames.length} functions, which is the number both files are held to`);
});

const VOID_FORWARDS = ['addMessageHandler', 'addEditHandler', 'removeMessageHandler', 'removeEditHandler'];

test('every client call is forwarded to the same method, with the same arguments, and returned untouched', () => {
  for (const [name, call, expectedMethod, expectedArgs] of FORWARDS) {
    const results = {};
    for (const [driver, adapter] of Object.entries(DRIVERS)) {
      const client = recorder();
      const returned = call(adapter, client);
      const recorded = client.calls;
      assert.deepEqual(recorded.map((entry) => entry.name), [expectedMethod], `${driver}.${name} calls ${expectedMethod} and nothing else`);
      const args = recorded[0].args;
      assert.equal(args.length, expectedArgs.length, `${driver}.${name} passes ${expectedArgs.length} argument(s)`);
      for (let index = 0; index < expectedArgs.length; index += 1) {
        if (expectedArgs[index] === undefined) continue;
        assert.deepEqual(args[index], expectedArgs[index], `${driver}.${name} passes argument ${index} through unchanged`);
      }
      /* Four of these are statements, not expressions, in the original file: the handler registration and
         removal return nothing at all, because GramJS returns nothing and a refactor that started returning the
         client's value would be a new promise to reason about at every call site. Parity means matching that. */
      if (VOID_FORWARDS.includes(name)) assert.equal(returned, undefined, `${driver}.${name} returns nothing, as the file it mirrors does`);
      else assert.equal(returned, client.sentinel, `${driver}.${name} hands back exactly what the client returned - no await, no catch, no default`);
      results[driver] = recorded;
    }
    assert.deepEqual(results.teleproto.map((entry) => entry.name), results.gramjs.map((entry) => entry.name), `${name} reaches the same method on both`);
  }
});

test('the two guards that read a client answer the same for the same shape', () => {
  const full = recorder();
  const cases = [
    ['canDisconnect', (a) => a.canDisconnect(full), true],
    ['canDisconnect(empty)', (a) => a.canDisconnect({}), false],
    ['canDisconnect(null)', (a) => a.canDisconnect(null), false],
    ['canInvoke', (a) => a.canInvoke(full), true],
    ['canGetSelf', (a) => a.canGetSelf(full), true],
    ['isConnected(connected=true)', (a) => a.isConnected({ connected: true }), true],
    ['isConnected(connected=undefined)', (a) => a.isConnected({ connected: undefined }), false],
    ['isConnected(connected=truthy)', (a) => a.isConnected({ connected: 1 }), false],
    ['connectedFlag(connected=1)', (a) => a.connectedFlag({ connected: 1 }), true],
    ['connectedFlag(connected=false)', (a) => a.connectedFlag({ connected: false }), false],
    ['canRemoveMessageHandler', (a) => a.canRemoveMessageHandler(full), true],
    ['canListEventHandlers', (a) => a.canListEventHandlers(full), true],
    ['canListEventHandlers(missing)', (a) => a.canListEventHandlers({}), false],
    ['hasLoggerGate', (a) => a.hasLoggerGate(full._log), true],
    ['hasLoggerGate(none)', (a) => a.hasLoggerGate({}), false],
    ['isHandlerAttached(pair)', (a) => a.isHandlerAttached([[{}, function h() {}]], function h() {}), false],
    ['dialogIsChannelLike', (a) => a.dialogIsChannelLike({ isChannel: false, isGroup: true }), true],
    ['dialogIsGroupLike(megagroup)', (a) => a.dialogIsGroupLike({ isGroup: false, entity: { megagroup: true } }), true],
    ['dialogIsGroupLike(channel)', (a) => a.dialogIsGroupLike({ isGroup: false, entity: { megagroup: false } }), false],
    ['dialogTitle', (a) => a.dialogTitle({ title: 'Gold Desk' }), 'Gold Desk'],
    ['dialogUsername', (a) => a.dialogUsername({ entity: { username: 'xauusd' } }), 'xauusd'],
    ['dialogUsername(no entity)', (a) => a.dialogUsername({}), undefined],
    ['dialogPeerIdText', (a) => a.dialogPeerIdText({ id: { toString: () => '-100123' } }), '-100123'],
  ];
  for (const [label, call, expected] of cases) {
    for (const [driver, adapter] of Object.entries(DRIVERS)) {
      assert.equal(call(adapter), expected, `${driver}: ${label}`);
    }
  }

  /* The one place the two drivers' declarations genuinely differ: GramJS types `Dialog.id` as required and the
     fork as optional. A missing id has to be fatal in both, and the fork's adapter says why in words. */
  assert.throws(() => gramjs.dialogPeerIdText({ id: undefined }), TypeError, 'gramjs throws on a dialog with no id');
  assert.throws(() => teleproto.dialogPeerIdText({ id: undefined }), (error) => /no peer id/.test(error.message), 'teleproto throws on a dialog with no id, naming the library');
});

test('transport options differ by exactly one key, and that key is the transport', () => {
  for (const wss of [false, true]) {
    const a = gramjs.captureTransportOptions({ wss });
    const b = teleproto.captureTransportOptions({ wss });
    if (!wss) assert.deepEqual(b, a, 'the plain-port shape is identical, key for key');
    const { transport, ...rest } = b;
    assert.deepEqual(rest, { connectionRetries: 5, autoReconnect: true }, 'strip the transport and the GramJS-only flag, and what is left is the same two numbers both drivers were tuned with');
    assert.equal(a.useWSS, wss ? true : undefined, 'gramjs asks for WSS with a flag');
    assert.equal(transport?.constructor?.name, wss ? 'WebSocketTransport' : undefined, 'the fork asks with a transport object, which is what wss://<ip>:443/apiws means');
    if (wss) assert.equal(typeof transport?.resolve, 'function', 'and the transport is the object the client asks for a connection factory');
  }
  assert.deepEqual(teleproto.loginTransportOptions(), gramjs.loginTransportOptions(), 'login clients are identical: no transport knob, no autoReconnect');
  assert.deepEqual(gramjs.captureTransportOptions(), gramjs.captureTransportOptions({ wss: false }), 'a missing argument is the same as asking for plain ports');
  assert.deepEqual(teleproto.captureTransportOptions(), teleproto.captureTransportOptions({ wss: false }));
});

test('event filters and requests are built from each package own classes', async () => {
  const filters = { gramjs: [], teleproto: [] };
  const built = [];
  for (const [driver, adapter] of Object.entries(DRIVERS)) {
    const message = adapter.createMessageEventFilter();
    const edit = adapter.createEditEventFilter();
    assert.equal(message.constructor.name, 'NewMessage', `${driver} builds a NewMessage`);
    assert.equal(edit.constructor.name, 'EditedMessage', `${driver} builds an EditedMessage`);
    assert.equal(Object.getPrototypeOf(message) === Object.getPrototypeOf(edit), false, 'and they are different builders, because that is what makes the two handlers a partition');
    filters[driver].push(message, edit);

    const state = await adapter.createStateRequest();
    const difference = await adapter.createDifferenceRequest({ pts: 7, qts: 8, date: 9 });
    /* Compared by `className`, the TL name every request carries, and by the constructor id the frame is tagged
       with - not by `constructor.name`, which is 'VirtualClass' for every GramJS request (the archived package
       builds its `Api` classes through a factory) and `updates.GetState` in the fork (which declares them as
       classes). An assertion on the class name would be measuring how each package was generated; the
       CONSTRUCTOR_ID is the only one of the two that changes what goes on the wire, so both are compared. */
    const identify = (request) => ({ className: request?.className, id: request?.CONSTRUCTOR_ID ?? Object.getPrototypeOf(request)?.CONSTRUCTOR_ID });
    built.push({ state: identify(state), difference: identify(difference) });
    assert.equal(state.className, 'updates.GetState', `${driver} can build updates.GetState`);
    assert.equal(difference.className, 'updates.GetDifference', `${driver} can build updates.GetDifference`);
    assert.equal(difference.pts, 7);
    assert.equal(difference.date, 9);
    assert.equal(await adapter.canReconcileUpdates(), true, `${driver} can reconcile`);

    const signIn = adapter.createSignInRequest({ phoneNumber: '+1', phoneCodeHash: 'h', phoneCode: '12345' });
    assert.equal(signIn.className, 'auth.SignIn');
    built[built.length - 1].signIn = identify(signIn);
    assert.equal(typeof built[built.length - 1].signIn.id, 'number', `${driver}: the sign-in request is tagged with a constructor id`);
    assert.equal(signIn.phoneCode, '12345', 'the code is passed through, not trimmed, hashed, or re-read');
  }
  assert.deepEqual(built[1], built[0], 'both drivers build the same three requests, with the same TL names and the same constructor ids, which is the whole point of a fork');
  for (const row of built) for (const key of ['state', 'difference', 'signIn']) {
    assert.ok(row[key].id > 0, `${key} carries a positive constructor id on both`);
  }
  assert.notEqual(Object.getPrototypeOf(filters.gramjs[0]), Object.getPrototypeOf(filters.teleproto[0]), 'a GramJS filter is not a teleproto filter, so exactly one adapter may be in play in a process');

  /* `instanceof` is per package, which is a fact about the swap rather than a curiosity: the fork's own class is
     not an instance of the archived one. Any code that mixed the two adapters would find its own objects
     unrecognised, and this is the pin that says so. */
  assert.equal(gramjs.isSignUpRequired(new GramjsApi.auth.AuthorizationSignUpRequired({})), true);
  assert.equal(gramjs.isSignUpRequired(new TeleprotoApi.auth.AuthorizationSignUpRequired({})), false, 'a cross-package instance is not recognised, deliberately');
  assert.equal(teleproto.isSignUpRequired(new TeleprotoApi.auth.AuthorizationSignUpRequired({})), true);
  assert.equal(teleproto.isSignUpRequired(new GramjsApi.auth.AuthorizationSignUpRequired({})), false);
  assert.equal(gramjs.isSignUpRequired({}), false);
});

test('a session saved by one driver loads in the other, through the adapters', async () => {
  const session = new GramjsStringSession();
  session._dcId = 3;
  session._serverAddress = '149.154.175.53';
  session._port = 443;
  session._key = Buffer.from(KEY);
  session._authKey = { getKey: () => Buffer.from(KEY) };
  const stored = session.save();

  const a = gramjs.createClient({ sessionString: stored, apiId: 1, apiHash: 'h', options: gramjs.loginTransportOptions() });
  const b = teleproto.createClient({ sessionString: stored, apiId: 1, apiHash: 'h', options: teleproto.loginTransportOptions() });
  /* `save()` writes from the *computed* auth key, which each library derives from the parsed string inside
     `load()` - GramJS calls it from the client constructor, the fork memoizes it. Awaiting both explicitly is what
     makes this a test of the string rather than of a half-initialised session object. */
  await a.session.load();
  await b.session.load();
  assert.equal(gramjs.exportSessionString(a), stored, 'the first driver re-saves the string it was given, unchanged');
  assert.equal(teleproto.exportSessionString(b), stored, 'and so does the fork, which is the no-re-login property');
  assert.equal(a.session.constructor.name, 'StringSession');
  assert.equal(b.session.constructor.name, 'StringSession');
  assert.equal(Boolean(a.connected), false, 'neither client claims a connection before one exists');
  assert.equal(Boolean(b.connected), false);
});

test('the handler list behaves the same on two real clients, including the detach', () => {
  const built = {};
  for (const [driver, adapter] of Object.entries(DRIVERS)) {
    const client = adapter.createClient({
      sessionString: new GramjsStringSession().save() || '',
      apiId: 1,
      apiHash: 'h',
      options: adapter.captureTransportOptions({ wss: true }),
    });
    const messageFilter = adapter.createMessageEventFilter();
    const editFilter = adapter.createEditEventFilter();
    const onMessage = function onMessage() {};
    const onEdit = function onEdit() {};
    adapter.addMessageHandler(client, onMessage, messageFilter);
    adapter.addEditHandler(client, onEdit, editFilter);

    const list = adapter.listEventHandlers(client);
    assert.equal(list.length, 2, `${driver}: two handlers, one per pair`);
    assert.equal(adapter.isHandlerAttached(list, onMessage), true, `${driver}: the pair shape is [builder, handler]`);
    assert.equal(adapter.isHandlerAttached(list, onEdit), true);

    /* The rule the edited-message capture cannot work without: removing the edit pair leaves the message pair.
       On a shared callback this would drop both, and a workspace would hear posts but not corrections. */
    adapter.removeEditHandler(client, onEdit, editFilter);
    const after = adapter.listEventHandlers(client);
    assert.equal(after.length, 1, `${driver}: one handler left`);
    assert.equal(adapter.isHandlerAttached(after, onMessage), true, `${driver}: and it is the new-message one`);
    assert.equal(adapter.isHandlerAttached(after, onEdit), false);

    adapter.addEditHandler(client, onEdit, editFilter);
    assert.equal(adapter.listEventHandlers(client).length, 2, `${driver}: re-attaching the edit half alone works, which is what the reconnect path does`);
    built[driver] = after.map((pair) => Array.isArray(pair) ? pair.length : typeof pair);
  }
  assert.deepEqual(built.teleproto, built.gramjs, 'the list holds the same pair shape in both');
});

test('the keep-alive seams ask the same questions of the same logger', () => {
  for (const [driver, adapter] of Object.entries(DRIVERS)) {
    const client = { _log: { level: 'error', canSend(level) { return this.seen = (this.seen || []).concat(level), true; } } };
    const logger = adapter.clientLogger(client);
    assert.equal(logger, client._log, `${driver}: clientLogger is the client's own object, not a copy`);
    assert.equal(adapter.hasLoggerGate(logger), true);
    const gate = adapter.bindLoggerGate(logger);
    assert.equal(gate('error'), true, `${driver}: the bound gate keeps its receiver`);
    assert.deepEqual(logger.seen, ['error'], `${driver}: and passes the level through`);

    let replaced = null;
    adapter.patchLoggerGate(logger, (level) => { replaced = level; return false; });
    assert.equal(logger.canSend('warn'), false, `${driver}: the patch is in place on the library's object`);
    assert.equal(replaced, 'warn');
    assert.equal(adapter.hasLoggerGate({}), false, `${driver}: a logger without the gate is reported, not guessed`);
    assert.equal(adapter.hasLoggerGate(undefined), false);
  }
});

test('the resolver hands each name its own module, and refuses a driver this build does not know', async () => {
  const gramjsResolved = await resolveTelegramAdapter({ env: { TELEGRAM_DRIVER: 'gramjs' } });
  assert.equal(gramjsResolved.adapter, gramjs, 'gramjs is the module object the app imports today');
  const teleprotoResolved = await resolveTelegramAdapter({ env: { TELEGRAM_DRIVER: 'teleproto' } });
  assert.equal(teleprotoResolved.adapter, teleproto, 'and teleproto is the island adapter, not a wrapper of the first');
  for (const name of Object.keys(gramjs).filter((key) => typeof gramjs[key] === 'function')) {
    assert.equal(typeof teleprotoResolved.adapter[name], 'function', `${name} exists on the fork adapter`);
  }
  const stale = await resolveTelegramAdapter({ env: { TELEGRAM_DRIVER: 'mtcute' } });
  assert.equal(stale.adapter, gramjs, 'a retired driver name lands on the driver that works');
  assert.match(stale.note, /mtcute/, 'and the note says what was ignored');
});
