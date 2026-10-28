/**
 * The keep-alive matcher, on its own, for both vocabularies.
 *
 * `test/telegram-adapter.test.js` already pins the GramJS half, because that half was written against a real
 * failure and a false positive there would hide a socket that has genuinely died. The teleproto half is new, and
 * the rule that keeps this file separate is the user's: a future re-swap must not be able to lose the noise
 * suppression quietly, so the second vocabulary gets a test of its own rather than a clause inside someone
 * else's table.
 *
 * What is being protected, in order of how much it costs us:
 *
 *  - **A missed match is log noise.** The heartbeat's 30-second beat would print a stack every time Telegram
 *    closes an idle connection, which is what the guard exists to prevent and which is survivable.
 *  - **A false match is a hidden fault.** If the matcher accepted an error whose stack came from our own files,
 *    a real bug in our code that happened to be reported with the words "ping timeout" would be swallowed, the
 *    reconnect would still fire, and nothing in the dashboard would say the account had a problem. So the stack
 *    has to be the library's, in both halves, and that is tested from both directions.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { isGramjsKeepAliveTimeout, isProviderKeepAliveTimeout, isTeleprotoKeepAliveTimeout } from '../services/telegram-keepalive.js';

const at = (file, line = 1) => `    at file:///app/node_modules/${file}:${line}:9`;
const thrown = (message, frames) => {
  const error = new Error(message);
  error.stack = `Error: ${message}\n${frames.join('\n')}`;
  return error;
};

const GRAMJS_LOOP = at('telegram/client/updates.js', 412);
const TELEPROTO_SESSION = at('teleproto/network/session/Session.js', 582);

test('both halves are reachable from the one question the guard asks, and are not the same function', () => {
  assert.equal(typeof isProviderKeepAliveTimeout, 'function');
  assert.notEqual(isProviderKeepAliveTimeout, isGramjsKeepAliveTimeout, 'the union is a union, so neither half can be dropped by re-exporting the other');
  assert.notEqual(isProviderKeepAliveTimeout, isTeleprotoKeepAliveTimeout);
  for (const [label, matcher, own] of [
    ['gramjs', isGramjsKeepAliveTimeout, thrown('TIMEOUT', [GRAMJS_LOOP, at('telegram/client/updates.js', 200)])],
    ['teleproto', isTeleprotoKeepAliveTimeout, thrown('Ping timeout of 10s expired', [TELEPROTO_SESSION])],
  ]) {
    assert.equal(matcher(own), true, `${label} recognises its own shape`);
    assert.equal(isProviderKeepAliveTimeout(own), true, `and the guard sees it too, which is the property a re-swap must not lose: ${label}'s timeout still counts as a missed beat`);
  }
});

test('the teleproto vocabulary is matched on both sentences, in either case, at either depth', () => {
  const cases = [
    'Ping timeout of 10s expired',
    'Read timeout of 10s expired',
    'ping timeout of 30s expired',
    'READ TIMEOUT OF 3.5s expired',
    'Ping timeout of 0.001s expired',
  ];
  for (const message of cases) {
    assert.equal(isTeleprotoKeepAliveTimeout(thrown(message, [TELEPROTO_SESSION])), true, JSON.stringify(message));
    assert.equal(isProviderKeepAliveTimeout(thrown(message, [TELEPROTO_SESSION])), true, `${JSON.stringify(message)} through the guard's entry point`);
    /* The fork raises this from its session layer and it surfaces through the connection, so the frame we can
       count on is the library's, not ours - and the matcher accepts any frame inside the package for that reason,
       rather than one path it cannot control. */
    for (const frame of [at('teleproto/network/connection.js', 88), at('teleproto/client/TelegramBaseClient.js', 12)]) {
      assert.equal(isTeleprotoKeepAliveTimeout(thrown('Ping timeout of 10s expired', [frame])), true, 'a later hop inside the same package still counts');
    }
  }
});

test('the teleproto matcher refuses what only looks like a missed beat', () => {
  const nearMisses = [
    'Ping timeout expired',
    'Ping timeout of s expired',
    'Ping timeout of 10 expired',
    'Read timeout of 10m expired',
    'Ping timeout of 10s expired while flushing the queue',
    'timeout',
    'TIMEOUT',
    '',
  ];
  for (const message of nearMisses) {
    assert.equal(isTeleprotoKeepAliveTimeout(thrown(message, [TELEPROTO_SESSION])), false, `${JSON.stringify(message)} is not one of the two sentences, even from the right file`);
  }
  /* The important one: the same words, from our own code. A regression that logs "ping timeout of 10s expired"
     from index.js must not be treated as the benign library beat, because then the reconnect would look handled
     while the fault stayed invisible. */
  assert.equal(isTeleprotoKeepAliveTimeout(thrown('Ping timeout of 10s expired', ['    at noteBeat (file:///app/index.js:40:3)', '    at Tick (file:///app/index.js:22:1)'])), false, 'our own stack frame disqualifies it');
  assert.equal(isGramjsKeepAliveTimeout(thrown('TIMEOUT', ['    at timeout (file:///app/services/telegram-keepalive.js:12:1)'])), false, 'and the GramJS half has always had the same rule');
  assert.equal(isTeleprotoKeepAliveTimeout('Ping timeout of 10s expired'), false, 'a bare string has no stack to trust, so it is not noise');
  assert.equal(isTeleprotoKeepAliveTimeout({ message: 'Ping timeout of 10s expired' }), false, 'an object with no stack is not either');
  assert.equal(isTeleprotoKeepAliveTimeout(null), false);
  assert.equal(isTeleprotoKeepAliveTimeout(undefined), false);
  assert.equal(isProviderKeepAliveTimeout(new Error('socket hang up')), false, 'a real connection fault is never matched by either half');
});

test('the GramJS half keeps its exact behaviour, including the frame it will not forgive', () => {
  /* Written as its own case rather than assumed, because the requirement here is "unchanged", and the cheapest
     way to change it by accident is to widen the shared helper while widening the new one. */
  assert.equal(isGramjsKeepAliveTimeout(thrown('TIMEOUT', [GRAMJS_LOOP])), true, 'first frame, the inline call in _updateLoop');
  assert.equal(isGramjsKeepAliveTimeout(thrown('timeout', [GRAMJS_LOOP])), true, 'case-insensitively, as it has always been');
  assert.equal(isGramjsKeepAliveTimeout(thrown('TIMEOUT', [at('telegram/network/client.js', 9), GRAMJS_LOOP])), false, 'the throw site in the second position counts only with the call that timed out above it');
  assert.equal(isGramjsKeepAliveTimeout(thrown('TIMEOUT', ['    at timeout (file:///app/node_modules/telegram/client/updates.js:9:1)', GRAMJS_LOOP])), true, 'or one with attempts() above the throw site');
  assert.equal(isGramjsKeepAliveTimeout(thrown('TIMEOUT', [])), false, 'and an error with no frame to point at is not matched, because nothing about it says where it came from');
  assert.equal(isGramjsKeepAliveTimeout(thrown('TIMEOUT', [at('telegram/network/client.js', 4)])), false, 'a different file in the same package is not the update loop');
  assert.equal(isGramjsKeepAliveTimeout(thrown('ETIMEDOUT', [GRAMJS_LOOP])), false, 'and neither is a socket error that merely contains the word');
  assert.equal(isTeleprotoKeepAliveTimeout(thrown('TIMEOUT', [GRAMJS_LOOP])), false, 'the halves do not reach into each other\'s territory');
  assert.equal(isGramjsKeepAliveTimeout(thrown('Ping timeout of 10s expired', [TELEPROTO_SESSION])), false);
});
