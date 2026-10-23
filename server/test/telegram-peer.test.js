import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isTelegramServiceMessage,
  resolveTelegramChatId,
  telegramMessageText,
  telegramPeerIdVariants,
  telegramPeerIdsMatch,
} from '../services/telegram-peer.js';

/* The whole reason this module exists: a supergroup/channel id travels as `-1002440709664` when it is
   marked and as `2440709664` when it is not, and the listener used to compare one exact string. Every
   message from every channel was dropped and nothing said so. */
test('a marked id and its bare form describe the same chat', () => {
  const marked = telegramPeerIdVariants('-1002440709664');
  const bare = telegramPeerIdVariants('2440709664');
  assert.ok(marked.includes('-1002440709664'));
  assert.ok(marked.includes('2440709664'), 'the marked form also offers the bare id');
  assert.ok(bare.includes('-1002440709664'), 'the bare form also offers the marked id');
  assert.equal(telegramPeerIdsMatch('-1002440709664', '2440709664'), true);
  assert.equal(telegramPeerIdsMatch('1234567890', '-1001234567890'), true);
});

test('a chat is never matched with a different chat', () => {
  assert.equal(telegramPeerIdsMatch('-1002440709664', '-1002038845363'), false);
  assert.equal(telegramPeerIdsMatch('2440709664', '2440709665'), false);
  assert.equal(telegramPeerIdsMatch('', '2440709664'), false);
  assert.equal(telegramPeerIdsMatch(undefined, undefined), false);
  assert.equal(telegramPeerIdsMatch('xm_signals', '2440709664'), false, 'a handle is never a number');
  assert.equal(telegramPeerIdsMatch('-1007', '-1008'), false);
});

test('a stored monitored channel matches whichever spelling arrived', () => {
  assert.deepEqual(telegramPeerIdVariants('@xm_signals'), ['xm_signals']);
  assert.equal(telegramPeerIdsMatch('xm_signals', '@xm_signals'), true);
  // a basic group id is small and negative: it must keep its sign or it matches nothing at all
  assert.ok(telegramPeerIdVariants('-7').includes('-7'));
});

test('the chat id is read from whichever accessor this update actually fills', () => {
  assert.equal(resolveTelegramChatId({ chatId: '-1002440709664' }), '-1002440709664');
  assert.equal(resolveTelegramChatId({ peerId: { className: 'PeerChannel', channelId: '2440709664' } }), '2440709664');
  assert.equal(resolveTelegramChatId({ peerId: { toObject: () => ({ channel_id: 2440709664 }) } }), '2440709664');
  assert.equal(resolveTelegramChatId(undefined, { updates: [{ message: { chatId: '99' } }] }), '99');
  assert.equal(resolveTelegramChatId({}, { update: { channelId: '77' } }), '77');
  assert.equal(resolveTelegramChatId({ peerId: { className: 'PeerUser', userId: '5' } }), '5');
  assert.equal(resolveTelegramChatId({}, {}), null);
});

test('the text is read from every field a channel post can carry, with the invisible padding stripped', () => {
  assert.equal(telegramMessageText({ message: { text: '  BUY EURUSD  ' } }), 'BUY EURUSD');
  assert.equal(telegramMessageText({ message: { text: '\u200bSELL\u200c XAU/USD\u200b' } }), 'SELL XAU/USD');
  assert.equal(telegramMessageText({ message: { media: { caption: 'TP 1.0950' } } }), 'TP 1.0950');
  assert.equal(telegramMessageText({ message: { text: Array(5000).fill('x').join('') } })?.length, 4000, 'a runaway payload is capped, not run through the regexes whole');
  assert.equal(telegramMessageText(undefined), null);
});

test('a service notice is described as one instead of being read as an unclear signal', () => {
  // "Channel renamed" has no text to parse. Calling that "no clear signal" sends the reader hunting
  // for a formatting problem in a message that was never meant to hold a trade.
  assert.equal(isTelegramServiceMessage({ action: { className: 'MessageActionChannelCreate' } }), true);
  assert.equal(isTelegramServiceMessage({ text: 'BUY EURUSD' }), false);
  assert.equal(telegramMessageText({ action: { className: 'MessageActionPin' } }), null);
});
