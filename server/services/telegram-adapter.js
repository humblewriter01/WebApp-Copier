/**
 * The one seam between this application and GramJS.
 *
 * Every other file in `server/` talks to Telegram through this module, and this module contains every sentence
 * in the codebase that names a GramJS thing: a class, a client method, a private member, an `Api.*` request, a
 * `NewMessage` event filter, a transport option key, or the shape of a `dialog`. Nothing else. That split is the
 * whole contract, and it is enforced rather than requested - `test/telegram-adapter.test.js` fails if an app file
 * outside this module contains any library token, and fails if this module touches a token that is not listed in
 * `TELEGRAM_TOUCHPOINTS` below.
 *
 * Why the seam exists, in the order the reasons matter:
 *
 * 1. **`telegram` is 2.26.22, published in February 2025, and its repository is archived.** It works, and it is
 *    not going to be fixed. The plan is therefore not to fix our client but to be *cheap to leave*: when
 *    `@mtcute/node` (or whatever is current then) replaces it, the change should touch this file and the
 *    call sites' names, not the reconciliation logic, the watchdog, the login routes, or the tests that pin them.
 * 2. **Thirty-odd accesses were spread over three files** - the capture listener, the server bootstrap, and the
 *    keep-alive guard - including three that reach past the public API into `_log`, `logger.canSend` and the
 *    `onError` accessor. Scattered, those are invisible to review; gathered, they are a checklist.
 * 3. **The library's shape is knowledge, and knowledge belongs in one place.** That a handler list is an array of
 *    `[builder, handler]` pairs, that `getMe(true)` is the cached form while `getMe()` re-issues a request, that
 *    `channelId` and `megagroup` live on `dialog.entity`, that `timeout` is accepted and never read: each of those
 *    is a fact about 2.26.22, and each now has exactly one home.
 *
 * What this file deliberately is not:
 *
 * - **Not a policy layer.** Every function here is a forwarding call: no `try`/`catch`, no default that the
 *   caller did not ask for, no `Boolean()` where truthiness was already enough, no swallowed rejection. The
 *   adapter knows *names*; the app keeps deciding what to do. Retry counts, deadlines, cooldowns, strikes,
 *   reconnect ladders, log wording and the user-facing copy all stay with the callers, because that is where the
 *   behaviour lives and a refactor must not move behaviour.
 * - **Not a model layer.** `telegram-peer.js` still reads message and chat-id shapes, and the update-state cache
 *   still lives on the client object under our own `UPDATE_STATE_KEY`. Both are about *our* data hanging off a
 *   library object, not about the library's API, and the swap would leave them where they are.
 * - **Not a singleton.** Construction is exported as a function so the caller owns the client's lifetime, which is
 *   what makes the "attach the guard before `connect()`" rule expressible at the call site instead of buried here.
 */
import { Api, TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { NewMessage } from 'telegram/events/index.js';
/* The edited-post filter, from the file that defines it rather than from the barrel: `telegram/events/index.js`
   exports `Raw`, `NewMessage` and `NewMessageEvent` and *nothing else* (verified against 2.26.22), so a
   `MessageEdited` import - the name the library's own documentation uses - would resolve to `undefined` and die
   on the first `new`. The class here is called `EditedMessage`, it extends `NewMessage`, and its `build()` answers
   exactly the two updates `NewMessage.build()` refuses (`UpdateEditMessage`, `UpdateEditChannelMessage`), which is
   what makes the two handlers a partition rather than a duplication: a new post fires one, an edit fires the other,
   and neither fires twice. */
import { EditedMessage } from 'telegram/events/EditedMessage.js';

/**
 * Every GramJS access this module owns. The count is the contract: the test asserts both that each of these
 * appears in this file and that none of them appears anywhere else in the application.
 */
export const TELEGRAM_TOUCHPOINTS = Object.freeze([
  'TelegramClient',
  'StringSession',
  'NewMessage',
  'EditedMessage',
  'telegram/events/EditedMessage deep import',
  'Api.auth.SignIn',
  'Api.auth.AuthorizationSignUpRequired',
  'Api.updates.GetState',
  'Api.updates.GetDifference',
  'options.connectionRetries',
  'options.autoReconnect',
  'options.useWSS',
  'client.connected',
  'client.connect()',
  'client.disconnect()',
  'client.destroy()',
  'client.checkAuthorization()',
  'client.session.save()',
  'client.invoke()',
  'client.getMe()',
  'client.sendCode()',
  'client.signInWithPassword()',
  'client.getDialogs()',
  'client.getEntity()',
  'client.getMessages()',
  'client.addEventHandler()',
  'client.removeEventHandler()',
  'client.listEventHandlers()',
  'client._log',
  'logger.canSend (read)',
  'logger.canSend (write)',
  'client.onError (setter)',
  'eventBuilders pair shape',
  'dialog.isChannel',
  'dialog.isGroup',
  'dialog.id',
  'dialog.title',
  'dialog.entity.username',
  'dialog.entity.megagroup',
]);

/** How many times the sender may try to *establish* a connection before the client gives up on the attempt. */
const CAPTURE_CONNECTION_RETRIES = 5;
/** The login clients are one-shot handshakes, so they get fewer attempts than a long-lived capture session. */
const LOGIN_CONNECTION_RETRIES = 3;

/* ------------------------------------------------------------------------------------ module loading
   `index.js` has always imported the package eagerly, because a server that cannot build a client is not a
   server. The capture listener has always reached for `Api` lazily and treated a failure as "unknown", and that
   asymmetry is deliberate - a probe the code cannot build must never be the reason a working session is torn
   down - so both shapes are kept here exactly as they were found, behind one memoized promise.
   ------------------------------------------------------------------------------------ */

let apiPromise = null;

/**
 * The `Api` namespace, or `null` when the installed package will not produce one.
 *
 * Memoized because the module registry caches the lookup anyway, and a listener that asked once per beat per
 * session was paying for the promise rather than the import.
 */
export function telegramApi() {
  if (!apiPromise) {
    apiPromise = import('telegram').then((module) => module?.Api ?? null).catch(() => null);
  }
  return apiPromise;
}

/** Can this library answer the two requests the reconciliation ladder needs? False means "do not try". */
export async function canReconcileUpdates() {
  const api = await telegramApi();
  return Boolean(api?.updates?.GetState && api?.updates?.GetDifference);
}

/** `updates.GetState`, or null when this version of the library has no such request. */
export async function createStateRequest() {
  const api = await telegramApi();
  if (!api?.updates?.GetState) return null;
  return new api.updates.GetState();
}

/** `updates.GetDifference` from a known point in the stream. Null when the library cannot answer. */
export async function createDifferenceRequest({ pts, qts, date }) {
  const api = await telegramApi();
  if (!api?.updates?.GetDifference) return null;
  return new api.updates.GetDifference({ pts, qts, date });
}

/* -------------------------------------------------------------------------------------- construction
   Four sites build a client: the two capture transports (primary and its fallback), the restore of a pending
   login from `telegram_login_attempts`, and the client that asks Telegram to send a code. The only difference
   between them is the session string and the options, so the options come from the two builders below rather
   than being spelled out again at each site - which is the same rule that kept the WSS retry from drifting.
   -------------------------------------------------------------------------------------- */

/** A client over a stored session string. Nothing connects until the caller calls `connect`. */
export function createClient({ sessionString, apiId, apiHash, options }) {
  return new TelegramClient(new StringSession(sessionString), apiId, apiHash, options);
}

/**
 * The capture transport options, with the plain-port tuning and the 443 variant in one place.
 *
 * `useWSS` is the only knob that moves the data-centre connection off port 80, and this version of the library
 * has no request timeout worth setting: `timeout` is stored as `_connectTimeout` and never read, which is worse
 * than absent, so it is not passed. `autoReconnect` is what lets the sender keep trying after the attempts run
 * out, and five attempts (rather than three) is what keeps our watchdog from rebuilding a session the library was
 * still recovering - see `telegram-keepalive.js` for the arithmetic that produced that number.
 */
export function captureTransportOptions({ wss = false } = {}) {
  const base = { connectionRetries: CAPTURE_CONNECTION_RETRIES, autoReconnect: true };
  return wss === true ? { ...base, useWSS: true } : base;
}

/** Login and pending-session clients: the same sender, without the long-lived tuning or the transport knob. */
export function loginTransportOptions() {
  return { connectionRetries: LOGIN_CONNECTION_RETRIES };
}

/* --------------------------------------------------------------------------------------- lifecycle
   `connected` is GramJS's own boolean about a TCP socket. It is read in three different moods in this app and
   the moods are not interchangeable, so there are three accessors and no cleverness: `=== true` for the gates
   that refuse to act on anything less, and a plain truthiness read for the places that already treated the flag
   loosely. `disconnect()` is not awaited by the adapter - callers decide whether a failed teardown matters, and
   most of them have already decided it does not.
   --------------------------------------------------------------------------------------- */

export function connect(client) {
  return client.connect();
}

export function disconnect(client) {
  return client.disconnect();
}

/**
 * End a client for good, and mean it: stop its update loop, then close the sender.
 *
 * `disconnect()` alone does not end anything, and this is the line the whole function exists for. In 2.26.22
 * `disconnect()` (`telegramBaseClient.js:158-178`) closes the senders and never touches `_destroyed`, while
 * `_updateLoop` runs `while (!client._destroyed)` (`client/updates.js:166`) - so a client dropped with
 * `disconnect()` keeps sending a `PingDelayDisconnect` every `PING_INTERVAL` (9 s) into a closed sender for the
 * remaining life of the process, timing out three attempts (`PING_FAIL_ATTEMPTS` x `PING_TIMEOUT`) before it does,
 * which is one stack trace per 39 seconds per abandoned session. The library's own cadence is the evidence: the
 * keep-alive summary's production numbers were 1081 timeouts over 11h45m, one per 39.1 s.
 *
 * `destroy()` is the only public call that sets the flag (`telegramBaseClient.js:190-192`), it calls
 * `disconnect()` itself, and it also clears `_eventBuilders` - which is precisely why this is exported as a
 * separate operation rather than folded into `disconnect`: a client the app intends to keep listening with must
 * never be destroyed, and the difference between the two is a single word at the call site.
 *
 * Never throws synchronously, whatever it is handed: every caller is a cleanup path that has already decided a
 * failed teardown is not worth an exception.
 */
export function destroyClient(client) {
  if (typeof client?.destroy === 'function') return client.destroy();
  if (typeof client?.disconnect === 'function') return client.disconnect();
  return Promise.resolve();
}

/** Can this client be torn down at all? Checked before the call, so a half-built object never throws here. */
export function canDisconnect(client) {
  return Boolean(client?.disconnect);
}

/** The strict form: the gates in the reconnect path only trust an affirmative flag. */
export function isConnected(client) {
  return client?.connected === true;
}

/** The loose form, for fleet reporting, where "anything that is not false" is what the panel means. */
export function connectedFlag(client) {
  return Boolean(client?.connected);
}

export function checkAuthorization(client) {
  return client.checkAuthorization();
}

/**
 * The stored form of this client's session, as a string.
 *
 * `session.save()` on a GramJS `StringSession` returns the authorization key and endpoints and *nothing else*:
 * no `pts`, no update state, no channel count. That absence is why this application tracks update state itself,
 * so the two facts must never be confused for one - which is also why the adapter has no `importSession`.
 */
export function exportSessionString(client) {
  return client.session.save();
}

/* ------------------------------------------------------------------------------------------------- auth
   The three steps of a sign-in, in the shapes 2.26.22 wants. `signInWithPassword` takes a *function* for the
   password and an `onError` that answers "retry the prompt?" - both are library conventions, so the callback
   plumbing stays with the caller and only the call itself lives here.
   ------------------------------------------------------------------------------------------------- */

export function sendCode(client, context, phoneNumber) {
  return client.sendCode(context, phoneNumber);
}

/** `auth.SignIn`, the request the phone code is verified with. Static import, because the routes need it now. */
export function createSignInRequest({ phoneNumber, phoneCodeHash, phoneCode }) {
  return new Api.auth.SignIn({ phoneNumber, phoneCodeHash, phoneCode });
}

/** The answer that means "this number has no account", which is a 409 for the user, not a retry. */
export function isSignUpRequired(result) {
  return result instanceof Api.auth.AuthorizationSignUpRequired;
}

/**
 * The two-factor step. The library wants the secret behind a *function* - it calls it again when the first answer
 * is refused - and reads `onError` as "ask the user again?", so the shapes belong here and the password and the
 * failure handling belong to the route.
 */
export function signInWithPassword(client, context, { password, onError }) {
  return client.signInWithPassword(context, {
    password: async () => password,
    onError,
  });
}

/* ------------------------------------------------------------------------------- handlers and events
   Capture is two handlers per client - `NewMessage` for posts, `EditedMessage` for corrections - and the library
   keeps its handlers in `_eventBuilders` as
   `[builder, handler]` pairs. `listEventHandlers()` is the only authoritative answer to "is my handler still on
   this socket", which is why the watchdog reads it instead of trusting `entry.handler`.
   ------------------------------------------------------------------------------- */

/** The filter every capture handler registers with. Empty on purpose: the channel filter is in the database. */
export function createMessageEventFilter() {
  return new NewMessage({});
}

/**
 * The filter an edited-post handler registers with.
 *
 * Same emptiness, same reason: which chats this workspace trades is a database question, not an event-filter one,
 * and an edit has to reach the same channel matching the new message went through.
 */
export function createEditEventFilter() {
  return new EditedMessage({});
}

export function addMessageHandler(client, handler, filter) {
  client.addEventHandler(handler, filter);
}

/**
 * The edit half of the pair.
 *
 * A *separate callback* is not a style choice here. `removeEventHandler` drops every pair that matches the filter
 * **or** the callback (`updates.js`: `item[0] !== event && item[1] !== callback`), so one handler registered twice
 * could not be unsubscribed once: removing the new-message pair would take the edit pair with it and leave the
 * workspace hearing posts but not corrections - the exact bug this seam exists to make impossible to re-introduce.
 * Two callbacks, two filters, and each half can be re-attached on its own.
 */
export function addEditHandler(client, handler, filter) {
  client.addEventHandler(handler, filter);
}

/** Whether this client can detach a handler at all - a question about the client, so both filters use it. */
export function canRemoveMessageHandler(client) {
  return typeof client?.removeEventHandler === 'function';
}

export function removeMessageHandler(client, handler, filter) {
  client.removeEventHandler(handler, filter);
}

/** Detaches an edited-post handler, and only that one - see `addEditHandler` for why the callback is what separates them. */
export function removeEditHandler(client, handler, filter) {
  client.removeEventHandler(handler, filter);
}

export function canListEventHandlers(client) {
  return typeof client?.listEventHandlers === 'function';
}

/** The library's own handler list, in whatever shape this version hands back. */
export function listEventHandlers(client) {
  return client.listEventHandlers();
}

/**
 * Is this callback in that list? The pair shape is GramJS's: `[eventBuilder, handler]`, and a bare array check is
 * what keeps a client that returns something else from being read as "attached".
 */
export function isHandlerAttached(builders, handler) {
  return builders.some((pair) => Array.isArray(pair) && pair[1] === handler);
}

/* ---------------------------------------------------------------------------------------- requests
   The two requests the reconciliation ladder makes, and the identity check the first one rides along with.
   `getMe(true)` is the form that returns the cached self peer; the argumentless form always re-issues
   `users.GetUsers`, which on a healthy session is a request for nothing.
   ---------------------------------------------------------------------------------------- */

export function canInvoke(client) {
  return typeof client?.invoke === 'function';
}

export function invoke(client, request) {
  return client.invoke(request);
}

export function canGetSelf(client) {
  return typeof client?.getMe === 'function';
}

export function getSelf(client) {
  return client.getMe(true);
}

/* --------------------------------------------------------------------------------------- history
   What a rebuilt session reads back: the channel by handle, then its recent messages. A numeric id has to be a
   `BigInt` for the library to resolve it, which is why the caller passes the handle it already chose and not a
   string it hopes will do.
   --------------------------------------------------------------------------------------- */

export function getEntity(client, handle) {
  return client.getEntity(handle);
}

export function getMessages(client, entity, options) {
  return client.getMessages(entity, options);
}

/* --------------------------------------------------------------------------------------- dialogs
   The workspace's channel list. These field names are 2.26.22's: `isChannel`/`isGroup` on the dialog, `id`
   already run through `getPeerId`, and the title, handle and `megagroup` flag on the resolved `entity`.
   --------------------------------------------------------------------------------------- */

export function getDialogs(client, options) {
  return client.getDialogs(options);
}

/** Channels and groups, which is everything a workspace can monitor. Returned as the library reports it. */
export function dialogIsChannelLike(dialog) {
  return dialog.isChannel || dialog.isGroup;
}

/** A supergroup is a channel to Telegram and a group to a trader, and this is the only place that decides. */
export function dialogIsGroupLike(dialog) {
  return dialog.isGroup || dialog.entity?.megagroup;
}

/** The peer id as text. Not `String(...)`: a dialog without an id is a library change, and it should throw. */
export function dialogPeerIdText(dialog) {
  return dialog.id.toString();
}

export function dialogTitle(dialog) {
  return dialog.title;
}

export function dialogUsername(dialog) {
  return dialog.entity?.username;
}

/* ------------------------------------------------------------------------- the keep-alive guard's seams
   The library catches its own ping timeout, hands the error to `_errorHandler`, then asks `_log.canSend('error')`
   before printing. That gate is the only place a timeout can be recognised and hidden before it reaches a
   printer, so the guard needs three things from the client: the logger, the ability to answer its one question,
   and `onError`. All three are private or accessor-shaped, which is precisely why they are named here.
   ------------------------------------------------------------------------- */

/** The client's own logger object, or undefined on a client that was never given one. */
export function clientLogger(client) {
  return client._log;
}

/** Is there a gate to ask? Anything else means the guard counts and stays quiet about the printing. */
export function hasLoggerGate(logger) {
  return typeof logger?.canSend === 'function';
}

/** The library's own gate, bound to the logger, so wrapping it cannot lose `this`. */
export function bindLoggerGate(logger) {
  return logger.canSend.bind(logger);
}

/** Replace the gate. The caller owns every decision inside the function it passes. */
export function patchLoggerGate(logger, gate) {
  logger.canSend = gate;
}

/**
 * Install the client's error handler. `onError` is a setter that writes `_errorHandler`, so this is an
 * assignment through an accessor rather than a property write, and a client built without the setter will throw
 * - which the guard catches, and that is the point of catching it there.
 */
export function setClientErrorHandler(client, handler) {
  client.onError = handler;
}
