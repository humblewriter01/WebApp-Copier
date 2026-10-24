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
const AdvancedSettings = (await bundleFor('advanced-settings', 'components', 'AdvancedSettings.jsx')).default;
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
  // A direction is only ever inferred *from* an entry and a target, so the fixture carries both.
  const inferred = { source: 'telegram', directionInferred: true, entryPrice: 1.08, stopLoss: 1.08, takeProfit: 1.09 };
  assert.deepEqual(signalBadges(inferred).map((badge) => badge.label), ['Inferred']);
  // Take the entry away and that is not a third hole in the message - it is the channel asking to be filled
  // now, which is a fact worth printing next to the inference it was judged from.
  assert.deepEqual(signalBadges({ ...inferred, entryPrice: null }).map((badge) => badge.label), ['Inferred', 'Market']);

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
const renderSettings = (settings) => render(AdvancedSettings, {
  settings,
  accounts: [{ metaApiAccountId: 'account-1', name: 'Demo MT5', platform: 'mt5', server: 'Broker-Demo', state: 'DEPLOYED' }],
  trades: [],
  runtimeAvailable: true,
  platformPause: null,
  onChange: () => {},
  onSubmit: (event) => event.preventDefault(),
  saving: false,
});

test('the advanced page is three folded bars that each state their own state, in the order a decision is made', () => {
  const markup = renderSettings(settingsBase);
  // A bar is a `<details>` element, so it folds with no script, is keyboard-operable, and reports its
  // own state to a screen reader; the title lives in the bar and every control sits under it.
  assert.match(markup, /<h3>Core Execution<\/h3>/);
  assert.match(markup, /<h4>Auto-Trading<\/h4>/, 'the switch is named inside the bar that leads the page');
  assert.match(markup, /<h3>Trade Management<\/h3>/);
  assert.match(markup, /<h3>Advanced Safety Nets<\/h3>/);
  assert.ok(markup.indexOf('Core Execution') < markup.indexOf('Trade Management'), 'what decides whether anything is sent comes first');
  assert.ok(markup.indexOf('Trade Management') < markup.indexOf('Advanced Safety'), 'the strictest rules come last');
  // The account and the lot size travel with the switch they are conditions of, not with the trade they
  // produce: an order cannot exist without all three, so splitting them across bars split one decision.
  assert.ok(markup.indexOf('id="execution-account"') < markup.indexOf('Trade Management'), 'the connected account sits in Core Execution');
  assert.ok(markup.indexOf('id="lot-size-mode"') < markup.indexOf('Trade Management'), 'and so does the lot size');
  assert.ok(markup.indexOf('id="execution-account"') > markup.indexOf('Core Execution'));
  // Exactly one bar is open for the reader: the one most often changed. The other two explain themselves
  // on expand, which is what keeps the page to three lines instead of three screens.
  const openBars = markup.match(/<details[^>]*class="[^"]*settings-section[^"]*"[^>]*open=""/g) || [];
  assert.equal(openBars.length, 1, `one bar open, found ${openBars.length}`);
  assert.match(openBars[0], /settings-section-core-execution/);
  assert.equal(markup.includes('settings-section-trade-management" open'), false, 'how a trade is looked after is read by whoever asks for it');
  assert.equal(markup.includes('settings-section-advanced-safety" open'), false, 'nothing about the strictest group is switched on for the reader');
  // A header that only named its section would be a click to learn whether anything is protecting a trade.
  assert.match(markup, /No stop moves · First Target Only/, 'the folded bar states both halves of what it governs');
  assert.match(markup, /settings-section-state-bad">Blocking</, 'and the state is a badge, not a colour nobody can read');
  // Every bar turns its chevron: the rotation is a CSS transform on the open state, not a second icon.
  assert.equal((markup.match(/class="settings-section-chevron"/g) || []).length, 3, 'one chevron per bar');
  // What moved out stays out: the panel used to carry these between the risk percent and the safety
  // blocks, which is exactly the mixing this split exists to end.
  for (const absent of ['id="risk-percent"', 'id="max-open-trades"', 'id="max-daily-trades"', 'id="daily-loss-limit"', 'Delete My Account', 'account-danger-zone']) {
    assert.equal(markup.includes(absent), false, `${absent} belongs to another page now`);
  }
  assert.match(markup, /Risk Settings/, 'and the page says where those numbers went');
});

test('the stop-loss guard is on unless the workspace has explicitly switched it off', () => {
  const defaultMarkup = renderSettings(settingsBase);
  assert.match(defaultMarkup, /Block execution if Stop Loss is missing ON/);
  assert.match(defaultMarkup, /id="block-missing-stop" type="checkbox" checked/, 'a settings object that predates the switch reads as the safe one');
  assert.match(defaultMarkup, /Blocking/, 'the summary states the effect before it is opened');

  // One block off while the other is still on is still a blocking workspace: the header says what the
  // group does overall, not what the one switch the reader just touched does.
  const halfRelaxed = renderSettings({ ...settingsBase, blockExecutionWithoutStopLoss: false });
  assert.match(halfRelaxed, /Blocking/, 'the take-profit block is still up, so nothing has been allowed overall');

  const relaxed = renderSettings({ ...settingsBase, blockExecutionWithoutStopLoss: false, blockExecutionWithoutTakeProfit: false });
  assert.match(relaxed, /id="block-missing-stop" type="checkbox"/);
  assert.equal(/id="block-missing-stop" type="checkbox" checked/.test(relaxed), false, 'the checkbox reflects the saved value');
  assert.match(relaxed, /Allowed/, 'and the summary says what that means');
  // The copy has to say what stays strict, or "off" reads as "everything is allowed".
  assert.match(relaxed, /only in Fixed Lot mode/);
  assert.match(relaxed, /Nothing else is relaxed/i);
  assert.match(relaxed, /inferred[^.]*never executed|never executed/i);
});

test('the take-profit block and the two fallback distances are part of the same folded decision', () => {
  const markup = renderSettings(settingsBase);
  assert.match(markup, /Block execution if Take Profit is missing ON/, 'a workspace that predates the switch is not silently permitted to trade with no exit');
  assert.match(markup, /id="block-missing-target" type="checkbox" checked/);
  assert.match(markup, /id="fallback-stop-loss" type="number" min="1" max="1000000" step="1" placeholder="None"/);
  assert.match(markup, /id="fallback-take-profit" type="number" min="1" max="1000000" step="1" placeholder="None"/);
  // Points, like every other distance in this panel, and blank is a legal answer.
  assert.match(markup, /Fallback Stop Loss \(points\)/);
  assert.match(markup, /Fallback Take Profit \(points\)/);
  assert.match(markup, /Blank means no fallback\./);
  assert.match(markup, /On most FX pairs 10 points is one pip/);
  assert.match(markup, /value=""/, 'no fallback is an empty field, not a 0 somebody has to notice');
  // Where the fields sit is the policy in visual form: the two refusals, then the two rescues, all of it
  // inside the same disclosure that decides execution.
  assert.ok(markup.indexOf('id="block-missing-stop"') < markup.indexOf('id="block-missing-target"'), 'the two blocks are read together');
  assert.ok(markup.indexOf('id="block-missing-target"') < markup.indexOf('id="fallback-stop-loss"'), 'the nets follow the rules they answer');
  assert.ok(markup.indexOf('id="fallback-take-profit"') < markup.indexOf('execution-advanced-facts'), 'nothing about execution eligibility lives outside this group');
  assert.ok(markup.indexOf('Fallback Stop Loss') > markup.indexOf('Trade Management'), 'a fallback is not filed with the lot settings');
  // The copy that makes the rescue honest.
  assert.match(markup, /used only when a signal states no stop loss of its own/);
  assert.match(markup, /what the channel wrote always wins/);
  assert.match(markup, /reported as unusable rather than ignored/);
  assert.match(markup, /Block execution if Stop Loss is missing ON/, 'the wording the workspace already reads is untouched');
  assert.match(markup, /Nothing else is relaxed/i);
});

test('saved fallback distances come back into the fields, and an empty one is not turned into a number', () => {
  const saved = renderSettings({ ...settingsBase, fallbackStopLossPoints: 3000, fallbackTakeProfitPoints: '4000', blockExecutionWithoutTakeProfit: false });
  assert.match(saved, /id="fallback-stop-loss"[^>]*value="3000"/);
  assert.match(saved, /id="fallback-take-profit"[^>]*value="4000"/);
  assert.match(saved, /Block execution if Take Profit is missing OFF/);
  assert.equal(/id="block-missing-target" type="checkbox" checked/.test(saved), false, 'the checkbox reflects the saved value');
  assert.match(saved, /Blocking/, 'while the stop block is on the group still refuses, and says so');

  const cleared = renderSettings({ ...settingsBase, fallbackStopLossPoints: null, fallbackTakeProfitPoints: undefined });
  // Scoped to these two inputs on purpose: `value="0"` is a legitimate break-even offset, and a distance
  // of zero here is not - it would mean a stop sitting exactly on the order price.
  const emptyStop = cleared.match(/id="fallback-stop-loss"[^>]*/)[0];
  const emptyTarget = cleared.match(/id="fallback-take-profit"[^>]*/)[0];
  assert.equal(/value="0"/.test(emptyStop) || /value="0"/.test(emptyTarget), false, 'a blank net never renders as 0 points, which would be a distance');
  assert.match(emptyStop, /value=""/);
  assert.match(emptyTarget, /value=""/);

  const both = renderSettings({ ...settingsBase, blockExecutionWithoutStopLoss: false, blockExecutionWithoutTakeProfit: false });
  assert.match(both, /Allowed/, 'only with neither block left standing does the header say what is permitted');
});

test('a missing leg is described as the choice it now is', () => {
  const signal = { id: 'signal-1', source: 'telegram', status: 'skipped', stopLoss: null, takeProfit: null };
  const badges = signalBadges(signal);
  assert.deepEqual(badges.map((badge) => badge.key), ['missing-stop', 'missing-target']);
  assert.match(badges[0].title, /fallback distance in your Safety settings can supply one/i);
  assert.match(badges[0].title, /while the stop-loss block is on/);
  // The target badge used to promise that no target never stopped an order; the block made that false,
  // and a badge that contradicts the refusal sentence under it is worse than no badge.
  assert.match(badges[1].title, /Your Safety settings decide whether that stops an order/);
  assert.equal(badges[1].title.includes('never stopped an order'), false);
  assert.deepEqual(signalBadges({ ...signal, source: 'manual' }), [], 'a note the user typed is not judged by the rules for a live channel');
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
