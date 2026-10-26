/**
 * One queue in front of the AI reader, so a catch-up cannot spend the latency of a live signal.
 *
 * Layer 1 costs nothing and is never delayed by this file: a message the deterministic parser finished is
 * written and queued before any request is made (`needsLayer2` says so). The gate exists for the other case -
 * a message that needs the model - because that request is the only part of capture whose duration belongs to
 * somebody else's server. Two things went wrong without it:
 *
 *   1. A reconnect replays up to 25 recent messages, and if several of them need the model, that replay sits
 *      in front of every live message on the same endpoint. Groq answers per-model rate limits with 429s and
 *      queueing, so the *live* signal - the one where seconds decide whether the level is still there - is the
 *      one that waits.
 *   2. Nothing bounded the number of requests in flight, so a burst of captures could open as many concurrent
 *      calls as there were messages, which is how a burst turns into a wall of timeouts. Each call carries its
 *      own deadline, but thirty deadlines firing at once is a worse outcome than ten of them never being made.
 *
 * The rules here are therefore about ordering and pressure, not about retrying:
 *
 *     - at most `maxConcurrent` requests are open at a time;
 *     - live captures are served before replayed ones, and a live capture is never refused;
 *     - a replayed message that cannot get a slot within `replayWaitMs` is *not* asked - it comes back
 *       `gated`, which the pipeline already treats as "saved for review", the same outcome as a model that
 *       could not be reached. A catch-up row waiting for the next sweep is a row that is still stored; a live
 *       signal that missed its level is a trade that did not happen.
 *
 * The gate never throws, and it never holds a request open after its caller has given up: the deadline is the
 * caller's (`LLM_TIMEOUT_MS`), and a task that finishes after its slot was released still returns its answer.
 */

export const DEFAULT_MAX_CONCURRENT = 2;
export const DEFAULT_REPLAY_QUEUE = 8;
/** How long a replayed message waits for a free slot before it is left for review instead. */
export const DEFAULT_REPLAY_WAIT_MS = 20_000;

/** The order requests are served in. A lower number is served first. */
const PRIORITIES = { realtime: 0, replay: 1 };

/**
 * @param input.maxConcurrent   how many model requests may be open at once
 * @param input.replayQueue     how many replayed messages may wait at all
 * @param input.replayWaitMs    how long one of them may wait before it is given up on
 * @param input.waiters         test seam for the clock the give-up deadline uses
 */
export function createLlmGate({
  maxConcurrent = DEFAULT_MAX_CONCURRENT,
  replayQueue = DEFAULT_REPLAY_QUEUE,
  replayWaitMs = DEFAULT_REPLAY_WAIT_MS,
  now = () => Date.now(),
  setTimeoutImpl = (fn, ms) => setTimeout(fn, ms),
  clearTimeoutImpl = (timer) => clearTimeout(timer),
} = {}) {
  const limit = Math.max(1, Number(maxConcurrent) || DEFAULT_MAX_CONCURRENT);
  const queues = new Map([...Object.keys(PRIORITIES).map((key) => [key, []])]);
  const running = new Set();
  /** Only for the panel: how many requests have been refused because the queue was full. */
  let gatedCount = 0;

  function settle(entry) {
    running.delete(entry);
    pump();
  }

  function pump() {
    while (running.size < limit) {
      let next = null;
      for (const key of Object.keys(PRIORITIES)) {
        const queue = queues.get(key);
        if (queue.length) { next = queue.shift(); break; }
      }
      if (!next) return;
      next.start();
      running.add(next);
      /* A task that throws is a bug in the caller or a provider that fell over, and neither may come back as an
         unhandled rejection or as a lost message: the capture path would otherwise drop the row it was asked
         to save. It is reported as a refusal, which the pipeline already files as "saved for review". */
      Promise.resolve()
        .then(next.task)
        .then(
          (value) => next.finish({ ok: true, value }),
          (error) => next.finish({
            ok: false,
            code: 'reader-failed',
            reason: `The AI reader could not be consulted (${error?.message || 'the request itself failed'}), so this signal was saved for review.`,
            error,
          }),
        )
        .finally(() => settle(next));
    }
  }

  /**
   * Ask for `task` to run when the gate allows it.
   *
   * Resolves with `{ ok: true, value }` when the task ran, or `{ ok: false, code: 'gated' }` when a replayed
   * message was given up on. A live message has no such branch: it is queued ahead of everything replayed and
   * waits as long as it takes, because the alternative is a signal that silently never gets read by the layer
   * that was supposed to rescue it.
   */
  function run(task, { priority = 'realtime' } = {}) {
    const key = PRIORITIES[priority] === undefined ? 'realtime' : priority;
    return new Promise((resolve) => {
      const entry = {
        key,
        task,
        timer: null,
        settled: false,
        start() { if (entry.timer) { clearTimeoutImpl(entry.timer); entry.timer = null; } },
        finish(result) {
          if (entry.settled) return;
          entry.settled = true;
          if (entry.timer) { clearTimeoutImpl(entry.timer); entry.timer = null; }
          resolve(result);
        },
      };
      // A replay waits only as long as it takes to get a slot; after that the row goes to review, and the
      // deadline is cleared the moment it is served so a fast gate never trips it.
      if (key === 'replay') {
        entry.timer = setTimeoutImpl(() => {
          if (entry.settled) return;
          entry.settled = true;
          const queue = queues.get(key);
          const at = queue.indexOf(entry);
          if (at >= 0) queue.splice(at, 1);
          else running.delete(entry);
          gatedCount += 1;
          resolve({ ok: false, code: 'gated', reason: 'The AI reader was working through newer messages, so this one was left for review.' });
        }, Math.max(1, Number(replayWaitMs) || DEFAULT_REPLAY_WAIT_MS));
        entry.timer?.unref?.();
      }
      const queue = queues.get(key);
      if (key === 'replay' && queue.length >= Math.max(1, Number(replayQueue) || DEFAULT_REPLAY_QUEUE)) {
        if (entry.timer) clearTimeoutImpl(entry.timer);
        entry.settled = true;
        gatedCount += 1;
        resolve({ ok: false, code: 'gated', reason: 'The AI reader is already catching up on this channel, so this message was left for review.' });
        return;
      }
      queue.push(entry);
      pump();
    });
  }

  function summary() {
    return {
      maxConcurrent: limit,
      active: running.size,
      waiting: Object.fromEntries([...queues.entries()].map(([key, queue]) => [key, queue.length])),
      gated: gatedCount,
    };
  }

  return { run, summary };
}
