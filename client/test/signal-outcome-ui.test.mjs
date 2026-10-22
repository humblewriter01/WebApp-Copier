import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { signalOutcomeView, signalsAwaitingUpgrade } from '../src/lib/signal-outcome.js';

const here = path.dirname(fileURLToPath(import.meta.url));

function bundle(name) {
  const outfile = path.join(here, '.tmp', `${name}.mjs`);
  return build({
    entryPoints: [path.join(here, '..', 'src', name.includes('/') ? name : path.join('components', name))],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    external: ['react'],
    define: {
      'process.env.NODE_ENV': '"development"',
      // The API helper reads Vite's env object at module scope, which only exists in a bundle.
      'import.meta.env': JSON.stringify({ PROD: false, VITE_API_URL: 'http://localhost:5000' }),
    },
    logLevel: 'silent',
  }).then(() => {
    assert.ok(existsSync(outfile), `the ${name} bundle was produced`);
    return import(pathToFileURL(outfile).href);
  });
}

const { default: SignalTable } = await bundle('SignalTable.jsx');
const { request } = await bundle('lib/api.js');

/* -------------------------------- the outcome of a captured signal -------------------------------- */

test('a saved-but-not-executed signal says so, in the server\'s words and never in ours', () => {
  const free = signalOutcomeView({
    status: 'unexecuted',
    executionNote: 'Upgrade to Starter or higher to execute signals automatically. This signal is saved for review.',
  });
  assert.deepEqual(free, {
    status: 'unexecuted',
    label: 'Not executed',
    tone: 'warn',
    note: 'Upgrade to Starter or higher to execute signals automatically. This signal is saved for review.',
    upgradeRequired: true,
    showNote: true,
  });

  // No note means no invented reason: the label describes the status and stops there.
  const quiet = signalOutcomeView({ status: 'received' });
  assert.equal(quiet.note, '');
  assert.equal(quiet.showNote, false);
  assert.equal(quiet.upgradeRequired, false);

  assert.equal(signalOutcomeView({ status: 'executed', executionNote: null }).tone, 'good');
  assert.equal(signalOutcomeView({ status: 'queued' }).label, 'Sent for execution');
  assert.equal(signalOutcomeView({ status: 'unparsed' }).label, 'No clear signal');
  // A status the client has never heard of is displayed, not swallowed, and is not called "Saved".
  assert.equal(signalOutcomeView({ status: 'pending_review' }).label, 'pending review');
  assert.equal(signalOutcomeView(undefined).label, 'Saved for review', 'no status is the state a fresh capture starts in');
  assert.equal(signalsAwaitingUpgrade([{ status: 'unexecuted', executionNote: 'no trading account is selected' }]), false, 'an unlinked account is not an upsell');
  assert.equal(signalsAwaitingUpgrade([{ status: 'unexecuted', executionNote: 'Automatic execution needs a paid plan.' }]), true);
  assert.equal(signalsAwaitingUpgrade([]), false);
  assert.equal(signalsAwaitingUpgrade(undefined), false);
});

test('a free workspace sees its captured signals with the reason attached, not an empty panel', () => {
  const signals = [
    {
      id: 'one', symbol: 'EURUSD', side: 'buy', channelTitle: 'FX Room', message: 'BUY EURUSD 1.0850 SL 1.0800',
      entryPrice: 1.085, stopLoss: 1.08, createdAt: '2026-10-22T10:00:00.000Z', status: 'unexecuted',
      executionNote: 'Upgrade to Starter or higher to execute signals automatically. This signal is saved for review.',
    },
    {
      id: 'two', symbol: 'XAUUSD', side: 'sell', channelTitle: 'Gold Signals', message: 'SELL XAUUSD',
      status: 'queued', executionNote: null, createdAt: '2026-10-22T09:00:00.000Z',
    },
  ];
  const markup = renderToStaticMarkup(React.createElement(SignalTable, {
    signals,
    channelCount: 2,
    onOpenTelegram() {},
    onUpgrade() {},
  }));
  assert.match(markup, /FX Room/, 'the captured message itself is rendered, not replaced by a call to action');
  assert.match(markup, /Not executed/);
  assert.match(markup, /Upgrade to Starter or higher/);
  assert.match(markup, /See plans/, 'the way forward is next to the reason, not on another page');
  assert.match(markup, /Sent for execution/);
  assert.match(markup, /outcome-warn/);
  assert.equal(markup.includes('Connect Telegram'), false, 'a workspace that is already capturing is never told to connect');
});

/* ----------------------------- what a failed request says back ----------------------------- */

function answering({ status, body, contentType = 'application/json' }) {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => contentType },
      text: async () => body,
    };
  };
  return calls;
}

test('the server\'s own explanation survives a 500, and a response that never came from the app is named as such', async () => {
  answering({
    status: 500,
    body: JSON.stringify({ error: 'Something went wrong. Please try again in a moment.', code: 'UNEXPECTED', requestId: 'a1b2c3d4', userMessage: 'Publishing that announcement did not complete: duplicate key value. Nothing was changed - please try again.' }),
  });
  await assert.rejects(
    () => request('/api/admin/announcements', 'token', { method: 'POST', body: { message: 'hi there' } }),
    (error) => {
      assert.match(error.message, /^Publishing that announcement did not complete: duplicate key value/);
      assert.match(error.message, /Reference a1b2c3d4\)$/, 'the reference travels with the sentence so a report can be traced in the log');
      assert.equal(error.code, 'UNEXPECTED');
      assert.equal(error.status, 500);
      assert.equal(error.retryable, undefined, 'the server answered, so this is not a transport failure');
      assert.equal(error.requestId, 'a1b2c3d4');
      return true;
    },
  );

  // A JSON body with no sentence in it still gets the old, honest wording.
  answering({ status: 500, body: JSON.stringify({}) });
  await assert.rejects(
    () => request('/api/admin/users/x', 'token', { method: 'PATCH', body: {} }),
    (error) => {
      assert.equal(error.message, 'We could not complete that request. Please try again in a moment.');
      assert.equal(error.retryable, true);
      return true;
    },
  );

  // An HTML error page from a proxy is a different fact from a refusal by the service.
  const calls = answering({ status: 502, body: '<html>Bad Gateway</html>', contentType: 'text/html' });
  await assert.rejects(
    () => request('/api/admin/users/x/suspend', 'token', { method: 'PATCH', body: {} }),
    (error) => {
      assert.match(error.message, /did not answer that request \(HTTP 502\)/);
      assert.match(error.message, /may never have been applied/);
      assert.match(error.message, /reload it, and try again/);
      assert.equal(error.retryable, true);
      return true;
    },
  );
  assert.deepEqual(calls[0].options.headers, { 'Content-Type': 'application/json', Authorization: 'Bearer token' });

  // A gateway error with no body at all is the same fact, stated without a fabricated status.
  answering({ status: 503, body: '' });
  await assert.rejects(
    () => request('/api/admin/announcements', 'token', { method: 'POST', body: { message: 'x' } }),
    (error) => {
      assert.match(error.message, /HTTP 503/);
      return true;
    },
  );
});

test('a 400 keeps its instructions, and a success is returned untouched', async () => {
  answering({ status: 400, body: JSON.stringify({ error: 'Add a short reason before suspending this user.' }) });
  await assert.rejects(
    () => request('/api/admin/users/x', 'token', { method: 'PATCH', body: {} }),
    (error) => {
      assert.equal(error.message, 'Add a short reason before suspending this user.');
      assert.equal(error.retryable, undefined, 'retrying the same request would be refused again');
      return true;
    },
  );

  answering({ status: 200, body: JSON.stringify({ user: { id: 'x', isSuspended: true }, notice: '1 support session closed.' }) });
  const data = await request('/api/admin/users/x', 'token', { method: 'PATCH', body: { isSuspended: true } });
  assert.deepEqual(data, { user: { id: 'x', isSuspended: true }, notice: '1 support session closed.' });

  // An accepted response with no body stays a payload rather than a parse failure.
  answering({ status: 202, body: '' });
  assert.deepEqual(await request('/api/anything', 'token', { method: 'POST' }), {});
});
