/**
 * How the signal summary line renders take-profit targets across Multiple Target Handling modes.
 *
 * When a channel publishes a multi-target ladder (TP1 / TP2 / TP3), the summary line on both
 * Signal History and Overview must agree with what the workspace's active Multiple Target
 * Handling setting (`first_target`, `final_target`, `scale_out`) actually tells the broker to do:
 *   - `first_target` ("First Target Only") -> `Entry 2650 SL 2645 TP 2655`
 *   - `final_target` ("Final Target Only") -> `Entry 2650 SL 2645 TP 2665`
 *   - `scale_out` ("Split & Scale-Out")    -> `Entry 2650 SL 2645 TP1 2655 | TP2 2660 | TP3 2665`
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { takeProfitSummary } from '../src/lib/signal-outcome.js';
import { DASHBOARD_SIGNAL_COLUMNS } from '../../server/services/dashboard-signals.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (...parts) => readFileSync(path.join(here, ...parts), 'utf8');

const outfile = path.join(here, '.tmp', 'multiple-target-summary-signal-table.mjs');
await build({
  entryPoints: [path.join(here, '..', 'src', 'components', 'SignalTable.jsx')],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'node',
  external: ['react', 'react-dom'],
  define: {
    'process.env.NODE_ENV': '"development"',
    'import.meta.env': JSON.stringify({ PROD: false, VITE_API_URL: 'http://localhost:5000' }),
  },
  logLevel: 'silent',
});
assert.ok(existsSync(outfile), 'SignalTable bundle was built');
const { default: SignalTable } = await import(pathToFileURL(outfile).href);

const multiTargetSignal = {
  id: 'sig-gold-ladder',
  symbol: 'XAUUSD',
  side: 'buy',
  channelTitle: 'Gold VIP',
  message: 'BUY XAUUSD\nEntry: 2650\nSL: 2645\nTP1: 2655\nTP2: 2660\nTP3: 2665',
  entryPrice: 2650,
  stopLoss: 2645,
  takeProfit: 2655,
  takeProfitLevels: [2655, 2660, 2665],
  executionReady: true,
  status: 'executed',
  createdAt: '2026-10-25T12:00:00.000Z',
};

function renderMetaLine(signal, { multipleTargetHandling, compact = false } = {}) {
  const html = renderToStaticMarkup(
    React.createElement(SignalTable, {
      signals: [signal],
      channelCount: 1,
      multipleTargetHandling,
      compact,
      autoTradingEnabled: true,
      linkedAccounts: [{ id: 'acc-1', state: 'DEPLOYED' }],
    }),
  );
  const metaMatch = html.match(/<div class="signal-meta">([\s\S]*?)<\/div>/);
  assert.ok(metaMatch, 'signal card rendered a .signal-meta summary container');
  const spans = [...metaMatch[1].matchAll(/<span[^>]*>([\s\S]*?)<\/span>/g)].map((match) => match[1]);
  return { html, spans, summaryLine: spans.join(' ') };
}

test('takeProfitSummary formats multi-target and single-target signals for every Multiple Target Handling mode', () => {
  assert.equal(takeProfitSummary(multiTargetSignal, 'first_target'), 'TP 2655');
  assert.equal(takeProfitSummary(multiTargetSignal, 'final_target'), 'TP 2665');
  assert.equal(takeProfitSummary(multiTargetSignal, 'scale_out'), 'TP1 2655 | TP2 2660 | TP3 2665');
  assert.equal(takeProfitSummary(multiTargetSignal), 'TP 2655', 'default mode matches First Target Only');

  const singleTarget = { entryPrice: 2650, stopLoss: 2645, takeProfit: 2655, takeProfitLevels: null };
  assert.equal(takeProfitSummary(singleTarget, 'first_target'), 'TP 2655');
  assert.equal(takeProfitSummary(singleTarget, 'final_target'), 'TP 2655');
  assert.equal(takeProfitSummary(singleTarget, 'scale_out'), 'TP 2655');

  const noTarget = { entryPrice: 2650, stopLoss: 2645, takeProfit: null, takeProfitLevels: [] };
  assert.equal(takeProfitSummary(noTarget, 'final_target'), null);
  assert.equal(takeProfitSummary(noTarget, 'scale_out'), null);

  const sparseLadder = { takeProfit: 2655, takeProfitLevels: [2655, null, 0, -10, 2665] };
  assert.equal(takeProfitSummary(sparseLadder, 'final_target'), 'TP 2665');
  assert.equal(takeProfitSummary(sparseLadder, 'scale_out'), 'TP1 2655 | TP2 2665');
});

test('SignalTable renders TP1, Final TP, or the full TP1 | TP2 | TP3 ladder based on multipleTargetHandling', () => {
  const first = renderMetaLine(multiTargetSignal, { multipleTargetHandling: 'first_target' });
  assert.equal(first.summaryLine, 'Entry 2650 SL 2645 TP 2655');
  assert.ok(!first.summaryLine.includes('2665'), 'First Target Only does not display TP3 as the active target');

  const final = renderMetaLine(multiTargetSignal, { multipleTargetHandling: 'final_target' });
  assert.equal(final.summaryLine, 'Entry 2650 SL 2645 TP 2665');
  assert.ok(!final.summaryLine.includes('2655'), 'Final Target Only replaces TP1 with the final target TP3');

  const scaleOut = renderMetaLine(multiTargetSignal, { multipleTargetHandling: 'scale_out' });
  assert.equal(scaleOut.summaryLine, 'Entry 2650 SL 2645 TP1 2655 | TP2 2660 | TP3 2665');
});

test('Overview compact SignalTable and Signals page receive multipleTargetHandling and takeProfitLevels', () => {
  const compactFinal = renderMetaLine(multiTargetSignal, { multipleTargetHandling: 'final_target', compact: true });
  assert.equal(compactFinal.summaryLine, 'Entry 2650 SL 2645 TP 2665');

  const compactScaleOut = renderMetaLine(multiTargetSignal, { multipleTargetHandling: 'scale_out', compact: true });
  assert.equal(compactScaleOut.summaryLine, 'Entry 2650 SL 2645 TP1 2655 | TP2 2660 | TP3 2665');

  const appSource = read('..', 'src', 'App.jsx');
  const signalTableTags = appSource.match(/<SignalTable\b[^>]*>/g) || [];
  assert.equal(signalTableTags.length, 2, 'Overview and Signals page both render SignalTable');
  for (const tag of signalTableTags) {
    assert.match(tag, /multipleTargetHandling=\{settings\.multipleTargetHandling\}/, `SignalTable receives settings.multipleTargetHandling: ${tag}`);
  }

  assert.match(DASHBOARD_SIGNAL_COLUMNS, /take_profit_levels AS "takeProfitLevels"/, 'Overview dashboard signals query includes takeProfitLevels');
  const serverSource = read('..', '..', 'server', 'index.js');
  assert.match(
    serverSource,
    /SELECT risk_mode AS "riskMode"[^;]*multiple_target_handling AS "multipleTargetHandling" FROM settings WHERE user_id=\$1/,
    'GET /api/dashboard includes multipleTargetHandling in its settings snapshot',
  );
});
