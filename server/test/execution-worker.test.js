/**
 * How long a queued job waits, and what a wake-up is allowed to cost.
 *
 * The worker is the last hop between a channel's message and an order at the broker, and until now the only
 * way into it was the clock: a job written a moment after a pass finished sat in `queued` for the rest of the
 * interval - up to 1.2 s of the 120 s window in which the price the channel published is still the price the
 * trader meant, and longer if the pass it landed in was busy sweeping open positions. These tests drive the
 * real `createExecutionWorker` with a deliberately absurd poll interval, so the only way a job can be claimed
 * is the way the capture path claims it: by waking the loop.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createExecutionWorker } from '../services/execution-worker.js';

/**
 * A pool that answers the four statements the worker issues and nothing else, and an engine that records what
 * it was asked to do. `queue` is the table: `claimOne` shifts from it exactly as `FOR UPDATE SKIP LOCKED` would.
 */
function harness({ jobs = [], sweeps = true } = {}) {
  const state = { queue: [...jobs], processed: [], sweeps: { breakEven: 0, takeProfit: 0, resting: 0 }, queries: [] };
  const pool = {
    async query(sql, params) {
      state.queries.push(String(sql).replace(/\s+/g, ' ').trim().slice(0, 48));
      if (sql.includes("UPDATE execution_jobs SET status='expired'")) return { rows: [] };
      if (sql.includes("UPDATE execution_jobs SET status='unknown'")) return { rows: [] };
      throw new Error(`unexpected statement: ${String(sql).slice(0, 60)}`);
    },
    async connect() {
      return {
        async query(sql) {
          state.queries.push(String(sql).replace(/\s+/g, ' ').trim().slice(0, 48));
          if (sql.includes('FROM execution_jobs')) return { rows: state.queue.slice(0, 1) };
          if (sql.includes("SET status='processing'")) {
            const next = state.queue.shift();
            return { rows: next ? [next] : [] };
          }
          return { rows: [] };
        },
        release() {},
      };
    },
  };
  const engine = {
    async processJob(job) { state.processed.push(job.id); },
    ...(sweeps ? {
      async sweepBreakEven() { state.sweeps.breakEven += 1; return { moved: 0 }; },
      async sweepTakeProfitLevels() { state.sweeps.takeProfit += 1; return { closed: 0 }; },
      async sweepExpiredOrders() { state.sweeps.resting += 1; return { attempted: 0 }; },
    } : {}),
  };
  const logger = { info() {}, warn() {}, error() {} };
  return { state, worker: createExecutionWorker({ pool, engine, logger, pollIntervalMs: 60_000 }) };
}

const settle = (ms = 15) => new Promise((resolve) => setTimeout(resolve, ms));

test('a queued job is claimed by the wake-up, not by the clock', async () => {
  const { state, worker } = harness({ jobs: [{ id: 'job-1', user_id: 'user-1', signal_id: 'signal-1' }] });
  worker.start();
  await settle();
  assert.deepEqual(state.processed, ['job-1'], 'the pass that start() kicks off finds it');

  state.queue.push({ id: 'job-2', user_id: 'user-1', signal_id: 'signal-2' });
  assert.equal(state.processed.length, 1, 'and with a 60-second interval, nothing else would run for a minute');
  assert.equal(worker.notify(), true, 'the wake-up reports that work was accepted');
  await settle();
  assert.deepEqual(state.processed, ['job-1', 'job-2'], 'a job written after a pass finished is claimed on the spot');
  await worker.stop();
});

test('a wake-up that lands mid-pass is honoured by that pass, and never doubles it', async () => {
  let claims = 0;
  const { state, worker } = harness({ jobs: [{ id: 'job-a', user_id: 'user-1', signal_id: 's-a' }] });
  let releaseHold;
  const hold = new Promise((resolve) => { releaseHold = resolve; });
  const slowEngine = {
    async processJob(job) { claims += 1; state.processed.push(job.id); await hold; },
  };
  const pool = {
    async query() { return { rows: [] }; },
    async connect() {
      return {
        async query(sql) {
          if (sql.includes('FROM execution_jobs')) return { rows: state.queue.slice(0, 1) };
          if (sql.includes("SET status='processing'")) { const next = state.queue.shift(); return { rows: next ? [next] : [] }; }
          return { rows: [] };
        },
        release() {},
      };
    },
  };
  const running = createExecutionWorker({ pool, engine: slowEngine, logger: { info() {}, warn() {}, error() {} }, pollIntervalMs: 60_000 });
  running.start();
  await settle();
  assert.equal(claims, 1, 'one pass is in flight, held inside processJob');
  state.queue.push({ id: 'job-c', user_id: 'user-1', signal_id: 's-c' });
  running.notify();
  running.notify();
  running.notify();
  await settle();
  assert.equal(claims, 1, 'three wakes while it is busy still do not start a second pass beside it');
  releaseHold();
  await settle();
  assert.ok(claims >= 2, 'the pass that was running goes straight into another one when it finishes');
  await running.stop();
  const after = claims;
  await settle(30);
  assert.equal(claims, after, 'and stopping leaves nothing scheduled behind it');
});

test('a stream of jobs is drained in consecutive passes, bounded so protection is not starved', async () => {
  const many = Array.from({ length: 12 }, (_, index) => ({ id: `job-${index}`, user_id: 'user-1', signal_id: `s-${index}` }));
  // The shipped budget, because the budget and the sweep cadence are the same two numbers argued about: five
  // claimed passes is what the loop tolerates before it insists on a protection sweep, and a follow-on chain
  // shorter than that would leave the counter reset by the interval instead.
  const { state, worker } = createWorkerWithLimit(many, 8);
  worker.start();
  await settle(120);
  await worker.stop();
  assert.equal(state.processed.length, 8, `the chain ran exactly the follow-on budget (${state.processed.length} jobs)`);
  assert.ok(state.processed.length < 12, 'but a queue cannot hold the loop in a permanent claim-and-run loop');
  assert.ok(state.sweeps.breakEven > 0, 'the break-even sweep still ran while jobs were waiting, because orders go first and protection goes with them');
});

function createWorkerWithLimit(jobs, followUpLimit) {
  const built = harness({ jobs });
  const pool = {
    async query() { return { rows: [] }; },
    async connect() {
      return {
        async query(sql) {
          if (sql.includes('FROM execution_jobs')) return { rows: built.state.queue.slice(0, 1) };
          if (sql.includes("SET status='processing'")) {
            const next = built.state.queue.shift();
            return { rows: next ? [next] : [] };
          }
          return { rows: [] };
        },
        release() {},
      };
    },
  };
  const engine = {
    async processJob(job) { built.state.processed.push(job.id); },
    async sweepBreakEven() { built.state.sweeps.breakEven += 1; return { moved: 0 }; },
    async sweepTakeProfitLevels() { built.state.sweeps.takeProfit += 1; return { closed: 0 }; },
    async sweepExpiredOrders() { built.state.sweeps.resting += 1; return { attempted: 0 }; },
  };
  return { state: built.state, worker: createExecutionWorker({ pool, engine, logger: { info() {}, warn() {}, error() {} }, pollIntervalMs: 60_000, followUpLimit }) };
}

test('notify is inert before start and after stop, so a capture during boot is not lost but never double-runs', async () => {
  const { state, worker } = harness({ jobs: [{ id: 'job-x', user_id: 'user-1', signal_id: 's-x' }] });
  assert.equal(worker.notify(), false, 'a wake-up before the worker is started says so instead of queueing a pass');
  assert.deepEqual(state.processed, [], 'and nothing ran');
  worker.start();
  await settle();
  assert.deepEqual(state.processed, ['job-x'], 'the same call after start is what claims the job');
  await worker.stop();
  assert.equal(worker.notify(), false, 'and after stop it is inert again');
});

test('a pass reports whether it claimed anything, which is what the next pass is decided on', async () => {
  const { state, worker } = harness({ jobs: [] });
  const idle = await worker.runOnce();
  assert.deepEqual(idle, { claimed: false }, 'an empty queue is reported as empty');
  state.queue.push({ id: 'job-q', user_id: 'user-1', signal_id: 's-q' });
  const busy = await worker.runOnce();
  assert.deepEqual(busy, { claimed: true }, 'and a claim is reported as a claim');
  assert.equal(state.processed.length, 1, 'the engine saw it');
});

test('a failing engine cannot take the loop down with it, and the wake-up survives it', async () => {
  const pool = {
    async query() { return { rows: [] }; },
    async connect() {
      return {
        async query(sql) {
          if (sql.includes('FROM execution_jobs')) return { rows: [{ id: 'job-f', user_id: 'user-1', signal_id: 's-f' }] };
          if (sql.includes("SET status='processing'")) return { rows: [{ id: 'job-f', user_id: 'user-1', signal_id: 's-f' }] };
          return { rows: [] };
        },
        release() {},
      };
    },
  };
  const seen = [];
  const engine = { async processJob(job) { seen.push(job.id); throw new Error('MetaAPI refused (HTTP 503) authorization=Bearer abc.def.ghi'); } };
  const logged = [];
  const worker = createExecutionWorker({ pool, engine, logger: { info() {}, warn() {}, error: (line) => logged.push(line) }, pollIntervalMs: 60_000 });
  worker.start();
  await settle();
  worker.notify();
  await settle();
  await worker.stop();
  assert.ok(seen.length >= 2, 'the pass after the throw ran anyway - a job that fails is not a worker that stops');
  const lines = logged.join('\n');
  assert.match(lines, /Execution worker iteration failed/, 'the failure is reported, with the reason');
  assert.match(lines, /HTTP 503/, 'a status code belongs in exactly this place - the operator log, not a card');
  assert.match(lines, /authorization=\[redacted\]/, 'and the credential beside it does not survive the trip');
});
