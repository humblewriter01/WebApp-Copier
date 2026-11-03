/**
 * The page a stranger sees, and the two doors that lead away from it.
 *
 * Until this view existed, `App.jsx` answered "no token" with the sign-in card - so the first thing an unauthenticated
 * visitor met was "Welcome back", said to someone who had never been here, with no way to see the product, what a
 * workspace contains, or what it would do with their broker account. The fix has to keep a property the sign-in card
 * has and a marketing page usually loses: nothing may be asked of the visitor. So this file checks both halves - the
 * page that shows without a token, and the fact that it shows *by asking nothing*.
 *
 * `Landing` is mounted rather than string-rendered, because the doors are behaviour: a "Log in" that navigates to a
 * route this app does not have, or that renders a form which posts nowhere, would look correct in markup and be a
 * dead end on a phone.
 */
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import React from 'react';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(here, '..', 'src');
const outfile = path.join(here, '.tmp', 'landing-mounted.mjs');

await build({
  entryPoints: [path.join(srcDir, 'components', 'Landing.jsx')],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'node',
  external: ['react', 'react-dom', 'react-dom/client'],
  define: { 'process.env.NODE_ENV': '"development"', 'import.meta.env': JSON.stringify({ PROD: false, DEV: true, VITE_API_URL: '' }) },
  jsx: 'automatic',
  logLevel: 'silent',
});
assert.ok(existsSync(outfile), 'the landing bundle was produced');

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
for (const name of ['HTMLElement', 'HTMLInputElement', 'Element', 'Node', 'Event', 'MouseEvent', 'getComputedStyle']) {
  Object.defineProperty(globalThis, name, { value: dom.window[name], configurable: true, writable: true });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
after(() => dom.window.close());

const { createRoot } = await import('react-dom/client');
const act = (callback) => React.act(callback);
const { default: Landing } = await import(pathToFileURL(outfile).href);

const landingSource = readFileSync(path.join(srcDir, 'components', 'Landing.jsx'), 'utf8');
const appSource = readFileSync(path.join(srcDir, 'App.jsx'), 'utf8');
const authSource = readFileSync(path.join(srcDir, 'components', 'AuthScreen.jsx'), 'utf8');
const cssSource = readFileSync(path.join(srcDir, 'styles.css'), 'utf8');

async function mount(props = {}) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => { root.render(React.createElement(Landing, props)); });
  return { host, entered: [], unmount: () => act(() => root.unmount()) };
}
const text = (node) => (node?.textContent || '').replace(/\s+/g, ' ').trim();
const buttonNamed = (host, wanted) => [...host.querySelectorAll('button')].find((node) => text(node).toLowerCase() === wanted.toLowerCase());

test('the first screen explains the product instead of asking for a password', async () => {
  const { host, unmount } = await mount();
  const body = text(host);
  assert.match(body, /Telegram/i, 'what it reads is said on the first screen');
  assert.match(host.querySelector('h1').textContent, /order is already at the broker/, 'the headline is the promise, not a greeting');
  assert.doesNotMatch(body, /Welcome back/, 'nobody is welcomed back before they have been');
  assert.equal(host.querySelector('input[type="password"]'), null, 'no password field on the page a stranger reads');
  assert.equal(host.querySelector('form'), null, 'and no form at all, so there is nothing to submit prematurely');
  await unmount();
});

test('the hero explicitly promises channel-scoped read-only access and no passwords', async () => {
  const { host, unmount } = await mount();
  const note = host.querySelector('.landing-security-note');
  assert.equal(text(note), 'Read-only Telegram access. Signal Desk can only read the specific channels you pick. No passwords required.');
  assert.ok(note.querySelector('.landing-lock-icon[aria-hidden="true"]'), 'a quiet lock icon reinforces the reassurance');
  assert.doesNotMatch(text(host.querySelector('.landing-hero')), /Telegram session/i, 'the hero no longer implies a personal password or login session');
  await unmount();
});

test('the broker step gives the trade-only reassurance and the FAQ answers withdrawal concerns', async () => {
  const { host, unmount } = await mount();
  const brokerStep = host.querySelector('.landing-step:nth-child(3)');
  const note = brokerStep.querySelector('.broker-access-note-landing');
  assert.equal(text(note), 'Broker access is trade-only. We can place and close trades, but we can never withdraw funds. Disconnect anytime.');
  assert.ok(note.querySelector('svg[aria-hidden="true"]'), 'the shield-and-lock icon is decorative and paired with readable copy');
  assert.equal(text(brokerStep.querySelector('h3')), 'The order goes to your broker');

  const faq = [...host.querySelectorAll('.landing-faq-item')].find((item) => text(item.querySelector('h3')) === 'Can you withdraw my funds?');
  assert.ok(faq, 'the withdrawal question is directly findable in the FAQ');
  assert.equal(text(faq.querySelector('p')), 'No. We use trade-only access. We can place and close trades on your behalf, but we do not have withdrawal permissions. You can disconnect your account at any time.');
  await unmount();
});

test('the workspace is shown, and labelled as a picture', async () => {
  const { host, unmount } = await mount();
  const demo = host.querySelector('.landing-demo');
  assert.ok(demo, 'a mock workspace is part of the page, not an optional extra');
  assert.match(text(demo.querySelector('.landing-demo-tag')).toLowerCase(), /sample data/, 'it says what it is before anyone can mistake it');
  assert.doesNotMatch(text(demo).toLowerCase(), /usd balance|equity|deposit|withdraw/, 'a demo that quotes money someone could expect to see is a promise, and this page makes none');
  // The switch inside the picture is off. A mock that shows execution armed would teach the reader that arming is
  // the normal state of a new workspace, which is the exact assumption the other half of this change removes.
  const armed = demo.querySelector('.landing-switch')?.getAttribute('data-on');
  assert.equal(armed, 'false', 'the sample workspace is drawn with Auto-Trading off');
  assert.match(text(demo.querySelector('.landing-demo-note')), /off until you turn it on/i, 'and the note beside it says so');

  const market = demo.querySelector('.landing-signal-market');
  const review = demo.querySelector('.landing-signal-review');
  assert.match(text(market), /BUY EURUSD @ Market · SL 1\.0812 · TP 1\.0902/);
  assert.match(text(market), /EXECUTED/);
  assert.match(text(market), /Filled at 1\.0845 · 0\.4s after the post/);
  assert.match(text(review), /SELL US30 @ 34,250\.00 · SL 34,400\.00 · TP 34,000\.00/);
  assert.match(text(review), /PENDING/);
  assert.match(text(review), /Held for review/);
  assert.match(text(review), /Waiting for price to enter zone\. Nothing sent yet\./);
  const position = demo.querySelector('.landing-panel');
  assert.match(text(position), /EURUSD · BUY/);
  assert.match(text(position), /Fill price\s*1\.0845/);
  assert.match(text(position), /\+12\.50 USD/);
  await unmount();
});

test('Get Started and Log in open their named auth flows, with recovery kept inside login', async () => {
  const { host, entered, unmount } = await mount({ onEnterAuth: (mode) => entered.push(mode) });
  await act(async () => { buttonNamed(host, 'Get Started Free').click(); });
  assert.deepEqual(entered, ['register'], 'Get Started opens workspace creation');
  await act(async () => { buttonNamed(host, 'Log in').click(); });
  assert.deepEqual(entered, ['register', 'login'], 'Log in opens sign-in');
  assert.equal(buttonNamed(host, 'Forgotten a password?'), undefined, 'password recovery is not promoted on the public landing page');
  assert.match(authSource, /Forgot Password\?/i, 'the password recovery link remains in the actual login form');
  await unmount();
});

test('the install offer is the browser’s, not this page’s invention', async () => {
  const without = await mount();
  assert.equal(buttonNamed(without.host, 'Install Signal Desk'), undefined, 'with no prompt from the browser, no button is offered');
  await without.unmount();
  const withPrompt = await mount({ installPrompt: { prompt: async () => {} }, onInstall: () => {} });
  assert.ok(buttonNamed(withPrompt.host, 'Install Signal Desk'), 'and it appears when the browser has one to give');
  await withPrompt.unmount();
});

test('the page requests only public prices and never reads visitor credentials or storage', () => {
  for (const forbidden of ['localStorage', 'sessionStorage', 'signal-token', 'supabase', 'WebSocket']) {
    assert.ok(!landingSource.includes(forbidden), `the public landing view never touches ${forbidden}`);
  }
  assert.match(landingSource, /request\('\/api\/public\/pricing'\)/, 'only the public pricing endpoint is fetched');
  assert.match(landingSource, /catch\(\(\) => \{\}\)/, 'a pricing outage silently preserves the useful default cards');
  assert.match(landingSource, /useState\(DEFAULT_PRICING\)/, 'defaults render before the request completes');
});

test('the landing pricing defaults to USD and the NGN toggle still changes every displayed price', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => { throw new Error('offline'); };
    const { host, unmount } = await mount();
    const pricing = host.querySelector('.landing-pricing');
    assert.match(text(pricing), /\$39/, 'Starter shows its USD fallback immediately');
    assert.match(text(pricing), /\$69/, 'Pro shows its USD fallback immediately');
    assert.equal(pricing.querySelector('[aria-label="Pricing currency"] button[aria-pressed="true"]')?.textContent, 'USD');
    await act(async () => { buttonNamed(host, 'NGN').click(); });
    assert.equal(pricing.querySelector('[aria-label="Pricing currency"] button[aria-pressed="true"]')?.textContent, 'NGN');
    assert.match(text(pricing), /₦60,000/, 'the manual switch displays the naira Starter fallback');
    assert.match(text(pricing), /₦105,000/, 'and the naira Pro fallback');
    await unmount();
  } finally { globalThis.fetch = originalFetch; }
});

test('pricing defaults render on an API failure and live prices replace them on success', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => { throw new Error('offline'); };
    const fallback = await mount();
    assert.match(text(fallback.host.querySelector('.landing-pricing')), /\$39/, 'Starter has an immediate USD default price');
    assert.match(text(fallback.host.querySelector('.landing-pricing')), /\$69/, 'Pro has an immediate USD default price');
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.match(text(fallback.host.querySelector('.landing-pricing')), /\$39/, 'failure leaves the USD defaults in place');
    await fallback.unmount();

    globalThis.fetch = async () => new Response(JSON.stringify({ currency: 'USD', plans: [
      { key: 'starter', name: 'Starter', amount: 27, currency: 'USD', interval: 'monthly' },
      { key: 'pro', name: 'Pro', amount: 44, currency: 'USD', interval: 'monthly' },
      { key: 'premium', name: 'Premium', amount: 79, currency: 'USD', interval: 'monthly' },
    ] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    const live = await mount();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const prices = text(live.host.querySelector('.landing-pricing'));
    assert.match(prices, /\$27/);
    assert.match(prices, /\$44/);
    assert.match(prices, /\$79/);
    assert.doesNotMatch(prices, /₦105,000/);
    await live.unmount();
  } finally { globalThis.fetch = originalFetch; }
});

test('each pricing card states the plan limits a buyer is actually held to', async () => {
  // A price alone tells a visitor what a plan costs and nothing about what it allows, so the card has to carry the
  // same three numbers the authenticated billing page enforces: trading accounts, Telegram channels, daily signals.
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => { throw new Error('offline'); };
    const { host, unmount } = await mount();
    const cards = [...host.querySelectorAll('.landing-price-card')];
    assert.equal(cards.length, 4, 'four plans are shown');
    const limitsFor = (index) => [...cards[index].querySelectorAll('.landing-price-limits li')].map((node) => text(node));
    assert.deepEqual(limitsFor(0), ['0 trading accounts', '2 Telegram channels', '50 signals per day']);
    assert.deepEqual(limitsFor(1), ['1 trading account', '10 Telegram channels', '200 signals per day']);
    assert.deepEqual(limitsFor(2), ['3 trading accounts', '50 Telegram channels', '500 signals per day']);
    assert.deepEqual(limitsFor(3), ['5 trading accounts', '100 Telegram channels', '2000 signals per day']);
    assert.match(text(cards[1]), /10 Telegram channels/, 'the numbers are visible in the card, not only in the source');
    assert.match(cssSource, /\.landing-price-limits\{/, 'the list is styled rather than left as browser bullets');
    await unmount();
  } finally { globalThis.fetch = originalFetch; }
});

test('live prices replace the amounts without taking the limits or the toggle with them', async () => {
  // The limits are static copy; the money is not. A successful pricing fetch must not blank the lists, and the
  // currency toggle must keep working after it, because that is the mistake a rewrite of this section invites.
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ currency: 'USD', plans: [
      { key: 'starter', name: 'Starter', amount: 27, currency: 'USD', interval: 'monthly', prices: { USD: { amount: 27 }, NGN: { amount: 41000 } } },
    ] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    const { host, unmount } = await mount();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const pricing = host.querySelector('.landing-pricing');
    assert.match(text(pricing), /\$27/, 'the live Starter amount is what renders');
    assert.doesNotMatch(text(pricing), /\$39/, 'and the fallback amount has been replaced, not appended to');
    assert.match(text(pricing), /1 trading account10 Telegram channels/, 'the limits survive the live price swap');
    assert.match(text(pricing), /200 signals per day/);
    await act(async () => { buttonNamed(host, 'NGN').click(); });
    assert.match(text(pricing), /₦41,000/, 'the toggle still swaps the live amount into naira');
    assert.match(text(pricing), /5 trading accounts/, 'and the limits are still there afterwards');
    await unmount();
  } finally { globalThis.fetch = originalFetch; }
});

test('the language rule a trader’s notes are held to is held over the marketing copy too', async () => {
  // `user-note-language.test.mjs` keeps an HTTP status, a model name or an endpoint out of anything a person reads.
  // The landing view is read by more people than any panel in the app, so it gets the same rule, applied to the
  // rendered text rather than to the source, which is where a sentence actually becomes something somebody reads.
  const FORBIDDEN = /HTTP|api\.groq|gpt-oss|stack/i;
  const { host, unmount } = await mount();
  const shown = [...host.querySelectorAll('p,h1,h2,h3,h4,span,dd,dt,button,li')].map((node) => text(node));
  const offender = shown.find((sentence) => FORBIDDEN.test(sentence));
  assert.equal(offender, undefined, 'no status code, model name or endpoint in a sentence a stranger reads');
  assert.ok(shown.some((sentence) => /Telegram/.test(sentence)), 'while the thing it does is still said plainly');
  await unmount();
  assert.doesNotMatch(landingSource, />\s*Connect Telegram\s*</, 'and no button here is the sign-in call to action, which belongs to a workspace that has one to connect');
});

test('every class this view styles is a class the sheet defines', () => {
  const used = new Set(landingSource.match(/className="([^"]+)"/g).join(' ').split(/[\s"{}]+/).filter((name) => name.startsWith('landing-')));
  assert.ok(used.size >= 20, `${used.size} landing classes are in use, which is the whole point of the extra sheet`);
  const missing = [...used].filter((name) => !cssSource.includes(`.${name}`));
  assert.deepEqual(missing, [], `unstyled markup on the only page a stranger reads: ${missing.join(', ')}`);
  assert.match(cssSource, /@media\(max-width:940px\)\{\.landing-hero\{grid-template-columns:minmax\(0,1fr\)/, 'and the two-column hero collapses on a phone');
});

test('App shows this page to an unauthenticated visitor and the sign-in card only on request', () => {
  const gate = appSource.slice(appSource.indexOf('if (!authToken) {'), appSource.indexOf('if (loading)'));
  assert.ok(gate.length > 60 && gate.includes('if (loading)') === false, 'the landing branch is reached before the workspace starts loading, so a slow session check never flashes a spinner at a stranger');
  assert.match(gate, /if \(authIntent\) return <AuthScreen[\s\S]*initialMode=\{authIntent\}/, 'the card opens on the form the visitor asked for');
  assert.match(gate, /return <Landing onEnterAuth=\{setAuthIntent\}/, 'and the landing view is what an unasked visitor gets');
  assert.ok(appSource.indexOf('return <Landing') < appSource.indexOf('if (loading)'), 'in that order');
  // The card is reachable in both directions: a way back is what makes an overview page safe to show first.
  assert.match(appSource, /onBackToOverview=\{\(\) => setAuthIntent\(null\)\}/, 'a visitor who came in through the wrong door can go back out');
  assert.match(appSource, /if \(normalizedPath === '\/billing\/callback'\) return authToken\n\s*\? <BillingCallbackPage \/>\n\s*: <AuthScreen/, 'a callback keeps its sign-in card - nobody arrives there to browse');
  assert.match(appSource, /autoTradingEnabled: false/, 'the client’s own idea of a new workspace is an unarmed one, agreeing with the column default');
});
