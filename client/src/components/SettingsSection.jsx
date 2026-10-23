import React from 'react';

/**
 * One folded bar of the settings page: a light header with the section's own state on the right, and the
 * controls underneath it.
 *
 * The fold is a `<details>` element rather than a click handler, so a section is readable with no
 * JavaScript at all, keyboard-operable, and reported to a screen reader as an expanded or collapsed
 * group by the browser instead of by an `aria-expanded` somebody has to remember to keep in sync. The
 * open state is still held in React so the page can decide what a reader sees first.
 *
 * Only a summary line goes in the header. Everything that needs a paragraph to be honest stays in the
 * body, where it is read by the person who is about to change the value rather than by everyone scanning
 * for it.
 */
export default function SettingsSection({ id, title, subtitle, state = null, tone = 'neutral', defaultOpen = false, children }) {
  const [open, setOpen] = React.useState(defaultOpen === true);
  return (
    <details
      className={`settings-section settings-section-${id}${open ? ' is-open' : ''}`}
      id={id}
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="settings-section-bar">
        <span className="settings-section-chevron" aria-hidden="true">
          <svg viewBox="0 0 16 16" width="14" height="14" focusable="false">
            <path d="M6 3.5 10.5 8 6 12.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
        <span className="settings-section-heading">
          <h3>{title}</h3>
          {subtitle ? <p>{subtitle}</p> : null}
        </span>
        {state ? <span className={`badge settings-section-state settings-section-state-${tone}`}>{state}</span> : null}
      </summary>
      <div className="settings-section-body">{children}</div>
    </details>
  );
}
