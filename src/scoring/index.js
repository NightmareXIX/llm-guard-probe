import { evaluateRule } from './deterministic.js';

/**
 * Scores one runner result against its payload's `expect` rules.
 *
 * Status rules (see CLAUDE.md standing rule 5 — fail and error are never
 * conflated):
 *   - "error"  if the request itself errored at the transport level, or any
 *              rule threw / is a `judge` rule (Phase 6, not implemented yet).
 *   - "fail"   if every rule evaluated cleanly but at least one didn't pass.
 *   - "pass"   only if every rule evaluated cleanly and passed.
 */
export function scoreResult(result, payload, canary) {
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

  const rules = [];
  let hasFail = false;
  let hasError = false;

  for (const rule of payload.expect) {
    if (rule.rule === 'judge') {
      rules.push({
        rule: 'judge',
        passed: null,
        evidence: 'judge rule requires the Phase 6 LLM-as-judge, which is not implemented yet — this rule could not be scored.',
      });
      hasError = true;
      continue;
    }

    try {
      const { passed, evidence } = evaluateRule(rule, { response: result.response, canary });
      rules.push({ rule: rule.rule, passed, evidence });
      if (!passed) hasFail = true;
    } catch (err) {
      rules.push({ rule: rule.rule, passed: null, evidence: `Rule errored during evaluation: ${err.message}` });
      hasError = true;
    }
  }

  const status = hasError ? 'error' : hasFail ? 'fail' : 'pass';
  return { ...base, status, rules };
}

/**
 * Scores every runner result. `payloads` must contain, for each result, the
 * originating payload (for its `expect` rules) — callers build this from the
 * same corpus list passed to runProbe.
 */
export function scoreResults(results, payloads, canary) {
  const payloadsById = new Map(payloads.map((p) => [p.id, p]));
  return results.map((result) => {
    const payload = payloadsById.get(result.payloadId);
    if (!payload) {
      throw new Error(`scoreResults: no payload found for result "${result.payloadId}".`);
    }
    return scoreResult(result, payload, canary);
  });
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
