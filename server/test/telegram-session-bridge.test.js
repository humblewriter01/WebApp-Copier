/**
 * Both drivers read and write one session string, proved by a third reader that belongs to neither.
 *
 * The claim the driver swap depends on is not "teleproto says it is compatible" - the fork's documentation does say
 * so, and a README is not evidence about bytes. So this file builds a session with the archived package's own
 * class, with the fork's own class, and with the hand-written parser in `gramjs-session.ts`, and requires all three
 * to agree on the datacenter id, the host, the port and the 256-byte key. Then it requires each driver's `save()`
 * to produce the string the *other* one loads, in both directions, which is the property that decides whether a
 * workspace is asked for a phone code after a deployment.
 *
 * The quirks are pinned as faithfully as the happy path, because the fork preserved them verbatim and a future
 * "improvement" is the incident this file exists to catch: the 352-character Telethon branch, the IPv6 read that
 * rewinds two bytes, the key that is "whatever is left", and a port read without a range check. Where GramJS is
 * wrong, this file requires the parser to be wrong the same way - and the encoder to refuse to create a new one.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { StringSession as GramjsStringSession } from 'telegram/sessions/index.js';
import { StringSession as TeleprotoStringSession } from 'teleproto/sessions/index.js';
import { GramjsSessionError, describeGramjsSession, encodeGramjsSession, parseGramjsSession, toDriverSessionSeed } from '../services/telegram/gramjs-session.ts';

const KEY = new Uint8Array(Array.from({ length: 256 }, (_, index) => (index * 7 + 3) % 251));

/** A saved session from a real class, without a network or an auth-key computation. */
function savedBy(Class, { dcId = 2, serverAddress = '149.154.167.51', port = 443, key = KEY }) {
  const session = new Class();
  session._dcId = dcId;
  session._serverAddress = serverAddress;
  session._port = port;
  session._key = Buffer.from(key);
  session._authKey = { getKey: () => Buffer.from(key) };
  const saved = session.save();
  assert.ok(saved && saved[0] === '1', 'the library itself refuses to write a session without a version prefix');
  return saved;
}

test('the two packages write byte-identical session strings, in both directions', () => {
  for (const [host, port, dcId] of [['149.154.167.51', 443, 2], ['demo.telegroup.example', 80, 5], ['2001:db8::1', 5222, 4]]) {
    const fromGramjs = savedBy(GramjsStringSession, { dcId, serverAddress: host, port });
    const fromTeleproto = savedBy(TeleprotoStringSession, { dcId, serverAddress: host, port });
    assert.equal(fromTeleproto, fromGramjs, `${host} is written the same way by both`);
    assert.equal(encodeGramjsSession({ dcId, host, port, authKey: KEY }), fromGramjs, 'and the third reader writes it the same way too');

    /* The direction that matters at boot: a string saved before the swap, loaded after it, and re-saved. If the
       re-save changed anything, the row in the database would drift every time a workspace restarted. */
    const reloaded = new TeleprotoStringSession(fromGramjs);
    assert.equal(String(reloaded._serverAddress), host);
    assert.equal(reloaded._port, port);
    assert.equal(reloaded._dcId, dcId);
    assert.deepEqual([...reloaded._key], [...KEY], 'the key survives the round trip byte for byte');
    assert.equal(savedBy(TeleprotoStringSession, { dcId, serverAddress: String(reloaded._serverAddress), port: reloaded._port, key: reloaded._key }), fromGramjs, 're-saving what the fork loaded gives back the same string');
  }
});

test('the hand-written reader agrees with both classes, field for field', () => {
  for (const Class of [GramjsStringSession, TeleprotoStringSession]) {
    const value = savedBy(Class, { dcId: 5, serverAddress: '91.108.56.180', port: 80 });
    const parsed = parseGramjsSession(value);
    assert.ok(parsed);
    assert.deepEqual(parsed, { dcId: 5, serverAddress: '91.108.56.180', port: 80, authKey: KEY, legacyTelethon: false }, `${Class.name} wrote it, and the parser says exactly that`);
    assert.equal(parsed.authKey instanceof Uint8Array, true, 'the key is a plain byte view, not a Buffer pretending to be one');
  }
});

test('the legacy Telethon branch is kept, by both, identically', () => {
  /* `session.length == 352` is a live decoder in both packages, so a string that hits it must parse the same way
     three times over. The payload is padded to 264 bytes to land on the length the branch keys on. */
  const body = Buffer.concat([Buffer.from([2]), Buffer.from([149, 154, 167, 91]), Buffer.alloc(2, 0), Buffer.alloc(256, 9), Buffer.from([1])]);
  const value = `1${body.toString('base64')}`;
  assert.equal(value.slice(1).length, 352, 'the length the branch keys on');

  const theirs = [new GramjsStringSession(value), new TeleprotoStringSession(value)];
  const ours = parseGramjsSession(value);
  assert.ok(ours);
  for (const session of theirs) {
    assert.equal(ours.serverAddress, session._serverAddress, 'the same invented quad, from the same bytes, in both packages');
    assert.equal(ours.port, session._port);
  }
  assert.equal(theirs[0]._serverAddress, theirs[1]._serverAddress, 'the two packages mis-read it identically');
  assert.equal(ours.legacyTelethon, true, 'and the flag is how anyone downstream finds out this string came from the older writer');
  assert.equal(ours.authKey.length, 257, 'the key is whatever followed, exactly as both treat it');
});

test('an IPv6 session reads as the compressed address both libraries would have shown', () => {
  /* Any declared length above 100 is taken to mean "this was never a length": rewind two bytes, read sixteen as
     hex. The asymmetry lives in the decoder only, and a rewrite that tidied it would mis-read every IPv6 session. */
  const raw = Buffer.from('20010db8000000000000000000000001', 'hex');
  const body = Buffer.concat([Buffer.from([2]), Buffer.alloc(2, 0), raw, Buffer.alloc(256, 4)]);
  body.writeInt16BE(120, 1);
  const value = `1${body.toString('base64')}`;

  const ours = parseGramjsSession(value);
  assert.ok(ours);
  for (const Class of [GramjsStringSession, TeleprotoStringSession]) {
    assert.equal(ours.serverAddress, new Class(value)._serverAddress, `${Class.name} agrees on the address`);
  }
  assert.equal(ours.legacyTelethon, false);
});

test('a session that is not a session says which kind of not it is', () => {
  for (const empty of ['', null, undefined, '   ']) {
    assert.equal(parseGramjsSession(empty), null, 'an absent session is a state, not an error, and a text field writes whitespace');
  }
  for (const [value, code] of [['2AAAA', 'UNSUPPORTED_VERSION'], ['1', 'TRUNCATED']]) {
    assert.throws(() => parseGramjsSession(value), (error) => error instanceof GramjsSessionError && error.code === code, `${JSON.stringify(value)} is refused with ${code}`);
  }
  assert.throws(() => parseGramjsSession('1!!!not base64!!!'), (error) => error instanceof GramjsSessionError, 'a mangled string is refused, whatever the code says');

  const noKey = Buffer.concat([Buffer.from([2]), Buffer.from([0, 4]), Buffer.from('dc.d'), Buffer.alloc(2, 0)]);
  assert.throws(() => parseGramjsSession(`1${noKey.toString('base64')}`), (error) => error.code === 'BAD_AUTH_KEY', 'a session with no key after the port is not a login');

  assert.throws(
    () => encodeGramjsSession({ dcId: 2, host: 'a.b', port: 443, authKey: new Uint8Array(256) }),
    (error) => error instanceof GramjsSessionError && error.code === 'LEGACY_COLLISION',
    'the write path refuses to create a string either decoder would mis-read',
  );
});

test('a session string never reaches a log line, but its shape does', () => {
  const description = describeGramjsSession(savedBy(GramjsStringSession, {}));
  assert.deepEqual(description, { present: true, dcId: 2, host: '149.154.167.51', port: 443, authKeyBytes: 256, legacyTelethon: false, error: null });
  const rendered = JSON.stringify(description) + String(description);
  assert.equal(rendered.includes(Buffer.from(KEY).toString('base64')), false, 'the key itself is absent');
  assert.equal(rendered.includes(Buffer.from(KEY).toString('hex').slice(0, 16)), false, 'and so is any prefix of it');
  assert.match(rendered, /149\.154\.167\.51/, 'the endpoint is reported, because that is what an operator needs to see');

  const broken = describeGramjsSession('2nope');
  assert.equal(broken.present, true, 'a string that exists but cannot be read is still worth reporting');
  assert.equal(broken.error, 'UNSUPPORTED_VERSION');
  assert.equal(describeGramjsSession('').present, false, 'while an absent session is quiet, not an error');
});

test('the four fields a second driver needs are the four it gets', () => {
  const parsed = parseGramjsSession(savedBy(TeleprotoStringSession, { dcId: 4, serverAddress: '149.154.175.59', port: 443 }));
  assert.ok(parsed);
  assert.deepEqual(toDriverSessionSeed(parsed), { dcId: 4, host: '149.154.175.59', port: 443, authKey: KEY });
  assert.deepEqual(Object.keys(toDriverSessionSeed(parsed)).sort(), ['authKey', 'dcId', 'host', 'port'], 'no format claim, no version, nothing about another library');
});
