/**
 * The page someone sees before they have an account.
 *
 * Until now an unauthenticated visitor was rendered a sign-in card: "Welcome back", asked of someone who had never
 * been here, with no way to see what the product does, what a workspace looks like, or why it is worth connecting a
 * broker account to. That is a door with no window in it. This is the window: what Signal Desk does, in plain
 * sentences, and a picture of a workspace doing it - the same switch, signal card, position list and risk summary
 * the trader will meet later, with sample numbers, so the shape of the thing is visible before anything is asked.
 *
 * Three rules this component keeps, because it is the only part of the app a stranger reads:
 *   - it asks for nothing. No token, no request, no storage read; it renders from the constants below, and a
 *     visitor whose browser blocks every cookie still sees the whole page;
 *   - it shows no live data and never hints at any. The demo panel is labelled, its numbers are recognifiably
 *     invented, and there is no row that could be mistaken for somebody's real trade;
 *   - it promises nothing about money. Returns are not discussed, no channel is named, and the one risk sentence it
 *     does carry is the true one: execution is off until the owner turns it on, and turning it on asks them to say
 *     they understand it places live orders.
 */
import React from 'react';

/** What the demo panel shows. Deliberately ordinary: one filled signal, one awaiting a price, one position. */
const SAMPLE_SIGNALS = [
  { id: 'xau', symbol: 'XAUUSD', side: 'SELL', entry: '2 612.50', stop: '2 622.00', target: '2 592.00', state: 'Executed', detail: '0.10 lots · 2 s after the post' },
  { id: 'eur', symbol: 'EURUSD', side: 'BUY', entry: '1.0842', stop: '1.0812', target: '1.0902', state: 'Held for review', detail: 'no price in the message, so nothing was sent' },
];
const SAMPLE_POSITION = { symbol: 'XAUUSD', side: 'SELL', volume: '0.10', open: '2 612.50', stop: '2 622.00', target: '2 592.00', result: '−48.20 USD' };
const SAMPLE_RISK = [
  ['Risk per trade', '1 %'],
  ['Open positions at once', '3'],
  ['Daily loss limit', '5 %'],
  ['Stop loss required', 'Yes'],
  ['Take profit required', 'Yes'],
];
const STEPS = [
  ['Point it at your channels', 'Signal Desk reads the messages you choose, from the moment you connect them. Nothing is bought, sold or moved before you say so.'],
  ['It reads the signal, not the vibe', 'Direction, entry, stop and targets are taken from the post. A message that states a direction without a price is saved for you to read, not guessed at.'],
  ['The order goes to your broker', 'Your own trading account, your own lot size and limits. Every execution is written down with the signal that caused it, so a week later you can still see which message did what.'],
];

function MockDashboard() {
  return <div className="landing-demo" aria-hidden="false">
    <div className="landing-demo-bar">
      <span className="landing-demo-title">Signal Desk · workspace</span>
      <span className="landing-demo-tag">Sample data, not a live account</span>
    </div>
    <div className="landing-demo-row landing-demo-switch">
      <span className="landing-demo-label">Auto-Trading</span>
      <span className="landing-switch" data-on="false"><span className="landing-switch-knob" /></span>
      <span className="landing-demo-note">Off until you turn it on. Turning it on asks you to confirm what that means.</span>
    </div>
    <div className="landing-demo-signals">
      {SAMPLE_SIGNALS.map((signal) => <div className="landing-signal" key={signal.id}>
        <span className={`landing-side landing-side-${signal.side.toLowerCase()}`}>{signal.side}</span>
        <span className="landing-symbol">{signal.symbol}<small>{signal.entry} · SL {signal.stop} · TP {signal.target}</small></span>
        <span className="landing-state">{signal.state}<small>{signal.detail}</small></span>
      </div>)}
    </div>
    <div className="landing-demo-grid">
      <div className="landing-panel">
        <h4>Open position</h4>
        <dl className="landing-pairs">
          <div><dt>Instrument</dt><dd>{SAMPLE_POSITION.symbol} · {SAMPLE_POSITION.side}</dd></div>
          <div><dt>Volume</dt><dd>{SAMPLE_POSITION.volume}</dd></div>
          <div><dt>Entry</dt><dd>{SAMPLE_POSITION.open}</dd></div>
          <div><dt>Stop / target</dt><dd>{SAMPLE_POSITION.stop} · {SAMPLE_POSITION.target}</dd></div>
          <div><dt>Result so far</dt><dd>{SAMPLE_POSITION.result}</dd></div>
        </dl>
      </div>
      <div className="landing-panel">
        <h4>Your limits</h4>
        <dl className="landing-pairs">
          {SAMPLE_RISK.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
        </dl>
      </div>
    </div>
    <p className="landing-demo-foot">Nothing in this picture is connected to anything. No broker, no money, no channel.</p>
  </div>;
}

export default function Landing({ onEnterAuth = () => {}, installPrompt = null, onInstall = () => {} }) {
  return <main className="landing-shell">
    <div className="auth-brand"><div className="brand-mark"><img src="/icons/signal-desk-icon-192.png" alt="" /></div><span>Signal Desk</span></div>
    <section className="landing-hero">
      <div className="landing-hero-copy">
        <p className="eyebrow">TELEGRAM SIGNALS, CARRIED TO YOUR BROKER</p>
        <h1>The signal arrived in your channel. The order is already at the broker.</h1>
        <p className="landing-lede">Signal Desk watches the Telegram channels you point it at, reads the signal in each message, and places the order on your own trading account inside your own limits - while you are away from the screen, in a meeting, or on the other side of a chart you were not watching.</p>
        <div className="landing-cta">
          <button type="button" className="button button-primary" onClick={() => onEnterAuth('register')}>Create your workspace</button>
          <button type="button" className="button button-secondary" onClick={() => onEnterAuth('login')}>Log in</button>
        </div>
        <p className="landing-fine">Set up takes a workspace, a Telegram session and a trading account. <button type="button" className="landing-link" onClick={() => onEnterAuth('forgot')}>Forgotten a password?</button></p>
      </div>
      <MockDashboard />
    </section>
    <section className="landing-steps">
      {STEPS.map(([title, body], index) => <article className="landing-step" key={title}>
        <span className="landing-step-no">{String(index + 1).padStart(2, '0')}</span>
        <h3>{title}</h3>
        <p>{body}</p>
      </article>)}
    </section>
    <section className="landing-guardrails">
      <h2>What it will not do</h2>
      <div className="landing-guard-grid">
        <p><strong>It will not start on its own.</strong> A new workspace is created with execution switched off, and the switch stays off until you raise it yourself and confirm that you understand it sends live orders.</p>
        <p><strong>It will not guess a price.</strong> A message with a direction but no level is saved for review. A fallback distance may protect an order that has a price; it never creates one.</p>
        <p><strong>It will not outrun your limits.</strong> Risk per trade, how many positions may be open, the daily loss limit and the block on orders without a stop are yours, and they are checked on every signal.</p>
        <p><strong>It will not act while you are not watching on purpose.</strong> A workspace on the free plan pauses when it has been idle, and the pause is written down, so an open connection is never mistaken for attention.</p>
      </div>
      <div className="landing-foot-actions">
        <button type="button" className="button button-primary" onClick={() => onEnterAuth('register')}>Create your workspace</button>
        {installPrompt && <button type="button" className="button button-secondary" onClick={onInstall}>Install Signal Desk</button>}
      </div>
    </section>
  </main>;
}
