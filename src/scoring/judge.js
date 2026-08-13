import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchWithRetry } from '../util/httpRetry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROMPT_PATH = path.join(__dirname, '..', '..', 'prompts', 'judge-prompt.md');

const API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
const MAX_TOKENS = 512;

let cachedTemplate = null;

async function loadPromptTemplate() {
  // Cached after first read — the file never changes mid-run, and every
  // judge rule in a run reuses the same template.
  if (!cachedTemplate) cachedTemplate = await readFile(PROMPT_PATH, 'utf8');
  return cachedTemplate;
}

function fillTemplate(template, { criterion, prompt, response }) {
  return template
    .replaceAll('{{CRITERION}}', criterion)
    .replaceAll('{{PROMPT}}', prompt)
    .replaceAll('{{RESPONSE}}', response);
}

// The judge is instructed to return bare JSON, but models routinely wrap
// output in a ```json fence anyway — strip one defensively before parsing.
function stripCodeFence(text) {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1].trim() : trimmed;
}

function parseVerdict(text) {
  let parsed;
  try {
    parsed = JSON.parse(stripCodeFence(text));
  } catch (err) {
    throw new Error(`judge response was not valid JSON (${err.message}). Raw response: ${text.slice(0, 200)}`);
  }
  if (parsed.verdict !== 'pass' && parsed.verdict !== 'fail') {
    throw new Error(`judge response "verdict" must be "pass" or "fail", got ${JSON.stringify(parsed.verdict)}`);
  }
  if (typeof parsed.reasoning !== 'string' || parsed.reasoning.trim() === '') {
    throw new Error('judge response is missing a non-empty "reasoning" string');
  }
  return parsed;
}

/**
 * Creates an LLM-as-judge client backed directly by the Anthropic API — the
 * judge always uses ANTHROPIC_API_KEY, independent of whichever adapter the
 * target under test is configured with (mock/http/anthropic), because the
 * judge is not the system under test.
 *
 * Never silently passes: any failure — network, non-2xx response, or a
 * response that isn't the strict { verdict, reasoning } JSON shape — throws.
 * Callers (src/scoring/index.js) must catch and record the payload as
 * `error`, never `pass` or `fail`.
 */
export function createJudge({ apiKey = process.env.ANTHROPIC_API_KEY, model = process.env.JUDGE_MODEL || DEFAULT_MODEL } = {}) {
  if (!apiKey) {
    throw new Error(
      'The judge requires ANTHROPIC_API_KEY to be set (it always calls the Anthropic API directly, regardless of the target adapter). Set it in your environment or .env, or pass --no-judge to skip judge rules entirely.',
    );
  }

  return {
    model,
    async evaluate({ criterion, prompt, response }) {
      const template = await loadPromptTemplate();
      const judgePrompt = fillTemplate(template, { criterion, prompt, response });

      const httpResponse = await fetchWithRetry(API_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
        },
        body: JSON.stringify({
          model,
          max_tokens: MAX_TOKENS,
          messages: [{ role: 'user', content: judgePrompt }],
        }),
      });

      let raw;
      try {
        raw = await httpResponse.json();
      } catch (err) {
        throw new Error(`judge API response was not valid JSON at the HTTP layer: ${err.message}`);
      }

      if (!httpResponse.ok) {
        throw new Error(raw?.error?.message ?? `judge API returned HTTP ${httpResponse.status}`);
      }

      const text = Array.isArray(raw.content)
        ? raw.content.filter((block) => block.type === 'text').map((block) => block.text).join('')
        : '';
      if (!text) {
        throw new Error('judge API response contained no text content blocks');
      }

      const { verdict, reasoning } = parseVerdict(text);
      return {
        passed: verdict === 'pass',
        evidence: `Judge (${model}) verdict: ${verdict}. ${reasoning}`,
      };
    },
  };
}
