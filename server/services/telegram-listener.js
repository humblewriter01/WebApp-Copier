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
 * 3. THE GAP. GramJS in this version defines `catchUp()` as a stub with a `// TODO` in it, and the
 *    update loop only pings: nothing asks Telegram for the messages that arrived while the instance
 *    was disconnected. On a free Render service, which stops between visitors, that means a message
 *    published during sleep is never seen at all - the connection is healthy, the handler is
 *    attached, and the app is permanently one message behind. `runCatchUp` closes that gap by
 *    pulling recent history for each monitored channel after a session is restored, and feeding
 *    those messages through the same path a pushed update takes.
 */
import { NewMessage } from 'telegram/events/index.js';
import { isTelegramServiceMessage, resolveTelegramChatId, telegramMessageText, telegramPeerIdVariants } from './telegram-peer.js';

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
 * A scalping signal is dead at two minutes (`MAX_SIGNAL_AGE_MS`), so the bound has to be well under that: this
 * is the interval within which a deaf socket is noticed, probed and rebuilt, instead of at the next deploy.
 */
export const SILENCE_SUSPECT_MS = 90_000;
/** A probe that has not answered in this long is a dead socket, because a live one answers in tens of ms. */
export const STREAM_PROBE_DEADLINE_MS = 5_000;
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

/** One turn of the event loop, so a replay never runs two messages back to back. */
const yieldToEventLoop = () => new Promise((resolve) => setImmediate(resolve));
/** Connected, listening, and nothing through the handler for this long is worth saying out loud. */
export const STREAM_IDLE_MS = 15 * 60 * 1000;

const EMPTY_STATS = () => ({ seen: 0, saved: 0, ignored: 0, lastAt: null, lastChatId: null, lastError: null, catchUpSaved: 0, lastDelayMs: null, lastSentAt: null, lastMessageId: null });

export function createTelegramListener({ clients, pool, log = console, saveSignal, now = () => Date.now(), catchUpLimit = CATCH_UP_LIMIT, catchUpCooldownMs = CATCH_UP_COOLDOWN_MS, catchUpBudgetMs = CATCH_UP_BUDGET_MS, silenceSuspectMs = SILENCE_SUSPECT_MS, probeDeadlineMs = STREAM_PROBE_DEADLINE_MS, gapCatchUpMs = GAP_CATCH_UP_MS } = {}) {
  if (!clients || !pool || !saveSignal) throw new Error('createTelegramListener requires clients, pool and saveSignal');
  const startedAt = new Date();
  const catchUpRuns = new Map();
  const catchUpInFlight = new Set();
  let resumedAfterBoot = 0;

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
    if (typeof client.listEventHandlers !== 'function') return true;
    let builders = [];
    try { builders = client.listEventHandlers() || []; } catch { return true; }
    return builders.some((pair) => Array.isArray(pair) && pair[1] === handler);
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
    if (!client || client.connected !== true) return { alive: false, state: 'no-socket' };
    if (typeof client.invoke !== 'function') return { alive: true, state: 'unknown' };
    let request = null;
    try {
      const { Api } = await import('telegram');
      if (Api?.updates?.GetState) request = new Api.updates.GetState();
    } catch {
      return { alive: true, state: 'unknown' };
    }
    if (!request) return { alive: true, state: 'unknown' };
    const startedAt = now();
    let timer = null;
    try {
      const state = await Promise.race([
        Promise.resolve().then(() => client.invoke(request)),
        new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error('probe-timeout')), deadlineMs); timer.unref?.(); }),
      ]);
      return { alive: true, state: 'alive', pts: Number(state?.pts ?? 0) || null, ms: Math.max(0, now() - startedAt) };
    } catch (error) {
      return { alive: false, state: 'dead', error: `${error?.message || error}`.slice(0, 160), ms: Math.max(0, now() - startedAt) };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** What one session's stream looks like: when we last saw anything, and whether it is due a cross-check. */
  function streamHealth(userId) {
    const entry = entryFor(userId);
    const stats = entry?.stats || EMPTY_STATS();
    const lastAt = stats.lastAt ? Date.parse(stats.lastAt) : 0;
    const silenceMs = lastAt ? Math.max(0, now() - lastAt) : null;
    const lastRun = catchUpRuns.get(String(userId)) || 0;
    /* Staggered per workspace, deterministically: `gapCatchUpMs + spread` is the outer bound, and a user who
       signed up last is not the one that gets throttled every time the fleet is asked at once. */
    const spread = [...String(userId)].reduce((total, char) => (total * 31 + char.charCodeAt(0)) % GAP_CATCH_UP_SPREAD_MS, 0);
    return {
      lastEventAt: stats.lastAt || null,
      silenceMs,
      lastDelayMs: Number.isFinite(stats.lastDelayMs) ? stats.lastDelayMs : null,
      suspect: silenceMs !== null && silenceMs >= silenceSuspectMs,
      catchUpOverdue: now() - lastRun >= gapCatchUpMs + spread,
      listening: Boolean(entry?.handler) && handlerIsLive(entry.client, entry.handler) && entry.client?.connected === true,
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
    if (current.handler && typeof target.removeEventHandler === 'function') {
      try { target.removeEventHandler(current.handler, new NewMessage({})); } catch { /* the old client is gone */ }
    }
    const handler = (event) => ingestMessage(userId, event?.message, event);
    target.addEventHandler(handler, new NewMessage({}));
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
    if (!current?.client || current.client.connected !== true) return { ran: false, reason: 'NO_CLIENT', stored: 0 };
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
        return { ran: true, reason: 'BUDGET', stored, partial: true };
      }
      const handles = [];
      if (channel.username) handles.push(channel.username);
      const numeric = String(channel.channelId || '').replace(/^-100/, '');
      if (/^\d+$/.test(numeric)) handles.push(BigInt(numeric));
      let messages = [];
      for (const handle of handles) {
        try {
          const entity = await current.client.getEntity(handle);
          messages = await current.client.getMessages(entity, { limit: catchUpLimit });
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
          if (stored) log('info', 'Telegram catch-up stopped at its budget', { userId, stored });
          return { ran: true, reason: 'BUDGET', stored, partial: true };
        }
        const result = await ingestMessage(userId, message, { message }, { replayed: true });
        if (result.stored) stored += 1;
      }
    }
    if (stored) log('info', 'Telegram catch-up stored missed messages', { userId, stored });
    return { ran: true, reason: 'DONE', stored };
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
      const attached = Boolean(entry.handler) && handlerIsLive(entry.client, entry.handler);
      if (attached && entry.client?.connected) listening += 1;
      seen += Number(stats.seen) || 0;
      saved += Number(stats.saved) || 0;
      if (stats.lastAt && (!lastMessageAt || stats.lastAt > lastMessageAt)) lastMessageAt = stats.lastAt;
      sessions.push({
        userId: String(userId),
        connected: entry.client?.connected === true,
        listening: attached && entry.client?.connected === true,
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
      // The state the health panel turns into a sentence: something is expected, nothing is attached.
      nothingAttached: sessions.length > 0 && listening === 0,
      idleSeconds: idleMs === null ? null : Math.round(idleMs / 1000),
    };
  }

  function markSessionResumed() { resumedAfterBoot += 1; }

  return { startTelegramListener, handlerIsLive, ingestMessage, runCatchUp, statsFor, telegramFleetSummary, probeUpdateStream, streamHealth, markSessionResumed, EMPTY_STATS };
}
