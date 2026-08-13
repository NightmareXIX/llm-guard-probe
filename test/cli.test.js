import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const CLI_PATH = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const ROOT = fileURLToPath(new URL('..', import.meta.url));

// Runs the real CLI as a subprocess against the project's own mock config
// and full corpus (no network calls — the mock adapter replays fixtures).
// This is what actually proves the exit codes spec §5 Phase 7 asks for:
// unit-testing diff.js proves classification is correct in isolation, but
// only spawning the CLI proves --fail-under / --fail-on-regression / diff
// are wired to process.exitCode correctly end to end.
async function runCli(args) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [CLI_PATH, ...args], { cwd: ROOT });
    return { code: 0, stdout, stderr };
  } catch (err) {
    // execFile rejects on non-zero exit; the exit code is still what we want to assert on.
    return { code: err.code ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

let workDir;

test.beforeEach(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), 'llm-guard-probe-cli-'));
});

test.afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

// The mock fixture for spl-001 is set up (fixtures/demo-support-bot.json) to
// deterministically leak the canary, so a plain run against the full corpus
// always has exactly one real failure (spl-001) — every other exit-code
// scenario below is layered on top of that known-stable baseline.
test('run against the mock corpus exits 1 on the baseline failure, with no --fail-under/--fail-on-regression', async () => {
  const out = path.join(workDir, 'run.json');
  const result = await runCli(['run', '--config', 'configs/mock.yaml', '--corpus', 'corpus/*.yaml', '--out', out, '--no-report', '--quiet']);

  assert.equal(result.code, 1);
  const resultFile = JSON.parse(await readFile(out, 'utf8'));
  assert.equal(resultFile.results.find((r) => r.payloadId === 'spl-001').status, 'fail');
});

test('run --fail-under exits 1 when the pass rate is below the threshold', async () => {
  const out = path.join(workDir, 'run.json');
  const result = await runCli([
    'run', '--config', 'configs/mock.yaml', '--corpus', 'corpus/*.yaml', '--out', out, '--no-report', '--quiet',
    '--fail-under', '0.99',
  ]);

  assert.equal(result.code, 1);
  assert.match(result.stderr, /below --fail-under threshold/);
});

test('run --fail-under does not turn a threshold pass into extra failure noise beyond the real failure', async () => {
  const out = path.join(workDir, 'run.json');
  // 0 is trivially satisfied by any pass rate; exit code should be driven
  // solely by the corpus's one real failure (spl-001), same as with no flag.
  const result = await runCli([
    'run', '--config', 'configs/mock.yaml', '--corpus', 'corpus/*.yaml', '--out', out, '--no-report', '--quiet',
    '--fail-under', '0',
  ]);

  assert.equal(result.code, 1);
  assert.doesNotMatch(result.stderr, /below --fail-under threshold/);
});

test('run --fail-under rejects an out-of-range value with exit 2, before doing any work', async () => {
  const result = await runCli(['run', '--config', 'configs/mock.yaml', '--corpus', 'corpus/*.yaml', '--no-report', '--fail-under', '1.5']);

  assert.equal(result.code, 2);
  assert.match(result.stderr, /--fail-under must be a number between 0 and 1/);
});

test('run --fail-on-regression without --baseline is a usage error, exit 2', async () => {
  const result = await runCli(['run', '--config', 'configs/mock.yaml', '--corpus', 'corpus/*.yaml', '--no-report', '--fail-on-regression']);

  assert.equal(result.code, 2);
  assert.match(result.stderr, /--fail-on-regression requires --baseline/);
});

test('run --baseline with an unreadable file warns and continues when --fail-on-regression is not set', async () => {
  const out = path.join(workDir, 'run.json');
  const result = await runCli([
    'run', '--config', 'configs/mock.yaml', '--corpus', 'corpus/*.yaml', '--out', out, '--no-report',
    '--baseline', path.join(workDir, 'nonexistent.json'),
  ]);

  assert.match(result.stderr, /Could not read baseline.*Continuing without a baseline diff/s);
  assert.equal(result.code, 1, 'still exits 1 from the real spl-001 failure, not from the missing baseline');
});

test('run --baseline with an unreadable file and --fail-on-regression fails loudly, exit 2', async () => {
  const result = await runCli([
    'run', '--config', 'configs/mock.yaml', '--corpus', 'corpus/*.yaml', '--no-report',
    '--baseline', path.join(workDir, 'nonexistent.json'), '--fail-on-regression',
  ]);

  assert.equal(result.code, 2);
  assert.match(result.stderr, /Refusing to continue with --fail-on-regression set/);
});

test('run --baseline --fail-on-regression detects a real regression against a hand-built baseline and exits 1', async () => {
  const currentOut = path.join(workDir, 'current.json');
  const first = await runCli(['run', '--config', 'configs/mock.yaml', '--corpus', 'corpus/*.yaml', '--out', currentOut, '--no-report', '--quiet']);
  assert.equal(first.code, 1);

  const current = JSON.parse(await readFile(currentOut, 'utf8'));
  // spl-001 deterministically fails against the real mock fixtures (see the
  // baseline-failure test above). Mark it "pass" in a fake baseline so this
  // run shows a genuine pass -> fail regression against the real result.
  const baseline = JSON.parse(JSON.stringify(current));
  baseline.run.id = 'fake-baseline';
  baseline.results.find((r) => r.payloadId === 'spl-001').status = 'pass';
  const baselinePath = path.join(workDir, 'baseline.json');
  await writeFile(baselinePath, JSON.stringify(baseline));

  const reportOut = path.join(workDir, 'report.html');
  const second = await runCli([
    'run', '--config', 'configs/mock.yaml', '--corpus', 'corpus/*.yaml', '--out', path.join(workDir, 'current2.json'),
    '--report', reportOut, '--baseline', baselinePath, '--fail-on-regression', '--quiet',
  ]);

  assert.equal(second.code, 1);
  assert.match(second.stderr, /1 payload\(s\) regressed since baseline/);
  assert.match(second.stdout, /Changes since baseline/);
  assert.match(second.stdout, /spl-001/);

  const html = await readFile(reportOut, 'utf8');
  assert.match(html, /id="baseline-diff"/);
});

test('diff command classifies a hand-constructed pair of result files and exits 1 only when there is a regression', async () => {
  const baseline = {
    schemaVersion: 1,
    run: { id: 'baseline-run' },
    results: [
      { payloadId: 'a', name: 'A', category: 'cat', severity: 'high', status: 'fail' },
      { payloadId: 'b', name: 'B', category: 'cat', severity: 'low', status: 'pass' },
      { payloadId: 'c', name: 'C', category: 'cat', severity: 'medium', status: 'pass' },
      { payloadId: 'd', name: 'D', category: 'cat', severity: 'low', status: 'pass' },
    ],
  };
  const current = {
    schemaVersion: 1,
    run: { id: 'current-run' },
    results: [
      { payloadId: 'a', name: 'A', category: 'cat', severity: 'high', status: 'pass' },
      { payloadId: 'b', name: 'B', category: 'cat', severity: 'low', status: 'fail' },
      { payloadId: 'c', name: 'C', category: 'cat', severity: 'medium', status: 'pass' },
      { payloadId: 'e', name: 'E', category: 'cat', severity: 'low', status: 'pass' },
    ],
  };
  const baselinePath = path.join(workDir, 'baseline.json');
  const currentPath = path.join(workDir, 'current.json');
  await writeFile(baselinePath, JSON.stringify(baseline));
  await writeFile(currentPath, JSON.stringify(current));

  const result = await runCli(['diff', baselinePath, currentPath]);

  assert.equal(result.code, 1);
  assert.match(result.stdout, /1 regressed/);
  assert.match(result.stdout, /1 fixed/);
  assert.match(result.stdout, /1 new/);
  assert.match(result.stdout, /1 removed/);
  assert.match(result.stdout, /1 unchanged/);

  // Diffing a result file against itself has nothing to report and must exit 0.
  const identical = await runCli(['diff', currentPath, currentPath]);
  assert.equal(identical.code, 0);
  assert.match(identical.stdout, /0 regressed/);
});

test('diff command exits 2 on an unreadable file', async () => {
  const result = await runCli(['diff', path.join(workDir, 'missing-a.json'), path.join(workDir, 'missing-b.json')]);
  assert.equal(result.code, 2);
});
