import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  decideSignalOutcome,
  signalStatusForJobStatus,
  overlayLiveBlocker,
  EXECUTION_BLOCKER_NOTES,
  AUTO_TRADING_OFF_NOTE,
  PLAN_NO_EXECUTION_NOTE,
  NO_ACCOUNT_NOTE,
  ACCOUNT_NOT_READY_NOTE,
  SIGNAL_STATUSES,
  UPGRADE_REQUIRED_NOTE,
} from '../services/signal-outcome.js';
import { createExecutionEngine } from '../services/execution-engine.js';
import { captureSafety } from '../services/signal-safety.js';

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

test('the capture path asks the database for the switch on every message, and remembers nothing between them', () => {
  /* "Auto-Trading is toggled on but the signal was saved for review" is a staleness accusation, and the only
     answer that closes it is where the number comes from. The read lives inside `saveSignal`, below the INSERT
     and above the decision, so it happens once per captured message - and the decision is built from that
     row, not from anything held in a variable between calls. A cache here would be defensible design (a
     setting that changes mid-signal is its own hazard), but it does not exist, and this pin is what keeps
     somebody from adding one quietly. */
  const readAt = saveSignalBody.indexOf('pool.query(SIGNAL_OUTCOME_CONTEXT_SQL, [userId])');
  assert.ok(readAt > 0, 'the workspace switch is read from `settings` inside saveSignal, through the one statement built for it');
  assert.ok(readAt < saveSignalBody.indexOf('decideSignalOutcome({'), 'before the outcome is decided');
  assert.ok(readAt > saveSignalBody.indexOf('INSERT INTO signals'), 'and after the row is stored, so a toggle during a slow parse is answered from the state at the moment of the annotation');
  assert.match(saveSignalBody, /const \[contextResult, pausedNow\] = await Promise\.all\(\[/, 'the switch read and the kill-switch read are issued in one window, not two');
  assert.match(saveSignalBody, /autoTradingEnabled: context\.autoTrading === true/, 'and the decision is built from that read');
  assert.match(saveSignalBody, /accountSelected: Boolean\(context\.executionAccountId\)/, 'as is whether an account is selected at all');
  assert.equal(/let (cached)?autoTrading\b/.test(index), false, 'no module-level copy of the switch exists to go stale');
  // The statement itself lives beside the decision it feeds, and the routes that *display* signals read the
  // same one: a banner and a row that disagree about the account are only possible if they ask separately.
  const outcomeService = readFileSync(new URL('../services/signal-outcome.js', import.meta.url), 'utf8');
  assert.match(outcomeService, /export const SIGNAL_OUTCOME_CONTEXT_SQL = `SELECT s\.auto_trading_enabled AS "autoTrading"/, 'the aliases are quoted, or Postgres folds them and the read silently returns undefined');
  assert.match(outcomeService, /AS "executionAccountId",[\s\S]*AS "accountState",u\.subscription_status AS "subscriptionStatus",u\.id AS "userId"/, 'every one of them');
  assert.equal((index.match(/pool\.query\(SIGNAL_OUTCOME_CONTEXT_SQL/g) || []).length, 1, 'the capture asks once per message, and keeps no other copy of the read');
  assert.match(index, /createSignalOutcomeReader\(\{/, 'the routes that display rows go through the reader beside the decision it feeds, rather than a second one here');
  assert.equal((outcomeService.match(/pool\.query\(SIGNAL_OUTCOME_CONTEXT_SQL/g) || []).length, 1, 'and that reader issues the statement exactly once, for every list it is applied to');
  /* The one auto-trading value that IS read once, at boot, is the deployment's runtime flag - and it is used
     as itself, never as the user\'s switch. Conflating the two is how "it is on but nothing trades" starts. */
  assert.match(saveSignalBody, /runtimeEnabled: autoTradingRuntimeEnabled/, 'the runtime flag is passed separately');
  assert.equal(/runtimeEnabled: settings\.autoTrading|autoTradingEnabled: autoTradingRuntimeEnabled/.test(index), false);
});

/**
 * A fake result set keyed the way Postgres keys one.
 *
 * The whole reason this exists: an unquoted alias is folded to lowercase by the server, so
 * `AS autoTrading` arrives as `autotrading`, `row.autoTrading` is `undefined`, `undefined === true` is false,
 * and a workspace with its switch ON is decided as though it were OFF. Every fake pool in the suite handed
 * back exactly the camelCase keys the code asked for, so three releases of this bug passed their tests.
 * This one reads the aliases out of the statement it is handed and folds the unquoted ones, which makes the
 * projection itself part of the contract under test.
 */
function foldedRow(sql, source) {
  const lookup = new Map(Object.entries(source).map(([key, value]) => [key.toLowerCase(), value]));
  const list = sql.slice(sql.search(/\bSELECT\b/i) + 6, sql.search(/\bFROM\b/i));
  const row = {};
  for (const part of list.split(',')) {
    const token = part.replace(/`/g, '').trim();
    if (!token) continue;
    const aliased = /\sAS\s+("(?:[^"]+)"|[A-Za-z_]\w*)$/i.exec(token);
    if (!aliased) {
      const bare = /^[a-z_][a-z0-9_]*$/i.exec(token.includes('.') ? token.split('.').pop() : token);
      if (bare) row[bare[1].toLowerCase()] = lookup.get(bare[1].toLowerCase()) ?? null;
      continue;
    }
    const raw = aliased[1];
    const key = raw.startsWith('"') ? raw.slice(1, -1) : raw.toLowerCase();
    row[key] = lookup.get(key.toLowerCase()) ?? null;
  }
  return row;
}

test('the capture-time safety switches survive the round trip they are read on', () => {
  /* The other statement with unquoted aliases in it, and the one with money on it: `captureSafety` is handed
     `settings.<camelCase>` for the two block-unless switches and the fallback distances, and folded keys made
     all five `undefined` - a workspace that refuses to capture a signal without a stop loss silently looked
     like one that allowed it. Same fake database as in `signal-live-blocker-read.test.js`. */
  const guardSql = /const guardSql = '([^']+)'/.exec(saveSignalBody)?.[1];
  assert.ok(guardSql, 'the capture reads its strictness from `settings` in one statement');
  const folded = foldedRow(guardSql, {
    lotSizeMode: 'risk_percent',
    blockExecutionWithoutStopLoss: true,
    blockExecutionWithoutTakeProfit: false,
    fallbackStopLossPoints: 500,
    fallbackTakeProfitPoints: 700,
  });
  assert.equal(folded.blockExecutionWithoutStopLoss, true, 'the switch that must fail closed arrives as a true value');
  assert.equal(folded.fallbackStopLossPoints, 500);
  assert.equal(folded.lotSizeMode, 'risk_percent');
  assert.equal(Object.values(folded).includes(undefined), false, 'and nothing is read as a missing key');

  const safety = captureSafety({ parsed: { side: 'buy', symbol: 'EURUSD', entryPrice: 1.08, stopLoss: null, takeProfit: 1.12 }, source: 'telegram', settings: folded, review: {} });
  assert.equal(safety.blocked === true || /stop/.test(String(safety.reason || '') + JSON.stringify(safety)), true,
    'a workspace that blocks signals without a stop loss is obeyed, not quietly overruled by a folded column name');
});

test('the four states of the workspace produce exactly the four sentences, in this order', () => {
  /* A switch that is on is not a promise that anything will trade, and the row has to say which of the four
     states it is in. Each sentence is pinned verbatim: these are the words a trader reads on a phone, and the
     one thing that must never happen is a row explaining a condition that is not the one in front of them. */
  const cases = [
    {
      name: 'Auto-Trading actually off',
      input: { autoTradingEnabled: false },
      note: 'Auto-Trading is off, so this signal was saved for review only.',
      status: SIGNAL_STATUSES.received,
    },
    {
      name: 'Free plan, no paid execution',
      input: { autoTradingEnabled: true, subscriptionStatus: 'free' },
      note: 'Auto-Trading is on, but your plan does not include automatic execution. Upgrade to execute signals.',
      status: SIGNAL_STATUSES.unexecuted,
    },
    {
      name: 'Paid plan, no trading account connected',
      input: { autoTradingEnabled: true, subscriptionStatus: 'active', accountSelected: false, accountState: undefined },
      note: 'Auto-Trading is on, but no trading account is connected. Connect one to execute signals.',
      status: SIGNAL_STATUSES.unexecuted,
    },
    {
      name: 'Everything set',
      input: { autoTradingEnabled: true, subscriptionStatus: 'active', accountSelected: true, accountState: 'DEPLOYED' },
      note: null,
      status: SIGNAL_STATUSES.queued,
    },
  ];
  for (const entry of cases) {
    const outcome = decideSignalOutcome({ executionReady: true, runtimeEnabled: true, paused: false, ...entry.input });
    assert.equal(outcome.note, entry.note, `${entry.name} says exactly its own sentence`);
    assert.equal(outcome.status, entry.status, `${entry.name} is recorded as ${entry.status}`);
    assert.equal(outcome.queue, entry.status === SIGNAL_STATUSES.queued, `${entry.name} queues only when nothing blocks it`);
  }
});

test('the account and plan sentences win over the switch sentence, because that is what is actually blocking', () => {
  // The bug this pins: a row that read "Auto-Trading is off" beside a banner reading "Auto-Trading is ON, but
  // no trading account is connected". `Auto-Trading is off` is only ever the sentence for a switch that is off;
  // with the switch on, the row must name the plan or the account.
  const on = { executionReady: true, autoTradingEnabled: true, runtimeEnabled: true, paused: false };
  assert.equal(decideSignalOutcome({ ...on, subscriptionStatus: 'free', accountSelected: false }).note, PLAN_NO_EXECUTION_NOTE,
    'an unpaid workspace is told to upgrade before it is told to connect an account, because paying is the step that makes an account possible');
  assert.equal(decideSignalOutcome({ ...on, subscriptionStatus: 'active', accountSelected: false }).note, NO_ACCOUNT_NOTE);
  assert.equal(decideSignalOutcome({ ...on, subscriptionStatus: 'active', accountSelected: true, accountState: 'STOPPED' }).note, ACCOUNT_NOT_READY_NOTE);
  assert.equal(/Auto-Trading is off/.test(decideSignalOutcome({ ...on, accountSelected: false }).note), false,
    'and the switch sentence never appears for a switch that is on');
  assert.equal(decideSignalOutcome({ ...on, autoTradingEnabled: undefined }).note, AUTO_TRADING_OFF_NOTE,
    'a workspace with no settings row at all is treated as off, which is what the column default says');
});

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
  assert.match(outcome.note, /Upgrade to execute signals/);
  assert.match(outcome.note, /Auto-Trading is on/, 'and it says so from a switch that is on, so it cannot be misread as a disabled toggle');
});

test('every condition that stops execution explains itself in the note', () => {
  const cases = [
    [{ accountSelected: false }, /no trading account is connected/],
    [{ accountState: 'STOPPED' }, /not connected yet/],
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

test('a blocked row is re-read live when it is displayed, and a note from anywhere else is left alone', () => {
  const blocked = {
    source: 'telegram', telegramMessageId: '41', executionReady: true,
    status: SIGNAL_STATUSES.unexecuted, executionNote: AUTO_TRADING_OFF_NOTE,
  };
  const nowReady = { autoTradingEnabled: true, runtimeEnabled: true, paused: false, subscriptionStatus: 'active', accountSelected: true, accountState: 'DEPLOYED' };
  assert.equal(overlayLiveBlocker(blocked, nowReady).executionNote, null, 'the row stops accusing a switch that is on once nothing blocks it');
  assert.equal(overlayLiveBlocker(blocked, nowReady).status, SIGNAL_STATUSES.unexecuted, 'and only the sentence changes: whether an order went out is a fact about the past');
  assert.equal(overlayLiveBlocker(blocked, { ...nowReady, accountSelected: false }).executionNote, NO_ACCOUNT_NOTE, 'with an account still missing it says so instead');
  const mirrored = { ...blocked, executionNote: 'The broker declined this order. Check your account and try again.' };
  assert.equal(overlayLiveBlocker(mirrored, { ...nowReady, accountSelected: false }), mirrored, 'a note the engine wrote about a real order is nobody else\'s to rewrite');
  const unready = { source: 'telegram', telegramMessageId: '42', executionReady: false, status: SIGNAL_STATUSES.unparsed, executionNote: null };
  assert.equal(overlayLiveBlocker(unready, nowReady), unready, 'a row nothing could be executed from has no execution state to report');
  const handWritten = { source: 'manual', executionReady: true, status: SIGNAL_STATUSES.received, executionNote: null };
  assert.equal(overlayLiveBlocker(handWritten, nowReady), handWritten, 'and a note a person typed for themselves is never annotated');
  assert.deepEqual(overlayLiveBlocker({ ...blocked, executionNote: null }, { ...nowReady, accountSelected: false }), { ...blocked, executionNote: null },
    'a row that was never given a blocker sentence is not given one on the way past the reader either');
  assert.ok(EXECUTION_BLOCKER_NOTES.every((note) => typeof note === 'string' && note.length > 20), 'the registry the overlay keys on is made of sentences, not codes');
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

test('a queued signal is handed to the worker on the spot, and the emit is not held up by the order', () => {
  const queueAt = saveSignalBody.indexOf("INSERT INTO execution_jobs(user_id,signal_id,status,expires_at)");
  const notifyAt = saveSignalBody.indexOf('executionWorker.notify()');
  const emitAt = saveSignalBody.indexOf("emit('signal:received'");
  assert.ok(queueAt > 0 && notifyAt > queueAt, 'the wake-up follows the statement that put the job in the table, and cannot run before there is anything to claim');
  assert.ok(emitAt > notifyAt, 'and it is fire-and-forget: the row reaches the browser on the same tick, not after the broker answers');
  assert.equal(/await executionWorker\.notify|notify\(\)\.then/.test(saveSignalBody), false, 'nothing awaits it, so a slow order cannot delay a delivery');
  assert.ok(saveSignalBody.indexOf('if (outcome.queue) {') < notifyAt, 'inside the queueing branch only - a row that will never trade does not wake the loop');
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
  assert.match(index, /UPDATE signals SET status=\$2,execution_note=\$3,technical_note=COALESCE\(\$4,technical_note\) WHERE id=\$1 RETURNING status,execution_note AS "executionNote"/);
});

test('the technical half of a row is written for the admin panel and read by nobody else', () => {
  /* `signals.technical_note` exists so that a status code, a provider body or a stack frame can be kept without
     ever being the sentence a trader reads. That is only true while no user-facing SELECT picks it up, so the
     boundary is a test rather than a habit: the admin column list has it, the capture statements write it, and
     the routes a browser polls - plus the payload pushed over the socket - do not read it. */
  assert.ok(index.includes('s.technical_note AS "technicalNote"'), 'the admin signal list reads it, which is the point of the column');
  assert.match(index, /entry_range,technical_note,sent_at\)\n\s+VALUES\(\$1,\$2,\$3,\$4,\$5,\$6,\$7,\$8,\$9,\$10,\$11,\$12,\$13,\$14,\$15,\$16::jsonb,\$17,\$18,\$19,\$20,\$21,\$22,\$23,\$24,\$25,\$26::jsonb,\$27,\$28::timestamptz\)/, 'the capture writes it, and the channel clock rides along in the same statement');
  assert.match(index, /channel\.sentAt \? new Date\(channel\.sentAt\) : null\],/, 'the bound value is the time the channel posted, and a source without one stores NULL rather than "just now"');
  const userReads = ["app.get('/api/signals'", "app.get('/api/dashboard'", "const dashboardColumns"];
  for (const marker of userReads) {
    const at = index.indexOf(marker);
    if (at === -1) continue;
    const block = index.slice(at, index.indexOf("res.set('Cache-Control'", at));
    assert.equal(block.includes('technical_note'), false, `${marker} never selects the technical half`);
  }
  assert.equal((index.match(/technical_note AS "technicalNote"/g) || []).length, 1, 'one SELECT in the whole server reads it back, and it is the admin one');
  assert.match(index, /io\.to\(`user:\$\{userId\}`\)\.emit\('signal:received', signal\);/, 'the socket pushes the object the capture RETURNING produced');
  assert.equal(/RETURNING[^']*technical_note/.test(index), false, 'and no RETURNING list of a capture statement carries it, so nothing pushed or POSTed can contain it');
});

test('a skipped job is an unexecuted signal, and a trade clears the stale reason', () => {
  assert.equal(signalStatusForJobStatus('skipped'), SIGNAL_STATUSES.unexecuted);
  assert.equal(signalStatusForJobStatus('expired'), SIGNAL_STATUSES.expired);
  assert.equal(signalStatusForJobStatus('unknown'), SIGNAL_STATUSES.unknown);
  assert.equal(signalStatusForJobStatus('executed'), 'executed');
  assert.equal(signalStatusForJobStatus(undefined), SIGNAL_STATUSES.received);
  assert.match(engineSource, /UPDATE signals SET status=\$1,execution_note=\$2,technical_note=COALESCE\(\$3,technical_note\) WHERE id=\(SELECT signal_id FROM execution_jobs WHERE id=\$4 AND user_id=\$5\)/,
    'and the mirror that moves the status carries both halves of the reason');
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

test('the zone a message published is stored beside the bound the row was credited with', () => {
  /* Two decisions are taken after capture from this column - the order that must be refused once the market
     has run through the range, and the row that has to show what was offered - and both read the stored value
     rather than re-parsing the message. So the write is pinned here: a row that lost its zone would quietly
     go back to trading a dead setup as a bargain. */
  assert.match(saveSignalBody, /is_scalping,entry_range,technical_note,sent_at\)/, 'the INSERT carries the column');
  assert.match(saveSignalBody, /\$26::jsonb,\$27/, 'as jsonb, like the target ladder beside it, with the admin-only half last');
  assert.match(saveSignalBody, /entryRangeValue\(parsed\),/, 'from the parse, not from a re-read of the message');
  assert.match(saveSignalBody, /entry_range AS "entryRange"/, 'and the row read back has it, so the client sees the row that was written');

  const helper = section(index, 'function entryRangeValue(parsed) {', '\nasync function saveSignal(');
  assert.match(helper, /entryRangeBounds\(parsed\?\.entryRange\)/, 'normalised through the same reader the execution engine uses');
  assert.match(helper, /JSON\.stringify\(bounds\)/, 'stored as the two bounds');
  assert.match(helper, /return bounds \? JSON\.stringify\(bounds\) : null/, 'and NULL for a message that named a single price');
});

/* ------------------------------------------------------------------- the channel's own clock ------------------------------------------------------

   `signals.created_at` is the moment we wrote the row, and nothing else. As long as that was the only
   timestamp, two very different failures looked identical in the database and identical in the logs - a
   channel that had simply not posted, and a session that was connected, "listening", and deaf - and the
   second one was invisible until someone watched a dashboard. Storing the Telegram send time is what makes
   the difference measurable after the fact; ageing the execution guard off it is what stops a five-minute-late
   entry being traded as though it had just been posted.

   ------------------------------------------------------------------------------------------------------------------------------------------ */

test('a late capture is stored as late, and the execution guard reads the channel clock rather than ours', () => {
  const schema = readFileSync(new URL('../db.js', import.meta.url), 'utf8');
  assert.match(schema, /ALTER TABLE signals ADD COLUMN IF NOT EXISTS sent_at TIMESTAMPTZ;/,
    'the column is added idempotently, so an existing workspace gains it on the next boot without a migration step');
  assert.equal(/ALTER TABLE signals ADD COLUMN IF NOT EXISTS sent_at[^;]*;[^;]*ALTER TABLE signals ADD COLUMN IF NOT EXISTS sent_at/.test(schema), false,
    'once, in one statement');

  assert.match(saveSignalBody, /sent_at\)/, 'the capture writes it');
  assert.match(saveSignalBody, /channel\.sentAt \? new Date\(channel\.sentAt\) : null/,
    'from the update, or NULL when the source has no send time - never from the wall clock, which would defeat the column');

  // The bound that decides whether a signal is still tradable is the one place this changes behaviour, and it
  // changes it in the direction of refusing: a row written just now about a price from six minutes ago is stale.
  assert.match(engineSource, /COALESCE\(s\.sent_at, s\.created_at\) AS signal_created_at/,
    'the claim query hands the engine the posting time, falling back to the write time for rows written before the column existed');
  assert.match(engineSource, /now\(\) - createdAt > MAX_SIGNAL_AGE_MS/,
    'and that is the value the age guard is measured against');
  const ageGuardAt = engineSource.indexOf('const createdAt = new Date(item.signal_created_at).getTime();');
  assert.ok(ageGuardAt > 0, 'the guard is where the engine reads the claimed row');
  const ageGuard = engineSource.slice(ageGuardAt, ageGuardAt + 420);
  assert.match(ageGuard, /now\(\) - createdAt > MAX_SIGNAL_AGE_MS/,
    'the guard consumes exactly that column, so a rebuild of either half without the other breaks a test');

  // And the listener is what computes it, on every path - live push and replay alike - so a catch-up cannot
  // smuggle an old message in wearing a fresh timestamp.
  assert.match(listenerSource, /const sentAtMs = Number\(message\?\.date\) \* 1000/, 'the Telegram date is read in seconds and converted once');
  assert.match(listenerSource, /saveSignal\(userId, text, \{/, 'through the single storage path both routes share');
  assert.match(listenerSource, /sentAt, delayMs/, 'with the send time and the measured lateness riding along together');
});

/* ------------------------------------------------------------- the watchdog that proves the socket ------------------------------------------------

   `connected === true` and a handler in GramJS's own list are both facts about objects in memory. They were the
   only facts the product had, which meant a session that stayed open and stopped receiving looked identical to a
   quiet channel - for as long as it took someone to notice that the signals had stopped. The sweep below is what
   makes the difference an event rather than an observation: it asks each silent session a bounded question,
   rebuilds the ones that cannot answer it, and asks the channel directly about the ones that can.

   ------------------------------------------------------------------------------------------------------------------------------------------------------ */

test('the sweep proves each listening session is receiving, and rebuilds the ones that cannot answer', () => {
  const watchdog = section(index, 'async function checkTelegramStreams(', '\n/** Re-attach anything in memory');
  assert.ok(watchdog.length > 400, 'the check exists in the server, next to the re-arm it follows');
  assert.match(watchdog, /telegramCapture\.streamHealth\(userId\)/, 'it works off the silence clock rather than a boolean');
  assert.match(watchdog, /if \(!health\.listening\) continue/, 'a session with no handler is the re-arm\'s business, not a rebuild trigger');
  assert.match(watchdog, /if \(health\.suspect\) \{/, 'a session that delivered a message a minute ago is not interrogated on every sweep - only the quiet one is asked a question');
  assert.match(watchdog, /telegramCapture\.probeUpdateStream\(entry\.client\)/, 'a suspect session is asked a bounded question');
  assert.match(watchdog, /restoreTelegramClient\(userId, \{ reason: 'silent-update-stream' \}\)/, 'a socket that cannot answer is rebuilt, under a reason that names the diagnosis');
  assert.equal(/probe\.state === 'unknown'[\s\S]{0,400}restoreTelegramClient/.test(watchdog.slice(watchdog.indexOf("if (probe.state === 'unknown')"))), false,
    'and a probe this build cannot run never, on its own, tears a working listener down');
  assert.match(watchdog, /if \(health\.catchUpOverdue\) \{[\s\S]{0,160}runCatchUp\(userId\)/, 'and every session is cross-checked against the channel on its own staggered schedule, because a quiet-but-live session and a half-deaf one look identical from the flags');
  assert.match(watchdog, /Telegram update stream is silent and the socket is not answering; rebuilding the session/, 'the rebuild is logged with the numbers that justify it');

  // Being a function is not being scheduled: the proof is that it runs in the same 60 second sweep that already
  // re-arms handlers, after the re-arm, so a rebuild never races the thing that was about to fix the same row.
  assert.ok(index.includes(".then(() => rearmTelegramListeners())\n      .then(() => checkTelegramStreams({ reason: 'sweep' }))"),
    'it is chained onto the sweep, after the re-arm, so a rebuild never races the pass that was about to fix the same session');
  const sweepAt = index.indexOf('const telegramSweep = setInterval(');
  assert.ok(sweepAt > 0, 'the telegram sweep is a named interval in the server');
  const sweep = index.slice(sweepAt, sweepAt + 700);
  assert.match(sweep, /\}, 60 \* 1000\);/, 'and the sweep is a minute, which is what bounds the worst case for every path in here');
  assert.match(sweep, /\.catch\(\(error\) => log\('warn', 'Telegram listener sweep failed'/, 'a failed check cannot kill the interval that keeps the fleet listening');
});
