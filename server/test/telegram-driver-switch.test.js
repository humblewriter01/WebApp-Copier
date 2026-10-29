/**
 * The `TELEGRAM_DRIVER` switch: what it accepts, what it ignores, and what it refuses.
 *
 * With the variable unset the listener gets the GramJS module it got before this file existed - that is the
 * promise the whole swap runs on, and most of this file is about keeping it. The rest is about the two refusals
 * the fork can actually provoke (a module this runtime cannot load, and a driver missing operations the app
 * calls), because "we fall back to GramJS in that case" is the one answer that would make a broken pilot look
 * like a working deployment.
 *
 * Every function here takes an env object instead of reading `process.env`, and that is not politeness: a test
 * that mutates `process.env` leaks the setting into whichever test file the runner executes next, and in this
 * suite one of those files drives a real listener.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEFAULT_TELEGRAM_DRIVER, KNOWN_TELEGRAM_DRIVERS, TELEGRAM_DRIVER_ENV, describeTelegramDriver, parseTelegramDriverSelection, readTelegramDriverStatus, resolveTelegramAdapter, telegramDriverRefusal } from '../services/telegram-driver.js';
import * as gramjsAdapter from '../services/telegram-adapter.js';
import * as teleprotoAdapter from '../services/telegram/teleproto-adapter.ts';

const env = (value) => ({ [TELEGRAM_DRIVER_ENV]: value });

test('unset, blank or absent means GramJS, with nothing to report', async () => {
  assert.deepEqual(parseTelegramDriverSelection({}), { driver: 'gramjs', requested: null, note: null });
  for (const blank of ['', '   ', '\t', '\n']) {
    assert.deepEqual(parseTelegramDriverSelection(env(blank)), { driver: 'gramjs', requested: null, note: null }, `${JSON.stringify(blank)} is the absence of a setting, not a wrong one`);
  }
  assert.equal(DEFAULT_TELEGRAM_DRIVER, 'gramjs', 'the default is the driver that is deployed today');
  assert.deepEqual(KNOWN_TELEGRAM_DRIVERS, ['gramjs', 'teleproto']);
  assert.equal(TELEGRAM_DRIVER_ENV, 'TELEGRAM_DRIVER', 'one spelling, named once, for a status route and a boot log both');

  const resolved = await resolveTelegramAdapter({ env: {} });
  assert.equal(resolved.driver, 'gramjs');
  assert.equal(resolved.adapter, gramjsAdapter, 'the very module object the app imports, not a copy and not a wrapper');
  assert.equal(resolved.note, null);
});

test('an unrecognised value is a log line, not a crash and not a coin flip', () => {
  for (const value of ['TELEPROT', 'teleproto@1.232', 'telegram', 'mtcute', '0', 'false', 'off', 'null', 'MT_CUTE']) {
    const selection = parseTelegramDriverSelection(env(value));
    assert.equal(selection.driver, 'gramjs', `${JSON.stringify(value)} selects gramjs`);
    assert.ok(selection.note, 'with a note, because a typo in a dashboard text field has to be findable');
    assert.match(selection.note, new RegExp(TELEGRAM_DRIVER_ENV), 'the note quotes the variable name');
    assert.match(selection.note, /gramjs/, 'and names what ran instead');
    assert.doesNotMatch(selection.note, /throw|fatal|abort/i, 'phrased as a note, not as an alarm');
  }

  /* `mtcute` in particular: the first increment shipped it as a known value, and a workspace that kept the
     setting after the experiment was retired must land on the driver that works, not on a name with no module. */
  const retired = parseTelegramDriverSelection(env('mtcute'));
  assert.equal(retired.requested, 'mtcute', 'the request is recorded as what it was');
  assert.match(retired.note, /not a driver this build knows/, 'and reported as unknown rather than remembered');

  /* A paste with stray spaces or the wrong case is not a typo, and refusing it would mean a working
     configuration silently doing nothing. */
  assert.equal(parseTelegramDriverSelection(env(' TELEPROTO ')).driver, 'teleproto');
  assert.equal(parseTelegramDriverSelection(env('GRAMJS')).note, null);
  assert.equal(parseTelegramDriverSelection(env('gramjs')).note, null);
});

test('the fork adapter reports itself complete against the driver it replaces', async () => {
  const status = await readTelegramDriverStatus('teleproto');
  assert.equal(status.loadable, true, 'the island loads in this runtime, which is the whole reason it is a .ts file');
  assert.deepEqual(status.missing, [], 'nothing the GramJS adapter exports is absent from the fork adapter');
  assert.deepEqual(status.extra, [], 'and it invents no extra operations, which would be a seam growing on one side');

  const gramjsFunctions = Object.keys(gramjsAdapter).filter((name) => typeof gramjsAdapter[name] === 'function');
  assert.equal(status.exported.length, gramjsFunctions.length, 'the counts agree, which is the number the parity test is written against');
  assert.equal(status.error, null);

  const description = await describeTelegramDriver(env('teleproto'));
  assert.deepEqual(Object.keys(description).sort(), ['available', 'driver', 'note', 'requested', 'teleproto']);
  assert.equal(description.available, true, 'the fork can be handed out, so this is not a refusal with a status page attached');
  assert.equal(description.teleproto.missing.length, 0);
  assert.equal(description.note, null, 'a value the switch understands is not a problem to note');
});

test('a driver that cannot be handed over whole is refused, never substituted', async () => {
  const logs = [];
  /* The incomplete case, provoked by pointing the name at a module that loads and has almost none of the
     operations - which is exactly what a half-ported driver looks like from the resolver's point of view. */
  await assert.rejects(
    resolveTelegramAdapter({
      env: env('teleproto'),
      log: (level, message, extra) => logs.push({ level, message, extra }),
      drivers: { gramjs: './telegram-adapter.js', teleproto: './telegram/gramjs-session.ts' },
    }),
    (error) => {
      assert.equal(error.code, 'TELEGRAM_DRIVER_TELEPROTO_UNAVAILABLE', 'a code, so a route can answer 501 without matching prose');
      assert.equal(error.name, 'TelegramDriverUnavailableError');
      assert.match(error.message, /is missing \d+ operation\(s\)/, 'the message counts what is missing');
      assert.match(error.message, /will not start on another driver instead/, 'and says plainly that there is no fallback');
      assert.match(error.message, /Set TELEGRAM_DRIVER=gramjs/, 'and names the way out');
      return true;
    },
    'a partial driver is a refusal, not a fallback',
  );
  assert.deepEqual(logs.map((entry) => entry.level), ['error'], 'one error line, on the way out');
  assert.equal(logs[0].extra.missing.length > 0, true, 'the log carries the list, not just the count');

  /* The unloadable case, which is what a runtime without type stripping produces for a `.ts` driver: the failure
     has to be at the switch, before anything is half-built. */
  const logs2 = [];
  await assert.rejects(
    resolveTelegramAdapter({
      env: env('teleproto'),
      log: (level, message, extra) => logs2.push({ level, message, extra }),
      drivers: { gramjs: './telegram-adapter.js', teleproto: './no-such-driver-module.js' },
    }),
    (error) => error.code === 'TELEGRAM_DRIVER_TELEPROTO_UNAVAILABLE' && /could not be loaded by this runtime/.test(error.message),
  );
  assert.equal(logs2[0].message, 'Telegram driver could not be loaded');
  assert.match(logs2[0].extra.error, /Cannot find module|MODULE_NOT_FOUND|Failed to load|not found/i, 'with the loader\'s own complaint beside it');
});

test('a bad value is logged by the resolver, then ignored; a good one is logged when it is chosen', async () => {
  const logs = [];
  const resolved = await resolveTelegramAdapter({ env: env('teleprot'), log: (level, message, extra) => logs.push({ level, message, extra }) });
  assert.equal(resolved.driver, 'gramjs');
  assert.equal(resolved.adapter, gramjsAdapter);
  assert.deepEqual(logs, [{ level: 'warn', message: 'Telegram driver setting could not be understood', extra: { requested: 'teleprot', fellBackTo: 'gramjs' } }]);

  const chosen = [];
  const teleprotoResolved = await resolveTelegramAdapter({ env: env('teleproto'), log: (level, message, extra) => chosen.push({ level, message, extra }) });
  assert.equal(teleprotoResolved.adapter, teleprotoAdapter, 'the fork adapter is handed out as the module object, exactly as the GramJS one is');
  assert.deepEqual(chosen, [{ level: 'info', message: 'Telegram driver selected', extra: { driver: 'teleproto', operations: Object.keys(teleprotoAdapter).filter((name) => typeof teleprotoAdapter[name] === 'function').length } }], 'and the choice is said out loud at boot, because a silent switch is a switch nobody notices');
});

test('the refusal text is a contract, and an unknown driver name never reaches it', async () => {
  const refusal = telegramDriverRefusal('teleproto', 'is missing 3 operation(s): a, b, c', 'detail');
  assert.match(refusal.message, /TELEGRAM_DRIVER=teleproto was requested/);
  assert.match(refusal.message, /Underneath: detail/, 'the loader\'s own complaint is appended, not swallowed');
  assert.equal(refusal.code, 'TELEGRAM_DRIVER_TELEPROTO_UNAVAILABLE');
  assert.equal(telegramDriverRefusal('teleproto', 'could not be loaded', null).message.includes('Underneath'), false, 'and no empty Underneath clause when there is nothing to say');

  const status = await readTelegramDriverStatus('nonsense');
  assert.equal(status.loadable, false, 'a name with no module behind it is reported, not thrown at');
  assert.match(status.error, /unknown driver/);
});

test('the latency pilot measures the same registration path production uses', () => {
  /* The pilot is allowed one reach past the seam - the `Raw` builder, which no adapter exports and which the
     GramJS file may not gain in this increment - and everything else it touches has to go through the resolved
     adapter, because a harness that registers its own handlers is measuring its own code, not the driver's. */
  const pilot = readFileSync(new URL('../scripts/telegram-latency-pilot.mjs', import.meta.url), 'utf8');
  assert.match(pilot, /adapter\.addMessageHandler\(client, onRaw, rawFilter\)/, 'the raw half is registered through the adapter');
  assert.match(pilot, /adapter\.addMessageHandler\(client, onMessage, messageFilter\)/, 'and so is the half that produces the number');
  assert.match(pilot, /adapter\.removeMessageHandler\(client, handler, filter\)/, 'and undone the same way, so a failed run leaves no handler on a live account');
  assert.equal(/client\.addEventHandler\(/.test(pilot), false, 'the pilot never calls the client directly to attach a handler');
  assert.match(pilot, /resolveTelegramAdapter/, 'and it resolves through the switch, so it cannot measure a driver the deployment would not run');
});

test('the island is not wired into the running application yet, and says which increment will', () => {
  /* The strangler-fig rule for this increment. It is not timidity: the pilot must measure one unproven change,
     the library, and rewiring four files in the same deployment would make a regression impossible to attribute.
     `resolveTelegramAdapter` is what the pilot script and these tests use, and that is the whole live surface. */
  for (const file of ['../index.js', '../services/telegram-listener.js', '../services/telegram-auth.js', '../services/telegram-keepalive.js']) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.equal(source.includes('resolveTelegramAdapter'), false, `${file} still imports the GramJS adapter directly, while the pilot is being measured`);
  }
  const boot = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  assert.match(boot, /import \* as telegramAdapter from '\.\/services\/telegram-adapter\.js';/, 'the production import line is untouched, which is the strongest form of "we can flip back and lose nothing"');

  const docs = readFileSync(new URL('../../.env.example', import.meta.url), 'utf8');
  assert.match(docs, /^# TELEGRAM_DRIVER=gramjs$/m, 'documented, commented out, and defaulted to what is already running');
  assert.match(docs, /teleproto/, 'and naming the alternative, since a commented-out value nobody can spell is not documentation');
});
