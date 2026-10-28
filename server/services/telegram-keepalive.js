/**
 * The provider's keep-alive noise, counted instead of printed.
 *
 * `Error: TIMEOUT` from `telegram/client/updates.js` is GramJS's own ping loop giving up on a pong, and
 * `Error('Ping timeout of Ns expired')` from `teleproto/network/session/Session.js` is the same event in the
 * fork. Either one is what this file exists for. It is
 * worth understanding before it is worth silencing, so here is what that file actually does (2.26.22): every
 * `PING_INTERVAL` (9 s) it sends `PingDelayDisconnect` through `timeout(ping, PING_TIMEOUT)` - a 10 s race it
 * implements itself, with `PING_FAIL_ATTEMPTS` (3) goes at `PING_FAIL_INTERVAL` (100 ms) - and the catch around
 * that block hands the error to `client._errorHandler`, prints it with `console.error` if the client's logger
 * will allow it, and then calls `client._sender.reconnect()`. So the line is not a warning that a message was
 * lost; it is the trace of a transport flap the library is already recovering from, repeated once per nine
 * seconds per session, which on Render is hundreds of stack traces an hour for a connection that answers our
 * own `updates.GetState` in twenty milliseconds.
 *
 * Two rules keep this honest, and they are the whole design:
 *
 * 1. **Count before the gate, never after.** Every recognised error increments the counter *first*, so what
 *    disappears is the print, not the fact. The counts reach the heartbeat summary, the fleet panel and one
 *    rate-limited log line per window, which is what makes it safe to suppress at all: an operator who wants to
 *    know that the ping loop is unhappy can still ask, and one who does not will not read it four hundred times.
 * 2. **"From the telegram package" is not a usable filter.** Our capture path is *called by* the library -
 *    `saveSignal` runs inside `_dispatchUpdate`, whose frames are in that stack - so a predicate written as
 *    "stack contains node_modules/telegram" would also swallow a dead Postgres pool, a parser bug, and every
 *    other failure that happens while the library is on the call stack. That is the class of bug this file must
 *    not create. So the test is the exact message GramJS builds *and* the exact frame that builds it - the
 *    **first** frame, the throw site - which our own errors never have.
 *
 * The suppression itself goes through the seam the library already offers rather than through `console`: the
 * catch calls `_errorHandler` and *then* asks `_log.canSend(ERROR)` before printing, so a per-client logger that
 * answers that one question "no" for one marked error silences the noise for that client only, leaves
 * `info`/`warn`/`debug` behaviour untouched, and never touches a global that other code logs through.
 */

import * as telegramAdapter from './telegram-adapter.js';

/** How often one client may say "the keep-alive is timing out" out loud, however many times it happens. */
export const KEEP_ALIVE_SUMMARY_MS = 5 * 60_000;
/**
 * How long a mark may suppress a print. One error is offered to `_errorHandler` and then to `canSend` in the same
 * tick, so this is a seatbelt, not a policy: a mark nobody consumed must not be able to silence the *next*
 * error, which is a different error about a different thing.
 */
export const KEEP_ALIVE_MARK_TTL_MS = 1_000;
/**
 * How long a recognised keep-alive timeout counts as "the transport is mid-flap" for the watchdog.
 *
 * The arithmetic is the library's: `PING_INTERVAL` (9 s) plus up to `PING_FAIL_ATTEMPTS` (3) goes at
 * `PING_TIMEOUT` (10 s) each, so one bad cycle is about forty seconds of reconnecting before GramJS gives up on
 * it - longer than our own 30-second beat. A grace window shorter than that would have the watchdog rebuild a
 * session in the middle of a flap the provider was already recovering from, which is a worse outage than the one
 * it is reacting to; one longer would let a genuinely dead socket sit unrepaired for minutes.
 */
export const KEEP_ALIVE_FLAP_GRACE_MS = 60_000;
/** GramJS's keep-alive timeout: the message it writes and the file that writes it. */
const GRAMJS_THROW_SITE = /(?:^|[/\\])telegram[/\\]client[/\\]updates\.js/;
/** The fork's, which lives in its session layer and carries the elapsed seconds in the text. */
const TELEPROTO_THROW_SITE = /(?:^|[/\\])teleproto[/\\]network[/\\]session[/\\]Session\.js/;
const TELEPROTO_TIMEOUT_MESSAGE = /^(?:ping|read) timeout of \d+(?:\.\d+)?s expired$/i;

/** The message and the first frames of a thrown thing, in the shape both matchers need. */
function errorShape(error) {
  if (!error || (typeof error !== 'object' && typeof error !== 'string')) return null;
  const message = String(typeof error === 'object' ? (error.message ?? error.errorMessage ?? '') : error).trim();
  const stack = typeof error === 'object' ? String(error.stack || '') : '';
  if (!stack) return message === 'TIMEOUT' ? { message, frames: [] } : null;
  const frames = stack.split('\n');
  const header = /^Error\b/.test(frames[0] || '') ? 1 : 0;
  return { message, frames: frames.slice(header, header + 2) };
}

/**
 * Is this the library's keep-alive timeout?
 *
 * Two vocabularies, because two drivers can raise it, and each half is exported separately so a future re-swap
 * cannot quietly lose one of them: `telegram-adapter.test.js` pins the GramJS matcher's exact behaviour, and this
 * file's own test pins both.
 *
 * The first stack frame is the throw site; later frames say only who was on the call stack when it happened, and
 * for us that is the library's dispatcher roughly as often as it is the library's own code.
 */
export function isProviderKeepAliveTimeout(error) {
  return isGramjsKeepAliveTimeout(error) || isTeleprotoKeepAliveTimeout(error);
}

/** The GramJS half, unchanged in behaviour from the day it was written: `Error: TIMEOUT`, from its update loop. */
export function isGramjsKeepAliveTimeout(error) {
  const shape = errorShape(error);
  if (!shape || shape.message.toUpperCase() !== 'TIMEOUT') return false;
  const [firstFrame = '', secondFrame = ''] = shape.frames;
  // `timeout()` is called inline in `_updateLoop`, so the frame we want is one of the first two - and neither of
  // them is ever a frame of ours, which is the property the whole filter rests on.
  return GRAMJS_THROW_SITE.test(firstFrame) || (GRAMJS_THROW_SITE.test(secondFrame) && /at (timeout|attempts)\b/.test(firstFrame));
}

/**
 * The teleproto half: `Ping timeout of Ns expired` / `Read timeout of Ns expired`, raised by its session layer
 * when `link.close('lost', error)` fires.
 *
 * Only the message is recognised as strictly as GramJS's, because the fork's error travels a different number of
 * hops (it is created inside `Session.js` and surfaces through the connection), and a matcher that insisted on one
 * exact frame would stop suppressing after a refactor we do not control - which is a log-noise regression, the
 * mild failure. The stack is still required to be the library's own, because a future dependency that happens to
 * write the same sentence must not be able to make this service hide a real fault.
 */
export function isTeleprotoKeepAliveTimeout(error) {
  const shape = errorShape(error);
  if (!shape || !TELEPROTO_TIMEOUT_MESSAGE.test(shape.message)) return false;
  const frames = shape.frames.length ? shape.frames : String(error?.stack || '').split('\n').slice(1, 5);
  return frames.some((frame) => TELEPROTO_THROW_SITE.test(frame) || /[/\\]teleproto[/\\]/.test(frame));
}

/**
 * A per-client guard: recognises the keep-alive timeout, counts it, and answers the library's logging gate.
 *
 * `attach` is called on a client that has just been constructed and not yet connected, because the update loop
 * starts inside `connect()` - a guard installed afterwards would miss exactly the first flap, which is the one
 * that happens while the session is being rebuilt.
 *
 * @typedef {Object} TelegramKeepAliveGuardDeps
 * @property {Function} [log]
 * @property {Function} [now]
 * @property {any} [summaryEveryMs]
 * @property {number} [markTtlMs]
 */
export function createTelegramKeepAliveGuard(/** @type {TelegramKeepAliveGuardDeps} */ { log = () => {}, now = () => Date.now(), summaryEveryMs = KEEP_ALIVE_SUMMARY_MS, markTtlMs = KEEP_ALIVE_MARK_TTL_MS } = {}) {
  const states = new Set();
  const byClient = new WeakMap();
  // Everything the process-level handler recognises lands here: there is no client to attribute it to, but there
  // is still a fact worth counting, and a count is the difference between "we hid it" and "we hid it, N times".
  const orphan = { userId: null, count: 0, firstAt: null, lastAt: null, windowAt: 0, pending: null };
  const GUARD_FLAG = '_sdbKeepAliveGuard';

  function makeState(userId = null) {
    // `count` is everything since boot; `windowCount` is everything since the last summary was said. Only the
    // second one can express a rate, and a rate is what "starting to spike" means.
    return { userId, count: 0, windowCount: 0, firstAt: null, lastAt: null, windowAt: 0, pending: null };
  }

  function report(state, at) {
    // The first one is always said out loud and then at most one per window per client: enough that a fleet-wide
    // ping problem is visible in the first five minutes of it, quiet enough that it is never the reason a real
    // line got scrolled past - and a summary that only arrived after a full window had passed would be a summary
    // nobody reads before the deploy is rolled back.
    if (state.windowAt && at - state.windowAt < summaryEveryMs) return;
    state.windowAt = at;
    /* Who else is timing out in this same window, because that is the number that tells a bad workspace apart
       from a bad data center - and it only exists on this line, since a reader looking at 60 separate lines
       cannot see that they are the same event. The library's own cadence is the yardstick: `PING_INTERVAL` is 9
       seconds, so `windowCount` near `windowMs / 9000` means every single ping failed, and a third of it means a
       hiccup. No threshold is asserted here on purpose - that judgement belongs to whoever is on call, and an
       invented "spike" number is a lie that gets believed. */
    const windowStart = at - summaryEveryMs;
    let affectedClients = 0;
    for (const other of states) {
      if (other.lastAt !== null && other.lastAt >= windowStart) affectedClients += 1;
    }
    log('warn', 'Telegram keep-alive timeouts suppressed', {
      userId: state.userId,
      count: state.count,
      windowCount: state.windowCount,
      windowMs: summaryEveryMs,
      pingCyclesPerWindow: Math.max(1, Math.round(summaryEveryMs / 9_000)),
      affectedClients,
      guardedClients: states.size,
      suppressedTotal: stats().count,
      firstAt: state.firstAt === null ? null : new Date(state.firstAt).toISOString(),
      lastAt: new Date(state.lastAt).toISOString(),
      source: 'telegram/client/updates.js (_updateLoop ping)',
    });
    state.windowCount = 0;
  }

  function note(error, state) {
    const at = now();
    const noise = isProviderKeepAliveTimeout(error);
    /* Set *or* clear, in that order, because the library asks the gate after every error it handles: an unrelated
       failure must reset the mark rather than inherit the suppression the timeout earned. */
    state.pending = noise ? at : null;
    if (!noise) return false;
    state.count += 1;
    state.windowCount += 1;
    if (state.firstAt === null) state.firstAt = at;
    state.lastAt = at;
    report(state, at);
    // `flapFor` is how the watchdog learns about this moment - the same record, read on purpose rather than
    // pushed on the way past, so a beat that is about to tear a session down can ask whether the provider has
    // already started reconnecting it.
    return true;
  }

  function attach(client, { userId = null } = {}) {
    if (!client || typeof client !== 'object') return null;
    // Twice on one client would count every timeout twice, and a count is exactly what this file is for.
    const existing = byClient.get(client);
    if (existing) return existing;
    const state = makeState(userId === null ? null : (Number(userId) || String(userId)));
    states.add(state);
    byClient.set(client, state);
    try {
      const logger = telegramAdapter.clientLogger(client);
      if (logger && telegramAdapter.hasLoggerGate(logger) && !logger[GUARD_FLAG]) {
        const canSend = telegramAdapter.bindLoggerGate(logger);
        logger[GUARD_FLAG] = true;
        telegramAdapter.patchLoggerGate(logger, (level) => {
          const pending = state.pending;
          // Consume on read: the mark is for the error that was just offered to `_errorHandler`, one print, no more.
          if (pending !== null && level === 'error' && now() - pending <= markTtlMs) {
            state.pending = null;
            return false;
          }
          if (pending !== null) state.pending = null;
          return Boolean(canSend(level));
        });
      }
      // `onError` is the documented setter for `_errorHandler`, and the library calls it for every error it
      // catches in the update loop - the only place a timeout can be recognised before it is printed.
      telegramAdapter.setClientErrorHandler(client, (error) => { note(error, state); });
    } catch (error) {
      // A client whose internals have changed shape is a client whose noise we will simply keep printing: the
      // guard is an improvement to the logs, and losing it must not be able to lose the session.
      log('warn', 'Telegram keep-alive guard could not be attached', { userId: state.userId, error: `${error?.message || error}`.slice(0, 160) });
    }
    return state;
  }

  /** Count a recognised timeout that arrived with no client to attribute it to (the process-level path). */
  function observe(error) {
    return note(error, orphan);
  }

  /** The client's own flap record: when the provider last timed out its ping, and how many times it has since. */
  function flapFor(client) {
    const state = byClient.get(client);
    if (!state) return { at: 0, count: 0 };
    return { at: state.lastAt || 0, count: state.count };
  }

  function stats() {
    let count = orphan.count;
    let lastAt = orphan.lastAt;
    for (const state of states) {
      count += state.count;
      if (state.lastAt !== null && (lastAt === null || state.lastAt > lastAt)) lastAt = state.lastAt;
    }
    return { count, lastAt, clients: states.size };
  }

  return { attach, note, observe, flapFor, stats, isProviderKeepAliveTimeout };
}

/**
 * Decide what an unhandled rejection is, without deciding to hide it.
 *
 * Node kills the process on an unhandled rejection - correctly, for anything of ours - so this handler exists
 * only to stop the provider's ping loop from being able to do it. Anything it does not recognise is rethrown on
 * the next tick, which turns it back into the uncaught exception it would have been anyway: same crash, same
 * stack, one extra frame of honesty. A handler that logged-and-continued every rejection would be the most
 * expensive possible way to make a real bug unreproducible.
 */
export function createUnhandledRejectionGuard({ isNoise, onNoise, onOther }) {
  return (reason) => {
    if (isNoise(reason)) {
      onNoise(reason);
      return true;
    }
    onOther(reason);
    return false;
  };
}
