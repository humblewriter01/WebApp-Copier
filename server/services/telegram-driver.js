/**
 * The Telegram driver switch, and the only place that decides which driver a process talks to.
 *
 * A Strangler Fig is only safe if the old path cannot be disturbed by the new one, and one environment variable
 * is not a safety property on its own: it has to be *read* in one place, with one answer for a typo, and one
 * behaviour for a driver that is named but not finished. Three rules, and they are the whole file:
 *
 *  1. **Unset means gramjs.** Production behaviour is unchanged by the existence of this module, which is the
 *     promise the migration runs on: the flag defaults to the driver that is deployed today, and a missing
 *     variable is not a configuration change.
 *  2. **An unrecognised value is a log line, not a crash and not a coin flip.** A typo in a dashboard's environment
 *     panel must not take capture down, and must not be treated as "they probably meant the new one". The old
 *     driver runs, and the note says what was ignored, in the same turn, where an operator will see it.
 *  3. **A driver that is not wired is refused, never substituted.** If `TELEGRAM_DRIVER=mtcute` were allowed to
 *     fall back, then a half-ported driver plus a typo would look identical to a working deployment while the
 *     session material two layers down belonged to something else - and Telegram sessions are the one piece of
 *     state where "it kept working" and "it silently wrote to the wrong store" are indistinguishable from outside.
 *
 * Note what this module does *not* do: it is not imported by `index.js` or `services/telegram-listener.js` yet.
 * Today nothing in the running application asks it a question, so it cannot change what production does; the
 * switch becomes live in the increment that rewires those two call sites, and `test/telegram-driver.test.js` pins
 * that the resolver and the driver it returns agree before that happens.
 */
/** The variable that selects the driver, named once so a status route and a log line quote the same spelling. */
export const TELEGRAM_DRIVER_ENV = 'TELEGRAM_DRIVER';
/** What a process with no opinion runs on. Changing this is changing production. */
export const DEFAULT_TELEGRAM_DRIVER = 'gramjs';
/** Every value the switch accepts, in the order they are tried. */
export const KNOWN_TELEGRAM_DRIVERS = Object.freeze(['gramjs', 'mtcute']);

/**
 * Read `TELEGRAM_DRIVER` without deciding anything.
 *
 * Trimmed and lower-cased, because Render's environment panel is a text field that people paste into, and
 * `GRAMJS` should not be a different answer from `gramjs`.
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
 * The status of the new driver, read without assuming it can be loaded at all.
 *
 * `mtcute-adapter.ts` is a TypeScript file, and loading a TypeScript file is a capability of the runtime rather
 * than a certainty, so every reader of the ledger goes through this function and gets an answer shaped like the
 * uncertainty: `null` means "the driver's own bookkeeping could not be read here", which a boot log can print and
 * a status route can render without a second failure on top of the first.
 *
 * @returns {Promise<{ wired: boolean, pending: string[], ported: string[], blockers: Array<{ code: string, summary: string }> } | null>}
 */
export async function readMtcuteDriverStatus() {
  try {
    const module = await import('./telegram/mtcute-adapter.ts');
    const status = module.mtcuteDriverStatus();
    return { wired: status.wired === true, pending: [...status.pending], ported: [...status.ported], blockers: status.blockers.map((blocker) => ({ code: blocker.code, summary: blocker.summary })) };
  } catch (error) {
    return null;
  }
}

/**
 * The answer a status route or a boot log can print without importing either driver.
 *
 * @param {Record<string, string | undefined>} [env]
 */
export async function describeTelegramDriver(env = process.env) {
  const selection = parseTelegramDriverSelection(env);
  const status = selection.driver === 'gramjs' ? null : await readMtcuteDriverStatus();
  return {
    driver: selection.driver,
    requested: selection.requested,
    note: selection.note,
    /** Whether the requested driver can actually be handed out, which for gramjs is always yes. */
    available: selection.driver === 'gramjs' ? true : status?.wired === true,
    mtcute: status ? { wired: status.wired, pending: status.pending.length, blockers: status.blockers.map((blocker) => blocker.code) } : null,
  };
}

/**
 * Hand back the adapter the process should use, or refuse with the reason.
 *
 * Both imports are dynamic, and the asymmetry that follows is the point: the gramjs branch loads a `.js` module,
 * which every supported runtime can do; the mtcute branch loads a `.ts` module, which needs a runtime that strips
 * types. A production boot must never fail because of that difference, so the `.ts` is only ever reached by an
 * explicit request for the driver that lives in it - and the refusal is raised *before* the module's contents are
 * used for anything, so a runtime without type stripping fails at the switch, loudly, instead of half-starting.
 *
 * @param {{ env?: Record<string, string | undefined>, log?: (level: string, message: string, extra?: unknown) => void }} [options]
 * @returns {Promise<{ adapter: Record<string, unknown>, driver: string, note: string | null }>}
 */
export async function resolveTelegramAdapter({ env = process.env, log = () => {} } = {}) {
  const selection = parseTelegramDriverSelection(env);
  if (selection.note) log('warn', 'Telegram driver setting could not be understood', { requested: selection.requested, fellBackTo: selection.driver });

  if (selection.driver === 'gramjs') {
    const adapter = await import('./telegram-adapter.js');
    return { adapter, driver: 'gramjs', note: selection.note };
  }

  const status = await readMtcuteDriverStatus();
  if (!status || status.wired !== true) {
    const error = new MtcuteNotWiredErrorFrom(status);
    log('error', 'Telegram driver could not be started', {
      driver: 'mtcute',
      pending: status ? status.pending.length : null,
      blockers: status ? status.blockers.map((blocker) => blocker.code) : ['driver-module-unloadable'],
    });
    throw error;
  }
  const module = await import('./telegram/mtcute-adapter.ts');
  return { adapter: module.createMtcuteAdapter(), driver: 'mtcute', note: selection.note };
}

/**
 * The refusal, shaped by the status it was built from. `MtcuteNotWiredError` in the adapter file carries the same
 * name and message; this wrapper exists so the resolver can raise it without importing the class eagerly, which
 * is the difference between a resolver that works on any runtime and one that needs type stripping loaded first.
 */
class MtcuteNotWiredErrorFrom extends Error {
  /** @param {{ pending: string[], blockers: Array<{ code: string }> } | null} status */
  constructor(status) {
    super(
      status === null
        ? 'TELEGRAM_DRIVER=mtcute was requested, and the driver\'s own module could not be loaded by this runtime - its ledger lives in a TypeScript file, which needs a runtime that strips types.'
        : `TELEGRAM_DRIVER=mtcute was requested, and ${status.pending.length} of the driver operations it must provide are not implemented`
        + `${status.blockers.length ? ` (blockers: ${status.blockers.map((blocker) => blocker.code).join(', ')})` : ''}.`,
    );
    this.name = 'MtcuteNotWiredError';
    this.code = 'MT_CUTE_NOT_WIRED';
    this.pending = status.pending;
    this.blockers = status.blockers;
  }
}
