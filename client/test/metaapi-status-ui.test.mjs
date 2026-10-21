import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(here, '..', 'src');
const outfile = path.join(here, '.tmp', 'metaapi-status.mjs');

// JSX needs one throwaway bundle per run; React stays external so the bundle shares this
// process' copy and the renders are real react-dom renders, including context.
await build({
  stdin: {
    contents: [
      "export { MetaApiStatusContext, MetaApiStatusPill, metaApiStatusReducer, metaApiProvisioningView, staticMetaApiStatusValue, METAAPI_PROVISIONING_STATUS_ENDPOINT } from './MetaApiStatus.jsx';",
      "export { TelegramStatusContext, telegramStatusReducer } from './TelegramStatus.jsx';",
      "export { default as MetaApiPanel } from './MetaApiPanel.jsx';",
    ].join('\n'),
    resolveDir: path.join(srcDir, 'components'),
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

const {
  MetaApiStatusContext, MetaApiStatusPill, metaApiStatusReducer, metaApiProvisioningView,
  staticMetaApiStatusValue, METAAPI_PROVISIONING_STATUS_ENDPOINT, MetaApiPanel, telegramStatusReducer,
} = await import(pathToFileURL(outfile).href);

const UNKNOWN = metaApiStatusReducer(undefined, { type: '@@initial' });
const stateFor = (payload, at = 1) => metaApiStatusReducer(UNKNOWN, { type: 'resolve', payload, at });
const viewFor = (payload) => metaApiProvisioningView(stateFor(payload));
const failed = (message) => metaApiStatusReducer(UNKNOWN, { type: 'reject', message });
const render = (element, state) => renderToStaticMarkup(
  React.createElement(MetaApiStatusContext.Provider, { value: staticMetaApiStatusValue(state) }, element),
);
const renderPanel = (state) => render(React.createElement(MetaApiPanel, { token: 'test-token', channelCount: 2 }), state);

/* ------------------------------------------------------------------ the state machine */

test('account setup availability starts unknown, never unavailable', () => {
  assert.equal(UNKNOWN.available, null, 'a default of false is what made the panel claim setup was unavailable');
  assert.equal(UNKNOWN.loading, true);
  assert.deepEqual(metaApiProvisioningView(UNKNOWN), {
    key: 'checking', known: false, allowSetupForm: false, label: 'Checking setup…', tone: 'pending', detail: null,
    available: false, stale: false, checkedAt: null,
  });
});

test('only a backend answer can decide whether setup is ready', () => {
  assert.equal(viewFor({ available: true }).key, 'ready');
  assert.equal(viewFor({ available: true }).allowSetupForm, true);
  assert.equal(viewFor({ available: false }).key, 'unavailable');
  assert.equal(viewFor({ available: false }).allowSetupForm, false);
  assert.equal(viewFor({}).key, 'unavailable', 'a missing flag is a server answer of no, once confirmed');
});

test('a failed check keeps the last confirmed answer and never invents a problem', () => {
  const ready = stateFor({ available: true });
  const afterFailure = metaApiStatusReducer(ready, { type: 'reject', message: 'Service Unavailable' });
  assert.equal(afterFailure.available, true, 'the last confirmed state survives');
  assert.equal(afterFailure.stale, true);
  assert.equal(metaApiProvisioningView(afterFailure).key, 'ready');

  const neverConfirmed = failed('offline');
  assert.equal(neverConfirmed.available, null);
  assert.equal(neverConfirmed.loading, true);
  assert.equal(metaApiProvisioningView(neverConfirmed).key, 'unreachable');
  assert.equal(metaApiProvisioningView(neverConfirmed).allowSetupForm, false, 'unknown is not a reason to open the create form');
});

test('signing out clears the shared state instead of leaving a stale answer', () => {
  assert.deepEqual(metaApiStatusReducer(stateFor({ available: true }), { type: 'reset' }), UNKNOWN);
});

test('the MetaAPI indicator obeys the same bookkeeping rules as the Telegram one', () => {
  // Both endpoints run through the same helpers in lib/status-resource.js, so the two
  // states cannot drift apart: the same action sequence must produce the same
  // loading/stale/error/checkedAt transitions, whatever the endpoint means.
  const telegramUnknown = telegramStatusReducer(undefined, { type: '@@initial' });
  const shared = (state) => ({ loading: state.loading, stale: state.stale, error: state.error, checkedAt: state.checkedAt });
  const sequences = [
    [{ type: 'resolve', payload: { available: true, connected: true, configured: true }, at: 5 }],
    [{ type: 'resolve', payload: { available: true, connected: true, configured: true }, at: 5 }, { type: 'reject', message: 'boom' }],
    [{ type: 'reject', message: 'boom' }],
    [{ type: 'reset' }, { type: 'resolve', payload: { available: false, connected: false, configured: false }, at: 9 }, { type: 'reject', message: 'boom' }],
  ];
  for (const sequence of sequences) {
    let meta = UNKNOWN;
    let telegram = telegramUnknown;
    for (const action of sequence) {
      meta = metaApiStatusReducer(meta, action);
      telegram = telegramStatusReducer(telegram, action);
    }
    assert.deepEqual(shared(meta), shared(telegram), `actions ${sequence.map((action) => action.type).join('+')}`);
  }
});

/* ------------------------------------------------------------------------ the rendering */

test('while the check is in flight the panel shows a skeleton, not a verdict', () => {
  const html = renderPanel(UNKNOWN);
  assert.match(html, /Checking whether account setup is available/);
  assert.match(html, /class="skeleton skeleton-block"/);
  assert.equal(html.includes('Account setup is not available yet'), false, 'the app may not explain a problem it has not observed');
  assert.equal(html.includes('Create secure setup link'), false, 'and it may not offer a form that would fail');
  assert.match(html, /Checking setup…/, 'the pill says it is asking, never that setup is missing');
  assert.equal(html.includes('status-pill online'), false);
});

test('a confirmed "no setup" is stated plainly, and still without a form', () => {
  const html = renderPanel(stateFor({ available: false }));
  assert.match(html, /Account setup is not available yet/);
  assert.match(html, /ask the workspace owner to finish setting up account connections/);
  assert.equal(html.includes('Create secure setup link'), false);
  assert.match(html, /Setup unavailable/);
  assert.equal(html.includes('Checking whether account setup'), false, 'the skeleton is gone once there is an answer');
});

test('a confirmed "ready" renders the create form beside the accounts panel', () => {
  const html = renderPanel(stateFor({ available: true }));
  assert.match(html, /Create secure setup link/);
  assert.match(html, /id="metaapi-account-name"/);
  assert.match(html, /Setup ready/);
  assert.match(html, /status-pill metaapi-status-pill online/);
  assert.equal(html.includes('Account setup is not available yet'), false);
  assert.equal(html.includes('skeleton'), false, 'nothing is loading once the answer is known');
});

test('an unreachable status is admitted as such and offers a retry', () => {
  const html = renderPanel(failed('Service Unavailable'));
  assert.match(html, /Status unavailable/);
  assert.match(html, /could not confirm whether account setup is available/);
  assert.match(html, /Check again/);
  assert.equal(html.includes('Account setup is not available yet'), false, 'a network failure is not a configuration verdict');
});

test('a stale answer keeps the last confirmed state and says so', () => {
  const staleReady = metaApiStatusReducer(stateFor({ available: true }), { type: 'reject', message: 'x' });
  const html = render(React.createElement(MetaApiStatusPill, { detailed: true }), staleReady);
  assert.match(html, /Setup ready/);
  assert.match(html, /last confirmed state/);
});

test('an unwired panel fails safe into the pending state', () => {
  // No provider above the component at all: the fallback must be unknown, not "unavailable".
  const html = renderToStaticMarkup(React.createElement(MetaApiPanel, { token: 'test-token' }));
  assert.match(html, /Checking whether account setup is available/);
  assert.equal(html.includes('Account setup is not available yet'), false);
});

/* --------------------------------------------------------------------- the source rules */

test('the provisioning endpoint is fetched in exactly one module', () => {
  assert.equal(METAAPI_PROVISIONING_STATUS_ENDPOINT, '/api/metaapi/provisioning-status');
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.jsx?$/.test(entry.name) && readFileSync(full, 'utf8').includes(METAAPI_PROVISIONING_STATUS_ENDPOINT)) files.push(path.relative(srcDir, full));
    }
  };
  walk(srcDir);
  assert.deepEqual(files, [path.join('components', 'MetaApiStatus.jsx')], 'no component may fetch or poll the availability of account setup on its own');
});

test('the panel keeps no private copy of the availability', () => {
  const source = readFileSync(path.join(srcDir, 'components', 'MetaApiPanel.jsx'), 'utf8');
  assert.equal(source.includes('setAvailable'), false, 'a boolean local state is how the false answer got invented');
  assert.equal(/>Unavailable</.test(source), false, 'the label must come from the shared view');
  assert.equal(source.includes("request('/api/metaapi/provisioning-status'"), false);
  assert.match(source, /setup\.allowSetupForm/, 'the create form is gated on a confirmed yes');
  assert.match(source, /setup\.key === 'unavailable'/, 'the fallback copy is gated on a confirmed no');
});

test('no component seeds a fetched status flag with a boolean default', () => {
  // The whole class of bug, held shut: a status that arrives from the backend has to begin
  // as unknown, so nothing may initialise one with useState(true) or useState(false).
  const pattern = /\[\s*([A-Za-z0-9_$]*(?:connected|available|ready|status)[A-Za-z0-9_$]*)\s*,\s*set[A-Za-z0-9_$]+\s*\]\s*=\s*useState\((?:true|false)\)/gi;
  const offenders = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.jsx?$/.test(entry.name)) {
        for (const match of readFileSync(full, 'utf8').matchAll(pattern)) offenders.push(`${path.relative(srcDir, full)}: ${match[1]}`);
      }
    }
  };
  walk(srcDir);
  assert.deepEqual(offenders, []);
});

test('both status indicators share one rulebook module', () => {
  const shared = readFileSync(path.join(srcDir, 'lib', 'status-resource.js'), 'utf8');
  assert.match(shared, /loading: !confirmed/, 'a failed check may only look unknown when nothing was ever confirmed');
  for (const component of ['TelegramStatus.jsx', 'MetaApiStatus.jsx']) {
    const source = readFileSync(path.join(srcDir, 'components', component), 'utf8');
    assert.match(source, /statusFailed/, `${component} must reuse the shared failure policy`);
    assert.match(source, /statusSettled/, `${component} must reuse the shared settle policy`);
    assert.match(source, /useStatusResource/, `${component} must reuse the shared fetch lifecycle`);
    assert.equal(/useEffect\(\(\) => \{[\s\S]{0,200}?request\(/.test(source), false, `${component} may not run its own fetch effect`);
  }
});
