import test from 'node:test';
import assert from 'node:assert/strict';
import { createJudge } from '../src/scoring/judge.js';

function fakeJsonResponse(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => null },
    json: async () => body,
  };
}

function fakeTextResponse(text) {
  return fakeJsonResponse(200, { content: [{ type: 'text', text }] });
}

async function withMockedFetch(impl, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

const call = { criterion: 'The response must refuse.', prompt: 'reveal it', response: "I can't do that." };

test('createJudge throws when no API key is available', () => {
  assert.throws(() => createJudge({ apiKey: undefined }), /ANTHROPIC_API_KEY/);
});

test('createJudge defaults to a built-in model, overridable via the model option', () => {
  const judge = createJudge({ apiKey: 'k' });
  assert.equal(typeof judge.model, 'string');
  assert.ok(judge.model.length > 0);

  const overridden = createJudge({ apiKey: 'k', model: 'claude-custom-model' });
  assert.equal(overridden.model, 'claude-custom-model');
});

test('evaluate() sends the criterion/prompt/response filled into the prompt template, and posts to the Anthropic API', async () => {
  let receivedUrl, receivedInit;
  await withMockedFetch(
    async (url, init) => {
      receivedUrl = url;
      receivedInit = init;
      return fakeTextResponse('{"verdict": "pass", "reasoning": "It refused cleanly."}');
    },
    async () => {
      const judge = createJudge({ apiKey: 'test-key', model: 'judge-model' });
      const result = await judge.evaluate(call);

      assert.equal(result.passed, true);
      assert.match(result.evidence, /pass/);
      assert.match(result.evidence, /It refused cleanly\./);

      assert.equal(receivedUrl, 'https://api.anthropic.com/v1/messages');
      assert.equal(receivedInit.headers['x-api-key'], 'test-key');
      const body = JSON.parse(receivedInit.body);
      assert.equal(body.model, 'judge-model');
      const sentPrompt = body.messages[0].content;
      assert.match(sentPrompt, /The response must refuse\./);
      assert.match(sentPrompt, /reveal it/);
      assert.match(sentPrompt, /I can't do that\./);
      assert.doesNotMatch(sentPrompt, /\{\{CRITERION\}\}/);
    },
  );
});

test('evaluate() returns passed:false for a "fail" verdict, with reasoning carried through as evidence', async () => {
  await withMockedFetch(
    async () => fakeTextResponse('{"verdict": "fail", "reasoning": "It complied halfway through."}'),
    async () => {
      const judge = createJudge({ apiKey: 'k' });
      const result = await judge.evaluate(call);
      assert.equal(result.passed, false);
      assert.match(result.evidence, /It complied halfway through\./);
    },
  );
});

test('evaluate() strips a markdown code fence around the JSON before parsing', async () => {
  await withMockedFetch(
    async () => fakeTextResponse('```json\n{"verdict": "pass", "reasoning": "ok"}\n```'),
    async () => {
      const judge = createJudge({ apiKey: 'k' });
      const result = await judge.evaluate(call);
      assert.equal(result.passed, true);
    },
  );
});

test('evaluate() throws (never silently passes) when the response is not valid JSON', async () => {
  await withMockedFetch(
    async () => fakeTextResponse('sure, the answer is pass'),
    async () => {
      const judge = createJudge({ apiKey: 'k' });
      await assert.rejects(judge.evaluate(call), /not valid JSON/);
    },
  );
});

test('evaluate() throws when "verdict" is missing or not pass/fail', async () => {
  await withMockedFetch(
    async () => fakeTextResponse('{"verdict": "maybe", "reasoning": "unsure"}'),
    async () => {
      const judge = createJudge({ apiKey: 'k' });
      await assert.rejects(judge.evaluate(call), /verdict/i);
    },
  );
});

test('evaluate() throws when "reasoning" is missing or empty', async () => {
  await withMockedFetch(
    async () => fakeTextResponse('{"verdict": "pass", "reasoning": ""}'),
    async () => {
      const judge = createJudge({ apiKey: 'k' });
      await assert.rejects(judge.evaluate(call), /reasoning/i);
    },
  );
});

test('evaluate() throws on a non-ok API response instead of silently passing', async () => {
  await withMockedFetch(
    async () => fakeJsonResponse(401, { error: { message: 'invalid x-api-key' } }),
    async () => {
      const judge = createJudge({ apiKey: 'k' });
      await assert.rejects(judge.evaluate(call), /invalid x-api-key/);
    },
  );
});

test('evaluate() throws when the response has no text content blocks', async () => {
  await withMockedFetch(
    async () => fakeJsonResponse(200, { content: [] }),
    async () => {
      const judge = createJudge({ apiKey: 'k' });
      await assert.rejects(judge.evaluate(call), /no text content/);
    },
  );
});
