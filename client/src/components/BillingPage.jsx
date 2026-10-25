import React, { useCallback, useEffect, useState } from 'react';
import { request } from '../lib/api.js';

/** Cheapest to most expensive, used to offer the next step up rather than a fixed plan. */
export const PLAN_ORDER = Object.freeze(['free', 'starter', 'pro', 'premium']);

export function nextPlanKey(current, plans = []) {
  const keys = (plans || []).map((plan) => plan.key);
  const rank = (key) => PLAN_ORDER.indexOf(String(key || 'free'));
  const from = rank(current);
  return keys.filter((key) => rank(key) > (from === -1 ? -1 : from))[0] || keys[keys.length - 1] || PLAN_ORDER[1];
}

/** Zero is a real allowance on Free, and "0 trading accounts" reads like a bug. */
function accountAllowance(limit) {
  const value = Number(limit);
  if (!Number.isFinite(value)) return '1 trading account';
  return value === 0 ? 'No trading accounts' : `${value} trading account${value === 1 ? '' : 's'}`;
}

function formatMoney(amountMinor, currency = 'NGN') {
  const value = Number(amountMinor || 0) / 100;
  try {
    return new Intl.NumberFormat('en-NG', { style: 'currency', currency, maximumFractionDigits: 2 }).format(value);
  } catch {
    return `${currency} ${value.toFixed(2)}`;
  }
}

function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function statusLabel(subscription) {
  if (!subscription) return 'Free';
  if (subscription.status === 'free') return 'Free plan';
  if (subscription.cancelAtPeriodEnd) return 'Cancels at period end';
  if (subscription.status === 'active') return 'Active';
  if (subscription.status === 'past_due') return 'Payment due';
  if (subscription.status === 'canceled') return 'Ended';
  return subscription.status;
}

export default function BillingPage({ token }) {
  const [plans, setPlans] = useState([]);
  const [data, setData] = useState(null);
  const [promoCode, setPromoCode] = useState('');
  const [quote, setQuote] = useState(null);
  const [quoteError, setQuoteError] = useState('');
  const [selectedPlan, setSelectedPlan] = useState('starter');
  const [busy, setBusy] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    setError('');
    try {
      const [plansData, subscriptionData] = await Promise.all([
        request('/api/billing/plans', token),
        request('/api/billing/subscription', token),
      ]);
      setPlans(plansData.plans || []);
      setData(subscriptionData);
      // Offer the next tier up, so a free user is shown Starter rather than the top plan.
      const current = subscriptionData?.subscription?.plan;
      const next = nextPlanKey(current, plansData.plans || []);
      if (next) setSelectedPlan(next);
    } catch (loadError) {
      setError(loadError.message);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { load(); }, [load]);

  const applyPromo = async () => {
    setQuoteError('');
    setQuote(null);
    if (!promoCode.trim()) return;
    try {
      const result = await request(`/api/billing/quote?plan=${encodeURIComponent(selectedPlan)}&code=${encodeURIComponent(promoCode.trim())}`, token);
      setQuote(result.quote);
    } catch (quoteFailure) {
      setQuoteError(quoteFailure.message);
    }
  };

  const upgrade = async (planKey) => {
    setBusy(planKey);
    setError('');
    setNotice('');
    try {
      const result = await request('/api/billing/checkout', token, {
        method: 'POST',
        body: { plan: planKey, promoCode: promoCode.trim() || undefined },
      });
      setNotice('Redirecting you to the secure Paystack checkout…');
      window.location.assign(result.checkout.authorizationUrl);
    } catch (checkoutError) {
      setError(checkoutError.message);
      setBusy('');
    }
  };

  const cancelSubscription = async () => {
    if (!window.confirm('Cancel renewal? You keep access until the end of the paid period.')) return;
    setBusy('cancel');
    setError('');
    try {
      const result = await request('/api/billing/cancel', token, { method: 'POST' });
      setData((current) => ({ ...current, subscription: result.subscription }));
      const provider = result.subscription?.provider;
      if (provider?.status === 'failed') setError(provider.message);
      else setNotice(provider?.message || 'Renewal canceled. Your plan stays active until the end of the current period.');
    } catch (cancelError) {
      setError(cancelError.message);
    } finally { setBusy(''); }
  };

  const resumeSubscription = async () => {
    setBusy('resume');
    setError('');
    try {
      const result = await request('/api/billing/resume', token, { method: 'POST' });
      setData((current) => ({ ...current, subscription: result.subscription }));
      const provider = result.subscription?.provider;
      if (provider?.status === 'failed') setError(provider.message);
      else setNotice(provider?.message || 'Renewal resumed.');
    } catch (resumeError) {
      setError(resumeError.message);
    } finally { setBusy(''); }
  };

  if (loading) return <section className="panel"><div className="loading-shell inline-loading"><div className="spinner" /><span>Loading your plan…</span></div></section>;

  const subscription = data?.subscription;
  const currentPlan = subscription?.plan || 'free';
  const currency = data?.currency || 'NGN';
  const selected = plans.find((plan) => plan.key === selectedPlan);
  const quotedAmount = quote?.plan === selectedPlan ? quote.amountMinor : selected?.amountMinor;

  return <>
    {error && <div className="alert alert-error global-alert" role="alert">{error}<button className="alert-close" type="button" onClick={() => setError('')}>×</button></div>}
    {notice && <div className="alert alert-success global-alert" role="status" aria-live="polite">{notice}<button className="alert-close" type="button" onClick={() => setNotice('')}>×</button></div>}

    <section className="panel billing-current" aria-labelledby="current-plan-title">
      <div className="panel-heading">
        <div><p className="eyebrow">SUBSCRIPTION</p><h2 id="current-plan-title">Your plan</h2></div>
        <span className={`status-pill ${currentPlan !== 'free' ? 'online' : ''}`}>{statusLabel(subscription)}</span>
      </div>
      <div className="billing-current-body">
        <div>
          <strong className="billing-plan-name">{subscription?.planName || 'Free'}</strong>
          <p className="muted">
            {currentPlan === 'free'
              ? 'Signal capture and review only. Automated execution and trading accounts need a paid plan.'
              : `Renews ${subscription?.cancelAtPeriodEnd ? 'until' : 'every period ending'} ${formatDate(subscription?.currentPeriodEnd)}.`}
          </p>
        </div>
        <div className="billing-limit-list">
          <span>{accountAllowance(data?.limits?.maxTradingAccounts)}</span>
          <span>{data?.limits?.maxTelegramChannels ?? 2} Telegram channels</span>
        </div>
      </div>
      {currentPlan !== 'free' && <div className="button-row billing-actions">
        {subscription?.cancelAtPeriodEnd
          ? <button type="button" className="button button-primary button-small" disabled={busy === 'resume'} onClick={resumeSubscription}>{busy === 'resume' ? 'Resuming…' : 'Resume renewal'}</button>
          : <button type="button" className="button button-secondary button-small" disabled={busy === 'cancel'} onClick={cancelSubscription}>{busy === 'cancel' ? 'Canceling…' : 'Cancel renewal'}</button>}
      </div>}
      {!data?.configured && <div className="alert alert-info" role="status">Payments are temporarily unavailable. Please try again later.</div>}
    </section>

    <section className="panel billing-plans" aria-labelledby="plans-title">
      <div className="panel-heading"><div><p className="eyebrow">PLANS</p><h2 id="plans-title">Choose a plan</h2></div></div>
      <div className="billing-plan-grid">
        <article className={`billing-plan-card ${currentPlan === 'free' ? 'current' : ''}`}>
          <header><h3>Free</h3><p>Monitor signals without automating a broker account.</p></header>
          <p className="billing-price">{formatMoney(0, currency)}<span>/month</span></p>
          <ul><li className="billing-plan-absent">No trading accounts</li><li>2 Telegram channels</li><li>50 signals per day</li><li className="billing-plan-absent">No automated execution</li></ul>
          <button type="button" className="button button-secondary" disabled>{currentPlan === 'free' ? 'Current plan' : 'Included'}</button>
        </article>
        {plans.map((plan) => {
          const isCurrent = currentPlan === plan.key;
          return <article key={plan.key} className={`billing-plan-card ${isCurrent ? 'current' : ''}`}>
            <header><h3>{plan.name}</h3><p>{plan.description}</p></header>
            <p className="billing-price">{formatMoney(plan.amountMinor, plan.currency)}<span>/{plan.interval === 'annually' ? 'year' : 'month'}</span></p>
            <p className="billing-price-note">{plan.renewsAutomatically ? 'Renews automatically — cancel any time.' : 'One payment for one period.'}</p>
            <ul>
              <li>{plan.limits.maxTradingAccounts} trading accounts</li>
              <li>{plan.limits.maxTelegramChannels} Telegram channels</li>
              <li>{plan.limits.maxDailySignals} signals per day</li>
            </ul>
            <button
              type="button"
              className="button button-primary"
              disabled={Boolean(busy) || !data?.configured || isCurrent}
              onClick={() => { setSelectedPlan(plan.key); upgrade(plan.key); }}
            >
              {isCurrent ? 'Current plan' : busy === plan.key ? 'Opening checkout…' : `Choose ${plan.name}`}
            </button>
          </article>;
        })}
      </div>

      <form className="billing-promo" onSubmit={(event) => { event.preventDefault(); applyPromo(); }}>
        <label htmlFor="billing-promo-code">Promo code
          <input id="billing-promo-code" value={promoCode} onChange={(event) => { setPromoCode(event.target.value.toUpperCase()); setQuote(null); setQuoteError(''); }} placeholder="LAUNCH25" maxLength={50} autoComplete="off" />
        </label>
        <button type="submit" className="button button-secondary button-small" disabled={!promoCode.trim()}>Apply</button>
      </form>
      <p className="field-help">
        Discounts apply to the plan you select. Applied at checkout for {selected?.name || 'the selected plan'}:
        {' '}<strong>{formatMoney(quotedAmount, currency)}</strong>
        {quote?.discountMinor ? <span> (saving {formatMoney(quote.discountMinor, currency)})</span> : null}
        {quote?.promoCode ? <span> A discounted period is paid once and does not renew automatically.</span> : null}
      </p>
      {quoteError && <div className="alert alert-error" role="alert">{quoteError}</div>}
    </section>

    <section className="panel billing-history" aria-labelledby="billing-history-title">
      <div className="panel-heading"><div><p className="eyebrow">PAYMENTS</p><h2 id="billing-history-title">Recent payments</h2></div></div>
      {!data?.recentTransactions?.length ? <div className="empty-state"><strong>No payments yet</strong><span>Your Paystack receipts will appear here after a successful checkout.</span></div> : <div className="admin-table-wrap">
        <table className="admin-table">
          <caption className="sr-only">Recent Paystack payments</caption>
          <thead><tr><th scope="col">Reference</th><th scope="col">Plan</th><th scope="col">Amount</th><th scope="col">Status</th><th scope="col">Paid</th></tr></thead>
          <tbody>
            {data.recentTransactions.map((transaction) => <tr key={transaction.reference}>
              <td data-label="Reference"><strong>{transaction.reference}</strong>{transaction.promoCode ? <small>Promo {transaction.promoCode}</small> : null}</td>
              <td data-label="Plan">{plans.find((plan) => plan.key === transaction.planKey)?.name || transaction.planKey}{transaction.source === 'renewal' ? <small>Auto-renewal</small> : null}</td>
              <td data-label="Amount">{formatMoney(transaction.amountMinor, transaction.currency || currency)}</td>
              <td data-label="Status"><span className={`badge ${transaction.status === 'success' ? 'badge-buy' : ''}`}>{transaction.status}</span></td>
              <td data-label="Paid">{transaction.paidAt ? formatDate(transaction.paidAt) : '—'}</td>
            </tr>)}
          </tbody>
        </table>
      </div>}
      <p className="field-help">Prices are the ones the workspace publishes today. Payments are processed by Paystack; Signal Desk never receives or stores your card details.</p>
    </section>
  </>;
}
