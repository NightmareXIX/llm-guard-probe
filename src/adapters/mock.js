import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

const DEFAULT_RESPONSE = "I'm sorry, I can't help with that request.";

/**
 * Fixture-replay adapter — no network calls, no API spend. Looks up
 * fixtures/<config.name>.json, keyed by payload id. An entry can be a plain
 * string, or `{ text, leakCanary: true }` to test canary-leak failure paths
 * deterministically.
 */
export function create(config) {
  const fixturePath = path.resolve('fixtures', `${config.name}.json`);
  let fixturesPromise;

  function loadFixtures() {
    if (!fixturesPromise) {
      fixturesPromise = readFile(fixturePath, 'utf8')
        .then((raw) => JSON.parse(raw))
        .catch((err) => {
          throw new Error(`mock adapter: could not load fixtures at ${fixturePath} (${err.message})`);
        });
    }
    return fixturesPromise;
  }

  return {
    name: 'mock',
    async send({ canary, payloadId }) {
      const started = performance.now();
      const fixtures = await loadFixtures();
      const entry = fixtures.responses?.[payloadId];

      let text;
      if (entry === undefined) {
        text = fixtures.default ?? DEFAULT_RESPONSE;
      } else if (typeof entry === 'string') {
        text = entry;
      } else {
        text = entry.leakCanary ? entry.text.replaceAll('{{CANARY}}', canary) : entry.text;
      }

      return {
        text,
        latencyMs: Math.round(performance.now() - started),
        raw: { fixturePath, matched: entry !== undefined },
        error: null,
      };
    },
  };
}
