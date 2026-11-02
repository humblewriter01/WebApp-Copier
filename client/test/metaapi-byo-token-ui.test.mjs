import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import React from 'react';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(here, '..', 'src');
const outfile = path.join(here, '.tmp', 'metaapi-byo-token-mounted.mjs');

await build({
  stdin: {
    contents: [
      "export { default as MetaApiPanel } from './MetaApiPanel.jsx';",
      "export { MetaApiStatusContext, metaApiStatusReducer, staticMetaApiStatusValue } from './MetaApiStatus.jsx';",
    ].join('\n'),
    resolveDir: path.join(srcDir, 'components'),
    loader: 'jsx',
  },
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'node',
  external: ['react', 'react-dom', 'react-dom/client'],
  define: { 'process.env.NODE_ENV': '"development"', 'import.meta.env': '{}' },
  logLevel: 'silent',
});
assert.ok(existsSync(outfile), 'the MetaAPI panel bundle was produced');

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
for (const name of ['HTMLElement', 'HTMLInputElement', 'Element', 'Node', 'Event', 'MouseEvent', 'getComputedStyle']) {
  Object.defineProperty(globalThis, name, { value: dom.window[name], configurable: true, writable: true });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
after(() => { dom.window.close(); globalThis.fetch = originalFetch; });

const { createRoot } = await import('react-dom/client');
const { MetaApiPanel, MetaApiStatusContext, metaApiStatusReducer, staticMetaApiStatusValue } = await import(pathToFileURL(outfile).href);
const act = (callback) => React.act(callback);
const unavailable = metaApiStatusReducer(undefined, { type: 'resolve', payload: { available: false }, at: 1 });
const originalFetch = globalThis.fetch;

test('the Advanced BYO token toggle reveals a password input even if platform setup is unavailable', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ accounts: [], inactivity: null }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(React.createElement(
      MetaApiStatusContext.Provider,
      { value: staticMetaApiStatusValue(unavailable) },
      React.createElement(MetaApiPanel, { token: 'session-token', channelCount: 0 }),
    ));
  });

  const toggle = host.querySelector('.metaapi-token-toggle');
  assert.ok(toggle, 'the BYO option is available without the platform provisioning token');
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(host.querySelector('#metaapi-own-token'), null, 'the secret input stays hidden until requested');
  await act(async () => { toggle.click(); });

  const tokenInput = host.querySelector('#metaapi-own-token');
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  assert.equal(tokenInput?.type, 'password', 'the BYO API token is masked');
  assert.ok(tokenInput.required, 'the token is required while the BYO option is active');
  assert.equal(host.querySelector('#metaapi-own-token-fields').hidden, false);
  assert.match(host.textContent, /Encrypted for this account/);

  await act(async () => root.unmount());
  globalThis.fetch = originalFetch;
});
