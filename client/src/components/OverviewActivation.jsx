import React from 'react';
import { useTelegramStatus } from './TelegramStatus.jsx';
import { RISK_REMINDER } from './RiskWarningModal.jsx';

/** A single view model keeps the header, metric, and execution card in agreement. */
export function overviewActivationView({
  linkedAccounts = [],
  autoTradingEnabled = false,
  executionAccountId = '',
  channelCount = 0,
  executionReady = true,
  executionIssue = '',
} = {}) {
  const accounts = Array.isArray(linkedAccounts) ? linkedAccounts.filter((account) => account && typeof account === 'object') : [];
  const selectedAccount = accounts.find((account) => String(account.metaApiAccountId || '') === String(executionAccountId || '')) || null;
  const account = selectedAccount || accounts[0] || null;
  const accountName = [account?.name, account?.login, account?.label].find((value) => typeof value === 'string' && value.trim())?.trim()
    || 'your connected account';
  const channelTotal = Math.max(0, Number.isFinite(Number(channelCount)) ? Math.floor(Number(channelCount)) : 0);

  if (!accounts.length) {
    return {
      state: 'pending',
      tone: 'pending',
      status: 'Pending',
      headline: 'Your bot is listening.',
      subtext: 'You have signals waiting. Connect an MT5 account to start executing.',
      message: 'Connect a broker account to enable execution.',
      metricNote: 'Connect a broker account',
    };
  }

  if (autoTradingEnabled !== true) {
    return {
      state: 'off',
      tone: 'muted',
      status: 'Off',
      headline: 'Ready to execute.',
      subtext: 'Your broker is connected. Turn on Auto-Trading in Advanced Settings to allow the bot to place trades.',
      message: 'Auto-Trading is disabled. Turn it on to execute signals.',
      metricNote: 'Turn it on in Advanced Settings',
    };
  }

  if (executionReady !== true) {
    const issue = typeof executionIssue === 'string' && executionIssue.trim()
      ? executionIssue.trim()
      : 'Auto-Trading is enabled, but execution is not ready yet.';
    return {
      state: 'attention',
      tone: 'pending',
      status: 'Needs attention',
      headline: 'Your setup needs attention.',
      subtext: issue,
      message: issue,
      metricNote: 'Execution setup needs attention',
    };
  }

  const executionAccountCount = selectedAccount ? 1 : accounts.length;
  return {
    state: 'active',
    tone: 'good',
    status: 'Active',
    headline: 'Your workspace is live.',
    subtext: `Monitoring ${channelTotal} ${channelTotal === 1 ? 'channel' : 'channels'} and executing on ${executionAccountCount} ${executionAccountCount === 1 ? 'account' : 'accounts'}.`,
    message: `Auto-Trading is live. Executing on ${accountName}.`,
    metricNote: `Live on ${accountName}`,
  };
}

export function OverviewHeader({ userName = 'trader', activation }) {
  const firstName = String(userName || 'trader').trim().split(/\s+/)[0] || 'trader';
  return <div className="overview-heading-copy" aria-live="polite" aria-atomic="true">
    <p className="overview-greeting">Good to see you, {firstName}.</p>
    <h2 className="overview-headline">{activation.headline}</h2>
    <p className="overview-subtext">{activation.subtext}</p>
  </div>;
}

const SETUP_STEPS = [
  { key: 'telegram', label: 'Connect Telegram', action: 'Connect', tab: 'telegram' },
  { key: 'channel', label: 'Select at least one monitored channel', action: 'Choose channels', tab: 'telegram' },
  { key: 'account', label: 'Connect at least one trading account', action: 'Connect account', tab: 'metaapi' },
];

export function SetupChecklist({ telegramConnected: telegramConnectedProp, channelCount = 0, linkedAccounts = [], onNavigate = () => {} }) {
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

  if (completeCount === steps.length) return null;

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

export function AutoTradingStatusCard({ activation, autoTradingEnabled = false, action = null, onNavigate = () => {} }) {
  const statusAction = action || (activation.state === 'off' ? { label: 'Open Advanced Settings', tab: 'advanced' } : null);
  return <section className={`overview-execution-card overview-execution-card-${activation.state}`} data-state={activation.state} aria-labelledby="overview-execution-title">
    <div className="overview-execution-header">
      <div><p className="eyebrow">EXECUTION STATUS</p><h2 id="overview-execution-title">Auto-Trading</h2></div>
      <span className={`overview-execution-pill overview-execution-pill-${activation.tone}`} data-tone={activation.tone} role="status">{activation.status}</span>
    </div>
    <p className="overview-execution-message">{activation.message}</p>
    {statusAction && <button type="button" className="overview-execution-action" onClick={() => onNavigate(statusAction.tab)}>{statusAction.label}<span aria-hidden="true">→</span></button>}
    {autoTradingEnabled && <p className="overview-execution-warning"><span aria-hidden="true">!</span><span>{RISK_REMINDER} Use a demo account while you are testing, and turn this off in Advanced Settings whenever you want no new orders.</span></p>}
  </section>;
}
