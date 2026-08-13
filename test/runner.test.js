import test from 'node:test';
import assert from 'node:assert/strict';
import { runProbe } from '../src/runner.js';

function baseConfig(overrides = {}) {
  return {
    system: 'sys',
    canary: 'CANARY-test',
    run: { concurrency: 2, timeoutMs: 200, retries: 1, ...overrides },
  };
}

const payloads = [
  { id: 'p1', category: 'cat', severity: 'low', prompt: 'a' },
  { id: 'p2', category: 'cat', severity: 'low', prompt: 'b' },
  { id: 'p3', category: 'cat', severity: 'low', prompt: 'c' },
];

test('runProbe returns one result per payload, in payload order', async () => {
  const adapter = { send: async ({ payloadId }) => ({ text: `echo:${payloadId}`, latencyMs: 1, raw: null, error: null }) };
  const results = await runProbe({ adapter, config: baseConfig(), payloads });
  assert.deepEqual(
    results.map((r) => r.payloadId),
    ['p1', 'p2', 'p3'],
  );
  assert.equal(results[0].response, 'echo:p1');
});

test('runProbe retries a thrown (transport) error and succeeds within the retry budget', async () => {
  let calls = 0;
  const adapter = {
    send: async () => {
      calls++;
      if (calls === 1) throw new Error('ECONNRESET');
      return { text: 'ok', latencyMs: 1, raw: null, error: null };
    },
  };
  const results = await runProbe({ adapter, config: baseConfig({ retries: 1 }), payloads: [payloads[0]] });
  assert.equal(results[0].error, null);
  assert.equal(results[0].response, 'ok');
  assert.equal(calls, 2);
});

test('runProbe gives up after exhausting retries and reports a transport error', async () => {
  let calls = 0;
  const adapter = {
    send: async () => {
      calls++;
      throw new Error('always fails');
    },
  };
  const results = await runProbe({ adapter, config: baseConfig({ retries: 1 }), payloads: [payloads[0]] });
  assert.equal(calls, 2);
  assert.equal(results[0].response, null);
  assert.match(results[0].error.message, /always fails/);
});

test('runProbe does not retry an application-level error returned by the adapter', async () => {
  let calls = 0;
  const adapter = {
    send: async () => {
      calls++;
      return { text: null, latencyMs: 1, raw: null, error: { message: '429 rate limited', code: 'RATE_LIMIT' } };
    },
  };
  const results = await runProbe({ adapter, config: baseConfig({ retries: 3 }), payloads: [payloads[0]] });
  assert.equal(calls, 1);
  assert.deepEqual(results[0].error, { message: '429 rate limited', code: 'RATE_LIMIT' });
});

test('runProbe times out a slow adapter call and treats it as a retryable transport error', async () => {
  const adapter = {
    send: () => new Promise((resolve) => setTimeout(() => resolve({ text: 'too slow', latencyMs: 1, raw: null, error: null }), 500)),
  };
  const results = await runProbe({ adapter, config: baseConfig({ timeoutMs: 20, retries: 0 }), payloads: [payloads[0]] });
  assert.equal(results[0].error.code, 'ETIMEDOUT');
});

test('runProbe respects the configured concurrency ceiling', async () => {
  let active = 0;
  let maxActive = 0;
  const adapter = {
    send: async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active--;
      return { text: 'ok', latencyMs: 1, raw: null, error: null };
    },
  };
  await runProbe({ adapter, config: baseConfig({ concurrency: 2 }), payloads });
  assert.ok(maxActive <= 2);
});

test('runProbe reports progress via onProgress as each payload completes', async () => {
  const adapter = { send: async () => ({ text: 'ok', latencyMs: 1, raw: null, error: null }) };
  const calls = [];
  await runProbe({ adapter, config: baseConfig(), payloads, onProgress: (done, total) => calls.push([done, total]) });
  assert.equal(calls.length, payloads.length);
  assert.deepEqual(calls[calls.length - 1], [3, 3]);
});
