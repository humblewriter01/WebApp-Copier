import React, { useCallback, useEffect, useRef, useState } from 'react';
import Sidebar from './components/Sidebar.jsx';
import SignalTable from './components/SignalTable.jsx';
import ConfirmModal from './components/ConfirmModal.jsx';
import { signalsAwaitingUpgrade } from './lib/signal-outcome.js';
import { AutoTradingStatusCard, OverviewHeader, OverviewLoadingShell, OverviewMetrics, SetupChecklist, overviewActivationView } from './components/OverviewActivation.jsx';
import TelegramConnect from './components/TelegramConnect.jsx';
import { TelegramStatusProvider, TelegramStatusPill, useTelegramStatus, monitoringLabel } from './components/TelegramStatus.jsx';
import { MetaApiStatusProvider } from './components/MetaApiStatus.jsx';
import MetaApiPanel from './components/MetaApiPanel.jsx';
import RiskSettings from './components/RiskSettings.jsx';
import AdvancedSettings from './components/AdvancedSettings.jsx';
import ProfileSettings from './components/ProfileSettings.jsx';
import AdminPanel from './components/AdminPanel.jsx';
import AnnouncementBanner from './components/AnnouncementBanner.jsx';
import SupportSessionBar from './components/SupportSessionBar.jsx';
import { clearSupportSession, readSupportSession, writeSupportSession } from './lib/support-session.js';
import BillingPage from './components/BillingPage.jsx';
import BillingCallbackPage from './components/BillingCallbackPage.jsx';
import UpdatePasswordPage from './components/UpdatePasswordPage.jsx';
import Landing from './components/Landing.jsx';
import AuthScreen from './components/AuthScreen.jsx';
import { navigationItemsForRole } from './navigation.js';
import { API_URL, request } from './lib/api.js';
import { connectSignalFeed, createReconciler, dashboardFreshnessNote, mergeSignalRows, FALLBACK_POLL_INTERVAL_MS, LIVE_SWEEP_INTERVAL_MS } from './lib/signal-feed.js';
import { autoTradingBannerView } from './lib/platform-view.js';
import { supabaseReady } from './lib/supabase.js';

/** How many captured rows the workspace keeps on screen, and the cap a pushed row is merged into. */
export const SIGNALS_PAGE_LIMIT = 50;

function LiveLabel({ channelCount }) {
  const { view } = useTelegramStatus();
  const label = monitoringLabel({ view, channelCount });
  return <span className={`live-label ${label.live ? '' : 'idle'}`} role="status" aria-live="polite">{label.live ? <i aria-hidden="true" /> : null}<span>{label.text}</span></span>;
}

/* Pages that own a URL, so a refresh or a pasted link lands on the page and not on Overview. Anything
   else is the workspace shell at `/`. The table is read in both directions: `App` writes the path when a
   page is opened, and reads it back on a refresh and on the browser's own back and forward. `/billing/callback`
   and `/update-password` are deliberately absent - they are full-screen flows handled before this. */
const PATH_FOR_TAB = { admin: '/admin', billing: '/billing', advanced: '/advanced', profile: '/profile' };
const TAB_FOR_PATH = Object.fromEntries(Object.entries(PATH_FOR_TAB).map(([tab, path]) => [path, tab]));

function App() {
  const [token, setToken] = useState(() => {
    try { return localStorage.getItem('signal-token') || sessionStorage.getItem('signal-token') || ''; }
    catch { return sessionStorage.getItem('signal-token') || ''; }
  });
  const [user, setUser] = useState(null);
  /* A support session is a second, one-hour, read-only token an administrator mints for
   * themselves. While it is active the whole workspace is rendered with *that* token, so what the
   * admin sees is the customer's dashboard - their signals, their accounts, their notices - and
   * every write the server refuses is refused by the server, not by a client-side guess. */
  const [support, setSupport] = useState(() => readSupportSession());
  const authToken = support?.token || token;
  const initialTabFromPath = (pathname) => TAB_FOR_PATH[String(pathname || '').replace(/\/+$/, '')] || 'overview';
  const [tab, setTab] = useState(() => initialTabFromPath(window.location.pathname));
  const [dashboard, setDashboard] = useState(null);
  const [channels, setChannels] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [signals, setSignals] = useState([]);
  const [settings, setSettings] = useState({ riskMode: 'fixed', riskPercent: 1, maxOpenPositions: 3, dailyLossLimit: 5, autoTradingEnabled: false, hasAcceptedRiskWarning: false, lotSizeMode: 'fixed', fixedLotSize: 0.01, maxDailyTrades: 10, executionAccountId: '', breakEvenEnabled: false, breakEvenTriggerPoints: 20, breakEvenOffsetPoints: 0, trailingStopEnabled: false, trailingStopDistancePoints: 10, multipleTargetHandling: 'first_target', limitOrderExpiryValue: 30, limitOrderExpiryUnit: 'minutes', maxSlippagePoints: null });
  const [linkedAccounts, setLinkedAccounts] = useState([]);
  const [trades, setTrades] = useState([]);
  const [executionRuntimeEnabled, setExecutionRuntimeEnabled] = useState(false);
  // The platform's own switch, read with the settings so the panel can explain a pause instead
  // of letting a user hunt for a toggle that is already on.
  const [executionPaused, setExecutionPaused] = useState(null);
  // Whether the pushed feed is open right now. It decides how often the dashboard polls, and nothing else:
  // a closed feed is a slower page, never a broken one.
  const [feedLive, setFeedLive] = useState(false);
  const signalsRef = useRef(null);
  const reconcilerRef = useRef(null);
  const [loading, setLoading] = useState(true);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [toggleError, setToggleError] = useState('');
  const [toggleNotice, setToggleNotice] = useState('');
  const [signalHistoryError, setSignalHistoryError] = useState('');
  const [signalHistoryNotice, setSignalHistoryNotice] = useState('');
  const [accountListError, setAccountListError] = useState('');
  const [accountListNotice, setAccountListNotice] = useState('');
  const [signalText, setSignalText] = useState('');
  // null | { kind: 'row', signal } | { kind: 'all' } - a history delete is never one click deep.
  const [signalDeletion, setSignalDeletion] = useState(null);
  const [signalDeleting, setSignalDeleting] = useState(false);
  const [accountForm, setAccountForm] = useState({ label: '', broker: '', platform: '', accountReference: '' });
  const [installPrompt, setInstallPrompt] = useState(null);
  /* null, or the mode an unauthenticated visitor asked for. A visitor who has not signed in is shown the landing
     view - the product explained, a workspace pictured - and the sign-in card only appears when they ask for it.
     Which mode they asked for is kept here rather than inside the card, so the two doors stay two doors. */
  const [authIntent, setAuthIntent] = useState(null);
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
    setError('');
    setNotice('');
    setToggleError('');
    setToggleNotice('');
    setSignalHistoryError('');
    setSignalHistoryNotice('');
    setAccountListError('');
    setAccountListNotice('');
    closeMobileSidebar();
    try {
      const path = PATH_FOR_TAB[nextTab] || '/';
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
      setTab(TAB_FOR_PATH[window.location.pathname.replace(/\/+$/, '')] || 'overview');
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

  const exitSupport = useCallback(async (session) => {
    const current = session || readSupportSession();
    // Closing the tab would leave the row alive for the rest of the hour, so say so out loud.
    if (current?.token) {
      try { await request('/api/auth/support/exit', current.token, { method: 'POST', body: {} }); } catch { /* the local session ends either way */ }
    }
    clearSupportSession();
    setSupport(null);
    setNotice('Support view closed. That workspace is no longer being watched.');
  }, []);
  const logout = useCallback(() => { try { void supabaseReady().then((client) => client?.auth.signOut({ scope: 'local' })).catch(() => {}); } catch {} try { localStorage.removeItem('signal-token'); } catch {} sessionStorage.removeItem('signal-token'); clearSupportSession(); setSupport(null); setToken(''); setUser(null); setDashboard(null); setLoading(false); }, []);
  const refresh = useCallback(async () => {
    if (!authToken) return;
    try {
      const [me, dash, channelsData, accountsData, signalsData, settingsData, tradingAccountsData, tradesData] = await Promise.all([
        request('/api/auth/me', authToken), request('/api/dashboard', authToken), request('/api/channels', authToken), request('/api/accounts', authToken), request(`/api/signals?limit=${SIGNALS_PAGE_LIMIT}`, authToken), request('/api/settings', authToken), request('/api/metaapi/linked-accounts', authToken), request('/api/trades', authToken),
      ]);
      setUser(me.user); setDashboard(dash); setChannels(channelsData.channels); setAccounts(accountsData.accounts); setSignals(signalsData.signals); signalsRef.current = signalsData.signals;
      /* The dashboard payload carries the workspace's own `auto_trading_enabled` straight out of the database,
         so it is applied first and the settings request on the same tick fills in the rest. Reading the switch
         from the row rather than from whatever a previous poll left in state is what keeps the banner from
         contradicting the engine: a signal is queued against the value in the table, and this is the same
         value, from the same read, at the same moment. */
      setSettings((current) => ({ ...current, ...(dash.settings || {}), ...settingsData.settings })); setExecutionRuntimeEnabled(Boolean(settingsData.runtimeEnabled)); setExecutionPaused(settingsData.executionPaused || null); setLinkedAccounts(tradingAccountsData.accounts || []); setTrades(tradesData.trades || []);
      setError('');
    } catch (e) {
      // A support session that just ran out must not sign the administrator out of their own work.
      if (/support session/i.test(e.message)) { void exitSupport(); return; }
      if (/expired|sign in/i.test(e.message)) logout(); else setError(e.message);
    }
    finally { setLoading(false); }
  }, [authToken, logout, exitSupport]);
  // `refresh` changes identity when the support session or the sign-out handler changes; the feed must not
  // reconnect for that reason, so it reaches the current function through a ref.
  const refreshRef = useRef(refresh);
  useEffect(() => { refreshRef.current = refresh; }, [refresh]);

  /* A captured signal is applied the moment the server emits it, then one debounced refresh reconciles the
     parts of the page the event does not carry (the outcome the worker writes a second later, the trade list,
     the counters). Merging the row rather than re-reading the page is what makes the difference visible on a
     phone: no spinner, no scroll jumping back to the top, no flash of the empty state. */
  const applyIncomingSignal = useCallback((incoming) => {
    if (!incoming || incoming.id === undefined || incoming.id === null) return;
    setSignals((current) => mergeSignalRows(current, incoming, { limit: SIGNALS_PAGE_LIMIT }));
    setDashboard((current) => (current ? { ...current, signals: mergeSignalRows(current.signals || [], incoming) } : current));
    reconcilerRef.current?.schedule();
  }, []);

  useEffect(() => {
    if (!authToken) { setFeedLive(false); return undefined; }
    reconcilerRef.current = createReconciler(() => refreshRef.current());
    const feed = connectSignalFeed({ url: API_URL, token: authToken, onSignal: applyIncomingSignal, onStatus: (state) => setFeedLive(state === 'open') });
    return () => { feed.close(); reconcilerRef.current?.cancel(); reconcilerRef.current = null; setFeedLive(false); };
  }, [authToken, applyIncomingSignal]);

  useEffect(() => {
    if (!authToken) { setLoading(false); return undefined; }
    refresh();
    // The poll is the safety net, not the mechanism: while the feed is open a slower sweep is enough, and the
    // instant one comes back the moment it is not.
    const timer = setInterval(() => { void refreshRef.current(); }, feedLive ? LIVE_SWEEP_INTERVAL_MS : FALLBACK_POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [authToken, feedLive, refresh]);

  // Coming back to a tab is when "did anything arrive while I was away?" is actually asked, and it is also
  // when a feed killed by a sleeping laptop needs re-reading. Cheap, and it removes the worst case of a
  // reconnect: the first event after the wake can be seconds away, and the interval may be minutes.
  useEffect(() => {
    if (!authToken) return undefined;
    const onVisible = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      void refreshRef.current();
    };
    window.addEventListener('focus', onVisible);
    document.addEventListener('visibilitychange', onVisible);
    return () => { window.removeEventListener('focus', onVisible); document.removeEventListener('visibilitychange', onVisible); };
  }, [authToken]);

  const beginSupportSession = useCallback((data) => {
    if (!writeSupportSession(data)) {
      setError('The browser refused to hold the support session, so it was not opened.');
      return;
    }
    setSupport(readSupportSession());
    setLoading(true);
  }, []);

  const authenticated = (data, rememberMe = true) => {
    sessionStorage.removeItem('signal-token');
    try {
      localStorage.removeItem('signal-token');
      (rememberMe ? localStorage : sessionStorage).setItem('signal-token', data.token);
    } catch { sessionStorage.setItem('signal-token', data.token); }
    setToken(data.token); setUser(data.user); setLoading(true);
  };
  const readOnlySupport = Boolean(support);
  const addManualSignal = async (event) => {
    event.preventDefault(); setError(''); setNotice(''); setSignalHistoryError(''); setSignalHistoryNotice('');
    if (readOnlySupport) { setError('Support view is read-only.'); return; }
    try { await request('/api/signals', authToken, { method: 'POST', body: { message: signalText } }); setSignalText(''); setNotice('Signal saved.'); await refresh(); }
    catch (e) { setError(e.message); }
  };
  /* Deleting a captured message is the one destructive thing in this workspace that has no undo, so
     the answer comes from the server: `deleted` is how many rows actually went, `unlinkedTrades` how
     many trades were kept and unlinked. The panel repeats those numbers rather than the ones it hoped
     for, because "cleared" said nothing when nine signals were left behind by a linked trade. */
  const confirmSignalDeletion = async () => {
    if (!signalDeletion || signalDeleting) return;
    const kind = signalDeletion.kind;
    const id = signalDeletion.signal?.id;
    setSignalDeleting(true); setSignalHistoryError(''); setSignalHistoryNotice('');
    try {
      const result = await request(kind === 'row' ? `/api/signals/${id}` : '/api/signals', authToken, { method: 'DELETE' });
      const kept = Number(result?.unlinkedTrades) || 0;
      const keptSentence = kept ? ` ${kept} trade record${kept === 1 ? '' : 's'} kept in your history.` : '';
      setSignalHistoryNotice(kind === 'row'
        ? `Signal removed.${keptSentence}`
        : `${Number(result?.deleted) || 0} captured signal${Number(result?.deleted) === 1 ? '' : 's'} removed.${keptSentence}`);
      setSignalDeletion(null);
      await refresh();
    } catch (e) { setSignalHistoryError(e.message); } finally { setSignalDeleting(false); }
  };
  const addAccount = async (event) => {
    event.preventDefault(); setError(''); setNotice(''); setAccountListError(''); setAccountListNotice('');
    if (readOnlySupport) { setError('Support view is read-only.'); return; }
    try { await request('/api/accounts', authToken, { method: 'POST', body: accountForm }); setAccountForm({ label: '', broker: '', platform: '', accountReference: '' }); setNotice('Account note saved.'); await refresh(); }
    catch (e) { setError(e.message); }
  };
  const removeAccountNote = async (accountId) => {
    setAccountListError(''); setAccountListNotice('');
    if (readOnlySupport) { setAccountListError('Support view is read-only.'); return; }
    try {
      await request(`/api/accounts/${accountId}`, authToken, { method: 'DELETE' });
      setAccountListNotice('Account note removed.');
      await refresh();
    } catch (e) {
      setAccountListError(e.message);
    }
  };
  const saveSettings = async (event) => {
    event.preventDefault(); setError(''); setNotice(''); setToggleError(''); setToggleNotice('');
    if (readOnlySupport) { setError('Support view is read-only, so risk and execution settings cannot be changed.'); return; }
    setSettingsSaving(true);
    try { const result = await request('/api/settings', authToken, { method: 'PUT', body: settings }); setSettings(result.settings); setExecutionRuntimeEnabled(Boolean(result.runtimeEnabled)); setExecutionPaused(result.executionPaused || null); setNotice('Settings saved.'); }
    catch (e) { setError(e.message); }
    finally { setSettingsSaving(false); }
  };
  // `accepted` carries the live-trading acknowledgement with the switch it belongs to, so the
  // confirmation and the change it authorises are one write and can never disagree.
  const toggleAutoTrading = async (enabled, accepted) => {
    if (settingsSaving) return;
    if (readOnlySupport) { setToggleError('Support view is read-only, so Auto-Trading cannot be switched here.'); return; }
    const previous = settings;
    const updated = { ...previous, autoTradingEnabled: enabled, ...(enabled && accepted?.hasAcceptedRiskWarning ? { hasAcceptedRiskWarning: true } : {}) };
    setSettings(updated); setError(''); setNotice(''); setToggleError(''); setToggleNotice(''); setSettingsSaving(true);
    try {
      const result = await request('/api/settings', authToken, { method: 'PUT', body: updated });
      setSettings(result.settings); setExecutionRuntimeEnabled(Boolean(result.runtimeEnabled)); setExecutionPaused(result.executionPaused || null);
      setToggleNotice(enabled ? 'Auto-Trading is on. New eligible Telegram signals may place live orders.' : 'Auto-Trading is off. No new signal orders will be submitted.');
    } catch (e) { setSettings(previous); setToggleError(e.message); }
    finally { setSettingsSaving(false); }
  };

  const autoTradingBanner = autoTradingBannerView({
    autoTradingEnabled: settings.autoTradingEnabled,
    runtimeEnabled: executionRuntimeEnabled,
    platformPause: executionPaused,
    linkedAccounts,
    executionAccountId: settings.executionAccountId,
    subscriptionStatus: dashboard?.subscription?.status ?? null,
  });
  const overviewDataUnavailable = dashboard == null;
  const overviewChannelCount = dashboard?.stats?.activeChannels ?? channels.filter((channel) => channel.enabled !== false).length;
  const overviewActivation = overviewActivationView({
    linkedAccounts,
    autoTradingEnabled: settings.autoTradingEnabled,
    executionAccountId: settings.executionAccountId,
    channelCount: overviewChannelCount,
  });
  const isAdmin = user?.role === 'admin';
  const tabs = navigationItemsForRole(user?.role).map(({ key, label }) => [key, label]);

  const normalizedPath = window.location.pathname.replace(/\/+$/, '');
  if (normalizedPath === '/billing/callback') return authToken
    ? <BillingCallbackPage />
    : <AuthScreen onAuthenticated={authenticated} installPrompt={installPrompt} onInstall={installApp} />;
  if (normalizedPath === '/update-password') return <UpdatePasswordPage />;
  if (!authToken) {
    if (authIntent) return <AuthScreen onAuthenticated={authenticated} installPrompt={installPrompt} onInstall={installApp} initialMode={authIntent} onBackToOverview={() => setAuthIntent(null)} />;
    // The whole product used to sit behind a login box, which asked a stranger to sign in to something they had no
    // way to see. Landing holds no state and sends no request, so the sign-in card is one click away in either
    // direction, and a workspace that has signed out keeps going straight to it as it always did.
    return <Landing onEnterAuth={setAuthIntent} installPrompt={installPrompt} onInstall={installApp} />;
  }
  if (loading) return <OverviewLoadingShell />;
  return <TelegramStatusProvider token={authToken}>
    <MetaApiStatusProvider token={authToken}>
    <div className={`app-shell ${sidebarVisible ? '' : 'sidebar-hidden'}`}>
    <Sidebar active={tab} onNavigate={navigateToTab} user={user} onSignOut={logout} onClose={closeMobileSidebar} visible={sidebarVisible} />
    {isMobileViewport && sidebarVisible && <button type="button" className="sidebar-backdrop" aria-label="Close navigation menu" onClick={closeMobileSidebar} />}
    <main className="main-area"><header className="topbar"><div><span className="eyebrow">PERSONAL WORKSPACE</span><h1>{tabs.find(([key]) => key === tab)?.[1] || 'Overview'}</h1></div><div className="topbar-right"><button type="button" className="button button-secondary button-small sidebar-toggle" aria-controls="workspace-sidebar" aria-expanded={sidebarVisible} aria-label={isMobileViewport ? (sidebarVisible ? 'Close navigation menu' : 'Open navigation menu') : (sidebarVisible ? 'Hide sidebar' : 'Show sidebar')} title={isMobileViewport ? (sidebarVisible ? 'Close navigation menu' : 'Open navigation menu') : (sidebarVisible ? 'Hide sidebar' : 'Show sidebar')} onClick={toggleSidebar}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{isMobileViewport ? <path d="M4 6h16M4 12h16M4 18h16" /> : <><rect x="3" y="4" width="18" height="16" rx="2"/><path d={sidebarVisible ? 'M9 4v16' : 'M15 4v16'} /></>}</svg><span>{sidebarVisible ? 'Hide sidebar' : 'Show sidebar'}</span></button>{installPrompt && <button className="button button-primary button-small install-app-button" onClick={installApp}>Install app</button>}<TelegramStatusPill /><button className="button button-secondary button-small" onClick={refresh}>Refresh</button></div></header>
      {support ? <SupportSessionBar session={support} onExit={() => { void exitSupport(support); }} /> : null}
      <AnnouncementBanner token={authToken} />
      <div className="content-area">
        {tab === 'overview' && <>
          <section className="welcome-row overview-welcome"><OverviewHeader userName={user?.name} activation={overviewActivation} unavailable={overviewDataUnavailable} /><LiveLabel channelCount={overviewChannelCount} /></section>
          <SetupChecklist channelCount={overviewChannelCount} linkedAccounts={linkedAccounts} onNavigate={navigateToTab} unavailable={overviewDataUnavailable} />
          {error && <div className="alert alert-error" role="alert">{error}</div>}
          {notice && <div className="alert alert-success" role="status" aria-live="polite">{notice}</div>}
          <OverviewMetrics
            totalSignals={dashboard?.stats?.totalSignals}
            activeChannels={overviewChannelCount}
            executedSignals={dashboard?.stats?.executedSignals}
            unavailable={overviewDataUnavailable}
          />
          <AutoTradingStatusCard activation={overviewActivation} autoTradingEnabled={settings.autoTradingEnabled} action={autoTradingBanner.action} onNavigate={navigateToTab} unavailable={overviewDataUnavailable} />
          <section className="panel"><div className="panel-heading"><div><p className="eyebrow">LATEST ACTIVITY</p><h2>Recent signals</h2></div><button className="text-button" onClick={() => setTab('signals')}>View all</button></div>{dashboard?.signalsScope === 'recent' && dashboard?.signals?.length ? <p className="dashboard-signals-note">No setup has come through your channels yet, so this is your most recent captured traffic.</p> : null}{(() => { const note = dashboardFreshnessNote({ newerCaptures: dashboard?.signalsNewerCaptures, lastCaptureAt: dashboard?.signalsLastCaptureAt }); return dashboard?.signalsScope === 'actionable' && note ? <p className="dashboard-signals-note">{note}</p> : null; })()}<SignalTable signals={dashboard?.signals || []} compact channelCount={channels.length} onOpenTelegram={() => navigateToTab('telegram')} onUpgrade={() => navigateToTab('billing')} /></section>
        </>}
        {tab === 'telegram' && <TelegramConnect token={authToken} channels={channels} onRefresh={refresh} />}
        {tab === 'metaapi' && <MetaApiPanel token={authToken} channelCount={channels.length} onOpenTelegram={() => navigateToTab('telegram')} />}
        {tab === 'signals' && <div className="panel-grid"><section className="panel"><div className="panel-heading"><div><p className="eyebrow">CAPTURED MESSAGES</p><h2>Signal history</h2></div><div className="panel-heading-actions"><span className="count-badge">{signals.length}</span>{!readOnlySupport && signals.length ? <button className="text-button" type="button" onClick={() => setSignalDeletion({ kind: 'all' })}>Clear history</button> : null}</div></div>{signalHistoryError && <div className="alert alert-error" role="alert">{signalHistoryError}</div>}{signalHistoryNotice && <div className="alert alert-success" role="status" aria-live="polite">{signalHistoryNotice}</div>}{signalsAwaitingUpgrade(signals) ? <p className="field-help signal-capture-note">Every message from your connected channels is captured and saved here, whatever your plan. Where a signal was not executed, the reason is written under it.</p> : null}<SignalTable signals={signals} channelCount={channels.length} onOpenTelegram={() => navigateToTab('telegram')} onUpgrade={() => navigateToTab('billing')} onDeleteSignal={readOnlySupport ? undefined : (signal) => setSignalDeletion({ kind: 'row', signal })} deletingId={signalDeleting && signalDeletion?.kind === 'row' ? signalDeletion.signal.id : null} /></section><section className="panel"><div className="panel-heading"><div><p className="eyebrow">MANUAL ENTRY</p><h2>Add a signal note</h2></div></div><p className="muted">Save a message for tracking. Signal Desk may identify the symbol, direction, entry, stop, and target.</p><form className="form-stack" onSubmit={addManualSignal}><label>Signal message<textarea rows="7" value={signalText} onChange={e => setSignalText(e.target.value)} placeholder={'BUY EURUSD\nEntry: 1.0850\nSL: 1.0800\nTP: 1.0950'} required maxLength={5000} /></label>{error && <div className="alert alert-error" role="alert">{error}</div>}{notice && <div className="alert alert-success" role="status" aria-live="polite">{notice}</div>}<button className="button button-primary">Save signal</button></form></section><ConfirmModal
              open={Boolean(signalDeletion)}
              busy={signalDeleting}
              title={signalDeletion?.kind === 'row' ? 'Remove this signal from your history?' : 'Clear your signal history?'}
              confirmLabel={signalDeletion?.kind === 'row' ? 'Remove signal' : 'Clear history'}
              onCancel={() => (signalDeleting ? null : setSignalDeletion(null))}
              onConfirm={confirmSignalDeletion}
            >
              {signalDeletion?.kind === 'row'
                ? <p>The message is removed from your list. If it opened a trade, that trade stays in your history with its profit and loss, and simply stops pointing at a message. A trade already open is not closed by this.</p>
                : <p>Every captured message in your history is removed, including a signal that is queued and not yet sent &mdash; that order will not go out. Trades already opened keep their records, their profit and loss, and their history; they stop pointing at a signal. This cannot be undone.</p>}
            </ConfirmModal></div>}
        {tab === 'accounts' && <div className="panel-grid"><section className="panel"><div className="panel-heading"><div><p className="eyebrow">YOUR NOTES</p><h2>Account Notes</h2></div><span className="count-badge">{accounts.length}</span></div><p className="muted">Save a label or optional reference for your own notes. To connect a trading account, open Trading Accounts.</p>{accountListError && <div className="alert alert-error" role="alert">{accountListError}</div>}{accountListNotice && <div className="alert alert-success" role="status" aria-live="polite">{accountListNotice}</div>}{!accounts.length ? <div className="empty-state"><strong>No account notes yet</strong><span>Add a label for your own reference.</span></div> : <div className="chat-list">{accounts.map(account => <div className="chat-row" key={account.id}><div><strong>{account.label}</strong><small>{[account.broker, account.platform, account.accountReference].filter(Boolean).join(' · ') || 'Reference only'}</small></div><button className="icon-button" onClick={() => removeAccountNote(account.id)}>Remove</button></div>)}</div>}</section><section className="panel"><div className="panel-heading"><div><p className="eyebrow">ADD A NOTE</p><h2>Account note</h2></div></div><form className="form-stack" onSubmit={addAccount}><label>Label<input value={accountForm.label} onChange={e => setAccountForm({ ...accountForm, label: e.target.value })} placeholder="Demo MT5 account" required maxLength={100} /></label><div className="form-row"><label>Broker<input value={accountForm.broker} onChange={e => setAccountForm({ ...accountForm, broker: e.target.value })} /></label><label>Platform<input value={accountForm.platform} onChange={e => setAccountForm({ ...accountForm, platform: e.target.value })} placeholder="MT4, MT5…" /></label></div><label>Reference<input value={accountForm.accountReference} onChange={e => setAccountForm({ ...accountForm, accountReference: e.target.value })} placeholder="Optional alias" /></label>{error && <div className="alert alert-error" role="alert">{error}</div>}{notice && <div className="alert alert-success" role="status" aria-live="polite">{notice}</div>}<button className="button button-primary">Save note</button></form></section></div>}
        {tab === 'billing' && <BillingPage token={authToken} />}
        {tab === 'admin' && (isAdmin
          ? <AdminPanel token={token} currentUser={user} onImpersonate={beginSupportSession} />
          : <section className="panel admin-denied" aria-labelledby="admin-denied-title">
            <p className="eyebrow">RESTRICTED AREA</p>
            <h2 id="admin-denied-title">Admin access required</h2>
            <p className="muted">This area is only available to workspace administrators. If you believe you should have access, contact the workspace owner.</p>
            <button type="button" className="button button-secondary" onClick={() => navigateToTab('overview')}>Return to overview</button>
          </section>)}
        {/* One settings row, two pages, one `settings` object in state: whichever page saves, it writes
            the whole row as the server last returned it, so a save on Risk Settings can never blank what
            is set on Advanced Settings. `PUT /api/settings` is unchanged by the split. */}
        {tab === 'settings' && <RiskSettings settings={settings} onChange={setSettings} onSubmit={saveSettings} onOpenAdvanced={() => navigateToTab('advanced')} saving={settingsSaving} error={error} notice={notice} />}
        {tab === 'advanced' && <AdvancedSettings settings={settings} accounts={linkedAccounts} trades={trades} runtimeAvailable={executionRuntimeEnabled} platformPause={executionPaused} onChange={setSettings} onSubmit={saveSettings} onToggle={toggleAutoTrading} onOpenRiskSettings={() => navigateToTab('settings')} onOpenTradingAccounts={() => navigateToTab('metaapi')} onOpenPlan={() => navigateToTab('billing')} subscriptionStatus={dashboard?.subscription?.status ?? null} saving={settingsSaving} error={error} notice={notice} toggleError={toggleError} toggleNotice={toggleNotice} />}
        {tab === 'profile' && <ProfileSettings user={user} token={authToken} onDeleted={logout} readOnly={readOnlySupport} />}
      </div>
      <footer className="footer">Not financial advice. Use at your own risk.</footer>
    </main>
    </div>
    </MetaApiStatusProvider>
  </TelegramStatusProvider>;
}

export default App;
