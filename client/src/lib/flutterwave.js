/**
 * Opening a Flutterwave payment from the browser, in the shape the billing page wants:
 *
 *     const flutterwave = useFlutterwave();
 *     await flutterwave.start(result.checkout);
 *
 * There is deliberately no `flutterwave-react-v3` here. That package was read before it was rejected: its
 * payment callback builds an analytics string out of the account's public key and posts it to the author's own
 * AWS endpoint, and it derives that string with `payment_options.split(',')` - a field that is easy for a
 * caller to leave out, and a crash when they do. A payment step that leaks which accounts are being paid and
 * breaks on a missing optional field is not a dependency worth taking, so this file talks to the script
 * Flutterwave itself hosts and nothing else.
 *
 * Two ways to pay, one behaviour:
 *
 * - Flutterwave's own inline modal, when `checkout.flutterwave.com/v3.js` loads and the server sent a public key.
 *   The fields are snake_case because that is the documented shape of `window.FlutterwaveCheckout`.
 * - The hosted link the server already got back from `POST /v3/payments` (`checkout.link`), which is what every
 *   browser gets if the modal script is blocked, slow, or unavailable.
 *
 * Both carry the same `tx_ref`, the same amount and the same currency, and both come back to `redirect_url`,
 * where the server re-verifies the payment with Flutterwave before anything is granted. Nothing in this file
 * decides whether a plan was bought: it only opens the door the server built.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

const CHECKOUT_SRC = 'https://checkout.flutterwave.com/v3.js';
/** How long to wait for the provider's script before sending the visitor to the hosted page instead. */
const SDK_TIMEOUT_MS = 2500;

let sdkPromise = null;

/** Loads the provider script once per page, and never fails: a `null` result just means "use the link". */
export function loadCheckoutSdk() {
  if (typeof window === 'undefined') return Promise.resolve(null);
  if (window.FlutterwaveCheckout) return Promise.resolve(window.FlutterwaveCheckout);
  if (sdkPromise) return sdkPromise;
  sdkPromise = new Promise((resolve) => {
    const existing = document.querySelector(`script[src="${CHECKOUT_SRC}"]`);
    const script = existing || Object.assign(document.createElement('script'), { src: CHECKOUT_SRC, async: true });
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve(typeof window.FlutterwaveCheckout === 'function' ? window.FlutterwaveCheckout : null);
    };
    const timer = setTimeout(() => {
      settled = true;
      resolve(null);
    }, SDK_TIMEOUT_MS);
    script.addEventListener('load', () => { clearTimeout(timer); finish(); }, { once: true });
    script.addEventListener('error', () => { clearTimeout(timer); settled = true; resolve(null); }, { once: true });
    if (!existing) document.head.appendChild(script);
  });
  return sdkPromise;
}

/**
 * Which country the provider renders, and which payment methods it offers, per currency.
 *
 * Flutterwave infers both from the payer's IP when a checkout says nothing, and a Nigerian IP being shown the
 * Nigerian page is exactly the failure this exists to prevent: the dollar price was in the request, and the
 * modal still offered a naira bank transfer that cannot settle a USD charge. So both fields are set explicitly,
 * from the currency, on both halves of the payment - the server's `POST /v3/payments` body and this config.
 *
 * This table is a mirror of `CURRENCY_CHECKOUT_PRESENTATION` in `server/services/flutterwave.js`, and it exists
 * only for the case the server response predates those fields (a tab that was open across a deploy). The test
 * in `client/test/billing-currency-toggle-ui.test.mjs` imports both tables and fails if they ever disagree, so
 * the duplication is checked rather than trusted.
 */
export const CURRENCY_CHECKOUT_PRESENTATION = Object.freeze({
  NGN: Object.freeze({ country: 'NG', paymentOptions: 'card,banktransfer,ussd' }),
  USD: Object.freeze({ country: 'US', paymentOptions: 'card' }),
});

/** `card` only: a charge bound to a Flutterwave payment plan is settled by card each interval, in any currency. */
export const PLAN_BOUND_PAYMENT_OPTIONS = 'card';

export function checkoutPresentation(currency, { planBound = false } = {}) {
  const rule = CURRENCY_CHECKOUT_PRESENTATION[String(currency || '').toUpperCase().trim()] || null;
  return {
    country: rule ? rule.country : null,
    paymentOptions: planBound ? PLAN_BOUND_PAYMENT_OPTIONS : (rule ? rule.paymentOptions : null),
  };
}

/**
 * The one place a price is turned into something Flutterwave can charge.
 *
 * `amount` is the MAIN unit on purpose - Flutterwave is told `60000` for ₦60,000 and `39` for $39, while every
 * number this app stores and compares is hundredths. The server already made that division (`providerAmount`);
 * re-dividing a minor-unit figure here, or sending `amountMinor` as the old Paystack integration did, is how a
 * customer gets charged a hundred times the plan price - so if `providerAmount` is missing this falls back to
 * the server's own `amount` rather than inventing a unit from `amountMinor`.
 */
export function checkoutRequest(checkout) {
  const amount = checkout?.providerAmount ?? checkout?.amount;
  /* The server sends the country and the allowed methods with the price; a response that predates those fields
     falls back to the mirrored table so an old tab still opens the right page. */
  const inferred = checkoutPresentation(checkout?.currency, { planBound: Boolean(checkout?.renewsAutomatically) });
  const presented = {
    // Field by field, so a response that carries one but not the other is completed rather than overridden: the
    // server's value always wins, and the rule only fills a gap a deploy left behind.
    country: checkout?.country || inferred.country,
    paymentOptions: checkout?.paymentOptions || inferred.paymentOptions,
  };
  return {
    public_key: checkout?.publicKey || undefined,
    tx_ref: checkout?.reference,
    amount: typeof amount === 'number' ? String(amount) : amount,
    currency: checkout?.currency,
    // Both fields are what stop the provider guessing a payment method from the payer's IP address.
    ...(presented.country ? { country: presented.country } : {}),
    ...(presented.paymentOptions ? { payment_options: presented.paymentOptions } : {}),
    redirect_url: checkout?.redirectUrl,
    customer: { email: checkout?.customer?.email, fullname: checkout?.customer?.name || undefined },
    customization: { title: `Signal Desk ${checkout?.planName || 'plan'}`, description: 'Signal Desk subscription' },
    meta: { plan: checkout?.plan, payment_plan_bound: Boolean(checkout?.renewsAutomatically) },
    // Flutterwave recomputes this from its own copy of the four fields and refuses the charge if one is edited.
    payload_hash: checkout?.payloadHash || undefined,
  };
}

/**
 * Which of the two payment surfaces a checkout can be opened on - decided in one place so the rule is testable.
 *
 * The inline modal is configured here, in the browser, which is why it also needs the currency in the response:
 * an amount of `39` with no currency is Flutterwave charging whatever the account defaults to, and on a naira
 * account that is thirty-nine naira for a thirty-nine dollar plan. The hosted link is a different case - the
 * server's own `POST /v3/payments` call named its currency - so an incomplete response still opens a correct
 * page, and refusing it would turn a working payment into a dead end for nobody's benefit.
 */
export function checkoutSurface(checkout, { sdk = null } = {}) {
  return sdk && checkout?.publicKey && checkout?.currency ? 'inline' : 'redirect';
}

export function useFlutterwave() {
  const [sdk, setSdk] = useState(null);
  const [error, setError] = useState('');
  const opened = useRef(false);

  // Fetched lazily but announced early: a modal that only starts loading on click is a modal that misses the click.
  useEffect(() => {
    let cancelled = false;
    loadCheckoutSdk().then((value) => { if (!cancelled && value) setSdk(() => value); });
    return () => { cancelled = true; };
  }, []);

  const start = useCallback(async (checkout) => {
    setError('');
    if (!checkout?.reference) throw new Error('The payment session did not start correctly. Try again.');
    const open = sdk || await loadCheckoutSdk();
    if (checkoutSurface(checkout, { sdk: open }) === 'inline') {
      try {
        opened.current = true;
        open(checkoutRequest(checkout));
        return { mode: 'inline' };
      } catch {
        // A modal that refuses to open is a reason to redirect, not a reason to lose the sale.
        opened.current = false;
      }
    }
    const link = checkout.link || checkout.authorizationUrl;
    if (!link) throw new Error('Flutterwave did not return a checkout page. Try again in a moment.');
    window.location.assign(link);
    return { mode: 'redirect' };
  }, [sdk]);

  return { start, ready: Boolean(sdk), error, inline: Boolean(sdk) };
}

export default useFlutterwave;
