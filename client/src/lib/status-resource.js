import { useCallback, useContext, useEffect, useMemo, useReducer, useRef } from 'react';

/**
 * Shared plumbing for "ask the backend, then tell every surface the same answer".
 *
 * Both remote indicators in this app — the Telegram connection and MetaAPI account setup —
 * broke in exactly the same way: each component kept a private copy of the status that
 * defaulted to the negative answer, so a page flashed "not connected" or "unavailable"
 * while its request was still in flight. That default is the bug rather than a detail, so
 * the rules that prevent it live here once, and no surface can opt out of them:
 *
 *  - until the backend answers, the state is unknown, never `false`;
 *  - concurrent refreshes collapse into one request;
 *  - a failed check never invents a disconnection — the last confirmed answer is kept and
 *    marked stale, and only a resource that never resolved stays unknown;
 *  - the answer is re-read when the tab regains focus or becomes visible, because the API
 *    service can sleep between visits and something elsewhere may already have changed it.
 *
 * A domain supplies the reducer that maps its own fields, so the policy stays shared while
 * the vocabulary of each endpoint stays local.
 */
export const STATUS_POLL_INTERVAL_MS = 30_000;

/** True once this resource has ever received an answer for the current sign-in. */
function hasConfirmedAnswer(state) {
  return state?.checkedAt != null;
}

/** Settle the shared bookkeeping when an answer arrives, from a fetch or from a local flow. */
export function statusSettled(state, action = {}) {
  return { ...state, loading: false, error: null, stale: false, checkedAt: action.at || Date.now() };
}

/** A failed check is not evidence: keep what was confirmed, otherwise stay unknown. */
export function statusFailed(state, action = {}) {
  const confirmed = hasConfirmedAnswer(state);
  return {
    ...state,
    loading: !confirmed,
    stale: confirmed,
    error: action.message || 'This status could not be checked right now.',
  };
}

export function useStatusResource({ token, fetchStatus, reducer, initialState, pollIntervalMs = STATUS_POLL_INTERVAL_MS }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const mounted = useRef(true);
  const inFlight = useRef(null);
  // The fetcher is read through a ref so a caller passing a fresh function on every render
  // cannot re-create `refresh` and turn the mount effect into a request loop.
  const fetcher = useRef(fetchStatus);

  useEffect(() => { fetcher.current = fetchStatus; }, [fetchStatus]);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const refresh = useCallback(async () => {
    // Signed out: there is nothing to know and no value worth keeping on screen.
    if (!token) { dispatch({ type: 'reset' }); return null; }
    if (inFlight.current) return inFlight.current;
    const run = async () => {
      try {
        const payload = await fetcher.current(token);
        if (mounted.current) dispatch({ type: 'resolve', payload });
        return payload;
      } catch (error) {
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
    const onVisible = () => { if (visible()) refresh(); };
    const timer = setInterval(() => { if (visible()) refresh(); }, pollIntervalMs);
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

  /** Let a flow publish an outcome it already knows, without waiting for another round trip. */
  const publish = useCallback((action) => {
    if (mounted.current) dispatch(action);
  }, []);

  return { state, refresh, publish };
}

/**
 * Read a status context with a fail-safe default. A component rendered without a provider
 * (a forgotten wrapper, an isolated test render, a page mounted early) must land on the
 * unknown state rather than a guessed one, and the fallback is memoised unconditionally so
 * the hook order never changes when a provider is added above the component.
 */
export function useStatusContext(context, unknownValue) {
  const value = useContext(context);
  const fallback = useMemo(() => unknownValue, [unknownValue]);
  return value || fallback;
}
