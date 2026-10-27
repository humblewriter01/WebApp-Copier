import React, { useCallback, useEffect, useState } from 'react';
import { request } from '../lib/api.js';
import { useFlutterwave } from '../lib/flutterwave.js';

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

/* A dollar price formatted with a Nigerian locale prints "$39.00" with the grouping most readers here expect
   for naira but the wrong decimal convention for cents, and vice versa; the locale travels with the currency. */
const MONEY_LOCALES = { NGN: 'en-NG', USD: 'en-US' };

export function formatMoney(amountMinor, currency = 'NGN') {
  const code = String(currency || 'NGN').toUpperCase();
  const value = Number(amountMinor || 0) / 100;
  try {
    return new Intl.NumberFormat(MONEY_LOCALES[code] || 'en-NG', { style: 'currency', currency: code, maximumFractionDigits: 2 }).format(value);
  } catch {
    return `${code} ${value.toFixed(2)}`;
  }
}

/**
 * The price of a plan in one currency, in hundredths, or null when the workspace does not sell it in that
 * currency. `prices` is the map the toggle reads; the two flat fields are the same numbers from the same
 * snapshot, kept so a client that has not been taught about currencies still shows a price.
 */
export function priceFor(plan, currency = 'NGN') {
  if (!plan) return null;
  const code = String(currency || 'NGN').toUpperCase();
  const entry = plan.prices?.[code];
  if (entry && entry.amountMinor !== null && entry.amountMinor !== undefined) return Number(entry.amountMinor);
  if (code === 'USD') return plan.usdAmountMinor ?? null;
  return plan.amountMinor ?? null;
}

/** Every currency at least one published plan is priced in - the toggle only offers what can be bought. */
export function pricedCurrencies(plans = []) {
  const codes = new Set();
  for (const plan of plans || []) {
    for (const [code, entry] of Object.entries(plan.prices || {})) {
      if (entry && entry.amountMinor !== null && entry.amountMinor !== undefined) codes.add(code);
    }
    if (plan.amountMinor !== null && plan.amountMinor !== undefined) codes.add('NGN');
    if (plan.usdAmountMinor !== null && plan.usdAmountMinor !== undefined) codes.add('USD');
  }
  return [...codes];
}

function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/**
 * The `[ NGN ] [ USD ]` switch.
 *
 * It is a group of two pressed buttons rather than a dropdown or a radio pair because it changes what a price
 * *says*, on the page you are already looking at, with no navigation and no round trip. A currency the
 * workspace has no price in is shown and disabled instead of hidden: the trader can then see that dollars
 * exist and are simply not offered yet, which is a different message from a control that pretends not to be
 * there.
 */
export function CurrencyToggle({ value = 'NGN', options = ['NGN', 'USD'], available = options, onChange, onSelect } = {}) {
  if (options.length < 2) return null;
  return <div className="billing-currency-toggle" role="group" aria-label="Price currency">
    {options.map((code) => {
      const offered = available.includes(code);
      return <button
        key={code}
        type="button"
        className={`billing-currency-button ${value === code ? 'active' : ''}`}
        aria-pressed={value === code}
        disabled={!offered}
        title={offered ? `Show prices in ${code === 'NGN' ? 'naira' : 'US dollars'}` : 'Not offered in this currency yet'}
        onClick={() => { if (!offered) return; if (value !== code) onChange?.(code); onSelect?.(code); }}
      >{code}</button>;
    })}
  </div>;
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
  // Naira first, always: it is the currency this workspace was built for, and a visitor who never touches the
  // toggle must see exactly what they saw before dollars existed here.
  const [currency, setCurrency] = useState('NGN');
  const [data, setData] = useState(null);
  const [promoCode, setPromoCode] = useState('');
  const [quote, setQuote] = useState(null);
  const [quoteError, setQuoteError] = useState('');
  const [selectedPlan, setSelectedPlan] = useState('starter');
  const [busy, setBusy] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const flutterwave = useFlutterwave();

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

  const applyPromo = useCallback(async ({ planKey = selectedPlan, code = promoCode, currency: quotedCurrency = currency } = {}) => {
    if (!String(code || '').trim()) return null;
    setQuoteError('');
    setQuote(null);
    try {
      const result = await request(`/api/billing/quote?plan=${encodeURIComponent(planKey)}&code=${encodeURIComponent(String(code).trim())}&currency=${encodeURIComponent(quotedCurrency)}`, token);
      setQuote(result.quote);
      return result.quote;
    } catch (quoteFailure) {
      setQuoteError(quoteFailure.message);
      return null;
    }
  }, [promoCode, selectedPlan, currency, token]);

  // Switching currencies re-prices the card instantly and re-quotes the discount, because "25% off" and
  // "₦2,000 off" mean different things in dollars and the server is the one that decides.
  useEffect(() => {
    if (quote || quoteError) applyPromo({ code: promoCode });
    // The quote is re-fetched only when the currency changes; every other dependency is already in the call.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currency]);

  const upgrade = async (planKey) => {
    setBusy(planKey);
    setError('');
    setNotice('');
    try {
      // Only the plan and the chosen currency are sent. The amount is looked up here and priced there by the
      // server, which is what makes a tampered browser unable to change what anybody pays.
      const result = await request('/api/billing/checkout', token, {
        method: 'POST',
        body: { plan: planKey, currency, promoCode: promoCode.trim() || undefined },
      });
      setNotice(`Opening the secure Flutterwave checkout for ${formatMoney(result.checkout.amountMinor, result.checkout.currency)}…`);
      await flutterwave.start(result.checkout);
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
  const supported = pricedCurrencies(plans);
  // Every currency the workspace publishes, priced or not: the switch shows an unpriced one as disabled rather
  // than hiding it, because "dollars are not offered here yet" is an answer and a missing control is not.
  const supportedOptions = (data?.supportedCurrencies?.length ? data.supportedCurrencies : [...new Set([...supported, 'NGN', 'USD'])]);
  const payCurrency = supported.includes(currency) ? currency : (supported[0] || 'NGN');
  if (payCurrency !== currency) setCurrency(payCurrency);
  const selected = plans.find((plan) => plan.key === selectedPlan);
  const quotedAmount = (quote?.plan === selectedPlan && quote?.currency === payCurrency) ? quote.amountMinor : priceFor(selected, payCurrency);
  const periodWord = (plan) => (plan?.interval === 'annually' || plan?.interval === 'yearly' ? 'year' : 'month');

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
      <div className="panel-heading">
        <div><p className="eyebrow">PLANS</p><h2 id="plans-title">Choose a plan</h2></div>
        <CurrencyToggle
          value={payCurrency}
          options={supportedOptions}
          available={supported}
          onChange={setCurrency}
          onSelect={(code) => { setCurrency(code); if (quote || quoteError) applyPromo({ code: promoCode }); }}
        />
      </div>
      <div className="billing-plan-grid">
        <article className={`billing-plan-card ${currentPlan === 'free' ? 'current' : ''}`}>
          <header><h3>Free</h3><p>Monitor signals without automating a broker account.</p></header>
          <p className="billing-price">{formatMoney(0, payCurrency)}<span>/month</span></p>
          <ul><li className="billing-plan-absent">No trading accounts</li><li>2 Telegram channels</li><li>50 signals per day</li><li className="billing-plan-absent">No automated execution</li></ul>
          <button type="button" className="button button-secondary" disabled>{currentPlan === 'free' ? 'Current plan' : 'Included'}</button>
        </article>
        {plans.map((plan) => {
          const isCurrent = currentPlan === plan.key;
          const amountMinor = priceFor(plan, payCurrency);
          const unpriced = amountMinor === null;
          return <article key={plan.key} className={`billing-plan-card ${isCurrent ? 'current' : ''}`}>
            <header><h3>{plan.name}</h3><p>{plan.description}</p></header>
            <p className="billing-price">{unpriced ? <span className="billing-price-unavailable">Not sold in {payCurrency}</span> : formatMoney(amountMinor, payCurrency)}<span>/{periodWord(plan)}</span></p>
            <p className="billing-price-note">{plan.renewsAutomatically?.[payCurrency] ? 'Renews automatically — cancel any time.' : 'One payment for one period.'}</p>
            <ul>
              <li>{plan.limits.maxTradingAccounts} trading accounts</li>
              <li>{plan.limits.maxTelegramChannels} Telegram channels</li>
              <li>{plan.limits.maxDailySignals} signals per day</li>
            </ul>
            <button
              type="button"
              className="button button-primary"
              disabled={Boolean(busy) || !data?.configured || isCurrent || unpriced}
              onClick={() => { setSelectedPlan(plan.key); upgrade(plan.key); }}
            >
              {isCurrent ? 'Current plan' : busy === plan.key ? 'Opening checkout…' : unpriced ? `Unavailable in ${payCurrency}` : `Choose ${plan.name}`}
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
        Discounts apply to the plan you select. Applied at checkout for {selected?.name || 'the selected plan'} in {payCurrency}:
        {' '}<strong>{quotedAmount === null ? 'no price set' : formatMoney(quotedAmount, payCurrency)}</strong>
        {quote?.discountMinor ? <span> (saving {formatMoney(quote.discountMinor, quote.currency || payCurrency)})</span> : null}
        {quote?.promoCode ? <span> A discounted period is paid once and does not renew automatically.</span> : null}
      </p>
      {quoteError && <div className="alert alert-error" role="alert">{quoteError}</div>}
    </section>

    <section className="panel billing-history" aria-labelledby="billing-history-title">
      <div className="panel-heading"><div><p className="eyebrow">PAYMENTS</p><h2 id="billing-history-title">Recent payments</h2></div></div>
      {!data?.recentTransactions?.length ? <div className="empty-state"><strong>No payments yet</strong><span>Your Flutterwave receipts will appear here after a successful checkout.</span></div> : <div className="admin-table-wrap">
        <table className="admin-table">
          <caption className="sr-only">Recent payments</caption>
          <thead><tr><th scope="col">Reference</th><th scope="col">Plan</th><th scope="col">Amount</th><th scope="col">Status</th><th scope="col">Paid</th></tr></thead>
          <tbody>
            {data.recentTransactions.map((transaction) => <tr key={transaction.reference}>
              <td data-label="Reference"><strong>{transaction.reference}</strong>{transaction.promoCode ? <small>Promo {transaction.promoCode}</small> : null}</td>
              <td data-label="Plan">{plans.find((plan) => plan.key === transaction.planKey)?.name || transaction.planKey}{transaction.source === 'renewal' ? <small>Auto-renewal</small> : null}</td>
              <td data-label="Amount">{formatMoney(transaction.amountMinor, transaction.currency || payCurrency)}</td>
              <td data-label="Status"><span className={`badge ${transaction.status === 'success' ? 'badge-buy' : ''}`}>{transaction.status}</span></td>
              <td data-label="Paid">{transaction.paidAt ? formatDate(transaction.paidAt) : '—'}</td>
            </tr>)}
          </tbody>
        </table>
      </div>}
      <p className="field-help">Prices are the ones the workspace publishes today, in the currency you picked above. Payments are processed by Flutterwave; Signal Desk never receives or stores your card details.</p>
    </section>
  </>;
}
