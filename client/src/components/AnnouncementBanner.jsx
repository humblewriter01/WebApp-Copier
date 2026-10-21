import React, { useCallback, useEffect, useState } from 'react';
import { request } from '../lib/api.js';
import { announcementCopy } from '../lib/platform-view.js';

/**
 * The global announcement banner.
 *
 * The server decides who should see what (active, inside the window, not already dismissed by
 * this user), so this component only renders and reports a dismissal. While the answer is still
 * on its way it renders nothing at all: an empty slot is honest, a guessed one is not. The wording
 * and severity rules live in lib/platform-view.js so no other component can drift from them.
 */
export default function AnnouncementBanner({ token }) {
  // `null` means "we do not know yet"; an empty array means "there is nothing to show".
  const [items, setItems] = useState(null);
  const [busyId, setBusyId] = useState('');
  const [dismissError, setDismissError] = useState('');

  const load = useCallback(async () => {
    try {
      const data = await request('/api/announcements/active', token);
      setItems(Array.isArray(data?.announcements) ? data.announcements : []);
    } catch {
      // A banner is not a safety control: if it cannot be read, say nothing rather than
      // interrupting someone who is trying to trade.
      setItems([]);
    }
  }, [token]);

  useEffect(() => {
    if (!token) {
      setItems(null);
      return;
    }
    void load();
  }, [token, load]);

  const dismiss = async (id) => {
    setBusyId(id);
    setDismissError('');
    try {
      await request(`/api/announcements/${id}/dismiss`, token, { method: 'POST', body: {} });
      setItems((current) => (current || []).filter((item) => item.id !== id));
    } catch (error) {
      setDismissError(error.message || 'Could not dismiss that announcement.');
    } finally {
      setBusyId('');
    }
  };

  if (!items || !items.length) return null;

  return (
    <div className="announcement-stack">
      {items.map((item) => {
        const copy = announcementCopy(item);
        return (
          <section key={item.id} className={`announcement announcement-${copy.level}`} role={copy.role} aria-live={copy.live}>
            <span className="announcement-tag">{copy.tag}</span>
            <div className="announcement-body">
              <p className="announcement-message">{item.message}</p>
              {copy.window ? <span className="announcement-window">{copy.window}</span> : null}
              {dismissError && item.id === busyId ? <span className="announcement-error">{dismissError}</span> : null}
            </div>
            <button type="button" className="announcement-dismiss" onClick={() => dismiss(item.id)} disabled={busyId === item.id}>
              {busyId === item.id ? 'Dismissing…' : 'Dismiss'}
            </button>
          </section>
        );
      })}
    </div>
  );
}
