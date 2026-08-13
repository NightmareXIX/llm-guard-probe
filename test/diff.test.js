import test from 'node:test';
import assert from 'node:assert/strict';
import { diffResults, sortDiffEntries, hasRegressions } from '../src/util/diff.js';

function resultFile(runId, results) {
  return { schemaVersion: 1, run: { id: runId }, results };
}

function r(payloadId, status, overrides = {}) {
  return { payloadId, status, name: `${payloadId} name`, category: 'direct-injection', severity: 'high', ...overrides };
}

test('diffResults classifies fail→pass as fixed and pass→fail as regressed', () => {
  const baseline = resultFile('baseline', [r('a', 'fail'), r('b', 'pass')]);
  const current = resultFile('current', [r('a', 'pass'), r('b', 'fail')]);

  const diff = diffResults(baseline, current);

  assert.equal(diff.entries.find((e) => e.payloadId === 'a').classification, 'fixed');
  assert.equal(diff.entries.find((e) => e.payloadId === 'b').classification, 'regressed');
  assert.equal(diff.summary.fixed, 1);
  assert.equal(diff.summary.regressed, 1);
});

test('diffResults classifies identical status as unchanged', () => {
  const baseline = resultFile('b', [r('a', 'pass'), r('b', 'fail'), r('c', 'error')]);
  const current = resultFile('c', [r('a', 'pass'), r('b', 'fail'), r('c', 'error')]);

  const diff = diffResults(baseline, current);

  assert.ok(diff.entries.every((e) => e.classification === 'unchanged'));
  assert.equal(diff.summary.unchanged, 3);
});

test('diffResults classifies payloads only in current as new, only in baseline as removed', () => {
  const baseline = resultFile('b', [r('gone', 'pass')]);
  const current = resultFile('c', [r('fresh', 'fail')]);

  const diff = diffResults(baseline, current);

  const gone = diff.entries.find((e) => e.payloadId === 'gone');
  const fresh = diff.entries.find((e) => e.payloadId === 'fresh');
  assert.equal(gone.classification, 'removed');
  assert.equal(gone.after, null);
  assert.equal(fresh.classification, 'new');
  assert.equal(fresh.before, null);
  assert.equal(diff.summary.removed, 1);
  assert.equal(diff.summary.new, 1);
});

test('diffResults classifies transitions involving "error" as changed, not fixed/regressed/unchanged', () => {
  const baseline = resultFile('b', [r('a', 'pass'), r('b', 'fail'), r('c', 'error')]);
  const current = resultFile('c', [r('a', 'error'), r('b', 'error'), r('c', 'pass')]);

  const diff = diffResults(baseline, current);

  assert.equal(diff.entries.find((e) => e.payloadId === 'a').classification, 'changed');
  assert.equal(diff.entries.find((e) => e.payloadId === 'b').classification, 'changed');
  assert.equal(diff.entries.find((e) => e.payloadId === 'c').classification, 'changed');
  assert.equal(diff.summary.changed, 3);
  assert.equal(diff.summary.regressed, 0, 'pass->error must not be reported as a regression');
  assert.equal(diff.summary.fixed, 0, 'error->pass must not be silently reported as fixed');
});

test('diffResults carries name/category/severity from the current result, falling back to baseline when removed', () => {
  const baseline = resultFile('b', [r('removed-one', 'pass', { category: 'role-override', severity: 'low' })]);
  const current = resultFile('c', [r('removed-one', 'pass', { category: 'ignored-should-not-appear' })].slice(0, 0));

  const diff = diffResults(baseline, current);
  const entry = diff.entries.find((e) => e.payloadId === 'removed-one');
  assert.equal(entry.category, 'role-override');
  assert.equal(entry.severity, 'low');
});

test('diffResults exposes baselineId/currentId from each result file\'s run.id', () => {
  const diff = diffResults(resultFile('run-1', []), resultFile('run-2', []));
  assert.equal(diff.baselineId, 'run-1');
  assert.equal(diff.currentId, 'run-2');
});

test('hasRegressions is true only when at least one payload regressed', () => {
  const noRegression = diffResults(resultFile('b', [r('a', 'fail')]), resultFile('c', [r('a', 'pass')]));
  const withRegression = diffResults(resultFile('b', [r('a', 'pass')]), resultFile('c', [r('a', 'fail')]));

  assert.equal(hasRegressions(noRegression), false);
  assert.equal(hasRegressions(withRegression), true);
});

test('sortDiffEntries orders regressed first, then changed, fixed, new, removed, unchanged, tie-broken by severity then id', () => {
  const baseline = resultFile('b', [
    r('crit-regress', 'pass', { severity: 'critical' }),
    r('low-regress', 'pass', { severity: 'low' }),
    r('fixed-1', 'fail'),
    r('same', 'pass'),
  ]);
  const current = resultFile('c', [
    r('crit-regress', 'fail', { severity: 'critical' }),
    r('low-regress', 'fail', { severity: 'low' }),
    r('fixed-1', 'pass'),
    r('same', 'pass'),
    r('brand-new', 'pass'),
  ]);

  const diff = diffResults(baseline, current);
  const order = sortDiffEntries(diff.entries).map((e) => e.payloadId);

  assert.deepEqual(order, ['crit-regress', 'low-regress', 'fixed-1', 'brand-new', 'same']);
});
