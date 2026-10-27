/**
 * The whole capture path, end to end, with no network and no SQL-only shortcuts.
 *
 * Every previous fix to Telegram capture was verified by asking the database whether a query matched
 * a channel id. That is not the failure. The failure is that a message arrives on a GramJS client and
 * no row appears, so this file drives a real update object through the real GramJS dispatcher -
 * `_handleUpdate`, the same function the MTProto connection calls for a pushed update, with the real
 * `NewMessage` event builder the production code registers - into the listener, and asserts what the
 * storage layer was asked to write. If the handler were never attached, if an id arrived in the other
 * spelling, or if a save error were swallowed again, one of these tests breaks.
 *
 * The client here is a real `TelegramClient` that never connects. The identity lookup the dispatcher
 * would otherwise attempt (`getMe`) is pre-seeded, because it is a network call and not part of what
 * is under test; nothing else is stubbed out.
 */
import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Api, TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { _handleUpdate } from 'telegram/client/updates.js';
import { NewMessage } from 'telegram/events/index.js';
import { CATCH_UP_COOLDOWN_MS, HEARTBEAT_INTERVAL_MS, STREAM_REBUILD_COOLDOWN_MS, GAP_CATCH_UP_MS, GAP_CATCH_UP_SPREAD_MS, SILENCE_SUSPECT_MS, createTelegramListener, normalizeUpdateState, readUpdateState, UPDATE_STATE_KEY } from '../services/telegram-listener.js';
import { telegramPeerIdVariants, telegramMessageText } from '../services/telegram-peer.js';

const USER_ID = '5036a3d3-0671-4cbf-9728-e5e3bf1eea9b';
/** The production shape: the row carries the `-100` mark, the update carries the raw id. */
const STORED_CHANNEL_ID = '-1002440709664';
const BARE_CHANNEL_ID = '2440709664';
const CHANNEL_TITLE = 'XM Crypto News';
const SIGNAL_TEXT = 'BUY XAUUSD\nEntry: 2650.00\nSL: 2640.00\nTP: 2670.00';

function makePool({ channels = [{ channelId: STORED_CHANNEL_ID, title: CHANNEL_TITLE }], knownMessageIds = [] } = {}) {
  const calls = [];
  const known = new Set(knownMessageIds.map((id) => String(id)));
  return {
    calls,
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes('FROM channels')) {
        // The listener's lookup passes every spelling of the id; the catch-up read asks for all of
        // this workspace's monitored channels at once, and both are real queries.
        const variants = params[1];
        const rows = Array.isArray(variants) ? channels.filter((channel) => variants.includes(channel.channelId)) : channels;
        return { rows: rows.map((channel) => ({ channelId: channel.channelId, title: channel.title, username: channel.username ?? null })) };
      }
      if (sql.includes('FROM signals WHERE user_id=$1 AND channel_id=$2 AND telegram_message_id=$3')) {
        return { rows: known.has(String(params[2])) ? [{ '?column?': 1 }] : [] };
      }
      throw new Error(`Unexpected query from the capture path: ${sql.replace(/\s+/g, ' ').slice(0, 90)}`);
    },
    channelsCalls: () => calls.filter((call) => call.sql.includes('FROM channels')),
    known,
  };
}

function makeHarness(options = {}) {
  const pool = makePool(options);
  const saved = [];
  const logs = [];
  const clients = new Map();
  let clock = Date.parse('2026-10-23T13:00:00.000Z');
  const listener = createTelegramListener({
    clients,
    pool,
    log: (level, message, meta) => logs.push({ level, message, meta }),
    saveSignal: async (userId, message, channel) => {
      if (options.failSave) throw new Error('column "fallback_stop_loss_points" does not exist');
      // A test that wants to hold the replay mid-write - to see what a live update does while the loop is
      // busy with a row - parks here, before the row is recorded as stored.
      if (options.onSave) await options.onSave(channel);
      saved.push({ userId, message, channel });
      return { id: `signal-${saved.length}` };
    },
    now: () => clock,
  });
  const client = new TelegramClient(new StringSession(''), 1, 'api-hash', { connectionRetries: 1 });
  // The dispatcher asks for the account's own peer id once per update; that is a network call, so it
  // is pre-seeded rather than mocked mid-flight.
  client._userId = 42n;
  // GramJS reports `connected` as `_sender && _sender.isConnected()`, and there is no sender until a
  // real connect happens. This stand-in is what lets the test assert the thing the listener itself
  // depends on: that a session the library calls live is the session a handler is attached to.
  client._sender = { isConnected: () => true };
  client._selfInputPeer = new Api.PeerUser({ userId: 42n });
  client._log = { info() {}, warn() {}, error() {}, debug() {} };
  clients.set(USER_ID, { client, handler: null, stats: listener.EMPTY_STATS() });
  const advance = (ms) => { clock += ms; };
  return { pool, saved, logs, clients, client, listener, advance, entry: () => clients.get(USER_ID) };
}

/*
 * GramJS keeps a channel post's body in `message.message`; `message.text` only exists once the
 * library's own `_finishInit()` has run, and that call is wrapped in a `try/catch` that ignores
 * failures. A message whose decoration failed used to read as "no text" and be dropped, so the
 * shape under test is deliberately the undecorated one.
 */
function channelMessage({ id = 77, text = SIGNAL_TEXT, decorated = true, out = false } = {}) {
  const peerId = new Api.PeerChannel({ channelId: BigInt(BARE_CHANNEL_ID) });
  const message = new Api.Message({
    id,
    peerId,
    date: Math.floor(Date.parse('2026-10-23T12:59:00.000Z') / 1000),
    message: text,
    out,
    mentioned: false,
    mediaUnstable: false,
    mediaUnread: false,
    unread: false,
    post: false,
  });
  // `Message.text` is a getter over `_text`, and `_finishInit()` is what fills `_text` in. Setting
  // it here reproduces a decorated message without depending on the library's entity resolution.
  if (decorated) message._text = text;
  return message;
}

async function dispatch(harness, update) {
  await _handleUpdate(harness.client, update);
  // `_handleUpdate` fans out to an async dispatcher without awaiting it, exactly as the connection
  // layer does, so one microtask drain is needed before the storage call can be observed.
  for (let index = 0; index < 5; index += 1) await new Promise((resolve) => { setImmediate(resolve); });
}

test('a real GramJS channel update is matched and stored through the real dispatcher', async () => {
  const harness = makeHarness();
  await harness.listener.startTelegramListener(USER_ID, harness.client);
  assert.ok(harness.entry().handler, 'attaching records the handler');
  assert.equal(harness.listener.handlerIsLive(harness.client, harness.entry().handler), true, 'the handler is in GramJS own list');

  await dispatch(harness, new Api.UpdateNewChannelMessage({ message: channelMessage(), pts: 12, seq: 0 }));

  const channels = harness.pool.channelsCalls();
  assert.equal(channels.length, 1, 'the monitored channel is looked up once per message');
  const variants = channels[0].params[1];
  assert.ok(variants.includes(BARE_CHANNEL_ID), 'the raw id from the update is tried');
  assert.ok(variants.includes(STORED_CHANNEL_ID), 'and the -100 spelling the row holds is tried too');
  assert.equal(channels[0].params[0], USER_ID, 'only this workspace rows are consulted');

  assert.equal(harness.saved.length, 1, 'the message reached storage');
  /* `replayed: false` is not decoration: it is what tells the AI reader queue that this message is live and
     must be served before a reconnect's replay, so the flag is pinned on the live path as well as the replay. */
  /* `sentAt`/`delayMs` are pinned here because they are the whole difference between "the channel was quiet" and
   * "we were deaf", and they are the only evidence of it that outlives the log buffer: the fixture posts at
   * 12:59:00 and the harness clock says 13:00:00, so a minute of lateness has to be carried into storage rather
   * than flattened into `created_at`, which would describe a five-minute-late entry as a fresh one. */
  assert.deepEqual(harness.saved[0].channel, { source: 'telegram', channelId: STORED_CHANNEL_ID, title: CHANNEL_TITLE, telegramMessageId: 77, replayed: false, sentAt: '2026-10-23T12:59:00.000Z', delayMs: 60_000 });
  assert.equal(harness.saved[0].message, SIGNAL_TEXT);
  const captured = harness.logs.find((entry) => entry.message === 'Telegram message captured');
  assert.ok(captured, 'the capture is written down, so a report can quote it');
  assert.equal(captured.meta.channel, CHANNEL_TITLE);
  assert.deepEqual({ seen: harness.entry().stats.seen, saved: harness.entry().stats.saved, ignored: harness.entry().stats.ignored }, { seen: 1, saved: 1, ignored: 0 });
});

test('the batched shape Telegram pushes for channels is read the same way', async () => {
  const harness = makeHarness();
  await harness.listener.startTelegramListener(USER_ID, harness.client);
  await dispatch(harness, new Api.UpdatesCombined({
    updates: [new Api.UpdateNewChannelMessage({ message: channelMessage({ id: 91 }), pts: 13, seq: 1 })],
    users: [],
    chats: [],
    date: Math.floor(Date.parse('2026-10-23T12:59:00.000Z') / 1000),
    seq: 2,
  }));
  assert.equal(harness.saved.length, 1, 'a message inside an UpdatesCombined is stored like a direct one');
  assert.equal(harness.saved[0].channel.telegramMessageId, 91);
});

test('a post whose GramJS decoration failed is still read, which is the bug that lost every signal', async () => {
  const harness = makeHarness();
  await harness.listener.startTelegramListener(USER_ID, harness.client);
  await dispatch(harness, new Api.UpdateNewChannelMessage({ message: channelMessage({ id: 93, decorated: false }), pts: 14, seq: 0 }));
  assert.equal(harness.saved.length, 1, 'an undecorated message is not an empty message');
  assert.equal(harness.saved[0].message, SIGNAL_TEXT);
  assert.equal(harness.entry().stats.ignored, 0, 'and it is never counted as having no text again');
});

test('a row stored without the mark matches an update that carries it', async () => {
  const harness = makeHarness({ channels: [{ channelId: BARE_CHANNEL_ID, title: CHANNEL_TITLE }] });
  await harness.listener.startTelegramListener(USER_ID, harness.client);
  await dispatch(harness, new Api.UpdateNewChannelMessage({ message: channelMessage({ id: 95 }), pts: 14, seq: 0 }));
  assert.equal(harness.saved.length, 1, 'either spelling on either side is the same channel');
  assert.equal(harness.saved[0].channel.channelId, BARE_CHANNEL_ID, 'and the row keeps the spelling it already used');
});

test('a message from a chat nobody monitors is counted and named, not quietly dropped', async () => {
  const harness = makeHarness({ channels: [] });
  await harness.listener.startTelegramListener(USER_ID, harness.client);
  await dispatch(harness, new Api.UpdateNewChannelMessage({ message: channelMessage(), pts: 15, seq: 0 }));
  assert.equal(harness.saved.length, 0);
  assert.equal(harness.entry().stats.ignored, 1, 'the ignored counter is how a quiet channel is told from a deaf listener');
  const ignored = harness.logs.find((entry) => entry.message.startsWith('Telegram message ignored'));
  assert.ok(ignored, 'and the log says which chat it refused');
  assert.ok(telegramPeerIdVariants(ignored.meta.chatId).includes(BARE_CHANNEL_ID), 'the id written down is this chat, whichever spelling produced it');
});

test('a storage failure is reported to the log and the status, instead of vanishing', async () => {
  const harness = makeHarness({ failSave: true });
  await harness.listener.startTelegramListener(USER_ID, harness.client);
  await dispatch(harness, new Api.UpdateNewChannelMessage({ message: channelMessage(), pts: 16, seq: 0 }));
  const failed = harness.logs.find((entry) => entry.message === 'Telegram update processing failed');
  assert.ok(failed, 'the message did arrive, so the cause of no row has to be visible');
  assert.match(failed.meta.error, /fallback_stop_loss_points/);
  assert.match(harness.entry().stats.lastError, /fallback_stop_loss_points/, 'and the status endpoint can repeat it');
  assert.equal(harness.entry().stats.saved, 0);
});

test('a handler that is no longer in the client is attached again, and the next message lands', async () => {
  const harness = makeHarness();
  await harness.listener.startTelegramListener(USER_ID, harness.client);
  const firstHandler = harness.entry().handler;
  // Attaching twice must not double-register: a second handler on the same client means a second row
  // for one message.
  await harness.listener.startTelegramListener(USER_ID, harness.client);
  assert.equal(harness.client.listEventHandlers().length, 1, 'one handler per client');
  assert.equal(harness.entry().handler, firstHandler, 'and the first one is kept');

  // Now simulate what a disconnect looks like to the bookkeeping: our flag still says attached.
  harness.client._eventBuilders = [];
  assert.equal(harness.listener.handlerIsLive(harness.client, firstHandler), false, 'the flag is a lie, and the handler list is the truth');
  await harness.listener.startTelegramListener(USER_ID, harness.client);
  assert.equal(harness.client.listEventHandlers().length, 1, 're-attached, once');
  assert.notEqual(harness.entry().handler, firstHandler, 'on the client that is actually connected');

  await dispatch(harness, new Api.UpdateNewChannelMessage({ message: channelMessage({ id: 99 }), pts: 17, seq: 0 }));
  assert.equal(harness.saved.length, 1, 'and messages flow again');
});

test('catch-up after a wake stores what the workspace missed, oldest first, and never twice', async () => {
  const pool = makePool({ knownMessageIds: [11] });
  const saved = [];
  const clients = new Map();
  let clock = Date.parse('2026-10-23T13:00:00.000Z');
  const listener = createTelegramListener({
    clients, pool, log: () => {},
    // Storing a replayed message also teaches the fake pool it exists, so a second replay of the
    // same window is testing the dedupe rather than the fixture.
    saveSignal: async (userId, message, channel) => {
      saved.push({ message, channel });
      if (channel.telegramMessageId != null) pool.known.add(String(channel.telegramMessageId));
      return { id: `signal-${saved.length}` };
    },
    now: () => clock,
  });
  // A stand-in for a GramJS client whose history read succeeds; the point of the test is which
  // messages the replay hands to storage, not the network.
  // A history read hands over messages the same way, and `getMessages` only decorates them when
  // the entity resolution succeeds, so the undecorated shape is what the replay has to survive.
  const fetched = [channelMessage({ id: 12, decorated: false }), channelMessage({ id: 11, decorated: false })];
  const client = { connected: true, getEntity: async () => ({ id: 1 }), getMessages: async () => fetched };
  clients.set(USER_ID, { client, handler: () => {}, stats: listener.EMPTY_STATS() });

  const first = await listener.runCatchUp(USER_ID);
  assert.equal(first.stored, 1, 'the message already captured is not stored again');
  assert.deepEqual(saved.map((entry) => entry.channel.telegramMessageId), [12], 'and the replay runs oldest first');
  assert.deepEqual(saved.map((entry) => entry.channel.replayed), [true], 'a replay says so, so the model queue can put it last');
  assert.equal(clients.get(USER_ID).stats.catchUpSaved, 1);

  const second = await listener.runCatchUp(USER_ID);
  assert.equal(second.ran, false);
  assert.equal(second.reason, 'COOLDOWN', 'a replay is rate limited, so it can never hammer Telegram');
  clock += 6 * 60 * 1000;
  const third = await listener.runCatchUp(USER_ID);
  assert.equal(third.stored, 0, 'once nothing is new, the replay adds nothing');
});

test('a session with no client connected cannot catch up, and says why', async () => {
  const harness = makeHarness();
  harness.clients.set(USER_ID, { client: { connected: false }, handler: null, stats: harness.listener.EMPTY_STATS() });
  const result = await harness.listener.runCatchUp(USER_ID);
  assert.deepEqual({ ran: result.ran, reason: result.reason }, { ran: false, reason: 'NO_CLIENT' });
});

test('the summary the admin panel reads separates a live listener from a mere connection', async () => {
  const harness = makeHarness();
  const before = harness.listener.telegramFleetSummary();
  assert.equal(before.sessionsInMemory, 1);
  assert.equal(before.listening, 0, 'connected but nothing attached is the failure state, and it has to be visible');
  assert.equal(before.nothingAttached, true, 'a session that is connected with nothing attached is the failure this whole path exists to catch');

  await harness.listener.startTelegramListener(USER_ID, harness.client);
  await dispatch(harness, new Api.UpdateNewChannelMessage({ message: channelMessage(), pts: 18, seq: 0 }));
  harness.advance(20 * 60 * 1000);
  const after = harness.listener.telegramFleetSummary();
  assert.equal(after.listening, 1);
  assert.equal(after.messagesSeen, 1);
  assert.equal(after.signalsSaved, 1);
  assert.equal(after.streamIdle, true, '20 minutes of silence after a message is worth saying out loud');
});

test('the reader finds a body in every field this library puts one in', () => {
  assert.equal(telegramMessageText({ message: 'BUY EURUSD' }), 'BUY EURUSD', 'the raw wire field');
  assert.equal(telegramMessageText({ text: 'BUY EURUSD' }), 'BUY EURUSD', 'the decorated field');
  assert.equal(telegramMessageText({ message: { text: 'BUY EURUSD' } }), 'BUY EURUSD', 'a nested message object');
  assert.equal(telegramMessageText({ media: { caption: 'SELL GBPUSD' } }), 'SELL GBPUSD', 'a caption under a photo');
  assert.equal(telegramMessageText({ message: '   ' }), null, 'blank is genuinely blank');
  assert.equal(telegramMessageText(null), null);
});

/*
 * Catch-up is the part of capture that runs *next to* live traffic rather than instead of it. These three
 * tests are the contract the reconnect path has to keep: one replay per user, a bounded run that resumes,
 * and a live message that is never made to wait behind a replay of older ones.
 */
function makeReplayHarness({ messages, catchUpBudgetMs, onStored, getMessages, catchUpCooldownMs = 0 } = {}) {
  const pool = makePool();
  const clients = new Map();
  const saved = [];
  let clock = Date.parse('2026-10-23T13:00:00.000Z');
  const listener = createTelegramListener({
    clients,
    pool,
    log: () => {},
    saveSignal: async (userId, message, channel) => {
      saved.push({ message, channel });
      pool.known.add(String(channel.telegramMessageId));
      onStored?.(clock);
      return { id: `signal-${saved.length}` };
    },
    now: () => clock,
    catchUpBudgetMs,
    catchUpCooldownMs,
  });
  const client = {
    connected: true,
    getEntity: async () => ({ id: 1 }),
    getMessages: getMessages || (async () => messages.map((id) => channelMessage({ id, decorated: false }))),
  };
  clients.set(USER_ID, { client, handler: () => {}, stats: listener.EMPTY_STATS() });
  return { pool, clients, listener, saved, entry: () => clients.get(USER_ID), advance: (ms) => { clock += ms; } };
}

test('a catch-up that runs out of its budget stops, keeps its claim, and finishes on the next pass', async () => {
  // The first stored message spends the whole budget of five milliseconds, so the replay is interrupted after
  // one row and the rest must survive rather than be silently walked past.
  const harness = makeReplayHarness({
    // Newest first, because that is the order Telegram hands history over; the replay is what reverses it.
    messages: [33, 32, 31],
    catchUpBudgetMs: 5,
    onStored: () => { if (!harness.spent) { harness.spent = true; harness.advance(10); } },
  });
  const first = await harness.listener.runCatchUp(USER_ID);
  assert.equal(first.stored, 1, 'the run stores what fits in its budget');
  assert.equal(first.reason, 'BUDGET', 'and says that it stopped rather than claiming it finished');
  assert.equal(harness.entry().needsCatchUp, true, 'a stopped replay leaves the session flagged for the next sweep');

  const second = await harness.listener.runCatchUp(USER_ID);
  assert.equal(second.reason, 'DONE');
  assert.deepEqual(second.stored, 2, 'the remaining messages are picked up where the first pass stopped');
  assert.equal(harness.entry().needsCatchUp, false, 'and the flag is cleared only once the list was finished');
  assert.deepEqual(harness.saved.map((entry) => entry.channel.telegramMessageId), [31, 32, 33], 'oldest first, with nothing lost or repeated');
});

test('one catch-up per user: a second call gives up instead of reading the same window twice', async () => {
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const harness = makeReplayHarness({ getMessages: async () => { await blocked; return []; } });
  const running = harness.listener.runCatchUp(USER_ID);
  const overlapping = await harness.listener.runCatchUp(USER_ID);
  assert.deepEqual({ ran: overlapping.ran, reason: overlapping.reason, stored: overlapping.stored }, { ran: false, reason: 'IN_FLIGHT', stored: 0 });
  release();
  assert.equal((await running).ran, true, 'the run that got there first is unaffected');
  const after = await harness.listener.runCatchUp(USER_ID);
  assert.equal(after.ran, true, 'and once it finishes, a new run is allowed');
});

test('a live message is stored while a replay is still reading history', async () => {
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const harness = makeHarness();
  await harness.listener.startTelegramListener(USER_ID, harness.client);
  // The reconnect's history read is in flight - a real flood wait, or a slow `getEntity`, looks just like this.
  harness.client.getEntity = async () => { await blocked; return { id: 1 }; };
  const replay = harness.listener.runCatchUp(USER_ID);

  await dispatch(harness, new Api.UpdateNewChannelMessage({ message: channelMessage({ id: 400 }), pts: 30, seq: 0 }));

  assert.deepEqual(harness.saved.map((entry) => entry.channel?.telegramMessageId), [400], 'the pushed update is stored while the replay waits');
  assert.equal(harness.saved[0].channel.replayed, false, 'and it is stored as live traffic, which is what puts it first in the AI reader queue');
  assert.equal(harness.logs.some((entry) => entry.message === 'Telegram message captured'), true);

  release();
  assert.equal((await replay).ran, true, 'the replay finishes afterwards');
});

test('a live message is stored between two replayed ones, not after the whole window', async () => {
  /* The hazard this pins is not the history read - that is a network call, and its awaits yield by
     themselves - but the ingest loop: 25 messages per channel, each a database write and sometimes a
     model request, chained through nothing but promises. A microtask chain like that never returns to the
     event loop, so a signal that arrived while the replay was running would be served after another row of
     the replay, which is exactly the delay this path exists to remove. One turn of the loop per message is
     what keeps the worst case at "one row behind", and the source assertion below is what keeps that from
     being optimised away as a redundant line. */
  let releaseFirst;
  const firstHeld = new Promise((resolve) => { releaseFirst = resolve; });
  let seen = 0;
  const harness = makeHarness({
    onSave: async (channel) => {
      seen += 1;
      if (channel.replayed === true && seen === 1) await firstHeld;
    },
  });
  await harness.listener.startTelegramListener(USER_ID, harness.client);
  // Entity resolution is a network call in GramJS, and `getMessages` is only reached once it succeeds, so
  // both halves of the history read are stood in for here.
  harness.client.getEntity = async () => ({ id: 1 });
  harness.client.getMessages = async () => [9, 8, 7].map((id) => channelMessage({ id }));

  const replay = harness.listener.runCatchUp(USER_ID);
  for (let index = 0; index < 5; index += 1) await new Promise((resolve) => { setImmediate(resolve); });
  assert.equal(harness.saved.length, 0, 'the replay is parked inside the save of its first row');

  await dispatch(harness, new Api.UpdateNewChannelMessage({ message: channelMessage({ id: 500 }), pts: 60, seq: 0 }));
  assert.deepEqual(harness.saved.map((entry) => entry.channel.telegramMessageId), [500], 'the live row lands while the replay is mid-write');

  releaseFirst();
  const result = await replay;
  assert.equal(result.ran, true, 'and the replay finishes what it started');
  assert.deepEqual(harness.saved.map((entry) => entry.channel.telegramMessageId), [500, 7, 8, 9],
    'the live update is first, ahead of the replayed rows that had not begun yet, and the window still lands oldest first');
});

test('the replay gives the loop back once per message, and says why in the line that does it', () => {
  const listenerSource = readFileSync(new URL('../services/telegram-listener.js', import.meta.url), 'utf8');
  const loop = listenerSource.slice(listenerSource.indexOf('for (const message of [...messages].reverse())'));
  assert.ok(loop.length > 80, 'the replay loop is where the yield has to be');
  assert.match(loop.slice(0, 900), /await yieldToEventLoop\(\);/, 'one turn of the event loop between messages');
  assert.match(listenerSource, /const yieldToEventLoop = \(\) => new Promise\(\(resolve\) => setImmediate\(resolve\)\);/, 'queued in the check phase, which is where an update from Telegram lands - a microtask would cut in front of it');
});

/* --------------------------------------------------------------------------- *
 * Half-deaf sockets.
 *
 * `connected === true` and a handler sitting in GramJS's own list are both statements about objects in memory,
 * and neither is a statement about the transport. A session can be open and receive nothing at all: a `pts` gap
 * Telegram stopped filling, an idle connection reaped by the host's NAT, a reconnect that left the update
 * manager attached to the previous transport. Every one of those was reported healthy, because the only rescue
 * was a catch-up that ran once every five minutes and was flagged only when the session had never seen a single
 * message - so a stream that went deaf mid-session stayed deaf until the next deploy. The three pieces below are
 * what close that hole: the bounded probe that asks the socket a question, the silence clock that decides when to
 * ask it, and the rule that any handler put back on a client has to look at the channel afterwards.
 * --------------------------------------------------------------------------- */

test('the probe tells a quiet channel from a deaf socket, and never condemns a client it cannot ask', async () => {
  const harness = makeHarness();
  const answering = { connected: true, invoke: async () => ({ pts: 900 }) };
  const live = await harness.listener.probeUpdateStream(answering);
  assert.equal(live.alive, true, 'a socket that replies is a socket that can push');
  assert.equal(live.state, 'alive');
  assert.equal(live.pts, 900, 'and the reply carries the counter whose movement is the whole proof');

  // A request that never returns is the actual production failure: the socket accepts writes and answers nothing.
  const deaf = { connected: true, invoke: () => { harness.advance(4_000); return new Promise(() => {}); } };
  // The probe's own deadline timer is unref'd - deliberately, because a watchdog must never be the reason a
  // process cannot exit - so a test that waits on it has to hold the loop open itself.
  const holdTheLoopOpen = setTimeout(() => {}, 120);
  const stalled = await harness.listener.probeUpdateStream(deaf, { deadlineMs: 20 });
  clearTimeout(holdTheLoopOpen);
  assert.deepEqual({ alive: stalled.alive, state: stalled.state }, { alive: false, state: 'dead' }, 'a probe that times out is a dead stream, and the bound is what makes it safe to ask');
  assert.equal(stalled.ms, 4_000, 'the wait it spent is reported on the session clock, so a log line can say how long the socket took to fail to answer');

  const rejected = { connected: true, invoke: async () => { throw new Error('Cannot send requests while disconnected'); } };
  assert.equal((await harness.listener.probeUpdateStream(rejected)).state, 'dead', 'a socket that answers with an error is exactly as deaf as one that answers with nothing');

  assert.equal((await harness.listener.probeUpdateStream({ connected: false })).state, 'no-socket', 'a session with no transport is not a mystery, it is a reconnect');
  const unaskable = { connected: true };
  const unknown = await harness.listener.probeUpdateStream(unaskable);
  assert.equal(unknown.state, 'unknown');
  assert.equal(unknown.alive, true, 'a library this build cannot interrogate is never a reason to tear a working listener down');
});

test('a session is suspect on silence alone, and only on silence', async () => {
  const harness = makeHarness();
  // No traffic and no attach: there is nothing to conclude, and a watchdog that acts on that would tear down
  // every session between the connect and the first message.
  harness.clients.set('never-listened', { client: harness.client, handler: () => {}, stats: harness.listener.EMPTY_STATS() });
  const cold = harness.listener.streamHealth('never-listened');
  assert.equal(cold.silenceMs, null, 'a session that has never received anything has no silence to measure');
  assert.equal(cold.suspect, false);

  await harness.listener.startTelegramListener(USER_ID, harness.client);
  await dispatch(harness, new Api.UpdateNewChannelMessage({ message: channelMessage({ id: 500 }), pts: 20, seq: 0 }));

  let health = harness.listener.streamHealth(USER_ID);
  assert.equal(health.listening, true, 'connected, attached, handler in GramJS own list: the state that used to be the whole answer');
  assert.equal(health.silenceMs, 0, 'silence is measured from when the last update reached us; how stale that update was is the separate number below');
  assert.equal(health.lastDelayMs, 60_000, 'and the lag between the channel posting and us hearing about it is kept beside it, because that pair is the whole diagnosis');
  assert.equal(health.suspect, false, 'a minute of nothing on a scalping channel is a quiet channel, and it is not probed on every sweep');

  harness.advance(20 * 60_000);
  health = harness.listener.streamHealth(USER_ID);
  assert.equal(health.suspect, true, 'twenty silent minutes while everything claims to be listening is the half-deaf state, and it now has to be asked out loud instead of shown in a panel fifteen minutes later');
  assert.ok(health.catchUpOverdue, 'a session this quiet is also due for the channel to be asked what it has');

  // A message arriving is the cure: the suspicion is a clock, not a latch.
  await dispatch(harness, new Api.UpdateNewChannelMessage({ message: channelMessage({ id: 501 }), pts: 21, seq: 0 }));
  const healed = harness.listener.streamHealth(USER_ID);
  assert.equal(healed.suspect, false, 'and it clears the moment the stream speaks again');
  assert.equal(healed.silenceMs, 0);
});

test('the periodic cross-check is bounded on both sides and does not fire the fleet in one second', async () => {
  const harness = makeReplayHarness({ messages: [], catchUpCooldownMs: 60_000 });
  const client = harness.clients.get(USER_ID).client;
  // Chosen because its per-workspace offset is 55 s from USER_ID's, which is what the assertion below needs.
  const OTHER = '2036a3d3-0671-4cbf-9728-e5e3bf1eea9b';
  harness.clients.set(OTHER, { client, handler: () => {}, stats: harness.listener.EMPTY_STATS() });
  assert.equal((await harness.listener.runCatchUp(USER_ID)).ran, true, 'both workspaces looked at the channel in the same second');
  assert.equal((await harness.listener.runCatchUp(OTHER)).ran, true);

  const firstDue = new Map();
  for (let step = 0; step < 60 && firstDue.size < 2; step += 1) {
    harness.advance(5_000);
    for (const userId of [USER_ID, OTHER]) {
      if (!firstDue.has(userId) && harness.listener.streamHealth(userId).catchUpOverdue) firstDue.set(userId, (step + 1) * 5_000);
    }
  }

  assert.equal(firstDue.size, 2, 'a quiet-but-healthy session is cross-checked eventually, on a schedule, for every workspace');
  for (const [userId, due] of firstDue) {
    assert.ok(due >= GAP_CATCH_UP_MS, `${userId} was cross-checked before the gap had elapsed, which is how a replay becomes polling`);
    assert.ok(due <= GAP_CATCH_UP_MS + GAP_CATCH_UP_SPREAD_MS + 5_000, `${userId} went longer than the gap plus its stagger without being asked, which is how a missed message stays missed`);
  }
  assert.notEqual(firstDue.get(USER_ID), firstDue.get(OTHER), 'two workspaces that caught up in the same second do not ask the channel in the same second: the spread is what keeps a fleet-wide sweep from being one request storm');
});

test('the catch-up window is a minute, not five, so a missed message is replayed inside the trade rather than after it', async () => {
  // The harness is driven with the production constant rather than a number of its own, so that changing the
  // window in the service is a test failure here and not a quiet divergence.
  assert.equal(CATCH_UP_COOLDOWN_MS, 60_000, 'one minute: five was chosen when a replay was a courtesy to a busy API, and it became the length of a signal delay');
  const harness = makeReplayHarness({ messages: [12], catchUpCooldownMs: CATCH_UP_COOLDOWN_MS });
  const first = await harness.listener.runCatchUp(USER_ID);
  assert.deepEqual({ ran: first.ran, stored: first.stored }, { ran: true, stored: 1 });
  const blocked = await harness.listener.runCatchUp(USER_ID);
  assert.deepEqual({ ran: blocked.ran, reason: blocked.reason }, { ran: false, reason: 'COOLDOWN' }, 'back-to-back recoveries are still rate limited, so a rebuild cannot hammer Telegram');
  harness.advance(70_000);
  const again = await harness.listener.runCatchUp(USER_ID);
  assert.equal(again.ran, true, 'and the wait is one minute: a five-minute throttle in front of a two-minute signal is the difference between a trade and a miss');
});

test('an update that arrives late is written down as late, at the moment it arrives', async () => {
  const harness = makeHarness();
  await harness.listener.startTelegramListener(USER_ID, harness.client);
  await dispatch(harness, new Api.UpdateNewChannelMessage({ message: channelMessage({ id: 501 }), pts: 21, seq: 0 }));
  assert.equal(harness.logs.some((entry) => entry.message === 'Telegram update arrived late'), false,
    'a minute of travel on a signal that is dead at two is normal delivery, and crying about it would bury the alarms that matter');
  assert.equal(harness.entry().stats.lastDelayMs, 60_000, 'it is still measured, so the trend is visible without reading a log line');
  assert.equal(harness.entry().stats.lastSentAt, '2026-10-23T12:59:00.000Z', 'from the channel clock, not from ours');

  // The lateness rides on the line that proves the row exists, so one entry answers "did we get it" and "how
  // late was it" together - which is the comparison an operator makes in the log viewer, once, per message.
  const firstLine = harness.logs.find((entry) => entry.message === 'Telegram message captured');
  assert.ok(firstLine, 'the capture is still announced the same way');
  assert.equal(firstLine.meta.delayMs, 60_000);
  assert.equal(firstLine.meta.sentAt, '2026-10-23T12:59:00.000Z');

  // Ten more silent minutes, and the next message out of the fixture carries the same send date: eleven
  // minutes of travel, which is the number the incident report was about.
  harness.advance(10 * 60_000);
  await dispatch(harness, new Api.UpdateNewChannelMessage({ message: channelMessage({ id: 502 }), pts: 22, seq: 0 }));
  const late = harness.logs.find((entry) => entry.message === 'Telegram update arrived late');
  assert.ok(late, 'this is the line that turns "the bot feels slow" into an interval an operator can be held to');
  assert.equal(late.level, 'warn', 'and it is a warning, because a late signal is a signal nobody traded');
  assert.equal(late.meta.userId, USER_ID);
  assert.equal(late.meta.delayMs, 11 * 60_000);
  assert.equal(harness.entry().stats.lastDelayMs, 11 * 60_000);

  const summary = harness.listener.telegramFleetSummary();
  const session = summary.sessions.find((item) => item.userId === USER_ID);
  assert.equal(session.lastDelayMs, 11 * 60_000, 'the panel shows the worst lag in the fleet, not only the count of messages');
  assert.equal(summary.maxDelayMs, 11 * 60_000);
});

test('a handler that had to be put back asks the channel what it missed, even after a session that was already talking', async () => {
  const harness = makeHarness();
  await harness.listener.startTelegramListener(USER_ID, harness.client);
  await dispatch(harness, new Api.UpdateNewChannelMessage({ message: channelMessage({ id: 503 }), pts: 23, seq: 0 }));
  // The state a session reaches once its boot replay has finished: caught up, and full of history.
  harness.entry().needsCatchUp = false;

  // The detach itself, done the way the library does it: the callback leaves `_eventBuilders`, and our own
  // bookkeeping is what is left pointing at a function nothing will ever call.
  harness.client.removeEventHandler(harness.entry().handler, new NewMessage({}));
  assert.equal(harness.listener.handlerIsLive(harness.client, harness.entry().handler), false, 'the handler is off the socket, which is the entire failure');
  assert.ok(harness.entry().stats.lastAt, 'the session had already seen a message - the case the old flag rule excluded');
  await harness.listener.startTelegramListener(USER_ID, harness.client);
  assert.equal(harness.entry().needsCatchUp, true,
    'so a re-attach is still a recovery: a handler that was off the socket for any length of time has to ask what happened while it was off');
  assert.ok(Number.isFinite(Date.parse(harness.entry().attachedAt)), 'and the moment it went back on is recorded, so the summary can say how long a listener has really been up');
  assert.ok(harness.logs.some((entry) => entry.message === 'Telegram capture handler attached'),
    'the attach itself is logged, which is what a report is quoted from when someone asks whether the listener was ever there');
});

/* --------------------------------------------------------------------------- *
 * The heartbeat.
 *
 * `MTProtoSender` in this version of GramJS has no keep-alive: while a monitored channel is quiet, the client
 * sends nothing at all, and a NAT that evicts idle flows - which is what a sleeping host's network does to a
 * free service - can leave a connection that accepts writes and answers none. No error reaches `autoReconnect`,
 * because no request is ever made, so the socket stays `connected === true` forever and every message arrives by
 * replay instead of by push. The beat fixes the first half (an outbound packet every 30 seconds keeps the flow
 * registered) and settles the second half with a number rather than a guess: the account's own `pts` moving
 * while `stats.seen` does not is proof that updates are being produced and not delivered, which is the one
 * distinction a silence clock cannot make.
 * --------------------------------------------------------------------------- */

function makeBeatHarness({ pts = () => 100, mode = 'alive', stats = null, ...overrides } = {}) {
  const clients = new Map();
  const logs = [];
  const rebuilt = [];
  let clock = Date.parse('2026-10-23T13:00:00.000Z');
  let beatIndex = 0;
  const listener = createTelegramListener({
    clients,
    pool: makePool(),
    log: (level, message, meta) => logs.push({ level, message, meta }),
    saveSignal: async () => ({ id: 'signal-1' }),
    now: () => clock,
    onDeadStream: async (userId, reason, { force = false } = {}) => { rebuilt.push({ userId, reason, forced: force === true }); },
    // The production constants, not numbers of the test's own: the cadence and the reconnect cooldown are the
    // two things an operator can legitimately change, and a test that pinned a copy of them would survive the
    // change silently.
    heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
    rebuildCooldownMs: STREAM_REBUILD_COOLDOWN_MS,
    ...overrides,
  });
  const invoke = mode === 'alive'
    ? async () => ({ pts: BigInt(pts(beatIndex)) })
    : mode === 'hang'
      ? () => new Promise(() => {})
      : async () => { throw new Error('Cannot send requests while disconnected'); };
  const client = { connected: true, invoke, addEventHandler() {}, removeEventHandler() {}, listEventHandlers: () => [{}, () => {}] };
  clients.set(USER_ID, { client, handler: () => {}, stats: stats || listener.EMPTY_STATS(), attachedAt: new Date(clock).toISOString() });
  return {
    clients, client, logs, rebuilt, listener,
    /** One 30-second cycle, and the clock advance that goes with it (the first cycle runs at the current time). */
    async cycle() { beatIndex += 1; const result = await listener.beatUpdateStreams({ reason: 'test' }); clock += 30_000; return result; },
    advance: (ms) => { clock += ms; },
    entry: () => clients.get(USER_ID),
    stats: () => clients.get(USER_ID).stats,
  };
}

test('the heartbeat asks every connected session on its own clock, not when the last message arrived', async () => {
  const harness = makeBeatHarness();
  // Traffic five seconds ago: the silence threshold from the previous change would not even have looked.
  harness.entry().stats.lastAt = new Date(Date.parse('2026-10-23T12:59:55.000Z').valueOf()).toISOString();
  assert.equal(harness.listener.streamHealth(USER_ID).suspect, false, 'the session is not suspicious by silence at all');

  let asked = 0;
  harness.client.invoke = async () => { asked += 1; return { pts: 100n }; };
  const cycle = await harness.cycle();
  assert.equal(asked, 1, 'and it is still asked a question, because the point is the packet as much as the answer');
  assert.deepEqual({ sent: cycle.sent, answered: cycle.answered, dead: cycle.dead, stalled: cycle.stalled }, { sent: 1, answered: 1, dead: 0, stalled: 0 });
  assert.ok(harness.logs.some((entry) => entry.message === 'Telegram heartbeat sent'), 'the line an operator greps to prove the watchdog is alive');
  assert.equal(harness.rebuilt.length, 0, 'a session that answers is left alone');
});

test('a beat that is not answered reconnects immediately, and the beat is what noticed', async () => {
  const harness = makeBeatHarness({ mode: 'error' });
  const cycle = await harness.cycle();
  assert.equal(cycle.dead, 1, 'a request that errors is a dead stream, not a slow network');
  assert.ok(harness.logs.some((entry) => entry.message === 'Telegram heartbeat sent' && entry.level === 'warn'), 'the cycle is a warning when it found a corpse');
  await new Promise((resolve) => { setImmediate(resolve); });
  assert.deepEqual(harness.rebuilt, [{ userId: USER_ID, reason: 'heartbeat-no-answer', forced: false }], 'and the reconnect is requested on the spot rather than at the next sweep');

  // The unresponsive socket - the shape Render's NAT actually leaves behind: writes succeed, nothing returns.
  const hung = makeBeatHarness({ mode: 'hang' });
  const hungProbe = hung.listener.beatUpdateStreams({ reason: 'test' });
  const holdTheLoopOpen = setTimeout(() => {}, 8_000);
  const hungCycle = await hungProbe;
  clearTimeout(holdTheLoopOpen);
  assert.equal(hungCycle.dead, 1, 'a probe that times out counts as dead in the same way');
  await new Promise((resolve) => { setImmediate(resolve); });
  assert.equal(hung.rebuilt.length, 1, 'and it reconnects too, because the alternative is to keep a listener nobody is answering');
});

test('a moving pts with a quiet handler is a dead update loop, and it is rebuilt after two beats', async () => {
  const harness = makeBeatHarness({ pts: (index) => 100 + index });
  await harness.cycle();          // first beat: no previous answer to compare with, so nothing can be concluded
  assert.equal(harness.rebuilt.length, 0, 'the first beat only sets the baseline');
  await harness.cycle();          // pts moved, handler silent: one suspicion
  assert.equal(harness.rebuilt.length, 0, 'one beat of disagreement is not a verdict - an edit or a service message moves pts without being a NewMessage');
  const stalls = harness.listener.streamBeatFor(USER_ID).stalls;
  assert.equal(stalls, 1);
  await harness.cycle();          // and the second one is
  await new Promise((resolve) => { setImmediate(resolve); });
  assert.deepEqual(harness.rebuilt, [{ userId: USER_ID, reason: 'update-stream-stalled', forced: false }], 'two beats of "Telegram produced updates we never saw" is the one proof that a live socket and a dead listener can be told apart');

  // The same movement, delivered: nothing to fix.
  const healthy = makeBeatHarness({ pts: (index) => 100 + index });
  await healthy.cycle();
  await healthy.cycle();
  healthy.entry().stats.seen = 1;   // the handler saw what the server counted
  await healthy.cycle();
  await healthy.cycle();
  assert.equal(healthy.rebuilt.length, 0, 'and the rule is a comparison, not a suspicion of quietness');
});

test('a quiet channel is not a fault: no pts movement, no rebuild, ever', async () => {
  const harness = makeBeatHarness({ pts: () => 42 });
  for (let index = 0; index < 6; index += 1) await harness.cycle();   // three minutes of nothing
  await new Promise((resolve) => { setImmediate(resolve); });
  assert.equal(harness.rebuilt.length, 0, 'a workspace whose channel has not posted for an hour must not be reconnected once a minute');
  assert.equal(harness.logs.filter((entry) => entry.message === 'Telegram heartbeat sent').length, 6, 'but it must still be beaten, and said so, every cycle');
});

test('a rebuild is one rebuild: the cooldown outlives every detector', async () => {
  // One minute is how often the socket is asked; two minutes is how often it may be rebuilt for the answer.
  assert.equal(HEARTBEAT_INTERVAL_MS, 30_000, 'the beat is the keep-alive, so its period is the idle window it has to stay inside');
  assert.equal(STREAM_REBUILD_COOLDOWN_MS, 2 * 60_000, 'and the cooldown is strictly longer than it, or a broken stream is reconnected on every beat');
  const harness = makeBeatHarness({ mode: 'error' });
  await harness.cycle();
  await new Promise((resolve) => { setImmediate(resolve); });
  assert.equal(harness.rebuilt.length, 1);
  await harness.cycle();
  await harness.cycle();
  await new Promise((resolve) => { setImmediate(resolve); });
  assert.equal(harness.rebuilt.length, 1, 'the socket is still dead, and the watchdog is still shouting, but a reconnect loop is a worse outage than a deaf stream');
  assert.ok(harness.logs.some((entry) => entry.message === 'Telegram stream rebuild already cooling down'), 'the suppression is written down, so a silent watchdog is never mistaken for a working one');
  assert.equal(harness.listener.heartbeatSummary().suppressed, 2);
  harness.advance(STREAM_REBUILD_COOLDOWN_MS + 1_000);
  await harness.cycle();
  await new Promise((resolve) => { setImmediate(resolve); });
  assert.equal(harness.rebuilt.length, 2, 'and once the window passes, the same dead socket is rebuilt again');
});

test('the heartbeat reports itself in counts, and the per-session detail stays off the public route', async () => {
  const harness = makeBeatHarness();
  await harness.cycle();
  const summary = harness.listener.heartbeatSummary();
  assert.equal(summary.cycles, 1);
  assert.equal(summary.answered, 1);
  assert.equal(summary.intervalMs, 30_000);
  assert.equal(summary.stale, false, 'the last cycle is half a minute old at most, which is the promise');
  assert.equal(summary.beats.length, 1, 'the per-session beat is on the admin summary');
  assert.equal(harness.listener.telegramFleetSummary().sessions[0].beatPts, 100, 'and each session carries its own counter, so "pts moved, nothing arrived" is visible per workspace');
});

test('a replay that finds a message posted while the handler was attached is evidence against the stream, not a recovery', async () => {
  const rebuilt = [];
  const clients = new Map();
  const logs = [];
  let clock = Date.parse('2026-10-23T13:00:00.000Z');
  const pool = makePool();
  const listener = createTelegramListener({
    clients, pool, log: (level, message, meta) => logs.push({ level, message, meta }),
    now: () => clock,
    saveSignal: async () => ({ id: 'signal-1' }),
    onDeadStream: async (userId, reason) => { rebuilt.push({ userId, reason }); },
  });
  const client = {
    connected: true, getEntity: async () => ({ id: 1 }),
    // The channel's newest post is dated after the attach, which is the definition of "we were listening and
    // it never arrived": the silence clock cannot see this, because another channel keeps `lastAt` fresh.
    getMessages: async () => [new Api.Message({ id: 5, peerId: new Api.PeerChannel({ channelId: BigInt(BARE_CHANNEL_ID) }), date: Math.floor((clock + 60_000) / 1000), message: SIGNAL_TEXT, out: false, mentioned: false, mediaUnstable: false, mediaUnread: false, unread: false, post: false })],
  };
  clients.set(USER_ID, { client, handler: () => {}, stats: listener.EMPTY_STATS(), attachedAt: new Date(clock).toISOString() });

  const outcome = await listener.runCatchUp(USER_ID);
  await new Promise((resolve) => { setImmediate(resolve); });
  assert.equal(outcome.stored, 1);
  assert.equal(outcome.fresh, 1, 'the pass reports what it had no business finding');
  assert.deepEqual(rebuilt, [{ userId: USER_ID, reason: 'message-missed-while-listening' }], 'and asks for a rebuild on the spot');
  assert.ok(logs.some((entry) => entry.message === 'Telegram replay found messages posted while the handler was attached'));

  // The boot case: the same message dated *before* the attach is simply history we were asleep through. The
  // clock moves past the replay cooldown first, because this is a second, separate recovery and not a retry of
  // the one above.
  rebuilt.length = 0;
  clock += 61_000;
  clients.set(USER_ID, { client: { ...client, getMessages: async () => [new Api.Message({ id: 5, peerId: new Api.PeerChannel({ channelId: BigInt(BARE_CHANNEL_ID) }), date: Math.floor((clock - 3_600_000) / 1000), message: SIGNAL_TEXT, out: false, mentioned: false, mediaUnstable: false, mediaUnread: false, unread: false, post: false })] }, handler: () => {}, stats: listener.EMPTY_STATS(), attachedAt: new Date(clock).toISOString() });
  pool.known.clear();
  const second = await listener.runCatchUp(USER_ID);
  await new Promise((resolve) => { setImmediate(resolve); });
  assert.equal(second.stored, 1, 'the backlog is still stored');
  assert.equal(second.fresh, 0, 'and it is still called a backlog');
  assert.equal(rebuilt.length, 0, 'an outage that ended before the attach is not a broken stream');
});

test('one cycle beats a fleet in bounded chunks, so a bigger workspace cannot become a request storm', async () => {
  const harness = makeBeatHarness();
  let open = 0;
  let maxOpen = 0;
  const shared = { connected: true, addEventHandler() {}, removeEventHandler() {}, listEventHandlers: () => [{}, () => {}] };
  shared.invoke = async () => {
    open += 1;
    maxOpen = Math.max(maxOpen, open);
    await new Promise((resolve) => { setImmediate(resolve); });
    open -= 1;
    return { pts: 100n };
  };
  for (let index = 0; index < 20; index += 1) harness.clients.set(`user-${index}`, { client: shared, handler: () => {}, stats: harness.listener.EMPTY_STATS() });

  const cycle = await harness.cycle();
  assert.equal(cycle.sessions, 21, 'the harness session plus twenty more');
  assert.equal(cycle.answered, 21, 'and every one of them was asked');
  assert.ok(maxOpen <= 8, `at most eight requests are open in one tick, saw ${maxOpen}`);
  assert.ok(maxOpen >= 2, 'and they are genuinely concurrent rather than serialised one by one');
});

test('a rebuild is not mistaken for a stalled handler, because the new session starts from zero', async () => {
  // `restoreTelegramClient` replaces the entry with fresh `stats`, so `seen` goes backwards on purpose. A
  // watchdog that read that as silence would reconnect every session it had ever rebuilt, forever.
  const harness = makeBeatHarness({ pts: (index) => 100 + index });
  await harness.cycle();                                  // baseline: pts 100, seen 0
  await harness.cycle();                                  // pts moved, handler silent -> one suspicion
  assert.equal(harness.listener.streamBeatFor(USER_ID).stalls, 1, 'first, the case that is a stall: pts moved and nothing arrived');
  await new Promise((resolve) => { setImmediate(resolve); });
  assert.equal(harness.rebuilt.length, 0, 'one beat of it is not yet a verdict');

  harness.entry().stats.seen = 5;                         // the session recovered and delivered updates
  await harness.cycle();                                  // pts 102 with movement: no suspicion at all
  assert.equal(harness.listener.streamBeatFor(USER_ID).stalls, 0, 'a delivered update clears the count');
  harness.entry().stats.seen = 0;                         // and now the session is rebuilt, so its counters restart
  await harness.cycle();
  await new Promise((resolve) => { setImmediate(resolve); });
  assert.equal(harness.listener.streamBeatFor(USER_ID).stalls, 0, 'a counter going backwards is a new session, not a deaf one');
  assert.equal(harness.rebuilt.length, 0, 'and no rebuild is requested for it');
});

test('the cooldown protects Telegram from the watchdog, and never from a person', async () => {
  const harness = makeBeatHarness({ mode: 'error' });
  await harness.cycle();
  await new Promise((resolve) => { setImmediate(resolve); });
  assert.equal(harness.rebuilt.length, 1, 'the first failure reconnects');
  assert.deepEqual(harness.rebuilt[0], { userId: USER_ID, reason: 'heartbeat-no-answer', forced: false }, 'and the automatic path says plainly that it is not forcing anything');

  await harness.cycle();
  await new Promise((resolve) => { setImmediate(resolve); });
  assert.equal(harness.rebuilt.length, 1, 'the same session inside the window is left to the rebuild already in progress');

  // The manual route's call, one level up in index.js: `force: true`, and nothing else about the beat changes.
  assert.equal(harness.listener.requestStreamRebuild(USER_ID, 'manual-reconnect', { force: true }), true,
    'an operator who has read the counters is not refused by a throttle designed for a machine that might be wrong');
  await new Promise((resolve) => { setImmediate(resolve); });
  assert.deepEqual(harness.rebuilt[1], { userId: USER_ID, reason: 'manual-reconnect', forced: true });
  assert.equal(harness.listener.heartbeatSummary().suppressed, 1, 'the suppressed attempt is counted, so "the button worked but the watchdog was already shouting" is one number');
});

test('a session that was just rebuilt starts its own clock, and its throttle with it', async () => {
  const harness = makeBeatHarness({ pts: (index) => 101 + index });
  harness.entry().stats.seen = 4;
  await harness.cycle();                                   // first beat: pts 102, seen 4 -> the baseline
  assert.equal(harness.listener.streamBeatFor(USER_ID).pts, 102, 'the beat keeps what it will compare the next answer against');

  // What `restoreTelegramClient` now does on every rebuild, automatic or forced: new entry, empty stats, and
  // `resetStreamBaseline`, which drops both the comparison baseline and the rebuild throttle the old session
  // earned. The first is defence against accusing a new session of its predecessor's silence; the second is why
  // an operator pressing the button is not told to wait two minutes, twice.
  harness.entry().stats = harness.listener.EMPTY_STATS();
  assert.deepEqual(harness.listener.resetStreamBaseline(USER_ID), { cleared: 1 });
  assert.equal(harness.listener.streamBeatFor(USER_ID), null, 'the old lifetime is not compared with the new one');

  await harness.cycle();                                   // pts moved, `seen` legitimately back to zero
  await new Promise((resolve) => { setImmediate(resolve); });
  assert.equal(harness.rebuilt.length, 0, 'and a single beat after a rebuild is not a verdict');
  assert.ok(harness.listener.streamBeatFor(USER_ID).stalls <= 1, 'at most one suspicion, retaken from the new baseline');

  // The throttle half, which is the part a person feels.
  const throttled = makeBeatHarness({ mode: 'error' });
  await throttled.cycle();
  await new Promise((resolve) => { setImmediate(resolve); });
  await throttled.cycle();
  await new Promise((resolve) => { setImmediate(resolve); });
  assert.equal(throttled.rebuilt.length, 1, 'the watchdog is throttled inside the window, as designed');
  throttled.listener.resetStreamBaseline(USER_ID);
  assert.equal(throttled.listener.requestStreamRebuild(USER_ID, 'manual-reconnect'), true,
    'and a rebuild that was asked for by hand clears that window, because the operator is not the risk the cooldown was written against');
});

/* ---------------------------------------------------------------------------
 * THE UPDATE STATE. A session is only pushed to while the account believes it is current, and GramJS 2.26.22
 * never reconciles anything: `session.processUpdates` is commented out in `_handleUpdate`, `catchUp()` is an
 * empty stub, and its own three `updates.GetState` calls discard the answer. So `pts` is tracked here, against
 * the number the beat already asks for, and a gap the handler has not consumed is closed with
 * `updates.GetDifference` - the request the library does not make - before anything is torn down.
 *
 * These tests are the difference between "the heartbeat logs a number" and "the heartbeat does something about
 * it": a fake Telegram that answers GetState, records what a difference request was sent with, and reports each
 * of the four shapes the answer can take.
 * --------------------------------------------------------------------------- */

const GET_STATE = 'updates.GetState';
const GET_DIFFERENCE = 'updates.GetDifference';

function makeStateHarness({ serverPts = () => 4200, difference = null, ...overrides } = {}) {
  const rebuilt = [];
  const harness = makeBeatHarness({
    ...overrides,
    onDeadStream: async (userId, reason, { force = false, escalate = false } = {}) => {
      rebuilt.push({ userId, reason, forced: force === true, escalated: escalate === true });
    },
  });
  const asked = [];
  harness.client.invoke = async (request) => {
    asked.push(request);
    if (request.className === GET_STATE) {
      // Zero-based: the first beat a session is asked is beat 0, which is how the fixtures read.
      const beat = Math.max(0, asked.filter((entry) => entry.className === GET_STATE).length - 1);
      return { pts: BigInt(serverPts(beat)), qts: 11n, date: 1_760_000_000, count: 3 };
    }
    if (request.className === GET_DIFFERENCE) {
      /* A fixture may answer by call number rather than by a fixed object: `updates.differenceSlice` only makes
         sense as a *sequence*, and a refusal that arrives on the second request is a different bug from one that
         arrives on the first. The number is 1-based across the whole harness. */
      harness.differenceAsked = (harness.differenceAsked || 0) + 1;
      const answer = typeof difference === 'function' ? difference(request, harness.differenceAsked) : difference;
      if (answer instanceof Error) throw answer;
      return answer ?? { className: 'updates.differenceEmpty', newMessages: [], pts: 4200n, currentDate: 1_760_000_000 };
    }
    throw new Error(`the listener should not send ${request.className} here`);
  };
  return { ...harness, asked, rebuilt, states: () => asked.filter((entry) => entry.className === GET_STATE), differences: () => asked.filter((entry) => entry.className === GET_DIFFERENCE) };
}

test('a first beat adopts the account state, and says so instead of claiming a gap it cannot measure', async () => {
  const harness = makeStateHarness();
  assert.equal(harness.listener.readUpdateState(harness.client), null, 'a session that has never been asked has no state');
  await harness.cycle();
  assert.deepEqual({ pts: harness.listener.streamBeatFor(USER_ID).pts, action: harness.listener.streamBeatFor(USER_ID).action }, { pts: 4200, action: 'state-adopted' });
  assert.equal(harness.listener.readUpdateState(harness.client).pts, 4200, 'and the number is now held on the client that earned it');
  assert.equal(harness.differences().length, 0, 'no difference request, because asking from `pts = 0` requests the account history and is always refused');
  assert.ok(harness.logs.some((entry) => entry.message === 'Telegram update state adopted'), 'the adoption is a line in the log, not a silent write');
});

test('a healthy session is reconciled from the beat it already made, at no extra cost', async () => {
  const harness = makeStateHarness({ serverPts: (index) => 4200 + index * 10 });
  await harness.cycle();   // 4210, adopted
  harness.entry().stats.seen = 1;   // and the handler was shown what arrived
  await harness.cycle();   // 4220, gap of 10 - consumed, so adopted
  assert.equal(harness.states().length, 2, 'one GetState per beat, and only the one the beat was going to send anyway');
  assert.equal(harness.differences().length, 0, 'a gap the handler covered is not a fault, and a difference request per beat for every healthy session would be a request for nothing');
  assert.equal(harness.listener.readUpdateState(harness.client).pts, 4210, 'the state tracks reality while updates flow');
  assert.equal(harness.rebuilt.length, 0, 'and nothing is torn down');
});

test('a gap the handler never consumed is closed with GetDifference, sent with this session’s own pts', async () => {
  const messages = [channelMessage({ id: 91 }), channelMessage({ id: 92 })];
  const harness = makeStateHarness({
    serverPts: (index) => (index === 0 ? 4200 : 4260),
    difference: { className: 'updates.difference', newMessages: messages, otherUpdates: [], state: { pts: 4260n, qts: 12n, date: 1_760_000_600, count: 5 } },
  });
  await harness.cycle();                                  // 4200 adopted, nothing to compare yet
  assert.equal(harness.listener.readUpdateState(harness.client).pts, 4200);
  await harness.cycle();                                  // 4260, silent handler: the gap is real
  const difference = harness.differences()[0];
  assert.ok(difference, 'the request the library never makes is made here');
  assert.equal(Number(difference.pts), 4200, 'with where WE are, not where the account is - the server answers a difference request relative to the pts it was given');
  assert.equal(Number(difference.qts), 11, 'qts carried from the last answer');
  assert.equal(Number(difference.date), 1_760_000_000);
  const beat = harness.listener.streamBeatFor(USER_ID);
  assert.equal(beat.action, 'difference-applied');
  assert.equal(beat.gap, 60, 'the size of the hole is on the record');
  assert.equal(harness.listener.readUpdateState(harness.client).pts, 4260, 'and the state moves to what the answer said, so the next beat is not accused of the same gap');
  assert.equal(harness.entry().needsCatchUp, true, 'the missed messages themselves go to the catch-up, which dedupes against `signals` and budgets itself');
  assert.equal(harness.logs.filter((entry) => entry.message.includes('captured')).length, 0, 'a resync never writes a row, so a `replayed: false` capture stays proof of a real push');
});

test('a difference Telegram will not compute is the one case that forces a rebuild past the cooldown', async () => {
  const harness = makeStateHarness({
    serverPts: (index) => (index === 0 ? 4200 : 94200),
    difference: { className: 'updates.differenceTooLong', pts: 94200n },
  });
  await harness.cycle();
  await harness.cycle();
  await new Promise((resolve) => { setImmediate(resolve); });
  assert.deepEqual(harness.rebuilt, [{ userId: USER_ID, reason: 'update-state-too-far-behind', forced: true, escalated: false }],
    'the server has said the state is unrecoverable; waiting two minutes to act on that is only a longer outage');
  assert.ok(harness.logs.some((entry) => entry.message === 'Telegram update state reconciled' && entry.meta.action === 'too-long'), 'and the log says which answer it acted on');
});

test('a static pts while the sweep keeps storing messages is a deaf stream, and it is named', async () => {
  // The signature the user sees: nothing is ever pushed, `updates.GetState` reports no change, and the gap
  // sweep goes to the channel and comes back with messages every time.
  const harness = makeStateHarness({ serverPts: () => 4200 });
  await harness.cycle();                                   // adopts 4200
  const stats = harness.entry().stats;
  stats.catchUpSaved = 1;                                  // the sweep stored one
  await harness.cycle();                                   // pts unchanged, sweep found something: deaf, once
  assert.equal(harness.listener.streamBeatFor(USER_ID).deaf, 1, 'counted, not concluded');
  assert.equal(harness.differences().length, 1, 'and the cheap repair is tried first even with no measurable gap - "nothing to send you" from an account with new messages is the answer we need in the log');
  assert.equal(harness.rebuilt.length, 0, 'one beat of it is not a verdict');
  stats.catchUpSaved = 2;
  await harness.cycle();
  await new Promise((resolve) => { setImmediate(resolve); });
  assert.deepEqual(harness.rebuilt, [{ userId: USER_ID, reason: 'deaf-stream-pts-static', forced: false, escalated: true }],
    'twice in a row is the proof: the session has to be new, because the socket is already fine');
  assert.equal(harness.listener.streamBeatFor(USER_ID).action, 'difference-empty', 'the server insisting we are current is in the same record as the verdict');

  // The counter-example the whole design hangs on: a quiet channel with a quiet sweep is not a fault.
  const quiet = makeStateHarness({ serverPts: () => 4200 });
  await quiet.cycle();
  await quiet.cycle();
  await quiet.cycle();
  assert.deepEqual(quiet.rebuilt, [], 'nothing moved, nothing was found, nothing was rebuilt');
});

test('every beat logs the numbers the decision was made from, in one debug line', async () => {
  const harness = makeStateHarness({ serverPts: (index) => 4200 + index });
  await harness.cycle();
  await harness.cycle();
  const lines = harness.logs.filter((entry) => entry.message === 'Telegram heartbeat beat');
  assert.equal(lines.length, 2, 'one per session per beat, at debug level so production stays readable');
  const last = lines[lines.length - 1].meta;
  assert.deepEqual({ pts: last.pts, ptsDelta: last.ptsDelta, seen: last.seen, catchUpSaved: last.catchUpSaved }, { pts: 4201, ptsDelta: 1, seen: 0, catchUpSaved: 0 });
  assert.equal(last.statePts, 4200, 'the account’s number and this session’s reconciled number, side by side: a moving first and a still second is the diagnosis');
  assert.equal(typeof last.gap, 'number');
  assert.ok(Number.isFinite(last.ms) && Number.isFinite(last.listeningMs), 'how long the question took, and how long this handler has been attached');
});

test('the fleet summary carries the state, so the panel can answer "deaf or quiet" without a log search', async () => {
  // 100 updates the account had produced and the handler had not been shown, with a server that says there is
  // nothing to send: the numbers on the panel are the whole story, and the action says which of the two it was.
  const harness = makeStateHarness({ serverPts: (index) => (index === 0 ? 4200 : 4300) });
  await harness.cycle();
  await harness.cycle();
  const [session] = harness.listener.telegramFleetSummary().sessions;
  assert.deepEqual({ beatPts: session.beatPts, beatStatePts: session.beatStatePts, beatGap: session.beatGap, beatDeaf: session.beatDeaf, beatAction: session.beatAction },
    { beatPts: 4300, beatStatePts: 4300, beatGap: 100, beatDeaf: 0, beatAction: 'difference-empty' });
  const summary = harness.listener.heartbeatSummary();
  assert.equal(summary.resynced, 1, 'the cycle counters that say a repair was attempted, separately from one that says a session was rebuilt');
  assert.equal(summary.gaps, 100);
  assert.deepEqual({ pts: summary.beats[0].pts, statePts: summary.beats[0].statePts, action: summary.beats[0].action, deaf: summary.beats[0].deaf }, { pts: 4300, statePts: 4300, action: 'difference-empty', deaf: 0 }, 'and the per-session detail travels with it');
});

test('attaching a handler seeds the state, so a new session is never indistinguishable from a deaf one', async () => {
  const harness = makeHarness();
  const asked = [];
  harness.client.getMe = async () => ({ id: 42n });        // identity first, and it is the cheap proof the session works
  harness.client.invoke = async (request) => {
    asked.push(request.className);
    if (request.className === GET_STATE) return { pts: 777n, qts: 4n, date: 1_760_000_000, count: 1 };
    return { className: 'updates.differenceEmpty', newMessages: [], pts: 777n };
  };
  await harness.listener.startTelegramListener(USER_ID, harness.client);
  for (let index = 0; index < 4; index += 1) await new Promise((resolve) => { setImmediate(resolve); });
  assert.deepEqual(asked, [GET_STATE], 'one GetState, no history request, and no waiting for the next beat');
  assert.equal(harness.listener.readUpdateState(harness.client).pts, 777);
  assert.equal(harness.saved.length, 0, 'seeding a state stores nothing');
});

test('a resync that cannot be built is never a reason to tear a working session down', async () => {
  const harness = makeBeatHarness({ mode: 'alive' });
  harness.client.invoke = async () => { throw new Error('Cannot send requests while disconnected'); };
  const outcome = await harness.listener.resyncUpdateState(harness.client, { userId: USER_ID, reason: 'test' });
  assert.equal(outcome.action, 'failed', 'the failure is an outcome, not an exception');
  assert.match(outcome.error, /disconnected/);
  assert.ok(harness.logs.some((entry) => entry.message === 'Telegram update state could not be reconciled'), 'and it is logged, because an operator reading the panel wants to know the question was asked');
  const noClient = await harness.listener.resyncUpdateState(null, { userId: USER_ID });
  assert.equal(noClient.action, 'unavailable');
  const notConnected = await harness.listener.resyncUpdateState({ connected: false, invoke: async () => ({}) }, { userId: USER_ID });
  assert.equal(notConnected.action, 'unavailable', 'and a dead socket is answered without sending anything');
});

test('the state helpers read the shapes the library actually returns, including BigInt and Date', () => {
  assert.deepEqual(normalizeUpdateState({ pts: 42n, qts: 3n, date: 1_760_000_000, count: 2 }), { pts: 42, qts: 3, date: 1_760_000_000, count: 2 });
  assert.deepEqual(normalizeUpdateState({ pts: '9', date: new Date('2026-10-23T13:00:00.000Z') }), { pts: 9, qts: null, date: Math.floor(Date.parse('2026-10-23T13:00:00.000Z') / 1000), count: 0 }, 'a Date is Telegram’s seconds, not its milliseconds');
  assert.deepEqual(normalizeUpdateState(undefined), { pts: null, qts: null, date: null, count: 0 }, 'and no answer is no answer, not zero: a zero pts is a gap wide enough to justify a rebuild');
  assert.equal(readUpdateState({}), null, 'an object with no cache has no state');
  assert.equal(readUpdateState(null), null, 'including no object at all');
  const partial = { [UPDATE_STATE_KEY]: { pts: 10n } };
  assert.deepEqual(readUpdateState(partial), { pts: 10, qts: null, date: null, at: null }, 'a cached state missing a field is read as missing, not as zero');
  assert.equal(UPDATE_STATE_KEY, '_sdbUpdateState', 'the key is exported because the whole state lives in that one property');
});

/* ---------------------------------------------------------------------------
 * THE FIVE ANSWERS A DIFFERENCE REQUEST CAN GET. `updates.GetDifference` replies with `updates.difference`
 * (caught up), `updates.differenceSlice` (here is part of it, ask again from here), `updates.differenceEmpty`
 * (the account owes you nothing) or `updates.differenceTooLong` (the hole is wider than this API will fill) - and
 * it also *throws*, which is how Telegram answers the three cases that matter most: a channel unread for days
 * (`UPDATES_TOO_OLD`), a fleet that asked too often (`FLOOD_WAIT_n`), and a session the account has dropped
 * (`AUTH_KEY_UNREGISTERED`). GramJS raises the last two as `RPCError` subclasses and nothing in the library
 * distinguishes them, so the distinction lives here: back off, fall back, or stop.
 *
 * Each one is tested for the same three things: what the cached state ends up as, what the beat records, and what
 * is never done (a fabricated row, a reconnect against a dead key, a hammering retry against a flood limit).
 * --------------------------------------------------------------------------- */

const emptyAnswer = (pts) => ({ className: 'updates.differenceEmpty', newMessages: [], pts: BigInt(pts), currentDate: 1_760_000_000 });
const rpcError = (message, code, extra = {}) => Object.assign(new Error(message), { errorMessage: code, ...extra });

test('a differenceSlice is answered by asking again, from the state the slice just handed over', async () => {
  const slices = [
    { className: 'updates.differenceSlice', newMessages: [channelMessage({ id: 91 }), channelMessage({ id: 92 })], state: { pts: 4230n, qts: 12n, date: 1_760_000_300, count: 4 } },
    { className: 'updates.differenceSlice', newMessages: [channelMessage({ id: 93 })], state: { pts: 4250n, qts: 12n, date: 1_760_000_500, count: 4 } },
    { className: 'updates.difference', newMessages: [channelMessage({ id: 94 })], state: { pts: 4260n, qts: 12n, date: 1_760_000_600, count: 5 } },
  ];
  const harness = makeStateHarness({
    serverPts: (index) => (index === 0 ? 4200 : 4260),
    difference: (request, asked) => slices[asked - 1] || emptyAnswer(4260),
  });
  await harness.cycle();                          // 4200, adopted: nothing to reconcile against yet
  await harness.cycle();                          // 4260 with a silent handler: a gap of 60, one reply cannot close it
  assert.deepEqual(harness.differences().map((request) => Number(request.pts)), [4200, 4230, 4250],
    'every request is sent from where the previous answer left the state, which is the only way a slice ends');
  const beat = harness.listener.streamBeatFor(USER_ID);
  assert.deepEqual({ action: beat.action, steps: beat.steps, gap: beat.gap }, { action: 'difference-applied', steps: 3, gap: 60 });
  const state = harness.listener.readUpdateState(harness.client);
  assert.equal(state.pts, 4260, 'and the session finishes the beat on the account’s own number');
  assert.equal(state.qts, 12, 'every field of the last answer is what is cached, not the first one’s');
  assert.equal(harness.entry().needsCatchUp, true, 'channel content is still the history read’s job, slice or no slice');
  const line = harness.logs.filter((entry) => entry.message === 'Telegram update state reconciled').pop();
  assert.deepEqual({ steps: line.meta.steps, messages: line.meta.messages, partial: line.meta.partial }, { steps: 3, messages: 4, partial: false },
    'the log carries how many round trips the repair took and how much it found, because "reconciled" alone does not say');
  assert.ok(harness.logs.every((entry) => !/captured/.test(entry.message)), 'a difference never writes a signal row itself');
});

test('a loop that runs out of budget is called partial, and the next beat resumes from where it stopped', async () => {
  // A gap of 300, slices of 40, and three requests of budget: further along, not finished.
  const harness = makeStateHarness({
    differenceMaxSteps: 3,
    serverPts: (index) => (index === 0 ? 4200 : 4500),
    difference: (request, asked) => ({
      className: 'updates.differenceSlice',
      newMessages: [],
      state: { pts: BigInt(Number(request.pts) + 40), qts: 12n, date: 1_760_000_000 + asked * 40, count: 3 },
    }),
  });
  await harness.cycle();
  await harness.cycle();
  const beat = harness.listener.streamBeatFor(USER_ID);
  assert.deepEqual({ action: beat.action, steps: beat.steps, partial: beat.partial }, { action: 'difference-partial', steps: 3, partial: true },
    'an unfinished difference says so, instead of the "reconciled" that would hide a hole 180 updates wide');
  assert.equal(harness.differences().length, 3, 'and it stops at the budget rather than catching up mid-outage forever');
  assert.equal(harness.listener.readUpdateState(harness.client).pts, 4320, 'the state it leaves behind is the one it reached, never the one that produced the gap');
  assert.equal(harness.entry().needsCatchUp, true, 'a partial difference is still a flagged session: the sweep reads the channels either way');
  await harness.cycle();
  assert.equal(harness.differences()[3] && Number(harness.differences()[3].pts), 4320, 'the next beat continues from 4320 instead of re-asking the whole 300');
});

test('a difference the server refuses to compute falls back to the history read instead of crashing', async () => {
  const harness = makeStateHarness({
    serverPts: (index) => (index === 0 ? 4200 : 94200),
    difference: () => { throw rpcError('The referenced messages are too old to access', 'UPDATES_TOO_OLD', { errorCode: 400 }); },
  });
  await harness.cycle();
  await harness.cycle();
  await new Promise((resolve) => { setImmediate(resolve); });
  assert.equal(harness.listener.streamBeatFor(USER_ID).action, 'too-long', 'a thrown refusal is classified, not lumped in with "the socket is sad"');
  assert.equal(harness.listener.readUpdateState(harness.client).pts, 94200, 'the state adopts what the account is on, because the number that produced the refusal is a number to stop using');
  assert.deepEqual(harness.rebuilt, [{ userId: USER_ID, reason: 'update-state-too-far-behind', forced: true, escalated: false }],
    'and the session is replaced past the cooldown, since this refusal does not expire on its own');
  assert.equal(harness.entry().needsCatchUp, true, 'the messages this session never saw are read back from history, which is the only API that answers for a hole this wide');
  assert.ok(harness.logs.some((entry) => entry.message === 'Telegram update state reconciled' && entry.meta.action === 'too-long'));
  // The counter-example that keeps this from being an outage amplifier: a *second* beat after the refusal is quiet.
  await harness.cycle();
  assert.equal(harness.differences().length, 1, 'the adopted state means the next beat has nothing to ask about');
});

test('a FLOOD_WAIT pauses the reconciliation and nothing else', async () => {
  const harness = makeStateHarness({
    serverPts: (index) => (index === 0 ? 4200 : 4260),
    // Flooded once, and answered the second time the wait expires - a fixture that refused forever would prove
    // nothing about the stamp being cleared.
    difference: (request, asked) => {
      if (asked === 1) throw rpcError('A wait of 57 seconds is required', 'FLOOD_WAIT_57', { seconds: 57 });
      return emptyAnswer(4260);
    },
  });
  await harness.cycle();
  await harness.cycle();
  const beat = harness.listener.streamBeatFor(USER_ID);
  assert.deepEqual({ action: beat.action, throttledFor: beat.throttledFor }, { action: 'throttled', throttledFor: 57_000 },
    'the wait the provider asked for is the wait we keep, in the record and in the log');
  assert.equal(harness.listener.readUpdateState(harness.client).pts, 4200, 'a throttle never marks us caught up: the gap stays, so the next beat closes it');
  await harness.cycle();
  assert.equal(harness.differences().length, 1, 'and while the wait is running no second request is sent, which is what stops a fleet hammering the same limit every 30 seconds');
  assert.equal(harness.listener.streamHealth(USER_ID).beatAction, 'throttled');
  assert.deepEqual(harness.rebuilt, [], 'being rate limited is not a dead stream, and treating it as one is how a flood wait becomes an outage');
  harness.advance(60_000);
  await harness.cycle();
  assert.equal(harness.differences().length, 2, 'the stamp expires instead of becoming a permanent silence');
  assert.equal(harness.listener.streamBeatFor(USER_ID).action, 'difference-empty', 'and the second ask is answered normally');
  assert.equal(harness.listener.readUpdateState(harness.client).nextDifferenceAt, undefined, 'a difference that is answered clears the stamp, so a pause is one pause and not a lifestyle');
});

test('an auth key the account no longer recognises ends the session instead of retrying it', async () => {
  const declared = [];
  const harness = makeStateHarness({
    onSessionUnrecoverable: async (userId, reason, details) => { declared.push({ userId, reason, details }); },
    serverPts: (index) => (index === 0 ? 4200 : 4260),
    difference: () => { throw rpcError('AUTH_KEY_UNREGISTERED', 'AUTH_KEY_UNREGISTERED', { errorCode: 401 }); },
  });
  await harness.cycle();
  await harness.cycle();
  await new Promise((resolve) => { setImmediate(resolve); });
  assert.equal(harness.listener.streamBeatFor(USER_ID).action, 'session-revoked');
  assert.deepEqual(harness.rebuilt, [], 'nothing is reconnected: a new socket on a dead key is the same 401 in a different shape');
  await new Promise((resolve) => { setImmediate(resolve); });
  assert.equal(declared.length, 1, 'the workspace is asked to sign in, once, and not every beat afterwards');
  assert.equal(declared[0].reason, 'telegram-session-revoked');
  assert.equal(harness.listener.streamHealth(USER_ID).reauthRequired, true, 'the verdict is a fact about the session, readable without a log search');
  assert.ok(harness.logs.some((entry) => entry.level === 'warn' && entry.message === 'Telegram session marked for re-authentication'));
});

test('three beats of a gap a rebuild could not close ask the user to sign in, about 90 seconds in', async () => {
  const declared = [];
  const harness = makeStateHarness({
    onSessionUnrecoverable: async (userId, reason, details) => { declared.push({ reason, details }); },
    // The gap grows every beat and the account keeps insisting it owes us nothing: the pattern is unambiguous.
    serverPts: (index) => 4260 + index * 60,
    difference: (request) => emptyAnswer(Number(request.pts)),
  });
  await harness.cycle();                                  // adopt
  await harness.cycle();                                  // gap 60: a difference is asked and refused
  assert.equal(harness.listener.streamBeatFor(USER_ID).strikes, 1, 'one beat of it is a measurement');
  await harness.cycle();                                  // gap 120: the stall detector replaces the session
  assert.equal(harness.rebuilt.length, 1, 'the rebuild comes before the verdict, never instead of it');
  assert.equal(harness.listener.streamBeatFor(USER_ID).strikes, 2);
  await harness.cycle();                                  // gap 180, on a session that is 30 seconds old
  assert.equal(declared.length, 1, 'a brand-new session already failing the same way is not a transport problem any more');
  assert.equal(declared[0].reason, 'pts-gap-unresolved');
  assert.ok(declared[0].details.strikes >= 3 && declared[0].details.gap > 0, 'and the evidence travels with the verdict');
  const verdictBeat = harness.listener.streamBeatFor(USER_ID);
  assert.deepEqual({ action: verdictBeat.action, strikes: verdictBeat.strikes, rebuilds: verdictBeat.rebuilds }, { action: 'difference-empty', strikes: 0, rebuilds: 1 },
    'the verdict resets the ladder it climbed, and the record keeps the evidence of what was tried');
  const fleet = harness.listener.telegramFleetSummary().sessions[0];
  assert.equal(fleet.reauthRequired, true, 'so is the panel field, which is the whole point of the strike counter');
  await harness.cycle();
  await harness.cycle();
  assert.equal(declared.length, 1, 'one verdict per cooldown window, however long the gap goes on growing afterwards');
  assert.equal(harness.listener.heartbeatSummary().unrecoverable, 1);
});

test('a stream that reconciles is forgiven, and the strike count starts over', async () => {
  const declared = [];
  const harness = makeStateHarness({
    onSessionUnrecoverable: async (userId, reason) => { declared.push(reason); },
    serverPts: (index) => 4260 + index * 60,
    difference: (request) => emptyAnswer(Number(request.pts)),
  });
  await harness.cycle();
  await harness.cycle();
  await harness.cycle();
  assert.equal(harness.listener.streamBeatFor(USER_ID).strikes, 2, 'two beats behind, and no verdict yet');
  harness.entry().stats.seen = 5;                          // the handler starts being shown things again
  await harness.cycle();
  assert.equal(harness.listener.streamBeatFor(USER_ID).strikes, 0, 'a beat where the handler kept up wipes the history, because a recovering session is not a condemned one');
  harness.entry().stats.seen = 6;
  await harness.cycle();
  await harness.cycle();
  assert.equal(declared.length, 0, 'and the ladder has to be climbed again from the bottom');
});

test('a difference that finds nothing still queues the session for the next minute, not the next three', async () => {
  // The shape of a permanently deaf stream: the account’s number never moves, the sweep keeps bringing back
  // messages, and the difference answers "nothing is missing" every time it is asked.
  const harness = makeStateHarness({ serverPts: () => 4200, difference: () => emptyAnswer(4200) });
  await harness.cycle();
  harness.entry().stats.catchUpSaved = 1;
  await harness.cycle();
  assert.equal(harness.listener.streamBeatFor(USER_ID).action, 'difference-empty', 'the server’s answer is in the record');
  assert.equal(harness.differences().length, 1, 'and it was actually asked, which is the only way to tell "you are current" from "I have stopped telling you"');
  assert.equal(harness.entry().needsCatchUp, true,
    'the flag the 60-second sweep reads is set even though the difference found nothing: for a session the account will not reconcile, that read is the whole recovery, and a flag that only rises on a successful difference would leave the messages to the three-minute stagger');
  const health = harness.listener.streamHealth(USER_ID);
  assert.equal(health.needsCatchUp, true, 'health publishes the flag, which is the only way the minute-long re-arm pass can see it: the unit sets it, the server consumes it, and the pin for that hand-off lives in the index test');
  assert.equal(health.beatAction, 'difference-empty', 'and it publishes the answer that produced it, so "the server insists this session is current" is a fact a panel can show without a log search');
});

test('a channel of thirty thousand members that stops pushing is caught by the state, and nothing is invented', async () => {
  /* The failure mode a ping cannot see: the account’s `pts` moves because its *other* chats are loud, this
     session is shown nothing for the monitored channel, and a difference request answers with `otherUpdates` -
     the channel events it owes but never sent. The handler is not re-fed from a difference (that would mint a
     `replayed: false` row for an event nobody pushed, which is the one number the workspace trusts); the answer
     is to record the debt, flag the session, and let the history read bring the content back. */
  const harness = makeStateHarness({
    serverPts: (index) => 4200 + index * 40,
    difference: () => ({ className: 'updates.difference', otherUpdates: [{ className: 'updateNewChannelMessage' }, { className: 'updateDeleteChannelMessage' }], state: { pts: 4240n, qts: 11n, date: 1_760_000_040, count: 3 } }),
  });
  await harness.cycle();
  await harness.cycle();
  const beat = harness.listener.streamBeatFor(USER_ID);
  assert.deepEqual({ action: beat.action, gap: beat.gap }, { action: 'difference-applied', gap: 40 }, 'the debt is measured and closed as far as the API allows');
  const line = harness.logs.filter((entry) => entry.message === 'Telegram update state reconciled').pop();
  assert.deepEqual({ messages: line.meta.messages, otherUpdates: line.meta.otherUpdates }, { messages: 0, otherUpdates: 2 },
    'the count of events that were owed, logged as the reason and never as a signal');
  assert.ok(harness.logs.every((entry) => !/captured/.test(entry.message)), 'an update pulled by a difference is never a capture, so `replayed: false` stays proof of a real push');
  assert.equal(harness.entry().needsCatchUp, true, 'and the channel content is fetched by the catch-up, which is GramJS’s only working recovery for a channel');
  await harness.cycle();
  await harness.cycle();
  assert.deepEqual(harness.rebuilt.map((entry) => entry.reason), ['update-stream-stalled'], 'a pts that keeps outrunning a silent handler becomes a new session, on the same two-beat rule as any other stall');
});

test('a session that comes back from a sign-in is not still condemned by the failure it arrived with', async () => {
  const declared = [];
  const harness = makeStateHarness({
    onSessionUnrecoverable: async (userId, reason) => { declared.push(reason); },
    serverPts: (index) => (index === 0 ? 4200 : 4260),
    difference: () => { throw rpcError('AUTH_KEY_UNREGISTERED', 'AUTH_KEY_UNREGISTERED', { errorCode: 401 }); },
  });
  await harness.cycle();
  await harness.cycle();
  await new Promise((resolve) => { setImmediate(resolve); });
  assert.equal(declared.length, 1, 'the verdict lands once');
  assert.equal(harness.listener.streamHealth(USER_ID).reauthRequired, true);
  assert.equal(harness.differences().length, 1, 'and while it stands, the beat stops asking the question that produced it');
  harness.listener.resetStreamBaseline(USER_ID);
  assert.equal(harness.listener.streamHealth(USER_ID).reauthRequired, false, 'a re-attach wipes the verdict: the row says the session was signed in again, and an old verdict must not survive that');
  await harness.cycle();
  assert.equal(harness.listener.streamBeatFor(USER_ID).strikes, 0, 'with the ladder, since a new session has to earn its own history');
});

/* ---------------------------------------------------------------------------
 * THE PROVIDER'S OWN TIMEOUTS, AND WHAT THE WATCHDOG MAY NOT CONCLUDE FROM THEM. `telegram/client/updates.js`
 * pings every 9 seconds with a 10-second race, three goes, and on failure it prints `Error: TIMEOUT` and calls
 * `_sender.reconnect()`. So for up to about forty seconds a session can be perfectly healthy by the app's own
 * measurement (`answered: 1, ms: 22`) while its socket is being re-established underneath. The guard in
 * `services/telegram-keepalive.js` silences the print; what these tests cover is the other half - a beat that
 * finds nothing to answer it *inside* that window waits one cycle instead of tearing a recovering session down,
 * and a flap on its own is not allowed to become a deaf verdict, a strike, or a rebuild.
 * --------------------------------------------------------------------------- */

test('an unanswered beat during a provider keep-alive timeout waits one cycle, then acts', async () => {
  const flap = { at: 1, count: 3 };
  const harness = makeBeatHarness({ mode: 'error', transportFlap: () => flap, keepAliveFlapGraceMs: Number.MAX_SAFE_INTEGER });
  await harness.cycle();
  assert.deepEqual(harness.rebuilt, [], 'the first unanswered beat is not a verdict while the provider is reconnecting its own transport');
  const beat = harness.listener.streamBeatFor(USER_ID);
  assert.deepEqual({ flapping: beat.flapping, deadBeat: beat.deadBeat, keepAliveTimeouts: beat.keepAliveTimeouts }, { flapping: true, deadBeat: 1, keepAliveTimeouts: 3 },
    'and it is recorded as a flap with a count, not as a healthy beat');
  assert.equal(harness.listener.heartbeatSummary().flapping, 1, 'the cycle counts it separately from dead ones');
  assert.ok(harness.logs.some((entry) => entry.level === 'warn' && entry.message === 'Telegram beat waits out a provider keep-alive timeout'),
    'said once, out loud, because a deferred rebuild is a decision somebody should be able to see');
  const health = harness.listener.streamHealth(USER_ID);
  assert.equal(health.transportFlapping, true, 'and the panel can ask, rather than infer it from a missing signal');

  await harness.cycle();
  assert.deepEqual(harness.rebuilt.map((entry) => entry.reason), ['heartbeat-no-answer'],
    'a second consecutive unanswered beat is a dead socket by our own measurement, whatever the provider is doing to its own');
  assert.equal(harness.listener.streamBeatFor(USER_ID).flapping, false, 'the grace is one beat, not a policy of patience');

  // The same window, expired: nothing is deferred, because the flap no longer explains the silence. (The fixture
  // states the flap in absolute terms, so a grace of 1 ms is the same thing as a flap that happened an hour ago.)
  const expired = makeBeatHarness({ mode: 'error', transportFlap: () => ({ at: 1, count: 3 }), keepAliveFlapGraceMs: 1 });
  await expired.cycle();
  assert.deepEqual(expired.rebuilt.map((entry) => entry.reason), ['heartbeat-no-answer'], 'outside the grace window a dead beat is a dead beat, immediately');
  // And a session with no keep-alive noise at all keeps the behaviour it always had.
  const quiet = makeBeatHarness({ mode: 'error', transportFlap: () => ({ at: 0, count: 0 }) });
  await quiet.cycle();
  assert.deepEqual(quiet.rebuilt.map((entry) => entry.reason), ['heartbeat-no-answer'], 'no flap, no forgiveness');
});

test('keep-alive noise on a session that answers is not a deaf stream, a strike, or a rebuild', async () => {
  // The log the user is actually looking at: hundreds of provider TIMEOUTs, and a beat that answers in 22 ms.
  const harness = makeStateHarness({
    serverPts: (index) => 4200 + index * 5,
    transportFlap: () => ({ at: 1, count: 412 }),
    keepAliveFlapGraceMs: Number.MAX_SAFE_INTEGER,
  });
  await harness.cycle();
  harness.entry().stats.seen = 5;                 // the handler is being shown messages, as it is in production
  await harness.cycle();
  harness.entry().stats.seen = 9;
  await harness.cycle();
  await new Promise((resolve) => { setImmediate(resolve); });
  assert.deepEqual(harness.rebuilt, [], 'four hundred provider timeouts do not add up to one reason to replace a session that answers');
  const beat = harness.listener.streamBeatFor(USER_ID);
  assert.deepEqual({ deaf: beat.deaf, strikes: beat.strikes, stalls: beat.stalls, flapping: Boolean(beat.flapping) }, { deaf: 0, strikes: 0, stalls: 0, flapping: false },
    'and none of the stream detectors is fed by them: those read pts, the handler, and the sweep, never the provider’s logger');
  const [session] = harness.listener.telegramFleetSummary().sessions;
  assert.deepEqual({ keepAliveTimeouts: session.keepAliveTimeouts, transportFlapping: session.transportFlapping, reauthRequired: session.reauthRequired },
    { keepAliveTimeouts: 412, transportFlapping: false, reauthRequired: false }, 'the count reaches the panel, so the noise is visible without being loud');
});
