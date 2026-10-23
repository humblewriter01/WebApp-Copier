import React from 'react';

/**
 * How much a trade may cost, and when the workspace has to stop.
 *
 * Four numbers, nothing else. The rules about whether a captured signal may become an order at all,
 * which account it goes to, and how its stop is looked after afterwards live on Advanced Settings, and
 * deleting the account lives on Profile. They used to sit between these fields, in one panel, which is
 * how a reader ended up choosing a risk percent next to a Danger Zone.
 *
 * Saving this page writes the whole settings row (`PUT /api/settings`), including the execution values
 * exactly as they were loaded. One endpoint, one row, two pages - so a save here can never blank what is
 * set there, and the fields below are the only ones this page may change.
 */
export default function RiskSettings({ settings, onChange, onSubmit, onOpenAdvanced = () => {}, saving = false }) {
  const set = (key, value) => onChange({ ...settings, [key]: value });

  return (
    <section className="panel settings-panel risk-settings-panel">
      <div className="panel-heading">
        <div><p className="eyebrow">RISK</p><h2>Risk Settings</h2></div>
        <span className={`badge risk-settings-reminder ${settings.autoTradingEnabled ? 'on' : 'off'}`}>{settings.autoTradingEnabled ? 'Auto-Trading ON' : 'Auto-Trading OFF'}</span>
      </div>
      <p className="risk-settings-intro">How much a trade may cost you. Limits are checked against the selected connected account before every order.</p>

      <form className="form-stack risk-settings-form" onSubmit={onSubmit} aria-busy={saving}>
        <label htmlFor="risk-percent">Risk percent per position
          <input id="risk-percent" type="number" min="0.1" max="5" step="0.1" value={settings.riskPercent} onChange={(event) => set('riskPercent', event.target.value)} required />
        </label>
        <div className="form-row">
          <label htmlFor="max-open-trades">Maximum Open Trades
            <input id="max-open-trades" type="number" min="1" max="50" step="1" value={settings.maxOpenPositions} onChange={(event) => set('maxOpenPositions', event.target.value)} required />
          </label>
          <label htmlFor="max-daily-trades">Maximum Daily Trades
            <input id="max-daily-trades" type="number" min="1" max="100" step="1" value={settings.maxDailyTrades} onChange={(event) => set('maxDailyTrades', event.target.value)} required />
          </label>
        </div>
        <label htmlFor="daily-loss-limit">Daily loss limit (%)
          <input id="daily-loss-limit" type="number" min="1" max="25" step="0.5" value={settings.dailyLossLimit} onChange={(event) => set('dailyLossLimit', event.target.value)} required />
        </label>
        <p className="field-help">The open-trade limit counts open positions and pending orders. The daily trade limit counts new broker positions opened during the current UTC day. A position already open keeps its own stop whatever is saved here.</p>
        <button className="button button-primary" type="submit" disabled={saving}>{saving ? 'Saving risk settings…' : 'Save risk settings'}</button>
      </form>
      <p className="field-help risk-settings-crosslink">Whether an order is sent at all, which account it goes to, and how its stop is protected afterwards are power-user settings, on the <button type="button" className="text-button" onClick={onOpenAdvanced}>Advanced Settings</button> page. The Auto-Trading switch is there too &mdash; this page only changes what a trade risks once it is allowed to happen.</p>
    </section>
  );
}
