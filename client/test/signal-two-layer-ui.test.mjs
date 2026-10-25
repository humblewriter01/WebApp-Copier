/**
 * What the reader is told about a row the platform is not sure of.
 *
 * The server now records three things the Signals page did not previously have: that a model helped read the
 * message (`llmUsed` / `parsedBy` / `parseConfidence`), that the row is held for a human (`needsReview`), and
 * that a leg was written as a distance in pips rather than a price (`stopLossPips` / `takeProfitPips`).
 * Each of those has to be visible, for a different reason:
 *
 *   - **AI Parsed** is provenance. A price a model reported can be exactly right and still deserve a second
 *     pair of eyes, because "the model read it" is the one fact a reader cannot recover from the number.
 *   - **Needs Review** is a state, and it must not be confused with "no clear signal": the first means the
 *     platform read the message and will not act on it, the second means the message said nothing.
 *   - **TP 50 pips** in the meta line is the dangerous one. A distance rendered as a price - "TP 50" - is a
 *     number that looks like a level and is not one, which is how a reader ends up trusting a row that has
 *     no target at all yet.
 *
 * Rendering is real (esbuild + `renderToStaticMarkup`) rather than a source grep, and the layout claim is
 * read off the stylesheet's cascade, because there is no browser here and an invented layout engine would
 * agree with whatever it was written against.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { signalBadges, signalHasTradingData, signalOutcomeView } from '../src/lib/signal-outcome.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const css = readFileSync(path.join(here, '..', 'src', 'styles.css'), 'utf8');
const escapeRe = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Every declaration block written for exactly this selector, in source order, at a rule boundary. */
function blocks(selector) {
  const pattern = new RegExp(`(?:^|(?<=\\})|(?<=\\n))${escapeRe(selector)}\\{([^}]*)\\}`, 'gm');
  return [...css.matchAll(pattern)].map((match) => match[1]);
}

/** What the browser ends up with: later blocks win, property by property. */
function declared(selector) {
  const merged = {};
  for (const block of blocks(selector)) {
    for (const part of block.split(';')) {
      const colon = part.indexOf(':');
      if (colon > 0) merged[part.slice(0, colon).trim()] = part.slice(colon + 1).trim();
    }
  }
  assert.ok(Object.keys(merged).length > 0, `${selector} is styled somewhere in styles.css`);
  return merged;
}

/* -------------------------------------- the AI badge is provenance -------------------------------------- */

test('a row a model helped read says so, with the confidence it reported', () => {
  const assisted = {
    source: 'telegram', symbol: 'XAUUSD', side: 'buy', entryPrice: null, stopLoss: 4011.5, takeProfit: 4050,
    llmUsed: true, parsedBy: 'llm', parseConfidence: 0.95, needsReview: false,
  };
  const [badge] = signalBadges(assisted).filter((item) => item.key === 'ai');
  assert.ok(badge, 'the badge is on the row, not buried in its note');
  assert.equal(badge.label, 'AI Parsed');
  assert.equal(badge.tone, 'ai');
  assert.match(badge.title, /95% confidence/, 'the number the model reported is on the hover text, so a reader can weigh the badge instead of taking it on faith');
  assert.match(badge.title, /checked against the digits in the message/, 'and it says what was verified, not just who did it');

  // A row the model was *asked* about and could not help with carries no such claim: nothing was filled in.
  const asked = { ...assisted, parsedBy: 'regex', parseConfidence: 0.4 };
  assert.equal(signalBadges(asked).some((item) => item.key === 'ai'), false, 'consulting the fallback layer is not the same as being read by it');
});

test('the badge has a colour of its own, later in the cascade than the base pill', () => {
  const tone = declared('.signal-flag-badge.tone-ai');
  assert.match(tone.background, /^#f/i, 'a pale purple, distinct from the warn amber and the good green the other tones already own');
  assert.match(tone.color, /^#6/i, 'with ink dark enough to read on it');
  const base = css.indexOf('.signal-flag-badge{');
  const ai = css.indexOf('.signal-flag-badge.tone-ai{');
  assert.ok(base > -1 && ai > base, 'a tone declared before the base rule would be painted over by it');
});

/* --------------------------------------- review is not "unclear" --------------------------------------- */

test('needs-review is its own state, and is never reported as a failed read', () => {
  const held = { status: 'unparsed', source: 'telegram', symbol: 'EURUSD', side: 'buy', entryPrice: 1.085, stopLoss: 1.08, takeProfit: null, needsReview: true };
  const view = signalOutcomeView(held);
  assert.equal(view.label, 'Needs Review', 'the flag outranks the status wording, because it is the actionable fact');
  assert.equal(view.tone, 'warn', 'and it is not a quiet grey: a row that will not trade on its own should look like it is waiting');

  const unclear = { status: 'unparsed', source: 'telegram', message: 'good morning everyone' };
  assert.equal(signalOutcomeView(unclear).label, 'No clear signal', 'a message that said nothing about a trade is still a different thing');

  /* A row blocked for review has a price on it, so the trading-data test has to answer true: that is the
     difference between "the parser found something and refused it" and "the parser found nothing". */
  assert.equal(signalHasTradingData(held), true);
  assert.equal(signalHasTradingData(unclear), false);
});

/* ------------------------------------------ pips, kept honest ------------------------------------------ */

test('a leg stated as a distance is badgeable, and is never called missing', () => {
  const pips = {
    source: 'telegram', symbol: 'EURUSD', side: 'buy', entryPrice: 1.085, stopLoss: 1.08, takeProfit: null,
    takeProfitPips: 50, needsReview: false,
  };
  const badges = signalBadges(pips);
  const target = badges.find((item) => item.key === 'pips-target');
  assert.equal(target.label, 'Pips TP 50', 'the distance is on the badge, so the row can be read without opening the message');
  assert.match(target.title, /measured from the market price at the moment the order goes out/);
  assert.equal(badges.some((item) => item.key === 'missing-target'), false, 'and the reader is not told to go set a fallback for a leg the channel did state');
  assert.equal(badges.some((item) => item.key === 'market'), false, 'and no "Market" badge either, because this message did name an entry');
  // The market pill belongs to a row that named levels and not an entry - including when those levels are distances.
  const noEntry = { source: 'telegram', symbol: 'EURUSD', side: 'buy', entryPrice: null, stopLoss: null, takeProfit: null, takeProfitPips: 50 };
  assert.equal(signalBadges(noEntry).some((item) => item.key === 'market'), true, 'a pip target is still a stated level, which is what makes this a market order rather than an empty row');

  const stopOnly = { source: 'telegram', symbol: 'XAUUSD', side: 'buy', entryPrice: null, stopLoss: null, stopLossPips: 30, takeProfit: null };
  assert.equal(signalBadges(stopOnly).some((item) => item.key === 'missing-stop'), false, 'a stop of 30 pips is a stop');
});

/* ------------------------------------------- the real render ------------------------------------------- */

async function bundle(name) {
  const outfile = path.join(here, '.tmp', `${name}.mjs`);
  await build({
    entryPoints: [path.join(here, '..', 'src', name.includes('/') ? name : path.join('components', name))],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    external: ['react', 'react-dom'],
    define: {
      'process.env.NODE_ENV': '"development"',
      'import.meta.env': JSON.stringify({ PROD: false, VITE_API_URL: 'http://localhost:5000' }),
    },
    logLevel: 'silent',
  });
  assert.ok(existsSync(outfile), `the ${name} bundle was produced`);
  return import(pathToFileURL(outfile).href);
}

test('a signal finished by the model renders its badge, its pips, and still fits the row', async () => {
  const { default: SignalTable } = await bundle('SignalTable.jsx');
  /* The crowded case this feature makes possible: side, outcome, AI provenance, a pip distance and a missing
     leg on one card. It is one badge more than the four the mobile fix was written against, which is exactly
     why it is rendered here rather than asserted in the abstract. */
  const signal = {
    id: 'ai-row', symbol: 'EURUSD', side: 'buy', source: 'telegram', channelTitle: 'London Session Signals',
    message: 'BUY EURUSD 1.0850 - stop should be 1.0800', status: 'received',
    entryPrice: 1.085, stopLoss: 1.08, takeProfit: null, takeProfitPips: 50,
    llmUsed: true, parsedBy: 'llm', parseConfidence: 0.95, needsReview: false,
    createdAt: '2026-10-24T09:12:00.000Z',
  };
  const html = renderToStaticMarkup(React.createElement(SignalTable, {
    signals: [signal], channelCount: 1, compact: false, onOpenTelegram() {}, onUpgrade() {},
  }));
  assert.match(html, /class="badge signal-flag-badge tone-ai" title="[^"]*AI reading assistant[^"]*">AI Parsed</, 'the badge is a real pill with a real explanation on it');
  assert.match(html, /<span>TP 50 pips<\/span>/, 'the meta line reads as a distance, never as a bare number that could be mistaken for a price');
  assert.equal(/<span>TP 50<\/span>/.test(html), false, 'and the distance is never rendered as if it were the level itself');
  assert.match(html, /<span>SL 1\.08<\/span>/, 'while the stated price leg is rendered as the price it is');

  const flags = html.slice(html.indexOf('class="signal-flags"'), html.indexOf('</div>', html.indexOf('class="signal-flags"')));
  assert.equal((flags.match(/class="badge/g) || []).length, 4, 'side, outcome, AI and pips - the missing-target badge is correctly absent');

  /* And the row may still give way: five pills on a 320px card is the case the mobile fix exists for, so the
     mechanism it installed is asserted intact rather than assumed. */
  assert.equal(/\.signal-flags\s*\{[^}]*flex:0 0 auto/.test(css), false, 'no badge container in this app may be rigid');
  assert.equal(declared('.signal-flags')['flex-wrap'], 'wrap');
  assert.equal(declared('.signal-flags').flex, '0 1 auto');
  assert.equal(declared('.signal-top')['flex-wrap'], 'wrap');
  assert.equal(declared('body')['min-width'], '320px');
});
