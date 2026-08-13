import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { expandGlobs } from '../src/util/glob.js';

test('expandGlobs resolves a wildcard pattern to every matching file, sorted', async () => {
  const files = await expandGlobs(['corpus/*.yaml']);
  assert.equal(files.length, 6);
  assert.ok(files.every((f) => f.endsWith('.yaml')));
  const sorted = [...files].sort();
  assert.deepEqual(files, sorted);
});

test('expandGlobs passes through a literal path with no wildcard', async () => {
  const files = await expandGlobs(['corpus/direct-injection.yaml']);
  assert.equal(files.length, 1);
  assert.equal(files[0], path.resolve('corpus/direct-injection.yaml'));
});

test('expandGlobs deduplicates overlapping patterns', async () => {
  const files = await expandGlobs(['corpus/*.yaml', 'corpus/direct-injection.yaml']);
  assert.equal(files.length, 6);
});

test('expandGlobs returns an empty list for a directory with no matches', async () => {
  const files = await expandGlobs(['corpus/*.does-not-exist']);
  assert.equal(files.length, 0);
});
