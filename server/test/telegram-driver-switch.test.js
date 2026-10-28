/**
 * The `TELEGRAM_DRIVER` switch, and the promise the whole migration rests on: **with the variable unset, a boot
 * resolves to the GramJS module object the application imports today.**
 *
 * The switch is deliberately not wired into `index.js` or the listener yet, so these tests are the only thing
 * exercising it - which is the correct arrangement while the second driver still refuses to start, and the reason
 * the last test here asserts that the call sites are *not* yet pointed at the resolver.
 *
 * One shape runs through the file: every function takes an env object rather than reading `process.env` itself.
 * Not politeness - a test that mutates `process.env` leaks the setting into whichever test file the runner happens
 * to execute next, and in this suite one of those files drives a real listener.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEFAULT_TELEGRAM_DRIVER, KNOWN_TELEGRAM_DRIVERS, TELEGRAM_DRIVER_ENV, describeTelegramDriver, parseTelegramDriverSelection, readMtcuteDriverStatus, resolveTelegramAdapter } from '../services/telegram-driver.js';
import { MTCUTE_PORTED, TELEGRAM_ADAPTER_METHODS, mtcuteDriverStatus } from '../services/telegram/mtcute-adapter.ts';
import * as gramjsAdapter from '../services/telegram-adapter.js';

const env = (value) => ({ [TELEGRAM_DRIVER_ENV]: value });

test('unset means GramJS, and says so without a note', async () => {
  const selection = parseTelegramDriverSelection({});
  assert.deepEqual(selection, { driver: 'gramjs', requested: null, note: null });
  assert.equal(DEFAULT_TELEGRAM_DRIVER, 'gramjs', 'the default is the driver that is deployed today');
  assert.deepEqual(KNOWN_TELEGRAM_DRIVERS, ['gramjs', 'mtcute']);
  assert.equal(TELEGRAM_DRIVER_ENV, 'TELEGRAM_DRIVER', 'one spelling, named once, for the status route and the boot log both');

  const resolved = await resolveTelegramAdapter({ env: {} });
  assert.equal(resolved.driver, 'gramjs');
  assert.equal(resolved.adapter, gramjsAdapter, 'the very module object the app imports, not a copy and not a wrapper');
  assert.equal(resolved.note, null, 'and nothing to report');
});

test('an unrecognised value is a log line, not a crash and not a coin flip', () => {
  for (const value of ['MT_CUTE', 'mt-cute', 'sqlite', 'gram-js', '0', 'false', 'off', 'null']) {
    const selection = parseTelegramDriverSelection(env(value));
    assert.equal(selection.driver, 'gramjs', `${JSON.stringify(value)} selects gramjs`);
    assert.ok(selection.note, 'with a note, because a typo in a dashboard text field has to be findable');
    assert.match(selection.note, new RegExp(TELEGRAM_DRIVER_ENV), 'the note quotes the variable name');
    assert.match(selection.note, /gramjs/, 'and names what ran instead');
    assert.doesNotMatch(selection.note, /throw|fatal|abort/i, 'phrased as a note, not as an alarm');
  }

  /* An empty value is not a typo, it is the box being cleared - Render's environment panel writes exactly this when
     someone deletes a row, and a boot log that called it a problem would teach people to ignore the log. So it is
     treated as "unset", which is the same answer the listener would have got before this switch existed. */
  for (const blank of ['', '   ', '\t', '\n']) {
    const selection = parseTelegramDriverSelection(env(blank));
    assert.deepEqual(selection, { driver: 'gramjs', requested: null, note: null }, `${JSON.stringify(blank)} is the absence of a setting`);
  }

  /* The one value that is *not* a typo is the one that looks like one: a paste with stray whitespace or the wrong
     case has to be honoured, because refusing it would mean an operator's working configuration does nothing. */
  assert.equal(parseTelegramDriverSelection(env(' gramjs ')).driver, 'gramjs');
  assert.equal(parseTelegramDriverSelection(env(' gramjs ')).note, null, 'and it is not reported as a problem');
  assert.equal(parseTelegramDriverSelection(env('GRAMJS')).note, null);
  assert.equal(parseTelegramDriverSelection(env('MTCUTE')).driver, 'mtcute', 'including the new driver, whose refusal is tested next');
});

test('asking for the second driver is refused, and the refusal is not a fallback', async () => {
  const logs = [];
  await assert.rejects(
    resolveTelegramAdapter({ env: env('mtcute'), log: (level, message, extra) => logs.push({ level, message, extra }) }),
    (error) => {
      assert.equal(error.code, 'MT_CUTE_NOT_WIRED', 'a code, so a route can answer 501 without matching prose');
      assert.equal(error.name, 'MtcuteNotWiredError');
      assert.match(error.message, /45 of the driver operations it must provide are not implemented/, 'the message counts what is missing, so nobody has to open the file to know the size of it');
      assert.match(error.message, /no-wss-transport/, 'and names the blockers by code');
      return true;
    },
    'a request for an unwired driver is a refusal, not a silent return to the old one',
  );
  assert.equal(logs.length, 1, 'one error line, on the way out');
  assert.equal(logs[0].level, 'error');
  assert.deepEqual(logs[0].extra.blockers, mtcuteDriverStatus().blockers.map((blocker) => blocker.code), 'the log carries the same codes the ledger holds');
  assert.equal(logs[0].extra.pending, TELEGRAM_ADAPTER_METHODS.length);
});

test('the refusal is the behaviour, so nothing else about the switch changes', async () => {
  /* A driver that is refused must not be *half* consulted: if the resolver had already built a client, or
     written a session row, before noticing it could not hand the adapter out, then "we never run mtcute in
     production" would depend on the order of two statements instead of on the switch. So the resolver's only
     observable effect for an unknown-but-valid request is the throw above, and the note field stays null. */
  const description = await describeTelegramDriver(env('mtcute'));
  assert.deepEqual(Object.keys(description).sort(), ['available', 'driver', 'mtcute', 'note', 'requested']);
  assert.equal(description.driver, 'mtcute', 'the request is reported as what it was, not as what ran');
  assert.equal(description.available, false);
  assert.equal(description.mtcute.wired, false);
  assert.equal(description.mtcute.pending, TELEGRAM_ADAPTER_METHODS.length);
  assert.equal(description.note, null, 'a value the switch understands is not a problem to note');

  const fallback = await describeTelegramDriver(env('mt-cute'));
  assert.equal(fallback.driver, 'gramjs');
  assert.equal(fallback.available, true, 'and what actually runs is available');
  assert.ok(/gramjs/.test(fallback.note), 'with the typo on the record');
});

test('the status reader survives a runtime that cannot load TypeScript', async () => {
  /* `describeTelegramDriver` and `resolveTelegramAdapter` both go through this function rather than importing the
     adapter module themselves, because the adapter lives in a `.ts` file and loading a `.ts` file is a capability
     of the runtime, not a certainty. On a runtime without type stripping the answer must still be an object - or
     the failure of the *status page* would be the only thing an operator sees. */
  const status = await readMtcuteDriverStatus();
  if (status === null) {
    assert.ok(true, 'this runtime could not load the ledger, and the caller handled it');
    return;
  }
  assert.deepEqual(Object.keys(status).sort(), ['blockers', 'pending', 'ported', 'wired']);
  assert.equal(status.wired, false);
  assert.deepEqual(status.ported, [...MTCUTE_PORTED]);
  assert.equal(status.pending.length, TELEGRAM_ADAPTER_METHODS.length, 'while nothing is ported, everything is pending');
  for (const blocker of status.blockers) {
    assert.ok(blocker.code && blocker.summary, `${blocker.code} carries the sentence that explains it`);
    assert.ok(blocker.summary.length > 80, `${blocker.code} is written to be read by whoever has to decide, not by whoever wrote it`);
  }
});

test('a bad value is logged by the resolver, then ignored', async () => {
  const logs = [];
  const resolved = await resolveTelegramAdapter({ env: env('mtcute2'), log: (level, message, extra) => logs.push({ level, message, extra }) });
  assert.equal(resolved.driver, 'gramjs');
  assert.equal(resolved.adapter, gramjsAdapter);
  assert.deepEqual(logs, [{ level: 'warn', message: 'Telegram driver setting could not be understood', extra: { requested: 'mtcute2', fellBackTo: 'gramjs' } }]);
});

test('the island is not wired into the running application yet', () => {
  /* The strangler-fig rule for this increment: files may exist, tests may pass, and the call sites stay as they
     were until the report has been read. If this test ever fails because someone pointed index.js at the resolver,
     it should fail together with a wired driver and an empty blocker list - not before. */
  for (const file of ['../index.js', '../services/telegram-listener.js', '../services/telegram-auth.js']) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.equal(source.includes('telegram-driver'), false, `${file} does not import the switch`);
    assert.equal(source.includes('TELEGRAM_DRIVER'), false, `${file} does not read the variable either, so there is one place that decides`);
  }

  const db = readFileSync(new URL('../db.js', import.meta.url), 'utf8');
  assert.equal(db.includes('storage-schema'), false, 'and the migration for the new tables is not applied by the boot path');

  const docs = readFileSync(new URL('../../.env.example', import.meta.url), 'utf8');
  assert.match(docs, /^# TELEGRAM_DRIVER=gramjs$/m, 'documented, commented out, and defaulted to what is already running');
  assert.match(docs, /telegram-driver/, 'with a pointer to the file that explains what the value does');
});
