import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clientRoot = path.resolve(__dirname, '..');
const srcDir = path.join(clientRoot, 'src');
const tmpDir = path.join(__dirname, '.tmp');

const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
  url: 'https://signal.example/dashboard',
  pretendToBeVisual: true,
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.HTMLInputElement = dom.window.HTMLInputElement;
globalThis.HTMLSelectElement = dom.window.HTMLSelectElement;
globalThis.HTMLTextAreaElement = dom.window.HTMLTextAreaElement;
globalThis.HTMLButtonElement = dom.window.HTMLButtonElement;
globalThis.HTMLFormElement = dom.window.HTMLFormElement;
globalThis.Event = dom.window.Event;
globalThis.MouseEvent = dom.window.MouseEvent;
globalThis.KeyboardEvent = dom.window.KeyboardEvent;
globalThis.InputEvent = dom.window.InputEvent;
globalThis.CustomEvent = dom.window.CustomEvent;
globalThis.Node = dom.window.Node;
globalThis.Element = dom.window.Element;
globalThis.localStorage = dom.window.localStorage;
globalThis.sessionStorage = dom.window.sessionStorage;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
window.matchMedia = () => ({
  matches: false,
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
});
window.scrollTo = () => {};
window.confirm = () => true;
Element.prototype.scrollIntoView = () => {};

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { act } = React;

const styles = await fs.readFile(path.join(srcDir, 'styles.css'), 'utf8');
const styleEl = document.createElement('style');
styleEl.textContent = styles;
document.head.appendChild(styleEl);

await fs.mkdir(tmpDir, { recursive: true });
const bundleOut = path.join(tmpDir, 'contextual-audit-bundle.mjs');
await build({
  stdin: {
    contents: `
      export { default as TelegramConnect } from './components/TelegramConnect.jsx';
      export { default as MetaApiPanel } from './components/MetaApiPanel.jsx';
      export { default as RiskSettings } from './components/RiskSettings.jsx';
      export { default as AdvancedSettings } from './components/AdvancedSettings.jsx';
      export { default as AdminPanel } from './components/AdminPanel.jsx';
      export { default as BillingPage } from './components/BillingPage.jsx';
      export { TelegramStatusProvider } from './components/TelegramStatus.jsx';
      export { MetaApiStatusProvider } from './components/MetaApiStatus.jsx';
    `,
    resolveDir: srcDir,
    sourcefile: 'contextual-audit-entry.jsx',
    loader: 'jsx',
  },
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  outfile: bundleOut,
  external: ['react', 'react-dom', 'react/jsx-runtime'],
  define: {
    'import.meta.env': JSON.stringify({ PROD: false, DEV: true, VITE_API_URL: '' }),
  },
  loader: { '.js': 'jsx', '.jsx': 'jsx' },
});

const {
  TelegramConnect,
  MetaApiPanel,
  RiskSettings,
  AdvancedSettings,
  AdminPanel,
  BillingPage,
  TelegramStatusProvider,
  MetaApiStatusProvider,
} = await import(`${bundleOut}?t=${Date.now()}`);

function setInputValue(input, value) {
  const proto = input instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : input instanceof HTMLSelectElement
      ? HTMLSelectElement.prototype
      : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

async function flush() {
  for (let i = 0; i < 6; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

test('Auto-Trading toggle renders success/error feedback right next to the switch while AdvancedSettings form save renders above the submit button', async () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  const accounts = [
    { id: 'acc-1', accountName: 'ICMarkets MT5', broker: 'ICMarkets', login: '1001', server: 'ICMarketsSC-Demo', state: 'DEPLOYED', connectionStatus: 'CONNECTED' },
  ];

  function Harness({ shouldFailToggle = false }) {
    const [settings, setSettings] = React.useState({
      riskPercent: 1,
      maxOpenPositions: 3,
      maxDailyTrades: 5,
      dailyLossLimit: 5,
      autoTradingEnabled: false,
      hasAcceptedRiskWarning: true,
      executionAccountId: 'acc-1',
    });
    const [error, setError] = React.useState('');
    const [notice, setNotice] = React.useState('');
    const [toggleError, setToggleError] = React.useState('');
    const [toggleNotice, setToggleNotice] = React.useState('');

    const onToggle = async (enabled) => {
      setError('');
      setNotice('');
      setToggleError('');
      setToggleNotice('');
      if (shouldFailToggle) {
        setToggleError('Auto-Trading could not be enabled because the broker bridge is unreachable.');
        return;
      }
      setSettings((curr) => ({ ...curr, autoTradingEnabled: enabled }));
      setToggleNotice(
        enabled
          ? 'Auto-Trading is on. New eligible Telegram signals may place live orders.'
          : 'Auto-Trading is off. No new signal orders will be submitted.',
      );
    };

    const onSubmit = async (event) => {
      event.preventDefault();
      setToggleError('');
      setToggleNotice('');
      setError('');
      setNotice('Settings saved.');
    };

    return React.createElement(AdvancedSettings, {
      settings,
      accounts,
      trades: [],
      runtimeAvailable: true,
      platformPause: null,
      onChange: setSettings,
      onSubmit,
      onToggle,
      onOpenRiskSettings: () => {},
      onOpenTradingAccounts: () => {},
      onOpenPlan: () => {},
      subscriptionStatus: 'active',
      saving: false,
      error,
      notice,
      toggleError,
      toggleNotice,
    });
  }

  try {
    await act(async () => {
      root.render(React.createElement(Harness, { shouldFailToggle: false }));
      await flush();
    });

    const toggleInput = container.querySelector('#auto-trading-enabled');
    assert.ok(toggleInput, 'Auto-Trading checkbox is rendered');

    await act(async () => {
      toggleInput.click();
      await flush();
    });

    const coreSection = container.querySelector('#core-execution');
    const toggleFeedback = coreSection.querySelector('.auto-trading-toggle-feedback.alert-success');
    assert.ok(toggleFeedback, 'Auto-Trading toggle success alert renders inside #core-execution right next to the switch');
    assert.match(toggleFeedback.textContent, /Auto-Trading is on/);

    // Ensure the toggle feedback is not duplicated at the bottom of the form
    const allSuccessAlerts = container.querySelectorAll('.alert-success');
    assert.equal(allSuccessAlerts.length, 1, 'Only one success alert is rendered (next to the switch)');

    // Now test toggle error rendering next to the switch
    await act(async () => {
      root.render(React.createElement(Harness, { shouldFailToggle: true }));
      await flush();
    });

    await act(async () => {
      container.querySelector('#auto-trading-enabled').click();
      await flush();
    });

    const toggleErrorAlert = container.querySelector('#core-execution .auto-trading-toggle-feedback.alert-error');
    assert.ok(toggleErrorAlert, 'Auto-Trading toggle error renders right next to the switch inside #core-execution');
    assert.match(toggleErrorAlert.textContent, /broker bridge is unreachable/);

    // Now submit the Advanced Settings form and verify the form save confirmation renders above the submit button
    const form = container.querySelector('form.execution-settings-form');
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await flush();
    });

    const formAlerts = [...form.children].filter((el) => el.classList?.contains('alert-success'));
    assert.equal(formAlerts.length, 1, 'Form save confirmation renders at the bottom of form.execution-settings-form');
    assert.match(formAlerts[0].textContent, /Settings saved/);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test('RiskSettings save renders confirmation/error locally inside .risk-settings-form and enforces button spacing', async () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  function RiskHarness({ fail = false }) {
    const [settings, setSettings] = React.useState({
      riskPercent: 1,
      maxOpenPositions: 3,
      maxDailyTrades: 5,
      dailyLossLimit: 5,
      autoTradingEnabled: false,
    });
    const onSubmit = async (event) => {
      event.preventDefault();
      if (fail) throw new Error('Risk percentage must be between 0.01% and 100%.');
    };
    return React.createElement(RiskSettings, {
      settings,
      onChange: setSettings,
      onSubmit,
      onOpenAdvanced: () => {},
      saving: false,
    });
  }

  try {
    await act(async () => {
      root.render(React.createElement(RiskHarness, { fail: false }));
      await flush();
    });

    const form = container.querySelector('form.risk-settings-form');
    const submitBtn = form.querySelector('button[type="submit"]');
    const crosslink = container.querySelector('.risk-settings-crosslink');
    assert.equal(dom.window.getComputedStyle(submitBtn).marginBottom, '16px', 'Save risk settings button has 16px bottom margin');
    assert.equal(dom.window.getComputedStyle(crosslink).marginTop, '16px', 'Helper text below form has 16px top margin');

    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await flush();
    });

    const successAlert = form.querySelector('.alert-success');
    assert.ok(successAlert, 'Risk Settings save confirmation renders inside form.risk-settings-form');
    assert.match(successAlert.textContent, /Risk settings saved|Settings saved/);

    await act(async () => {
      root.render(React.createElement(RiskHarness, { fail: true }));
      await flush();
    });

    await act(async () => {
      container.querySelector('form.risk-settings-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await flush();
    });

    const errorAlert = container.querySelector('form.risk-settings-form .alert-error');
    assert.ok(errorAlert, 'Risk Settings error renders inside form.risk-settings-form');
    assert.match(errorAlert.textContent, /Risk percentage must be between/);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test('TelegramConnect renders auth, disconnect, and channel monitoring feedback inline inside the Telegram card with no floating Toast', async () => {
  const originalFetch = globalThis.fetch;
  let connected = false;

  globalThis.fetch = async (url, options = {}) => {
    const u = String(url);
    const method = (options.method || 'GET').toUpperCase();
    if (u.includes('/api/telegram/status')) {
      return new Response(
        JSON.stringify({
          configured: true,
          connected,
          paused: false,
          user: connected ? { firstName: 'Ada', username: 'adatrader', phone: '+2348000000000' } : null,
          monitoredChannels: [],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    if (u.includes('/api/telegram/request-code') && method === 'POST') {
      return new Response(
        JSON.stringify({ ok: true }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    if (u.includes('/api/telegram/verify-code') && method === 'POST') {
      connected = true;
      return new Response(
        JSON.stringify({
          connected: true,
          user: { firstName: 'Ada', username: 'adatrader', phone: '+2348000000000' },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    if (u.includes('/api/telegram/chats')) {
      return new Response(
        JSON.stringify({
          chats: [{ channelId: '-10012345', title: 'Gold VIP Signals', username: 'goldvip', type: 'channel' }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    if (u.includes('/api/channels') && method === 'POST') {
      return new Response(
        JSON.stringify({
          channel: { id: 'ch-1', channelId: '-10012345', title: 'Gold VIP Signals', username: 'goldvip' },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    return new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  try {
    await act(async () => {
      root.render(
        React.createElement(
          TelegramStatusProvider,
          { token: 'test-jwt' },
          React.createElement(TelegramConnect, { token: 'test-jwt', channels: [], onRefresh: async () => {} }),
        ),
      );
      await flush();
    });

    const telegramSection = container.querySelector('section[aria-labelledby="telegram-connection-title"]');
    assert.ok(telegramSection, 'Telegram connection section exists');

    // Step 1: Enter phone and send login code
    const phoneInput = telegramSection.querySelector('#telegram-phone');
    await act(async () => {
      setInputValue(phoneInput, '+2348000000000');
      await flush();
    });
    await act(async () => {
      telegramSection.querySelector('form.telegram-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await flush();
    });

    const codeSentAlert = telegramSection.querySelector('.telegram-inline-feedback.alert-success');
    assert.ok(codeSentAlert, 'Code sent confirmation renders inline inside the Telegram connection card');
    assert.match(codeSentAlert.textContent, /Telegram sent a login code/);
    assert.equal(document.querySelector('.toast'), null, 'No floating .toast element is rendered anywhere');

    // Step 2: Verify code
    const codeInput = telegramSection.querySelector('#telegram-code');
    await act(async () => {
      setInputValue(codeInput, '12345');
      await flush();
    });
    await act(async () => {
      telegramSection.querySelector('form.telegram-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await flush();
    });

    const connectedAlert = telegramSection.querySelector('.telegram-inline-feedback.alert-success');
    assert.ok(connectedAlert, 'Telegram connected confirmation renders inline inside the Telegram connection card');
    assert.match(connectedAlert.textContent, /Telegram is connected to your workspace/);

    // Step 3: Monitor a channel from available channels
    const monitorBtn = [...telegramSection.querySelectorAll('.chat-row button')].find((b) => /Monitor/.test(b.textContent));
    assert.ok(monitorBtn, 'Monitor button is rendered in available channels list');
    await act(async () => {
      monitorBtn.click();
      await flush();
    });

    const monitorAlert = telegramSection.querySelector('.telegram-inline-feedback.alert-success');
    assert.ok(monitorAlert, 'Channel monitoring confirmation renders inline inside the Telegram card');
    assert.match(monitorAlert.textContent, /Gold VIP Signals was added to monitored sources/);
    assert.equal(document.querySelector('.toast'), null, 'Still zero floating .toast elements');
  } finally {
    globalThis.fetch = originalFetch;
    await act(async () => root.unmount());
    container.remove();
  }
});

test('MetaApiPanel scopes setup errors to the setup form and per-account actions to the Trading Accounts card/row', async () => {
  const originalFetch = globalThis.fetch;
  let accountsList = [
    {
      id: 'mt-acc-1',
      metaApiAccountId: 'mt-acc-1',
      name: 'FTMO Demo',
      accountName: 'FTMO Demo',
      broker: 'FTMO',
      login: '551122',
      server: 'FTMO-Demo',
      platform: 'mt5',
      managedByApp: true,
      state: 'DEPLOYED',
      connectionStatus: 'CONNECTED',
    },
  ];

  globalThis.fetch = async (url, options = {}) => {
    const u = String(url);
    const method = (options.method || 'GET').toUpperCase();
    if (u.includes('/api/metaapi/provisioning-status')) {
      return new Response(JSON.stringify({ available: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (u.includes('/api/metaapi/linked-accounts') && method === 'GET') {
      return new Response(
        JSON.stringify({ configured: true, clientSupported: true, accounts: accountsList }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    if (u.includes('/api/metaapi/provisioned-accounts') && method === 'POST' && !u.includes('/refresh')) {
      return new Response(
        JSON.stringify({
          error: 'Signal Desk cannot add new trading accounts right now because our MetaAPI workspace needs to be topped up.',
        }),
        { status: 403, headers: { 'Content-Type': 'application/json' } },
      );
    }
    if (u.includes('/api/metaapi/provisioned-accounts/mt-acc-1/refresh') && method === 'POST') {
      return new Response(
        JSON.stringify({ account: accountsList[0] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    if (u.includes('/api/metaapi/accounts/mt-acc-1') && method === 'DELETE') {
      accountsList = [];
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  try {
    await act(async () => {
      root.render(
        React.createElement(
          TelegramStatusProvider,
          { token: 'test-jwt' },
          React.createElement(
            MetaApiStatusProvider,
            { token: 'test-jwt' },
            React.createElement(MetaApiPanel, { token: 'test-jwt', channelCount: 1, onOpenTelegram: () => {} }),
          ),
        ),
      );
      await flush();
    });

    const setupPanel = container.querySelector('section[aria-labelledby="metaapi-setup-title"]');
    const accountsPanel = container.querySelector('section[aria-labelledby="metaapi-accounts-title"]');
    const setupForm = setupPanel.querySelector('form.form-stack');

    // 1. Trigger 403 funding error on MT4/MT5 setup form
    const nameInput = setupForm.querySelector('#metaapi-account-name');
    const serverInput = setupForm.querySelector('#metaapi-server');
    await act(async () => {
      setInputValue(nameInput, 'My MT5 Demo');
      setInputValue(serverInput, 'ICMarketsSC-Demo');
      await flush();
    });
    await act(async () => {
      setupForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await flush();
    });

    assert.ok(setupForm.querySelector('.alert-error'), '403 setup error renders inside the MT4/MT5 setup form');
    assert.equal(accountsPanel.querySelector('.alert-error'), null, 'Setup error does not leak into Connected accounts panel');

    // 2. Refresh a specific trading account and verify feedback renders inside that account row
    const accountRow = accountsPanel.querySelector('.account-row');
    const refreshRowBtn = [...accountRow.querySelectorAll('button')].find((b) => /Refresh/.test(b.textContent));
    await act(async () => {
      refreshRowBtn.click();
      await flush();
    });

    const rowSuccess = accountRow.querySelector('.account-row-feedback.alert-success');
    assert.ok(rowSuccess, 'Per-account refresh notice renders inside the target .account-row');
    assert.match(rowSuccess.textContent, /Trading account status updated/);
    assert.equal(setupForm.querySelector('.alert-success'), null, 'Account refresh notice does not leak into setup form');

    // 3. Delete trading account and verify feedback renders inside Connected accounts panel
    const removeBtn = [...accountRow.querySelectorAll('button')].find((b) => /Delete account|Unlink/.test(b.textContent));
    await act(async () => {
      removeBtn.click();
      await flush();
    });

    const deletedNotice = accountsPanel.querySelector('.alert-success');
    assert.ok(deletedNotice, 'Removed account notice renders inside Connected accounts panel');
    assert.match(deletedNotice.textContent, /removed from Signal Desk|Trading account removed/);
  } finally {
    globalThis.fetch = originalFetch;
    await act(async () => root.unmount());
    container.remove();
  }
});

test('AdminPanel and BillingPage render all feedback locally inside the active card, row, or modal with zero .global-alert banners', async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (url, options = {}) => {
    const u = String(url);
    const method = (options.method || 'GET').toUpperCase();
    if (u.includes('/api/admin/overview')) {
      return new Response(JSON.stringify({ stats: { totalUsers: 2, adminUsers: 1, suspendedUsers: 0, paidUsers: 1 } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (u.includes('/api/admin/users/u-2/telegram/reconnect') && method === 'POST') {
      return new Response(JSON.stringify({ caughtUp: 2, fresh: 0 }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (u.includes('/api/admin/users')) {
      return new Response(
        JSON.stringify({
          users: [
            { id: 'u-1', name: 'Admin', email: 'admin@signal.example', role: 'admin', isSuspended: false },
            { id: 'u-2', name: 'Ada Trader', email: 'ada@signal.example', role: 'user', isSuspended: false, telegramConnected: true, telegramPaused: false, monitorCount: 2 },
          ],
          total: 2,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    if (u.includes('/api/admin/promo-codes') && method === 'POST') {
      return new Response(
        JSON.stringify({ promoCode: { id: 'p-1', code: 'LAUNCH25', discountType: 'percentage', discountValue: 25, currentUses: 0, maxUses: 100, active: true } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    if (u.includes('/api/admin/promo-codes')) {
      return new Response(JSON.stringify({ promoCodes: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (u.includes('/api/admin/billing')) {
      return new Response(JSON.stringify({ configured: true, summary: {}, transactions: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (u.includes('/api/admin/pricing')) {
      return new Response(
        JSON.stringify({
          configured: true,
          webhookConfigured: true,
          supportedCurrencies: ['NGN', 'USD'],
          billing: { recurringEnabled: true, updateExistingSubscriptions: true },
          plans: [
            { key: 'starter', name: 'Starter', description: 'Starter', interval: 'monthly', limits: { maxTradingAccounts: 1, maxTelegramChannels: 3, maxDailySignals: 100 }, prices: { NGN: { amountMinor: 1500000 } }, sources: { NGN: 'database' } },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    if (u.includes('/api/admin/announcements')) {
      return new Response(JSON.stringify({ announcements: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (u.includes('/api/admin/audit-logs')) {
      return new Response(JSON.stringify({ entries: [], total: 0, totalEntries: 0, actions: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (u.includes('/api/billing/plans')) {
      return new Response(
        JSON.stringify({
          plans: [
            { key: 'starter', name: 'Starter', description: 'Starter plan', interval: 'monthly', limits: { maxTradingAccounts: 1, maxTelegramChannels: 3, maxDailySignals: 100 }, prices: { NGN: { amountMinor: 1500000 } } },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    if (u.includes('/api/billing/subscription')) {
      return new Response(
        JSON.stringify({
          configured: true,
          supportedCurrencies: ['NGN', 'USD'],
          subscription: { plan: 'starter', planName: 'Starter', status: 'active', cancelAtPeriodEnd: false, currentPeriodEnd: '2026-12-01T00:00:00Z' },
          limits: { maxTradingAccounts: 1, maxTelegramChannels: 3 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    if (u.includes('/api/billing/cancel') && method === 'POST') {
      return new Response(
        JSON.stringify({
          subscription: { plan: 'starter', planName: 'Starter', status: 'active', cancelAtPeriodEnd: true, currentPeriodEnd: '2026-12-01T00:00:00Z' },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    return new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  try {
    await act(async () => {
      root.render(React.createElement(AdminPanel, { token: 'admin-jwt', currentUser: { id: 'u-1', role: 'admin' } }));
      await flush();
    });

    // 1. Trigger Reconnect Telegram on Ada Trader's row and verify feedback renders inside her row
    const reconnectBtn = [...container.querySelectorAll('button')].find((b) => /Reconnect Telegram/.test(b.textContent));
    assert.ok(reconnectBtn, 'Reconnect Telegram button is rendered on Ada row');
    await act(async () => {
      reconnectBtn.click();
      await flush();
    });

    const rowFeedback = container.querySelector('tr .admin-row-feedback.alert-success');
    assert.ok(rowFeedback, 'User row action renders .admin-row-feedback inside the target user row');
    assert.match(rowFeedback.textContent, /Ada Trader's Telegram session is new/);
    assert.equal(container.querySelector('.global-alert'), null, 'No .global-alert banner exists in AdminPanel');

    // 2. Switch to Pricing & Plans tab and create a Promo Code; verify feedback renders only in Create promo code card
    const pricingTab = container.querySelector('#admin-tab-pricing');
    await act(async () => {
      pricingTab.click();
      await flush();
    });

    const promoCreatePanel = container.querySelector('.promo-create-panel');
    const pricingPanel = container.querySelector('.pricing-panel');
    const promoInputs = promoCreatePanel.querySelectorAll('input');
    await act(async () => {
      setInputValue(promoInputs[0], 'LAUNCH25');
      setInputValue(promoInputs[1], '25');
      promoCreatePanel.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await flush();
    });

    assert.ok(promoCreatePanel.querySelector('.alert-success'), 'Promo creation notice renders inside .promo-create-panel');
    assert.equal(pricingPanel.querySelector('.alert-success'), null, 'Promo creation notice does not leak into .pricing-panel');

    // 3. Mount BillingPage and cancel renewal; verify feedback renders inside .billing-current
    await act(async () => {
      root.render(React.createElement(BillingPage, { token: 'user-jwt' }));
      await flush();
    });

    const billingCurrent = container.querySelector('.billing-current');
    const billingPlans = container.querySelector('.billing-plans');
    const cancelBtn = [...billingCurrent.querySelectorAll('button')].find((b) => /Cancel renewal/.test(b.textContent));
    await act(async () => {
      cancelBtn.click();
      await flush();
    });

    assert.ok(billingCurrent.querySelector('.alert-success'), 'Cancel renewal notice renders inside .billing-current card');
    assert.equal(billingPlans.querySelector('.alert-success'), null, 'Cancel renewal notice does not leak into .billing-plans card');
    assert.equal(container.querySelector('.global-alert'), null, 'No .global-alert banner exists in BillingPage');
  } finally {
    globalThis.fetch = originalFetch;
    await act(async () => root.unmount());
    container.remove();
  }
});

test.after(async () => {
  await fs.rm(bundleOut, { force: true }).catch(() => {});
});
