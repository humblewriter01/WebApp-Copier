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
const outfile = path.join(outDir, 'admin-email-mounted.mjs');
mkdirSync(outDir, { recursive: true });

await build({
  entryPoints: [path.join(srcDir, 'components', 'AdminPanel.jsx')],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'node',
  external: ['react', 'react-dom', 'react-dom/client'],
  define: {
    'process.env.NODE_ENV': '"development"',
    'import.meta.env': JSON.stringify({ PROD: false, DEV: true, VITE_API_URL: '' }),
  },
  jsx: 'automatic',
  logLevel: 'silent',
});

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
for (const name of ['HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLSelectElement', 'Element', 'Node', 'Event', 'MouseEvent']) {
  Object.defineProperty(globalThis, name, { value: dom.window[name], configurable: true, writable: true });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
after(() => dom.window.close());

const { createRoot } = await import('react-dom/client');
const act = (callback) => React.act(callback);
const { default: AdminPanel } = await import(pathToFileURL(outfile).href);
const REPLY_ID = '33333333-3333-4333-8333-333333333333';
const reply = {
  id: REPLY_ID,
  userId: '22222222-2222-4222-8222-222222222222',
  fromEmail: 'ada@example.com',
  subject: 'Re: Weekly update',
  bodyHtml: '<p>Thank you!</p>',
  bodyText: 'Thank you for the update.\nI have a question.',
  receivedAt: '2026-11-13T10:00:00.000Z',
  inReplyTo: '<broadcast@example.com>',
  read: false,
};

const json = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, async text() { return JSON.stringify(data); } });

async function mountPanel() {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const pathname = String(url).replace(/^https?:\/\/[^/]+/, '').split('?')[0];
    const method = options.method || 'GET';
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ path: pathname, method, body });
    if (pathname === '/api/admin/overview') return json({ stats: {} });
    if (pathname === '/api/admin/users') return json({ users: [], total: 0 });
    if (pathname === '/api/admin/promo-codes') return json({ promoCodes: [] });
    if (pathname === '/api/admin/billing') return json({ summary: { currency: 'NGN' }, transactions: [] });
    if (pathname === '/api/admin/pricing') return json({ currency: 'NGN', plans: [] });
    if (pathname === '/api/admin/announcements') return json({ announcements: [] });
    if (pathname === '/api/admin/broadcast/recipients') return json({ targetAudience: 'all', recipientCount: 2 });
    if (pathname === '/api/admin/broadcast' && method === 'POST') return json({ targetAudience: 'all', recipientCount: 2, sentRecipients: 2, failedRecipients: 0, batchCount: 1 });
    if (pathname === '/api/admin/replies' && method === 'GET') return json({ replies: [{ ...reply }] });
    if (pathname === `/api/admin/replies/${REPLY_ID}/read` && method === 'PATCH') return json({ reply: { id: REPLY_ID, read: true } });
    return json({});
  };

  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(AdminPanel, {
      token: 'admin-token',
      currentUser: { id: 'admin-1', name: 'Root', email: 'root@example.com', role: 'admin' },
      onImpersonate() {},
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return {
    calls,
    container,
    async unmount() {
      await act(async () => { root.unmount(); });
      container.remove();
    },
  };
}

const all = (selector) => [...document.querySelectorAll(selector)];
const byText = (selector, text) => all(selector).find((element) => element.textContent.trim() === text);
async function click(element) {
  assert.ok(element, 'the UI control exists');
  await act(async () => { element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true })); });
}
async function settle() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}
async function typeInto(element, value) {
  const proto = element.tagName === 'TEXTAREA' ? dom.window.HTMLTextAreaElement.prototype : dom.window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(element, value);
  await act(async () => { element.dispatchEvent(new dom.window.Event('input', { bubbles: true })); });
}

test('Email Broadcast renders its form, previews eligible users, and confirms before sending', async () => {
  const panel = await mountPanel();
  try {
    await click(byText('[role="tab"]', 'Email Broadcast'));
    await settle();

    assert.ok(document.querySelector('#admin-section-email'), 'the Email Broadcast tab panel is rendered');
    assert.ok(document.querySelector('#admin-broadcast-audience'), 'the audience dropdown is present');
    assert.ok(document.querySelector('#admin-broadcast-subject'), 'the subject input is present');
    assert.ok(document.querySelector('#admin-broadcast-body'), 'the body textarea is present');
    assert.match(document.querySelector('#admin-section-email').textContent, /2 eligible users/);

    await typeInto(document.querySelector('#admin-broadcast-subject'), 'Weekly update');
    await typeInto(document.querySelector('#admin-broadcast-body'), 'Hello users');
    await click(byText('button', 'Send Broadcast'));
    assert.ok(document.querySelector('[role="alertdialog"]'), 'the bulk send opens a confirmation dialog');
    assert.match(document.querySelector('[role="alertdialog"]').textContent, /Are you sure you want to send this to 2 users\?/);

    await click(byText('button', 'Send broadcast'));
    await settle();
    const send = panel.calls.find((call) => call.path === '/api/admin/broadcast' && call.method === 'POST');
    assert.deepEqual(send?.body, { targetAudience: 'all', subject: 'Weekly update', body: 'Hello users' });
    assert.match(document.querySelector('#admin-section-email').textContent, /Brevo accepted the broadcast for 2 users/);
  } finally {
    await panel.unmount();
  }
});

test('Inbox renders replies and expanding an unread message displays its body and marks it read', async () => {
  const panel = await mountPanel();
  try {
    await click(byText('[role="tab"]', 'Inbox'));
    await settle();

    const section = document.querySelector('#admin-section-inbox');
    assert.ok(section, 'the Inbox tab panel is rendered');
    assert.match(section.textContent, /ada@example\.com/);
    assert.match(section.textContent, /Re: Weekly update/);
    assert.match(section.textContent, /Unread/);
    assert.match(section.textContent, /Nov 13, 2026|11\/13\/2026|13\/11\/2026/);

    const messageButton = section.querySelector('.admin-inbox-trigger');
    assert.equal(messageButton.getAttribute('aria-expanded'), 'false');
    await click(messageButton);
    await settle();
    assert.equal(messageButton.getAttribute('aria-expanded'), 'true');
    assert.match(section.textContent, /Thank you for the update\./);
    assert.match(section.textContent, /Read/);
    assert.ok(panel.calls.some((call) => call.path === `/api/admin/replies/${REPLY_ID}/read` && call.method === 'PATCH'), 'opening the reply marks it read through the admin endpoint');
    assert.match(section.querySelector('.admin-inbox-message pre').textContent, /I have a question\./);
  } finally {
    await panel.unmount();
  }
});
