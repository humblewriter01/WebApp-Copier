import React from 'react';

const items = [
  ['overview', 'Overview', 'M3 10.5 12 3l9 7.5V21h-6v-6H9v6H3z'],
  ['telegram', 'Telegram', 'M21 4 3.8 10.7c-.8.3-.8 1.4.1 1.7l4.3 1.4 1.5 4.7c.2.7 1.1.9 1.6.3l2.5-3 4.3 3.2c.6.4 1.4.1 1.5-.6L22 5.1c.1-.8-.5-1.4-1-1.1ZM9 13.4 18 7l-6.7 8.2'],
  ['signals', 'Signals', 'M4 19V9m5 10V5m5 14v-7m5 7V8M2 21h20'],
  ['accounts', 'Accounts', 'M20 21a8 8 0 0 0-16 0m8-10a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z'],
  ['settings', 'Risk settings', 'M4 6h6m4 0h6M4 12h10m4 0h2M4 18h2m4 0h10M12 6a2 2 0 1 0 0 .01M16 12a2 2 0 1 0 0 .01M8 18a2 2 0 1 0 0 .01'],
  ['metaapi', 'MetaAPI', 'M7 12h.01M12 7h.01M17 12h.01M12 17h.01M7 12l5-5 5 5-5 5-5-5Z'],
];

function NavIcon({ path }) {
  return <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={path} /></svg>;
}

export default function Sidebar({ active, onNavigate, user, onSignOut, onClose, visible = true }) {
  return <aside id="workspace-sidebar" className="sidebar" aria-label="Workspace navigation" aria-hidden={!visible}>
    <div className="side-brand">
      <div className="brand-mark"><img src="/icons/signal-desk-icon-192.png" alt="" /></div>
      <div className="brand-copy"><strong>Signal Desk</strong><small>Telegram copier</small></div>
      <button type="button" className="sidebar-close" aria-label="Close navigation menu" onClick={onClose}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
      </button>
    </div>
    <nav className="sidebar-nav" aria-label="Main navigation">
      {items.map(([key, label, path]) => <button
        key={key}
        type="button"
        className={`nav-item ${active === key ? 'active' : ''}`}
        aria-current={active === key ? 'page' : undefined}
        onClick={() => onNavigate(key)}
      ><NavIcon path={path} /><span>{label}</span></button>)}
    </nav>
    <div className="sidebar-bottom">
      <div className="user-mini"><span className="avatar" aria-hidden="true">{(user?.name || 'U').slice(0, 1).toUpperCase()}</span><div><strong>{user?.name}</strong><small>{user?.email}</small></div></div>
      <button className="logout-button" type="button" onClick={onSignOut}>Sign out</button>
    </div>
  </aside>;
}
