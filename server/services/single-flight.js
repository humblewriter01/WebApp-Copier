/**
 * Two small mechanisms for "do not start this twice".
 *
 * Both exist because of a specific production failure: an interval callback that is still running when its next
 * tick arrives. `setInterval` does not care, so the second pass starts while the first is mid-flight, and if that
 * pass constructs a network client, the two passes each build one. Whichever finishes last wins the entry in
 * `telegramClients`, and the other client is left connected, authorized, and referenced by nothing but its own
 * update loop - a socket with receive buffers that no code can reach and no shutdown will close, because the map
 * does not know about it. Repeat that on a host whose network is slow enough to make every pass overlap and the
 * process fills up at 512 MB.
 *
 * The two mechanisms differ in what happens to the second arrival:
 *
 *  - **`createSingleFlight`** is for work keyed by something (one workspace's rebuild). The second caller does
 *    not get to run, and gets told, so it can return the thing the first caller is producing instead of a
 *    duplicate. The key is held for the duration of one call.
 *  - **`createPassGuard`** is for a whole sweep on a timer. There is nothing for the second arrival to join, so
 *    it is simply skipped, and the *duration* of the pass is reported against the interval it was scheduled on -
 *    which is the number that says "this sweep takes 70 seconds and runs every 60", the diagnosis, rather than
 *    the symptom in a memory graph.
 *
 * Deliberately not a queue. Both mechanisms drop work rather than deferring it, because every caller here is a
 * periodic sweep that will run again in thirty or sixty seconds: a queue would grow without bound under exactly
 * the condition that made it necessary, and "the next pass was skipped" is recoverable while "the process held
 * four hundred pending passes" is not.
 *
 * Also deliberately not a promise-join. Handing the second caller the first caller's promise looks better and is
 * much worse: the rebuild path can reach back into this same function through the dead-stream watchdog, and an
 * `await` on the in-flight call would then be an `await` on itself. A skipped caller returns immediately, with
 * whatever the shared state already holds.
 */

/** How long a key may be held before the next arrival assumes its holder is wedged and takes over. */
export const DEFAULT_STALE_AFTER_MS = 5 * 60_000;

/**
 * A per-key "one at a time" latch.
 *
 * @param {{
 *   onContention?: (key: string, held: { startedAt: number, elapsedMs: number, stale: boolean }) => void,
 *   onTakeover?: (key: string, held: { startedAt: number, elapsedMs: number }) => void,
 *   onFinished?: (key: string, outcome: { elapsedMs: number, ok: boolean, value?: any, error?: any }) => void,
 *   staleAfterMs?: number,
 *   now?: () => number,
 * }} [options]
 */
export function createSingleFlight({
  onContention = () => {},
  onTakeover = () => {},
  onFinished = () => {},
  staleAfterMs = DEFAULT_STALE_AFTER_MS,
  now = () => Date.now(),
} = {}) {
  /** @type {Map<string, { token: object, startedAt: number }>} */
  const held = new Map();

  function stateOf(key) {
    const entry = held.get(key);
    if (!entry) return null;
    const elapsedMs = Math.max(0, now() - entry.startedAt);
    // The stale window is strict, so a holder that has been sitting exactly `staleAfterMs` still owns the key.
    return { startedAt: entry.startedAt, elapsedMs, stale: elapsedMs > staleAfterMs };
  }

  return {
    /** How many keys are held right now - a number worth putting on a status page, because it should be 0 or 1. */
    size: () => held.size,
    isRunning: (key) => held.has(String(key)),
    running: () => [...held.keys()],
    elapsedFor: (key) => stateOf(String(key))?.elapsedMs ?? 0,

    /**
     * Run `task` unless the same key is already being worked on.
     *
     * @param {string|number} key
     * @param {() => any} task
     * @returns {Promise<{ ran: boolean, elapsedMs: number, value?: any, error?: any, skippedAfterMs?: number }>}
     */
    async run(key, task) {
      const name = String(key);
      const existing = stateOf(name);
      if (existing) {
        if (!existing.stale) {
          onContention(name, existing);
          return { ran: false, elapsedMs: 0, skippedAfterMs: existing.elapsedMs };
        }
        /* The holder has been sitting on this key longer than any honest version of the work could take. Two
           answers are possible: skip forever, or assume the holder is stuck on a socket that will never answer
           and take the key. Taking it is the right one here, because the work being protected is "restore this
           workspace's session", and refusing to try again because a previous attempt is wedged is how one dead
           promise turns into a permanently deaf workspace. The wedged call is not cancelled - it cannot be, in
           JavaScript - so its completion is guarded by a token, and a stale finisher must not delete a key it no
           longer owns. */
        onTakeover(name, existing);
      }
      const token = {};
      const startedAt = now();
      held.set(name, { token, startedAt });
      try {
        const value = await task();
        const elapsedMs = Math.max(0, now() - startedAt);
        onFinished(name, { elapsedMs, ok: true, value });
        return { ran: true, elapsedMs, value };
      } catch (error) {
        const elapsedMs = Math.max(0, now() - startedAt);
        onFinished(name, { elapsedMs, ok: false, error });
        return { ran: true, elapsedMs, error };
      } finally {
        if (held.get(name)?.token === token) held.delete(name);
      }
    },
  };
}

/**
 * A single-key latch around a periodic pass, with the pass's own duration reported.
 *
 * @param {{
 *   name?: string,
 *   onSkip?: (info: { name: string, elapsedMs: number, runningForMs: number }) => void,
 *   onOverrun?: (info: { name: string, elapsedMs: number, thresholdMs: number }) => void,
 *   overrunAfterMs?: number,
 *   staleAfterMs?: number,
 *   now?: () => number,
 * }} [options]
 */
export function createPassGuard({
  name = 'pass',
  onSkip = () => {},
  onOverrun = () => {},
  overrunAfterMs = 0,
  staleAfterMs = DEFAULT_STALE_AFTER_MS,
  now = () => Date.now(),
} = {}) {
  const flight = createSingleFlight({
    now,
    staleAfterMs,
    onContention: (_key, held) => onSkip({ name, elapsedMs: 0, runningForMs: held.elapsedMs }),
  });
  let passes = 0;
  let skipped = 0;
  let slowestMs = 0;

  return {
    get stats() { return { passes, skipped, slowestMs }; },
    isRunning: () => flight.isRunning(name),
    runningForMs: () => flight.elapsedFor(name),
    /**
     * @template T
     * @param {() => T | Promise<T>} task
     * @returns {Promise<{ ran: boolean, value?: T, error?: any, elapsedMs: number }>}
     */
    async run(task) {
      const result = await flight.run(name, task);
      if (!result.ran) {
        skipped += 1;
        return { ran: false, elapsedMs: 0 };
      }
      passes += 1;
      slowestMs = Math.max(slowestMs, result.elapsedMs);
      if (overrunAfterMs && result.elapsedMs > overrunAfterMs) {
        onOverrun({ name, elapsedMs: result.elapsedMs, thresholdMs: overrunAfterMs });
      }
      return result.error
        // The pass is allowed to throw the way it threw before this wrapper existed; the guard only has to
        // release the key, which `finally` in the flight already did.
        ? (() => { throw result.error; })()
        : { ran: true, value: result.value, elapsedMs: result.elapsedMs };
    },
  };
}

/**
 * A `Set` used as "is somebody already working on this id", with the same stale-takeover rule as the flight above.
 *
 * Not exported for convenience: the fleet summary in the listener reports how many of these are occupied, because
 * a rebuild that never finishes is the one state in this file that a human has to look at.
 *
 * @param {{ now?: () => number, staleAfterMs?: number }} [options]
 */
export function createOccupancySet({ now = () => Date.now(), staleAfterMs = DEFAULT_STALE_AFTER_MS } = {}) {
  /** @type {Map<string, number>} key -> startedAt */
  const occupied = new Map();
  return {
    size: () => occupied.size,
    keys: () => [...occupied.keys()],
    has: (key) => occupied.has(String(key)),
    /** Claim `key`; returns false when it is already claimed and not stale. */
    claim: (key) => {
      const name = String(key);
      const startedAt = occupied.get(name);
      if (startedAt !== undefined && now() - startedAt <= staleAfterMs) return false;
      occupied.set(name, now());
      return true;
    },
    release: (key) => occupied.delete(String(key)),
  };
}
