const TELEGRAM_ERROR_MESSAGES = {
  PHONE_CODE_INVALID: 'Telegram rejected that code (PHONE_CODE_INVALID). Check the newest code or request another one.',
  PHONE_CODE_EXPIRED: 'That Telegram code has expired (PHONE_CODE_EXPIRED). Request a fresh code.',
  PHONE_CODE_HASH_INVALID: 'This Telegram login request is no longer valid (PHONE_CODE_HASH_INVALID). Request a fresh code.',
  PHONE_CODE_HASH_EMPTY: 'The Telegram login request is missing its code reference (PHONE_CODE_HASH_EMPTY). Request a fresh code.',
  PHONE_CODE_EMPTY: 'Enter the code Telegram sent (PHONE_CODE_EMPTY).',
  PHONE_NUMBER_INVALID: 'Telegram did not accept that phone number (PHONE_NUMBER_INVALID). Check the country code and try again.',
  PHONE_NUMBER_BANNED: 'Telegram cannot sign in this phone number (PHONE_NUMBER_BANNED).',
  PHONE_NUMBER_UNOCCUPIED: 'That phone number is not registered to a Telegram account (PHONE_NUMBER_UNOCCUPIED).',
  PHONE_NUMBER_FLOOD: 'Telegram is temporarily limiting sign-in attempts for this phone number (PHONE_NUMBER_FLOOD). Wait before retrying.',
  SESSION_PASSWORD_NEEDED: 'This account requires its Telegram two-step verification password.',
  PASSWORD_HASH_INVALID: 'Telegram rejected the two-step verification password (PASSWORD_HASH_INVALID). Check it and try again.',
  PASSWORD_EMPTY: 'Enter your Telegram two-step verification password (PASSWORD_EMPTY).',
  PASSWORD_TOO_FRESH: 'Telegram is temporarily preventing a password change (PASSWORD_TOO_FRESH). Try again later.',
  API_ID_INVALID: 'Telegram sign-in is temporarily unavailable. Please try again later.',
  API_ID_PUBLISHED_FLOOD: 'Telegram sign-in is temporarily unavailable. Please try again later.',
  AUTH_KEY_UNREGISTERED: 'The Telegram login session is no longer valid (AUTH_KEY_UNREGISTERED). Request a fresh code.',
  AUTH_RESTART: 'Telegram restarted the login request (AUTH_RESTART). Request a fresh code.',
};

export function getTelegramErrorCode(error) {
  const candidates = [error?.errorMessage, error?.message, error?.toString?.()];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    const match = /\b([A-Z][A-Z0-9_]{2,})\b/.exec(candidate);
    if (match) return match[1];
  }
  return null;
}

export function isTelegramPasswordNeeded(error) {
  return getTelegramErrorCode(error) === 'SESSION_PASSWORD_NEEDED';
}

export function shouldDiscardTelegramLogin(code) {
  return ['PHONE_CODE_EXPIRED', 'PHONE_CODE_HASH_INVALID', 'PHONE_CODE_HASH_EMPTY', 'AUTH_KEY_UNREGISTERED', 'AUTH_RESTART'].includes(code);
}

export function telegramAuthErrorPayload(error) {
  const telegramErrorCode = getTelegramErrorCode(error);
  if (['API_ID_INVALID', 'API_ID_PUBLISHED_FLOOD'].includes(telegramErrorCode)) {
    return { error: 'Telegram sign-in is temporarily unavailable. Please try again later.', telegramErrorCode: null };
  }
  const floodWait = /^FLOOD_WAIT_(\d+)$/.exec(telegramErrorCode || '');
  const message = floodWait
    ? `Telegram is temporarily limiting sign-in (FLOOD_WAIT_${floodWait[1]}). Wait before retrying.`
    : TELEGRAM_ERROR_MESSAGES[telegramErrorCode]
      || (telegramErrorCode
        ? `Telegram could not complete sign-in (${telegramErrorCode}). Request a fresh code or try again.`
        : 'Telegram sign-in failed before it could verify the code. Request a fresh code or try again.');
  return { error: message, telegramErrorCode };
}
