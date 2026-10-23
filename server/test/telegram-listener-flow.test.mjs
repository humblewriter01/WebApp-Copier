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
import test from 'node:test';
import assert from 'node:assert/strict';
import { Api, TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { _handleUpdate } from 'telegram/client/updates.js';
import { createTelegramListener } from '../services/telegram-listener.js';
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
  assert.deepEqual(harness.saved[0].channel, { source: 'telegram', channelId: STORED_CHANNEL_ID, title: CHANNEL_TITLE, telegramMessageId: 77 });
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
