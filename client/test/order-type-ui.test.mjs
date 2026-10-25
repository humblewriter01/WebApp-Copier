/**
 * The order type, the drift guard and the expiry - as the workspace sees and sets them.
 *
 * Two of the three are new decisions this product makes on the user's behalf, which is exactly why they are
 * rendered the way they are: a limit order placed because a channel published a price and nothing else has to
 * *say* that it was inferred, and an expiry the user chose has to be readable on the order that carries it.
 * A panel that renders the wrong number here is a settings page that lies, so the assertions read the actual
 * markup - the value in the input, the option marked selected, the sentence under the trade - rather than
 * trusting that a prop was passed through.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { signalBadges } from '../src/lib/signal-outcome.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(here, '..', 'src');
const serverRoot = path.join(here, '..', '..', 'server');
const outfile = path.join(here, '.tmp', 'order-type-settings.mjs');

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

const {
  default: AdvancedSettings, LIMIT_ORDER_EXPIRY_UNITS, DEFAULT_LIMIT_ORDER_EXPIRY, restingOrderSummary,
} = await import(pathToFileURL(outfile).href);

const baseSettings = {
  autoTradingEnabled: true, hasAcceptedRiskWarning: true, riskMode: 'fixed', riskPercent: 1, maxOpenPositions: 3,
  dailyLossLimit: 5, lotSizeMode: 'fixed', fixedLotSize: 0.1, maxDailyTrades: 10, executionAccountId: 'account-1',
  breakEvenEnabled: false, breakEvenTriggerPoints: 20, breakEvenOffsetPoints: 0,
  trailingStopEnabled: false, trailingStopDistancePoints: 10, multipleTargetHandling: 'first_target',
  limitOrderExpiryValue: 30, limitOrderExpiryUnit: 'minutes', maxSlippagePoints: null,
};
const accounts = [{ metaApiAccountId: 'account-1', name: 'Demo MT5', platform: 'mt5', server: 'Broker-Demo', state: 'DEPLOYED' }];
const render = (over = {}, trades = []) => renderToStaticMarkup(
  React.createElement(AdvancedSettings, { settings: { ...baseSettings, ...over }, accounts, trades, runtimeAvailable: true, onChange: () => {}, onSubmit: () => {} }),
);

/* ------------------------------------------------------------------ the two new settings ------------------------------------------------------------------ */

test('the expiry units the panel offers are the ones the engine can read', () => {
  const serverSource = readFileSync(path.join(serverRoot, 'services', 'order-routing.js'), 'utf8');
  const declared = /export const EXPIRY_UNITS = Object.freeze\(\[([^\]]+)\]\)/.exec(serverSource);
  assert.ok(declared, 'the server still declares its units as a frozen list this test can read');
  const serverUnits = declared[1].split(',').map((entry) => entry.trim().replace(/'/g, ''));
  assert.deepEqual(LIMIT_ORDER_EXPIRY_UNITS.map((unit) => unit.value), serverUnits, 'a unit the panel can offer and the engine cannot read would be a setting that silently does nothing');
  assert.deepEqual(LIMIT_ORDER_EXPIRY_UNITS.map((unit) => unit.label), ['Minutes', 'Hours', 'Days']);
});

test('the expiry is shown as the workspace set it, and as the documented default when it has not', () => {
  const markup = render();
  assert.match(markup, /id="limit-order-expiry"[^>]*value="30"/, 'the number arrives in the input, not beside it');
  assert.match(markup, /<option value="minutes" selected="">/);

  const saved = render({ limitOrderExpiryValue: 4, limitOrderExpiryUnit: 'hours', maxSlippagePoints: 250 });
  assert.match(saved, /id="limit-order-expiry"[^>]*value="4"/);
  assert.match(saved, /<option value="hours" selected="">/);
  assert.match(saved, /id="max-slippage-points"[^>]*value="250"/);

  // A workspace that has never saved since these fields existed shows the defaults, not an empty box that
  // would imply "no expiry" - which is the one reading that would leave an order on a broker forever.
  const untouched = render({ limitOrderExpiryValue: undefined, limitOrderExpiryUnit: undefined, maxSlippagePoints: undefined });
  assert.match(untouched, /id="limit-order-expiry"[^>]*value="30"/);
  assert.match(untouched, /<option value="minutes" selected="">/);
  assert.match(untouched, /id="max-slippage-points"[^>]*value=""/, 'the drift guard genuinely is blank when it is unset, and says what blank means');
  assert.equal(DEFAULT_LIMIT_ORDER_EXPIRY.unit, 'minutes');
});

test('both settings say what they refuse as well as what they allow', () => {
  const markup = render();
  assert.match(markup, /A fill better than the published price is always taken/, 'the drift guard is one-directional, and the sentence that matters most is the one people assume');
  assert.match(markup, /blank or 0 means never/);
  assert.match(markup, /Between 1 minute and 30 days/);
  assert.match(markup, /scalping ignores this number: its orders live for two minutes/);
  assert.match(markup, /A limit waiting at the edge of an entry zone is covered by this too/, 'a zone order really does rest now, so the expiry has to mention it or the sentence under the setting is a half-truth');
  assert.match(markup, /A market order never rests/);
  // Rendered text carries the typographic apostrophe React leaves alone, not an entity - so the assertion
  // matches the sentence as a reader sees it.
  assert.match(markup, /sent to the platform as the order\u2019s own expiration/);
});

/* ------------------------------------------------------------------ the resting order in the activity list ------------------------------------------------------------------ */

const AT = Date.parse('2026-10-25T12:00:00.000Z');
const clock = () => AT;

test('a pending order is described by its level and how long it has left', () => {
  const pending = {
    status: 'pending', orderType: 'limit', entryPrice: 4011, createdAt: '2026-10-25T11:30:00.000Z',
    expiryTimestamp: new Date(AT + 24 * 60_000).toISOString(),
  };
  assert.equal(restingOrderSummary(pending, clock), 'Limit order at 4011 is on your broker account, cancelled unfilled in 24 min.');
  assert.match(restingOrderSummary({ ...pending, orderType: 'stop' }, clock), /^Stop order at 4011/);
  assert.match(restingOrderSummary({ ...pending, expiryTimestamp: null }, clock), /is on your broker account\.$/);
  assert.equal(
    restingOrderSummary({ ...pending, expiryTimestamp: new Date(AT - 1000).toISOString() }, clock),
    'Limit order at 4011 passed its expiry; Signal Desk is taking it off your broker account.',
    'past the deadline and before the sweep, the row says which of the two it is in',
  );
  assert.equal(restingOrderSummary({ ...pending, entryPrice: null }, clock), 'Limit order is on your broker account, cancelled unfilled in 24 min.');
  assert.equal(restingOrderSummary({ status: 'executed', orderType: 'limit' }, clock), '', 'a trade that filled has nothing waiting on it');
});

test('the activity list shows the resting line, and marks the row as waiting rather than unknown', () => {
  const markup = render({}, [{
    id: 'trade-1', side: 'buy', symbol: 'XAUUSD', quantity: 0.01, status: 'pending', orderType: 'limit', entryPrice: 4011,
    createdAt: '2026-10-25T11:30:00.000Z',
    /* The deadline is read against the wall clock, because `restingOrderSummary` is called by the component
       with no clock of its own. A pinned timestamp here aged: on 2026-10-25 afternoon this row was already
       past 12:24 and the line correctly became "passed its expiry", failing a test about a sentence that had
       not changed. Relative to `now`, the row is always a resting order with time left, whatever day runs. */
    expiryTimestamp: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
  }]);
  assert.match(markup, /class="badge execution-status-pending">on the book</);
  assert.match(markup, /execution-resting-summary[^<]*<\/p>/, 'the sentence is rendered, not only computed');
  assert.match(markup, /Limit order at 4011 is on your broker account/);
});

/* ------------------------------------------------------------------ the badges on the signal row ------------------------------------------------------------------ */

const telegram = (over = {}) => ({ source: 'telegram', symbol: 'XAUUSD', side: 'buy', entryPrice: 4011, stopLoss: 4005, takeProfit: 4030, ...over });
const keys = (signal) => signalBadges(signal).map((badge) => badge.key);
const badgeFor = (signal, key) => signalBadges(signal).find((badge) => badge.key === key);

test('a resting order is badged, and the badge admits who chose it', () => {
  const asked = telegram({ orderType: 'limit', orderTypeStated: true });
  assert.deepEqual(keys(asked), ['order-type'], 'a limit that names its level needs no other explanation on the row');
  assert.equal(badgeFor(asked, 'order-type').label, 'Limit Order');
  assert.equal(badgeFor(asked, 'order-type').tone, 'busy', 'the channel asked for this, so it is a fact and not a warning');
  assert.match(badgeFor(asked, 'order-type').title, /The channel asked for this trade to rest at 4011/);

  const implied = telegram({ orderType: 'limit', orderTypeStated: false });
  assert.equal(badgeFor(implied, 'order-type').tone, 'warn', 'this one is Signal Desk deciding, and it looks different because it is');
  assert.match(badgeFor(implied, 'order-type').title, /Nothing in this message said LIMIT or STOP/);
  assert.match(badgeFor(implied, 'order-type').title, /Write NOW or CMP in the channel if you want it taken immediately/, 'and the row says how to overrule it');

  assert.equal(badgeFor(telegram({ orderType: 'stop', orderTypeStated: true }), 'order-type').label, 'Stop Order');
});

test('a market order is only badged where its missing entry would otherwise read as a gap', () => {
  // The rule this product has always had, kept exactly: no entry price + a stated level elsewhere.
  assert.deepEqual(keys(telegram({ orderType: 'market', entryPrice: null, takeProfit: null })), ['market', 'missing-target']);
  assert.match(badgeFor(telegram({ orderType: 'market', entryPrice: null, takeProfit: null }), 'market').title, /did not name an entry price/);
  // A market order that did publish a price needs no pill: nearly every signal is one, and a badge on it
  // would teach nobody to read it.
  assert.deepEqual(keys(telegram({ orderType: 'market', orderTypeStated: true })), []);
  // And a resting order is never also "market".
  assert.equal(keys(telegram({ orderType: 'limit', entryPrice: null, takeProfit: null })).includes('market'), false);
});

test('a scalp is marked, because two minutes is not the number in the settings', () => {
  const scalp = telegram({ orderType: 'limit', orderTypeStated: true, isScalping: true });
  assert.ok(keys(scalp).includes('scalping'));
  assert.match(badgeFor(scalp, 'scalping').title, /two minutes instead of your Limit Order Expiry setting/);
  assert.match(badgeFor(scalp, 'scalping').title, /if the market is already at the level it is taken at once/);
  assert.equal(keys(telegram({ orderType: 'limit' })).includes('scalping'), false);
});

test('a manual or unparseable row gains no order-type pill', () => {
  assert.equal(keys({ source: 'manual', symbol: 'XAUUSD', side: 'buy', entryPrice: 4011 }).includes('order-type'), false, 'the pill is a statement about a signal the copier will trade');
  assert.equal(keys({ source: 'telegram', entryPrice: 4011, orderType: 'nonsense' }).includes('order-type'), false, 'and an order type the server does not speak is not badged as one the user should read');
});
