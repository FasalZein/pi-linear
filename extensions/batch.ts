import { randomUUID } from 'node:crypto';
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
  requireIssueReference,
  withLinearGraphQL,
  withLinearRateLimitTelemetry,
} from './client';
import {
  formatInvocation,
  getOperation,
  getOperationDefinition,
  parameterShapes,
  type LinearOperation,
} from './operations';
import { isUuid } from './operations/shared';
import type {
  BatchLookup,
  BatchLookupField,
  BatchLookupValues,
  BatchPreparation,
  GraphQLDocumentVariant,
  OperationPreparation,
} from './operation-types';
import { activeSecrets } from './active-secrets';
import {
  apiKeyForWorkspace,
  assertOperationAllowed,
  routeLinearEnvelope,
  validateMutationResult,
  type JsonObject,
} from './runtime';
import { assertMutationAllowed, type MutationMode } from './safety';
import { projection } from './selections';

export const BATCH_PURPOSE = 'Carry several independent named reads in one GraphQL request.';

const ALIAS = /^[_A-Za-z][_0-9A-Za-z]*$/;
const FORBIDDEN_OPERATIONS = new Set(['help', 'batch']);

class PreparationLookup extends Error {}

export function batchHelp(): JsonObject {
  return {
    name: 'batch',
    purpose: BATCH_PURPOSE,
    parameters: [
      { name: 'reads', type: 'BatchEntry[]', required: false },
      { name: 'mutations', type: 'BatchEntry[]', required: false },
    ],
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

type IndependentPlan = Extract<BatchPreparation, { kind: 'independent' }>;

type CompiledLookup = {
  field: BatchLookupField;
  aliases: string[];
  ast: DocumentNode;
  variables: Record<string, unknown>;
  resolve: (
    raw: JsonObject,
    pathErrors: ReturnType<typeof linearGraphQLErrors>,
  ) => unknown;
};

type PlannedEntry = {
  key: string;
  root: string;
  document: string;
  variables: Record<string, unknown>;
  prepared?: OperationPreparation;
  operationName: string;
  variant?: GraphQLDocumentVariant;
  lookups?: CompiledLookup[];
  batchFinish?: IndependentPlan['finish'];
};

const ISSUE_BATCH_CREATE_DOCUMENT = `mutation BatchIssueCreate($input: IssueBatchCreateInput!) {
  issueBatchCreate(input: $input) {
    success
    issues { ${projection('issue', 'detail')} }
  }
}`;

function isIssueCreateEntry(entry: { operation: string }): boolean {
  const documents = getOperationDefinition(entry.operation).graphql?.documents ?? [];
  const roots = documents.filter((document) => document.kind === 'mutation').map((document) => document.root);
  return roots.length === 1 && roots[0] === 'issueCreate';
}

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

function mergeDocuments(
  operation: OperationTypeNode,
  name: string,
  parts: readonly DocumentNode[],
): string {
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
      operation,
      name: { kind: Kind.NAME, value: name },
      variableDefinitions,
      selectionSet: { kind: Kind.SELECTION_SET, selections },
    }],
  });
}

type RawEntry = { key: string; operation: string; variables: Record<string, unknown> };

function parsePhase(value: unknown, label: string, seen: Set<string>): RawEntry[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`Batch ${label} must be an array.`);
  return value.map((entry, index) => {
    const record = asObject(entry, `Batch ${label} entry ${index}`);
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
    const entryVariables = record.variables === undefined
      ? {}
      : asObject(record.variables, `Batch entry "${record.key}" variables`);
    return { key: record.key, operation: record.operation, variables: entryVariables };
  });
}

function parseEntries(variables: Record<string, unknown>): { reads: RawEntry[]; mutations: RawEntry[] } {
  const unknown = Object.keys(variables).filter((name) => name !== 'reads' && name !== 'mutations');
  if (unknown.length) {
    throw new Error(`Unknown batch field "${unknown[0]}". Send { "reads"?: BatchEntry[], "mutations"?: BatchEntry[] }.`);
  }
  const seen = new Set<string>();
  const reads = parsePhase(variables.reads, 'reads', seen);
  const mutations = parsePhase(variables.mutations, 'mutations', seen);
  if (!reads.length && !mutations.length) {
    throw new Error('Batch requires a non-empty reads or mutations array.');
  }
  return { reads, mutations };
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
        throw new Error(`Batch entry "${key}" cannot fold its preparation lookups into one GraphQL request.`);
      }
      throw error;
    }
  });
}

function requireOne<T>(nodes: T[], description: string): T {
  if (nodes.length !== 1) {
    throw new Error(`Linear ${description} resolved to ${nodes.length} matches; expected exactly one.`);
  }
  return nodes[0]!;
}

function throwIfLookupPath(
  aliases: readonly string[],
  pathErrors: ReturnType<typeof linearGraphQLErrors>,
): void {
  const scoped = pathErrors.filter((error) => aliases.includes(String(error.path[0])));
  if (scoped.length) throw new Error(scoped[0]!.message);
}

function aliasLookup(
  prefix: string,
  document: string,
  variables: Record<string, unknown>,
): { ast: DocumentNode; variables: Record<string, unknown>; aliases: string[] } {
  const aliases: string[] = [];
  const ast = visit(parse(document), {
    Variable(node) {
      return { kind: Kind.VARIABLE, name: { kind: Kind.NAME, value: `${prefix}_${node.name.value}` } };
    },
    OperationDefinition(node) {
      const roots = node.selectionSet.selections.filter((selection) => selection.kind === Kind.FIELD);
      return {
        ...node,
        name: undefined,
        selectionSet: {
          ...node.selectionSet,
          selections: node.selectionSet.selections.map((selection) => {
            if (selection.kind !== Kind.FIELD) return selection;
            const aliasName = roots.length === 1
              ? prefix
              : `${prefix}_${selection.alias?.value ?? selection.name.value}`;
            aliases.push(aliasName);
            return { ...selection, alias: { kind: Kind.NAME, value: aliasName } };
          }),
        },
      };
    },
  });
  return {
    ast,
    aliases,
    variables: Object.fromEntries(
      Object.entries(variables).map(([name, value]) => [`${prefix}_${name}`, value]),
    ),
  };
}

function compileLookup(entryKey: string, lookup: BatchLookup): CompiledLookup {
  const prefix = `_lookup_${entryKey}_${lookup.field}`;
  if (lookup.field === 'parent') {
    requireIssueReference(lookup.requested);
    const compiled = aliasLookup(prefix, `query ($id: String!) {
  issue(id: $id) { id identifier team { id key } }
}`, { id: lookup.requested });
    return {
      field: lookup.field,
      ...compiled,
      resolve(raw, pathErrors) {
        throwIfLookupPath(compiled.aliases, pathErrors);
        const issue = raw[compiled.aliases[0]!] as {
          id?: unknown;
          identifier?: unknown;
          team?: { id?: unknown; key?: unknown } | null;
        } | null;
        assertIssueNodeMatches(lookup.requested, issue);
        const team = issue.team;
        if (!team || typeof team.id !== 'string' || typeof team.key !== 'string') {
          throw new Error(`Linear issue "${lookup.requested}" has no team.`);
        }
        const identifier = lookup.requested.match(/^([A-Z][A-Z0-9]*)-(\d+)$/i);
        if (identifier && team.key.toLowerCase() !== identifier[1]!.toLowerCase()) {
          throw new Error(`Linear issue resolver returned a mismatched team for "${lookup.requested}".`);
        }
        return { id: issue.id, identifier: issue.identifier, teamId: team.id, teamKey: team.key };
      },
    };
  }
  if (lookup.field === 'team') {
    if (isUuid(lookup.requested)) {
      const compiled = aliasLookup(prefix, `query ($id: String!) {
  team(id: $id) { id key }
}`, { id: lookup.requested });
      return {
        field: lookup.field,
        ...compiled,
        resolve(raw, pathErrors) {
          throwIfLookupPath(compiled.aliases, pathErrors);
          const team = raw[compiled.aliases[0]!] as { id?: unknown; key?: unknown } | null;
          if (!team || typeof team.id !== 'string' || typeof team.key !== 'string') {
            throw new Error(`Linear team "${lookup.requested}" was not found.`);
          }
          if (team.id !== lookup.requested) {
            throw new Error(`Linear team resolver returned mismatched id for "${lookup.requested}".`);
          }
          return { id: team.id, key: team.key };
        },
      };
    }
    if (!/^[A-Z][A-Z0-9]*$/i.test(lookup.requested)) {
      throw new Error(`Invalid Linear team reference "${lookup.requested}". Use a team key or UUID.`);
    }
    const compiled = aliasLookup(prefix, `query ($key: String!) {
  teams(first: 2, filter: { key: { eq: $key } }) { nodes { id key } }
}`, { key: String(lookup.requested).toUpperCase() });
    return {
      field: lookup.field,
      ...compiled,
      resolve(raw, pathErrors) {
        throwIfLookupPath(compiled.aliases, pathErrors);
        const connection = raw[compiled.aliases[0]!] as { nodes?: Array<{ id: string; key: string }> } | null;
        const team = requireOne(connection?.nodes ?? [], `team "${lookup.requested}"`);
        if (team.key.toLowerCase() !== lookup.requested.toLowerCase()) {
          throw new Error(`Linear team resolver returned mismatched key "${team.key}" for "${lookup.requested}".`);
        }
        return team;
      },
    };
  }
  if (lookup.field === 'state') {
    if (isUuid(lookup.requested)) {
      const compiled = aliasLookup(prefix, `query ($id: String!) {
  workflowState(id: $id) { id name team { id } }
}`, { id: lookup.requested });
      return {
        field: lookup.field,
        ...compiled,
        resolve(raw, pathErrors) {
          throwIfLookupPath(compiled.aliases, pathErrors);
          const state = raw[compiled.aliases[0]!] as {
            id?: unknown;
            name?: unknown;
            team?: { id?: unknown } | null;
          } | null;
          if (!state || typeof state.id !== 'string' || typeof state.name !== 'string') {
            throw new Error(`Linear state "${lookup.requested}" was not found.`);
          }
          if (state.id !== lookup.requested) {
            throw new Error(`Linear state resolver returned mismatched id for "${lookup.requested}".`);
          }
          if (typeof state.team?.id !== 'string') throw new Error(`Linear state "${lookup.requested}" has no team.`);
          return { id: state.id, name: state.name, teamId: state.team.id };
        },
      };
    }
    const team = lookup.team;
    if (!team) {
      throw new Error(`Invalid Linear state reference "${lookup.requested}". Use a state UUID, or provide team with an exact state name.`);
    }
    const byId = isUuid(team);
    const compiled = byId
      ? aliasLookup(prefix, `query ($teamId: ID!, $name: String!) {
  workflowStates(first: 2, filter: { team: { id: { eq: $teamId } }, name: { eqIgnoreCase: $name } }) {
    nodes { id name team { id } }
  }
}`, { teamId: team, name: lookup.requested })
      : aliasLookup(prefix, `query ($teamKey: String!, $name: String!) {
  workflowStates(first: 2, filter: { team: { key: { eq: $teamKey } }, name: { eqIgnoreCase: $name } }) {
    nodes { id name team { id key } }
  }
}`, { teamKey: String(team).toUpperCase(), name: lookup.requested });
    return {
      field: lookup.field,
      ...compiled,
      resolve(raw, pathErrors) {
        throwIfLookupPath(compiled.aliases, pathErrors);
        const connection = raw[compiled.aliases[0]!] as {
          nodes?: Array<{ id: string; name: string; team?: { id?: string } | null }>;
        } | null;
        const matches = (connection?.nodes ?? []).filter((state) =>
          state.name.toLowerCase() === lookup.requested.toLowerCase(),
        );
        const state = requireOne(matches, `state "${lookup.requested}" in team "${team}"`);
        if (typeof state.team?.id !== 'string') throw new Error(`Linear state "${lookup.requested}" has no team.`);
        return { id: state.id, name: state.name, teamId: state.team.id };
      },
    };
  }
  const selection = 'id name displayName email';
  if (lookup.requested.toLowerCase() === 'me') {
    const compiled = aliasLookup(prefix, `query { viewer { ${selection} } }`, {});
    return {
      field: lookup.field,
      ...compiled,
      resolve(raw, pathErrors) {
        throwIfLookupPath(compiled.aliases, pathErrors);
        const viewer = raw[compiled.aliases[0]!] as { id?: unknown } | null;
        if (typeof viewer?.id !== 'string') throw new Error('Linear viewer could not be resolved.');
        return { id: viewer.id };
      },
    };
  }
  if (isUuid(lookup.requested)) {
    const compiled = aliasLookup(prefix, `query ($id: String!) {
  user(id: $id) { ${selection} }
}`, { id: lookup.requested });
    return {
      field: lookup.field,
      ...compiled,
      resolve(raw, pathErrors) {
        throwIfLookupPath(compiled.aliases, pathErrors);
        const user = raw[compiled.aliases[0]!] as { id?: unknown } | null;
        if (typeof user?.id !== 'string') throw new Error(`Linear user "${lookup.requested}" was not found.`);
        if (user.id !== lookup.requested) {
          throw new Error(`Linear user resolver returned mismatched id for "${lookup.requested}".`);
        }
        return { id: user.id };
      },
    };
  }
  const compiled = aliasLookup(prefix, `query ($reference: String!) {
  byEmail: users(first: 2, filter: { email: { eq: $reference } }) { nodes { ${selection} } }
  byName: users(first: 2, filter: { name: { eq: $reference } }) { nodes { ${selection} } }
  byDisplayName: users(first: 2, filter: { displayName: { eq: $reference } }) { nodes { ${selection} } }
}`, { reference: lookup.requested });
  return {
    field: lookup.field,
    ...compiled,
    resolve(raw, pathErrors) {
      throwIfLookupPath(compiled.aliases, pathErrors);
      const lists = compiled.aliases.map((alias) => {
        const connection = raw[alias] as { nodes?: Array<{ id: string; email?: string; name?: string; displayName?: string }> } | null;
        return connection?.nodes ?? [];
      }).flat();
      const exact = lists.filter((user) =>
        user.email === lookup.requested || user.name === lookup.requested || user.displayName === lookup.requested,
      );
      const users = [...new Map(exact.map((user) => [user.id, user])).values()];
      return { id: requireOne(users, `user "${lookup.requested}"`).id };
    },
  };
}

function prefixVariables(key: string, variables: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(variables).map(([name, value]) => [`${key}_${name}`, value]));
}

function objectAtPath(value: unknown, path: string): JsonObject | undefined {
  let current: unknown = value;
  for (const part of path.split('.')) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined;
    current = (current as JsonObject)[part];
  }
  return current && typeof current === 'object' && !Array.isArray(current)
    ? current as JsonObject
    : undefined;
}

function assertNamedEntry(entry: RawEntry): LinearOperation {
  if (FORBIDDEN_OPERATIONS.has(entry.operation)) {
    throw new Error('Batch entries must be named GraphQL operations. help, batch, raw GraphQL, and local operations are not allowed.');
  }
  const operation = getOperation(entry.operation);
  const definition = getOperationDefinition(entry.operation);
  if (operation.executeLocal || definition.kind === 'local') {
    throw new Error('Batch entries must be named GraphQL operations. help, batch, raw GraphQL, and local operations are not allowed.');
  }
  return operation;
}

async function planEntry(
  entry: RawEntry,
  expectedKind: 'query' | 'mutation',
  mode: MutationMode,
  signal: AbortSignal | undefined,
): Promise<PlannedEntry> {
  const operation = assertNamedEntry(entry);
  const definition = getOperationDefinition(entry.operation);
  if (definition.kind !== expectedKind) {
    throw new Error(`Batch entry "${entry.key}" must be a ${expectedKind} operation.`);
  }
  assertOperationAllowed(operation, entry.variables, mode);
  validateVariables(operation, entry.operation, entry.variables);
  let batchPlan: BatchPreparation | undefined;
  try {
    batchPlan = definition.preparation.batchPrepare?.(entry.variables);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Batch entry "${entry.key}": ${message}`);
  }
  if (batchPlan?.kind === 'independent') {
    const document = operation.document;
    if (!document) throw new Error(`Batch entry "${entry.key}" is missing a GraphQL document.`);
    const { ast, root } = aliasDocument(entry.key, document);
    return {
      key: entry.key,
      root,
      document: print(ast),
      variables: {},
      operationName: operation.name,
      variant: operation.variants?.[0],
      lookups: batchPlan.lookups.map((lookup) => compileLookup(entry.key, lookup)),
      batchFinish: batchPlan.finish,
    };
  }
  const prepared = await localPrepare(entry.key, operation, entry.variables, signal);
  const document = prepared.variant?.document ?? operation.document;
  if (!document) throw new Error(`Batch entry "${entry.key}" is missing a GraphQL document.`);
  const { ast, root } = aliasDocument(entry.key, document);
  return {
    key: entry.key,
    root,
    document: print(ast),
    variables: prefixVariables(entry.key, prepared.variables),
    prepared,
    operationName: operation.name,
    variant: prepared.variant ?? operation.variants?.[0],
  };
}

function collectAlias(
  entry: PlannedEntry,
  raw: JsonObject,
  pathErrors: ReturnType<typeof linearGraphQLErrors>,
  data: JsonObject,
  errors: BatchError[],
): void {
  const scoped = pathErrors.filter((error) => error.path[0] === entry.key);
  if (scoped.length) {
    const partial = raw[entry.key] == null ? undefined : { [entry.root]: raw[entry.key] };
    for (const error of scoped) {
      errors.push({ key: entry.key, path: error.path, message: error.message, ...(partial ? { partial } : {}) });
    }
    return;
  }
  const value = raw[entry.key];
  const mapped = { [entry.root]: value };
  try {
    if (value == null) throw new Error(`Batch entry "${entry.key}" returned no data.`);
    if (entry.prepared?.exactIssue) {
      assertIssueNodeMatches(
        entry.prepared.exactIssue.requested,
        objectAtPath(mapped, entry.prepared.exactIssue.path) as never,
      );
    }
    if (entry.prepared?.exactNamed) {
      assertNamedNodeMatches(
        entry.prepared.exactNamed.kind,
        entry.prepared.exactNamed.requested,
        objectAtPath(mapped, entry.prepared.exactNamed.path) as never,
      );
    }
    if (entry.variant?.mutationResult) validateMutationResult(entry.operationName, mapped, entry.variant);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    errors.push({ key: entry.key, path: [entry.key], message, ...(value == null ? {} : { partial: mapped }) });
    return;
  }
  data[entry.key] = mapped;
}

export type BatchError = {
  key: string;
  path: ReadonlyArray<string | number>;
  message: string;
  causes?: Array<{ path: ReadonlyArray<string | number>; message: string }>;
  partial?: JsonObject;
};

function consolidateBatchErrors(errors: readonly BatchError[]): BatchError[] {
  const grouped = new Map<string, BatchError[]>();
  for (const error of errors) grouped.set(error.key, [...(grouped.get(error.key) ?? []), error]);
  return [...grouped.entries()].map(([key, entries]) => {
    const first = entries[0]!;
    const causes = entries.flatMap((entry) => entry.causes ?? [{ path: entry.path, message: entry.message }]);
    const partial = entries.find((entry) => entry.partial)?.partial;
    return {
      key,
      path: first.path,
      message: first.message,
      ...(causes.length > 1 ? { causes } : {}),
      ...(partial ? { partial } : {}),
    };
  });
}

export function assertBatchAccounting(
  requestedKeys: readonly string[],
  data: JsonObject,
  errors: readonly BatchError[],
  skipped: readonly string[],
): void {
  const requested = new Set(requestedKeys);
  const buckets = [...Object.keys(data), ...errors.map(({ key }) => key), ...skipped];
  const accounted = new Set(buckets);
  if (requested.size !== requestedKeys.length
    || accounted.size !== buckets.length
    || requested.size !== accounted.size
    || [...requested].some((key) => !accounted.has(key))) {
    throw new Error('Internal batch accounting mismatch: every requested key must appear exactly once in data, errors, or skipped.');
  }
}

async function envelope(
  requestedKeys: readonly string[],
  data: JsonObject,
  rawErrors: readonly BatchError[],
  skipped: string[],
  requests: { read: number; mutation: number },
  aliases: number,
  sink: 'inline' | 'artifact' | undefined,
  secrets: readonly string[],
): Promise<JsonObject> {
  const errors = consolidateBatchErrors(rawErrors);
  assertBatchAccounting(requestedKeys, data, errors, skipped);
  return routeLinearEnvelope({
    data,
    errors,
    skipped,
    meta: { requests, aliases, truncations: [], stringsClipped: 0 },
  }, { label: 'batch', category: 'batch', sink, secrets });
}

function failTransaction(keys: readonly string[], message: string): BatchError[] {
  return keys.map((key) => ({ key, path: ['issueBatchCreate'], message }));
}

function collectTransactionalCreates(
  plans: Array<{ key: string; uuid: string }>,
  raw: JsonObject,
  pathErrors: ReturnType<typeof linearGraphQLErrors>,
  data: JsonObject,
  errors: BatchError[],
): void {
  const keys = plans.map((plan) => plan.key);
  const scoped = pathErrors.filter((error) => error.path[0] === 'issueBatchCreate');
  const rootErrors = scoped.filter((error) => error.path.length < 3
    || error.path[1] !== 'issues'
    || typeof error.path[2] !== 'number');
  if (rootErrors.length) {
    for (const key of keys) {
      for (const error of rootErrors) errors.push({ key, path: error.path, message: error.message });
    }
    return;
  }
  const payload = raw.issueBatchCreate;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    errors.push(...failTransaction(keys, 'Linear issueBatchCreate returned unusable transaction data.'));
    return;
  }
  const record = payload as JsonObject;
  if (record.success !== true) {
    errors.push(...failTransaction(keys, 'Linear issueBatchCreate failed mutation expectation: issueBatchCreate.success must be true.'));
    return;
  }
  if (!Array.isArray(record.issues)) {
    errors.push(...failTransaction(keys, 'Linear issueBatchCreate returned unusable transaction data.'));
    return;
  }
  const byId = new Map<string, JsonObject>();
  for (const issue of record.issues) {
    if (!issue || typeof issue !== 'object' || Array.isArray(issue)) {
      errors.push(...failTransaction(keys, 'Linear issueBatchCreate returned unusable transaction data.'));
      return;
    }
    const id = (issue as JsonObject).id;
    if (typeof id !== 'string' || !id) {
      errors.push(...failTransaction(keys, 'Linear issueBatchCreate returned unusable transaction data.'));
      return;
    }
    if (byId.has(id)) {
      errors.push(...failTransaction(keys, 'Linear issueBatchCreate returned duplicate issue ids.'));
      return;
    }
    byId.set(id, issue as JsonObject);
  }
  const stamped = new Set(plans.map((plan) => plan.uuid));
  if (byId.size !== stamped.size || [...byId.keys()].some((id) => !stamped.has(id))) {
    errors.push(...failTransaction(
      keys,
      'Linear issueBatchCreate returned issue ids that do not match the stamped create ids.',
    ));
    return;
  }

  const keyById = new Map(plans.map((plan) => [plan.uuid, plan.key]));
  const affected = new Map<string, typeof scoped>();
  for (const error of scoped) {
    const index = error.path[2] as number;
    if (!Number.isSafeInteger(index) || index < 0 || index >= record.issues.length) {
      errors.push(...failTransaction(keys, 'Linear issueBatchCreate returned uncorrelatable transaction errors.'));
      return;
    }
    const issue = record.issues[index] as JsonObject;
    const key = keyById.get(issue.id as string);
    if (!key) {
      errors.push(...failTransaction(keys, 'Linear issueBatchCreate returned uncorrelatable transaction errors.'));
      return;
    }
    affected.set(key, [...(affected.get(key) ?? []), error]);
  }

  for (const plan of plans) {
    const mapped = { issueCreate: { success: true, issue: byId.get(plan.uuid) } };
    const issueErrors = affected.get(plan.key);
    if (issueErrors?.length) {
      for (const error of issueErrors) errors.push({
        key: plan.key,
        path: error.path,
        message: error.message,
        partial: mapped,
      });
    } else {
      data[plan.key] = mapped;
    }
  }
}

function applyIndependentLookups(
  mutations: PlannedEntry[],
  raw: JsonObject,
  pathErrors: ReturnType<typeof linearGraphQLErrors>,
  errors: BatchError[],
): void {
  for (const entry of mutations) {
    if (!entry.lookups?.length || !entry.batchFinish) continue;
    const resolved: BatchLookupValues = {};
    let failed = false;
    for (const lookup of entry.lookups) {
      try {
        resolved[lookup.field] = lookup.resolve(raw, pathErrors) as never;
      } catch (error) {
        failed = true;
        const message = error instanceof Error ? error.message : String(error);
        errors.push({ key: entry.key, path: lookup.aliases, message });
      }
    }
    if (failed) continue;
    try {
      entry.prepared = entry.batchFinish(resolved);
      entry.variables = prefixVariables(entry.key, entry.prepared.variables);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push({ key: entry.key, path: [entry.key], message });
    }
  }
}

async function executeBatchWithTelemetry(
  params: { variables?: Record<string, unknown>; workspace?: string; sink?: 'inline' | 'artifact' },
  mode: MutationMode,
  ctx: ExtensionContext,
  signal: AbortSignal | undefined,
): Promise<JsonObject> {
  const parsed = parseEntries(params.variables ?? {});
  const createFlags = parsed.mutations.map((entry) => isIssueCreateEntry(entry));
  const transactional = parsed.mutations.length > 1 && createFlags.every(Boolean);
  if (parsed.mutations.length > 1 && !transactional) {
    if (createFlags.some(Boolean)) {
      throw new Error('Batch rejects transactional creates mixed with other mutations.');
    }
    throw new Error('Batch permits one ordinary named mutation.');
  }

  const reads: PlannedEntry[] = [];
  for (const entry of parsed.reads) reads.push(await planEntry(entry, 'query', mode, signal));
  const mutations: PlannedEntry[] = [];
  for (const entry of parsed.mutations) mutations.push(await planEntry(entry, 'mutation', mode, signal));

  const lookups = mutations.flatMap((entry) => entry.lookups ?? []);
  const callerKeys = new Set([...reads, ...mutations].map((entry) => entry.key));
  for (const lookup of lookups) {
    for (const alias of lookup.aliases) {
      if (callerKeys.has(alias)) {
        throw new Error(`Batch lookup alias "${alias}" collides with a caller key.`);
      }
    }
  }

  const apiKey = await apiKeyForWorkspace(ctx, params.workspace);
  const secrets = [...activeSecrets(), apiKey];
  const requestedKeys = [...reads, ...mutations].map(({ key }) => key);
  const data: JsonObject = {};
  const errors: BatchError[] = [];
  let readRequests = 0;
  let mutationRequests = 0;
  const aliasCount = reads.length + mutations.length;

  const readDocuments = [
    ...reads.map((entry) => parse(entry.document)),
    ...lookups.map((lookup) => lookup.ast),
  ];
  if (readDocuments.length) {
    const query = mergeDocuments(OperationTypeNode.QUERY, 'BatchRead', readDocuments);
    const variables = Object.assign(
      {},
      ...reads.map((entry) => entry.variables),
      ...lookups.map((lookup) => lookup.variables),
    );
    const raw = await linearGraphQL<JsonObject>(
      apiKey,
      query,
      variables,
      signal,
      { preserveUnusableRoot: true, phase: 'read' },
    );
    readRequests = 1;
    const pathErrors = linearGraphQLErrors(raw);
    for (const entry of reads) collectAlias(entry, raw, pathErrors, data, errors);
    applyIndependentLookups(mutations, raw, pathErrors, errors);
  }

  if (errors.length && mutations.length) {
    const mutationKeys = new Set(mutations.map(({ key }) => key));
    const attemptedErrors = errors.filter(({ key }) => !mutationKeys.has(key));
    return envelope(
      requestedKeys,
      data,
      attemptedErrors,
      mutations.map((entry) => entry.key),
      { read: readRequests, mutation: 0 },
      aliasCount,
      params.sink,
      secrets,
    );
  }

  if (transactional) {
    const stamped = mutations.map((entry) => {
      const input = entry.prepared?.variables.input;
      if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw new Error(`Batch entry "${entry.key}" is missing a prepared create input.`);
      }
      const uuid = randomUUID();
      return { key: entry.key, uuid, input: { ...(input as JsonObject), id: uuid } };
    });
    assertMutationAllowed(ISSUE_BATCH_CREATE_DOCUMENT, mode, ['issueBatchCreate']);
    const raw = await linearGraphQL<JsonObject>(
      apiKey,
      ISSUE_BATCH_CREATE_DOCUMENT,
      { input: { issues: stamped.map((entry) => entry.input) } },
      signal,
      { preserveUnusableRoot: true, phase: 'mutation' },
    );
    mutationRequests = 1;
    collectTransactionalCreates(stamped, raw, linearGraphQLErrors(raw), data, errors);
    return envelope(
      requestedKeys,
      data,
      errors,
      [],
      { read: readRequests, mutation: mutationRequests },
      aliasCount,
      params.sink,
      secrets,
    );
  }

  if (mutations.length) {
    const mutation = mutations[0]!;
    const query = mergeDocuments(OperationTypeNode.MUTATION, 'BatchMutation', [parse(mutation.document)]);
    assertMutationAllowed(query, mode, [mutation.root]);
    const raw = await linearGraphQL<JsonObject>(
      apiKey,
      query,
      mutation.variables,
      signal,
      { preserveUnusableRoot: true, phase: 'mutation' },
    );
    mutationRequests = 1;
    collectAlias(mutation, raw, linearGraphQLErrors(raw), data, errors);
  }

  return envelope(
    requestedKeys,
    data,
    errors,
    [],
    { read: readRequests, mutation: mutationRequests },
    aliasCount,
    params.sink,
    secrets,
  );
}

export async function executeBatch(
  params: { variables?: Record<string, unknown>; workspace?: string; sink?: 'inline' | 'artifact' },
  mode: MutationMode,
  ctx: ExtensionContext,
  signal: AbortSignal | undefined,
): Promise<JsonObject> {
  return withLinearRateLimitTelemetry(() => executeBatchWithTelemetry(params, mode, ctx, signal));
}
