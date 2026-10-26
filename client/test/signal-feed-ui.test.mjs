/**
 * The live feed and the workspace-readiness banner - the two halves of "is anything happening right now".
 *
 * Both exist because of the same report: a signal was captured seconds earlier and the page still showed a
 * twenty-second-old list, while the banner said Auto-Trading was off when the switch had been on for an hour
 * (and, when it was on with no trading account behind it, said nothing that was actionable).
 *
 * The feed is tested with a stand-in socket rather than a real one, because what matters is the contract the
 * two ends of the wire agreed on: the event name the server emits, the token it authenticates with, and what
 * the client does with a row it is handed. The merge is tested directly, because a pushed row and a polled page
 * must end up looking identical - and `mergeSignalRows` is the only thing between those two shapes.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  connectSignalFeed,
  createReconciler,
  mergeSignalRows,
  signalRowTime,
  SIGNAL_ROW_EVENT,
  FALLBACK_POLL_INTERVAL_MS,
  LIVE_SWEEP_INTERVAL_MS,
  RECONCILE_DELAY_MS,
} from '../src/lib/signal-feed.js';
import { autoTradingBannerView } from '../src/lib/platform-view.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (...parts) => readFileSync(path.join(here, ...parts), 'utf8');
const appSource = read('..', 'src', 'App.jsx');

/* The prompt under the switch is asserted on rendered markup, because a settings page that shows "ON" beside
   an account-less workspace is the exact confusion this change exists to remove. */
const settingsOutfile = path.join(here, '.tmp', 'signal-feed-settings.mjs');
await build({
  entryPoints: [path.join(here, '..', 'src', 'components', 'AdvancedSettings.jsx')],
  outfile: settingsOutfile,
  bundle: true,
  format: 'esm',
  platform: 'node',
  external: ['react', 'react-dom'],
  define: { 'process.env.NODE_ENV': '"development"' },
  logLevel: 'silent',
});
assert.ok(existsSync(settingsOutfile), 'the settings component was built');
const { default: AdvancedSettings } = await import(pathToFileURL(settingsOutfile).href);
const serverSource = read('..', '..', 'server', 'index.js');

const row = (id, createdAt, extra = {}) => ({ id, createdAt, source: 'telegram', status: 'received', ...extra });

/* ------------------------------------------------------------------ the merge ------------------------------------------------------------------ */

test('a pushed row lands where its own timestamp puts it, not where the socket happened to arrive', () => {
  const current = [row(3, '2026-10-25T12:00:00.000Z'), row(2, '2026-10-25T11:00:00.000Z'), row(1, '2026-10-25T10:00:00.000Z')];

  const live = mergeSignalRows(current, row(4, '2026-10-25T13:00:00.000Z', { symbol: 'XAUUSD' }));
  assert.deepEqual(live.map((entry) => entry.id), [4, 3, 2, 1], 'a capture that just happened is the top row');

  /* A message Telegram delivers late - the ones a catch-up replays after a sleep - is *older* than what is on
     screen, and putting it first would tell the reader it is the setup to act on now. */
  const late = mergeSignalRows(current, row(0, '2026-10-25T10:30:00.000Z'));
  assert.deepEqual(late.map((entry) => entry.id), [3, 2, 0, 1], 'it is filed where the channel wrote it');

  // A replacement keeps its place, so a row whose status moved does not jump around the list.
  const updated = mergeSignalRows(current, row(2, '2026-10-25T11:00:00.000Z', { status: 'executed' }));
  assert.deepEqual(updated.map((entry) => entry.id), [3, 2, 1]);
  assert.equal(updated[1].status, 'executed', 'with the new fields, not the old ones');
  assert.equal(updated.length, 3, 'and no duplicate row for the same signal');
});

test('a pushed row never grows the list the server bounded', () => {
  const current = Array.from({ length: 50 }, (unused, index) => row(50 - index, `2026-10-25T12:${String(50 - index).padStart(2, '0')}:00.000Z`));
  const merged = mergeSignalRows(current, row(99, '2026-10-25T14:00:00.000Z'), { limit: 50 });
  assert.equal(merged.length, 50, 'the page stays the size the request asked for');
  assert.equal(merged[0].id, 99);
  assert.equal(merged.some((entry) => entry.id === 1), false, 'the oldest row falls off the bottom');
  // With no explicit cap, the list is held at the length it already had.
  const small = mergeSignalRows([row(2, '2026-10-25T12:00:00.000Z')], row(3, '2026-10-25T13:00:00.000Z'));
  assert.equal(small.length, 2);
  const empty = mergeSignalRows([], row(1, '2026-10-25T13:00:00.000Z'));
  assert.deepEqual(empty.map((entry) => entry.id), [1], 'and an empty page still shows the signal that just came in');
});

test('a payload that is not a row leaves the page exactly as it was', () => {
  const current = [row(1, '2026-10-25T10:00:00.000Z')];
  for (const junk of [null, undefined, {}, { symbol: 'XAUUSD' }, 'x', 7]) {
    assert.equal(mergeSignalRows(current, junk), current, `${JSON.stringify(junk)} is not merged into anything`);
  }
  assert.deepEqual(mergeSignalRows(undefined, row(2)).map((entry) => entry.id), [2], 'an absent list is an empty page, not a reason to drop the signal');
  assert.deepEqual(mergeSignalRows(undefined, undefined), [], 'and nothing at all stays nothing');
  assert.deepEqual(mergeSignalRows([null, undefined, row(9, '2026-10-25T09:00:00.000Z')], row(8, '2026-10-25T10:00:00.000Z')).map((entry) => entry.id), [8, 9], 'a hole in the list is dropped rather than compared against');
});

test('a row with no readable timestamp is treated as the oldest thing on screen', () => {
  assert.equal(signalRowTime(row(1, 'not a date')), 0);
  assert.equal(signalRowTime(undefined), 0);
  const current = [row(2, '2026-10-25T11:00:00.000Z')];
  assert.deepEqual(mergeSignalRows(current, row(1, null)).map((entry) => entry.id), [2, 1], 'it goes at the bottom, not the top');
});

/* ------------------------------------------------------------------ the connection ------------------------------------------------------------------ */

/** A socket the test can drive: it records the handlers it was given and the options it was opened with. */
function fakeSocket() {
  const handlers = {};
  const opened = [];
  const socket = {
    handlers,
    opened,
    closed: false,
    on: (event, handler) => { handlers[event] = handler; },
    emit: () => {},
    close: () => { socket.closed = true; },
  };
  const create = (url, options) => { opened.push({ url, options }); return socket; };
  return { socket, create };
}

function feedFor({ token = 'jwt-abc', ...rest } = {}) {
  const fake = fakeSocket();
  const signals = [];
  const statuses = [];
  const feed = connectSignalFeed({
    url: 'https://api.example.test',
    token,
    importSocket: async () => ({ io: fake.create }),
    onSignal: (incoming) => signals.push(incoming),
    onStatus: (state) => statuses.push(state),
    ...rest,
  });
  return { ...fake, feed, signals, statuses };
}

test('the feed authenticates with the workspace token and listens for the event the server emits', async () => {
  const harness = feedFor();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(harness.socket.opened.map((entry) => entry.url), ['https://api.example.test'], 'the socket is opened against the API origin, not the page origin');
  const options = harness.socket.opened[0].options;
  assert.equal(options.auth.token, 'jwt-abc', 'and the JWT the server verifies on handshake is the one from storage');
  assert.deepEqual(options.transports, ['websocket'], 'websocket only: a polling handshake can be routed to a different worker than its upgrade');
  // The name has to match what `server/index.js` emits - a typo on either side is a silently dead feed.
  assert.ok(harness.socket.handlers[SIGNAL_ROW_EVENT], 'the capture event is subscribed');
  assert.match(serverSource, new RegExp(`emit\\('${SIGNAL_ROW_EVENT}'`), 'and that name is still what the server emits');
});

test('a captured signal reaches the callback, and a broken callback does not break the feed', async () => {
  const seen = [];
  const harness = feedFor({ onSignal: (incoming) => { seen.push(incoming); throw new Error('a state update exploded'); } });
  await new Promise((resolve) => setImmediate(resolve));
  harness.socket.handlers[SIGNAL_ROW_EVENT](row(5, '2026-10-25T12:00:00.000Z'));
  harness.socket.handlers[SIGNAL_ROW_EVENT](row(6, '2026-10-25T12:01:00.000Z'));
  assert.deepEqual(seen.map((entry) => entry.id), [5, 6], 'the next signal is still delivered after one throws');
  harness.socket.handlers[SIGNAL_ROW_EVENT](null);
  harness.socket.handlers[SIGNAL_ROW_EVENT]('nonsense');
  assert.equal(seen.length, 2, 'while a payload that is not a row is never passed on');
});

test('the feed reports its own state, because the poll interval depends on it', async () => {
  const harness = feedFor();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.feed.isOpen(), false, 'not open before the handshake');
  harness.socket.handlers.connect();
  assert.equal(harness.feed.isOpen(), true);
  assert.deepEqual(harness.statuses, ['open']);
  harness.socket.handlers.disconnect();
  assert.equal(harness.feed.isOpen(), false);
  assert.deepEqual(harness.statuses, ['open', 'closed']);
  // A failed handshake is a slower page, not an error the user has to be told about.
  harness.socket.handlers.connect_error(new Error('websocket failure'));
  assert.deepEqual(harness.statuses, ['open', 'closed', 'error']);
});

test('a feed that cannot be imported leaves the app working, silently', async () => {
  const statuses = [];
  const warnings = [];
  const feed = connectSignalFeed({
    url: '',
    token: 't',
    importSocket: async () => { throw new Error('failed to fetch chunk'); },
    onStatus: (state) => statuses.push(state),
    logger: { warn: (message, extra) => warnings.push({ message, extra }) },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(statuses, ['error']);
  assert.equal(warnings.length, 1, 'the cause is logged once');
  assert.match(warnings[0].message, /keep polling/);
  assert.equal(feed.isOpen(), false);
  feed.close();
});

test('closing the feed detaches it, and closing twice is not an error', async () => {
  const harness = feedFor();
  await new Promise((resolve) => setImmediate(resolve));
  harness.socket.handlers.connect();
  harness.feed.close();
  assert.equal(harness.socket.closed, true);
  assert.equal(harness.feed.isOpen(), false);
  harness.feed.close();
  assert.equal(harness.feed.isOpen(), false);
  // A row that arrives after the component unmounted must not be applied to state that no longer exists.
  let applied = 0;
  const late = feedFor({ onSignal: () => { applied += 1; } });
  await new Promise((resolve) => setImmediate(resolve));
  late.feed.close();
  late.socket.handlers[SIGNAL_ROW_EVENT]?.(row(7, '2026-10-25T12:00:00.000Z'));
  assert.equal(applied, 0);
});

/* ------------------------------------------------------------------ the reconciler ------------------------------------------------------------------ */

test('one refresh reconciles a burst of captures, not one per message', async () => {
  let runs = 0;
  const timers = [];
  const reconciler = createReconciler(() => { runs += 1; }, {
    delayMs: RECONCILE_DELAY_MS,
    setTimeoutImpl: (fn) => { const entry = { fn, cleared: false }; timers.push(entry); return entry; },
    clearTimeoutImpl: (entry) => { if (entry) entry.cleared = true; },
  });
  assert.equal(reconciler.schedule(), true, 'the first event arms a refresh');
  assert.equal(reconciler.schedule(), false, 'while a second one in the same burst is folded into it');
  assert.equal(reconciler.schedule(), false);
  assert.equal(runs, 0, 'and nothing has run yet');
  timers[0].fn();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runs, 1, 'one refresh, after the delay');
  assert.equal(reconciler.schedule(), true, 'a later event can arm another');
  reconciler.cancel();
  assert.equal(timers[1].cleared, true, 'and unmounting cancels the pending one');
});

/* ------------------------------------------------------------------ what the shell does with it ------------------------------------------------------------------ */

test('the dashboard shell wires the feed, and keeps the poll as the safety net', () => {
  assert.match(appSource, /connectSignalFeed\(\{[^}]*url: API_URL[^}]*token: authToken/, 'opened against the API origin with this session\'s token');
  assert.match(appSource, /onSignal: applyIncomingSignal/, 'a pushed row is applied to the page');
  assert.match(appSource, /const timer = setInterval\(\(\) => \{ void refreshRef\.current\(\); \}, feedLive \? LIVE_SWEEP_INTERVAL_MS : FALLBACK_POLL_INTERVAL_MS\)/, 'the poll slows down only while the feed is open');
  assert.match(appSource, /return \(\) => \{ feed\.close\(\)/, 'and the socket is closed when the session ends');
  assert.equal(/setInterval\(refresh, 20_000\)/.test(appSource), false, 'the fixed 20-second poll is gone');
  assert.equal(FALLBACK_POLL_INTERVAL_MS, 20_000, 'the fallback is the interval the page used to have, so nothing is worse when the feed fails');
  assert.ok(LIVE_SWEEP_INTERVAL_MS > FALLBACK_POLL_INTERVAL_MS, 'while a live feed only sweeps to catch what events do not carry');
  assert.match(appSource, /document\.addEventListener\('visibilitychange', onVisible\)/, 'coming back to the tab re-reads the workspace immediately');
});

test('a pushed row updates both lists, and schedules one reconcile', () => {
  assert.match(appSource, /setSignals\(\(current\) => mergeSignalRows\(current, incoming, \{ limit: SIGNALS_PAGE_LIMIT \}\)\)/, 'the Signals tab, at the length it was asked for');
  assert.match(appSource, /setDashboard\(\(current\) => \(current \? \{ \.\.\.current, signals: mergeSignalRows\(current\.signals \|\| \[\], incoming\) \} : current\)\)/, 'and the Overview, without inventing a dashboard that was never loaded');
  assert.match(appSource, /reconcilerRef\.current\?\.schedule\(\)/);
  assert.match(appSource, /createReconciler\(\(\) => refreshRef\.current\(\)\)/, 'the reconcile goes through a ref, so a new `refresh` identity cannot reconnect the socket');
  assert.match(appSource, /const refreshRef = useRef\(refresh\);/, 'which is what that ref is for');
});

/* ------------------------------------------------------------------ the readiness banner ------------------------------------------------------------------ */

const DEPLOYED = { metaApiAccountId: 'acct-1', state: 'DEPLOYED' };
const settingsFor = (over = {}) => ({ autoTradingEnabled: true, runtimeEnabled: true, platformPause: null, linkedAccounts: [DEPLOYED], executionAccountId: 'acct-1', ...over });

test('the banner tells an enabled workspace what is actually missing', () => {
  const noAccounts = autoTradingBannerView(settingsFor({ linkedAccounts: [], executionAccountId: '' }));
  assert.equal(noAccounts.state, 'no-account');
  assert.equal(noAccounts.message, 'Auto-Trading is ON, but no trading account is connected. Connect your account or upgrade your plan to execute signals.');
  assert.equal(noAccounts.action.label, 'Open Trading Accounts');
  assert.equal(noAccounts.action.tab, 'metaapi', 'and the button goes to the page that can fix it, not to the one the reader is on');

  const nothingSelected = autoTradingBannerView(settingsFor({ executionAccountId: '' }));
  assert.equal(nothingSelected.state, 'no-account', 'an account that exists but is not selected is the same problem for the reader');

  const deploying = autoTradingBannerView(settingsFor({ linkedAccounts: [{ ...DEPLOYED, state: 'DEPLOYING' }] }));
  assert.equal(deploying.state, 'not-deployed');
  assert.match(deploying.message, /not connected yet \(deploying\)/);

  const ready = autoTradingBannerView(settingsFor());
  assert.equal(ready.state, 'ready');
  assert.match(ready.message, /may place live orders/);
  assert.equal(ready.action, null, 'and a ready workspace is told nothing more');
});

test('the switch, the service and the platform each get their own sentence', () => {
  assert.equal(autoTradingBannerView(settingsFor({ autoTradingEnabled: false })).state, 'off');
  assert.match(autoTradingBannerView(settingsFor({ autoTradingEnabled: false })).message, /Turn Auto-Trading on in Advanced Settings/);
  assert.equal(autoTradingBannerView(settingsFor({ runtimeEnabled: false })).state, 'unavailable');
  assert.equal(autoTradingBannerView(settingsFor({ platformPause: { paused: true, reason: 'Provider outage' } })).state, 'paused');
  assert.match(autoTradingBannerView(settingsFor({ platformPause: { paused: true, reason: 'Provider outage' } })).message, /Reason given: Provider outage/);
  // An unreadable switch is the pause case, not the ready case - the banner never claims more than the read.
  assert.equal(autoTradingBannerView(settingsFor({ platformPause: { paused: true, state: 'unavailable' } })).state, 'paused');
  assert.equal(autoTradingBannerView().state, 'off', 'and no data at all is "off", never "on"');
});

test('the metric line and the banner come from one reading, so they cannot contradict each other', () => {
  // The Overview's "Auto-Trading" metric used to ask its own copy of the same question the banner asked, and
  // the two answers were written separately. They are now one object, so each state has to say both things.
  const cases = [
    ['off', settingsFor({ autoTradingEnabled: false }), 'Off until you enable it'],
    ['unavailable', settingsFor({ runtimeEnabled: false }), 'Unavailable on this service'],
    ['paused', settingsFor({ platformPause: { paused: true } }), 'Paused by Signal Desk'],
    ['no-account', settingsFor({ linkedAccounts: [], executionAccountId: '' }), 'Waiting for a trading account'],
    ['not-deployed', settingsFor({ linkedAccounts: [{ ...DEPLOYED, state: 'STOPPED' }] }), 'Waiting for the account to deploy'],
    ['ready', settingsFor(), 'Eligible signals may place orders'],
  ];
  for (const [state, input, metricNote] of cases) {
    const view = autoTradingBannerView(input);
    assert.equal(view.state, state);
    assert.equal(view.metricNote, metricNote, `${state} explains itself on the metric too`);
    assert.match(view.headline, /Auto-Trading is (on|off)/, 'and the headline never contradicts the switch');
    assert.ok(typeof view.message === 'string' && view.message.length > 0);
  }
});

test('a deployed and a connected account both count as able to trade', () => {
  for (const state of ['DEPLOYED', 'CONNECTED']) {
    assert.equal(autoTradingBannerView(settingsFor({ linkedAccounts: [{ ...DEPLOYED, state }] })).state, 'ready', `${state} is an account the broker will take an order on`);
  }
});

test('the banner is rendered from the helper rather than from a ternary in the shell', () => {
  assert.match(appSource, /autoTradingBanner\.message/, 'the shell shows the sentence the helper chose');
  assert.match(appSource, /data-state=\{autoTradingBanner\.state\}/, 'with the state on the element, for the style and for the next test to read');
  assert.match(appSource, /note=\{autoTradingBanner\.metricNote\}/, 'and the same reading behind the metric');
});

test('the settings page says what the switch is not enough of, in its own words', () => {
  const settings = { autoTradingEnabled: true, hasAcceptedRiskWarning: true, riskMode: 'fixed', riskPercent: 1, maxOpenPositions: 3, dailyLossLimit: 5, lotSizeMode: 'fixed', fixedLotSize: 0.1, maxDailyTrades: 10, executionAccountId: '', breakEvenEnabled: false, breakEvenTriggerPoints: 20, breakEvenOffsetPoints: 0, trailingStopEnabled: false, trailingStopDistancePoints: 10, multipleTargetHandling: 'first_target', limitOrderExpiryValue: 30, limitOrderExpiryUnit: 'minutes', maxSlippagePoints: null };
  const withoutAccount = renderToStaticMarkup(React.createElement(AdvancedSettings, {
    settings, accounts: [], trades: [], runtimeAvailable: true, platformPause: null,
    onChange: () => {}, onSubmit: () => {}, onToggle: () => {}, onOpenTradingAccounts: () => {},
  }));
  assert.match(withoutAccount, /no trading account is connected\. Connect your account or upgrade your plan to execute signals\./, 'the same sentence the Overview shows, next to the switch that was just turned on');
  assert.match(withoutAccount, /Open Trading Accounts/, 'with the way out of it');

  const deployed = renderToStaticMarkup(React.createElement(AdvancedSettings, {
    settings: { ...settings, executionAccountId: 'acct-1' }, accounts: [{ metaApiAccountId: 'acct-1', state: 'DEPLOYED' }], trades: [], runtimeAvailable: true, platformPause: null,
    onChange: () => {}, onSubmit: () => {}, onToggle: () => {}, onOpenTradingAccounts: () => {},
  }));
  assert.equal(/no trading account is connected/.test(deployed), false, 'and it stops saying it once the account is there');
});

