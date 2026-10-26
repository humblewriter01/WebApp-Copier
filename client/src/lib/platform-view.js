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

/* ---------------------------------------------------------------- the workspace's own trading readiness ---------------------------------------------------------------- */

/** The states MetaAPI reports for an account this product can actually place an order on. */
export const EXECUTABLE_ACCOUNT_STATES = Object.freeze(['DEPLOYED', 'CONNECTED']);

/**
 * One sentence for the banner at the top of the workspace, in the order the reader can act on it.
 *
 * The banner used to answer only "is the switch on", which is the one question the app can already see the
 * answer to - and it was the answer the user got when the switch was on, an account was missing, and nothing
 * would ever trade. Auto-Trading being enabled is not the same thing as being able to execute, so each state
 * says which half is missing. A workspace whose plan does not include execution gets its own `plan` state and a
 * route to Billing, rather than being told to connect an account it is not allowed to use: the two sentences ask
 * for different things from the reader.
 *
 * The order is the one `decideSignalOutcome` walks on the server - the switch, then the plan, then the trading
 * account and its deployment, then the conditions that are true of every workspace here - so the banner and the
 * sentence under a signal row cannot blame two different things. `unavailable` and `paused` used to be answered
 * first, which is how a workspace missing an account came to be told about a switch nobody here can move while
 * its own row said something else.
 *
 * `subscriptionStatus` is optional because a caller that has not read the plan cannot claim anything about it;
 * the sentence under it stays worded for a workspace that has nothing linked, whether or not the plan allows it.
 */
export function autoTradingBannerView({ autoTradingEnabled = false, runtimeEnabled = true, platformPause = null, linkedAccounts = [], executionAccountId = '', subscriptionStatus = null } = {}) {
  if (autoTradingEnabled !== true) {
    return {
      state: 'off',
      tone: 'muted',
      headline: 'Auto-Trading is off',
      message: 'Signals are saved for review only. Turn Auto-Trading on in Advanced Settings to submit new eligible signals to your broker.',
      metricNote: 'Off until you enable it',
      action: null,
    };
  }
  if (subscriptionStatus != null && !['active', 'non_renewing'].includes(String(subscriptionStatus).toLowerCase())) {
    return {
      state: 'plan',
      tone: 'warn',
      headline: 'Auto-Trading is on',
      message: 'Auto-Trading is on, but your plan does not include automatic execution. Upgrade to execute signals.',
      metricNote: 'Upgrade to execute signals',
      action: { label: 'Open Billing', tab: 'billing' },
    };
  }
  const accounts = Array.isArray(linkedAccounts) ? linkedAccounts.filter((account) => account && typeof account === 'object') : [];
  const selected = accounts.find((account) => String(account.metaApiAccountId || '') === String(executionAccountId || '')) || null;
  if (!accounts.length || !selected) {
    return {
      state: 'no-account',
      tone: 'warn',
      headline: 'Auto-Trading is on',
      message: 'Auto-Trading is ON, but no trading account is connected. Connect your account or upgrade your plan to execute signals.',
      metricNote: 'Waiting for a trading account',
      action: { label: 'Open Trading Accounts', tab: 'metaapi' },
    };
  }
  if (!EXECUTABLE_ACCOUNT_STATES.includes(String(selected.state || '').toUpperCase())) {
    return {
      state: 'not-deployed',
      tone: 'warn',
      headline: 'Auto-Trading is on',
      message: `Auto-Trading is ON, but the trading account you selected is not connected yet (${String(selected.state || 'unknown').toLowerCase().replace(/_/g, ' ')}). Deploy it before signals can be executed.`,
      metricNote: 'Waiting for the account to deploy',
      action: { label: 'Open Trading Accounts', tab: 'metaapi' },
    };
  }
  if (runtimeEnabled === false) {
    return {
      state: 'unavailable',
      tone: 'warn',
      headline: 'Auto-Trading is on',
      message: 'Automatic execution is unavailable on this service right now, so nothing is sent to your broker. Signals are still captured and saved.',
      metricNote: 'Unavailable on this service',
      action: null,
    };
  }
  if (platformPause?.paused === true) {
    const reason = typeof platformPause.reason === 'string' && platformPause.reason.trim() ? ` Reason given: ${platformPause.reason.trim()}.` : '';
    return {
      state: 'paused',
      tone: 'warn',
      headline: 'Auto-Trading is on',
      message: `Signal Desk has paused automatic execution for every workspace, so nothing is sent to your broker.${reason}`,
      metricNote: 'Paused by Signal Desk',
      action: null,
    };
  }
  return {
    state: 'ready',
    tone: 'good',
    headline: 'Auto-Trading is on',
    message: 'New eligible Telegram signals may place live orders on your selected account. You can turn this off in Advanced Settings.',
    metricNote: 'Eligible signals may place orders',
    action: null,
  };
}
