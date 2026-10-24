/**
 * What a message's numbers mean, settled before anything is labelled.
 *
 * The parser used to scan the raw text for `\d+(\.\d+)?`, which silently mis-reads the money in three of
 * the shapes real channels write: `SL 1,0850` became a stop at **1.0850**, `SL 4,011.50` became **4**, and
 * `TP 50 pips` became a target *price* of **50**. Every one of those is a number that parses, so nothing
 * downstream objected: the stop sat on the correct side of the market and the risk arithmetic ran on a
 * distance of a whole chart. A price that cannot be read and is refused costs a review; a price that is
 * misread costs a trade.
 *
 * So the text is normalised once, here, and the parser only ever sees canonical dot-decimals:
 *
 *   - `4,512.50`, `1.085,00` - two separators, so the last is the decimal point and the rest is grouping,
 *     in whichever convention the writer was using;
 *   - `1,234,567` - every group is three digits, so it is grouping and nothing else;
 *   - `1,0850`, `2,50` - a comma followed by 1, 2, 4 or 5 digits is a decimal comma, because no market
 *     groups thousands in those widths;
 *   - `$4011.50`, `€4 011,50` - a currency mark and a spacing character are decoration on a number;
 *   - `140.512`, `1.085` - a single dot is a decimal point, always: three-decimal quotes are real
 *     (USDJPY), and reading `140.512` as 140512 would be the far rarer mistake;
 *   - `4,011` - one comma, exactly three digits. Genuinely either 4.011 or 4011, and the difference is a
 *     factor of a thousand on a stop. Settled by the message itself, and otherwise reported as ambiguous
 *     so the leg it sits on is reviewed rather than traded.
 *
 * Pips are not prices, and their unit is deliberately left in the text: the label scanners ask
 * `isPipDistance` about the number they matched and record a *distance* instead, because turning one into a
 * price needs the broker's own tick size, which does not exist until the order is being built.
 */

/**
 * A number, with the marks a writer may have put around it.
 *
 * Written as a literal rather than assembled from fragments on purpose: interpolating a character class
 * (`[ ]`) into a character class closes the outer one at its first `]`, and the resulting expression matches
 * `1,0` and `850` where it should have matched `1,0850` - a bug that looks like a working parser and reads
 * every European decimal as two numbers.
 *
 * The optional ` \d{3}` step inside is what lets `€4 011,50` stay one number: a space is only part of a
 * price when the three digits after it are the end of the run, so `SL 1.0800 (50 pips)` is still two.
 */
const NUMERIC_TOKEN = /[$€£₦₵¥₹]?\s?(\d[\d.,]*(?: \d{3}(?!\d))?[\d.,]*\d|\d)(?:\s?[$€£₦₵¥₹])?/gd;
/** `50 pips`, `30pts`, `40 points` - a distance stated in a unit, never a price. */
const PIP_UNIT = /^\s*(?:pips?|pts?|points?)(?![a-z])/i;
const CURRENCY_MARKS = /[$€£₦₵¥₹]/g;
const SPACING_CHARS = /[ \u00A0\u202F]/g;

const tailAfter = (token, separator) => {
  const index = token.lastIndexOf(separator);
  return index === -1 ? null : token.length - index - 1;
};

/**
 * The readings a single token permits, best first, and whether the choice was forced.
 *
 * `ambiguous: true` means both readings are defensible from the token alone, so the caller must settle it
 * against the message or hand it to a human.
 */
export function numberReadings(raw) {
  const token = String(raw).replace(CURRENCY_MARKS, '').replace(SPACING_CHARS, '');
  if (!/\d/.test(token)) return null;
  const commas = token.split(',').length - 1;
  const dots = token.split('.').length - 1;
  if (!commas && !dots) {
    const value = Number(token);
    return Number.isFinite(value) && value > 0 ? { value, candidates: [value], ambiguous: false } : null;
  }

  if (commas && dots) {
    // The last separator is the decimal point; what sits before it is grouping in some convention, and
    // removing it is the same operation whichever convention the writer was using.
    const at = token.lastIndexOf('.') > token.lastIndexOf(',') ? token.lastIndexOf('.') : token.lastIndexOf(',');
    const value = Number(`${token.slice(0, at).replace(/[.,]/g, '')}.${token.slice(at + 1)}`);
    return Number.isFinite(value) && value > 0 ? { value, candidates: [value], ambiguous: false } : null;
  }

  const separator = commas ? ',' : '.';
  const groups = token.split(separator);
  const tail = tailAfter(token, separator);

  if (separator === ',') {
    // Several comma groups of three digits can only be thousands: the decimal reading of `1,234,567`
    // would need two decimal points.
    if (commas > 1 && groups.every((group, index) => (index === 0 ? group.length >= 1 && group.length <= 3 : group.length === 3))) {
      const value = Number(groups.join(''));
      return Number.isFinite(value) && value > 0 ? { value, candidates: [value], ambiguous: false } : null;
    }
    if (tail === 3) {
      const asDecimal = Number(`${groups[0]}.${groups[1]}`);
      const asThousands = Number(groups.join(''));
      const candidates = [asDecimal, asThousands].filter((value) => Number.isFinite(value) && value > 0);
      if (!candidates.length) return null;
      // `1,085` reads as a decimal on digit count alone; only a two-way tie is a question.
      return { value: candidates[0], candidates, ambiguous: candidates.length > 1 };
    }
    const value = Number(token.replace(',', '.'));
    return Number.isFinite(value) && value > 0 ? { value, candidates: [value], ambiguous: false } : null;
  }

  // A single dot is a decimal point: `1.085`, `140.512`, `4011.50`.
  const value = Number(token);
  if (Number.isFinite(value) && value > 0) return { value, candidates: [value], ambiguous: false };
  // Repeated dots with no comma (`1.085.500`) are grouping with a decimal tail.
  const dotted = Number(`${groups.slice(0, -1).join('')}.${groups[groups.length - 1]}`);
  return Number.isFinite(dotted) && dotted > 0 ? { value: dotted, candidates: [dotted], ambiguous: false } : null;
}

/** Two numbers count as the same order of magnitude when they sit within about a decade of each other. */
const sameScale = (a, b) => Number.isFinite(a) && Number.isFinite(b) && a > 0 && b > 0 && Math.abs(Math.log10(a / b)) < 1.1;

/**
 * Rewrite a message so its prices are canonical, and report the readings that needed the message's help.
 *
 * Only the digits are replaced, so every label, colon and line break keeps its position relative to them -
 * which is what lets the label scanners keep matching `TP 1 : 4029.50` and index-aware separators untouched.
 *
 * An ambiguous token is settled by a vote among the numbers in the same message that are *not* in question:
 * the reading that agrees in magnitude with more of them wins, and it has to win outright. Counting votes
 * rather than taking the smallest or largest anchor is the difference between reading `SL 4,011` as 4011
 * beside a target of 4029.50, and being fooled by the `1` in `TP 1 :` or the ratio in `leverage 1:500` -
 * both of which are numbers a signal carries and neither of which is a price.
 */
export function normalizeSignalNumbers(text) {
  const source = String(text ?? '');
  const matches = [...source.matchAll(NUMERIC_TOKEN)];
  if (!matches.length) return { text: source, ambiguous: [] };

  const readings = matches.map((match) => numberReadings(match[1]));
  const anchors = readings.filter((read) => read && !read.ambiguous).map((read) => read.value);

  const ambiguous = [];
  let out = '';
  let cursor = 0;
  for (const [index, match] of matches.entries()) {
    const read = readings[index];
    const [start, end] = match.indices[1];
    out += source.slice(cursor, start);
    cursor = end;
    if (!read) { out += source.slice(start, end); continue; }
    let value = read.value;
    if (read.ambiguous && anchors.length) {
      const votes = read.candidates.map((candidate) => anchors.filter((anchor) => sameScale(candidate, anchor)).length);
      const best = Math.max(...votes);
      const winner = read.candidates[votes.indexOf(best)];
      // One vote against zero settles it; a tie does not, and neither does a lone anchor that both
      // readings can claim. The first candidate - the decimal - is then kept as the value to display,
      // and the leg is marked for review.
      if (best > 0 && votes.filter((count) => count === best).length === 1) value = winner;
      else ambiguous.push({ raw: match[1].trim(), value, candidates: [...read.candidates] });
    } else if (read.ambiguous) {
      ambiguous.push({ raw: match[1].trim(), value, candidates: [...read.candidates] });
    }
    out += String(Number(value.toFixed(8)));
  }
  out += source.slice(cursor);
  return { text: out, ambiguous };
}

/**
 * Whether the text right after a matched number states a distance rather than a price.
 *
 * `TP: 50 pips` and `SL 30pts` say how far, not where. The distance is carried to execution time, where
 * the broker's tick size turns it into a price; converting it here would be a guess about the symbol's
 * quote precision, and a factor-of-ten guess on a target is a trade that closes too early or too late with
 * nobody the wiser.
 */
export function isPipDistance(text, index) {
  const rest = String(text ?? '').slice(index, index + 16);
  return PIP_UNIT.test(rest);
}
