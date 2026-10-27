import React, { useEffect, useState } from 'react';
import { request } from '../lib/api.js';

function readToken() {
  try { return localStorage.getItem('signal-token') || sessionStorage.getItem('signal-token') || ''; } catch { return ''; }
}

/**
 * Landing page for Flutterwave's `redirect_url`. Flutterwave appends `tx_ref` plus its own `status` and
 * `transaction_id`, and the reference this app issued is what ties them back to a plan - so the reference is
 * read from wherever it is, then handed to GET /api/billing/verify, which asks Flutterwave directly before
 * anything is granted. A visit to this page has never bought anything: it can only confirm what the provider
 * already says was paid.
 */
export default function BillingCallbackPage() {
  const [state, setState] = useState({ phase: 'checking', message: 'Verifying your payment…' });

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    // `tx_ref` is what Flutterwave sends back; `reference`/`trxref` are the older spellings, kept so a checkout
    // started before this deploy still lands somewhere honest instead of on "missing reference".
    const reference = params.get('tx_ref') || params.get('reference') || params.get('trxref') || '';
    const reported = String(params.get('status') || '').toLowerCase();
    const token = readToken();
    if (!token) {
      setState({ phase: 'error', message: 'Sign in to finish confirming this payment.' });
      return;
    }
    if (!reference) {
      setState({ phase: 'error', message: 'This payment link is missing its reference. Return to Billing to try again.' });
      return;
    }
    if (reported === 'failed' || reported === 'cancelled' || reported === 'canceled') {
      setState({ phase: 'error', message: 'Flutterwave reported this payment as not completed. Nothing was charged, so you can try again from Billing.' });
      return;
    }
    request(`/api/billing/verify?reference=${encodeURIComponent(reference)}`, token)
      .then((result) => {
        if (result.subscription?.status === 'active') {
          setState({ phase: 'success', message: `Your ${result.subscription.planName} plan is active.`, subscription: result.subscription });
        } else if (result.alreadyProcessed) {
          setState({ phase: 'success', message: 'This payment was already confirmed.', subscription: result.subscription });
        } else {
          setState({ phase: 'pending', message: 'Flutterwave has not confirmed this payment yet. Refresh in a moment or check Billing.', subscription: result.subscription });
        }
      })
      .catch((error) => {
        setState({ phase: 'error', message: error.message || 'We could not confirm this payment. Check Billing for your latest status.' });
      });
  }, []);

  return <main className="auth-shell">
    <div className="auth-brand"><div className="brand-mark"><img src="/icons/signal-desk-icon-192.png" alt="" /></div><span>Signal Desk</span></div>
    <section className="auth-card" aria-labelledby="billing-callback-title" aria-live="polite">
      <p className="eyebrow">PAYMENT STATUS</p>
      <h1 id="billing-callback-title">
        {state.phase === 'success' ? 'Payment confirmed' : state.phase === 'error' ? 'Payment not confirmed' : state.phase === 'pending' ? 'Payment pending' : 'Checking payment'}
      </h1>
      {state.phase === 'checking'
        ? <div className="loading-shell inline-loading"><div className="spinner" /><span>{state.message}</span></div>
        : <>
          <p className="muted">{state.message}</p>
          {state.subscription?.currentPeriodEnd && <p className="muted">Access runs until {new Date(state.subscription.currentPeriodEnd).toLocaleDateString()}.</p>}
          <a className="button button-primary button-wide auth-link-button" href="/billing">Go to Billing</a>
        </>}
    </section>
  </main>;
}
