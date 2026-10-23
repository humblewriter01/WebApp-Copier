/**
 * The three destructive "Clear history" buttons, and the administrator's tools as dialogs.
 *
 * Two things are pinned here because both were asked for after being got wrong. First: a button that
 * permanently deletes must not delete on click - so the endpoints live in one map, the only place that
 * calls them is the confirm handler, and that handler refuses to run without a confirmed key. Second: the
 * Suspend / Adjust plan / Impersonate forms used to be rendered inside the user table, where they were
 * either squashed into one cell or scrolled out of sight on a phone - so they must render through the
 * shared modal, over a backdrop, with Cancel and Confirm both reachable at 360px wide.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(here, '..', 'src');
const outfile = path.join(here, '.tmp', 'admin-action-modal.mjs');

const panel = readFileSync(path.join(srcDir, 'components', 'AdminPanel.jsx'), 'utf8');
const styles = readFileSync(path.join(srcDir, 'styles.css'), 'utf8');
const serverRoutes = readFileSync(path.join(here, '..', '..', 'server', 'index.js'), 'utf8');

await build({
  entryPoints: [path.join(srcDir, 'components', 'AdminActionModal.jsx')],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'node',
  external: ['react'],
  define: { 'process.env.NODE_ENV': '"development"' },
  logLevel: 'silent',
});
assert.ok(existsSync(outfile), 'the modal bundle was produced');
const { default: AdminActionModal } = await import(pathToFileURL(outfile).href);

/** The three buttons, keyed the way the panel keys them, with the route each one is allowed to call. */
const CLEAR_ENDPOINTS = {
  errors: '/api/admin/health/errors',
  audit: '/api/admin/audit-logs',
  banners: '/api/admin/announcements/history',
};

/** The JSX text and string literals of a source file - what a reader of the panel actually sees. */
function renderedText(source) {
  const stripped = source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, ' ');
  const literals = [...stripped.matchAll(/'([^'\n]{8,})'|\"([^\"\n]{8,})\"|`([^`\n]{8,})`/g)].map((match) => match[1] || match[2] || match[3]);
  const jsxText = [...stripped.matchAll(/>([^<>{}]{8,})</g)].map((match) => match[1]);
  return [...literals, ...jsxText].join('\n');
}

test('every clear button on the panel is guarded by the confirmation, and only by it', () => {
  for (const [key, endpoint] of Object.entries(CLEAR_ENDPOINTS)) {
    assert.match(panel, new RegExp(`setClearConfirm\\(\\{ key: '${key}' \\}\\)`), `the ${key} button opens the confirmation instead of deleting`);
    // Bound once, to the map: the audit path is also read by the list above the button, so what matters is
    // that nothing else can hand it to `request` as a delete.
    assert.equal(panel.split(`endpoint: '${endpoint}'`).length - 1, 1, `${key} is cleared by ${endpoint}, and that is the only thing that clears it`);
  }
  // One handler, and it cannot run on its own: the statement it executes comes from the confirmed state.
  assert.match(panel, /const entry = clearConfirm \? CLEAR_HISTORY\[clearConfirm\.key\] : null;\n\s*if \(!entry \|\| clearing\) return;/);
  assert.match(panel, /await request\(entry\.endpoint, token, \{ method: 'DELETE', retryWhenUnanswered: true \}\)/);
  assert.match(panel, /<ConfirmModal[\s\S]*?open=\{Boolean\(clearConfirm\)\}[\s\S]*?busy=\{clearing\}/);
  // While the delete is in flight the dialog is busy, which is what holds both of its buttons. The option
  // is the tell: the signal deletes that share the panel do not retry after a cold start, these do.
  assert.equal((panel.match(/method: 'DELETE', retryWhenUnanswered: true/g) || []).length, 1, 'the panel has exactly one way to ask for a clear');
});

test('the confirmation says permanently, in the words the panel already uses for that list', () => {
  const from = panel.indexOf('const CLEAR_HISTORY');
  const copy = renderedText(panel.slice(from, panel.indexOf('function formatDate')));
  assert.match(copy, /permanently delete all Telegram parsing errors\? This cannot be undone\./);
  assert.match(copy, /permanently delete all audit entries\? This cannot be undone\./);
  assert.match(copy, /permanently delete the retired banners\? This cannot be undone\./);
  // What survives matters as much as what goes, so each body says it: the captured messages stay, the log
  // records its own clearing, and a banner somebody can still see is out of scope.
  assert.match(copy, /message itself stays/i);
  assert.match(copy, /clear is written as the only entry that remains/i);
  assert.match(copy, /Live and upcoming banners are kept\./);
});

test('the endpoints the confirmation calls are the routes the server mounted', () => {
  for (const [key, endpoint] of Object.entries(CLEAR_ENDPOINTS)) {
    // A rename on either side has to break a test here: this panel has 404-quietly on exactly that before.
    assert.ok(serverRoutes.includes(`app.delete('${endpoint}', authenticate, requireAdmin`), `the server mounts DELETE ${endpoint} behind admin access`);
    const declared = new RegExp(`${key}: \\{\\s*endpoint: '([^']+)'`).exec(panel)?.[1];
    assert.equal(declared, endpoint, `and the panel's ${key} entry points at it, not at a copy of an old path`);
  }
});

test('each clear is declared before any sibling :param route that could swallow it', () => {
  // The history clear shipped *after* `app.delete('/api/admin/announcements/:id')`, Express matched the
  // earlier pattern, `history` became an id, and the button was answered with `Choose a valid announcement.`
  // - a sentence about a banner nobody was touching, from the endpoint that retires one. Checking that a
  // route exists is not checking that it runs, so order is what is asserted here, against the sibling that
  // can steal it rather than against a copy of Express's matcher.
  const deletes = [...serverRoutes.matchAll(/app\.delete\('(\/[^']+)'/g)].map((match) => ({ path: match[1], at: match.index }));
  for (const endpoint of Object.values(CLEAR_ENDPOINTS)) {
    const mine = deletes.find((route) => route.path === endpoint);
    assert.ok(mine, `${endpoint} is mounted as a DELETE`);
    const parent = endpoint.slice(0, endpoint.lastIndexOf('/'));
    const rivals = deletes.filter((route) => route.path !== endpoint
      && route.path.startsWith(`${parent}/:`)
      && route.path.split('/').length === endpoint.split('/').length);
    for (const rival of rivals) {
      assert.ok(mine.at < rival.at, `${endpoint} has to be declared before ${rival.path}, or the last segment is read as its :param`);
    }
  }
  const sibling = deletes.find((route) => route.path === '/api/admin/announcements/:id');
  assert.ok(sibling, 'the retire route is still there, so the ordering check above had something to order against');
});

test('the notice after a clear is the server answer, and the list is read again', () => {
  const handler = panel.slice(panel.indexOf('const runClearHistory'), panel.indexOf('const changePage'));
  assert.match(handler, /setNotice\(data\?\.notice \|\| 'History cleared\.'\)/, 'the count of deleted rows comes from the response');
  assert.ok(handler.indexOf('setNotice(') < handler.indexOf('await loadHealth(healthHours)'), 'the notice is set before the reload, so it survives it');
  assert.match(handler, /await loadHealth\(healthHours\)/, 'the errors list is read again, not optimistically emptied');
  assert.match(handler, /await loadAudit\(\{ action: auditAction, search: auditSearch, offset: 0 \}\)/, 'and a filtered audit view goes back to its first page, which is where an empty log starts');
  assert.match(handler, /await loadAnnouncements\(\)/);
  assert.match(handler, /setClearConfirm\(null\);/, 'the dialog is closed by the request, not by the button');
  assert.match(handler, /setError\(clearError\.message \|\| 'That history could not be cleared\.'\)/, 'a refusal is shown in the admin panel, where the button is');
});

test('the capture card kept its numbers and lost the paragraph about the host', () => {
  assert.equal(panel.includes('health-capture-sleep'), false, 'the beige explanation is not rendered any more');
  assert.equal(styles.includes('.health-capture-sleep'), false, 'and its rule is not left behind to be found by the next reader');
  assert.match(panel, /Messages seen/, 'the counters it pointed at are still there');
  assert.match(panel, /Sessions held/);
});

test('Suspend, Impersonate and Adjust plan open as dialogs, not as rows of the table', () => {
  assert.equal((panel.match(/<AdminActionModal/g) || []).length, 3, 'three tools, three modals');
  assert.equal((panel.match(/<\/AdminActionModal>/g) || []).length, 3);
  for (const open of [
    'open={Boolean(suspension.userId)}',
    'open={Boolean(supportFor.userId)}',
    'open={Boolean(adjustFor)}',
  ]) {
    assert.ok(panel.includes(open), `${open} ties a dialog to the state its row button sets`);
  }
  // The geometry that made them unusable: a form inside a table cell, and a strip under the table that
  // scrolled away before the button could be reached.
  assert.equal(/admin-tools-row|colSpan=\{7\}/.test(panel), false, 'nothing is rendered inside a table row any more');
  assert.equal(
    ['.admin-tools-row', '.admin-support-form', '.admin-adjust-form', '.admin-suspend'].some((selector) => styles.includes(selector)),
    false,
    'and the styles for those layouts are gone with them',
  );
});

test('the dialogs are centred over a darkened backdrop, and hold their buttons while working', () => {
  const markup = renderToStaticMarkup(React.createElement(AdminActionModal, {
    open: true,
    title: 'Suspend Trader One',
    intro: 'They cannot sign in while the suspension stands.',
    confirmLabel: 'Suspend user',
    tone: 'danger',
    children: React.createElement('label', null, 'Reason shown to the user', React.createElement('input', { defaultValue: 'chargeback' })),
  }));
  assert.match(markup, /class="modal-backdrop"/, 'the panel behind it is scrimmed, not merely displaced');
  assert.match(markup, /role="dialog"/);
  assert.match(markup, /aria-modal="true"/);
  // The title has to be the dialog's accessible name, whichever id scheme this React version hands out.
  const labelledBy = /aria-labelledby="([^"]+)"/.exec(markup)?.[1];
  assert.ok(labelledBy, 'the dialog is labelled by something');
  assert.ok(markup.includes(`id="${labelledBy}"`), 'and that something is its own heading');
  assert.match(markup, /Suspend Trader One/);
  assert.match(markup, /They cannot sign in while the suspension stands\./);
  assert.match(markup, /Reason shown to the user/);
  assert.match(markup, /type="submit"[^>]*class="button button-danger"/, 'the confirm button submits, which is what makes Enter work');
  assert.match(markup, /<button type="button" class="button button-secondary">Cancel</, 'Cancel is a button, never a submit');

  const busy = renderToStaticMarkup(React.createElement(AdminActionModal, {
    open: true, title: 'Suspend Trader One', busy: true, confirmLabel: 'Suspend user',
  }));
  assert.equal((busy.match(/disabled=""/g) || []).length, 2, 'both buttons are held while the request is in flight');
  assert.match(busy, /Working…/);
  assert.equal(busy.includes('Suspend user'), false, 'and the label says what is happening instead of repeating the click');

  assert.equal(renderToStaticMarkup(React.createElement(AdminActionModal, { title: 'Nothing' })), '', 'a closed tool is not in the document at all, so its fields cannot be tabbed into');
});

test('the modal is a form, so Escape and the backdrop cancel and Enter confirms', () => {
  const source = readFileSync(path.join(srcDir, 'components', 'AdminActionModal.jsx'), 'utf8');
  assert.match(source, /className="panel modal admin-action-modal"/, 'it borrows the panel and modal styling rather than inventing a third look');
  assert.match(source, /onSubmit=\{\(event\) => \{ event\.preventDefault\(\); void onSubmit\?\.\(\); \}\}/);
  assert.match(source, /event\.key === 'Escape' && !busy/);
  assert.match(source, /event\.target === event\.currentTarget && !busy/, 'a click outside closes it, but not while the write is running');
  assert.match(source, /querySelector\?\.\('input,select,textarea'\)/, 'focus lands on the first field, so typing starts without another click');
});

test('at 360px the dialog is the screen, and its buttons are thumb-sized', () => {
  const modalRule = /\.admin-action-modal\{[^}]*\}/.exec(styles)?.[0] || '';
  assert.match(modalRule, /max-width:min\(620px,100%\)/, 'it takes the full width a phone has, and no more of a desktop');
  assert.match(modalRule, /max-height:calc\(100vh - 40px\)/);
  assert.match(modalRule, /overflow-y:auto/, 'a tall form scrolls inside the dialog instead of pushing its buttons off the page');
  assert.match(styles, /\.modal-backdrop\{position:fixed;inset:0[^}]*place-items:center/, 'centred, not anchored to a corner');
  assert.match(styles, /\.modal-backdrop\{[^}]*background:rgba\(16,26,38,\.5\)/, 'with the dark scrim the request asked for');
  const mobile = /\.admin-action-modal \.modal-actions \.button\{[^}]*\}/.exec(styles)?.[0] || '';
  assert.match(mobile, /width:100%/, 'Cancel and Confirm stack full width on a phone');
  assert.match(styles, /\.panel-heading-actions\{[^}]*flex-wrap:wrap/, 'a heading with a Clear button in it wraps instead of overflowing');
});

test('the three headings carry their clear button, and only when there is something to clear', () => {
  const health = panel.slice(panel.indexOf('LATEST SYSTEM ERRORS'), panel.indexOf('health-capture'));
  assert.match(health, /panel-heading-actions/);
  assert.match(health, /Clear parsing errors/, 'the button says what it deletes, because the list beside it also holds MetaAPI rows');
  assert.match(health, /disabled=\{clearing \|\| !health \|\| health\.errorsAvailable === false\}/, 'and it waits for a list that could actually be read');
  const auditStart = panel.indexOf('WHO DID WHAT');
  const audit = panel.slice(auditStart, panel.indexOf('admin-search', auditStart));
  assert.match(audit, />Clear history</);
  assert.match(audit, /disabled=\{clearing \|\| !audit\.totalEntries\}/, 'an audit log with no entries does not offer to delete them');
  const bannerStart = panel.indexOf('Banner history');
  const banners = panel.slice(bannerStart, panel.indexOf('announcement-row', bannerStart));
  assert.match(banners, />Clear history</);
  assert.match(banners, /disabled=\{clearing\}/, 'the list is paged, so only the in-flight state is known to be authoritative here');
});

test('the audit panel no longer promises that entries can never be deleted', () => {
  const from = panel.indexOf('WHO DID WHAT');
  const copy = renderedText(panel.slice(from, panel.indexOf('admin-search', from)));
  assert.equal(/entries are never edited or deleted/i.test(copy), false, 'that sentence is now one the panel breaks on purpose, in the open');
  assert.match(copy, /only way one leaves the table is the Clear history button/i);
});
