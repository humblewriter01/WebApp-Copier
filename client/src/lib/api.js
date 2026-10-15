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
    throw new Error(payload.error || payload.message || `Request failed (${response.status})`);
  }
  return payload;
}
