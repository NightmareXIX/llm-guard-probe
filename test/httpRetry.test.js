import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchWithRetry } from '../src/util/httpRetry.js';

function fakeResponse(status, headers = {}) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { status, ok: status >= 200 && status < 300, headers: { get: (name) => lower[name.toLowerCase()] ?? null } };
}

function mockFetch(responses) {
  const calls = [];
  const fn = async (...args) => {
    calls.push(args);
    const next = responses[Math.min(calls.length - 1, responses.length - 1)];
    if (next instanceof Error) throw next;
    return next;
  };
  fn.calls = calls;
  return fn;
}

async function withMockedFetch(responses, fn) {
  const original = globalThis.fetch;
  const mock = mockFetch(responses);
  globalThis.fetch = mock;
  try {
    return await fn(mock);
  } finally {
    globalThis.fetch = original;
  }
}

test('fetchWithRetry returns a successful response on the first attempt without retrying', async () => {
  await withMockedFetch([fakeResponse(200)], async (mock) => {
    const response = await fetchWithRetry('http://x', {});
    assert.equal(response.status, 200);
    assert.equal(mock.calls.length, 1);
  });
});

test('fetchWithRetry retries a 429, honouring Retry-After, and returns the eventual success', async () => {
  await withMockedFetch([fakeResponse(429, { 'retry-after': '0' }), fakeResponse(200)], async (mock) => {
    const response = await fetchWithRetry('http://x', {}, { baseDelayMs: 1 });
    assert.equal(response.status, 200);
    assert.equal(mock.calls.length, 2);
  });
});

test('fetchWithRetry retries a 5xx with exponential backoff when there is no Retry-After header', async () => {
  await withMockedFetch([fakeResponse(503), fakeResponse(503), fakeResponse(200)], async (mock) => {
    const response = await fetchWithRetry('http://x', {}, { baseDelayMs: 1, maxAttempts: 3 });
    assert.equal(response.status, 200);
    assert.equal(mock.calls.length, 3);
  });
});

test('fetchWithRetry gives up after maxAttempts and returns the last (still-failing) response rather than throwing', async () => {
  await withMockedFetch([fakeResponse(500), fakeResponse(500), fakeResponse(500)], async (mock) => {
    const response = await fetchWithRetry('http://x', {}, { baseDelayMs: 1, maxAttempts: 3 });
    assert.equal(response.status, 500);
    assert.equal(mock.calls.length, 3);
  });
});

test('fetchWithRetry does not retry a non-429, non-5xx response (e.g. 400)', async () => {
  await withMockedFetch([fakeResponse(400), fakeResponse(200)], async (mock) => {
    const response = await fetchWithRetry('http://x', {}, { baseDelayMs: 1 });
    assert.equal(response.status, 400);
    assert.equal(mock.calls.length, 1);
  });
});

test('fetchWithRetry lets a network-level failure (fetch rejecting) propagate rather than retrying it', async () => {
  await withMockedFetch([new Error('ECONNRESET')], async () => {
    await assert.rejects(() => fetchWithRetry('http://x', {}, { baseDelayMs: 1 }), /ECONNRESET/);
  });
});
