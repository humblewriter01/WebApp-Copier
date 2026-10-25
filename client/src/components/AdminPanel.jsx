import React, { useCallback, useEffect, useState } from 'react';
import { request } from '../lib/api.js';
import { healthCheckTone, killSwitchView } from '../lib/platform-view.js';
import ConfirmModal from './ConfirmModal.jsx';
import AdminActionModal from './AdminActionModal.jsx';

const PAGE_SIZE = 25;
const SECTIONS = [
  { key: 'overview', label: 'Users & activity' },
  { key: 'health', label: 'System health' },
  { key: 'pricing', label: 'Pricing & Plans' },
  { key: 'billing', label: 'Payments' },
  { key: 'announcements', label: 'Announcements' },
  { key: 'audit', label: 'Audit log' },
  { key: 'data', label: 'Data management' },
];
const HEALTH_WINDOWS = [
  { hours: 1, label: 'last hour' },
  { hours: 6, label: 'last 6 hours' },
  { hours: 24, label: 'last 24 hours' },
  { hours: 72, label: 'last 3 days' },
  { hours: 168, label: 'last 7 days' },
];
const SYNC_COPY = {
  synced: 'Saved in Paystack',
  in_sync: 'Already matched Paystack',
  failed: 'Paystack sync failed',
  not_configured: 'Paystack not configured',
  pending: 'Not synced yet',
};

/**
 * What each "Clear history" button asks before it asks the server, and what it says it removed.
 *
 * They share one state slot, one modal, and one handler on purpose: a destructive admin button that
 * reaches the network without going through this map is the bug, so the endpoints live here and the
 * handler has nothing to special-case. The first sentence of each body is the one the user has to
 * answer to; it names what is permanently deleted, in the words the panel already uses for that list.
 */
const CLEAR_HISTORY = Object.freeze({
  errors: {
    endpoint: '/api/admin/health/errors',
    title: 'Clear the recorded parsing errors?',
    confirmLabel: 'Clear parsing errors',
    first: 'Are you sure you want to permanently delete all Telegram parsing errors? This cannot be undone.',
    rest: 'Only the reason recorded against a captured message is removed. The message itself stays in that workspace\'s Signal History, so anything misread can still be reviewed or deleted one by one.',
  },
  audit: {
    endpoint: '/api/admin/audit-logs',
    title: 'Clear the administrator audit log?',
    confirmLabel: 'Delete every entry',
    first: 'Are you sure you want to permanently delete all audit entries? This cannot be undone.',
    rest: 'Every row leaves the table, including the ones about your own changes. The clear is written as the only entry that remains, so the log cannot be emptied quietly.',
  },
  banners: {
    endpoint: '/api/admin/announcements/history',
    title: 'Clear the banner history?',
    confirmLabel: 'Delete retired banners',
    first: 'Are you sure you want to permanently delete the retired banners? This cannot be undone.',
    rest: 'Banners that were retired and banners whose end date has passed are deleted, with the per-user dismissals recorded against them. Live and upcoming banners are kept.',
  },
});

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

export default function AdminPanel({ token, currentUser, onImpersonate }) {
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
  // The account is carried inside the form, not looked up from the list at submit time: a re-`find`
  // would quietly do nothing once paging or a search had replaced that page, and 'nothing happened'
  // is the worst failure an admin panel can have - no request, no error, no audit row.
  const [suspension, setSuspension] = useState({ userId: '', name: '', reason: '' });
  const [loading, setLoading] = useState(true);
  // False only until the first refresh attempt has finished, one way or the other. `loading` on its own is
  // not a safe thing to gate the panel's content on: it goes true again on every search and every page turn.
  const [painted, setPainted] = useState(false);
  const [savingPromo, setSavingPromo] = useState(false);
  const [savingPricing, setSavingPricing] = useState(false);
  const [syncingPlans, setSyncingPlans] = useState(false);
  const [busyUser, setBusyUser] = useState('');
  const [health, setHealth] = useState(null);
  const [healthHours, setHealthHours] = useState(24);
  const [switchBusy, setSwitchBusy] = useState(false);
  const [switchReason, setSwitchReason] = useState('');
  const [announcements, setAnnouncements] = useState([]);
  const [announcementForm, setAnnouncementForm] = useState({ message: '', level: 'info', startsAt: '', endsAt: '' });
  const [announcementEditing, setAnnouncementEditing] = useState({ id: '', message: '' });
  const [savingAnnouncement, setSavingAnnouncement] = useState(false);
  const [audit, setAudit] = useState({ entries: [], total: 0, totalEntries: 0, actions: [] });
  const [auditAction, setAuditAction] = useState('');
  const [auditSearchInput, setAuditSearchInput] = useState('');
  const [auditSearch, setAuditSearch] = useState('');
  const [auditOffset, setAuditOffset] = useState(0);
  /* Data management: captured signals across every workspace, and the three ways they can be removed.
     The list is read with the same filters it is deleted with, so an administrator is always confirming
     the count they can see rather than a number that was estimated somewhere else. */
  const [signals, setSignals] = useState([]);
  const [signalTotal, setSignalTotal] = useState(0);
  const [signalSearchInput, setSignalSearchInput] = useState('');
  const [signalSearch, setSignalSearch] = useState('');
  const [signalFrom, setSignalFrom] = useState('');
  const [signalTo, setSignalTo] = useState('');
  const [signalOffset, setSignalOffset] = useState(0);
  const [signalsBusy, setSignalsBusy] = useState(false);
  const [signalError, setSignalError] = useState('');
  const [signalConfirm, setSignalConfirm] = useState(null);
  const [purgeDays, setPurgeDays] = useState(30);
  const [purge, setPurge] = useState(null);
  // Which "Clear history" confirmation is open, by key in CLEAR_HISTORY. Null means no dialog is open.
  const [clearConfirm, setClearConfirm] = useState(null);
  const [clearing, setClearing] = useState(false);
  const [supportFor, setSupportFor] = useState({ userId: '', name: '', reason: '' });
  const [supportBusy, setSupportBusy] = useState('');
  const [adjustFor, setAdjustFor] = useState(null);
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

  const loadHealth = useCallback(async (hours) => {
    const windowHours = Number(hours) || 24;
    const data = await request(`/api/admin/health?hours=${encodeURIComponent(String(windowHours))}&limit=25`, token);
    /* Shaped here, once, instead of defended at each read: the health payload is the only one on this panel
     * whose lists are walked without a `?.`, and a render that throws takes the whole tree - and the dialog
     * open on top of it - down with it. A gateway that answers with something JSON-shaped but not a snapshot
     * is a real thing that happens to a service waking up on Render. */
    setHealth({ ...data, checks: data.checks || [], errors: data.errors || [], counts: data.counts || {} });
  }, [token]);

  const loadAnnouncements = useCallback(async () => {
    const data = await request('/api/admin/announcements?limit=50', token);
    setAnnouncements(data.announcements || []);
  }, [token]);

  const loadAudit = useCallback(async ({ action = '', search = '', offset = 0 } = {}) => {
    const query = new URLSearchParams({ limit: '25', offset: String(offset) });
    if (action) query.set('action', action);
    if (search) query.set('search', search);
    const data = await request(`/api/admin/audit-logs?${query.toString()}`, token);
    setAudit({ entries: data.entries || [], total: data.total || 0, totalEntries: data.totalEntries || 0, actions: data.actions || [] });
  }, [token]);

  const loadSignals = useCallback(async ({ search: nextSearch = signalSearch, from = signalFrom, to = signalTo, offset: nextOffset = signalOffset } = {}) => {
    const query = new URLSearchParams({ search: nextSearch, limit: String(PAGE_SIZE), offset: String(nextOffset) });
    if (from) query.set('from', from);
    if (to) query.set('to', to);
    const data = await request(`/api/admin/signals?${query.toString()}`, token);
    setSignals(data.signals || []);
    setSignalTotal(data.total || 0);
    setSignalOffset(Number(data.offset) || nextOffset);
  }, [token, signalSearch, signalFrom, signalTo, signalOffset]);

  const loadPurgePreview = useCallback(async (days = purgeDays) => {
    const query = new URLSearchParams({ olderThanDays: String(days) });
    const data = await request(`/api/admin/signals/purge-preview?${query.toString()}`, token);
    setPurge(data);
    return data;
  }, [token, purgeDays]);

  const applySignalFilter = async () => {
    setSignalError('');
    setSignalsBusy(true);
    try {
      await loadSignals({ search: signalSearchInput.trim(), from: signalFrom, to: signalTo, offset: 0 });
    } catch (filterError) {
      setSignalError(filterError.message || 'That search could not be read.');
    } finally {
      setSignalsBusy(false);
    }
  };

  const changeSignalPage = async (direction) => {
    const nextOffset = Math.max(0, signalOffset + direction * PAGE_SIZE);
    if (nextOffset === signalOffset) return;
    setSignalsBusy(true);
    try {
      await loadSignals({ offset: nextOffset });
    } catch (pageError) {
      setSignalError(pageError.message || 'That page could not be read.');
    } finally {
      setSignalsBusy(false);
    }
  };

  /** Every deletion goes through one handler, so the sentence after it always quotes the server's counts. */
  const runSignalDeletion = async () => {
    if (!signalConfirm || signalsBusy) return;
    const kind = signalConfirm.kind;
    setSignalsBusy(true); setSignalError(''); setError('');
    try {
      let result = null;
      if (kind === 'row') result = await request(`/api/admin/signals/${signalConfirm.row.id}`, token, { method: 'DELETE' });
      else if (kind === 'user') result = await request(`/api/admin/users/${signalConfirm.row.userId}/signals`, token, { method: 'DELETE' });
      else result = await request('/api/admin/signals/purge', token, { method: 'POST', body: { olderThanDays: Number(purgeDays) } });
      const deleted = Number(result?.deleted) || 0;
      const kept = Number(result?.unlinkedTrades) || 0;
      setNotice(`${deleted} captured signal${deleted === 1 ? '' : 's'} removed; ${kept} trade record${kept === 1 ? '' : 's'} kept and unlinked.`);
      setSignalConfirm(null);
      await Promise.all([loadSignals({ offset: kind === 'row' ? signalOffset : 0 }), loadPurgePreview(), loadOverview()]);
    } catch (deleteError) {
      // The server's own sentence, verbatim: a blocked delete carries the reason in it, and paraphrasing
      // it here is how "nothing was deleted" gets read as "it worked".
      setSignalError(deleteError.message || 'The signal could not be removed.');
    } finally {
      setSignalsBusy(false);
    }
  };

  const loadEverything = useCallback(async (nextSearch = search, nextOffset = offset) => {
    setError('');
    try {
      await Promise.all([
        loadOverview(), loadUsers(nextSearch, nextOffset), loadPromoCodes(), loadBilling(), loadPricing(), loadAnnouncements(),
      ]);
    } catch (loadError) {
      setError(loadError.message);
    } finally {
      setLoading(false);
      /* The one place that decides whether the panel has content to show at all. It is set in a `finally`,
       * so a section that failed still counts as read: the alternative - inferring it from `stats` - let a
       * workspace whose overview request failed sit in a panel where every later refresh swapped the whole
       * tree for a spinner, closing whatever dialog the administrator was typing into. */
      setPainted(true);
    }
  }, [loadOverview, loadUsers, loadPromoCodes, loadBilling, loadPricing, loadAnnouncements, search, offset]);

  useEffect(() => { loadEverything(); }, [loadEverything]);

  /* Health and the audit log read their own data when their tab is opened; audit filters and pages
   * fetch explicitly, while the health window is a dependency of its effect. Folding either into
   * loadEverything would have meant every keystroke in the audit search box re-running the panel's
   * whole refresh, because a useCallback identity changes with the state its defaults read. */
  useEffect(() => {
    if (loading || section !== 'health') return;
    loadHealth(healthHours).catch((healthError) => setError(healthError.message));
  }, [loading, section, loadHealth, healthHours]);

  useEffect(() => {
    if (loading || section !== 'data') return;
    setSignalsBusy(true);
    Promise.all([loadSignals({ offset: 0 }), loadPurgePreview()])
      .catch((dataError) => setSignalError(dataError.message))
      .finally(() => setSignalsBusy(false));
  }, [loading, section, loadSignals, loadPurgePreview]);

  useEffect(() => {
    if (loading || section !== 'audit') return;
    loadAudit({ action: auditAction, search: auditSearch, offset: auditOffset }).catch((auditError) => setError(auditError.message));
  // Deliberately only on open: changeHealthWindow, applyAuditFilter and changeAuditPage fetch with
  // the values they were handed, so the request and the state change happen exactly once each.
  }, [loading, section, loadAudit]);

  const applySearch = async (event) => {
    event.preventDefault();
    const nextSearch = searchInput.trim();
    // An open Suspend dialog is deliberately left alone here: it holds the id of the account it targets, not
    // a reference to a row that is about to scroll away, so closing it because the list moved would only
    // throw away what the administrator had typed.
    setSearch(nextSearch);
    setOffset(0);
    setLoading(true);
    await loadEverything(nextSearch, 0);
  };

  /** One path for all three clears: confirm, delete, then reload the list the button sits above. */
  const runClearHistory = async () => {
    const entry = clearConfirm ? CLEAR_HISTORY[clearConfirm.key] : null;
    if (!entry || clearing) return;
    const key = clearConfirm.key;
    setClearing(true);
    setError('');
    setNotice('');
    try {
      const data = await request(entry.endpoint, token, { method: 'DELETE', retryWhenUnanswered: true });
      // The server's count, quoted back: "it looks cleared" is not an answer an admin can act on.
      setNotice(data?.notice || 'History cleared.');
      setClearConfirm(null);
      if (key === 'errors') await loadHealth(healthHours);
      else if (key === 'audit') await loadAudit({ action: auditAction, search: auditSearch, offset: 0 });
      else await loadAnnouncements();
    } catch (clearError) {
      setError(clearError.message || 'That history could not be cleared.');
      setClearConfirm(null);
    } finally {
      setClearing(false);
    }
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
      /*
       * `retryWhenUnanswered` is what makes the Suspend button honest about a sleeping host: the
       * first write after a quiet period can reach a gateway that has not finished starting, and that
       * is a reason to wait a few seconds and send it once more, not a reason to tell the
       * administrator the change failed. A refusal from the service itself is never repeated.
       */
      await request(`/api/admin/users/${userId}`, token, { method: 'PATCH', body, retryWhenUnanswered: true });
      setNotice(successMessage);
      setSuspension({ userId: '', name: '', reason: '' });
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

  const startSuspension = (user) => setSuspension({ userId: user.id, name: user.name || user.email, reason: '' });
  const cancelSuspension = () => setSuspension({ userId: '', name: '', reason: '' });
  /**
   * Sends exactly the two fields the endpoint writes: a real boolean and the trimmed reason. The
   * reason is required here as well as on the server, because a blank one is the difference between
   * "suspended for chargeback" and an account whose owner has to ask what happened.
   */
  const confirmSuspension = async () => {
    if (!suspension.userId) { setError('Open the suspension form again for that account.'); return; }
    const reason = suspension.reason.trim();
    if (!reason) { setError('Add a short reason before suspending this user.'); return; }
    await updateUser(suspension.userId, { isSuspended: true, suspensionReason: reason }, `${suspension.name || 'That account'} has been suspended.`);
  };
  const liftSuspension = (user) => updateUser(user.id, { isSuspended: false }, `${user.name} can sign in again.`);

  /* --------------------------- system health & kill switch ---------------------------
   * The panel never decides what a state means: the server sends a headline and a sentence per
   * check, so an unreadable section reads as "Unknown" here instead of quietly looking fine.
   */
  const changeHealthWindow = (hours) => {
    // Recording the window is enough: the section's effect refetches when it changes, so the
    // select cannot end up with a request that disagrees with what the dropdown says.
    setError('');
    setHealthHours(hours);
  };

  const setSwitch = async (paused) => {
    const reason = switchReason.trim();
    if (paused && reason.length < 3) {
      setError('Add a short reason for the pause - every workspace that asks why will read it.');
      return;
    }
    setSwitchBusy(true);
    setError('');
    setNotice('');
    try {
      const data = await request('/api/admin/execution-switch', token, { method: 'PUT', body: { paused, ...(reason ? { reason } : {}) } });
      setNotice(data.notice || (paused ? 'Automatic execution is paused.' : 'Automatic execution is live again.'));
      setSwitchReason('');
      // The state shown after a toggle is read back from the server, never assumed from the
      // button that was pressed - the write and the read are separate facts.
      await Promise.all([loadHealth(healthHours), loadAudit({ action: auditAction, search: auditSearch, offset: auditOffset })]);
    } catch (switchError) {
      setError(switchError.message);
    } finally {
      setSwitchBusy(false);
    }
  };

  /* ------------------------------- announcements ------------------------------- */
  const publishAnnouncement = async (event) => {
    event.preventDefault();
    const message = announcementForm.message.trim();
    if (message.length < 4) {
      setError('Write at least 4 characters for the announcement.');
      return;
    }
    setSavingAnnouncement(true);
    setError('');
    setNotice('');
    try {
      const body = { message, level: announcementForm.level };
      if (announcementForm.startsAt) body.startsAt = new Date(announcementForm.startsAt).toISOString();
      if (announcementForm.endsAt) body.endsAt = new Date(announcementForm.endsAt).toISOString();
      const data = await request('/api/admin/announcements', token, { method: 'POST', body });
      setNotice(data.notice || 'Announcement saved.');
      setAnnouncementForm({ message: '', level: 'info', startsAt: '', endsAt: '' });
      await Promise.all([loadAnnouncements(), loadAudit({ action: auditAction, search: auditSearch, offset: auditOffset })]);
    } catch (publishError) {
      setError(publishError.message);
    } finally {
      setSavingAnnouncement(false);
    }
  };

  const retireAnnouncement = async (item) => {
    setError('');
    setNotice('');
    try {
      const data = await request(`/api/admin/announcements/${item.id}`, token, { method: 'DELETE' });
      setNotice(data.notice || 'Announcement retired.');
      await Promise.all([loadAnnouncements(), loadAudit({ action: auditAction, search: auditSearch, offset: auditOffset })]);
    } catch (retireError) {
      setError(retireError.message);
    }
  };

  const saveAnnouncementMessage = async (item) => {
    const message = announcementEditing.message.trim();
    if (message.length < 4) {
      setError('Write at least 4 characters for the announcement.');
      return;
    }
    setError('');
    try {
      await request(`/api/admin/announcements/${item.id}`, token, { method: 'PATCH', body: { message } });
      setNotice('Announcement updated.');
      setAnnouncementEditing({ id: '', message: '' });
      await Promise.all([loadAnnouncements(), loadAudit({ action: auditAction, search: auditSearch, offset: auditOffset })]);
    } catch (editError) {
      setError(editError.message);
    }
  };

  /* --------------------------------- audit log --------------------------------- */
  const applyAuditFilter = async (nextAction, nextSearch) => {
    setAuditAction(nextAction);
    setAuditSearch(nextSearch);
    setAuditOffset(0);
    setError('');
    try {
      await loadAudit({ action: nextAction, search: nextSearch, offset: 0 });
    } catch (auditError) {
      setError(auditError.message);
    }
  };

  const changeAuditPage = async (direction) => {
    const nextOffset = Math.max(0, auditOffset + direction * PAGE_SIZE);
    if (nextOffset === auditOffset) return;
    setAuditOffset(nextOffset);
    try {
      await loadAudit({ action: auditAction, search: auditSearch, offset: nextOffset });
    } catch (auditError) {
      setError(auditError.message);
    }
  };

  /* ---------------------- support access and manual adjustments ---------------------- */
  const openSupportAccess = (user) => {
    setError('');
    setNotice('');
    setSupportFor({ userId: user.id, name: user.name || user.email, reason: '' });
  };
  const closeSupportAccessForm = () => setSupportFor({ userId: '', name: '', reason: '' });

  /* The account is read from the state that opened the dialog, never looked up in `users` again: the
     list can be paged or searched while the dialog is open, and a lookup that missed would silently
     target whoever happens to be on screen. */
  const startImpersonation = async () => {
    if (!supportFor.userId) return;
    const reason = supportFor.reason.trim();
    if (reason.length < 3) {
      setError('Say why you need support access - it is written to the audit log.');
      return;
    }
    setSupportBusy(supportFor.userId);
    setError('');
    setNotice('');
    try {
      const data = await request(`/api/admin/users/${supportFor.userId}/impersonate`, token, { method: 'POST', body: { reason } });
      setSupportFor({ userId: '', name: '', reason: '' });
      setNotice(data.notice || 'Support view opened.');
      await loadAudit({ action: auditAction, search: auditSearch, offset: auditOffset });
      onImpersonate?.(data);
    } catch (supportError) {
      setError(supportError.message);
    } finally {
      setSupportBusy('');
    }
  };

  const openAdjustment = (user) => {
    setError('');
    setNotice('');
    setAdjustFor({
      userId: user.id,
      name: user.name || user.email,
      plan: '',
      days: '',
      endsAt: '',
      reason: '',
      currentPlan: user.subscriptionPlan || 'free',
      currentStatus: user.subscriptionStatus || 'free',
      periodEnd: user.periodEnd || null,
      hasProviderSubscription: user.hasProviderSubscription === true,
    });
  };
  const cancelAdjustment = () => setAdjustFor(null);

  const saveAdjustment = async () => {
    const form = adjustFor;
    if (!form?.userId) return;
    const reason = form.reason.trim();
    if (reason.length < 5) {
      setError('Add a short reason for this adjustment (at least 5 characters).');
      return;
    }
    if (!form.plan && !form.days && !form.endsAt) {
      setError('Choose a plan to grant, days to add, or an expiry date.');
      return;
    }
    if (form.plan === 'free' && (form.days || form.endsAt)) {
      setError('Moving an account to Free already ends its paid period - clear the days or the date.');
      return;
    }
    const body = { reason };
    if (form.plan) body.plan = form.plan;
    if (form.days) body.days = Number(form.days);
    if (form.endsAt) body.endsAt = new Date(form.endsAt).toISOString();
    setBusyUser(form.userId);
    setError('');
    setNotice('');
    try {
      const data = await request(`/api/admin/users/${form.userId}/subscription`, token, { method: 'PATCH', body });
      setNotice(data.notice || 'Subscription adjusted.');
      setAdjustFor(null);
      await Promise.all([loadUsers(), loadOverview(), loadBilling(), loadAudit({ action: auditAction, search: auditSearch, offset: auditOffset })]);
    } catch (adjustError) {
      setError(adjustError.message);
    } finally {
      setBusyUser('');
    }
  };

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

  // Only ever on the first paint. A refresh - a search, a page turn, the write that just landed - must never
  // replace the panel with a spinner, because the panel is where the dialogs are opened from and a subtree
  // that is swapped away takes the open form, and the reason being typed into it, with it.
  if (!painted) return <section className="panel"><div className="loading-shell inline-loading"><div className="spinner" /><span>Loading the admin dashboard…</span></div></section>;

  const currencyCode = pricing?.currency || billing?.summary?.currency || 'NGN';
  const pendingChanges = Object.keys(changedPlans()).length;
  // Never inferred from the button that was pressed, and never "Live" while the read is missing.
  const killSwitch = killSwitchView(health);

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
                  const supporting = supportFor.userId === user.id;
                  const adjusting = adjustFor?.userId === user.id;
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
                    <td data-label="Status">
                      <StatusBadge suspended={isSuspended} plan={user.subscriptionPlan} />
                      <small>{user.subscriptionStatus && user.subscriptionStatus !== 'active' ? `${user.subscriptionStatus} · ` : ''}{user.periodEnd ? `paid until ${formatDate(user.periodEnd)}` : 'no paid period'}</small>
                      {user.hasProviderSubscription ? <small className="admin-reason">Renews through Paystack</small> : null}
                    </td>
                    <td data-label="Joined">{formatDate(user.createdAt)}</td>
                    <td data-label="Last sign-in">{formatDateTime(user.lastLogin)}</td>
                    <td data-label="Signals">{user.signalCount ?? 0}</td>
                    <td data-label="Actions">
                      <div className="admin-row-actions">
                        {isSelf ? <span className="muted">—</span> : isSuspended
                          ? <button type="button" className="button button-secondary button-small" disabled={busy} onClick={() => liftSuspension(user)}>{busy ? 'Saving…' : 'Restore access'}</button>
                          : <button type="button" className="button button-danger button-small" disabled={busy} onClick={() => startSuspension(user)}>Suspend</button>}
                        <button type="button" className="button button-secondary button-small" disabled={busy || isSelf} onClick={() => (supporting ? closeSupportAccessForm() : openSupportAccess(user))}>Impersonate</button>
                        <button type="button" className="button button-secondary button-small" disabled={busy} onClick={() => (adjusting ? cancelAdjustment() : openAdjustment(user))}>Adjust plan</button>
                      </div>
                    </td>
                  </tr>;
                })}
              </tbody>
            </table>
          </div>

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
    {section === 'health' && <div id="admin-section-health" role="tabpanel" aria-labelledby="admin-tab-health">
      <section className="panel admin-panel kill-switch-panel">
        <div className="panel-heading">
          <div><p className="eyebrow">PLATFORM SAFETY</p><h2>Global auto-trading kill switch</h2></div>
          <span className={`badge ${killSwitch.state === 'live' ? 'badge-buy' : killSwitch.state === 'paused' ? 'badge-suspended' : 'badge-unknown'}`}>{killSwitch.label}</span>
        </div>
        <p className="muted">Off means no workspace can place a new automatic order. The execution engine reads this switch again before every trade, so it bites on the next job without a restart. Positions that are already open keep the stops they have - and break-even or trailing protection keeps moving, because taking a safety net away mid-incident is the opposite of what a pause is for.</p>
        {!health ? <div className="loading-shell inline-loading"><div className="spinner" /><span>{killSwitch.headline}</span></div> : <>
          <div className={`kill-switch-state tone-${healthCheckTone(killSwitch.state)}`}>
            <strong>{killSwitch.headline}</strong>
            {killSwitch.detail ? <p>{killSwitch.detail}</p> : null}
            {killSwitch.paused && killSwitch.reason ? <p className="kill-switch-reason">Reason shown to workspaces: {killSwitch.reason}</p> : null}
            {killSwitch.updatedAt ? <p className="muted">{killSwitch.updatedBy ? `Last set by ${killSwitch.updatedBy} · ` : 'Last set '}{formatDateTime(killSwitch.updatedAt)}</p> : null}
          </div>
          <form className="kill-switch-controls" onSubmit={(event) => { event.preventDefault(); setSwitch(!killSwitch.paused); }}>
            <label htmlFor="kill-switch-reason">Reason (required when pausing; shown to affected workspaces and stored in the audit log)</label>
            <input id="kill-switch-reason" value={switchReason} onChange={(event) => setSwitchReason(event.target.value)} maxLength={300} placeholder="For example: MetaAPI incident MT5-2291 - orders rejected until the broker is healthy" />
            <div className="button-row">
              <button type="submit" className={`button ${killSwitch.paused ? 'button-primary' : 'button-danger'}`} disabled={switchBusy || !killSwitch.ready}>
                {switchBusy ? 'Saving…' : killSwitch.paused ? 'Resume automatic execution' : 'Pause execution for everyone'}
              </button>
            </div>
            <p className="muted">{switchBusy ? 'The engine picks the change up on its next job.' : 'The state above is read back from the server, never assumed from this button.'}</p>
          </form>
          {health.runtimeEnabled === false ? <div className="alert alert-error" role="alert">This deployment also has AUTO_TRADING_RUNTIME_ENABLED off, so no orders are placed here at all - the switch is not the reason signals are not executing.</div> : null}
        </>}
      </section>

      <section className="panel admin-panel health-panel">
        <div className="panel-heading">
          <div><p className="eyebrow">LATEST SYSTEM ERRORS</p><h2>MetaAPI and Telegram checks</h2></div>
          <div className="panel-heading-actions">
            <label className="health-window">Window
              <select value={healthHours} onChange={(event) => changeHealthWindow(Number(event.target.value))} aria-label="Error window">
                {HEALTH_WINDOWS.map((entry) => <option key={entry.hours} value={entry.hours}>{entry.label}</option>)}
              </select>
            </label>
            <button type="button" className="button button-secondary button-small" disabled={clearing || !health || health.errorsAvailable === false} onClick={() => setClearConfirm({ key: 'errors' })}>Clear parsing errors</button>
          </div>
        </div>
        {!health ? <div className="loading-shell inline-loading"><div className="spinner" /><span>Reading the platform state…</span></div> : <>
          <ul className="health-checks">
            {(health.checks || []).map((check) => <li key={check.key} className={`health-check tone-${healthCheckTone(check.state)}`}>
              <span className="health-check-dot" aria-hidden="true" />
              <div><strong>{check.label}</strong><span className="health-check-headline">{check.headline}</span><p>{check.detail}</p></div>
            </li>)}
          </ul>
          {health.capture ? <div className="health-capture" role="note">
            <div className="health-capture-head">
              <strong>Message capture</strong>
              <span className={`count-badge ${healthCheckTone(health.capture.state)}`}>{health.capture.headline}</span>
            </div>
            <p>{health.capture.detail}</p>
            <div className="health-queue">
              <div><span>Sessions held</span><strong>{health.capture.sessionsInMemory}</strong></div>
              <div><span>Listening</span><strong>{health.capture.listening}</strong></div>
              <div><span>Messages seen</span><strong>{health.capture.messagesSeen}</strong></div>
              <div><span>Signals stored</span><strong>{health.capture.signalsSaved}</strong></div>
              <div><span>Monitored channels</span><strong>{health.capture.monitoredChannels}</strong></div>
              <div><span>Workspaces connected</span><strong>{health.capture.connectedUsers}</strong></div>
              <div><span>Last message through</span><strong>{health.capture.lastMessageAt ? formatDateTime(health.capture.lastMessageAt) : 'Never'}</strong></div>
              <div><span>Last stored signal</span><strong>{health.capture.lastSignalAt ? formatDateTime(health.capture.lastSignalAt) : 'Never'}</strong></div>
            </div>
            <p className="health-capture-foot">
              Instance up {health.capture.instanceUptimeSeconds === null ? '—' : `${health.capture.instanceUptimeSeconds}s`}
              {health.capture.instanceStartedAt ? ` · started ${formatDateTime(health.capture.instanceStartedAt)}` : ''}
              {health.capture.gitCommit ? ` · build ${health.capture.gitCommit.slice(0, 7)}` : ''}
              {health.capture.lastError ? ` · handler error: ${health.capture.lastError}` : ''}
            </p>
          </div> : null}
          <div className="health-queue">
            <div><span>Queued jobs</span><strong>{health.queue ? health.queue.queuedJobs : '—'}</strong></div>
            <div><span>In flight</span><strong>{health.queue ? health.queue.processingJobs : '—'}</strong></div>
            <div><span>Dead jobs</span><strong>{health.queue ? health.queue.deadJobs : '—'}</strong></div>
            <div><span>Orders filled in window</span><strong>{health.queue ? health.queue.executedTrades : '—'}</strong></div>
            <div><span>Auto-trading workspaces</span><strong>{health.queue ? health.queue.autoTradingWorkspaces : '—'}</strong></div>
            <div><span>Last claim</span><strong>{health.queue?.lastClaimAt ? formatDateTime(health.queue.lastClaimAt) : 'Never'}</strong></div>
          </div>

          <h3>Latest errors</h3>
          {health.errorsAvailable === false ? <div className="alert alert-error" role="alert">Recent errors could not be read from the database right now, so this list is empty because it is unknown - not because nothing went wrong.</div> : !health.errors.length ? <div className="empty-state"><strong>No errors recorded</strong><span>Nothing from MetaAPI execution, stop moves, or Telegram parsing inside {HEALTH_WINDOWS.find((entry) => entry.hours === healthHours)?.label || 'this window'}.</span></div> : <div className="admin-table-wrap">
            <table className="admin-table health-table">
              <caption className="sr-only">Recent MetaAPI execution and Telegram parsing errors</caption>
              <thead><tr><th scope="col">When</th><th scope="col">Source</th><th scope="col">Workspace</th><th scope="col">Instrument</th><th scope="col">Account</th><th scope="col">What happened</th></tr></thead>
              <tbody>
                {health.errors.map((error, index) => <tr key={`${error.kind}-${error.occurredAt}-${index}`}>
                  <td data-label="When">{formatDateTime(error.occurredAt)}</td>
                  <td data-label="Source"><span className={`badge health-kind-${error.kind}`}>{error.kindLabel}</span></td>
                  <td data-label="Workspace"><strong>{error.email}</strong>{error.name ? <small>{error.name}</small> : null}</td>
                  <td data-label="Instrument">{[error.symbol, error.side].filter(Boolean).join(' · ') || '—'}</td>
                  <td data-label="Account">{error.accountId || '—'}</td>
                  <td data-label="What happened"><code className="health-message">{error.message}</code>{error.status ? <small>status: {error.status}</small> : null}</td>
                </tr>)}
              </tbody>
            </table>
          </div>}
          {health.errors.length && health.errorsTruncated ? <p className="muted">Newest 25 only - widen the window to see further back.</p> : null}
          <p className="muted">
            Read at {formatDateTime(health.generatedAt)}.{' '}
            {health.counts?.available === false ? 'Error counts could not be read.' : Object.keys(health.counts || {}).filter((key) => key !== 'available' && key !== 'windowHours').map((key) => `${(health.counts[key] || {}).count || 0} ${key.replace(/_/g, ' ')}`).join(' · ') || 'no errors in this window.'}
          </p>
        </>}
      </section>
    </div>}

    {section === 'announcements' && <div id="admin-section-announcements" role="tabpanel" aria-labelledby="admin-tab-announcements">
      <section className="panel admin-panel">
        <div className="panel-heading">
          <div><p className="eyebrow">EVERY DASHBOARD</p><h2>System announcements</h2></div>
          <span className="count-badge">{announcements.length}</span>
        </div>
        <p className="muted">A banner appears at the top of the dashboard for signed-in users. Dismissing is per user, so a maintenance notice that one trader closed stays closed on their other devices and does not hide itself for everybody else.</p>
        <form className="announcement-form" onSubmit={publishAnnouncement}>
          <label>Message
            <textarea rows="3" value={announcementForm.message} onChange={(event) => setAnnouncementForm({ ...announcementForm, message: event.target.value })} maxLength={500} required placeholder="Scheduled maintenance on Sunday at 2 AM - orders and stop moves pause for about 20 minutes." />
          </label>
          <div className="form-row">
            <label>Severity
              <select value={announcementForm.level} onChange={(event) => setAnnouncementForm({ ...announcementForm, level: event.target.value })}>
                <option value="info">Info - quiet banner</option>
                <option value="warning">Warning - amber banner</option>
                <option value="critical">Critical - red banner, announced to screen readers</option>
              </select>
            </label>
            <label>Starts (optional)
              <input type="datetime-local" value={announcementForm.startsAt} onChange={(event) => setAnnouncementForm({ ...announcementForm, startsAt: event.target.value })} />
            </label>
            <label>Ends (optional)
              <input type="datetime-local" value={announcementForm.endsAt} onChange={(event) => setAnnouncementForm({ ...announcementForm, endsAt: event.target.value })} />
            </label>
          </div>
          <div className="button-row">
            <button type="submit" className="button button-primary" disabled={savingAnnouncement}>{savingAnnouncement ? 'Publishing…' : 'Publish banner'}</button>
            <button type="button" className="button button-secondary" onClick={() => setAnnouncementForm({ message: '', level: 'info', startsAt: '', endsAt: '' })}>Clear</button>
          </div>
        </form>
      </section>

      <section className="panel admin-panel">
        <div className="panel-heading">
          <div><p className="eyebrow">PUBLISHED</p><h2>Banner history</h2></div>
          <div className="panel-heading-actions">
            <button type="button" className="button button-secondary button-small" disabled={clearing} onClick={() => setClearConfirm({ key: 'banners' })}>Clear history</button>
          </div>
        </div>
        {!announcements.length ? <div className="empty-state"><strong>No announcements yet</strong><span>Publish one to put a banner on every dashboard.</span></div> : <div className="chat-list">
          {announcements.map((item) => <div className="announcement-row" key={item.id}>
            <div className="announcement-row-main">
              <strong>{item.message}</strong>
              <small>
                <span className={`badge ${item.state === 'live' ? 'badge-buy' : item.state === 'scheduled' ? '' : 'badge-suspended'}`}>{item.state}</span>
                {` · ${item.level} · `}
                {item.startsAt ? `from ${formatDateTime(item.startsAt)}` : 'now'}
                {item.endsAt ? ` until ${formatDateTime(item.endsAt)}` : ''}
                {` · ${item.dismissalCount || 0} user${item.dismissalCount === 1 ? '' : 's'} dismissed it`}
                {item.createdByEmail ? ` · published by ${item.createdByEmail}` : ''}
              </small>
              {announcementEditing.id === item.id ? <div className="announcement-edit">
                <label>Correct the message
                  <textarea rows="2" value={announcementEditing.message} onChange={(event) => setAnnouncementEditing({ ...announcementEditing, message: event.target.value })} maxLength={500} />
                </label>
                <div className="button-row">
                  <button type="button" className="button button-primary button-small" onClick={() => saveAnnouncementMessage(item)}>Save</button>
                  <button type="button" className="button button-secondary button-small" onClick={() => setAnnouncementEditing({ id: '', message: '' })}>Cancel</button>
                </div>
              </div> : null}
            </div>
            <div className="button-row">
              {announcementEditing.id !== item.id ? <button type="button" className="button button-secondary button-small" onClick={() => setAnnouncementEditing({ id: item.id, message: item.message })}>Edit</button> : null}
              {item.state !== 'retired' ? <button type="button" className="button button-danger button-small" onClick={() => retireAnnouncement(item)}>Retire</button> : <span className="muted">Retired</span>}
            </div>
          </div>)}
        </div>}
      </section>
    </div>}

    {section === 'audit' && <div id="admin-section-audit" role="tabpanel" aria-labelledby="admin-tab-audit">
      <section className="panel admin-panel audit-panel">
        <div className="panel-heading">
          <div><p className="eyebrow">WHO DID WHAT</p><h2>Administrator audit log</h2></div>
          <div className="panel-heading-actions">
            <span className="count-badge">{audit.total}</span>
            <button type="button" className="button button-secondary button-small" disabled={clearing || !audit.totalEntries} onClick={() => setClearConfirm({ key: 'audit' })}>Clear history</button>
          </div>
        </div>
        <p className="muted">Every price change, promo code edit, suspension, manual subscription adjustment, kill-switch movement, announcement, and support session is written here with the admin's email address and the timestamp. No entry is ever edited, and the only way one leaves the table is the Clear history button above - which records itself, so an emptied log still says when and by whom.</p>
        <form className="admin-search" role="search" onSubmit={(event) => { event.preventDefault(); applyAuditFilter(auditAction, auditSearchInput.trim()); }}>
          <label htmlFor="audit-search" className="sr-only">Search the audit log by admin email or summary</label>
          <input id="audit-search" type="search" value={auditSearchInput} onChange={(event) => setAuditSearchInput(event.target.value)} placeholder="Search by admin email or wording" maxLength={100} />
          <select value={auditAction} onChange={(event) => applyAuditFilter(event.target.value, auditSearch)} aria-label="Filter by action">
            <option value="">All actions</option>
            {(audit.actions || []).map((action) => <option key={action.key} value={action.key}>{action.label}</option>)}
          </select>
          <button type="submit" className="button button-primary button-small">Search</button>
          {auditSearch || auditAction ? <button type="button" className="button button-secondary button-small" onClick={() => { setAuditSearchInput(''); applyAuditFilter('', ''); }}>Clear</button> : null}
        </form>
        {!audit.entries.length ? <div className="empty-state"><strong>No audit entries yet</strong><span>{auditSearch || auditAction ? 'No entries match that filter.' : 'Administrator changes will appear here.'}</span></div> : <>
          <div className="admin-table-wrap">
            <table className="admin-table audit-table">
              <caption className="sr-only">Administrator actions with the admin email and timestamp</caption>
              <thead><tr><th scope="col">When</th><th scope="col">Admin</th><th scope="col">Action</th><th scope="col">What happened</th></tr></thead>
              <tbody>
                {audit.entries.map((entry) => <tr key={entry.id}>
                  <td data-label="When">{formatDateTime(entry.createdAt)}</td>
                  <td data-label="Admin"><strong>{entry.actorEmail}</strong>{entry.targetId ? <small>{entry.targetType || 'target'}: {entry.targetId}</small> : null}</td>
                  <td data-label="Action"><span className={`badge audit-action-${entry.action.replace(/\./g, '-')}`}>{entry.action}</span></td>
                  <td data-label="What happened">
                    <p className="audit-summary">{entry.summary}</p>
                    {entry.metadata && Object.keys(entry.metadata).length ? <details className="audit-meta"><summary>Details</summary><pre>{JSON.stringify(entry.metadata, null, 2)}</pre></details> : null}
                  </td>
                </tr>)}
              </tbody>
            </table>
          </div>
          <div className="admin-pagination">
            <button type="button" className="button button-secondary button-small" onClick={() => changeAuditPage(-1)} disabled={auditOffset === 0}>Previous</button>
            <span className="muted">Showing {audit.entries.length ? auditOffset + 1 : 0}–{auditOffset + audit.entries.length} of {audit.total} matching ({audit.totalEntries} entries in total)</span>
            <button type="button" className="button button-secondary button-small" onClick={() => changeAuditPage(1)} disabled={auditOffset + audit.entries.length >= audit.total}>Next</button>
          </div>
        </>}
      </section>
    </div>}

    {section === 'data' && <div id="admin-section-data" role="tabpanel" aria-labelledby="admin-tab-data">
      <section className="panel admin-panel data-management-panel">
        <div className="panel-heading">
          <div><p className="eyebrow">CAPTURED SIGNALS</p><h2>Data management</h2></div>
          <span className="count-badge">{signalTotal}</span>
        </div>
        <p className="muted">Search the signal history of every workspace by email, name, monitored channel, or symbol, and within a date range. Removing a signal never removes a trade: a trade that points at it is kept, with its profit and loss and broker records, and only unlinked.</p>
        <form className="admin-signal-filters" onSubmit={(event) => { event.preventDefault(); void applySignalFilter(); }}>
          <label htmlFor="signal-filter-search">Search
            <input id="signal-filter-search" type="search" value={signalSearchInput} onChange={(event) => setSignalSearchInput(event.target.value)} maxLength={100} placeholder="user@email.com, channel, EURUSD…" />
          </label>
          <label htmlFor="signal-filter-from">From
            <input id="signal-filter-from" type="date" value={signalFrom} onChange={(event) => setSignalFrom(event.target.value)} />
          </label>
          <label htmlFor="signal-filter-to">To
            <input id="signal-filter-to" type="date" value={signalTo} onChange={(event) => setSignalTo(event.target.value)} />
          </label>
          <button type="submit" className="button button-primary" disabled={signalsBusy}>{signalsBusy ? 'Searching…' : 'Search'}</button>
        </form>
        {signalError ? <div className="alert alert-error" role="alert">{signalError}</div> : null}
        {notice ? <div className="alert alert-success" role="status">{notice}</div> : null}
        {!signals.length && !signalsBusy ? <div className="empty-state"><strong>Nothing matched</strong><span>No captured signal has that search or date range.</span></div> : (
          <div className="admin-signal-list">
            {signals.map((row) => <article className="admin-signal-row" key={row.id}>
              <div>
                <strong>{row.symbol || 'Signal message'}{row.side ? ` · ${String(row.side).toUpperCase()}` : ''}</strong>
                <span className="admin-signal-sub">{row.userEmail || 'unknown workspace'} · {row.channelTitle || row.channelId || 'Manual entry'} · {formatDateTime(row.createdAt)} · {row.status}</span>
                {row.message ? <p>{row.message}</p> : null}
              </div>
              <div className="admin-signal-actions">
                {Number(row.tradeCount) > 0 ? <span className="admin-signal-linked">{row.tradeCount} trade record{Number(row.tradeCount) === 1 ? '' : 's'} kept, unlinked</span> : null}
                <button type="button" className="button button-danger button-small" disabled={signalsBusy} onClick={() => setSignalConfirm({ kind: 'row', row })}>Delete signal</button>
                <button type="button" className="button button-secondary button-small" disabled={signalsBusy} onClick={() => setSignalConfirm({ kind: 'user', row })}>Delete all for this user</button>
              </div>
            </article>)}
            <div className="admin-pagination">
              <button type="button" className="button button-secondary button-small" onClick={() => changeSignalPage(-1)} disabled={signalOffset === 0 || signalsBusy}>Previous</button>
              <span className="muted">Showing {signals.length ? signalOffset + 1 : 0}–{signalOffset + signals.length} of {signalTotal}</span>
              <button type="button" className="button button-secondary button-small" onClick={() => changeSignalPage(1)} disabled={signalOffset + signals.length >= signalTotal || signalsBusy}>Next</button>
            </div>
          </div>
        )}
      </section>

      <section className="panel admin-panel admin-purge-card">
        <div className="panel-heading">
          <div><p className="eyebrow">RETENTION</p><h2>Purge old signals</h2></div>
          <span className="count-badge">{purge ? purge.signals : '—'}</span>
        </div>
        <p className="admin-purge-preview">
          {purge === null
            ? 'Reading how many captured signals are older than the chosen age…'
            : purge.signals === 0
              ? `Nothing is older than ${purge.olderThanDays} days, so there is nothing to purge.`
              : `${purge.signals} captured signal(s) are older than ${purge.olderThanDays} days, across every workspace. ${purge.unlinkableTrades} linked trade record(s) would be kept and unlinked.`}
        </p>
        <form className="form-row" onSubmit={(event) => { event.preventDefault(); loadPurgePreview(Number(purgeDays)).catch((previewError) => setSignalError(previewError.message)); }}>
          <label htmlFor="purge-days">Older than (days)
            <input id="purge-days" type="number" min="1" max="3650" step="1" value={purgeDays} onChange={(event) => setPurgeDays(event.target.value)} required />
          </label>
          <button type="submit" className="button button-secondary" disabled={signalsBusy}>Recalculate</button>
        </form>
        <p className="muted">A purge deletes every workspace&rsquo;s matching signals at once. A signal that is still queued for execution is dropped along with its pending job, so that order will never be sent. Trades already opened keep their records. This cannot be undone, and it is written to the audit log with the counts it moved.</p>
        <div className="button-row">
          <button type="button" className="button button-danger" disabled={signalsBusy || !purge || !purge.signals} onClick={() => setSignalConfirm({ kind: 'purge' })}>
            {purge && purge.signals ? `Purge ${purge.signals} older than ${purge.olderThanDays} days` : 'Nothing to purge'}
          </button>
        </div>
      </section>

      <ConfirmModal
        open={Boolean(signalConfirm)}
        busy={signalsBusy}
        title={signalConfirm?.kind === 'row' ? 'Delete this captured signal?'
          : signalConfirm?.kind === 'user' ? `Delete every signal for ${signalConfirm?.row?.userEmail || 'this workspace'}?`
            : `Purge signals older than ${purgeDays} days?`}
        confirmLabel={signalConfirm?.kind === 'row' ? 'Delete signal' : signalConfirm?.kind === 'user' ? 'Delete this history' : 'Purge old signals'}
        onCancel={() => (signalsBusy ? null : setSignalConfirm(null))}
        onConfirm={runSignalDeletion}
      >
        {signalConfirm?.kind === 'purge'
          ? <p>This removes {purge?.signals ?? 0} captured signal(s) from every workspace, and any order still queued for them is dropped so it will not be sent. {purge?.unlinkableTrades ?? 0} trade record(s) stay, unlinked.</p>
          : <p>The message is removed from {signalConfirm?.row?.userEmail || 'the workspace'}. {Number(signalConfirm?.row?.tradeCount) > 0 ? `${signalConfirm.row.tradeCount} trade record(s) from it will be kept and unlinked — their profit and loss stay in the user's history.` : 'No trade points at this signal.'}</p>}
        <p>Deleting does not touch the account, its plan, its channels, its Telegram session, or any trade row.</p>
      </ConfirmModal>
    </div>}

    {/* Three tools that used to be a form squeezed under a table row. As dialogs they get the width the
        explanation needs, they cannot be pushed around by the row's column sizes, and on a phone they are
        the same screen rather than a 300px strip inside a scrolled table. */}
    <AdminActionModal
      open={Boolean(suspension.userId)}
      title={`Suspend ${suspension.name || 'this account'}`}
      intro="They cannot sign in while the suspension stands, and a support session open on their workspace is closed. Nothing is deleted - restoring the account brings it back as it was."
      confirmLabel="Suspend user"
      tone="danger"
      busy={Boolean(suspension.userId) && busyUser === suspension.userId}
      onCancel={cancelSuspension}
      onSubmit={() => { void confirmSuspension(); }}
    >
      <label>Reason shown to the user
        <input value={suspension.reason} onChange={(event) => setSuspension({ ...suspension, reason: event.target.value })} maxLength={200} required placeholder="For example: chargeback on subscription" />
      </label>
    </AdminActionModal>

    <AdminActionModal
      open={Boolean(supportFor.userId)}
      title="Open a one-hour read-only support session"
      intro={`You will see this workspace exactly as ${supportFor.name || 'this account'} does - signals, settings, accounts, and notices. Their password is never read or changed, nothing here can be written, admin tools stay unavailable, and the session ends by itself in one hour.`}
      confirmLabel="Open support view"
      busy={Boolean(supportFor.userId) && supportBusy === supportFor.userId}
      onCancel={closeSupportAccessForm}
      onSubmit={() => { void startImpersonation(); }}
    >
      <label>Why do you need this? (written to the audit log)
        <input value={supportFor.reason} onChange={(event) => setSupportFor({ ...supportFor, reason: event.target.value })} maxLength={200} required placeholder="For example: investigating a signal that did not execute on 3 Mar" />
      </label>
    </AdminActionModal>

    <AdminActionModal
      open={Boolean(adjustFor)}
      title={`Manual adjustment for ${adjustFor?.name || 'this account'}`}
      intro={`Currently ${adjustFor?.currentPlan || 'free'} (${adjustFor?.currentStatus || 'free'}), ${adjustFor?.periodEnd ? `paid until ${formatDate(adjustFor.periodEnd)}` : 'no paid period'}. ${adjustFor?.hasProviderSubscription ? 'This workspace renews through Paystack, so a gateway subscription keeps billing on its own schedule until it is cancelled there.' : 'No gateway subscription is attached to this workspace.'}`}
      confirmLabel="Save adjustment"
      busy={Boolean(adjustFor) && busyUser === adjustFor.userId}
      onCancel={cancelAdjustment}
      onSubmit={() => { void saveAdjustment(); }}
    >
      <div className="form-row">
        <label>Grant plan for free
          <select value={adjustFor?.plan || ''} onChange={(event) => setAdjustFor({ ...adjustFor, plan: event.target.value })} aria-label={`Plan to grant to ${adjustFor?.name || 'this account'}`}>
            <option value="">Leave the plan as it is</option>
            <option value="starter">Starter</option>
            <option value="pro">Pro</option>
            <option value="premium">Premium</option>
            <option value="free">Free (remove the paid plan)</option>
          </select>
        </label>
        <label>Add days
          <input type="number" min="1" max="365" step="1" value={adjustFor?.days || ''} onChange={(event) => setAdjustFor({ ...adjustFor, days: event.target.value })} placeholder="14" disabled={adjustFor?.plan === 'free'} />
        </label>
        <label>Or set an expiry date
          <input type="date" value={adjustFor?.endsAt || ''} onChange={(event) => setAdjustFor({ ...adjustFor, endsAt: event.target.value })} disabled={adjustFor?.plan === 'free' || Boolean(adjustFor?.days)} />
        </label>
      </div>
      <label>Reason (written to the audit log)
        <input value={adjustFor?.reason || ''} onChange={(event) => setAdjustFor({ ...adjustFor, reason: event.target.value })} maxLength={200} required placeholder="For example: goodwill after the MetaAPI outage on 2 March" />
      </label>
    </AdminActionModal>

    <ConfirmModal
      open={Boolean(clearConfirm)}
      busy={clearing}
      title={clearConfirm ? CLEAR_HISTORY[clearConfirm.key].title : ''}
      confirmLabel={clearConfirm ? CLEAR_HISTORY[clearConfirm.key].confirmLabel : 'Delete'}
      onCancel={() => (clearing ? null : setClearConfirm(null))}
      onConfirm={() => { void runClearHistory(); }}
    >
      {clearConfirm ? <>
        <p className="confirm-modal-count">{CLEAR_HISTORY[clearConfirm.key].first}</p>
        <p>{CLEAR_HISTORY[clearConfirm.key].rest}</p>
      </> : null}
    </ConfirmModal>
  </>;
}
