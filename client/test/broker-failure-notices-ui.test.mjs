import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { signalOutcomeView } from '../src/lib/signal-outcome.js';

/*
 * Two halves of one promise: when the execution engine decides that an account cannot trade, the workspace
 * is told where it will actually look - the signal it just captured, and the trading account that produced
 * the failure. Both sentences come from the server; this code only renders them, which is what these tests
 * hold it to.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const read = (relative) => readFileSync(path.join(here, '..', relative), 'utf8');
const panel = read('src/components/MetaApiPanel.jsx');
const styles = read('src/styles.css');
const server = read('../server/services/execution-engine.js');
const routes = read('../server/index.js');

test('a trading account carries the engine\'s own sentence when it cannot trade', () => {
  assert.match(panel, /\{account\.executionNote \? <p className="account-execution-note" role="alert">\{account\.executionNote\}<\/p> : null\}/);
  // Twice and only twice: the condition and the sentence itself. Anything more would mean the panel had
  // started inventing its own explanation of a broker failure, which is the server's job.
  assert.equal(panel.match(/account\.executionNote/g).length, 2);
  assert.match(styles, /\.account-execution-note\{/, 'and it is styled as the problem it is, not as another muted line of metadata');
});

test('the note arrives through the accounts route, not a second request', () => {
  assert.match(routes, /ma\.execution_note AS "executionNote",ma\.execution_note_at AS "executionNoteAt"/);
  assert.match(server, /UPDATE metaapi_accounts SET execution_note=\$3,execution_note_at=NOW\(\) WHERE user_id=\$1 AND metaapi_account_id=\$2/);
  assert.match(server, /UPDATE metaapi_accounts SET execution_note=NULL,execution_note_at=NULL WHERE user_id=\$1 AND metaapi_account_id=\$2 AND execution_note IS NOT NULL/);
  assert.equal(server.match(/UPDATE metaapi_accounts SET execution_note=/g).length, 2, 'exactly two statements write this column: the note and its clear, no third path');
});

test('a signal blocked by a broker error says so, and does not sound like a rejection', () => {
  const blocked = signalOutcomeView({ status: 'failed', executionNote: 'Broker connection failed. Please check your credentials.' });
  assert.equal(blocked.label, 'Blocked by a broker error');
  assert.equal(blocked.tone, 'bad');
  assert.equal(blocked.showNote, true);

  const refused = signalOutcomeView({ status: 'rejected', executionNote: 'Invalid volume (TRADE_RETCODE_INVALID_VOLUME).' });
  assert.equal(refused.label, 'Rejected by broker', 'the account is fine there; this order was not');
  assert.equal(refused.tone, 'bad');

  const waiting = signalOutcomeView({ status: 'queued', executionNote: null });
  assert.equal(waiting.label, 'Sent for execution', 'a signal waiting out a retry backoff is still in flight, and is not annotated as a failure');
  assert.equal(waiting.note, '');

  const stale = signalOutcomeView({ status: 'unexecuted', executionNote: 'Execution skipped: price quote is stale to prevent slippage.' });
  assert.equal(stale.label, 'Not executed');
  assert.match(stale.note, /price quote is stale/);
});
