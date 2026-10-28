/**
 * The contract the second driver has to satisfy, and the honest state of satisfying it.
 *
 * This file is the seam's front door for a `@mtcute/node` client: it names every operation the application asks of
 * a Telegram driver, it says which of them the new driver implements, and it refuses - loudly, in as many words as
 * it can - to be used before that list is empty. The refusal is the reason the file exists today. A migration
 * that "had" an adapter with twenty plausible-looking calls in it would be worse than no adapter at all, because
 * the failure would arrive as a runtime `undefined is not a function` on a workspace that had just signed in, and
 * every one of those calls would first have to be *re-derived* from the installed declarations to find out whether
 * it was ever real.
 *
 * So the rule for this file is: a member is `ported` when it has been written *and* compiled against the
 * declarations of the library that shipped into `node_modules`, never when it merely looks right. The four facts
 * below are in the same shape as that rule - each one was read out of the installed package, and each one is
 * re-asserted by `test/mtcute-seam-contract.test.js`, so if a future version of `@mtcute/node` removes a blocker
 * the test says so instead of the blocker quietly aging into folklore.
 *
 * What is already built, in this directory, and provably so:
 *  - `postgres-storage.ts` - the storage provider the driver asks for, with `storage-schema.ts` as its migration.
 *  - `gramjs-session.ts` - the credential the driver needs to inherit, read and written byte-for-byte against the
 *    GramJS class that wrote it.
 * What is not: the client itself. Its constructor options, its login flow, its update subscriptions, its history
 * read and its error vocabulary are all unverified, and they are the surface the capture path, the watchdog and
 * the login routes lean on - which is the difference between "a driver" and "a file with a driver's name".
 */

/** The drivers this application knows how to run, and the only values `TELEGRAM_DRIVER` accepts. */
export type TelegramDriverName = 'gramjs' | 'mtcute';

/**
 * Every operation a Telegram driver must provide: the export list of `services/telegram-adapter.js`, which is the
 * file this one replaces. Names and arity are the contract, and the test enforces both against the module it is
 * modelled on, so a new GramJS touchpoint cannot be added without appearing here as an open question.
 *
 * The signatures are `unknown` on purpose while the driver is unported. Giving them plausible parameter types
 * would be the same mistake as writing plausible calls: it would look like a decision, and it would compile
 * whether or not it matched anything in the library. Each ported member gets a real signature in the same commit
 * that ports it.
 */
export const TELEGRAM_ADAPTER_METHODS = Object.freeze([
    'telegramApi',
    'canReconcileUpdates',
    'createStateRequest',
    'createDifferenceRequest',
    'createClient',
    'captureTransportOptions',
    'loginTransportOptions',
    'connect',
    'disconnect',
    'canDisconnect',
    'isConnected',
    'connectedFlag',
    'checkAuthorization',
    'exportSessionString',
    'sendCode',
    'createSignInRequest',
    'isSignUpRequired',
    'signInWithPassword',
    'createMessageEventFilter',
    'createEditEventFilter',
    'addMessageHandler',
    'addEditHandler',
    'canRemoveMessageHandler',
    'removeMessageHandler',
    'removeEditHandler',
    'canListEventHandlers',
    'listEventHandlers',
    'isHandlerAttached',
    'canInvoke',
    'invoke',
    'canGetSelf',
    'getSelf',
    'getEntity',
    'getMessages',
    'getDialogs',
    'dialogIsChannelLike',
    'dialogIsGroupLike',
    'dialogPeerIdText',
    'dialogTitle',
    'dialogUsername',
    'clientLogger',
    'hasLoggerGate',
    'bindLoggerGate',
    'patchLoggerGate',
    'setClientErrorHandler',
] as const);

/** How many arguments each member takes, which is half of what a caller of either driver has to agree on. */
export const TELEGRAM_ADAPTER_ARITY: Readonly<Record<TelegramAdapterMethodName, number>> = Object.freeze({
    telegramApi: 0,
    canReconcileUpdates: 0,
    createStateRequest: 0,
    createDifferenceRequest: 1,
    createClient: 1,
    /** Zero, not one: the single parameter has a default, and `Function.length` counts what must be passed. */
    captureTransportOptions: 0,
    loginTransportOptions: 0,
    connect: 1,
    disconnect: 1,
    canDisconnect: 1,
    isConnected: 1,
    connectedFlag: 1,
    checkAuthorization: 1,
    exportSessionString: 1,
    sendCode: 3,
    createSignInRequest: 1,
    isSignUpRequired: 1,
    signInWithPassword: 3,
    createMessageEventFilter: 0,
    createEditEventFilter: 0,
    addMessageHandler: 3,
    addEditHandler: 3,
    canRemoveMessageHandler: 1,
    removeMessageHandler: 3,
    removeEditHandler: 3,
    canListEventHandlers: 1,
    listEventHandlers: 1,
    isHandlerAttached: 2,
    canInvoke: 1,
    invoke: 2,
    canGetSelf: 1,
    getSelf: 1,
    getEntity: 2,
    getMessages: 3,
    getDialogs: 2,
    dialogIsChannelLike: 1,
    dialogIsGroupLike: 1,
    dialogPeerIdText: 1,
    dialogTitle: 1,
    dialogUsername: 1,
    clientLogger: 1,
    hasLoggerGate: 1,
    bindLoggerGate: 1,
    patchLoggerGate: 2,
    setClientErrorHandler: 2,
} as Record<TelegramAdapterMethodName, number>);

export type TelegramAdapterMethodName = (typeof TELEGRAM_ADAPTER_METHODS)[number];

/** The shape both drivers answer to. See the note above about the loose signatures. */
export type TelegramDriverAdapter = Readonly<Record<TelegramAdapterMethodName, (...args: readonly unknown[]) => unknown>>;

/** What stands between this driver and being selectable, each with the place it was read from. */
export interface MtcuteBlocker {
    readonly code: 'no-wss-transport' | 'native-dependency' | 'client-surface-unverified' | 'session-import-unverified';
    readonly summary: string;
    /** The file in the installed package, or in this repository, that says so. */
    readonly evidence: string;
}

/** Annotated as an array, not as a tuple: a literal length of 4 would make the emptiness check below a
 * compile-time constant, and the day a blocker is resolved the compiler would be the only thing that noticed. */
export const MTCUTE_BLOCKERS: readonly MtcuteBlocker[] = Object.freeze([
    {
        code: 'no-wss-transport',
        summary: 'There is no MTProto-over-WebSocket transport to select, so the 443 fallback the capture path depends on is not a flag. `MtClientOptions.transport` is an injectable interface with two members (`connect`, `packetCodec`), and the transports that ship are abstract/intermediate/obfuscated/proxy - the token "wss" appears in no file in the package, and "websocket" in exactly one, the doc comment naming the default. The size of the gap is therefore known and small: one class wrapping a `ws` socket as an `ITelegramConnection`, with `IntermediatePacketCodec` reused as-is, because MTProto over WSS differs from TCP only in what carries the framed bytes. It is still an unmaintained-by-us class on the path every signal arrives through, which is why it is a blocker and not a detail.',
        evidence: 'node_modules/@mtcute/core/network/client.d.ts:78-80, node_modules/@mtcute/core/network/transports/ (4 files, none of them websocket), grep -ril "wss" node_modules/@mtcute = empty',
    },
    {
        code: 'native-dependency',
        summary: '@mtcute/node hard-depends on better-sqlite3 - in `dependencies`, not optional, not a peer - so any image that installs the driver runs an install script that can require a compiler, and its own SQLite storage is only reachable through the root barrel, never as a subpath. Measured rather than assumed: a clean `npm ci` of this service with scripts enabled exits 0 and silently drops the whole optional package (no better-sqlite3, no node directory), while keeping `@mtcute/core`, which is what the strict typecheck needs. So the cost is not a broken build - it is that the driver is *absent* in exactly the images that cannot build a native module, and an absent driver has to be refused rather than half-loaded, which is the behaviour `telegram-driver.js` is written around. The remaining hazard is the one that cannot be tested from here: an image that CAN build it, where the install now pays for a compiler pass on every deploy of a service that does not use the package.',
        evidence: 'npm ci in a clean directory against this lockfile: exit 0, node_modules/@mtcute = {core, file-id, tl-runtime}, better-sqlite3 absent (2026-10-28); node_modules/@mtcute/node/package.json dependencies',
    },
    {
        code: 'client-surface-unverified',
        summary: 'The client surface - constructor options, start/login, the update subscription for new posts and edits, the history read, the error vocabulary that the keep-alive guard classifies - has not been compiled against the installed declarations. Until it has, every one of the 45 members below is an open question, not a formality.',
        evidence: 'server/test/mtcute-seam-contract.test.js (asserts the ledger below against the module it replaces)',
    },
    {
        code: 'session-import-unverified',
        summary: 'The bridge exists and reads correctly - `client.start({ session })` takes `InputStringSessionData`, whose four fields a GramJS session fills exactly, and `gramjs-session.ts` already round-trips through the real `readStringSession`/`writeStringSession` in a test. What has not been run is everything around it, and it is the part that decides whether a workspace keeps its login: `importSession` starts with `prepare()`, so the storage provider has to be constructed and reachable before the seed is handed over; it returns early when the storage already holds a key for the primary DC unless `sessionForce` is set, which makes "the old key is gone from the row" load-bearing rather than cosmetic; it calls `authKeys.deleteAll()` before setting the imported one, which on our provider is a real `DELETE` of every temporary key in the same instant; and `self` is null for a GramJS session, so `CurrentUserInfo` has to be back-filled by the first `getMe` before anything that reads `storage.self` runs. Four orderings, each readable in the source, none of them verified against a live account or against our provider.',
        evidence: 'node_modules/@mtcute/core/highlevel/base.js:199-218 (importSession), node_modules/@mtcute/core/highlevel/client.d.ts:365-377 (start({session, sessionForce}))',
    },
]);

/**
 * The ledger. `ported` is empty because nothing here has been compiled against the library yet - and it is in this
 * file rather than in a PR description so that the claim cannot be softened by whoever writes the next commit: the
 * status function below derives `wired` from this array being empty, and a member that is not in either list is a
 * test failure.
 */
export const MTCUTE_PORTED = Object.freeze([] as readonly TelegramAdapterMethodName[]);

export interface MtcuteDriverStatus {
    /** True only when every member is ported *and* no blocker stands. Nothing else can make it true. */
    readonly wired: boolean;
    readonly ported: readonly TelegramAdapterMethodName[];
    readonly pending: readonly TelegramAdapterMethodName[];
    readonly blockers: readonly MtcuteBlocker[];
}

/** The answer the driver switch consults. It is a function, not a constant, so the ledger above stays the truth. */
export function mtcuteDriverStatus(): MtcuteDriverStatus {
    const ported = new Set<string>(MTCUTE_PORTED);
    const pending = TELEGRAM_ADAPTER_METHODS.filter((name) => !ported.has(name));
    return {
        wired: pending.length === 0 && MTCUTE_BLOCKERS.length === 0,
        ported: MTCUTE_PORTED,
        pending,
        blockers: MTCUTE_BLOCKERS,
    };
}

/**
 * Raised instead of a driver. The message is written to be read in a log at 3am by someone who has to decide
 * whether to switch back, so it says what is missing, in how many, and what to set to be rid of it.
 */
export class MtcuteNotWiredError extends Error {
    readonly pending: readonly string[];
    readonly blockers: readonly MtcuteBlocker[];

    constructor(status: MtcuteDriverStatus = mtcuteDriverStatus()) {
        super(
            `TELEGRAM_DRIVER=mtcute was requested, and ${status.pending.length} of ${TELEGRAM_ADAPTER_METHODS.length} driver operations are not implemented`
            + `${status.blockers.length ? ` (${status.blockers.map((blocker) => blocker.code).join(', ')})` : ''}`
            + '. Production capture continues on gramjs only if TELEGRAM_DRIVER is unset or gramjs; nothing here falls back silently, because a session written by'
            + ' one driver and read by another is how an account loses its login. Set TELEGRAM_DRIVER=gramjs to run the driver that is wired.',
        );
        this.name = 'MtcuteNotWiredError';
        this.pending = status.pending;
        this.blockers = status.blockers;
    }
}

/**
 * The factory the resolver calls when the switch says mtcute. It has no body to give yet: a client built from
 * unverified options is a client that fails at the first network call, on a workspace that believed it had signed
 * in. The refusal is the behaviour, and it is total - which is what "the old path is untouched" is worth.
 */
export function createMtcuteAdapter(): never {
    throw new MtcuteNotWiredError();
}
