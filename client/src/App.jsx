import React, { useCallback, useEffect, useState } from 'react';
import Sidebar from './components/Sidebar.jsx';
import TelegramConnect from './components/TelegramConnect.jsx';
import MetaApiPanel from './components/MetaApiPanel.jsx';
import ExecutionSettings from './components/ExecutionSettings.jsx';
import AccountDeletionSettings from './components/AccountDeletionSettings.jsx';
import AdminPanel from './components/AdminPanel.jsx';
import BillingPage from './components/BillingPage.jsx';
import BillingCallbackPage from './components/BillingCallbackPage.jsx';
import UpdatePasswordPage from './components/UpdatePasswordPage.jsx';
import { navigationItemsForRole } from './navigation.js';
import { request } from './lib/api.js';
import { supabaseReady } from './lib/supabase.js';

function AuthScreen({ onAuthenticated, installPrompt, onInstall }) {
  const [mode, setMode] = useState('login');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [resetSent, setResetSent] = useState(false);
  const [rememberMe, setRememberMe] = useState(true);
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const submit = async (event) => {
    event.preventDefault(); setBusy(true); setError('');
    try {
      if (mode === 'forgot') {
        const email = form.email.trim().toLowerCase();
        const client = await supabaseReady();
        if (!client) {
          console.error('[password-reset] Supabase browser configuration is missing, so no reset email can be sent.', {
            hint: 'Set VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY in the static-site build environment, and SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY on the API service, then redeploy. GET /api/config must return both values.',
          });
          throw new Error('Password recovery is temporarily unavailable. Please try again shortly or contact support.');
        }
        await request('/api/auth/prepare-password-reset', null, { method: 'POST', body: { email } });
        const { error: resetError } = await client.auth.resetPasswordForEmail(email, { redirectTo: `${window.location.origin}/update-password` });
        if (resetError) {
          console.error('[password-reset] Supabase resetPasswordForEmail failed', {
            message: resetError.message,
            status: resetError.status,
            code: resetError.code,
            name: resetError.name,
          });
          throw new Error('We could not process that reset request right now. Please try again later.');
        }
        setResetSent(true);
        return;
      }
      const data = await request(`/api/auth/${mode === 'login' ? 'login' : 'register'}`, null, { method: 'POST', body: { ...form, rememberMe } });
      onAuthenticated(data, rememberMe);
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  };
  const changeMode = (nextMode) => { setMode(nextMode); setError(''); setResetSent(false); };
  return <main className="auth-shell">
    <div className="auth-brand"><div className="brand-mark"><img src="/icons/signal-desk-icon-192.png" alt="" /></div><span>Signal Desk</span></div>
    <section className="auth-card">
      <p className="eyebrow">{mode === 'forgot' ? 'ACCOUNT RECOVERY' : 'AUTOMATED SIGNAL EXECUTION'}</p>
      <h1>{mode === 'login' ? 'Welcome back' : mode === 'register' ? 'Create your workspace' : resetSent ? 'Check your email' : 'Reset your password'}</h1>
      <p className="muted">{mode === 'forgot' ? 'Enter the email address for your Signal Desk account. If it exists, we will send a secure reset link.' : 'Automate your trading by executing Telegram signals directly to your broker.'}</p>
      {mode === 'forgot' && resetSent ? <>
        <div className="alert alert-success" role="status">If an account exists for that address, a password reset link has been sent. Check your inbox and spam folder.</div>
        <button type="button" className="button button-secondary button-wide auth-mode-button" onClick={() => changeMode('login')}>Back to sign in</button>
      </> : <form onSubmit={submit} className="form-stack">
        {mode === 'register' && <label>Your name<input autoComplete="name" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} required maxLength={100} /></label>}
        <label>Email<input type="email" autoComplete="email" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} required /></label>
        {mode !== 'forgot' && <label>Password<input type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} required minLength={mode === 'register' ? 10 : 1} />{mode === 'register' && <small>Use at least 10 characters.</small>}</label>}
        {mode === 'login' && <div className="forgot-password-row"><button type="button" className="text-button" onClick={() => changeMode('forgot')}>Forgot Password?</button></div>}
        {mode === 'login' && <><label className="remember-session"><input type="checkbox" checked={rememberMe} onChange={(event) => setRememberMe(event.target.checked)} /><span>Keep me signed in for 30 days</span></label><small className="remember-hint">Leave checked on your personal device. Uncheck it on shared devices.</small></>}
        {error && <div className="alert alert-error" role="alert">{error}</div>}
        <button className="button button-primary button-wide" disabled={busy}>{busy ? (mode === 'forgot' ? 'Sending…' : 'Please wait…') : mode === 'login' ? 'Sign in' : mode === 'register' ? 'Create account' : 'Send reset link'}</button>
        {mode === 'forgot' && <button type="button" className="button button-secondary button-wide auth-mode-button" onClick={() => changeMode('login')}>Back to sign in</button>}
      </form>}
      {mode !== 'forgot' && <p className="auth-switch">{mode === 'login' ? 'New to Signal Desk?' : 'Already have an account?'} <button type="button" className="text-button" onClick={() => changeMode(mode === 'login' ? 'register' : 'login')}>{mode === 'login' ? 'Create account' : 'Sign in'}</button></p>}
      <p className="fine-print">Auto-Trading is ON by default for new workspaces. New eligible Telegram signals may place live orders after you select a deployed trading account. Review the risk settings and turn it off whenever you want to stop new orders.</p>
      {installPrompt && <button type="button" className="button button-primary button-wide install-button" onClick={onInstall}>Install Signal Desk</button>}
    </section>
  </main>;
}

function Metric({ label, value, note }) {
  return <div className="metric-card"><span className="metric-label">{label}</span><strong>{value ?? '—'}</strong><span className="metric-note">{note}</span></div>;
}

function SignalTable({ signals, compact = false, onEmptyAction }) {
  if (!signals?.length) return <div className="empty-state signal-empty">
    <span className="empty-icon" aria-hidden="true">↗</span>
    <strong>No signals yet</strong>
    <span>Connect Telegram to collect messages from your selected chats, or add a signal note.</span>
    {onEmptyAction && <button className="button button-secondary" type="button" onClick={onEmptyAction}>Connect Telegram</button>}
  </div>;
  return <div className="signal-list">{signals.map(signal => <article className="signal-item" key={signal.id}>
    <div className="signal-top"><div><strong>{signal.symbol || 'Signal message'}</strong><span className="signal-source">{signal.channelTitle || 'Telegram chat'}</span></div><span className={`badge ${signal.side === 'buy' ? 'badge-buy' : signal.side === 'sell' ? 'badge-sell' : ''}`}>{signal.side || 'received'}</span></div>
    <p className="signal-message">{signal.message}</p>
    <div className="signal-meta">{signal.entryPrice != null && <span>Entry {signal.entryPrice}</span>}{signal.stopLoss != null && <span>SL {signal.stopLoss}</span>}{signal.takeProfit != null && <span>TP {signal.takeProfit}</span>}<time>{signal.createdAt ? new Date(signal.createdAt).toLocaleString() : ''}</time></div>
  </article>)}</div>;
}

function App() {
  const [token, setToken] = useState(() => {
    try { return localStorage.getItem('signal-token') || sessionStorage.getItem('signal-token') || ''; }
    catch { return sessionStorage.getItem('signal-token') || ''; }
  });
  const [user, setUser] = useState(null);
  const initialTabFromPath = (pathname) => {
    const path = String(pathname || '').replace(/\/+$/, '');
    if (path === '/admin') return 'admin';
    if (path === '/billing') return 'billing';
    return 'overview';
  };
  const [tab, setTab] = useState(() => initialTabFromPath(window.location.pathname));
  const [dashboard, setDashboard] = useState(null);
  const [channels, setChannels] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [signals, setSignals] = useState([]);
  const [settings, setSettings] = useState({ riskMode: 'fixed', riskPercent: 1, maxOpenPositions: 3, dailyLossLimit: 5, autoTradingEnabled: false, lotSizeMode: 'fixed', fixedLotSize: 0.01, maxDailyTrades: 10, executionAccountId: '' });
  const [linkedAccounts, setLinkedAccounts] = useState([]);
  const [trades, setTrades] = useState([]);
  const [executionRuntimeEnabled, setExecutionRuntimeEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [signalText, setSignalText] = useState('');
  const [accountForm, setAccountForm] = useState({ label: '', broker: '', platform: '', accountReference: '' });
  const [installPrompt, setInstallPrompt] = useState(null);
  const [isMobileViewport, setIsMobileViewport] = useState(() => window.matchMedia('(max-width:700px)').matches);
  const [sidebarVisible, setSidebarVisible] = useState(() => {
    if (window.matchMedia('(max-width:700px)').matches) return false;
    try { return window.localStorage.getItem('signal-sidebar-visible') !== 'false'; } catch { return true; }
  });

  useEffect(() => {
    const captureInstallPrompt = (event) => { event.preventDefault(); setInstallPrompt(event); };
    const handleInstalled = () => setInstallPrompt(null);
    window.addEventListener('beforeinstallprompt', captureInstallPrompt);
    window.addEventListener('appinstalled', handleInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', captureInstallPrompt);
      window.removeEventListener('appinstalled', handleInstalled);
    };
  }, []);

  const installApp = async () => {
    if (!installPrompt) return;
    try { await installPrompt.prompt(); await installPrompt.userChoice; } catch {}
    setInstallPrompt(null);
  };

  const toggleSidebar = () => setSidebarVisible((visible) => {
    const next = !visible;
    if (!isMobileViewport) {
      try { window.localStorage.setItem('signal-sidebar-visible', String(next)); } catch {}
    }
    return next;
  });
  const closeMobileSidebar = () => { if (isMobileViewport) setSidebarVisible(false); };
  const navigateToTab = (nextTab) => {
    setTab(nextTab);
    closeMobileSidebar();
    try {
      const path = nextTab === 'admin' ? '/admin' : nextTab === 'billing' ? '/billing' : '/';
      if (window.location.pathname !== path) window.history.pushState({ tab: nextTab }, '', path);
    } catch {}
  };

  useEffect(() => {
    const media = window.matchMedia('(max-width:700px)');
    const handleViewportChange = (event) => {
      setIsMobileViewport(event.matches);
      if (event.matches) setSidebarVisible(false);
      else {
        try { setSidebarVisible(window.localStorage.getItem('signal-sidebar-visible') !== 'false'); } catch { setSidebarVisible(true); }
      }
    };
    if (media.addEventListener) media.addEventListener('change', handleViewportChange);
    else media.addListener(handleViewportChange);
    return () => {
      if (media.removeEventListener) media.removeEventListener('change', handleViewportChange);
      else media.removeListener(handleViewportChange);
    };
  }, []);

  useEffect(() => {
    const syncTabFromPath = () => {
      const path = window.location.pathname.replace(/\/+$/, '');
      setTab(path === '/admin' ? 'admin' : path === '/billing' ? 'billing' : 'overview');
    };
    window.addEventListener('popstate', syncTabFromPath);
    return () => window.removeEventListener('popstate', syncTabFromPath);
  }, []);

  useEffect(() => {
    if (!isMobileViewport || !sidebarVisible) return undefined;
    const closeOnEscape = (event) => { if (event.key === 'Escape') setSidebarVisible(false); };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [isMobileViewport, sidebarVisible]);

  const logout = useCallback(() => { try { void supabaseReady().then((client) => client?.auth.signOut({ scope: 'local' })).catch(() => {}); } catch {} try { localStorage.removeItem('signal-token'); } catch {} sessionStorage.removeItem('signal-token'); setToken(''); setUser(null); setDashboard(null); setLoading(false); }, []);
  const refresh = useCallback(async () => {
    if (!token) return;
    try {
      const [me, dash, channelsData, accountsData, signalsData, settingsData, tradingAccountsData, tradesData] = await Promise.all([
        request('/api/auth/me', token), request('/api/dashboard', token), request('/api/channels', token), request('/api/accounts', token), request('/api/signals?limit=50', token), request('/api/settings', token), request('/api/metaapi/linked-accounts', token), request('/api/trades', token),
      ]);
      setUser(me.user); setDashboard(dash); setChannels(channelsData.channels); setAccounts(accountsData.accounts); setSignals(signalsData.signals); setSettings((current) => ({ ...current, ...settingsData.settings })); setExecutionRuntimeEnabled(Boolean(settingsData.runtimeEnabled)); setLinkedAccounts(tradingAccountsData.accounts || []); setTrades(tradesData.trades || []);
      setError('');
    } catch (e) { if (/expired|sign in/i.test(e.message)) logout(); else setError(e.message); }
    finally { setLoading(false); }
  }, [token, logout]);
  useEffect(() => { if (!token) { setLoading(false); return; } refresh(); const timer = setInterval(refresh, 20_000); return () => clearInterval(timer); }, [token, refresh]);

  const authenticated = (data, rememberMe = true) => {
    sessionStorage.removeItem('signal-token');
    try {
      localStorage.removeItem('signal-token');
      (rememberMe ? localStorage : sessionStorage).setItem('signal-token', data.token);
    } catch { sessionStorage.setItem('signal-token', data.token); }
    setToken(data.token); setUser(data.user); setLoading(true);
  };
  const addManualSignal = async (event) => {
    event.preventDefault(); setError(''); setNotice('');
    try { await request('/api/signals', token, { method: 'POST', body: { message: signalText } }); setSignalText(''); setNotice('Signal saved.'); await refresh(); }
    catch (e) { setError(e.message); }
  };
  const addAccount = async (event) => {
    event.preventDefault(); setError('');
    try { await request('/api/accounts', token, { method: 'POST', body: accountForm }); setAccountForm({ label: '', broker: '', platform: '', accountReference: '' }); setNotice('Account note saved.'); await refresh(); }
    catch (e) { setError(e.message); }
  };
  const saveSettings = async (event) => {
    event.preventDefault(); setError(''); setNotice(''); setSettingsSaving(true);
    try { const result = await request('/api/settings', token, { method: 'PUT', body: settings }); setSettings(result.settings); setExecutionRuntimeEnabled(Boolean(result.runtimeEnabled)); setNotice('Execution settings saved.'); }
    catch (e) { setError(e.message); }
    finally { setSettingsSaving(false); }
  };
  const toggleAutoTrading = async (enabled) => {
    if (settingsSaving) return;
    const previous = settings;
    const updated = { ...previous, autoTradingEnabled: enabled };
    setSettings(updated); setError(''); setNotice(''); setSettingsSaving(true);
    try {
      const result = await request('/api/settings', token, { method: 'PUT', body: updated });
      setSettings(result.settings); setExecutionRuntimeEnabled(Boolean(result.runtimeEnabled));
      setNotice(enabled ? 'Auto-Trading is on. New eligible Telegram signals may place live orders.' : 'Auto-Trading is off. No new signal orders will be submitted.');
    } catch (e) { setSettings(previous); setError(e.message); }
    finally { setSettingsSaving(false); }
  };

  const isAdmin = user?.role === 'admin';
  const tabs = navigationItemsForRole(user?.role).map(({ key, label }) => [key, label]);

  const normalizedPath = window.location.pathname.replace(/\/+$/, '');
  if (normalizedPath === '/billing/callback') return token
    ? <BillingCallbackPage />
    : <AuthScreen onAuthenticated={authenticated} installPrompt={installPrompt} onInstall={installApp} />;
  if (normalizedPath === '/update-password') return <UpdatePasswordPage />;
  if (!token) return <AuthScreen onAuthenticated={authenticated} installPrompt={installPrompt} onInstall={installApp} />;
  if (loading) return <main className="loading-shell"><div className="spinner" /><span>Loading your workspace…</span></main>;
  return <div className={`app-shell ${sidebarVisible ? '' : 'sidebar-hidden'}`}>
    <Sidebar active={tab} onNavigate={navigateToTab} user={user} onSignOut={logout} onClose={closeMobileSidebar} visible={sidebarVisible} />
    {isMobileViewport && sidebarVisible && <button type="button" className="sidebar-backdrop" aria-label="Close navigation menu" onClick={closeMobileSidebar} />}
    <main className="main-area"><header className="topbar"><div><span className="eyebrow">PERSONAL WORKSPACE</span><h1>{tabs.find(([key]) => key === tab)?.[1] || 'Overview'}</h1></div><div className="topbar-right"><button type="button" className="button button-secondary button-small sidebar-toggle" aria-controls="workspace-sidebar" aria-expanded={sidebarVisible} aria-label={isMobileViewport ? (sidebarVisible ? 'Close navigation menu' : 'Open navigation menu') : (sidebarVisible ? 'Hide sidebar' : 'Show sidebar')} title={isMobileViewport ? (sidebarVisible ? 'Close navigation menu' : 'Open navigation menu') : (sidebarVisible ? 'Hide sidebar' : 'Show sidebar')} onClick={toggleSidebar}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{isMobileViewport ? <path d="M4 6h16M4 12h16M4 18h16" /> : <><rect x="3" y="4" width="18" height="16" rx="2"/><path d={sidebarVisible ? 'M9 4v16' : 'M15 4v16'} /></>}</svg><span>{sidebarVisible ? 'Hide sidebar' : 'Show sidebar'}</span></button>{installPrompt && <button className="button button-primary button-small install-app-button" onClick={installApp}>Install app</button>}<span className="status-pill online"><i /> Connected</span><button className="button button-secondary button-small" onClick={refresh}>Refresh</button></div></header>
      {error && <div className="alert alert-error global-alert" role="alert">{error}<button className="alert-close" onClick={() => setError('')}>×</button></div>}{notice && <div className="alert alert-success global-alert" role="status" aria-live="polite">{notice}<button className="alert-close" onClick={() => setNotice('')}>×</button></div>}
      <div className="content-area">
        {tab === 'overview' && <>
          <section className="welcome-row"><div><h2>Good to see you, {user?.name?.split(' ')[0] || 'trader'}.</h2><p>Monitor Telegram signals and keep your setup organized.</p></div><span className="live-label"><i /> Signal monitoring</span></section>
          <div className="metrics-grid"><Metric label="Signals captured" value={dashboard?.stats?.totalSignals ?? 0} note="Across your workspace" /><Metric label="Active sources" value={dashboard?.stats?.activeChannels ?? 0} note="Telegram channels" /><Metric label="Account Notes" value={dashboard?.stats?.accounts ?? 0} note="Labels and references" /><Metric label="Auto-Trading" value={settings.autoTradingEnabled ? 'On' : 'Off'} note={settings.autoTradingEnabled ? 'Eligible signals may place orders' : 'Off until you enable it'} /></div>
          {settings.autoTradingEnabled && <div className="execution-warning" role="alert">Warning: Auto-Trading can execute live trades on your selected broker account. It is ON by default for new workspaces. Use a demo account for testing; you are responsible for any financial losses. Turn Auto-Trading off in Risk Settings to stop new orders from being submitted.</div>}
          <div className="notice-banner"><strong>{settings.autoTradingEnabled ? 'Auto-Trading is on' : 'Auto-Trading is off'}</strong><span>{settings.autoTradingEnabled ? 'New eligible Telegram signals may place live orders on your selected account. You can turn this off in Risk Settings.' : 'Signals are saved for review only. Turn Auto-Trading on in Risk Settings to submit new eligible signals to your broker.'}</span></div>
          <section className="panel"><div className="panel-heading"><div><p className="eyebrow">LATEST ACTIVITY</p><h2>Recent signals</h2></div><button className="text-button" onClick={() => setTab('signals')}>View all</button></div><SignalTable signals={dashboard?.signals || []} compact onEmptyAction={() => setTab('telegram')} /></section>
        </>}
        {tab === 'telegram' && <TelegramConnect token={token} channels={channels} onRefresh={refresh} />}
        {tab === 'metaapi' && <MetaApiPanel token={token} />}
        {tab === 'signals' && <div className="panel-grid"><section className="panel"><div className="panel-heading"><div><p className="eyebrow">CAPTURED MESSAGES</p><h2>Signal history</h2></div><span className="count-badge">{signals.length}</span></div><SignalTable signals={signals} onEmptyAction={() => setTab('telegram')} /></section><section className="panel"><div className="panel-heading"><div><p className="eyebrow">MANUAL ENTRY</p><h2>Add a signal note</h2></div></div><p className="muted">Save a message for tracking. Signal Desk may identify the symbol, direction, entry, stop, and target.</p><form className="form-stack" onSubmit={addManualSignal}><label>Signal message<textarea rows="7" value={signalText} onChange={e => setSignalText(e.target.value)} placeholder={'BUY EURUSD\nEntry: 1.0850\nSL: 1.0800\nTP: 1.0950'} required maxLength={5000} /></label><button className="button button-primary">Save signal</button></form></section></div>}
        {tab === 'accounts' && <div className="panel-grid"><section className="panel"><div className="panel-heading"><div><p className="eyebrow">YOUR NOTES</p><h2>Account Notes</h2></div><span className="count-badge">{accounts.length}</span></div><p className="muted">Save a label or optional reference for your own notes. To connect a trading account, open Trading Accounts.</p>{!accounts.length ? <div className="empty-state"><strong>No account notes yet</strong><span>Add a label for your own reference.</span></div> : <div className="chat-list">{accounts.map(account => <div className="chat-row" key={account.id}><div><strong>{account.label}</strong><small>{[account.broker, account.platform, account.accountReference].filter(Boolean).join(' · ') || 'Reference only'}</small></div><button className="icon-button" onClick={async () => { await request(`/api/accounts/${account.id}`, token, { method: 'DELETE' }); await refresh(); }}>Remove</button></div>)}</div>}</section><section className="panel"><div className="panel-heading"><div><p className="eyebrow">ADD A NOTE</p><h2>Account note</h2></div></div><form className="form-stack" onSubmit={addAccount}><label>Label<input value={accountForm.label} onChange={e => setAccountForm({ ...accountForm, label: e.target.value })} placeholder="Demo MT5 account" required maxLength={100} /></label><div className="form-row"><label>Broker<input value={accountForm.broker} onChange={e => setAccountForm({ ...accountForm, broker: e.target.value })} /></label><label>Platform<input value={accountForm.platform} onChange={e => setAccountForm({ ...accountForm, platform: e.target.value })} placeholder="MT4, MT5…" /></label></div><label>Reference<input value={accountForm.accountReference} onChange={e => setAccountForm({ ...accountForm, accountReference: e.target.value })} placeholder="Optional alias" /></label><button className="button button-primary">Save note</button></form></section></div>}
        {tab === 'billing' && <BillingPage token={token} />}
        {tab === 'admin' && (isAdmin
          ? <AdminPanel token={token} currentUser={user} />
          : <section className="panel admin-denied" aria-labelledby="admin-denied-title">
            <p className="eyebrow">RESTRICTED AREA</p>
            <h2 id="admin-denied-title">Admin access required</h2>
            <p className="muted">This area is only available to workspace administrators. If you believe you should have access, contact the workspace owner.</p>
            <button type="button" className="button button-secondary" onClick={() => navigateToTab('overview')}>Return to overview</button>
          </section>)}
        {tab === 'settings' && <><ExecutionSettings settings={settings} accounts={linkedAccounts} trades={trades} runtimeAvailable={executionRuntimeEnabled} onChange={setSettings} onSubmit={saveSettings} onToggle={toggleAutoTrading} saving={settingsSaving} /><AccountDeletionSettings token={token} onDeleted={logout} /></>}
      </div>
      <footer className="footer">Not financial advice. Use at your own risk.</footer>
    </main>
  </div>;
}

export default App;
