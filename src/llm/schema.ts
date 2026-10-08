/**
 * Turns a JSON schema written for OpenAI's json_schema response format into
 * one Anthropic's structured output accepts:
 *
 *   - every object gets `additionalProperties: false` (required there);
 *   - `type: ['integer', 'null']`, and an enum that contains null, become an
 *     `anyOf` with a `{ type: 'null' }` branch;
 *   - length and range constraints are dropped (unsupported). The property
 *     description already states the limit, and callers check it themselves
 *     where it matters (splitArtistOrString);
 *   - the wrapper's description goes on the root.
 *
 * The input is never changed; the OpenAI adapter sends it as written.
 */
import { LlmRequestError } from './errors';

const UNSUPPORTED = new Set([
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minItems',
  'maxItems',
  'uniqueItems',
  'minProperties',
  'maxProperties',
]);

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalize(node: unknown, path: string): unknown {
  if (Array.isArray(node)) return node.map((n, i) => normalize(n, `${path}[${i}]`));
  if (!isObject(node)) return node;

  const out: Json = {};
  for (const [key, value] of Object.entries(node)) {
    if (!UNSUPPORTED.has(key)) out[key] = value;
  }

  // Nullable written as a type list, or as an enum that lists null.
  const types = Array.isArray(out['type']) ? (out['type'] as unknown[]) : null;
  const enumValues = Array.isArray(out['enum']) ? (out['enum'] as unknown[]) : null;
  const nullable =
    (types && types.includes('null')) || (enumValues && enumValues.includes(null));
  if (nullable) {
    const { description, ...rest } = out;
    const nonNull = types
      ? types.filter((t) => t !== 'null')
      : rest['type'] !== undefined
        ? [rest['type']]
        : [];
    const branches: unknown[] = nonNull.map((t) => {
      const branch: Json = { ...rest, type: t };
      if (enumValues) branch['enum'] = enumValues.filter((v) => v !== null);
      return normalize(branch, path);
    });
    if (branches.length === 0 && enumValues) {
      branches.push(normalize({ ...rest, enum: enumValues.filter((v) => v !== null) }, path));
    }
    const wrapper: Json = { anyOf: [...branches, { type: 'null' }] };
    if (description !== undefined) wrapper['description'] = description;
    return wrapper;
  }
  if (types && types.length > 1) {
    const { description, ...rest } = out;
    const wrapper: Json = {
      anyOf: types.map((t) => normalize({ ...rest, type: t }, path)),
    };
    if (description !== undefined) wrapper['description'] = description;
    return wrapper;
  }

  if (enumValues && enumValues.length === 0) {
    throw new LlmRequestError(`schema ${path}: empty enum`);
  }

  if (out['type'] === 'object' || isObject(out['properties'])) {
    const properties = isObject(out['properties']) ? out['properties'] : {};
    const normalized: Json = {};
    for (const [key, value] of Object.entries(properties)) {
      normalized[key] = normalize(value, `${path}.${key}`);
    }
    out['properties'] = normalized;
    out['additionalProperties'] = false;
    if (Array.isArray(out['required'])) {
      const required = [...new Set(out['required'] as string[])];
      const missing = required.filter((key) => !(key in normalized));
      if (missing.length > 0) {
        throw new LlmRequestError(
          `schema ${path}: required ${missing.join(', ')} not in properties`
        );
      }
      out['required'] = required;
    }
  }

  if (out['items'] !== undefined) out['items'] = normalize(out['items'], `${path}[]`);
  for (const key of ['anyOf', 'allOf', 'oneOf'] as const) {
    if (Array.isArray(out[key])) out[key] = normalize(out[key], `${path}.${key}`);
  }
  for (const key of ['$defs', 'definitions'] as const) {
    if (isObject(out[key])) {
      const defs: Json = {};
      for (const [name, def] of Object.entries(out[key] as Json)) {
        defs[name] = normalize(def, `${path}.${key}.${name}`);
      }
      out[key] = defs;
    }
  }
  return out;
}

export function toAnthropicSchema(
  schema: Record<string, unknown>,
  description?: string
): Record<string, unknown> {
  const out = normalize(schema, '$') as Record<string, unknown>;
  if (description && out['description'] === undefined) {
    out['description'] = description;
  }
  return out;
}
