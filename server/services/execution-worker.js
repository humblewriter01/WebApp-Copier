function safeWorkerError(error) {
  return String(error?.message || 'Execution worker could not process the signal.')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/(authorization|auth[-_ ]?token|access[-_ ]?token|api[-_ ]?token|password|secret)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1000);
}

/**
 * The queue, drained as fast as it can be and never faster than the broker's own protection sweeps.
 *
 * `pollIntervalMs` is the *idle* wait, not the delay a signal sits in: the moment the capture path writes a
 * queued job it calls `notify()`, which starts a pass on the spot. Before that wake-up existed, the first order
 * of a quiet minute waited for the next tick - up to 1.2 s of a 120 s window in which the price the channel
 * published is still the price the trader meant. A pass that claimed a job also goes straight into the next one,
 * bounded by `followUpLimit`, so a burst of signals is drained in consecutive round trips instead of one per
 * interval; the bound is what keeps a busy channel from starving the break-even and scale-out sweeps that the
 * same loop carries for positions already open.
 */
export function createExecutionWorker({ pool, engine, pollIntervalMs = 1200, staleLockMs = 5 * 60_000, logger = console, followUpLimit = 8 } = {}) {
  if (!pool?.connect || !pool?.query || typeof engine?.processJob !== 'function') throw new TypeError('Execution worker dependencies are incomplete.');
  let stopped = true;
  let timer = null;
  let active = null;
  let jobsSinceSweep = 0;
  /* Set by `notify()` when a pass is already in flight: the pass that is running goes into another one as soon
     as it finishes, so a signal arriving mid-sweep is not queued behind the next interval as well. */
  let wakeRequested = false;
  let followOns = 0;
  /* Whether a pass is in flight *for the scheduler*, which is not the same question as `active` (the promise the
     stop path awaits): between the await and the next scheduling decision the pass is over but nothing has been
     queued yet, and a `notify()` landing there must not start a second one. */
  let running = false;

  async function expireOldJobs() {
    await pool.query(
      `WITH expired AS (
         UPDATE execution_jobs SET status='expired',error_message='This signal expired before execution.',locked_at=NULL,updated_at=NOW()
         WHERE status='queued' AND expires_at <= NOW() RETURNING id,user_id,signal_id
       )
       UPDATE signals s SET status='expired' FROM expired e WHERE s.id=e.signal_id AND s.user_id=e.user_id`,
    );
  }

  async function markStaleJobsUnknown() {
    const intervalMs = Math.max(30_000, Number(staleLockMs) || 300_000);
    await pool.query(
      `WITH stale AS (
         UPDATE execution_jobs SET status='unknown',error_message='Worker stopped while an order may have been in progress. Reconcile the broker account before any manual retry.',locked_at=NULL,updated_at=NOW()
         WHERE status='processing' AND locked_at < NOW() - ($1::text || ' milliseconds')::interval
         RETURNING id,user_id,signal_id
       ), changed_trades AS (
         UPDATE trades t SET status='unknown',error_message='Execution outcome is unknown; automatic retry was blocked.'
         FROM stale s WHERE t.execution_job_id=s.id AND t.user_id=s.user_id
       )
       UPDATE signals sig SET status='unknown' FROM stale s WHERE sig.id=s.signal_id AND sig.user_id=s.user_id`,
      [intervalMs],
    );
  }

  async function claimOne() {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        /* A job whose `next_attempt_at` is in the future is waiting out a backoff, and claiming it early is
         * how a broker that asked for fewer requests gets a request anyway. `expires_at` is still the hard
         * bound, so a retry can never resurrect a signal past its own window: the deadline wins, the job
         * expires, and the reason the user reads is the one the expiry sweep wrote. */
        `SELECT id,user_id,signal_id FROM execution_jobs
         WHERE status='queued' AND expires_at > NOW()
           AND (next_attempt_at IS NULL OR next_attempt_at <= NOW())
         ORDER BY created_at ASC FOR UPDATE SKIP LOCKED LIMIT 1`,
      );
      if (!rows[0]) {
        await client.query('COMMIT');
        return null;
      }
      const { rows: claimed } = await client.query(
        `UPDATE execution_jobs SET status='processing',attempt_count=attempt_count+1,locked_at=NOW(),updated_at=NOW()
         WHERE id=$1 AND status='queued' RETURNING id,user_id,signal_id`,
        [rows[0].id],
      );
      await client.query('COMMIT');
      return claimed[0] || null;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * One protection sweep, logged and swallowed if it fails. A sweep that cannot run is a position left
   * without its protection for a few seconds; a sweep whose error escapes is the whole worker loop
   * stopped, which is every position left without it indefinitely.
   */
  async function runSweep(message, sweep, countedKey) {
    if (typeof sweep !== 'function') return;
    try {
      const result = await sweep.call(engine);
      if (result?.[countedKey]) logger.info?.(JSON.stringify({ level: 'info', message, ...result }));
    } catch (error) {
      logger.error?.(JSON.stringify({ level: 'error', message: `${message} sweep failed`, error: safeWorkerError(error) }));
    }
  }

  async function runOnce() {
    try {
      await expireOldJobs();
      await markStaleJobsUnknown();
      await engine.captureUtcDayBaselines?.();
      const job = await claimOne();
      if (job) {
        await engine.processJob(job);
        jobsSinceSweep += 1;
      } else {
        jobsSinceSweep = 0;
      }
      // Break-even stop moves share this loop so they react within a second or two of a
      // quote change. An order always goes first, because protecting an open position must
      // never delay a fresh signal, but a busy stream of signals cannot starve protection
      // either: every fifth iteration also attempts a sweep (the engine's own throttle decides). The engine throttles the sweep itself,
      // so calling it often costs nothing.
      const sweepDue = !job || jobsSinceSweep >= 5;
      if (sweepDue) {
        // Decided once, for both sweeps. Reading the counter again after the first sweep would starve
        // the second one, because the first resets it - which is how a plan would end up never swept on
        // a busy signal stream while open positions kept getting their stops moved.
        jobsSinceSweep = 0;
        await runSweep('Break-even stop moved', engine.sweepBreakEven, 'moved');
        await runSweep('Scale-out target closed', engine.sweepTakeProfitLevels, 'closed');
        /* Resting orders: cancel what has passed its expiry, and notice the ones that left the broker's book
         * by themselves. The engine throttles this to once a minute on its own, and the read is cheap next to
         * the two above, so it shares their slot rather than needing a timer of its own - which is also what
         * keeps a single stale-account failure from being able to stop the protection sweeps behind it. */
        await runSweep('Resting order sweep', engine.sweepExpiredOrders, 'attempted');
      }
      return { claimed: Boolean(job) };
    } catch (error) {
      logger.error?.(JSON.stringify({ level: 'error', message: 'Execution worker iteration failed', error: safeWorkerError(error) }));
      return { claimed: false };
    }
  }

  async function tick() {
    if (stopped || running) return;
    running = true;
    active = runOnce();
    let result;
    try {
      result = await active;
    } finally {
      active = null;
      running = false;
    }
    if (stopped) return;
    /* Two reasons to run again without waiting: somebody queued a job while this pass was working, or this pass
       took a job and there may be another one behind it. The chain is bounded twice over - `followUpLimit`
       caps how many claimed passes may follow one another, and a pass that claimed nothing resets the count -
       so a busy channel cannot hold the break-even and scale-out sweeps at arm's length. */
    const woken = wakeRequested;
    const more = result?.claimed === true && followOns + 1 < followUpLimit;
    if (woken || more) {
      followOns = more && !woken ? followOns + 1 : 0;
      wakeRequested = false;
      void tick().catch(() => {});
      return;
    }
    followOns = 0;
    wakeRequested = false;
    timer = setTimeout(() => { void tick().catch(() => {}); }, pollIntervalMs);
    timer.unref?.();
  }

  /**
   * "There is work now." Called by the capture path the instant a job is queued, and safe to call from anywhere:
   * it never runs a second pass at once, never throws, and does nothing while the worker is stopped.
   */
  function notify() {
    if (stopped) return false;
    wakeRequested = true;
    if (running) return true;
    if (timer) { clearTimeout(timer); timer = null; }
    followOns = 0;
    void tick().catch(() => {});
    return true;
  }

  function start() {
    if (!stopped) return;
    stopped = false;
    void tick().catch(() => {});
  }

  async function stop() {
    stopped = true;
    wakeRequested = false;
    followOns = 0;
    if (timer) clearTimeout(timer);
    timer = null;
    if (active) await active.catch(() => {});
  }

  return { start, stop, runOnce, claimOne, notify };
}
