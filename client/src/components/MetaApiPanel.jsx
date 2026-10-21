import React, { useCallback, useEffect, useState } from 'react';
import { request } from '../lib/api.js';
import { useTelegramStatus } from './TelegramStatus.jsx';
import { MetaApiStatusPill, useMetaApiStatus } from './MetaApiStatus.jsx';

function accountStateLabel(state) {
  const normalized = String(state || '').toUpperCase();
  if (normalized === 'DRAFT' || normalized === 'UNDEPLOYED') return 'Awaiting secure setup';
  if (normalized === 'DEPLOYED' || normalized === 'CONNECTED') return 'Connected';
  if (!normalized) return 'Status unavailable';
  return normalized.toLowerCase().replaceAll('_', ' ').replace(/^./, (character) => character.toUpperCase());
}

/**
 * Idle-state copy for accounts Signal Desk pays for. A user with a paid plan is never
 * warned, because their accounts are exempt from the inactivity deletion.
 */
export function idleWarnings({ accounts = [], inactivity = null } = {}) {
  if (!inactivity || inactivity.exempt) return [];
  const deletionDays = Number(inactivity.deletionDays) || 30;
  return accounts
    .filter((account) => account.managedByApp && (account.inactivityStatus === 'warned' || account.inactivityStatus === 'deferred'))
    .map((account) => {
      const name = account.name || account.login || 'Trading account';
      const days = Number(account.daysInactive || 0);
      if (account.inactivityStatus === 'deferred') {
        return {
          id: account.metaApiAccountId,
          tone: 'info',
          text: `"${name}" has been idle for ${days} days but was not deleted. ${account.inactivityReason || 'Close any open positions and remove it yourself when you are ready.'}`,
        };
      }
      return {
        id: account.metaApiAccountId,
        tone: 'alert',
        text: `"${name}" has been inactive for ${days} days and will be permanently deleted in ${Math.max(1, deletionDays - days)} days. Sign in or run a trade to keep it.`,
      };
    });
}

/**
 * Whether the broker account on this page can receive anything to trade, stated only from
 * a confirmed Telegram state. While the answer is unknown the line is simply absent —
 * an absent note is honest, a guessed one is what made this page flash a connect prompt.
 */
export function telegramSourceNote({ view, channelCount = 0 } = {}) {
  if (view?.key === 'disconnected') {
    return { tone: 'info', action: 'connect', text: 'Telegram is not connected, so there are no signals for this account to execute.' };
  }
  if (view?.key === 'connected' && !Number(channelCount)) {
    return { tone: 'info', action: 'choose', text: 'Telegram is connected, but no channels are selected yet, so nothing new will arrive to execute.' };
  }
  if (view?.key === 'unavailable') {
    return { tone: 'info', action: null, text: view.detail || 'Telegram sign-in is temporarily unavailable, so new signals cannot be captured yet.' };
  }
  return null;
}

export default function MetaApiPanel({ token, channelCount = 0, onOpenTelegram }) {
  const { view } = useTelegramStatus();
  // Whether this service can provision accounts is shared, not local: a private copy of it
  // is how the panel came to flash "Unavailable" and swap the form for an explanation while
  // its own request was still in flight.
  const { view: setup, refresh: refreshSetup } = useMetaApiStatus();
  const [accounts, setAccounts] = useState([]);
  const [form, setForm] = useState({ name: '', platform: 'mt5', server: '' });
  const [setupLink, setSetupLink] = useState(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [inactivity, setInactivity] = useState(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    // The provisioning pill is owned by the shared status provider; asking it to re-check
    // keeps a manual refresh behaving the way it did when this panel fetched the status
    // itself. The provider deduplicates concurrent checks, so mounting alongside its own
    // fetch costs nothing.
    refreshSetup();
    setError('');
    try {
      const linked = await request('/api/metaapi/linked-accounts', token);
      setAccounts(linked.accounts || []);
      setInactivity(linked.inactivity || null);
    } catch (requestError) {
      setError(requestError.message || 'We could not load your trading accounts. Please try again.');
    } finally {
      setLoading(false);
    }
  }, [token, refreshSetup]);

  useEffect(() => { refresh(); }, [refresh]);

  const createAccount = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    setNotice('');
    setSetupLink(null);
    try {
      const result = await request('/api/metaapi/provisioned-accounts', token, {
        method: 'POST',
        body: form,
      });
      setForm((current) => ({ ...current, name: '', server: '' }));
      if (result.configurationLink) {
        setSetupLink({ accountId: result.account.metaApiAccountId, url: result.configurationLink });
      }
      await refresh();
      if (result.setupError?.message) {
        setError(result.setupError.message);
      } else if (result.configurationLink) {
        setNotice('Trading account setup is ready. Open the secure MetaAPI page to finish connecting it.');
      } else {
        setNotice('Your trading account was added. Create a secure setup link below to finish connecting it.');
      }
    } catch (requestError) {
      setError(requestError.message || 'We could not start trading account setup. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const createLink = async (account) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await request(`/api/metaapi/provisioned-accounts/${encodeURIComponent(account.metaApiAccountId)}/configuration-link`, token, { method: 'POST', body: {} });
      setSetupLink({ accountId: account.metaApiAccountId, url: result.configurationLink });
      setNotice('Your secure setup link is ready. It expires after seven days.');
    } catch (requestError) {
      setError(requestError.message || 'We could not create a secure setup link. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const refreshAccount = async (account) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await request(`/api/metaapi/provisioned-accounts/${encodeURIComponent(account.metaApiAccountId)}/refresh`, token, { method: 'POST', body: {} });
      await refresh();
      setNotice('Trading account status updated.');
    } catch (requestError) {
      setError(requestError.message || 'We could not refresh this trading account. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const removeAccount = async (account) => {
    const confirmation = account.managedByApp
      ? 'Remove this trading account? It will be permanently deleted from MetaAPI, which stops MetaAPI billing for it. Your broker account and any open positions are not affected.'
      : 'Remove this trading account from Signal Desk? It stays in MetaAPI under your own MetaAPI token, so it is not deleted there.';
    if (!window.confirm(confirmation)) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await request(`/api/metaapi/accounts/${encodeURIComponent(account.metaApiAccountId)}`, token, { method: 'DELETE' });
      if (setupLink?.accountId === account.metaApiAccountId) setSetupLink(null);
      await refresh();
      const cleanup = result?.metaApiCleanup;
      if (cleanup?.failed) {
        setError('The account was removed from Signal Desk, but MetaAPI could not confirm its deletion. It may still be billed; check your MetaAPI dashboard before trying again.');
      } else if (cleanup?.skipped) {
        setNotice('Trading account removed from Signal Desk. It was not deleted from MetaAPI because it is billed to your own MetaAPI token.');
      } else {
        setNotice('Trading account deleted from MetaAPI and removed from Signal Desk.');
      }
    } catch (requestError) {
      setError(requestError.message || 'We could not remove this trading account. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const provisionedAccounts = accounts.filter((account) => account.managedByApp);
  const warnings = idleWarnings({ accounts, inactivity });
  const sourceNote = telegramSourceNote({ view, channelCount });
  const previouslyLinkedAccounts = accounts.filter((account) => !account.managedByApp);

  return <div className="panel-grid">
    <section className="panel" aria-labelledby="metaapi-setup-title">
      <div className="panel-heading">
        <div><p className="eyebrow">TRADING ACCOUNT</p><h2 id="metaapi-setup-title">Add an MT4/MT5 account</h2></div>
        <MetaApiStatusPill />
      </div>
      <p className="muted">Enter the trading account name, platform, and broker server. You’ll enter your trading login and password on MetaAPI’s secure page—not in Signal Desk.</p>
      {setup.allowSetupForm ? <form className="form-stack" onSubmit={createAccount} aria-busy={busy}>
        <label htmlFor="metaapi-account-name">Account name
          <input id="metaapi-account-name" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="My MT5 account" maxLength={100} autoComplete="off" required />
        </label>
        <label htmlFor="metaapi-platform">Platform
          <select id="metaapi-platform" value={form.platform} onChange={(event) => setForm({ ...form, platform: event.target.value })} required>
            <option value="mt4">MetaTrader 4</option>
            <option value="mt5">MetaTrader 5</option>
          </select>
        </label>
        <label htmlFor="metaapi-server">Broker server
          <input id="metaapi-server" value={form.server} onChange={(event) => setForm({ ...form, server: event.target.value })} placeholder="Server name shown by your broker" maxLength={160} autoComplete="off" required />
        </label>
        <small className="field-help">Use the exact server name shown by your broker. For monitoring, choose an investor/read-only password on MetaAPI if your broker offers one.</small>
        <button className="button button-primary" type="submit" disabled={busy || loading || !form.name.trim() || !form.server.trim()}>{busy ? 'Preparing secure setup…' : 'Create secure setup link'}</button>
      </form> : setup.key === 'unavailable' ? <div className="empty-state compact-empty"><strong>Account setup is not available yet</strong><span>Please ask the workspace owner to finish setting up account connections.</span></div> : <div className="setup-pending" aria-busy={setup.key === 'checking'}>
        <span className="skeleton skeleton-block" aria-hidden="true" />
        <span className="skeleton skeleton-block short" aria-hidden="true" />
        <span>{setup.key === 'unreachable' ? 'Signal Desk could not confirm whether account setup is available right now.' : 'Checking whether account setup is available…'}</span>
        {setup.key === 'unreachable' ? <button type="button" className="text-button" onClick={() => { refreshSetup(); }}>Check again</button> : null}
      </div>}
      <p className="field-help account-idle-policy">
        Idle accounts are cleaned up automatically: if nobody signs in or trades for {inactivity?.deletionDays || 30} days, an account created here is deleted from MetaAPI so
        it stops being billed, with a warning here on day {inactivity?.warningDays || 25}. Accounts with an open position are left for you to close, and a paid plan is never
        swept. {inactivity?.exempt
          ? 'This workspace is exempt, so no account here is scheduled for deletion.'
          : 'Sign in, save execution settings, or execute a signal to reset the clock.'}
      </p>
      {sourceNote ? <div className={`alert alert-${sourceNote.tone} telegram-source-note`} role="status">
        <span>{sourceNote.text}</span>
        {sourceNote.action === 'choose' && onOpenTelegram ? <button type="button" className="text-button" onClick={onOpenTelegram}>Choose channels</button> : null}
        {sourceNote.action === 'connect' && onOpenTelegram && view.showConnectCallToAction ? <button type="button" className="text-button" onClick={onOpenTelegram}>Connect Telegram</button> : null}
      </div> : null}
      <div className="note-box">Adding an account does not place a trade by itself. Auto-Trading is ON by default for new workspaces; after you select a deployed account, new eligible Telegram signals may place orders. Turn it off in Risk Settings to stop new orders. MetaAPI usage limits or charges may apply when a trading account is connected.</div>
    </section>

    <section className="panel" aria-labelledby="metaapi-accounts-title">
      <div className="panel-heading">
        <div><p className="eyebrow">TRADING ACCOUNTS</p><h2 id="metaapi-accounts-title">Connected trading accounts</h2></div>
        <button type="button" className="button button-secondary button-small" disabled={busy || loading} onClick={refresh}>{loading ? 'Loading…' : 'Refresh'}</button>
      </div>
      {setupLink && <div className="secure-link-card" role="status">
        <strong>Finish setup on MetaAPI</strong>
        <p>The secure link is valid for seven days. Your broker password is entered on MetaAPI, not stored by Signal Desk.</p>
        <a className="button button-primary" href={setupLink.url} target="_blank" rel="noopener noreferrer">Open secure setup</a>
      </div>}
      {loading && !accounts.length ? <p className="muted" role="status">Loading your trading accounts…</p> : !accounts.length ? <div className="empty-state compact-empty"><strong>No trading accounts connected</strong><span>Add an MT4 or MT5 account to get started.</span></div> : <div className="chat-list">
        {provisionedAccounts.map((account) => <div className="chat-row account-row" key={account.id}>
          <div><strong>{account.name || 'Trading account'}</strong><small>{[account.platform?.toUpperCase(), account.server, account.login && `Login ${account.login}`, accountStateLabel(account.state)].filter(Boolean).join(' · ')}</small></div>
          <div className="account-actions">
            <button type="button" className="button button-secondary button-small" disabled={busy} onClick={() => refreshAccount(account)}>Refresh status</button>
            <button type="button" className="button button-small" disabled={busy} onClick={() => createLink(account)}>New setup link</button>
            <button type="button" className="icon-button" disabled={busy} onClick={() => removeAccount(account)}>Delete account</button>
          </div>
        </div>)}
        {previouslyLinkedAccounts.map((account) => <div className="chat-row account-row" key={account.id}>
          <div><strong>{account.name || account.login || 'Trading account'}</strong><small>{[account.platform?.toUpperCase(), account.login && `Login ${account.login}`, account.state && accountStateLabel(account.state), 'Previously connected'].filter(Boolean).join(' · ')}</small></div>
          <div className="account-actions"><button type="button" className="icon-button" disabled={busy} onClick={() => removeAccount(account)}>Unlink</button></div>
        </div>)}
      </div>}
      {warnings.length > 0 && <div className="idle-warning-card" role="alert" aria-live="assertive">
        <strong>{warnings.length === 1 ? 'An idle trading account is scheduled for deletion' : `${warnings.length} idle trading accounts are scheduled for deletion`}</strong>
        <ul>{warnings.map((warning) => <li key={warning.id}>{warning.text}</li>)}</ul>
        <p>Log in to Signal Desk or execute a trade to keep the account. Accounts that are removed cannot be recovered, and your broker account itself is not touched.</p>
      </div>}
      {(error || notice) && <div className={`alert ${error ? 'alert-error' : 'alert-success'}`} role={error ? 'alert' : 'status'} aria-live="polite">{error || notice}</div>}
      <p className="field-help account-retention-note">Removing an account you created here deletes it from MetaAPI as well, so provider billing for it stops. Your broker account, open positions, and orders already sent are not affected. Accounts you added with your own MetaAPI token are only unlinked.</p>
    </section>
  </div>;
}
