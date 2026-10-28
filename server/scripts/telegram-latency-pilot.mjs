/**
 * The driver-swap latency pilot. Run it where Telegram is reachable - a Render Preview shell, or a machine with
 * the same credentials - and not from a sandbox that cannot open a socket to `api.telegram.org`.
 *
 *     cd server
 *     TELEGRAM_DRIVER=teleproto API_ID=… API_HASH=… TELEGRAM_SESSION=… \
 *       node scripts/telegram-latency-pilot.mjs --channel <id or @handle> --rounds 8 --post
 *
 * Why it exists, and what it can actually prove. The pilot's gate is "every capture under one second, and anything
 * over five seconds fails", and a message's own `date` is one-second resolution, so a number derived from it
 * cannot settle a sub-second claim at all - it can only be a ceiling. This script therefore measures three things
 * and prints all of them, with the first one carrying the verdict:
 *
 *   1. **`roundTripMs`** - only with `--post`, where the pilot sends `signalpilot <n> <iso>` itself and stamps the
 *      instant it asked, so the measurement is exact and sub-second. This is the number for the gate.
 *   2. **`dispatchMs`** - the interval between the update arriving at the client (a `Raw` handler, which sees every
 *      update before the message builders filter them) and our `NewMessage` handler being called with it. This is
 *      the number that separates "Telegram was slow" from "the library sat on it", which is the distinction teleproto
 *      issue #36 is about, and it is measurable on channels the pilot cannot post to.
 *   3. **`serverLagMs`** - arrival minus the message's `date`. Coarse, and reported as a ceiling only.
 *
 * `--mode both` runs the `addEventHandler(NewMessage)` path and the `.watch()` path in the same process against the
 * same channels and prints them side by side, because the fork's maintainer recommends `.watch()` for big channels
 * and we should know which one production uses before we depend on either. `.watch()` is teleproto-only; with
 * `TELEGRAM_DRIVER=gramjs` the comparison half is skipped and says so.
 *
 * Nothing here writes to the database, calls MetaAPI, or touches a live workspace's session. It builds its own
 * client from the environment, connects, listens for `--seconds`, and closes. The session string it is given is
 * read-only in practice, but a second socket on a real account is still a second socket, so run it against a test
 * workspace or a channel you own.
 */
import process from 'node:process';
import { Buffer } from 'node:buffer';

const PASS_CEILING_MS = 1_000;
const FAIL_CEILING_MS = 5_000;
const argv = process.argv.slice(2);

function flag(name, fallback = undefined) {
  const at = argv.indexOf(`--${name}`);
  if (at === -1) return fallback;
  const next = argv[at + 1];
  return next === undefined || next.startsWith('--') ? true : next;
}

function help(code) {
  console.log(`usage: node scripts/telegram-latency-pilot.mjs --channel <id|@handle> [options]

  --rounds <n>       messages to wait for before giving up           (default 5)
  --seconds <n>      total wall-clock budget for the pilot            (default 120)
  --post             send the probe message itself; needed for the exact round-trip number
  --pattern <re>     only count posts whose text matches (default: any)
  --mode <m>         handlers | watch | both                          (default both)
  --channel <c>      repeatable; a peer id, @handle or t.me link

A run passes when every measured capture is at most ${PASS_CEILING_MS} ms and fails outright at ${FAIL_CEILING_MS} ms.
Exit code 0 on pass, 1 on a failed round, 2 on a pilot that could not run at all.`);
  process.exit(code);
}

const channels = argv.reduce((all, arg, i) => (arg === '--channel' && argv[i + 1] ? all.concat(argv[i + 1]) : all), []);
if (argv.includes('--help') || !channels.length) help(argv.includes('--help') ? 0 : 2);
const rounds = Number(flag('rounds', 5));
const budgetMs = Number(flag('seconds', 120)) * 1000;
const selfPost = flag('post', false) === true;
const mode = flag('mode', 'both');
const pattern = flag('pattern') ? new RegExp(String(flag('pattern')), 'i') : null;
const driver = process.env.TELEGRAM_DRIVER || 'gramjs';

/* Preflight, before the switch is consulted: the fork's adapter is a TypeScript file, and loading it at all
   needs a runtime that strips types - Node 22.18 or newer by default, or 22.6+ with --experimental-strip-types.
   Failing here says which Node to install; failing inside the resolver says only what the loader complained
   about, and that message has already been filed as a bug report by someone who read it as a missing dependency.
   The application has no such requirement, because the driver it runs on is plain JavaScript, and that is the
   reason the floor lives here rather than in package.json's engines field. */
const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number);
if (driver !== 'gramjs' && (nodeMajor < 22 || (nodeMajor === 22 && nodeMinor < 18))) {
  console.error(`The ${driver} pilot needs Node 22.18 or newer to read a TypeScript module; this is ${process.versions.node}.`);
  console.error('Upgrade, or run this file with --experimental-strip-types on Node 22.6+, or set TELEGRAM_DRIVER=gramjs.');
  process.exit(2);
}

const { resolveTelegramAdapter } = await import('../services/telegram-driver.js');
const resolved = await resolveTelegramAdapter({ env: process.env, log: (level, message, extra) => console.log(`[${level}] ${message} ${extra ? JSON.stringify(extra) : ''}`) });
const adapter = resolved.adapter;
const options = adapter.captureTransportOptions({ wss: true });
/* The two drivers are printed by dumping the object they were given, rather than by naming the keys here, so
     that this file stays inside the seam's containment rule (`test/telegram-adapter.test.js`) and so the line
     cannot drift into asserting a spelling one of the two packages no longer accepts. Both shapes have to say
     "wss on port 443", in their own vocabulary, and this is where you read which one ran. */
console.log(`driver=${resolved.driver} options=${Object.entries(options).map(([key, value]) => `${key}=${value && typeof value === 'object' ? value.constructor?.name || 'object' : value}`).join(' ')}`);

const sessionString = process.env.TELEGRAM_SESSION || '';
if (!sessionString) {
  console.error('TELEGRAM_SESSION is empty, so there is no account to listen as. Export the same stored session the workspace uses.');
  process.exit(2);
}
const apiId = Number(process.env.API_ID);
const apiHash = process.env.API_HASH || '';
const client = adapter.createClient({ sessionString, apiId, apiHash, options });

/** What one observed message cost, in the three units above. */
const seen = [];
let rawArrivalAt = null;
let postedAt = new Map();
let stopped = false;

function record(updateAt, message) {
  const text = typeof message?.message === 'string' ? message.message : '';
  if (pattern && !pattern.test(text)) return false;
  const handlerAt = Date.now();
  const probe = /^signalpilot (\d+) (\d+)$/.exec(text.trim());
  const roundTripMs = probe ? handlerAt - Number(probe[2]) : null;
  const serverDateMs = message.date ? message.date * 1000 : null;
  const entry = {
    text: text.slice(0, 40),
    dispatchMs: rawArrivalAt === null ? null : handlerAt - rawArrivalAt,
    roundTripMs,
    serverLagMs: serverDateMs === null ? null : handlerAt - serverDateMs,
    viaWatch: updateAt === 'watch',
  };
  seen.push(entry);
  printRow(seen.length, entry);
  if (roundTripMs !== null) postedAt.delete(probe[1]);
  return true;
}

function printRow(index, entry) {
  const pad = (value, unit) => (value === null || value === undefined ? `   n/a    ` : `${String(value).padStart(6)}${unit}  `);
  console.log(`  #${String(index).padStart(2)}  roundTrip${pad(entry.roundTripMs, 'ms')}dispatch${pad(entry.dispatchMs, 'ms')}serverLag${pad(entry.serverLagMs, 'ms')}${entry.viaWatch ? '[watch]' : '[handlers]'}  ${JSON.stringify(entry.text)}`);
}

/** The verdict, from whichever numbers exist. A missing roundTrip is not a pass. */
function verdict() {
  const measured = seen.filter((entry) => entry.roundTripMs !== null);
  const worst = measured.reduce((max, entry) => Math.max(max, entry.roundTripMs), 0);
  const dispatched = seen.filter((entry) => entry.dispatchMs !== null);
  const worstDispatch = dispatched.reduce((max, entry) => Math.max(max, entry.dispatchMs), 0);
  const lines = [
    `samples=${seen.length} measuredRoundTrips=${measured.length} worstRoundTripMs=${worst || 'n/a'} worstDispatchMs=${worstDispatch || 'n/a'}`,
  ];
  if (!measured.length) lines.push('FAILED: no exact round trip was measured, so the gate cannot be judged - use --post on a channel the account can write to');
  else if (measured.some((entry) => entry.roundTripMs > FAIL_CEILING_MS)) lines.push(`FAILED: a capture took over ${FAIL_CEILING_MS} ms (${measured.filter((e) => e.roundTripMs > FAIL_CEILING_MS).length} of ${measured.length}) - do not proceed with this driver`);
  else if (measured.some((entry) => entry.roundTripMs > PASS_CEILING_MS)) lines.push(`INCONCLUSIVE: ${measured.filter((e) => e.roundTripMs > PASS_CEILING_MS).length} capture(s) between ${PASS_CEILING_MS} and ${FAIL_CEILING_MS} ms - re-run with more rounds before deciding`);
  else lines.push(`PASSED: all ${measured.length} captures at most ${PASS_CEILING_MS} ms (${worst} ms worst), dispatch overhead ${worstDispatch} ms`);
  return { lines, code: lines[lines.length - 1].startsWith('PASSED') ? 0 : 1 };
}

const handlers = [];
const watchTask = { stop: null, seen: new Set() };
async function main() {
  await adapter.connect(client);
  if (!(await adapter.checkAuthorization(client))) {
    console.error('this session is not authorized (checkAuthorization said no), so the pilot would measure nothing. Use the stored session of a signed-in workspace.');
    process.exit(2);
  }
  const self = await adapter.getSelf(client);
  console.log(`connected as ${self?.id ?? self?.userId ?? '?'}`);

  /* `Raw` sees every update before any builder filters it, which is where "arrival at the client" is stamped.
     Registration itself goes through the adapter, even for the raw half: an event filter is an opaque argument to
     `addMessageHandler`, so the pilot measures the same call the listener makes rather than a parallel one. */
  const onRaw = (update) => { rawArrivalAt = Date.now(); void update; };
  const messageFilter = adapter.createMessageEventFilter();
  const onMessage = async (event) => { record('handlers', event.message); };
  const rawFilter = await newRaw();
  handlers.push([messageFilter, onMessage], [rawFilter, onRaw]);
  adapter.addMessageHandler(client, onRaw, rawFilter);
  adapter.addMessageHandler(client, onMessage, messageFilter);

  if (mode !== 'handlers' && resolved.driver === 'teleproto') {
    const watch = client.updates?.watch?.bind(client.updates);
    if (!watch) console.log('[warn] this teleproto build exposes no client.updates.watch(), so the comparison is skipped');
    else {
      const iterable = watch({ chats: channels.length ? channels : undefined });
      const abort = { done: false };
      watchTask.stop = async () => { abort.done = true; await iterable.return?.(); };
      (async () => {
        for await (const update of iterable) {
          if (abort.done) break;
          rawArrivalAt = Date.now();
          const message = update?.message ?? (update?.updates && update.updates[0]?.message);
          if (message && typeof message.message === 'string') record('watch', message);
        }
      })().catch((error) => console.log(`[warn] watch iterator ended: ${error?.message}`));
    }
  } else if (mode !== 'handlers') {
    console.log(`[skip] .watch() comparison is not available on ${resolved.driver}; measured the handler path only`);
  }

  const deadline = Date.now() + budgetMs;
  while (!stopped && seen.filter((entry) => entry.roundTripMs !== null).length < rounds && Date.now() < deadline) {
    if (selfPost && postedAt.size < rounds) {
      const n = String(seen.length + postedAt.size + 1);
      const at = Date.now();
      postedAt.set(n, at);
      try {
        await client.sendMessage(channels[0], { message: `signalpilot ${n} ${at}` });
      } catch (error) {
        console.error(`[fail] could not post the probe: ${error?.message}. Drop --post to measure passively (dispatch and serverLag only).`);
        stopped = true;
        break;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(2_000, Math.max(0, deadline - Date.now()))));
  }
}

/**
 * The `Raw` builder, from whichever package the active driver came from.
 *
 * This is the one line in the pilot that reaches past the seam, and it is exempted by name in
 * `test/telegram-adapter.test.js`, with the reason there rather than buried here: the adapters do not export a raw
 * filter, and adding one to the GramJS file is not allowed in the same increment that swaps the other driver,
 * because that file has to stay the thing the deployment is byte-identical to. Everything the pilot does with the
 * result - registering it, removing it, counting messages - goes through the adapter like production does.
 */
async function newRaw() {
  const pkg = resolved.driver === 'teleproto' ? 'teleproto/events' : 'telegram/events';
  const { Raw } = await import(pkg);
  return new Raw({});
}

const result = await main().then(() => verdict(), (error) => ({ lines: [`FAILED: the pilot could not run: ${error?.stack || error}`], code: 2 }));
stopped = true;
await watchTask.stop?.().catch(() => {});
for (const [filter, handler] of handlers) {
  try { adapter.removeMessageHandler(client, handler, filter); } catch { /* already gone */ }
}
await adapter.disconnect(client).catch(() => {});
console.log('');
for (const line of result.lines) console.log(line);
if (mode === 'both' && seen.some((entry) => entry.viaWatch)) {
  const byPath = (watch) => {
    const rows = seen.filter((entry) => entry.viaWatch === watch);
    const dispatch = rows.map((entry) => entry.dispatchMs).filter((value) => value !== null);
    return `${watch ? 'watch    ' : 'handlers'}: ${rows.length} sample(s), median dispatch ${median(dispatch)} ms`;
  };
  console.log(byPath(false));
  console.log(byPath(true));
  console.log('the path with more samples at lower dispatch is the one production should use; a path that simply sees fewer is losing updates, which is worse than being slow');
}
process.exit(result.code);

function median(values) {
  if (!values.length) return 'n/a';
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}
