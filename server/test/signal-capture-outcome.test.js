import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  decideSignalOutcome,
  signalStatusForJobStatus,
  SIGNAL_STATUSES,
  UPGRADE_REQUIRED_NOTE,
} from '../services/signal-outcome.js';
import { createExecutionEngine } from '../services/execution-engine.js';

const index = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
// The capture loop moved into its own module so that a test can drive an update through it. The
// invariants this file guards - storage before any execution decision, no plan gate in the listener -
// are worth keeping, but they now live in the service, not in the routing file.
const listenerSource = readFileSync(new URL('../services/telegram-listener.js', import.meta.url), 'utf8');
const engineSource = readFileSync(new URL('../services/execution-engine.js', import.meta.url), 'utf8');

function section(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `${startMarker} is missing from the source`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  return source.slice(start, end === -1 ? source.length : end);
}

const saveSignalBody = section(index, 'async function saveSignal(', '\nconst telegramCapture = createTelegramListener(');
const listenerBody = section(listenerSource, 'async function ingestMessage(', '  /**\n   * Attach the capture handler');
const settingsPut = section(index, "app.put('/api/settings'", '\napp.get(\'/api/trades\'');

const eligible = {
  executionReady: true,
  autoTradingEnabled: true,
  runtimeEnabled: true,
  paused: false,
  subscriptionStatus: 'active',
  accountSelected: true,
  accountState: 'DEPLOYED',
};

test('a free workspace with no trading account is an unexecuted signal, never a missing one', () => {
  const outcome = decideSignalOutcome({
    executionReady: true,
    autoTradingEnabled: true,
    runtimeEnabled: true,
    paused: false,
    subscriptionStatus: undefined,
    accountSelected: false,
    accountState: undefined,
  });
  assert.equal(outcome.status, SIGNAL_STATUSES.unexecuted);
  assert.equal(outcome.queue, false);
  assert.equal(outcome.upgradeRequired, true);
  assert.equal(outcome.note, UPGRADE_REQUIRED_NOTE);
  // The sentence has to name the action the user can take, not just refuse them.
  assert.match(outcome.note, /Upgrade to Starter or higher/);
  assert.match(outcome.note, /saved for review/);
});

test('every condition that stops execution explains itself in the note', () => {
  const cases = [
    [{ accountSelected: false }, /No trading account is selected/],
    [{ accountState: 'STOPPED' }, /not deployed/],
    [{ runtimeEnabled: false }, /unavailable on this service/],
    [{ paused: true }, /paused by Signal Desk/],
    [{ autoTradingEnabled: false }, /Auto-Trading is off/],
  ];
  for (const [override, pattern] of cases) {
    const outcome = decideSignalOutcome({ ...eligible, ...override });
    assert.equal(outcome.status, 'autoTradingEnabled' in override ? SIGNAL_STATUSES.received : SIGNAL_STATUSES.unexecuted, JSON.stringify(override));
    assert.equal(outcome.queue, false);
    assert.match(outcome.note, pattern);
  }
});

test('only a fully eligible Telegram signal is queued, and a hand-written note never is', () => {
  assert.deepEqual(
    { ...decideSignalOutcome(eligible), note: undefined },
    { status: SIGNAL_STATUSES.queued, queue: true, note: undefined },
  );
  const manual = decideSignalOutcome({ ...eligible, manual: true });
  assert.equal(manual.status, SIGNAL_STATUSES.received);
  assert.equal(manual.note, null);
  assert.equal(manual.queue, false);
  const unparsed = decideSignalOutcome({ ...eligible, executionReady: false });
  assert.equal(unparsed.status, SIGNAL_STATUSES.unparsed);
  assert.equal(unparsed.note, null);
});

test('capture runs before any execution decision, so a signal cannot be lost to a plan or an account', () => {
  assert.ok(saveSignalBody.includes('INSERT INTO signals'), 'the signal must be inserted');
  assert.ok(saveSignalBody.includes('ON CONFLICT DO NOTHING'), 'a redelivered Telegram message stays a single row');
  assert.equal(
    saveSignalBody.indexOf('INSERT INTO signals') < saveSignalBody.indexOf('decideSignalOutcome'),
    true,
    'the execution outcome is recorded after the message is already saved, never as a condition for saving it',
  );
  // No branch may skip the insert because of plan, accounts, the runtime or the kill switch.
  const beforeInsert = saveSignalBody.slice(0, saveSignalBody.indexOf('INSERT INTO signals'));
  for (const blocked of ['isPaidSubscriber', 'subscription_status', 'metaapi_accounts', 'platformControls', 'autoTradingRuntimeEnabled']) {
    assert.equal(beforeInsert.includes(blocked), false, `${blocked} must not gate whether a signal is stored`);
  }
  assert.doesNotMatch(saveSignalBody, /return fail\(/, 'saving a signal never answers with an error');
});

test('the Telegram listener only needs an enabled channel, never a plan or a connected broker', () => {
  // The chat is matched by every spelling of its id, because a monitored channel row and an incoming
  // message do not reliably agree on whether the `-100` mark is present.
  assert.match(listenerBody, /FROM channels\b[\s\S]*WHERE user_id=\$1 AND enabled=TRUE AND channel_id = ANY\(\$2::text\[\]\)/);
  for (const blocked of ['isPaidSubscriber', 'subscription', 'metaapi', 'planLimits', 'platformControls', 'auto_trading_enabled']) {
    assert.equal(listenerBody.includes(blocked), false, `the listener must not consult ${blocked}`);
  }
  assert.ok(listenerBody.includes('await saveSignal('), 'a matching channel message is saved unconditionally');
});

/* The defect these tests exist for: the listener read one accessor for the chat id, compared it with one
   exact string, and returned. Every live message was dropped with no row, no error, and no log line - so
   the panel said "Waiting for signals" forever while manual entry kept working. */
test('a live message is never dropped without saying where it went', () => {
  assert.match(listenerBody, /resolveTelegramChatId\(message, event\)/, 'the id is read from every accessor GramJS fills in');
  assert.match(listenerBody, /const text = telegramMessageText\(message\)/, 'the body is read from every field this update type carries');
  assert.equal(/const chatId = message\?\.chatId\?\.toString\(\)/.test(listenerBody), false, 'one accessor is exactly how every message went missing');
  assert.equal(/if \(!chatId \|\| !text\) return;/.test(listenerBody), false, 'an unreadable message is logged, not abandoned');
  for (const line of [
    "'Telegram message captured'",
    "'Telegram message ignored: that chat is not monitored'",
    "'Telegram message carried no text to read'",
    "'Telegram message had no chat id to match on'",
  ]) {
    assert.ok(listenerBody.includes(line), `the listener states what it did with the message: ${line}`);
  }
  // and the counters survive into the status route, so "is it even listening?" has an answer
  const statusRoute = section(index, "app.get('/api/telegram/status'", 'async function persistTelegramLoginAttempt');
  assert.match(index, /void resumeTelegramSessions\(\{ reason: 'boot' \}\)/, 'sessions are re-armed at boot, without waiting for someone to open the dashboard');
  assert.match(statusRoute, /listening: Boolean\(entry\?\.client\?\.connected && entry\.handler && telegramCapture\.handlerIsLive\(entry\.client, entry\.handler\)\)/, 'listening is read from GramJS\'s handler list, not from a flag of ours');
  assert.match(statusRoute, /messagesSeen|signalsSaved/, 'the panel can tell a silent listener from a quiet channel');
  assert.match(statusRoute, /await startTelegramListener\(req\.userId, entry\.client\)/, 'a connected client with no live handler is attached on the spot');
});

test('the safety nets are read before the row is written, and the decision is not made twice', () => {
  /* Capture decides eligibility by asking the same policy the engine will consult at send time. Two
     copies of that rule is how a signal ended up queued as executable and then refused, or blocked at
     the row while a perfectly usable fallback sat in settings. */
  assert.match(saveSignalBody, /captureSafety\(\{ parsed, source, settings: guard, review \}\)/, 'the shared policy is the only one allowed to decide, and the review flag is an input to it rather than a second opinion afterwards');
  /* Both layers run in exactly one place, and the capture path is it. A second `parseSignal` call would be
     the same mistake in a new costume: two readings of one message, one of which the row does not have. */
  assert.match(saveSignalBody, /parseSignalTwoLayer\(savedText, \{ source, config: parserConfig/, 'the row is written from the merged reading, not from Layer 1 alone');
  assert.equal(/(?:^|[^.\w])parseSignal\(/.test(saveSignalBody), false, 'capture never calls the deterministic layer directly');
  assert.match(saveSignalBody, /const executionReady = safety\.executionReady === true/);
  assert.match(saveSignalBody, /const parseError = safety\.parseError \|\| null/);
  for (const dropped of ['isBlockedOnlyByStopLoss', 'allowMissingStopLoss']) {
    assert.equal(saveSignalBody.includes(dropped), false, `${dropped} is the old inline copy of the rule`);
  }
  const beforeInsert = saveSignalBody.slice(0, saveSignalBody.indexOf('INSERT INTO signals'));
  for (const read of ['lot_size_mode', 'block_execution_without_stop_loss', 'block_execution_without_take_profit', 'fallback_stop_loss_points', 'fallback_take_profit_points']) {
    assert.match(beforeInsert, new RegExp(read), `the policy needs ${read} from the settings row`);
  }
  assert.equal(beforeInsert.includes('auto_trading_enabled'), false, 'the capture decision never reads the trading switch');
  assert.equal(/pool\.query\(\s*'UPDATE settings/.test(beforeInsert), false, 'reading the guard never writes to settings');
  // The inferred direction is stored with the signal, so the badge survives a reload.
  assert.match(saveSignalBody, /direction_inferred AS "directionInferred"/);
  assert.match(saveSignalBody, /parsed\.directionInferred === true/);
});

test('the outcome is read back by every surface that lists signals', () => {
  assert.equal((index.match(/execution_note AS "executionNote"/g) || []).length >= 3, true, 'signals list, dashboard and the save path all carry the note');
  assert.match(index, /const queued = outcome\.queue === true|if \(outcome\.queue\) \{/);
  assert.match(index, /UPDATE signals SET status=\$2,execution_note=\$3 WHERE id=\$1 RETURNING status,execution_note AS "executionNote"/);
});

test('a skipped job is an unexecuted signal, and a trade clears the stale reason', () => {
  assert.equal(signalStatusForJobStatus('skipped'), SIGNAL_STATUSES.unexecuted);
  assert.equal(signalStatusForJobStatus('expired'), SIGNAL_STATUSES.expired);
  assert.equal(signalStatusForJobStatus('unknown'), SIGNAL_STATUSES.unknown);
  assert.equal(signalStatusForJobStatus('executed'), 'executed');
  assert.equal(signalStatusForJobStatus(undefined), SIGNAL_STATUSES.received);
  assert.match(engineSource, /UPDATE signals SET status=\$1,execution_note=\$2 WHERE id=\(SELECT signal_id FROM execution_jobs WHERE id=\$3 AND user_id=\$4\)/);
});

const baseItem = {
  job_id: 'job-1', user_id: 'user-1', job_status: 'processing', expires_at: new Date(Date.now() + 120000),
  signal_id: 'signal-1', source: 'telegram', signal_created_at: new Date(), symbol: 'EURUSD', side: 'buy',
  entry_price: null, stop_loss: 1.09, take_profit: 1.12, execution_ready: true, parse_error: null,
  auto_trading_enabled: true, lot_size_mode: 'fixed', fixed_lot_size: 0.01, risk_percent: 1,
  max_open_positions: 3, max_daily_trades: 10, daily_loss_limit: 5, execution_account_id: 'account-1',
  metaapi_account_id: 'account-1', managed_by_app: true, account_state: 'DEPLOYED',
  subscription_status: 'active', subscription_plan: 'pro',
};

function fakePool(subscriptionStatus) {
  const calls = [];
  return {
    calls,
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes('SELECT ej.id AS job_id')) return { rows: [{ ...baseItem, subscription_status: subscriptionStatus }] };
      if (sql.includes('SELECT auto_trading_enabled AS "autoTradingEnabled"')) return { rows: [{ autoTradingEnabled: true, executionAccountId: 'account-1' }] };
      if (sql.includes('SELECT baseline_equity')) return { rows: [{ baseline_equity: 1000 }] };
      if (sql.includes('SELECT COUNT(*)::int AS count FROM trades')) return { rows: [{ count: 0 }] };
      if (sql.includes('INSERT INTO trades')) return { rows: [{ id: 'trade-1' }] };
      return { rows: [], rowCount: 1 };
    },
  };
}

function fakeTrading() {
  const calls = [];
  return {
    calls,
    async getAccountState() {
      return {
        account: { state: 'DEPLOYED' }, accountInformation: { balance: 1000, equity: 1000 },
        positions: [], orders: [], deals: [],
        specification: { symbol: 'EURUSD', minVolume: 0.01, maxVolume: 20, volumeStep: 0.01, tickSize: 0.0001 },
        price: { bid: 1.1, ask: 1.1002, lossTickValue: 1, time: new Date().toISOString() },
      };
    },
    async createMarketOrder(order) {
      calls.push(order);
      return { stringCode: 'TRADE_RETCODE_DONE', numericCode: 10009, orderId: 'broker-order-1', positionId: 'broker-position-1' };
    },
  };
}

test('the engine records why a free plan was not executed, on the signal the user reads', async () => {
  const pool = fakePool('incomplete');
  const trading = fakeTrading();
  const engine = createExecutionEngine({ pool, trading, resolveToken: async () => 'fake-token', runtimeEnabled: true, isTradingPaused: async () => false });
  const result = await engine.processJob({ id: 'job-1', user_id: 'user-1' });
  assert.equal(result.status, 'skipped');
  assert.equal(trading.calls.length, 0, 'a free plan never reaches the broker');
  const signalUpdate = pool.calls.find(({ sql }) => sql.includes('UPDATE signals SET status'));
  assert.ok(signalUpdate, 'the signal row is updated with the outcome');
  assert.equal(signalUpdate.params[0], 'unexecuted');
  assert.match(signalUpdate.params[1], /needs a paid plan|paid plan/);
  const jobUpdate = pool.calls.find(({ sql }) => sql.includes('UPDATE execution_jobs'));
  assert.equal(jobUpdate.params[0], 'skipped', 'the job keeps its own vocabulary');
});

test('a paid workspace that does reach the broker has no warning note left on the signal', async () => {
  const pool = fakePool('active');
  const trading = fakeTrading();
  const engine = createExecutionEngine({ pool, trading, resolveToken: async () => 'fake-token', runtimeEnabled: true, isTradingPaused: async () => false });
  await engine.processJob({ id: 'job-1', user_id: 'user-1' });
  const signalUpdate = pool.calls.filter(({ sql }) => sql.includes('UPDATE signals SET status')).pop();
  assert.equal(signalUpdate.params[0], 'executed');
  assert.equal(signalUpdate.params[1], null);
  assert.equal(trading.calls.length, 1);
});

test('the execution switches belong to every workspace, with the live-money acknowledgement as the only gate', () => {
  assert.doesNotMatch(settingsPut, /isPaidSubscriber/, 'no plan check may stand between a user and their own switches');
  assert.doesNotMatch(settingsPut, /PLAN_REQUIRED/);
  assert.match(settingsPut, /hasAcceptedRiskWarning/);
  assert.match(settingsPut, /Confirm the live-trading warning before Auto-Trading is turned on\. Nothing has been changed\./);
  assert.match(settingsPut, /has_accepted_risk_warning=EXCLUDED\.has_accepted_risk_warning/);
  assert.match(settingsPut, /if \(previousRows\[0\]\?\.hasAcceptedRiskWarning === true\) hasAcceptedRiskWarning = true;/);
  // The engine still refuses the order itself, which is where the plan limit actually lives.
  assert.match(engineSource, /if \(!isPaidSubscriber\(\{ subscription_status: item\.subscription_status \}\)\) \{/);
});
