import React, { useCallback, useEffect, useState } from 'react';
import { request } from '../lib/api.js';

const PAGE_SIZE = 25;
const SECTIONS = [
  { key: 'overview', label: 'Users & activity' },
  { key: 'pricing', label: 'Pricing & Plans' },
  { key: 'billing', label: 'Payments' },
];
const SYNC_COPY = {
  synced: 'Saved in Paystack',
  in_sync: 'Already matched Paystack',
  failed: 'Paystack sync failed',
  not_configured: 'Paystack not configured',
  pending: 'Not synced yet',
};

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

function formatMoney(amountMinor, currency = 'NGN') {
  const value = Number(amountMinor || 0) / 100;
  try {
    return new Intl.NumberFormat('en-NG', { style: 'currency', currency, maximumFractionDigits: 2 }).format(value);
  } catch {
    return `${currency} ${value.toFixed(2)}`;
  }
}

function Stat({ label, value, note }) {
  return <div className="metric-card"><span className="metric-label">{label}</span><strong>{value ?? '—'}</strong><span className="metric-note">{note}</span></div>;
}

function StatusBadge({ suspended, plan }) {
  if (suspended) return <span className="badge badge-suspended">Suspended</span>;
  return <span className={`badge ${plan && plan !== 'free' ? 'badge-buy' : ''}`}>{plan && plan !== 'free' ? plan : 'Active'}</span>;
}

function syncCopy(status) {
  return SYNC_COPY[status] || 'Not synced yet';
}

export default function AdminPanel({ token, currentUser }) {
  const [stats, setStats] = useState(null);
  const [section, setSection] = useState('overview');
  const [users, setUsers] = useState([]);
  const [totalUsers, setTotalUsers] = useState(0);
  const [offset, setOffset] = useState(0);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [promoCodes, setPromoCodes] = useState([]);
  const [billing, setBilling] = useState(null);
  const [pricing, setPricing] = useState(null);
  const [priceInputs, setPriceInputs] = useState({});
  const [priceNote, setPriceNote] = useState('');
  const [syncResults, setSyncResults] = useState([]);
  const [promoForm, setPromoForm] = useState({ code: '', discountType: 'percentage', discountValue: '', maxUses: '', expiresAt: '' });
  const [suspension, setSuspension] = useState({ userId: '', reason: '' });
  const [loading, setLoading] = useState(true);
  const [savingPromo, setSavingPromo] = useState(false);
  const [savingPricing, setSavingPricing] = useState(false);
  const [syncingPlans, setSyncingPlans] = useState(false);
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

  const loadBilling = useCallback(async () => {
    const data = await request('/api/admin/billing', token);
    setBilling(data);
  }, [token]);

  const loadPricing = useCallback(async () => {
    const data = await request('/api/admin/pricing', token);
    setPricing(data);
    setPriceInputs((current) => {
      const next = { ...current };
      for (const plan of data.plans || []) {
        if (next[plan.key] === undefined || next[plan.key] === '') next[plan.key] = String(plan.amount);
      }
      return next;
    });
    return data;
  }, [token]);

  const loadEverything = useCallback(async (nextSearch = search, nextOffset = offset) => {
    setError('');
    try {
      await Promise.all([loadOverview(), loadUsers(nextSearch, nextOffset), loadPromoCodes(), loadBilling(), loadPricing()]);
    } catch (loadError) {
      setError(loadError.message);
    } finally {
      setLoading(false);
    }
  }, [loadOverview, loadUsers, loadPromoCodes, loadBilling, loadPricing, search, offset]);

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

  /* ------------------------------ pricing ------------------------------ */
  const changedPlans = () => {
    const changes = {};
    for (const plan of pricing?.plans || []) {
      const raw = String(priceInputs[plan.key] ?? '').trim();
      if (!raw) continue;
      if (Number(raw) === Number(plan.amount) && !priceNote.trim()) continue;
      changes[plan.key] = { amount: raw };
    }
    return changes;
  };

  const reportSyncs = (data) => {
    const syncs = data?.syncs || [];
    setSyncResults(syncs);
    const broken = syncs.filter((sync) => sync.usable !== true);
    if (broken.length) {
      setError(`${broken.map((sync) => `${sync.planKey}: ${sync.message}`).join(' ')} Checkout still works: users are charged the saved price as a one-time payment until the plan syncs.`);
    }
  };

  const savePricing = async (event) => {
    event?.preventDefault?.();
    const plans = changedPlans();
    if (!Object.keys(plans).length) {
      setNotice('Enter a new price before saving.');
      return;
    }
    setSavingPricing(true);
    setError('');
    setNotice('');
    setSyncResults([]);
    try {
      const data = await request('/api/admin/pricing', token, {
        method: 'PUT',
        body: {
          plans,
          billing: {
            recurringEnabled: pricing?.billing?.recurringEnabled !== false,
            updateExistingSubscriptions: pricing?.billing?.updateExistingSubscriptions !== false,
          },
          note: priceNote.trim() || undefined,
        },
      });
      await loadPricing();
      setPriceInputs({});
      setPriceNote('');
      reportSyncs(data);
      const broken = (data?.syncs || []).some((sync) => sync.usable !== true);
      if (!broken) setNotice(data.notice || 'Prices saved.');
      await loadBilling();
    } catch (saveError) {
      setError(saveError.userMessage || saveError.message);
    } finally {
      setSavingPricing(false);
    }
  };

  const clearPlanPrice = async (plan) => {
    if (!window.confirm(`Use the deployed default price for ${plan.name}? This removes the saved price for this plan.`)) return;
    setSavingPricing(true);
    setError('');
    setNotice('');
    try {
      const data = await request('/api/admin/pricing', token, {
        method: 'PUT',
        body: { plans: { [plan.key]: null }, billing: { recurringEnabled: pricing?.billing?.recurringEnabled !== false } },
      });
      await loadPricing();
      reportSyncs(data);
      setNotice(`${plan.name} now uses the deployed default price (${formatMoney(plan.environmentAmountMinor, plan.currency)}).`);
    } catch (clearError) {
      setError(clearError.userMessage || clearError.message);
    } finally {
      setSavingPricing(false);
    }
  };

  const syncPlans = async (planKey) => {
    setSyncingPlans(true);
    setError('');
    setNotice('');
    try {
      const data = await request('/api/admin/pricing/sync', token, { method: 'POST', body: planKey ? { plan: planKey } : {} });
      setPricing(data.pricing);
      setSyncResults(data.syncs || []);
      const usable = (data.syncs || []).filter((sync) => sync.usable);
      if ((data.syncs || []).length && usable.length === data.syncs.length) {
        setNotice(`Paystack plans match the saved prices${data.syncs[0]?.planCode ? ` (${data.syncs.map((sync) => sync.planCode).filter(Boolean).join(', ')})` : ''}.`);
      } else {
        reportSyncs(data);
      }
    } catch (syncError) {
      setError(syncError.userMessage || syncError.message);
    } finally {
      setSyncingPlans(false);
    }
  };

  const toggleBillingSwitch = async (key, value) => {
    setError('');
    setNotice('');
    try {
      const data = await request('/api/admin/pricing', token, { method: 'PUT', body: { billing: { [key]: value } } });
      setPricing(data.pricing);
      setNotice(key === 'recurringEnabled'
        ? (value ? 'Recurring billing is on: users who pay through a synced Paystack plan are billed again each period.' : 'Recurring billing is off: every checkout is a one-time payment for one period.')
        : (value ? 'Price changes will move existing Paystack subscriptions to the new price.' : 'Price changes will apply to new subscriptions only.'));
      const syncs = data.syncs || [];
      if (syncs.length) reportSyncs(data);
    } catch (toggleError) {
      setError(toggleError.message);
    }
  };

  /* ------------------------------- promos ------------------------------ */
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
      await loadBilling();
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
      await loadBilling();
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
      await loadBilling();
    } catch (deleteError) {
      setError(deleteError.message);
    }
  };

  if (loading && !stats) return <section className="panel"><div className="loading-shell inline-loading"><div className="spinner" /><span>Loading the admin dashboard…</span></div></section>;

  const currencyCode = pricing?.currency || billing?.summary?.currency || 'NGN';
  const pendingChanges = Object.keys(changedPlans()).length;

  return <>
    {error && <div className="alert alert-error global-alert" role="alert">{error}<button className="alert-close" type="button" onClick={() => setError('')}>×</button></div>}
    {notice && <div className="alert alert-success global-alert" role="status" aria-live="polite">{notice}<button className="alert-close" type="button" onClick={() => setNotice('')}>×</button></div>}

    <div className="admin-tabs" role="tablist" aria-label="Admin sections">
      {SECTIONS.map((item) => <button
        key={item.key}
        type="button"
        role="tab"
        id={`admin-tab-${item.key}`}
        aria-selected={section === item.key}
        aria-controls={`admin-section-${item.key}`}
        className={`admin-tab ${section === item.key ? 'active' : ''}`}
        onClick={() => setSection(item.key)}
      >
        {item.label}
        {item.key === 'pricing' && pendingChanges ? <span className="admin-tab-flag">{pendingChanges}</span> : null}
      </button>)}
    </div>

    {section === 'overview' && <div id="admin-section-overview" role="tabpanel" aria-labelledby="admin-tab-overview">
      <div className="metrics-grid admin-metrics">
        <Stat label="Total Users" value={stats?.totalUsers ?? 0} note={`${stats?.newUsers7d ?? 0} joined in the last 7 days`} />
        <Stat label="Administrators" value={stats?.adminUsers ?? 0} note="Workspace admin access" />
        <Stat label="Suspended" value={stats?.suspendedUsers ?? 0} note="Blocked from signing in" />
        <Stat label="Paid plans" value={stats?.paidUsers ?? 0} note={`${pricing?.plans?.reduce((total, plan) => total + (plan.activeSubscribers || 0), 0) ?? 0} active subscriptions`} />
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

      <section className="panel admin-panel">
        <div className="panel-heading"><div><p className="eyebrow">WORKSPACE ACTIVITY</p><h2>Platform totals</h2></div></div>
        <div className="metrics-grid admin-metrics">
          <Stat label="New users (30 days)" value={stats?.newUsers30d ?? 0} note="Recent sign-ups" />
          <Stat label="Paid plan users" value={stats?.paidUsers ?? 0} note="Non-free subscription plan" />
          <Stat label="Linked trading accounts" value={stats?.linkedTradingAccounts ?? 0} note="Connected through MetaAPI" />
          <Stat label="Signals captured" value={stats?.totalSignals ?? 0} note={`${stats?.totalTrades ?? 0} execution records`} />
        </div>
      </section>
    </div>}

    {section === 'pricing' && <div id="admin-section-pricing" role="tabpanel" aria-labelledby="admin-tab-pricing">
      <section className="panel admin-panel pricing-panel">
        <div className="panel-heading">
          <div><p className="eyebrow">PRICING</p><h2>Plan prices</h2></div>
          <span className={`status-pill ${pricing?.configured ? 'online' : ''}`}>{pricing?.configured ? 'Paystack connected' : 'Paystack not configured'}</span>
        </div>
        <p className="muted">
          Prices are saved in the workspace database and are what the Billing page shows and charges. Leaving a plan without a saved price falls back to its deployed default
          (PAYSTACK_PLAN_{'{'}STARTER|PRO|PREMIUM{'}'}_AMOUNT). Saving a price also creates or updates the matching Paystack plan, so recurring charges follow you here.
          Limits and the free tier live in the deployed catalogue (server/services/billing.js): Free is signal review with no trading accounts, and a saved price applies to
          existing subscribers as soon as their next charge.
        </p>

        {!pricing?.plans?.length ? <div className="empty-state"><strong>No paid plans available</strong><span>Set a Paystack secret key to enable plan pricing.</span></div> : <form className="pricing-plans" onSubmit={savePricing}>
          {pricing.plans.map((plan) => {
            const dirty = String(priceInputs[plan.key] ?? '').trim() && Number(priceInputs[plan.key]) !== Number(plan.amount);
            const amount = priceInputs[plan.key] ?? String(plan.amount);
            return <article className="pricing-plan-card" key={plan.key}>
              <header className="pricing-plan-head">
                <div>
                  <h3>{plan.name}</h3>
                  <small>{plan.description}</small>
                </div>
                <span className={`badge ${plan.source === 'database' ? 'badge-buy' : ''}`}>{plan.source === 'database' ? 'Saved price' : 'Deployed default'}</span>
              </header>

              <div className="pricing-plan-limits">
                <span>{plan.limits.maxTradingAccounts} trading accounts</span>
                <span>{plan.limits.maxTelegramChannels} channels</span>
                <span>{plan.limits.maxDailySignals} signals/day</span>
                <span>{plan.activeSubscribers ?? 0} active subscribers</span>
              </div>

              <label className="pricing-price-field">
                Price per {plan.interval} ({plan.currency})
                <div className="pricing-price-row">
                  <input
                    type="text"
                    inputMode="decimal"
                    value={amount}
                    onChange={(event) => setPriceInputs({ ...priceInputs, [plan.key]: event.target.value })}
                    aria-label={`${plan.name} price in ${plan.currency} per ${plan.interval}`}
                    maxLength={12}
                  />
                  {plan.source === 'database' && Number(plan.environmentAmountMinor) !== Number(plan.amountMinor)
                    ? <button type="button" className="button button-secondary button-small" disabled={savingPricing} onClick={() => clearPlanPrice(plan)}>Use default</button>
                    : null}
                </div>
                <small className="muted">
                  {plan.source === 'database'
                    ? <>Active price <strong>{formatMoney(plan.amountMinor, plan.currency)}</strong>{plan.updatedAt ? <> · saved {formatDate(plan.updatedAt)}{plan.updatedBy ? ` by ${plan.updatedBy}` : ''}</> : null}</>
                    : <>Deployed default <strong>{formatMoney(plan.environmentAmountMinor, plan.currency)}</strong> · not stored in the database yet</>}
                </small>
              </label>

              <div className={`pricing-sync pricing-sync-${plan.paystack?.syncStatus || 'pending'}`}>
                <strong>{syncCopy(plan.paystack?.syncStatus)}</strong>
                <small>
                  {plan.paystack?.planCode ? <code>{plan.paystack.planCode}</code> : 'No Paystack plan created yet.'}
                  {plan.paystack?.syncedAmountMinor != null ? ` · Paystack charges ${formatMoney(plan.paystack.syncedAmountMinor, plan.paystack?.currency || plan.currency)}` : ''}
                  {plan.paystack?.syncedAt ? ` · ${formatDateTime(plan.paystack.syncedAt)}` : ''}
                </small>
                {plan.paystack?.message || plan.paystack?.error ? <small className="pricing-sync-detail">{plan.paystack.error || plan.paystack.message}</small> : null}
                <div className="admin-row-actions">
                  <button type="button" className="button button-secondary button-small" disabled={syncingPlans || savingPricing} onClick={() => syncPlans(plan.key)}>
                    {syncingPlans ? 'Syncing…' : 'Sync with Paystack'}
                  </button>
                  <span className={`badge ${plan.renewsAutomatically ? 'badge-buy' : ''}`}>
                    {plan.renewsAutomatically ? 'Recurring ready' : 'One-time only'}
                  </span>
                </div>
              </div>
              {dirty ? <span className="pricing-dirty-note">Unsaved change — press Save changes below.</span> : null}
            </article>;
          })}

          <div className="pricing-settings">
            <label className="checkbox-row">
              <input type="checkbox" checked={pricing?.billing?.recurringEnabled !== false} onChange={(event) => toggleBillingSwitch('recurringEnabled', event.target.checked)} />
              <span>Automatic renewal through Paystack plans</span>
            </label>
            <small className="muted">Turn this off to make every checkout a single payment for one period. A synced plan is only used when the price matches Paystack exactly, and discounted checkouts are always one-time.</small>
            <label className="checkbox-row">
              <input type="checkbox" checked={pricing?.billing?.updateExistingSubscriptions !== false} onChange={(event) => toggleBillingSwitch('updateExistingSubscriptions', event.target.checked)} />
              <span>Move existing Paystack subscriptions to a new price</span>
            </label>
            <small className="muted">When off, a price change applies to new subscribers only and existing customers keep paying the price they signed up at.</small>
            <label>Change note (optional, stored in the price history)
              <input value={priceNote} onChange={(event) => setPriceNote(event.target.value)} maxLength={200} placeholder="For example: launch pricing for October" />
            </label>
          </div>

          <div className="button-row pricing-actions">
            <button className="button button-primary" type="submit" disabled={savingPricing}>{savingPricing ? 'Saving…' : `Save changes${pendingChanges ? ` (${pendingChanges})` : ''}`}</button>
            <button className="button button-secondary" type="button" disabled={syncingPlans || savingPricing} onClick={() => syncPlans(null)}>{syncingPlans ? 'Syncing…' : 'Re-sync all plans with Paystack'}</button>
          </div>
        </form>}

        {syncResults.length ? <div className="pricing-sync-results">
          <strong>Last sync result</strong>
          {syncResults.map((sync) => <p key={`${sync.planKey}-${sync.status}`}>
            <span className={`badge ${sync.usable ? 'badge-buy' : 'badge-suspended'}`}>{sync.usable ? 'OK' : 'Attention'}</span>
            {' '}{sync.planKey}: {sync.message}{sync.affectedSubscriptions != null ? ` (${sync.affectedSubscriptions} existing subscription(s) updated)` : ''}
          </p>)}
        </div> : null}

        {pricing?.plans?.some((plan) => plan.history?.length) ? <details className="pricing-history">
          <summary>Price history</summary>
          {pricing.plans.filter((plan) => plan.history?.length).map((plan) => <div key={plan.key}>
            <strong>{plan.name}</strong>
            <ul>
              {plan.history.map((entry, index) => <li key={`${plan.key}-${entry.at || index}`}>
                {formatDateTime(entry.at)} · {entry.fromMinor != null ? formatMoney(entry.fromMinor, plan.currency) : 'no stored price'} → {entry.toMinor != null ? formatMoney(entry.toMinor, plan.currency) : 'default'}{entry.by ? ` · ${entry.by}` : ''}{entry.note ? ` · ${entry.note}` : ''}
              </li>)}
            </ul>
          </div>)}
        </details> : null}
      </section>

      <div className="panel-grid">
        <section className="panel admin-panel">
          <div className="panel-heading"><div><p className="eyebrow">DISCOUNTS</p><h2>Create promo code</h2></div></div>
          <p className="muted">Promo codes apply at checkout. A discounted period is billed once, because a Paystack plan charges its own price and cannot be discounted.</p>
          <form className="form-stack" onSubmit={createPromoCode}>
            <label>Code<input value={promoForm.code} onChange={(event) => setPromoForm({ ...promoForm, code: event.target.value.toUpperCase() })} placeholder="LAUNCH25" required maxLength={50} pattern="[A-Za-z0-9][A-Za-z0-9_-]{2,49}" /></label>
            <div className="form-row">
              <label>Discount type<select value={promoForm.discountType} onChange={(event) => setPromoForm({ ...promoForm, discountType: event.target.value })}><option value="percentage">Percentage</option><option value="fixed">Fixed amount</option></select></label>
              <label>Discount value ({promoForm.discountType === 'percentage' ? '%' : currencyCode})<input type="number" min="0.01" step="0.01" value={promoForm.discountValue} onChange={(event) => setPromoForm({ ...promoForm, discountValue: event.target.value })} required placeholder={promoForm.discountType === 'percentage' ? '25' : '1000'} /></label>
            </div>
            <div className="form-row">
              <label>Maximum uses<input type="number" min="1" step="1" value={promoForm.maxUses} onChange={(event) => setPromoForm({ ...promoForm, maxUses: event.target.value })} placeholder="Unlimited" /></label>
              <label>Expires<input type="datetime-local" value={promoForm.expiresAt} onChange={(event) => setPromoForm({ ...promoForm, expiresAt: event.target.value })} /></label>
            </div>
            <button className="button button-primary" disabled={savingPromo}>{savingPromo ? 'Creating…' : 'Create promo code'}</button>
          </form>
        </section>

        <section className="panel admin-panel">
          <div className="panel-heading"><div><p className="eyebrow">DISCOUNTS</p><h2>Promo codes</h2></div><span className="count-badge">{promoCodes.length}</span></div>
          {!promoCodes.length ? <div className="empty-state"><strong>No promo codes yet</strong><span>Create a code to share a discount with your users.</span></div> : <div className="admin-table-wrap">
            <table className="admin-table">
              <caption className="sr-only">Existing promo codes</caption>
              <thead><tr><th scope="col">Code</th><th scope="col">Discount</th><th scope="col">Uses</th><th scope="col">Expires</th><th scope="col">Status</th><th scope="col">Actions</th></tr></thead>
              <tbody>
                {promoCodes.map((promoCode) => <tr key={promoCode.id}>
                  <td data-label="Code"><strong>{promoCode.code}</strong></td>
                  <td data-label="Discount">{promoCode.discountType === 'percentage' ? `${promoCode.discountValue}%` : formatMoney(Number(promoCode.discountValue) * 100, currencyCode)}</td>
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
    </div>}

    {section === 'billing' && <div id="admin-section-billing" role="tabpanel" aria-labelledby="admin-tab-billing">
      <section className="panel admin-panel" aria-labelledby="admin-billing-title">
        <div className="panel-heading">
          <div><p className="eyebrow">BILLING</p><h2 id="admin-billing-title">Subscriptions and payments</h2></div>
          <span className={`status-pill ${billing?.configured ? 'online' : ''}`}>{billing?.configured ? 'Paystack ready' : 'Payments off'}</span>
        </div>
        <div className="metrics-grid admin-metrics">
          <Stat label="Active subscriptions" value={billing?.summary?.activeSubscriptions ?? 0} note="Paid plans currently active" />
          <Stat label="Successful payments" value={billing?.summary?.successfulPayments ?? 0} note={`${billing?.summary?.pendingPayments ?? 0} pending checkouts`} />
          <Stat label="Gross collected" value={formatMoney(billing?.summary?.grossMinor, billing?.summary?.currency)} note="Verified Paystack payments" />
          <Stat label="Discounts given" value={formatMoney(billing?.summary?.discountsMinor, billing?.summary?.currency)} note="Applied promo codes" />
        </div>

        {!billing?.transactions?.length ? <div className="empty-state"><strong>No payments yet</strong><span>Successful and pending Paystack transactions will appear here.</span></div> : <div className="admin-table-wrap admin-billing-table">
          <table className="admin-table">
            <caption className="sr-only">Recent billing transactions</caption>
            <thead><tr><th scope="col">Customer</th><th scope="col">Plan</th><th scope="col">Amount</th><th scope="col">Status</th><th scope="col">Created</th></tr></thead>
            <tbody>
              {billing.transactions.map((transaction) => <tr key={transaction.reference}>
                <td data-label="Customer"><strong>{transaction.email}</strong><small>{transaction.reference}</small>{transaction.promoCode ? <small>Promo {transaction.promoCode}</small> : null}</td>
                <td data-label="Plan">{transaction.planKey}{transaction.source === 'renewal' ? <small>Auto-renewal</small> : null}</td>
                <td data-label="Amount">{formatMoney(transaction.amountMinor, transaction.currency)}</td>
                <td data-label="Status"><span className={`badge ${transaction.status === 'success' ? 'badge-buy' : ''}`}>{transaction.status}</span></td>
                <td data-label="Created">{formatDate(transaction.createdAt)}</td>
              </tr>)}
            </tbody>
          </table>
        </div>}
      </section>
    </div>}
  </>;
}
