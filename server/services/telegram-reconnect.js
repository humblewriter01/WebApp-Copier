/**
 * What one workspace's Telegram reconnect attempt is allowed to report, and what the map is allowed to hold.
 *
 * The rebuild itself stays in `index.js`: only the server owns the client map, the database and the listener.
 * What lives here is the half that was missing. `telegramRestoreFlight` makes two simultaneous clicks into one
 * rebuild - and until now the click that was *refused* was reported exactly like the click that *finished*,
 * because both ended up returning "whichever client the map holds right now". During a rebuild that object is
 * the one the winning pass has already ended: the discard happens first, and the replacement is installed only
 * after a stored session is read, a socket is opened, `checkAuthorization` answers and the update state is
 * reconciled - seconds of network. So a second click could be shown as a success over a destroyed socket, with a
 * "reconnected by hand" audit row behind it, and the database was never part of the conversation at all.
 *
 * Two rules, both of them total:
 *   - nobody may report a reconnect it did not perform;
 *   - the map may not hold a client this process has ended.
 *
 * `strict` is deliberately a caller's decision rather than a policy: a sweep that will run again in sixty seconds
 * wants whatever the workspace has, and may log nothing; a human who pressed a button wants to be told their click
 * was refused. This module returns a status and forgets an entry; the callers decide whether that is an error.
 */

/** The rebuild ran in this pass and ended with a client this process can see live. */
export const RECONNECTED = 'reconnected';
/** Another pass holds this workspace's latch, so this pass built nothing and owns no claim. */
export const IN_FLIGHT = 'in-flight';
/** The rebuild ran and found nothing to rebuild from - no stored session. */
export const NO_SESSION = 'no-session';
/** The rebuild ran, returned a client, and that client has no live socket: the workspace is not connected. */
export const UNAVAILABLE = 'unavailable';
/** The rebuild ran and threw. The error belongs to the caller, unchanged. */
export const FAILED = 'failed';

/** The two flags a route is allowed to turn into a status code instead of a generic failure. */
export const RECONNECT_BUSY_FLAG = 'telegramReconnectInFlight';
export const RECONNECT_UNAVAILABLE_FLAG = 'telegramReconnectUnavailable';

/**
 * A reconnect refusal, which is an `Error` carrying one flag and, for the busy case, how long the holder has had
 * the key. The flags are optional properties rather than a subclass because every caller here is a `catch` that
 * reads a property and picks a status code, and a hierarchy would make the two files argue about which class a
 * wrapped Telegram failure was.
 *
 * @typedef {Error & { telegramReconnectInFlight?: boolean, telegramReconnectUnavailable?: boolean, waitedForMs?: number }} ReconnectError
 */

/**
 * `clients` is optional to the type system and required by the guard below: the map has to be the live
 * `telegramClients` itself - not a copy - because `forget` must be the same mutation the server makes, and a test
 * of a copy would prove nothing about a race. Declaring it optional is what lets a test call this with `{}` to
 * prove the refusal, which a type error would have made untestable.
 *
 * @param {{ clients?: Map<any, any>, isConnected?: (client: any) => boolean }} [deps]
 */
export function createTelegramReconnectPolicy({ clients, isConnected = () => true } = {}) {
  if (!clients || typeof clients.get !== 'function' || typeof clients.delete !== 'function') {
    throw new TypeError('createTelegramReconnectPolicy requires the client map itself, so `forget` is the real mutation');
  }
  if (typeof isConnected !== 'function') throw new TypeError('createTelegramReconnectPolicy requires an `isConnected` predicate');

  /**
   * Read one `flight.run()` result as what it actually was.
   *
   * `held` is the client the map holds for this workspace at the moment of the refusal, and it is reported as
   * part of an `in-flight` status rather than promoted to a success: a caller that is only observing may use it,
   * and a caller that is answering a human must not.
   */
  function classify(outcome, held = null) {
    if (outcome?.error) return { status: FAILED, error: outcome.error, client: null };
    if (!outcome || outcome.ran !== true) {
      return { status: IN_FLIGHT, client: held || null, waitedForMs: Number(outcome?.skippedAfterMs) || 0 };
    }
    const client = outcome.value ?? null;
    if (!client) return { status: NO_SESSION, client: null };
    // A client with no live socket is not a connected workspace, whatever object the map ends up holding. The
    // predicate here is the same one the status route and the sweep read, so "healthy" cannot mean one thing to
    // the panel and another to the answer given to an operator.
    if (!isConnected(client)) return { status: UNAVAILABLE, client };
    return { status: RECONNECTED, client };
  }

  /**
   * Take the entry a rebuild has just ended out of the map.
   *
   * Identity-guarded, because it runs while another pass may already have installed its own client: dropping
   * that one would deafen a healthy workspace to buy a cleanup. Returns whether this pass's entry was the one
   * removed, which is what the caller logs - a `false` here means somebody else won the workspace, and that is
   * worth a line, not an exception.
   */
  function forget(userId, entry) {
    if (!entry) return false;
    if (clients.get(userId) !== entry) return false;
    clients.delete(userId);
    return true;
  }

  /** The workspace's client, if the map holds one - never the client this pass is throwing away. */
  function held(userId) {
    return clients.get(userId)?.client || null;
  }

  function busyError(waitedForMs = 0) {
    /** @type {ReconnectError} */
    const busy = new Error('A Telegram reconnect for this workspace is already running.');
    busy.telegramReconnectInFlight = true;
    busy.waitedForMs = waitedForMs;
    return busy;
  }

  function unavailableError() {
    /** @type {ReconnectError} */
    const unavailable = new Error('Telegram rebuilt the session without a live socket, so nothing was reported as connected.');
    unavailable.telegramReconnectUnavailable = true;
    return unavailable;
  }

  const isBusy = (error) => error?.[RECONNECT_BUSY_FLAG] === true;
  const isUnavailable = (error) => error?.[RECONNECT_UNAVAILABLE_FLAG] === true;

  return {
    classify,
    forget,
    held,
    busyError,
    unavailableError,
    isBusy,
    isUnavailable,
    RECONNECTED,
    IN_FLIGHT,
    NO_SESSION,
    UNAVAILABLE,
    FAILED,
  };
}
