/**
 * The Telegram capture loop, as one testable unit.
 *
 * This code used to live inside `index.js`, wrapped around module-level state, which is why every
 * previous fix to it was verified with a SQL query instead of with the thing that actually has to
 * happen: an update arriving on a GramJS client and a row appearing in `signals`. Here the only
 * outside facts are injected (`clients`, `pool`, `log`, `saveSignal`), so the whole path - event
 * dispatch, chat-id matching, channel lookup, storage - can be driven from a test with a real
 * GramJS client object and a real update, without a network.
 *
 * Three separate failures are handled here, and they are separate on purpose:
 *
 * 1. ATTACHMENT. A client that is connected but has no `NewMessage` handler receives nothing, so
 *    attachment is idempotent and verified against GramJS's own handler list rather than against a
 *    flag we set ourselves. A flag can say "attached" about a client that has since been
 *    disconnected and re-created, which is exactly how a silent drop looks from the outside.
 * 2. ID MATCHING. A channel id has two spellings (`-1002440709664` and `2440709664`) depending on
 *    which accessor produced it, and the database holds whichever one the browser sent. Every
 *    lookup goes through both spellings, on both sides.
 * 3. THE IDLE SOCKET. `MTProtoSender` in this version has no keep-alive pinger: while a channel is quiet, an
 *    MTProto connection sends *nothing at all*, and a NAT that evicts idle flows (which is what a host like
 *    Render does to a free service with no traffic) can leave the socket either half-dead or answered only by
 *    requests we initiate. Nothing in GramJS notices, because nothing in GramJS asks: `autoReconnect` reacts to
 *    an error the sender observes, and a black-holed write produces none until a request times out - and no
 *    request is ever issued. `beatUpdateStreams` is the thing that asks, every 30 seconds, on purpose: an
 *    outbound byte per session per half-minute is what keeps a flow entry alive, and its answer or absence is
 *    what decides whether to rebuild the session now rather than at the next sweep.
 * 4. THE GAP. GramJS in this version defines `catchUp()` as a stub with a `// TODO` in it, and the
 *    update loop only pings: nothing asks Telegram for the messages that arrived while the instance
 *    was disconnected. On a free Render service, which stops between visitors, that means a message
 *    published during sleep is never seen at all - the connection is healthy, the handler is
 *    attached, and the app is permanently one message behind. `runCatchUp` closes that gap by
 *    pulling recent history for each monitored channel after a session is restored, and feeding
 *    those messages through the same path a pushed update takes.
 * 5. THE UPDATE STATE. A pushed update carries the account's `pts`, and a client that never reconciles it is a
 *    client Telegram stops writing to: the connection is up, `connected` is true, every handler is attached, and
 *    nothing is ever pushed again - which is exactly what "the bot only catches messages from the sweep" looks
 *    like from outside. GramJS 2.26.22 has no reconciliation to configure: the line of its `_handleUpdate` that
 *    would advance the session's state is commented out, `catchUp()` is an empty `// TODO`, and each of its three
 *    `updates.GetState` calls discards the answer. So the state is tracked here, against the number the heartbeat
 *    already asks for, and a gap our handler has not consumed is closed with `updates.GetDifference` - the
 *    request the library never makes - before anything is torn down and rebuilt.
 */
import * as telegramAdapter from './telegram-adapter.js';
import { isTelegramServiceMessage, resolveTelegramChatId, telegramMessageText, telegramPeerIdVariants } from './telegram-peer.js';
import { KEEP_ALIVE_FLAP_GRACE_MS } from './telegram-keepalive.js';

/** How many recent messages one channel is asked for when a session comes back. */
export const CATCH_UP_LIMIT = 25;
/**
 * Never poll Telegram for history more often than this, per user.
 *
 * This used to be five minutes, and five minutes is what a trader waited for a signal their channel had posted
 * already: `connected === true` is not proof that updates are arriving (see `probeUpdateStream`), so a session
 * that went deaf mid-life was only ever rescued by a catch-up, and the cooldown decided *when*. A launch-blocking
 * delay was hiding in a throttle constant. One minute is still polite to Telegram - one `getHistory` per channel
 * per user per minute at worst, inside `CATCH_UP_BUDGET_MS` - and it bounds the damage of every recovery path.
 */
export const CATCH_UP_COOLDOWN_MS = 60_000;
/**
 * How long a connected, attached, listening session may go without one event before that is treated as a
 * problem rather than a quiet channel.
 *
 * A scalping signal is dead at two minutes (`MAX_SIGNAL_AGE_MS`), so the bound has to be well under that. It is
 * now a *reporting* threshold rather than the rescue plan - the heartbeat asks every session a question every 30
 * seconds regardless of what the last message was - and it is still what decides when an arriving update counts
 * as late, which is the number a support report is made of.
 */
export const SILENCE_SUSPECT_MS = 90_000;
/** A probe that has not answered in this long is a dead socket, because a live one answers in tens of ms. */
export const STREAM_PROBE_DEADLINE_MS = 5_000;
/**
 * How often every connected session is asked an active question, whether or not anything is happening.
 *
 * The point is not diagnostics, it is traffic: MTProto connections in this library never speak unless they have
 * something to say, and an idle flow is exactly what a hosting NAT evicts. One `updates.GetState` per session
 * per half-minute is a few dozen bytes, well inside anything Telegram calls flooding (it is per account, and the
 * request is the cheapest one the API serves), and it turns "the socket died at 03:00 and nobody noticed until
 * the next deploy" into at most thirty seconds of silence and one reconnect. The beat is also the only *proof*
 * that the stream is delivering: the answer carries the account's own `pts`, and a `pts` that moves while our
 * handler stays quiet means updates are being produced for us and not reaching the dispatcher - a dead socket
 * and a dead update loop look identical from `connected`, and these two numbers tell them apart.
 */
export const HEARTBEAT_INTERVAL_MS = 30_000;
/** Consecutive beats of "their `pts` moved, our handler saw nothing" before the session is rebuilt. */
export const PTS_STALL_BEATS = 2;
/**
 * Where the account's update state is kept: on the client that earned it.
 *
 * On the *client* and not in a map, because the state belongs to a session. A rebuilt client must start with no
 * cached `pts` at all - its first beat adopts the server's number and concludes nothing - while a map keyed by
 * user id would carry a dead session's `pts` into a live one, which is a fabricated gap, and a gap is what
 * escalates. GramJS stores no `pts` anywhere in this version, so this property is the only copy in the process.
 */
export const UPDATE_STATE_KEY = '_sdbUpdateState';
/**
 * How long one session must wait between watchdog-triggered rebuilds.
 *
 * A rebuild is not free: it tears the transport down, reconnects, re-attaches and replays history. Telegram's
 * clock, a skewed channel date or a session that legitimately has nothing to do must not be able to turn the
 * watchdog into a reconnect loop, so a second request inside this window is counted and ignored - which is also
 * why the cooldown is far longer than the beat, and the beat far longer than a request.
 */
export const STREAM_REBUILD_COOLDOWN_MS = 2 * 60_000;
/**
 * How many `updates.GetDifference` calls one reconciliation may make, and for how long.
 *
 * Telegram answers a difference request with `updates.differenceSlice` when the gap is bigger than one reply: the
 * slice carries the new state and expects to be asked again from it, until the answer is a plain
 * `updates.difference` (caught up) or a `differenceEmpty` (nothing left). A single call therefore closes a small
 * gap and only *partly* closes a big one - which after days of downtime could mean a hundred round trips, so the
 * loop is bounded twice over: `DIFFERENCE_MAX_STEPS` requests, and `DIFFERENCE_BUDGET_MS` of wall clock,
 * whichever runs out first. A loop that stops early is not a failure: the state it adopted is further along than
 * the one it started from, the next beat continues from there, and the catch-up is flagged either way, so the
 * messages are recovered by history read whether or not the difference finishes.
 */
export const DIFFERENCE_MAX_STEPS = 5;
export const DIFFERENCE_BUDGET_MS = 4_000;
/**
 * How long a `FLOOD_WAIT` backs off the *difference* requests specifically.
 *
 * Being throttled while asking "what did I miss" must not turn into being throttled forever, and it must not
 * become a reason to give up on the session either: the backoff silences the reconciliation and nothing else -
 * the beat still runs, the catch-up still reads the channels, and the stamp is cleared as soon as a difference is
 * actually answered.
 */
export const FLOOD_BACKOFF_MS = 60_000;
/**
 * Consecutive beats of an unreconciled stream, after a rebuild has already been tried, before the workspace is
 * told to sign in again.
 *
 * Three is the number, and the reason for it is the ladder: beat one adopts or asks, beat two escalates to a new
 * session, beat three is a fresh session that is *already* failing - at which point the thing that has changed
 * is not the transport but the account's view of this session, which no reconnect can repair. The strike counter
 * is reset by any beat that reconciles, so a session that recovers for one beat and relapses starts over.
 */
export const PTS_GAP_STRIKES = 3;
/** How recently a rebuild has to have been attempted for the strike ladder to be allowed to end a session. */
export const PTS_GAP_REAUTH_WINDOW_MS = 10 * 60_000;
/**
 * How often a session that passes its probe is still cross-checked against the channel.
 *
 * `pts` desync, a Telegram-side update drop, a builder that filtered something we cared about: every one of
 * those looks healthy from the inside. Asking the channel on a schedule is what turns "the bot missed it" into
 * "the bot caught it a few minutes later", and it is staggered per user so two hundred workspaces do not all
 * arrive in the same second.
 */
export const GAP_CATCH_UP_MS = 3 * 60_000;
/** Spread for that schedule, per workspace, so the sweep does not become a thundering herd. */
export const GAP_CATCH_UP_SPREAD_MS = 90_000;
/**
 * How long one catch-up run may spend before it stops and leaves the rest for the next one.
 *
 * A replay is 25 messages times however many channels a workspace monitors, each of them a database write and
 * sometimes a model request. Given no bound, a reconnect could sit in this loop for minutes - not because the
 * event loop was blocked, but because the queue of work it keeps appending to is the same queue live captures
 * are served from. The budget is what makes "catch up on what we missed" finish; a run that stops early leaves
 * the session flagged, so the next sweep resumes it, and messages already stored are never stored twice.
 */
export const CATCH_UP_BUDGET_MS = 20_000;

/** A Telegram counter as a plain number: BigInt in some builds, a `Date` for `date`, `null` when absent. */
function updateCounter(value) {
  if (value instanceof Date) return Math.floor(value.getTime() / 1000);
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * An `updates.State`, as a plain object: the four numbers that say where an account's stream stands.
 *
 * `pts` is the one that decides anything here - it moves for every update Telegram has produced for this account,
 * shown to us or not - and `qts` plus `date` are what an `updates.GetDifference` request has to be sent with.
 */
export function normalizeUpdateState(answer) {
  return {
    pts: updateCounter(answer?.pts),
    qts: updateCounter(answer?.qts),
    date: updateCounter(answer?.date),
    count: updateCounter(answer?.count) ?? 0,
  };
}

/**
 * What a thrown Telegram error actually means for the update state, because the answers are not interchangeable.
 *
 * `updates.differenceTooLong` is a *result* the library hands back, but a channel that has been unread for days
 * is answered with an RPC error instead (`CHANNEL_DIFFERENCE_TOO_LONG`, `UPDATES_TOO_OLD`), and GramJS raises
 * those as exceptions - `FloodWaitError` carries its own `seconds`, and the session-killing codes
 * (`AUTH_KEY_UNREGISTERED`, `SESSION_REVOKED`, `USER_DEACTIVATED`) mean no amount of retrying on this session
 * will ever work again. Classifying is what lets the caller back off, fall back, or stop, instead of treating
 * every throw as the same "the socket is sad" and reconnecting in a loop against a flood limit.
 */
export function classifyProviderError(error) {
  const name = String(error?.constructor?.name || '');
  const raw = `${error?.errorMessage || ''} ${error?.message || ''}`.toUpperCase();
  if (/FLOOD_WAIT|SLOW_MODE|WAIT OF \d+ SECONDS/.test(raw) || /Flood.*Wait/i.test(name)) return 'throttled';
  if (/TOO_LONG|TOO OLD|UPDATES_TOO_OLD|DIFFERENCE_TOO_LONG/.test(raw) || /TooLong/i.test(name)) return 'too-long';
  if (/AUTH_KEY_UNREGISTERED|AUTH_KEY_INVALID|SESSION_REVOKED|SESSION_TIMEOUT|USER_DEACTIVATED|UNAUTHORIZED|AUTH_KEY/.test(raw)) return 'session-revoked';
  if (/TIMEOUT|NETWORK|ECONNRESET|EPIPE|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|SOCKET/.test(raw) || error?.name === 'AbortError') return 'network';
  return 'unknown';
}

/** How long to stay quiet about difference requests, from a flood error: its own number of seconds, or the default. */
export function floodBackoffMs(error, fallback = FLOOD_BACKOFF_MS) {
  const seconds = Number(error?.seconds ?? error?.capture);
  const ms = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : fallback;
  return Math.min(Math.max(ms, 1_000), 15 * 60_000);
}

/**
 * What this session last reconciled itself to, or `null` when nothing has proved it yet.
 *
 * `nextDifferenceAt` appears only while a flood wait is running: the three numbers are the state, and a key that
 * is sometimes absent and sometimes a timestamp is easier to read in a log than one that is always `0`.
 */
export function readUpdateState(client) {
  const cached = client?.[UPDATE_STATE_KEY];
  const pts = updateCounter(cached?.pts);
  if (pts === null) return null;
  const state = { pts, qts: updateCounter(cached?.qts), date: updateCounter(cached?.date), at: cached?.at ?? null };
  const until = Number(cached?.nextDifferenceAt);
  if (Number.isFinite(until) && until > 0) state.nextDifferenceAt = until;
  return state;
}

/** One turn of the event loop, so a replay never runs two messages back to back. */
const yieldToEventLoop = () => new Promise((resolve) => setImmediate(resolve));
/** Connected, listening, and nothing through the handler for this long is worth saying out loud. */
export const STREAM_IDLE_MS = 15 * 60 * 1000;

const EMPTY_STATS = () => ({ seen: 0, saved: 0, ignored: 0, lastAt: null, lastChatId: null, lastError: null, catchUpSaved: 0, lastDelayMs: null, lastSentAt: null, lastMessageId: null });

/**
 * Whether a workspace id handed to `onSessionUnrecoverable` can address a row of `users`.
 *
 * `users.id` is a UUID, and the capture map is keyed by whatever `req.userId` was, which is that UUID as text.
 * The guard this replaces asked "is it a positive integer", so every real workspace failed it: a session that
 * could not recover was never marked for re-authentication, its client stayed in the map being beaten every
 * thirty seconds, and the panel went on reporting Telegram as connected to a stream that would never deliver
 * again. Asking only that the id be present is the whole of what a database write needs, and the legacy
 * integer ids this app also carries are still accepted so a test fixture or an old row behaves the same way.
 */
export function isValidWorkspaceId(value) {
  if (typeof value === 'number') return Number.isInteger(value) && value > 0;
  return typeof value === 'string' && value.trim().length > 0;
}

export function createTelegramListener({ clients, pool, log = console, saveSignal, now = () => Date.now(), catchUpLimit = CATCH_UP_LIMIT, catchUpCooldownMs = CATCH_UP_COOLDOWN_MS, catchUpBudgetMs = CATCH_UP_BUDGET_MS, silenceSuspectMs = SILENCE_SUSPECT_MS, probeDeadlineMs = STREAM_PROBE_DEADLINE_MS, gapCatchUpMs = GAP_CATCH_UP_MS, gapCatchUpSpreadMs = GAP_CATCH_UP_SPREAD_MS, heartbeatIntervalMs = HEARTBEAT_INTERVAL_MS, ptsStallBeats = PTS_STALL_BEATS, rebuildCooldownMs = STREAM_REBUILD_COOLDOWN_MS,
  differenceMaxSteps = DIFFERENCE_MAX_STEPS, differenceBudgetMs = DIFFERENCE_BUDGET_MS, floodWaitMs = FLOOD_BACKOFF_MS,
  ptsGapStrikes = PTS_GAP_STRIKES, gapReauthWindowMs = PTS_GAP_REAUTH_WINDOW_MS, transportFlap = null, keepAliveFlapGraceMs = KEEP_ALIVE_FLAP_GRACE_MS, onDeadStream = null, onSessionUnrecoverable = null } = {}) {
  if (!clients || !pool || !saveSignal) throw new Error('createTelegramListener requires clients, pool and saveSignal');
  const startedAt = new Date();
  const catchUpRuns = new Map();
  const catchUpInFlight = new Set();
  /* One heartbeat per session per cycle, and the memory of the last answer: `pts` is the account's own
     persistent timestamp, so the delta between two beats against the delta in `stats.seen` is the difference
     between "Telegram had nothing for us" and "Telegram sent it and our dispatcher never woke up". */
  const streamBeats = new Map();
  const rebuildCooldown = new Map();
  /* One re-auth verdict per session per window, whatever number of detectors reached it. A strike counter that
     fired every 30 seconds would tell the user to sign in again sixty times an hour, which is not a diagnosis -
     it is the outage wearing the diagnosis's clothes. */
  const unrecoverableCooldown = new Map();
  /* When this session was last handed to whoever owns reconnects, and how many times. `resetStreamBaseline` wipes
     the beat record - a new session must not inherit a dead one's counters - so the evidence that a repair was
     already attempted has to live somewhere the reset does not reach, or the strike ladder would keep
     re-justifying a teardown that has already happened. */
  const rebuildAttempts = new Map();
  const heartbeat = { cycles: 0, sent: 0, answered: 0, dead: 0, stalled: 0, rebuilt: 0, probing: 0, suppressed: 0, resynced: 0, recovered: 0, deaf: 0, gaps: 0, partial: 0, throttled: 0, unrecoverable: 0, flapping: 0, lastCycleAt: null, lastCycleMs: null, lastCycleSessions: 0 };
  let emptyCycleReported = false;
  let resumedAfterBoot = 0;

  /** A deterministic per-session offset inside `spread`, so a fleet is not asked in the same second. */
  function staggerFor(key, spread) {
    return [...String(key)].reduce((total, char) => (total * 31 + char.charCodeAt(0)) % spread, 0);
  }

  const entryFor = (userId) => clients.get(String(userId)) || clients.get(userId);

  function statsFor(userId) {
    const entry = entryFor(userId);
    if (!entry) return null;
    if (!entry.stats) entry.stats = EMPTY_STATS();
    return entry.stats;
  }

  /**
   * Is the handler in GramJS's own list, or only in our bookkeeping?
   *
   * `listEventHandlers()` reads `_eventBuilders`, which is the array the dispatcher iterates for
   * every update, so it is the only authoritative answer. A client that was disconnected and
   * re-created (or whose handlers were removed by a reconnect path) keeps our `entry.handler`
   * pointing at a callback nothing will ever call.
   */
  function handlerIsLive(client, handler) {
    if (!client || !handler) return false;
    if (!telegramAdapter.canListEventHandlers(client)) return true;
    let builders = [];
    try { builders = telegramAdapter.listEventHandlers(client) || []; } catch { return true; }
    return telegramAdapter.isHandlerAttached(builders, handler);
  }

  /**
   * Ask the socket whether it is still answering, rather than trusting a boolean.
   *
   * `client.connected` is GramJS's own flag about a TCP socket, and a socket can be open, registered and
   * entirely deaf: Telegram stops pushing after a `pts` gap it cannot close, an idle connection is severed by
   * the host's NAT and quietly re-established on the other side, a reconnect leaves the update manager detached
   * from the event builders. All of those keep `connected === true` and every handler in place, and all of them
   * look like a channel that has nothing to say. `updates.GetState` is the cheapest request Telegram answers -
   * it returns the current `pts`, which is also the number that tells us whether the stream moved - and a
   * socket that cannot answer it inside a few seconds is not a stream.
   *
   * A probe this code cannot build (a library change, an unexpected export) answers `unknown`, and `unknown`
   * never tears a session down: it is worse to drop a working listener than to keep one that needs a minute to
   * be caught by the gap sweep anyway.
   */
  async function probeUpdateStream(client, { deadlineMs = probeDeadlineMs } = {}) {
    if (!client || !telegramAdapter.isConnected(client)) return { alive: false, state: 'no-socket' };
    if (!telegramAdapter.canInvoke(client)) return { alive: true, state: 'unknown' };
    let request = null;
    try {
      request = await telegramAdapter.createStateRequest();
    } catch {
      return { alive: true, state: 'unknown' };
    }
    if (!request) return { alive: true, state: 'unknown' };
    const startedAt = now();
    let timer = null;
    try {
      const state = await Promise.race([
        Promise.resolve().then(() => telegramAdapter.invoke(client, request)),
        new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error('probe-timeout')), deadlineMs); timer.unref?.(); }),
      ]);
      /* The answer is the account's own state, and this is the one request the beat already makes, so the whole
         object travels back rather than only `pts`: the state is reconciled from the number we asked for, and a
         second `GetState` to find out what the first one said would be a request for nothing. */
      return {
        alive: true,
        state: 'alive',
        pts: Number(state?.pts ?? 0) || null,
        updateState: normalizeUpdateState(state),
        ms: Math.max(0, now() - startedAt),
      };
    } catch (error) {
      return { alive: false, state: 'dead', error: `${error?.message || error}`.slice(0, 160), ms: Math.max(0, now() - startedAt) };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Make this session's update state agree with Telegram's, and report what the gap turned out to be.
   *
   * This is the reconciliation the library does not do. `updates.GetState` answers with where the account
   * actually stands; `updates.GetDifference`, sent with *our* last `pts`/`qts`/`date`, is what tells Telegram we
   * have caught up - and until somebody sends it, a session that missed updates is a session the server has no
   * reason to keep writing to. GramJS never sends it, so the silence is permanent, the socket stays open, and the
   * only messages that ever arrive are the ones the gap sweep pulls out of history by hand.
   *
   * What it deliberately does *not* do is replay the messages the difference returned into the event handler. A
   * synthesized push would look, in `signals`, exactly like the thing the operator is trying to prove happened
   * (`replayed: false`), and the app already has a deduped, budgeted path for recovering missed content: the
   * catch-up. So a difference that found messages flags the session for one, and the log says how many it found.
   *
   * The action is the whole contract, and every one of them is safe to ignore:
   * `'unavailable'` (no library export, no socket), `'state-adopted'` (first sight: nothing to compare with),
   * `'in-sync'` (nothing happened, or it happened and we were shown it), `'difference-applied'`,
   * `'difference-empty'` (the server insists we are current, which with a busy channel is the deaf-stream
   * confession), `'too-long'` (the gap is beyond repair - only a new session fixes it), `'failed'`.
   */
  async function resyncUpdateState(client, { userId = null, reason = 'resync', state = null, seenAdvanced = false, force = false, deadlineMs = probeDeadlineMs, maxSteps = differenceMaxSteps, budgetMs = differenceBudgetMs } = {}) {
    const outcome = { action: 'unavailable', serverPts: null, statePts: null, gap: 0, messages: 0, otherUpdates: 0, steps: 0, partial: false, backoffMs: 0, error: null, ms: null };
    if (!client || !telegramAdapter.isConnected(client) || !telegramAdapter.canInvoke(client)) return outcome;
    const startedAt = now();
    let reconcilable = false;
    try {
      reconcilable = await telegramAdapter.canReconcileUpdates();
    } catch {
      return outcome;
    }
    if (!reconcilable) return outcome;

    const invoke = async (request) => {
      let timer = null;
      try {
        return await Promise.race([
          Promise.resolve().then(() => telegramAdapter.invoke(client, request)),
          new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error('state-sync-timeout')), deadlineMs); timer.unref?.(); }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    };

    try {
      /* Identity first, and its failure is not fatal. `getMe(true)` is the form that matters: GramJS's `getMe()`
         always re-issues `users.GetUsers`, while the `true` form returns the cached self peer when there is one -
         so a healthy session pays nothing here and the first beat after a rebuild pays one request. That first
         request is worth having on purpose: the dispatcher consults `_selfInputPeer` while it decides whether a
         pushed message counts as incoming for *every* event builder, and an exception in that path is swallowed by
         the library. */
      if (telegramAdapter.canGetSelf(client)) {
        try { await telegramAdapter.getSelf(client); } catch (error) { outcome.error = `identity: ${`${error?.message || error}`.slice(0, 80)}`; }
      }
      const provided = state && (state.updateState || state.pts !== undefined) ? (state.updateState || state) : null;
      const server = normalizeUpdateState(provided || await invoke(await telegramAdapter.createStateRequest()));
      outcome.serverPts = server.pts;
      const cached = readUpdateState(client);
      outcome.statePts = cached?.pts ?? null;

      /* The first sight of a session has nothing to reconcile against. Adopt what the account says and conclude
         nothing - asking for a difference from `pts = 0` asks Telegram to replay the account's whole history,
         which is the one request guaranteed to come back `updates.differenceTooLong`. */
      if (!cached || !Number.isFinite(cached.pts) || !Number.isFinite(server.pts)) {
        try { client[UPDATE_STATE_KEY] = { ...server, at: now() }; } catch { /* a frozen test double */ }
        outcome.action = 'state-adopted';
        outcome.gap = 0;
        log('info', 'Telegram update state adopted', { userId, pts: server.pts, reason });
        return outcome;
      }

      /* A flood answer silences *this* reconciliation for the number of seconds Telegram asked for, and nothing
         else: the beat goes on beating, the catch-up goes on reading history, and `force` (a human, or a
         session that is being rebuilt anyway) still gets to ask. Silencing the retry is the difference between
         backing off and a fleet of sessions hammering the same throttle every 30 seconds forever. */
      const until = Number(cached.nextDifferenceAt || 0);
      if (until > now()) {
        outcome.action = 'throttled';
        outcome.backoffMs = until - now();
        return outcome;
      }

      const gap = server.pts - cached.pts;
      outcome.gap = gap > 0 ? gap : 0;
      /* Nothing to close: either the account moved and we were shown every update (the ordinary case, and the
         reason a healthy session must not pay for a difference request every 30 seconds), or it did not move at
         all. `force` bypasses both halves of that test, because the deaf stream presents as *no gap at all* - the
         account reports no pending updates while the channel demonstrably has new ones, and the only way to
         distinguish "you are current" from "I have stopped telling you" is to ask for the difference anyway and
         read which shape comes back. */
      if (!force && (outcome.gap <= 0 || seenAdvanced)) {
        try { client[UPDATE_STATE_KEY] = { ...server, at: now() }; } catch { /* as above */ }
        outcome.action = 'in-sync';
        return outcome;
      }

      /* ------------------------------------------------------------------ the difference loop
         A slice means "there is more, ask again from here", so this is a loop and not a call: each answer moves
         the state we send next, and it ends on a plain `updates.difference` (caught up), a `differenceEmpty`
         (nothing left), a refusal, or the step/time budget. `adopted` is written on every iteration, so a loop
         that runs out of budget still leaves the session further along than it was - and never back at the pts
         that produced the gap, which would ask the same question again on the next beat forever. */
      const keep = (value, fallback) => (Number.isFinite(value) ? value : fallback);
      const writeState = (state_, extra = {}) => {
        try { client[UPDATE_STATE_KEY] = { ...state_, at: now(), ...extra }; } catch { /* a frozen test double */ }
      };
      let adopted = { pts: cached.pts, qts: keep(cached.qts, 0), date: keep(cached.date, Math.floor(startedAt / 1000)), count: keep(cached.count, 0) };
      let lastClass = '';
      let action = 'difference-empty';
      let throttled = false;
      while (outcome.steps < maxSteps && now() - startedAt < budgetMs) {
        outcome.steps += 1;
        let difference = null;
        try {
          difference = await invoke(await telegramAdapter.createDifferenceRequest({ pts: adopted.pts, qts: adopted.qts, date: adopted.date }));
        } catch (error) {
          /* The refusals that matter, told apart, because each one wants a different thing from us: a flood wait
             is a pause, `CHANNEL_DIFFERENCE_TOO_LONG`/`UPDATES_TOO_OLD` is "the gap is beyond the difference API"
             and wants the history read instead, and a revoked auth key is the end of this session no matter how
             many times we rebuild it. Anything else is reported and left alone - a reconciliation that cannot be
             completed is never a reason to tear down a socket that is answering. */
          const kind = classifyProviderError(error);
          const text = `${error?.errorMessage || ''} ${error?.message || error}`.slice(0, 160);
          if (kind === 'throttled') {
            const backoff = floodBackoffMs(error, floodWaitMs);
            writeState(adopted, { nextDifferenceAt: now() + backoff });
            throttled = true;
            action = 'throttled';
            outcome.backoffMs = backoff;
            outcome.error = text;
            break;
          }
          if (kind === 'too-long') { action = 'too-long'; adopted = { ...server }; }
          else if (kind === 'session-revoked') action = 'session-revoked';
          else action = 'failed';
          outcome.error = text;
          break;
        }
        lastClass = String(difference?.className || difference?.constructor?.name || '');
        const reported = normalizeUpdateState(difference?.state || difference);
        outcome.messages += Array.isArray(difference?.newMessages) ? difference.newMessages.length : 0;
        outcome.otherUpdates += Array.isArray(difference?.otherUpdates) ? difference.otherUpdates.length : 0;
        /* `updates.difference` and `differenceSlice` carry a `state`; `differenceEmpty` puts the numbers on the
           object itself; a refusal says nothing at all, which is why the fallback is the GetState answer rather
           than the value we arrived with - a cached pts that survives a repair is a gap reopened on the next
           beat, and an open gap is what triggers a rebuild. */
        if (Number.isFinite(reported.pts)) {
          adopted = {
            pts: reported.pts,
            qts: keep(reported.qts, keep(server.qts, adopted.qts)),
            date: keep(reported.date, keep(server.date, adopted.date)),
            count: keep(reported.count, keep(server.count, adopted.count)),
          };
        }
        if (/toolong/i.test(lastClass)) { action = 'too-long'; adopted = { ...server }; break; }
        if (/empty/i.test(lastClass)) { action = outcome.messages || outcome.otherUpdates ? 'difference-applied' : 'difference-empty'; break; }
        if (!/slic/i.test(lastClass)) { action = outcome.messages || outcome.otherUpdates ? 'difference-applied' : 'in-sync'; break; }
        /* Still slicing: keep going while the account genuinely owes us updates, and stop the moment it does not,
           so a session that has caught up mid-loop does not send one more request to be told so. */
        if (Number.isFinite(server.pts) && adopted.pts >= server.pts) { action = 'difference-applied'; break; }
      }
      if (outcome.steps >= maxSteps && /slic/i.test(lastClass)) {
        // Out of budget with the server still mid-answer: further along, not finished, and the next beat resumes
        // from the adopted pts. Flagged so the log and the panel say "partial" rather than "repaired".
        outcome.partial = true;
        action = 'difference-partial';
      }
      /* The stamp is cleared by any difference that was actually answered - including one refused as too long - and
         kept only by the beat that set it, or the backoff would last exactly as long as it takes to write it. */
      if (!throttled) writeState(adopted, { nextDifferenceAt: 0 });

      /* One rule for every answer that cost us a request: the channels are read back. Whether the difference
         returned messages, refused to compute, was throttled, or swore nothing was missing while the sweep keeps
         finding things, the recovery is the same history read - deduped against `signals`, budgeted, and labelled
         `replayed: true`. This is also the safety net for a permanently deaf session: the push stream may never
         recover, and the workspace still gets its messages on the next sweep. */
      if (outcome.steps > 0) {
        const entry = entryFor(userId);
        if (entry) entry.needsCatchUp = true;
      }
      if (action !== 'in-sync' || outcome.messages || outcome.otherUpdates) {
        log(action === 'too-long' || action === 'session-revoked' ? 'warn' : 'info', 'Telegram update state reconciled', {
          userId, action, from: cached.pts, to: adopted.pts, gap: outcome.gap, steps: outcome.steps,
          messages: outcome.messages, otherUpdates: outcome.otherUpdates, partial: outcome.partial,
          backoffMs: outcome.backoffMs || null, providerClass: lastClass || null, error: outcome.error, reason,
        });
      }
      outcome.action = action;
      outcome.statePts = adopted.pts;
      return outcome;
    } catch (error) {
      outcome.action = 'failed';
      outcome.error = `${error?.message || error}`.slice(0, 160);
      // A failed reconciliation is a reportable fact and never a fault in the caller: the beat has already
      // proved the socket answers, and the stream decision stands on the pts comparison either way.
      log('warn', 'Telegram update state could not be reconciled', { userId, reason, error: outcome.error });
      return outcome;
    } finally {
      outcome.ms = Math.max(0, now() - startedAt);
    }
  }

  /**
   * Ask one session for permission to be rebuilt, and only ask if it has been quiet about it lately.
   *
   * Every watchdog in this file ends up here, whichever proof it found - a socket that will not answer, a `pts`
   * that moved while our handler stayed quiet, a replay that turned up a message posted while we were listening.
   * The cooldown is the only thing between "the stream is broken" and "reconnect forever", and it is deliberately
   * a property of the *rebuild* rather than of each detector, so three detectors agreeing still means one
   * rebuild per window.
   *
   * Two escalation levels, because "do it now" and "do it properly" are different asks:
   *
   * - `force: true` steps around the window as well as the shortcut, and is only ever passed by a human being on
   *   the other side of an admin route - or by proof from Telegram itself (`update-state-too-far-behind`), which
   *   is the one case where waiting two minutes is strictly worse than a duplicate reconnect. The throttle exists
   *   to protect Telegram from a watchdog that misread a quiet channel; it has no argument with an operator who
   *   is looking at the evidence, or with a server that has said in as many words that this session's state can
   *   no longer be reconciled.
   * - `escalate: true` keeps the window and drops the *shortcut*: rebuild the session even though the socket
   *   looks fine and the handler is attached. That is what a deaf stream needs, and it is the reason the flag
   *   exists - a reconnect of a client that is already connected is otherwise a no-op dressed as a fix.
   */
  function requestStreamRebuild(userId, reason, { force = false, escalate = false } = {}) {
    const key = String(userId);
    const last = rebuildCooldown.get(key) || 0;
    if (!force && now() - last < rebuildCooldownMs) {
      heartbeat.suppressed += 1;
      log('info', 'Telegram stream rebuild already cooling down', { userId, reason, sinceMs: Math.round(now() - last) });
      return false;
    }
    rebuildCooldown.set(key, now());
    if (typeof onDeadStream !== 'function') {
      log('warn', 'Telegram update stream needs a rebuild but no restorer is wired', { userId, reason });
      return false;
    }
    const prior = rebuildAttempts.get(key);
    // Counted here rather than in the restorer's success path, because "we replaced the session" is the fact the
    // strike ladder needs: whether that replacement then worked is the next three beats' business.
    rebuildAttempts.set(key, { at: now(), count: (Number(prior?.count) || 0) + 1 });
    heartbeat.rebuilt += 1;
    log('warn', 'Telegram update stream rebuild forced', { userId, reason, cooldownMs: rebuildCooldownMs, forced: force === true, escalated: escalate === true });
    // Deliberately not awaited by the caller: a reconnect is a minutes-long affair (handshake, resume, replay)
    // and a watchdog that blocks on it stops watching everything else. `restoreTelegramClient` re-attaches and
    // flags its own catch-up, which is the whole recovery; failures are logged rather than thrown so a dead
    // session cannot become an unhandled rejection inside the interval.
    Promise.resolve().then(() => onDeadStream(userId, reason, { force: force === true, escalate: escalate === true })).catch((error) => {
      log('warn', 'Telegram update stream rebuild failed', { userId, reason, error: `${error?.message || error}`.slice(0, 200) });
    });
    return true;
  }

  /**
   * Say out loud that no reconnect is going to fix this, and let whoever owns the user's session decide what the
   * user is told.
   *
   * The listener deliberately does not touch `users` itself: the row is the server's, and the honest split is
   * "we hold the evidence, they decide the consequence". What this guarantees is that the evidence arrives once
   * per window rather than once per beat, and that the decision is recorded on the session so a status route can
   * answer "why does my bot say it needs signing in" without reading logs.
   */
  /** Has a rebuild been asked for this session recently enough to count as "we already tried the strong fix"? */
  function rebuildAttemptsFor(userId, withinMs = gapReauthWindowMs) {
    const attempt = rebuildAttempts.get(String(userId));
    return Boolean(attempt) && attempt.count > 0 && now() - attempt.at <= withinMs;
  }

  function declareSessionUnrecoverable(userId, reason, details = {}) {
    const key = String(userId);
    const last = unrecoverableCooldown.get(key) || 0;
    if (now() - last < rebuildCooldownMs) return false;
    unrecoverableCooldown.set(key, now());
    heartbeat.unrecoverable += 1;
    const entry = entryFor(userId);
    if (entry) entry.reauthRequired = true;
    if (typeof onSessionUnrecoverable !== 'function') {
      log('warn', 'Telegram session needs a fresh sign-in but no re-auth handler is wired', { userId, reason, ...details });
      return false;
    }
    log('warn', 'Telegram session marked for re-authentication', { userId, reason, cooldownMs: rebuildCooldownMs, ...details });
    Promise.resolve().then(() => onSessionUnrecoverable(userId, reason, details)).catch((error) => {
      log('warn', 'Telegram re-auth marking failed', { userId, reason, error: `${error?.message || error}`.slice(0, 200) });
    });
    return true;
  }

  /**
   * One heartbeat cycle: an active request to every connected session, and the decisions its answer allows.
   *
   * Three outcomes, all of them cheap. The socket does not answer -> it is not a stream, rebuild now. It answers
   * and its `pts` moved while our handler saw nothing, twice in a row -> the transport works and the update loop
   * does not, rebuild now. It answers and `pts` is where it was -> the account genuinely has nothing new, and
   * the only correct action is to leave the session alone. A quiet channel is not a fault, and a watchdog that
   * reconnects quiet channels is a self-inflicted outage; this is the line the whole function walks.
   */
  async function beatUpdateStreams({ reason = 'heartbeat' } = {}) {
    const targets = [];
    for (const [userId, entry] of clients.entries?.() || []) {
      if (!entry?.client || !telegramAdapter.isConnected(entry.client)) continue;
      targets.push([userId, entry]);
    }
    const cycleStartedAt = now();
    const results = { reason, sessions: targets.length, sent: 0, answered: 0, dead: 0, flapping: 0, stalled: 0, quiet: 0, unknown: 0, resynced: 0, recovered: 0, deaf: 0, partial: 0, throttled: 0, unrecoverable: 0, worstMs: 0 };
    if (!targets.length) {
      heartbeat.cycles += 1;
      heartbeat.lastCycleAt = new Date(cycleStartedAt).toISOString();
      if (!emptyCycleReported) {
        emptyCycleReported = true;
        log('info', 'Telegram heartbeat has no connected sessions to beat', { reason, intervalMs: heartbeatIntervalMs });
      }
      return { ...results, beats: 0 };
    }
    emptyCycleReported = false;

    const beatOne = async ([userId, entry]) => {
      const key = String(userId);
      const previous = streamBeats.get(key);
      const stats = entry.stats || EMPTY_STATS();
      const seenBefore = Number(stats.seen) || 0;
      results.sent += 1;
      const probe = await probeUpdateStream(entry.client, { deadlineMs: probeDeadlineMs });
      if (probe.state === 'unknown') {
        // A library change that removed `updates.GetState` must not become one log line per session per beat.
        results.unknown += 1;
        heartbeat.probing += 1;
        log('debug', 'Telegram heartbeat could not be answered by this build of the library', { userId });
        return;
      }
      if (!probe.alive) {
        results.dead += 1;
        heartbeat.dead += 1;
        /* One exception to "a beat that cannot be answered is rebuilt now", and it needs saying precisely,
           because it is the difference between a watchdog and an echo: GramJS runs its own keep-alive ping every
           9 seconds with a 10-second race and three attempts, and while that loop is failing it calls
           `_sender.reconnect()` - so for up to about forty seconds the socket is being re-established under us
           and any request we send inside the gap can legitimately go unanswered. Rebuilding in the middle of
           that tears down a session the provider was about to hand back, and it is exactly what a fleet of
           sessions does at once when one data center hiccups. So the first unanswered beat *while the provider
           reports a keep-alive timeout* is recorded and waited out; the next one is a dead socket by our own
           measurement, and gets the same immediate rebuild it always got. */
        const flap = typeof transportFlap === 'function' ? transportFlap(entry.client) : null;
        const flapAge = Number.isFinite(flap?.at) && flap.at > 0 ? now() - flap.at : null;
        const flapping = probe.state === 'dead' && flapAge !== null && flapAge >= 0 && flapAge < keepAliveFlapGraceMs;
        if (flapping && !previous?.deadBeat) {
          results.flapping += 1;
          heartbeat.flapping += 1;
          streamBeats.set(key, {
            ...(previous || {}), at: now(), error: probe.error || 'probe-timeout', stalls: 0,
            deadBeat: 1, flapping: true, keepAliveTimeouts: Number(flap.count) || 0,
          });
          log('warn', 'Telegram beat waits out a provider keep-alive timeout', {
            userId, error: probe.error || 'probe-timeout', flapAgeMs: Math.round(flapAge), keepAliveTimeouts: Number(flap.count) || 0, graceMs: keepAliveFlapGraceMs,
          });
          return;
        }
        streamBeats.set(key, {
          ...(previous || {}), at: now(), error: probe.error || 'probe-timeout', stalls: 0, deadBeat: 1,
          flapping: false, keepAliveTimeouts: Number(flap?.count) || 0,
        });
        requestStreamRebuild(userId, 'heartbeat-no-answer');
        return;
      }
      results.answered += 1;
      results.worstMs = Math.max(results.worstMs, Number(probe.ms) || 0);
      const pts = Number(probe.pts) || 0;
      const seenNow = Number(stats.seen) || 0;
      const replayNow = Number(stats.catchUpSaved) || 0;
      const ptsAdvanced = Number.isFinite(previous?.pts) && pts > previous.pts;
      const ptsStatic = Number.isFinite(previous?.pts) && pts === previous.pts;
      const seenAtLastBeat = Number.isFinite(previous?.seen) ? previous.seen : 0;
      const handlerKeptUp = seenNow > seenAtLastBeat;
      /* The other half of the diagnosis, and the half the account cannot argue with: the sweep pulled a message
         out of a channel that this session is supposedly subscribed to. A `pts` that did not move across the
         same interval says Telegram does not believe it owes us anything, so the messages exist in the channel
         and not in the stream - which is not a quiet channel, not a slow socket, and not something a reconnect
         of the same session can fix. */
      const replayFound = Number.isFinite(previous?.catchUpSaved) && replayNow > previous.catchUpSaved;
      const stateBefore = readUpdateState(entry.client);
      const gapBefore = Number.isFinite(stateBefore?.pts) ? pts - stateBefore.pts : null;
      /* One line per session per beat, with every number the decision below is made of. `pts` is what the
         account is at, `statePts` what this session has reconciled to, `gap` the difference between them:
         a moving `pts` with a still `statePts` is a stream that is not being consumed, and a `gap` the handler
         has covered every beat is a session doing its job. This is the line to read before rebuilding anything. */
      log('debug', 'Telegram heartbeat beat', {
        userId,
        pts,
        statePts: stateBefore?.pts ?? null,
        ptsDelta: Number.isFinite(previous?.pts) ? pts - previous.pts : null,
        gap: Number.isFinite(gapBefore) && gapBefore > 0 ? gapBefore : 0,
        seen: seenNow,
        catchUpSaved: replayNow,
        replayFound,
        ms: Number(probe.ms) || 0,
        sinceLastBeatMs: Number.isFinite(previous?.at) ? Math.max(0, now() - previous.at) : null,
        listeningMs: entry.attachedAt ? Math.max(0, now() - Date.parse(entry.attachedAt)) : null,
      });
      /* A rebuild replaces the session's whole `stats` object, so `seen` going *backwards* is not a stalled
         handler - it is a fresh one, and comparing it against a baseline from the previous lifetime would accuse
         the new session of the old one's silence. The beat learns the new baseline and says nothing. */
      const restarted = Number.isFinite(previous?.seen) && seenNow < seenAtLastBeat;
      /* Reconcile before concluding anything. A gap the handler has already covered is adopted in one write and
         costs nothing; a gap it has not covered is closed with `updates.GetDifference` - which is the repair, and
         is tried before a teardown because a session that only needed to tell the server it had caught up should
         not have to reconnect to say so. The beat's own GetState answer is handed over, so the healthy case asks
         Telegram nothing at all. */
      const sync = await resyncUpdateState(entry.client, {
        userId,
        reason: 'heartbeat',
        state: probe,
        seenAdvanced: handlerKeptUp,
        force: ptsStatic && replayFound,
      });
      if (sync.action !== 'in-sync' && sync.action !== 'state-adopted') {
        results.resynced += 1;
        heartbeat.resynced += 1;
      }
      if (sync.gap) {
        heartbeat.gaps += Number(sync.gap) || 0;
      }
      if (sync.messages) {
        results.recovered += Number(sync.messages) || 0;
        heartbeat.recovered += Number(sync.messages) || 0;
      }

      let stalls = Number(previous?.stalls) || 0;
      let deaf = Number(previous?.deaf) || 0;
      let strikes = Number(previous?.strikes) || 0;
      /* Whether this stream is still behind, judged from numbers that cannot argue with each other: what the
         account says it owes us, what this session has been shown, and what the gap sweep had to go and fetch by
         hand. `difference-partial` counts as well - a slice loop that ran out of budget is a gap left open,
         however the beat's own delta looked. */
      const openGap = Number.isFinite(gapBefore) && gapBefore > 0;
      const unresolved = !restarted
        && ((ptsAdvanced && !handlerKeptUp) || (ptsStatic && replayFound) || (openGap && !handlerKeptUp) || sync.action === 'difference-partial');
      const rebuild = (reason, opts = {}) => requestStreamRebuild(userId, reason, opts);
      if (sync.action === 'throttled') {
        // Telegram asked for a pause. The session is not sick, it is on a clock: nothing escalates, nothing is
        // forgiven either, and the stamp inside the client cache is the thing that does the waiting.
        results.throttled += 1;
        heartbeat.throttled += 1;
        strikes = Number(previous?.strikes) || 0;
      } else if (sync.action === 'session-revoked') {
        /* The auth key is gone, which is the one answer no rebuild can serve - reconnecting against
           `AUTH_KEY_UNREGISTERED` is how a watchdog becomes the outage it is watching for. So it goes straight to
           the verdict, with no strike count in front of it. */
        results.unrecoverable += 1;
        declareSessionUnrecoverable(userId, 'telegram-session-revoked', { pts, gap: Number(sync.gap) || 0, error: sync.error });
        strikes = 0;
      } else if (sync.action === 'too-long') {
        /* Telegram has said in as many words that this session's `pts` is too far behind to be caught up by a
           difference - either as an answer (`updates.differenceTooLong`) or as a refusal
           (`CHANNEL_DIFFERENCE_TOO_LONG`, `UPDATES_TOO_OLD`), which is why both arrive here. It will go on saying
           it until the session is new, so this is the one reply that buys an exception to the rebuild cooldown, and
           the fresh client adopts a current state on its next beat so it cannot loop. */
        rebuild('update-state-too-far-behind', { force: true });
        strikes = 0;
        stalls = 0;
        deaf = 0;
      } else if (unresolved) {
        strikes += 1;
        if (sync.action === 'difference-partial') { results.partial += 1; heartbeat.partial += 1; }
        if (ptsStatic && replayFound) {
          deaf += 1;
          results.deaf += 1;
          heartbeat.deaf += 1;
          if (deaf >= ptsStallBeats) {
            /* Two beats of "the channel wrote, the account owes us nothing, and we had to go and read it
               ourselves". The difference has already been asked for by then (`force` in the resync), so the only
               thing left is a session with no history: escalate, and keep the cooldown that stops a skewed clock
               from turning this into a reconnect loop. */
            rebuild('deaf-stream-pts-static', { escalate: true });
            deaf = 0;
          }
        } else if (ptsAdvanced && !handlerKeptUp) {
          stalls += 1;
          if (stalls >= ptsStallBeats) {
            results.stalled += 1;
            heartbeat.stalled += 1;
            rebuild('update-stream-stalled');
            stalls = 0;
          }
        }
        if (strikes >= ptsGapStrikes && rebuildAttemptsFor(userId)) {
          /* The escalation has just been tried, and the gap is being measured for the third beat running - about
             90 seconds of "a brand-new session is behind in exactly the same way". What changed is not the
             transport, so this stops being a fault the app can repair and becomes a sign-in, which is the only
             action that mints an auth key. Judged after the escalation on purpose: no session is condemned without
             having first been replaced. */
          results.unrecoverable += 1;
          declareSessionUnrecoverable(userId, 'pts-gap-unresolved', { pts, gap: Number(sync.gap) || (openGap ? gapBefore : 0), strikes, action: sync.action });
          strikes = 0;
          deaf = 0;
          stalls = 0;
        }
      } else {
        if (ptsAdvanced) results.quiet += 1;
        strikes = 0;
        stalls = 0;
        deaf = 0;
      }
      streamBeats.set(key, {
        at: now(),
        pts,
        seen: seenNow,
        catchUpSaved: replayNow,
        ms: Number(probe.ms) || 0,
        stalls,
        deaf,
        strikes,
        rebuilds: Number(rebuildAttempts.get(key)?.count) || 0,
        statePts: Number.isFinite(sync.serverPts) ? sync.serverPts : pts,
        gap: Number(sync.gap) || 0,
        steps: Number(sync.steps) || 0,
        partial: sync.partial === true,
        throttledFor: Number(sync.backoffMs) || 0,
        action: sync.action,
        error: sync.error || null,
      });
    };

    // Chunked rather than fired-all-at-once: one session's slow reconnect must not be the reason 200 requests
    // are opened against the same process tick, and `Promise.allSettled` per chunk keeps one timeout from
    // rejecting the cycle.
    const chunkSize = 8;
    for (let index = 0; index < targets.length; index += chunkSize) {
      await Promise.allSettled(targets.slice(index, index + chunkSize).map(beatOne));
    }

    heartbeat.cycles += 1;
    heartbeat.sent += results.sent;
    heartbeat.answered += results.answered;
    heartbeat.lastCycleAt = new Date(now()).toISOString();
    heartbeat.lastCycleMs = results.worstMs;
    heartbeat.lastCycleSessions = results.sessions;
    /* The line the operator greps to prove the watchdog is alive: once per cycle, with every count that decides
       anything in it, so "it is beating but the streams are dead" is one line rather than a correlation. */
    log(results.dead || results.stalled || results.deaf || results.unrecoverable ? 'warn' : 'info', 'Telegram heartbeat sent', {
      ...results,
      intervalMs: heartbeatIntervalMs,
      slowestMs: results.worstMs,
      sinceBootMs: Math.max(0, now() - startedAt.getTime()),
    });
    return { ...results, beats: heartbeat.cycles };
  }

  /** The heartbeat's own counters, for the health panel and for the `/health` payload. */
  function heartbeatSummary() {
    const beats = [...streamBeats.entries()].map(([userId, beat]) => ({
      userId: String(userId),
      at: beat.at ? new Date(beat.at).toISOString() : null,
      pts: Number.isFinite(beat.pts) ? beat.pts : null,
      statePts: Number.isFinite(beat.statePts) ? beat.statePts : null,
      gap: Number(beat.gap) || 0,
      action: beat.action || null,
      deaf: Number(beat.deaf) || 0,
      strikes: Number(beat.strikes) || 0,
      rebuilds: Number(beat.rebuilds) || 0,
      steps: Number(beat.steps) || 0,
      partial: beat.partial === true,
      throttledFor: Number(beat.throttledFor) || 0,
      keepAliveTimeouts: Number(beat.keepAliveTimeouts) || 0,
      flapping: beat.flapping === true,
      ms: Number.isFinite(beat.ms) ? beat.ms : null,
      stalls: Number(beat.stalls) || 0,
      error: beat.error || null,
    }));
    return {
      ...heartbeat,
      intervalMs: heartbeatIntervalMs,
      ptsStallBeats,
      rebuildCooldownMs,
      secondsSinceLastCycle: heartbeat.lastCycleAt ? Math.round((now() - Date.parse(heartbeat.lastCycleAt)) / 1000) : null,
      stale: heartbeat.lastCycleAt ? (now() - Date.parse(heartbeat.lastCycleAt)) > heartbeatIntervalMs * 4 : true,
      beats,
    };
  }

  /** Whether one session's beat says its stream is moving; used by the summary, never by a user-facing route. */
  function streamBeatFor(userId) {
    return streamBeats.get(String(userId)) || null;
  }

  /**
   * Forget what the last beat compared, for one session or for all of them.
   *
   * Call it whenever a session is replaced by hand: the new client's `stats.seen` starts at zero, and a
   * comparison against a baseline taken from the session it replaced reads that as a stalled stream - which is
   * how a watchdog ends up reconnecting every session it has ever rebuilt, forever. The beat retakes the
   * baseline on its next cycle, so what this removes is only the accusation.
   */
  function resetStreamBaseline(userId = null) {
    if (userId === null || userId === undefined) {
      const cleared = streamBeats.size;
      streamBeats.clear();
      rebuildCooldown.clear();
      return { cleared };
    }
    const key = String(userId);
    const had = streamBeats.delete(key);
    rebuildCooldown.delete(key);
    unrecoverableCooldown.delete(key);
    const entry = entryFor(userId);
    if (entry) entry.reauthRequired = false;
    return { cleared: had ? 1 : 0 };
  }

  /** What one session's stream looks like: when we last saw anything, and whether it is due a cross-check. */
  function streamHealth(userId) {
    const entry = entryFor(userId);
    const stats = entry?.stats || EMPTY_STATS();
    const lastAt = stats.lastAt ? Date.parse(stats.lastAt) : 0;
    const silenceMs = lastAt ? Math.max(0, now() - lastAt) : null;
    const lastRun = catchUpRuns.get(String(userId)) || 0;
    const beat = streamBeats.get(String(userId)) || null;
    /* Staggered per workspace, deterministically: `gapCatchUpMs + spread` is the outer bound, and a user who
       signed up last is not the one that gets throttled every time the fleet is asked at once. */
    const spread = staggerFor(userId, gapCatchUpSpreadMs);
    return {
      lastEventAt: stats.lastAt || null,
      silenceMs,
      lastDelayMs: Number.isFinite(stats.lastDelayMs) ? stats.lastDelayMs : null,
      suspect: silenceMs !== null && silenceMs >= silenceSuspectMs,
      catchUpOverdue: now() - lastRun >= gapCatchUpMs + spread,
      /* Two facts the sweep is allowed to act on sooner than its own stagger. `needsCatchUp` is the promise that a
         deaf session is a *delay* and never a loss: the 60-second rearm pass consumes it, so a stream the account
         refuses to reconcile still gets its channels read back within a minute instead of waiting on the staggered
         gap check. `reauthRequired` is the one fact that means a human is needed, and it belongs in health rather
         than in a log line, because "is it still recovering or is it finished" is the only question anybody asks. */
      needsCatchUp: entry?.needsCatchUp === true,
      reauthRequired: entry?.reauthRequired === true,
      beatStrikes: Number(beat?.strikes) || 0,
      beatRebuilds: Number(beat?.rebuilds) || 0,
      beatAction: beat?.action || null,
      /* The provider's own keep-alive, as seen by whoever is deciding whether this session is dying. A ping
         timeout inside GramJS is not evidence about our stream - it is evidence about its transport - and a
         watchdog that reads it as a fault will reconnect a fleet that was about to be fine. */
      keepAliveTimeouts: Number((typeof transportFlap === 'function' ? transportFlap(entry?.client) : null)?.count) || 0,
      transportFlapping: beat?.flapping === true,
      listening: Boolean(entry?.handler) && handlerIsLive(entry.client, entry.handler) && telegramAdapter.isConnected(entry.client),
    };
  }

  /* The one place a message becomes a row. Both the pushed-update path and the catch-up path call
     it, so "it was captured" means the same thing in production and in the replay. */
  async function ingestMessage(userId, message, event, { replayed = false } = {}) {
    const stats = statsFor(userId) || EMPTY_STATS();
    const entry = entryFor(userId);
    if (entry) entry.stats = stats;
    try {
      if (!replayed) stats.seen += 1;
      const chatId = resolveTelegramChatId(message, event);
      const arrivedAt = now();
      stats.lastAt = new Date(arrivedAt).toISOString();
      stats.lastChatId = chatId || null;
      stats.lastMessageId = message?.id ?? null;
      /* When the *channel* sent it, not when we got it: without this number the whole question "is the listener
         lagging" is unanswerable after the fact, because `signals.created_at` is only ever the write time. GramJS
         gives the Telegram date in epoch seconds, so the delay is one subtraction, and it is recorded on every
         update - including the ones this workspace does not trade - because a quiet handler and a deaf one are
         the same shape from the outside. */
      const sentAtMs = Number(message?.date) * 1000;
      const sentAt = Number.isFinite(sentAtMs) && sentAtMs > 0 ? new Date(sentAtMs).toISOString() : null;
      stats.lastSentAt = sentAt;
      stats.lastDelayMs = sentAt ? Math.max(0, Math.round(arrivedAt - sentAtMs)) : null;
      if (stats.lastDelayMs !== null && stats.lastDelayMs >= silenceSuspectMs) {
        log('warn', 'Telegram update arrived late', { userId, messageId: message?.id ?? null, delayMs: stats.lastDelayMs, replayed: replayed === true });
      }
      const text = telegramMessageText(message);
      if (!chatId) {
        stats.ignored += 1;
        log('warn', 'Telegram message had no chat id to match on', { userId, messageId: message?.id ?? null, peer: message?.peerId?.className ?? null, replayed });
        return { stored: false, reason: 'NO_CHAT_ID' };
      }
      if (!text) {
        // A photo, a poll, a pin, a join notice: nothing to parse, and saying so is what makes
        // "no new signals" an answer rather than a mystery.
        stats.ignored += 1;
        log('info', 'Telegram message carried no text to read', { userId, chatId, service: isTelegramServiceMessage(message), replayed });
        return { stored: false, reason: 'NO_TEXT' };
      }
      const variants = telegramPeerIdVariants(chatId);
      const { rows } = await pool.query(
        `SELECT channel_id AS "channelId",title FROM channels
          WHERE user_id=$1 AND enabled=TRUE AND channel_id = ANY($2::text[])
          ORDER BY created_at DESC LIMIT 1`,
        [userId, variants],
      );
      if (!rows.length) {
        stats.ignored += 1;
        log('info', 'Telegram message ignored: that chat is not monitored', { userId, chatId, variants: variants.join('|'), chars: text.length, replayed });
        return { stored: false, reason: 'NOT_MONITORED' };
      }
      // A replay must not invent a second row for a message the workspace already has, and the
      // table has no unique constraint to fall back on, so the check happens here.
      if (replayed && message?.id != null) {
        const known = await pool.query(
          `SELECT 1 FROM signals WHERE user_id=$1 AND channel_id=$2 AND telegram_message_id=$3 AND source='telegram' LIMIT 1`,
          [userId, rows[0].channelId, String(message.id)],
        ).catch(() => ({ rows: [] }));
        if (known.rows?.length) return { stored: false, reason: 'ALREADY_CAPTURED' };
      }
      /* `delayMs` rides on the line that proves the row exists, so one log entry answers "did we get it" and "how
         late was it" together - the pair an operator actually has to compare, and the only way the difference
         between a quiet channel and a deaf socket survives past the buffer for a report. */
      log('info', replayed ? 'Telegram message captured from catch-up' : 'Telegram message captured', { userId, chatId, channel: rows[0].title, chars: text.length, messageId: message?.id ?? null, delayMs: stats.lastDelayMs, sentAt: stats.lastSentAt });
      // The signal is stored whatever the parser makes of it - a message from a monitored channel that
      // reads as prose is still a captured message, and it is shown as such instead of vanishing.
      await saveSignal(userId, text, { source: 'telegram', channelId: rows[0].channelId, title: rows[0].title, telegramMessageId: message?.id ?? null, sentAt, delayMs: stats.lastDelayMs, replayed });
      stats.saved += 1;
      if (replayed) stats.catchUpSaved = (stats.catchUpSaved || 0) + 1;
      return { stored: true };
    } catch (error) {
      stats.lastError = `${error.message}`.slice(0, 200);
      // A storage failure used to be invisible: the promise was dropped and the panel simply had
      // nothing to show. The sentence goes to the log with the id it failed on, and onto the
      // status the admin page reads, so the next report has an actual cause in it.
      log('error', 'Telegram update processing failed', { userId, error: error.message, code: error.code || null, messageId: message?.id ?? null, replayed });
      return { stored: false, reason: 'SAVE_FAILED', error: error.message };
    }
  }

  /**
   * Attach the capture handler, or prove it is already attached.
   *
   * Returns the entry it worked on, including when it decides to do nothing, because the caller
   * (the status route, the boot sweep, a channel toggle) wants to report whether the workspace is
   * listening now - not whether this function had work to do.
   */
  async function startTelegramListener(userId, client) {
    const current = clients.get(String(userId)) || clients.get(userId);
    if (!current) return null;
    if (current.handler && handlerIsLive(client || current.client, current.handler)) return current;
    const target = client || current.client;
    if (!target) return current;
    if (current.handler && telegramAdapter.canRemoveMessageHandler(target)) {
      try { telegramAdapter.removeMessageHandler(target, current.handler, telegramAdapter.createMessageEventFilter()); } catch { /* the old client is gone */ }
    }
    const handler = (event) => ingestMessage(userId, event?.message, event);
    telegramAdapter.addMessageHandler(target, handler, telegramAdapter.createMessageEventFilter());
    current.handler = handler;
    if (!current.stats) current.stats = EMPTY_STATS();
    /* Every re-attach asks what was missed, whatever the statistics say. This used to be conditioned on
       "we have never seen a message on this session", which is the only case where the flag was obviously
       needed and the only case where a lost handler is *not* the explanation: a session that ran for an hour,
       went deaf, and had its handler re-attached had seen messages, so nothing was fetched, and the gap the
       re-attach existed to close stayed open forever. A push that will never come is a push that will never
       come whether or not we have had one before. */
    current.needsCatchUp = true;
    current.attachedAt = new Date(now()).toISOString();
    log('info', 'Telegram capture handler attached', { userId, reattach: true, silenceMs: current.stats.lastAt ? Math.max(0, now() - Date.parse(current.stats.lastAt)) : null });
    /* Every path that puts a handler on a client goes through here, so this is where "after the client connects
       and authenticates, force a state sync" has to live: an attach that leaves a session with no reconciled
       `pts` would have to wait for a beat to be believed, and for its first minute be indistinguishable from a
       deaf one. Adoptive rather than demanding on a fresh session, and deliberately not awaited - a capture
       handler that waits on a state request is a handler that is not attached while it waits. */
    const seeded = readUpdateState(target);
    void (Number.isFinite(seeded?.pts) && now() - (Number(seeded.at) || 0) < 10_000
      ? Promise.resolve({ action: 'in-sync', ms: 0 })
      : resyncUpdateState(target, { userId, reason: current.stats.lastAt ? 'reattach' : 'attach' }))
      .then((outcome) => { if (outcome && outcome.action && outcome.action !== 'in-sync') log('debug', 'Telegram update state seeded on attach', { userId, action: outcome.action }); })
      .catch((error) => log('warn', 'Telegram update state could not be seeded', { userId, error: `${error?.message || error}`.slice(0, 160) }));
    return current;
  }

  /**
   * Pull the recent history of each monitored channel after a session was rebuilt.
   *
   * The channel is looked up by username when the workspace has one, because that is the handle
   * Telegram will always resolve; a numeric id is tried next, and a channel the account cannot see
   * is reported rather than silently skipped - "the session is not in that channel" is the one
   * explanation that used to be unavailable from inside the product.
   */
  async function runCatchUp(userId) {
    const current = clients.get(String(userId)) || clients.get(userId);
    if (!current?.client || !telegramAdapter.isConnected(current.client)) return { ran: false, reason: 'NO_CLIENT', stored: 0 };
    /* Two runs for one user would read the same 25 messages twice and race each other on the dedupe check,
       and the two ways a catch-up starts - the reconnect itself and the periodic re-arm sweep - are not
       coordinated with each other. Whichever arrives second gives up immediately; the flag stays set, so the
       work is not lost, only deferred. */
    if (catchUpInFlight.has(String(userId))) return { ran: false, reason: 'IN_FLIGHT', stored: 0 };
    const lastRun = catchUpRuns.get(String(userId)) || 0;
    if (now() - lastRun < catchUpCooldownMs) return { ran: false, reason: 'COOLDOWN', stored: 0 };
    catchUpInFlight.add(String(userId));
    // The cooldown starts here, not when the pass finishes: a run that is interrupted still costs a pause.
    catchUpRuns.set(String(userId), now());
    // Cleared only when a run finishes the whole list; see the budget check below.
    const startedAt = now();
    try {
      return await runCatchUpPass(userId, current, startedAt);
    } finally {
      catchUpInFlight.delete(String(userId));
    }
  }

  async function runCatchUpPass(userId, current, startedAt) {
    let stored = 0;
    /* A replay that turns up a message posted *after* this handler went on is not a recovery, it is a
       confession: the channel spoke while we were listening and the push never arrived. That is the one thing
       the silence clock cannot tell us - a workspace with two monitored channels keeps `lastAt` fresh on the
       live one and misses the other forever - so it is measured here, against the attach, where both halves of
       the comparison are already in hand. */
    const listeningSince = current.attachedAt ? Date.parse(current.attachedAt) : 0;
    let fresh = 0;
    current.needsCatchUp = false;
    const { rows: channels } = await pool.query(
      'SELECT channel_id AS "channelId",title,username FROM channels WHERE user_id=$1 AND enabled=TRUE ORDER BY created_at DESC',
      [userId],
    );
    if (!channels.length) return { ran: true, reason: 'NO_CHANNELS', stored: 0 };
    for (const channel of channels) {
      if (now() - startedAt >= catchUpBudgetMs) {
        // Out of budget: the remaining channels keep their claim on the next run.
        current.needsCatchUp = true;
        return { ran: true, reason: 'BUDGET', stored, fresh, partial: true };
      }
      const handles = [];
      if (channel.username) handles.push(channel.username);
      const numeric = String(channel.channelId || '').replace(/^-100/, '');
      if (/^\d+$/.test(numeric)) handles.push(BigInt(numeric));
      let messages = [];
      for (const handle of handles) {
        try {
          const entity = await telegramAdapter.getEntity(current.client, handle);
          messages = await telegramAdapter.getMessages(current.client, entity, { limit: catchUpLimit });
          break;
        } catch (error) {
          log('warn', 'Telegram catch-up could not read that channel', { userId, channel: channel.channelId, handle: String(handle), error: error.message });
        }
      }
      if (!messages.length) continue;
      // Oldest first, so the rows land in the order the channel wrote them.
      for (const message of [...messages].reverse()) {
        /* One event-loop turn per message. Without this the replay is a chain of 25 promises that never
           yields, and every live update that arrives during it is served after another row of the replay -
           which is exactly the latency this whole path is meant to remove. `setImmediate` puts the next
           message at the back of the check queue instead of the front of the microtask one. */
        await yieldToEventLoop();
        if (now() - startedAt >= catchUpBudgetMs) {
          current.needsCatchUp = true;
          if (stored) log('info', 'Telegram catch-up stopped at its budget', { userId, stored, fresh });
          return { ran: true, reason: 'BUDGET', stored, fresh, partial: true };
        }
        const result = await ingestMessage(userId, message, { message }, { replayed: true });
        if (result.stored) {
          stored += 1;
          const sentAtMs = Number(message?.date) * 1000;
          if (listeningSince && Number.isFinite(sentAtMs) && sentAtMs > listeningSince) fresh += 1;
        }
      }
    }
    if (stored) log('info', 'Telegram catch-up stored missed messages', { userId, stored, fresh });
    if (fresh) {
      log('warn', 'Telegram replay found messages posted while the handler was attached', { userId, fresh, sinceAttachMs: Math.max(0, now() - listeningSince) });
      /* Escalated, because there is a handler attached and a socket that answers: a reconnect that returns the
         same connected client would rebuild nothing and simply agree that the session is fine. */
      requestStreamRebuild(userId, 'message-missed-while-listening', { escalate: true });
    }
    return { ran: true, reason: 'DONE', stored, fresh };
  }

  /** What every user's session looks like right now, for the admin diagnostics only. */
  function telegramFleetSummary() {
    const sessions = [];
    let listening = 0;
    let seen = 0;
    let saved = 0;
    let lastMessageAt = null;
    for (const [userId, entry] of clients.entries?.() || []) {
      const stats = entry.stats || EMPTY_STATS();
      const beatInfo = streamBeats.get(String(userId));
      const attached = Boolean(entry.handler) && handlerIsLive(entry.client, entry.handler);
      if (attached && telegramAdapter.connectedFlag(entry.client)) listening += 1;
      seen += Number(stats.seen) || 0;
      saved += Number(stats.saved) || 0;
      if (stats.lastAt && (!lastMessageAt || stats.lastAt > lastMessageAt)) lastMessageAt = stats.lastAt;
      sessions.push({
        userId: String(userId),
        connected: telegramAdapter.isConnected(entry.client),
        listening: attached && telegramAdapter.isConnected(entry.client),
        needsCatchUp: entry.needsCatchUp === true,
        messagesSeen: Number(stats.seen) || 0,
        messagesIgnored: Number(stats.ignored) || 0,
        signalsSaved: Number(stats.saved) || 0,
        catchUpSaved: Number(stats.catchUpSaved) || 0,
        lastMessageAt: stats.lastAt || null,
        lastError: stats.lastError || null,
        // What the operator needs to answer "is it slow" without a log search: how long the last update took
        // to reach us from the channel, and how long it has been since the handler fired at all.
        lastDelayMs: Number.isFinite(stats.lastDelayMs) ? stats.lastDelayMs : null,
        silenceSeconds: stats.lastAt ? Math.round(Math.max(0, now() - Date.parse(stats.lastAt)) / 1000) : null,
        attachedAt: entry.attachedAt || null,
        /* The beat's own numbers for this session. Together with `silenceSeconds` these are the whole answer to
           "is it slow, is it dead, or is the channel quiet": a fresh `lastBeatAt` with a moving `beatPts` and no
           `messagesSeen` growth is a live transport feeding a dead update loop, which is invisible from any flag. */
        lastBeatAt: beatInfo?.at ? new Date(beatInfo.at).toISOString() : null,
        beatMs: Number.isFinite(beatInfo?.ms) ? beatInfo.ms : null,
        beatPts: Number.isFinite(beatInfo?.pts) ? beatInfo.pts : null,
        /* The pair that answers "is it deaf" without a log search: the account's number, this session's reconciled
           number, and the two counters that show the sweep doing the stream's job. */
        beatStatePts: Number.isFinite(beatInfo?.statePts) ? beatInfo.statePts : null,
        beatGap: Number(beatInfo?.gap) || 0,
        beatAction: beatInfo?.action || null,
        beatDeaf: Number(beatInfo?.deaf) || 0,
        /* The strike ladder in three numbers: how many beats in a row the stream has been behind, how many
           rebuilds this session has already been given, and whether a workspace is now waiting on a sign-in.
           `reauthRequired` is the only one of these that means "stop waiting for it to fix itself". */
        beatStrikes: Number(beatInfo?.strikes) || 0,
        beatRebuilds: Number(beatInfo?.rebuilds) || 0,
        beatSteps: Number(beatInfo?.steps) || 0,
        beatPartial: beatInfo?.partial === true,
        reauthRequired: entry.reauthRequired === true,
        /* The transport's own tally, read live rather than from the last beat: a session that answers every ping
           test but has been flapping for an hour is the fact worth having next to its healthy `beatAction`. */
        keepAliveTimeouts: Number((typeof transportFlap === 'function' ? transportFlap(entry.client) : null)?.count) || 0,
        transportFlapping: beatInfo?.flapping === true,
        beatStalls: Number(beatInfo?.stalls) || 0,
        beatError: beatInfo?.error || null,
      });
    }
    const instanceStartedAt = startedAt.toISOString();
    const idleMs = lastMessageAt ? Math.max(0, now() - Date.parse(lastMessageAt)) : null;
    const delays = sessions.map((session) => session.lastDelayMs).filter((value) => Number.isFinite(value));
    const slowestSilence = sessions.reduce((worst, session) => (session.silenceSeconds != null && (worst === null || session.silenceSeconds > worst) ? session.silenceSeconds : worst), null);
    return {
      sessions,
      sessionsInMemory: sessions.length,
      connectedSessions: sessions.filter((entry) => entry.connected).length,
      listening,
      messagesSeen: seen,
      signalsSaved: saved,
      lastMessageAt,
      instanceStartedAt,
      instanceUptimeSeconds: Math.round((now() - startedAt.getTime()) / 1000),
      resumedAfterBoot,
      // The one sentence this whole block exists to make possible: the session is connected and
      // nothing has passed through the handler, which on a sleeping host means the instance was
      // not running when the channel posted.
      // The numbers this whole path is judged on, in the health panel and nowhere else: the worst
      // channel-to-database delay any session reported, and the longest silence across the fleet.
      maxDelayMs: delays.length ? Math.max(...delays) : null,
      medianDelayMs: delays.length ? delays.slice().sort((a, b) => a - b)[Math.floor(delays.length / 2)] : null,
      longestSilenceSeconds: slowestSilence,
      streamIdle: listening > 0 && (idleMs === null || idleMs > Math.max(STREAM_IDLE_MS, silenceSuspectMs)),
      // The keep-alive watchdog in one object: how many cycles ran, how many sessions could not answer, how
      // many had to be rebuilt, and whether the last cycle is old enough that the interval itself is suspect.
      heartbeat: heartbeatSummary(),
      // The state the health panel turns into a sentence: something is expected, nothing is attached.
      nothingAttached: sessions.length > 0 && listening === 0,
      idleSeconds: idleMs === null ? null : Math.round(idleMs / 1000),
    };
  }

  function markSessionResumed() { resumedAfterBoot += 1; }

  return { startTelegramListener, handlerIsLive, ingestMessage, runCatchUp, statsFor, telegramFleetSummary, probeUpdateStream, resyncUpdateState, declareSessionUnrecoverable, readUpdateState: (client) => readUpdateState(client), streamHealth, beatUpdateStreams, heartbeatSummary, streamBeatFor, resetStreamBaseline, requestStreamRebuild, markSessionResumed, EMPTY_STATS };
}
