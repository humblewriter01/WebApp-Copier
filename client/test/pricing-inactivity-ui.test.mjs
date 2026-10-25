import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const here = path.dirname(fileURLToPath(import.meta.url));
const outfile = path.join(here, '.tmp', 'pricing-inactivity.mjs');

// Both components are JSX, so one throwaway bundle per run exposes their helpers and
// their rendered markup to node:test. React stays external to share this process' copy.
await build({
  stdin: {
    contents: [
      "export { default as BillingPage, nextPlanKey, PLAN_ORDER } from './BillingPage.jsx';",
      "export { default as MetaApiPanel, idleWarnings } from './MetaApiPanel.jsx';",
      "export { MetaApiStatusContext, metaApiStatusReducer, staticMetaApiStatusValue } from './MetaApiStatus.jsx';",
    ].join('\n'),
    resolveDir: path.join(here, '..', 'src', 'components'),
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

const { BillingPage, nextPlanKey, PLAN_ORDER, MetaApiPanel, idleWarnings, MetaApiStatusContext, metaApiStatusReducer, staticMetaApiStatusValue } = await import(pathToFileURL(outfile).href);

// The panel refuses to speak about account setup until the shared status answers, so tests
// that care about the rest of the page mount a provider that already knows the answer.
const withSetup = (available, element) => renderToStaticMarkup(React.createElement(
  MetaApiStatusContext.Provider,
  { value: staticMetaApiStatusValue(metaApiStatusReducer(undefined, { type: 'resolve', payload: { available }, at: 1 })) },
  element,
));
const sources = {
  billing: readFileSync(path.join(here, '..', 'src', 'components', 'BillingPage.jsx'), 'utf8'),
  accounts: readFileSync(path.join(here, '..', 'src', 'components', 'MetaApiPanel.jsx'), 'utf8'),
};

const paidPlans = [
  { key: 'starter', name: 'Starter', description: 'One automated account.', amountMinor: 6_000_000, amount: 60_000, currency: 'NGN', interval: 'monthly', limits: { maxTradingAccounts: 1, maxTelegramChannels: 10, maxDailySignals: 200 } },
  { key: 'pro', name: 'Pro', description: 'Busier channels.', amountMinor: 10_500_000, amount: 105_000, currency: 'NGN', interval: 'monthly', limits: { maxTradingAccounts: 3, maxTelegramChannels: 50, maxDailySignals: 500 } },
  { key: 'premium', name: 'Premium', description: 'Highest limits.', amountMinor: 15_000_000, amount: 150_000, currency: 'NGN', interval: 'monthly', limits: { maxTradingAccounts: 5, maxTelegramChannels: 100, maxDailySignals: 2000 } },
];

test('the next plan offered steps up one tier instead of jumping to the top', () => {
  assert.deepEqual([...PLAN_ORDER], ['free', 'starter', 'pro', 'premium']);
  assert.equal(nextPlanKey('free', paidPlans), 'starter');
  assert.equal(nextPlanKey('starter', paidPlans), 'pro');
  assert.equal(nextPlanKey('pro', paidPlans), 'premium');
  assert.equal(nextPlanKey('premium', paidPlans), 'premium', 'already at the top has nowhere to go');
  assert.equal(nextPlanKey('legacy', paidPlans), 'starter', 'an unknown plan picks the cheapest paid tier');
  assert.equal(nextPlanKey('premium', []), 'starter', 'no catalogue yet falls back to the entry plan');
});

test('the billing page sells the free tier as review-only and the three paid tiers', () => {
  // The plan cards are rendered from the API response inside an effect, so the copy that
  // is fixed in the component is asserted directly and the grid is asserted through props.
  assert.match(sources.billing, /<h3>Free<\/h3>/);
  assert.match(sources.billing, /No trading accounts/);
  assert.match(sources.billing, /No automated execution/);
  // The free card is the one plan card whose numbers are written in the component instead of read from the
  // catalogue, so it has to be re-pinned whenever Free changes - and it is pinned against the server file
  // that decides the number, not against a copy of it typed here.
  assert.match(sources.billing, /2 Telegram channels/);
  assert.match(sources.billing, /maxTelegramChannels \?\? 2\}/, 'the current-plan strip falls back to the number the server enforces');
  const freeCatalogue = readFileSync(path.join(here, '..', '..', 'server', 'services', 'billing.js'), 'utf8');
  assert.match(freeCatalogue, /maxTelegramChannels: 2\b/, 'the card says 2 because the catalogue says 2');
  assert.match(sources.billing, /50 signals per day/);
  assert.doesNotMatch(sources.billing, /<li>1 trading account<\/li>/, 'the old free allowance must not survive');
  assert.match(sources.billing, /Signal capture and review only\. Automated execution and trading accounts need a paid plan\./);
  assert.equal(typeof BillingPage, 'function');
});

test('a zero allowance reads as "No trading accounts" rather than "0 trading accounts"', () => {
  assert.match(sources.billing, /value === 0 \? 'No trading accounts'/);
  assert.match(sources.billing, /data\?\.limits\?\.maxTradingAccounts\)/, 'the current-plan strip uses the same formatter');
});

test('idle accounts are warned with a countdown and never warned for a paying subscriber', () => {
  const inactivity = { warningDays: 25, deletionDays: 30, daysInactive: 26, exempt: false, lastActiveAt: '2026-05-20T00:00:00.000Z' };
  const accounts = [
    { metaApiAccountId: 'a1', name: 'My MT5', managedByApp: true, inactivityStatus: 'warned', daysInactive: 26 },
    { metaApiAccountId: 'a2', name: 'Other', managedByApp: true, inactivityStatus: 'deferred', daysInactive: 33, inactivityReason: 'Not deleted: 2 open position(s) are still on this account.' },
    { metaApiAccountId: 'a3', name: 'Own token', managedByApp: false, inactivityStatus: 'warned', daysInactive: 40 },
    { metaApiAccountId: 'a4', name: 'Fresh', managedByApp: true, inactivityStatus: 'none', daysInactive: 2 },
  ];
  const warnings = idleWarnings({ accounts, inactivity });
  assert.equal(warnings.length, 2, 'only the swept accounts with a state to show');
  assert.match(warnings[0].text, /inactive for 26 days and will be permanently deleted in 4 days/);
  assert.match(warnings[0].text, /Sign in or run a trade to keep it/);
  assert.equal(warnings[0].tone, 'alert');
  assert.match(warnings[1].text, /was not deleted/);
  assert.match(warnings[1].text, /2 open position\(s\)/);
  assert.equal(warnings[1].tone, 'info');

  assert.deepEqual(idleWarnings({ accounts, inactivity: { ...inactivity, exempt: true } }), [], 'a subscriber is never threatened');
  assert.deepEqual(idleWarnings({ accounts, inactivity: null }), [], 'no policy loaded yet means no banner');
  assert.deepEqual(idleWarnings({ accounts: [], inactivity }), []);
});

test('the trading accounts page states the deletion policy near the add-account form', () => {
  assert.match(sources.accounts, /Idle accounts are cleaned up automatically/);
  assert.match(sources.accounts, /inactivity\?\.deletionDays \|\| 30/);
  assert.match(sources.accounts, /inactivity\?\.warningDays \|\| 25/);
  assert.match(sources.accounts, /paid plan is never\s*\n?\s*swept/);
  // An exempt workspace (paid plan or administrator) is told so, instead of being shown a
  // deletion promise that does not apply to it.
  assert.match(sources.accounts, /inactivity\?\.exempt/);
  assert.match(sources.accounts, /This workspace is exempt, so no account here is scheduled for deletion\./);
});

test('the rendered panel keeps its add-account form and policy note together', () => {
  const html = withSetup(true, React.createElement(MetaApiPanel, { token: 'test-token' }));
  assert.match(html, /Add an MT4\/MT5 account/);
  assert.match(html, /Create secure setup link/);
  assert.match(html, /Idle accounts are cleaned up automatically/);
  assert.match(html, /reset the clock|Sign in, save execution settings, or execute a signal to reset the clock/);
  assert.match(html, /Adding an account does not place a trade by itself/);
});
