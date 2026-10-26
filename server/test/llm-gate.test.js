/**
 * The queue in front of the AI reader.
 *
 * None of this is about the model's answer; it is about who gets to ask. A reconnect replays up to 25 messages
 * and, before this gate existed, every one of them that needed Layer 2 issued its own request immediately -
 * which meant a live signal arriving in the middle of that replay was either behind it on the provider's rate
 * limit or inside a burst that the provider answers with 429s. The properties below are the whole contract:
 * a bounded number of open requests, live captures served first, replayed work that gives up rather than
 * queueing forever, and a live capture that is never refused a slot.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createLlmGate } from '../services/llm-gate.js';

/** A task that stays pending until the test hands it back its resolver, so "in flight" is controllable. */
function deferredTask() {
  let resolve;
  let reject;
  const promise = new Promise((innerResolve, innerReject) => { resolve = innerResolve; reject = innerReject; });
  return { promise, resolve, reject, started: false, task: null };
}

function harness(options = {}) {
  const tasks = [];
  const gate = createLlmGate({
    maxConcurrent: 1,
    replayQueue: 2,
    // No give-up deadline by default: these tests say when a task finishes, so a real timer would only make
    // the outcome depend on how long the event loop took.
    replayWaitMs: 10_000_000,
    ...options,
  });
  const submit = (label, priority) => {
    const holder = deferredTask();
    const task = () => { holder.started = true; order.push(label); return holder.promise; };
    const order = submit.order;
    const result = gate.run(task, { priority });
    tasks.push({ label, priority, holder, result });
    return tasks[tasks.length - 1];
  };
  submit.order = [];
  return { gate, submit, tasks, order: submit.order };
}

/** Let the gate's own promise chain (task → finish → settle → pump) run to the end of the turn. */
const tick = async () => { for (let index = 0; index < 3; index += 1) await new Promise((resolve) => setImmediate(resolve)); };

test('at most `maxConcurrent` requests are open at once', async () => {
  let active = 0;
  let peak = 0;
  const gate = createLlmGate({ maxConcurrent: 2 });
  const make = () => gate.run(async () => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setImmediate(resolve));
    active -= 1;
    return 'done';
  });
  const results = await Promise.all(Array.from({ length: 7 }, make));
  assert.deepEqual(results.map((result) => result.value), Array(7).fill('done'), 'every request still gets its answer');
  assert.equal(peak, 2, 'and never more than two were in flight');
  assert.deepEqual(gate.summary().waiting, { realtime: 0, replay: 0 }, 'the queue drains');
});

test('a live capture is served before a replay that queued first', async () => {
  const run = harness({ maxConcurrent: 1 });
  const first = run.submit('blocking', 'realtime');
  await tick();
  const replayA = run.submit('replay-a', 'replay');
  const replayB = run.submit('replay-b', 'replay');
  const live = run.submit('live', 'realtime');
  assert.equal(first.holder.started, true, 'one request is open');
  assert.equal(live.holder.started, false, 'and the live capture waits for its turn like anything else');

  first.holder.resolve({ fields: 1 });
  await tick();
  assert.deepEqual(run.order, ['blocking', 'live'], 'the live message goes next, ahead of both replays');
  live.holder.resolve({ fields: 2 });
  await tick();
  assert.equal(run.order[2], 'replay-a', 'and only then the replay that asked first');
  replayA.holder.resolve({});
  await tick();
  replayB.holder.resolve({});
  const settled = await Promise.all([first.result, live.result, replayA.result, replayB.result]);
  assert.deepEqual(settled.map((result) => result.ok), [true, true, true, true], 'nothing was refused on the way');
  assert.deepEqual(run.order, ['blocking', 'live', 'replay-a', 'replay-b']);
});

test('a replay is given up on rather than queued behind a wall of older messages', async () => {
  const run = harness({ maxConcurrent: 1, replayQueue: 2 });
  const blocking = run.submit('blocking', 'realtime');
  await tick();
  const a = run.submit('replay-a', 'replay');
  const b = run.submit('replay-b', 'replay');
  const c = run.submit('replay-c', 'replay');

  const third = await c.result;
  assert.equal(third.ok, false, 'the overflow replay is refused immediately, before anything else finishes');
  assert.equal(third.code, 'gated');
  assert.match(third.reason, /catching up/i, 'and the sentence says what actually happened');
  assert.equal(run.gate.summary().gated, 1, 'the refusal is countable, because it is the number that says how much review the queue caused');

  blocking.holder.resolve({});
  await tick();
  assert.equal(a.holder.started, true, 'the replay that fitted in the queue is still served');
  a.holder.resolve({});
  await tick();
  assert.equal(b.holder.started, true, 'and so is the second one');
  b.holder.resolve({});
  const [ra, rb] = await Promise.all([a.result, b.result]);
  assert.equal(ra.ok, true);
  assert.equal(rb.ok, true);
});

test('a live capture is never refused a slot, however deep the replay queue is', async () => {
  const run = harness({ maxConcurrent: 1, replayQueue: 1 });
  const blocking = run.submit('blocking', 'realtime');
  await tick();
  const queuedReplay = run.submit('replay-a', 'replay');
  const overflowReplay = run.submit('replay-b', 'replay');
  const live = run.submit('live', 'realtime');
  const late = run.submit('live-2', 'realtime');
  assert.deepEqual(await overflowReplay.result, { ok: false, code: 'gated', reason: 'The AI reader is already catching up on this channel, so this message was left for review.' }, 'the overflow replay is the one that is refused');

  blocking.holder.resolve({});
  await tick();
  for (const entry of [live, late, queuedReplay]) entry.holder.resolve({ ran: true });
  await tick();
  const results = await Promise.all([live.result, late.result, queuedReplay.result]);
  assert.deepEqual(results.map((result) => result.ok), [true, true, true], 'no live request was ever refused, however deep the replay queue got');
  assert.ok(run.order.indexOf('live') < run.order.indexOf('replay-a'), 'live went ahead of the queued replay');
});

test('a replay that waits past its deadline is left for review instead of holding the queue', async () => {
  const timers = [];
  const gate = createLlmGate({
    maxConcurrent: 1,
    replayWaitMs: 50,
    setTimeoutImpl: (fn, ms) => { const entry = { fn, ms, cleared: false }; timers.push(entry); return entry; },
    clearTimeoutImpl: (entry) => { if (entry) entry.cleared = true; },
  });
  const blocking = gate.run(() => new Promise(() => {}), { priority: 'realtime' });
  const waiting = gate.run(() => Promise.resolve({ ran: true }), { priority: 'replay' });
  const deadline = timers.find((entry) => entry.ms === 50);
  assert.ok(deadline, 'the replay armed a deadline');
  assert.equal(deadline.cleared, false, 'while it is still queued');
  deadline.fn();
  const outcome = await waiting;
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, 'gated');
  assert.match(outcome.reason, /newer messages/i, 'the sentence names the reason the reader never ran');
  assert.equal(typeof blocking, 'object', 'the live request that was already open is untouched by any of this');
});

test('a slot is released when a request throws, so one bad call cannot wedge the reader', async () => {
  const gate = createLlmGate({ maxConcurrent: 1 });
  const failed = await gate.run(async () => { throw new Error('socket hang up'); });
  assert.equal(failed.ok, false, 'the failure comes back as a refusal rather than a rejection');
  assert.equal(failed.code, 'reader-failed');
  assert.match(failed.reason, /socket hang up/, 'with the words the pipeline writes onto the row');
  assert.equal(failed.error instanceof Error, true, 'and the error itself travels with it, for the log');
  const next = await gate.run(async () => 'ran');
  assert.equal(next.value, 'ran', 'and the next message is still served');
});

test('an unknown priority is treated as live rather than dropped', async () => {
  const gate = createLlmGate({ maxConcurrent: 1 });
  const result = await gate.run(async () => 'answer', { priority: 'whatever' });
  assert.equal(result.value, 'answer');
  assert.deepEqual(gate.summary().waiting, { realtime: 0, replay: 0 });
});
