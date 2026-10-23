import React from 'react';
import RiskWarningModal, { needsRiskAcknowledgement, RISK_REMINDER, RISK_WARNING_COPY } from './RiskWarningModal.jsx';
import SettingsSection from './SettingsSection.jsx';

/**
 * Kept as the full sentence the warning used to be, for surfaces that need to quote it in one line.
 * The panel itself no longer prints it: the same words are asked as a decision in
 * RiskWarningModal, and reduced to RISK_REMINDER underneath the switch once they have been agreed to.
 */
export const EXECUTION_WARNING = RISK_WARNING_COPY.body;

/* The acknowledgement belongs to this panel, so its parts are re-exported here: one module owns the
 * switch, the sentence that guards it, and the decision that dismisses it. */
export { default as RiskWarningModal, needsRiskAcknowledgement, RISK_REMINDER, RISK_WARNING_COPY } from './RiskWarningModal.jsx';

/**
 * The three answers a workspace can give to a signal that numbered its targets. The values are the
 * server's (`server/services/scale-out.js` `TARGET_MODES`), and a test pins the two lists together,
 * because a mode the panel could offer but the engine could not read would be a setting that silently
 * does nothing.
 */
export const MULTIPLE_TARGET_MODES = [
  { value: 'first_target', label: 'First Target Only', summary: 'Exit at the first target and leave the rest of the plan unread.' },
  { value: 'final_target', label: 'Final Target Only', summary: 'Hold the trade to the last price the channel named.' },
  { value: 'scale_out', label: 'Split & Scale-Out', summary: 'Open the full size at the final target, then close pieces as each earlier target is reached.' },
];
export const DEFAULT_TARGET_MODE = 'first_target';
/** What the sweep does with the ladder, stated here because it is the promise the setting makes. */
export const SCALE_OUT_PLAN = 'Half closes at the first target and its stop moves to break even in the same breath; 30% at the next; the rest rides to the final target.';

const targetModeOf = (settings) => (MULTIPLE_TARGET_MODES.some((mode) => mode.value === settings?.multipleTargetHandling) ? settings.multipleTargetHandling : DEFAULT_TARGET_MODE);

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
 * What has happened to each rung of a scale-out plan, in the order the channel wrote them.
 *
 * `trade_tp_levels` is the only place that answer lives, and a user reading a trade should not have to
 * open a database to find out whether a target was banked, refused, or is still waiting. `unconfirmed`
 * is spelled out rather than softened: that row means the broker may already have closed the volume and
 * nothing will send it again without a human looking first.
 */
export function scaleOutSummary(trade) {
  const levels = Array.isArray(trade?.tpLevels) ? trade.tpLevels : [];
  if (!levels.length) return '';
  const outcome = (status) => ({
    filled: 'closed',
    pending: 'waiting',
    submitting: 'being closed',
    deferred: 'waiting for room',
    failed: 'refused',
    skipped: 'not tradable',
    closed: 'position gone',
    unknown: 'unconfirmed',
  }[String(status || 'pending')] || String(status));
  const parts = levels.map((level) => `${level.price} ${outcome(level.status)}${Number(level.percent) ? ` (${level.percent}%)` : ''}`);
  return `Scale-out: ${parts.join(' · ')}`;
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

export default function AdvancedSettings({ settings, accounts = [], trades = [], runtimeAvailable = false, platformPause = null, onChange, onSubmit, onToggle, onOpenRiskSettings = () => {}, saving = false }) {
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
  const protecting = settings.breakEvenEnabled === true || settings.trailingStopEnabled === true;
  const targetMode = targetModeOf(settings);
  const targetModeLabel = MULTIPLE_TARGET_MODES.find((mode) => mode.value === targetMode)?.label || 'First Target Only';
  const set = (key, value) => onChange({ ...settings, [key]: value });

  return (
    <section className="panel settings-panel execution-settings-panel">
      <div className="panel-heading">
        <div><p className="eyebrow">EXECUTION &amp; AUTOMATION</p><h2>Advanced Settings</h2></div>
        <span className={`status-pill ${settings.autoTradingEnabled ? 'online' : ''}`}>
          {settings.autoTradingEnabled ? 'Auto-Trading ON' : 'Auto-Trading OFF'}
        </span>
      </div>

      {pauseNotice ? <div className="alert alert-info execution-paused-notice" role="alert">{pauseNotice}</div> : null}
      {!runtimeAvailable && <div className="alert alert-info" role="status">Automatic execution is unavailable here, so no signal will place an order until it returns.</div>}
      {runtimeAvailable && <p className="field-help execution-runtime-note">The worker runs while Signal Desk is online; signals missed while it was offline are never executed late.</p>}

      <form className="form-stack execution-settings-form" onSubmit={onSubmit} aria-busy={saving}>
        {/* Three bars, read top to bottom in the order a decision is made: may a signal become an order
            and on what account, what happens to the trade afterwards, and which signals are refused
            before any of it. Each bar carries its own one-line state so the page can be read folded. */}
        <SettingsSection
          id="core-execution"
          title="Core Execution"
          subtitle="Whether a signal may become an order, on which account, and at what size."
          state={settings.autoTradingEnabled ? 'Auto-Trading ON' : 'Auto-Trading OFF'}
          tone={settings.autoTradingEnabled ? 'good' : 'neutral'}
          defaultOpen
        >
          <div className="execution-section-heading">
            <h4>Auto-Trading</h4>
            <p>Trade size lives on the Risk Settings page.</p>
          </div>
          <label className="execution-toggle-row" htmlFor="auto-trading-enabled">
            <input id="auto-trading-enabled" type="checkbox" checked={Boolean(settings.autoTradingEnabled)} disabled={saving || (!settings.autoTradingEnabled && !runtimeAvailable)} onChange={(event) => requestAutoTrading(event.target.checked)} />
            <span><strong>Auto-Trading {settings.autoTradingEnabled ? 'ON' : 'OFF'}</strong><small>This toggle saves immediately. Turn it off whenever no new orders should be submitted.</small></span>
          </label>
          <p className="risk-reminder">
            <span>{RISK_REMINDER}</span>
            <details className="risk-reminder-details">
              <summary>What else applies to this switch</summary>
              <ul>
                {protecting
                  ? <li>Break-even and trailing-stop moves send further modify requests for trades Signal Desk opened, so protection follows the trade without you.</li>
                  : <li>Break-even and trailing-stop moves are off, so nothing protects an open trade automatically.</li>}
                <li>An order that has already reached the broker cannot be recalled here; close it in your trading terminal.</li>
                <li>Signals without a clear symbol, direction, or stop loss are saved for review and never traded, whatever this switch says.</li>
                {settings.hasAcceptedRiskWarning === true ? <li>You confirmed the live-trading warning for this workspace, so it is not asked for again.</li> : <li>You have not confirmed the live-trading warning yet; you will be asked the first time you switch this on.</li>}
              </ul>
            </details>
          </p>

          <label htmlFor="execution-account">Connected trading account
            <select id="execution-account" value={settings.executionAccountId || ''} onChange={(event) => set('executionAccountId', event.target.value || null)}>
              <option value="">Select a connected account</option>
              {connectedAccounts.map((account) => <option key={account.metaApiAccountId} value={account.metaApiAccountId}>
                {account.name || account.login || 'Trading account'} · {String(account.platform || '').toUpperCase()} · {account.server || 'Broker'}
              </option>)}
            </select>
          </label>
          {!connectedAccounts.length && <p className="field-help">Connect and select a deployed MT4/MT5 account before any orders can be placed. Signals are not executed until an owned account is selected.</p>}

          <div className="execution-section-heading">
            <h4>Lot Size</h4>
            <p>How big each order is, within the broker&rsquo;s own rules for the symbol.</p>
          </div>
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
        </SettingsSection>

        <SettingsSection
          id="trade-management"
          title="Trade Management"
          subtitle="How an open trade is looked after, and what a signal with several targets means."
          state={`${protecting ? 'Stop moves on' : 'No stop moves'} · ${targetModeLabel}`}
          tone={protecting ? 'good' : 'neutral'}
        >
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
              <small>Only trades Signal Desk opened are touched, and a stop only ever moves to reduce risk &mdash; never widened. A move needs a fresh quote and the broker&rsquo;s own stop and freeze distances, so it is retried while the price is too close; turning Auto-Trading off also stops these moves, and changing either distance re-arms positions already handled.</small>
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
              <small>The stop only ever moves in the direction that reduces risk, and a stop you tightened yourself is never widened or replaced. Each check uses a fresh synchronized quote and the broker&rsquo;s own distances, so a move that cannot be accepted yet is retried rather than forced. It runs with or without break even, and the more protective stop wins. Turning Auto-Trading off stops these moves too.</small>
            </span>
          </label>
          <p className="field-help">Trailing stops are checked on the same sweep as break-even moves, for trades Signal Desk opened, and distances are MetaTrader points aligned onto the symbol&rsquo;s tick size. A move the broker could not confirm is left alone until you reconcile it, rather than being sent again.</p>
          {!runtimeAvailable && <p className="field-help">Trailing stop moves are unavailable while automatic execution is unavailable on this service.</p>}

          <div className="execution-section-heading">
            <h4>Multiple Target Handling</h4>
            <p>A channel that numbers its targets is publishing a plan for one trade. This decides what the copy does with it.</p>
          </div>
          <label htmlFor="multiple-target-handling">Multiple Target Handling
            <select id="multiple-target-handling" value={targetMode} onChange={(event) => set('multipleTargetHandling', event.target.value)}>
              {MULTIPLE_TARGET_MODES.map((mode) => <option key={mode.value} value={mode.value}>{mode.label}</option>)}
            </select>
            <small>{MULTIPLE_TARGET_MODES.find((mode) => mode.value === targetMode)?.summary}</small>
          </label>
          {targetMode === 'scale_out' && (
            <div className="execution-scale-out-plan">
              <p>{SCALE_OUT_PLAN}</p>
              <p>A trade too small for the broker&rsquo;s minimum lot to survive a cut keeps its first target instead, and only signals this workspace opened are ever swept &mdash; your own trades in the terminal are left alone.</p>
              {!runtimeAvailable && <p className="field-help">Scale-out closes are unavailable while automatic execution is unavailable on this service.</p>}
            </div>
          )}
          <p className="field-help">This changes what happens to the next signal that is executed; a trade already open keeps the exit it was sent with.</p>
        </SettingsSection>

        <SettingsSection
          id="advanced-safety"
          title="Advanced Safety Nets"
          subtitle="Which signals may be sent at all, and what fills a leg the channel forgot."
          state={safetyBlocking ? 'Blocking' : 'Allowed'}
          tone={safetyBlocking ? 'bad' : 'good'}
        >
          <p className="execution-advanced-intro">The default is the strictest reading, and it is the one to leave alone unless a channel posts signals without stops.</p>
          <label className="execution-toggle-row" htmlFor="block-missing-stop">
            <input id="block-missing-stop" type="checkbox" checked={blockMissingStop} disabled={saving} onChange={(event) => set('blockExecutionWithoutStopLoss', event.target.checked)} />
            <span>
              <strong>Block execution if Stop Loss is missing {blockMissingStop ? 'ON' : 'OFF'}</strong>
              <small>While on, a signal with no stop loss is saved for review and never sent to your broker. Turning it off allows one to be executed only in Fixed Lot mode: a Risk-Based size is measured to a stop that would not exist. Nothing else is relaxed &mdash; a stated direction, a fresh price, your own switch and a managed account are still required.</small>
            </span>
          </label>
          <label className="execution-toggle-row" htmlFor="block-missing-target">
            <input id="block-missing-target" type="checkbox" checked={blockMissingTarget} disabled={saving} onChange={(event) => set('blockExecutionWithoutTakeProfit', event.target.checked)} />
            <span>
              <strong>Block execution if Take Profit is missing {blockMissingTarget ? 'ON' : 'OFF'}</strong>
              <small>While on, a signal with no take-profit target is saved for review and never sent. Turning it off is the deliberate choice to hold a trade with no exit planned; with the stop-loss block off too, that trade is naked on both sides, and it is recorded as a User Override so it can be found afterwards.</small>
            </span>
          </label>
          <div className="form-row execution-fallback-fields">
            <label htmlFor="fallback-stop-loss">Fallback Stop Loss (points)
              <input id="fallback-stop-loss" type="number" min="1" max="1000000" step="1" placeholder="None" value={settings.fallbackStopLossPoints ?? ''} disabled={saving} onChange={(event) => set('fallbackStopLossPoints', event.target.value === '' ? null : event.target.value)} />
              <small>This distance is used only when a signal states no stop loss of its own &mdash; what the channel wrote always wins. Measured from the price the order is sent at, rounded onto the symbol&rsquo;s tick grid away from the market so rounding never tightens your risk. On most FX pairs 10 points is one pip. Blank means no fallback.</small>
            </label>
            <label htmlFor="fallback-take-profit">Fallback Take Profit (points)
              <input id="fallback-take-profit" type="number" min="1" max="1000000" step="1" placeholder="None" value={settings.fallbackTakeProfitPoints ?? ''} disabled={saving} onChange={(event) => set('fallbackTakeProfitPoints', event.target.value === '' ? null : event.target.value)} />
              <small>The same rescue for the other leg, placed this far beyond the order price when the channel stated none. A distance this symbol&rsquo;s broker would refuse is reported as unusable rather than ignored, and the block above then decides. Blank means no fallback.</small>
            </label>
          </div>
          <ul className="execution-advanced-facts">
            <li>These rules decide only whether a signal may be sent; several targets are handled by the choice in Trade Management, not here.</li>
            <li>A fallback is priced from a live quote when the order is sent, never from the signal&rsquo;s entry price, and a signal whose direction had to be inferred is never executed.</li>
            <li>Changes apply to signals captured afterwards; an open trade keeps its own stop.</li>
          </ul>
          <p className="field-help">Saved with the rest of these settings, when you press Save settings below.</p>
        </SettingsSection>

        <p className="field-help">Break-even moves apply to positions Signal Desk opened; your own trades keep their stops.</p>
        <p className="field-help advanced-settings-crosslink">Position size, open-trade limit and daily loss limit live on the <button type="button" className="text-button" onClick={onOpenRiskSettings}>Risk Settings</button> page.</p>
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
          <div><strong>{trade.side?.toUpperCase() || 'TRADE'} {trade.symbol || ''}</strong><small>{trade.quantity ? `${trade.quantity} lots${trade.remainingVolume != null && Number(trade.remainingVolume) !== Number(trade.quantity) ? ` · ${trade.remainingVolume} lots left` : ''}` : 'Size unavailable'} · {trade.createdAt ? new Date(trade.createdAt).toLocaleString() : 'Recent'}</small></div>
          <span className={`badge execution-status-${String(trade.status || '').toLowerCase()}`}>{trade.status || 'unknown'}</span>
          {scaleOutSummary(trade) && <p className="execution-scale-out-summary">{scaleOutSummary(trade)}</p>}
          {trade.breakEvenStatus && <span className={`badge execution-breakeven-badge execution-breakeven-${trade.breakEvenStatus}`}>{breakEvenSummary(trade)}</span>}
          {trade.errorMessage && <p className="execution-error-message">{trade.errorMessage}</p>}
          {trade.breakEvenError && <p className="execution-error-message">{trade.breakEvenError}</p>}
        </article>)}</div>}
      </div>
    </section>
  );
}
