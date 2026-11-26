import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import React from 'react';
import { pathToFileURL, fileURLToPath } from 'node:url';

const outfile = fileURLToPath(new URL('.tmp/signal-message-mounted.mjs', import.meta.url));
await build({
  entryPoints: [fileURLToPath(new URL('../src/components/SignalMessage.jsx', import.meta.url))],
  outfile, bundle: true, format: 'esm', platform: 'node', external: ['react', 'react-dom'], logLevel: 'silent',
});
const { default: SignalMessage } = await import(pathToFileURL(outfile).href);
const dom = new JSDOM('<!doctype html><html><body></body></html>');
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
after(() => dom.window.close());
const { createRoot } = await import('react-dom/client');

async function mount(t, initial) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  t.after(async () => { await React.act(() => root.unmount()); host.remove(); });
  const render = (props) => React.act(() => root.render(React.createElement(SignalMessage, props)));
  await render(initial);
  const click = () => React.act(async () => host.querySelector('button').click());
  return { host, render, click };
}

const signal = { id: 's1', message: 'A'.repeat(200), messageTruncated: true, editedAt: null };

test('full text loads only on click; collapse and polling reuse it without another download', async (t) => {
  let calls = 0;
  const props = { signal, onLoadMessage: async (id) => { calls++; assert.equal(id, 's1'); return { message: 'A'.repeat(200) + ' original suffix' }; } };
  const ui = await mount(t, props);
  assert.equal(calls, 0);
  assert.ok(ui.host.textContent.includes('…'));
  await ui.click();
  assert.equal(calls, 1);
  assert.match(ui.host.textContent, /original suffix/);
  assert.equal(ui.host.querySelector('button').getAttribute('aria-expanded'), 'true');
  await ui.click();
  assert.doesNotMatch(ui.host.textContent, /original suffix/);
  await ui.render({ ...props, signal: { ...signal } });
  await ui.click();
  assert.equal(calls, 1);
  assert.match(ui.host.textContent, /original suffix/);
});

test('failed expansion stays a preview and can be retried', async (t) => {
  let calls = 0;
  const ui = await mount(t, { signal, onLoadMessage: async () => {
    if (++calls === 1) throw new Error('Message unavailable; try again.');
    return { message: 'Recovered original' };
  } });
  await ui.click();
  assert.match(ui.host.querySelector('[role="alert"]').textContent, /try again/);
  assert.equal(ui.host.querySelector('button').disabled, false);
  await ui.click();
  assert.equal(calls, 2);
  assert.match(ui.host.textContent, /Recovered original/);
  assert.equal(ui.host.querySelector('[role="alert"]'), null);
});

test('a changed message revision discards cached text, including edits beyond the preview', async (t) => {
  let calls = 0;
  const props = { signal, onLoadMessage: async () => ({ message: `Original revision ${++calls}` }) };
  const ui = await mount(t, { ...props, key: 's1:revision1' });
  await ui.click();
  assert.match(ui.host.textContent, /revision 1/);
  await ui.render({ ...props, key: 's1:revision2', signal: { ...signal, editedAt: '2026-11-26T12:00:00Z' } });
  assert.doesNotMatch(ui.host.textContent, /revision 1/);
  assert.equal(calls, 1, 'an edit does not automatically download full text');
  await ui.click();
  assert.match(ui.host.textContent, /revision 2/);
});

test('short messages need neither a fetch nor an expansion button', async (t) => {
  const ui = await mount(t, { signal: { id: 'short', message: 'BUY EURUSD', messageTruncated: false }, onLoadMessage: () => { throw new Error('must not fetch'); } });
  assert.equal(ui.host.querySelector('button'), null);
  assert.equal(ui.host.textContent, 'BUY EURUSD');
});

test('the history wires authenticated on-demand reads and keys cached text by the server edit revision', () => {
  const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  const table = readFileSync(new URL('../src/components/SignalTable.jsx', import.meta.url), 'utf8');
  assert.ok(app.includes('await request(`/api/signals/${encodeURIComponent(id)}/message`, authToken)'));
  assert.ok(app.includes('onLoadMessage={loadSignalMessage}'));
  assert.ok(table.includes("key={`${signal.id}:${signal.editedAt || ''}:${signal.message}`}"));
});
