import { performance } from 'node:perf_hooks';
import { fetchWithRetry } from '../util/httpRetry.js';

const API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MAX_TOKENS = 1024;

/**
 * Direct Anthropic Messages API adapter. The key always comes from
 * ANTHROPIC_API_KEY — not from the target config's generic `auth` block —
 * because this adapter talks to one specific, known provider rather than an
 * arbitrary endpoint (that's what src/adapters/http.js is for).
 */
export function create(config) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('adapter "anthropic": ANTHROPIC_API_KEY is not set. Export it in your environment or .env file (see .env.example).');
  }
  if (typeof config.model !== 'string' || config.model.trim() === '') {
    throw new Error(`adapter "anthropic": target config "${config.name}" is missing required field "model".`);
  }
  const maxTokens = config.maxTokens ?? DEFAULT_MAX_TOKENS;

  return {
    name: 'anthropic',
    async send({ system, messages }) {
      const started = performance.now();

      // Network-level failures propagate (thrown), so the runner's own
      // retry/timeout handling applies to them; fetchWithRetry only retries
      // completed-but-rate-limited/server-error responses.
      const response = await fetchWithRetry(API_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
        },
        body: JSON.stringify({
          model: config.model,
          max_tokens: maxTokens,
          system,
          messages: messages.map((m) => ({ role: m.role, content: m.content })),
        }),
      });

      const latencyMs = Math.round(performance.now() - started);

      let raw;
      try {
        raw = await response.json();
      } catch (err) {
        return {
          text: null,
          latencyMs,
          raw: null,
          error: { message: `Could not parse the Anthropic API response as JSON: ${err.message}`, code: 'BAD_RESPONSE' },
        };
      }

      if (!response.ok) {
        return {
          text: null,
          latencyMs,
          raw,
          error: {
            message: raw?.error?.message ?? `Anthropic API returned HTTP ${response.status}`,
            code: raw?.error?.type ?? `HTTP_${response.status}`,
          },
        };
      }

      const text = Array.isArray(raw.content)
        ? raw.content
            .filter((block) => block.type === 'text')
            .map((block) => block.text)
            .join('')
        : '';

      if (!text) {
        return {
          text: null,
          latencyMs,
          raw,
          error: { message: 'Anthropic API response contained no text content blocks.', code: 'EMPTY_RESPONSE' },
        };
      }

      return { text, latencyMs, raw, error: null };
    },
  };
}
