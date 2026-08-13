import { readdir } from 'node:fs/promises';
import path from 'node:path';

function globToRegExp(pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const withWildcards = escaped.replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${withWildcards}$`);
}

/**
 * Minimal single-segment glob expansion (e.g. "corpus/*.yaml") — enough for
 * this CLI's needs without pulling in a glob dependency. Does not support
 * "**" or wildcards in intermediate directory segments.
 */
export async function expandGlobs(patterns) {
  const resolved = new Set();

  for (const pattern of patterns) {
    if (!pattern.includes('*') && !pattern.includes('?')) {
      resolved.add(path.resolve(pattern));
      continue;
    }

    const dir = path.dirname(pattern);
    const regex = globToRegExp(path.basename(pattern));

    let entries;
    try {
      entries = await readdir(dir);
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (regex.test(entry)) resolved.add(path.resolve(dir, entry));
    }
  }

  return [...resolved].sort();
}
