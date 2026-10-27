/**
 * Opening a Flutterwave payment from the browser, in the shape the billing page wants:
 *
 *     const flutterwave = useFlutterwave();
 *     await flutterwave.start(result.checkout);
 *
 * There is deliberately no `flutterwave-react-v3` here. That package was read before it was rejected: its
 * payment callback builds an analytics string out of the account's public key and posts it to the author's own
 * AWS endpoint, and it computes that string with `payment_options.split(',')`, which throws when - as here -
 * `payment_options` is not part of the request. A payment step that leaks which accounts are being paid and
 * crashes on a field we never sent is not a dependency worth taking, so this file talks to the script
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
  return {
    public_key: checkout?.publicKey || undefined,
    tx_ref: checkout?.reference,
    amount: typeof amount === 'number' ? String(amount) : amount,
    currency: checkout?.currency,
    redirect_url: checkout?.redirectUrl,
    customer: { email: checkout?.customer?.email, fullname: checkout?.customer?.name || undefined },
    customization: { title: `Signal Desk ${checkout?.planName || 'plan'}`, description: 'Signal Desk subscription' },
    meta: { plan: checkout?.plan, payment_plan_bound: Boolean(checkout?.renewsAutomatically) },
    // Flutterwave recomputes this from its own copy of the four fields and refuses the charge if one is edited.
    payload_hash: checkout?.payloadHash || undefined,
  };
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
    if (open && checkout.publicKey) {
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
