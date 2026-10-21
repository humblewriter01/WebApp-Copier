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
  entryPoints: [path.join(here, '..', 'src', 'components', 'ExecutionSettings.jsx')],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'node',
  external: ['react'],
  define: { 'process.env.NODE_ENV': '"development"' },
  logLevel: 'silent',
});
assert.ok(existsSync(outfile), 'the component bundle was produced');

const { default: ExecutionSettings, EXECUTION_WARNING } = await import(pathToFileURL(outfile).href);

const baseSettings = {
  riskMode: 'fixed', riskPercent: 1, maxOpenPositions: 3, dailyLossLimit: 5, autoTradingEnabled: true,
  lotSizeMode: 'fixed', fixedLotSize: 0.01, maxDailyTrades: 10, executionAccountId: 'account-1',
  breakEvenEnabled: true, breakEvenTriggerPoints: 35, breakEvenOffsetPoints: 5,
};
const accounts = [{ metaApiAccountId: 'account-1', name: 'Demo MT5', platform: 'mt5', server: 'Broker-Demo', state: 'DEPLOYED' }];

function render(props = {}) {
  const settings = { ...baseSettings, ...(props.settings || {}) };
  return renderToStaticMarkup(
    React.createElement(ExecutionSettings, {
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

test('the live-trading warning keeps the exact required wording', () => {
  assert.equal(
    EXECUTION_WARNING,
    'Warning: Enabling Auto-Trading will execute live trades on your connected broker account. Ensure you are using a demo account for testing. You are fully responsible for any financial losses.',
  );
  assert.ok(render().includes(EXECUTION_WARNING));
});
