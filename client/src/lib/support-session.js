/**
 * The browser side of a support ("impersonate") session.
 *
 * A support session is a one-hour, read-only token that an administrator mints for themselves.
 * It lives in sessionStorage rather than localStorage on purpose: it dies with the tab, it is not
 * sent on any other origin's request, and closing the tab is a reasonable default for "I am done
 * looking at someone's account".
 *
 * Everything that decides *whether* a support session is active is here, so no component gets to
 * assume it on its own. A record that cannot be understood, or that has run out, is treated as no
 * session at all - never as "probably still fine".
 */
export const SUPPORT_SESSION_STORAGE_KEY = 'signal-support-session';

function storageOrDefault(storage) {
  if (storage !== undefined) return storage;
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}

function cleanText(value, max) {
  return String(value ?? '').trim().slice(0, max);
}

/** Only a complete, unexpired record is a session; anything else is nothing, and is removed. */
export function readSupportSession(storage) {
  const target = storageOrDefault(storage);
  if (!target) return null;
  let raw = null;
  try {
    raw = target.getItem(SUPPORT_SESSION_STORAGE_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  const session = shapeSession(parsed);
  if (session) return session;
  try {
    target.removeItem(SUPPORT_SESSION_STORAGE_KEY);
  } catch {
    /* nothing else to do; the record is ignored either way */
  }
  return null;
}

export function shapeSession(input, now = () => Date.now()) {
  const token = cleanText(input?.token, 4000);
  const expiresAt = input?.expiresAt ? new Date(input.expiresAt) : null;
  const email = cleanText(input?.user?.email, 200);
  if (!token || !email || !expiresAt || Number.isNaN(expiresAt.getTime())) return null;
  if (expiresAt.getTime() <= now()) return null;
  return {
    token,
    sessionId: cleanText(input.sessionId, 80) || null,
    expiresAt: expiresAt.toISOString(),
    user: {
      id: cleanText(input.user?.id, 80) || null,
      name: cleanText(input.user.name, 120) || email,
      email,
    },
  };
}

export function writeSupportSession(session, storage) {
  const target = storageOrDefault(storage);
  const shaped = shapeSession(session);
  if (!target) return false;
  if (!shaped) {
    try {
      target.removeItem(SUPPORT_SESSION_STORAGE_KEY);
    } catch { /* ignored */ }
    return false;
  }
  try {
    target.setItem(SUPPORT_SESSION_STORAGE_KEY, JSON.stringify(shaped));
    return true;
  } catch {
    return false;
  }
}

export function clearSupportSession(storage) {
  const target = storageOrDefault(storage);
  if (!target) return false;
  try {
    target.removeItem(SUPPORT_SESSION_STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}

export function supportSessionIsActive(session, now = () => Date.now()) {
  return Boolean(shapeSession(session, now));
}

/**
 * A short countdown for the banner. It is deliberately coarse: the exact second nobody can act on
 * is noise, and "under a minute left" is the only case where precision changes behaviour.
 */
export function supportSessionRemaining(session, now = Date.now()) {
  const expiresAt = session?.expiresAt ? new Date(session.expiresAt).getTime() : NaN;
  if (!Number.isFinite(expiresAt)) return null;
  const seconds = Math.floor((expiresAt - now) / 1000);
  if (seconds <= 0) return { expired: true, label: 'expired' };
  if (seconds < 60) return { expired: false, label: 'under a minute left' };
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return { expired: false, label: `${minutes} min left` };
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  // A fresh session has a whole hour on it, and "1h 0 min left" reads like a malfunction.
  return { expired: false, label: rest ? `${hours}h ${rest} min left` : `${hours} hour${hours === 1 ? '' : 's'} left` };
}
