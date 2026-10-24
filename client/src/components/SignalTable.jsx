import React from 'react';
import { LISTENER_NOT_ATTACHED_MESSAGE, useTelegramStatus, WAITING_FOR_MESSAGES_MESSAGE } from './TelegramStatus.jsx';
import { signalBadges, signalOutcomeView } from '../lib/signal-outcome.js';
import { DASHBOARD_SIGNAL_LIMIT, summarizeSignalMessage } from '../lib/signal-summary.js';

/**
 * What the signal list says when it is empty — decided entirely by the confirmed Telegram
 * state, never by an assumption. "Connect Telegram" may only appear when the backend has
 * said the account is disconnected; while the answer is still unknown the list shows a
 * skeleton, and when the user is connected it says what is actually happening instead of
 * sending them to sign in again.
 */
export function signalEmptyState({ view, channelCount = 0 } = {}) {
  const key = view?.key || 'checking';
  if (key === 'checking') {
    return { tone: 'pending', title: 'Checking your sources', message: 'Loading your captured signals…', action: null, skeleton: true };
  }
  if (key === 'unreachable') {
    return { tone: 'pending', title: 'Signal status unavailable', message: 'Signal Desk could not confirm your Telegram connection just now. Signals already captured stay saved.', action: 'retry', skeleton: true };
  }
  if (key === 'unavailable') {
    return { tone: 'pending', title: 'Telegram is temporarily unavailable', message: view.detail || 'Telegram sign-in is temporarily unavailable. Please try again later.', action: null };
  }
  if (key === 'connected') {
    return Number(channelCount) > 0
      ? {
        tone: 'online',
        title: view?.listening === false ? 'Signed in, not yet reading' : 'Waiting for signals',
        message: view?.listening === false ? LISTENER_NOT_ATTACHED_MESSAGE : WAITING_FOR_MESSAGES_MESSAGE,
        action: null,
      }
      : { tone: 'online', title: 'Telegram is connected', message: 'Choose the groups and channels to monitor, and new signals will appear here automatically.', action: 'choose' };
  }
  return { tone: 'offline', title: 'No signals yet', message: 'Connect Telegram to collect messages from your selected chats, or add a signal note.', action: 'connect' };
}

function SignalEmpty({ channelCount, onOpenTelegram, view }) {
  const { refresh } = useTelegramStatus();
  const empty = signalEmptyState({ view, channelCount });
  return <div className={`empty-state signal-empty tone-${empty.tone}`}>
    {empty.skeleton
      ? <span className="skeleton skeleton-block" aria-hidden="true"><i /><i /><i /></span>
      : <span className="empty-icon" aria-hidden="true">{empty.tone === 'online' ? '⌁' : '↗'}</span>}
    <strong>{empty.title}</strong>
    <span>{empty.message}</span>
    {empty.action === 'connect' && onOpenTelegram && view.showConnectCallToAction
      ? <button className="button button-secondary" type="button" onClick={onOpenTelegram}>Connect Telegram</button>
      : null}
    {empty.action === 'choose' && onOpenTelegram
      ? <button className="button button-secondary" type="button" onClick={onOpenTelegram}>Choose channels to monitor</button>
      : null}
    {empty.action === 'retry'
      ? <button className="button button-secondary" type="button" onClick={() => refresh()}>Check again</button>
      : null}
  </div>;
}

/**
 * Every captured message is shown with what became of it. A free workspace, or one with no trading
 * account connected, is exactly the case where silence reads as failure: the signal is there, and
 * the reason it was not traded has to be as visible as the signal itself.
 */
export default function SignalTable({ signals, channelCount = 0, onOpenTelegram, onUpgrade, onDeleteSignal, deletingId = null, compact = false }) {
  const { view } = useTelegramStatus();
  if (!signals?.length) return <SignalEmpty channelCount={channelCount} onOpenTelegram={onOpenTelegram} view={view} />;
  /* The Overview is a glance, so it shows a bounded list with a bounded amount of text per row, and the
     `View all` beside its heading is what carries the reader to the rest. The Signals page passes no `compact`
     and still shows everything, in full, because that is where a captured message is actually read. */
  const shown = compact ? signals.slice(0, DASHBOARD_SIGNAL_LIMIT) : signals;
  return <div className="signal-list">{shown.map((signal) => {
    const outcome = signalOutcomeView(signal);
    const badges = signalBadges(signal);
    const summary = compact ? summarizeSignalMessage(signal.message) : null;
    return <article className={`signal-item outcome-${outcome.tone}${compact ? ' signal-item-compact' : ''}`} key={signal.id}>
    <div className="signal-top"><div><strong>{signal.symbol || 'Signal message'}</strong><span className="signal-source">{signal.channelTitle || 'Telegram chat'}</span></div><div className="signal-flags"><span className={`badge ${signal.side === 'buy' ? 'badge-buy' : signal.side === 'sell' ? 'badge-sell' : ''}`}>{signal.side || 'received'}</span><span className={`badge signal-outcome tone-${outcome.tone}`}>{outcome.label}</span>{badges.map((badge) => <span key={badge.key} className={`badge signal-flag-badge tone-${badge.tone}`} title={badge.title}>{badge.label}</span>)}</div>
      {onDeleteSignal ? <button className="signal-delete-button" type="button" title="Remove this signal from your history" aria-label={`Remove ${signal.symbol || 'this signal'} from your history`} disabled={deletingId === signal.id} onClick={() => onDeleteSignal(signal)}>{deletingId === signal.id ? '…' : '✕'}</button> : null}</div>
    <p className="signal-message"{...(summary?.truncated ? { title: signal.message } : {})}>{summary ? summary.text : signal.message}</p>
    <div className="signal-meta">{signal.entryPrice != null && <span>Entry {signal.entryPrice}</span>}{signal.stopLoss != null && <span>SL {signal.stopLoss}</span>}{signal.takeProfit != null && <span>TP {signal.takeProfit}</span>}{signal.stopLossPips != null && <span>SL {signal.stopLossPips} pips</span>}{signal.takeProfitPips != null && <span>TP {signal.takeProfitPips} pips</span>}<time>{signal.createdAt ? new Date(signal.createdAt).toLocaleString() : ''}</time></div>
    {outcome.showNote ? <p className="signal-outcome-note"><span>{outcome.note}</span>{outcome.upgradeRequired && onUpgrade ? <button className="text-button" type="button" onClick={onUpgrade}>See plans</button> : null}</p> : null}
  </article>;
})}</div>;
}
