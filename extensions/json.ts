import {
  isCompatibilityObject,
  type CompatibilityObject,
  type CompatibilityValue,
  type UnparsedCompatibilityVariables,
} from './operation-types';

/**
 * JSON that has crossed a parser. Tool requests, GraphQL responses, stored results,
 * and local results all carry this contract once their seam has decoded them.
 */
export type JsonValue = CompatibilityValue;
export type JsonObject = CompatibilityObject;

/** A transport, file, or network value that has not crossed a parser yet. */
export type UnparsedJson = UnparsedCompatibilityVariables | null | undefined;

const ARRAY_TAG = '[object Array]';
const BOOLEAN_TAG = '[object Boolean]';
const NUMBER_TAG = '[object Number]';
const OBJECT_TAG = '[object Object]';
const STRING_TAG = '[object String]';

function jsonTag(value: UnparsedJson): string {
  return Object.prototype.toString.call(value);
}

function parseJsonValue(value: UnparsedJson, visited: WeakSet<UnparsedCompatibilityVariables>): JsonValue | undefined {
  if (value === null) return null;
  if (value === undefined) return undefined;
  const tag = jsonTag(value);
  if (tag === STRING_TAG) return value as string;
  if (tag === NUMBER_TAG) return value as number;
  if (tag === BOOLEAN_TAG) return value as boolean;
  if (tag !== ARRAY_TAG && tag !== OBJECT_TAG) return undefined;
  // A value that contains itself is a cycle, which carries no JSON meaning.
  // Only the current path is tracked, so a value repeated beside itself still parses.
  if (visited.has(value)) return undefined;
  visited.add(value);
  try {
    if (tag === ARRAY_TAG) {
      const entries = value as readonly UnparsedJson[];
      return entries.map((entry) => parseJsonValue(entry, visited) ?? null);
    }
    const parsed: JsonObject = {};
    for (const key of Object.keys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !('value' in descriptor)) continue;
      const entry = parseJsonValue(descriptor.value as UnparsedJson, visited);
      if (entry !== undefined) parsed[key] = entry;
    }
    return parsed;
  } finally {
    visited.delete(value);
  }
}

/**
 * Parse one unparsed value into JSON. Own enumerable properties survive; functions,
 * symbols, and cycles carry no JSON meaning and parse to `undefined`.
 */
export function parseJson(value: UnparsedJson): JsonValue | undefined {
  return parseJsonValue(value, new WeakSet());
}

/** Parse an unparsed value that must be a JSON object. Anything else parses to `undefined`. */
export function parseJsonObject(value: UnparsedJson): JsonObject | undefined {
  const parsed = parseJson(value);
  return isCompatibilityObject(parsed) ? parsed : undefined;
}
