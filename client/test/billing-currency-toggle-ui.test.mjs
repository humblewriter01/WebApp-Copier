/**
 * The currency switch on the billing page, and the numbers it changes.
 *
 * The toggle is the only part of the two-currency work a trader ever sees, so it is tested the way the rest of
 * this directory tests a component: the pure helpers are called, the rendered markup is asserted where a
 * component renders from props, and the copy that only appears after a fetch is pinned to the source it comes
 * from. Three things must stay true no matter what the API sends: naira is the default, the price shown and the
 * price charged are read from the same per-currency field, and the words that describe the machinery - kobo,
 * `tx_ref`, payload hashes, plan codes - never reach a trader's screen.
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
const outfile = path.join(here, '.tmp', 'billing-currency-toggle.mjs');

await build({
  stdin: {
    contents: [
      "export { default as BillingPage, priceFor, pricedCurrencies, formatMoney, CurrencyToggle } from './BillingPage.jsx';",
      "export { checkoutRequest } from '../lib/flutterwave.js';",
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

const { priceFor, pricedCurrencies, formatMoney, CurrencyToggle, checkoutRequest } = await import(pathToFileURL(outfile).href);
const sources = {
  billing: readFileSync(path.join(here, '..', 'src', 'components', 'BillingPage.jsx'), 'utf8'),
  callback: readFileSync(path.join(here, '..', 'src', 'components', 'BillingCallbackPage.jsx'), 'utf8'),
  flutterwave: readFileSync(path.join(here, '..', 'src', 'lib', 'flutterwave.js'), 'utf8'),
};

/** The `/api/billing/plans` payload shape, in the unit the server stores: hundredths. */
const plans = [
  {
    key: 'starter', name: 'Starter', description: 'One automated account.', interval: 'monthly', currency: 'NGN',
    amountMinor: 6_000_000, amount: 60_000, usdAmountMinor: 3_900, usdAmount: 39,
    prices: { NGN: { amountMinor: 6_000_000, currency: 'NGN' }, USD: { amountMinor: 3_900, currency: 'USD' } },
    renewsAutomatically: { NGN: true, USD: false }, limits: { maxTradingAccounts: 1, maxTelegramChannels: 10, maxDailySignals: 200 },
  },
  {
    key: 'pro', name: 'Pro', description: 'Busier channels.', interval: 'monthly', currency: 'NGN',
    amountMinor: 10_500_000, amount: 105_000, usdAmountMinor: 6_900, usdAmount: 69,
    prices: { NGN: { amountMinor: 10_500_000, currency: 'NGN' }, USD: { amountMinor: 6_900, currency: 'USD' } },
    renewsAutomatically: { NGN: true, USD: true }, limits: { maxTradingAccounts: 3, maxTelegramChannels: 50, maxDailySignals: 500 },
  },
];

/* ------------------------------------------------------------------ which price belongs to which currency ------------------------------------------------------------------ */

test('a price is read from the currency the visitor picked, not from whichever field is first', () => {
  assert.equal(priceFor(plans[0], 'NGN'), 6_000_000);
  assert.equal(priceFor(plans[0], 'usd'), 3_900);
  assert.equal(priceFor(plans[1], 'USD'), 6_900);
  // The fallbacks are what keeps an older API response readable, and they must not disagree with `prices`.
  assert.equal(priceFor({ key: 'pro', amountMinor: 1, usdAmountMinor: 2 }, 'USD'), 2);
  assert.equal(priceFor({ key: 'pro', amountMinor: 1 }, 'NGN'), 1);
  assert.equal(priceFor({ key: 'pro', amountMinor: null, usdAmountMinor: null }, 'USD'), null);
  assert.equal(priceFor(undefined, 'NGN'), null);
});

test('a currency nobody priced is not offered, and a half-priced catalogue still offers both', () => {
  assert.deepEqual(pricedCurrencies(plans), ['NGN', 'USD']);
  assert.deepEqual(pricedCurrencies([{ key: 'pro', amountMinor: 10_500_000, prices: { NGN: { amountMinor: 10_500_000 } } }]), ['NGN']);
  assert.deepEqual(pricedCurrencies([{ key: 'pro', usdAmountMinor: 6_900, amountMinor: null, prices: { USD: { amountMinor: 6_900 } } }]), ['USD']);
  assert.deepEqual(pricedCurrencies([]), []);
});

test('naira and dollars are printed as the money they are', () => {
  assert.equal(formatMoney(6_000_000, 'NGN'), '₦60,000.00');
  assert.equal(formatMoney(3_900, 'USD'), '$39.00');
  assert.equal(formatMoney(6_900, 'USD'), '$69.00');
  // The same digits in the other currency are different money, and the symbol says so.
  assert.notEqual(formatMoney(60_000, 'NGN'), formatMoney(60_000, 'USD'));
  assert.equal(formatMoney(0, 'NGN'), '₦0.00');
});

/* ---------------------------------------------------------------------------- the switch ---------------------------------------------------------------------------- */

test('the switch offers both currencies, pressed on naira, with dollars one click away', () => {
  const html = renderToStaticMarkup(React.createElement(CurrencyToggle, { value: 'NGN', available: ['NGN', 'USD'] }));
  assert.match(html, /aria-label="Price currency"/);
  assert.match(html, /class="billing-currency-button active"[^>]*aria-pressed="true"[^>]*>NGN</, 'naira is the default view');
  assert.match(html, /aria-pressed="false"[^>]*>USD</);
  assert.equal((html.match(/billing-currency-button/g) || []).length, 2, 'exactly two choices, no dropdown to open');
});

test('a currency with no price is shown, disabled, and titled honestly', () => {
  const html = renderToStaticMarkup(React.createElement(CurrencyToggle, { value: 'NGN', available: ['NGN'] }));
  const usd = html.slice(html.lastIndexOf('<button', html.indexOf('>USD<')), html.indexOf('>USD<'));
  assert.match(usd, /disabled=""/, 'it is visible and unpressable, which reads as "not yet", not as "broken"');
  assert.match(usd, /aria-pressed="false"/);
  assert.match(usd, /Not offered in this currency yet/);
  const naira = html.slice(html.lastIndexOf('<button', html.indexOf('>NGN<')), html.indexOf('>NGN<'));
  assert.doesNotMatch(naira, /disabled=""/);
  assert.match(naira, /Show prices in naira/, 'the currency that is available still explains what pressing it does');

  // A workspace that publishes one currency has nothing to switch between, and does not pretend otherwise.
  assert.equal(CurrencyToggle({ value: 'NGN', options: ['NGN'], available: ['NGN'] }), null, 'one option is not a choice');
});

/* --------------------------------------------------------------------- what the provider is told ---------------------------------------------------------------------- */

test('the checkout is opened with the major amount and the currency the visitor chose', () => {
  const naira = checkoutRequest({
    reference: 'sdb_user_1767312000_abc', link: 'https://checkout.flutterwave.com/pay/x', amountMinor: 6_000_000, amount: 60_000, providerAmount: 60_000,
    currency: 'NGN', redirectUrl: 'https://app.example.test/billing/callback', publicKey: 'pk_test', payloadHash: 'hash',
    plan: 'starter', planName: 'Starter', customer: { email: 'trader@example.test', name: 'Trader' },
  });
  assert.equal(naira.amount, '60000', 'Flutterwave is sent 60000 for ₦60,000 - the number the whole migration turns on');
  assert.equal(naira.currency, 'NGN');
  assert.equal(naira.tx_ref, 'sdb_user_1767312000_abc');
  assert.equal(naira.public_key, 'pk_test');
  assert.equal(naira.payload_hash, 'hash');
  assert.equal(naira.redirect_url, 'https://app.example.test/billing/callback');
  assert.deepEqual(naira.customer, { email: 'trader@example.test', fullname: 'Trader' });
  assert.equal('amountMinor' in naira, false, 'the hundredths figure never leaves the server');

  const dollars = checkoutRequest({
    reference: 'sdb_user_1767312000_def', amountMinor: 3_900, amount: 39, providerAmount: 39, currency: 'USD',
    redirectUrl: 'https://app.example.test/billing/callback', customer: { email: 'us@example.test' },
  });
  assert.equal(dollars.amount, '39');
  assert.equal(dollars.currency, 'USD');
  assert.equal(dollars.public_key, undefined, 'no public key means no modal, and the hosted link is used instead');
  assert.equal(dollars.payload_hash, undefined, 'a missing hash is left out rather than sent empty');
});

test('a provider amount is preferred over recomputing one in the browser', () => {
  // If only the stored figure is available the browser divides it; what must never happen is the stored figure
  // being sent as-is, which is the Paystack convention and a hundred times the price here.
  const only = checkoutRequest({ reference: 'r', amountMinor: 6_000_000, currency: 'NGN' });
  assert.equal(only.amount, undefined);
  assert.match(sources.flutterwave, /checkout\?\.providerAmount \?\? checkout\?\.amount/, 'and it is the server amount that is used first');
});

/* ------------------------------------------------------------------------ the copy a trader reads ------------------------------------------------------------------------ */

test('the billing page sends the currency it is showing and says nothing about the machinery', () => {
  assert.match(sources.billing, /body: \{ plan: planKey, currency, promoCode/, 'the checkout request carries the picked currency');
  assert.match(sources.billing, /&currency=\$\{encodeURIComponent\(quotedCurrency\)\}/, 'and so does the promo quote');
  assert.match(sources.billing, /const \[currency, setCurrency\] = useState\('NGN'\)/, 'naira first, before anything has loaded');
  assert.match(sources.billing, /priceFor\(plan, payCurrency\)/, 'a card is priced in the picked currency');
  assert.match(sources.billing, /Not sold in \{payCurrency\}/, 'and says so plainly when there is no price in it');
  assert.match(sources.billing, /unpriced \? `Unavailable in \$\{payCurrency\}`/, 'the button explains why it cannot be pressed');
  assert.match(sources.billing, /plan\.renewsAutomatically\?\.\[payCurrency\]/, 'renewal wording is per currency too, because the mirror is');
  assert.match(sources.billing, /Payments are processed by Flutterwave; Signal Desk never receives or stores your card details/);

  for (const jargon of ['kobo', 'payload_hash', 'tx_ref', 'access_code', 'plan_code', 'amountMinor, plan.currency', 'providerAmount']) {
    assert.equal(sources.billing.includes(jargon), false, `"${jargon}" is a word for logs and the admin panel, not for a trader's page`);
  }
});

test('the callback page reads the reference Flutterwave sends and never grants anything itself', () => {
  assert.match(sources.callback, /params\.get\('tx_ref'\)/, 'tx_ref is what the provider appends; the older spellings stay readable');
  assert.match(sources.callback, /params\.get\('reference'\) \|\| params\.get\('trxref'\)/);
  assert.match(sources.callback, /\/api\/billing\/verify\?reference=/, 'and the answer comes from the server, which asks Flutterwave');
  assert.match(sources.callback, /Flutterwave reported this payment as not completed/);
  assert.match(sources.callback, /Flutterwave has not confirmed this payment yet/);
  assert.equal(/paystack/i.test(sources.callback), false, 'the old provider is not mentioned to a customer');
});
