import test from 'node:test';
import assert from 'node:assert/strict';
import { Api, TelegramClient } from 'telegram';
import {
  getTelegramErrorCode,
  isTelegramPasswordNeeded,
  shouldDiscardTelegramLogin,
  telegramAuthErrorPayload,
} from '../services/telegram-auth.js';

test('uses GramJS Api.auth.SignIn and verifies its phone-code hash fields', () => {
  assert.equal(typeof Api.auth.SignIn, 'function');
  assert.equal(typeof TelegramClient.prototype.signIn, 'undefined');
  assert.equal(typeof TelegramClient.prototype.sendCode, 'function');
  assert.equal(typeof TelegramClient.prototype.signInWithPassword, 'function');

  const request = new Api.auth.SignIn({
    phoneNumber: '+15551234567',
    phoneCodeHash: 'test-code-hash',
    phoneCode: '12345',
  });
  assert.equal(request.phoneNumber, '+15551234567');
  assert.equal(request.phoneCodeHash, 'test-code-hash');
  assert.equal(request.phoneCode, '12345');
});

test('extracts Telegram RPC codes from GramJS errors and returns specific safe messages', () => {
  const error = new Error('400: PHONE_CODE_INVALID (caused by auth.SignIn)');
  error.errorMessage = 'PHONE_CODE_INVALID';
  assert.equal(getTelegramErrorCode(error), 'PHONE_CODE_INVALID');
  const payload = telegramAuthErrorPayload(error);
  assert.equal(payload.telegramErrorCode, 'PHONE_CODE_INVALID');
  assert.match(payload.error, /PHONE_CODE_INVALID/);
  assert.match(payload.error, /newest code/i);
});

test('recognizes Telegram two-step verification and maps incorrect passwords precisely', () => {
  const required = new Error('400: SESSION_PASSWORD_NEEDED');
  required.errorMessage = 'SESSION_PASSWORD_NEEDED';
  assert.equal(isTelegramPasswordNeeded(required), true);
  assert.equal(telegramAuthErrorPayload(required).telegramErrorCode, 'SESSION_PASSWORD_NEEDED');

  const incorrect = new Error('400: PASSWORD_HASH_INVALID');
  incorrect.errorMessage = 'PASSWORD_HASH_INVALID';
  assert.match(telegramAuthErrorPayload(incorrect).error, /two-step verification password/i);
});

test('only expires invalidated/expired login attempts, not ordinary mistyped codes', () => {
  assert.equal(shouldDiscardTelegramLogin('PHONE_CODE_INVALID'), false);
  assert.equal(shouldDiscardTelegramLogin('PHONE_CODE_EXPIRED'), true);
  assert.equal(shouldDiscardTelegramLogin('PHONE_CODE_HASH_INVALID'), true);
});

test('preserves Telegram flood-wait duration in the user-facing error', () => {
  const payload = telegramAuthErrorPayload({ errorMessage: 'FLOOD_WAIT_42' });
  assert.equal(payload.telegramErrorCode, 'FLOOD_WAIT_42');
  assert.match(payload.error, /42/);
});

test('hides API application configuration details from user-facing errors', () => {
  for (const errorMessage of ['API_ID_INVALID', 'API_ID_PUBLISHED_FLOOD']) {
    const payload = telegramAuthErrorPayload({ errorMessage });
    assert.equal(payload.telegramErrorCode, null);
    assert.match(payload.error, /temporarily unavailable/i);
    assert.doesNotMatch(payload.error, /API_ID|service environment|API application/i);
  }
});
