/**
 * The one retry a sleeping host is worth, and no more.
 *
 * `lib/api.js` cannot be imported from a test - it resolves the API origin from `import.meta.env`, which
 * only exists in a Vite build - so the rule that decides *whether* to retry lives in `lib/wake-retry.js`
 * and is tested here directly. These four cases are the whole difference between the message an
 * administrator was shown ("Signal Desk did not answer that request, so it may never have been
 * applied") and the outcome they needed (the suspension applied on the second attempt, a few seconds
 * after the service finished waking up).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { UNANSWERED_STATUSES, WAKE_RETRY_DELAY_MS, isUnansweredRequestFailure, withWakeRetry } from '../src/lib/wake-retry.js';

function failure(message, extra = {}) {
  const error = new Error(message);
  Object.assign(error, extra);
  return error;
}

test('only a request nobody answered counts as unanswered', () => {
  assert.equal(isUnansweredRequestFailure(failure('fetch failed', { name: 'TypeError' })), true, 'a closed socket during a wake is the case that matters most');
  assert.equal(isUnansweredRequestFailure(failure('nope', { status: 503, answered: false })), true, 'a gateway page is not an answer from the service');
  for (const status of UNANSWERED_STATUSES) {
    assert.equal(isUnansweredRequestFailure(failure('gateway', { status, answered: false })), true, `HTTP ${status} is a proxy, not the service`);
  }
  assert.equal(isUnansweredRequestFailure(failure('Conflict', { status: 503, answered: true })), false, 'a 503 that carries the service sentence was answered');
  assert.equal(isUnansweredRequestFailure(failure('Add a short reason before suspending this user.', { status: 400 })), false, 'a refusal is never retried');
  assert.equal(isUnansweredRequestFailure(failure('gone', { status: 404 })), false, 'a 404 is an answer');
  assert.equal(isUnansweredRequestFailure(failure('down', { status: 500, answered: true })), false, 'a 500 that spoke for itself is an answer');
  assert.equal(isUnansweredRequestFailure(undefined), false);
});

test('an unanswered first attempt is sent once more, and the answer from the second is returned', async () => {
  const waits = [];
  const attempts = [];
  const result = await withWakeRetry(async () => {
    attempts.push(attempts.length);
    if (attempts.length === 1) throw failure('Failed to fetch', { name: 'TypeError' });
    return { user: { id: 'u-1', isSuspended: true } };
  }, { sleep: async (ms) => { waits.push(ms); }, retryDelayMs: 250 });
  assert.equal(attempts.length, 2, 'exactly one retry');
  assert.deepEqual(waits, [250], 'and the retry waits for the wake window rather than firing immediately');
  assert.deepEqual(result.user, { id: 'u-1', isSuspended: true });
});

test('a refusal is not retried, so the service sentence arrives immediately', async () => {
  let calls = 0;
  await assert.rejects(
    withWakeRetry(async () => {
      calls += 1;
      throw failure('You cannot suspend your own account.', { status: 409, answered: true });
    }, { sleep: async () => {} }),
    /You cannot suspend your own account\./,
  );
  assert.equal(calls, 1, 'a deliberate no is passed straight through');
});

test('two unanswered attempts say what is now known, and mark themselves', async () => {
  const waits = [];
  let clock = 1000;
  await assert.rejects(
    withWakeRetry(async () => { throw failure('Signal Desk did not answer that request (HTTP 502).', { status: 502, answered: false }); }, {
      sleep: async (ms) => { waits.push(ms); clock += ms; },
      now: () => clock,
    }),
    (error) => {
      assert.equal(error.wakeRetried, true, 'the caller can tell this from a first-attempt failure');
      assert.equal(error.wakeRetryWaitedMs, WAKE_RETRY_DELAY_MS, 'and how long the wait actually was');
      assert.match(error.message, /did not answer either attempt/);
      assert.match(error.message, /nothing was changed/);
      return true;
    },
  );
  assert.equal(waits.length, 1, 'the budget is one retry, never a loop');
});

test('a request that fails after the first attempt was answered is not retried blindly', async () => {
  let calls = 0;
  // The first attempt succeeded at the transport level and the second one is refused: the retry must
  // not swallow that refusal into a "nobody was home" sentence.
  await assert.rejects(
    withWakeRetry(async () => {
      calls += 1;
      if (calls === 1) throw failure('socket reset', { name: 'TypeError' });
      throw failure('That user could not be found.', { status: 404, answered: true });
    }, { sleep: async () => {} }),
    /That user could not be found\./,
  );
  assert.equal(calls, 2);
});
