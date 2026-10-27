/**
 * The provider's keep-alive noise, and the narrowness of the filter that hides it.
 *
 * `Error: TIMEOUT` from `telegram/client/updates.js` is GramJS's own ping race expiring; the library catches it,
 * prints it through its client logger's gate, and reconnects the sender. Two properties matter to this file, and
 * they pull against each other: the print has to stop, and *nothing else* may stop with it. Every test here is
 * about that second half - the shape the filter must refuse - because a log filter is easy to write and very
 * easy to write too broadly.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isProviderKeepAliveTimeout,
  createTelegramKeepAliveGuard,
  createUnhandledRejectionGuard,
  KEEP_ALIVE_SUMMARY_MS,
  KEEP_ALIVE_FLAP_GRACE_MS,
} from '../services/telegram-keepalive.js';

/** The stack the library actually produces: `timeout()` in updates.js, called from `_updateLoop`. */
function keepAliveTimeout() {
  const error = new Error('TIMEOUT');
  error.stack = [
    'Error: TIMEOUT',
    '    at timeout (/app/server/node_modules/telegram/client/updates.js:253:60)',
    '    at attempts (/app/server/node_modules/telegram/client/updates.js:232:20)',
    '    at _updateLoop (/app/server/node_modules/telegram/client/updates.js:189:17)',
    '    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)',
  ].join('\n');
  return error;
}

/**
 * One of ours, thrown while the library was on the call stack - which is what every handler in this app looks
 * like, because GramJS dispatches updates from its own loop. This is the error class a
 * "stack includes node_modules/telegram" filter would have eaten.
 */
function ourOwnTimeoutInsideTheLibrary() {
  const error = new Error('TIMEOUT');
  error.stack = [
    'Error: TIMEOUT',
    '    at saveSignal (/app/server/index.js:700:11)',
    '    at ingestMessage (/app/server/services/telegram-listener.js:400:9)',
    '    at _dispatchUpdate (/app/server/node_modules/telegram/client/updates.js:150:9)',
  ].join('\n');
  return error;
}

test('the filter recognises one error, by its message and by the frame that throws it', () => {
  assert.equal(isProviderKeepAliveTimeout(keepAliveTimeout()), true, 'the library ping race, exactly as it arrives');
  assert.equal(isProviderKeepAliveTimeout(ourOwnTimeoutInsideTheLibrary()), false,
    'a TIMEOUT of ours is not the provider clearing its ping, however much of the library is in its stack: the throw site is the only frame that means anything');
  assert.equal(isProviderKeepAliveTimeout(new Error('Connection reset by peer')), false, 'a different message is a different problem');
  const elsewhere = new Error('TIMEOUT');
  elsewhere.stack = 'Error: TIMEOUT\n    at fetchPrice (/app/server/services/metaapi.js:20:5)';
  assert.equal(isProviderKeepAliveTimeout(elsewhere), false, 'and the same message from a different file is still a real fault');
  const noStack = new Error('TIMEOUT');
  noStack.stack = undefined;
  assert.equal(isProviderKeepAliveTimeout(noStack), false, 'an error that cannot say where it came from is not suppressed: unknown is not the same as innocent');
  assert.equal(isProviderKeepAliveTimeout('TIMEOUT'), false, 'a bare string has no throw site to check');
  assert.equal(isProviderKeepAliveTimeout(null), false);
  assert.equal(isProviderKeepAliveTimeout(undefined), false);
});

test('the suppression is a per-client answer to the library gate, not a patch on the printer', async () => {
  const prints = [];
  const originalConsoleError = console.error;
  const probe = (...args) => prints.push(args[0]);
  console.error = probe;
  let clock = 1_000;
  const logs = [];
  const guard = createTelegramKeepAliveGuard({
    log: (level, message, meta) => logs.push({ level, message, meta }),
    now: () => clock,
    summaryEveryMs: 60_000,
  });
  try {
    /* The library's own two seams, duck-typed the way `TelegramBaseClient` builds them: a `canSend` gate on the
       logger, and `onError` as an *accessor* that installs `_errorHandler` - because that indirection is exactly
       what the guard depends on, and a fake with a plain property would pass while the real thing did nothing. */
    const client = {
      _log: { canSend() { return true; } },
      set onError(handler) { this._errorHandler = async (error) => { await handler(error); }; },
    };
    const state = guard.attach(client, { userId: 7 });
    assert.equal(console.error, probe, 'installing the guard leaves the printer alone, so no other code in the process loses its output to a global patch');
    assert.equal(client._log.canSend('error'), true, 'the stock gate still answers normally when nothing is marked');

    /* The exact call order from `client/updates.js`: the error is offered to `_errorHandler`, and only then is the
       logging gate asked whether the print may happen. */
    const printIfAllowed = async (error) => {
      if (client._errorHandler) await client._errorHandler(error);
      if (client._log.canSend('error')) console.error(error);
    };

    await printIfAllowed(keepAliveTimeout());
    assert.deepEqual(prints, [], 'the timeout was counted and not printed');
    assert.equal(state.count, 1, 'counted, because what is removed here is the noise and not the fact');
    assert.equal(client._log.canSend('error'), true, 'the suppression is consumed by the print it was for: the gate is open again immediately');
    await printIfAllowed(new Error('the update handler threw'));
    await printIfAllowed(ourOwnTimeoutInsideTheLibrary());
    assert.equal(prints.length, 2, 'and both of the errors that were not the provider clearing its ping went through untouched');
    assert.deepEqual(prints.map((error) => String(error?.message)), ['the update handler threw', 'TIMEOUT'],
      'including ours: a TIMEOUT thrown from our own code, with the library on its stack, is printed like any other failure');

    clock += 30 * 60_000;
    await printIfAllowed(keepAliveTimeout());
    assert.equal(prints.length, 2, 'the next window suppresses its own timeout too');
    assert.equal(state.count, 2);
    const lines = logs.filter((entry) => entry.message === 'Telegram keep-alive timeouts suppressed');
    assert.equal(lines.length, 2, 'one summary line per window, however many timeouts it covers');
    assert.deepEqual({ userId: lines[1].meta.userId, count: lines[1].meta.count, windowMs: lines[1].meta.windowMs }, { userId: 7, count: 2, windowMs: 60_000 },
      'and the line says which session, how many, and over what window, so a reader can tell a flap from an outage');
    assert.deepEqual(guard.stats(), { count: 2, lastAt: 1_801_000, clients: 1 }, 'the totals are for the panel, not for the log');
    assert.deepEqual(guard.flapFor(client), { at: 1_801_000, count: 2 }, 'and per-client, so the watchdog can ask about the socket it is about to tear down');
    assert.deepEqual(guard.flapFor({}), { at: 0, count: 0 }, 'a client nobody guarded has never flapped, which is the safe answer');
    assert.equal(guard.attach(client, { userId: 7 }), state, 'attaching twice returns the same record instead of double-counting every timeout');
  } finally {
    console.error = originalConsoleError;
  }
});

test('a hundred timeouts a minute become one line, and every one of them is still counted', () => {
  let clock = 0;
  const logs = [];
  const guard = createTelegramKeepAliveGuard({
    log: (level, message, meta) => logs.push({ level, message, meta }),
    now: () => clock,
    summaryEveryMs: 5 * 60_000,
  });
  const client = { _log: { canSend: () => true }, set onError(handler) { this._errorHandler = async (error) => { await handler(error); }; } };
  const state = guard.attach(client, { userId: 3 });
  assert.equal(typeof client._errorHandler, 'function', 'the guard reaches the library through the handler it calls');
  // One cycle every 9 seconds, for an hour: 400 prints silenced, 12 lines said.
  for (let i = 0; i < 400; i += 1) {
    clock += 9_000;
    guard.note(keepAliveTimeout(), state);
  }
  assert.equal(state.count, 400, 'nothing was lost to the suppression');
  assert.equal(logs.length, 12, `one line per ${Math.round(5 * 60_000 / 60_000)}-minute window, the first of them immediately`);
  assert.equal(guard.stats().count, 400);
});

test('a timeout with no client to attribute it to is still counted, because the count is the point', () => {
  const logs = [];
  const guard = createTelegramKeepAliveGuard({ log: (level, message, meta) => logs.push({ level, message, meta }), now: () => 10_000 });
  assert.equal(guard.observe(keepAliveTimeout()), true);
  assert.equal(guard.observe(new Error('something else entirely')), false, 'and an unrecognised rejection is left exactly as it was');
  assert.deepEqual(guard.stats(), { count: 1, lastAt: 10_000, clients: 0 });
  assert.equal(logs[0].meta.userId, null, 'the line says it came from nowhere in particular, which is the truth');
});

test('a client whose internals have changed shape loses the guard and nothing else', () => {
  const logs = [];
  const guard = createTelegramKeepAliveGuard({ log: (level, message) => logs.push({ level, message }) });
  assert.equal(guard.attach(null), null, 'no client, no guard, no exception');
  assert.equal(guard.attach({}).userId, null, 'a guarded client with no user attribution still gets a record');
  const frozen = Object.freeze({ _log: Object.freeze({ canSend: () => true }) });
  assert.equal(guard.attach(frozen, { userId: 1 }) !== null, true, 'a frozen client returns a state so the caller keeps working');
  assert.ok(logs.some((entry) => entry.message === 'Telegram keep-alive guard could not be attached'), 'and it says so once, at warn, rather than failing silently forever');
});

test('the process filter exists for the ping, and hands everything else back to Node', () => {
  const noise = [];
  const others = [];
  const handler = createUnhandledRejectionGuard({
    isNoise: isProviderKeepAliveTimeout,
    onNoise: (reason) => noise.push(reason),
    onOther: (reason) => others.push(reason),
  });
  assert.equal(handler(keepAliveTimeout()), true, 'a leaked keep-alive rejection is handled, so a data center hiccup cannot restart a deploy');
  assert.equal(noise.length, 1);
  const bug = new Error('cannot read properties of undefined');
  bug.stack = 'Error: cannot read properties of undefined\n    at saveSignal (/app/server/index.js:1:1)';
  assert.equal(handler(bug), false, 'anything else is not ours to keep');
  assert.deepEqual(others, [bug], 'and the caller decides what that means, which in production is rethrowing it on the next tick so the process still dies with its stack');
  assert.equal(noise.length, 1, 'an unrelated rejection never increments the noise counter');
});

test('the windows are the library’s, not invented numbers', () => {
  // The grace window has to cover a provider reconnect cycle, which is `PING_INTERVAL` plus three `PING_TIMEOUT`
  // races - and the beat that consults it runs every 30 seconds, so "one beat, maybe two" is the whole ask.
  assert.equal(KEEP_ALIVE_FLAP_GRACE_MS, 60_000, 'two beats of grace, no more: a dead socket is still rebuilt, one cycle later');
  assert.equal(KEEP_ALIVE_SUMMARY_MS, 5 * 60_000, 'a five-minute silence between summaries is short enough to notice and long enough not to matter');
});
