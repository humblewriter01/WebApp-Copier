import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { signalBadges, signalHasTradingData, signalOutcomeView } from '../src/lib/signal-outcome.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = (...parts) => path.join(here, '..', 'src', ...parts);

// SignalTable shares the Telegram status hook, and ConfirmModal and the settings panel are JSX, so each
// is transpiled into its own throwaway bundle with React left external. One build per component, so the
// output name is known rather than derived from how esbuild flattens a directory.
const bundleFor = async (name, ...parts) => {
  const outfile = path.join(here, '.tmp', `review-${name}.mjs`);
  await build({
    entryPoints: [src(...parts)],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    external: ['react'],
    define: {
      'process.env.NODE_ENV': '"development"',
      'import.meta.env': JSON.stringify({ PROD: false, VITE_API_URL: 'http://localhost:5000' }),
    },
    logLevel: 'silent',
  });
  assert.ok(existsSync(outfile), `the ${name} component bundle was produced`);
  return await import(pathToFileURL(outfile).href);
};

const signalTableModule = await bundleFor('signal-table', 'components', 'SignalTable.jsx');
const ConfirmModal = (await bundleFor('confirm-modal', 'components', 'ConfirmModal.jsx')).default;
const ExecutionSettings = (await bundleFor('execution-settings', 'components', 'ExecutionSettings.jsx')).default;
const SignalTable = signalTableModule.default;
const { signalEmptyState } = signalTableModule;
// The two sentences belong to the status module, not the table, so they are read from there: a test that
// retyped them would pass while the panel said something else.
const telegramStatusModule = await bundleFor('telegram-status', 'components', 'TelegramStatus.jsx');
const { LISTENER_NOT_ATTACHED_MESSAGE, WAITING_FOR_MESSAGES_MESSAGE } = telegramStatusModule;

const appSource = readFileSync(src('App.jsx'), 'utf8');
const adminSource = readFileSync(src('components', 'AdminPanel.jsx'), 'utf8');

// Node does not parse JSX, so the components are created explicitly - the same call esbuild makes for
// the bundled sources, and it keeps the assertions about markup honest.
const render = (component, props = {}, ...children) => renderToStaticMarkup(React.createElement(component, props, ...children));

/* ---------------------------------------------------------------- the badges */
test('a badge is only ever printed for something the signal row actually says', () => {
  const inferred = { source: 'telegram', directionInferred: true, stopLoss: 1.08, takeProfit: 1.09 };
  assert.deepEqual(signalBadges(inferred).map((badge) => badge.label), ['Inferred']);

  const thin = { source: 'telegram', directionInferred: false, entryPrice: 1.08, stopLoss: null, takeProfit: null };
  assert.deepEqual(signalBadges(thin).map((badge) => badge.label), ['Missing SL', 'Missing TP']);

  const complete = { source: 'telegram', directionInferred: false, entryPrice: 1.08, stopLoss: 1.07, takeProfit: 1.1 };
  assert.deepEqual(signalBadges(complete), [], 'a full signal is not decorated with warnings');

  // A hand-written note has no prices to be missing: it is not a channel message that failed.
  assert.deepEqual(signalBadges({ source: 'manual', stopLoss: null, takeProfit: null }), []);
  for (const badge of signalBadges(thin)) assert.ok(badge.title.length > 40, `${badge.label} has to explain itself on hover`);
});

test('"no clear signal" is reserved for a message with no trading data at all', () => {
  assert.equal(signalHasTradingData({ message: 'good morning everyone' }), false);
  assert.equal(signalHasTradingData({ message: 'hello', entryPrice: 1.08 }), true);
  assert.equal(signalOutcomeView({ status: 'unparsed', message: 'good morning' }).label, 'No clear signal');
  const readable = signalOutcomeView({ status: 'unparsed', symbol: 'EURUSD', side: 'buy', entryPrice: 1.08, executionNote: null, parseError: 'The signal needs an entry price.' });
  assert.equal(readable.label, 'Needs review', 'a legible note with a hole in it is not an unclear message');
  assert.equal(signalOutcomeView({ status: 'queued' }).label, 'Sent for execution', 'the known statuses are untouched');
});

/* ---------------------------------------------------------------- the list */
test('the signal list shows the badges and offers removal per row, only when deletion is allowed', () => {
  const signal = {
    id: 'signal-1', source: 'telegram', symbol: 'EURUSD', side: 'buy', message: 'EURUSD Entry 1.0850 TP 1.0950',
    entryPrice: 1.085, stopLoss: null, takeProfit: 1.095, directionInferred: true, status: 'received', createdAt: '2026-04-04T10:00:00.000Z',
  };
  const withDelete = render(SignalTable, { signals: [signal], onDeleteSignal: () => {}, channelCount: 1 });
  assert.match(withDelete, />Inferred</);
  assert.match(withDelete, />Missing SL</);
  assert.match(withDelete, /signal-delete-button/, 'a per-row removal control is offered');
  assert.match(withDelete, /aria-label="Remove EURUSD from your history"/, 'the control says which row it touches');

  // Support view is read-only on the server too; the panel must not offer a button that will be refused.
  const readOnly = render(SignalTable, { signals: [signal], channelCount: 1 });
  assert.equal(readOnly.includes('signal-delete-button'), false, 'no delete control without the callback');
  assert.match(render(SignalTable, { signals: [signal], onDeleteSignal: () => {}, deletingId: 'signal-1', channelCount: 1 }), /signal-delete-button[^>]*disabled/, 'the row is held while its delete is in flight');
});

/* ---------------------------------------------------------------- the confirmation */
test('a destructive confirmation is a dialog, and it is not a click deep', () => {
  assert.equal(render(ConfirmModal, { open: false, title: 'Delete?', onConfirm: () => {}, children: 'body' }), '', 'a closed confirmation renders nothing at all');
  const markup = render(ConfirmModal, { open: true, title: 'Clear your signal history?', confirmLabel: 'Clear history', onCancel: () => {}, onConfirm: () => {}, children: React.createElement('p', null, 'Trades are kept.') });
  assert.match(markup, /role="alertdialog"/);
  assert.match(markup, /aria-modal="true"/);
  assert.match(markup, /aria-labelledby="confirm-modal-title"/, 'the dialog labels itself with its own title');
  assert.match(markup, /Clear your signal history\?/);
  assert.match(markup, /Trades are kept\./);
  assert.match(markup, /button-danger/, 'the confirm side reads as destructive, not as the primary path');
  assert.match(markup, /Cancel/);
  const busy = render(ConfirmModal, { open: true, busy: true, title: 'Delete?', confirmLabel: 'Delete signal', onConfirm: () => {}, onCancel: () => {}, children: 'x' });
  assert.match(busy, /Working…/, 'an in-flight deletion changes the button rather than firing twice');
  assert.match(busy, /disabled/, 'and both sides are held while it runs');
});

test('an empty list never promises messages while no stream is attached', () => {
  const connected = { key: 'connected', known: true, showConnectCallToAction: false };
  // The endpoint has said the handler is attached: the patient sentence is the honest one.
  assert.equal(signalEmptyState({ view: { ...connected, listening: true }, channelCount: 2 }).message, WAITING_FOR_MESSAGES_MESSAGE);
  const idle = signalEmptyState({ view: { ...connected, listening: false }, channelCount: 2 });
  assert.equal(idle.title, 'Signed in, not yet reading');
  assert.equal(idle.message, LISTENER_NOT_ATTACHED_MESSAGE, 'waiting for messages is a promise the server just denied');
  // Unknown is not the same as "not attached", so nothing is inferred from a missing field.
  assert.equal(signalEmptyState({ view: { ...connected, listening: null }, channelCount: 2 }).message, WAITING_FOR_MESSAGES_MESSAGE);
  assert.equal(signalEmptyState({ view: { ...connected, listening: false }, channelCount: 0 }).action, 'choose', 'with no channels selected there is nothing to listen to yet');
});

/* ---------------------------------------------------------------- the settings panel */
const settingsBase = {
  riskMode: 'fixed', riskPercent: 1, maxOpenPositions: 3, dailyLossLimit: 5, autoTradingEnabled: true,
  lotSizeMode: 'fixed', fixedLotSize: 0.01, maxDailyTrades: 10, executionAccountId: 'account-1',
  breakEvenEnabled: false, breakEvenTriggerPoints: 20, breakEvenOffsetPoints: 0,
  trailingStopEnabled: false, trailingStopDistancePoints: 10, hasAcceptedRiskWarning: true,
};
const renderSettings = (settings) => render(ExecutionSettings, {
  settings,
  accounts: [{ metaApiAccountId: 'account-1', name: 'Demo MT5', platform: 'mt5', server: 'Broker-Demo', state: 'DEPLOYED' }],
  trades: [],
  runtimeAvailable: true,
  platformPause: null,
  onChange: () => {},
  onSubmit: (event) => event.preventDefault(),
  saving: false,
});

test('the risk panel is three groups, and the strict one is folded away', () => {
  const markup = renderSettings(settingsBase);
  assert.match(markup, /<h3>Core Risk<\/h3>/);
  assert.match(markup, /<h3>Trade Management<\/h3>/);
  assert.match(markup, /Advanced Safety/);
  // The grouping has to be real, not three headings over one undifferentiated stack.
  assert.ok(markup.indexOf('Core Risk') < markup.indexOf('Trade Management'), 'Core Risk comes first');
  assert.ok(markup.indexOf('Trade Management') < markup.indexOf('Advanced Safety'), 'the strictest rules come last');
  assert.ok(markup.indexOf('id="risk-percent"') < markup.indexOf('Trade Management'), 'risk limits sit under Core Risk');
  assert.ok(markup.indexOf('id="execution-account"') > markup.indexOf('Trade Management'), 'the account and lot sizing sit under Trade Management');
  assert.match(markup, /<details class="execution-advanced">/, 'Advanced Safety is a closed disclosure, not open by default');
  assert.equal(markup.includes('<details class="execution-advanced" open'), false, 'nothing about this group is switched on for the reader');
});

test('the stop-loss guard is on unless the workspace has explicitly switched it off', () => {
  const defaultMarkup = renderSettings(settingsBase);
  assert.match(defaultMarkup, /Block execution if Stop Loss is missing ON/);
  assert.match(defaultMarkup, /id="block-missing-stop" type="checkbox" checked/, 'a settings object that predates the switch reads as the safe one');
  assert.match(defaultMarkup, /Blocking/, 'the summary states the effect before it is opened');

  const relaxed = renderSettings({ ...settingsBase, blockExecutionWithoutStopLoss: false });
  assert.match(relaxed, /id="block-missing-stop" type="checkbox"/);
  assert.equal(/id="block-missing-stop" type="checkbox" checked/.test(relaxed), false, 'the checkbox reflects the saved value');
  assert.match(relaxed, /Allowed/, 'and the summary says what that means');
  // The copy has to say what stays strict, or "off" reads as "everything is allowed".
  assert.match(relaxed, /only in Fixed Lot mode/);
  assert.match(relaxed, /Nothing else is relaxed/i);
  assert.match(relaxed, /inferred[^.]*never executed|never executed/i);
});

/* ---------------------------------------------------------------- the callers */
test('the user history deletes are confirmed, scoped, and reported from the server counts', () => {
  // One handler for both shapes, with the row path carrying the id: a second call site is a second
  // place to forget the confirmation or the support-view guard.
  assert.match(appSource, /request\(kind === 'row' \? `\/api\/signals\/\$\{id\}` : '\/api\/signals', authToken, \{ method: 'DELETE' \}\)/);
  // Two destructive calls in the whole workspace panel: the account note and the signal history (one call
  // site, both shapes). Anything that adds a third has to say what it is, here, on purpose.
  assert.equal((appSource.match(/method: 'DELETE'/g) || []).length, 2, 'the panel has exactly two DELETE call sites');
  // nothing fires without the confirmation step, and support view is refused before a request is made
  assert.ok(appSource.indexOf('confirmSignalDeletion') < appSource.indexOf('onConfirm={confirmSignalDeletion}'), 'the handler is defined once and only wired to the modal');
  assert.match(appSource, /onCancel=\{\(\) => \(signalDeleting \? null : setSignalDeletion\(null\)\)\}/, 'a confirmation cannot be dismissed mid-request');
  assert.match(appSource, /onDeleteSignal=\{readOnlySupport \? undefined : /, 'read-only support view gets no delete control');
  assert.match(appSource, /Number\(result\?\.deleted\)/, 'the count in the notice is the one the database returned');
  assert.match(appSource, /kept in your history/, 'the notice says what happened to a linked trade');
  assert.equal(/request\(`\/api\/trades[^`]*`, authToken, \{ method: 'DELETE'/.test(appSource), false, 'no trade is ever deleted from this panel');
});

test('admin data management deletes signals only, through one confirmed path', () => {
  assert.match(adminSource, /\{ key: 'data', label: 'Data management' \}/);
  assert.match(adminSource, /request\(`\/api\/admin\/signals\/\$\{signalConfirm\.row\.id\}`, token, \{ method: 'DELETE' \}\)/);
  assert.match(adminSource, /request\(`\/api\/admin\/users\/\$\{signalConfirm\.row\.userId\}\/signals`, token, \{ method: 'DELETE' \}\)/);
  assert.match(adminSource, /request\('\/api\/admin\/signals\/purge', token, \{ method: 'POST', body: \{ olderThanDays: Number\(purgeDays\) \} \}\)/);
  // the buttons open a confirmation; they never call the endpoint themselves
  for (const kind of ['row', 'user', 'purge']) {
    assert.ok(adminSource.includes(`setSignalConfirm({ kind: '${kind}'`), `the ${kind} deletion asks first`);
  }
  assert.equal(/request\(`\/api\/admin\/signals[^`]*`, token, \{ method: 'DELETE'/.test(adminSource.split('runSignalDeletion')[1] || ''), true, 'and only the confirmed handler ever fires it');
  assert.match(adminSource, /trade record.*kept and unlinked/s, 'the admin copy says what happens to a linked trade');
  assert.equal(/method: 'DELETE'[^)]*\/api\/(admin\/)?trades/.test(adminSource), false, 'a trade row is never deleted from the admin panel');
  assert.match(adminSource, /setSignalError\(deleteError\.message/, 'the server sentence is shown verbatim when a delete is refused');
  assert.match(adminSource, /loadPurgePreview/, 'the purge count is read before it is confirmed, not guessed');
});
