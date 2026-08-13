import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadCorpus } from '../src/corpus/loader.js';

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'llm-guard-probe-corpus-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const VALID_DOC = `
category: direct-injection
description: Test category.
reference: "OWASP LLM01"
payloads:
  - id: di-001
    name: Test payload
    severity: high
    prompt: hello
    expect:
      - rule: no_canary_leak
    notes: what a failure would mean
`;

test('loadCorpus aggregates real project corpus files', async () => {
  const files = [
    'corpus/direct-injection.yaml',
    'corpus/system-prompt-leak.yaml',
    'corpus/role-override.yaml',
    'corpus/indirect-injection.yaml',
    'corpus/encoding-obfuscation.yaml',
    'corpus/data-exfiltration.yaml',
  ];
  const { payloads, corpusVersion } = await loadCorpus(files);
  assert.ok(payloads.length >= 40 && payloads.length <= 60, `expected 40-60 payloads, got ${payloads.length}`);
  assert.match(corpusVersion, /^sha256:[0-9a-f]{64}$/);
  assert.ok(payloads.every((p) => p.category && p.id));
});

test('loadCorpus real project corpus has 6-10 payloads per category, covering every category', async () => {
  const files = [
    'corpus/direct-injection.yaml',
    'corpus/system-prompt-leak.yaml',
    'corpus/role-override.yaml',
    'corpus/indirect-injection.yaml',
    'corpus/encoding-obfuscation.yaml',
    'corpus/data-exfiltration.yaml',
  ];
  const { payloads } = await loadCorpus(files);

  const expectedCategories = [
    'direct-injection',
    'system-prompt-leak',
    'role-override',
    'indirect-injection',
    'encoding-obfuscation',
    'data-exfiltration',
  ];

  const counts = new Map();
  for (const p of payloads) counts.set(p.category, (counts.get(p.category) ?? 0) + 1);

  for (const category of expectedCategories) {
    const count = counts.get(category) ?? 0;
    assert.ok(count >= 6 && count <= 10, `${category}: expected 6-10 payloads, got ${count}`);
  }
  assert.equal(counts.size, expectedCategories.length);
});

test('loadCorpus real project corpus: every payload id is unique and matches its category prefix', async () => {
  const files = [
    'corpus/direct-injection.yaml',
    'corpus/system-prompt-leak.yaml',
    'corpus/role-override.yaml',
    'corpus/indirect-injection.yaml',
    'corpus/encoding-obfuscation.yaml',
    'corpus/data-exfiltration.yaml',
  ];
  const { payloads } = await loadCorpus(files);

  const prefixes = {
    'direct-injection': 'di',
    'system-prompt-leak': 'spl',
    'role-override': 'ro',
    'indirect-injection': 'ii',
    'encoding-obfuscation': 'eo',
    'data-exfiltration': 'de',
  };

  const seen = new Set();
  for (const p of payloads) {
    assert.ok(!seen.has(p.id), `duplicate id: ${p.id}`);
    seen.add(p.id);
    assert.ok(p.id.startsWith(`${prefixes[p.category]}-`), `${p.id}: id does not match prefix for ${p.category}`);
  }
});

test('loadCorpus is deterministic regardless of input file order', async () => {
  const forward = await loadCorpus(['corpus/direct-injection.yaml', 'corpus/system-prompt-leak.yaml']);
  const reversed = await loadCorpus(['corpus/system-prompt-leak.yaml', 'corpus/direct-injection.yaml']);
  assert.equal(forward.corpusVersion, reversed.corpusVersion);
});

test('loadCorpus rejects a payload missing required fields, naming file and problem', async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, 'bad.yaml');
    await writeFile(
      file,
      `
category: direct-injection
description: Test category.
reference: "OWASP LLM01"
payloads:
  - id: di-001
    name: Missing severity and notes
    prompt: hello
    expect:
      - rule: no_canary_leak
`,
    );

    await assert.rejects(() => loadCorpus([file]), (err) => {
      assert.match(err.message, /bad\.yaml/);
      assert.match(err.message, /severity/);
      assert.match(err.message, /notes/);
      return true;
    });
  });
});

test('loadCorpus rejects an unknown rule name', async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, 'bad-rule.yaml');
    await writeFile(
      file,
      `
category: direct-injection
description: Test category.
reference: "OWASP LLM01"
payloads:
  - id: di-001
    name: Bad rule
    severity: high
    prompt: hello
    expect:
      - rule: not_a_real_rule
    notes: n/a
`,
    );

    await assert.rejects(() => loadCorpus([file]), /unknown rule "not_a_real_rule"/);
  });
});

test('loadCorpus rejects duplicate payload ids across files, naming both', async () => {
  await withTempDir(async (dir) => {
    const fileA = path.join(dir, 'a.yaml');
    const fileB = path.join(dir, 'b.yaml');
    await writeFile(fileA, VALID_DOC);
    await writeFile(fileB, VALID_DOC);

    await assert.rejects(() => loadCorpus([fileA, fileB]), (err) => {
      assert.match(err.message, /duplicate id/);
      assert.match(err.message, /di-001/);
      return true;
    });
  });
});

test('loadCorpus rejects invalid YAML, naming the file', async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, 'broken.yaml');
    await writeFile(file, 'category: [unterminated');

    await assert.rejects(() => loadCorpus([file]), (err) => {
      assert.match(err.message, /broken\.yaml/);
      return true;
    });
  });
});

test('loadCorpus throws when given no files', async () => {
  await assert.rejects(() => loadCorpus([]));
});
