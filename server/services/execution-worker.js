function safeWorkerError(error) {
  return String(error?.message || 'Execution worker could not process the signal.')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/(authorization|auth[-_ ]?token|access[-_ ]?token|api[-_ ]?token|password|secret)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1000);
}

export function createExecutionWorker({ pool, engine, pollIntervalMs = 1200, staleLockMs = 5 * 60_000, logger = console }) {
  if (!pool?.connect || !pool?.query || typeof engine?.processJob !== 'function') throw new TypeError('Execution worker dependencies are incomplete.');
  let stopped = true;
  let timer = null;
  let active = null;
  let jobsSinceSweep = 0;

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
        `SELECT id,user_id,signal_id FROM execution_jobs
         WHERE status='queued' AND expires_at > NOW()
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
      }
    } catch (error) {
      logger.error?.(JSON.stringify({ level: 'error', message: 'Execution worker iteration failed', error: safeWorkerError(error) }));
    }
  }

  async function tick() {
    if (stopped) return;
    active = runOnce();
    await active;
    active = null;
    if (!stopped) {
      timer = setTimeout(tick, pollIntervalMs);
      timer.unref?.();
    }
  }

  function start() {
    if (!stopped) return;
    stopped = false;
    void tick();
  }

  async function stop() {
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = null;
    if (active) await active.catch(() => {});
  }

  return { start, stop, runOnce, claimOne };
}
