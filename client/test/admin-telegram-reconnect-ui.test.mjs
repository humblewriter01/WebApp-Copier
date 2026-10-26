/**
 * The admin panel's manual Telegram reconnect.
 *
 * The panel is where "the bot is not hearing the channel" is decided, and the button is the only action there
 * that is allowed to step around the server's rebuild throttle. What this file guards is the difference between
 * a control that tells the truth and one that merely looks busy: the button must not exist for an account with no
 * session to rebuild, the click must be reported by what the replay found rather than by "ok", and a reconnect
 * that stored nothing must not be described as a failure - because on a channel that has not posted, that is the
 * normal answer, and an administrator who is told it failed will press it again.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const panel = readFileSync(path.join(here, '..', 'src', 'components', 'AdminPanel.jsx'), 'utf8');

const handler = panel.slice(panel.indexOf('const reconnectTelegram = async (user) => {'), panel.indexOf('const changeRole ='));
assert.ok(handler.length > 400, 'the handler is in the panel, next to the other per-user actions it belongs with');

test('the reconnect is offered only where there is a session to reconnect', () => {
  assert.match(panel, /\{user\.telegramConnected && !isSelf \? <button[^>]*onClick=\{\(\) => reconnectTelegram\(user\)\}/,
    'the button is conditional on the account actually having a linked session, and never offered on the administrator themself');
  assert.match(panel, /disabled=\{busy\}/, 'and it is disabled while that row has any write in flight, so a double click cannot start two reconnects');
  assert.match(panel, /Reconnect Telegram/, 'named for what it does, in the row it acts on');
  assert.match(panel, /title="Drop the Telegram connection, sign back in with the stored session, and replay what the channels posted while it was down"/,
    'the hover text says what will happen to the data, because "Reconnect" alone sounds like a page refresh');
  assert.match(panel, /Telegram linked · \{user\.monitorCount/, 'the row says whether the linked session is watching anything, which is the fact that changes the diagnosis');
  assert.match(panel, /no channel monitored yet/, 'and says it plainly when that is the case, instead of leaving an empty gap to be read as a bug');
});

test('the result is the backlog the replay found, not a thank-you', () => {
  assert.match(handler, /request\(`\/api\/admin\/users\/\$\{user\.id\}\/telegram\/reconnect`, token, \{ method: 'POST', body: \{ reason: 'admin-panel' \}, retryWhenUnanswered: true \}\)/,
    'it rides the same request helper as every other admin write, including the waking-host retry: the first call after a quiet night is expected to arrive at a service that is still starting');
  assert.match(handler, /const caughtUp = Number\(result\?\.caughtUp\) \|\| 0;/, 'the counts are read defensively, because an absent number is not zero messages, it is an unknown one');
  assert.match(handler, /It replayed \$\{caughtUp\} missed message\(s\)/, 'and the notice reports what was found');
  assert.match(handler, /that is the deaf-stream case, not a backlog\./,
    'a message posted while the old listener was attached is called what it is, because that is the sentence that turns into a bug report about the server');
  assert.match(handler, /Nothing was waiting in the channels, which on a quiet channel is the normal answer\./,
    'and an empty replay is described as an answer, not a failure, so nobody presses it twice out of doubt');
  assert.match(handler, /setNotice\(`\$\{user\.name\}'s Telegram session is new\./, 'the success path is a notice, not an error styled like one');
  assert.match(handler, /await loadUsers\(\);/, 'the row is re-read, so the panel does not keep showing the state the button just changed');
});

test('the handler leaves the row usable whether or not the request answered', () => {
  assert.match(handler, /setBusyUser\(user\.id\);\n\s*setError\(''\);\n\s*setNotice\(''\);/, 'it clears the old result before it starts, so a stale notice is never read as this click');
  assert.match(handler, /catch \(reconnectError\) \{\n\s*setError\(reconnectError\.message\);/, 'a refusal is shown in the service’s own words, which is the only description of a Telegram-side failure that has ever been accurate');
  assert.match(handler, /finally \{\n\s*setBusyUser\(''\);\n\s*\}/, 'and the row is released either way, because a stuck spinner on the only escape hatch is a worse outage than the deaf stream');
});

test('the copy an administrator reads stays free of the server’s own vocabulary', () => {
  const copyMatch = handler.match(/setNotice\(`([\s\S]*?)`\);/);
  assert.ok(copyMatch, 'the result of the click is one sentence built in the handler, where it can be read and tested');
  const copy = copyMatch[1];
  assert.equal(/pts|cooldown|watchdog|heartbeat|NAT|socket|MTProto|dispatcher|GramJS|timeout|latency/i.test(copy), false,
    'the panel speaks about sessions, channels and messages; `pts`, the cooldown and the watchdog belong to the log lines and the health panel, where they are actionable');
});
