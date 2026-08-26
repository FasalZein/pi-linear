/**
 * JSON that has crossed a parser. Tool requests, GraphQL responses, stored results,
 * and local results all carry this contract once their seam has decoded them.
 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | JsonObject;
export type JsonObject = {
  [key: string]: JsonValue | undefined;
};

const ARRAY_TAG = '[object Array]';
const BOOLEAN_TAG = '[object Boolean]';
const NUMBER_TAG = '[object Number]';
const OBJECT_TAG = '[object Object]';
const STRING_TAG = '[object String]';

function jsonTag(cause: unknown): string {
  return Object.prototype.toString.call(cause);
}

/** True when a parsed value is a JSON object. */
export function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return jsonTag(value) === OBJECT_TAG;
}

function parseJsonValue(cause: unknown, visited: WeakSet<object>): JsonValue | undefined {
  if (cause === null) return null;
  if (cause === undefined) return undefined;
  const tag = jsonTag(cause);
  if (tag === STRING_TAG) return cause as string;
  if (tag === NUMBER_TAG) return cause as number;
  if (tag === BOOLEAN_TAG) return cause as boolean;
  if (tag !== ARRAY_TAG && tag !== OBJECT_TAG) return undefined;
  // The tag proves the value is an array or a plain object, so it can be walked.
  const container = cause as object;
  // A value that contains itself is a cycle, which carries no JSON meaning.
  // Only the current path is tracked, so a value repeated beside itself still parses.
  if (visited.has(container)) return undefined;
  visited.add(container);
  try {
    if (tag === ARRAY_TAG) {
      const entries = cause as readonly unknown[];
      return entries.map((entry) => parseJsonValue(entry, visited) ?? null);
    }
    const parsed: JsonObject = {};
    for (const key of Object.keys(container)) {
      const descriptor = Object.getOwnPropertyDescriptor(container, key);
      if (descriptor === undefined || !('value' in descriptor)) continue;
      const entry = parseJsonValue(descriptor.value, visited);
      if (entry !== undefined) parsed[key] = entry;
    }
    return parsed;
  } finally {
    visited.delete(container);
  }
}

/**
 * Parse one untrusted value into JSON. This module is the only I/O seam that opens an
 * untrusted value; every other module receives `JsonValue` or `JsonObject`, which exist
 * only because a parser here produced them. Own enumerable properties survive; functions,
 * symbols, and cycles carry no JSON meaning and parse to `undefined`.
 */
export function parseJson(cause: unknown): JsonValue | undefined {
  return parseJsonValue(cause, new WeakSet());
}

/** Parse an untrusted value that must be a JSON object. Anything else parses to `undefined`. */
export function parseJsonObject(cause: unknown): JsonObject | undefined {
  const parsed = parseJson(cause);
  return isJsonObject(parsed) ? parsed : undefined;
}

/**
 * Parse an untrusted value where an object is required. The caller names the value so
 * the failure points at the seam that supplied it.
 */
export function requireJsonObject(cause: unknown, description: string): JsonObject {
  const parsed = parseJsonObject(cause);
  if (parsed === undefined) throw new Error(`${description} must be a JSON object.`);
  return parsed;
}
