/**
 * The admin dialogs, mounted and typed into.
 *
 * Every other UI test in this project reads rendered markup, which is the right tool for copy and for
 * layout - and the wrong tool for the one bug this file exists for. A dialog that closes itself while a
 * person is typing is not a markup problem: it is a component whose *lifespan* is decided by its parent's
 * next render. Nothing short of mounting the panel, clicking the button, and typing a character can tell
 * "the dialog is still open" from "the dialog is still open".
 *
 * So this file boots the real `AdminPanel` against a real DOM and a stubbed API, and drives it the way the
 * panel is actually used: open the Suspend dialog, type a reason, search for the next user, switch tabs,
 * press Escape, press every button on every tab. The assertions are the ones a user would notice failing -
 * the dialog is still there, the text they typed is still in it, the caret is still in the field they were
 * typing in, and the click they just made reached the endpoint it names.
 *
 * `jsdom` is a devDependency for this file alone; nothing in `src/` imports it.
 */
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import React from 'react';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(here, '..', 'src');
const outfile = path.join(here, '.tmp', 'admin-panel-mounted.mjs');

await build({
  entryPoints: [path.join(srcDir, 'components', 'AdminPanel.jsx')],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'node',
  external: ['react', 'react-dom', 'react-dom/client'],
  define: {
    'process.env.NODE_ENV': '"development"',
    // The API origin is read from the build environment; a test has none, and none is needed because every
    // request is answered by the stub below.
    'import.meta.env': JSON.stringify({ PROD: false, DEV: true, VITE_API_URL: '' }),
  },
  jsx: 'automatic',
  logLevel: 'silent',
});
assert.ok(existsSync(outfile), 'the mounted admin panel bundle was produced');

// No `pretendToBeVisual`: it starts a request-animation frame loop, and a loop that outlives the last test
// keeps the process - and therefore the test report - from ever draining. The window is closed outright for
// the same reason.
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
// Node 22 defines `navigator` as a getter of its own, so it has to be replaced rather than assigned.
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
for (const name of ['HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLSelectElement', 'Element', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'MutationObserver']) {
  Object.defineProperty(globalThis, name, { value: dom.window[name], configurable: true, writable: true });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

after(() => dom.window.close());

const { createRoot } = await import('react-dom/client');
// Called through `React.`, never pulled off it: an unbound `const act = React.act` leaves React's act queue
// open, which does not throw - it just never finishes, and a test file that never finishes starves the reporter.
const act = (callback) => React.act(callback);
const { default: AdminPanel } = await import(pathToFileURL(outfile).href);

/* ------------------------------------------------------------------ the workspace behind the panel ------------------------------------------------------------------ */

const OVERVIEW = { stats: { totalUsers: 2, adminUsers: 1, suspendedUsers: 0, newUsers7d: 1, paidUsers: 1, totalSignals: 4, linkedTradingAccounts: 1, totalTrades: 2 } };
const USERS = {
  users: [
    { id: 'u-1', name: 'Ada Trader', email: 'ada@example.com', role: 'user', isSuspended: false, subscriptionPlan: 'starter', subscriptionStatus: 'active', createdAt: '2026-01-04T09:00:00.000Z', lastLogin: '2026-02-11T09:00:00.000Z', signalCount: 4 },
    { id: 'u-2', name: 'Bo Trader', email: 'bo@example.com', role: 'user', isSuspended: false, subscriptionPlan: 'free', subscriptionStatus: 'free', createdAt: '2026-01-05T09:00:00.000Z', lastLogin: null, signalCount: 0 },
  ],
  total: 2,
};
const HEALTHY = {
  generatedAt: '2026-10-25T12:00:00.000Z', windowHours: 24, runtimeEnabled: true, queue: { pending: 0 },
  counts: { available: true }, errorsAvailable: true, errorsTruncated: false,
  killSwitch: { state: 'live', paused: false, reason: null },
  checks: [{ key: 'kill_switch', label: 'Platform switch', state: 'live', headline: 'Live', detail: 'Writing is allowed.' }],
  errors: [],
};
const PRICING = { currency: 'NGN', plans: [{ key: 'starter', name: 'Starter', amount: 60_000, amountMinor: 6_000_000, currency: 'NGN', interval: 'monthly', activeSubscribers: 1, history: [], limits: { maxTradingAccounts: 1, maxTelegramChannels: 10, maxDailySignals: 200 }, sync: { usable: true } }] };

/** A route's answer, with the delay and status a waking service actually produces. */
function json(body, { status = 200, delayMs = 0 } = {}) {
  return async () => {
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body ?? {}) };
  };
}

function defaultRoutes() {
  return {
    '/api/admin/overview': json(OVERVIEW),
    '/api/admin/users': json(USERS),
    '/api/admin/promo-codes': json({ promoCodes: [] }),
    '/api/admin/billing': json({ transactions: [], summary: { currency: 'NGN' } }),
    '/api/admin/pricing': json(PRICING),
    '/api/admin/announcements': json({ announcements: [{ id: 'a-1', message: 'Maintenance Sunday', level: 'warning', state: 'live', dismissalCount: 2 }] }),
    '/api/admin/health': json(HEALTHY),
    '/api/admin/audit-logs': json({ entries: [{ id: 'l-1', action: 'users.suspend', actorEmail: 'root@example.com', targetEmail: 'ada@example.com', summary: 'Suspended', createdAt: '2026-02-11T09:00:00.000Z' }], total: 1, totalEntries: 1, actions: [{ key: 'users.suspend', label: 'Suspensions' }] }),
    '/api/admin/signals': json({ signals: [], total: 0, offset: 0 }),
    '/api/admin/signals/purge-preview': json({ signals: 3, olderThanDays: 30, unlinkableTrades: 0 }),
  };
}

/**
 * Mounts the panel against a stubbed API.
 *
 * `routes` may be extended or overridden per test, and every request is recorded, so an assertion can say
 * not just that the dialog is open but that the button inside it asked for exactly one thing.
 */
async function mountPanel({ routes = {}, render = true } = {}) {
  const table = { ...defaultRoutes(), ...routes };
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const pathOnly = String(url).replace(/^https?:\/\/[^/]+/, '').split('?')[0];
    const method = options.method || 'GET';
    calls.push({ path: pathOnly, method, body: options.body ? JSON.parse(options.body) : null });
    const route = table[pathOnly] || json({});
    return route({ url, options });
  };
  // No console interception here on purpose. A render that throws is rethrown by `act`, so every `await` in
  // these tests is already an assertion that nothing threw - and replacing `console.error` inside a
  // `node:test` child process hijacks the reporter's own writer, which is a test run that never ends.
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  if (render) {
    await act(async () => {
      root.render(React.createElement(AdminPanel, {
        token: 'admin-token',
        currentUser: { id: 'admin-1', name: 'Root', email: 'root@example.com', role: 'admin' },
        onImpersonate: () => {},
      }));
    });
  }
  let closed = false;
  return {
    calls: () => calls,
    container,
    async unmount() {
      if (closed) return;
      closed = true;
      await act(async () => { root.unmount(); });
      container.remove();
    },
  };
}

/* ------------------------------------------------------------------ the few helpers that make the tests readable ------------------------------------------------------------------ */

/**
 * Identity as a boolean. `assert.equal(nodeA, nodeB)` is fine until it fails, and a failing comparison of two
 * DOM nodes hands Node's inspector a jsdom element to describe - the whole document, its listeners, and its
 * owner - which is how a single wrong caret ends the run with an out-of-memory kill instead of a line number.
 */
const same = (a, b) => a === b;

const modal = () => document.querySelector('.admin-action-modal');
const confirmBox = () => document.querySelector('.confirm-modal');
const backdrop = () => document.querySelector('.modal-backdrop');
const all = (selector) => [...document.querySelectorAll(selector)];
const byText = (selector, text) => all(selector).find((element) => element.textContent.trim() === text);
const field = (host, index = 0) => host ? [...host.querySelectorAll('input,select,textarea')][index] : null;

async function click(element) {
  assert.ok(element, 'the control under test exists');
  await act(async () => {
    element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

/**
 * Types exactly as a browser does: the field takes focus, the value is set through the platform's own setter,
 * and the event is dispatched so React's `onChange` runs. Focus first matters - a keyboard only ever types
 * into the element it is sitting in, and the point of several assertions below is that nothing moves the caret
 * afterwards.
 */
async function typeInto(element, value) {
  assert.ok(element, 'the field under test exists');
  const proto = element.tagName === 'TEXTAREA' ? dom.window.HTMLTextAreaElement.prototype : element.tagName === 'SELECT' ? dom.window.HTMLSelectElement.prototype : dom.window.HTMLInputElement.prototype;
  await act(async () => { element.focus?.(); });
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(element, value);
  await act(async () => {
    element.dispatchEvent(new dom.window.Event(element.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
  });
}

async function pressKey(key) {
  await act(async () => {
    document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, bubbles: true }));
    window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, bubbles: true }));
  });
}

async function openDialog(label) {
  await click(byText('button', label));
  const host = modal();
  assert.ok(host, `${label} opens a dialog`);
  return host;
}

/* ------------------------------------------------------------------ the regression ------------------------------------------------------------------ */

test('typing in the Suspend reason keeps the dialog open, and keeps the caret in the field', async () => {
  const panel = await mountPanel();
  try {
    const trigger = byText('button', 'Suspend');
    assert.ok(trigger, 'Ada is on the list and is not the signed-in administrator');
    const host = await openDialog('Suspend');
    const reason = field(host);
    assert.equal(panel.container.contains(host), false, 'the dialog was never inside the panel\'s own subtree');
    for (const [index, character] of [...'cha'].entries()) {
      await typeInto(reason, `chargeback${index ? ' ' : ''}${character}`);
      assert.ok(modal(), `the dialog is still open after character ${index + 1}`);
      assert.equal(field(modal()).value, `chargeback${index ? ' ' : ''}${character}`, 'and it holds what was typed');
      assert.equal(same(document.activeElement, field(modal())), true, 'and the caret never left the field - the bug was a re-focus on every keystroke, which on a phone closes the keyboard');
    }
    assert.equal(same(backdrop().parentNode, document.body), true, 'the backdrop is portal-rendered into the document, not inside the panel subtree that a refresh replaces');
    assert.equal(panel.container.contains(modal()), false, 'so no re-render of the panel can unmount it');
  } finally {
    await panel.unmount();
  }
});

test('the Adjust-plan dialog keeps focus with whichever field was typed in last', async () => {
  const panel = await mountPanel();
  try {
    const host = await openDialog('Adjust plan');
    const [plan, days, endsAt, reason] = [...host.querySelectorAll('input,select')];
    await typeInto(plan, 'pro');
    assert.equal(same(document.activeElement, plan), true, 'choosing a plan leaves the caret on the plan');
    await typeInto(days, '14');
    assert.equal(same(document.activeElement, days), true, 'typing the number of days does not jump to the first field');
    assert.equal(plan.value, 'pro', 'and the choice made a moment ago is still there');
    await typeInto(reason, 'goodwill after the outage');
    assert.equal(same(document.activeElement, reason), true, 'the reason is still being typed into');
    assert.equal(days.value, '14');
    assert.equal(endsAt.disabled, true, 'and the expiry date is disabled while a day count is set, because the two are one choice');
    assert.equal(modal()?.contains(reason), true, 'one dialog, not a second copy');
  } finally {
    await panel.unmount();
  }
});

test('a refresh behind an open dialog cannot close it, or lose the reason', async () => {
  // Slow from the second call on: the panel has to finish its first load before anything can be clicked,
  // and the refresh the test cares about is the one that happens *after* the dialog is already open.
  let usersCalls = 0;
  const panel = await mountPanel({
    routes: {
      '/api/admin/users': async () => {
        usersCalls += 1;
        if (usersCalls > 1) await new Promise((resolve) => setTimeout(resolve, 40));
        return { ok: true, status: 200, text: async () => JSON.stringify(USERS) };
      },
    },
  });
  try {
    const host = await openDialog('Suspend');
    const reason = field(host);
    await typeInto(reason, 'chargeback on subscription');
    const before = panel.calls().length;
    // Exactly what a search does: it re-runs the panel's own refresh while the dialog is open.
    await act(async () => {
      document.querySelector('.admin-search').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    });
    assert.ok(panel.calls().length > before, 'the list really did re-fetch - that part of the panel is working');
    assert.ok(modal(), 'and the dialog is still open over it');
    assert.equal(field(modal()).value, 'chargeback on subscription', 'with the text intact');
    assert.equal(same(document.activeElement, field(modal())), true, 'and the caret where it was');
  } finally {
    await panel.unmount();
  }
});

test('a partial section payload reads as unknown instead of taking the panel down with it', async () => {
  // The failure the report described: one section of the panel threw while rendering, and React unmounted
  // the whole tree - including the dialog that was open on top of it. A health snapshot with no `errors`
  // array is what a gateway answers with when the service behind it is waking up.
  const panel = await mountPanel({ routes: { '/api/admin/health': json({ generatedAt: null }) } });
  try {
    const host = await openDialog('Suspend');
    await typeInto(field(host), 'k');
    await click(byText('[role="tab"]', 'System health'));
    assert.ok(document.querySelector('.admin-tabs'), 'the panel is still mounted');
    assert.ok(modal(), 'the dialog is still open');
    assert.equal(field(modal()).value, 'k', 'with the text intact');
    await click(byText('[role="tab"]', 'Users & activity'));
    assert.equal(field(modal()).value, 'k', 'and switching back still has it');
  } finally {
    await panel.unmount();
  }
});

test('Escape closes the dialog and hands focus back to the button that opened it', async () => {
  const panel = await mountPanel();
  try {
    const trigger = byText('button', 'Suspend');
    // A browser focuses the button a click landed on; a dispatched event does not, so the focus the dialog is
    // expected to hand back has to be given first or this asserts jsdom's event model instead of the app.
    await act(async () => { trigger.focus(); });
    await click(trigger);
    assert.ok(modal());
    await pressKey('Escape');
    assert.equal(modal(), null, 'Escape cancels');
    assert.equal(same(document.activeElement, trigger), true, 'and focus goes back where it came from, not to the top of the page');
  } finally {
    await panel.unmount();
  }
});

test('a press that began inside the dialog can never dismiss it', async () => {
  const panel = await mountPanel();
  try {
    const host = await openDialog('Suspend');
    const reason = field(host);
    const release = (on) => act(async () => { on.dispatchEvent(new dom.window.MouseEvent('mouseup', { bubbles: true })); });
    // The mobile case: the finger goes down on the field, the keyboard closes, the layout shifts, and the
    // release is reported on the backdrop. The dialog has to stay.
    await act(async () => { reason.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true })); });
    await release(backdrop());
    assert.ok(modal(), 'a drag that started in the form does not close it');
    assert.equal(field(modal()).value, '', 'and nothing was typed to lose');
    await act(async () => { backdrop().dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true })); });
    await release(backdrop());
    assert.equal(modal(), null, 'a press that both started and ended on the backdrop does close it');
  } finally {
    await panel.unmount();
  }
});

/* ------------------------------------------------------------------ what the dialogs are for ------------------------------------------------------------------ */

test('the reason typed into a dialog is the reason that reaches the endpoint, once', async () => {
  let patched = 0;
  const panel = await mountPanel({
    routes: {
      '/api/admin/users/u-1': async () => { patched += 1; return { ok: true, status: 200, text: async () => JSON.stringify({}) }; },
    },
  });
  try {
    const host = await openDialog('Suspend');
    await typeInto(field(host), '  chargeback on subscription  ');
    await click(byText('button', 'Suspend user'));
    assert.equal(patched, 1, 'one dialog, one request');
    const sent = panel.calls().find((entry) => entry.method === 'PATCH');
    assert.deepEqual(sent.body, { isSuspended: true, suspensionReason: 'chargeback on subscription' }, 'trimmed, boolean, and exactly the two fields the route writes');
    assert.equal(sent.path, '/api/admin/users/u-1', 'against the account the dialog was opened for');
    assert.equal(modal(), null, 'and the dialog closes itself once the write is done');
    assert.match(document.querySelector('.alert-success').textContent, /Ada Trader has been suspended./);
  } finally {
    await panel.unmount();
  }
});

test('a dialog stays open when the workspace says no, and says why where it was typed', async () => {
  const panel = await mountPanel({
    routes: {
      '/api/admin/users/u-1': async () => ({ ok: false, status: 409, text: async () => JSON.stringify({ userMessage: 'That account has a live trading session; suspend it from the platform first.' }) }),
    },
  });
  try {
    const host = await openDialog('Suspend');
    await typeInto(field(host), 'duvet');
    await click(byText('button', 'Suspend user'));
    assert.ok(modal(), 'a refusal does not swallow the reason that was typed');
    assert.equal(field(modal()).value, 'duvet');
    assert.match(document.querySelector('.alert-error').textContent, /live trading session/, 'the server sentence is shown, in the dialog error slot the panel already uses');
    assert.equal(byText('button', 'Suspend user').disabled, false, 'and it can be corrected and tried again');
  } finally {
    await panel.unmount();
  }
});

test('support access requires a reason before it will spend a session', async () => {
  const panel = await mountPanel();
  try {
    await openDialog('Impersonate');
    await click(byText('button', 'Open support view'));
    assert.equal(panel.calls().filter((entry) => entry.path.endsWith('/impersonate')).length, 0, 'a blank reason never reaches the endpoint');
    assert.ok(modal(), 'the dialog stays open to be corrected');
    await typeInto(field(modal()), 'investigating a signal that did not execute');
    await click(byText('button', 'Open support view'));
    const sent = panel.calls().find((entry) => entry.path.endsWith('/impersonate'));
    assert.equal(sent.method, 'POST');
    assert.deepEqual(sent.body, { reason: 'investigating a signal that did not execute' });
    assert.equal(modal(), null, 'and it closes when the session opens');
  } finally {
    await panel.unmount();
  }
});

test('the confirmation in front of a permanent clear survives a keystroke elsewhere and asks once', async () => {
  let deletes = 0;
  const panel = await mountPanel({
    routes: { '/api/admin/announcements/history': async () => { deletes += 1; return { ok: true, status: 200, text: async () => JSON.stringify({ notice: 'Retired banners removed.' }) }; } },
  });
  try {
    await click(byText('[role="tab"]', 'Announcements'));
    await click(byText('button', 'Clear history'));
    assert.ok(confirmBox(), 'the clear asks first');
    assert.equal(same(confirmBox().parentNode, backdrop()), true, 'and it is portal-rendered like the other dialogs');
    // A keystroke in the panel behind it must not dismiss a confirmation mid-read.
    await typeInto(document.querySelector('.announcement-form textarea'), 'x');
    assert.ok(confirmBox(), 'typing behind the dialog does not close it');
    await click(byText('button', 'Delete retired banners'));
    assert.equal(deletes, 1, 'one delete, for one confirmation');
    assert.equal(confirmBox(), null);
  } finally {
    await panel.unmount();
  }
});

/* ------------------------------------------------------------------ the audit: every button, on every tab ------------------------------------------------------------------ */

const TABS = ['Users & activity', 'System health', 'Pricing & Plans', 'Payments', 'Announcements', 'Audit log', 'Data management'];

test('every button on every tab does something, and nothing unmounts the panel', async () => {
  let writes = 0;
  const answered = (body) => async () => { writes += 1; return { ok: true, status: 200, text: async () => JSON.stringify(body ?? {}) }; };
  const panel = await mountPanel({
    routes: {
      '/api/admin/users/u-1': answered({}),
      '/api/admin/users/u-1/impersonate': answered({ notice: 'Support view opened.' }),
      '/api/admin/users/u-1/signals': answered({ deleted: 0, unlinkedTrades: 0 }),
      '/api/admin/signals/purge': answered({ deleted: 0, unlinkedTrades: 0 }),
      '/api/admin/signals/s-1': answered({ deleted: 1, unlinkedTrades: 0 }),
      '/api/admin/announcements': answered({ notice: 'Announcement saved.' }),
      '/api/admin/announcements/a-1': answered({ notice: 'Retired.' }),
      '/api/admin/announcements/history': answered({ notice: 'Cleared.' }),
      '/api/admin/audit-logs': answered({ notice: 'Cleared.' }),
      '/api/admin/health/errors': answered({ notice: 'Cleared.' }),
      '/api/admin/execution-switch': answered({ notice: 'Paused.', paused: true }),
      '/api/admin/pricing': answered({ pricing: PRICING }),
      '/api/admin/plans/sync': answered({ syncs: [{ planKey: 'starter', usable: true, status: 'in_sync' }] }),
      '/api/admin/promo-codes': answered({ notice: 'Promo code saved.', promoCode: { id: 'p-1', code: 'WELCOME', discountType: 'percentage', discountValue: 10, active: true, maxUses: null, expiresAt: null, usedCount: 0 } }),
    },
  });
  const seen = new Set();
  try {
    for (const tab of TABS) {
      await click(byText('[role="tab"]', tab));
      assert.ok(document.querySelector('.admin-tabs'), `${tab} still shows the panel`);
      // Every control the tab offers, clicked in the order a reader meets them, twice over where a first
      // click opens a dialog - because "the button works" includes "the button in the dialog it opens works".
      for (let pass = 0; pass < 2; pass += 1) {
        for (const button of all('button')) {
          if (!button.isConnected || button.disabled) continue;
          const label = (button.textContent || button.getAttribute('aria-label') || '').trim();
          if (!label || seen.has(`${tab}:${pass}:${label}`)) continue;
          seen.add(`${tab}:${pass}:${label}`);
          // `act` rethrows anything the render path threw, so this line is the assertion that the click did
          // not break the panel - and the one after it is that the panel is still on screen afterwards.
          await click(button);
          assert.ok(document.querySelector('.admin-tabs') || modal() || confirmBox(), `${label} did not take the panel down`);
          if (modal()) { await click(byText('button', 'Cancel')); }
          if (confirmBox()) { await click(byText('button', 'Cancel')); }
        }
      }
    }
    assert.ok(seen.size > 25, `the sweep reached ${seen.size} distinct controls, not a handful`);
    assert.ok(writes > 0, 'and the clicks that should reach the workspace did reach it');
  } finally {
    await panel.unmount();
  }
});

test('no control on the panel is unlabelled, and no dialog button is left outside the dialog', async () => {
  const panel = await mountPanel();
  try {
    for (const tab of TABS) {
      await click(byText('[role="tab"]', tab));
      for (const button of all('button')) {
        const name = (button.textContent || '').trim() || button.getAttribute('aria-label') || '';
        assert.ok(name.length > 0, `an unlabelled button on ${tab}`);
      }
      for (const input of all('input,select,textarea')) {
        const labelled = input.getAttribute('aria-label') || input.closest('label') || (input.id && document.querySelector(`label[for="${input.id}"]`));
        assert.ok(labelled, `an unlabelled ${input.tagName.toLowerCase()} on ${tab}`);
      }
    }
    await click(byText('[role="tab"]', 'Users & activity'));
    const host = await openDialog('Suspend');
    const buttons = [...host.querySelectorAll('button')];
    const submits = buttons.filter((button) => button.type === 'submit');
    assert.equal(submits.length, 1, 'exactly one button in a dialog submits it, so Enter means "the confirm", never the last thing clicked');
    assert.equal(submits[0].textContent.trim(), 'Suspend user', 'and it is the confirm');
    assert.equal(buttons.filter((button) => button.type === 'button').length, 1, 'the other is a plain button: a cancel that submits is a suspend nobody meant');
    for (const button of buttons) {
      assert.equal(same(button.closest('form'), host), true, 'both live inside the dialog form, so a keystroke cannot reach the panel form behind it');
    }
  } finally {
    await panel.unmount();
  }
});

/* ------------------------------------------------------------------ the source-level pins that a mount cannot express ------------------------------------------------------------------ */

test('the dialogs share their one mechanism, so a fix cannot land on one of them only', () => {
  const action = readFileSync(path.join(srcDir, 'components', 'AdminActionModal.jsx'), 'utf8');
  const confirm = readFileSync(path.join(srcDir, 'components', 'ConfirmModal.jsx'), 'utf8');
  for (const [name, source] of [['AdminActionModal', action], ['ConfirmModal', confirm]]) {
    assert.match(source, /createPortal/, `${name} is portal-rendered`);
    assert.match(source, /\[open\]\);/, `${name}'s wiring is keyed on open alone, so a parent render re-runs nothing`);
    assert.doesNotMatch(source, /React\.useEffect\(\(\) => \{[\s\S]{0,600}?\}, \[[^\]]*onCancel[^\]]*\]\);/, `${name} must not re-bind per render on a callback identity`);
    assert.match(source, /pressedOnBackdrop/, `${name} requires the press to start on the backdrop`);
    assert.match(source, /isConnected/, `${name} only restores focus to a node that is still on the page`);
  }
  const panel = readFileSync(path.join(srcDir, 'components', 'AdminPanel.jsx'), 'utf8');
  assert.match(panel, /if \(!painted\) return/, 'the panel blanks itself only before its first paint has finished');
  assert.equal(panel.match(/closeSuspensionForm\(\)/g)?.length ?? 0, 0, 'and a list refresh no longer closes the suspension form on its own');
});

test('while the write is in flight, the dialog holds: no cancel, no backdrop, no Escape, no second submit', async () => {
  let releaseWrite;
  const gate = new Promise((resolve) => { releaseWrite = resolve; });
  const panel = await mountPanel({
    routes: {
      '/api/admin/users/u-1': async () => {
        await gate;
        return { ok: true, status: 200, text: async () => JSON.stringify({}) };
      },
    },
  });
  try {
    const host = await openDialog('Suspend');
    await typeInto(field(host), 'chargeback');
    await click(byText('button', 'Suspend user'));
    assert.ok(modal(), 'the dialog is open and working');
    assert.equal(byText('button', 'Working\u2026') !== undefined, true, 'and it says so on the button');
    assert.equal(byText('button', 'Cancel').disabled, true, 'both buttons are held');
    await pressKey('Escape');
    await act(async () => {
      backdrop().dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true }));
      backdrop().dispatchEvent(new dom.window.MouseEvent('mouseup', { bubbles: true }));
    });
    assert.ok(modal(), 'neither Escape nor the backdrop dismisses a dialog whose request has not been answered');
    const attempts = panel.calls().filter((entry) => entry.method === 'PATCH').length;
    await click(byText('button', 'Working\u2026'));
    assert.equal(panel.calls().filter((entry) => entry.method === 'PATCH').length, attempts, 'and a second click on the held button cannot ask twice');
    releaseWrite();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
    assert.equal(panel.calls().filter((entry) => entry.method === 'PATCH').length, 1, 'exactly one suspend went to the workspace');
    assert.equal(modal(), null, 'and the dialog closes when it comes back');
  } finally {
    releaseWrite();
    await panel.unmount();
  }
});
