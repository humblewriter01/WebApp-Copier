/** The Overview activation header, checklist, metric grid, status card, and loading state stay tied to mocked data. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(here, '..', 'src');
const outfile = path.join(here, '.tmp', 'overview-activation.mjs');
const appSource = readFileSync(path.join(srcDir, 'App.jsx'), 'utf8');
const metaApiPanelSource = readFileSync(path.join(srcDir, 'components', 'MetaApiPanel.jsx'), 'utf8');
const cssSource = readFileSync(path.join(srcDir, 'styles.css'), 'utf8');

await build({
  stdin: {
    contents: "export { AutoTradingStatusCard, OverviewHeader, OverviewLoadingShell, OverviewMetrics, SetupChecklist, overviewActivationView } from './OverviewActivation.jsx';",
    resolveDir: path.join(srcDir, 'components'),
    loader: 'jsx',
  },
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'node',
  external: ['react', 'react-dom'],
  define: { 'process.env.NODE_ENV': '"development"', 'import.meta.env': '{}' },
  logLevel: 'silent',
});
assert.ok(existsSync(outfile), 'the activation components were bundled');
const { AutoTradingStatusCard, OverviewHeader, OverviewLoadingShell, OverviewMetrics, SetupChecklist, overviewActivationView } = await import(pathToFileURL(outfile).href);
const render = (Component, props = {}) => renderToStaticMarkup(React.createElement(Component, props));
const ACCOUNT = { metaApiAccountId: 'mt5-1', name: 'Kano Demo', login: '432109', state: 'DEPLOYED' };

const activationFor = (overrides = {}) => overviewActivationView({
  linkedAccounts: [],
  autoTradingEnabled: false,
  executionAccountId: '',
  channelCount: 0,
  ...overrides,
});

test('the greeting stays personalized and the no-account header names MT4/MT5', () => {
  const activation = activationFor();
  const html = render(OverviewHeader, { userName: 'Amina Yusuf', activation });
  assert.match(html, /Good to see you, Amina\./, 'the greeting remains personalized and uses the first name');
  assert.match(html, /Your bot is listening\./);
  assert.match(html, /You have signals waiting\. Connect an MT4\/MT5 account to start executing\./);
  assert.match(cssSource, /\.overview-greeting\{[^}]*color:#8491a3;[^}]*font-size:11px/,
    'the retained greeting is small and muted');
});

test('the explicit off switch renders Off even when no broker account is connected', () => {
  const activation = activationFor({ autoTradingEnabled: false, linkedAccounts: [] });
  const card = render(AutoTradingStatusCard, { activation, autoTradingEnabled: false });
  assert.match(card, /data-state="off"/);
  assert.match(card, /data-tone="muted"/);
  assert.match(card, />Off</);
  assert.match(card, /Auto-Trading is disabled\. Turn it on to execute signals\./);
  assert.match(card, /Open Advanced Settings/, 'the off state still links to the switch');
  assert.match(cssSource, /\.overview-execution-pill-muted\{[^}]*color:#647184/,
    'Off uses the neutral grey status style');
});

test('an enabled switch without a connected account renders Awaiting Broker in amber', () => {
  const activation = activationFor({ autoTradingEnabled: true, linkedAccounts: [] });
  assert.match(render(OverviewHeader, { userName: 'Amina Yusuf', activation }), /Your bot is listening\./);
  assert.equal(activation.state, 'awaiting-broker');

  const card = render(AutoTradingStatusCard, { activation, autoTradingEnabled: true });
  assert.match(card, /data-state="awaiting-broker"/);
  assert.match(card, /data-tone="pending"/);
  assert.match(card, />Awaiting Broker</);
  assert.doesNotMatch(card, />Pending</);
  assert.match(card, /Connect an MT4\/MT5 account to enable execution\./);
  assert.match(cssSource, /\.overview-execution-card-awaiting-broker,\.overview-execution-card-attention\{[^}]*border-left-color:#d6a13c/,
    'the large card keeps its amber warning edge');
  assert.match(cssSource, /\.overview-execution-pill-pending\{[^}]*color:#8b6417/,
    'the status pill keeps its amber warning styling');
  assert.match(cssSource, /\.signal-outcome\.tone-warn\{[^}]*background:#fdf6e6;color:#8a6a1f/,
    'Awaiting Broker signal chips also use the warning color');
});

test('a connected broker with Auto-Trading off keeps the Ready to execute header and Off card', () => {
  const activation = activationFor({ linkedAccounts: [ACCOUNT] });
  const header = render(OverviewHeader, { userName: 'Amina Yusuf', activation });
  assert.match(header, /Ready to execute\./);
  assert.match(header, /Your broker is connected\. Turn on Auto-Trading in Advanced Settings to allow the bot to place trades\./);

  const card = render(AutoTradingStatusCard, { activation, autoTradingEnabled: false });
  assert.match(card, /data-state="off"/);
  assert.match(card, />Off</);
  assert.match(card, /Auto-Trading is disabled\. Turn it on to execute signals\./);
});

test('a ready account and enabled switch show the live header and Active card', () => {
  const activation = activationFor({
    linkedAccounts: [ACCOUNT],
    autoTradingEnabled: true,
    executionAccountId: ACCOUNT.metaApiAccountId,
    channelCount: 5,
    executionReady: true,
  });
  const header = render(OverviewHeader, { userName: 'Amina Yusuf', activation });
  assert.match(header, /Your workspace is live\./);
  assert.match(header, /Monitoring 5 channels and executing on 1 account\./);

  const card = render(AutoTradingStatusCard, { activation, autoTradingEnabled: true });
  assert.match(card, /data-state="active"/);
  assert.match(card, /data-tone="good"/);
  assert.match(card, />Active</);
  assert.match(card, /Auto-Trading is live\./);
  assert.match(card, /class="overview-execution-warning"[^>]*>[\s\S]*Auto-Trading executes live orders\. Trade at your own risk\./,
    'the live-order warning is inside the status card');
  assert.match(cssSource, /\.overview-execution-pill-good\{[^}]*color:#217b55/,
    'Active uses the green status style');
});

test('the connected-account and enabled-switch state consistently drives Active copy', () => {
  const activation = activationFor({
    linkedAccounts: [ACCOUNT],
    autoTradingEnabled: true,
    executionAccountId: ACCOUNT.metaApiAccountId,
    channelCount: 2,
  });
  assert.equal(activation.state, 'active');
  assert.equal(activation.status, 'Active');
  assert.equal(activation.message, 'Auto-Trading is live.');
  assert.equal(activation.headline, 'Your workspace is live.');
  assert.match(activation.subtext, /Monitoring 2 channels and executing on 1 account/);
});

test('Recent Signals and the execution card share live switch/account state, refreshed after account changes', () => {
  assert.match(appSource, /<SignalTable signals=\{dashboard\?\.signals \|\| \[\]\} compact autoTradingEnabled=\{settings\.autoTradingEnabled\} linkedAccounts=\{linkedAccounts\}/,
    'Recent Signals receives the same current switch and account snapshot as the card');
  assert.match(appSource, /<AutoTradingStatusCard activation=\{overviewActivation\} autoTradingEnabled=\{settings\.autoTradingEnabled\}/,
    'the status card uses that workspace switch');
  assert.match(appSource, /<MetaApiPanel[^\n]*onAccountsChanged=\{refresh\}/,
    'broker changes ask App to refresh the whole Overview snapshot');
  assert.equal((metaApiPanelSource.match(/await onAccountsChanged\(\);/g) || []).length, 3,
    'adding, refreshing, and removing a broker account each refresh both Overview statuses');
});

test('the Setup Checklist tracks all three steps and disappears after completion', () => {
  const incomplete = render(SetupChecklist, {
    telegramConnected: true,
    channelCount: 1,
    linkedAccounts: [],
    onNavigate: () => {},
  });
  assert.match(incomplete, /Setup Checklist/);
  assert.match(incomplete, /Connect Telegram/);
  assert.match(incomplete, /Select at least one monitored channel/);
  assert.match(incomplete, /Connect an MT4\/MT5 account/);
  assert.match(incomplete, /Connect MT4\/MT5<span aria-hidden="true">→<\/span>/);
  assert.doesNotMatch(incomplete, /trading account/i, 'the activation checklist names the supported platforms directly');
  assert.match(incomplete, /2 of 3 complete/);
  assert.equal((incomplete.match(/data-complete="true"/g) || []).length, 2,
    'Telegram and a selected channel carry completed state');
  assert.match(incomplete, /class="setup-checklist-icon"[^>]*>✓</,
    'completed steps use the checkmark icon');

  const accountConnected = render(SetupChecklist, {
    telegramConnected: false,
    channelCount: 0,
    linkedAccounts: [ACCOUNT],
  });
  const completedAccountStep = [...accountConnected.matchAll(/<li class="setup-checklist-step setup-checklist-step-complete" data-complete="true">([\s\S]*?)<\/li>/g)]
    .map((match) => match[1]);
  assert.equal(completedAccountStep.length, 1, 'a linked trading account completes its checklist step');
  assert.match(completedAccountStep[0], /Connect an MT4\/MT5 account/);
  assert.match(completedAccountStep[0], />✓<\/span>/);

  const complete = render(SetupChecklist, {
    telegramConnected: true,
    channelCount: 2,
    linkedAccounts: [ACCOUNT],
  });
  assert.equal(complete, '', 'the activation checklist is hidden once every step is complete');
  assert.equal(render(SetupChecklist, { loading: true, channelCount: 0, linkedAccounts: [] }), '',
    'the checklist does not flash unconfirmed incomplete steps during initial loading');
});

test('the Overview has three data metrics and no duplicate Auto-Trading or Account Notes card', () => {
  const metrics = render(OverviewMetrics, { totalSignals: 19, activeChannels: 3, executedSignals: 7 });
  assert.equal((metrics.match(/class="metric-card"/g) || []).length, 3);
  assert.match(metrics, /Signals captured/);
  assert.match(metrics, /Active sources/);
  assert.match(metrics, /Signals Executed/);
  assert.match(metrics, />7</);
  assert.match(metrics, /Successfully sent to broker/);
  assert.doesNotMatch(metrics, /Account Notes|Auto-Trading/);
  assert.match(appSource, /<OverviewMetrics[\s\S]*?executedSignals=\{dashboard\?\.stats\?\.executedSignals\}/,
    'Signals Executed uses the API-backed count');
  assert.match(appSource, /<AutoTradingStatusCard activation=\{overviewActivation\}/,
    'the large execution card is the only Overview Auto-Trading status');
  assert.doesNotMatch(appSource, /label="Auto-Trading"/);
  assert.doesNotMatch(appSource, /risk-reminder-compact/,
    'the live-order reminder no longer floats outside the status card');
});

test('initial Overview loading renders metric and execution-card skeletons without zeroes or a false status', () => {
  const shell = render(OverviewLoadingShell);
  assert.match(shell, /class="app-shell overview-loading-shell" aria-busy="true"/);
  assert.match(shell, /Loading your workspace…/);
  assert.equal((shell.match(/overview-metric-skeleton/g) || []).length, 3,
    'all three metrics use skeleton values');
  assert.match(shell, /class="overview-execution-card overview-execution-card-loading" data-state="loading"/,
    'the status card itself is shown as a skeleton');
  assert.match(shell, /overview-status-skeleton-pill/);
  assert.doesNotMatch(shell, />Pending</);
  assert.doesNotMatch(shell, />Off</);
  assert.doesNotMatch(shell, />0</);
  assert.match(appSource, /if \(loading\) return <OverviewLoadingShell \/>/,
    'the initial fetch renders this shell instead of a zero-filled dashboard');
  assert.doesNotMatch(appSource, /stats\?\.(?:totalSignals|executedSignals) \?\? 0/,
    'the data grid does not invent zeroes before the API values exist');

  const unavailable = render(OverviewMetrics, { unavailable: true });
  assert.equal((unavailable.match(/>—<\/strong>/g) || []).length, 3,
    'a failed initial request does not turn missing values into zeroes');
  assert.match(render(AutoTradingStatusCard, { unavailable: true }), />Unavailable</,
    'a failed initial request does not invent Pending or Off');
});
