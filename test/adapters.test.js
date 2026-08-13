import test from 'node:test';
import assert from 'node:assert/strict';
import { createAdapter } from '../src/adapters/index.js';

test('createAdapter throws an actionable error for an unregistered adapter name', () => {
  assert.throws(() => createAdapter({ adapter: 'carrier-pigeon' }), (err) => {
    assert.match(err.message, /"carrier-pigeon"/);
    assert.match(err.message, /mock/);
    return true;
  });
});

test('createAdapter routes "http" and "anthropic" to their real factories (Phase 4)', () => {
  // Each factory validates its own required config fields, so a bare
  // { adapter } is enough to prove the registry wiring without a real
  // request — the specific validation errors are covered in
  // adapters-http.test.js and adapters-anthropic.test.js.
  assert.throws(() => createAdapter({ name: 'x', adapter: 'http' }), /adapter "http"/);
  process.env.ANTHROPIC_API_KEY = 'test-key';
  try {
    assert.throws(() => createAdapter({ name: 'x', adapter: 'anthropic' }), /adapter "anthropic"/);
  } finally {
    delete process.env.ANTHROPIC_API_KEY;
  }
});

test('mock adapter replays the matching fixture by payload id', async () => {
  const adapter = createAdapter({ name: 'demo-support-bot', adapter: 'mock' });
  assert.equal(adapter.name, 'mock');

  const result = await adapter.send({ canary: 'CANARY-deadbeef', payloadId: 'ro-001' });
  assert.match(result.text, /Acme support assistant/);
  assert.equal(result.error, null);
  assert.equal(typeof result.latencyMs, 'number');
});

test('mock adapter substitutes the canary only when leakCanary is set', async () => {
  const adapter = createAdapter({ name: 'demo-support-bot', adapter: 'mock' });

  const leaking = await adapter.send({ canary: 'CANARY-deadbeef', payloadId: 'spl-001' });
  assert.match(leaking.text, /CANARY-deadbeef/);

  const nonLeaking = await adapter.send({ canary: 'CANARY-deadbeef', payloadId: 'ro-001' });
  assert.ok(!nonLeaking.text.includes('CANARY-deadbeef'));
});

test('mock adapter falls back to the fixture default for an unmatched payload id', async () => {
  const adapter = createAdapter({ name: 'demo-support-bot', adapter: 'mock' });
  const result = await adapter.send({ canary: 'CANARY-deadbeef', payloadId: 'does-not-exist' });
  assert.equal(result.text, "I'm sorry, I can't help with that request.");
});
