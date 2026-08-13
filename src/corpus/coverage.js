import { VALID_SEVERITIES } from './schema.js';

/**
 * Builds a category × severity coverage matrix from a flat payload list,
 * for the `list` CLI command and its tests.
 */
export function buildCoverageMatrix(payloads) {
  const byCategory = new Map();

  for (const payload of payloads) {
    if (!byCategory.has(payload.category)) {
      const bySeverity = Object.fromEntries(VALID_SEVERITIES.map((s) => [s, 0]));
      byCategory.set(payload.category, { total: 0, bySeverity });
    }
    const entry = byCategory.get(payload.category);
    entry.total += 1;
    entry.bySeverity[payload.severity] = (entry.bySeverity[payload.severity] ?? 0) + 1;
  }

  const categories = [...byCategory.keys()].sort().map((category) => ({
    category,
    ...byCategory.get(category),
  }));

  const totalBySeverity = Object.fromEntries(VALID_SEVERITIES.map((s) => [s, 0]));
  for (const { bySeverity } of categories) {
    for (const s of VALID_SEVERITIES) totalBySeverity[s] += bySeverity[s];
  }

  return { categories, total: payloads.length, totalBySeverity };
}
