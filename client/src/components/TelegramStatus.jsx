import React, { createContext, useMemo } from 'react';
import { request } from '../lib/api.js';
import { STATUS_POLL_INTERVAL_MS, statusFailed, statusSettled, useStatusContext, useStatusResource } from '../lib/status-resource.js';

/**
 * The one place the app learns whether Telegram is connected.
 *
 * Every surface that mentions Telegram — the topbar pill, the signal empty states, the
 * Trading Accounts note, and the Telegram page itself — reads this shared state instead
 * of fetching or, worse, assuming. The rule that fixes the flashing is simple: the
 * connection is `null` until the backend answers, and nothing may render a "Connect
 * Telegram" call to action for a state it has not been told about. A slow or failed check
 * therefore shows a pending state, never a wrong one.
 */
export const TELEGRAM_STATUS_ENDPOINT = '/api/telegram/status';
export const TELEGRAM_POLL_INTERVAL_MS = STATUS_POLL_INTERVAL_MS;
export const WAITING_FOR_MESSAGES_MESSAGE = 'Telegram is connected. Waiting for messages from your selected channels...';
/**
 * What the empty list says when the session is connected but the backend reports that no live message
 * stream is attached to it. "Waiting for messages" would be a promise the server has just told us it is
 * not keeping, and this state is exactly the one that hid a dropped-message defect for so long: the
 * panel re-attaches the handler when the status is read, so the message names the moment, not a fault.
 */
export const LISTENER_NOT_ATTACHED_MESSAGE = 'Telegram is signed in, but the live message stream is not attached to this session yet. Reading this page re-attaches it; messages that arrive from now on will be captured.';

const UNKNOWN_STATE = Object.freeze({
  loading: true,
  connected: null,
  configured: null,
  // Whether the event handler is attached, as the server last said. Unknown, not false, until it says.
  listening: null,
  message: null,
  error: null,
  stale: false,
  checkedAt: null,
});

/**
 * Every transition the shared status can take, in one pure function, because this is the
 * code that decides whether a user is told to connect. `unknown` is the initial value and
 * is only ever replaced by something the backend said; a failed check can never invent a
 * disconnection, it can only mark the last confirmed answer stale.
 */
export function telegramStatusReducer(state = UNKNOWN_STATE, action = {}) {
  switch (action.type) {
    case 'resolve':
    case 'apply': {
      const result = action.payload || {};
      return statusSettled({
        ...state,
        connected: Boolean(result.connected),
        // `apply` comes from a local flow that only knows the connection, so it must not
        // erase whether this service can perform a sign-in at all.
        configured: typeof result.configured === 'boolean' ? result.configured : (action.type === 'apply' ? state.configured : null),
        message: typeof result.message === 'string' ? result.message : null,
        // Only the endpoint may say whether the listener is attached; a local sign-in flow cannot.
        listening: typeof result.listening === 'boolean' ? result.listening : null,
      }, action);
    }
    case 'reject':
      return statusFailed(state, action);
    case 'mark-disconnected':
      return statusSettled({ ...state, connected: false, listening: null }, action);
    case 'reset':
      return UNKNOWN_STATE;
    default:
      return state;
  }
}

/**
 * View model over the raw fetch state. `key` is the only thing the UI branches on, so a
 * component cannot half-trust the data: `checking` and `unreachable` both forbid a
 * connect CTA, and `unavailable` forbids it too because the server has said signing in is
 * not possible right now.
 */
export function telegramConnectionView(state = UNKNOWN_STATE) {
  const { connected, configured, error, message, stale, checkedAt, listening } = state;
  const base = { connected: connected === true, configured, stale: Boolean(stale), checkedAt: checkedAt || null };
  if (connected === null) {
    return error
      ? { ...base, key: 'unreachable', known: false, showConnectCallToAction: false, label: 'Status unavailable', tone: 'pending', detail: 'Telegram status could not be checked right now.' }
      : { ...base, key: 'checking', known: false, showConnectCallToAction: false, label: 'Checking Telegram…', tone: 'pending', detail: null };
  }
  if (configured === false) {
    return { ...base, key: 'unavailable', known: true, showConnectCallToAction: false, label: 'Telegram unavailable', tone: 'pending', detail: message || 'Telegram sign-in is temporarily unavailable. Please try again later.' };
  }
  if (connected) {
    // `listening` is passed through rather than folded into `key`: the state machine's five keys are
    // what every surface branches on, and a session that is connected with the stream not yet attached
    // is still connected. The empty list reads this flag to decide which sentence it is allowed to say.
    return { ...base, key: 'connected', known: true, showConnectCallToAction: false, label: 'Telegram connected', tone: 'online', listening: listening === null ? null : listening === true, detail: stale ? 'The latest status check failed, so this is the last confirmed state.' : null };
  }
  return { ...base, key: 'disconnected', known: true, showConnectCallToAction: true, label: 'Telegram not connected', tone: 'offline', detail: stale ? 'The latest status check failed, so this is the last confirmed state.' : (message || null) };
}

export const TelegramStatusContext = createContext(null);

const fetchTelegramStatus = (token) => request(TELEGRAM_STATUS_ENDPOINT, token);

/**
 * `fetchStatus` is a seam: the flows are testable without a network, exactly like the
 * server's fake MetaAPI and Paystack adapters.
 */
export function TelegramStatusProvider({ token, children, pollIntervalMs = TELEGRAM_POLL_INTERVAL_MS, fetchStatus = fetchTelegramStatus }) {
  const { state, refresh, publish } = useStatusResource({
    token, fetchStatus, reducer: telegramStatusReducer, initialState: UNKNOWN_STATE, pollIntervalMs,
  });

  const value = useMemo(() => ({
    ...state,
    view: telegramConnectionView(state),
    refresh,
    /** A flow that already has the answer publishes it rather than triggering a second call. */
    applyStatus: (result) => publish({ type: 'apply', payload: result }),
    markDisconnected: () => publish({ type: 'mark-disconnected' }),
  }), [state, refresh, publish]);

  return <TelegramStatusContext.Provider value={value}>{children}</TelegramStatusContext.Provider>;
}

/** A status value with no live provider behind it: real state, no working actions. */
export function staticTelegramStatusValue(state = UNKNOWN_STATE) {
  return {
    ...state,
    view: telegramConnectionView(state),
    refresh: async () => null,
    applyStatus: () => {},
    markDisconnected: () => {},
  };
}

const TELEGRAM_FALLBACK = Object.freeze(staticTelegramStatusValue());

/**
 * Safe without a provider: an unwired consumer gets the unknown view, which renders a
 * pending state rather than a connect button. Defaults must fail safe, because one
 * forgotten provider is otherwise exactly the flash this module exists to remove.
 */
export function useTelegramStatus() {
  return useStatusContext(TelegramStatusContext, TELEGRAM_FALLBACK);
}

/**
 * The dashboard's monitoring label, which is a status claim and therefore has to be earned
 * by the same confirmed state as everything else: "monitoring" is only true with a live
 * session and at least one selected channel.
 */
export function monitoringLabel({ view, channelCount = 0 } = {}) {
  if (!view?.known) return { key: 'checking', text: 'Checking sources…', live: false };
  if (view.key === 'disconnected') return { key: 'disconnected', text: 'Telegram not connected', live: false };
  if (view.key === 'unavailable') return { key: 'unavailable', text: 'Telegram unavailable', live: false };
  if (view.key === 'unreachable') return { key: 'unreachable', text: 'Status unavailable', live: false };
  if (!Number(channelCount)) return { key: 'no-channels', text: 'No channels selected', live: false };
  return { key: 'monitoring', text: 'Signal monitoring', live: true };
}

export function TelegramStatusPill({ detailed = false }) {
  const { view } = useTelegramStatus();
  const pending = view.key === 'checking' || view.key === 'unreachable';
  return <span className={`status-pill telegram-status-pill ${view.tone === 'online' ? 'online' : ''} ${pending ? 'pending' : ''}`} role="status" aria-live="polite">
    {pending ? <span className="skeleton skeleton-dot" aria-hidden="true" /> : <i aria-hidden="true" />}
    <span>{detailed ? view.label : (view.key === 'connected' ? 'Telegram connected' : view.key === 'disconnected' ? 'Telegram not connected' : view.label)}</span>
    {detailed && view.detail ? <small>{view.detail}</small> : null}
  </span>;
}
