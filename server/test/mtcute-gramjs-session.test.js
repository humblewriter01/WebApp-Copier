/**
 * That a stored GramJS session can be read by something that is not GramJS, and written back exactly as GramJS
 * would have written it.
 *
 * The migration's danger is not that the new driver mis-parses a message; it is that a workspace that had already
 * signed in is asked to sign in again, or - worse, because nobody notices it - that the string we hand over is
 * almost right and the new driver silently starts a fresh session against a different datacenter. Only one thing
 * settles that: the byte layout has to be read off the class that writes it, and re-checked against it in both
 * directions. So the real `telegram/sessions/StringSession.js` from the installed package is the oracle here, and
 * nothing in this file asserts a layout from memory.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { StringSession } from 'telegram/sessions/index.js';
import { GramjsSessionError, describeGramjsSession, encodeGramjsSession, parseGramjsSession, toDriverSessionSeed } from '../services/telegram/gramjs-session.ts';

const KEY = new Uint8Array(Array.from({ length: 256 }, (_, index) => (index * 7 + 3) % 251));

/** A GramJS session object with the fields `save()` reads, without a network or an auth-key computation. */
function gramjsSessionString({ dcId = 2, serverAddress = '149.154.167.51', port = 443, key = KEY }) {
  const session = new StringSession();
  session._dcId = dcId;
  session._serverAddress = serverAddress;
  session._port = port;
  session._key = Buffer.from(key);
  session._authKey = { getKey: () => Buffer.from(key) };
  const saved = session.save();
  assert.ok(saved && saved[0] === '1', 'the library itself refuses to write a session without a version prefix');
  return saved;
}

test('a session we write is read back by GramJS as the same login', () => {
  for (const [host, port, dcId] of [['149.154.167.51', 443, 2], ['demo.telegroup.example', 80, 5], ['2001:db8::1', 5222, 4]]) {
    const value = encodeGramjsSession({ dcId, host, port, authKey: KEY });
    const parsed = new StringSession(value);
    assert.equal(parsed._dcId, dcId, `datacenter survives for ${host}`);
    assert.equal(String(parsed._serverAddress), host, 'and so does the host, as text');
    assert.equal(parsed._port, port, 'and the port');
    assert.equal(parsed._key.length, 256, 'and the key is the 256 bytes it was, no padding, no shift');
    assert.deepEqual([...parsed._key], [...KEY], 'byte for byte');
  }
});

test('a session GramJS wrote is read by us as the same login', () => {
  const value = gramjsSessionString({ dcId: 5, serverAddress: '91.108.56.180', port: 80 });
  const parsed = parseGramjsSession(value);
  assert.ok(parsed);
  assert.deepEqual(parsed, {
    dcId: 5,
    serverAddress: '91.108.56.180',
    port: 80,
    authKey: KEY,
    legacyTelethon: false,
  }, 'every field the library set, and nothing it did not');
  assert.equal(parsed.authKey instanceof Uint8Array, true, 'the key is a plain byte view, not a Buffer pretending to be one');
});

test('the two encoders agree on one string, byte for byte', () => {
  const theirs = gramjsSessionString({});
  const ours = encodeGramjsSession({ dcId: 2, host: '149.154.167.51', port: 443, authKey: KEY });
  assert.equal(ours, theirs, 'a migration that could not write what the library writes would be a second format, not a copy of one');
});

test('the legacy Telethon branch is kept, because the library kept it', () => {
  /* `telegram`'s constructor has a special case for a base64 body of exactly 352 characters: four raw bytes
     become a dotted IPv4, and no length prefix is read. It looks like dead code from 2026 and it is a live
     decoder today, so a session that hits it must parse the same way here as there - including the odd tail,
     which is "the rest of the buffer", not "256 bytes". */
  const ip = [149, 154, 167, 91];
  const body = Buffer.concat([Buffer.from([2]), Buffer.from(ip), Buffer.alloc(2, 0), Buffer.alloc(256, 9), Buffer.from([1])]);
  // Two bytes for the port and one for nothing: the point is the 352-character length, not a valid Telethon file.
  const value = `1${body.toString('base64')}`;
  assert.equal(value.slice(1).length, 352, 'the length the branch keys on, which is why the payload is 264 bytes');

  const theirs = new StringSession(value);
  const ours = parseGramjsSession(value);
  assert.ok(ours);
  assert.equal(ours.serverAddress, theirs._serverAddress, 'the dotted quad, read the same way');
  assert.equal(ours.port, theirs._port, 'the port, from the two bytes after four');
  assert.equal(ours.dcId, theirs._dcId);
  assert.equal(ours.legacyTelethon, true, 'and the fact that this string came from the older writer is reported, not smoothed over');
  assert.equal(ours.authKey.length, 257, 'the key is whatever followed, exactly as the library treats it');
});

test('a session the library reads wrongly, we read wrongly too, and say so', () => {
  /* The 352-character test is not a length the library chose for a reason that still holds: a GramJS session with
     a 256-byte key and a host of three characters or fewer is *also* 352 characters long, so the legacy branch
     claims it and reads an IPv4 address out of a length prefix. That is a defect in the format, and the migration
     inherits it exactly - because a reader that "fixed" it would parse one set of sessions one way and hand a
     different set to the new driver, which is a worse outcome than agreeing. The encoder refuses the colliding
     host instead of writing one, so the case cannot be created here. */
  const colliding = Buffer.concat([Buffer.from([2]), Buffer.from('1.2.3'), Buffer.alloc(2, 0), Buffer.alloc(256, 4)]);
  const value = `1${colliding.toString('base64')}`;
  assert.equal(value.slice(1).length, 352, 'three bytes of host, and the body lands on the legacy length');

  const theirs = new StringSession(value);
  const ours = parseGramjsSession(value);
  assert.ok(ours);
  assert.equal(ours.serverAddress, theirs._serverAddress, 'the same invented quad, from the same bytes');
  assert.equal(ours.port, theirs._port, 'the same zero port');
  assert.equal(ours.legacyTelethon, true, 'and the flag is how anyone downstream finds out this string was mis-read');

  assert.throws(
    () => encodeGramjsSession({ dcId: 2, host: 'a.b', port: 443, authKey: new Uint8Array(256) }),
    (error) => error instanceof GramjsSessionError && error.code === 'LEGACY_COLLISION',
    'while the write path refuses to produce one: a host this short is not something a session should be built from',
  );
});

test('an IPv6 session reads as the compressed address the library would have shown', () => {
  /* Any declared length above 100 is treated by GramJS as "this was never a length": it rewinds two bytes and
     takes the next sixteen as hex. That asymmetry is in the decoder only, and a rewrite that "tidied" it would
     mis-read every session written for an IPv6 datacenter. */
  /* Sixteen bytes of address, and GramJS asks for them by rewinding two bytes after the length prefix. A
     * declared length above 100 is the signal that the string was never length-prefixed the way the common case
     * is, and the sixteen bytes that follow are the address. */
  const raw = Buffer.from('20010db8000000000000000000000001', 'hex');
  const body = Buffer.concat([Buffer.from([2]), Buffer.alloc(2, 0), raw, Buffer.alloc(256, 4)]);
  const declared = body.subarray(1, 3);
  declared.writeInt16BE(120, 0);
  const value = `1${body.toString('base64')}`;

  const theirs = new StringSession(value);
  const ours = parseGramjsSession(value);
  assert.ok(ours);
  assert.equal(ours.serverAddress, theirs._serverAddress, 'the same compressed text, from the same sixteen bytes');
  assert.equal(ours.legacyTelethon, false);
});

test('a session that is not a session says which kind of not it is', () => {
  assert.equal(parseGramjsSession(''), null, 'an empty string is "nobody has signed in here", which is a state and not an error');
  assert.equal(parseGramjsSession(null), null);
  assert.equal(parseGramjsSession(undefined), null);
  assert.equal(parseGramjsSession('   '), null, 'and whitespace is the same state, because a text field in a dashboard writes it');

  for (const [value, code] of [['2AAAA', 'UNSUPPORTED_VERSION'], ['1', 'TRUNCATED']]) {
    assert.throws(() => parseGramjsSession(value), (error) => error instanceof GramjsSessionError && error.code === code, `${JSON.stringify(value)} is refused with ${code}`);
  }
  /* Base64 of a non-base64 string is defined (the invalid characters are dropped), so what a mangled value leaves
     behind is a short buffer at an unpredictable offset - the point is only that some read path cannot produce a
     *confident* session from it. Which of the four ways it runs out first is not worth pinning. */
  assert.throws(() => parseGramjsSession('1!!!not base64!!!'), (error) => error instanceof GramjsSessionError, 'a mangled string is refused, whatever the code says');

  /* dc 2, a declared address length of 4, four bytes of address, a port, and then nothing where the key should
     be. That is not a login with a short key, it is a login with no key, and it is the one shape on the read path
     that is refused outright rather than described. */
  const noKey = Buffer.concat([Buffer.from([2]), Buffer.from([0, 4]), Buffer.from('dc.d'), Buffer.alloc(2, 0)]);
  assert.throws(() => parseGramjsSession(`1${noKey.toString('base64')}`), (error) => error.code === 'BAD_AUTH_KEY', 'a session with no key after the port is not a login');
});

test('a session string never reaches a log line, but its shape does', () => {
  const value = gramjsSessionString({});
  const description = describeGramjsSession(value);
  assert.deepEqual(Object.keys(description).sort(), ['authKeyBytes', 'dcId', 'error', 'host', 'legacyTelethon', 'port', 'present']);
  assert.deepEqual(description, { present: true, dcId: 2, host: '149.154.167.51', port: 443, authKeyBytes: 256, legacyTelethon: false, error: null });

  /* The redaction rule this project holds: a fingerprint of a credential is a credential for anyone patient
     enough to search the space, and these logs are read by more than the person who wrote them. */
  const rendered = JSON.stringify(description) + String(description);
  assert.equal(rendered.includes(Buffer.from(KEY).toString('base64')), false, 'the key itself is absent');
  assert.equal(rendered.includes(Buffer.from(KEY).toString('hex').slice(0, 16)), false, 'and so is any prefix of it');
  assert.equal(rendered.length < 400, true, 'and the whole thing is a line, not a blob');

  const broken = describeGramjsSession('2nope');
  assert.equal(broken.present, true, 'a string that exists but cannot be read is still worth reporting');
  assert.equal(broken.error, 'UNSUPPORTED_VERSION', 'with the code that says which kind of incident it is');
  assert.equal(describeGramjsSession('').present, false, 'while an absent session is quiet, not an error');
});

test('the seed handed to another driver carries the four things a connection needs', () => {
  const parsed = parseGramjsSession(gramjsSessionString({ dcId: 4, serverAddress: '149.154.175.59', port: 443 }));
  assert.ok(parsed);
  const seed = toDriverSessionSeed(parsed);
  assert.deepEqual(Object.keys(seed).sort(), ['authKey', 'dcId', 'host', 'port'], 'and nothing else - no session format, no version, no claim about another library');
  assert.deepEqual(seed, { dcId: 4, host: '149.154.175.59', port: 443, authKey: KEY });
});
