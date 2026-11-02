/** Public overview and pricing for Signal Desk. */
import React, { useEffect, useState } from 'react';
import { request } from '../lib/api.js';

const DEFAULT_PRICING = [
  { key: 'free', name: 'Free', amount: 0, currency: 'USD', prices: { USD: 0, NGN: 0 }, interval: 'monthly', description: 'Explore signal capture and review.' },
  { key: 'starter', name: 'Starter', amount: 39, currency: 'USD', prices: { USD: 39, NGN: 60000 }, interval: 'monthly', description: 'A focused setup for one trading account.' },
  { key: 'pro', name: 'Pro', amount: 69, currency: 'USD', prices: { USD: 69, NGN: 105000 }, interval: 'monthly', description: 'More accounts and room for active channels.' },
  { key: 'premium', name: 'Premium', amount: 99, currency: 'USD', prices: { USD: 99, NGN: 150000 }, interval: 'monthly', description: 'Higher limits for multiple accounts and busy channels.' },
];
const SAMPLE_SIGNALS = [
  { id: 'xau', symbol: 'XAUUSD', side: 'SELL', entry: '2 612.50', stop: '2 622.00', target: '2 592.00', state: 'Executed', detail: '0.10 lots · 2 s after the post' },
  { id: 'eur', symbol: 'EURUSD', side: 'BUY', entry: '1.0842', stop: '1.0812', target: '1.0902', state: 'Held for review', detail: 'no price in the message, so nothing was sent' },
];
const SAMPLE_POSITION = { symbol: 'XAUUSD', side: 'SELL', volume: '0.10', open: '2 612.50', stop: '2 622.00', target: '2 592.00', result: '−48.20 USD' };
const SAMPLE_RISK = [['Risk per trade', '1 %'], ['Open positions at once', '3'], ['Daily loss limit', '5 %'], ['Stop loss required', 'Yes'], ['Take profit required', 'Yes']];
const STEPS = [
  ['Point it at your channels', 'Connect Telegram and choose the channels whose signals you want Signal Desk to monitor.'],
  ['It reads the signal', 'AI parses the message, then checks for a clear price and stop loss before anything can be sent.'],
  ['The order goes to your broker', 'Once enabled, the order is executed on your MT4 or MT5 account within your limits.'],
];
const FAQS = [
  ['Does this work with my broker?', 'Yes. Signal Desk works with any MT4 or MT5 broker.'],
  ['Do I need a VPS?', 'No. Signal Desk runs in the cloud, so you do not need to maintain a VPS.'],
  ['Does it give trading advice?', 'No. Signal Desk is an execution tool, not an adviser. You choose your signals and control your risk.'],
];

function MockDashboard() {
  return <div className="landing-demo" aria-hidden="false">
    <div className="landing-demo-bar"><span className="landing-demo-title">Signal Desk · workspace</span><span className="landing-demo-tag">Sample data, not a live account</span></div>
    <div className="landing-demo-row landing-demo-switch"><span className="landing-demo-label">Auto-Trading</span><span className="landing-switch" data-on="false"><span className="landing-switch-knob" /></span><span className="landing-demo-note">Off until you turn it on. Turning it on asks you to confirm what that means.</span></div>
    <div className="landing-demo-signals">{SAMPLE_SIGNALS.map((signal) => <div className="landing-signal" key={signal.id}><span className={`landing-side landing-side-${signal.side.toLowerCase()}`}>{signal.side}</span><span className="landing-symbol">{signal.symbol}<small>{signal.entry} · SL {signal.stop} · TP {signal.target}</small></span><span className="landing-state">{signal.state}<small>{signal.detail}</small></span></div>)}</div>
    <div className="landing-demo-grid">
      <div className="landing-panel"><h4>Open position</h4><dl className="landing-pairs"><div><dt>Instrument</dt><dd>{SAMPLE_POSITION.symbol} · {SAMPLE_POSITION.side}</dd></div><div><dt>Volume</dt><dd>{SAMPLE_POSITION.volume}</dd></div><div><dt>Entry</dt><dd>{SAMPLE_POSITION.open}</dd></div><div><dt>Stop / target</dt><dd>{SAMPLE_POSITION.stop} · {SAMPLE_POSITION.target}</dd></div><div><dt>Result so far</dt><dd>{SAMPLE_POSITION.result}</dd></div></dl></div>
      <div className="landing-panel"><h4>Your limits</h4><dl className="landing-pairs">{SAMPLE_RISK.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl></div>
    </div>
    <p className="landing-demo-foot">Nothing in this picture is connected to anything. No broker, no money, no channel.</p>
  </div>;
}

function priceAmount(plan, currency) {
  const entry = plan.prices?.[currency];
  if (entry && typeof entry === 'object') return entry.amount ?? (entry.amountMinor == null ? null : Number(entry.amountMinor) / 100);
  if (entry !== undefined) return entry;
  return plan.currency === currency ? (plan.amount ?? (plan.amountMinor == null ? null : Number(plan.amountMinor) / 100)) : null;
}

function formatPrice(plan, currency) {
  const amount = priceAmount(plan, currency);
  if (amount === null || amount === undefined) return 'Contact us';
  if (Number(amount) === 0) return 'Free';
  try {
    return new Intl.NumberFormat(currency === 'NGN' ? 'en-NG' : 'en-US', { style: 'currency', currency, maximumFractionDigits: 2 }).format(Number(amount));
  } catch {
    return `${currency} ${Number(amount).toLocaleString()}`.trim();
  }
}

export default function Landing({ onEnterAuth = () => {}, installPrompt = null, onInstall = () => {} }) {
  const [plans, setPlans] = useState(DEFAULT_PRICING);
  const [currency, setCurrency] = useState('USD');

  useEffect(() => {
    let active = true;
    request('/api/public/pricing').then((payload) => {
      if (!active || !Array.isArray(payload?.plans)) return;
      const liveByKey = new Map(payload.plans.map((plan) => [plan.key, plan]));
      const livePlans = DEFAULT_PRICING.map((fallback) => {
        const live = liveByKey.get(fallback.key);
        if (!live) return fallback;
        const prices = { ...fallback.prices };
        if (live.prices && typeof live.prices === 'object') {
          for (const code of ['USD', 'NGN']) {
            if (Object.prototype.hasOwnProperty.call(live.prices, code)) prices[code] = live.prices[code];
          }
        } else if (live.currency && ['USD', 'NGN'].includes(live.currency)) {
          prices[live.currency] = live.amount ?? (live.amountMinor == null ? null : live.amountMinor / 100);
        }
        return { ...fallback, ...live, prices, amount: live.amount ?? (live.amountMinor == null ? null : live.amountMinor / 100) };
      });
      setPlans(livePlans);
    }).catch(() => {});
    return () => { active = false; };
  }, []);

  return <main className="landing-shell">
    <div className="auth-brand"><div className="brand-mark"><img src="/icons/signal-desk-icon-192.png" alt="" /></div><span>Signal Desk</span></div>
    <section className="landing-hero">
      <div className="landing-hero-copy">
        <p className="eyebrow">TELEGRAM SIGNALS, CARRIED TO YOUR BROKER</p>
        <h1>The signal arrived in your channel. The order is already at the broker.</h1>
        <p className="landing-lede">Signal Desk watches the Telegram channels you point it at, reads the signal in each message, and places the order on your own trading account inside your own limits - while you are away from the screen, in a meeting, or on the other side of a chart you were not watching.</p>
        <div className="landing-cta"><button type="button" className="button button-primary" onClick={() => onEnterAuth('register')}>Get Started Free</button><button type="button" className="button button-secondary" onClick={() => onEnterAuth('login')}>Log in</button></div>
        <div className="landing-trust-bar" aria-label="Platform highlights"><span>Executions in &lt;1s</span><i>•</i><span>MT4 &amp; MT5 Supported</span><i>•</i><span>Cloud-based — No VPS</span></div>
        <p className="landing-fine">Set up takes a workspace, a Telegram session and a trading account.</p>
      </div>
      <MockDashboard />
    </section>
    <section className="landing-how" aria-labelledby="landing-how-title">
      <div className="landing-section-heading"><p className="eyebrow">A CLEAR PATH FROM SIGNAL TO EXECUTION</p><h2 id="landing-how-title">How it works</h2></div>
      <div className="landing-steps">{STEPS.map(([title, body], index) => <article className="landing-step" key={title}><span className="landing-step-no">0{index + 1}</span><h3>{title}</h3><p>{body}</p></article>)}</div>
    </section>
    <section className="landing-guardrails">
      <h2>What it will not do</h2>
      <div className="landing-guard-grid">
        <p><strong>It will not start on its own.</strong> A new workspace is created with execution switched off, and the switch stays off until you raise it yourself and confirm that you understand it sends live orders.</p>
        <p><strong>It will not guess a price.</strong> A message with a direction but no level is saved for review. A fallback distance may protect an order that has a price; it never creates one.</p>
        <p><strong>It will not outrun your limits.</strong> Risk per trade, how many positions may be open, the daily loss limit and the block on orders without a stop are yours, and they are checked on every signal.</p>
        <p><strong>It will not act while you are not watching on purpose.</strong> Free workspaces safely pause during prolonged inactivity to preserve resources.</p>
      </div>
      <div className="landing-foot-actions"><button type="button" className="button button-primary" onClick={() => onEnterAuth('register')}>Get Started Free</button>{installPrompt && <button type="button" className="button button-secondary" onClick={onInstall}>Install Signal Desk</button>}</div>
    </section>
    <section className="landing-pricing" aria-labelledby="landing-pricing-title">
      <div className="landing-guarantee-bar"><span>One-click disconnect</span><i>•</i><span>No hidden fees</span><i>•</i><span>Bank-grade MT5 encryption</span></div>
      <div className="landing-section-heading"><p className="eyebrow">SIMPLE, TRANSPARENT PLANS</p><h2 id="landing-pricing-title">Pricing that scales with you</h2><p>Start free, then choose the capacity that fits your workspace.</p></div>
      <div className="landing-currency-toggle" role="group" aria-label="Pricing currency">
        {['USD', 'NGN'].map((code) => <button key={code} type="button" className={currency === code ? 'active' : ''} aria-pressed={currency === code} onClick={() => setCurrency(code)}>{code}</button>)}
      </div>
      <div className="landing-pricing-grid">{plans.map((plan) => <article className={`landing-price-card${plan.key === 'pro' ? ' landing-price-featured' : ''}`} key={plan.key}>
        {plan.key === 'pro' && <span className="landing-popular">POPULAR</span>}
        <h3>{plan.name}</h3><p className="landing-price-description">{plan.description}</p>
        <p className="landing-price"><strong>{formatPrice(plan, currency)}</strong>{Number(priceAmount(plan, currency)) > 0 && <span> / {{ monthly: 'month', quarterly: 'quarter', annually: 'year', annual: 'year' }[plan.interval] || plan.interval || 'month'}</span>}</p>
        <button type="button" className={`button ${plan.key === 'pro' ? 'button-primary' : 'button-secondary'}`} onClick={() => onEnterAuth('register')}>{plan.key === 'free' ? 'Get Started Free' : 'Choose ' + plan.name}</button>
      </article>)}</div>
    </section>
    <section className="landing-faq" aria-labelledby="landing-faq-title"><div className="landing-section-heading"><p className="eyebrow">GOOD TO KNOW</p><h2 id="landing-faq-title">Frequently asked questions</h2></div><div className="landing-faq-list">{FAQS.map(([question, answer]) => <article className="landing-faq-item" key={question}><h3>{question}</h3><p>{answer}</p></article>)}</div></section>
    <footer className="landing-footer"><span>© {new Date().getFullYear()} Signal Desk</span><span>Tools for disciplined execution.</span></footer>
  </main>;
}
