const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low'];

// Regressions loudest, then anything else worth a human's attention, then
// the boring cases last. Used by both the CLI printer and the HTML report.
export const CLASSIFICATION_ORDER = ['regressed', 'changed', 'fixed', 'new', 'removed', 'unchanged'];

function statusOf(entry) {
  return entry ? entry.status : null;
}

/**
 * Classifies a single payload's before/after status per spec §5 Phase 7
 * task 1: fixed (fail→pass), regressed (pass→fail), unchanged, new, removed.
 *
 * Real runs can also produce a `pass`/`fail` on one side and `error` on the
 * other (a transport failure, a rule that started throwing, a judge call
 * that stopped resolving) — that isn't a guardrail regression or fix, so
 * calling it either would misrepresent what happened (CLAUDE.md standing
 * rule 5: never conflate fail and error). Those land in a sixth bucket,
 * `changed`, rather than being silently folded into `unchanged`.
 */
function classify(before, after) {
  if (before === null) return 'new';
  if (after === null) return 'removed';
  if (before === after) return 'unchanged';
  if (before === 'fail' && after === 'pass') return 'fixed';
  if (before === 'pass' && after === 'fail') return 'regressed';
  return 'changed';
}

function severityRank(sev) {
  const i = SEVERITY_ORDER.indexOf(sev);
  return i === -1 ? SEVERITY_ORDER.length : i;
}

/**
 * Compares two §4.4 result files by payload id.
 *
 * @param {object} baseline - a previously written result file
 * @param {object} current - the result file for this run
 * @returns {{
 *   baselineId: string|null, currentId: string|null,
 *   entries: Array<{ payloadId, name, category, severity, before, after, classification }>,
 *   summary: { fixed, regressed, unchanged, new, removed, changed }
 * }}
 */
export function diffResults(baseline, current) {
  const baselineById = new Map((baseline?.results ?? []).map((r) => [r.payloadId, r]));
  const currentById = new Map((current?.results ?? []).map((r) => [r.payloadId, r]));
  const ids = new Set([...baselineById.keys(), ...currentById.keys()]);

  const entries = [...ids].map((payloadId) => {
    const before = baselineById.get(payloadId) ?? null;
    const after = currentById.get(payloadId) ?? null;
    const ref = after ?? before;
    const beforeStatus = statusOf(before);
    const afterStatus = statusOf(after);
    return {
      payloadId,
      name: ref.name,
      category: ref.category,
      severity: ref.severity,
      before: beforeStatus,
      after: afterStatus,
      classification: classify(beforeStatus, afterStatus),
    };
  });

  const summary = { fixed: 0, regressed: 0, unchanged: 0, new: 0, removed: 0, changed: 0 };
  for (const entry of entries) summary[entry.classification] += 1;

  return {
    baselineId: baseline?.run?.id ?? null,
    currentId: current?.run?.id ?? null,
    entries,
    summary,
  };
}

/** Regressions first, most severe first — matches the printer's intent: loudest first. */
export function sortDiffEntries(entries) {
  return [...entries].sort(
    (a, b) =>
      CLASSIFICATION_ORDER.indexOf(a.classification) - CLASSIFICATION_ORDER.indexOf(b.classification) ||
      severityRank(a.severity) - severityRank(b.severity) ||
      a.payloadId.localeCompare(b.payloadId),
  );
}

export function hasRegressions(diff) {
  return diff.summary.regressed > 0;
}
