/**
 * The second Telegram driver: the same 45 operations as `services/telegram-adapter.js`, on `teleproto`.
 *
 * Why this file is small. GramJS is archived and teleproto is its maintained fork, so the seam needed no new
 * design - it needed a second set of import specifiers and one option renamed. Everything below is a forwarding
 * call with the same name, the same arity and the same absence of policy as the GramJS file it mirrors, and
 * `test/telegram-driver-parity.test.js` proves that by giving both adapters the same inputs and comparing the
 * outputs. What is NOT here is also a rule: no ping-knob tuning, no timeout, no retry arithmetic. The pilot is
 * allowed exactly one unproven change - the library - so the transport that GramJS chose with `useWSS` is chosen
 * here with `transport`, and nothing else about the connection is adjusted. (`telegram-keepalive.js` grew one
 * matcher for teleproto's two timeout messages and nothing more; the rtt-based `pingMay`/`pingMust`/
 * `pingDisconnect` knobs teleproto offers are a separate, later decision.)
 *
 * Three differences from GramJS are worth naming, because each is a place where a "compatible" fork is not:
 *
 *  - **`useWSS` does not exist.** The option is `transport?: Transport`, and `WebSocketTransport` is the 443
 *    path (it builds `wss://<ip>:443/apiws` and takes its socket from `globalThis.WebSocket`, which is why this
 *    file requires nothing extra on Node 22 and can be handed `ws` on an older runtime). `networkSocket` still
 *    exists and logs a deprecation warning, which is the wrong way to live.
 *  - **`Dialog.id` is optional in the declarations.** GramJS declares it required. The accessor below therefore
 *    has to do something explicit with a missing id rather than let a TypeError escape, and the choice is to
 *    throw with a name that says which library changed - the same behaviour as before (this is fatal for the row
 *    and caught by the caller), better error text.
 *  - **`EditedMessage` is in `teleproto/events`.** The deep import in the GramJS adapter exists only because
 *    2.26.22's barrel omits the class; the fork exports it from the barrel, so the workaround has no reason to
 *    survive into a new file. (`Raw` comes along too, which is what the latency pilot stamps arrival with.)
 *    The specifiers are not free to be chosen by taste, though: the root barrel publishes its re-exports with
 *    `Object.defineProperty`, which Node's CommonJS named-export detection does not see, so `StringSession`,
 *    `NewMessage` and `EditedMessage` must come from the subpath modules and only `Api`, `TelegramClient` and
 *    `WebSocketTransport` come from the root. Getting that backwards is an import-time SyntaxError, on every boot.
 *
 * Sessions need no conversion at all - `StringSession` reads the same bytes, which is what
 * `test/telegram-session-bridge.test.js` exists to keep true.
 */
import { Api, TelegramClient, WebSocketTransport } from 'teleproto';
import { EditedMessage, NewMessage } from 'teleproto/events';
import { StringSession } from 'teleproto/sessions';
import type { Dialog } from 'teleproto/tl/custom/dialog.js';

/** How many times the sender may try to *establish* a connection before the client gives up on the attempt. */
const CAPTURE_CONNECTION_RETRIES = 5;
/** The login clients are one-shot handshakes, so they get fewer attempts than a long-lived capture session. */
const LOGIN_CONNECTION_RETRIES = 3;

/* ------------------------------------------------------------------------------------ module loading
   The same asymmetry the GramJS adapter keeps, on purpose: `Api` is reached for lazily and a failure is
   "unknown", because a probe the code cannot build must never be the reason a working session is torn down.
   ------------------------------------------------------------------------------------ */

type ApiNamespace = typeof Api;

let apiPromise: Promise<ApiNamespace | null> | null = null;

/** The `Api` namespace, or `null` when the installed package will not produce one. */
export function telegramApi(): Promise<ApiNamespace | null> {
    if (!apiPromise) {
        apiPromise = import('teleproto').then((module) => (module?.Api ?? null) as ApiNamespace | null).catch(() => null);
    }
    return apiPromise;
}

/** Can this library answer the two requests the reconciliation ladder needs? False means "do not try". */
export async function canReconcileUpdates(): Promise<boolean> {
    const api = await telegramApi();
    return Boolean((api as unknown as Record<string, Record<string, unknown>> | null)?.updates?.GetState
        && (api as unknown as Record<string, Record<string, unknown>> | null)?.updates?.GetDifference);
}

/** `updates.GetState`, or null when this version of the library has no such request. */
export async function createStateRequest(): Promise<unknown | null> {
    const api = await telegramApi() as unknown as Record<string, Record<string, new (a?: unknown) => unknown>> | null;
    if (!api?.updates?.GetState) return null;
    return new api.updates.GetState();
}

/** `updates.GetDifference` from a known point in the stream. Null when the library cannot answer. */
export async function createDifferenceRequest(input: { pts: number; qts: number; date: number }): Promise<unknown | null> {
    const api = await telegramApi() as unknown as Record<string, Record<string, new (a?: unknown) => unknown>> | null;
    if (!api?.updates?.GetDifference) return null;
    return new api.updates.GetDifference({ pts: input.pts, qts: input.qts, date: input.date });
}

/* -------------------------------------------------------------------------------------- construction */

/** Options this adapter can hand a client, widened to include the transport the GramJS driver never sees. */
type ClientOptions = Record<string, unknown>;

/** A client over a stored session string. Nothing connects until the caller calls `connect`. */
export function createClient(input: { sessionString: string; apiId: number; apiHash: string; options: ClientOptions }): TelegramClient {
    return new TelegramClient(new StringSession(input.sessionString), input.apiId, input.apiHash, input.options as never);
}

/**
 * The capture transport options. `{ wss: true }` means "reach Telegram over 443", which GramJS spells
 * `useWSS: true` and teleproto spells with a transport object; both are the *only* thing this builder changes.
 *
 * `timeout` is deliberately absent in both drivers: the flag that matters is `connectionRetries`, and a
 * per-request timeout that the library stores and never reads is worse than none. teleproto does honour a
 * connect timeout at the session layer, and we still do not pass one, so the two drivers are governed by the
 * same numbers and the pilot measures one variable.
 */
export function captureTransportOptions(input: { wss?: boolean } = {}): ClientOptions {
    const base: ClientOptions = { connectionRetries: CAPTURE_CONNECTION_RETRIES, autoReconnect: true };
    return input.wss === true ? { ...base, transport: new WebSocketTransport() } : base;
}

/** Login and pending-session clients: the same sender, without the long-lived tuning or the transport knob. */
export function loginTransportOptions(): ClientOptions {
    return { connectionRetries: LOGIN_CONNECTION_RETRIES };
}

/* --------------------------------------------------------------------------------------- lifecycle
   `connected` is the same getter as in GramJS (`this._sender && this._sender.isConnected()`), which means it can
   be `undefined`, and the three accessors below keep the three moods the app reads it in.
   --------------------------------------------------------------------------------------- */

export function connect(client: TelegramClient): Promise<boolean> {
    return client.connect();
}

export function disconnect(client: TelegramClient): Promise<void> {
    return client.disconnect();
}

/** Can this client be torn down at all? Checked before the call, so a half-built object never throws here. */
export function canDisconnect(client: Partial<TelegramClient> | null | undefined): boolean {
    return Boolean(client?.disconnect);
}

/** The strict form: the gates in the reconnect path only trust an affirmative flag. */
export function isConnected(client: Partial<TelegramClient> | null | undefined): boolean {
    return client?.connected === true;
}

/** The loose form, for fleet reporting, where "anything that is not false" is what the panel means. */
export function connectedFlag(client: Partial<TelegramClient> | null | undefined): boolean {
    return Boolean(client?.connected);
}

export function checkAuthorization(client: TelegramClient): Promise<boolean> {
    return client.checkAuthorization();
}

/**
 * The stored form of this client's session, as a string. Same contract as the GramJS adapter: `save()` writes the
 * key, the endpoint and the datacenter id, and no update state - which is why this application tracks update
 * state itself, and why neither adapter has an `importSession`.
 */
export function exportSessionString(client: TelegramClient): string {
    return (client.session as unknown as { save(): string }).save();
}

/* ------------------------------------------------------------------------------------------------- auth
   `sendCode(apiCredentials, phoneNumber)` and `signInWithPassword(apiCredentials, { password, onError })` are
   the same two calls GramJS makes, with two extra optional parameters (forceSMS, reCaptchaCallback) that this
   adapter does not pass, because the routes have not been given a way to answer a captcha yet.
   ------------------------------------------------------------------------------------------------- */

export function sendCode(client: TelegramClient, context: unknown, phoneNumber: string): Promise<unknown> {
    return client.sendCode(context as never, phoneNumber);
}

/** `auth.SignIn`, the request the phone code is verified with. Static import, because the routes need it now. */
export function createSignInRequest(input: { phoneNumber: string; phoneCodeHash: string; phoneCode: string }): Api.auth.SignIn {
    return new Api.auth.SignIn({ phoneNumber: input.phoneNumber, phoneCodeHash: input.phoneCodeHash, phoneCode: input.phoneCode });
}

/** The answer that means "this number has no account", which is a 409 for the user, not a retry. */
export function isSignUpRequired(result: unknown): boolean {
    return result instanceof Api.auth.AuthorizationSignUpRequired;
}

/** The two-factor step: the secret behind a function, and `onError` as "ask the user again?". */
export function signInWithPassword(client: TelegramClient, context: unknown, input: { password: string; onError?: (error: unknown) => Promise<boolean> | boolean }): Promise<unknown> {
    return client.signInWithPassword(context as never, {
        password: async () => input.password,
        onError: input.onError as never,
    });
}

/* ------------------------------------------------------------------------------- handlers and events
   Two handlers per client, two callbacks, one `[eventBuilder, handler]` list - `removeEventHandler`'s filter is
   `item[0] !== event && item[1] !== callback`, character-identical to GramJS's, which is why the pair below has
   to stay two callbacks rather than one registered twice.
   ------------------------------------------------------------------------------- */

/** The filter every capture handler registers with. Empty on purpose: the channel filter is in the database. */
export function createMessageEventFilter(): NewMessage {
    return new NewMessage({});
}

/** The filter an edited-post handler registers with, for the same reason. */
export function createEditEventFilter(): EditedMessage {
    return new EditedMessage({});
}

export function addMessageHandler(client: TelegramClient, handler: (...args: never[]) => unknown, filter: NewMessage): void {
    client.addEventHandler(handler as never, filter as never);
}

/** The edit half of the pair. Separate callback, because that is what makes each half detachable on its own. */
export function addEditHandler(client: TelegramClient, handler: (...args: never[]) => unknown, filter: EditedMessage): void {
    client.addEventHandler(handler as never, filter as never);
}

/** Whether this client can detach a handler at all - a question about the client, so both filters use it. */
export function canRemoveMessageHandler(client: Partial<TelegramClient> | null | undefined): boolean {
    return typeof client?.removeEventHandler === 'function';
}

export function removeMessageHandler(client: TelegramClient, handler: (...args: never[]) => unknown, filter: NewMessage): void {
    client.removeEventHandler(handler as never, filter as never);
}

/** Detaches an edited-post handler, and only that one. */
export function removeEditHandler(client: TelegramClient, handler: (...args: never[]) => unknown, filter: EditedMessage): void {
    client.removeEventHandler(handler as never, filter as never);
}

export function canListEventHandlers(client: Partial<TelegramClient> | null | undefined): boolean {
    return typeof (client as { listEventHandlers?: unknown } | null | undefined)?.listEventHandlers === 'function';
}

/** The library's own handler list, in whatever shape this version hands back. */
export function listEventHandlers(client: TelegramClient): unknown[] {
    return (client as unknown as { listEventHandlers(): unknown[] }).listEventHandlers();
}

/** Is this callback in that list? The pair shape is the library's: `[eventBuilder, handler]`. */
export function isHandlerAttached(builders: unknown[], handler: unknown): boolean {
    return builders.some((pair) => Array.isArray(pair) && (pair as unknown[])[1] === handler);
}

/* ---------------------------------------------------------------------------------------- requests */

export function canInvoke(client: Partial<TelegramClient> | null | undefined): boolean {
    return typeof client?.invoke === 'function';
}

export function invoke<R>(client: TelegramClient, request: unknown): Promise<R> {
    return client.invoke(request as never) as Promise<R>;
}

export function canGetSelf(client: Partial<TelegramClient> | null | undefined): boolean {
    return typeof client?.getMe === 'function';
}

/** `getMe(true)` is the cached form; the argumentless one re-issues `users.GetUsers` for nothing. */
export function getSelf(client: TelegramClient): Promise<unknown> {
    return client.getMe(true) as unknown as Promise<unknown>;
}

/* --------------------------------------------------------------------------------------- history */

export function getEntity(client: TelegramClient, handle: unknown): Promise<unknown> {
    return client.getEntity(handle as never) as unknown as Promise<unknown>;
}

export function getMessages(client: TelegramClient, entity: unknown, options: unknown): Promise<unknown> {
    return client.getMessages(entity as never, options as never) as unknown as Promise<unknown>;
}

/* --------------------------------------------------------------------------------------- dialogs */

export function getDialogs(client: TelegramClient, options: unknown): Promise<unknown> {
    return client.getDialogs(options as never) as unknown as Promise<unknown>;
}

/** Channels and groups, which is everything a workspace can monitor. Returned as the library reports it. */
export function dialogIsChannelLike(dialog: Dialog): boolean {
    return Boolean(dialog.isChannel || dialog.isGroup);
}

/** A supergroup is a channel to Telegram and a group to a trader, and this is the only place that decides. */
export function dialogIsGroupLike(dialog: Dialog): boolean {
    return Boolean(dialog.isGroup || (dialog.entity as { megagroup?: boolean } | undefined)?.megagroup);
}

/**
 * The peer id as text. GramJS declares `Dialog.id` as required; teleproto declares it optional, so a missing id
 * has to be named rather than left to a TypeError, and the decision it forces is the same one: this row cannot
 * be matched to a workspace, so it is a library change and it should throw.
 */
export function dialogPeerIdText(dialog: Dialog): string {
    const id = dialog.id;
    if (id === undefined || id === null) {
        throw new TypeError('teleproto returned a Dialog with no peer id, which the app cannot key a workspace on');
    }
    return id.toString();
}

export function dialogTitle(dialog: Dialog): string | undefined {
    return dialog.title;
}

export function dialogUsername(dialog: Dialog): string | undefined {
    return (dialog.entity as { username?: string } | undefined)?.username;
}

/* ------------------------------------------------------------------------- the keep-alive guard's seams
   The library catches its own ping timeout, hands the error to `_errorHandler`, then asks its logger before
   printing - the same three-seam shape as GramJS, with the same reason: that gate is the only place a timeout can
   be recognised and hidden before it reaches a printer.
   ------------------------------------------------------------------------- */

/** The client's own logger object, or undefined on a client that was never given one. */
export function clientLogger(client: TelegramClient): unknown {
    return (client as unknown as { _log?: unknown })._log;
}

type LoggerWithGate = { canSend?: (level: unknown) => boolean };

/** Is there a gate to ask? Anything else means the guard counts and stays quiet about the printing. */
export function hasLoggerGate(logger: LoggerWithGate | null | undefined): boolean {
    return typeof logger?.canSend === 'function';
}

/** The library's own gate, bound to the logger, so wrapping it cannot lose `this`. */
export function bindLoggerGate(logger: LoggerWithGate): (level: unknown) => boolean {
    return (logger.canSend as (level: unknown) => boolean).bind(logger);
}

/** Replace the gate. The caller owns every decision inside the function it passes. */
export function patchLoggerGate(logger: LoggerWithGate, gate: (level: unknown) => boolean): void {
    logger.canSend = gate;
}

/**
 * Install the client's error handler. `onError` is a setter that writes `_errorHandler`, so this is an
 * assignment through an accessor rather than a property write, and a client built without the setter will throw -
 * which the guard catches, and that is the point of catching it there.
 */
export function setClientErrorHandler(client: TelegramClient, handler: (error: unknown) => unknown): void {
    (client as unknown as { onError: (error: unknown) => unknown }).onError = handler;
}
