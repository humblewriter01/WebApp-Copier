/**
 * The app boots before the database does, and says so.
 *
 * This file spawns the real `server/index.js` as a child process against a fake Postgres that accepts the
 * connection and then never replies. That is the exact shape of the outage it exists to prevent: the build
 * succeeded, `node index.js` ran, and for fifteen minutes the service bound no port, logged nothing, and
 * never reached the database, so Render could only report "Port scan timeout reached, no open ports
 * detected". Against the code that caused it, the assertions below fail because nothing answers at all.
 *
 * No database, no network, and no dependency beyond Node is needed: the child is pointed at a socket on
 * localhost that we control, which is also what makes the failure deterministic.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.join(here, '..');

/** A server that accepts a connection and says nothing back: reachable, and completely unhelpful. */
function silentDatabase() {
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => sockets.delete(socket));
    socket.on('close', () => sockets.delete(socket));
  });
  return {
    server,
    listen: () => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port))),
    close: () => {
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

const freePort = () => new Promise((resolve) => {
  const probe = net.createServer();
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});

/**
 * One HTTP request that cannot hang. A plain `fetch` against a service whose health route is stalled would
 * wait forever, and the suite would wait with it, so the timeout is a property of the request: a stalled
 * handler is a failure to answer, which is what is being asserted.
 *
 * The budget is deliberately longer than the app's own database probe (1.5 s): the health route is allowed
 * to wait that long for a `SELECT 1` before it answers "unreachable", and a client that gives up sooner is
 * measuring the wrong thing.
 */
function request(port, requestPath, timeoutMs = 6_000) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: requestPath, timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('timeout', () => { req.destroy(new Error(`no response within ${timeoutMs} ms`)); });
    req.on('error', reject);
  });
}

const until = async (work, deadlineMs, label) => {
  const startedAt = Date.now();
  let lastError = null;
  while (Date.now() - startedAt < deadlineMs) {
    try {
      const value = await work();
      if (value) return value;
      lastError = new Error(`${label}: not true yet`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  throw lastError || new Error(`${label}: timed out`);
};

/** Boot the app against a stalled database and hand back everything the test needs to clean up. */
async function bootAgainstStalledDatabase() {
  const db = silentDatabase();
  const fakeDbPort = await db.listen();
  const appPort = await freePort();
  const output = { stdout: '', stderr: '' };
  const child = spawn(process.execPath, ['index.js'], {
    cwd: serverRoot,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(appPort),
      DATABASE_URL: `postgresql://stalled:stalled@127.0.0.1:${fakeDbPort}/stalled`,
      JWT_SECRET: 'boot-readiness-test-secret-value-0123456789',
      AUTO_TRADING_RUNTIME_ENABLED: 'false',
      INACTIVITY_CLEANUP_ENABLED: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => { output.stdout += chunk; });
  child.stderr.on('data', (chunk) => { output.stderr += chunk; });
  return {
    appPort,
    output: () => `${output.stdout}${output.stderr}`,
    exited: () => child.exitCode,
    stop: async () => {
      if (child.exitCode === null) { child.kill('SIGKILL'); await new Promise((resolve) => child.once('close', resolve)); }
      await db.close();
    },
  };
}

test('the port is open while the database is still stalled, and data routes say they are starting', async () => {
  const app = await bootAgainstStalledDatabase();
  try {
    // The whole point: an unanswered database must not be able to hold the port hostage.
    const answered = await until(() => request(app.appPort, '/health').catch(() => null), 15_000, 'the health route')
      .catch((error) => { throw new Error(`${error.message} | child exited=${app.exited()} | output=${app.output().slice(0, 1200)}`); });
    assert.equal(answered.status, 200, 'liveness is not the readiness question, so it is not made to fail here');

    const status = JSON.parse(answered.body);
    assert.equal(status.database, 'unknown', 'the health payload names the database as the thing that is not answering');
    assert.equal(status.startup.ready, false);
    assert.match(status.startup.step, /connect|schema|applying/, `the payload says which step is in progress, said "${status.startup.step}"`);
    assert.ok(status.gitCommit === null || typeof status.gitCommit === 'string', 'the boot stamp is still there');

    // And a real request is refused in one short sentence rather than hanging or half-working.
    const gated = await request(app.appPort, '/api/signals');
    assert.equal(gated.status, 503);
    const payload = JSON.parse(gated.body);
    assert.equal(payload.code, 'STARTING');
    assert.equal(payload.error, 'Signal Desk is still starting up. Please try again in a moment.');

    // Silence is what made the outage unreadable: the log has to say the port is up.
    await until(() => Promise.resolve(/Server listening/.test(app.output())), 5_000, 'the listening line');
    assert.equal(app.exited(), null, 'a stalled database must not take the process down with it');
  } finally {
    await app.stop();
  }
});

test('the migration retries instead of exiting, and keeps reporting the step it is stuck on', async () => {
  const app = await bootAgainstStalledDatabase();
  try {
    await until(() => Promise.resolve(/will keep trying|waiting for a lock|applying the schema/.test(app.output())), 20_000, 'a retry log line');
    const first = JSON.parse((await request(app.appPort, '/health')).body);
    assert.ok(first.startup.attempts >= 1, 'the boot counted its own attempts');
    assert.match(first.startup.step, /applying|failed|connect/);
    assert.equal(app.exited(), null, 'the process is still alive, which is what lets the next attempt land');
    await until(() => request(app.appPort, '/health').then((res) => JSON.parse(res.body)).then((body) => body.startup.attempts > first.startup.attempts || body.startup.step !== first.startup.step), 25_000, 'a second attempt');
  } finally {
    await app.stop();
  }
});
