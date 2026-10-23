/**
 * Every route in the app has to be reachable at the path the client calls it on.
 *
 * This exists because of one specific mistake: `DELETE /api/admin/announcements/history` was added after
 * `DELETE /api/admin/announcements/:id`, Express matched the earlier pattern, `history` became an `:id`,
 * the UUID guard refused it, and the administrator pressing "Clear history" was answered with
 * `Choose a valid announcement.` The code looked correct, the test that checked the route existed passed,
 * and the route was dead. Existence is not reachability, so this file reads the whole file the way the
 * router does - in order, first match wins - and fails on any static path an earlier pattern would swallow.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const index = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
const DECLARATION = /app\.(get|post|put|patch|delete|all)\(\s*(['"])(\/[^'"]*)\2/g;

/** Express matches segment by segment: `:name` is any run without a slash, `*` is a wildcard, the rest is literal. */
function matcherFor(pattern) {
  const literal = pattern
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/:[A-Za-z_][A-Za-z0-9_]*/g, '[^/]+')
    .replace(/\*/g, '[^]*');
  return new RegExp(`^${literal}/?$`);
}

export const ROUTES = [...index.matchAll(DECLARATION)].map((match) => ({ verb: match[1], path: match[3], at: match.index }));

/** The handler a request would actually reach: the first declaration whose pattern matches. */
export function firstMatch(verb, path) {
  return ROUTES.find((route) => (route.verb === verb || route.verb === 'all') && matcherFor(route.path).test(path)) || null;
}

test('the route parse sees the whole surface, so it cannot be quietly blind', () => {
  assert.ok(ROUTES.length > 60, `the file declares ${ROUTES.length} routes - a small number means the regex stopped matching`);
  assert.ok(ROUTES.some((route) => route.path === '/api/admin/announcements/:id' && route.verb === 'delete'), 'the retire route is in the list');
  assert.ok(ROUTES.some((route) => route.path === '/api/admin/announcements/history' && route.verb === 'delete'), 'and so is the history clear');
});

test('no static path is shadowed by a dynamic route declared before it', () => {
  const shadowed = [];
  ROUTES.forEach((route, index2) => {
    if (/[:*]/.test(route.path)) return;
    for (const earlier of ROUTES.slice(0, index2)) {
      if (earlier.path === route.path) continue;
      if (earlier.verb !== route.verb && earlier.verb !== 'all') continue;
      if (matcherFor(earlier.path).test(route.path)) {
        shadowed.push(`${route.verb.toUpperCase()} ${route.path} is swallowed by ${earlier.verb.toUpperCase()} ${earlier.path}`);
      }
    }
  });
  assert.deepEqual(shadowed, [], 'a route that can never be reached is a button that calls the wrong handler');
});

test('the banner history clear reaches the clear, not the retire-one route', () => {
  const reached = firstMatch('delete', '/api/admin/announcements/history');
  assert.equal(reached?.path, '/api/admin/announcements/history', 'and not the `:id` route that answers with "Choose a valid announcement."');
  const body = index.slice(reached.at, index.indexOf('\n}));', reached.at));
  assert.match(body, /buildRetiredAnnouncementClear\(\)/, 'the handler that runs is the one that deletes retired and finished banners');
  // A single banner must still resolve to the retire route - the guard is about order, not about excluding
  // the dynamic route from its own jobs.
  assert.equal(firstMatch('delete', '/api/admin/announcements/2ea79e0a-9929-4572-9e7a-c09f68b9c0dc')?.path, '/api/admin/announcements/:id');
  assert.equal(firstMatch('patch', '/api/admin/announcements/2ea79e0a-9929-4572-9e7a-c09f68b9c0dc')?.path, '/api/admin/announcements/:id');
});

test('the other two admin clears resolve to themselves', () => {
  for (const [verb, path, expected] of [
    ['delete', '/api/admin/health/errors', '/api/admin/health/errors'],
    ['delete', '/api/admin/audit-logs', '/api/admin/audit-logs'],
    ['get', '/api/admin/audit-logs', '/api/admin/audit-logs'],
    ['post', '/api/admin/signals/purge', '/api/admin/signals/purge'],
    ['get', '/api/admin/signals/purge-preview', '/api/admin/signals/purge-preview'],
    ['delete', '/api/admin/users/3f2f26a4-fc8c-4b69-9c44-2be36b65e1a7/signals', '/api/admin/users/:id/signals'],
  ]) {
    assert.equal(firstMatch(verb, path)?.path, expected, `${verb.toUpperCase()} ${path} is handled by ${expected}`);
  }
});
