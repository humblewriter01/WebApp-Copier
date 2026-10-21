import React, { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef } from 'react';
import { request } from '../lib/api.js';

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
export const TELEGRAM_POLL_INTERVAL_MS = 30_000;
export const WAITING_FOR_MESSAGES_MESSAGE = 'Telegram is connected. Waiting for messages from your selected channels...';

const UNKNOWN_STATE = Object.freeze({
  loading: true,
  connected: null,
  configured: null,
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
      return {
        ...state,
        loading: false,
        connected: Boolean(result.connected),
        configured: typeof result.configured === 'boolean' ? result.configured : (action.type === 'apply' ? state.configured : null),
        message: typeof result.message === 'string' ? result.message : null,
        error: null,
        stale: false,
        checkedAt: action.at || Date.now(),
      };
    }
    case 'reject':
      return {
        ...state,
        loading: state.connected === null,
        stale: state.connected !== null,
        error: action.message || 'Telegram status could not be checked.',
      };
    case 'mark-disconnected':
      return { ...state, loading: false, connected: false, stale: false, error: null, checkedAt: action.at || Date.now() };
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
  const { connected, configured, error, message, stale, checkedAt } = state;
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
    return { ...base, key: 'connected', known: true, showConnectCallToAction: false, label: 'Telegram connected', tone: 'online', detail: stale ? 'The latest status check failed, so this is the last confirmed state.' : null };
  }
  return { ...base, key: 'disconnected', known: true, showConnectCallToAction: true, label: 'Telegram not connected', tone: 'offline', detail: stale ? 'The latest status check failed, so this is the last confirmed state.' : (message || null) };
}

export const TelegramStatusContext = createContext(null);

export function TelegramStatusProvider({ token, children, pollIntervalMs = TELEGRAM_POLL_INTERVAL_MS, fetchStatus = null }) {
  const [state, dispatch] = useReducer(telegramStatusReducer, UNKNOWN_STATE);
  const mounted = useRef(true);
  const inFlight = useRef(null);
  // A fetcher seam keeps the flows testable without a network, exactly like the server's
  // fake adapters, and lets a caller reuse an already-loaded payload.
  const fetcher = useRef(fetchStatus || ((currentToken) => request(TELEGRAM_STATUS_ENDPOINT, currentToken)));
  if (fetchStatus) fetcher.current = fetchStatus;

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const refresh = useCallback(async () => {
    if (!token) {
      // Signed out: there is nothing to know, and no stale value to keep showing.
      dispatch({ type: 'reset' });
      return null;
    }
    if (inFlight.current) return inFlight.current;
    const run = async () => {
      try {
        const result = await fetcher.current(token);
        if (!mounted.current) return result;
        dispatch({ type: 'resolve', payload: result });
        return result;
      } catch (error) {
        // A failed check proves nothing about the account: the reducer keeps the last
        // confirmed answer as stale, or stays unknown if nothing was ever confirmed.
        if (mounted.current) dispatch({ type: 'reject', message: error?.message });
        return null;
      } finally {
        inFlight.current = null;
      }
    };
    inFlight.current = run();
    return inFlight.current;
  }, [token]);

  useEffect(() => { refresh(); }, [refresh]);

  useEffect(() => {
    if (!token || !pollIntervalMs) return undefined;
    const visible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden';
    const timer = setInterval(() => { if (visible()) refresh(); }, pollIntervalMs);
    const onVisible = () => { if (visible()) refresh(); };
    const targets = [
      [typeof window !== 'undefined' ? window : null, 'focus', onVisible],
      [typeof document !== 'undefined' ? document : null, 'visibilitychange', onVisible],
    ];
    for (const [target, event, handler] of targets) target?.addEventListener?.(event, handler);
    return () => {
      clearInterval(timer);
      for (const [target, event, handler] of targets) target?.removeEventListener?.(event, handler);
    };
  }, [token, pollIntervalMs, refresh]);

  /** Publish a status the caller already has, so a flow never waits for a second round trip. */
  const applyStatus = useCallback((result) => {
    if (mounted.current) dispatch({ type: 'apply', payload: result });
  }, []);

  const value = useMemo(() => ({
    ...state,
    view: telegramConnectionView(state),
    refresh,
    applyStatus,
    /** Local flows that know the answer without asking again (disconnect, failed restore). */
    markDisconnected: () => dispatch({ type: 'mark-disconnected' }),
  }), [state, refresh, applyStatus]);

  return <TelegramStatusContext.Provider value={value}>{children}</TelegramStatusContext.Provider>;
}

/**
 * Safe without a provider: an unmounted or unwired consumer gets the unknown view, which
 * renders a pending state rather than a connect button. Defaults must fail safe, because a
 * single forgotten provider is otherwise exactly the flash this module exists to remove.
 */
export function useTelegramStatus() {
  const context = useContext(TelegramStatusContext);
  return context || useMemo(() => ({
    ...UNKNOWN_STATE,
    view: telegramConnectionView(UNKNOWN_STATE),
    refresh: async () => null,
    applyStatus: () => {},
    markDisconnected: () => {},
  }), []);
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
