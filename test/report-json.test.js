import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { makeRunId, defaultResultsPath, buildResultFile, writeJsonReport } from '../src/report/json.js';

test('makeRunId produces a filesystem-safe, colon-free timestamp', () => {
  const runId = makeRunId(new Date('2026-08-13T02:14:33.123Z'));
  assert.equal(runId, '2026-08-13T02-14-33Z');
  assert.ok(!runId.includes(':'));
});

test('defaultResultsPath nests the run id under results/', () => {
  assert.equal(defaultResultsPath('2026-08-13T02-14-33Z'), path.join('results', '2026-08-13T02-14-33Z.json'));
});

test('buildResultFile assembles the §4.4 shape with schemaVersion 1', () => {
  const startedAt = new Date('2026-08-13T02:14:33.000Z');
  const file = buildResultFile({
    runId: '2026-08-13T02-14-33Z',
    target: 'demo-support-bot',
    adapter: 'mock',
    corpusVersion: 'sha256:abc',
    canary: 'CANARY-abc',
    startedAt,
    durationMs: 1234,
    summary: { total: 1, passed: 1, failed: 0, errored: 0, passRate: 1, byCategory: {}, bySeverity: {} },
    results: [{ payloadId: 'p-001', status: 'pass' }],
  });

  assert.equal(file.schemaVersion, 1);
  assert.equal(file.run.id, '2026-08-13T02-14-33Z');
  assert.equal(file.run.target, 'demo-support-bot');
  assert.equal(file.run.startedAt, startedAt.toISOString());
  assert.equal(file.run.durationMs, 1234);
  assert.equal(file.run.canary, 'CANARY-abc');
  assert.equal(file.summary.total, 1);
  assert.equal(file.results.length, 1);
});

test('writeJsonReport creates parent directories and writes valid, round-trippable JSON', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'llm-guard-probe-report-'));
  try {
    const outPath = path.join(dir, 'nested', 'run.json');
    const resultFile = buildResultFile({
      runId: 'r1',
      target: 't',
      adapter: 'mock',
      corpusVersion: 'sha256:x',
      canary: 'CANARY-x',
      startedAt: new Date(),
      durationMs: 1,
      summary: { total: 0, passed: 0, failed: 0, errored: 0, passRate: 0, byCategory: {}, bySeverity: {} },
      results: [],
    });

    await writeJsonReport(outPath, resultFile);

    const written = JSON.parse(await readFile(outPath, 'utf8'));
    assert.equal(written.schemaVersion, 1);
    assert.equal(written.run.id, 'r1');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
