import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync } from 'node:fs';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(here, '..', 'src');
const outfile = path.join(here, '.tmp', 'telegram-status.mjs');

await build({
  stdin: {
    contents: [
      "export { TelegramStatusContext, telegramStatusReducer, telegramConnectionView, TelegramStatusPill, WAITING_FOR_MESSAGES_MESSAGE, LISTENER_NOT_ATTACHED_MESSAGE, monitoringLabel, TELEGRAM_STATUS_ENDPOINT } from './TelegramStatus.jsx';",
      "export { default as SignalTable, signalEmptyState } from './SignalTable.jsx';",
      "export { telegramSourceNote } from './MetaApiPanel.jsx';",
    ].join('\n'),
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
assert.ok(existsSync(outfile), 'the component bundle was produced');

const {
  TelegramStatusContext, telegramStatusReducer, telegramConnectionView, TelegramStatusPill,
  WAITING_FOR_MESSAGES_MESSAGE, LISTENER_NOT_ATTACHED_MESSAGE, TELEGRAM_STATUS_ENDPOINT,
  monitoringLabel, SignalTable, signalEmptyState, telegramSourceNote,
} = await import(pathToFileURL(outfile).href);

const UNKNOWN = telegramStatusReducer(undefined, { type: '@@initial' });
const stateFor = (payload, at = 1) => telegramStatusReducer(UNKNOWN, { type: 'resolve', payload, at });
const viewFor = (payload) => telegramConnectionView(stateFor(payload));
const render = (element, view) => renderToStaticMarkup(
  React.createElement(TelegramStatusContext.Provider, { value: { view, refresh: async () => {} } }, element),
);

/* ---------------------------------------------------------------- the state machine */

test('the connection starts unknown, never false', () => {
  assert.equal(UNKNOWN.connected, null, 'a default of false is what made the button flash');
  assert.equal(UNKNOWN.loading, true);
  assert.deepEqual(telegramConnectionView(UNKNOWN), {
    key: 'checking', known: false, showConnectCallToAction: false, label: 'Checking Telegram…', tone: 'pending', detail: null,
    connected: false, configured: null, stale: false, checkedAt: null,
  });
});

test('only a backend answer can set the connection', () => {
  assert.equal(viewFor({ connected: true, configured: true }).key, 'connected');
  assert.equal(viewFor({ connected: false, configured: true }).key, 'disconnected');
  assert.equal(viewFor({ connected: false, configured: false }).key, 'unavailable');
  assert.equal(viewFor({ connected: true, configured: false }).key, 'unavailable', 'a session that cannot be renewed is not a connected source');
});

test('a failed check keeps the last confirmed answer and marks it stale, never invents a disconnection', () => {
  const connected = stateFor({ connected: true, configured: true });
  const afterFailure = telegramStatusReducer(connected, { type: 'reject', message: 'Service Unavailable' });
  assert.equal(afterFailure.connected, true, 'the last confirmed state survives');
  assert.equal(afterFailure.stale, true);
  assert.equal(afterFailure.error, 'Service Unavailable');
  assert.equal(telegramConnectionView(afterFailure).key, 'connected');

  const neverConfirmed = telegramStatusReducer(UNKNOWN, { type: 'reject', message: 'offline' });
  assert.equal(neverConfirmed.connected, null);
  assert.equal(neverConfirmed.loading, true);
  assert.equal(telegramConnectionView(neverConfirmed).key, 'unreachable');
  assert.equal(telegramConnectionView(neverConfirmed).showConnectCallToAction, false, 'unknown is not a reason to ask someone to sign in');
});

test('signing out clears the shared state instead of leaving a stale answer', () => {
  const connected = stateFor({ connected: true, configured: true });
  assert.deepEqual(telegramStatusReducer(connected, { type: 'reset' }), UNKNOWN);
});

test('local flows publish their own outcome without waiting for a refetch', () => {
  const disconnected = telegramStatusReducer(stateFor({ connected: true, configured: true }), { type: 'mark-disconnected', at: 2 });
  assert.deepEqual({ connected: disconnected.connected, stale: disconnected.stale, loading: disconnected.loading }, { connected: false, stale: false, loading: false });
  const applied = telegramStatusReducer(UNKNOWN, { type: 'apply', payload: { connected: true }, at: 3 });
  assert.equal(applied.connected, true);
  assert.equal(applied.checkedAt, 3);
});

test('the status endpoint is fetched in exactly one module', () => {
  assert.equal(TELEGRAM_STATUS_ENDPOINT, '/api/telegram/status');
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.jsx?$/.test(entry.name) && readFileSync(full, 'utf8').includes(TELEGRAM_STATUS_ENDPOINT)) files.push(path.relative(srcDir, full));
    }
  };
  walk(srcDir);
  assert.deepEqual(files, [path.join('components', 'TelegramStatus.jsx')], 'no component may fetch or poll the status on its own');
});

/* ------------------------------------------------------------------ the empty states */

test('an empty signal list says it is waiting when Telegram is connected, and hides the button', () => {
  const empty = signalEmptyState({ view: viewFor({ connected: true, configured: true }), channelCount: 4 });
  assert.equal(empty.title, 'Waiting for signals');
  assert.equal(empty.message, 'Telegram is connected. Waiting for messages from your selected channels...');
  assert.equal(WAITING_FOR_MESSAGES_MESSAGE, empty.message);
  assert.equal(empty.action, null);

  const html = render(React.createElement(SignalTable, { signals: [], channelCount: 4 }), viewFor({ connected: true, configured: true }));
  assert.match(html, /Telegram is connected\. Waiting for messages from your selected channels\.\.\./);
  assert.equal(html.includes('Connect Telegram'), false, 'the CTA must be gone, not merely hidden by CSS');
  assert.equal(html.includes('button'), false, 'no action at all while there is nothing to act on');
});

test('a connected user with no channels is asked to choose sources, not to sign in again', () => {
  const empty = signalEmptyState({ view: viewFor({ connected: true, configured: true }), channelCount: 0 });
  assert.equal(empty.action, 'choose');
  assert.match(empty.message, /Choose the groups and channels to monitor/);
  const html = render(React.createElement(SignalTable, { signals: [], channelCount: 0, onOpenTelegram: () => {} }), viewFor({ connected: true, configured: true }));
  assert.match(html, /Choose channels to monitor/);
  assert.match(html, /Telegram is connected<\/strong>/, 'the heading confirms the state instead of implying they are signed out');
  assert.equal(html.includes('>Connect Telegram<'), false);
});

test('the connect prompt appears only for a confirmed disconnection', () => {
  const unknown = render(React.createElement(SignalTable, { signals: [], channelCount: 0 }), telegramConnectionView(UNKNOWN));
  assert.equal(unknown.includes('Connect Telegram'), false, 'nothing may be rendered while the answer is in flight');
  assert.match(unknown, /Checking your sources|Loading your captured signals/);
  assert.match(unknown, /class="skeleton skeleton-block"/, 'a skeleton, not a spinner-less guess');

  const failed = render(React.createElement(SignalTable, { signals: [] }), telegramConnectionView(telegramStatusReducer(UNKNOWN, { type: 'reject', message: 'down' })));
  assert.equal(failed.includes('Connect Telegram'), false);
  assert.match(failed, /Check again/);

  const off = render(React.createElement(SignalTable, { signals: [], channelCount: 0, onOpenTelegram: () => {} }), viewFor({ connected: false, configured: true }));
  assert.match(off, /<button class="button button-secondary" type="button">Connect Telegram<\/button>/);
  assert.match(off, /No signals yet/);
  // Without a navigation target there is nothing to click, so the copy must not offer it.
  assert.equal(render(React.createElement(SignalTable, { signals: [], channelCount: 0 }), viewFor({ connected: false, configured: true })).includes('<button'), false);
});

test('a workspace where Telegram is not configured promises no sign-in flow', () => {
  const view = viewFor({ connected: false, configured: false });
  const html = render(React.createElement(SignalTable, { signals: [] }), view);
  assert.equal(html.includes('Connect Telegram'), false);
  assert.match(html, /Telegram is temporarily unavailable|temporarily unavailable/);
});

test('signals are listed as soon as they exist, whatever the connection says', () => {
  for (const view of [telegramConnectionView(UNKNOWN), viewFor({ connected: true, configured: true }), viewFor({ connected: false, configured: true })]) {
    const html = render(React.createElement(SignalTable, { signals: [{ id: 's1', symbol: 'EURUSD', message: 'BUY EURUSD', side: 'buy', channelTitle: 'Alpha Calls' }] }), view);
    assert.match(html, /EURUSD/);
    assert.match(html, /Alpha Calls/);
    assert.equal(html.includes('empty-state'), false);
  }
});

/* ------------------------------------------------------- the rest of the app surface */

test('the topbar pill reports the four states instead of a permanent Connected', () => {
  assert.match(render(React.createElement(TelegramStatusPill), telegramConnectionView(UNKNOWN)), /Checking Telegram…/);
  assert.match(render(React.createElement(TelegramStatusPill), viewFor({ connected: true, configured: true })), /Telegram connected/);
  const offline = render(React.createElement(TelegramStatusPill), viewFor({ connected: false, configured: true }));
  assert.match(offline, /Telegram not connected/);
  assert.equal(offline.includes('status-pill online'), false, 'the online style must not be applied while offline');
  const stale = render(React.createElement(TelegramStatusPill, { detailed: true }), telegramConnectionView(telegramStatusReducer(stateFor({ connected: true, configured: true }), { type: 'reject', message: 'x' })));
  assert.match(stale, /Telegram connected/);
  assert.match(stale, /last confirmed state/);
});

test('the trading accounts page only speaks about the signal source when it knows', () => {
  assert.equal(telegramSourceNote({ view: telegramConnectionView(UNKNOWN) }), null, 'no note while the status is unknown');
  assert.equal(telegramSourceNote({ view: viewFor({ connected: true, configured: true }), channelCount: 3 }), null, 'a working source needs no warning');
  assert.match(telegramSourceNote({ view: viewFor({ connected: false, configured: true }) }).text, /Telegram is not connected/);
  assert.match(telegramSourceNote({ view: viewFor({ connected: true, configured: true }), channelCount: 0 }).text, /no channels are selected yet/);
});

test('every Connect Telegram prompt in the app is gated on the confirmed state', () => {
  const offenders = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!/\.jsx?$/.test(entry.name)) continue;
      const source = readFileSync(full, 'utf8');
      if (/>Connect Telegram</.test(source) && !source.includes('view.showConnectCallToAction')) offenders.push(path.relative(srcDir, full));
    }
  };
  walk(srcDir);
  assert.deepEqual(offenders, [], 'a connect CTA may only render when the backend confirmed a disconnection');
});

test('the telegram page keeps its sign-in form out of the loading window', () => {
  const source = readFileSync(path.join(srcDir, 'components', 'TelegramConnect.jsx'), 'utf8');
  assert.equal(source.includes("useState({ connected: false })"), false);
  assert.match(source, /view\.key === 'checking' \|\| view\.key === 'unreachable'/);
  assert.match(source, /Checking your Telegram connection/);
  assert.match(source, /connected === true/, 'chats load only for a confirmed connection');
  assert.equal(source.includes('setStatus'), false, 'the page has no local copy of the status any more');
});

/* ---------------------------------------------------------------------------------------------
 * The dashboard's monitoring label is a status claim, so it has to be disprovable by the one field
 * the server is entitled to set: `listening`. A signed-in session with nothing attached to it used
 * to read here as "Signal monitoring", which is precisely how a dropped handler stayed invisible for
 * weeks - the empty list said it, but the pill contradicted it, and the pill is what is always on
 * screen.
 * ------------------------------------------------------------------------------------------- */

const connectedView = (listening) => telegramConnectionView(stateFor({ connected: true, configured: true, listening }));

test('the monitoring label is not claimed by a session that is not listening', () => {
  assert.deepEqual(
    { key: monitoringLabel({ view: connectedView(true), channelCount: 2 }).key, live: monitoringLabel({ view: connectedView(true), channelCount: 2 }).live },
    { key: 'monitoring', live: true },
    'a connected session with a live handler and a channel selected is monitoring',
  );
  const idle = monitoringLabel({ view: connectedView(false), channelCount: 2 });
  assert.equal(idle.key, 'idle');
  assert.equal(idle.live, false, 'and a label that is not live may not be drawn as live');
  assert.match(idle.text, /Waiting for Telegram/, 'the sentence says the app is waiting, not that a fault happened');
  assert.equal(/Render|sleep|asleep|instance/i.test(idle.text), false, 'the mechanism is an administrator diagnostic, never dashboard copy');
  assert.equal(monitoringLabel({ view: connectedView(false), channelCount: 0 }).key, 'no-channels', 'a workspace with nothing selected is a different fact');
});

test('the not-listening empty state is one sentence an operator can act on', () => {
  const empty = signalEmptyState({ view: connectedView(false), channelCount: 2 });
  assert.equal(empty.message, LISTENER_NOT_ATTACHED_MESSAGE);
  assert.ok(LISTENER_NOT_ATTACHED_MESSAGE.length < 170, 'the copy stays readable where it is read: a whole paragraph in an empty state is text nobody finishes');
  assert.match(LISTENER_NOT_ATTACHED_MESSAGE, /not receiving messages yet/);
  assert.equal(/Render|sleep|asleep|restart/i.test(LISTENER_NOT_ATTACHED_MESSAGE), false, 'no host mechanics in a user-facing empty state');
});
