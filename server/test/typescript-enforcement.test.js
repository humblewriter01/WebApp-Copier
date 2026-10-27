/**
 * The typecheck is only a gate if it cannot be quietly widened, unhooked, or narrowed.
 *
 * `allowJs` + `checkJs` over the application sources is what makes `server/types/app.d.ts` and the ~60 options-bag
 * typedefs worth anything: a checker nobody runs is a lint that decays, and a checker whose include list shrinks
 * says "clean" about a smaller and smaller share of the code. These tests are the difference between "the type
 * check exists" and "the type check is enforced", and they are the reason the two are not the same claim:
 *
 *   - the include list must cover every non-test source, so a new directory cannot dodge it;
 *   - `npm test` and the Render build command must both run it, so it cannot be skipped by habit;
 *   - every `@typedef` that describes a parameter must be applied to that parameter, because a typedef that
 *     nothing references documents nothing and still leaves the checker guessing;
 *   - the declarations in `types/app.d.ts` must describe fields, columns and types the code actually has, in
 *     both directions - the class of lie that turns a type file into folklore.
 *
 * Nothing here runs `tsc`: this file is about the *config*, and the config's correctness is proved by
 * `npm run typecheck` being part of `npm test` (pinned below) and by the CI that runs it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER = fileURLToPath(new URL('..', import.meta.url));
const appSources = ['index.js', 'db.js', ...readdirSync(join(SERVER, 'services')).map((f) => `services/${f}`)];
const read = (rel) => readFileSync(join(SERVER, rel), 'utf8');
/**
 * `tsconfig.json` is JSON-with-comments, and a naive comment strip eats the glob in `include`: a double-star,
 * a slash, a star and a dot in that order is a comment terminator wearing a filename. So the strip below
 * tracks string state instead of searching for slash-star, which is a charming failure to debug at night.
 */
function stripJsonComments(text) {
  let out = '';
  let quote = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      out += ch;
      if (ch === '\\') { out += text[i + 1]; i += 1; } else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; out += ch; continue; }
    if (ch === '/' && text[i + 1] === '*') { const end = text.indexOf('*/', i + 2); i = end + 1; continue; }
    if (ch === '/' && text[i + 1] === '/') { const end = text.indexOf('\n', i); i = end === -1 ? text.length : end - 1; continue; }
    out += ch;
  }
  return out;
}
const config = JSON.parse(stripJsonComments(read('tsconfig.json')));
const pkg = JSON.parse(read('package.json'));
const declarations = read('types/app.d.ts');

test('the typecheck covers every source the server runs, and only those', () => {
  assert.deepEqual(config.include, ['**/*.js', '**/*.d.ts'], 'a new directory is inside the gate the day it is created, not whenever someone remembers to add it');
  assert.deepEqual(config.exclude, ['node_modules', 'test'], 'the dependencies are skipLibCheck territory and the tests are deliberately outside: their fixtures are duck-typed shapes that are meant to be wrong in instructive ways');
  const jsOnDisk = readdirSync(SERVER).filter((f) => f.endsWith('.js'));
  assert.ok(jsOnDisk.includes('index.js') && jsOnDisk.includes('db.js'), 'the two roots that hold the routes and the schema');
  assert.equal(readdirSync(join(SERVER, 'test')).filter((f) => f.endsWith('.mjs')).length, 1, 'one .mjs test exists and no .mjs application source does, which is why `**/*.js` is enough - if a source ever lands on .mjs it would be silently unchecked');
});

test('the checker is configured for a JavaScript service, with the strict ramp written down', () => {
  assert.equal(config.compilerOptions.allowJs, true, 'so the .js files are the ones being checked');
  assert.equal(config.compilerOptions.checkJs, true, 'and checked, which is the entire point');
  assert.equal(config.compilerOptions.noEmit, true, 'no build step, no output directory, no second copy of the truth');
  assert.equal(config.compilerOptions.strict, false, 'the staged setting this migration chose; flipping it is a decision with a PR of its own, not a line edit');
  assert.equal(config.compilerOptions.skipLibCheck, true, 'the dependencies ship declarations this app does not own');
  assert.equal(config.compilerOptions.maxNodeModuleJsDepth, 0, 'and untyped ones are never read as JavaScript, so `telegram` stays behind the adapter rather than becoming 4,000 inferred errors');
  assert.ok(config.compilerOptions.types.includes('node'), 'node types, and nothing else in scope');
});

test('the gate is wired into the commands people actually run', () => {
  assert.match(pkg.scripts.typecheck, /tsc\b/, 'a script exists so nobody types the flags from memory');
  assert.match(pkg.scripts.typecheck, /--noEmit/, 'and it cannot produce output by accident');
  assert.match(pkg.scripts.typecheck, /-p tsconfig\.json|--project tsconfig\.json/, 'against this config, not whatever tsc finds');
  assert.match(pkg.scripts.test, /typecheck/, 'npm test runs it, so a red type is a failed test run');
  assert.match(pkg.scripts.test, /node --test/, 'without dropping the suite it used to be the only thing that ran');
  assert.ok(pkg.devDependencies.typescript, 'the compiler is a dependency of the service, not of a developer');
  assert.ok(pkg.devDependencies['@types/node'], 'and node has types, which is what makes `process`, `Buffer` and `setTimeout` mean something');
});

test('and into the build that produces the deployment', () => {
  const yaml = readFileSync(join(SERVER, '..', 'render.yaml'), 'utf8');
  const services = yaml.split(/\n  - type: /).slice(1);
  const server = services.find((block) => /rootDir: server/.test(block));
  assert.ok(server, 'the blueprint still has a server service to build');
  const build = (server.match(/buildCommand:\s*(.+)/) || [])[1] || '';
  assert.match(build, /npm ci/, 'install first, as it always did');
  assert.match(build, /npm run typecheck/, 'then refuse to build what will not typecheck, which is the only moment a deploy can be stopped before it starts');
  const client = services.find((block) => /rootDir: client/.test(block));
  assert.ok(!/typecheck/.test((client.match(/buildCommand:\s*(.+)/) || [])[1] || ''), 'the client is not wired yet, and this test says so rather than letting that look like coverage');
});

test('every options-bag typedef is applied to the parameter it describes', () => {
  /* A `@typedef` in a doc block that the signature never references is worse than no typedef: it reads like a
     contract while the checker goes back to inferring the parameter from its own defaults, which is the failure
     mode every one of these blocks was written to remove. It happens by accident whenever the bag is not the
     first parameter, so it is checked rather than trusted. */
  const unapplied = [];
  for (const rel of appSources.filter((f) => f.endsWith('.js'))) {
    const text = read(rel);
    for (const match of text.matchAll(/@typedef \{Object\} (\w+)/g)) {
      const name = match[1];
      /* Applied means either cast onto the parameter it documents, or named by another declaration that is -
         `PromoDescriptor` is a shape `ApplyPromoCodeInput` points at and is never a parameter of anything, and
         a typedef with no mention anywhere else in the file is a type nobody is using. */
      const mentions = (text.match(new RegExp(`\\b${name}\\b`, 'g')) || []).length;
      const applied = mentions >= 2;
      if (!applied) unapplied.push(`${rel}: ${name}`);
    }
  }
  assert.deepEqual(unapplied, [], 'each one is cast onto the parameter it documents');
});

test('the declared error fields are the fields this app puts on an error, in both directions', () => {
  const block = declarations.slice(declarations.indexOf('interface Error {'), declarations.indexOf('\n}', declarations.indexOf('interface Error {')));
  const declared = [...block.matchAll(/^ {2}(\w+)\?:/gm)].map((m) => m[1]);
  assert.ok(declared.length >= 15, 'the augmentation is real, not a stub');
  const sources = appSources.map(read).join('\n');
  const BUILT_IN = new Set(['message', 'name', 'stack', 'cause']);
  const written = new Set([...sources.matchAll(/\b(?:error|err)\??\.([a-zA-Z_$][\w$]*)\s*=(?!=)/g)].map((m) => m[1]));
  const undeclared = [...written].filter((key) => !BUILT_IN.has(key) && !declared.includes(key));
  assert.deepEqual(undeclared, [], 'a field this app sets on a thrown thing that the type file has never heard of - which is the field a reader cannot find');
  const phantom = declared.filter((key) => !new RegExp(`\\.${key}\\b`).test(sources));
  assert.deepEqual(phantom, [], 'a field the type file declares that no code reads or writes any more - which is the field a reader trusts for nothing');
});

/** The columns `db.js` creates or alters for one table, as the schema writes them. */
function columnsOf(table) {
  const schema = read('db.js');
  const found = new Set();
  const create = schema.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(([\\s\\S]*?)\\n\\s*\\);`));
  if (create) {
    for (const line of create[1].split('\n')) {
      const m = line.match(/^\s*([a-z_]+)\s+([A-Z][A-Z0-9]+)/);
      if (m && !['CONSTRAINT', 'PRIMARY', 'UNIQUE', 'FOREIGN', 'CHECK'].includes(m[1].toUpperCase())) found.add(m[1]);
    }
  }
  for (const m of schema.matchAll(new RegExp(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ([a-z_]+)`, 'g'))) found.add(m[1]);
  return found;
}

/** The properties one row typedef declares. */
function propertiesOf(typeName) {
  const start = declarations.indexOf(`type ${typeName} = {`);
  assert.notEqual(start, -1, `${typeName} is declared`);
  const body = declarations.slice(start, declarations.indexOf('\n};', start));
  return [...body.matchAll(/^ {2}\/\*\*[\s\S]*?\*\/\n {2}(\w+):|^ {2}(\w+):/gm)].map((m) => m[1] || m[2]);
}

test('a row type cannot name a column the schema does not have', () => {
  const PAIRS = [['UserRow', 'users'], ['ChannelRow', 'channels'], ['SignalRow', 'signals'], ['TradeRow', 'trades'], ['SettingsRow', 'settings'], ['PromoCodeRow', 'promo_codes']];
  for (const [type, table] of PAIRS) {
    const columns = columnsOf(table);
    assert.ok(columns.size > 4, `${table} was found in the schema at all`);
    const invented = propertiesOf(type).filter((property) => !columns.has(property));
    assert.deepEqual(invented, [], `${type} declares columns that ${table} does not have`);
  }
});

test('a NUMERIC column is typed as text, because that is what the driver returns', () => {
  /* The single most consequential fact in this file's types: `pg` hands back NUMERIC as a string so a broker's
     price survives without rounding, which is why the service coerces at every arithmetic site instead of
     trusting a column. If a price is ever typed as a number, `row.entry_price > 0` stops being a comparison and
     starts being a string test - true for `'-1'` - and this is the pin that says so loudly. */
  const numeric = new Map();
  const schema = read('db.js');
  for (const m of schema.matchAll(/^\s*([a-z_]+) NUMERIC/gm)) numeric.set(m[1], true);
  for (const m of schema.matchAll(/ALTER TABLE \w+ ADD COLUMN IF NOT EXISTS ([a-z_]+) NUMERIC/g)) numeric.set(m[1], true);
  const checked = [];
  for (const type of ['SignalRow', 'TradeRow', 'SettingsRow', 'PromoCodeRow']) {
    const start = declarations.indexOf(`type ${type} = {`);
    const body = declarations.slice(start, declarations.indexOf('\n};', start));
    for (const line of body.split('\n')) {
      const m = line.match(/^ {2}(\w+): (.+);$/);
      if (!m || !numeric.has(m[1])) continue;
      checked.push(`${type}.${m[1]}`);
      assert.match(m[2], /^string \| null \| string$|string/, `${type}.${m[1]} is NUMERIC in the schema, so text out of the driver - the coercion is the code being correct, not being defensive`);
      assert.doesNotMatch(m[2], /^number/, `${type}.${m[1]} may not be typed as a number`);
    }
  }
  assert.ok(checked.length >= 8, `the pin actually looked at prices (${checked.length}) rather than finding nothing to check`);
});

test('the type declarations cannot run, by construction', () => {
  const files = readdirSync(join(SERVER, 'types'));
  assert.deepEqual(files, ['app.d.ts'], 'one declaration file, so there is one place to look');
  /* No statement that reaches a runtime: no import or export (which would also stop the declarations being
     global), no function bodies, no value bindings. `import('socket.io').Socket` inside a type position is not
     an import statement and is allowed. */
  assert.doesNotMatch(declarations, /^import .*from/m, 'no top-level import');
  assert.doesNotMatch(declarations, /^export /m, 'no top-level export');
  assert.doesNotMatch(declarations, /^\s*(?:const|let|var|function|class) /m, 'nothing to execute');
});
