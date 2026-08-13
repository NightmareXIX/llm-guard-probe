import { evaluateRule } from './deterministic.js';

const DEFAULT_JUDGE_SKIP_REASON = 'Judge rule not evaluated: no judge is configured for this run (see --no-judge).';

/**
 * Scores one runner result against its payload's `expect` rules.
 *
 * Deterministic rules always run first, regardless of the order they're
 * declared in the corpus — only once all of them have been evaluated do any
 * `judge` rules run, and only if none of the deterministic rules already
 * failed or errored (a deterministic failure short-circuits the payload, so
 * there's no reason to spend a judge call on it — spec §5 Phase 6 task 3).
 *
 * Status rules (see CLAUDE.md standing rule 5 — fail and error are never
 * conflated):
 *   - "error"  if the request itself errored at the transport level, any
 *              rule threw, or a `judge` rule couldn't be evaluated (no judge
 *              configured, or the judge call itself failed).
 *   - "fail"   if every rule evaluated cleanly but at least one didn't pass.
 *   - "pass"   only if every rule evaluated cleanly and passed.
 *
 * @param {object} [options]
 * @param {{ evaluate: Function }|null} [options.judge] — an `src/scoring/judge.js`
 *   client, or null/undefined if judging is unavailable for this run.
 * @param {string|null} [options.judgeSkipReason] — evidence text to use for
 *   `judge` rules when `judge` is null (e.g. "--no-judge was passed" vs
 *   "ANTHROPIC_API_KEY is not set"). Falls back to a generic message.
 */
export async function scoreResult(result, payload, canary, { judge = null, judgeSkipReason = null } = {}) {
  const base = {
    payloadId: result.payloadId,
    name: payload.name,
    category: result.category,
    severity: result.severity,
    latencyMs: result.latencyMs,
    prompt: result.prompt,
    response: result.response,
  };

  if (result.error) {
    return {
      ...base,
      status: 'error',
      rules: [],
      transportError: result.error,
    };
  }

  const deterministicRules = payload.expect.filter((rule) => rule.rule !== 'judge');
  const judgeRules = payload.expect.filter((rule) => rule.rule === 'judge');

  const rules = [];
  let hasFail = false;
  let hasError = false;

  for (const rule of deterministicRules) {
    try {
      const { passed, evidence } = evaluateRule(rule, { response: result.response, canary });
      rules.push({ rule: rule.rule, passed, evidence });
      if (!passed) hasFail = true;
    } catch (err) {
      rules.push({ rule: rule.rule, passed: null, evidence: `Rule errored during evaluation: ${err.message}` });
      hasError = true;
    }
  }

  for (const rule of judgeRules) {
    if (hasFail || hasError) {
      rules.push({
        rule: 'judge',
        passed: null,
        evidence: `Judge call skipped: a deterministic rule already ${hasError ? 'errored on' : 'failed'} this payload — no need to spend a judge call.`,
      });
      hasError = true;
      continue;
    }

    if (!judge) {
      rules.push({ rule: 'judge', passed: null, evidence: judgeSkipReason ?? DEFAULT_JUDGE_SKIP_REASON });
      hasError = true;
      continue;
    }

    try {
      const { passed, evidence } = await judge.evaluate({ criterion: rule.criterion, prompt: result.prompt, response: result.response });
      rules.push({ rule: 'judge', passed, evidence });
      if (!passed) hasFail = true;
    } catch (err) {
      rules.push({ rule: 'judge', passed: null, evidence: `Judge evaluation failed: ${err.message}` });
      hasError = true;
    }
  }

  const status = hasError ? 'error' : hasFail ? 'fail' : 'pass';
  return { ...base, status, rules };
}

/**
 * Scores every runner result. `payloads` must contain, for each result, the
 * originating payload (for its `expect` rules) — callers build this from the
 * same corpus list passed to runProbe. `options` is forwarded to every
 * scoreResult call — see its doc comment for the judge-related fields.
 */
export async function scoreResults(results, payloads, canary, options = {}) {
  const payloadsById = new Map(payloads.map((p) => [p.id, p]));
  return Promise.all(
    results.map((result) => {
      const payload = payloadsById.get(result.payloadId);
      if (!payload) {
        throw new Error(`scoreResults: no payload found for result "${result.payloadId}".`);
      }
      return scoreResult(result, payload, canary, options);
    }),
  );
}

function emptyCounts() {
  return { total: 0, passed: 0, failed: 0, errored: 0, passRate: 0 };
}

function tally(counts, status) {
  counts.total += 1;
  if (status === 'pass') counts.passed += 1;
  else if (status === 'fail') counts.failed += 1;
  else if (status === 'error') counts.errored += 1;
}

/** Builds the §4.4 `summary` block from a list of scored results. */
export function summarize(scoredResults) {
  const overall = emptyCounts();
  const byCategory = {};
  const bySeverity = {};

  for (const r of scoredResults) {
    tally(overall, r.status);
    byCategory[r.category] ??= emptyCounts();
    tally(byCategory[r.category], r.status);
    bySeverity[r.severity] ??= emptyCounts();
    tally(bySeverity[r.severity], r.status);
  }

  for (const counts of [overall, ...Object.values(byCategory), ...Object.values(bySeverity)]) {
    counts.passRate = counts.total ? counts.passed / counts.total : 0;
  }

  const { total, passed, failed, errored, passRate } = overall;
  return { total, passed, failed, errored, passRate, byCategory, bySeverity };
}
