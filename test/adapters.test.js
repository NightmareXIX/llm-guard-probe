import test from 'node:test';
import assert from 'node:assert/strict';
import { createAdapter } from '../src/adapters/index.js';

test('createAdapter throws an actionable error for an unregistered adapter name', () => {
  assert.throws(() => createAdapter({ adapter: 'http' }), (err) => {
    assert.match(err.message, /"http"/);
    assert.match(err.message, /mock/);
    return true;
  });
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
