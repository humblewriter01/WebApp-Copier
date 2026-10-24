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
    // One level stated, so the row still earns its missing-leg pills: the crowded header this test exists for
    // is now the *signal* case, since a message with no price in it is left with one quiet outcome pill.
    entryPrice: 4041.5, stopLoss: null, takeProfit: null, createdAt: '2026-10-24T00:16:00.000Z',
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

/* ------------------------- the header a real channel produces -------------------------
 *
 * Three captured messages, quoted exactly as they arrived, run through the real server parser and the real
 * safety decision, then rendered. This is the whole point of the header: it is not decoration under a title,
 * it is the user's only view of what the platform understood - so the pair of them has to be tested together.
 * A UI test that builds its own rows by hand can pass while every one of those rows is wrong.
 */
const { parseSignal } = await import('../../server/services/signal-parser.js');
const { captureSafety } = await import('../../server/services/signal-safety.js');

const SETTINGS_WITH_NETS = {
  fallbackStopLossPoints: 500,
  fallbackTakeProfitPoints: 1000,
  blockExecutionWithoutStopLoss: true,
  blockExecutionWithoutTakeProfit: true,
};

/** The row `saveSignal` writes, as the API hands it back. */
function storedRow(message, { id = 'row', channelTitle = 'ADRIELLE TRADERS CIRCLE' } = {}) {
  const parsed = parseSignal(message);
  const safety = captureSafety({ parsed, source: 'telegram', settings: SETTINGS_WITH_NETS });
  return {
    id, source: 'telegram', channelTitle, message,
    symbol: parsed.symbol, side: parsed.side,
    entryPrice: parsed.entryPrice, stopLoss: parsed.stopLoss, takeProfit: parsed.takeProfit,
    stopLossPips: parsed.stopLossPips, takeProfitPips: parsed.takeProfitPips,
    executionReady: safety.executionReady, status: safety.executionReady ? 'received' : 'unparsed',
    executionNote: safety.parseError, createdAt: '2026-10-23T16:01:30.000Z',
  };
}

const CHATTER = 'Should I release more setups, guys ? Because I see the tap-tap reactions are so damn slow ! 😔';
const MANAGE = 'GOLD BUY MORE NOW !\n\nPrice : 4026.00 - 4016.00\n\nSL - 4011.00\nTP - 50Pips / 100Pips\n\nManage Layering And Money Management !';
const WINPOST = '✅ R1 GOLD BUY : 50PIPS\n✅ R2 GOLD BUY : 50PIPS\n✅ R3 GOLD BUY : 70PIPS\n\nWinning streak as usual when you trade with Sir Adrielle right ? So guys, enjoy your profit ! ⚡';

test('a chat message wears one honest pill and nothing else', async () => {
  const { default: SignalTable } = await bundle('SignalTable.jsx');
  const markup = renderToStaticMarkup(React.createElement(SignalTable, {
    signals: [storedRow(CHATTER)], channelCount: 1, onOpenTelegram() {}, onUpgrade() {},
  }));
  assert.equal(markup.includes('Missing SL'), false, 'no stop is missing from a message that never asked for a trade');
  assert.equal(markup.includes('Missing TP'), false, 'and neither is a target');
  assert.equal(/>received</.test(markup), false, 'and the pill that read "received" because no direction was found is gone: a card saying RECEIVED / NO CLEAR SIGNAL said the same nothing twice');
  assert.equal((markup.match(/class="badge/g) || []).length, 1, 'one pill, the outcome');
  assert.match(markup, /No clear signal/, 'which is the truth of it');
  assert.match(markup, /<strong>Signal message<\/strong>/, 'titled by what it is, not by a word the parser mistook for a symbol');
});

test('an entry zone with a dashed stop and a pip target is read, and says so on the header', async () => {
  const { default: SignalTable } = await bundle('SignalTable.jsx');
  const row = storedRow(MANAGE);
  assert.equal(row.symbol, 'XAUUSD', 'the metal is named by the word GOLD; "Manage Layering" is not a symbol');
  assert.equal(row.entryPrice, 4026, 'the zone 4026.00 - 4016.00 is credited at its least favourable bound for a buy');
  assert.equal(row.stopLoss, 4011, 'SL - 4011.00 is a stop loss, dash and all - the pill that used to sit here said it was missing');
  assert.equal(row.takeProfitPips, 50, 'TP - 50Pips / 100Pips is a scale-out plan, so the first target is the row\'s and the rest stay in the message');
  assert.equal(row.executionReady, true, 'and nothing about it is blocked');

  const markup = renderToStaticMarkup(React.createElement(SignalTable, {
    signals: [row], channelCount: 1, onOpenTelegram() {}, onUpgrade() {},
  }));
  assert.match(markup, /<strong>XAUUSD<\/strong>/);
  assert.equal(markup.includes('Missing SL'), false, 'the missing-stop pill is gone, which was the complaint');
  assert.match(markup, /<span>SL 4011<\/span>/, 'the stop is shown as a price');
  assert.match(markup, /<span>TP 50 pips<\/span>/, 'the target is shown as a distance, never as "TP 50"');
  assert.equal((markup.match(/class="badge/g) || []).length, 3, 'side, outcome, and one flag that is information rather than a complaint');
  assert.match(markup, /class="badge signal-flag-badge tone-muted"[^>]*>Pips TP 50</, 'which is the badge saying the target is a distance, so the row is not read as having no plan');
});

test('a win-post is refused for the reason a user can act on, without inventing a missing leg', async () => {
  const { default: SignalTable } = await bundle('SignalTable.jsx');
  const row = storedRow(WINPOST);
  assert.equal(row.symbol, 'XAUUSD');
  assert.equal(row.side, 'buy', 'the direction is real - R1/R2/R3 GOLD BUY says buy gold');
  assert.equal(row.entryPrice, null, 'and there is no price in it, because it is a report of trades already closed');
  assert.equal(row.executionReady, false);

  const markup = renderToStaticMarkup(React.createElement(SignalTable, {
    signals: [row], channelCount: 1, onOpenTelegram() {}, onUpgrade() {},
  }));
  assert.equal(markup.includes('Missing SL'), false, 'no missing-leg pill, because nothing was omitted from a trade this message never proposed');
  assert.match(markup, /Needs [Rr]eview/);
  assert.match(markup, /states a direction but no price/, 'the sentence under it names the actual reason - and it says the fallbacks were deliberately not used');
});

test('the delete control travels with the pills it sits beside, so it is never stranded on a line of its own', async () => {
  const { default: SignalTable } = await bundle('SignalTable.jsx');
  const markup = renderToStaticMarkup(React.createElement(SignalTable, {
    signals: [storedRow(MANAGE)], channelCount: 1, onOpenTelegram() {}, onUpgrade() {}, onDeleteSignal() {},
  }));
  /* The button used to be the third child of `.signal-top`, after the pill row: with the row wrapping on a
     phone, it dropped onto a line of its own, alone on the left, under the badges it belongs to. It is now the
     last item inside the wrapping group, so it wraps with the pills and stays at their end. */
  assert.match(markup, /<\/span><button class="signal-delete-button"[^>]*>✕<\/button><\/div><\/div>/, 'the control closes the flags row, inside it');
  assert.equal(declared('.signal-flags')['flex-wrap'], 'wrap', 'and that row is still the one allowed to break');
  assert.equal(/\.signal-flags\s*\{[^}]*flex:0 0 auto/.test(css), false, 'still not rigid');
});
