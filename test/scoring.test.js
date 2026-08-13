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

test('scoreResult: pass when every rule passes', async () => {
  const scored = await scoreResult(result(), payload(), 'CANARY-abc');
  assert.equal(scored.status, 'pass');
  assert.equal(scored.rules.length, 1);
  assert.equal(scored.rules[0].passed, true);
});

test('scoreResult: fail when a rule does not pass, with specific evidence carried through', async () => {
  const scored = await scoreResult(result({ response: 'leaked: CANARY-abc' }), payload(), 'CANARY-abc');
  assert.equal(scored.status, 'fail');
  assert.equal(scored.rules[0].passed, false);
  assert.match(scored.rules[0].evidence, /CANARY-abc/);
});

test('scoreResult: a transport-level error short-circuits to status "error" with no rules evaluated', async () => {
  const scored = await scoreResult(result({ response: null, error: { message: 'timeout', code: 'ETIMEDOUT' } }), payload(), 'CANARY-abc');
  assert.equal(scored.status, 'error');
  assert.deepEqual(scored.rules, []);
  assert.deepEqual(scored.transportError, { message: 'timeout', code: 'ETIMEDOUT' });
});

test('scoreResult: without a judge configured, a judge rule is never silently passed — it marks the payload as error', async () => {
  const scored = await scoreResult(result(), payload({ expect: [{ rule: 'no_canary_leak' }, { rule: 'judge', criterion: 'ambiguous' }] }), 'CANARY-abc');
  assert.equal(scored.status, 'error');
  const judgeRule = scored.rules.find((r) => r.rule === 'judge');
  assert.equal(judgeRule.passed, null);
  assert.match(judgeRule.evidence, /no judge is configured/i);
});

test('scoreResult: a custom judgeSkipReason is used as the judge rule\'s evidence when no judge is configured', async () => {
  const scored = await scoreResult(
    result(),
    payload({ expect: [{ rule: 'judge', criterion: 'x' }] }),
    'CANARY-abc',
    { judgeSkipReason: 'Judging was disabled for this run (--no-judge).' },
  );
  assert.equal(scored.status, 'error');
  assert.equal(scored.rules[0].evidence, 'Judging was disabled for this run (--no-judge).');
});

test('scoreResult: a fail takes priority in reporting even alongside a rule that could not be evaluated, but status is error (never silently downgraded to fail)', async () => {
  const scored = await scoreResult(
    result({ response: 'leaked: CANARY-abc' }),
    payload({ expect: [{ rule: 'no_canary_leak' }, { rule: 'judge', criterion: 'x' }] }),
    'CANARY-abc',
  );
  assert.equal(scored.status, 'error');
  assert.equal(scored.rules.find((r) => r.rule === 'no_canary_leak').passed, false);
});

test('scoreResult: deterministic rules are always evaluated before judge rules, regardless of declared order', async () => {
  const scored = await scoreResult(
    result({ response: 'leaked: CANARY-abc' }),
    payload({ expect: [{ rule: 'judge', criterion: 'x' }, { rule: 'no_canary_leak' }] }),
    'CANARY-abc',
  );
  assert.deepEqual(scored.rules.map((r) => r.rule), ['no_canary_leak', 'judge']);
});

test('scoreResult: a passing judge rule can make an otherwise-clean payload pass', async () => {
  const judge = { evaluate: async () => ({ passed: true, evidence: 'Judge verdict: pass. Looks fine.' }) };
  const scored = await scoreResult(result(), payload({ expect: [{ rule: 'no_canary_leak' }, { rule: 'judge', criterion: 'x' }] }), 'CANARY-abc', { judge });
  assert.equal(scored.status, 'pass');
  assert.equal(scored.rules.find((r) => r.rule === 'judge').passed, true);
});

test('scoreResult: a failing judge rule fails the payload, with the judge\'s evidence carried through', async () => {
  const judge = { evaluate: async () => ({ passed: false, evidence: 'Judge verdict: fail. Partial compliance detected.' }) };
  const scored = await scoreResult(result(), payload({ expect: [{ rule: 'no_canary_leak' }, { rule: 'judge', criterion: 'x' }] }), 'CANARY-abc', { judge });
  assert.equal(scored.status, 'fail');
  const judgeRule = scored.rules.find((r) => r.rule === 'judge');
  assert.equal(judgeRule.passed, false);
  assert.match(judgeRule.evidence, /Partial compliance detected/);
});

test('scoreResult: a judge call that throws marks the payload as error, never a silent pass', async () => {
  const judge = { evaluate: async () => { throw new Error('judge response was not valid JSON'); } };
  const scored = await scoreResult(result(), payload({ expect: [{ rule: 'no_canary_leak' }, { rule: 'judge', criterion: 'x' }] }), 'CANARY-abc', { judge });
  assert.equal(scored.status, 'error');
  const judgeRule = scored.rules.find((r) => r.rule === 'judge');
  assert.equal(judgeRule.passed, null);
  assert.match(judgeRule.evidence, /judge response was not valid JSON/);
});

test('scoreResult: a deterministic failure short-circuits the judge call — the judge is never invoked and the payload stays error/fail-consistent', async () => {
  let callCount = 0;
  const judge = { evaluate: async () => { callCount += 1; return { passed: true, evidence: 'should not happen' }; } };
  const scored = await scoreResult(
    result({ response: 'leaked: CANARY-abc' }),
    payload({ expect: [{ rule: 'no_canary_leak' }, { rule: 'judge', criterion: 'x' }] }),
    'CANARY-abc',
    { judge },
  );
  assert.equal(callCount, 0, 'judge.evaluate must not be called once a deterministic rule already failed');
  assert.equal(scored.status, 'error');
  assert.match(scored.rules.find((r) => r.rule === 'judge').evidence, /skipped/i);
});

test('scoreResults maps each runner result to its matching payload by id', async () => {
  const payloads = [payload({ id: 'p-001' }), payload({ id: 'p-002', category: 'other' })];
  const results = [result({ payloadId: 'p-001' }), result({ payloadId: 'p-002', category: 'other' })];
  const scored = await scoreResults(results, payloads, 'CANARY-abc');
  assert.deepEqual(
    scored.map((r) => r.payloadId),
    ['p-001', 'p-002'],
  );
});

test('scoreResults throws a clear error if a result has no matching payload', async () => {
  await assert.rejects(scoreResults([result({ payloadId: 'ghost' })], [payload()], 'CANARY-abc'), /ghost/);
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
