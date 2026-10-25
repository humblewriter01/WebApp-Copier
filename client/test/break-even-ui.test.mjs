import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const here = path.dirname(fileURLToPath(import.meta.url));
const outfile = path.join(here, '.tmp', 'components.mjs');

// The component is written in JSX, so it is transpiled once per test run into a
// throwaway bundle. React stays external so the bundle shares this process' copy.
await build({
  entryPoints: [path.join(here, '..', 'src', 'components', 'AdvancedSettings.jsx')],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'node',
  external: ['react', 'react-dom'],
  define: { 'process.env.NODE_ENV': '"development"' },
  logLevel: 'silent',
});
assert.ok(existsSync(outfile), 'the component bundle was produced');

const {
  default: AdvancedSettings,
  EXECUTION_WARNING,
  breakEvenSummary,
  RiskWarningModal,
  needsRiskAcknowledgement,
  RISK_REMINDER,
  RISK_WARNING_COPY,
} = await import(pathToFileURL(outfile).href);

const baseSettings = {
  riskMode: 'fixed', riskPercent: 1, maxOpenPositions: 3, dailyLossLimit: 5, autoTradingEnabled: true,
  lotSizeMode: 'fixed', fixedLotSize: 0.01, maxDailyTrades: 10, executionAccountId: 'account-1',
  breakEvenEnabled: true, breakEvenTriggerPoints: 35, breakEvenOffsetPoints: 5,
  trailingStopEnabled: true, trailingStopDistancePoints: 25,
};
const accounts = [{ metaApiAccountId: 'account-1', name: 'Demo MT5', platform: 'mt5', server: 'Broker-Demo', state: 'DEPLOYED' }];

function render(props = {}) {
  const settings = { ...baseSettings, ...(props.settings || {}) };
  return renderToStaticMarkup(
    React.createElement(AdvancedSettings, {
      settings,
      accounts,
      trades: [],
      runtimeAvailable: true,
      onChange() {},
      onSubmit(event) { event.preventDefault(); },
      onToggle() {},
      ...props,
    }),
  );
}

test('the break-even section documents the rule that only narrows risk', () => {
  const markup = render();
  assert.match(markup, /Break Even/);
  assert.match(markup, /Trigger distance \(points\)/);
  assert.match(markup, /Offset beyond entry \(points\)/);
  assert.match(markup, /never widened/i);
  assert.match(markup, /positions Signal Desk opened/, 'the scope is stated before the toggle, not after it');
  assert.match(markup, /Turning Auto-Trading off also stops these moves/i, 'the user is told that OFF means no broker writes at all');
});

test('the inputs carry the saved values so a price is never silently reset', () => {
  const markup = render();
  assert.match(markup, /id="break-even-trigger"[^>]*value="35"/);
  assert.match(markup, /id="break-even-offset"[^>]*value="5"/);
});

test('the break-even switch follows the runtime and the saved preference', () => {
  assert.match(render(), /id="break-even-enabled"[^>]*checked/);
  const off = render({ settings: { breakEvenEnabled: false } });
  assert.equal(/id="break-even-enabled"[^>]*checked/.test(off), false);
  const noRuntime = render({ runtimeAvailable: false });
  assert.match(noRuntime, /id="break-even-enabled"[^>]*disabled/, 'the switch cannot be turned on without a runtime');
  assert.match(noRuntime, /unavailable while automatic execution is unavailable/i);
});

test('break-even outcomes are labelled per trade in the activity list', () => {
  const trades = [
    { id: 't1', side: 'buy', symbol: 'EURUSD', quantity: 0.05, status: 'executed', breakEvenStatus: 'moved', breakEvenStopLoss: '1.1005' },
    { id: 't2', side: 'sell', symbol: 'GBPUSD', quantity: 0.02, status: 'executed', breakEvenStatus: 'failed', breakEvenError: 'Trade is disabled' },
    { id: 't3', side: 'buy', symbol: 'USDJPY', quantity: 0.01, status: 'executed' },
  ];
  const markup = render({ trades });
  assert.match(markup, /Stop moved to break even \(1\.1005\)/);
  assert.match(markup, /Broker refused the move/);
  assert.match(markup, /Trade is disabled/);
  assert.match(markup, /execution-breakeven-moved/);
  assert.match(markup, /execution-breakeven-failed/);
  assert.equal(markup.includes('execution-breakeven-undefined'), false, 'a trade without a break-even result renders no badge');
});

test('the live-trading warning keeps the exact required wording, as a decision rather than decoration', () => {
  const required = 'Warning: Enabling Auto-Trading will execute live trades on your connected broker account. You are fully responsible for any financial losses.';
  assert.equal(RISK_WARNING_COPY.body, required, 'the sentence the workspace has to agree to, word for word');
  assert.equal(EXECUTION_WARNING, required);
  assert.equal(RISK_WARNING_COPY.confirm, 'I Understand');
  assert.equal(RISK_WARNING_COPY.cancel, 'Cancel');

  const markup = renderToStaticMarkup(React.createElement(RiskWarningModal, { open: true, onCancel() {}, onConfirm() {} }));
  assert.ok(markup.includes(required));
  assert.match(markup, /role="alertdialog"/);
  assert.match(markup, /aria-modal="true"/);
  assert.match(markup, /I Understand<\/button>/);
  assert.match(markup, /Cancel<\/button>/);
  // A demo-account caution is still worth saying, but as a point to read, not as a second warning.
  assert.match(markup, /demo account/);
  assert.equal(renderToStaticMarkup(React.createElement(RiskWarningModal, { open: false })), '', 'a closed acknowledgement renders nothing at all');
});

test('the panel no longer shouts, and keeps one quiet line under the switch instead', () => {
  const markup = render({ settings: { breakEvenEnabled: false, trailingStopEnabled: false, hasAcceptedRiskWarning: true } });
  assert.equal(markup.includes('execution-warning'), false, 'the giant red box is gone from a panel whose user has already agreed');
  assert.equal(markup.includes(RISK_WARNING_COPY.body), false, 'the full warning is asked for, not printed on every visit');
  assert.ok(markup.includes(RISK_REMINDER), 'Auto-Trading executes live orders. Trade at your own risk.');
  assert.match(markup, /<details class="risk-reminder-details">/);
  assert.match(markup, /cannot be recalled/i);
  assert.match(markup, /Break-even and trailing-stop moves are off/, 'what is not protecting the trade is said as plainly as what is');
});

test('the warning is asked for the first time only, and cancelling is never an error', () => {
  assert.equal(needsRiskAcknowledgement({ autoTradingEnabled: false, hasAcceptedRiskWarning: false }), true, 'the switch is going up for the first time');
  assert.equal(needsRiskAcknowledgement({ autoTradingEnabled: false }), true, 'a missing answer is not an agreement');
  assert.equal(needsRiskAcknowledgement(undefined), true);
  assert.equal(needsRiskAcknowledgement({ autoTradingEnabled: false, hasAcceptedRiskWarning: true }), false, 'once agreed it is never asked again, including after switching back on');
  assert.equal(needsRiskAcknowledgement({ autoTradingEnabled: true, hasAcceptedRiskWarning: false }), false, 'an already-live workspace is not interrupted by its own panel');

  const unaccepted = render({ settings: { hasAcceptedRiskWarning: false } });
  assert.match(unaccepted, /have not confirmed the live-trading warning yet/, 'a workspace that has never agreed is told so, in one line, without being blocked from reading the panel');
  const accepted = render({ settings: { hasAcceptedRiskWarning: true } });
  assert.match(accepted, /confirmed the live-trading warning for this workspace, so it is not asked for again/);
  assert.equal(accepted.includes('have not confirmed'), false);
});

/* ------------------------------- the trailing stop ------------------------------- */
/* A trail is the one setting here that writes to the broker over and over, so the copy has to
 * carry the same three promises the engine enforces: only tighten, only on a fresh quote, and
 * leave an unconfirmed answer alone instead of sending it again. */

test('the trailing stop section states what it does and what it never does', () => {
  const markup = render();
  // The heading level moved when the panel was grouped; what matters is that the section is a heading
  // inside Trade Management and not a bare paragraph.
  assert.match(markup, /<h[34]>Trailing Stop<\/h[34]>/);
  assert.ok(markup.indexOf('<h3>Trade Management</h3>') < markup.indexOf('Trailing Stop'), 'the trail sits under Trade Management');
  assert.match(markup, /Trailing distance \(points\)/);
  assert.match(markup, /Enable Trailing Stop ON/);
  assert.match(markup, /never slips back/, 'the one-way ratchet is explained before it is switched on');
  assert.match(markup, /only ever moves in the direction that reduces risk/i);
  assert.match(markup, /fresh synchronized quote/i);
  assert.match(markup, /the more protective stop wins/, 'the interaction with break even is stated, not left to be discovered');
  assert.match(markup, /Turning Auto-Trading off stops these moves too/i, 'OFF has to mean no broker writes for the trail as well');
  assert.match(markup, /reconcile it/i, 'an unconfirmed move waits for a human, it is not resent');
});

test('the trailing distance shows the saved value and never a blank or a silent zero', () => {
  assert.match(render(), /id="trailing-distance"[^>]*value="25"/);
  assert.match(render(), /id="trailing-distance"[^>]*min="1"[^>]*max="100000"/);
  assert.match(render({ settings: { trailingStopDistancePoints: undefined } }), /id="trailing-distance"[^>]*value="10"/, 'a workspace that never touched it still sees the default it would get');
});

test('the trailing switch follows the runtime and the saved preference', () => {
  assert.match(render(), /id="trailing-enabled"[^>]*checked/);
  assert.equal(/id="trailing-enabled"[^>]*checked/.test(render({ settings: { trailingStopEnabled: false } })), false);
  const noRuntime = render({ runtimeAvailable: false });
  assert.match(noRuntime, /id="trailing-enabled"[^>]*disabled/, 'the switch cannot be turned on without a runtime, same as break even');
  assert.match(noRuntime, /Trailing stop moves are unavailable while automatic execution is unavailable/i);
});

test('a trailed stop is labelled as a trail, not as break even', () => {
  const trade = { id: 't1', side: 'buy', symbol: 'EURUSD', quantity: 0.05, status: 'executed', breakEvenStatus: 'moved', breakEvenStopLoss: '1.1020' };
  assert.equal(breakEvenSummary(trade), 'Stop moved to break even (1.1020)', 'no trailing distance recorded means break even did it');
  assert.equal(breakEvenSummary({ ...trade, breakEvenTrailingDistancePoints: '30', breakEvenMoveCount: 1 }), 'Stop trailed (1.1020)');
  assert.equal(breakEvenSummary({ ...trade, breakEvenTrailingDistancePoints: '30', breakEvenMoveCount: 4 }), 'Stop trailed (1.1020) · 4 moves, 30 points behind');
  assert.equal(breakEvenSummary({ ...trade, breakEvenStatus: 'deferred', breakEvenTrailingDistancePoints: '30' }), 'Waiting for room to move', 'only a completed move counts as a ratchet');

  const markup = render({ trades: [{ ...trade, breakEvenTrailingDistancePoints: '30', breakEvenMoveCount: 2 }] });
  assert.match(markup, /Stop trailed \(1\.1020\) · 2 moves, 30 points behind/);
});
