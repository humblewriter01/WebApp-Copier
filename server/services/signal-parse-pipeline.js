/**
 * The two layers, and who is allowed to believe what.
 *
 * Layer 1 (`signal-parser.js`) reads what is written. Layer 2 (`signal-llm.js`) reads what a model can work
 * out. Between them sits the rule this file exists to enforce, and it is the only interesting one:
 *
 *   **A model may complete a signal. It may not create one.**
 *
 * So the deterministic reading has to supply the instrument, the direction, and at least one price - the
 * three things that say "a trader told us to trade, and told us where" - before anything the model returns
 * can be used to make a message executable. The model can then fill a leg the channel forgot, which is
 * where it is genuinely good at its job. A message that only the model understood is still stored, still
 * shown, and still marked for a human, because the difference between those two cases is not intelligence,
 * it's provenance: nobody can look at a number a model produced and tell whether it was read or invented,
 * and a wrong stop loss does not announce itself before the order goes out.
 *
 * The second rule is about failure: every way Layer 2 can go wrong - not configured, no key, timed out,
 * refusing to guess, a price that isn't in the message - lands on the same outcome, which is *the row is
 * saved and not traded*. Not on a crash, not on a silent retry, and not on the deterministic result being
 * thrown away.
 */

import { parseSignal } from './signal-parser.js';
import { llmConfig, needsLayer2, llmParseSignal } from './signal-llm.js';

/** The legs a model may supply, and where each one lands on the row. */
const GAPS = [
  { key: 'symbol', from: (result) => result.symbol },
  { key: 'side', from: (result) => result.side },
  { key: 'entryPrice', from: (result) => result.entry },
  { key: 'stopLoss', from: (result) => result.stop_loss },
  { key: 'takeProfit', from: (result) => result.take_profit },
];

/** Blockers a filled leg actually answers. Everything else survives the merge, whatever the model said. */
const ANSWERABLE = {
  stopLoss: ['stop-loss-missing', 'stop-loss-invalid', 'stop-loss-pips-multiple'],
  takeProfit: ['take-profit-invalid', 'take-profit-pips-multiple'],
};

/**
 * What the deterministic layer read for itself: the instrument, a direction, and a price.
 *
 * `hasPriceLevel` counts a distance in pips as a price the channel stated, because it is one - the message
 * said how far, and that is a fact about the trader's intent that a model cannot improve on.
 */
function layer1Authority(parsed) {
  const hasPriceLevel = parsed.entryPrice !== null
    || parsed.entryRange !== null
    || parsed.stopLoss !== null
    || parsed.takeProfit !== null
    || parsed.stopLossPips !== null
    || parsed.takeProfitPips !== null;
  return { has: Boolean(parsed.symbol && parsed.side && hasPriceLevel), hasPriceLevel };
}

/**
 * Layer 1's reading, with whatever the model could legitimately complete.
 *
 * A number the model invented is already gone by the time this runs - `validateExtraction` checks every price
 * against the digits in the message. What is still possible is a *misread* of a number that is in the text:
 * `TP 50 pips` answered with a target of 50.0, which is why a leg Layer 1 already read as a distance is never
 * handed a price from here. The same protection covers the entry: a range the channel gave is kept rather
 * than replaced by a single price, because the bound is the conservative half of the instruction.
 */
function mergeGaps(layer1, fields, { pipValues }) {
  const merged = { ...layer1 };
  const filled = [];
  const dropped = [];
  for (const gap of GAPS) {
    // `gap.from` is the translation layer: the model answers with `stop_loss`, the row calls it `stopLoss`,
    // and reading one with the other's name is a bug that looks identical to a model that refused.
    const proposed = gap.from(fields);
    if (proposed === null || proposed === undefined) continue;
    if (layer1[gap.key] !== null && layer1[gap.key] !== undefined) continue;
    if (gap.key === 'entryPrice' && layer1.entryRange !== null) continue;
    if ((gap.key === 'stopLoss' || gap.key === 'takeProfit') && layer1[gap.key.endsWith('Loss') ? 'stopLossPips' : 'takeProfitPips'] !== null) continue;
    if (gap.key === 'takeProfit' && pipValues.has(Number(proposed))) {
      dropped.push({ key: gap.key, value: proposed, because: 'the message states this number as a distance, not a price' });
      continue;
    }
    merged[gap.key] = proposed;
    filled.push(gap.key);
    const missing = merged.missing ? { ...merged.missing } : null;
    if (missing && (gap.key === 'stopLoss' || gap.key === 'takeProfit' || gap.key === 'entryPrice')) {
      missing[gap.key === 'entryPrice' ? 'entryPrice' : gap.key] = false;
      merged.missing = missing;
    }
  }
  if (!filled.length) return { merged, filled, dropped };
  // Only the blockers the merge answered are set aside, and only when the leg it answers is now filled.
  const answered = new Set(filled.flatMap((key) => (ANSWERABLE[key] ?? []).filter(() => merged[key] !== null && merged[key] !== undefined)));
  merged.blockers = (layer1.blockers ?? []).filter((blocker) => !answered.has(blocker.code));
  merged.parseError = merged.blockers[0]?.message ?? null;
  merged.executionReady = merged.parseError === null;
  return { merged, filled, dropped };
}

/**
 * Read a captured message with both layers, and say what may be done with the result.
 *
 * `review.required` is the answer to "may this be traded without a human?". It is true for a message Layer 2
 * was asked about and could not settle, for one it settled only partly without the deterministic layer having
 * authority, and for a signal-shaped message when the model is switched off - because in that case the
 * channel did write a signal and nobody read it, which is worth a look rather than a shrug.
 */
export async function parseSignalTwoLayer(message, { source = 'telegram', config, fetchImpl, logger } = {}) {
  const layer1 = parseSignal(message);
  const base = {
    parsed: layer1,
    provenance: { llmUsed: false, parsedBy: 'regex', confidence: null, filled: [], dropped: [] },
    review: { required: false, reason: null, code: null },
    llm: null,
  };
  // A note the user typed for their own review is not a channel instruction, and sending it to a model would
  // cost a request to produce a row that cannot trade anyway.
  if (source !== 'telegram') return base;

  const settings = config ?? llmConfig();
  if (!needsLayer2(layer1)) return base;

  if (!settings.enabled) {
    return {
      ...base,
      review: {
        required: true,
        code: 'llm-disabled',
        reason: layer1.parseError
          || 'Part of this signal was written in a form the built-in reader could not finish, and the AI reading assistant is switched off.',
      },
    };
  }

  const result = await llmParseSignal(message, { config: settings, fetchImpl, logger });
  const provenance = { llmUsed: true, parsedBy: 'regex', confidence: null, filled: [], dropped: [] };
  if (!result.ok) {
    return {
      parsed: layer1,
      provenance,
      review: {
        required: true,
        code: result.code || 'refused',
        reason: result.reason || 'The AI reader could not finish this signal, so it was saved for review.',
      },
      llm: result,
    };
  }

  const pipValues = new Set([layer1.stopLossPips, layer1.takeProfitPips].filter((value) => value !== null).map(Number));
  const { merged, filled, dropped } = mergeGaps(layer1, result.fields, { pipValues });
  const authority = layer1Authority(layer1);
  const complete = merged.missing?.stopLoss !== true && merged.missing?.takeProfit !== true;
  const outcome = {
    parsed: merged,
    provenance: { ...provenance, parsedBy: filled.length ? 'llm' : 'regex', confidence: result.confidence ?? null, filled, dropped },
    review: { required: false, reason: null, code: null },
    llm: result,
  };
  if (!authority.has) {
    outcome.review = {
      required: true,
      code: 'llm-only-reading',
      reason: filled.length
        ? 'Only the AI reading assistant could make sense of this message, so it was saved for review and will not be traded automatically.'
        : (result.reason || layer1.parseError || 'The AI reader could not add anything usable to this message, so it was saved for review.'),
    };
  } else if (dropped.length) {
    // The model produced something we refused to use, on a leg that is therefore still incomplete. Saying so
    // is the difference between a row that looks read and one that was read.
    outcome.review = {
      required: true,
      code: 'llm-discarded',
      reason: `The AI reader's answer was not usable (${dropped[0].because}), so this signal was saved for review.`,
    };
  } else if (!complete && merged.blockers?.length) {
    outcome.review = { required: true, code: 'still-incomplete', reason: merged.parseError };
  }
  return outcome;
}

export { layer1Authority };
