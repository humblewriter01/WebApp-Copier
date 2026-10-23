/**
 * Where a capture warning is allowed to appear.
 *
 * The instruction this file exists to keep is exact: a workspace owner must never be shown a
 * technical explanation about their host sleeping, because it is not their fault, not their fact to
 * act on, and on a free tier it would be permanently on screen. The same information belongs in the
 * admin panel's System Health section, where the reader is the person who can restart or upgrade the
 * service. So the rule is enforced on the source of every user-facing surface, with the admin panel as
 * the only exception, rather than on a review of screenshots.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(here, '..', 'src');
const ADMIN_PANEL = path.join('components', 'AdminPanel.jsx');

/** The sentences that describe host mechanics rather than what the user can see or do. */
const MECHANISM = /\bfree tier\b|\basleep\b|\bsleeps?\b|\bwake\b|waking|instance uptime|redeploy|\brestart/i;
/** The host's name, which belongs to the operator alone. */
const BRAND = /\bRender\b/;
const COMMENTS = /\/\*[\s\S]*?\*\/|\/\/[^\n]*/g;

function renderedText(source) {
  // Strings and JSX text, without the comments: the reasoning in a comment may name anything, the
  // sentence on somebody's screen may not.
  const stripped = source.replace(COMMENTS, ' ');
  const literals = [...stripped.matchAll(/'([^'\n]{12,})'|"([^"\n]{12,})"|`([^`\n]{12,})`/g)].map((match) => match[1] || match[2] || match[3]);
  const jsxText = [...stripped.matchAll(/>([^<>{}]{12,})</g)].map((match) => match[1]);
  return [...literals, ...jsxText].join('\n');
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}


test('no user-facing surface explains the host to the person using it', () => {
  const offenders = [];
  for (const file of walk(srcDir)) {
    if (!/\.jsx$/.test(file)) continue;
    const relative = path.relative(srcDir, file);
    if (relative === ADMIN_PANEL) continue;
    const text = renderedText(readFileSync(file, 'utf8'));
    if (MECHANISM.test(text) || BRAND.test(text)) offenders.push(relative);
  }
  assert.deepEqual(offenders, [], 'a sleep warning in a user dashboard is a fault of ours dressed up as theirs');
});

test('the admin panel is where the capture diagnostic lives, and it says the mechanism out loud', () => {
  const admin = renderedText(readFileSync(path.join(srcDir, ADMIN_PANEL), 'utf8'));
  assert.match(admin, BRAND, 'the administrator is told which host this is about');
  assert.match(admin, /free tier|asleep|sleeps/i);
  assert.match(admin, /messages seen|Messages seen/i, 'and the counter that distinguishes a quiet channel from a deaf listener');
  const source = readFileSync(path.join(srcDir, ADMIN_PANEL), 'utf8');
  assert.match(source, /health\.capture/, 'the numbers come from the server, never from a guess here');
  assert.match(source, /sleepSuspected/, 'and the derived flag is what turns the sentence on');
});
