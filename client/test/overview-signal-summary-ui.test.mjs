/**
 * The Overview card is a summary, and it has to look like one.
 *
 * Three things make that true, and each is easy to lose: the list is short, the text inside each row is
 * short, and the row still tells the reader where the rest of the message is. The first is the server's
 * `LIMIT 3`; this file checks that the client does not quietly undo it and that the other two are real.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  DASHBOARD_SIGNAL_LIMIT,
  SIGNAL_SUMMARY_MAX_CHARACTERS,
  SIGNAL_SUMMARY_MAX_LINES,
  summarizeSignalMessage,
} from '../src/lib/signal-summary.js';
import { signalHasTradingData } from '../src/lib/signal-outcome.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (relative) => readFileSync(path.join(here, '..', relative), 'utf8');
const table = read('src/components/SignalTable.jsx');
const app = read('src/App.jsx');
const styles = read('src/styles.css');
const serverModule = read('../server/services/dashboard-signals.js');

test('a summary keeps the lines of a signal and drops the paragraph after them', () => {
  const setup = 'BUY EURUSD\nEntry: 1.0850\nSL: 1.0800\nTP: 1.0950\n\nRead the full analysis in our VIP group, 40 members joined this week and our accuracy stands at 91 percent this month.';
  const { text, truncated } = summarizeSignalMessage(setup);
  assert.equal(truncated, true);
  assert.equal(text, 'BUY EURUSD\nEntry: 1.0850\nSL: 1.0800…', 'the first three lines, the ellipsis, and no trace of the promo below them');
  assert.equal(text.split('\n').length, SIGNAL_SUMMARY_MAX_LINES);
});

test('a short message is shown as it is, with nothing invented', () => {
  const { text, truncated } = summarizeSignalMessage('BUY XAUUSD\nEntry 3310\nSL 3295\n');
  assert.equal(truncated, false);
  assert.equal(text, 'BUY XAUUSD\nEntry 3310\nSL 3295', 'trailing blank lines are layout, not content, and a short card earns no ellipsis');

  const same = summarizeSignalMessage('SELL GBPJPY');
  assert.deepEqual(same, { text: 'SELL GBPJPY', truncated: false });
});

test('a one-line wall of news is cut at a word, not at an index', () => {
  const recap = `Weekly recap: we closed seven trades in profit this week, the drawdown stayed under two percent, our team added two new analysts, and next week we are planning a live session for members. ${'padding '.repeat(40)}`;
  const { text, truncated } = summarizeSignalMessage(recap);
  assert.equal(truncated, true);
  assert.ok(text.length <= SIGNAL_SUMMARY_MAX_CHARACTERS + 4, `the card stays inside its budget, got ${text.length}`);
  assert.match(text, /…$/);
  const kept = text.slice(0, -1);
  assert.equal(recap.startsWith(kept), true, 'the card quotes the real message from its first character');
  assert.equal(/[A-Za-z0-9]$/.test(kept) && !/[A-Za-z0-9]/.test(recap[kept.length] || ' '), true, 'and it stops between words, never inside one');
});

test('blank lines, carriage returns and nothing at all are handled', () => {
  assert.deepEqual(summarizeSignalMessage(''), { text: '', truncated: false });
  assert.deepEqual(summarizeSignalMessage(null), { text: '', truncated: false });
  assert.deepEqual(summarizeSignalMessage('   \n\n  '), { text: '', truncated: false });
  const crlf = summarizeSignalMessage('BUY EURUSD\r\nEntry: 1.0850\r\nSL: 1.0800');
  assert.equal(crlf.text, 'BUY EURUSD\nEntry: 1.0850\nSL: 1.0800', 'a Windows-copied message does not carry stray carriage returns into the card');
});

test('the client and the server agree on three, so neither screen can quietly widen', () => {
  assert.equal(DASHBOARD_SIGNAL_LIMIT, 3);
  assert.match(serverModule, /export const DASHBOARD_SIGNAL_LIMIT = 3;/, 'the same number, defined twice on purpose and pinned here');
  assert.match(serverModule, /entry_price IS NOT NULL OR stop_loss IS NOT NULL OR take_profit IS NOT NULL/, 'and the server asks a stricter question than this file does: a setup states a price');
  assert.equal(signalHasTradingData({ side: 'buy' }), true, 'which is not the same as the client\'s "did anything come out of this", and must not be conflated');
  assert.match(table, /signals\.slice\(0, DASHBOARD_SIGNAL_LIMIT\)/, 'a stale or wider payload still renders three rows');
});

test('the compact mode is what the Overview asks for, and the Signals page is not compacted', () => {
  assert.match(table, /compact = false/, 'the default is the full list, so the Signals page needs no change to keep showing everything');
  assert.match(table, /const summary = compact \? summarizeSignalMessage\(signal\.message\) : null/, 'truncation is opt-in per screen, not baked into the row');
  assert.match(table, /summary \? summary\.text : signal\.message/);
  assert.match(table, /\{\.\.\.\(summary\?\.truncated \? \{ title: signal\.message \} : \{\}\)\}/, 'the full message is a tooltip when, and only when, something was removed - spread, not a bare attribute, which is not valid JSX');
  assert.match(table, /signal-item-compact/, 'and the compact row is addressable in CSS');
  assert.match(styles, /\.signal-item-compact \.signal-message\{/, 'with its own tighter spacing');

  assert.match(app, /signals=\{dashboard\?\.signals \|\| \[\]\} compact/, 'the Overview panel passes it');
  assert.equal(app.includes('<SignalTable signals={signals} channelCount'), true, 'the Signals page still passes the whole array');
});

test('a fallback list says what it is, in one sentence', () => {
  assert.match(app, /dashboard\?\.signalsScope === 'recent' && dashboard\?\.signals\?\.length/, 'only when the server says it fell back, and only when there is something to explain');
  const note = app.match(/<p className="dashboard-signals-note">([^<]+)<\/p>/)?.[1];
  assert.ok(note, 'the panel carries the explanation next to the heading');
  assert.equal(note.endsWith('.'), true, 'one sentence');
  assert.equal(note.split(' ').length <= 22, true, `and short enough not to become the clutter it replaces (got ${note.split(' ').length} words)`);
  assert.doesNotMatch(app, /signalsScope === 'actionable'/, 'an actionable list needs no preamble at all');
});

/* --------------------------------------------------------------- the rendered card --------------------------------------------------------------- */

/* The rules above are about the code; this one is about the HTML, because a card that truncates correctly
   in a pure function and still prints five rows is exactly the bug this screen has had before. The component
   is bundled the way `telegram-status-ui.test.mjs` does it: the real `SignalTable`, rendered for real. */
const outfile = path.join(here, '.tmp', 'overview-signal-summary.mjs');
await build({
  stdin: {
    contents: "export { default as SignalTable } from './SignalTable.jsx';",
    resolveDir: path.join(here, '..', 'src', 'components'),
    loader: 'jsx',
  },
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'node',
  external: ['react'],
  define: { 'process.env.NODE_ENV': '"development"', 'import.meta.env': '{}' },
  logLevel: 'silent',
});
assert.ok(existsSync(outfile), 'the component bundle was produced');
const { SignalTable } = await import(pathToFileURL(outfile).href);

const SETUP = 'BUY EURUSD\nEntry: 1.0850\nSL: 1.0800\nTP: 1.0950';
const NOISE = 'Weekly recap: seven trades closed in profit, drawdown under two percent, two new analysts joined, and next week we run a live session for members of the VIP group.';
const fiveSignals = [
  { id: '1', symbol: 'EURUSD', side: 'buy', status: 'executed', channelTitle: 'FX Desk', message: SETUP, entryPrice: 1.085, createdAt: '2026-10-24T09:00:00.000Z' },
  { id: '2', symbol: null, status: 'unparsed', channelTitle: 'FX Desk', message: NOISE, createdAt: '2026-10-24T08:00:00.000Z' },
  { id: '3', symbol: 'XAUUSD', side: 'sell', status: 'skipped', channelTitle: 'Gold Signals', message: `${SETUP}\nMore detail follows in the channel post.`, createdAt: '2026-10-24T07:00:00.000Z' },
  { id: '4', symbol: 'GBPJPY', side: 'buy', status: 'received', channelTitle: 'FX Desk', message: 'SELL GBPJPY', createdAt: '2026-10-24T06:00:00.000Z' },
  { id: '5', symbol: 'USDJPY', side: 'sell', status: 'received', channelTitle: 'FX Desk', message: SETUP, createdAt: '2026-10-24T05:00:00.000Z' },
];
const render = (props) => renderToStaticMarkup(React.createElement(SignalTable, props));
const cards = (html) => (html.match(/<article class="signal-item/g) || []).length;

test('the compact list renders three cards, each with the head of its message', () => {
  const html = render({ signals: fiveSignals, compact: true });
  assert.equal(cards(html), 3, 'three, however many rows the payload carried');
  assert.match(html, /<article class="signal-item outcome-good signal-item-compact"/, 'and every one of them is a compact card');

  // Only what the reader sees, because the full text is deliberately present once - in the tooltip.
  const visible = [...html.matchAll(/<p class="signal-message"[^>]*>([\s\S]*?)<\/p>/g)].map((match) => match[1]);
  assert.equal(visible.length, 3, 'one message line per card, no more');
  assert.equal(visible[0], 'BUY EURUSD\nEntry: 1.0850\nSL: 1.0800…');
  assert.match(visible[1], /^Weekly recap: seven trades closed in profit/, 'a long single line is cut at a word, not at an index');
  assert.doesNotMatch(visible.join('|'), /VIP group/, 'and the tail of that line is not there at all');
  assert.equal(visible[0].includes('TP: 1.0950'), false, 'the fourth line of a setup stays on the Signals page');
  assert.ok(html.includes(`title="${SETUP}"`), 'and is one hover away from the card that needs it');
});

test('without compact the same rows are rendered whole, because that is the history screen', () => {
  const html = render({ signals: fiveSignals });
  assert.equal(cards(html), 5, 'every row the route returned');
  assert.ok(html.includes('TP: 1.0950'), 'the fourth line is there');
  assert.ok(html.includes(NOISE), 'and the recap is quoted in full, because the Signals page is where it belongs');
  assert.equal(html.includes('signal-item-compact'), false, 'no compact styling leaks into the full list');
  assert.equal(html.includes(`title="${SETUP}"`), false, 'and nothing is hidden, so nothing needs a tooltip');
});

test('a card is not made to look truncated when nothing was removed', () => {
  const html = render({ signals: [fiveSignals[3]], compact: true });
  assert.ok(html.includes('>SELL GBPJPY<'), 'a short message is printed as it is');
  assert.equal(html.includes('…'), false, 'no ellipsis for a thing that was never cut');
  assert.equal(/title="/.test(html), false, 'and no tooltip implying there is more');
});

test('the header of a card cannot be squeezed out of the screen by its own badges', () => {
  // The truncation moved the only long text in a card, which left the header as the thing that runs out of
  // room on a phone: a channel title on the left, four badges on the right, and no rule saying which one
  // gives way. It should be the title, never the state of the signal.
  /* The first answer to this was wrong in a way worth writing down: it made the badges rigid
     (`flex:0 0 auto`) so they would not be squeezed - and a container that cannot shrink is laid out at its
     content's full width, so its own `flex-wrap` had nothing narrower to wrap into, the row overflowed the
     card, and the one item that could give way was the title underneath it. Give way in two steps instead:
     the row may break, and the badge container may shrink. `signal-card-badge-row-ui.test.mjs` owns the
     detail; this is here so the rigid version cannot quietly return to this card. */
  assert.match(styles, /\.signal-top\{[^}]*flex-wrap:wrap/, 'the badges may drop onto a line of their own under the title');
  assert.match(styles, /\.signal-flags\{[^}]*flex:0 1 auto/, 'and the row may shrink to what the card can actually offer');
  assert.match(styles, /\.signal-top>div\{min-width:0\}/, 'the text side may shrink below its content, which is what makes an ellipsis possible at all');
  assert.match(styles, /\.signal-top strong,\.signal-source\{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap\}/, 'so a long channel name clips instead of pushing the outcome off the edge');
});
