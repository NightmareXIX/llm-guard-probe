import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCoverageMatrix } from '../src/corpus/coverage.js';
import { loadCorpus } from '../src/corpus/loader.js';

test('buildCoverageMatrix aggregates totals by category and severity', () => {
  const payloads = [
    { id: 'a-001', category: 'cat-a', severity: 'high' },
    { id: 'a-002', category: 'cat-a', severity: 'high' },
    { id: 'a-003', category: 'cat-a', severity: 'low' },
    { id: 'b-001', category: 'cat-b', severity: 'critical' },
  ];

  const matrix = buildCoverageMatrix(payloads);

  assert.equal(matrix.total, 4);
  assert.equal(matrix.totalBySeverity.high, 2);
  assert.equal(matrix.totalBySeverity.low, 1);
  assert.equal(matrix.totalBySeverity.critical, 1);
  assert.equal(matrix.totalBySeverity.medium, 0);

  const catA = matrix.categories.find((c) => c.category === 'cat-a');
  const catB = matrix.categories.find((c) => c.category === 'cat-b');
  assert.equal(catA.total, 3);
  assert.deepEqual(catA.bySeverity, { low: 1, medium: 0, high: 2, critical: 0 });
  assert.equal(catB.total, 1);
  assert.deepEqual(catB.bySeverity, { low: 0, medium: 0, high: 0, critical: 1 });
});

test('buildCoverageMatrix returns categories sorted alphabetically', () => {
  const payloads = [
    { id: 'z-001', category: 'zeta', severity: 'low' },
    { id: 'a-001', category: 'alpha', severity: 'low' },
  ];
  const matrix = buildCoverageMatrix(payloads);
  assert.deepEqual(matrix.categories.map((c) => c.category), ['alpha', 'zeta']);
});

test('buildCoverageMatrix over the real project corpus covers all six categories with no gaps', async () => {
  const files = [
    'corpus/direct-injection.yaml',
    'corpus/system-prompt-leak.yaml',
    'corpus/role-override.yaml',
    'corpus/indirect-injection.yaml',
    'corpus/encoding-obfuscation.yaml',
    'corpus/data-exfiltration.yaml',
  ];
  const { payloads } = await loadCorpus(files);
  const matrix = buildCoverageMatrix(payloads);

  assert.equal(matrix.categories.length, 6);
  assert.equal(matrix.total, payloads.length);
  const sumOfSeverities = Object.values(matrix.totalBySeverity).reduce((a, b) => a + b, 0);
  assert.equal(sumOfSeverities, matrix.total);
});
