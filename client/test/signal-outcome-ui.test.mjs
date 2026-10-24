import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { signalBadges, signalHasTradingData, signalOutcomeView, signalsAwaitingUpgrade } from '../src/lib/signal-outcome.js';

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

/* --------------------- a market order: a level stated, no entry --------------------- */

/** The row `Gold Buy now` / `SL: 4041.50` produces: symbol, side and stop, with the entry left absent. */
const MARKET_ROW = {
  id: 'gold-market', symbol: 'XAUUSD', side: 'buy', source: 'telegram', channelTitle: 'Gold Signals',
  message: 'Gold Buy now\n\nSL: 4041.50', status: 'unparsed', executionReady: true,
  entryPrice: null, stopLoss: 4041.5, takeProfit: null, createdAt: '2026-10-24T00:16:00.000Z',
};

test('an unstated entry is described as a market order, never as an unclear message', () => {
  const view = signalOutcomeView(MARKET_ROW);
  assert.equal(view.label, 'Needs review', 'the status is still unparsed, but the message said something tradeable, so it is not written off');
  assert.equal(view.label === 'No clear signal', false);

  const badges = signalBadges(MARKET_ROW);
  // The missing target earns its own badge, correctly: the Safety settings really do have a say about it,
  // while nothing has a say about the entry.
  assert.deepEqual(badges.map((badge) => badge.key), ['market', 'missing-target']);
  assert.equal(badges[0].label, 'Market');
  assert.equal(badges[0].tone, 'muted', 'nothing is wrong with the signal, so nothing is coloured as a warning');
  assert.match(badges[0].title, /market order/i, 'the tooltip explains what the badge means in terms of what the broker will be sent');
  assert.match(badges[0].title, /ask|bid/, 'and names the price it fills at');
});

test('the badge is only earned by a message that actually stated a level', () => {
  // A row that produced a word and nothing else is a bulletin, and it already says so.
  const hype = { id: 'h', symbol: 'SHOULD', side: 'buy', source: 'telegram', status: 'unparsed', entryPrice: null, stopLoss: null, takeProfit: null };
  /* A row that produced a word and nothing else is a bulletin, and it already says so - so it now wears no
     missing-leg pills either. "Missing SL" is advice about a signal, and a message that never stated a price
     is not a signal with a hole in it: the pair used to appear on a captured "Should I release more setups?"
     and told the user to go fix a trade that did not exist. */
  assert.deepEqual(signalBadges(hype), [], 'nothing is missing from a message that asked for nothing');
  assert.equal(signalHasTradingData(hype), true, 'the loose test stays as it is - it answers a different question');

  // An entry that is present has no story to tell about its absence.
  const limited = { ...MARKET_ROW, entryPrice: 4050 };
  assert.deepEqual(signalBadges(limited).map((badge) => badge.key), ['missing-target'], 'a complete entry leaves nothing to explain about the entry');

  // A target and no entry is still "at market": the level the channel gave need not be a stop.
  const targetOnly = { ...MARKET_ROW, stopLoss: null, takeProfit: 4075 };
  assert.deepEqual(signalBadges(targetOnly).map((badge) => badge.key), ['market', 'missing-stop']);

  // A message typed into the review panel is not a channel asking for a market fill.
  const manual = { ...MARKET_ROW, source: 'manual' };
  assert.deepEqual(signalBadges(manual).map((badge) => badge.key), []);
});

test('the card shows the stop, says Market where the entry would have been, and keeps the number off the screen', async () => {
  const { default: SignalTable } = await bundle('SignalTable.jsx');
  const markup = renderToStaticMarkup(React.createElement(SignalTable, {
    signals: [MARKET_ROW], channelCount: 1, onOpenTelegram() {}, onUpgrade() {},
  }));
  assert.match(markup, /XAUUSD/);
  assert.match(markup, /SL 4041\.5/, 'the level the channel did state is on the row');
  assert.equal(markup.includes('Entry '), false, 'and the entry line is not printed with an empty value');
  assert.match(markup, /class="badge signal-flag-badge tone-muted"[^>]*>Market<|>Market<\/span>/, 'the absence is labelled, not left to look like a gap');
  assert.match(markup, /filled at the current ask/);
  assert.equal(markup.includes('No clear signal'), false);
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
