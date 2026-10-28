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
// Telegram's library shape now lives in one file, so the invariants that used to be pinned where the calls were
// made are pinned here instead: the same numbers, asserted against the module that owns them.
const adapterSource = readFileSync(new URL('../services/telegram-adapter.js', import.meta.url), 'utf8');
const engineSource = readFileSync(new URL('../services/execution-engine.js', import.meta.url), 'utf8');

function section(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `${startMarker} is missing from the source`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  /* The end marker is required rather than optional. A slice that quietly runs to end-of-file keeps every
     `assert.match` inside it green while bounding nothing - the one way a source pin can rot without ever
     failing, and it did happen twice here, against a marker that has never existed in `index.js`. A caller that
     genuinely wants "to the end" should slice deliberately, so the looseness is at least written down. */
  assert.notEqual(end, -1, `${endMarker} does not follow ${startMarker}, so the section would read to end-of-file`);
  return source.slice(start, end);
}

/* The declaration that follows `restoreTelegramClient`, named once for every section that has to stop there: three
   pins bounded the same region, and one anchor is the difference between them agreeing and drifting apart. */
const AFTER_RESTORE = '\n/**\n * Every workspace with a stored session gets a live listener';

const saveSignalBody = section(index, 'async function saveSignal(', '\nconst telegramCapture = createTelegramListener(');
/* One column list, three statements: the INSERT's RETURNING, the read that answers a redelivered message, and the
   UPDATE an edited message writes. The pins below that used to read the aliases out of the capture function read
   them from here instead, plus an assertion that the capture function still points at this one - which is the
   part that actually matters, and a literal list in a test could never have said it. */
const captureRowColumns = section(index, 'const SIGNAL_CAPTURE_ROW_COLUMNS = `', 'async function saveSignal(userId, message, channel = {}) {');
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
  const emitAt = saveSignalBody.lastIndexOf("emit('signal:received'");
  assert.ok(queueAt > 0 && notifyAt > queueAt, 'the wake-up follows the statement that put the job in the table, and cannot run before there is anything to claim');
  assert.ok(emitAt > notifyAt, 'and it is fire-and-forget: the row reaches the browser on the same tick, not after the broker answers');
  /* The other announce site is an edited message that refreshed its row's text and stopped: no status moved, so
     there is nothing for the queue branch to do and no reason for a card to wait on one. It has to sit *after*
     that write, which is the same rule in a different costume - a client must never render a row that is half
     updated - and it must not be inside the queue branch, or a wording-only edit would wake the worker. */
  const textBranchAt = saveSignalBody.indexOf("if (editPlan.action === 'text') {");
  const textEmit = saveSignalBody.indexOf("emit('signal:received'", textBranchAt);
  assert.ok(textBranchAt > 0 && textEmit > textBranchAt, 'the text-only edit path announces its row too, because the card the trader is reading changed');
  assert.equal(/execution_jobs|decideSignalOutcome|captureSafety\(/.test(saveSignalBody.slice(textBranchAt, textEmit)), false,
    'and the path that refreshed text touches none of the execution machinery: no policy asked, no outcome decided, no job queued');
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
  assert.match(statusRoute, /listening: Boolean\(telegramAdapter\.connectedFlag\(entry\?\.client\) && entry\.handler && telegramCapture\.handlerIsLive\(entry\.client, entry\.handler\)\)/, 'listening is read from GramJS\'s handler list, not from a flag of ours');
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
  assert.match(captureRowColumns, /direction_inferred AS "directionInferred"/, 'the inferred direction is read back with the row');
  assert.match(saveSignalBody, /RETURNING \$\{SIGNAL_CAPTURE_ROW_COLUMNS\}/, 'and the capture reads it back through the one shared list, not its own copy');
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
  assert.match(index, /entry_range,technical_note,sent_at,edited_at\)\n\s+VALUES\(\$1,\$2,\$3,\$4,\$5,\$6,\$7,\$8,\$9,\$10,\$11,\$12,\$13,\$14,\$15,\$16::jsonb,\$17,\$18,\$19,\$20,\$21,\$22,\$23,\$24,\$25,\$26::jsonb,\$27,\$28::timestamptz,\$29::timestamptz\)/, 'the capture writes it, and the channel clock rides along in the same statement');
  assert.match(index, /channel\.sentAt \? new Date\(channel\.sentAt\) : null,\n\s+\/\*[\s\S]*?\*\/\n\s+channel\.editedAt \? new Date\(channel\.editedAt\) : null\],/, 'the bound value is the time the channel posted, a source without one stores NULL rather than "just now", and so does an edit with no `editDate` - our own clock is not evidence about the channel');
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
  assert.match(saveSignalBody, /is_scalping,entry_range,technical_note,sent_at,edited_at\)/, 'the INSERT carries the column, and the stamp that says an edited post produced this text');
  assert.match(saveSignalBody, /\$26::jsonb,\$27/, 'as jsonb, like the target ladder beside it, with the admin-only half last');
  assert.match(saveSignalBody, /entryRangeValue\(parsed\),/, 'from the parse, not from a re-read of the message');
  assert.match(captureRowColumns, /entry_range AS "entryRange"/, 'and the row read back has it, so the client sees the row that was written');
  assert.match(saveSignalBody, /entry_range=\$10::jsonb/, 'the edit path writes the zone through the same converter, as jsonb, in the same statement that carries the correction');

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

  assert.match(saveSignalBody, /sent_at,edited_at\)/, 'the capture writes it');
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

test('the sweep asks the channel what it said, and the heartbeat is what asks the socket', () => {
  const watchdog = section(index, 'async function checkTelegramStreams(', '\n/** Re-attach anything in memory');
  assert.ok(watchdog.length > 400, 'the cross-check exists in the server, next to the re-arm it follows');
  assert.match(watchdog, /telegramCapture\.streamHealth\(userId\)/, 'it works off the session clock rather than a boolean');
  assert.match(watchdog, /if \(!health\.listening\) continue/, 'a session with no handler is the re-arm\'s business, not a rebuild trigger');
  assert.match(watchdog, /if \(health\.catchUpOverdue\) \{[\s\S]{0,200}runCatchUp\(userId\)/, 'every listening session is cross-checked against the channel on its own staggered schedule');
  assert.equal(watchdog.includes('probeUpdateStream'), false, 'the socket question is not asked here any more: a beat every 30 seconds cannot be older than the sweep, and two watchdogs reconnecting the same session is one too many');
  assert.match(watchdog, /if \(results\.gapChecked\) log\('info', 'Telegram streams checked'/, 'the sweep only speaks when it did something, so a quiet minute is a quiet minute in the logs too');

  /* Being a function is not being scheduled. The proof is that the beat runs on its own interval - not inside the
     sweep, which is a minute, and not off the silence clock, which is ninety seconds of already-lost time. */
  assert.match(index, /void beatTelegramStreams\(\{ reason: 'boot' \}\);\n\s*const telegramHeartbeat = setInterval\(\(\) => \{\n\s*void beatTelegramStreams\(\{ reason: 'interval' \}\);\n\s*\}, HEARTBEAT_INTERVAL_MS\);\n\s*telegramHeartbeat\.unref\?\.\(\);/,
    'the interval is the exported constant, is unref\'d so it can never hold a shutting-down process open, and its first cycle runs at boot');
  /* Loosened on the name list and not on the meaning: this pin used to require the import to hold exactly two
     names, which is not an invariant of anything, and it made adding a third a red test for no reason. Both names
     it cares about are still required, from the same module, on the same line. */
  assert.match(index, /import \{ HEARTBEAT_INTERVAL_MS, createTelegramListener,[^\n]*\} from '\.\/services\/telegram-listener\.js'/,
    'from the module that owns the beat, so the number cannot drift between the two files');
  const runner = section(index, 'async function beatTelegramStreams(', '\n/** Re-attach anything in memory');
  assert.match(runner, /catch \(error\) \{\n\s*log\('warn', 'Telegram heartbeat cycle failed'/,
    'a cycle that throws once is logged, because an interval callback that rejects would stop the keep-alive permanently and silently - the exact failure this exists to prevent');

  // The rebuild goes through the one function that can do it, and the listener never reaches for it directly.
  assert.match(index, /onDeadStream: \(userId, reason, \{ force = false, escalate = false \} = \{\}\) => restoreTelegramClient\(userId, \{ reason, force, escalate \}\)/,
    'the listener decides when a stream is not a stream; the server owns the reconnect, which also re-attaches and replays');
  assert.equal((index.match(/force: true/g) || []).length, 1, 'exactly one caller in the server may bypass the rebuild cooldown, and it is the manual reconnect route');

  /* The part of a "rebuild" that used to be missing: both escalation levels have to step past the shortcut that
     returns the already-connected client, or the watchdog tears nothing down and the deaf session keeps its
     stale update state along with its handler. And the disconnect is conditional on the same flag, because a
     connected client is precisely the case being rebuilt - leaving it alive would keep two authorized sessions
     on one StringSession, which is how a "fix" becomes a second opinion. */
  const restore = section(index, 'async function restoreTelegramClient(', AFTER_RESTORE);
  assert.equal(restore.includes('resumeTelegramSessions'), false,
    'and the slice really does stop at the next declaration, so these pins bound the function they name');
  const restoreEarly = section(index, 'async function restoreTelegramClient(', 'if (current?.client && !telegramAdapter.isConnected(current.client)) {');
  assert.match(restoreEarly, /const mustRebuild = force === true \|\| escalate === true;/, 'the watchdog escalates, the operator forces, and either one rebuilds');
  assert.match(restoreEarly, /if \(!mustRebuild && telegramAdapter\.isConnected\(current\?\.client\) && current\.handler && telegramCapture\.handlerIsLive/, 'the shortcut is gated on that flag, not on good intentions');
  assert.match(restore, /if \(current\?\.client && \(!telegramAdapter\.isConnected\(current\.client\) \|\| mustRebuild\)\) await telegramAdapter\.disconnect\(current\.client\)\.catch\(\(\) => \{\}\);/,
    'a rebuilt session disconnects the client it replaces, connected or not');
  assert.match(restore, /await telegramCapture\.resyncUpdateState\(current\.client, \{ userId, reason: `\$\{reason\}:reconnected` \}\);/,
    'a socket that came back has its state reconciled before the handler is re-attached');
  assert.match(restore, /await telegramCapture\.resyncUpdateState\(client, \{ userId, reason: `\$\{reason\}:new-session`, force: mustRebuild \}\);/,
    'and a brand-new client is told where the account stands before anything is asked of it - GetState alone is not a sync when the answer is thrown away');
  assert.ok(restore.indexOf('resyncUpdateState') < restore.indexOf('telegramClients.set(userId, { client, handler: null'), 'the sync happens before this session exists to anyone else');
  assert.match(index, /telegramClients\.set\(userId, \{ client, handler: null, stats: telegramCapture\.EMPTY_STATS\(\) \}\);\n\s*telegramCapture\.resetStreamBaseline\(userId\);/,
    'a rebuilt session has its beat baseline retaken, because `seen` restarting at zero would otherwise read as a stalled stream and the watchdog would reconnect every session it had ever fixed');

  /* `/health` is public, so the heartbeat appears there as counts and nothing else. `beats` is the per-session
     array - user ids, `pts`, timings - and it is destructured away rather than filtered, so the shape that could
     leak is not merely hidden but absent from the object being serialised. */
  const healthBlock = section(index, 'function telegramHeartbeatHealth()', '\n/**');
  assert.match(healthBlock, /const \{ beats, \.\.\.counters \} = telegramCapture\.heartbeatSummary\(\)/, 'the per-session detail is dropped by construction');
  assert.match(healthBlock, /catch \{[\s\S]{0,120}return null/, 'and a diagnostic that throws cannot take the platform health route down with it');
  assert.match(index, /telegram: telegramHeartbeatHealth\(\),/, 'the block is on the payload every probe reads');
});

test('the transport can be moved off the plain port, and the option can never cost capture its signals', () => {
  const transport = section(index, 'function telegramCaptureTransport(', '\nasync function restoreTelegramClient');
  assert.match(transport, /process\.env\.TELEGRAM_TRANSPORT \|\| ''\)\.toLowerCase\(\) !== 'wss'/, 'off by default: the beat is the fix, this is a knob');
  assert.match(transport, /return \{ wss: overWss, options: telegramAdapter\.captureTransportOptions\(\{ wss: overWss \}\) \};/,
    'one return, and the shape still tells the caller whether a fallback is even available');
  assert.match(adapterSource, /useWSS: true/, 'and when it is on, it is the library\'s own option rather than a hand-rolled socket');
  assert.equal(transport.includes('useWSS'), false, 'the routing file does not name the library option; it only decides');

  const restore = section(index, 'async function restoreTelegramClient(', AFTER_RESTORE);
  assert.match(restore, /const transport = telegramCaptureTransport\(\);/, 'the capture client is built from it');
  assert.match(restore, /if \(!transport\.wss\) throw error;/, 'a failure with the option off is the ordinary failure');
  assert.match(restore, /Telegram WSS transport could not connect; reconnecting over the default transport/, 'and with it on, the fallback is announced');
  assert.match(restore, /client = telegramAdapter\.createClient\(\{ sessionString, apiId: Number\(process\.env\.API_ID\), apiHash: process\.env\.API_HASH, options: telegramCaptureTransport\(\{ wss: false \}\)\.options \}\);\n\s*telegramKeepAlive\.attach\(client, \{ userId \}\);\n\s*await telegramAdapter\.connect\(client\);/,
    'retried on the default transport with the same session and the same tuned options - restating the numbers here is how a fallback path keeps settings the primary one stopped having');
  const captureClients = index.match(/telegramAdapter\.createClient\(\{ sessionString,[^\n]*\}\);/g) || [];
  assert.equal(captureClients.length, 2, 'the two capture transports, primary and fallback, are both built here');
  assert.equal(captureClients.every((site) => /transport\.options|telegramCaptureTransport\(\{ wss: false \}\)\.options/.test(site)), true,
    'and neither names retry numbers of its own: both read them from the one function, which is what stops the fallback keeping settings the primary path no longer has');
  assert.equal(/createClient\(\{[^\n]*connectionRetries:/.test(index), false, 'nothing in the capture path restates the tuning');

  /* The knob that was asked for and does not exist, pinned so nobody re-adds it from a README: 2.26.26 stores
     `timeout` as `_connectTimeout` on the sender and never reads it, so passing it would look like a tuned
     timeout and do precisely nothing. The retry count is the real lever. */
  assert.match(adapterSource, /CAPTURE_CONNECTION_RETRIES = 5;/, 'five attempts, not three, because the library gives its own transport about forty seconds to recover');
  assert.match(adapterSource, /LOGIN_CONNECTION_RETRIES = 3;/, 'and the one-shot login clients keep their own, smaller number');
  assert.equal(/timeout:\s*\d/.test(transport) || /timeout:\s*\d/.test(adapterSource), false, 'no request-timeout option is passed anywhere, because in this version none is read');
  assert.match(adapterSource, /autoReconnect: true/, 'and the sender is left free to reconnect again after the attempts run out');

  /* The login clients deliberately keep the plain transport: a user waiting for a code is waiting interactively,
     and an experiment that exists for long-lived idle connections has no business in a one-shot handshake. */
  const loginSites = index.match(/telegramAdapter\.createClient\(\{[^\n]*loginTransportOptions\(\)/g) || [];
  assert.equal(loginSites.length, 2, 'the code request and the pending-session restore, and nothing else, build a login client');
  assert.equal(loginSites.some((site) => site.includes('useWSS')), false, 'and none of them takes the knob');
  assert.equal(/connectionRetries:/.test(index), false, 'the login tuning is spelled once, in the adapter, which is how a second login client cannot forget it');
});

/* ---------------------------------------------------------------------------
   The provider's keep-alive noise, handled where it is produced. GramJS's `_updateLoop` races its own ping
   against a 10-second timer, prints the resulting `Error: TIMEOUT` with `console.error`, and reconnects the
   sender - so on a long-lived session with a flappy path it is one stack trace per nine seconds per user, for a
   condition the library is already recovering from. Suppression has to happen at the client's logging gate
   rather than in a global handler, because the error is *caught* by the library: it never reaches
   `unhandledRejection` at all, and a filter written against that event would have hidden nothing while looking
   like a fix.
   --------------------------------------------------------------------------- */

test('the keep-alive noise is counted at the client that produced it, and the process filter is not where it happens', () => {
  const guard = section(index, 'const telegramCapture = createTelegramListener({', '\nconst startTelegramListener =');
  assert.match(index, /const telegramKeepAlive = createTelegramKeepAliveGuard/, 'the guard is built once per process, from the module that knows what the noise looks like');
  assert.match(guard, /transportFlap: \(client\) => telegramKeepAlive\.flapFor\(client\)/,
    'and the watchdog is given the flap record, so an unanswered beat during a provider reconnect is waited out instead of torn down');
  /* The invariant is per client, not per pattern: the primary build connects inside a `try`, the fallback does
     not, so counting the adjacency would have found one and proved nothing. Splitting on the construction is what
     lets the same claim be made about both transports. */
  const captureBuilds = section(index, 'async function restoreTelegramClient(', AFTER_RESTORE)
    .split('telegramAdapter.createClient({ sessionString').slice(1);
  assert.equal(captureBuilds.length, 2, 'both capture transports build their client in the same function');
  assert.equal(captureBuilds.every((chunk) => /telegramKeepAlive\.attach\(client, \{ userId \}\);[\s\S]{0,60}await telegramAdapter\.connect\(client\);/.test(chunk)), true,
    'and each one is guarded before it connects, on the fallback as well as on the transport the operator asked for');
  assert.match(index, /telegramKeepAlive\.attach\(client, \{ userId \}\);\n\s*await telegramAdapter\.connect\(client\);/,
    'attached before `connect()`, because that is where the update loop starts - after it would miss the first flap, which is the one that happens during a rebuild');

  // The process-level filter exists for the process, not for the log: it must never become a general silencer.
  const filter = section(index, "process.on('unhandledRejection'", "process.on('SIGTERM'");
  assert.match(filter, /isNoise: isProviderKeepAliveTimeout/, 'it recognises exactly one error, by its message and the frame that throws it');
  assert.match(filter, /onOther: \(reason\) => \{ process\.nextTick\(\(\) => \{ throw reason/, 'and everything else is rethrown, so a real unhandled rejection still ends the process with its stack');
  assert.equal((index.match(/process\.on\('unhandledRejection'/g) || []).length, 1, 'one rejection handler, and it is this one');
  assert.equal(index.includes("process.on('uncaughtException'"), false,
    'and no synchronous exception handler: a throw out of a socket callback is not the provider clearing its ping, and this app is meant to die loudly for it');
  assert.equal(/console\.(error|log) =/.test(index), false, 'and `console` is not patched: silencing a printer is how a log becomes unreliable for everyone who shares it');
});

test('an operator can rebuild a deaf session by hand, and that is the one path allowed to ignore the cooldown', () => {
  const route = section(index, "app.post('/api/admin/users/:id/telegram/reconnect'", '\napp.post');
  assert.match(route, /authenticate, requireAdmin, adminRoute\('Reconnecting a Telegram session by hand'/,
    'admin-only, and inside the wrapper that knows a write already landed, so a later failure is reported as "it happened" rather than as a clean refusal');
  assert.match(route, /markApplied\(req\);/, 'the user lookup is not the mutation, but the reconnect is');
  assert.match(route, /SELECT id, email FROM users WHERE id=\$1/, 'the target has to exist before anything is tried');
  assert.match(route, /fail\(res, 404, 'No workspace has that id/, 'and a bad id is a 404 about the id, not a 500 about the socket');
  assert.match(route, /fail\(res, 409, `\$\{error\.message\} The phone number has to sign in again/, 'no stored session is a conflict with the next step for the human');
  assert.match(route, /fail\(res, 502, `\$\{error\.message\} Try again in a minute/, 'and a refused handshake says what to do, in minutes, not in stack frames');

  const helper = section(index, 'async function forceTelegramReconnect(', '\n/** Re-attach anything in memory');
  assert.match(helper, /restoreTelegramClient\(userId, \{ reason, force: true \}\)/, 'the bypass is one call deep and named');
  assert.match(helper, /action: 'telegram\.reconnectForced'/, 'the audit trail gets its own action, because "who rebuilt this" is the first question after a rebuild that fixed something');
  assert.match(helper, /actorId,\n\s*actorEmail,/, 'both halves of the actor are recorded');
  assert.match(helper, /const caughtUp = Number\(outcome\?\.stored\) \|\| 0;\n\s*const fresh = Number\(outcome\?\.fresh\) \|\| 0;/,
    'the numbers are read out once');
  assert.match(helper, /metadata: \{ reason, caughtUp, fresh, heartbeatCycles: capture\.cycles, deadBeats: capture\.dead, stalledBeats: capture\.stalled \}/,
    'and the audit row and the response are built from that one pair, never from two computations that can disagree');
  assert.match(helper, /Reconnected a workspace's Telegram session by hand and replayed its channels: \$\{caughtUp\} missed message\(s\) stored, \$\{fresh\} of them posted while the old handler was already attached\./,
    'the summary says what was found and what it means, so the audit row can be read without the logs');
  assert.match(helper, /Telegram session reconnected by hand/, 'and the stdout line is searchable, with the same numbers');
  assert.match(helper, /await auditLog\.record\(\{[\s\S]{0,700}\}\)\.catch\(\(error\) => log\('warn', 'Telegram forced reconnect could not be audited'/,
    'a failure to write the audit row is logged rather than allowed to fail the action the operator took');

  // The helper must not go and rebuild the whole fleet as a side effect of one button press.
  assert.equal(helper.includes('resetStreamBaseline()'), false, 'the baseline is retaken per session, by the restore itself');

  /* The button is rendered from a field on the row, so the field has to be in the list the row is built from -
     and quoted, because Postgres folds a bare camelCase alias to lowercase and the client then reads
     `undefined` and states something false. This is the exact bug that put "Auto-Trading is off" on every row
     once, and a conditional control is the most dangerous place to repeat it: the button would simply vanish. */
  const columns = section(index, 'const adminUserColumns = `', '`;');
  assert.match(columns, /u\.telegram_connected AS "telegramConnected"/, 'the linked fact is on every admin read of an account, from one list');
  assert.match(columns, /\(SELECT COUNT\(\*\)::int FROM channels c WHERE c\.user_id=u\.id AND c\.enabled=TRUE\) AS "monitorCount"/,
    'and so is how many channels that session is supposed to be hearing, which is what distinguishes a deaf stream from a workspace that never picked a channel');
  assert.equal(/AS [a-z][a-zA-Z]*(?![\w"])/.test(columns), false, 'no camelCase alias in that list is left unquoted');
});

/* ---------------------------------------------------------------------------
   The two hand-offs between the listener and the server that a unit test cannot see: who consumes a flagged
   session, and who is allowed to decide that a user must sign in again. Both are pinned here because both are
   the sort of thing that silently stops being true when the file above it is refactored - and both are the
   difference between "the app noticed" and "the app recovered".
   --------------------------------------------------------------------------- */

test('a deaf session is saved by the minute, and an unrecoverable one is ended by the server', () => {
  // The listener sets `needsCatchUp`; this is the code that reads it, and the interval that runs it.
  const rearm = section(index, 'async function rearmTelegramListeners(', 'io.use((');
  assert.match(rearm, /if \(entry\.needsCatchUp && telegramAdapter\.isConnected\(entry\.client\)\) \{[\s\S]{0,200}runCatchUp\(userId\)/,
    'the flag the update-state reconciliation sets is the flag the re-arm pass acts on, so a session the account will not reconcile still gets its channels read back on the next pass rather than on the staggered one');
  const sweep = section(index, 'const telegramSweep = setInterval', 'telegramSweep.unref');
  assert.match(sweep, /resumeTelegramSessions\(\{ reason: 'sweep' \}\)[\s\S]{0,120}rearmTelegramListeners\(\)[\s\S]{0,120}checkTelegramStreams/,
    'in one pass, in that order: resume, re-arm and replay, then the staggered gap check - which is why the flag does not need a second scheduler to mean anything');
  assert.match(sweep, /\}, 60 \* 1000\);/, 'and the pass is a minute: that is the bound on how late a deaf session’s signals are, and it is a delay rather than a loss only because this line exists');

  // The last rung of the ladder: the listener holds the evidence, the server owns the consequence.
  const ctor = section(index, 'const telegramCapture = createTelegramListener({', '\nconst startTelegramListener =');
  assert.match(ctor, /onSessionUnrecoverable: async \(userId, reason, details = \{\}\) => \{/, 'the verdict has a handler wired, next to the rebuild handler it follows');
  assert.match(ctor, /UPDATE users SET telegram_connected=FALSE WHERE id=\$1/, 'which marks the account unlinked, the one fact every other part of the app already reads and shows');
  assert.equal(ctor.includes('telegram_session=NULL'), false, 'and deliberately does not destroy the session string: an admin’s forced reconnect is the last thing worth trying before a human is asked for their phone, and it needs that string to try');
  /* The key this handler addresses is where the bug lived, so it is pinned on the code rather than on the prose:
     `users.id` is a UUID and `req.userId` is that UUID as text, and the first version of this handler asked
     "is this a positive integer" before it wrote anything. Every real workspace failed that question, so the
     marking, the disconnect and the log line below it never ran at all, and a session already known to be dead
     went on being reported as connected for the life of the process. */
  assert.match(ctor, /if \(!isValidWorkspaceId\(userId\)\) return;/, 'the id is validated as an id - present text - not as a number');
  assert.equal(/Number\(userId\)/.test(ctor), false, 'and is never coerced anywhere in this handler, because coercion is what made it a no-op');
  assert.match(ctor, /WHERE id=\$1', \[userId\]\)/, 'the write is addressed by the same text the map is keyed by');
  assert.match(ctor, /telegramClients\.get\(userId\)/, 'the client is looked up by that same key');
  assert.match(ctor, /telegramClients\.delete\(userId\)/, 'the memory is dropped with the flag by that same key, so the resume query cannot hand the dead session straight back');
  assert.match(index, /telegramClients\.set\(userId, \{/, 'which is the key the map is filled with, three hundred lines away - set, get and delete have to agree or the map leaks a live client');
  assert.match(ctor, /log\('warn', 'Telegram session left for the user to sign in again'/, 'and the reason, the pts, the gap and the strike count are logged together, because that is the whole post-mortem');

  // The user-facing answer to "why does it say I need to reconnect", without a log search and without protocol in the UI.
  const statusRoute = section(index, "app.get('/api/telegram/status'", 'async function persistTelegramLoginAttempt');
  assert.match(statusRoute, /reauthRequired: entry\?\.reauthRequired === true/, 'the status route publishes the verdict as a boolean, not as a story about pts');
  const statusPayload = section(statusRoute, 'res.json({', '\n  });');
  assert.equal(/\b\w*(pts|Pts|difference|Difference|GetState|stall)\w*:/.test(statusPayload), false,
    'and none of the vocabulary that produced the verdict is a key in the payload the trader’s browser receives - a boolean they can act on, not a number they cannot');
});
