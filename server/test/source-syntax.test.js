/**
 * Every server source file is parsed before this suite is allowed to pass.
 *
 * Why a test exists for something a syntax error makes obvious: `db.js` is imported by `index.js` and by
 * nothing else - the rest of this directory reads it as *text* to check query placeholders - so a file that
 * cannot parse has no test that notices. The one that shipped had a backtick inside a block comment that
 * itself sat inside the template literal holding the entire schema, which ended that string mid-file: the
 * suite was green, and the service died at boot with `SyntaxError: missing ) after argument list` on every
 * restart, taking the schema migration - and the app - with it.
 *
 * Two checks, because two failure shapes exist. `node --check` catches the parse itself. Importing the
 * module catches the quieter one: a template literal that still parses but interpolates something
 * `${undefined}`, which only blows up when the file is actually loaded. Both are cheap, deterministic, and
 * need no database - `db.js` builds its pool lazily and connects only on the first query.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function sources(dir, found = []) {
  for (const entry of readdirSync(path.join(serverRoot, dir)).sort()) {
    if (entry === 'node_modules' || entry === '.tmp') continue;
    const relative = dir ? `${dir}/${entry}` : entry;
    if (statSync(path.join(serverRoot, relative)).isDirectory()) sources(relative, found);
    else if (entry.endsWith('.js')) found.push(relative);
  }
  return found;
}

const files = sources('');

test('every server source file parses, including the ones no test imports', () => {
  assert.ok(files.includes('db.js') && files.includes('index.js'), 'the sweep covers the entry points, not just services');
  const broken = [];
  for (const file of files) {
    const result = spawnSync(process.execPath, ['--check', path.join(serverRoot, file)], { encoding: 'utf8' });
    if (result.status !== 0) {
      broken.push(`${file}: ${String(result.stderr || '').split('\n').filter(Boolean).slice(0, 3).join(' | ')}`);
    }
  }
  assert.deepEqual(broken, [], `${broken.length} file(s) do not parse:\n${broken.join('\n')}`);
});

test('db.js loads, so a broken schema string is caught before a deploy is', async () => {
  // Importing is what the service does first, and it is the only check that separates "the file parses"
  // from "the file parses and the schema it hands to Postgres is still one string". A template that
  // interpolates something undefined, or a comment that quietly closed the literal, fails here - and a
  // pool is built lazily, so no database is needed to find that out.
  const db = await import('../db.js');
  assert.equal(typeof db.initializeDatabase, 'function');
  assert.equal(typeof db.pool?.query, 'function', 'the pool is built but never connected by an import');
});
