import React, { useCallback, useEffect, useState } from 'react';
import { request } from '../lib/api.js';

const PAGE_SIZE = 25;

function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function formatDateTime(value) {
  if (!value) return 'Never';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Never' : date.toLocaleString();
}

function Stat({ label, value, note }) {
  return <div className="metric-card"><span className="metric-label">{label}</span><strong>{value ?? '—'}</strong><span className="metric-note">{note}</span></div>;
}

function StatusBadge({ suspended, plan }) {
  if (suspended) return <span className="badge badge-suspended">Suspended</span>;
  return <span className={`badge ${plan && plan !== 'free' ? 'badge-buy' : ''}`}>{plan && plan !== 'free' ? plan : 'Active'}</span>;
}

export default function AdminPanel({ token, currentUser }) {
  const [stats, setStats] = useState(null);
  const [users, setUsers] = useState([]);
  const [totalUsers, setTotalUsers] = useState(0);
  const [offset, setOffset] = useState(0);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [promoCodes, setPromoCodes] = useState([]);
  const [promoForm, setPromoForm] = useState({ code: '', discountType: 'percentage', discountValue: '', maxUses: '', expiresAt: '' });
  const [suspension, setSuspension] = useState({ userId: '', reason: '' });
  const [loading, setLoading] = useState(true);
  const [savingPromo, setSavingPromo] = useState(false);
  const [busyUser, setBusyUser] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const loadOverview = useCallback(async () => {
    const data = await request('/api/admin/overview', token);
    setStats(data.stats);
  }, [token]);

  const loadUsers = useCallback(async (nextSearch = search, nextOffset = offset) => {
    const query = new URLSearchParams({ search: nextSearch, limit: String(PAGE_SIZE), offset: String(nextOffset) });
    const data = await request(`/api/admin/users?${query.toString()}`, token);
    setUsers(data.users || []);
    setTotalUsers(data.total || 0);
  }, [token, search, offset]);

  const loadPromoCodes = useCallback(async () => {
    const data = await request('/api/admin/promo-codes', token);
    setPromoCodes(data.promoCodes || []);
  }, [token]);

  const loadEverything = useCallback(async (nextSearch = search, nextOffset = offset) => {
    setError('');
    try {
      await Promise.all([loadOverview(), loadUsers(nextSearch, nextOffset), loadPromoCodes()]);
    } catch (loadError) {
      setError(loadError.message);
    } finally {
      setLoading(false);
    }
  }, [loadOverview, loadUsers, loadPromoCodes, search, offset]);

  useEffect(() => { loadEverything(); }, [loadEverything]);

  const applySearch = async (event) => {
    event.preventDefault();
    const nextSearch = searchInput.trim();
    setSearch(nextSearch);
    setOffset(0);
    setLoading(true);
    await loadEverything(nextSearch, 0);
  };

  const changePage = async (direction) => {
    const nextOffset = Math.max(0, offset + direction * PAGE_SIZE);
    if (nextOffset === offset) return;
    setOffset(nextOffset);
    setLoading(true);
    await loadEverything(search, nextOffset);
  };

  const updateUser = async (userId, body, successMessage) => {
    setBusyUser(userId);
    setError('');
    setNotice('');
    try {
      await request(`/api/admin/users/${userId}`, token, { method: 'PATCH', body });
      setNotice(successMessage);
      setSuspension({ userId: '', reason: '' });
      await loadOverview();
      await loadUsers();
    } catch (updateError) {
      setError(updateError.message);
    } finally {
      setBusyUser('');
    }
  };

  const changeRole = (user, role) => {
    if (role === user.role) return;
    void updateUser(user.id, { role }, role === 'admin' ? `${user.name} is now an administrator.` : `${user.name} is now a standard user.`);
  };

  const startSuspension = (user) => setSuspension({ userId: user.id, reason: '' });
  const cancelSuspension = () => setSuspension({ userId: '', reason: '' });
  const confirmSuspension = async (user) => {
    const reason = suspension.reason.trim();
    if (!reason) { setError('Add a short reason before suspending this user.'); return; }
    await updateUser(user.id, { isSuspended: true, suspensionReason: reason }, `${user.name} has been suspended.`);
  };
  const liftSuspension = (user) => updateUser(user.id, { isSuspended: false }, `${user.name} can sign in again.`);

  const createPromoCode = async (event) => {
    event.preventDefault();
    setSavingPromo(true);
    setError('');
    setNotice('');
    try {
      const payload = {
        code: promoForm.code,
        discountType: promoForm.discountType,
        discountValue: promoForm.discountValue,
        maxUses: promoForm.maxUses === '' ? null : promoForm.maxUses,
        expiresAt: promoForm.expiresAt === '' ? null : new Date(promoForm.expiresAt).toISOString(),
      };
      const data = await request('/api/admin/promo-codes', token, { method: 'POST', body: payload });
      setPromoCodes((current) => [data.promoCode, ...current]);
      setPromoForm({ code: '', discountType: 'percentage', discountValue: '', maxUses: '', expiresAt: '' });
      setNotice(`Promo code ${data.promoCode.code} created.`);
      await loadOverview();
    } catch (createError) {
      setError(createError.message);
    } finally {
      setSavingPromo(false);
    }
  };

  const togglePromoCode = async (promoCode) => {
    setError('');
    setNotice('');
    try {
      const data = await request(`/api/admin/promo-codes/${promoCode.id}`, token, { method: 'PATCH', body: { active: !promoCode.active } });
      setPromoCodes((current) => current.map((item) => (item.id === promoCode.id ? data.promoCode : item)));
      setNotice(`${promoCode.code} is now ${data.promoCode.active ? 'active' : 'paused'}.`);
      await loadOverview();
    } catch (updateError) {
      setError(updateError.message);
    }
  };

  const removePromoCode = async (promoCode) => {
    if (typeof window !== 'undefined' && !window.confirm(`Delete promo code ${promoCode.code}? This cannot be undone.`)) return;
    setError('');
    setNotice('');
    try {
      await request(`/api/admin/promo-codes/${promoCode.id}`, token, { method: 'DELETE' });
      setPromoCodes((current) => current.filter((item) => item.id !== promoCode.id));
      setNotice(`${promoCode.code} deleted.`);
      await loadOverview();
    } catch (deleteError) {
      setError(deleteError.message);
    }
  };

  if (loading && !stats) return <section className="panel"><div className="loading-shell inline-loading"><div className="spinner" /><span>Loading the admin dashboard…</span></div></section>;

  return <>
    {error && <div className="alert alert-error global-alert" role="alert">{error}<button className="alert-close" type="button" onClick={() => setError('')}>×</button></div>}
    {notice && <div className="alert alert-success global-alert" role="status" aria-live="polite">{notice}<button className="alert-close" type="button" onClick={() => setNotice('')}>×</button></div>}

    <div className="metrics-grid admin-metrics">
      <Stat label="Total Users" value={stats?.totalUsers ?? 0} note={`${stats?.newUsers7d ?? 0} joined in the last 7 days`} />
      <Stat label="Administrators" value={stats?.adminUsers ?? 0} note="Workspace admin access" />
      <Stat label="Suspended" value={stats?.suspendedUsers ?? 0} note="Blocked from signing in" />
      <Stat label="Promo Codes" value={stats?.activePromoCodes ?? 0} note={`${stats?.totalPromoCodes ?? 0} created in total`} />
    </div>

    <section className="panel admin-panel">
      <div className="panel-heading">
        <div><p className="eyebrow">USER MANAGEMENT</p><h2>Users</h2></div>
        <span className="count-badge">{totalUsers}</span>
      </div>

      <form className="admin-search" onSubmit={applySearch} role="search">
        <label htmlFor="admin-user-search" className="sr-only">Search users by name or email</label>
        <input id="admin-user-search" type="search" value={searchInput} onChange={(event) => setSearchInput(event.target.value)} placeholder="Search by name or email" maxLength={100} />
        <button className="button button-primary button-small" disabled={loading}>{loading ? 'Searching…' : 'Search'}</button>
        {search && <button type="button" className="button button-secondary button-small" onClick={() => { setSearchInput(''); setSearch(''); setOffset(0); setLoading(true); void loadEverything('', 0); }}>Clear</button>}
      </form>

      {!users.length ? <div className="empty-state"><strong>No users found</strong><span>{search ? 'Try a different name or email address.' : 'New sign-ups will appear here.'}</span></div> : <>
        <div className="admin-table-wrap">
          <table className="admin-table">
            <caption className="sr-only">Workspace users, roles, and account status</caption>
            <thead>
              <tr><th scope="col">User</th><th scope="col">Role</th><th scope="col">Status</th><th scope="col">Joined</th><th scope="col">Last sign-in</th><th scope="col">Signals</th><th scope="col">Actions</th></tr>
            </thead>
            <tbody>
              {users.map((user) => {
                const isSelf = user.id === currentUser?.id;
                const isSuspended = user.isSuspended === true;
                const busy = busyUser === user.id;
                return <tr key={user.id} className={isSuspended ? 'admin-row-suspended' : undefined}>
                  <td data-label="User">
                    <strong>{user.name}{isSelf ? ' (you)' : ''}</strong>
                    <small>{user.email}</small>
                    {isSuspended && user.suspensionReason ? <small className="admin-reason">Reason: {user.suspensionReason}</small> : null}
                  </td>
                  <td data-label="Role">
                    <select
                      value={user.role}
                      aria-label={`Role for ${user.name}`}
                      disabled={busy || isSelf}
                      onChange={(event) => changeRole(user, event.target.value)}
                    >
                      <option value="user">User</option>
                      <option value="admin">Admin</option>
                    </select>
                  </td>
                  <td data-label="Status"><StatusBadge suspended={isSuspended} plan={user.subscriptionPlan} /></td>
                  <td data-label="Joined">{formatDate(user.createdAt)}</td>
                  <td data-label="Last sign-in">{formatDateTime(user.lastLogin)}</td>
                  <td data-label="Signals">{user.signalCount ?? 0}</td>
                  <td data-label="Actions">
                    {isSelf ? <span className="muted">—</span> : isSuspended
                      ? <button type="button" className="button button-secondary button-small" disabled={busy} onClick={() => liftSuspension(user)}>{busy ? 'Saving…' : 'Restore access'}</button>
                      : <button type="button" className="button button-danger button-small" disabled={busy} onClick={() => startSuspension(user)}>Suspend</button>}
                  </td>
                </tr>;
              })}
            </tbody>
          </table>
        </div>

        {suspension.userId && <form className="admin-suspend" onSubmit={(event) => { event.preventDefault(); const user = users.find((item) => item.id === suspension.userId); if (user) confirmSuspension(user); }}>
          <strong>Suspend this account</strong>
          <label>Reason shown to the user<input value={suspension.reason} onChange={(event) => setSuspension({ ...suspension, reason: event.target.value })} maxLength={200} required placeholder="For example: chargeback on subscription" /></label>
          <div className="button-row">
            <button type="submit" className="button button-danger" disabled={busyUser === suspension.userId}>Suspend user</button>
            <button type="button" className="button button-secondary" onClick={cancelSuspension}>Cancel</button>
          </div>
        </form>}

        <div className="admin-pagination">
          <button type="button" className="button button-secondary button-small" onClick={() => changePage(-1)} disabled={offset === 0 || loading}>Previous</button>
          <span className="muted">Showing {users.length ? offset + 1 : 0}–{offset + users.length} of {totalUsers}</span>
          <button type="button" className="button button-secondary button-small" onClick={() => changePage(1)} disabled={offset + users.length >= totalUsers || loading}>Next</button>
        </div>
      </>}
    </section>

    <div className="panel-grid">
      <section className="panel admin-panel">
        <div className="panel-heading"><div><p className="eyebrow">PROMOTIONS</p><h2>Create promo code</h2></div></div>
        <form className="form-stack" onSubmit={createPromoCode}>
          <label>Code<input value={promoForm.code} onChange={(event) => setPromoForm({ ...promoForm, code: event.target.value.toUpperCase() })} placeholder="LAUNCH25" required maxLength={50} pattern="[A-Za-z0-9][A-Za-z0-9_-]{2,49}" /></label>
          <div className="form-row">
            <label>Discount type<select value={promoForm.discountType} onChange={(event) => setPromoForm({ ...promoForm, discountType: event.target.value })}><option value="percentage">Percentage</option><option value="fixed">Fixed amount</option></select></label>
            <label>Discount value<input type="number" min="0.01" step="0.01" value={promoForm.discountValue} onChange={(event) => setPromoForm({ ...promoForm, discountValue: event.target.value })} required placeholder={promoForm.discountType === 'percentage' ? '25' : '1000'} /></label>
          </div>
          <div className="form-row">
            <label>Maximum uses<input type="number" min="1" step="1" value={promoForm.maxUses} onChange={(event) => setPromoForm({ ...promoForm, maxUses: event.target.value })} placeholder="Unlimited" /></label>
            <label>Expires<input type="datetime-local" value={promoForm.expiresAt} onChange={(event) => setPromoForm({ ...promoForm, expiresAt: event.target.value })} /></label>
          </div>
          <button className="button button-primary" disabled={savingPromo}>{savingPromo ? 'Creating…' : 'Create promo code'}</button>
        </form>
      </section>

      <section className="panel admin-panel">
        <div className="panel-heading"><div><p className="eyebrow">PROMOTIONS</p><h2>Promo codes</h2></div><span className="count-badge">{promoCodes.length}</span></div>
        {!promoCodes.length ? <div className="empty-state"><strong>No promo codes yet</strong><span>Create a code to share a discount with your users.</span></div> : <div className="admin-table-wrap">
          <table className="admin-table">
            <caption className="sr-only">Existing promo codes</caption>
            <thead><tr><th scope="col">Code</th><th scope="col">Discount</th><th scope="col">Uses</th><th scope="col">Expires</th><th scope="col">Status</th><th scope="col">Actions</th></tr></thead>
            <tbody>
              {promoCodes.map((promoCode) => <tr key={promoCode.id}>
                <td data-label="Code"><strong>{promoCode.code}</strong></td>
                <td data-label="Discount">{promoCode.discountType === 'percentage' ? `${promoCode.discountValue}%` : promoCode.discountValue}</td>
                <td data-label="Uses">{promoCode.currentUses}{promoCode.maxUses ? ` / ${promoCode.maxUses}` : ' / ∞'}</td>
                <td data-label="Expires">{formatDate(promoCode.expiresAt)}</td>
                <td data-label="Status"><span className={`badge ${promoCode.active ? 'badge-buy' : ''}`}>{promoCode.active ? 'Active' : 'Paused'}</span></td>
                <td data-label="Actions">
                  <div className="admin-row-actions">
                    <button type="button" className="icon-button" onClick={() => togglePromoCode(promoCode)}>{promoCode.active ? 'Pause' : 'Activate'}</button>
                    <button type="button" className="icon-button" onClick={() => removePromoCode(promoCode)}>Delete</button>
                  </div>
                </td>
              </tr>)}
            </tbody>
          </table>
        </div>}
      </section>
    </div>

    <section className="panel admin-panel">
      <div className="panel-heading"><div><p className="eyebrow">WORKSPACE ACTIVITY</p><h2>Platform totals</h2></div></div>
      <div className="metrics-grid admin-metrics">
        <Stat label="New users (30 days)" value={stats?.newUsers30d ?? 0} note="Recent sign-ups" />
        <Stat label="Paid plan users" value={stats?.paidUsers ?? 0} note="Non-free subscription plan" />
        <Stat label="Linked trading accounts" value={stats?.linkedTradingAccounts ?? 0} note="Connected through MetaAPI" />
        <Stat label="Signals captured" value={stats?.totalSignals ?? 0} note={`${stats?.totalTrades ?? 0} execution records`} />
      </div>
    </section>
  </>;
}
