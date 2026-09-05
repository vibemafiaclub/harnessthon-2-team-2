// Minimal JSON-schema-subset validator (type/required/properties/items/enum).
// Covers exactly what the contracts in contracts/ use; no external deps.

export function validate(schema, value, path = '$') {
  const errors = [];
  const t = schema.type;
  if (t) {
    const actual = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
    if (actual !== t) {
      errors.push(`${path}: expected ${t}, got ${actual}`);
      return errors;
    }
  }
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${path}: value ${JSON.stringify(value)} not in enum [${schema.enum.join(', ')}]`);
  }
  if (t === 'object') {
    for (const key of schema.required ?? []) {
      if (!(key in value)) errors.push(`${path}: missing required property "${key}"`);
    }
    for (const [key, sub] of Object.entries(schema.properties ?? {})) {
      if (key in value) errors.push(...validate(sub, value[key], `${path}.${key}`));
    }
  }
  if (t === 'array' && schema.items) {
    value.forEach((item, i) => errors.push(...validate(schema.items, item, `${path}[${i}]`)));
  }
  return errors;
}

export function assertValid(schema, value, label) {
  const errors = validate(schema, value);
  if (errors.length) {
    throw new Error(`${label} failed validation:\n  ${errors.join('\n  ')}`);
  }
}
