/**
 * What a paused Telegram session looks like to the person whose session it is.
 *
 * The whole feature exists for one reason - a Free account that has not been opened in thirty days should not be
 * holding a socket - and the risk that comes with it is a support load built entirely from misunderstanding: a
 * trader who sees "not connected" opens the sign-in flow, and a trader who starts a fresh sign-in on a session that
 * is merely paused is one step away from the thing the design refuses to touch. So the paused state has to be its
 * own view, with its own sentence and no call to action, and this file is mostly about the absence of that button.
 *
 * The components are bundled with esbuild and imported, exactly like the rest of the UI tests here, because the
 * view model is the code under test and a regex over JSX would only prove the formatting.
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
const serverDir = path.join(here, '..', '..', 'server');
const outfile = path.join(here, '.tmp', 'telegram-pause-ui.mjs');

await build({
  stdin: {
    contents: [
      "export { TelegramStatusContext, telegramStatusReducer, telegramConnectionView, TelegramStatusPill, monitoringLabel, pausedCopy, PAUSED_MESSAGE, PAUSED_IDLE_MESSAGE, PAUSED_BY_SUPPORT_MESSAGE, LISTENER_NOT_ATTACHED_MESSAGE, WAITING_FOR_MESSAGES_MESSAGE } from './TelegramStatus.jsx';",
      "export { default as SignalTable, signalEmptyState } from './SignalTable.jsx';",
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
  TelegramStatusContext, telegramStatusReducer, telegramConnectionView, TelegramStatusPill, monitoringLabel,
  pausedCopy, PAUSED_MESSAGE, PAUSED_IDLE_MESSAGE, PAUSED_BY_SUPPORT_MESSAGE,
  LISTENER_NOT_ATTACHED_MESSAGE, WAITING_FOR_MESSAGES_MESSAGE, signalEmptyState,
} = await import(pathToFileURL(outfile).href);

const UNKNOWN = telegramStatusReducer(undefined, { type: '@@initial' });
const stateFor = (payload, at = 1) => telegramStatusReducer(UNKNOWN, { type: 'resolve', payload, at });
const viewFor = (payload) => telegramConnectionView(stateFor(payload));
const render = (element, view) => renderToStaticMarkup(
  React.createElement(TelegramStatusContext.Provider, { value: { view, refresh: async () => {} } }, element),
);

/* ------------------------------------------------------------------ the sentences */

test('a pause says why it happened, and the two causes get two different sentences', () => {
  assert.equal(pausedCopy('idle-free-plan'), PAUSED_IDLE_MESSAGE);
  assert.equal(pausedCopy('admin-manual'), PAUSED_BY_SUPPORT_MESSAGE);
  assert.equal(pausedCopy(null), PAUSED_MESSAGE, 'a pause whose cause the row does not record gets the sentence that is true of every pause');
  assert.equal(pausedCopy('something-invented'), PAUSED_MESSAGE, 'and an unknown value is never upgraded into a story about inactivity');
});

test('the idle sentence names both ways out, in the words the policy actually offers', () => {
  assert.equal(PAUSED_IDLE_MESSAGE, 'Your Telegram connection is paused due to inactivity. Upgrade to a paid plan or contact support to resume live signal copying.', 'this sentence is the product spec, verbatim, because it is the one line a paused trader is ever shown');
  assert.match(PAUSED_IDLE_MESSAGE, /paused due to inactivity/, 'it says what happened');
  assert.match(PAUSED_IDLE_MESSAGE, /Upgrade to a paid plan or contact support/, 'and it says both ways back, because a plan change resumes on the next pass and support can resume it now');
  assert.equal(PAUSED_IDLE_MESSAGE.includes('sign in'), false, 'and it never mentions signing in: the session is still linked, and pointing them at the login flow is how a pause becomes a re-authorisation');
});

test('an administrator pause is never described as the trader having gone quiet', () => {
  assert.match(PAUSED_BY_SUPPORT_MESSAGE, /paused by support/);
  assert.equal(PAUSED_BY_SUPPORT_MESSAGE.includes('inactivity'), false, 'the difference matters: one is a policy the account can grow out of, the other is a decision about this account');
  assert.equal(PAUSED_BY_SUPPORT_MESSAGE.includes('Upgrade'), false, 'and telling someone whose session support stopped to buy a plan is a promise the server does not keep for admin pauses');
  assert.match(PAUSED_BY_SUPPORT_MESSAGE, /live signal copying/, 'both sentences say what is stopped, in the words the rest of the app uses');
});

test('the copy stays in the product’s vocabulary', () => {
  const FORBIDDEN = /HTTP|api\.groq|gpt-oss|stack|socket|MTProto|pts|heartbeat|Telegram session string|409|503|fetch\(/i;
  for (const sentence of [PAUSED_MESSAGE, PAUSED_IDLE_MESSAGE, PAUSED_BY_SUPPORT_MESSAGE]) {
    assert.equal(FORBIDDEN.test(sentence), false, `a trader-facing sentence that says ${sentence} must not read like a log line`);
  }
});

/* ------------------------------------------------------------------ the state machine */

test('a pause is its own view, with no call to action anywhere in it', () => {
  const view = viewFor({ connected: false, configured: true, paused: true, pauseReason: 'idle-free-plan', listening: false });
  assert.equal(view.key, 'paused');
  assert.equal(view.known, true, 'it is not a pending state - the server said this');
  assert.equal(view.tone, 'pending', 'but it is not a fault either, so nothing is painted red');
  assert.equal(view.showConnectCallToAction, false, 'the one assert that keeps a paused account off the sign-in flow');
  assert.equal(view.label, 'Telegram paused');
  assert.equal(view.detail, PAUSED_IDLE_MESSAGE, 'and the sentence travels with it');
  assert.equal(view.paused, true);
});

test('the pause outranks every other branch, including a stale "connected"', async () => {
  /* The order on the wire is flag-then-socket, which means a poll can legitimately catch `connected: true` beside a
     pause that has already landed. A view that branched on `connected` first would say "waiting for messages" - the
     one sentence that is definitely false - over a session that was just stopped, so the paused view also declines
     to carry `connected` forward: nothing downstream has to know which of the two answers was the stale one. */
  const view = viewFor({ connected: true, configured: true, paused: true, pauseReason: 'admin-manual', listening: true });
  assert.equal(view.key, 'paused');
  assert.equal(view.listening, false, 'and it reports the session as not listening, whatever the last answer said');
  assert.equal(view.detail, PAUSED_BY_SUPPORT_MESSAGE);
  assert.equal(view.connected, false, '`connected` is not claimed by a view the server is reporting as paused');
});

test('an unknown state is still unknown, and a pause is not a default', () => {
  assert.equal(UNKNOWN.paused, false, 'a status that has never been read shows no pause notice - the pending view is the honest one');
  assert.equal(telegramConnectionView(UNKNOWN).key, 'checking');
  const unpaused = viewFor({ connected: true, configured: true, paused: false, pauseReason: null });
  assert.equal(unpaused.key, 'connected', 'and a linked session the server does not say is paused is treated as running');
});

test('a local flow clears the pause, because the only flows that set it are sign-in and sign-out', () => {
  const paused = stateFor({ connected: false, configured: true, paused: true, pauseReason: 'idle-free-plan' });
  const disconnected = telegramStatusReducer(paused, { type: 'mark-disconnected', at: 2 });
  assert.equal(disconnected.paused, false, 'a deliberate sign-out is not a pause, and the notice must not outlive the session');
  const signedIn = telegramStatusReducer(paused, { type: 'apply', payload: { connected: true }, at: 3 });
  assert.equal(signedIn.paused, false, 'and a local sign-in clears the notice rather than leaving it beside a session that has just connected');
  assert.equal(signedIn.connected, true);
  /* Clearing the *notice* is not clearing the *policy*: the next poll reads the row, and a paused session that
     invents its own resume would be the bug this whole feature was specified to avoid. */
  const refreshed = telegramStatusReducer(signedIn, { type: 'resolve', payload: { connected: false, configured: true, paused: true, pauseReason: 'idle-free-plan' }, at: 4 });
  assert.equal(refreshed.paused, true, 'and it comes back the moment the server says it is still paused');
});

/* ------------------------------------------------------------------ the surfaces */

test('the signal list says it is paused instead of promising messages or asking for a sign-in', () => {
  const view = viewFor({ connected: false, configured: true, paused: true, pauseReason: 'idle-free-plan' });
  for (const channelCount of [0, 3]) {
    const empty = signalEmptyState({ view, channelCount });
    assert.equal(empty.title, 'Signal copying is paused');
    assert.equal(empty.message, PAUSED_IDLE_MESSAGE, 'the sentence is the same one the pill and the page say, because three phrasings of one state read as three problems');
    assert.equal(empty.action, null, 'and there is no button: neither "connect" nor "choose channels" is the answer to a pause');
    assert.notEqual(empty.message, LISTENER_NOT_ATTACHED_MESSAGE, 'and the sentence the reconnect-era bug needed is not reused here: a paused session does not start again by reloading the page');
  }
});

test('the listener-not-attached sentence is not what a paused workspace is told', () => {
  const view = viewFor({ connected: false, configured: true, paused: true, pauseReason: 'idle-free-plan' });
  const pausedMessage = signalEmptyState({ view, channelCount: 3 }).message;
  assert.equal(pausedMessage.includes(LISTENER_NOT_ATTACHED_MESSAGE), false, '"open this page again and the next message will be captured" is a promise a paused session cannot keep - reloading does nothing');
  assert.equal(pausedMessage.includes(WAITING_FOR_MESSAGES_MESSAGE), false, 'and neither is the quiet-channel sentence');
  const notAttached = signalEmptyState({ view: viewFor({ connected: true, configured: true, listening: false }), channelCount: 3 });
  assert.equal(notAttached.message, LISTENER_NOT_ATTACHED_MESSAGE, 'which is why it stays exactly where it belongs: a live session whose handler dropped is a different problem with a different fix');
});

test('the dashboard label stops claiming monitoring, and the pill says the state in three words', () => {
  const view = viewFor({ connected: false, configured: true, paused: true, pauseReason: 'idle-free-plan' });
  const label = monitoringLabel({ view, channelCount: 4 });
  assert.deepEqual(label, { key: 'paused', text: 'Signal copying paused', live: false }, 'a paused workspace with four channels selected is not monitoring any of them, and the label cannot say it is');
  assert.equal(monitoringLabel({ view: viewFor({ connected: true, configured: true, listening: true }), channelCount: 4 }).key, 'monitoring', 'the same count on a live session still reads as monitoring');
  const html = render(React.createElement(TelegramStatusPill, { detailed: true }), view);
  assert.match(html, /Telegram paused/, 'the pill renders the pause as its own label rather than as "not connected"');
  assert.equal(html.includes('Telegram not connected'), false, 'and it does not borrow the disconnected label, which is the one a user knows how to fix by themselves');
});

test('the paused view is decided by the field, not by the absence of a socket', () => {
  /* The negative that matters: every reviver in this app was rewritten around the fact that a paused workspace
     looks exactly like a disconnected one from the socket's side. If the client inferred the state from
     `connected: false`, the pause would be invisible the moment the server got it right. */
  const disconnected = viewFor({ connected: false, configured: true, paused: undefined });
  assert.equal(disconnected.key, 'disconnected');
  assert.equal(disconnected.showConnectCallToAction, true, 'a genuinely disconnected account is offered the sign-in, and that difference is the feature');
  const paused = viewFor({ connected: false, configured: true, paused: true });
  assert.equal(paused.key, 'paused');
  assert.equal(paused.showConnectCallToAction, false);
});

/* ------------------------------------------------------------------ the contract with the server */

test('the fields the client reads are the fields the status route sends', () => {
  const index = readFileSync(path.join(serverDir, 'index.js'), 'utf8');
  const status = index.slice(index.indexOf("app.get('/api/telegram/status'"), index.indexOf('async function persistTelegramLoginAttempt'));
  for (const field of ['paused', 'pauseReason', 'pausedAt', 'connected', 'listening', 'configured']) {
    // Either spelling is the route answering: a shorthand property (`configured,`) is the same field as
    // `paused: ...`, and a pin that only accepted one of them would fail the next harmless refactor of the payload.
    assert.match(status, new RegExp(String.raw`\b${field}:|\b${field},`), `the route answers with ${field}, which is the only place this view may learn it from`);
  }
  assert.ok(status.includes("pauseReason: paused ? (rows[0]?.telegram_pause_reason || null) : null"), 'the reason is sent when there is one and null when there is not, and never a default the UI would have to guess around');
  const reducer = readFileSync(path.join(srcDir, 'components', 'TelegramStatus.jsx'), 'utf8');
  for (const field of ['result.paused', 'result.pauseReason']) {
    assert.ok(reducer.includes(field), `and the reducer reads ${field} by name, so a rename on either side is a failing test rather than a silently missing sentence`);
  }
});

test('the panel asks for the pause and the resume at the two routes that perform them', () => {
  const panel = readFileSync(path.join(srcDir, 'components', 'AdminPanel.jsx'), 'utf8');
  assert.match(panel, /\/api\/admin\/users\/\$\{user\.id\}\/telegram\/pause`/, 'the administrator presses Pause on the row');
  assert.match(panel, /\/api\/admin\/users\/\$\{user\.id\}\/telegram\/resume`/, 'and Resume, as a second action with a second audit row');
  assert.match(panel, /body: \{ reason: 'admin-manual' \}/, 'the pause says who caused it in the vocabulary the server validates');
  assert.equal(panel.includes("telegram/pause`, token, { method: 'POST', body: { reason: 'idle-free-plan' }"), false, 'a button may never claim to be the automatic policy, which is the difference the audit row exists to keep');
});

test('the Telegram page does not offer a paused workspace the sign-in form', () => {
  /* `TelegramConnect` decides its whole body by branching on the shared view, and every branch it does not know
     falls through to the phone-number form - which is exactly the wrong answer for a pause: the session is linked,
     and typing a code into that form replaces the session string the pause exists to preserve. Pinned on the
     source because the ordering of the branches is the entire behaviour, and a paused view that reaches the form
     would still render a perfectly-looking page. */
  const page = readFileSync(path.join(srcDir, 'components', 'TelegramConnect.jsx'), 'utf8');
  const paused = page.indexOf("view.key === 'paused' ? <>");
  const connectForm = page.indexOf("id=\"telegram-phone\"");
  assert.ok(paused > 0, 'the page has a paused branch');
  assert.ok(connectForm > paused, 'and it is decided before the form, not after it');
  assert.ok(page.slice(paused, connectForm).includes('view.detail'), 'the branch shows the sentence the server chose for this pause');
  assert.equal(page.slice(paused, connectForm).includes('Send Telegram code'), false, 'and nothing in it asks for a code');
});
