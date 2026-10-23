/**
 * The difference between "the service said no" and "nobody was home".
 *
 * A host that stops between visitors answers the first write after a quiet period with a gateway page
 * - 502, 503, 504 - or by closing the socket while the service is still starting, which `fetch` reports
 * as a `TypeError` with no status at all. Neither of those is a refusal of what was asked, and an
 * administrator watching a Suspend button fail has no way to know that sending it once more a few
 * seconds later would have worked. So this file decides, in one place, which failures deserve exactly
 * one more attempt: those where no answer came back. A refusal that carries the service's own sentence
 * is never repeated, because the second attempt would fail the same way and only delay the answer.
 *
 * It is a separate module rather than a few lines in `api.js` because `api.js` reads `import.meta.env`
 * for the API origin, and this rule - and the retry budget - is the part worth testing on its own.
 */
export const UNANSWERED_STATUSES = Object.freeze([502, 503, 504]);
export const WAKE_RETRY_DELAY_MS = 4000;

/** True when the request never reached something that could answer it. */
export function isUnansweredRequestFailure(error) {
  if (!error) return false;
  if (error.name === 'TypeError') return true;
  return UNANSWERED_STATUSES.includes(Number(error.status)) && error.answered === false;
}

/**
 * Run `send` once, and a second time only if the first attempt was never answered.
 *
 * `sleep` is a parameter because the wait is the behaviour under test: it has to happen between the two
 * attempts, and a test should not have to wait four seconds to prove it. When the retry also goes
 * unanswered the error is marked `wakeRetried` and given the one sentence that is true at that point -
 * the change was not applied, and this time the reason is known.
 */
export async function withWakeRetry(send, { retryDelayMs = WAKE_RETRY_DELAY_MS, sleep, now = () => Date.now(), describeWait } = {}) {
  const wait = typeof sleep === 'function' ? sleep : (ms) => new Promise((resolve) => { setTimeout(resolve, Math.max(0, Number(ms) || 0)); });
  let firstError;
  try {
    return await send();
  } catch (error) {
    if (!isUnansweredRequestFailure(error)) throw error;
    firstError = error;
  }
  const startedAt = now();
  await wait(Math.max(0, Number(retryDelayMs) || 0));
  try {
    return await send();
  } catch (retryError) {
    if (!isUnansweredRequestFailure(retryError)) throw retryError;
    retryError.wakeRetried = true;
    retryError.wakeRetryWaitedMs = Math.max(0, now() - startedAt);
    const said = typeof firstError?.message === 'string' && firstError.message.trim() ? firstError.message.trim() : '';
    retryError.message = `${said} ${describeWait ? describeWait() : 'The service did not answer either attempt, which is what a host that is still waking up looks like - nothing was changed.'}`.trim();
    throw retryError;
  }
}
