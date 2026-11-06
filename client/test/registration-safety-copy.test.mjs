import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import React from 'react';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(here, '..', 'src');
const outDir = path.join(here, '.tmp');
const outfile = path.join(outDir, 'registration-auth-mounted.mjs');
mkdirSync(outDir, { recursive: true });

await build({
  entryPoints: [path.join(srcDir, 'components', 'AuthScreen.jsx')],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'node',
  external: ['react', 'react-dom', 'react-dom/client'],
  define: { 'process.env.NODE_ENV': '"development"', 'import.meta.env': JSON.stringify({ PROD: false, DEV: true, VITE_API_URL: '' }) },
  jsx: 'automatic',
  logLevel: 'silent',
});
assert.ok(existsSync(outfile), 'the auth screen bundle was produced');

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
for (const name of ['HTMLElement', 'HTMLInputElement', 'Element', 'Node', 'Event', 'MouseEvent']) {
  Object.defineProperty(globalThis, name, { value: dom.window[name], configurable: true, writable: true });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
after(() => dom.window.close());

const { createRoot } = await import('react-dom/client');
const act = (callback) => React.act(callback);
const { default: AuthScreen } = await import(pathToFileURL(outfile).href);
const normalize = (node) => (node?.textContent || '').replace(/\s+/g, ' ').trim();

test('the auth back-to-home control is a tappable button that returns to the public landing state', async () => {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  let returnedToHome = false;
  await act(async () => {
    root.render(React.createElement(AuthScreen, {
      initialMode: 'login',
      onAuthenticated: () => {},
      onBackToHome: () => { returnedToHome = true; },
    }));
  });

  const backButton = host.querySelector('.auth-back');
  assert.ok(backButton, 'the login screen renders the back action');
  assert.equal(backButton.tagName, 'BUTTON', 'the action is semantically a button');
  assert.equal(normalize(backButton), '← Back to home');
  assert.match(backButton.getAttribute('class'), /\bbutton\b/, 'it uses button styling');
  assert.equal(backButton.compareDocumentPosition(host.querySelector('.auth-card .eyebrow')) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING, dom.window.Node.DOCUMENT_POSITION_FOLLOWING,
    'the back control precedes the product eyebrow at the top of the card');
  assert.match(readFileSync(path.join(srcDir, 'styles.css'), 'utf8'), /\.auth-back\{[^}]*min-height:44px/,
    'the ghost button meets the 44px mobile touch target');

  await act(async () => backButton.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })));
  assert.equal(returnedToHome, true, 'clicking the button invokes the callback that clears authIntent and returns to Landing');
  await act(() => root.unmount());
});

test('registration explains that live trading is off until the user confirms the warning', async () => {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(React.createElement(AuthScreen, { initialMode: 'register', onAuthenticated: () => {} }));
  });

  assert.equal(normalize(host.querySelector('h1')), 'Create your workspace', 'this is the registration screen');
  const disclaimer = normalize(host.querySelector('.fine-print'));
  assert.equal(disclaimer, 'Auto-Trading is OFF by default for new workspaces. You will be asked to review your Risk Settings and explicitly confirm a live-trading warning before any orders can be placed. You can turn it off at any time.');
  assert.doesNotMatch(disclaimer, /Auto-Trading\s+is\s+ON\s+by\s+default/i, 'registration never claims a new workspace is armed');

  await act(() => root.unmount());
});
