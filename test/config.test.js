import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';

async function withTempFile(contents, fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'llm-guard-probe-config-'));
  const file = path.join(dir, 'config.yaml');
  await writeFile(file, contents);
  try {
    return await fn(file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('loadConfig substitutes a fresh CANARY token into system prompt', async () => {
  await withTempFile(
    `
name: demo
adapter: mock
system: |
  secret code: {{CANARY}}
`,
    async (file) => {
      const config = await loadConfig(file);
      assert.match(config.canary, /^CANARY-[0-9a-f]{8}$/);
      assert.match(config.system, new RegExp(`secret code: ${config.canary}`));
      assert.ok(!config.system.includes('{{CANARY}}'));
    },
  );
});

test('loadConfig produces a different canary on each call', async () => {
  await withTempFile(
    `
name: demo
adapter: mock
system: "code: {{CANARY}}"
`,
    async (file) => {
      const a = await loadConfig(file);
      const b = await loadConfig(file);
      assert.notEqual(a.canary, b.canary);
    },
  );
});

test('loadConfig applies run defaults when run block is omitted', async () => {
  await withTempFile(
    `
name: demo
adapter: mock
system: "hello"
`,
    async (file) => {
      const config = await loadConfig(file);
      assert.deepEqual(config.run, { concurrency: 4, timeoutMs: 30000, retries: 1 });
    },
  );
});

test('loadConfig rejects missing required fields', async () => {
  await withTempFile('adapter: mock\nsystem: hello\n', async (file) => {
    await assert.rejects(() => loadConfig(file), /"name" is required/);
  });
});

test('loadConfig rejects an unknown adapter', async () => {
  await withTempFile('name: demo\nadapter: carrier-pigeon\nsystem: hello\n', async (file) => {
    await assert.rejects(() => loadConfig(file), /"adapter" must be one of/);
  });
});

test('loadConfig rejects an inline bearer token in headers', async () => {
  // Assembled at runtime, not written as one literal, so secret scanners
  // (e.g. GitGuardian) don't flag this fake, non-functional placeholder as
  // a real Anthropic key in the diff. It only needs to be shaped like one
  // to exercise SECRET_LIKE_PATTERNS in src/config.js.
  const fakeAnthropicKeyShape = ['sk-ant-', 'api03-', 'abcdefghijklmnopqrstuvwxyz'].join('');
  await withTempFile(
    `
name: demo
adapter: http
system: hello
headers:
  Authorization: "Bearer ${fakeAnthropicKeyShape}"
`,
    async (file) => {
      await assert.rejects(() => loadConfig(file), /looks like it contains an inline secret/);
    },
  );
});

test('loadConfig rejects an auth block with an inline value instead of envVar', async () => {
  await withTempFile(
    `
name: demo
adapter: http
system: hello
auth:
  type: bearer
  key: hardcoded-value-not-an-env-var
`,
    async (file) => {
      await assert.rejects(() => loadConfig(file), /auth\.key is not allowed/);
    },
  );
});

test('loadConfig rejects auth.type "header" without an auth.header name', async () => {
  await withTempFile(
    `
name: demo
adapter: http
system: hello
auth:
  type: header
  envVar: SOME_TEST_TOKEN_VAR
`,
    async (file) => {
      await assert.rejects(() => loadConfig(file), /auth\.header .* is required when auth\.type is "header"/);
    },
  );
});

test('loadConfig accepts auth.type "header" with an auth.header name', async () => {
  await withTempFile(
    `
name: demo
adapter: http
system: hello
auth:
  type: header
  envVar: SOME_TEST_TOKEN_VAR
  header: X-Api-Key
`,
    async (file) => {
      const config = await loadConfig(file);
      assert.equal(config.auth.header, 'X-Api-Key');
    },
  );
});

test('loadConfig accepts a proper auth.envVar reference and does not read its value from the file', async () => {
  await withTempFile(
    `
name: demo
adapter: http
system: hello
auth:
  type: bearer
  envVar: SOME_TEST_TOKEN_VAR
`,
    async (file) => {
      delete process.env.SOME_TEST_TOKEN_VAR;
      const config = await loadConfig(file);
      assert.equal(config.authToken, null);

      process.env.SOME_TEST_TOKEN_VAR = 'resolved-from-env';
      const config2 = await loadConfig(file);
      assert.equal(config2.authToken, 'resolved-from-env');
      delete process.env.SOME_TEST_TOKEN_VAR;
    },
  );
});
