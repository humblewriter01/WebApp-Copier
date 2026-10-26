/**
 * The language a trader is allowed to be shown, and the agreement between a signal row and the banner above it.
 *
 * Two failures with the same root: a note that quotes the machinery (an HTTP status, a model name, an endpoint)
 * is a sentence nobody can act on, and a note that describes a state the workspace is not in - "Auto-Trading is
 * off" beside a switch that is on - is worse than no sentence at all, because it teaches the reader that the
 * panel lies. Both are pinned here from the client's side, which is where a legacy row from before the rule
 * still lands.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { FRIENDLY_NOTES, TECHNICAL_NOTE_MARKERS, friendlySignalNote, isTechnicalNote, signalOutcomeView } from '../src/lib/signal-outcome.js';
import { autoTradingBannerView } from '../src/lib/platform-view.js';
import * as serverWording from '../../server/services/signal-wording.js';
import {
  ACCOUNT_NOT_READY_NOTE,
  AUTO_TRADING_OFF_NOTE,
  NO_ACCOUNT_NOTE,
  PLAN_NO_EXECUTION_NOTE,
} from '../../server/services/signal-outcome.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FORBIDDEN = /HTTP|api\.groq|gpt-oss|stack/i;
/* Only what a person reads: a stylesheet name is allowed to be called `form-stack`, a sentence is not. */
const visibleText = (markup) => markup.replace(/<[^>]+>/g, ' ');

function bundle(name) {
  const outfile = path.join(here, '.tmp', `${name}.mjs`);
  return build({
    entryPoints: [path.join(here, '..', 'src', name.includes('/') ? name : path.join('components', name))],
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
  }).then(() => {
    assert.ok(existsSync(outfile), `the ${name} bundle was produced`);
    return import(pathToFileURL(outfile).href);
  });
}

const { default: SignalTable } = await bundle('SignalTable.jsx');
const { default: AdvancedSettings } = await bundle('AdvancedSettings.jsx');
const metaApiPanelSource = readFileSync(path.join(here, '..', 'src', 'components', 'MetaApiPanel.jsx'), 'utf8');

const captured = (extra = {}) => ({
  id: 'row-1', source: 'telegram', channelTitle: 'Adrielle Traders Circle', message: 'BUY GOLD 4016 SL 4010 TP 4050',
  symbol: 'XAUUSD', side: 'buy', entryPrice: 4016, stopLoss: 4010, takeProfit: 4050,
  stopLossPips: null, takeProfitPips: null, takeProfitLevels: [], entryRange: null,
  orderType: 'market', orderTypeStated: false, isScalping: false, directionInferred: false,
  needsReview: false, executionReady: true, parsedBy: 'regex', parseConfidence: null, llmUsed: false,
  status: 'unexecuted', parseError: null, executionNote: null, createdAt: '2026-10-25T09:00:00.000Z', ...extra,
});

const renderRow = (signal) => renderToStaticMarkup(React.createElement(SignalTable, { signals: [signal] }));

/* --------------------------------------------------------------- nothing technical reaches the screen */

test('a note that names a status code, a model, an endpoint or a stack is never shown, and never was', () => {
  // The screenshot that started this: a signal card reading "The AI reader could not be reached (HTTP 400)."
  const hostile = [
    'The AI reader could not be reached (HTTP 400).',
    'MetaAPI returned HTTP 503, but its response body could not be read (ECONNRESET).',
    'The model gpt-oss-20b at https://api.groq.com/openai/v1/chat/completions rejected the request: {"error":{"code":"model_overloaded"}}',
    'reader-failed: TypeError: fetch failed at node:internal/deps/undici/undici:11616:19',
    'Trade failed with TRADE_RETCODE_REQUOTE (10004) for EURUSD',
    'LLM_TIMEOUT_MS exceeded after 6000 ms (stack: 12 frames)',
  ];
  for (const note of hostile) {
    assert.equal(isTechnicalNote(note), true, `"${note}" is technical`);
    const shown = friendlySignalNote(note);
    assert.equal(FORBIDDEN.test(shown), false, `the replacement for "${note}" carries none of it`);
    assert.ok(Object.values(FRIENDLY_NOTES).includes(shown), 'and it is one of the sentences the product chose, not an invention');
  }
  const markup = renderRow(captured({ status: 'unparsed', executionReady: false, executionNote: null, parseError: hostile[0] }));
  assert.match(markup, /This signal was saved for review\. The platform could not fully read it\./, 'the card a legacy row produces says the friendly thing');
  assert.equal(FORBIDDEN.test(visibleText(markup)), false, 'and no part of the rendered row says the machinery');
});

test('a whole table of jargon rows renders as a whole table of sentences', () => {
  const rows = [
    captured({ id: 'a', executionNote: 'The AI reader could not be reached (HTTP 400).' }),
    captured({ id: 'b', executionNote: 'gpt-oss-20b endpoint api.groq.com returned a stack trace' }),
    captured({ id: 'c', parseError: 'HTTP 429 too many requests on the reader', executionNote: null }),
    captured({ id: 'd', executionNote: NO_ACCOUNT_NOTE }),
  ];
  const markup = renderToStaticMarkup(React.createElement(SignalTable, { signals: rows }));
  assert.equal(FORBIDDEN.test(visibleText(markup)), false, 'no HTTP, no api.groq, no gpt-oss, no stack - anywhere a person reads');
  assert.match(markup, /no trading account is connected/, 'while the sentence that was already clean is still there');
});

/* ------------------------------------------------------- the copy is shared, and so is the way it is chosen */

test('the client copy of the rule is the server copy, not an approximation of it', () => {
  assert.equal(TECHNICAL_NOTE_MARKERS, serverWording.TECHNICAL_NOTE_MARKERS, 'the same things count as internals');
  assert.deepEqual(FRIENDLY_NOTES, serverWording.FRIENDLY_NOTES, 'and map to the same sentences');
  const samples = [
    'The AI reader could not be reached (HTTP 400).',
    'MetaAPI returned HTTP 503 (ECONNRESET).',
    'Missing take-profit (code: take-profit-missing)',
    'SQLSTATE[HY000]: connection pool exhausted',
    'The signal has no stop loss, and your workspace requires one before an order is sent.',
  ];
  for (const sample of samples) {
    assert.equal(friendlySignalNote(sample), serverWording.friendlySignalNote(sample).text, `"${sample}" is read the same way on both sides`);
  }
});

/* -------------------------------------------------------------------- the four states, agreed */

test('each state of the workspace produces its own sentence on the row, verbatim', () => {
  const cases = [
    // Each sentence arrives with the status the server writes beside it: a switch that is off leaves the row
    // `received`, and every state that could have traded and did not is `unexecuted`.
    [AUTO_TRADING_OFF_NOTE, 'Saved for review', 'received'],
    [PLAN_NO_EXECUTION_NOTE, 'Not executed', 'unexecuted'],
    [NO_ACCOUNT_NOTE, 'Not executed', 'unexecuted'],
    [ACCOUNT_NOT_READY_NOTE, 'Not executed', 'unexecuted'],
  ];
  for (const [note, label, status] of cases) {
    const outcome = signalOutcomeView(captured({ executionNote: note, status }));
    assert.equal(outcome.note, note, `the card quotes "${note}" as the server wrote it`);
    assert.equal(outcome.label, label, `under the ${label} label`);
  }
});

test('the banner beside the list says the same thing about the same missing piece', () => {
  const deployedAccount = [{ metaApiAccountId: 'acct-1', state: 'DEPLOYED' }];
  const cases = [
    {
      name: 'Auto-Trading off',
      banner: { autoTradingEnabled: false, runtimeEnabled: true, platformPause: null, linkedAccounts: deployedAccount, executionAccountId: 'acct-1', subscriptionStatus: 'active' },
      note: AUTO_TRADING_OFF_NOTE,
      shares: /saved for review/i,
    },
    {
      name: 'plan without execution',
      banner: { autoTradingEnabled: true, runtimeEnabled: true, platformPause: null, linkedAccounts: [], executionAccountId: '', subscriptionStatus: 'free' },
      note: PLAN_NO_EXECUTION_NOTE,
      shares: /plan does not include automatic execution/,
      // The one pair that can be compared word for word, because both halves were written from the same rule.
      exact: PLAN_NO_EXECUTION_NOTE,
    },
    {
      name: 'no trading account',
      banner: { autoTradingEnabled: true, runtimeEnabled: true, platformPause: null, linkedAccounts: [], executionAccountId: '', subscriptionStatus: 'active' },
      note: NO_ACCOUNT_NOTE,
      shares: /no trading account is connected/,
    },
    {
      name: 'account not ready',
      banner: { autoTradingEnabled: true, runtimeEnabled: true, platformPause: null, linkedAccounts: [{ metaApiAccountId: 'acct-1', state: 'STOPPED' }], executionAccountId: 'acct-1', subscriptionStatus: 'active' },
      note: ACCOUNT_NOT_READY_NOTE,
      shares: /account|deploy/i,
    },
  ];
  for (const entry of cases) {
    const view = autoTradingBannerView(entry.banner);
    if (entry.exact) {
      assert.equal(view.message, entry.exact, `${entry.name}: the banner and the row say the same sentence`);
    } else {
      assert.match(view.message, entry.shares, `${entry.name}: banner "${view.message}" and note "${entry.note}" name the same thing`);
      assert.match(entry.note, entry.shares, `${entry.name}: and so does the row`);
    }
    if (entry.note !== AUTO_TRADING_OFF_NOTE) {
      assert.equal(/Auto-Trading is off/.test(view.message), false, `${entry.name}: a switch that is on is never described as off`);
      if (entry.note !== AUTO_TRADING_OFF_NOTE) assert.match(entry.note, /Auto-Trading is on/, `${entry.name}: and the row does not blame the switch either`);
    }
  }
});

test('what the reader can fix is named before what nobody on this workspace can', () => {
  // The order the brief asks for: the plan and the account are told first, so a row is never explained by a
  // platform condition while the workspace itself has an open step.
  const nothing = { autoTradingEnabled: true, linkedAccounts: [], executionAccountId: '', subscriptionStatus: 'active' };
  assert.equal(autoTradingBannerView({ ...nothing, runtimeEnabled: false }).state, 'no-account', 'a service that cannot trade at all is still behind a missing account');
  assert.equal(autoTradingBannerView({ ...nothing, platformPause: { paused: true, reason: 'maintenance' } }).state, 'no-account');
  const ready = { autoTradingEnabled: true, linkedAccounts: [{ metaApiAccountId: 'acct-1', state: 'DEPLOYED' }], executionAccountId: 'acct-1', subscriptionStatus: 'active', runtimeEnabled: true };
  assert.equal(autoTradingBannerView({ ...ready, platformPause: { paused: true, reason: 'Volatility pause' } }).state, 'paused', 'with nothing else missing, the platform condition is the honest answer');
  assert.match(autoTradingBannerView({ ...ready, platformPause: { paused: true, reason: 'Volatility pause' } }).message, /Volatility pause/, 'and its reason travels with it');
  assert.equal(autoTradingBannerView(ready).state, 'ready');
  assert.equal(autoTradingBannerView({ autoTradingEnabled: false, linkedAccounts: [], executionAccountId: '', subscriptionStatus: 'free' }).state, 'off', 'a switch that is off needs no opinion about the plan');
});

test('the card never has to explain a blocker twice, in two directions', () => {
  // A row whose stored note still blames the switch, in a workspace that has since connected an account, is the
  // screenshot. The server re-decides it before it reaches here (`overlayLiveBlocker`); the client only shows
  // what it is given, and that division is what keeps the two from ever disagreeing about the cause.
  const source = readFileSync(path.join(here, '..', 'src', 'lib', 'signal-outcome.js'), 'utf8');
  assert.equal(/executionNote\s*=|signal\.executionNote\s*=/.test(source), false, 'the card does not write a note of its own');
  assert.match(source, /const note = friendlySignalNote\(stored\)/, 'it filters the note it was given');
});

test('the settings page repeats the plan sentence, and points at the plan', () => {
  const settings = { autoTradingEnabled: true, hasAcceptedRiskWarning: true, riskMode: 'fixed', riskPercent: 1, maxOpenPositions: 3, dailyLossLimit: 5, lotSizeMode: 'fixed', fixedLotSize: 0.1, maxDailyTrades: 10, executionAccountId: '', breakEvenEnabled: false, breakEvenTriggerPoints: 20, breakEvenOffsetPoints: 0, trailingStopEnabled: false, trailingStopDistancePoints: 10, multipleTargetHandling: 'first_target', limitOrderExpiryValue: 30, limitOrderExpiryUnit: 'minutes', maxSlippagePoints: null };
  const unpaid = renderToStaticMarkup(React.createElement(AdvancedSettings, {
    settings, accounts: [], trades: [], runtimeAvailable: true, platformPause: null, subscriptionStatus: 'free',
    onChange: () => {}, onSubmit: () => {}, onToggle: () => {}, onOpenTradingAccounts: () => {}, onOpenPlan: () => {},
  }));
  assert.match(unpaid, /your plan does not include automatic execution\. Upgrade to execute signals\./, 'the same sentence the row carries, beside the switch');
  assert.match(unpaid, /data-state="plan"/, 'labelled with the state it is in');
  assert.match(unpaid, /Open Billing/, 'with the way out of it');
  const paid = renderToStaticMarkup(React.createElement(AdvancedSettings, {
    settings, accounts: [], trades: [], runtimeAvailable: true, platformPause: null, subscriptionStatus: 'active',
    onChange: () => {}, onSubmit: () => {}, onToggle: () => {}, onOpenTradingAccounts: () => {}, onOpenPlan: () => {},
  }));
  assert.equal(/plan does not include automatic execution/.test(paid), false, 'and it stops saying it when the plan does include execution');
  assert.match(paid, /no trading account is connected/, 'the account sentence takes its place');
});

test('an order outcome and an account note are read by the same rule as a signal row', () => {
  const settings = { autoTradingEnabled: true, hasAcceptedRiskWarning: true, riskMode: 'fixed', riskPercent: 1, maxOpenPositions: 3, dailyLossLimit: 5, lotSizeMode: 'fixed', fixedLotSize: 0.1, maxDailyTrades: 10, executionAccountId: 'acct-1', breakEvenEnabled: true, breakEvenTriggerPoints: 20, breakEvenOffsetPoints: 0, trailingStopEnabled: false, trailingStopDistancePoints: 10, multipleTargetHandling: 'first_target', limitOrderExpiryValue: 30, limitOrderExpiryUnit: 'minutes', maxSlippagePoints: null };
  const trade = { id: 't-1', side: 'buy', symbol: 'XAUUSD', quantity: 0.1, status: 'rejected', createdAt: '2026-10-25T09:00:00.000Z', remainingVolume: null, breakEvenStatus: 'failed', breakEvenError: 'Move modification failed with HTTP 502 from the trading gateway', errorMessage: 'MetaAPI returned TRADE_RETCODE_NO_MONEY (10019) for XAUUSD' };
  const markup = renderToStaticMarkup(React.createElement(AdvancedSettings, {
    settings, accounts: [{ metaApiAccountId: 'acct-1', state: 'DEPLOYED', executionNote: 'Copy trading could not start.' }],
    trades: [trade], runtimeAvailable: true, platformPause: null, subscriptionStatus: 'active',
    onChange: () => {}, onSubmit: () => {}, onToggle: () => {}, onOpenTradingAccounts: () => {}, onOpenPlan: () => {},
  }));
  assert.equal(FORBIDDEN.test(visibleText(markup)), false, 'no status code, endpoint or provider sentence reaches the settings page');
  assert.match(markup, /The broker declined this order\.|The platform could not finish processing it\./, 'and each raw answer is replaced by a sentence about the order');
  // The account card fetches its own rows, so it is pinned where the field is rendered rather than in markup.
  assert.match(metaApiPanelSource, /friendlySignalNote\(account\.executionNote\)/, 'the account note goes through the same filter');
});
