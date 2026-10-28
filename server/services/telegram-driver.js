/**
 * The Telegram driver switch, and the only place that decides which driver a process talks to.
 *
 * A second driver is only safe if the first one cannot be disturbed by it, and one environment variable is not a
 * safety property on its own: it has to be *read* in one place, with one answer for a typo, and one behaviour for a
 * driver that is named but cannot be loaded. Three rules, and they are the whole file:
 *
 *  1. **Unset means gramjs.** Production behaviour is unchanged by the existence of this module, which is the
 *     promise the migration runs on: the flag defaults to the driver that is deployed today, and a missing
 *     variable is not a configuration change.
 *  2. **An unrecognised value is a log line, not a crash and not a coin flip.** A typo in a dashboard's environment
 *     panel must not take capture down, and must not be treated as "they probably meant the new one". The old
 *     driver runs, and the note says what was ignored, in the same turn, where an operator will see it. This is
 *     also what happens to `TELEGRAM_DRIVER=mtcute` now that the mtcute experiment has been retired: it lands on
 *     gramjs with a note naming it, rather than on a half-loaded driver.
 *  3. **A driver that cannot be handed over whole is refused, never substituted.** If `TELEGRAM_DRIVER=teleproto`
 *     were allowed to fall back, a machine that cannot load the fork (no type stripping in its runtime, or the
 *     package absent after a partial install) would look identical to a working deployment while the sessions two
 *     layers down belonged to something else - and Telegram sessions are the one piece of state where "it kept
 *     working" and "it silently wrote to the wrong store" are indistinguishable from outside. So the resolver
 *     checks the *completeness* of the driver it is about to return, and refuses rather than returning a partial.
 *
 * Note what this module does *not* do: it is not imported by `index.js` or `services/telegram-listener.js` yet.
 * The application still imports `services/telegram-adapter.js` directly, so this switch is what a *pilot* runs
 * through (`scripts/telegram-latency-pilot.mjs`) and what the parity tests drive, not what a production boot
 * consults. Making it live is a separate increment with a decision attached to it - either every boot imports a
 * TypeScript file, which raises the Node floor to 22.18 for the whole service including the gramjs path, or the
 * adapter is injected through the listener, the watchdog and the auth routes, which is a real refactor of four
 * files. Neither is a one-line change, and doing either of them *inside* a driver-swap pilot would put two
 * unproven things in one deployment.
 */

/** The variable that selects the driver, named once so a status route and a log line quote the same spelling. */
export const TELEGRAM_DRIVER_ENV = 'TELEGRAM_DRIVER';
/** What a process with no opinion runs on. Changing this is changing production. */
export const DEFAULT_TELEGRAM_DRIVER = 'gramjs';
/** Every value the switch accepts, in the order they are tried. */
export const KNOWN_TELEGRAM_DRIVERS = Object.freeze(['gramjs', 'teleproto']);

/** The driver each value loads, relative to this file. The gramjs path is the JavaScript the app runs today. */
const DRIVER_MODULES = Object.freeze({
  gramjs: './telegram-adapter.js',
  teleproto: './telegram/teleproto-adapter.ts',
});

/**
 * Read `TELEGRAM_DRIVER` without deciding anything.
 *
 * Trimmed and lower-cased, because Render's environment panel is a text field that people paste into, and
 * `GRAMJS` should not be a different answer from `gramjs`. An empty or whitespace-only value is the *absence* of a
 * setting rather than a wrong one - that is what clearing a row in the panel writes - so it is not reported as a
 * problem either.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {{ driver: string, requested: string | null, note: string | null }}
 */
export function parseTelegramDriverSelection(env = process.env) {
  const raw = env?.[TELEGRAM_DRIVER_ENV];
  const requested = typeof raw === 'string' && raw.trim() ? raw.trim().toLowerCase() : null;
  if (requested === null) return { driver: DEFAULT_TELEGRAM_DRIVER, requested: null, note: null };
  if (!KNOWN_TELEGRAM_DRIVERS.includes(requested)) {
    return {
      driver: DEFAULT_TELEGRAM_DRIVER,
      requested,
      note: `${TELEGRAM_DRIVER_ENV}=${JSON.stringify(raw)} is not a driver this build knows (${KNOWN_TELEGRAM_DRIVERS.join(' or ')}), so capture runs on ${DEFAULT_TELEGRAM_DRIVER}`,
    };
  }
  return { driver: requested, requested, note: null };
}

/**
 * The names the second driver must provide, taken from the driver it replaces rather than from a list.
 *
 * This is the completeness check the refusal rests on. Deriving it from `telegram-adapter.js` at call time means
 * a new operation added for the GramJS path cannot quietly go missing from the other one: the day the first file
 * grows a function, an incomplete second driver stops being hand-offable and says so, instead of failing as
 * `undefined is not a function` inside a reconnect on a workspace that had just signed in.
 *
 * @param {string} [driver] which driver name to ask about; defaults to the one a pilot would be measuring.
 * @param {Object} [options]
 * @param {{ [name: string]: string }} [options.modules] which module each driver name loads; overridable so the
 *   refusal paths below can be driven without a third driver existing, and defaulted so nothing else can.
 * @returns {Promise<{ loadable: boolean, exported: string[], missing: string[], extra: string[], error: string | null }>}
 */
export async function readTelegramDriverStatus(driver = 'teleproto', { modules = DRIVER_MODULES } = {}) {
  const specifier = modules[driver];
  if (!specifier) {
    return { loadable: false, exported: [], missing: [], extra: [], error: `unknown driver ${JSON.stringify(driver)}` };
  }
  try {
    const [requested, gramjs] = await Promise.all([import(specifier), import('./telegram-adapter.js')]);
    const wanted = Object.keys(gramjs).filter((name) => typeof gramjs[name] === 'function');
    const given = Object.keys(requested).filter((name) => typeof requested[name] === 'function');
    return {
      loadable: true,
      exported: given,
      missing: wanted.filter((name) => !given.includes(name)),
      extra: given.filter((name) => !wanted.includes(name)),
      error: null,
    };
  } catch (error) {
    return { loadable: false, exported: [], missing: [], extra: [], error: error?.message ? String(error.message) : String(error) };
  }
}

/**
 * The answer a status route or a boot log can print without importing either driver.
 *
 * @param {Record<string, string | undefined>} [env]
 */
export async function describeTelegramDriver(env = process.env) {
  const selection = parseTelegramDriverSelection(env);
  const status = selection.driver === 'gramjs' ? null : await readTelegramDriverStatus(selection.driver);
  return {
    driver: selection.driver,
    requested: selection.requested,
    note: selection.note,
    /** Whether the requested driver can actually be handed out, which for gramjs is always yes. */
    available: selection.driver === 'gramjs' ? true : status?.loadable === true && status.missing.length === 0,
    [selection.driver]: status ? { loadable: status.loadable, exported: status.exported.length, missing: status.missing, error: status.error } : null,
  };
}

/**
 * Hand back the adapter the process should use, or refuse with the reason.
 *
 * Both imports are dynamic, and the asymmetry that follows is the point: the gramjs branch loads a `.js` module,
 * which every supported runtime can do, while the fork's adapter is a `.ts` file, and loading a TypeScript file is
 * a capability of the runtime (Node 22.18+) rather than a certainty. A production boot must never fail because of
 * that difference, so the `.ts` is only ever reached by an explicit request for the driver that lives in it - and
 * the refusal is raised *before* any of its contents are used, so a runtime without type stripping fails at the
 * switch, loudly, instead of half-starting.
 *
 * @param {{ env?: Record<string, string | undefined>, log?: (level: string, message: string, extra?: unknown) => void, drivers?: { [name: string]: string } }} [options]
 * @returns {Promise<{ adapter: Record<string, unknown>, driver: string, note: string | null }>}
 */
export async function resolveTelegramAdapter({ env = process.env, log = () => {}, drivers = DRIVER_MODULES } = {}) {
  const selection = parseTelegramDriverSelection(env);
  if (selection.note) log('warn', 'Telegram driver setting could not be understood', { requested: selection.requested, fellBackTo: selection.driver });

  if (selection.driver === 'gramjs') {
    const adapter = await import(drivers.gramjs);
    return { adapter, driver: 'gramjs', note: selection.note };
  }

  const status = await readTelegramDriverStatus(selection.driver, { modules: drivers });
  if (!status.loadable) {
    log('error', 'Telegram driver could not be loaded', { driver: selection.driver, error: status.error });
    throw telegramDriverRefusal(selection.driver, 'could not be loaded by this runtime', status.error);
  }
  if (status.missing.length) {
    log('error', 'Telegram driver is missing operations the app calls', { driver: selection.driver, missing: status.missing });
    throw telegramDriverRefusal(selection.driver, `is missing ${status.missing.length} operation(s): ${status.missing.join(', ')}`, null);
  }
  const adapter = await import(drivers[selection.driver]);
  log('info', 'Telegram driver selected', { driver: selection.driver, operations: status.exported.length });
  return { adapter, driver: selection.driver, note: selection.note };
}

/**
 * The refusal, shaped so a caller can answer "which kind of no was this" without matching prose.
 *
 * There is deliberately no fallback argument: the only safe response to a driver that cannot be handed over whole
 * is a stopped boot, because the alternative is a process that believes it is capturing on the fork while it is
 * capturing on GramJS against a session the other driver wrote.
 */
/** @internal Exported so the refusal's text and code are pinned without a third driver to provoke it. */
export function telegramDriverRefusal(driver, reason, detail) {
  const error = new Error(`TELEGRAM_DRIVER=${driver} was requested, the driver ${reason}, and capture will not start on another driver instead.`
    + (detail ? ` Underneath: ${detail}` : '')
    + ` Set TELEGRAM_DRIVER=${DEFAULT_TELEGRAM_DRIVER} (or unset it) to run the driver that is wired.`);
  error.name = 'TelegramDriverUnavailableError';
  error.code = `TELEGRAM_DRIVER_${driver.toUpperCase()}_UNAVAILABLE`;
  return error;
}
