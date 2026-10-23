import React from 'react';
import RiskWarningModal, { needsRiskAcknowledgement, RISK_REMINDER, RISK_WARNING_COPY } from './RiskWarningModal.jsx';

/**
 * Kept as the full sentence the warning used to be, for surfaces that need to quote it in one line.
 * The panel itself no longer prints it: the same words are asked as a decision in
 * RiskWarningModal, and reduced to RISK_REMINDER underneath the switch once they have been agreed to.
 */
export const EXECUTION_WARNING = RISK_WARNING_COPY.body;

/* The acknowledgement belongs to this panel, so its parts are re-exported here: one module owns the
 * switch, the sentence that guards it, and the decision that dismisses it. */
export { default as RiskWarningModal, needsRiskAcknowledgement, RISK_REMINDER, RISK_WARNING_COPY } from './RiskWarningModal.jsx';

const BREAK_EVEN_LABELS = {
  moved: 'Stop moved to break even',
  already_beyond: 'Already protected',
  deferred: 'Waiting for room to move',
  failed: 'Broker refused the move',
  unknown: 'Move unconfirmed',
  closed: 'Position closed',
};

/**
 * One line per trade, worded for the protection that actually produced it. A move that came
 * from a trail is not "break even" and saying so would mislead the user about where their stop
 * is heading, so the count of moves decides the wording rather than a setting guess.
 */
export function breakEvenSummary(trade) {
  const label = BREAK_EVEN_LABELS[trade.breakEvenStatus] || trade.breakEvenStatus;
  if (trade.breakEvenStatus !== 'moved' || !trade.breakEvenStopLoss) return label;
  const distance = Number(trade.breakEvenTrailingDistancePoints);
  if (!(distance > 0)) return `${label} (${trade.breakEvenStopLoss})`;
  const moves = Number(trade.breakEvenMoveCount) || 1;
  return moves > 1
    ? `Stop trailed (${trade.breakEvenStopLoss}) · ${moves} moves, ${distance} points behind`
    : `Stop trailed (${trade.breakEvenStopLoss})`;
}

/**
 * What a workspace is told when their own toggle is on but nothing is executing. The state comes
 * from the server, and an unreadable switch says so out loud rather than implying the user's
 * settings are to blame or that everything is fine.
 */
export function platformPauseNotice(platformPause) {
  if (!platformPause || platformPause.paused !== true) return '';
  const reason = platformPause.reason ? ` Reason given: ${platformPause.reason}` : '';
  return platformPause.state === 'unavailable'
    ? `Signal Desk could not confirm its platform execution switch, so new orders are on hold until it can.${reason}`
    : `Automatic execution is paused by Signal Desk for every workspace. Your own settings are untouched, and new signals are saved for review until the pause is lifted.${reason}`;
}

export default function ExecutionSettings({ settings, accounts = [], trades = [], runtimeAvailable = false, platformPause = null, onChange, onSubmit, onToggle, saving = false }) {
  const [riskWarningOpen, setRiskWarningOpen] = React.useState(false);
  const pauseNotice = platformPauseNotice(platformPause);
  // Turning the switch on is the only action here that spends money, so it is the only one that
  // asks first. Cancelling is not an error: the switch simply stays where it was.
  const requestAutoTrading = (enabled) => {
    if (enabled && needsRiskAcknowledgement(settings)) {
      setRiskWarningOpen(true);
      return;
    }
    if (onToggle) onToggle(enabled);
    else set('autoTradingEnabled', enabled);
  };
  const confirmRiskWarning = () => {
    setRiskWarningOpen(false);
    if (onToggle) onToggle(true, { hasAcceptedRiskWarning: true });
    else set('autoTradingEnabled', true);
  };
  const connectedAccounts = accounts.filter((account) => String(account.state || '').toUpperCase() === 'DEPLOYED');
  // Absent means on: the guard is the safe reading, and a settings object that has not been saved since
  // this switch existed must not silently become the permissive one.
  const blockMissingStop = settings.blockExecutionWithoutStopLoss !== false;
  const blockMissingTarget = settings.blockExecutionWithoutTakeProfit !== false;
  /* Either rule being on is worth saying on the folded header: a reader who switched the stop block off
     must not conclude from "Allowed" that nothing here refuses an order any more. */
  const safetyBlocking = blockMissingStop || blockMissingTarget;
  const set = (key, value) => onChange({ ...settings, [key]: value });

  return (
    <section className="panel settings-panel execution-settings-panel">
      <div className="panel-heading">
        <div><p className="eyebrow">RISK &amp; EXECUTION</p><h2>Risk settings</h2></div>
        <span className={`status-pill ${settings.autoTradingEnabled ? 'online' : ''}`}>
          {settings.autoTradingEnabled ? 'Auto-Trading ON' : 'Auto-Trading OFF'}
        </span>
      </div>

      {pauseNotice ? <div className="alert alert-info execution-paused-notice" role="alert">{pauseNotice}</div> : null}
      {!runtimeAvailable && <div className="alert alert-info" role="status">Automatic execution is currently unavailable. You can still turn Auto-Trading off; eligible signals will not place orders while execution is unavailable.</div>}
      {runtimeAvailable && <p className="field-help execution-runtime-note">The worker runs while Signal Desk is online. If the service is offline, new signals may be missed; stale signals are never executed after it returns.</p>}

      <form className="form-stack execution-settings-form" onSubmit={onSubmit} aria-busy={saving}>
        {/* Three groups, because the panel used to mix what to risk with where to send it with what to
            refuse outright. Only the last of those can change what reaches a broker without a stop. */}
        <section className="execution-group">
        <div className="execution-section-heading">
          <h3>Core Risk</h3>
          <p>How much a trade may cost you. Limits are checked against the selected connected account before every order.</p>
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
        </section>

        <section className="execution-group">
        <div className="execution-section-heading">
          <h3>Trade Management</h3>
          <p>Where an order goes, how big it is, and how its stop is looked after afterwards.</p>
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
          <h4>Break Even</h4>
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

        <div className="execution-section-heading">
          <h4>Trailing Stop</h4>
          <p>Break even moves a stop once. A trailing stop keeps moving it: the stop stays a fixed distance from the market as the trade runs, and never slips back when the price retraces.</p>
        </div>
        <label htmlFor="trailing-distance">Trailing distance (points)
          <input id="trailing-distance" type="number" min="1" max="100000" step="1" value={settings.trailingStopDistancePoints ?? 10} onChange={(event) => set('trailingStopDistancePoints', event.target.value)} required />
          <small>How far the stop follows the market. A small distance locks profit quickly but is more likely to be stopped out by normal noise; on most FX pairs 10 points is one pip.</small>
        </label>
        <label className="execution-toggle-row" htmlFor="trailing-enabled">
          <input id="trailing-enabled" type="checkbox" checked={Boolean(settings.trailingStopEnabled)} disabled={saving || !runtimeAvailable} onChange={(event) => set('trailingStopEnabled', event.target.checked)} />
          <span>
            <strong>Enable Trailing Stop {settings.trailingStopEnabled ? 'ON' : 'OFF'}</strong>
            <small>The stop only ever moves in the direction that reduces risk: a buy ratchets up, a sell ratchets down, and a stop you moved yourself to a tighter price is never widened or replaced. Each workspace check uses a fresh synchronized quote and the broker&rsquo;s own stop and freeze distances, so a move that cannot be accepted yet is retried instead of forced. It can run with or without break even &mdash; with both on, the more protective stop wins. Turning Auto-Trading off stops these moves too: while it is off Signal Desk sends nothing to your broker.</small>
          </span>
        </label>
        <p className="field-help">Trailing stops are checked on the same sweep as break-even moves, and only for trades Signal Desk opened. Distances are MetaTrader points, aligned onto the symbol&rsquo;s tick size, so a stop lands on a price the broker accepts rather than between ticks. A position whose move the broker could not confirm is left alone until you reconcile it, rather than being sent again.</p>
        {!runtimeAvailable && <p className="field-help">Trailing stop moves are unavailable while automatic execution is unavailable on this service.</p>}

        </section>

        <section className="execution-group execution-group-safety">
          <details className="execution-advanced">
            <summary>
              <span className="execution-advanced-title">Advanced Safety</span>
              <span className={`badge execution-advanced-state ${safetyBlocking ? 'on' : 'off'}`}>{safetyBlocking ? 'Blocking' : 'Allowed'}</span>
              <span className="execution-advanced-hint">What Signal Desk refuses to send, and what it supplies itself</span>
            </summary>
            <p className="execution-advanced-intro">These are the rules that decide whether a captured signal is ever allowed to become an order. They are folded away because most workspaces never need to change them &mdash; the default is the strictest reading.</p>
            <label className="execution-toggle-row" htmlFor="block-missing-stop">
              <input id="block-missing-stop" type="checkbox" checked={blockMissingStop} disabled={saving} onChange={(event) => set('blockExecutionWithoutStopLoss', event.target.checked)} />
              <span>
                <strong>Block execution if Stop Loss is missing {blockMissingStop ? 'ON' : 'OFF'}</strong>
                <small>While this is on, a signal with no stop loss is saved for review and never sent to your broker. Turning it off lets a signal without a stop be executed &mdash; only in Fixed Lot mode, because a Risk-Based size is calculated from the distance to a stop that would not exist. Nothing else is relaxed: a signal still needs a symbol, a direction the channel actually stated (or an inferred one, which is never traded), a fresh price, your own Auto-Trading switch, and an account Signal Desk manages.</small>
              </span>
            </label>
            <label className="execution-toggle-row" htmlFor="block-missing-target">
              <input id="block-missing-target" type="checkbox" checked={blockMissingTarget} disabled={saving} onChange={(event) => set('blockExecutionWithoutTakeProfit', event.target.checked)} />
              <span>
                <strong>Block execution if Take Profit is missing {blockMissingTarget ? 'ON' : 'OFF'}</strong>
                <small>A position with no target has nothing that closes it: it runs until you, the market, or its stop does. While this is on, a signal with no take-profit target is saved for review and never sent to your broker. Turning it off is the deliberate choice to hold an open trade with no exit planned &mdash; and with the stop-loss block off as well, that trade is naked on both sides, which Signal Desk marks as an override wherever it can be read afterwards.</small>
              </span>
            </label>
            <div className="form-row execution-fallback-fields">
              <label htmlFor="fallback-stop-loss">Fallback Stop Loss (points)
                <input id="fallback-stop-loss" type="number" min="1" max="1000000" step="1" placeholder="None" value={settings.fallbackStopLossPoints ?? ''} disabled={saving} onChange={(event) => set('fallbackStopLossPoints', event.target.value === '' ? null : event.target.value)} />
                <small>We cannot let a trade run naked because the provider forgot. This distance is used only when a signal states no stop loss of its own &mdash; what the channel wrote always wins. It is measured from the price the order is sent at and aligned onto the symbol&rsquo;s tick grid away from the market, so rounding can never tighten your risk. On most FX pairs 10 points is one pip. Blank means no fallback.</small>
              </label>
              <label htmlFor="fallback-take-profit">Fallback Take Profit (points)
                <input id="fallback-take-profit" type="number" min="1" max="1000000" step="1" placeholder="None" value={settings.fallbackTakeProfitPoints ?? ''} disabled={saving} onChange={(event) => set('fallbackTakeProfitPoints', event.target.value === '' ? null : event.target.value)} />
                <small>The same rescue for the other leg: a target placed this far beyond the order price when the channel stated none. A fallback that this symbol&rsquo;s broker would refuse is reported as unusable rather than ignored, and the block above then decides. Blank means no fallback.</small>
              </label>
            </div>
            <ul className="execution-advanced-facts">
              <li>Only new, clearly parsed Telegram signals are considered at all; while a block is on, a signal missing that leg needs a fallback distance to be sent.</li>
              <li>A signal whose direction had to be inferred from its prices is never executed, whatever this switch says.</li>
              <li>Changing this applies to signals captured after it is saved; a trade already open keeps its own stop.</li>
              <li>Missing or multiple targets are shown as they are; the block above is what decides, not the parser.</li>
              <li>A fallback prices the missing leg when the order is sent, from a live quote &mdash; never from the signal&rsquo;s entry price, which may be hours old.</li>
              <li>A trade sent without a leg because a block is off is logged as a User Override and left with a note on the signal, so it can be found afterwards.</li>
            </ul>
            <p className="field-help">Saved with the rest of these settings, when you press Save settings below.</p>
          </details>
        </section>

        <label className="execution-toggle-row" htmlFor="auto-trading-enabled">
          <input id="auto-trading-enabled" type="checkbox" checked={Boolean(settings.autoTradingEnabled)} disabled={saving || (!settings.autoTradingEnabled && !runtimeAvailable)} onChange={(event) => requestAutoTrading(event.target.checked)} />
          <span><strong>Auto-Trading {settings.autoTradingEnabled ? 'ON' : 'OFF'}</strong><small>This toggle saves immediately. Switch it off whenever you want no new orders to be submitted.</small></span>
        </label>
        <p className="risk-reminder">
          <span>{RISK_REMINDER}</span>
          <details className="risk-reminder-details">
            <summary>What else applies to this switch</summary>
            <ul>
              {settings.breakEvenEnabled || settings.trailingStopEnabled
                ? <li>Break-even and trailing-stop moves send further modify requests for trades Signal Desk opened, so protection follows the trade without you.</li>
                : <li>Break-even and trailing-stop moves are off, so nothing protects an open trade automatically.</li>}
              <li>An order that has already reached the broker cannot be recalled here; close it in your trading terminal.</li>
              <li>Signals without a clear symbol, direction, or stop loss are saved for review and never traded, whatever this switch says.</li>
              {settings.hasAcceptedRiskWarning === true ? <li>You confirmed the live-trading warning for this workspace, so it is not asked for again.</li> : <li>You have not confirmed the live-trading warning yet; you will be asked the first time you switch this on.</li>}
            </ul>
          </details>
        </p>
        <p className="field-help">Break-even moves apply to positions Signal Desk opened; trades you placed yourself in the terminal keep their own stops. The open-trade limit counts open positions and pending orders. The daily trade limit counts new broker positions opened during the current UTC day. Signals without a clear direction, symbol, or stop loss are saved for review but are not traded.</p>
        <button className="button button-primary" type="submit" disabled={saving}>{saving ? 'Saving settings…' : 'Save settings'}</button>
      </form>
      <RiskWarningModal
        open={riskWarningOpen}
        saving={saving}
        onCancel={() => setRiskWarningOpen(false)}
        onConfirm={confirmRiskWarning}
      />
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
