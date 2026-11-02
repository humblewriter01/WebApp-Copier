/**
 * The Auto-Trading switch, mounted and clicked.
 *
 * `auto_trading_enabled` used to default to TRUE, which meant a workspace could execute live orders from the second
 * its row was created - and it meant the confirmation that guards that switch could never be met on the way in,
 * because the guard is written against an *increase* and a row born on performs none. Fixing the default changes who
 * meets the modal: now the first upward click a new workspace makes is the one that has to be answered.
 *
 * That is a claim about an interaction, not about markup, so this file mounts the real `AdvancedSettings` in a real
 * DOM and presses the checkbox. What it pins is the order of events, which is the only thing a money switch should
 * be judged on: the click asks, nothing is written, and only the confirmation writes - with the acknowledgement
 * travelling in the same request, so a client cannot present an answer the server has not been told about.
 *
 * The house pattern for mounting is `admin-modal-interaction.test.mjs`: esbuild bundles the component with React
 * left external, `jsdom` supplies a DOM, and everything runs inside `React.act`. No `pretendToBeVisual`, because
 * its animation-frame loop outlives the last test and the report never drains.
 */
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import React from 'react';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(here, '..', 'src');
const outfile = path.join(here, '.tmp', 'advanced-settings-mounted.mjs');

await build({
  entryPoints: [path.join(srcDir, 'components', 'AdvancedSettings.jsx')],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'node',
  external: ['react', 'react-dom', 'react-dom/client'],
  define: { 'process.env.NODE_ENV': '"development"', 'import.meta.env': JSON.stringify({ PROD: false, DEV: true, VITE_API_URL: '' }) },
  jsx: 'automatic',
  logLevel: 'silent',
});
assert.ok(existsSync(outfile), 'the settings panel bundle was produced');

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
for (const name of ['HTMLElement', 'HTMLInputElement', 'HTMLSelectElement', 'HTMLTextAreaElement', 'Element', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'MutationObserver']) {
  Object.defineProperty(globalThis, name, { value: dom.window[name], configurable: true, writable: true });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
after(() => dom.window.close());

const { createRoot } = await import('react-dom/client');
const act = (callback) => React.act(callback);
const { default: AdvancedSettings } = await import(pathToFileURL(outfile).href);

/** A workspace exactly as signup creates one: unarmed, never acknowledged, but able to trade if it were armed. */
const NEW_WORKSPACE = Object.freeze({
  riskMode: 'fixed', riskPercent: 1, maxOpenPositions: 3, dailyLossLimit: 5,
  autoTradingEnabled: false, hasAcceptedRiskWarning: false, lotSizeMode: 'fixed', fixedLotSize: 0.01,
  maxDailyTrades: 10, executionAccountId: 'acct-1', breakEvenEnabled: false, breakEvenTriggerPoints: 20,
  breakEvenOffsetPoints: 0, trailingStopEnabled: false, trailingStopDistancePoints: 10,
  multipleTargetHandling: 'first_target', limitOrderExpiryValue: 30, limitOrderExpiryUnit: 'minutes', maxSlippagePoints: null,
});
const ACCOUNTS = [{ metaApiAccountId: 'acct-1', label: 'Demo', state: 'DEPLOYED' }];

async function mount(settings = NEW_WORKSPACE) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  const calls = { toggles: [], changes: [], submits: [] };
  await act(async () => {
    root.render(React.createElement(AdvancedSettings, {
      settings,
      accounts: ACCOUNTS,
      trades: [],
      runtimeAvailable: true,
      platformPause: { paused: false, state: 'live' },
      subscriptionStatus: 'active',
      onChange: (next) => calls.changes.push(next),
      onSubmit: (next) => calls.submits.push(next),
      onToggle: (enabled, extra) => calls.toggles.push([enabled, extra]),
    }));
  });
  const input = host.querySelector('#auto-trading-enabled');
  assert.ok(input, 'the Auto-Trading switch is on this page, where the confirmation belongs');
  return {
    host,
    calls,
    input,
    /* One click, no manual `change` event: React drives a checkbox's onChange from the click itself, so dispatching
       both would call the handler twice and a doubled write would look like a passing test. */
    clickSwitch: () => act(async () => { input.click(); }),
    clickConfirm: () => act(async () => { host.querySelector('.risk-warning-confirm')?.click(); }),
    clickCancel: () => act(async () => { [...host.querySelectorAll('.modal-actions button')].find((b) => /cancel/i.test(b.textContent))?.click(); }),
    modalOpen: () => Boolean(host.querySelector('.risk-warning-modal')),
    unmount: () => act(() => root.unmount()),
  };
}

test('the click that would arm live execution asks first and writes nothing', async () => {
  const view = await mount();
  await view.clickSwitch();
  assert.equal(view.modalOpen(), true, 'the confirmation appears on the click, not after a save');
  assert.deepEqual(view.calls.toggles, [], 'the switch did not save on its own - this is the whole assertion');
  assert.deepEqual(view.calls.changes, [], 'and no other write path carried it either');
  assert.deepEqual(view.calls.submits, []);
  assert.match(view.host.querySelector('.risk-warning-body').textContent, /execute live trades on your connected broker account/, 'in the words the product has chosen');
  assert.match(view.host.querySelector('.risk-warning-body').textContent, /You are fully responsible for any financial losses/, 'including the part nobody should have to discover');
  assert.equal(view.input.checked, false, 'the switch itself is still off while the question is being asked');
  await view.unmount();
});

test('the confirmation is what saves, and it saves the acknowledgement with it', async () => {
  const view = await mount();
  await view.clickSwitch();
  await view.clickConfirm();
  assert.deepEqual(view.calls.toggles, [[true, { hasAcceptedRiskWarning: true }]], 'one write, arming the switch and recording the answer in the same request');
  assert.equal(view.modalOpen(), false, 'and the dialog is gone, so a second click cannot double-save');
  await view.unmount();
});

test('refusing the question leaves the workspace exactly as it was', async () => {
  const view = await mount();
  await view.clickSwitch();
  await view.clickCancel();
  assert.deepEqual(view.calls.toggles, [], 'cancelling is not an error and is not a yes');
  assert.equal(view.modalOpen(), false);
  assert.equal(view.input.checked, false, 'the switch stayed off, which is the only safe thing it could have done');
  await view.unmount();
});

test('asking happens on the way up, never on the way down', async () => {
  const view = await mount({ ...NEW_WORKSPACE, autoTradingEnabled: true, hasAcceptedRiskWarning: true });
  assert.equal(view.input.checked, true);
  await view.clickSwitch();
  assert.deepEqual(view.calls.toggles, [[false, undefined]], 'a decrease is executed at once: waiting to turn a live account off is how a pause becomes a loss');
  assert.equal(view.modalOpen(), false, 'and no dialog stands in front of it');
  await view.unmount();
});

test('a workspace that has answered once is not asked twice, and still cannot skip the answer', async () => {
  // Two facts that look like a contradiction and are not: the standing acknowledgement is stored, so re-arming a
  // switch the owner already confirmed does not interrupt them; and a workspace that has never confirmed - which is
  // every workspace until the modal above is answered - cannot get an increase through the panel at all.
  const seen = await mount({ ...NEW_WORKSPACE, hasAcceptedRiskWarning: true });
  await seen.clickSwitch();
  assert.deepEqual(seen.calls.toggles, [[true, undefined]], 'the second time is a switch, not a ceremony');
  assert.equal(seen.modalOpen(), false);
  await seen.unmount();

  const appSource = readFileSync(path.join(srcDir, 'App.jsx'), 'utf8');
  const panel = readFileSync(path.join(srcDir, 'components', 'AdvancedSettings.jsx'), 'utf8');
  assert.match(panel, /if \(enabled && needsRiskAcknowledgement\(settings\)\) \{\s*setRiskWarningOpen\(true\);\s*return;\s*\}/, 'the ask is the first branch of the toggle, ahead of every save path');
  assert.match(appSource, /const toggleAutoTrading[\s\S]{0,400}autoTradingEnabled: enabled/, 'the shell passes the switch through to the one route that writes it');
  assert.match(readFileSync(path.join(here, '..', '..', 'server', 'index.js'), 'utf8'), /if \(autoTradingEnabled\) \{[\s\S]{0,400}Confirm the live-trading warning before Auto-Trading is turned on/,
    'and the server refuses the increase without the answer, so this dialog is a courtesy backed by a rule rather than the only thing standing in the way');
});

test('a workspace created today starts unarmed in the client too', () => {
  // The default is decided in three places and must be the same answer in all three: the column default, the
  // signup insert, and the settings object the shell holds before the first read comes back.
  const appSource = readFileSync(path.join(srcDir, 'App.jsx'), 'utf8');
  const initial = /const \[settings, setSettings\] = useState\(\{([^}]*)\}\)/.exec(appSource)[1];
  assert.match(initial, /autoTradingEnabled: false/, 'the shell’s idea of a fresh workspace is an unarmed one');
  assert.match(initial, /hasAcceptedRiskWarning: false/, 'which has never confirmed anything');
  const dbSource = readFileSync(path.join(here, '..', '..', 'server', 'db.js'), 'utf8');
  assert.match(dbSource, /ADD COLUMN IF NOT EXISTS auto_trading_enabled BOOLEAN NOT NULL DEFAULT FALSE/);
  assert.ok(!/ADD COLUMN IF NOT EXISTS auto_trading_enabled[^;]*DEFAULT TRUE/.test(dbSource), 'and no stale TRUE remains beside it');
});
