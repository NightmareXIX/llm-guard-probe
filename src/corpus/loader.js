import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import YAML from 'yaml';
import { validateCorpusDocument } from './schema.js';

/**
 * Loads and validates one or more corpus YAML files, aggregating them into
 * a flat, deduplicated payload list plus a stable hash for corpusVersion.
 */
export async function loadCorpus(filePaths) {
  if (!filePaths || filePaths.length === 0) {
    throw new Error('No corpus files provided.');
  }

  const sortedPaths = [...filePaths].sort();
  const errors = [];
  const payloads = [];
  const seenIds = new Map();
  const fileContents = [];

  for (const filePath of sortedPaths) {
    let raw;
    try {
      raw = await readFile(filePath, 'utf8');
    } catch (err) {
      errors.push(`${filePath}: could not read file (${err.message})`);
      continue;
    }
    fileContents.push(raw);

    let doc;
    try {
      doc = YAML.parse(raw);
    } catch (err) {
      errors.push(`${filePath}: invalid YAML (${err.message})`);
      continue;
    }

    const docErrors = validateCorpusDocument(doc, filePath);
    if (docErrors.length > 0) {
      errors.push(...docErrors);
      continue;
    }

    for (const payload of doc.payloads) {
      if (seenIds.has(payload.id)) {
        errors.push(`${filePath}: payload "${payload.id}": duplicate id (already defined in ${seenIds.get(payload.id)})`);
        continue;
      }
      seenIds.set(payload.id, filePath);
      payloads.push({ ...payload, category: doc.category });
    }
  }

  if (errors.length > 0) {
    throw new Error(`Corpus validation failed:\n${errors.map((e) => `  - ${e}`).join('\n')}`);
  }

  const corpusVersion = 'sha256:' + createHash('sha256').update(fileContents.join('\n')).digest('hex');

  return { payloads, corpusVersion };
}
