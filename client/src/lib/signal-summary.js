/**
 * Shortening a captured message for a summary screen.
 *
 * A signal row holds the whole Telegram message, up to 5000 characters, because capturing the message as it
 * arrived is the point - the Signals page has to be able to show what the channel actually said, including
 * the parts that were not a setup. On the Overview, the same text turns three rows into a screenful of news
 * bulletin, so the card says what it can and hands the rest to `View all`.
 *
 * The rule is deliberately not `slice(0, 150)`: a signal is written in lines (symbol, direction, entry,
 * stop, targets), and cutting mid-line loses the number that matters. So this takes the first few *lines*,
 * and only reaches for the character budget when a single line is itself a paragraph. Either way it reports
 * whether it cut, because the card is allowed to promise the full text only when some was actually removed.
 */

/** How many rows the Overview shows. The server caps the same list; neither is allowed to drift. */
export const DASHBOARD_SIGNAL_LIMIT = 3;
export const SIGNAL_SUMMARY_MAX_LINES = 3;
export const SIGNAL_SUMMARY_MAX_CHARACTERS = 150;

/** The punctuation a cut sentence must not be left holding. */
const TRAILING_DANGLE = /[\s,;:.\-–—"'([]+$/;

export function summarizeSignalMessage(message, { maxLines = SIGNAL_SUMMARY_MAX_LINES, maxCharacters = SIGNAL_SUMMARY_MAX_CHARACTERS } = {}) {
  const text = String(message ?? '').replace(/\r\n?/g, '\n');
  const lines = text.split('\n').filter((line) => line.trim() !== '');
  if (!lines.length) return { text: '', truncated: false };

  const kept = lines.slice(0, Math.max(1, maxLines));
  const droppedLines = lines.length > kept.length;
  let joined = kept.join('\n').trim();

  let truncated = droppedLines;
  if (joined.length > maxCharacters) {
    /* Cut at the last break that still leaves a real sentence, rather than at a fixed index: the difference
       between "TP2 1.0980 TP3" and "TP2 1.09…" is whether the reader can tell the card is a summary. */
    const window = joined.slice(0, maxCharacters);
    const boundary = Math.max(window.lastIndexOf(' '), window.lastIndexOf('\n'));
    const whole = boundary > Math.floor(maxCharacters * 0.5);
    joined = (whole ? window.slice(0, boundary) : window).replace(TRAILING_DANGLE, '');
    truncated = true;
  }
  return { text: truncated ? `${joined}…` : joined, truncated };
}
