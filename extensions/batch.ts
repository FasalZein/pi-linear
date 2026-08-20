import {
  Kind,
  OperationTypeNode,
  parse,
  print,
  visit,
  type DocumentNode,
  type OperationDefinitionNode,
} from 'graphql';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import {
  assertIssueNodeMatches,
  assertNamedNodeMatches,
  linearGraphQL,
  linearGraphQLErrors,
  withLinearGraphQL,
} from './client';
import {
  formatInvocation,
  getOperation,
  getOperationDefinition,
  parameterShapes,
  type LinearOperation,
} from './operations';
import type { OperationPreparation } from './operation-types';
import {
  apiKeyForWorkspace,
  assertOperationAllowed,
  compactLinearResult,
  type JsonObject,
} from './runtime';
import type { MutationMode } from './safety';

export const BATCH_PURPOSE = 'Carry several independent named reads in one GraphQL request.';

const ALIAS = /^[_A-Za-z][_0-9A-Za-z]*$/;
const FORBIDDEN_OPERATIONS = new Set(['help', 'batch']);

class PreparationLookup extends Error {}

export function batchHelp(): JsonObject {
  return {
    name: 'batch',
    purpose: BATCH_PURPOSE,
    parameters: [{ name: 'reads', type: 'BatchEntry[]', required: true }],
    example: {
      operation: 'batch',
      variables: {
        reads: [
          { key: 'one', operation: 'get_issue', variables: { issue: 'AEO-258' } },
          { key: 'two', operation: 'get_issue', variables: { issue: 'AEO-361' } },
        ],
      },
    },
  };
}

function isAlias(key: string): boolean {
  return ALIAS.test(key) && !key.startsWith('__');
}

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function parameterList(operation: LinearOperation): string {
  return operation.parameters.map(({ name, type, required }) =>
    `${name}: ${type}${required ? ' (required)' : ' (optional)'}`,
  ).join(', ');
}

function validateVariables(
  operation: LinearOperation,
  requestedName: string,
  variables: Record<string, unknown>,
): void {
  const shapes = parameterShapes(operation, requestedName);
  const valid = new Set(shapes.flatMap((shape) => shape.map(({ name }) => name)));
  const validShape = shapes.find((shape) => {
    const shapeKeys = new Set(shape.map(({ name }) => name));
    return shape.every(({ name, required }) => !required || name in variables)
      && Object.keys(variables).every((name) => shapeKeys.has(name));
  });
  if (validShape) {
    try {
      operation.validateVariables?.(variables);
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Invalid parameters for "${operation.name}": ${message}. Valid parameters: ${parameterList(operation)}. Example: ${formatInvocation(operation.example)}.`,
      );
    }
  }
  const missing = operation.parameters.filter(({ name, required }) => required && !(name in variables)).map(({ name }) => name);
  const unknown = Object.keys(variables).filter((name) => !valid.has(name));
  const problems = [
    ...(operation.requiresVariables && !Object.keys(variables).length ? ['at least one parameter is required'] : []),
    ...(missing.length ? [`missing ${missing.join(', ')}`] : []),
    ...(unknown.length ? [`unknown ${unknown.join(', ')}`] : []),
  ].join('; ') || 'parameters do not match one accepted shape';
  throw new Error(
    `Invalid parameters for "${operation.name}": ${problems}. Valid parameters: ${parameterList(operation)}. Example: ${formatInvocation(operation.example)}.`,
  );
}

type PlannedRead = {
  key: string;
  root: string;
  document: string;
  variables: Record<string, unknown>;
  prepared: OperationPreparation;
};

function operationDefinition(document: DocumentNode): OperationDefinitionNode {
  const definition = document.definitions.find((entry) => entry.kind === Kind.OPERATION_DEFINITION);
  if (!definition || definition.kind !== Kind.OPERATION_DEFINITION) {
    throw new Error('Missing GraphQL operation definition.');
  }
  return definition;
}

function aliasDocument(key: string, document: string): { ast: DocumentNode; root: string } {
  const source = parse(document);
  const op = operationDefinition(source);
  const roots = op.selectionSet.selections.filter((selection) => selection.kind === Kind.FIELD);
  if (roots.length !== 1 || roots[0]!.kind !== Kind.FIELD) {
    throw new Error(`Batch entry "${key}" must have exactly one GraphQL root field.`);
  }
  const root = roots[0]!.name.value;
  const ast = visit(source, {
    Variable(node) {
      return { kind: Kind.VARIABLE, name: { kind: Kind.NAME, value: `${key}_${node.name.value}` } };
    },
    OperationDefinition(node) {
      return {
        ...node,
        name: undefined,
        selectionSet: {
          ...node.selectionSet,
          selections: node.selectionSet.selections.map((selection) => {
            if (selection.kind !== Kind.FIELD) return selection;
            return { ...selection, alias: { kind: Kind.NAME, value: key } };
          }),
        },
      };
    },
  });
  return { ast, root };
}

function mergeQueries(parts: readonly DocumentNode[]): string {
  const variableDefinitions = [];
  const selections = [];
  for (const part of parts) {
    const op = operationDefinition(part);
    variableDefinitions.push(...(op.variableDefinitions ?? []));
    selections.push(...op.selectionSet.selections);
  }
  return print({
    kind: Kind.DOCUMENT,
    definitions: [{
      kind: Kind.OPERATION_DEFINITION,
      operation: OperationTypeNode.QUERY,
      name: { kind: Kind.NAME, value: 'BatchRead' },
      variableDefinitions,
      selectionSet: { kind: Kind.SELECTION_SET, selections },
    }],
  });
}

function parseEntries(variables: Record<string, unknown>): Array<{
  key: string;
  operation: string;
  variables: Record<string, unknown>;
}> {
  const unknown = Object.keys(variables).filter((name) => name !== 'reads' && name !== 'mutations');
  if (unknown.length) {
    throw new Error(`Unknown batch field "${unknown[0]}". Send { "reads": [ { "key", "operation", "variables" } ] }.`);
  }
  const mutations = variables.mutations;
  if (mutations !== undefined) {
    if (!Array.isArray(mutations)) throw new Error('Batch mutations must be an array.');
    if (mutations.length) throw new Error('Batch mutations are not implemented.');
  }
  const reads = variables.reads;
  if (!Array.isArray(reads) || reads.length === 0) {
    throw new Error('Batch reads must be a non-empty array.');
  }
  const seen = new Set<string>();
  return reads.map((entry, index) => {
    const record = asObject(entry, `Batch entry ${index}`);
    const extra = Object.keys(record).filter((name) => name !== 'key' && name !== 'operation' && name !== 'variables');
    if (extra.length) throw new Error(`Unknown batch entry field "${extra[0]}".`);
    if (typeof record.key !== 'string' || !isAlias(record.key)) {
      throw new Error(`Batch key "${String(record.key)}" is not a valid unique GraphQL alias.`);
    }
    if (seen.has(record.key)) throw new Error(`Duplicate batch key "${record.key}".`);
    seen.add(record.key);
    if (typeof record.operation !== 'string' || !record.operation.trim()) {
      throw new Error(`Batch entry "${record.key}" must name a GraphQL operation.`);
    }
    const entryVariables = record.variables === undefined ? {} : asObject(record.variables, `Batch entry "${record.key}" variables`);
    return { key: record.key, operation: record.operation, variables: entryVariables };
  });
}

async function localPrepare(
  key: string,
  operation: LinearOperation,
  variables: Record<string, unknown>,
  signal: AbortSignal | undefined,
): Promise<OperationPreparation> {
  if (!operation.prepare) return { variables };
  return withLinearGraphQL(async () => {
    throw new PreparationLookup();
  }, async () => {
    try {
      return await operation.prepare!('batch-local', variables, signal);
    } catch (error) {
      if (error instanceof PreparationLookup) {
        throw new Error(`Batch entry "${key}" cannot fold its preparation lookups into one read request.`);
      }
      throw error;
    }
  });
}

export async function executeBatch(
  params: { variables?: Record<string, unknown>; workspace?: string },
  mode: MutationMode,
  ctx: ExtensionContext,
  signal: AbortSignal | undefined,
): Promise<JsonObject> {
  const planned: PlannedRead[] = [];
  for (const entry of parseEntries(params.variables ?? {})) {
    if (FORBIDDEN_OPERATIONS.has(entry.operation)) {
      throw new Error('Batch entries must be named GraphQL operations. help, batch, raw GraphQL, and local operations are not allowed.');
    }
    const operation = getOperation(entry.operation);
    const definition = getOperationDefinition(entry.operation);
    if (operation.executeLocal || definition.kind === 'local') {
      throw new Error('Batch entries must be named GraphQL operations. help, batch, raw GraphQL, and local operations are not allowed.');
    }
    if (definition.kind !== 'query') {
      throw new Error(`Batch entry "${entry.key}" must be a query operation.`);
    }
    assertOperationAllowed(operation, entry.variables, mode);
    validateVariables(operation, entry.operation, entry.variables);
    const prepared = await localPrepare(entry.key, operation, entry.variables, signal);
    const document = prepared.variant?.document ?? operation.document;
    if (!document) throw new Error(`Batch entry "${entry.key}" is missing a GraphQL document.`);
    const { ast, root } = aliasDocument(entry.key, document);
    planned.push({
      key: entry.key,
      root,
      document: print(ast),
      variables: Object.fromEntries(
        Object.entries(prepared.variables).map(([name, value]) => [`${entry.key}_${name}`, value]),
      ),
      prepared,
    });
  }

  const query = mergeQueries(planned.map((entry) => parse(entry.document)));
  const variables = Object.assign({}, ...planned.map((entry) => entry.variables));
  const apiKey = await apiKeyForWorkspace(ctx, params.workspace);
  const raw = await linearGraphQL<JsonObject>(apiKey, query, variables, signal);
  const pathErrors = linearGraphQLErrors(raw);
  const data: JsonObject = {};
  const errors: Array<{ key: string; path: ReadonlyArray<string | number>; message: string }> = [];

  for (const entry of planned) {
    const scoped = pathErrors.filter((error) => error.path[0] === entry.key);
    if (scoped.length) {
      for (const error of scoped) errors.push({ key: entry.key, path: error.path, message: error.message });
      continue;
    }
    const value = raw[entry.key];
    try {
      if (entry.prepared.exactIssue) {
        assertIssueNodeMatches(entry.prepared.exactIssue.requested, value as never);
      }
      if (entry.prepared.exactNamed) {
        assertNamedNodeMatches(
          entry.prepared.exactNamed.kind,
          entry.prepared.exactNamed.requested,
          value as never,
        );
      }
      if (value == null) throw new Error(`Batch entry "${entry.key}" returned no data.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push({ key: entry.key, path: [entry.key], message });
      continue;
    }
    data[entry.key] = { [entry.root]: value };
  }

  const compact = compactLinearResult(data);
  return {
    data: compact.data,
    errors,
    skipped: [],
    meta: {
      requests: { read: 1, mutation: 0 },
      aliases: planned.length,
      truncations: compact.meta.truncations,
      stringsClipped: compact.meta.stringsClipped,
    },
  };
}
