const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 500;

function parseRetryAfterMs(header) {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const dateMs = Date.parse(header);
  if (!Number.isNaN(dateMs)) return Math.max(0, dateMs - Date.now());
  return null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * fetch() wrapped with rate-limit-aware retry: on HTTP 429 or 5xx, waits per
 * the Retry-After header when the target sends one, otherwise falls back to
 * exponential backoff with jitter, up to maxAttempts total tries.
 *
 * This is deliberately separate from the runner's own retry/timeout logic
 * (src/runner.js), which only covers *transport*-level failures — i.e.
 * fetch() itself throwing (DNS, connection reset, timeout). A completed
 * HTTP response, even a 429 or 500, is not a transport failure as far as
 * the runner is concerned, so retrying it here — where the adapter can
 * actually read Retry-After and the response body — is the right layer.
 *
 * Network-level failures are intentionally NOT caught here; they propagate
 * to the caller so the runner's transport retry/timeout still applies.
 */
export async function fetchWithRetry(url, init, { maxAttempts = DEFAULT_MAX_ATTEMPTS, baseDelayMs = DEFAULT_BASE_DELAY_MS } = {}) {
  let response;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    response = await fetch(url, init);
    if (response.status !== 429 && response.status < 500) {
      return response;
    }
    if (attempt === maxAttempts - 1) break;

    const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'));
    const backoffMs = retryAfterMs ?? baseDelayMs * 2 ** attempt + Math.random() * 100;
    await sleep(backoffMs);
  }
  return response;
}
