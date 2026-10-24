/**
 * Four pills and a title do not fit on a phone, so the row has to be allowed to stop being one row.
 *
 * A signal card's header carries the symbol and its channel on the left and, at worst, four badges on the
 * right: the side, the outcome, and a flag per missing leg. Reported on a phone as three failures at once -
 * the badges covering the channel name, the badges squeezed against each other, and the last one cut off by
 * the edge of the screen - and it is one failure with three symptoms. The badge container could not shrink,
 * so it was laid out at its max-content width; a wrapping container that is exactly as wide as its content
 * has nothing to wrap into, so it stayed one row, overflowed the card, and covered the title; and a badge
 * with no `white-space` of its own took the remaining pressure by breaking its own label in half.
 *
 * No browser exists in this environment, and a layout engine invented inside a test would agree with
 * whatever it was written against, so what is pinned here is the mechanism instead of the appearance: the
 * cascade of the real stylesheet, read the way a browser reads it, and the exact values that made the row
 * rigid. The numbers a reviewer can check by eye are in `client/src/styles.css` next to the rules.
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
const css = readFileSync(path.join(here, '..', 'src', 'styles.css'), 'utf8');

const escapeRe = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Every declaration block written for exactly this selector, in source order.
 *
 * The boundary matters. This stylesheet is a minified blob with additions underneath it, so a rule is always
 * preceded by `}` or by a newline - and without that requirement, reading `.badge` would also pick up
 * `.signal-flags .badge`, and the test below would report a global nowrap the stylesheet does not have.
 */
function blocks(selector) {
  const pattern = new RegExp(`(?:^|(?<=\})|(?<=\n))${escapeRe(selector)}\\{([^}]*)\\}`, 'gm');
  return [...css.matchAll(pattern)].map((match) => match[1]);
}

/** What the browser ends up with: later blocks override earlier ones, property by property. */
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

test('the header row may break, and the badge row may shrink: both are needed, in that order', () => {
  assert.equal(declared('.signal-top')['flex-wrap'], 'wrap', 'a badge row that cannot fit goes under the title instead of over it');
  assert.equal(declared('.signal-top').gap, '8px 10px', 'and the two lines are not touching');

  /* `flex:0 0 auto` is the bug, so it is asserted absent rather than just replaced: a container that cannot
     shrink is sized to max-content, and a max-content wrapping container is one row however narrow the card
     gets. It has to be able to give way - and not be allowed to grow into the title's space. */
  assert.equal(/\.signal-flags\s*\{[^}]*flex:0 0 auto/.test(css), false, 'no badge container in this app may be rigid');
  assert.equal(declared('.signal-flags').flex, '0 1 auto');
  assert.equal(declared('.signal-flags')['margin-left'], 'auto', 'pushed to the right edge on a wide card, where it already sat');
  assert.equal(declared('.signal-flags')['flex-wrap'], 'wrap', 'so that a nearly-fitting row wraps instead of overflowing');
  assert.equal(declared('.signal-flags').gap, '8px', 'with a real gutter between the pills, not a touching one');
  assert.equal(/\.signal-flags\s*\{[^}]*gap:6px/.test(css), false, 'and no later rule narrows it back down');
});

test('a badge keeps its label on one line, so the squeeze lands on secondary text and not inside the pill', () => {
  const badge = declared('.signal-flags .badge');
  assert.equal(badge['white-space'], 'nowrap', 'MISSING TP is never two lines inside a pill half as wide as its word');
  assert.equal(badge.flex, '0 0 auto', 'and never narrower than its own label');

  /* Deliberately scoped to the flag rows. A `.badge` elsewhere in the app carries sentences - the break-even
     summary on an execution row is one - and a global nowrap would push those off the card instead of fixing
     anything, which is why the base rule is asserted to stay as it is. */
  assert.equal(/white-space:nowrap/.test(blocks('.badge').join()), false, 'the base .badge rule stays wrappable');

  // The text that does give way is the title line, which is secondary here: the channel name is repeated by
  // the panel's own context and the full message sits on the card underneath.
  assert.equal(declared('.signal-top>div')['min-width'], '0', 'a flex item may shrink below its content, which is what lets the ellipsis be reached at all');
  const title = declared('.signal-top strong,.signal-source');
  assert.equal(title['max-width'], '100%');
  assert.equal(title.overflow, 'hidden');
  assert.equal(title['text-overflow'], 'ellipsis');
  assert.equal(title['white-space'], 'nowrap');
});

test('every other card header with status pills gets the same concessions, without hiding its title', () => {
  assert.equal(declared('.panel-heading')['flex-wrap'], 'wrap');
  assert.equal(declared('.panel-heading>*')['min-width'], '0');
  assert.equal(declared('.panel-heading-actions')['flex-wrap'], 'wrap');
  const pill = declared('.panel-heading .badge,.panel-heading .count-badge');
  assert.equal(pill.flex, '0 0 auto');
  assert.equal(pill['white-space'], 'nowrap');

  // A heading is not a channel name: nothing else on the page states it, so it wraps rather than ellipsizing.
  assert.equal(/text-overflow/.test(blocks('.panel-heading h2').join()), false, 'no ellipsis is ever set on a panel heading');

  /* The admin's signal cards and the plan cards, which are the same construction - a title with a pill or a
     button column on its right, in a row that had no way to give. The action column is a flex *column*, so
     wrapping it would place its buttons side by side; it shrinks and drops instead, which is asserted here so
     that "apply it globally" cannot be answered by a blanket rule that breaks something else. */
  assert.equal(declared('.admin-signal-row')['flex-wrap'], 'wrap');
  assert.equal(declared('.admin-signal-actions').flex, '0 1 auto');
  assert.equal(declared('.admin-signal-actions')['flex-wrap'], undefined, 'not wrapped: in a column, flex-wrap makes columns');
  assert.equal(declared('.admin-signal-actions')['margin-left'], 'auto');
  assert.equal(declared('.pricing-plan-head')['flex-wrap'], 'wrap');
  assert.equal(declared('.pricing-plan-head>div')['min-width'], '0');
  assert.equal(declared('.pricing-plan-head .badge')['white-space'], 'nowrap', 'a pill that reads "Deployed default" never breaks in the middle of the phrase');

  // The arithmetic that makes wrapping mandatory rather than cosmetic, pinned to the number the app claims.
  assert.equal(declared('body')['min-width'], '320px', 'the narrowest viewport the app supports is smaller than four badges and a title');
});

/* ---------------------------------- both pages render the same header ---------------------------------- */

async function bundle(name) {
  const outfile = path.join(here, '.tmp', `${name}.mjs`);
  await build({
    entryPoints: [path.join(here, '..', 'src', name.includes('/') ? name : path.join('components', name))],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    external: ['react'],
    define: {
      'process.env.NODE_ENV': '"development"',
      'import.meta.env': JSON.stringify({ PROD: false, VITE_API_URL: 'http://localhost:5000' }),
    },
    logLevel: 'silent',
  });
  assert.ok(existsSync(outfile), `the ${name} bundle was produced`);
  return import(pathToFileURL(outfile).href);
}

test('the Signals page and the Overview render the identical header, so the fix reaches both', async () => {
  const { default: SignalTable } = await bundle('SignalTable.jsx');
  // The reported worst case: a message that yielded a side and no prices, so the row wears `buy` +
  // `Needs review` + `Missing SL` + `Missing TP`.
  const thin = {
    id: 'thin', symbol: 'XAUUSD', side: 'buy', source: 'telegram', channelTitle: 'Gold Signals',
    message: 'Gold Buy now\n\nSL: 4041.50', status: 'unparsed',
    entryPrice: null, stopLoss: null, takeProfit: null, createdAt: '2026-10-24T00:16:00.000Z',
  };
  const render = (compact) => renderToStaticMarkup(React.createElement(SignalTable, {
    signals: [thin], channelCount: 1, compact, onOpenTelegram() {}, onUpgrade() {},
  }));

  const flagsOf = (markup) => /<div class="signal-flags">([\s\S]*?)<\/div>/.exec(markup)?.[1] || '';
  const pillsOf = (flags) => [...flags.matchAll(/<span class="badge[^"]*"[^>]*>([^<]*)<\/span>/g)].map((match) => match[1]);

  const full = render(false);
  const compact = render(true);
  assert.equal(pillsOf(flagsOf(full)).length, 4, 'four badges, which is the shape that overflowed');
  assert.deepEqual(pillsOf(flagsOf(compact)), pillsOf(flagsOf(full)), 'the Overview carries the same four, so it is the same rule that saves it');
  assert.match(flagsOf(full), /Missing TP/, 'including the pill that was being cut off by the edge of the screen');
  const badgesInMarkup = (markup) => (markup.match(/class="badge[^"]*"/g) || []).length;
  assert.equal(badgesInMarkup(full), 4, 'and not one badge lives outside it, which is what would put it over the title');
  assert.equal(badgesInMarkup(compact), 4, 'same on the Overview card');
  assert.match(full, /<div class="signal-top">/, 'and the header is still a single flex row - the one that is now allowed to break');
});
