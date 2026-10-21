import React from 'react';
import { useTelegramStatus, WAITING_FOR_MESSAGES_MESSAGE } from './TelegramStatus.jsx';

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
      ? { tone: 'online', title: 'Waiting for signals', message: WAITING_FOR_MESSAGES_MESSAGE, action: null }
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

export default function SignalTable({ signals, channelCount = 0, onOpenTelegram }) {
  const { view } = useTelegramStatus();
  if (!signals?.length) return <SignalEmpty channelCount={channelCount} onOpenTelegram={onOpenTelegram} view={view} />;
  return <div className="signal-list">{signals.map((signal) => <article className="signal-item" key={signal.id}>
    <div className="signal-top"><div><strong>{signal.symbol || 'Signal message'}</strong><span className="signal-source">{signal.channelTitle || 'Telegram chat'}</span></div><span className={`badge ${signal.side === 'buy' ? 'badge-buy' : signal.side === 'sell' ? 'badge-sell' : ''}`}>{signal.side || 'received'}</span></div>
    <p className="signal-message">{signal.message}</p>
    <div className="signal-meta">{signal.entryPrice != null && <span>Entry {signal.entryPrice}</span>}{signal.stopLoss != null && <span>SL {signal.stopLoss}</span>}{signal.takeProfit != null && <span>TP {signal.takeProfit}</span>}<time>{signal.createdAt ? new Date(signal.createdAt).toLocaleString() : ''}</time></div>
  </article>)}</div>;
}
