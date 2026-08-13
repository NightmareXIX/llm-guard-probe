import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { renderHtmlReport } from './template.js';

export function defaultReportPath(runId) {
  return path.join('results', `${runId}.html`);
}

export async function writeHtmlReport(outPath, resultFile, options = {}) {
  const dir = path.dirname(outPath);
  if (dir && dir !== '.') await mkdir(dir, { recursive: true });
  await writeFile(outPath, renderHtmlReport(resultFile, options));
}
