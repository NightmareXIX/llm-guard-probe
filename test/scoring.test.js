import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreResult, scoreResults, summarize } from '../src/scoring/index.js';

function payload(overrides = {}) {
  return {
    id: 'p-001',
    name: 'Test payload',
    category: 'cat',
    severity: 'high',
    expect: [{ rule: 'no_canary_leak' }],
    ...overrides,
  };
}

function result(overrides = {}) {
  return {
    payloadId: 'p-001',
    category: 'cat',
    severity: 'high',
    response: 'I cannot help with that.',
    latencyMs: 10,
    prompt: 'do the thing',
    error: null,
    ...overrides,
  };
}

test('scoreResult: pass when every rule passes', () => {
  const scored = scoreResult(result(), payload(), 'CANARY-abc');
  assert.equal(scored.status, 'pass');
  assert.equal(scored.rules.length, 1);
  assert.equal(scored.rules[0].passed, true);
});

test('scoreResult: fail when a rule does not pass, with specific evidence carried through', () => {
  const scored = scoreResult(result({ response: 'leaked: CANARY-abc' }), payload(), 'CANARY-abc');
  assert.equal(scored.status, 'fail');
  assert.equal(scored.rules[0].passed, false);
  assert.match(scored.rules[0].evidence, /CANARY-abc/);
});

test('scoreResult: a transport-level error short-circuits to status "error" with no rules evaluated', () => {
  const scored = scoreResult(result({ response: null, error: { message: 'timeout', code: 'ETIMEDOUT' } }), payload(), 'CANARY-abc');
  assert.equal(scored.status, 'error');
  assert.deepEqual(scored.rules, []);
  assert.deepEqual(scored.transportError, { message: 'timeout', code: 'ETIMEDOUT' });
});

test('scoreResult: a judge rule is never silently passed — it marks the payload as error', () => {
  const scored = scoreResult(result(), payload({ expect: [{ rule: 'no_canary_leak' }, { rule: 'judge', criterion: 'ambiguous' }] }), 'CANARY-abc');
  assert.equal(scored.status, 'error');
  const judgeRule = scored.rules.find((r) => r.rule === 'judge');
  assert.equal(judgeRule.passed, null);
  assert.match(judgeRule.evidence, /phase 6/i);
});

test('scoreResult: a fail takes priority in reporting even alongside a rule that could not be evaluated, but status is error (never silently downgraded to fail)', () => {
  const scored = scoreResult(
    result({ response: 'leaked: CANARY-abc' }),
    payload({ expect: [{ rule: 'no_canary_leak' }, { rule: 'judge', criterion: 'x' }] }),
    'CANARY-abc',
  );
  assert.equal(scored.status, 'error');
  assert.equal(scored.rules.find((r) => r.rule === 'no_canary_leak').passed, false);
});

test('scoreResults maps each runner result to its matching payload by id', () => {
  const payloads = [payload({ id: 'p-001' }), payload({ id: 'p-002', category: 'other' })];
  const results = [result({ payloadId: 'p-001' }), result({ payloadId: 'p-002', category: 'other' })];
  const scored = scoreResults(results, payloads, 'CANARY-abc');
  assert.deepEqual(
    scored.map((r) => r.payloadId),
    ['p-001', 'p-002'],
  );
});

test('scoreResults throws a clear error if a result has no matching payload', () => {
  assert.throws(() => scoreResults([result({ payloadId: 'ghost' })], [payload()], 'CANARY-abc'), /ghost/);
});

test('summarize: aggregates totals, per-category, and per-severity counts with correct pass rates', () => {
  const scored = [
    { payloadId: 'a', category: 'cat-1', severity: 'high', status: 'pass' },
    { payloadId: 'b', category: 'cat-1', severity: 'high', status: 'fail' },
    { payloadId: 'c', category: 'cat-2', severity: 'low', status: 'error' },
    { payloadId: 'd', category: 'cat-2', severity: 'low', status: 'pass' },
  ];
  const summary = summarize(scored);

  assert.equal(summary.total, 4);
  assert.equal(summary.passed, 2);
  assert.equal(summary.failed, 1);
  assert.equal(summary.errored, 1);
  assert.equal(summary.passRate, 0.5);

  assert.equal(summary.byCategory['cat-1'].total, 2);
  assert.equal(summary.byCategory['cat-1'].passed, 1);
  assert.equal(summary.byCategory['cat-1'].passRate, 0.5);

  assert.equal(summary.byCategory['cat-2'].total, 2);
  assert.equal(summary.byCategory['cat-2'].errored, 1);

  assert.equal(summary.bySeverity['high'].total, 2);
  assert.equal(summary.bySeverity['low'].total, 2);
});

test('summarize: an empty result list produces zeroed totals with no division-by-zero NaN', () => {
  const summary = summarize([]);
  assert.equal(summary.total, 0);
  assert.equal(summary.passRate, 0);
  assert.deepEqual(summary.byCategory, {});
});
