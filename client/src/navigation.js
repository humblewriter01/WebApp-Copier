/**
 * The workspace pages, in the order the sidebar shows them.
 *
 * Three of these used to be one page called "Risk settings": the risk numbers, the execution and safety
 * rules, and the button that deletes the account. They are separate now because they are separate
 * decisions - how much to risk, what may be sent, and whether this workspace goes on existing - and only
 * the last two are worth a confirmation. `key` is what `App.jsx` switches on and what the URL path is
 * derived from, so a new page here is a new deep link there.
 */
export const navigationItems = [
  { key: 'overview', label: 'Overview', iconPath: 'M3 10.5 12 3l9 7.5V21h-6v-6H9v6H3z' },
  { key: 'telegram', label: 'Telegram', iconPath: 'M21 4 3.8 10.7c-.8.3-.8 1.4.1 1.7l4.3 1.4 1.5 4.7c.2.7 1.1.9 1.6.3l2.5-3 4.3 3.2c.6.4 1.4.1 1.5-.6L22 5.1c.1-.8-.5-1.4-1-1.1ZM9 13.4 18 7l-6.7 8.2' },
  { key: 'signals', label: 'Signals', iconPath: 'M4 19V9m5 10V5m5 14v-7m5 7V8M2 21h20' },
  { key: 'accounts', label: 'Account Notes', iconPath: 'M20.6 13.4 12 22l-9-9V4h9l8.6 8.6a1.4 1.4 0 0 1 0 2ZM7.5 8.5h.01' },
  { key: 'settings', label: 'Risk Settings', iconPath: 'M4 6h6m4 0h6M4 12h10m4 0h2M4 18h2m4 0h10M12 6a2 2 0 1 0 0 .01M16 12a2 2 0 1 0 0 .01M8 18a2 2 0 1 0 0 .01' },
  { key: 'advanced', label: 'Advanced Settings', iconPath: 'M13 2 4 14h6l-1 8 9-12h-6l1-8Z' },
  { key: 'metaapi', label: 'Trading Accounts', iconPath: 'M7 12h.01M12 7h.01M17 12h.01M12 17h.01M7 12l5-5 5 5-5 5-5-5Z' },
  { key: 'billing', label: 'Billing', iconPath: 'M3 7h18M3 11h18M5 5h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Zm2 10h4' },
  { key: 'profile', label: 'Profile', iconPath: 'M20 21a8 8 0 0 0-16 0m8-10a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z' },
  { key: 'admin', label: 'Admin Panel', iconPath: 'M12 3l8 4v6c0 4.2-3.4 7.2-8 8-4.6-.8-8-3.8-8-8V7l8-4Zm0 6v5m0 3h.01', adminOnly: true },
];

/** Navigation items a signed-in user is allowed to see for their role. */
export function navigationItemsForRole(role) {
  const isAdmin = String(role || '').toLowerCase() === 'admin';
  return navigationItems.filter((item) => !item.adminOnly || isAdmin);
}
