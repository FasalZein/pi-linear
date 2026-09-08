import { Type, type TSchema } from 'typebox';
import type { LinearOperation } from './operations';
import { canonicalOperation } from './canonical';
import { schemaFor } from './parameter-schema';
import { typedToolName } from './tool-names';

/** The required-parameter sets that describe every valid canonical call. */
export function requirementBranches(operation: LinearOperation): readonly (readonly string[])[] {
  return canonicalOperation(operation).branches;
}

/**
 * Typed tools publish no `workspace` property.
 *
 * It was optional, absent from every help parameter card, and collided with pi's own
 * meaning of "workspace" (the working directory). Callers filled it with paths, and an
 * unrecognised name is a hard credential failure, so the call could not recover. Workspace
 * selection is session state: `/linear-auth switch` and `linear_switch_workspace` set it,
 * and `linear_graphql` / `linear_batch` still accept it for explicit cross-account work.
 */
function objectSchema(
  fields: Record<string, string>,
  advanced: Readonly<Record<string, string>>,
  fieldNames: readonly string[],
  branches: readonly (readonly string[])[],
  exclusive = false,
) {
  const properties: Record<string, TSchema> = Object.fromEntries(
    fieldNames.map((name) => [name, Type.Optional(schemaFor(fields[name]!))]),
  );
  const advancedNames = new Set(Object.keys(advanced));
  if (advancedNames.size) {
    properties.advanced = Type.Optional(Type.Object({}, { additionalProperties: true }));
  }
  const projectedBranches = [...new Map(branches.map((branch) => {
    const projected = [...new Set(branch.map((name) => advancedNames.has(name) ? 'advanced' : name))];
    return [JSON.stringify(projected), projected] as const;
  })).values()];

  if (projectedBranches.length === 1) {
    const required = projectedBranches[0]!;
    return Type.Object(properties, required.length
      ? { additionalProperties: false, required: [...required] }
      : { additionalProperties: false });
  }
  const pairedWithIdentity = advancedNames.size > 0
    && projectedBranches.length > 2
    && projectedBranches.every((branch) => branch.length === 2 && branch[0] === projectedBranches[0]![0]);
  if (pairedWithIdentity) {
    return Type.Object(properties, {
      additionalProperties: false,
      required: [projectedBranches[0]![0]!],
      minProperties: 2,
    });
  }
  const requirements = projectedBranches.map((branch) => ({ required: [...branch] }));
  return exclusive && advancedNames.size === 0
    ? Type.Object(properties, { additionalProperties: false, oneOf: requirements })
    : Type.Object(properties, { additionalProperties: false, anyOf: requirements });
}

function describePagination(schema: TSchema, operation: LinearOperation): TSchema {
  if (!operation.pagination) return schema;
  const properties = (schema as { properties: Record<string, TSchema> }).properties;
  if (properties.first) {
    properties.first = { ...properties.first, description: `Forward page size. Omit first to use the default ${operation.pagination.defaultPageSize}.` } as TSchema;
  }
  if (properties.last) {
    properties.last = { ...properties.last, description: `Backward page size. Omit last to use the default ${operation.pagination.defaultPageSize}.` } as TSchema;
  }
  return schema;
}

/** Publish one provider-safe object root, with mode rules as constraint fragments. */
export function parameterSchema(operation: LinearOperation) {
  const contract = canonicalOperation(operation);
  if (!contract.variants) {
    return describePagination(objectSchema(
      contract.fields,
      contract.advanced ?? {},
      Object.keys(contract.fields),
      contract.branches,
      contract.exclusiveBranches,
    ), operation);
  }

  const [create, update] = contract.variants;
  const fieldNames = Object.keys(contract.fields);
  const properties: Record<string, TSchema> = Object.fromEntries(
    fieldNames.map((name) => [name, Type.Optional(schemaFor(contract.fields[name]!))]),
  );
  if (Object.keys(contract.advanced ?? {}).length) {
    properties.advanced = Type.Optional(Type.Object({}, { additionalProperties: true }));
  }

  /**
   * Publish what each mode requires; enforce what each mode forbids at runtime.
   *
   * The required sets are information a caller needs and cost about 60 bytes. The forbidden
   * sets were an enumeration of every excluded field per mode, and when they tripped the
   * validator named no field and no fix. `assertVariant` in typed-tools.ts applies that
   * half, naming the mode, the offending field, and what the mode accepts.
   */
  return describePagination(Type.Object(properties, {
    additionalProperties: false,
    anyOf: [
      { required: [...create.branches[0]!] },
      // Every update branch is the identity plus one changed field, so `save_project`
      // enumerated 31 pairs to say this. `minProperties` states it in one clause.
      { required: [update.branches[0]![0]!], minProperties: 2 },
    ],
  }), operation);
}

/**
 * The published schema states the common call shape. Operations with rare fields point to
 * their on-demand advanced help without repeating the closed tail in normal context.
 */
function toolDescription(operation: LinearOperation): string {
  const hasAdvancedFields = Object.keys(canonicalOperation(operation).advanced ?? {}).length > 0;
  return hasAdvancedFields
    ? `${operation.purpose} For advanced fields, request linear help with variables.operation "${operation.name}:advanced".`
    : operation.purpose;
}

export type TypedToolMetadata = {
  name: string;
  label: string;
  description: string;
  parameters: TSchema;
  constrainedSampling?: false;
};

/** Pure metadata projection shared by runtime registration and generation. */
export function buildTypedToolMetadata(operation: LinearOperation): TypedToolMetadata {
  const contract = canonicalOperation(operation);
  const metadata: TypedToolMetadata = {
    name: typedToolName(operation.name),
    label: `Linear ${operation.name.replace(/_/g, ' ')}`,
    description: toolDescription(operation),
    parameters: parameterSchema(operation),
  };
  if (contract.variants || contract.exclusiveBranches || Object.values(contract.fields).includes('JsonObject')) {
    metadata.constrainedSampling = false;
  }
  return metadata;
}
