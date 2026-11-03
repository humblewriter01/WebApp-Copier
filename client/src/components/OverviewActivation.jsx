import React from 'react';
import { useTelegramStatus } from './TelegramStatus.jsx';
import { RISK_REMINDER } from './RiskWarningModal.jsx';

const STATUS_COPY = Object.freeze({
  off: 'Auto-Trading is disabled. Turn it on to execute signals.',
  pending: 'Connect a broker account to enable execution.',
  active: 'Auto-Trading is live.',
});

/** The status card follows the explicit switch first; connection state is only relevant when it is on. */
export function autoTradingStatusView({ linkedAccounts = [], autoTradingEnabled = false } = {}) {
  const accounts = Array.isArray(linkedAccounts)
    ? linkedAccounts.filter((account) => account && typeof account === 'object')
    : [];

  if (autoTradingEnabled !== true) {
    return { state: 'off', tone: 'muted', status: 'Off', message: STATUS_COPY.off };
  }
  if (accounts.length === 0) {
    return { state: 'pending', tone: 'pending', status: 'Pending', message: STATUS_COPY.pending };
  }
  return { state: 'active', tone: 'good', status: 'Active', message: STATUS_COPY.active };
}

/** The header and execution card share the same switch/account state; the header adds monitoring context. */
export function overviewActivationView({
  linkedAccounts = [],
  autoTradingEnabled = false,
  executionAccountId = '',
  channelCount = 0,
} = {}) {
  const accounts = Array.isArray(linkedAccounts) ? linkedAccounts.filter((account) => account && typeof account === 'object') : [];
  const selectedAccount = accounts.find((account) => String(account.metaApiAccountId || '') === String(executionAccountId || '')) || null;
  const channelTotal = Math.max(0, Number.isFinite(Number(channelCount)) ? Math.floor(Number(channelCount)) : 0);
  const status = autoTradingStatusView({ linkedAccounts: accounts, autoTradingEnabled });

  if (!accounts.length) {
    return {
      ...status,
      headline: 'Your bot is listening.',
      subtext: 'You have signals waiting. Connect an MT5 account to start executing.',
    };
  }

  if (autoTradingEnabled !== true) {
    return {
      ...status,
      headline: 'Ready to execute.',
      subtext: 'Your broker is connected. Turn on Auto-Trading in Advanced Settings to allow the bot to place trades.',
    };
  }

  const executionAccountCount = selectedAccount ? 1 : accounts.length;
  return {
    ...status,
    headline: 'Your workspace is live.',
    subtext: `Monitoring ${channelTotal} ${channelTotal === 1 ? 'channel' : 'channels'} and executing on ${executionAccountCount} ${executionAccountCount === 1 ? 'account' : 'accounts'}.`,
  };
}

export function OverviewHeader({ userName = 'trader', activation, loading = false, unavailable = false }) {
  const firstName = String(userName || 'trader').trim().split(/\s+/)[0] || 'trader';
  if (loading) return <div className="overview-heading-copy overview-header-skeleton" aria-label="Loading workspace summary" aria-busy="true">
    <span className="overview-skeleton overview-skeleton-greeting" aria-hidden="true" />
    <span className="overview-skeleton overview-skeleton-headline" aria-hidden="true" />
    <span className="overview-skeleton overview-skeleton-subtext" aria-hidden="true" />
  </div>;

  const headline = unavailable ? 'Workspace status unavailable.' : activation.headline;
  const subtext = unavailable
    ? 'Refresh your workspace to load the latest setup and execution status.'
    : activation.subtext;
  return <div className="overview-heading-copy" aria-live="polite" aria-atomic="true">
    <p className="overview-greeting">Good to see you, {firstName}.</p>
    <h2 className="overview-headline">{headline}</h2>
    <p className="overview-subtext">{subtext}</p>
  </div>;
}

const SETUP_STEPS = [
  { key: 'telegram', label: 'Connect Telegram', action: 'Connect', tab: 'telegram' },
  { key: 'channel', label: 'Select at least one monitored channel', action: 'Choose channels', tab: 'telegram' },
  { key: 'account', label: 'Connect at least one trading account', action: 'Connect account', tab: 'metaapi' },
];

export function SetupChecklist({ telegramConnected: telegramConnectedProp, channelCount = 0, linkedAccounts = [], onNavigate = () => {}, loading = false, unavailable = false }) {
  const telegramStatus = useTelegramStatus();
  const telegramConnected = typeof telegramConnectedProp === 'boolean'
    ? telegramConnectedProp
    : telegramStatus.view.key === 'connected';
  const steps = SETUP_STEPS.map((step) => ({
    ...step,
    complete: step.key === 'telegram'
      ? telegramConnected
      : step.key === 'channel'
        ? Number(channelCount) > 0
        : Array.isArray(linkedAccounts) && linkedAccounts.length > 0,
  }));
  const completeCount = steps.filter((step) => step.complete).length;

  if (loading || unavailable || completeCount === steps.length) return null;

  return <section className="panel setup-checklist" aria-labelledby="setup-checklist-title">
    <header className="setup-checklist-header">
      <div><p className="eyebrow">ACTIVATION GUIDE</p><h2 id="setup-checklist-title">Setup Checklist</h2></div>
      <span className="setup-checklist-count">{completeCount} of {steps.length} complete</span>
    </header>
    <div className="setup-checklist-progress" role="progressbar" aria-label="Setup progress" aria-valuemin="0" aria-valuemax={steps.length} aria-valuenow={completeCount}>
      <span style={{ width: `${(completeCount / steps.length) * 100}%` }} />
    </div>
    <ol className="setup-checklist-list">
      {steps.map((step, index) => <li className={`setup-checklist-step${step.complete ? ' setup-checklist-step-complete' : ''}`} data-complete={step.complete} key={step.key}>
        <span className="setup-checklist-icon" aria-hidden="true">{step.complete ? '✓' : index + 1}</span>
        <span className="setup-checklist-label">{step.label}</span>
        {!step.complete && <button type="button" className="setup-checklist-action" onClick={() => onNavigate(step.tab)} aria-label={`${step.action}: ${step.label}`}>{step.action}<span aria-hidden="true">→</span></button>}
      </li>)}
    </ol>
  </section>;
}

function MetricCard({ label, value, note, loading, unavailable }) {
  return <div className="metric-card" aria-busy={loading}>
    <span className="metric-label">{label}</span>
    {loading
      ? <span className="overview-skeleton overview-metric-skeleton" aria-hidden="true" />
      : <strong>{unavailable ? '—' : (value ?? '—')}</strong>}
    <span className="metric-note">{note}</span>
  </div>;
}

export function OverviewMetrics({ totalSignals, activeChannels, executedSignals, loading = false, unavailable = false }) {
  return <div className="metrics-grid overview-metrics-grid" aria-label="Workspace metrics" aria-busy={loading}>
    <MetricCard label="Signals captured" value={totalSignals} note="Across your workspace" loading={loading} unavailable={unavailable} />
    <MetricCard label="Active sources" value={activeChannels} note="Telegram channels" loading={loading} unavailable={unavailable} />
    <MetricCard label="Signals Executed" value={executedSignals} note="Successfully sent to broker" loading={loading} unavailable={unavailable} />
  </div>;
}

export function AutoTradingStatusCard({ activation, autoTradingEnabled = false, action = null, onNavigate = () => {}, loading = false, unavailable = false }) {
  if (loading) return <section className="overview-execution-card overview-execution-card-loading" data-state="loading" aria-labelledby="overview-execution-title" aria-busy="true">
    <div className="overview-execution-header">
      <div><p className="eyebrow">EXECUTION STATUS</p><h2 id="overview-execution-title">Auto-Trading</h2></div>
      <span className="overview-skeleton overview-status-skeleton-pill" aria-hidden="true" />
    </div>
    <div className="overview-execution-skeleton-copy" aria-hidden="true">
      <span className="overview-skeleton overview-status-skeleton-line" />
      <span className="overview-skeleton overview-status-skeleton-line overview-status-skeleton-line-short" />
    </div>
  </section>;

  const status = unavailable
    ? { state: 'unavailable', tone: 'muted', status: 'Unavailable', message: 'Auto-Trading status could not be loaded.' }
    : activation;
  const statusAction = action || (status.state === 'off' ? { label: 'Open Advanced Settings', tab: 'advanced' } : null);
  return <section className={`overview-execution-card overview-execution-card-${status.state}`} data-state={status.state} aria-labelledby="overview-execution-title">
    <div className="overview-execution-header">
      <div><p className="eyebrow">EXECUTION STATUS</p><h2 id="overview-execution-title">Auto-Trading</h2></div>
      <span className={`overview-execution-pill overview-execution-pill-${status.tone}`} data-tone={status.tone} role="status">{status.status}</span>
    </div>
    <p className="overview-execution-message">{status.message}</p>
    {statusAction && !unavailable && <button type="button" className="overview-execution-action" onClick={() => onNavigate(statusAction.tab)}>{statusAction.label}<span aria-hidden="true">→</span></button>}
    {autoTradingEnabled && !unavailable && <p className="overview-execution-warning"><span aria-hidden="true">!</span><span>{RISK_REMINDER} Use a demo account while you are testing, and turn this off in Advanced Settings whenever you want no new orders.</span></p>}
  </section>;
}

export function OverviewLoadingShell() {
  return <div className="app-shell overview-loading-shell" aria-busy="true">
    <aside className="sidebar overview-loading-sidebar" aria-hidden="true">
      <div className="side-brand">
        <span className="overview-skeleton overview-loading-mark" />
        <div className="brand-copy"><span className="overview-skeleton overview-loading-brand-line" /><span className="overview-skeleton overview-loading-brand-line overview-loading-brand-line-short" /></div>
      </div>
      <nav className="sidebar-nav">
        {[0, 1, 2, 3, 4, 5, 6].map((index) => <span className="overview-skeleton overview-loading-nav-line" key={index} />)}
      </nav>
      <div className="sidebar-bottom"><span className="overview-skeleton overview-loading-avatar" /><span className="overview-skeleton overview-loading-user-line" /></div>
    </aside>
    <main className="main-area overview-loading-main">
      <header className="topbar">
        <div><span className="eyebrow">PERSONAL WORKSPACE</span><h1>Overview</h1></div>
        <span className="overview-loading-label">Loading your workspace…</span>
      </header>
      <div className="content-area">
        <section className="welcome-row overview-welcome"><OverviewHeader loading /></section>
        <section className="panel setup-checklist overview-loading-checklist" aria-hidden="true">
          <span className="overview-skeleton overview-loading-checklist-title" />
          <span className="overview-skeleton overview-loading-checklist-progress" />
          {[0, 1, 2].map((index) => <span className="overview-skeleton overview-loading-checklist-row" key={index} />)}
        </section>
        <OverviewMetrics loading />
        <AutoTradingStatusCard loading />
      </div>
    </main>
  </div>;
}
