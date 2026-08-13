import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const SCHEMA_VERSION = 1;

/** Filesystem/URL-safe run id, e.g. "2026-08-13T02-14-33Z". */
export function makeRunId(date = new Date()) {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z').replaceAll(':', '-');
}

export function defaultResultsPath(runId) {
  return path.join('results', `${runId}.json`);
}

/** Assembles the canonical §4.4 result file object (not yet written to disk). */
export function buildResultFile({ runId, target, adapter, corpusVersion, canary, startedAt, durationMs, summary, results }) {
  return {
    schemaVersion: SCHEMA_VERSION,
    run: {
      id: runId,
      target,
      adapter,
      corpusVersion,
      startedAt: startedAt.toISOString(),
      durationMs,
      canary,
    },
    summary,
    results,
  };
}

export async function writeJsonReport(outPath, resultFile) {
  const dir = path.dirname(outPath);
  if (dir && dir !== '.') await mkdir(dir, { recursive: true });
  await writeFile(outPath, JSON.stringify(resultFile, null, 2));
}
