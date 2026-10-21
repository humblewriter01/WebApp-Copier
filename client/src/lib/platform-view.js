/**
 * The wording and tone rules for platform-level states, in one module.
 *
 * Admin health, the kill switch, announcements, and the support banner all have the same hazard:
 * an absent read looks exactly like a good read if the component is allowed to default it. So no
 * component decides on its own what "unknown" means - each one asks here, and every state that is
 * not a confirmed answer renders as unknown rather than borrowing the colour of a healthy one.
 */
export const KILL_SWITCH_LABELS = Object.freeze({
  live: 'Live',
  paused: 'Paused',
  unavailable: 'Unknown',
  loading: 'Checking…',
});

/** The three headlines the card can show; nothing here is inferred from the button pressed. */
export const KILL_SWITCH_HEADLINES = Object.freeze({
  live: 'Automatic execution is live',
  paused: 'Automatic execution is paused for every workspace',
  unavailable: 'The switch could not be read - execution is blocked',
  loading: 'Reading the platform switch…',
});

const CHECK_TONES = Object.freeze({
  ok: 'ok',
  idle: 'idle',
  watch: 'watch',
  fail: 'fail',
  paused: 'paused',
  unavailable: 'fail',
  unknown: 'unknown',
});

export function healthCheckTone(state) {
  return CHECK_TONES[state] || 'unknown';
}

export function killSwitchView(health) {
  const state = health ? health.killSwitch?.state || 'unavailable' : 'loading';
  const check = health?.checks?.find((entry) => entry.key === 'kill_switch') || null;
  return {
    state,
    label: KILL_SWITCH_LABELS[state] || 'Unknown',
    headline: KILL_SWITCH_HEADLINES[state] || KILL_SWITCH_HEADLINES.unavailable,
    detail: check?.detail || '',
    paused: state === 'paused',
    blocked: state !== 'live',
    ready: Boolean(health),
    reason: state === 'loading' ? '' : health?.killSwitch?.reason || '',
    updatedBy: state === 'loading' ? '' : health?.killSwitch?.updatedByEmail || '',
    updatedAt: state === 'loading' ? null : health?.killSwitch?.updatedAt || null,
  };
}

export const ANNOUNCEMENT_TAGS = Object.freeze({ info: 'Announcement', warning: 'Notice', critical: 'Important' });

function timeLabel(value) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return '';
  return date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** Only ever a description of the stored window, never an invented one. */
export function formatAnnouncementWindow(item, now = new Date()) {
  const end = item?.endsAt ? new Date(item.endsAt) : null;
  if (end && !Number.isNaN(end.getTime())) {
    if (end.getTime() <= now.getTime()) return 'ends now';
    return `until ${timeLabel(item.endsAt)}`;
  }
  const start = item?.startsAt ? new Date(item.startsAt) : null;
  if (start && !Number.isNaN(start.getTime()) && start.getTime() > now.getTime()) return `from ${timeLabel(item.startsAt)}`;
  return '';
}

export function announcementCopy(item, now = new Date()) {
  const level = ANNOUNCEMENT_TAGS[item?.level] ? item.level : 'info';
  return {
    level,
    tag: ANNOUNCEMENT_TAGS[level],
    window: formatAnnouncementWindow(item, now),
    // Only a critical banner interrupts; the rest are polite, and a critical one is announced
    // rather than displayed quietly, because it usually means "do not trust the numbers today".
    role: level === 'critical' ? 'alert' : 'status',
    live: level === 'critical' ? 'assertive' : 'polite',
  };
}

export function supportBannerCopy(session, remaining) {
  if (!session?.token) return null;
  const name = session.user?.name || session.user?.email || 'this workspace';
  return {
    identity: `${name}${session.user?.email && session.user.name ? ` (${session.user.email})` : ''}`,
    // Stated once, in the banner, instead of relying on each form to disable itself.
    readOnlyLine: 'This workspace is read-only - nothing you see here can be changed.',
    expiryLine: remaining
      ? remaining.expired
        ? 'This support session has ended.'
        : `Access ends in ${remaining.label.replace(' left', '')}.`
      : '',
  };
}
