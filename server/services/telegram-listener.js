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
/** Never poll Telegram for history more often than this, per user. */
export const CATCH_UP_COOLDOWN_MS = 5 * 60 * 1000;
/** Connected, listening, and nothing through the handler for this long is worth saying out loud. */
export const STREAM_IDLE_MS = 15 * 60 * 1000;

const EMPTY_STATS = () => ({ seen: 0, saved: 0, ignored: 0, lastAt: null, lastChatId: null, lastError: null, catchUpSaved: 0 });

export function createTelegramListener({ clients, pool, log = console, saveSignal, now = () => Date.now(), catchUpLimit = CATCH_UP_LIMIT, catchUpCooldownMs = CATCH_UP_COOLDOWN_MS } = {}) {
  if (!clients || !pool || !saveSignal) throw new Error('createTelegramListener requires clients, pool and saveSignal');
  const startedAt = new Date();
  const catchUpRuns = new Map();
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

  /* The one place a message becomes a row. Both the pushed-update path and the catch-up path call
     it, so "it was captured" means the same thing in production and in the replay. */
  async function ingestMessage(userId, message, event, { replayed = false } = {}) {
    const stats = statsFor(userId) || EMPTY_STATS();
    const entry = entryFor(userId);
    if (entry) entry.stats = stats;
    try {
      if (!replayed) stats.seen += 1;
      const chatId = resolveTelegramChatId(message, event);
      stats.lastAt = new Date(now()).toISOString();
      stats.lastChatId = chatId || null;
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
      log('info', replayed ? 'Telegram message captured from catch-up' : 'Telegram message captured', { userId, chatId, channel: rows[0].title, chars: text.length, messageId: message?.id ?? null });
      // The signal is stored whatever the parser makes of it - a message from a monitored channel that
      // reads as prose is still a captured message, and it is shown as such instead of vanishing.
      await saveSignal(userId, text, { source: 'telegram', channelId: rows[0].channelId, title: rows[0].title, telegramMessageId: message?.id ?? null });
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
    // A session that has just been rebuilt knows nothing about the messages that arrived while the
    // instance was down, so it is marked for the catch-up pull instead of waiting for a push that
    // will never come.
    if (!current.stats.lastAt) current.needsCatchUp = true;
    log('info', 'Telegram capture handler attached', { userId, reattach: true });
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
    const lastRun = catchUpRuns.get(String(userId)) || 0;
    if (now() - lastRun < catchUpCooldownMs) return { ran: false, reason: 'COOLDOWN', stored: 0 };
    catchUpRuns.set(String(userId), now());
    current.needsCatchUp = false;
    const { rows: channels } = await pool.query(
      'SELECT channel_id AS "channelId",title,username FROM channels WHERE user_id=$1 AND enabled=TRUE ORDER BY created_at DESC',
      [userId],
    );
    if (!channels.length) return { ran: true, reason: 'NO_CHANNELS', stored: 0 };
    let stored = 0;
    for (const channel of channels) {
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
      });
    }
    const instanceStartedAt = startedAt.toISOString();
    const idleMs = lastMessageAt ? Math.max(0, now() - Date.parse(lastMessageAt)) : null;
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
      streamIdle: listening > 0 && (idleMs === null || idleMs > STREAM_IDLE_MS),
      // The state the health panel turns into a sentence: something is expected, nothing is attached.
      nothingAttached: sessions.length > 0 && listening === 0,
      idleSeconds: idleMs === null ? null : Math.round(idleMs / 1000),
    };
  }

  function markSessionResumed() { resumedAfterBoot += 1; }

  return { startTelegramListener, handlerIsLive, ingestMessage, runCatchUp, statsFor, telegramFleetSummary, markSessionResumed, EMPTY_STATS };
}
