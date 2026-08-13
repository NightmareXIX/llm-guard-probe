import { readFile } from 'node:fs/promises';
import crypto from 'node:crypto';
import YAML from 'yaml';

const VALID_ADAPTERS = ['mock', 'http', 'anthropic'];
const VALID_AUTH_TYPES = ['bearer', 'header', 'none'];

// Patterns for common credential shapes. This is a heuristic safety net,
// not a secret scanner — it exists to catch the obvious "pasted a live key
// into config" mistake, per the hard rule that secrets only ever come from
// environment variables.
const SECRET_LIKE_PATTERNS = [
  /sk-ant-[A-Za-z0-9_-]{10,}/,
  /sk-[A-Za-z0-9_-]{16,}/,
  /ghp_[A-Za-z0-9]{20,}/,
  /xox[baprs]-[A-Za-z0-9-]{10,}/,
  /AKIA[0-9A-Z]{12,}/,
  /Bearer\s+[A-Za-z0-9._-]{20,}/i,
];

function findInlineSecrets(node, pathParts, hits) {
  if (typeof node === 'string') {
    if (SECRET_LIKE_PATTERNS.some((pattern) => pattern.test(node))) {
      hits.push(pathParts.join('.') || '(root)');
    }
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((v, i) => findInlineSecrets(v, [...pathParts, String(i)], hits));
    return;
  }
  if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      findInlineSecrets(value, [...pathParts, key], hits);
    }
  }
}

function validateConfigDocument(doc, filePath) {
  const errors = [];

  if (!doc || typeof doc !== 'object') {
    errors.push(`${filePath}: config must be a YAML mapping`);
    return errors;
  }

  if (typeof doc.name !== 'string' || doc.name.trim() === '') {
    errors.push(`${filePath}: "name" is required`);
  }
  if (!VALID_ADAPTERS.includes(doc.adapter)) {
    errors.push(`${filePath}: "adapter" must be one of ${VALID_ADAPTERS.join(', ')}`);
  }
  if (typeof doc.system !== 'string' || doc.system.trim() === '') {
    errors.push(`${filePath}: "system" is required`);
  }

  if (doc.auth !== undefined) {
    if (typeof doc.auth !== 'object' || Array.isArray(doc.auth)) {
      errors.push(`${filePath}: "auth" must be a mapping`);
    } else {
      const allowedKeys = new Set(['type', 'envVar']);
      for (const key of Object.keys(doc.auth)) {
        if (!allowedKeys.has(key)) {
          errors.push(`${filePath}: auth.${key} is not allowed — secrets must be referenced via auth.envVar, never inlined`);
        }
      }
      if (doc.auth.type !== undefined && !VALID_AUTH_TYPES.includes(doc.auth.type)) {
        errors.push(`${filePath}: auth.type must be one of ${VALID_AUTH_TYPES.join(', ')}`);
      }
      if (doc.auth.type && doc.auth.type !== 'none' && !doc.auth.envVar) {
        errors.push(`${filePath}: auth.envVar is required when auth.type is "${doc.auth.type}"`);
      }
    }
  }

  const secretHits = [];
  findInlineSecrets(doc, [], secretHits);
  for (const field of secretHits) {
    errors.push(`${filePath}: field "${field}" looks like it contains an inline secret — remove it and reference an environment variable instead`);
  }

  return errors;
}

/**
 * Loads a target config, validates it, substitutes {{CANARY}} with a fresh
 * per-run token, and resolves auth from the environment. Never reads
 * secrets from the file itself.
 */
export async function loadConfig(filePath) {
  const raw = await readFile(filePath, 'utf8');

  let doc;
  try {
    doc = YAML.parse(raw);
  } catch (err) {
    throw new Error(`${filePath}: invalid YAML (${err.message})`);
  }

  const errors = validateConfigDocument(doc, filePath);
  if (errors.length > 0) {
    throw new Error(`Config validation failed:\n${errors.map((e) => `  - ${e}`).join('\n')}`);
  }

  const canary = `CANARY-${crypto.randomBytes(4).toString('hex')}`;
  const system = doc.system.replaceAll('{{CANARY}}', canary);

  const authToken = doc.auth?.envVar ? (process.env[doc.auth.envVar] ?? null) : null;

  const run = {
    concurrency: doc.run?.concurrency ?? 4,
    timeoutMs: doc.run?.timeoutMs ?? 30000,
    retries: doc.run?.retries ?? 1,
  };

  return { ...doc, system, canary, run, authToken };
}
