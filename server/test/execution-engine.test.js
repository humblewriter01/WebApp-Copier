import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateOrderVolume, countSignalEntryDeals } from '../services/execution-engine.js';

const specification = { minVolume: 0.01, maxVolume: 5, volumeStep: 0.01, tickSize: 0.0001 };

test('risk-based sizing uses losing tick value and rounds down to volume step', () => {
  const volume = calculateOrderVolume({
    mode: 'risk_based', fixedLotSize: 0.01, balance: 1000, riskPercent: 1, side: 'buy',
    entryPrice: 1.1, stopLoss: 1.089, specification, price: { lossTickValue: 1 },
  });
  assert.equal(volume, 0.09);
});

test('risk sizing fails closed when account-currency tick value or safe stop distance is missing', () => {
  assert.throws(() => calculateOrderVolume({ mode: 'risk_based', balance: 1000, riskPercent: 1, side: 'buy', entryPrice: 1.1, stopLoss: 1.09, specification, price: {} }), /losing tick value/i);
  assert.throws(() => calculateOrderVolume({ mode: 'risk_based', balance: 1000, riskPercent: 1, side: 'buy', entryPrice: 1.09, stopLoss: 1.1, specification, price: { lossTickValue: 1 } }), /wrong side/i);
  assert.throws(() => calculateOrderVolume({ mode: 'risk_based', balance: 1000, riskPercent: 1, side: 'buy', entryPrice: 1.1, stopLoss: 1.09, specification: { ...specification, minVolume: 0.2 }, price: { lossTickValue: 1 } }), /below the broker minimum/i);
});

test('fixed lot validates broker range and step without silently rounding', () => {
  assert.equal(calculateOrderVolume({ mode: 'fixed', fixedLotSize: 0.03, specification }), 0.03);
  assert.throws(() => calculateOrderVolume({ mode: 'fixed', fixedLotSize: 0.025, specification }), /volume step/i);
  assert.throws(() => calculateOrderVolume({ mode: 'fixed', fixedLotSize: 10, specification }), /between/i);
});

test('volume increments are aligned from the broker minimum rather than zero', () => {
  const brokerRules = { minVolume: 0.1, maxVolume: 1, volumeStep: 0.03, tickSize: 0.01 };
  assert.equal(calculateOrderVolume({ mode: 'fixed', fixedLotSize: 0.13, specification: brokerRules }), 0.13);
  assert.equal(calculateOrderVolume({ mode: 'risk_based', balance: 170, riskPercent: 1, side: 'buy', entryPrice: 1, stopLoss: 0.9, specification: brokerRules, price: { lossTickValue: 1 } }), 0.16);
});

test('daily entry counting ignores exits, deduplicates order IDs and fails closed on missing classification or identity', () => {
  const deals = [
    { type: 'DEAL_TYPE_BUY', entryType: 'DEAL_ENTRY_IN', orderId: 'open-1' },
    { type: 'DEAL_TYPE_BUY', entryType: 'DEAL_ENTRY_IN', orderId: 'open-1' },
    { type: 'DEAL_TYPE_SELL', entryType: 'DEAL_ENTRY_OUT', id: 'close-1' },
    { type: 'DEAL_TYPE_SELL', entryType: 'DEAL_ENTRY_INOUT', id: 'reverse-1' },
    { type: 'DEAL_TYPE_BALANCE', id: 'balance-1' },
  ];
  assert.equal(countSignalEntryDeals(deals), 2);
  assert.throws(() => countSignalEntryDeals([{ type: 'DEAL_TYPE_BUY', orderId: 'missing-classification' }]), /classification/i);
  assert.throws(() => countSignalEntryDeals([{ type: 'DEAL_TYPE_SELL', entryType: 'DEAL_ENTRY_IN' }]), /identifier/i);
});
