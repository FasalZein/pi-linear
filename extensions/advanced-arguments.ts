import { Type } from 'typebox';
import { Compile } from 'typebox/compile';
import type { CanonicalOperation } from './canonical-schema';
import { schemaProblems } from './failure-message';
import type { JsonObject } from './runtime';
import { isCompatibilityObject } from './operation-types';
import { legacyReferenceReplacement } from './operations/reference-language';
import { schemaFor } from './parameter-schema';

const validators = new Map<string, ReturnType<typeof Compile>>();

function validator(name: string, advanced: Readonly<Record<string, string>>): ReturnType<typeof Compile> {
  const existing = validators.get(name);
  if (existing) return existing;
  const properties = Object.fromEntries(
    Object.entries(advanced).map(([field, type]) => [field, Type.Optional(schemaFor(type))]),
  );
  const compiled = Compile(Type.Object(properties, { additionalProperties: false }));
  validators.set(name, compiled);
  return compiled;
}

/** Validate the authored closed tail, then flatten it for the existing operation pipeline. */
export function flattenAdvancedArguments(
  operationName: string,
  canonical: CanonicalOperation,
  variables: JsonObject,
): JsonObject {
  const value = variables.advanced;
  if (value === undefined) return variables;
  if (!isCompatibilityObject(value)) {
    throw new Error(`Invalid advanced parameters for "${operationName}": advanced must be an object.`);
  }

  const common = new Set(Object.keys(canonical.fields));
  const advanced = canonical.advanced ?? {};
  const accepted = new Set([...common, ...Object.keys(advanced)]);
  for (const field of Object.keys(value)) {
    if (field === 'input') throw new Error('Raw input is unavailable in advanced. Use only named advanced parameters.');
    if (common.has(field)) {
      throw new Error(`advanced duplicates common parameter "${field}"; send "${field}" once at top level.`);
    }
    if (!(field in advanced)) {
      const replacement = legacyReferenceReplacement(operationName, field, accepted);
      if (replacement) {
        throw new Error(`Unsupported legacy advanced parameter "${field}"; send "${replacement}".`);
      }
      throw new Error(
        `Unknown advanced parameter "${field}" for "${operationName}". Request advanced help for the exact field list.`,
      );
    }
  }

  const check = validator(operationName, advanced);
  if (!check.Check(value)) {
    throw new Error(`Invalid advanced parameters for "${operationName}": ${schemaProblems(check.Errors(value))}.`);
  }
  const flattened = { ...variables, ...value };
  delete flattened.advanced;
  return flattened;
}
