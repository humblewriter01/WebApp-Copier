import React from 'react';

export const EXECUTION_WARNING = 'Warning: Enabling Auto-Trading will execute live trades on your connected broker account. Ensure you are using a demo account for testing. You are fully responsible for any financial losses.';

const BREAK_EVEN_LABELS = {
  moved: 'Stop moved to break even',
  already_beyond: 'Already protected',
  deferred: 'Waiting for room to move',
  failed: 'Broker refused the move',
  unknown: 'Move unconfirmed',
  closed: 'Position closed',
};

function breakEvenSummary(trade) {
  const label = BREAK_EVEN_LABELS[trade.breakEvenStatus] || trade.breakEvenStatus;
  if (trade.breakEvenStatus === 'moved' && trade.breakEvenStopLoss) return `${label} (${trade.breakEvenStopLoss})`;
  return label;
}

export default function ExecutionSettings({ settings, accounts = [], trades = [], runtimeAvailable = false, onChange, onSubmit, onToggle, saving = false }) {
  const connectedAccounts = accounts.filter((account) => String(account.state || '').toUpperCase() === 'DEPLOYED');
  const set = (key, value) => onChange({ ...settings, [key]: value });

  return (
    <section className="panel settings-panel execution-settings-panel">
      <div className="panel-heading">
        <div><p className="eyebrow">RISK &amp; EXECUTION</p><h2>Risk settings</h2></div>
        <span className={`status-pill ${settings.autoTradingEnabled ? 'online' : ''}`}>
          {settings.autoTradingEnabled ? 'Auto-Trading ON' : 'Auto-Trading OFF'}
        </span>
      </div>

      <div className="execution-warning" role="alert">{EXECUTION_WARNING}</div>
      {!runtimeAvailable && <div className="alert alert-info" role="status">Automatic execution is currently unavailable. You can still turn Auto-Trading off; eligible signals will not place orders while execution is unavailable.</div>}
      {runtimeAvailable && <p className="field-help execution-runtime-note">The worker runs while Signal Desk is online. If the service is offline, new signals may be missed; stale signals are never executed after it returns.</p>}

      <form className="form-stack execution-settings-form" onSubmit={onSubmit} aria-busy={saving}>
        <div className="execution-section-heading">
          <h3>Risk Settings</h3>
          <p>Limits are checked against the selected connected account before every order.</p>
        </div>
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

        <div className="execution-section-heading">
          <h3>Execution Settings</h3>
          <p>Only new, clearly parsed Telegram signals with a valid stop loss can be considered.</p>
        </div>
        <label htmlFor="execution-account">Connected trading account
          <select id="execution-account" value={settings.executionAccountId || ''} onChange={(event) => set('executionAccountId', event.target.value || null)}>
            <option value="">Select a connected account</option>
            {connectedAccounts.map((account) => <option key={account.metaApiAccountId} value={account.metaApiAccountId}>
              {account.name || account.login || 'Trading account'} · {String(account.platform || '').toUpperCase()} · {account.server || 'Broker'}
            </option>)}
          </select>
        </label>
        {!connectedAccounts.length && <p className="field-help">Connect and select a deployed MT4/MT5 account before any orders can be placed. Signals are not executed until an owned account is selected.</p>}

        <label htmlFor="lot-size-mode">Lot Size Mode
          <select id="lot-size-mode" value={settings.lotSizeMode} onChange={(event) => set('lotSizeMode', event.target.value)}>
            <option value="fixed">Fixed Lot</option>
            <option value="risk_based">Risk-Based (Calculated from Stop Loss)</option>
          </select>
        </label>
        {settings.lotSizeMode === 'fixed' && <label htmlFor="fixed-lot-size">Fixed Lot Size
          <input id="fixed-lot-size" type="number" min="0.01" max="100" step="0.01" value={settings.fixedLotSize} onChange={(event) => set('fixedLotSize', event.target.value)} required />
          <small>The broker's minimum, maximum, and volume step are checked before an order is sent.</small>
        </label>}
        {settings.lotSizeMode === 'risk_based' && <p className="field-help">Risk-Based sizing uses your account balance, risk percent, stop-loss distance, and the broker's current symbol tick values. If the safe size is below the broker minimum, the signal is skipped rather than rounded up.</p>}

        <div className="execution-section-heading">
          <h3>Break Even</h3>
          <p>Once the market moves far enough in favour of a trade Signal Desk opened, its stop loss is moved to the entry price so a reversal cannot turn the trade into a loss.</p>
        </div>
        <div className="form-row">
          <label htmlFor="break-even-trigger">Trigger distance (points)
            <input id="break-even-trigger" type="number" min="1" max="100000" step="1" value={settings.breakEvenTriggerPoints ?? 20} onChange={(event) => set('breakEvenTriggerPoints', event.target.value)} required />
            <small>The trade must first move this far in profit. On most FX pairs 10 points is one pip.</small>
          </label>
          <label htmlFor="break-even-offset">Offset beyond entry (points)
            <input id="break-even-offset" type="number" min="0" max="10000" step="1" value={settings.breakEvenOffsetPoints ?? 0} onChange={(event) => set('breakEvenOffsetPoints', event.target.value)} required />
            <small>Add the spread, and any commission, so the stop is not sitting exactly where the quote touches it.</small>
          </label>
        </div>
        <label className="execution-toggle-row" htmlFor="break-even-enabled">
          <input id="break-even-enabled" type="checkbox" checked={Boolean(settings.breakEvenEnabled)} disabled={saving || !runtimeAvailable} onChange={(event) => set('breakEvenEnabled', event.target.checked)} />
          <span>
            <strong>Move stops to break even {settings.breakEvenEnabled ? 'ON' : 'OFF'}</strong>
            <small>Only trades Signal Desk opened are touched, and a stop is only ever moved in the direction that reduces risk &mdash; never widened. The move needs a fresh synchronized quote and must satisfy the broker&rsquo;s own stop and freeze distances, so it is retried while the price is too close to the market. Turning Auto-Trading off also stops these moves: while it is off Signal Desk sends nothing to your broker. Changing either distance re-arms positions that were already handled.</small>
          </span>
        </label>
        {!runtimeAvailable && <p className="field-help">Break-even moves are unavailable while automatic execution is unavailable on this service.</p>}

        <label className="execution-toggle-row" htmlFor="auto-trading-enabled">
          <input id="auto-trading-enabled" type="checkbox" checked={Boolean(settings.autoTradingEnabled)} disabled={saving || (!settings.autoTradingEnabled && !runtimeAvailable)} onChange={(event) => onToggle ? onToggle(event.target.checked) : set('autoTradingEnabled', event.target.checked)} />
          <span><strong>Auto-Trading {settings.autoTradingEnabled ? 'ON' : 'OFF'}</strong><small>ON by default for new workspaces. This toggle saves immediately; switch it off to stop new orders from being submitted. An order already sent to the broker cannot be recalled here.</small></span>
        </label>
        <p className="field-help">Break-even moves apply to positions Signal Desk opened; trades you placed yourself in the terminal keep their own stops. The open-trade limit counts open positions and pending orders. The daily trade limit counts new broker positions opened during the current UTC day. Signals without a clear direction, symbol, or stop loss are saved for review but are not traded.</p>
        <button className="button button-primary" type="submit" disabled={saving}>{saving ? 'Saving settings…' : 'Save settings'}</button>
      </form>
      <div className="execution-history" aria-labelledby="execution-history-title">
        <div className="execution-section-heading"><h3 id="execution-history-title">Recent execution activity</h3><p>Order outcomes and safe rejection reasons for this workspace.</p></div>
        {!trades.length ? <p className="field-help">No execution activity yet. Signals are only considered while Auto-Trading is on.</p> : <div className="execution-trade-list">{trades.slice(0, 8).map((trade) => <article className="execution-trade-row" key={trade.id}>
          <div><strong>{trade.side?.toUpperCase() || 'TRADE'} {trade.symbol || ''}</strong><small>{trade.quantity ? `${trade.quantity} lots` : 'Size unavailable'} · {trade.createdAt ? new Date(trade.createdAt).toLocaleString() : 'Recent'}</small></div>
          <span className={`badge execution-status-${String(trade.status || '').toLowerCase()}`}>{trade.status || 'unknown'}</span>
          {trade.breakEvenStatus && <span className={`badge execution-breakeven-badge execution-breakeven-${trade.breakEvenStatus}`}>{breakEvenSummary(trade)}</span>}
          {trade.errorMessage && <p className="execution-error-message">{trade.errorMessage}</p>}
          {trade.breakEvenError && <p className="execution-error-message">{trade.breakEvenError}</p>}
        </article>)}</div>}
      </div>
    </section>
  );
}
