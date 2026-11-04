import test from 'node:test';
import assert from 'node:assert/strict';

import { parseSignal } from '../services/signal-parser.js';
import {
  extractJsonObject,
  isMarketEntryValue,
  llmConfig,
  llmParseSignal,
  needsLayer2,
  validateExtraction,
} from '../services/signal-llm.js';
import { parseSignalTwoLayer } from '../services/signal-parse-pipeline.js';
import { captureSafety } from '../services/signal-safety.js';

const CONFIG = llmConfig({
  LLM_API_KEY: 'test-key-not-a-secret',
  LLM_API_URL: 'https://llm.example.test/v1/chat/completions',
  LLM_MODEL_NAME: 'gpt-oss-20b',
});

const silentLogger = { warn() {}, info() {} };

function mockFetchJson(body, { ok = true, status = 200 } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, parsedBody: JSON.parse(init.body) });
    return {
      ok,
      status,
      async text() {
        return typeof body === 'string' ? body : JSON.stringify(body);
      },
    };
  };
  return { calls, fetchImpl };
}

test('EURUSD BUY @ Market with SL and TP1..TP3 parses as executionReady market order without calling Layer 2 or triggering AI failure', async () => {
  const plainSignal = [
    'EURUSD BUY @ Market',
    'SL: 1.0820',
    'TP1: 1.0880',
    'TP2: 1.0910',
    'TP3: 1.0950',
  ].join('\n');

  // Exact production Telegram payload including U+200E LEFT-TO-RIGHT MARK format characters.
  const telegramSignalWithLtrMarks = 'EURUSD BUY @ Market\n\u200eSL: 1.0820\n\u200eTP1: 1.0880\n\u200eTP2: 1.0910\n\u200eTP3: 1.0950\n\u200e';

  for (const rawMessage of [plainSignal, telegramSignalWithLtrMarks]) {
    const layer1 = parseSignal(rawMessage);
    assert.equal(layer1.symbol, 'EURUSD');
    assert.equal(layer1.side, 'buy');
    assert.equal(layer1.entryPrice, null, 'market orders fill at execution time and carry null entryPrice');
    assert.equal(layer1.orderType, 'market');
    assert.equal(layer1.orderTypeStated, true, '"@ Market" explicitly states a market order');
    assert.equal(layer1.stopLoss, 1.082);
    assert.equal(layer1.takeProfit, 1.088);
    assert.deepEqual(layer1.takeProfitLevels, [1.088, 1.091, 1.095]);
    assert.equal(layer1.executionReady, true);
    assert.equal(layer1.parseError, null);
    assert.equal(needsLayer2(layer1), false, 'complete market order must not trigger Layer 2');

    // Even if the AI endpoint would return the exact production empty-content response, Layer 2 is never called.
    const brokenAi = mockFetchJson({
      choices: [{ finish_reason: 'length', message: { role: 'assistant', content: '' } }],
    });

    const { parsed, provenance, review } = await parseSignalTwoLayer(rawMessage, {
      source: 'telegram',
      config: CONFIG,
      fetchImpl: brokenAi.fetchImpl,
      logger: silentLogger,
    });
    const safety = captureSafety({ parsed, source: 'telegram', settings: {}, review });

    assert.equal(brokenAi.calls.length, 0, 'AI endpoint must not be consulted when Regex resolved BUY/SELL + SL + TP @ Market');
    assert.equal(provenance.parsedBy, 'regex');
    assert.equal(provenance.llmUsed, false);
    assert.equal(review.required, false);
    assert.equal(review.reason, null);
    assert.equal(safety.executionReady, true);
    assert.equal(Boolean(safety.reviewRequired), false);
    assert.equal(safety.parseError, null);
    assert.equal(parsed.entryPrice, null);
    assert.equal(parsed.orderType, 'market');
    assert.equal(parsed.orderTypeStated, true);
  }
});

test('all common market-entry phrasings classify as stated market orders with entryPrice null and executionReady true', async () => {
  const variants = [
    'EURUSD BUY @ Market\nSL: 1.0820\nTP: 1.0880',
    'EURUSD SELL @Market\nSL: 1.0900\nTP: 1.0820',
    'BUY EURUSD at Market Price\nSL: 1.0820\nTP: 1.0880',
    'BUY EURUSD\nEntry: @ Market\nSL: 1.0820\nTP: 1.0880',
    'BUY EURUSD\nEntry: Market\nSL: 1.0820\nTP: 1.0880',
    'BUY EURUSD\nEntry: Current Price\nSL: 1.0820\nTP: 1.0880',
    'BUY EURUSD @ Current Price\nSL: 1.0820\nTP: 1.0880',
    'BUY EURUSD @CurrentPrice\nSL: 1.0820\nTP: 1.0880',
    'BUY EURUSD CMP\nSL: 1.0820\nTP: 1.0880',
    'BUY EURUSD\nEntry: CMP\nSL: 1.0820\nTP: 1.0880',
    'BUY EURUSD Market Execution\nSL: 1.0820\nTP: 1.0880',
    'BUY EURUSD @ Spot\nSL: 1.0820\nTP: 1.0880',
    'BUY EURUSD @ Live Price\nSL: 1.0820\nTP: 1.0880',
    'EURUSD BUY @ Market\n1) SL: 1.0820\n2) TP: 1.0880',
  ];

  for (const raw of variants) {
    const parsed = parseSignal(raw);
    assert.equal(parsed.entryPrice, null, `entryPrice should be null for: ${raw}`);
    assert.equal(parsed.orderType, 'market', `orderType should be market for: ${raw}`);
    assert.equal(parsed.orderTypeStated, true, `orderTypeStated should be true for: ${raw}`);
    assert.equal(parsed.executionReady, true, `executionReady should be true for: ${raw}`);
    assert.equal(needsLayer2(parsed), false, `needsLayer2 should be false for: ${raw}`);
  }
});

test('explicit pending order without a readable entry price still asks Layer 2 instead of silently becoming a market order', () => {
  const pendingMissingEntry = parseSignal('BUY LIMIT EURUSD\nSL: 1.0820\nTP: 1.0880');
  assert.equal(pendingMissingEntry.orderType, 'limit');
  assert.equal(pendingMissingEntry.entryPrice, null);
  assert.equal(needsLayer2(pendingMissingEntry), true);
});

test('signal-llm accepts "@ Market", "Market", "Current Price", and related market-entry terms without failing validation', () => {
  const rawMessage = 'EURUSD BUY @ Market\nTP1: 1.0880\nTP2: 1.0910\nstop should be 1.0820';
  const marketTerms = [
    null,
    '',
    '@ Market',
    '@Market',
    'Market',
    'market',
    'at market',
    'Market Price',
    '@ Market Price',
    'Market Order',
    'Market Execution',
    'Current Price',
    '@ Current Price',
    'Current Market Price',
    'CMP',
    '@CMP',
    'Now',
    'Buy Now',
    'Instant Execution',
    'Immediately',
    'Spot',
    'Spot Price',
    'Live Price',
    'None',
    'N/A',
  ];

  for (const entryTerm of marketTerms) {
    if (typeof entryTerm === 'string' && entryTerm.length > 0) {
      assert.equal(isMarketEntryValue(entryTerm), true, `expected market entry term to be recognized: ${entryTerm}`);
    }
    const result = validateExtraction(
      {
        symbol: 'EURUSD',
        side: 'buy',
        entry: entryTerm,
        stop_loss: 1.082,
        take_profit: [1.088, 1.091],
        confidence: 0.95,
      },
      { rawMessage, config: CONFIG },
    );
    assert.equal(result.ok, true, `validateExtraction should succeed for entry=${JSON.stringify(entryTerm)}`);
    assert.equal(result.fields.symbol, 'EURUSD');
    assert.equal(result.fields.side, 'buy');
    assert.equal(result.fields.entry, null);
    assert.equal(result.fields.stop_loss, 1.082);
    assert.equal(result.fields.take_profit, 1.088);
  }

  // Genuine garbage in `entry` is still rejected as `malformed-price`.
  const bogus = validateExtraction(
    { symbol: 'EURUSD', side: 'buy', entry: 'next tuesday maybe', stop_loss: 1.082, take_profit: 1.088, confidence: 0.95 },
    { rawMessage, config: CONFIG },
  );
  assert.equal(bogus.ok, false);
  assert.equal(bogus.code, 'malformed-price');
});

test('extractJsonObject handles reasoning <think> blocks and unquoted @Market / Market / Current Price literals', () => {
  const rawMessage = 'EURUSD BUY @ Market\nTP1: 1.0880\nstop should be 1.0820';

  const withThinkAndUnquotedMarket = [
    '<think>The user wrote EURUSD BUY @ Market so entry is at market.</think>',
    '{"symbol": "EURUSD", "side": "buy", "entry": @ Market, "stop_loss": 1.0820, "take_profit": 1.0880, "confidence": 0.95}',
  ].join('\n');
  const extractedA = extractJsonObject(withThinkAndUnquotedMarket);
  const validatedA = validateExtraction(extractedA, { rawMessage, config: CONFIG });
  assert.equal(validatedA.ok, true);
  assert.equal(validatedA.fields.entry, null);
  assert.equal(validatedA.fields.stop_loss, 1.082);

  const unquotedCurrentPrice = '{"symbol":"EURUSD","side":"buy","entry":Current Price,"stop_loss":1.0820,"take_profit":None,"confidence":0.92}';
  const extractedB = extractJsonObject(unquotedCurrentPrice);
  const validatedB = validateExtraction(extractedB, { rawMessage, config: CONFIG });
  assert.equal(validatedB.ok, true);
  assert.equal(validatedB.fields.entry, null);
  assert.equal(validatedB.fields.take_profit, null);

  // Truncated <think> with no closing tag must be refused rather than reading partial scratchpad JSON.
  const truncatedThink = '<think>Example {"symbol":"EURUSD","side":"buy","entry":null,"stop_loss":1.0820,"take_profit":1.0880,"confidence":1}';
  assert.equal(extractJsonObject(truncatedThink), null);
});

test('two-layer parse merges AI-recovered prose SL while preserving market order when AI reports entry "@ Market"', async () => {
  const proseStopMarketSignal = [
    'EURUSD BUY @ Market',
    'TP1: 1.0880',
    'TP2: 1.0910',
    'stop should be 1.0820',
  ].join('\n');

  const aiMock = mockFetchJson({
    choices: [{
      finish_reason: 'stop',
      message: {
        content: JSON.stringify({
          symbol: 'EURUSD',
          side: 'buy',
          entry: '@ Market',
          stop_loss: 1.082,
          take_profit: [1.088, 1.091],
          confidence: 0.94,
        }),
      },
    }],
  });

  const { parsed, provenance, review } = await parseSignalTwoLayer(proseStopMarketSignal, {
    source: 'telegram',
    config: CONFIG,
    fetchImpl: aiMock.fetchImpl,
    logger: silentLogger,
  });
  const safety = captureSafety({ parsed, source: 'telegram', settings: {}, review });

  assert.equal(aiMock.calls.length, 1);
  assert.equal(aiMock.calls[0].parsedBody.max_tokens, 1024, 'requests enough output budget for reasoning models');
  assert.equal(provenance.llmUsed, true);
  assert.equal(review.required, false);
  assert.equal(safety.executionReady, true);
  assert.equal(safety.parseError, null);
  assert.equal(parsed.entryPrice, null);
  assert.equal(parsed.orderType, 'market');
  assert.equal(parsed.stopLoss, 1.082);
  assert.equal(parsed.takeProfit, 1.088);
  assert.deepEqual(parsed.takeProfitLevels, [1.088, 1.091]);
});

test('empty string content from token-exhausted reasoning model is classified as empty-reply with finish_reason technical note', async () => {
  const aiMock = mockFetchJson({
    choices: [{ finish_reason: 'length', message: { role: 'assistant', content: '' } }],
  });
  const outcome = await llmParseSignal('BUY EURUSD TP 1.0950 - stop should be 1.0800', {
    config: CONFIG,
    fetchImpl: aiMock.fetchImpl,
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, 'empty-reply');
  assert.match(String(outcome.technical), /finish_reason: length/);
});
