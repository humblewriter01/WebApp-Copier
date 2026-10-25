/**
 * The multiple-target setting, and what the panel says about the ladder it trades.
 *
 * These assertions exist because the setting has three answers and only one of them is a broker write per
 * target: a panel that rendered the wrong option as selected, or that quietly fell back to "first target"
 * while showing "Split & Scale-Out", would let a workspace believe pieces of its trades were being taken
 * off when nothing was. So the tests read the selected option, the state the folded bar reports, and the
 * server's own list of modes - the boundary is pinned against the file that decides, not against a copy
 * of it typed here.
 */
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
const outfile = path.join(here, '.tmp', 'scale-out-settings.mjs');

await build({
  entryPoints: [path.join(srcDir, 'components', 'AdvancedSettings.jsx')],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'node',
  external: ['react', 'react-dom'],
  define: { 'process.env.NODE_ENV': '"development"' },
  logLevel: 'silent',
});
assert.ok(existsSync(outfile), 'the component bundle was produced');

const { default: AdvancedSettings, MULTIPLE_TARGET_MODES, SCALE_OUT_PLAN, DEFAULT_TARGET_MODE, scaleOutSummary } = await import(pathToFileURL(outfile).href);

const baseSettings = {
  autoTradingEnabled: true, hasAcceptedRiskWarning: true, riskMode: 'fixed', riskPercent: 1, maxOpenPositions: 3,
  dailyLossLimit: 5, lotSizeMode: 'fixed', fixedLotSize: 0.1, maxDailyTrades: 10, executionAccountId: 'account-1',
  breakEvenEnabled: false, breakEvenTriggerPoints: 20, breakEvenOffsetPoints: 0,
  trailingStopEnabled: false, trailingStopDistancePoints: 10, multipleTargetHandling: 'first_target',
};
const accounts = [{ metaApiAccountId: 'account-1', name: 'Demo MT5', platform: 'mt5', server: 'Broker-Demo', state: 'DEPLOYED' }];

function render(props = {}) {
  const settings = { ...baseSettings, ...(props.settings || {}) };
  delete props.settings;
  return renderToStaticMarkup(React.createElement(AdvancedSettings, {
    settings, accounts, trades: [], runtimeAvailable: true, platformPause: null,
    onChange() {}, onSubmit(event) { event.preventDefault(); }, onToggle() {}, saving: false, ...props,
  }));
}

test('the three modes the engine can read are the three the panel offers, in that order', async () => {
  const server = readFileSync(path.join(here, '..', '..', 'server', 'services', 'scale-out.js'), 'utf8');
  const declared = server.match(/export const TARGET_MODES = \[([^\]]*)\]/)[1].match(/'[^']+'/g).map((value) => value.replaceAll("'", ''));
  assert.deepEqual(MULTIPLE_TARGET_MODES.map((mode) => mode.value), declared, 'a mode the panel offered but the engine could not read would be a setting that does nothing');
  assert.equal(DEFAULT_TARGET_MODE, 'first_target', 'the default is the behaviour every workspace already had');
  const markup = render();
  assert.match(markup, /<option value="first_target" selected="">First Target Only<\/option>/);
  assert.match(markup, /<option value="final_target">Final Target Only<\/option>/);
  assert.match(markup, /<option value="scale_out">Split &amp; Scale-Out<\/option>/);
});

test('a workspace that never chose has no opinion stored, and sees the strict answer', () => {
  const settings = { ...baseSettings };
  delete settings.multipleTargetHandling;
  const markup = render({ settings });
  assert.match(markup, /<option value="first_target" selected="">First Target Only<\/option>/, 'an absent value is the safe default, not a blank select');
  assert.match(markup, /No stop moves · First Target Only/);

  // A value from a future version is not silently traded as something else either.
  const unknown = render({ settings: { multipleTargetHandling: 'moonshot' } });
  assert.match(unknown, /<option value="first_target" selected="">First Target Only<\/option>/);
});

test('choosing scale-out says what will happen, in the section that owns the choice', () => {
  const markup = render({ settings: { multipleTargetHandling: 'scale_out', breakEvenEnabled: true } });
  const tradeManagement = markup.slice(markup.indexOf('Trade Management'), markup.indexOf('Advanced Safety'));
  assert.match(tradeManagement, /Multiple Target Handling/, 'the dropdown sits under Trade Management, not under the safety blocks');
  assert.match(tradeManagement, /<option value="scale_out" selected="">Split &amp; Scale-Out<\/option>/);
  assert.match(tradeManagement, /Stop moves on · Split &amp; Scale-Out/, 'the folded bar states the mode without opening it');
  assert.match(tradeManagement, /Half closes at the first target and its stop moves to break even in the same breath; 30% at the next; the rest rides to the final target\./);
  assert.match(tradeManagement, /too small for the broker’s minimum lot to survive a cut keeps its first target/, 'the one case where the plan is not traded is said, not left to be discovered');
  assert.match(tradeManagement, /only signals this workspace opened are ever swept/, 'the reader is told their own trades are untouched');
  // The paragraph only appears for the mode it describes: the other two hold nothing open to sweep.
  assert.equal(markup.slice(0, markup.indexOf('Trade Management')).includes(SCALE_OUT_PLAN), false);
  assert.equal(render({ settings: { multipleTargetHandling: 'final_target' } }).includes(SCALE_OUT_PLAN), false);
});

test('a scale-out plan needs the runtime, and says so where it is chosen', () => {
  const markup = render({ settings: { multipleTargetHandling: 'scale_out' }, runtimeAvailable: false });
  assert.match(markup, /Scale-out closes are unavailable while automatic execution is unavailable on this service\./);
  assert.match(markup, /execution-scale-out-plan/);
});

test('a trade that has been cut down shows what is left of it', () => {
  const trades = [
    { id: 't1', side: 'buy', symbol: 'XAUUSD', quantity: 0.1, remainingVolume: 0.05, status: 'executed' },
    { id: 't2', side: 'buy', symbol: 'EURUSD', quantity: 0.1, remainingVolume: 0.1, status: 'executed' },
    { id: 't3', side: 'sell', symbol: 'GBPUSD', quantity: 0.1, status: 'executed' },
  ];
  const rows = Object.fromEntries(render({ trades }).split('<article class="execution-trade-row">').slice(1).map((row) => [row.match(/>(BUY|SELL) (\w+)</)[2], row]));
  assert.match(rows.XAUUSD, /0\.1 lots · 0\.05 lots left/, 'a plan that took half its trade off is visible without opening anything');
  assert.equal(rows.EURUSD.includes('lots left'), false, 'a trade nothing has touched is stated once, not twice');
  assert.equal(rows.GBPUSD.includes('lots left'), false, 'and a trade with no plan at all has no remainder line');
  assert.match(rows.GBPUSD, /0\.1 lots ·/, 'the size itself still reads normally beside it');
});

test('a folded bar states itself in one sentence, which is the whole point of folding it', () => {
  const markup = render();
  const subtitles = [...markup.matchAll(/<span class="settings-section-heading"><h3>[^<]+<\/h3><p>([^<]+)<\/p>/g)].map((match) => match[1]);
  assert.equal(subtitles.length, 3, 'three bars, three subtitles');
  for (const subtitle of subtitles) {
    assert.ok(subtitle.length <= 110, `"${subtitle}" is a summary, not a paragraph (${subtitle.length} characters)`);
    assert.equal((subtitle.match(/\./g) || []).length, 1, 'one sentence, then the detail is on expand');
  }
});

test('each rung of the plan says what became of it, including the answer nobody likes', () => {
  const trade = (tpLevels) => ({ id: 't1', symbol: 'XAUUSD', side: 'buy', quantity: 0.1, status: 'executed', tpLevels });
  assert.equal(scaleOutSummary(trade([])), '', 'a trade with no plan says nothing about one');
  assert.equal(scaleOutSummary(trade([{ price: '1.12', percent: '50', status: 'pending' }])), 'Scale-out: 1.12 waiting (50%)');
  const mixed = trade([
    { price: '1.12', percent: '50', status: 'filled' },
    { price: '1.15', percent: '30', status: 'submitting' },
    { price: '1.16', percent: '0', status: 'skipped' },
    { price: '1.18', percent: '0', status: 'unknown' },
  ]);
  assert.equal(scaleOutSummary(mixed), 'Scale-out: 1.12 closed (50%) · 1.15 being closed (30%) · 1.16 not tradable · 1.18 unconfirmed', 'a percent of zero is not a share worth printing, and an unconfirmed close is not hidden behind a friendly word');
  const markup = render({ trades: [mixed] });
  assert.match(markup, /<p class="execution-scale-out-summary">Scale-out: 1\.12 closed/);
});
