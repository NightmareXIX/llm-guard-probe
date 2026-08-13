function runWithConcurrency(items, concurrency, worker) {
  return new Promise((resolve) => {
    if (items.length === 0) {
      resolve([]);
      return;
    }

    const results = new Array(items.length);
    let next = 0;
    let inFlight = 0;
    let finished = 0;

    function launch() {
      while (inFlight < concurrency && next < items.length) {
        const index = next++;
        inFlight++;
        worker(items[index], index).then((result) => {
          results[index] = result;
          inFlight--;
          finished++;
          if (finished === items.length) resolve(results);
          else launch();
        });
      }
    }

    launch();
  });
}

async function withTimeout(promise, timeoutMs) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(Object.assign(new Error(`Timed out after ${timeoutMs}ms`), { code: 'ETIMEDOUT' }));
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Runs every payload against `adapter`, bounded by config.run.concurrency.
 *
 * Retry applies only to thrown errors (transport/timeout failures) — an
 * adapter that instead *returns* `{ error }` is signalling an application-
 * level failure (e.g. a 4xx from the target API) that a retry can't fix,
 * so it's passed straight through unscored.
 */
export async function runProbe({ adapter, config, payloads, onProgress }) {
  const { concurrency, timeoutMs, retries } = config.run;
  let completed = 0;

  return runWithConcurrency(payloads, concurrency, async (payload) => {
    let lastError;
    let attempt = 0;

    while (attempt <= retries) {
      attempt++;
      try {
        const response = await withTimeout(
          adapter.send({
            system: config.system,
            messages: [{ role: 'user', content: payload.prompt }],
            canary: config.canary,
            payloadId: payload.id,
          }),
          timeoutMs,
        );
        completed++;
        onProgress?.(completed, payloads.length);
        return {
          payloadId: payload.id,
          category: payload.category,
          severity: payload.severity,
          prompt: payload.prompt,
          response: response.text,
          latencyMs: response.latencyMs,
          raw: response.raw,
          error: response.error ?? null,
        };
      } catch (err) {
        lastError = err;
      }
    }

    completed++;
    onProgress?.(completed, payloads.length);
    return {
      payloadId: payload.id,
      category: payload.category,
      severity: payload.severity,
      prompt: payload.prompt,
      response: null,
      latencyMs: null,
      raw: null,
      error: { message: lastError.message, code: lastError.code ?? 'TRANSPORT_ERROR' },
    };
  });
}
