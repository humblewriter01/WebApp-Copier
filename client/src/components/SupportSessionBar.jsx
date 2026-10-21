import React from 'react';
import { supportSessionRemaining } from '../lib/support-session.js';
import { supportBannerCopy } from '../lib/platform-view.js';

/**
 * The bar that says out loud that this is somebody else's workspace.
 *
 * A support session looks exactly like the customer's dashboard, which is the point and also the
 * hazard: the same numbers, the same accounts. So the reminder is rendered above everything,
 * names whose account is being viewed, states that nothing here can be changed, and offers the way
 * out.
 */
export default function SupportSessionBar({ session, onExit, now = () => Date.now() }) {
  if (!session?.token) return null;
  const copy = supportBannerCopy(session, supportSessionRemaining(session, now()));
  if (!copy) return null;
  return (
    <div className="support-banner" role="status" aria-live="polite">
      <strong>Support access</strong>
      <span>
        You are viewing Signal Desk as <b>{copy.identity}</b>. {copy.readOnlyLine}{copy.expiryLine ? ` ${copy.expiryLine}` : ''}
      </span>
      <button type="button" className="button button-secondary button-small" onClick={onExit}>Exit support view</button>
    </div>
  );
}
