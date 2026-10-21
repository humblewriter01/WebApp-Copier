const configuredApiUrl = import.meta.env.VITE_API_URL || '';
const apiUrl = import.meta.env.PROD && configuredApiUrl.includes('telegram-copier-api.onrender.com')
  ? 'https://telegram-copier-api-l1mj.onrender.com'
  : configuredApiUrl || (import.meta.env.PROD ? 'https://telegram-copier-api-l1mj.onrender.com' : 'http://localhost:5000');
export const API_URL = apiUrl.replace(/\/$/, '');

export async function request(path, token, options = {}) {
  const response = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok && response.status !== 202) {
    const message = typeof payload.userMessage === 'string' && payload.userMessage.trim()
      ? payload.userMessage
      : response.status >= 500
        ? 'We could not complete that request. Please try again in a moment.'
        : payload.error || payload.message || 'Please check your details and try again.';
    const error = new Error(message);
    if (payload.telegramErrorCode) error.telegramErrorCode = payload.telegramErrorCode;
    if (Number.isInteger(payload.metaApiStatus)) error.metaApiStatus = payload.metaApiStatus;
    if (typeof payload.metaApiErrorCode === 'string') error.metaApiErrorCode = payload.metaApiErrorCode;
    if (typeof payload.metaApiErrorType === 'string') error.metaApiErrorType = payload.metaApiErrorType;
    if (typeof payload.metaApiNetworkDiagnostic === 'string') error.metaApiNetworkDiagnostic = payload.metaApiNetworkDiagnostic;
    if (typeof payload.code === 'string') error.code = payload.code;
    if (payload.upgradeRequired === true) error.upgradeRequired = true;
    throw error;
  }
  return payload;
}
