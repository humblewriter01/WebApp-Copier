import React, { createContext, useMemo } from 'react';
import { request } from '../lib/api.js';
import { STATUS_POLL_INTERVAL_MS, statusFailed, statusSettled, useStatusContext, useStatusResource } from '../lib/status-resource.js';

/**
 * The one place the app learns whether this service can create and configure MetaAPI
 * trading accounts, so the Trading Accounts page can never claim "setup is not available"
 * about a server it has not asked yet. Same rulebook as the Telegram connection: unknown is
 * its own state, only a confirmed `false` may show the fallback explanation, and a failed
 * check keeps the last confirmed answer instead of inventing a problem.
 */
export const METAAPI_PROVISIONING_STATUS_ENDPOINT = '/api/metaapi/provisioning-status';
export const METAAPI_POLL_INTERVAL_MS = STATUS_POLL_INTERVAL_MS;

const UNKNOWN_STATE = Object.freeze({
  loading: true,
  available: null,
  error: null,
  stale: false,
  checkedAt: null,
});

export function metaApiStatusReducer(state = UNKNOWN_STATE, action = {}) {
  switch (action.type) {
    case 'resolve':
    case 'apply':
      return statusSettled({ ...state, available: Boolean((action.payload || {}).available) }, action);
    case 'reject':
      return statusFailed(state, action);
    case 'reset':
      return UNKNOWN_STATE;
    default:
      return state;
  }
}

/**
 * `allowSetupForm` is deliberately stricter than "not told otherwise": the create form
 * submits a real provider request, so it appears only on a confirmed `true`, exactly as the
 * Telegram connect prompt appears only on a confirmed `false`.
 */
export function metaApiProvisioningView(state = UNKNOWN_STATE) {
  const { available, error, stale, checkedAt } = state;
  const base = { available: available === true, stale: Boolean(stale), checkedAt: checkedAt || null };
  if (available === null) {
    return error
      ? { ...base, key: 'unreachable', known: false, allowSetupForm: false, label: 'Status unavailable', tone: 'pending', detail: 'Signal Desk could not confirm whether account setup is available right now.' }
      : { ...base, key: 'checking', known: false, allowSetupForm: false, label: 'Checking setup…', tone: 'pending', detail: null };
  }
  if (available) {
    return { ...base, key: 'ready', known: true, allowSetupForm: true, label: 'Setup ready', tone: 'online', detail: stale ? 'The latest check failed, so this is the last confirmed state.' : null };
  }
  return {
    ...base,
    key: 'unavailable',
    known: true,
    allowSetupForm: false,
    label: 'Setup unavailable',
    tone: 'offline',
    detail: 'Account setup is not available yet. Please ask the workspace owner to finish setting up account connections.',
  };
}

export const MetaApiStatusContext = createContext(null);

const fetchMetaApiStatus = (token) => request(METAAPI_PROVISIONING_STATUS_ENDPOINT, token);

/** `fetchStatus` is a seam, so the flows are testable without a network. */
export function MetaApiStatusProvider({ token, children, pollIntervalMs = METAAPI_POLL_INTERVAL_MS, fetchStatus = fetchMetaApiStatus }) {
  const { state, refresh, publish } = useStatusResource({
    token, fetchStatus, reducer: metaApiStatusReducer, initialState: UNKNOWN_STATE, pollIntervalMs,
  });

  const value = useMemo(() => ({
    ...state,
    view: metaApiProvisioningView(state),
    refresh,
    /** A flow that already learned the answer (for example a 503 on create) publishes it. */
    applyStatus: (result) => publish({ type: 'apply', payload: result }),
  }), [state, refresh, publish]);

  return <MetaApiStatusContext.Provider value={value}>{children}</MetaApiStatusContext.Provider>;
}

/** A status value with no live provider behind it: real state, no working actions. */
export function staticMetaApiStatusValue(state = UNKNOWN_STATE) {
  return {
    ...state,
    view: metaApiProvisioningView(state),
    refresh: async () => null,
    applyStatus: () => {},
  };
}

const METAAPI_FALLBACK = Object.freeze(staticMetaApiStatusValue());

export function useMetaApiStatus() {
  return useStatusContext(MetaApiStatusContext, METAAPI_FALLBACK);
}

export function MetaApiStatusPill({ detailed = false }) {
  const { view } = useMetaApiStatus();
  const pending = view.key === 'checking' || view.key === 'unreachable';
  return <span className={`status-pill metaapi-status-pill ${view.tone === 'online' ? 'online' : ''} ${pending ? 'pending' : ''}`} role="status" aria-live="polite">
    {pending ? <span className="skeleton skeleton-dot" aria-hidden="true" /> : <i aria-hidden="true" />}
    <span>{view.label}</span>
    {detailed && view.detail ? <small>{view.detail}</small> : null}
  </span>;
}
