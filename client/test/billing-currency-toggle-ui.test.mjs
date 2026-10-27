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
      "export { checkoutRequest, checkoutPresentation, checkoutSurface, CURRENCY_CHECKOUT_PRESENTATION } from '../lib/flutterwave.js';",
      // The server's own rules, imported through the same bundle so the browser's fallback can be compared with
      // the table that produced the request rather than with a copy of it typed here.
      "export { checkoutPresentation as serverPresentation, CURRENCY_CHECKOUT_PRESENTATION as SERVER_RULES } from '../../../server/services/flutterwave.js';",
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

const { priceFor, pricedCurrencies, formatMoney, CurrencyToggle, checkoutRequest, checkoutPresentation, checkoutSurface, CURRENCY_CHECKOUT_PRESENTATION, serverPresentation, SERVER_RULES } = await import(pathToFileURL(outfile).href);
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

/* --------------------------------------------------------------- what the modal is configured to offer --------------------------------------------------------------- */

/** The checkout object `/api/billing/checkout` answers with, in each currency. */
const usdCheckout = {
  reference: 'sdb_user_1767312000_usd', link: 'https://checkout.flutterwave.com/pay/usd', amountMinor: 6_900, amount: 69, providerAmount: 69,
  currency: 'USD', country: 'US', paymentOptions: 'card', redirectUrl: 'https://app.example.test/billing/callback',
  publicKey: 'pk_test', payloadHash: 'hash', plan: 'pro', planName: 'Pro', renewsAutomatically: true,
  customer: { email: 'us@example.test', name: 'Trader' },
};
const nairaCheckout = { ...usdCheckout, currency: 'NGN', country: 'NG', paymentOptions: 'card,banktransfer,ussd', amountMinor: 10_500_000, amount: 105_000, providerAmount: 105_000, renewsAutomatically: false };

test('a dollar payment is configured as a card payment, in the country that settles dollars', () => {
  const config = checkoutRequest(usdCheckout);
  assert.equal(config.currency, 'USD', 'the toggled currency is the currency in the provider config - nothing else decides it');
  assert.equal(config.amount, '69');
  assert.equal(config.country, 'US');
  assert.equal(config.payment_options, 'card', 'bank transfer is a naira rail; a dollar price has to be paid by card');
});

test('a naira payment keeps the local rails, and is not quietly narrowed to cards', () => {
  const config = checkoutRequest(nairaCheckout);
  assert.equal(config.currency, 'NGN');
  assert.equal(config.amount, '105000');
  assert.equal(config.country, 'NG');
  assert.equal(config.payment_options, 'card,banktransfer,ussd');
});

test('a response that predates those fields still gets the right page, from the same rule', () => {
  // A tab left open across a deploy has no `country`/`paymentOptions` in its cached checkout object, and the
  // modal it opens must not be the one that caused this fix in the first place.
  const stale = { ...usdCheckout, country: undefined, paymentOptions: undefined };
  assert.deepEqual({ country: stale.country }, { country: undefined });
  const config = checkoutRequest(stale);
  assert.equal(config.country, 'US');
  assert.equal(config.payment_options, 'card');
  // `renewsAutomatically` is the browser's only clue that this charge is bound to a payment plan, and a bound
  // charge is card-only in either currency.
  const boundNaira = checkoutRequest({ ...nairaCheckout, paymentOptions: undefined, renewsAutomatically: true });
  assert.equal(boundNaira.payment_options, 'card');
  assert.equal(boundNaira.country, 'NG', 'the country is about the market, not about the method');
});

test('the browser and the server work off one table, not two that happen to agree today', () => {
  for (const code of ['NGN', 'USD', 'EUR', 'ngn', ' usd ', null, undefined]) {
    for (const planBound of [false, true]) {
      assert.deepEqual(
        checkoutPresentation(code, { planBound }),
        { ...serverPresentation(code, { planBound }) },
        `${String(code) || 'no currency'} (plan-bound: ${planBound}) must be presented identically by the request and by the modal`,
      );
    }
  }
  assert.deepEqual(Object.keys(CURRENCY_CHECKOUT_PRESENTATION).sort(), Object.keys(SERVER_RULES).sort(), 'the same currencies, no more');
  assert.deepEqual({ ...CURRENCY_CHECKOUT_PRESENTATION.USD }, { ...SERVER_RULES.USD });
  assert.deepEqual({ ...CURRENCY_CHECKOUT_PRESENTATION.NGN }, { ...SERVER_RULES.NGN });
});

test('an unnamed currency never opens a modal, and still uses the hosted link', () => {
  // `amount: 39` with no `currency` is Flutterwave charging the account default - thirty-nine naira for a
  // thirty-nine dollar plan - so the modal, whose config the browser writes, is refused. The link is not: it was
  // built by a server request that named its currency, so refusing it would only lose a sale that could happen.
  const sdk = () => {};
  assert.equal(checkoutSurface({ publicKey: 'pk', currency: 'USD', link: 'https://l' }, { sdk }), 'inline');
  assert.equal(checkoutSurface({ publicKey: 'pk', link: 'https://l' }, { sdk }), 'redirect', 'no currency, so no modal');
  assert.equal(checkoutSurface({ currency: 'USD', link: 'https://l' }, { sdk }), 'redirect', 'no public key, so no modal');
  assert.equal(checkoutSurface({ publicKey: 'pk', currency: 'USD', link: 'https://l' }, { sdk: null }), 'redirect', 'and no script, so no modal');
  assert.equal(checkoutRequest({ reference: 'r', amount: 39, providerAmount: 39 }).currency, undefined, 'the config never invents a currency of its own');
  assert.match(sources.flutterwave, /sdk && checkout\?\.publicKey && checkout\?\.currency/, 'the guard is one expression, not a comment about one');
});

/* What a trader is *shown* is the copy; a comment is where the machinery is explained to whoever maintains it.
   These assertions therefore read the file with its comments stripped, so "no payment-method vocabulary on the
   page" means what it says and a sentence like "the server divides by 100 here" stays legal where it belongs. */
const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('the billing page sends the currency and lets the provider payload carry the rest', () => {
  const copy = stripComments(sources.billing);
  assert.match(copy, /body: \{ plan: planKey, currency, promoCode/, 'the page states the currency once, in the request');
  assert.doesNotMatch(copy, /payment_options/, 'and never re-decides payment methods in the page itself');
  assert.doesNotMatch(copy, /country/i, 'no country is named to a customer, because a customer has no opinion about it');
  assert.doesNotMatch(copy, /bank ?transfer|banktransfer|ussd/i, 'the method list is provider vocabulary, and the modal is where methods are chosen');
});

test('the rendered currency control speaks in prices, not in payment rails', () => {
  const copy = stripComments(sources.billing);
  assert.match(copy, /Show prices in \$\{code === 'NGN' \? 'naira' : 'US dollars'\}/, 'a tooltip that names the currency is enough');
  assert.match(copy, /Not offered in this currency yet/);
  for (const jargon of ['kobo', 'payload_hash', 'tx_ref', 'access_code', 'plan_code', 'payment_plan', 'FlutterwaveCheckout', 'minor units']) {
    assert.equal(copy.includes(jargon), false, `"${jargon}" is vocabulary for logs and the Admin Panel, not for a trader's page`);
  }
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

  for (const jargon of ['kobo', 'payload_hash', 'access_code', 'plan_code', 'amountMinor, plan.currency', 'providerAmount']) {
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
