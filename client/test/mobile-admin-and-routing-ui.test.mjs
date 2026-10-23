/**
 * Three things a phone exposed, all of them about what a small screen is served rather than what it is shown.
 *
 * A refresh on `/advanced` answers with the static host's plain "Not Found" page unless something hands the
 * request to `index.html` first. Render takes that rule from its dashboard or from `render.yaml` and never
 * from a published file, so the blueprint entry is the one that works and `client/public/_redirects` is the
 * portable statement of the same intent for the hosts that do read it - which is why both are asserted here,
 * against each other. The client then has to survive an unknown path, because a rewrite that lands on a
 * blank screen is the same bug wearing a 200.
 *
 * The other two are the folded settings bar and the Message capture grid, both of which were correct at a
 * desktop width and unusable at a phone width: a flex line whose badge would not shrink squeezed the
 * section description to a word per line, and a nested grid whose column count was written on the more
 * specific selector outranked its own responsive rule, so the admin's counters were cut off mid-word.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');
const read = (...parts) => readFileSync(path.join(here, '..', ...parts), 'utf8');
const styles = read('src', 'styles.css');
const app = read('src', 'App.jsx');
const viteConfig = readFileSync(path.join(here, '..', 'vite.config.js'), 'utf8');
const redirects = readFileSync(path.join(here, '..', 'public', '_redirects'), 'utf8');
const blueprint = readFileSync(path.join(root, 'render.yaml'), 'utf8');
const advanced = read('src', 'components', 'AdvancedSettings.jsx');

test('the SPA fallback is stated once, and stated the same way everywhere', () => {
  const rules = redirects.split('\n').map((line) => line.trim()).filter(Boolean);
  assert.equal(rules.length, 1, 'one rule, so nothing else can shadow it');
  const [source, destination, status] = rules[0].split(/\s+/);
  assert.equal(source, '/*', 'every path the client can be asked for');
  assert.equal(destination, '/index.html', 'is answered with the app shell');
  assert.equal(status, '200', 'as a rewrite: a 301 moves the browser and loses the address being shared');
});

test('the blueprint carries the rule Render reads, and the file agrees with it', () => {
  // The blueprint entry is the load-bearing one: Render applies dashboard rules and `routes:`, and does not
  // read a `_redirects` file. Vite still publishes the file, so the fallback is also right on the hosts that
  // do read it, and a moved `publicDir` is what would silently break that half.
  assert.equal(/publicDir/.test(viteConfig), false, 'vite.config.js leaves publicDir alone, so client/public is the publish root');
  const staticService = blueprint.slice(blueprint.indexOf('name: telegram-copier-web'));
  assert.match(staticService, /staticPublishPath: \.\/dist/);
  assert.match(staticService, /routes:\s*\n\s*- type: rewrite\s*\n\s*source: \/\*\s*\n\s*destination: \/index\.html/, 'the managed service carries the same rule as a route');
  assert.ok(staticService.indexOf('routes:') < staticService.indexOf('envVars:'), 'and it is the static service that declares it, not the API');
});

test('a build that ran puts the file at the publish root', () => {
  // `client/dist` is not committed, so this only has something to say where a build has been run: it is
  // the check that `public/` really is the publish root, which is the difference between a rule the host
  // reads and a file that sits beside the source forever.
  const built = path.join(here, '..', 'dist', '_redirects');
  if (!existsSync(built)) return;
  assert.equal(readFileSync(built, 'utf8').trim(), redirects.trim(), 'the published `_redirects` is the one in the repo');
});

test('an unknown path still renders a workspace, so a 200 cannot be a blank screen', () => {
  // The host's job ends at index.html; after that an unrecognised address has to land somewhere a user
  // can navigate away from, because `eb.onrender.com/risk settings` (a space, a typo, a stale bookmark)
  // would otherwise be a white page with no way out but the back button.
  assert.match(app, /const initialTabFromPath = \(pathname\) => TAB_FOR_PATH\[String\(pathname \|\| ''\)\.replace\(\/\\\/\+\$\/, ''\)\] \|\| 'overview';/);
  assert.match(app, /setTab\(TAB_FOR_PATH\[window\.location\.pathname\.replace\(\/\\\/\+\$\/, ''\)\] \|\| 'overview'\)/, 'and a browser back into such a path is handled the same way');
  assert.match(app, /if \(normalizedPath === '\/billing\/callback'\)/, 'the two paths outside the shell are matched before the fallback, so they keep their own screens');
});

/* --------------------------------------------------------------------- the folded bars on a phone */

test('the three settings bars describe themselves in one short line', () => {
  for (const subtitle of [
    'Decide if and how signals become orders.',
    'Manage Break Even, Trailing Stops, and Multiple Targets.',
    'Configure fallback SL/TP and safety blocks.',
  ]) {
    assert.ok(advanced.includes(`subtitle="${subtitle}"`), `"${subtitle}" is what the header says`);
  }
  const lines = [...advanced.matchAll(/subtitle="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(lines.length, 3, 'one line per bar, and nowhere else for them to drift');
  for (const line of lines) {
    assert.ok(line.length <= 60, `"${line}" fits on a phone row without becoming the paragraph it replaces`);
  }
});

test('on a phone the header is title and state on one row, description on the next', () => {
  const mobile = /@media\(max-width:760px\)\{([\s\S]*?)\n\}/.exec(styles)?.[1] || '';
  assert.ok(mobile.includes('.settings-section-bar{display:grid'), 'the header is a grid, not a wrapping flex line');
  assert.match(mobile, /grid-template-columns:auto minmax\(0,1fr\) minmax\(0,46%\)/, 'the badge may take a fixed share of the bar, never all of it');
  assert.match(mobile, /grid-template-areas:"chevron title state" "desc desc desc"/, 'the description takes the whole second row');
  assert.match(mobile, /\.settings-section-heading\{display:contents\}/, 'by unboxing the wrapper, not by duplicating the markup');
  assert.match(mobile, /\.settings-section-state\{grid-area:state;margin-left:0;justify-self:end/, 'the badge stays on the first row, at its end');
  // The rule this replaces is the one that made the column narrow in the first place.
  assert.equal(/\.settings-section-state\{margin-left:26px\}/.test(styles), false, 'no leftover indent fighting the grid');
  assert.equal(/\.settings-section-state\{[^}]*max-width:44%/.test(styles), false, 'and no percentage max-width on the item, whose area it would resolve against is the thing it sizes');
});

test('the desktop header is untouched by the phone rule', () => {
  assert.match(styles, /\.settings-section-bar\{list-style:none;cursor:pointer;display:flex;align-items:center;gap:11px/);
  assert.match(styles, /\.settings-section-heading\{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1\}/);
});

/* ------------------------------------------------------------------- the capture grid on a phone */

test('the Message capture counters are two readable columns on a phone', () => {
  // Written as one line so it cannot be re-read as a rule that applies at every width: the four-across
  // grid is what pushed `Monitored channels` and the last-message time into each other.
  assert.match(
    styles,
    /@media \(min-width: 1051px\) \{ \.health-capture \.health-queue \{ grid-template-columns: repeat\(4,minmax\(0,1fr\)\); \} \}/,
    'four across is asked for only above the tablet width',
  );
  assert.match(styles, /\.health-queue, \.health-capture \.health-queue \{ grid-template-columns: repeat\(2,minmax\(0,1fr\)\); \}/, 'and both grids get two columns at phone width');
  assert.match(styles, /\.health-queue div \{ min-width: 0; padding: 9px 10px; \}/, 'a cell may shrink below its content');
  const wrap = /\.health-queue (span|strong) \{[^}]*overflow-wrap: anywhere/;
  assert.ok(wrap.test(styles), 'a 9-character label and a full timestamp both wrap instead of overflowing');
  assert.equal((styles.match(/overflow-wrap: anywhere/g) || []).length >= 2, true, 'on the label and on the value, not just one of them');
});

test('the queue grid beside it keeps the same treatment', () => {
  // The panel's other stat row is the same markup, so both grids are restated in one rule - fixing only
  // the nested one is how half of a panel stays broken.
  assert.match(styles, /@media \(max-width: 1050px\) \{\n  \.health-queue \{ grid-template-columns: repeat\(3,minmax\(0,1fr\)\); \}/, 'three across at tablet width');
  assert.equal(/\.health-queue \{ display: grid; grid-template-columns: repeat\(6,minmax\(0,1fr\)\)/.test(styles), true, 'and six on a desktop');
});
