/**
 * The settings area is three pages, and these tests keep it that way.
 *
 * A split like this fails quietly in one specific direction: a field that belongs to nobody, or one that
 * both pages write. The first is a value the user can no longer set at all, and the second is worse - the
 * page that saved last wins, and the other shows the old number until a refresh. So the boundary is pinned
 * against the server's own route rather than against a list somebody typed here.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { navigationItems, navigationItemsForRole } from '../src/navigation.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(here, '..', 'src');
const readSource = (...parts) => readFileSync(path.join(srcDir, ...parts), 'utf8');
const render = (component, props = {}) => renderToStaticMarkup(React.createElement(component, props));

await build({
  entryPoints: [
    path.join(srcDir, 'components', 'RiskSettings.jsx'),
    path.join(srcDir, 'components', 'ProfileSettings.jsx'),
  ],
  outdir: path.join(here, '.tmp'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  external: ['react', 'react-dom'],
  define: {
    'process.env.NODE_ENV': '"development"',
    'import.meta.env': JSON.stringify({ PROD: false, VITE_API_URL: 'http://localhost:5000', VITE_SUPABASE_URL: '', VITE_SUPABASE_PUBLISHABLE_KEY: '' }),
  },
  outExtension: { '.js': '.mjs' },
  logLevel: 'silent',
});
for (const name of ['RiskSettings', 'ProfileSettings']) {
  assert.ok(existsSync(path.join(here, '.tmp', `${name}.mjs`)), `the ${name} bundle was produced`);
}
const { default: RiskSettings } = await import(pathToFileURL(path.join(here, '.tmp', 'RiskSettings.mjs')).href);
const { default: ProfileSettings } = await import(pathToFileURL(path.join(here, '.tmp', 'ProfileSettings.mjs')).href);

const settingsBase = {
  riskMode: 'fixed', riskPercent: 1, maxOpenPositions: 3, dailyLossLimit: 5, maxDailyTrades: 10,
  autoTradingEnabled: true, hasAcceptedRiskWarning: true, lotSizeMode: 'fixed', fixedLotSize: 0.01,
  executionAccountId: 'account-1', breakEvenEnabled: false, breakEvenTriggerPoints: 20, breakEvenOffsetPoints: 0,
  trailingStopEnabled: false, trailingStopDistancePoints: 10, blockExecutionWithoutStopLoss: true,
  blockExecutionWithoutTakeProfit: true, fallbackStopLossPoints: null, fallbackTakeProfitPoints: null,
};

/* ---------------------------------------------------------------- the two settings pages */

test('Risk Settings is four numbers and nothing that decides an order', () => {
  const markup = render(RiskSettings, { settings: settingsBase, onChange() {}, onSubmit(event) { event.preventDefault(); }, saving: false });
  for (const field of ['risk-percent', 'max-open-trades', 'max-daily-trades', 'daily-loss-limit']) {
    assert.ok(markup.includes(`id="${field}"`), `the ${field} input is still on this page`);
  }
  assert.match(markup, /How much a trade may cost you\. Limits are checked against the selected connected account before every order\./, 'the sentence the panel has always used, moved rather than rewritten');
  // The point of the split, stated as absence: no switch that sends money, no button that deletes an account.
  for (const absent of [
    'id="auto-trading-enabled"', 'id="block-missing-stop"', 'id="block-missing-target"', 'id="fallback-stop-loss"',
    'id="break-even-enabled"', 'id="trailing-distance"', 'id="execution-account"', 'id="lot-size-mode"',
    'Delete My Account', 'account-danger-zone', 'risk-warning-modal',
  ]) {
    assert.equal(markup.includes(absent), false, `${absent} does not belong on the risk page`);
  }
  assert.equal(markup.includes('<details'), false, 'nothing on this page is folded away');
});

test('the risk numbers have no plan-based sizing and no legacy risk mode of their own', () => {
  // `riskMode` is what the parser-side sizing reads, and it has never had a control; the mode a user
  // chooses is the lot-size mode on the advanced page. Nothing here may start writing it by accident.
  const panel = readSource('components', 'RiskSettings.jsx');
  assert.equal(/set\('riskMode'/.test(panel), false);
  assert.equal(/autoTradingEnabled.*set\(/.test(panel), false, 'the risk page cannot switch Auto-Trading on');
});

/* ---------------------------------------------------------------- profile */

const userFixture = { id: 'user-1', name: 'Amina Yusuf', email: 'amina@example.com', role: 'user', createdAt: '2026-02-11T09:30:00.000Z' };

test('Profile carries the identity, the password flow, and the Danger Zone together', () => {
  const markup = render(ProfileSettings, { user: userFixture, token: 'fake-token', onDeleted() {}, readOnly: false });
  assert.match(markup, /<h2 id="profile-identity-title">Your account<\/h2>/);
  assert.match(markup, /Amina Yusuf/);
  assert.match(markup, /amina@example\.com/);
  assert.match(markup, /Workspace owner/);
  assert.match(markup, /11\/02\/2026|Feb 11, 2026|2026/, 'the workspace carries its own age');
  assert.match(markup, /<h2 id="profile-password-title">Password<\/h2>/);
  assert.match(markup, />Change password</);
  // The deletion control is last, on this page and nowhere else.
  assert.match(markup, /DANGER ZONE/);
  assert.ok(markup.indexOf('profile-password-title') < markup.indexOf('delete-account-heading'), 'the Danger Zone sits below the password panel');
  assert.match(markup, /Delete My Account/);
  // The panel's own confirmation form only exists after the button is pressed, so the static render
  // shows the button - and the reuse is pinned on the module that owns the form.
  assert.match(markup, /class="button button-danger">Delete My Account<\/button>/);
  assert.match(readSource('components', 'AccountDeletionSettings.jsx'), /Type DELETE to confirm/);
  assert.match(readSource('components', 'AccountDeletionSettings.jsx'), /request\('\/api\/auth\/account', token, \{\s*method: 'DELETE'/, 'one endpoint, still');
  assert.equal(markup.includes('id="risk-percent"'), false, 'no trading setting is reachable from here');
});

test('a support session sees the workspace but cannot change its account', () => {
  const markup = render(ProfileSettings, { user: userFixture, token: 'support-token', onDeleted() {}, readOnly: true });
  assert.equal(markup.includes('Type DELETE to confirm'), false, 'the deletion form is not rendered for a read-only view');
  assert.equal(markup.includes('>Change password<'), false, 'nor a reset email sent into somebody else\'s inbox');
  assert.match(markup, /read-only/);
  assert.match(markup, /Delete My Account/, 'it is still stated what is being withheld, rather than hidden');
});

/* ---------------------------------------------------------------- one password flow, not two */

const resetModule = readSource('lib', 'password-reset.js');
const appSource = readSource('App.jsx');
const profileSource = readSource('components', 'ProfileSettings.jsx');

test('both surfaces ask for the reset email through the same helper', () => {
  const files = ['App.jsx', 'components/ProfileSettings.jsx', 'components/UpdatePasswordPage.jsx', 'lib/password-reset.js'];
  for (const file of files) {
    const calls = (readFileSync(path.join(srcDir, file), 'utf8').match(/\.auth\.resetPasswordForEmail\(/g) || []).length;
    assert.equal(calls <= 1, true, `${file} does not get its own copy of the reset call`);
  }
  assert.equal(resetModule.includes('client.auth.resetPasswordForEmail'), true, 'the one copy is in the helper');
  assert.match(appSource, /await sendPasswordResetEmail\(form\.email\)/, 'the sign-in screen uses it');
  assert.match(profileSource, /await sendPasswordResetEmail\(email\)/, 'and so does Profile');
  assert.match(profileSource, /PASSWORD_RESET_SENT/, 'the sentence after sending is the same sentence the sign-in screen shows');
});

test('the helper prepares on the API before it asks Supabase, and hands over the app\'s own redirect', () => {
  const prepare = resetModule.indexOf("'/api/auth/prepare-password-reset'");
  const send = resetModule.indexOf('resetPasswordForEmail');
  assert.ok(prepare > 0 && send > prepare, 'the rate limit and existence handling run first, in that order');
  assert.match(resetModule, /redirectTo: `\$\{window\.location\.origin\}\$\{PASSWORD_RESET_REDIRECT_PATH\}`/);
  assert.equal(resetModule.includes('/update-password'), true, 'the link has to land on the page that can set a password');
  assert.match(appSource, /normalizedPath === '\/update-password'/, 'and that page is still routed');
  // A missing browser config is a deploy problem, and it is said as one instead of a stack trace.
  assert.match(resetModule, /console\.error\('\[password-reset\] Supabase browser configuration is missing/, 'the reason is logged where the operator will see it');
  assert.match(resetModule, /Password recovery is temporarily unavailable/);
  assert.match(profileSource, /setResetError|setError\(sendError/, 'a failed request is shown, not swallowed');
});

/* ---------------------------------------------------------------- the route and the sidebar */

test('every page in the sidebar is a page the app can route to, in the order it is read', () => {
  const keys = navigationItemsForRole('user').map((item) => item.key);
  assert.deepEqual(keys, ['overview', 'telegram', 'signals', 'accounts', 'settings', 'advanced', 'metaapi', 'billing', 'profile']);
  const labels = Object.fromEntries(navigationItems.map((item) => [item.key, item.label]));
  assert.equal(labels.settings, 'Risk Settings');
  assert.equal(labels.advanced, 'Advanced Settings');
  assert.equal(labels.profile, 'Profile');
  assert.deepEqual(navigationItemsForRole('admin').map((item) => item.key).slice(-1), ['admin'], 'only an administrator is offered the admin page');
  // One icon path per item, because two identical glyphs in the sidebar read as one page listed twice.
  const icons = navigationItems.map((item) => item.iconPath);
  assert.equal(new Set(icons).size, icons.length, 'every page has its own glyph');
  for (const item of navigationItems) assert.ok(item.label && item.iconPath, `${item.key} is fully described`);
});

test('the new pages have URLs, and the static host is told about them', () => {
  const table = appSource.slice(appSource.indexOf('const PATH_FOR_TAB'), appSource.indexOf('const TAB_FOR_PATH'));
  for (const [tab, route] of [['advanced', '/advanced'], ['profile', '/profile'], ['billing', '/billing'], ['admin', '/admin']]) {
    assert.ok(table.includes(`${tab}: '${route}'`), `${tab} owns ${route}`);
  }
  assert.match(appSource, /TAB_FOR_PATH\[String\(pathname/, 'a refresh reads the page back out of the path');
  assert.match(appSource, /setTab\(TAB_FOR_PATH\[/, 'so do the browser\'s back and forward buttons');
  assert.match(appSource, /const path = PATH_FOR_TAB\[nextTab\] \|\| '\/';/, 'and one table writes the path on navigation');
  assert.equal(/nextTab === 'admin' \? '\/admin'/.test(appSource), false, 'a chain of ternaries is how a page ends up deep-linked in one direction only');

  const routes = JSON.parse(readFileSync(path.join(here, '..', 'public', 'manus-routes.json'), 'utf8')).routes.map((route) => route.path);
  const declared = [...table.matchAll(/'(\/[a-z-]*)'/g)].map((match) => match[1]);
  for (const route of ['/advanced', '/profile', '/admin', '/billing', '/billing/callback', '/update-password', ...declared]) {
    assert.ok(routes.includes(route), `the route manifest has to list ${route} or a direct visit is a 404`);
  }
  for (const key of ['overview', 'telegram', 'signals', 'accounts', 'settings', 'metaapi']) {
    assert.equal(routes.includes(`/${key}`), false, `${key} stays on the shell path, as it has always been`);
  }
});

/* ---------------------------------------------------------------- the boundary against the API */

const indexSource = readFileSync(path.join(here, '..', '..', 'server', 'index.js'), 'utf8');
const putStart = indexSource.indexOf("app.put('/api/settings'");
const settingsPut = indexSource.slice(putStart, indexSource.indexOf('\napp.', putStart + 10));
const writtenFields = [...new Set([...settingsPut.matchAll(/req\.body\.([A-Za-z][A-Za-z0-9]*)/g)].map((match) => match[1]))];
const fieldsOf = (file) => new Set([...readSource('components', file).matchAll(/set\('([A-Za-z][A-Za-z0-9]*)'/g)].map((match) => match[1]));
const riskFields = fieldsOf('RiskSettings.jsx');
const advancedFields = fieldsOf('AdvancedSettings.jsx');

test('the route writes what the pages can set, and no field has two owners', () => {
  assert.ok(writtenFields.length >= 18, `the settings route reads ${writtenFields.length} fields - a truncated slice means the boundary test is reading the wrong route`);
  // `riskMode` has never had a control (the sizing mode on the advanced page is what users choose), and
  // the risk acknowledgement is written by the Auto-Trading toggle handler, not by a field.
  const notOnAnyPage = new Set(['riskMode', 'hasAcceptedRiskWarning']);
  const owned = new Set([...riskFields, ...advancedFields]);
  for (const field of writtenFields) {
    assert.ok(owned.has(field) || notOnAnyPage.has(field), `${field} is read by PUT /api/settings but no page can set it`);
  }
  for (const field of owned) {
    assert.ok(writtenFields.includes(field), `a page writes ${field} and the route would drop it`);
  }
  for (const field of riskFields) {
    assert.equal(advancedFields.has(field), false, `${field} is editable on two pages - whichever saved last would win`);
  }
  assert.deepEqual([...riskFields], ['riskPercent', 'maxOpenPositions', 'maxDailyTrades', 'dailyLossLimit'], 'the risk page owns exactly the four numbers');
  assert.deepEqual([...fieldsOf('ProfileSettings.jsx')], [], 'the profile page cannot write a trading setting at all');
});

test('both settings pages save through the one handler, and the profile page never does', () => {
  assert.equal((appSource.match(/onSubmit=\{saveSettings\}/g) || []).length, 2, 'Risk Settings and Advanced Settings, one PUT each time');
  assert.match(appSource, /<RiskSettings settings=\{settings\} onChange=\{setSettings\} onSubmit=\{saveSettings\}/);
  assert.match(appSource, /<AdvancedSettings settings=\{settings\}[^>]*onSubmit=\{saveSettings\}[^>]*onToggle=\{toggleAutoTrading\}/, 'the Auto-Trading switch keeps its own immediate save');
  assert.match(appSource, /<ProfileSettings user=\{user\} token=\{authToken\} onDeleted=\{logout\} readOnly=\{readOnlySupport\}/);
  assert.equal(/<ProfileSettings[^>]*onSubmit/.test(appSource), false, 'no settings write from the profile page');
  assert.equal(readSource('components', 'ProfileSettings.jsx').includes("request('/api/settings'"), false);
  assert.equal((appSource.match(/import AccountDeletionSettings/g) || []).length, 0, 'the Danger Zone is owned by the Profile page, not by the shell');
  assert.equal(readSource('components', 'RiskSettings.jsx').includes('AccountDeletionSettings'), false);
  assert.equal(readSource('components', 'AdvancedSettings.jsx').includes('AccountDeletionSettings'), false);
});

test('the copy that pointed a reader at a page they were already on points at the right one now', () => {
  // Auto-Trading left this page, so every sentence telling somebody to change it "in Risk settings"
  // would be sending them to a page that no longer has the switch. The sentences themselves now live in
  // `lib/platform-view.js`, where the banner and the metric share one reading of the workspace state - so the
  // guard follows them there, and the shell is pinned to the helper rather than to its own copy.
  const bannerSource = readSource('lib', 'platform-view.js');
  assert.equal(/turn this off in Risk settings|Turn Auto-Trading on in Risk Settings/i.test(`${appSource}\n${bannerSource}`), false);
  assert.match(bannerSource, /turn this off in Advanced Settings/);
  assert.match(bannerSource, /Turn Auto-Trading on in Advanced Settings/);
  assert.match(appSource, /autoTradingBannerView\(/, 'the banner is the helper\'s answer, not a ternary the shell invented');
  assert.equal(readSource('components', 'AdvancedSettings.jsx').includes('Auto-Trading is currently unavailable'), false, 'the runtime note says what is unavailable, not where the switch lives');
});
