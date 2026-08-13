import { performance } from 'node:perf_hooks';
import { fetchWithRetry } from '../util/httpRetry.js';

/** Recursively substitutes {{SYSTEM}} and {{PROMPT}} into every string in requestTemplate. */
function substituteTemplate(node, vars) {
  if (typeof node === 'string') {
    return node.replaceAll('{{SYSTEM}}', vars.system).replaceAll('{{PROMPT}}', vars.prompt);
  }
  if (Array.isArray(node)) return node.map((n) => substituteTemplate(n, vars));
  if (node && typeof node === 'object') {
    return Object.fromEntries(Object.entries(node).map(([key, value]) => [key, substituteTemplate(value, vars)]));
  }
  return node;
}

/** Resolves a "a.b.c" dot path against a parsed JSON response. */
function resolvePath(obj, dotPath) {
  let current = obj;
  for (const part of dotPath.split('.')) {
    if (current === null || typeof current !== 'object' || !(part in current)) {
      return undefined;
    }
    current = current[part];
  }
  return current;
}

function describeKeys(value) {
  if (value === null || typeof value !== 'object') return String(value);
  return Array.isArray(value) ? `[array of ${value.length}]` : `[${Object.keys(value).join(', ')}]`;
}

function buildAuthHeaders(config) {
  const { auth, authToken } = config;
  if (!auth || !auth.type || auth.type === 'none') return {};

  if (auth.type === 'bearer') return { Authorization: `Bearer ${authToken}` };
  if (auth.type === 'header') return { [auth.header]: authToken };

  throw new Error(`adapter "http": unknown auth.type "${auth.type}".`);
}

/**
 * Generic HTTP adapter: any chat-style JSON endpoint, described entirely by
 * the target config's requestTemplate/responsePath/auth/headers fields — the
 * runner and this adapter never need to know anything API-specific.
 */
export function create(config) {
  if (typeof config.endpoint !== 'string' || config.endpoint.trim() === '') {
    throw new Error(`adapter "http": target config "${config.name}" is missing required field "endpoint".`);
  }
  if (!config.requestTemplate || typeof config.requestTemplate !== 'object') {
    throw new Error(`adapter "http": target config "${config.name}" is missing required field "requestTemplate".`);
  }
  if (typeof config.responsePath !== 'string' || config.responsePath.trim() === '') {
    throw new Error(`adapter "http": target config "${config.name}" is missing required field "responsePath".`);
  }
  if (config.auth?.type && config.auth.type !== 'none' && !config.authToken) {
    throw new Error(`adapter "http": auth.envVar "${config.auth.envVar}" is not set in the environment.`);
  }

  const method = config.method ?? 'POST';

  return {
    name: 'http',
    async send({ system, messages }) {
      const prompt = messages.map((m) => m.content).join('\n');
      const body = substituteTemplate(config.requestTemplate, { system, prompt });

      const headers = {
        'content-type': 'application/json',
        ...config.headers,
        ...buildAuthHeaders(config),
      };

      const started = performance.now();

      // Network-level failures propagate (thrown) for the runner's own
      // retry/timeout handling; fetchWithRetry only retries completed
      // 429/5xx responses.
      const response = await fetchWithRetry(config.endpoint, {
        method,
        headers,
        body: JSON.stringify(body),
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
          error: { message: `Could not parse response from ${config.endpoint} as JSON: ${err.message}`, code: 'BAD_RESPONSE' },
        };
      }

      if (!response.ok) {
        return {
          text: null,
          latencyMs,
          raw,
          error: { message: `Target API returned HTTP ${response.status} for ${config.endpoint}.`, code: `HTTP_${response.status}` },
        };
      }

      const text = resolvePath(raw, config.responsePath);
      if (typeof text !== 'string') {
        return {
          text: null,
          latencyMs,
          raw,
          error: {
            message: `responsePath "${config.responsePath}" did not resolve to a string. Response shape at the root was ${describeKeys(raw)}.`,
            code: 'RESPONSE_PATH_NOT_FOUND',
          },
        };
      }

      return { text, latencyMs, raw, error: null };
    },
  };
}
