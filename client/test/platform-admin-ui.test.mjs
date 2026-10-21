import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  clearSupportSession,
  readSupportSession,
  shapeSession,
  SUPPORT_SESSION_STORAGE_KEY,
  supportSessionRemaining,
  writeSupportSession,
} from '../src/lib/support-session.js';
import {
  announcementCopy,
  formatAnnouncementWindow,
  healthCheckTone,
  killSwitchView,
  supportBannerCopy,
} from '../src/lib/platform-view.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const bundlePath = (name) => path.join(here, '.tmp', `${name}.mjs`);

// Both components live in JSX and the banner shares the API helper, which reads Vite's
// `import.meta.env`; the bundle gives that a value so the module can load in Node.
await build({
  entryPoints: [
    path.join(here, '..', 'src', 'components', 'ExecutionSettings.jsx'),
    path.join(here, '..', 'src', 'components', 'AnnouncementBanner.jsx'),
    path.join(here, '..', 'src', 'components', 'SupportSessionBar.jsx'),
  ],
  outdir: path.join(here, '.tmp'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  external: ['react'],
  define: {
    'process.env.NODE_ENV': '"development"',
    'import.meta.env': JSON.stringify({ PROD: false, VITE_API_URL: 'http://localhost:5000' }),
  },
  outExtension: { '.js': '.mjs' },
  logLevel: 'silent',
});
for (const name of ['ExecutionSettings', 'AnnouncementBanner', 'SupportSessionBar']) {
  assert.ok(existsSync(bundlePath(name)), `the ${name} bundle was produced`);
}

const { default: ExecutionSettings, platformPauseNotice } = await import(pathToFileURL(bundlePath('ExecutionSettings')).href);
const { default: AnnouncementBanner } = await import(pathToFileURL(bundlePath('AnnouncementBanner')).href);
const { default: SupportSessionBar } = await import(pathToFileURL(bundlePath('SupportSessionBar')).href);

/* ---------------------------- the support session ---------------------------- */

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
    dump: () => Object.fromEntries(data),
  };
}

const HOUR = 60 * 60 * 1000;

test('a support session survives a reload but only inside the tab and only for its hour', () => {
  const storage = memoryStorage();
  const expiresAt = new Date(Date.now() + HOUR).toISOString();
  assert.equal(writeSupportSession({ token: 'jwt-token', sessionId: 'session-1', expiresAt, user: { id: 'u1', name: 'Ada Trader', email: 'ada@example.com' } }, storage), true);
  assert.deepEqual(readSupportSession(storage), {
    token: 'jwt-token',
    sessionId: 'session-1',
    expiresAt,
    user: { id: 'u1', name: 'Ada Trader', email: 'ada@example.com' },
  });
  assert.deepEqual(Object.keys(storage.dump()), [SUPPORT_SESSION_STORAGE_KEY], 'nothing else is left behind in the tab');

  // an expired record is not a session, and it is removed rather than trusted
  const stale = memoryStorage({ [SUPPORT_SESSION_STORAGE_KEY]: JSON.stringify({ token: 'jwt', expiresAt: new Date(Date.now() - 1000).toISOString(), user: { email: 'ada@example.com' } }) });
  assert.equal(readSupportSession(stale), null);
  assert.equal(stale.getItem(SUPPORT_SESSION_STORAGE_KEY), null, 'the dead record is cleared on read');

  // garbage never becomes "probably still signed in"
  const broken = memoryStorage({ [SUPPORT_SESSION_STORAGE_KEY]: '{not json' });
  assert.equal(readSupportSession(broken), null);
  assert.equal(broken.getItem(SUPPORT_SESSION_STORAGE_KEY), null);

  // a record without an identity or a token is refused even when it parses
  assert.equal(shapeSession({ token: 'jwt', expiresAt: new Date(Date.now() + HOUR).toISOString(), user: {} }), null);
  assert.equal(shapeSession({ expiresAt: new Date(Date.now() + HOUR).toISOString(), user: { email: 'a@b.c' } }), null);

  assert.equal(clearSupportSession(storage), true);
  assert.equal(readSupportSession(storage), null);
});

test('a browser that refuses storage cannot half-open a support session', () => {
  const blocked = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() { throw new Error('denied'); } };
  assert.equal(readSupportSession(blocked), null);
  assert.equal(writeSupportSession({ token: 'jwt', expiresAt: new Date(Date.now() + HOUR).toISOString(), user: { email: 'a@b.c' } }, blocked), false);
  assert.equal(clearSupportSession(blocked), false);
  assert.equal(readSupportSession(null), null, 'no storage at all is still a safe answer');
});

test('the countdown is coarse, and precision is only used where it changes behaviour', () => {
  const now = Date.UTC(2026, 2, 4, 5, 0, 0);
  assert.deepEqual(supportSessionRemaining({ expiresAt: new Date(now + 59 * 60_000).toISOString() }, now), { expired: false, label: '59 min left' });
  assert.deepEqual(supportSessionRemaining({ expiresAt: new Date(now + 45 * 1000).toISOString() }, now), { expired: false, label: 'under a minute left' });
  assert.deepEqual(supportSessionRemaining({ expiresAt: new Date(now + HOUR + 61 * 60_000).toISOString() }, now), { expired: false, label: '2h 1 min left' });
  assert.deepEqual(supportSessionRemaining({ expiresAt: new Date(now + 2 * HOUR).toISOString() }, now), { expired: false, label: '2 hours left' }, 'a round hour is stated as an hour, not 1h 0 min');
  assert.deepEqual(supportSessionRemaining({ expiresAt: new Date(now - 1).toISOString() }, now), { expired: true, label: 'expired' });
  assert.equal(supportSessionRemaining({ expiresAt: 'nonsense' }, now), null);
  assert.equal(supportSessionRemaining(undefined, now), null);
});

test('the banner names the workspace, says the view is read-only, and offers the way out', () => {
  const session = { token: 'jwt', expiresAt: new Date(Date.now() + HOUR).toISOString(), user: { name: 'Ada Trader', email: 'ada@example.com' } };
  const copy = supportBannerCopy(session, supportSessionRemaining(session));
  assert.equal(copy.identity, 'Ada Trader (ada@example.com)');
  assert.match(copy.readOnlyLine, /read-only/);
  assert.equal(copy.expiryLine, 'Access ends in 1 hour.');
  assert.equal(supportBannerCopy(null, null), null, 'no session, no banner');

  const bar = renderToStaticMarkup(React.createElement(SupportSessionBar, { session, onExit() {} }));
  assert.match(bar, /Support access/);
  assert.match(bar, /ada@example\.com/);
  assert.match(bar, /read-only/);
  // the component recomputes the countdown as it renders, so the last minute can already be gone
  assert.match(bar, /Access ends in (1 hour|59 min)\./);
  assert.match(bar, /Exit support view/);
  assert.match(bar, /class="support-banner"/);
  // nothing in the bar looks like a control over the customer's data
  assert.equal(bar.match(/<input|<select|<textarea/g), null);
  assert.match(renderToStaticMarkup(React.createElement(SupportSessionBar, { session: null, onExit() {} })), /^$/, 'no session, no bar');
});

test('the announcement banner renders nothing while there is no answer, so an empty slot is never a claim', () => {
  // renderToStaticMarkup does not run effects, which is exactly the "still loading" state.
  assert.equal(renderToStaticMarkup(React.createElement(AnnouncementBanner, { token: 'jwt' })), '');
});

/* ------------------------- health, switch, and announcements ------------------------- */

test('the kill switch never reads "Live" from a missing or unreadable answer', () => {
  const loading = killSwitchView(null);
  assert.deepEqual({ state: loading.state, label: loading.label, ready: loading.ready, blocked: loading.blocked }, {
    state: 'loading', label: 'Checking…', ready: false, blocked: true,
  });
  assert.match(loading.headline, /Reading the platform switch/);

  const broken = killSwitchView({ killSwitch: { state: 'unavailable', paused: true, reason: 'db' }, checks: [{ key: 'kill_switch', detail: 'The switch could not be read.' }] });
  assert.deepEqual({ state: broken.state, label: broken.label, ready: broken.ready, blocked: broken.blocked, paused: broken.paused }, {
    state: 'unavailable', label: 'Unknown', ready: true, blocked: true, paused: false,
  });
  assert.equal(broken.detail, 'The switch could not be read.');

  const paused = killSwitchView({ killSwitch: { state: 'paused', paused: true, reason: 'Incident', updatedByEmail: 'ops@example.com', updatedAt: 'x' }, checks: [{ key: 'kill_switch', detail: 'Incident — set by ops@example.com.' }] });
  assert.equal(paused.paused, true);
  assert.equal(paused.label, 'Paused');
  assert.equal(paused.reason, 'Incident');
  assert.equal(paused.updatedBy, 'ops@example.com');

  const live = killSwitchView({ killSwitch: { state: 'live', paused: false, reason: null }, checks: [] });
  assert.deepEqual({ state: live.state, label: live.label, blocked: live.blocked, detail: live.detail }, { state: 'live', label: 'Live', blocked: false, detail: '' });

  // a payload that claims a state the shape does not support still cannot look healthy
  assert.equal(killSwitchView({ killSwitch: {} }).label, 'Unknown');
});

test('an unreadable health check is grey, never green', () => {
  assert.equal(healthCheckTone('ok'), 'ok');
  assert.equal(healthCheckTone('idle'), 'idle');
  assert.equal(healthCheckTone('watch'), 'watch');
  assert.equal(healthCheckTone('fail'), 'fail');
  assert.equal(healthCheckTone('paused'), 'paused');
  assert.equal(healthCheckTone('unavailable'), 'fail', 'a switch nobody can read is a failure, not a warning');
  assert.equal(healthCheckTone('made-up'), 'unknown');
  assert.equal(healthCheckTone(undefined), 'unknown');
});

test('announcement copy keeps severity honest and the window factual', () => {
  const now = new Date(Date.UTC(2026, 2, 4, 5, 0, 0));
  const maintenance = { level: 'warning', message: 'Maintenance', endsAt: new Date(now.getTime() + 3 * HOUR).toISOString() };
  const copy = announcementCopy(maintenance, now);
  assert.equal(copy.tag, 'Notice');
  assert.equal(copy.role, 'status');
  assert.match(copy.window, /^until /);

  assert.equal(announcementCopy({ level: 'critical' }, now).role, 'alert');
  assert.equal(announcementCopy({ level: 'critical' }, now).live, 'assertive');
  assert.equal(announcementCopy({ level: 'apocalypse' }, now).level, 'info', 'an unknown severity is displayed as info, never dropped');
  assert.equal(announcementCopy(null, now).tag, 'Announcement');

  assert.equal(formatAnnouncementWindow({ startsAt: new Date(now.getTime() + HOUR).toISOString() }, now), `from ${new Date(now.getTime() + HOUR).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`);
  assert.equal(formatAnnouncementWindow({ endsAt: new Date(now.getTime() - 1).toISOString() }, now), 'ends now');
  assert.equal(formatAnnouncementWindow({ startsAt: new Date(now.getTime() - HOUR).toISOString() }, now), '', 'a banner that is simply live needs no caption');
});

/* ------------------------- the user's own settings panel ------------------------- */

test('a platform pause explains itself next to a toggle that is already on', () => {
  assert.equal(platformPauseNotice(null), '', 'no state read is not the same as a pause');
  assert.equal(platformPauseNotice({ paused: false, state: 'live' }), '');
  const paused = platformPauseNotice({ paused: true, state: 'paused', reason: 'MetaAPI incident MT5-2291' });
  assert.match(paused, /paused by Signal Desk for every workspace/i);
  assert.match(paused, /Your own settings are untouched/);
  assert.match(paused, /Reason given: MetaAPI incident MT5-2291/);
  assert.match(platformPauseNotice({ paused: true, state: 'unavailable' }), /could not confirm its platform execution switch/);
  assert.doesNotMatch(platformPauseNotice({ paused: true, state: 'unavailable' }), /paused by Signal Desk for every workspace/, 'an unknown switch is not announced as a deliberate pause');

  const markup = renderToStaticMarkup(React.createElement(ExecutionSettings, {
    settings: { autoTradingEnabled: true, riskMode: 'fixed', riskPercent: 1, maxOpenPositions: 3, dailyLossLimit: 5, lotSizeMode: 'fixed', fixedLotSize: 0.01, maxDailyTrades: 10, executionAccountId: '', breakEvenEnabled: false, breakEvenTriggerPoints: 20, breakEvenOffsetPoints: 0, trailingStopEnabled: false, trailingStopDistancePoints: 10 },
    accounts: [],
    trades: [],
    runtimeAvailable: true,
    platformPause: { paused: true, state: 'paused', reason: 'Maintenance window' },
    onChange() {},
    onSubmit(event) { event.preventDefault(); },
    onToggle() {},
  }));
  assert.match(markup, /execution-paused-notice/);
  assert.match(markup, /Maintenance window/);
  assert.match(markup, /role="alert"/);
});

/* ---------------------------------------------------------------- the source rules */

const srcDir = path.join(here, '..', 'src');
const readSource = (...parts) => readFileSync(path.join(srcDir, ...parts), 'utf8');

test('only the shared view decides what a platform state looks like', () => {
  const panel = readSource('components', 'AdminPanel.jsx');
  assert.match(panel, /from '\.\.\/lib\/platform-view\.js'/, 'the health card takes its labels from the shared module');
  assert.equal(/live:\s*'Live'/.test(panel), false, 'a local label map is how an unknown read ends up looking green');
  assert.equal(panel.includes("killSwitch?.state || 'live'"), false, 'the fallback has to be the blocked state, never the trading one');

  const settings = readSource('components', 'ExecutionSettings.jsx');
  assert.match(settings, /export function platformPauseNotice/, 'the sentence a user sees about a platform pause lives with the component that shows it');
  assert.equal(settings.includes("request('/api/settings'"), false, 'the panel is told the pause state with its own settings instead of polling separately');

  const banner = readSource('components', 'AnnouncementBanner.jsx');
  assert.match(banner, /announcementCopy/, 'severity wording comes from the shared rules');
  assert.equal(/LEVEL_LABELS|const TAGS =/.test(banner), false);
});

test('a support token is kept in the tab only and never handed to another origin', () => {
  const lib = readSource('lib', 'support-session.js');
  assert.equal(/localStorage\.(set|remove|get)Item/.test(lib), false, 'localStorage would survive the tab and outlive the hour it was issued for');
  assert.match(lib, /sessionStorage/);
  const app = readSource('App.jsx');
  assert.match(app, /readSupportSession\(\)/, 'the app reads the session once at boot, so a reload cannot lose it silently');
  assert.match(app, /\/api\/auth\/support\/exit/, 'leaving support access is announced to the server, not just forgotten locally');
  assert.equal(app.includes("<AdminPanel token={authToken}"), false, 'the admin panel keeps acting as the administrator, never as the customer');
});
