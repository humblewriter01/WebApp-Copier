import { useCallback, useEffect, useState } from 'react';

const API_URL = (import.meta.env.VITE_API_URL || 'http://localhost:5000').replace(/\/$/, '');
const tabs = [
  ['overview', 'Overview'],
  ['telegram', 'Telegram'],
  ['signals', 'Signals'],
  ['accounts', 'Accounts'],
  ['settings', 'Risk settings'],
];

async function request(path, token, options = {}) {
  const response = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok && response.status !== 202) throw new Error(payload.error || payload.message || `Request failed (${response.status})`);
  return payload;
}

function AuthScreen({ onAuthenticated }) {
  const [mode, setMode] = useState('login');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const submit = async (event) => {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const data = await request(`/api/auth/${mode === 'login' ? 'login' : 'register'}`, null, { method: 'POST', body: form });
      onAuthenticated(data);
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  };
  return <main className="auth-shell">
    <div className="auth-brand"><div className="brand-mark">TS</div><span>Signal Desk</span></div>
    <section className="auth-card">
      <p className="eyebrow">TELEGRAM SIGNAL MONITOR</p>
      <h1>{mode === 'login' ? 'Welcome back' : 'Create your workspace'}</h1>
      <p className="muted">Review channel signals and organize your trading setup in one place.</p>
      <form onSubmit={submit} className="form-stack">
        {mode === 'register' && <label>Your name<input autoComplete="name" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} required maxLength={100} /></label>}
        <label>Email<input type="email" autoComplete="email" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} required /></label>
        <label>Password<input type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} required minLength={mode === 'register' ? 10 : 1} />{mode === 'register' && <small>Use at least 10 characters.</small>}</label>
        {error && <div className="alert alert-error">{error}</div>}
        <button className="button button-primary button-wide" disabled={busy}>{busy ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Create account'}</button>
      </form>
      <p className="auth-switch">{mode === 'login' ? 'New to Signal Desk?' : 'Already have an account?'} <button className="text-button" onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setError(''); }}>{mode === 'login' ? 'Create account' : 'Sign in'}</button></p>
      <p className="fine-print">Signal capture and organization only. This deployment does not place live trades.</p>
    </section>
  </main>;
}

function Metric({ label, value, note }) {
  return <div className="metric-card"><span className="metric-label">{label}</span><strong>{value ?? '—'}</strong><span className="metric-note">{note}</span></div>;
}

function SignalTable({ signals, compact = false }) {
  if (!signals?.length) return <div className="empty-state"><strong>No signals yet</strong><span>Connect a Telegram channel or add a signal message manually.</span></div>;
  return <div className="signal-list">{signals.map(signal => <article className="signal-item" key={signal.id}>
    <div className="signal-top"><div><strong>{signal.symbol || 'Unparsed message'}</strong><span className="signal-source">{signal.channelTitle || 'Telegram source'}</span></div><span className={`badge ${signal.side === 'buy' ? 'badge-buy' : signal.side === 'sell' ? 'badge-sell' : ''}`}>{signal.side || 'received'}</span></div>
    <p className="signal-message">{signal.message}</p>
    <div className="signal-meta">{signal.entryPrice != null && <span>Entry {signal.entryPrice}</span>}{signal.stopLoss != null && <span>SL {signal.stopLoss}</span>}{signal.takeProfit != null && <span>TP {signal.takeProfit}</span>}<time>{signal.createdAt ? new Date(signal.createdAt).toLocaleString() : ''}</time></div>
  </article>)}</div>;
}

function TelegramPanel({ token, channels, refresh }) {
  const [status, setStatus] = useState({ configured: false, connected: false });
  const [chats, setChats] = useState([]);
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [step, setStep] = useState('phone');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const checkStatus = useCallback(async () => { try { const s = await request('/api/telegram/status', token); setStatus(s); } catch (e) { setError(e.message); } }, [token]);
  const loadChats = useCallback(async () => { try { const data = await request('/api/telegram/chats', token); setChats(data.chats || []); } catch (e) { setError(e.message); } }, [token]);
  useEffect(() => { checkStatus(); }, [checkStatus]);
  useEffect(() => { if (status.connected) loadChats(); }, [status.connected, loadChats]);
  const action = async (path, body, success) => {
    setBusy(true); setError(''); setMessage('');
    try { const result = await request(path, token, { method: 'POST', body }); if (result.requiresPassword) { setStep('password'); setMessage(result.message); } else { setMessage(success || result.message || 'Done.'); if (result.connected) { setStep('phone'); await checkStatus(); await loadChats(); } } }
    catch (e) { setError(e.message); } finally { setBusy(false); }
  };
  const addChannel = async (chat) => {
    try { await request('/api/channels', token, { method: 'POST', body: chat }); setMessage(`Added ${chat.title}.`); await refresh(); } catch (e) { setError(e.message); }
  };
  const removeChannel = async (id) => {
    try { await request(`/api/channels/${id}`, token, { method: 'DELETE' }); await refresh(); } catch (e) { setError(e.message); }
  };
  return <div className="panel-grid">
    <section className="panel">
      <div className="panel-heading"><div><p className="eyebrow">SOURCE ACCOUNT</p><h2>Telegram connection</h2></div><span className={`status-pill ${status.connected ? 'online' : ''}`}>{status.connected ? 'Connected' : 'Not connected'}</span></div>
      {!status.configured && <div className="alert alert-info">Telegram is not enabled on this deployment yet. Add <code>API_ID</code> and <code>API_HASH</code> in the backend service environment to enable login.</div>}
      {status.connected ? <>
        <p className="muted">Your Telegram session is stored encrypted in the database. Only channels you subscribe to are monitored.</p>
        <div className="button-row"><button className="button button-secondary" onClick={loadChats}>Refresh channel list</button><button className="button button-danger" onClick={async () => { if (!window.confirm('Disconnect Telegram and delete the saved session?')) return; await action('/api/telegram/disconnect', {}, 'Telegram disconnected.'); setStatus({ ...status, connected: false }); setChats([]); await refresh(); }}>Disconnect</button></div>
        <h3 className="section-title">Available chats</h3>
        {!chats.length ? <p className="muted">No groups or channels were returned. Use Refresh to try again.</p> : <div className="chat-list">{chats.map(chat => { const added = channels.some(c => c.channelId === chat.channelId); return <div className="chat-row" key={chat.channelId}><div><strong>{chat.title}</strong><small>{chat.username ? `@${chat.username}` : chat.channelId}</small></div><button className="button button-small" disabled={added} onClick={() => addChannel(chat)}>{added ? 'Added' : 'Monitor'}</button></div>; })}</div>}
      </> : <>
        <p className="muted">Connect using Telegram’s login code. The service never asks for your Telegram password unless two-step verification requires it.</p>
        {step === 'phone' && <form className="form-stack" onSubmit={e => { e.preventDefault(); action('/api/telegram/request-code', { phoneNumber: phone }, 'Code requested.'); setStep('code'); }}><label>Phone number<input type="tel" placeholder="+15551234567" value={phone} onChange={e => setPhone(e.target.value)} required /></label><button className="button button-primary" disabled={busy || !status.configured}>{busy ? 'Requesting…' : 'Send Telegram code'}</button></form>}
        {step === 'code' && <form className="form-stack" onSubmit={e => { e.preventDefault(); action('/api/telegram/verify-code', { code }, 'Telegram connected.'); }}><label>Login code<input autoComplete="one-time-code" value={code} onChange={e => setCode(e.target.value)} required /></label><button className="button button-primary" disabled={busy}>{busy ? 'Verifying…' : 'Verify code'}</button></form>}
        {step === 'password' && <form className="form-stack" onSubmit={e => { e.preventDefault(); action('/api/telegram/verify-password', { password }, 'Telegram connected.'); }}><label>Two-step verification password<input type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} required /></label><button className="button button-primary" disabled={busy}>{busy ? 'Verifying…' : 'Verify password'}</button></form>}
      </>}
      {message && <div className="alert alert-success">{message}</div>}{error && <div className="alert alert-error">{error}</div>}
    </section>
    <section className="panel"><div className="panel-heading"><div><p className="eyebrow">MONITORED SOURCES</p><h2>Subscribed channels</h2></div><span className="count-badge">{channels.length}</span></div>
      {!channels.length ? <div className="empty-state"><strong>No channels selected</strong><span>Connect Telegram and choose the channels to monitor.</span></div> : <div className="chat-list">{channels.map(channel => <div className="chat-row" key={channel.id}><div><strong>{channel.title}</strong><small>{channel.enabled ? 'Monitoring enabled' : 'Paused'}</small></div><button className="icon-button" aria-label={`Remove ${channel.title}`} onClick={() => removeChannel(channel.id)}>Remove</button></div>)}</div>}
      <div className="note-box">Only new posts received while the service is awake are captured. A free Render web service can sleep; continuous monitoring requires an always-on deployment.</div>
    </section>
  </div>;
}

function App() {
  const [token, setToken] = useState(sessionStorage.getItem('signal-token') || '');
  const [user, setUser] = useState(null);
  const [tab, setTab] = useState('overview');
  const [dashboard, setDashboard] = useState(null);
  const [channels, setChannels] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [signals, setSignals] = useState([]);
  const [settings, setSettings] = useState({ riskMode: 'fixed', riskPercent: 1, maxOpenPositions: 5, dailyLossLimit: 5 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [signalText, setSignalText] = useState('');
  const [accountForm, setAccountForm] = useState({ label: '', broker: '', platform: '', accountReference: '' });

  const logout = useCallback(() => { sessionStorage.removeItem('signal-token'); setToken(''); setUser(null); setDashboard(null); setLoading(false); }, []);
  const refresh = useCallback(async () => {
    if (!token) return;
    try {
      const [me, dash, channelsData, accountsData, signalsData, settingsData] = await Promise.all([
        request('/api/auth/me', token), request('/api/dashboard', token), request('/api/channels', token), request('/api/accounts', token), request('/api/signals?limit=50', token), request('/api/settings', token),
      ]);
      setUser(me.user); setDashboard(dash); setChannels(channelsData.channels); setAccounts(accountsData.accounts); setSignals(signalsData.signals); setSettings(settingsData.settings);
      setError('');
    } catch (e) { if (/expired|sign in/i.test(e.message)) logout(); else setError(e.message); }
    finally { setLoading(false); }
  }, [token, logout]);
  useEffect(() => { if (!token) { setLoading(false); return; } refresh(); const timer = setInterval(refresh, 20_000); return () => clearInterval(timer); }, [token, refresh]);

  const authenticated = (data) => { sessionStorage.setItem('signal-token', data.token); setToken(data.token); setUser(data.user); setLoading(true); };
  const addManualSignal = async (event) => {
    event.preventDefault(); setError(''); setNotice('');
    try { await request('/api/signals', token, { method: 'POST', body: { message: signalText } }); setSignalText(''); setNotice('Signal saved.'); await refresh(); }
    catch (e) { setError(e.message); }
  };
  const addAccount = async (event) => {
    event.preventDefault(); setError('');
    try { await request('/api/accounts', token, { method: 'POST', body: accountForm }); setAccountForm({ label: '', broker: '', platform: '', accountReference: '' }); setNotice('Account note saved. No broker credentials or orders are stored.'); await refresh(); }
    catch (e) { setError(e.message); }
  };
  const saveSettings = async (event) => {
    event.preventDefault(); setError(''); setNotice('');
    try { const result = await request('/api/settings', token, { method: 'PUT', body: settings }); setSettings(result.settings); setNotice('Risk preferences saved. They do not trigger live orders.'); }
    catch (e) { setError(e.message); }
  };

  if (!token) return <AuthScreen onAuthenticated={authenticated} />;
  if (loading) return <main className="loading-shell"><div className="spinner" /><span>Loading your workspace…</span></main>;
  return <div className="app-shell">
    <aside className="sidebar"><div className="side-brand"><div className="brand-mark">TS</div><div><strong>Signal Desk</strong><small>Telegram copier</small></div></div><nav>{tabs.map(([key, label]) => <button key={key} className={`nav-item ${tab === key ? 'active' : ''}`} onClick={() => setTab(key)}><span className="nav-dot" />{label}</button>)}</nav><div className="sidebar-bottom"><div className="user-mini"><span className="avatar">{(user?.name || 'U').slice(0, 1).toUpperCase()}</span><div><strong>{user?.name}</strong><small>{user?.email}</small></div></div><button className="logout-button" onClick={logout}>Sign out</button></div></aside>
    <main className="main-area"><header className="topbar"><div><span className="eyebrow">PERSONAL WORKSPACE</span><h1>{tabs.find(([key]) => key === tab)?.[1] || 'Overview'}</h1></div><div className="topbar-right"><span className="status-pill online"><i /> Connected</span><button className="button button-secondary button-small" onClick={refresh}>Refresh</button></div></header>
      {error && <div className="alert alert-error global-alert">{error}<button className="alert-close" onClick={() => setError('')}>×</button></div>}{notice && <div className="alert alert-success global-alert">{notice}<button className="alert-close" onClick={() => setNotice('')}>×</button></div>}
      <div className="content-area">
        {tab === 'overview' && <>
          <section className="welcome-row"><div><h2>Good to see you, {user?.name?.split(' ')[0] || 'trader'}.</h2><p>Monitor Telegram signals and keep your setup organized.</p></div><span className="live-label"><i /> Signal monitoring</span></section>
          <div className="metrics-grid"><Metric label="Signals captured" value={dashboard?.stats?.totalSignals ?? 0} note="Across your workspace" /><Metric label="Active sources" value={dashboard?.stats?.activeChannels ?? 0} note="Telegram channels" /><Metric label="Account notes" value={dashboard?.stats?.accounts ?? 0} note="No secrets stored" /><Metric label="Live trades" value="Disabled" note="No live orders sent" /></div>
          <div className="notice-banner"><strong>Live execution is off</strong><span>This deployment captures and organizes signal messages. It does not connect to broker accounts or place orders.</span></div>
          <section className="panel"><div className="panel-heading"><div><p className="eyebrow">LATEST ACTIVITY</p><h2>Recent signals</h2></div><button className="text-button" onClick={() => setTab('signals')}>View all</button></div><SignalTable signals={dashboard?.signals || []} compact /></section>
        </>}
        {tab === 'telegram' && <TelegramPanel token={token} channels={channels} refresh={refresh} />}
        {tab === 'signals' && <div className="panel-grid"><section className="panel"><div className="panel-heading"><div><p className="eyebrow">CAPTURED MESSAGES</p><h2>Signal history</h2></div><span className="count-badge">{signals.length}</span></div><SignalTable signals={signals} /></section><section className="panel"><div className="panel-heading"><div><p className="eyebrow">MANUAL ENTRY</p><h2>Add a signal note</h2></div></div><p className="muted">Save a message for tracking. The parser may identify a symbol, direction, entry, stop, and target.</p><form className="form-stack" onSubmit={addManualSignal}><label>Signal message<textarea rows="7" value={signalText} onChange={e => setSignalText(e.target.value)} placeholder={'BUY EURUSD\nEntry: 1.0850\nSL: 1.0800\nTP: 1.0950'} required maxLength={5000} /></label><button className="button button-primary">Save signal</button></form></section></div>}
        {tab === 'accounts' && <div className="panel-grid"><section className="panel"><div className="panel-heading"><div><p className="eyebrow">REFERENCE ONLY</p><h2>Account notes</h2></div><span className="count-badge">{accounts.length}</span></div><p className="muted">Store labels and non-sensitive references. Do not enter broker passwords, API tokens, or account credentials.</p>{!accounts.length ? <div className="empty-state"><strong>No account notes yet</strong><span>Add a label for your own reference.</span></div> : <div className="chat-list">{accounts.map(account => <div className="chat-row" key={account.id}><div><strong>{account.label}</strong><small>{[account.broker, account.platform, account.accountReference].filter(Boolean).join(' · ') || 'Reference only'}</small></div><button className="icon-button" onClick={async () => { await request(`/api/accounts/${account.id}`, token, { method: 'DELETE' }); await refresh(); }}>Remove</button></div>)}</div>}</section><section className="panel"><div className="panel-heading"><div><p className="eyebrow">ADD ENTRY</p><h2>Account note</h2></div></div><form className="form-stack" onSubmit={addAccount}><label>Label<input value={accountForm.label} onChange={e => setAccountForm({ ...accountForm, label: e.target.value })} placeholder="Demo MT5 account" required maxLength={100} /></label><div className="form-row"><label>Broker<input value={accountForm.broker} onChange={e => setAccountForm({ ...accountForm, broker: e.target.value })} /></label><label>Platform<input value={accountForm.platform} onChange={e => setAccountForm({ ...accountForm, platform: e.target.value })} placeholder="MT4, MT5…" /></label></div><label>Non-sensitive reference<input value={accountForm.accountReference} onChange={e => setAccountForm({ ...accountForm, accountReference: e.target.value })} placeholder="Optional alias only" /></label><button className="button button-primary">Save note</button></form></section></div>}
        {tab === 'settings' && <section className="panel settings-panel"><div className="panel-heading"><div><p className="eyebrow">PREFERENCES</p><h2>Risk limits</h2></div></div><p className="muted">These values are saved as planning preferences only. No broker integration or live execution is enabled.</p><form className="form-stack settings-form" onSubmit={saveSettings}><label>Risk model<select value={settings.riskMode} onChange={e => setSettings({ ...settings, riskMode: e.target.value })}><option value="fixed">Fixed risk</option><option value="percent">Percentage based</option></select></label><label>Risk percent per position<input type="number" min="0.1" max="5" step="0.1" value={settings.riskPercent} onChange={e => setSettings({ ...settings, riskPercent: e.target.value })} /></label><label>Maximum open positions<input type="number" min="1" max="50" step="1" value={settings.maxOpenPositions} onChange={e => setSettings({ ...settings, maxOpenPositions: e.target.value })} /></label><label>Daily loss limit (%)<input type="number" min="1" max="25" step="0.5" value={settings.dailyLossLimit} onChange={e => setSettings({ ...settings, dailyLossLimit: e.target.value })} /></label><button className="button button-primary">Save preferences</button></form></section>}
      </div>
      <footer className="footer">Signal Desk · Telegram messages are encrypted in transit. Do not use this MVP as investment advice or a live execution system.</footer>
    </main>
  </div>;
}

export default App;
