import React from 'react';
import { navigationItemsForRole } from '../navigation.js';

function NavIcon({ path }) {
  return <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={path} /></svg>;
}

export default function Sidebar({ active, onNavigate, user, onSignOut, onClose, visible = true }) {
  const items = navigationItemsForRole(user?.role);
  return <aside id="workspace-sidebar" className="sidebar" aria-label="Workspace navigation" aria-hidden={!visible}>
    <div className="side-brand">
      <div className="brand-mark"><img src="/icons/signal-desk-icon-192.png" alt="" /></div>
      <div className="brand-copy"><strong>Signal Desk</strong><small>Telegram copier</small></div>
      <button type="button" className="sidebar-close" aria-label="Close navigation menu" onClick={onClose}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
      </button>
    </div>
    <nav className="sidebar-nav" aria-label="Main navigation">
      {items.map(({ key, label, iconPath }) => <button
        key={key}
        type="button"
        className={`nav-item ${active === key ? 'active' : ''}`}
        aria-current={active === key ? 'page' : undefined}
        onClick={() => onNavigate(key)}
      ><NavIcon path={iconPath} /><span>{label}</span></button>)}
    </nav>
    <div className="sidebar-bottom">
      <div className="user-mini"><span className="avatar" aria-hidden="true">{(user?.name || 'U').slice(0, 1).toUpperCase()}</span><div><strong>{user?.name}</strong><small>{user?.email}</small></div></div>
      <button className="logout-button" type="button" onClick={onSignOut}>Sign out</button>
    </div>
  </aside>;
}
