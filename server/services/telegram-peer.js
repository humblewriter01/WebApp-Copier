/**
 * Telegram peer identity, in one place.
 *
 * A chat has two spellings of the same number. MTProto marks channels and supergroups with a `-100`
 * prefix and basic groups with a bare minus, and GramJS hands over whichever shape the accessor you
 * picked happens to use: `message.chatId` follows the library's marked convention,
 * `message.peerId.channelId` is the raw id, and `dialog.id` is resolved through `getPeerId`, whose
 * marking depends on the version in `node_modules`. Monitoring used to compare one exact string, so a
 * row saved as `1234567890` never matched the messages of `-1001234567890` - the same channel, two
 * spellings, every live message dropped before it could be parsed and with nothing said about it.
 *
 * So an id is never compared as a single string: both spellings are produced on each side and matched
 * as a set, and nothing in this file has to know which way the installed library leans. Non-numeric
 * handles (`@name`) are carried through untouched.
 */

/** Longest message this workspace will read. A stale bot session can deliver a megabyte. */
export const MAX_SIGNAL_TEXT = 4000;

/** The raw channel/group digits behind a possibly marked id, or null when it is not numeric. */
function bareDigits(value) {
  const text = String(value ?? '').trim();
  if (!/^-?\d{1,20}$/.test(text)) return null;
  const unsigned = text.startsWith('-100') ? text.slice(4) : text.replace(/^-/, '');
  return /^\d+$/.test(unsigned) ? unsigned : null;
}

/**
 * Every spelling of this chat id that a database row could plausibly hold. Deduped and stable, so the
 * set can go straight into `= ANY($n::text[])`.
 */
export function telegramPeerIdVariants(value) {
  const text = String(value ?? '').trim();
  if (!text) return [];
  const digits = bareDigits(text);
  if (digits === null) return [text.replace(/^@/, '') || text];
  return [...new Set([text, `-100${digits}`, digits, `-${digits}`])];
}

/** Two monitored-channel rows describe the same chat when any spelling of their ids agrees. */
export function telegramPeerIdsMatch(left, right) {
  const variants = new Set(telegramPeerIdVariants(left));
  if (!variants.size) return false;
  return telegramPeerIdVariants(right).some((variant) => variants.has(variant));
}

/** Long-style ids print themselves; anything else is only usable once it is plain text. */
function idText(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object' && typeof value.toString !== 'function') return null;
  const text = String(value).trim();
  if (!text || text === 'undefined' || text === 'null' || text === '[object Object]') return null;
  return text;
}

/**
 * The chat a GramJS message came from, read from whichever accessor this version fills in.
 *
 * `Api.Message.chatId` is what the documentation advertises, `peerId.channelId` is what the wire format
 * actually carries, `dialog.id` is a `TypePeer`, and the update event itself keeps a `chatPeer` - all
 * three (plus `toPeer()`, `toObject()`, and the event's own `update`) are tried, so a missing accessor
 * can never again be the quiet reason a signal disappears. `null` means "I could not tell who sent
 * this", which the listener logs instead of pretending the message never arrived.
 */
export function resolveTelegramChatId(message, event = null) {
  const sources = [message, message?.message, message?.peerId, message?.chatPeer, event?.chatPeer, event?.update, event].filter(Boolean);
  for (const source of sources) {
    const direct = idText(source.chatId ?? source.chat_id ?? source.channelId ?? source.channel_id ?? source.userId ?? source.user_id);
    if (direct) return direct;
    if (typeof source.toPeer === 'function') {
      try {
        const peer = source.toPeer() || {};
        const fromPeer = idText(peer.channel_id ?? peer.chat_id ?? peer.user_id);
        if (fromPeer) return fromPeer;
      } catch { /* a session that cannot resolve this peer falls through to the plain accessors */ }
    }
    if (typeof source.toObject === 'function') {
      try {
        const plain = source.toObject({ ignoreReferences: true }) || {};
        const fromObject = idText(plain.channel_id ?? plain.chat_id ?? plain.user_id);
        if (fromObject) return fromObject;
      } catch { /* the raw shape is not always convertible; that is not a reason to lose the message */ }
    }
  }
  const nested = event?.updates?.[0]?.message || event?.message || null;
  return nested && nested !== message ? resolveTelegramChatId(nested, null) : null;
}

/** Telegram scatters zero-width marks through channel posts, and a header full of them parses as nothing. */
function stripInvisible(text) {
  return String(text ?? '').replace(/[​‌‍﻿]/g, '');
}

function firstDefined(values) {
  for (const value of values) {
    if (value === undefined || value === null) continue;
    const text = stripInvisible(value).replace(/\r\n/g, '\n').trim();
    if (text) return text;
  }
  return '';
}

/**
 * The body of a message, from whichever field this update type carries it.
 *
 * `message.message` is where channel posts live in this event shape, `message.text` is the plain
 * accessor, `media.caption` covers a signal posted as an image with the prices underneath, and the
 * whole thing is capped: a session that has been off for a week should not have a megabyte of prose run
 * through the parser, which used to happen for every undelivered update in one go.
 */
export function telegramMessageText(message) {
  const candidate = firstDefined([
    message?.text,
    message?.message?.text,
    message?.caption,
    message?.message?.caption,
    message?.media?.caption,
    message?.message?.media?.caption,
  ]);
  if (!candidate) return null;
  return candidate.slice(0, MAX_SIGNAL_TEXT);
}

/** A pin, a join, a rename: a service notice, not a post to read as a signal. */
export function isTelegramServiceMessage(message) {
  return Boolean(message?.action) || message?.className === 'MessageService';
}
