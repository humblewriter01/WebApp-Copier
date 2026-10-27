/**
 * The log line is the one place this server turns a request's facts into text a person who has not authenticated
 * can read, so the redaction list is a security boundary and not a formatting preference. It is pinned here
 * because every part of it is a string-match away from silently doing nothing: a key renamed at the call site
 * stays in the line, a second writer added beside this one bypasses the list entirely, and spreading `extra`
 * instead of the copy is a one-character change that leaks a session string to stdout.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const index = readFileSync(new URL('../index.js', import.meta.url), 'utf8');

/** The body of `const log`, extracted by braces rather than by line count so it survives reformatting. */
function logFunction() {
  const start = index.indexOf('const log = (level, message');
  assert.notEqual(start, -1, 'the server has a log function to redact with');
  const end = index.indexOf('\n};', start);
  assert.notEqual(end, -1, 'and it ends');
  return index.slice(start, end);
}

test('every credential a route is allowed to attach is stripped before the line is written', () => {
  const body = logFunction();
  /* These six are the names that appear in the payloads this server logs: a phone number and a session string
     from the Telegram login routes, the two spellings a MetaAPI token arrives under, a raw token, and the
     password a registration or recovery request carries. `password_hash` is not in the list because nothing
     that holds one logs it - the check below is what makes that sentence true rather than hopeful. */
  for (const key of ['phoneNumber', 'token', 'apiToken', 'metaApiToken', 'session', 'password']) {
    assert.match(body, new RegExp(`delete safe\\.${key};`), `the redactor removes ${key}`);
  }
  assert.match(body, /const safe = .*?\{ \.\.\.extra \}\)/s, 'from a copy, so a caller keeps the object it handed in');
  assert.match(body, /JSON\.stringify\(\{[\s\S]{0,200}\.\.\.safe \}\)/, 'and the line is serialised from the copy');
  assert.equal(/JSON\.stringify\(\{[\s\S]{0,200}\.\.\.extra/.test(index), false, 'never from the caller\'s object');
});

test('there is exactly one place in the server that writes to the console', () => {
  const writers = index.match(/console\[/g) || [];
  assert.equal(writers.length, 1, 'so there is no second path that skips the redactor by existing');
  assert.equal((index.match(/console\.(log|info|warn|error)\(/g) || []).length, 0, 'and none of the direct calls either');
});

test('a hash or a password is never attached to a log line in the first place', () => {
  /* The redactor would catch `password`; it would not catch `passwordHash`, which is not on the list because it
     must never arrive. This is the assertion that keeps that asymmetry honest. */
  const attached = index.match(/log\((?:'[^']*'|"[^"]*"),[^,]+,\s*\{[^\n]*/g) || [];
  const offending = attached.filter((line) => /password_hash|passwordHash|Hash:/.test(line));
  assert.deepEqual(offending, [], 'no log call in the server carries a hash');
});
