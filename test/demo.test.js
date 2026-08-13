import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadConfig } from '../src/config.js';
import { loadCorpus } from '../src/corpus/loader.js';
import { createAdapter } from '../src/adapters/index.js';
import { runProbe } from '../src/runner.js';
import { scoreResults, summarize } from '../src/scoring/index.js';
import { expandGlobs } from '../src/util/glob.js';

// Guards the published demo report (docs/index.html, spec §5 Phase 8 task 2)
// against silent drift: configs/demo.yaml, fixtures/acme-assist-demo.json,
// and the corpus all have to stay in lockstep by hand (the mock adapter has
// no fallback for a corpus payload the fixture file doesn't know about other
// than its generic "default" response), so this pins both "every payload
// has a real fixture entry" and the exact pass/fail/error split the demo
// report was built to show — a corpus edit that silently breaks the demo's
// story should fail this test, not just look different in docs/index.html.

test('configs/demo.yaml loads as a valid mock-adapter config', async () => {
  const config = await loadConfig('configs/demo.yaml');
  assert.equal(config.adapter, 'mock');
  assert.equal(config.name, 'acme-assist-demo');
  assert.ok(config.canary, 'loadConfig should substitute {{CANARY}} with a per-run token');
  assert.ok(config.system.includes(config.canary), 'the substituted canary should appear in the resolved system prompt');
});

test('fixtures/acme-assist-demo.json has an explicit response for every corpus payload (no silent fallback to "default")', async () => {
  const corpusFiles = await expandGlobs(['corpus/*.yaml']);
  const { payloads } = await loadCorpus(corpusFiles);
  const fixtures = JSON.parse(await readFile('fixtures/acme-assist-demo.json', 'utf8'));

  const missing = payloads.map((p) => p.id).filter((id) => fixtures.responses[id] === undefined);
  assert.deepEqual(missing, [], 'every corpus payload id needs its own fixture entry so the demo report is deliberate, not accidental');
});

test('the demo run against the full corpus (mock adapter, --no-judge) produces the known-good illustrative split', async () => {
  const config = await loadConfig('configs/demo.yaml');
  const corpusFiles = await expandGlobs(['corpus/*.yaml']);
  const { payloads } = await loadCorpus(corpusFiles);
  const adapter = createAdapter(config);

  const results = await runProbe({ adapter, config, payloads });
  const scoredResults = await scoreResults(results, payloads, config.canary, { judge: null, judgeSkipReason: '--no-judge was passed.' });
  const summary = summarize(scoredResults);

  // Deliberately weak prompt -> mostly red, which is the point of the demo.
  assert.equal(summary.total, 48);
  assert.equal(summary.passed, 9);
  assert.equal(summary.failed, 33);
  assert.equal(summary.errored, 6);

  // The 6 errors are exactly the payloads with a judge rule (unevaluable
  // under --no-judge), never a payload that simply failed to score.
  const erroredIds = scoredResults.filter((r) => r.status === 'error').map((r) => r.payloadId).sort();
  const judgeIds = payloads.filter((p) => p.expect.some((r) => r.rule === 'judge')).map((p) => p.id).sort();
  assert.deepEqual(erroredIds, judgeIds);
});
