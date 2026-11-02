import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import React from 'react';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const stylesPath = path.resolve(__dirname, '../src/styles.css');
const styles = fs.readFileSync(stylesPath, 'utf8');

const tmpDir = path.resolve(__dirname, '.tmp');
fs.mkdirSync(tmpDir, { recursive: true });

const bundleOutfile = path.join(tmpDir, 'ux-test-bundle.mjs');
await build({
  stdin: {
    contents: `
      export { default as AdminPanel } from '../src/components/AdminPanel.jsx';
      export { default as MetaApiPanel } from '../src/components/MetaApiPanel.jsx';
      export { MetaApiStatusProvider } from '../src/components/MetaApiStatus.jsx';
      export { TelegramStatusProvider } from '../src/components/TelegramStatus.jsx';
      export { default as RiskSettings } from '../src/components/RiskSettings.jsx';
      export { default as AdvancedSettings } from '../src/components/AdvancedSettings.jsx';
    `,
    resolveDir: __dirname,
    loader: 'jsx',
  },
  outfile: bundleOutfile,
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
for (const name of ['HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLSelectElement', 'Element', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'MutationObserver']) {
  Object.defineProperty(globalThis, name, { value: dom.window[name], configurable: true, writable: true });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

after(() => dom.window.close());

const { createRoot } = await import('react-dom/client');
const act = (callback) => React.act(callback);
const {
  AdminPanel,
  MetaApiPanel,
  MetaApiStatusProvider,
  TelegramStatusProvider,
  RiskSettings,
  AdvancedSettings,
} = await import(pathToFileURL(bundleOutfile).href);

async function click(element) {
  assert.ok(element, 'the control under test exists');
  await act(async () => {
    element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

async function typeInto(element, value) {
  assert.ok(element, 'the field under test exists');
  const proto = element.tagName === 'TEXTAREA'
    ? dom.window.HTMLTextAreaElement.prototype
    : element.tagName === 'SELECT'
      ? dom.window.HTMLSelectElement.prototype
      : dom.window.HTMLInputElement.prototype;
  await act(async () => { element.focus?.(); });
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(element, value);
  await act(async () => {
    element.dispatchEvent(new dom.window.Event(element.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
  });
}

test('Audit Log component wraps JSON metadata in <pre> inside <details class="audit-meta"> and CSS prevents vertical character stacking', async () => {
  const auditMetadata = {
    previousPlan: 'free',
    newPlan: 'pro',
    reason: 'Manual upgrade after bank transfer verification',
    reference: 'FLW-TX-998877665544332211',
  };

  globalThis.fetch = async (url) => {
    const pathOnly = String(url).replace(/^https?:\/\/[^/]+/, '').split('?')[0];
    const json = (body) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
    if (pathOnly === '/api/admin/audit-logs') {
      return json({
        entries: [
          {
            id: 'a-json-1',
            createdAt: '2026-03-04T12:00:00Z',
            actorEmail: 'very.long.administrator.email.address@signaldesk-operations.example.com',
            action: 'subscription.grant',
            targetType: 'user',
            targetId: 'usr_01J9Z8X7W6V5U4T3S2R1Q0P9N8',
            summary: 'Granted Pro to trader@example.com for 30 days',
            metadata: auditMetadata,
          },
        ],
        total: 1,
        totalEntries: 1,
        actions: [{ key: 'subscription.grant', label: 'subscription.grant' }],
      });
    }
    if (pathOnly === '/api/admin/overview') return json({ stats: { totalUsers: 1, adminUsers: 1, suspendedUsers: 0, paidUsers: 1 } });
    if (pathOnly === '/api/admin/users') return json({ users: [], total: 0 });
    if (pathOnly === '/api/admin/pricing') return json({ configured: true, webhookConfigured: true, currency: 'NGN', supportedCurrencies: ['NGN', 'USD'], billing: {}, plans: [] });
    if (pathOnly === '/api/admin/promo-codes') return json({ promoCodes: [] });
    if (pathOnly === '/api/admin/billing') return json({ configured: true, summary: { currency: 'NGN', revenue: [] }, transactions: [] });
    if (pathOnly === '/api/admin/health') return json({ runtimeEnabled: true, generatedAt: '2026-03-04T12:00:00Z', killSwitch: { paused: false, state: 'live', label: 'Live', headline: 'Live', ready: true }, checks: [], queue: {}, errors: [], counts: {} });
    if (pathOnly === '/api/admin/announcements') return json({ announcements: [] });
    if (pathOnly === '/api/admin/signals/purge-preview') return json({ olderThanDays: 90, signals: 0, unlinkableTrades: 0 });
    if (pathOnly === '/api/admin/signals') return json({ signals: [], total: 0 });
    return json({});
  };

  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(React.createElement(AdminPanel, { token: 't-admin', currentUser: { id: 'admin-1', role: 'admin' } }));
    });

    const auditTab = document.getElementById('admin-tab-audit');
    assert.ok(auditTab, 'Audit log tab is rendered');
    await click(auditTab);

    const whatHappenedCell = container.querySelector('.audit-table td[data-label="What happened"]');
    assert.ok(whatHappenedCell, 'Audit Log "What happened" cell is rendered');

    const details = whatHappenedCell.querySelector('details.audit-meta');
    assert.ok(details, 'Metadata is rendered inside <details class="audit-meta">');

    const pre = details.querySelector('pre');
    assert.ok(pre, 'JSON payload is wrapped in a <pre> element');
    assert.equal(pre.textContent, JSON.stringify(auditMetadata, null, 2), '<pre> preserves multi-line formatted JSON');

    // Verify CSS rules for .audit-meta and .audit-meta pre prevent vertical character-by-character stacking
    assert.match(
      styles,
      /\.audit-meta\{[^}]*width:100%[^}]*min-width:0[^}]*flex-shrink:0/,
      '.audit-meta takes full width, has min-width: 0, and cannot be squished by a flex row',
    );
    assert.match(
      styles,
      /\.audit-meta pre\{[^}]*font-family:ui-monospace[^}]*overflow-x:auto[^}]*white-space:pre;overflow-wrap:normal;word-break:normal/,
      '.audit-meta pre uses monospace font, horizontal scrolling, white-space: pre, and normal word breaking instead of anywhere/break-all',
    );
    assert.match(
      styles,
      /\.audit-meta pre\{[^}]*background:#f5f7fa/,
      '.audit-meta pre has a subtle background',
    );
    assert.match(
      styles,
      /\.admin-table td\[data-label="What happened"\][^{]*\{[^}]*flex-direction:column;align-items:flex-start/,
      'On mobile, What happened cell stacks summary and Details vertically instead of side-by-side in a horizontal flex row',
    );
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test('MT4/MT5 connection form renders backend and setup errors contextually inside the <form> element, not in the bottom card', async () => {
  globalThis.fetch = async (url, options = {}) => {
    const pathOnly = String(url).replace(/^https?:\/\/[^/]+/, '').split('?')[0];
    const method = (options.method || 'GET').toUpperCase();
    const json = (body, status = 200) => ({
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(body),
    });

    if (pathOnly === '/api/metaapi/provisioning-status') {
      return json({ available: true });
    }
    if (pathOnly === '/api/telegram/status') {
      return json({ configured: true, connected: true, listening: true });
    }
    if (pathOnly === '/api/metaapi/linked-accounts') {
      return json({ accounts: [], inactivity: { deletionDays: 30, warningDays: 25, exempt: false } });
    }
    if (pathOnly === '/api/metaapi/provisioned-accounts' && method === 'POST') {
      return json(
        { message: 'MetaAPI rejected provisioning (403 Forbidden): token lacks provisioning-profile access for this broker server.' },
        403,
      );
    }
    return json({});
  };

  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(
        React.createElement(
          TelegramStatusProvider,
          { token: 't-user' },
          React.createElement(
            MetaApiStatusProvider,
            { token: 't-user' },
            React.createElement(MetaApiPanel, { token: 't-user', channelCount: 2 }),
          ),
        ),
      );
    });

    const setupSection = container.querySelector('section[aria-labelledby="metaapi-setup-title"]');
    const accountsSection = container.querySelector('section[aria-labelledby="metaapi-accounts-title"]');
    assert.ok(setupSection, 'Setup section is rendered');
    assert.ok(accountsSection, 'Connected accounts section is rendered');

    const form = setupSection.querySelector('form.form-stack');
    assert.ok(form, 'Add MT4/MT5 account form is rendered inside the setup section');

    const nameInput = form.querySelector('#metaapi-account-name');
    const serverInput = form.querySelector('#metaapi-server');
    await typeInto(nameInput, 'ICMarkets MT5 Live');
    await typeInto(serverInput, 'ICMarketsSC-MT5-4');

    const submitButton = form.querySelector('button[type="submit"]');
    assert.equal(submitButton.disabled, false, 'Submit button is enabled once account name and server are entered');

    await act(async () => {
      form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    });

    const formError = form.querySelector('.alert.alert-error[role="alert"]');
    assert.ok(formError, 'Error alert renders directly inside the MT4/MT5 setup <form>');
    assert.match(formError.textContent, /403 Forbidden/, 'The backend error message is shown inside the form');

    // Ensure the error is positioned above the submit button inside the form
    const formChildren = Array.from(form.children);
    const errorIndex = formChildren.indexOf(formError);
    const submitIndex = formChildren.indexOf(submitButton);
    assert.ok(errorIndex !== -1 && errorIndex < submitIndex, 'Contextual error alert sits directly above the submit button inside the form');

    // Ensure the error does NOT render at the bottom of the Connected trading accounts section
    const bottomSectionError = accountsSection.querySelector('.alert.alert-error');
    assert.equal(bottomSectionError, null, 'Setup form error does not render in the bottom Connected trading accounts card');
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test('RiskSettings and AdvancedSettings render submission errors contextually inside their <form> elements', async () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const sampleSettings = {
    riskPercent: 1,
    maxOpenPositions: 3,
    maxDailyTrades: 5,
    dailyLossLimit: 5,
    autoTradingEnabled: false,
    lotSizeMode: 'risk_based',
    fixedLotSize: 0.01,
  };
  try {
    await act(async () => {
      root.render(
        React.createElement(
          'div',
          null,
          React.createElement(RiskSettings, {
            settings: sampleSettings,
            onChange: () => {},
            onSubmit: (e) => e.preventDefault(),
            error: 'Risk percent must be between 0.1 and 5.',
          }),
          React.createElement(AdvancedSettings, {
            settings: sampleSettings,
            accounts: [],
            trades: [],
            runtimeAvailable: true,
            onChange: () => {},
            onSubmit: (e) => e.preventDefault(),
            error: 'Select a deployed trading account before enabling execution.',
          }),
        ),
      );
    });

    const riskForm = container.querySelector('form.risk-settings-form');
    assert.ok(riskForm, 'RiskSettings form is rendered');
    const riskAlert = riskForm.querySelector('.alert.alert-error[role="alert"]');
    assert.ok(riskAlert, 'RiskSettings error renders inside form.risk-settings-form');
    assert.match(riskAlert.textContent, /Risk percent must be between 0\.1 and 5/);

    const execForm = container.querySelector('form.execution-settings-form');
    assert.ok(execForm, 'AdvancedSettings form is rendered');
    const execAlert = execForm.querySelector('.alert.alert-error[role="alert"]');
    assert.ok(execAlert, 'AdvancedSettings error renders inside form.execution-settings-form');
    assert.match(execAlert.textContent, /Select a deployed trading account/);
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test('Global layout CSS enforces min-width: 0 on flex/grid containers and break-word wrapping on emails, errors, broker servers, and transaction IDs', () => {
  // 1. Key flex/grid containers must allow shrinking below max-content so long tokens never blow out the viewport
  for (const containerSelector of [
    '.main-area',
    '.content-area',
    '.panel',
    '.metric-card',
    '.chat-row',
    '.chat-row>div',
    '.form-stack',
    '.form-stack label',
    '.form-row',
    '.form-row>*',
    '.user-mini',
    '.pricing-plan-card',
    '.pricing-sync',
    '.profile-fact',
    '.profile-fact dd',
  ]) {
    assert.ok(
      styles.includes(containerSelector) && /min-width:0/.test(styles),
      `Expected ${containerSelector} to be covered by min-width: 0 rules`,
    );
  }

  // 2. Alerts, error messages, broker server rows, emails, and transaction IDs must wrap long unbroken strings
  for (const textSelector of [
    '.alert',
    '.field-error',
    '.account-execution-note',
    '.execution-error-message',
    '.pricing-sync-detail',
    '.health-message',
    '.account-row strong',
    '.account-row small',
    '.chat-row small',
    '.admin-table td',
    '.admin-table td strong',
    '.admin-table td small',
    '.profile-fact dd',
  ]) {
    assert.ok(
      styles.includes(textSelector),
      `Expected ${textSelector} to have explicit text-overflow wrapping rules in styles.css`,
    );
  }

  assert.match(
    styles,
    /\.alert,\.field-error,\.account-execution-note,\.execution-error-message,\.pricing-sync-detail,\.announcement-error,\.health-message,\.signal-outcome-note,\.notice-banner,\.toast-message\{min-width:0;max-width:100%;overflow-wrap:break-word;word-break:break-word\}/,
    'All error and status surfaces wrap long messages cleanly with min-width: 0 and break-word',
  );

  // 3. Mobile admin table cells with multiple elements or long values stack vertically rather than squishing horizontally
  for (const label of ['User', 'Admin', 'Customer', 'Workspace', 'Status', 'Reference', 'Plan', 'What happened', 'Actions']) {
    assert.ok(
      styles.includes(`.admin-table td[data-label="${label}"]`),
      `Mobile admin table stacks td[data-label="${label}"] vertically`,
    );
  }
});
