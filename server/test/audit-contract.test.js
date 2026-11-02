/**
 * The audit log's contract, checked from both ends.
 *
 * `services/audit.js` keeps a closed list of action keys, and `buildAuditEntry` refuses anything outside it. That
 * is deliberate - a typo in a route should be loud - but the loudness is the problem: the refusal happens *inside*
 * `record()`, which swallows it, logs `Audit entry could not be built`, and returns null, so the administrator's
 * action succeeds, the row is never written, and nothing but a log line says the trail has a hole in it. Three
 * Telegram actions lived in that hole: `telegram.reconnectForced`, `telegram.sessionPaused` and
 * `telegram.sessionResumed` were dispatched by routes whose payloads were entirely correct. The payloads were
 * never the problem, and no amount of checking fields would have found it - the keys simply were not in the list.
 *
 * So this file pins the two directions that a route can get wrong, in both senses of "wrong":
 *   - every action key any route dispatches must be in the vocabulary (otherwise its entry is refused);
 *   - every vocabulary key must have a dispatcher (otherwise the panel offers a filter that can only be empty).
 * plus the payload checks that the existing `admin-audit.test.js` cannot make, because it builds every entry with
 * an action and nothing else, which passes for any key by construction.
 *
 * The source is parsed rather than a hand-typed list because the failure being prevented is drift between a route
 * and the list - and a list maintained by hand in a test drifts the same way. Actions built through a frozen map
 * (`MANUAL_SUBSCRIPTION_ACTIONS.grant`) and through a ternary (`input.paused ? … : …`) are both resolved, because
 * a scanner that only saw quoted literals would report nine "unused" keys and be wrong about every one of them.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildAuditEntry, sanitizeAuditMetadata, createAuditLogger, AUDIT_ACTIONS, auditLogColumns } from '../services/audit.js';

const SERVER = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** The files that are allowed to write an audit row: the server and its services, never the tests. */
function sourceFiles(dir = '', found = []) {
  for (const entry of fs.readdirSync(path.join(SERVER, dir), { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'test' || entry.name.startsWith('.')) continue;
    const relative = dir ? `${dir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) sourceFiles(relative, found);
    else if (entry.name.endsWith('.js') || entry.name.endsWith('.mjs')) found.push(relative);
  }
  return found;
}

const sources = new Map(sourceFiles().map((file) => [file, fs.readFileSync(path.join(SERVER, file), 'utf8')]));

// An audit action key as the code writes it: `action: 'domain.verb'`, or `action: cond ? 'a.b' : 'c.d'`, or
// `action: LOOKUP.key` into a frozen map. All three shapes are in use, and a scanner that understood only the first
// would report the subscription keys as dead and invent a bug. The pattern is a function rather than one shared
// /g regex on purpose: a global regex carries `lastIndex` between `matchAll` calls, and a scanner that quietly
// misses every other line reads as a pass. The trailing segment allows upper case: half of this vocabulary is
// camelCase (`telegram.sessionPaused`), and a class of `[a-z0-9_]` alone silently matches nothing at all for those -
// which is exactly the kind of blind scanner that turns a red test into a green one.
const dottedPattern = () => /'([a-z][a-z0-9_]*(?:\.[a-zA-Z0-9_]+)+)'/g;

/** Every action key any file could hand to `record()`, and where it came from. */
const dispatched = new Map();
/** Every `metadata: { … }` literal key in the server, with the file it was written in. */
const metadataWritten = [];
for (const [file, text] of sources) {
  for (const match of text.matchAll(/\baction:\s*([^\n]{0,240})/g)) {
    for (const dotted of match[1].matchAll(dottedPattern())) {
      if (!dispatched.has(dotted[1])) dispatched.set(dotted[1], new Set());
      dispatched.get(dotted[1]).add(`${file}:${text.slice(0, match.index).split('\n').length}`);
    }
    // A lookup written as `MANUAL_SUBSCRIPTION_ACTIONS.grant` spells nothing at the call site, so the map is read.
    const lookup = match[1].match(/^\s*([A-Z][A-Z0-9_]*ACTIONS)\b/);
    if (lookup) {
      const declaration = text.match(new RegExp(`const ${lookup[1]} = Object\\.freeze\\(\\{([\\s\\S]*?)\\}\\)`));
      if (declaration) {
        for (const dotted of declaration[1].matchAll(dottedPattern())) {
          if (!dispatched.has(dotted[1])) dispatched.set(dotted[1], new Set());
          dispatched.get(dotted[1]).add(`${lookup[1]} (declared in ${file})`);
        }
      }
    }
  }
  for (const match of text.matchAll(/\bmetadata:\s*\{/g)) {
    let depth = 0;
    const open = match.index + match[0].length - 1;
    let block = '';
    for (let i = open; i < text.length; i += 1) {
      if (text[i] === '{') depth += 1;
      else if (text[i] === '}') { depth -= 1; if (!depth) { block = text.slice(open, i + 1); break; } }
    }
    for (const key of block.slice(1, -1).matchAll(/(?:^|[{,])\s*([A-Za-z][A-Za-z0-9_]*)\s*:/g)) {
      metadataWritten.push({ key: key[1], at: `${file}:${text.slice(0, match.index).split('\n').length}` });
    }
  }
}

const VOCABULARY = Object.keys(AUDIT_ACTIONS);

test('the scanner sees the real surface, so an empty result cannot look like a pass', () => {
  assert.ok(sources.size > 20, `the sweep reads every server source file (${sources.size} found)`);
  assert.ok(dispatched.size >= VOCABULARY.length, `the parse found ${dispatched.size} keys for ${VOCABULARY.length} in the list, or it is blind`);
  assert.ok(metadataWritten.length >= 20, `metadata payloads are being read too (${metadataWritten.length} keys found)`);
  // The three shapes a route uses, each proven on the file rather than on a fixture: a literal at the call site, a
  // key resolved through a ternary, and a key resolved through a frozen lookup map.
  for (const key of ['telegram.reconnectForced', 'execution.pause', 'subscription.grant']) {
    assert.ok(dispatched.has(key), `${key} is dispatched in one of the three shapes, and the parser must follow all of them`);
  }
});

test('every action a route dispatches is in the closed vocabulary', () => {
  const missing = [...dispatched.keys()].filter((action) => !Object.hasOwn(AUDIT_ACTIONS, action));
  assert.deepEqual(missing, [], `these actions would be refused at build time and their rows silently never written: ${missing.join(', ')}`);
});

test('every vocabulary key has a dispatcher, so the panel never offers an empty filter', () => {
  const unused = VOCABULARY.filter((action) => !dispatched.has(action));
  assert.deepEqual(unused, [], `${unused.join(', ')} can be filtered for in the admin panel but no route writes them`);
});

/** The payload each of these routes really sends, in the words the route uses, not a paraphrase of it. */
const REPRESENTATIVE = {
  'telegram.reconnectForced': { targetType: 'user', summary: 'Reconnected by hand.', metadata: { reason: 'admin-panel', caughtUp: 0, fresh: 0, heartbeatCycles: 3, deadBeats: 0, stalledBeats: 1 } },
  'telegram.sessionPaused': { targetType: 'user', summary: 'Paused.', metadata: { reason: 'idle-free-plan', clientEnded: true, wasLive: true } },
  'telegram.sessionResumed': { targetType: 'user', summary: 'Resumed.', metadata: { reason: 'admin', cleared: 1, reconnected: true, wasAlreadyPaused: true } },
  'user.update': { targetType: 'user', summary: 'Changed.', metadata: { isSuspended: true, supportAccessRevoked: 2 } },
  'impersonation.start': { targetType: 'user', summary: 'Opened.', metadata: { supportAccessId: 'abc', reason: 'watching', expiresAt: 'later' } },
  'impersonation.stop': { targetType: 'support_session', summary: 'Closed.', metadata: { supportAccessId: 'abc' } },
};
const ACTOR = { actorId: '11111111-1111-4111-8111-111111111111', actorEmail: 'Admin@Example.com ' };

test('every action builds a row, bare and with the payload its route sends', () => {
  for (const action of VOCABULARY) {
    const bare = buildAuditEntry({ ...ACTOR, action });
    assert.equal(bare.action, action);
    assert.equal(bare.summary, AUDIT_ACTIONS[action], 'no route has to invent a summary to be writable, which is what makes the fallback safe');
    assert.equal(bare.actorEmail, 'admin@example.com', 'the email is lower-cased on the way in, because the panel matches on it');
    const payload = REPRESENTATIVE[action];
    if (!payload) continue;
    const built = buildAuditEntry({ ...ACTOR, action, targetId: 'target-1', ...payload });
    assert.equal(built.targetType, payload.targetType, `${action} keeps the target type its route chose`);
    assert.equal(built.targetId, 'target-1');
    assert.equal(built.summary, payload.summary, 'a route-supplied summary is never overwritten by the label');
    for (const key of Object.keys(payload.metadata)) {
      assert.ok(Object.hasOwn(built.metadata, key), `${action} loses metadata.${key} on the way in - rename it, do not widen the scrubber`);
    }
  }
});

test('the metadata a route writes is the metadata that survives the scrubber', () => {
  const dropped = [];
  for (const site of metadataWritten) {
    if (!Object.hasOwn(sanitizeAuditMetadata({ [site.key]: 'x' }), site.key)) dropped.push(`${site.key} @ ${site.at}`);
  }
  assert.deepEqual(dropped, [], `these keys are dropped by SECRET_KEY_PATTERN, so the row cannot carry them: ${dropped.join('; ')}`);
  const eaten = ['revokedSupportSessions', 'supportSessionsRevoked', 'sessionId'];
  const offending = metadataWritten.filter((site) => eaten.includes(site.key));
  assert.deepEqual(offending, [], `these metadata keys are named after credentials and SECRET_KEY_PATTERN drops them - the row cannot carry them: ${offending.map((o) => `${o.key} @ ${o.at}`).join('; ')}`);
  for (const key of ['supportAccessRevoked', 'supportAccessId']) {
    assert.ok(metadataWritten.some((site) => site.key === key), `${key} is the spelling that survives the scrubber and must stay in use`);
  }
});

test('record() writes one row for every action and refuses none of them', async () => {
  const writes = [];
  const logger = createAuditLogger({
    pool: { query: async (sql, params) => { writes.push({ sql, params }); return { rows: [{ id: 'row-1', action: params[2] }] }; } },
    logger: { error: () => { throw new Error('an audit entry was refused at build time'); }, warn: () => {}, info: () => {} },
  });
  for (const action of VOCABULARY) {
    const row = await logger.record({ ...ACTOR, action, targetType: 'user', targetId: 'target-1', summary: AUDIT_ACTIONS[action], metadata: { checked: true } });
    assert.equal(row?.action, action, `${action} produced no row`);
  }
  assert.equal(writes.length, VOCABULARY.length, 'one INSERT per action, and no action was dropped on the floor');
  assert.match(writes[0].sql, /INSERT INTO admin_audit_logs/, 'the statement is the append-only one');
  assert.ok(writes[0].sql.includes(auditLogColumns), 'and it returns the columns the panel reads back');
  assert.equal(JSON.parse(writes[0].params[6]).checked, true, 'metadata is stored as jsonb text of the sanitised object');
});

test('a key outside the list is still refused, so the closed vocabulary keeps its teeth', () => {
  assert.throws(() => buildAuditEntry({ ...ACTOR, action: 'telegram.reconnectForcedAgain' }), /Unknown audit action/);
  assert.throws(() => buildAuditEntry({ ...ACTOR, action: '' }), /needs the action/);
  assert.deepEqual(sanitizeAuditMetadata({ sessionString: 'x', apikey: 'y', kept: 'z' }), { kept: 'z' }, 'credential-shaped keys are dropped before the row is built, and that is not negotiable');
});
