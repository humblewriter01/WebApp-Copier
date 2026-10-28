/**
 * The GramJS `StringSession`, read and written by hand.
 *
 * Why this file exists at all: `TELEGRAM_DRIVER` can point the process at `teleproto`, the maintained fork of the
 * archived `telegram` package, and the credential both drivers use is already in our database - one string per
 * user, written by `telegram/sessions/StringSession.js` in `telegram@2.26.22`, saved by `client.session.save()`
 * and re-loaded on every boot. A swap that cannot carry that string across loses every signed-in workspace the
 * moment it is enabled, and no test would notice until a human re-entered a phone code.
 *
 * Why it is written by hand: the fork's documentation *says* its `StringSession` reads the legacy format, and a
 * promise in a README is not evidence about bytes. So this module is a third reader that belongs to neither
 * library, and the test feeds it strings produced by each of them and requires all three to agree on the datacenter
 * id, the host, the port and the 256-byte key. If the fork ever changes its encoding, that test is what says so -
 * not a support ticket from a workspace that had to sign in again.
 *
 * The layout is not a guess and not a memory. It is read out of the installed GramJS source, which is the only
 * authority that matters, and `test/telegram-session-bridge.test.js` re-proves it by encoding a session with the
 * real class and decoding it here, and the other way round, and then again against the fork. Two details in that
 * source look like bugs and are
 * load-bearing anyway:
 *
 *  - A session whose base64 body is exactly 352 characters is parsed by the *Telethon* layout instead: four raw
 *    bytes become a dotted IPv4 address, and no length prefix is read at all. GramJS keeps that branch for
 *    strings that predate its own format, and a driver that "simplified" it would mis-read a real login.
 *  - The address is read as `int16BE`-length-prefixed text, but any length above 100 is treated as 16 raw bytes
 *    of IPv6 and rendered as compressed hex - while `save()` writes the *string* form with its real length. The
 *    two halves are therefore not symmetric on purpose, and a round trip of an IPv6 session is only guaranteed
 *    to preserve what the address means, not the bytes it was written as.
 *
 * What this module deliberately does not do: it never puts a key on the wire or in a log. `describeGramjsSession`
 * is the function the server is allowed to log, and it reports sizes and destinations only.
 */
import { Buffer } from 'node:buffer';

/** The version byte GramJS prefixes the base64 body with, and refuses anything else for. */
const CURRENT_VERSION = '1';
/** A base64 body of this length is a Telethon session, per the check in GramJS's own constructor. */
const LEGACY_TELETHON_LENGTH = 352;
/** The same test, in bytes, for a writer that has to decide before it produces a string: 264 bytes base64 to 352 characters. */
const LEGACY_TELETHON_BYTES = 264;
/** `save()` writes the port with `writeInt16BE`, so a port outside this range would be written as a negative. */
const MAX_PORT = 32767;
/** The MTProto auth key length, which is what `save()` writes and what a new session must carry. */
const AUTH_KEY_BYTES = 256;

export interface GramjsSession {
    /** The datacenter id the session was opened against. */
    readonly dcId: number;
    /** The host that session points at, as text - IPv4, IPv6 or a name. */
    readonly serverAddress: string;
    /** The port, from the two bytes `save()` writes ahead of the key. */
    readonly port: number;
    /** The 256-byte authorization key, exactly as it was stored. */
    readonly authKey: Uint8Array;
    /** True when the string was read with the legacy Telethon layout rather than the length-prefixed one. */
    readonly legacyTelethon: boolean;
}

/** The seed another driver needs in order to talk to the same datacenter with the same key. */
export interface DriverSessionSeed {
    readonly dcId: number;
    readonly host: string;
    readonly port: number;
    readonly authKey: Uint8Array;
}

export type GramjsSessionErrorCode =
    | 'EMPTY'
    | 'UNSUPPORTED_VERSION'
    | 'TRUNCATED'
    | 'BAD_PORT'
    | 'BAD_AUTH_KEY'
    | 'BAD_ADDRESS'
    | 'BAD_DC'
    /** Nothing about the string that is already stored is broken; the format is. The encoder is where it can
     *  still be stopped, which is why this code exists on one path and not the other. */
    | 'LEGACY_COLLISION';

/**
 * A failure with a code, because the caller has to answer two different questions with it: "this workspace has
 * no session yet" (which is normal and must not page anyone) and "this stored session is not readable" (which is
 * an incident, because it is the only copy of a login).
 */
export class GramjsSessionError extends Error {
    readonly code: GramjsSessionErrorCode;

    constructor(code: GramjsSessionErrorCode, message: string) {
        super(message);
        this.name = 'GramjsSessionError';
        this.code = code;
    }
}

/** A cursor over the buffer, mirroring GramJS's `BinaryReader` (including its `read(-1)` = "everything left"). */
class Reader {
    private readonly buf: Buffer;
    private offset: number = 0;

    constructor(buf: Buffer) {
        this.buf = buf;
    }

    read(length: number): Buffer {
        if (length === -1) {
            const rest = this.buf.subarray(this.offset);
            this.offset = this.buf.length;
            return rest;
        }
        if (this.offset + length > this.buf.length) throw new GramjsSessionError('TRUNCATED', `session string ends ${length} bytes before it should`);
        const slice = this.buf.subarray(this.offset, this.offset + length);
        this.offset += length;
        return slice;
    }

    rewind(bytes: number): void {
        this.offset -= bytes;
    }
}

/**
 * Parse a stored GramJS session string.
 *
 * An empty value is not an error: `save()` returns `''` for a client that has an auth key, an address and a port
 * and no more, and a workspace that has never signed in simply has nothing stored. That case returns `null` so
 * the caller can distinguish "no login" from "broken login" - the difference between a prompt and an incident.
 */
export function parseGramjsSession(value: string | null | undefined): GramjsSession | null {
    const text = typeof value === 'string' ? value.trim() : '';
    if (!text) return null;
    if (text[0] !== CURRENT_VERSION) {
        throw new GramjsSessionError('UNSUPPORTED_VERSION', `session string starts with ${JSON.stringify(text[0])}, and GramJS writes only ${JSON.stringify(CURRENT_VERSION)}`);
    }
    const body = text.slice(1);
    const buf = Buffer.from(body, 'base64');
    const reader = new Reader(buf);

    const dcId = reader.read(1).readUInt8(0);
    let serverAddress: string;
    let legacyTelethon = false;
    if (body.length === LEGACY_TELETHON_LENGTH) {
        const ip = reader.read(4);
        serverAddress = `${ip[0]}.${ip[1]}.${ip[2]}.${ip[3]}`;
        legacyTelethon = true;
    } else {
        const declared = reader.read(2).readInt16BE(0);
        if (declared > 100) {
            // The branch GramJS takes when the two bytes were never a length: 16 raw bytes of IPv6, compressed.
            reader.rewind(2);
            const hex = reader.read(16).toString('hex').match(/.{1,4}/g) ?? [];
            serverAddress = hex
                .map((group) => group.replace(/^0+/, ''))
                .join(':')
                .replace(/0000:/g, ':')
                .replace(/:{2,}/g, '::');
        } else if (declared < 0 || declared > 255) {
            throw new GramjsSessionError('BAD_ADDRESS', `session declares an address ${declared} bytes long, which is not a host anyone wrote`);
        } else {
            serverAddress = reader.read(declared).toString();
        }
    }

    /* No port rule on the read path, for the same reason the key length has none: `save()` wrote whatever it was
     * holding, the class reads two bytes and calls it a port, and 0 is what a session whose address happened to
     * make the body 352 characters long reads back as (see the collision test). Refusing it here would turn a
     * string the old driver accepts into a login the new one declines to inherit. */
    const port = reader.read(2).readInt16BE(0);
    /* GramJS reads "everything left" as the key and never checks its length, and neither do we. A strict
     * `=== 256` here would be the correct-looking rule that turns a slightly odd but working login into a login
     * this migration refuses to carry - and the one failure mode this file exists to prevent is precisely a real
     * session string that we decided not to read. `describeGramjsSession` reports the length instead, so the
     * oddity is visible where an operator will see it rather than fatal where a trader would not. */
    const authKey = reader.read(-1);
    if (!authKey.length) throw new GramjsSessionError('BAD_AUTH_KEY', 'session carries no authorization key at all, which is not a login, it is an empty string');
    return { dcId, serverAddress, port, authKey: new Uint8Array(authKey), legacyTelethon };
}

/**
 * Write a session string in the form GramJS reads back.
 *
 * Byte-for-byte what `StringSession#save()` produces for the same fields - the test proves it by putting our
 * output through the real class - which is what lets a GramJS client and a second driver share one stored value.
 * The IPv6 encoding above is deliberately not reproduced: `save()` always writes the address as text, so a
 * session that was decoded through the 16-byte branch is re-written as its textual form, which is stable.
 */
/** The address, whichever name the caller's shape uses: `serverAddress` is GramJS's, `host` is ours. */
function hostOf(session: DriverSessionSeed | GramjsSession): string {
    return 'serverAddress' in session ? session.serverAddress : session.host;
}

export function encodeGramjsSession(session: DriverSessionSeed | GramjsSession): string {
    const address = Buffer.from(hostOf(session), 'utf8');
    if (address.length > 100) {
        throw new GramjsSessionError('BAD_ADDRESS', `host is ${address.length} bytes, and the length-prefixed form cannot hold one that long without reading back as IPv6`);
    }
    const port = session.port;
    if (!Number.isInteger(port) || port < 1 || port > MAX_PORT) throw new GramjsSessionError('BAD_PORT', `cannot write port ${port} as an int16`);
    const key = Buffer.from(session.authKey);
    if (key.length !== AUTH_KEY_BYTES) throw new GramjsSessionError('BAD_AUTH_KEY', `cannot write a ${key.length}-byte auth key`);
    if (!Number.isInteger(session.dcId) || session.dcId > 255) throw new GramjsSessionError('BAD_DC', `cannot write datacenter ${session.dcId} as a byte`);

    const head = Buffer.alloc(1);
    head.writeUInt8(session.dcId, 0);
    const length = Buffer.alloc(2);
    length.writeInt16BE(address.length, 0);
    const portBuffer = Buffer.alloc(2);
    portBuffer.writeInt16BE(port, 0);
    const payload = Buffer.concat([head, length, address, portBuffer, key]);
    /* A three-byte host and a 256-byte key put the body at exactly 352 characters, which is what the legacy
     * Telethon branch tests for - so such a string reads back as an IPv4 address built out of its own length
     * prefix, with a zero port behind it. The read path has to agree with the library about strings that already
     * exist, whatever they say, because a reader that "fixed" the quirk would parse one set of stored sessions one
     * way and hand the rest to the new driver as a different login. The writer is the only place left where this
     * can still be prevented, so it is the only place that checks. */
    if (payload.length === LEGACY_TELETHON_BYTES) {
        throw new GramjsSessionError('LEGACY_COLLISION', `host ${JSON.stringify(hostOf(session))} would make the session exactly as long as a Telethon string, which the decoder reads back as an IPv4 address`);
    }
    return CURRENT_VERSION + payload.toString('base64');
}

/**
 * The four fields a second driver needs, in the names our own code uses rather than the library's. Nothing builds
 * a client out of this today - the fork's `StringSession` takes the original string - which is why the function
 * exists for the test that proves the two formats describe one login, and not for the runtime path.
 */
export function toDriverSessionSeed(session: GramjsSession): DriverSessionSeed {
    return { dcId: session.dcId, host: session.serverAddress, port: session.port, authKey: session.authKey };
}

export interface GramjsSessionDescription {
    readonly present: boolean;
    readonly dcId: number | null;
    readonly host: string | null;
    readonly port: number | null;
    readonly authKeyBytes: number | null;
    readonly legacyTelethon: boolean | null;
    /** Set when the string exists but could not be read, with the code that says which kind of failure it is. */
    readonly error: string | null;
}

/**
 * What may be logged about a session: where it points and how long the key is. No prefix, no suffix, no hash of
 * the key - a fingerprint of a credential is a credential for anyone patient enough to search the space, and this
 * project's log lines are readable by more than one person (`test/log-redaction.test.js`).
 */
export function describeGramjsSession(value: string | null | undefined): GramjsSessionDescription {
    const base = { present: false, dcId: null, host: null, port: null, authKeyBytes: null, legacyTelethon: null, error: null } as GramjsSessionDescription;
    const text = typeof value === 'string' ? value.trim() : '';
    if (!text) return base;
    try {
        const session = parseGramjsSession(text);
        if (!session) return base;
        return {
            present: true,
            dcId: session.dcId,
            host: session.serverAddress,
            port: session.port,
            authKeyBytes: session.authKey.length,
            legacyTelethon: session.legacyTelethon,
            error: null,
        };
    } catch (error) {
        const code = error instanceof GramjsSessionError ? error.code : 'TRUNCATED';
        return { ...base, present: true, error: code };
    }
}
