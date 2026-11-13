import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import React from 'react';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(here, '..', 'src');
const outDir = path.join(here, '.tmp');
mkdirSync(outDir, { recursive: true });

await build({
  entryPoints: [
    path.join(srcDir, 'components', 'ContactSupportModal.jsx'),
    path.join(srcDir, 'components', 'Sidebar.jsx'),
  ],
  outdir: outDir,
  bundle: true,
  format: 'esm',
  platform: 'node',
  external: ['react', 'react-dom', 'react-dom/client'],
  define: {
    'process.env.NODE_ENV': '"development"',
    'import.meta.env': JSON.stringify({ PROD: false, DEV: true, VITE_API_URL: '' }),
  },
  outExtension: { '.js': '.mjs' },
  logLevel: 'silent',
});

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
for (const name of ['HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'Element', 'Node', 'Event', 'MouseEvent']) {
  Object.defineProperty(globalThis, name, { value: dom.window[name], configurable: true, writable: true });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
after(() => dom.window.close());

const { createRoot } = await import('react-dom/client');
const act = (callback) => React.act(callback);
const { default: ContactSupportModal } = await import(pathToFileURL(path.join(outDir, 'ContactSupportModal.mjs')).href);
const { default: Sidebar } = await import(pathToFileURL(path.join(outDir, 'Sidebar.mjs')).href);
const json = (data, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  async text() { return JSON.stringify(data); },
});

async function mount(element) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(element); });
  return {
    container,
    async unmount() {
      await act(async () => { root.unmount(); });
      container.remove();
    },
  };
}

async function click(element) {
  assert.ok(element, 'the control exists');
  await act(async () => { element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true })); });
}

async function typeInto(element, value) {
  const proto = element.tagName === 'TEXTAREA' ? dom.window.HTMLTextAreaElement.prototype : dom.window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(element, value);
  await act(async () => { element.dispatchEvent(new dom.window.Event('input', { bubbles: true })); });
}

async function settle() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

test('Contact Support submits the authenticated user message and shows the requested green confirmation', async () => {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url, options, body: options.body ? JSON.parse(options.body) : null });
    return json({ sent: true });
  };
  let closed = false;
  const panel = await mount(React.createElement(ContactSupportModal, {
    open: true,
    token: 'user-session-token',
    onClose() { closed = true; },
  }));
  try {
    const dialog = document.querySelector('[role="dialog"]');
    assert.ok(dialog);
    assert.ok(document.querySelector('#support-contact-subject'));
    assert.ok(document.querySelector('#support-contact-message'));
    await typeInto(document.querySelector('#support-contact-subject'), 'Help with Telegram');
    await typeInto(document.querySelector('#support-contact-message'), 'I cannot connect my account.');
    await click([...document.querySelectorAll('button')].find((button) => button.textContent.trim() === 'Send Message'));
    await settle();

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, '/api/support/contact');
    assert.equal(calls[0].options.method, 'POST');
    assert.equal(calls[0].options.headers.Authorization, 'Bearer user-session-token');
    assert.deepEqual(calls[0].body, { subject: 'Help with Telegram', message: 'I cannot connect my account.' });
    assert.equal(document.querySelector('.alert-success')?.textContent, 'Your message has been sent. We will reply to your email within 24 hours.');
    assert.ok(document.querySelector('.alert-success'), 'the success copy is shown in a green alert');
    assert.equal(document.querySelector('#support-contact-message'), null, 'the submitted form cannot be sent twice');
    await click([...document.querySelectorAll('button')].find((button) => button.textContent.trim() === 'Close'));
    assert.equal(closed, true, 'the success view can be dismissed');
  } finally {
    await panel.unmount();
  }
});

test('the sidebar Contact Support button invokes the shared open-modal callback', async () => {
  let opened = 0;
  const panel = await mount(React.createElement(Sidebar, {
    active: 'overview',
    user: { role: 'user', name: 'Amina Yusuf', email: 'amina@example.com' },
    onNavigate() {},
    onSignOut() {},
    onContactSupport() { opened += 1; },
    onClose() {},
  }));
  try {
    await click(document.querySelector('.sidebar-contact-support'));
    assert.equal(opened, 1);
    assert.ok(document.querySelector('.logout-button'), 'Contact Support appears alongside the account and Sign out controls');
  } finally {
    await panel.unmount();
  }
});
