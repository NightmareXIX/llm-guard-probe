export const VALID_SEVERITIES = ['low', 'medium', 'high', 'critical'];

export const RULE_PARAMS = {
  no_canary_leak: [],
  must_refuse: [],
  must_not_match: ['pattern'],
  must_match: ['pattern'],
  must_not_contain: ['text'],
  max_length: ['chars'],
  judge: ['criterion'],
};

const ID_PATTERN = /^[a-z0-9]+-\d{3,}$/;

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function validateRule(rule, context, errors) {
  if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
    errors.push(`${context}: each "expect" entry must be a mapping with a "rule" key`);
    return;
  }
  const params = RULE_PARAMS[rule.rule];
  if (params === undefined) {
    errors.push(`${context}: unknown rule "${rule.rule}" (known rules: ${Object.keys(RULE_PARAMS).join(', ')})`);
    return;
  }
  for (const param of params) {
    const value = rule[param];
    const isChars = param === 'chars';
    const valid = isChars ? typeof value === 'number' && value > 0 : isNonEmptyString(value);
    if (!valid) {
      errors.push(`${context}: rule "${rule.rule}" requires a ${isChars ? 'positive number' : 'non-empty string'} "${param}" param`);
    }
  }
}

function validatePayload(payload, index, filePath, errors) {
  const context = `${filePath}: payload[${index}]`;

  if (!payload || typeof payload !== 'object') {
    errors.push(`${context}: must be a mapping`);
    return;
  }

  const idContext = isNonEmptyString(payload.id) ? `${filePath}: payload "${payload.id}"` : context;

  if (!isNonEmptyString(payload.id)) {
    errors.push(`${context}: "id" is required`);
  } else if (!ID_PATTERN.test(payload.id)) {
    errors.push(`${idContext}: "id" must match "<category-prefix>-NNN", e.g. "spl-001"`);
  }

  if (!isNonEmptyString(payload.name)) errors.push(`${idContext}: "name" is required`);
  if (!VALID_SEVERITIES.includes(payload.severity)) {
    errors.push(`${idContext}: "severity" must be one of ${VALID_SEVERITIES.join(', ')}`);
  }
  if (!isNonEmptyString(payload.prompt)) errors.push(`${idContext}: "prompt" is required`);
  if (!isNonEmptyString(payload.notes)) errors.push(`${idContext}: "notes" is required — explain what a failure would mean`);

  if (!Array.isArray(payload.expect) || payload.expect.length === 0) {
    errors.push(`${idContext}: "expect" must be a non-empty list of rules`);
  } else {
    payload.expect.forEach((rule) => validateRule(rule, idContext, errors));
  }
}

/**
 * Validates a parsed corpus YAML document against the §4.3 schema.
 * Returns a list of human-readable error strings; never throws.
 */
export function validateCorpusDocument(doc, filePath) {
  const errors = [];

  if (!doc || typeof doc !== 'object') {
    errors.push(`${filePath}: file must contain a YAML mapping`);
    return errors;
  }

  if (!isNonEmptyString(doc.category)) errors.push(`${filePath}: "category" is required`);
  if (!isNonEmptyString(doc.description)) errors.push(`${filePath}: "description" is required`);
  if (!isNonEmptyString(doc.reference)) errors.push(`${filePath}: "reference" is required (cite the public source, e.g. "OWASP LLM01")`);

  if (!Array.isArray(doc.payloads) || doc.payloads.length === 0) {
    errors.push(`${filePath}: "payloads" must be a non-empty list`);
  } else {
    doc.payloads.forEach((payload, index) => validatePayload(payload, index, filePath, errors));
  }

  return errors;
}
