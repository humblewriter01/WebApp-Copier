/**
 * The live feed: one Socket.IO connection, so a captured signal reaches the screen when it is captured.
 *
 * Before this file existed the server emitted `signal:received` into a room nobody was listening to, and the
 * dashboard's only source of new data was a 20-second poll. That is not a delay of twenty seconds *for the
 * trader* - the order goes out on the server regardless - but it is twenty seconds during which a user cannot
 * see whether the signal they are waiting for arrived, and it is the reason a page of "recent" signals can
 * show a row from an hour ago at the top while the new one sits unrendered below the fold.
 *
 * Two rules keep this safe to add to a trading screen:
 *
 *   - **The poll never stops.** The feed is an accelerator, not a replacement. While it is open the poll drops
 *     to a slower sweep; the moment the socket is closed or fails, the poll returns to its short interval. A
 *     browser that cannot open a websocket (a proxy, an old extension, a blocked upgrade) loses nothing but
 *     the immediacy, and a `connect_error` here is deliberately not an error the user is shown.
 *   - **A pushed row is merged, not trusted.** `mergeSignalRows` keeps the list in the order the server
 *     returns it (newest first) and deduplicates by id, so a socket event and the next poll agree about what
 *     is on screen. The refresh that follows a push is what reconciles everything the event does not carry -
 *     the executed status, the trade list, the counters - and it is debounced, because a channel that posts
 *     six signals in a minute should cost one round trip, not six.
 *
 * `socket.io-client` is loaded with a dynamic import on purpose: the app must still render, and still poll,
 * if that chunk cannot be fetched.
 */

/** The event `server/index.js` emits after a captured signal's row - and its outcome - is written. */
export const SIGNAL_ROW_EVENT = 'signal:received';
/** How often the dashboard polls while the live feed is down. */
export const FALLBACK_POLL_INTERVAL_MS = 20_000;
/** How often it polls while the feed is open - a sweep for anything the events do not carry. */
export const LIVE_SWEEP_INTERVAL_MS = 60_000;
/** How long after a pushed row the reconciling refresh waits, so a burst of messages costs one request. */
export const RECONCILE_DELAY_MS = 1_500;

const loadSocket = () => import('socket.io-client');

/** Sort key for the merge: the captured-at instant, or 0 when the row does not carry a usable one. */
export function signalRowTime(row) {
  const parsed = Date.parse(String(row?.createdAt ?? ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Put one row into a newest-first list without duplicating it or re-ordering what the server already sorted.
 *
 * Both shapes have to be handled. A live capture belongs at the top; a message Telegram delivers late - the
 * ones a catch-up replays after a sleep - belongs wherever its own timestamp puts it, because pretending the
 * oldest message in the channel is the newest is how a workspace starts trading on a stale setup it can see is
 * stale. An id that is already present is replaced in place, so a row whose status moved from `queued` to
 * `executed` does not jump around the screen.
 */
export function mergeSignalRows(list, incoming, { limit } = {}) {
  const rows = Array.isArray(list) ? list : [];
  if (!incoming || typeof incoming !== 'object' || incoming.id === undefined || incoming.id === null) return rows;
  const usable = rows.filter((row) => row && typeof row === 'object');
  const others = usable.filter((row) => String(row.id) !== String(incoming.id));
  const stamp = signalRowTime(incoming);
  let at = others.findIndex((row) => signalRowTime(row) < stamp);
  if (at < 0) at = others.length;
  const merged = [...others.slice(0, at), incoming, ...others.slice(at)];
  /* The only list this shortens is one whose page size is known: a caller that says "50" gets 50. Without a
     stated limit the list is allowed to grow by the one row it gained, because a page holding three signals
     does not mean the workspace has only three signals - it means the poll has not caught up yet. */
  return Number.isInteger(limit) && limit > 0 ? merged.slice(0, limit) : merged;
}

/**
 * Open the feed.
 *
 * Returns `close()` for the caller's effect cleanup and `isOpen()` for whatever wants to know whether to poll
 * fast or slowly. `onStatus` is called with `'open'`, `'closed'` or `'error'`; nothing here throws, because a
 * live feed that cannot start is a slower page, not a broken one.
 */
export function connectSignalFeed({
  token,
  url = '',
  onSignal,
  onStatus,
  logger = null,
  importSocket = loadSocket,
  socketOptions = {},
} = {}) {
  let socket = null;
  let closed = false;
  let open = false;

  const setStatus = (state) => { try { onStatus?.(state); } catch { /* a listener that throws must not kill the feed */ } };

  const attach = (io) => {
    if (closed || typeof io !== 'function') return;
    socket = io(url || undefined, {
      // Websocket only. Socket.IO's default starts on long-polling and upgrades, and on a host that does not
      // guarantee sticky sessions the polling half can be routed to a different worker than the upgrade -
      // which looks exactly like a feed that connects and then stops delivering, the failure this whole
      // feature would have introduced. Render holds the websocket open, and if it cannot be opened here the
      // poll simply stays at its short interval.
      transports: ['websocket'],
      auth: { token },
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      ...socketOptions,
    });
    socket.on?.('connect', () => { open = true; setStatus('open'); });
    socket.on?.('disconnect', () => { open = false; setStatus('closed'); });
    socket.on?.('connect_error', (error) => {
      open = false;
      setStatus('error');
      logger?.warn?.('[feed] the live signal feed could not be opened; the dashboard will keep polling', { error: String(error?.message || error) });
    });
    socket.on?.(SIGNAL_ROW_EVENT, (row) => {
      // A row that arrives between `close()` and the transport actually letting go has nowhere to be applied:
      // the component that asked for this feed has unmounted, and writing to its state is the warning that
      // teaches nobody anything, forever.
      if (closed) return;
      if (!row || typeof row !== 'object') return;
      try { onSignal?.(row); } catch (error) {
        logger?.error?.('[feed] a pushed signal could not be applied', { error: String(error?.message || error) });
      }
    });
  };

  Promise.resolve()
    .then(importSocket)
    .then((module) => attach(module?.io ?? module?.default?.io ?? module))
    .catch((error) => {
      setStatus('error');
      logger?.warn?.('[feed] the live signal feed is unavailable in this browser; the dashboard will keep polling', { error: String(error?.message || error) });
    });

  return {
    isOpen: () => open && !closed,
    close() {
      closed = true;
      open = false;
      try { socket?.close?.(); } catch { /* already gone */ }
      socket = null;
    },
  };
}

/**
 * One pending reconciling refresh at a time.
 *
 * A channel that posts five messages in a second should cost one refresh, not five - and the refresh has to
 * happen at all, because the pushed row is the capture, not the outcome: whether the order reached the broker
 * is written a moment later by the worker.
 */
export function createReconciler(run, { delayMs = RECONCILE_DELAY_MS, setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout } = {}) {
  let timer = null;
  return {
    schedule() {
      if (timer) return false;
      timer = setTimeoutImpl(() => { timer = null; void Promise.resolve(run()).catch(() => {}); }, delayMs);
      return true;
    },
    cancel() {
      if (!timer) return;
      clearTimeoutImpl(timer);
      timer = null;
    },
  };
}
