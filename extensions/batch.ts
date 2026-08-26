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
  linearGraphQLResponseFailure,
  linearGraphQLWithContext,
  linearGraphQLErrors,
  withLinearRateLimitTelemetry,
  type LinearNetworkContext,
  type LinearRateLimitSnapshot,
} from './client';
import { requireJsonObject, type JsonValue } from './json';
import {
  BATCH_HELP_EXAMPLE,
  BATCH_PHASED_HELP_EXAMPLE,
  formatInvocation,
  getOperation,
  getOperationDefinition,
  parameterVariants,
  type LinearOperation,
} from './operations';
import type {
  CompatibilityObject,
  CompatibilityValue,
  GraphQLDocumentVariant,
  LookupPlan,
  OperationPlan,
  OperationPreparation,
} from './operation-types';
import {
  isCompatibilityObject,
  isCompatibilityString,
} from './operation-types';
import { activeSecrets } from './active-secrets';
import {
  assertOperationAllowed,
  linearCallContext,
  networkExecutionContext,
  routeLinearEnvelope,
  validateMutationResult,
  type JsonObject,
  type TelemetryMode,
} from './runtime';
import { assertMutationAllowed, type MutationMode } from './safety';
import { projection } from './selections';
import { verifyOperationResult } from './operation-plan';

export const BATCH_PURPOSE = 'Batch independent reads with read-only operations, or use explicit phases for one ordinary mutation, grouped issue creates, or one guarded relation delete.';

const ALIAS = /^[_A-Za-z][_0-9A-Za-z]*$/;
const FORBIDDEN_OPERATIONS = new Set(['help', 'batch']);

export function batchHelp(): JsonObject {
  return {
    name: 'batch',
    purpose: BATCH_PURPOSE,
    parameters: [
      { name: 'operations', type: '{ key?, operation, variables }[]', required: false },
      { name: 'reads', type: '{ key?, operation, variables }[]', required: false },
      { name: 'mutations', type: '{ key?, operation, variables }[]', required: false },
    ],
    entry: 'Each entry is { key?, operation, variables }. Keys are optional caller labels. The runtime assigns stable keys when absent.',
    example: BATCH_HELP_EXAMPLE,
    phasedExample: BATCH_PHASED_HELP_EXAMPLE,
  };
}

function isAlias(key: string): boolean {
  return ALIAS.test(key) && !key.startsWith('__');
}

function isPathNumber(value: string | number): value is number {
  return Object.prototype.toString.call(value) === '[object Number]';
}

function parameterList(operation: LinearOperation): string {
  return operation.parameters.map(({ name, type, required }) =>
    `${name}: ${type}${required ? ' (required)' : ' (optional)'}`,
  ).join(', ');
}

function validateVariables(
  operation: LinearOperation,
  requestedName: string,
  variables: CompatibilityObject,
): void {
  const variants = parameterVariants(operation, requestedName);
  const valid = new Set(variants.flatMap((variant) => variant.map(({ name }) => name)));
  const validVariant = variants.find((variant) => {
    const variantKeys = new Set(variant.map(({ name }) => name));
    return variant.every(({ name, required }) => !required || name in variables)
      && Object.keys(variables).every((name) => variantKeys.has(name));
  });
  if (validVariant) {
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

type CompiledLookup = {
  key: string;
  aliases: string[];
  ast: DocumentNode;
  variables: CompatibilityObject;
  failureMessage?: string;
  resolve: (
    raw: CompatibilityObject,
    pathErrors: ReturnType<typeof linearGraphQLErrors>,
  ) => CompatibilityObject;
};

type PlannedEntry = {
  key: string;
  root: string;
  document: string;
  variables: CompatibilityObject;
  prepared?: OperationPreparation;
  operationName: string;
  variant?: GraphQLDocumentVariant;
  lookups?: CompiledLookup[];
  batchFinish?: (resolved: CompatibilityObject) => OperationPreparation;
  deferredDocument?: string;
};

export const ISSUE_BATCH_CREATE_DOCUMENT = `mutation BatchIssueCreate($input: IssueBatchCreateInput!) {
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

export type AliasedDocument = {
  ast: DocumentNode;
  root: string;
};

export function aliasDocument(key: string, document: string): AliasedDocument {
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

export function mergeDocuments(
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

type RawEntry = {
  key: string;
  operation: string;
  variables: CompatibilityObject;
  generated: boolean;
  keyBase: string;
  nextSuffix: number;
};

type ParsedBatchPhases = {
  reads: RawEntry[];
  mutations: RawEntry[];
};

function parsePhaseEntry(entry: CompatibilityValue, index: number, label: string): RawEntry {
  if (!isCompatibilityObject(entry)) {
    throw new Error(`Malformed batch ${label} entry ${index}. Send { "operation": "<name>", "variables": { ... }, "key"?: "<label>" }.`);
  }
  const extra = Object.keys(entry).filter((field) => !['key', 'name', 'operation', 'variables'].includes(field));
  if (extra.length) {
    throw new Error(`Unknown batch entry field "${extra[0]}". Send { "operation": "<name>", "variables": { ... }, "key"?: "<label>" }.`);
  }
  if ('key' in entry && 'name' in entry) {
    throw new Error('Batch entries cannot include both "key" and "name". Omit "name" and send { key?, operation, variables }.');
  }
  const callerKey = entry.key ?? entry.name;
  if (callerKey !== undefined && (!isCompatibilityString(callerKey) || !isAlias(callerKey))) {
    throw new Error(`"${String(callerKey)}" is not a valid batch entry key. Send { key?: "valid_label", operation, variables }; keys are optional.`);
  }
  if (!isCompatibilityString(entry.operation) || !entry.operation.trim()) {
    throw new Error('Malformed batch entry. Send { "operation": "<name>", "variables": { ... }, "key"?: "<label>" }.');
  }
  if (entry.variables !== undefined && !isCompatibilityObject(entry.variables)) {
    throw new Error('Malformed batch entry variables. Send { "operation": "<name>", "variables": { ... }, "key"?: "<label>" }.');
  }
  return {
    key: isCompatibilityString(callerKey) ? callerKey : '',
    operation: entry.operation,
    variables: isCompatibilityObject(entry.variables) ? entry.variables : {},
    generated: callerKey === undefined,
    keyBase: '',
    nextSuffix: 2,
  };
}

function parsePhase(value: CompatibilityValue | undefined, label: string): RawEntry[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error(`Batch ${label} must be an array. Send { "operations": [...] } for reads or { "reads": [...], "mutations": [...] } for mixed work.`);
  }
  return value.map((entry, index) => parsePhaseEntry(entry, index, label));
}

function assignKeys(entries: RawEntry[]): void {
  const used = new Set<string>();
  for (const entry of entries) {
    if (entry.generated) continue;
    if (used.has(entry.key)) {
      throw new Error(`Duplicate batch key "${entry.key}". Use unique optional keys in { "operations": [...] } or { "reads": [...], "mutations": [...] }.`);
    }
    used.add(entry.key);
  }
  for (const entry of entries) {
    if (!entry.generated) continue;
    const base = getOperationDefinition(entry.operation).name;
    let key = base;
    let suffix = 2;
    while (used.has(key)) key = `${base}_${suffix++}`;
    entry.key = key;
    entry.keyBase = base;
    entry.nextSuffix = suffix;
    used.add(key);
  }
}

function parseEntries(variables: CompatibilityObject): ParsedBatchPhases {
  const allowed = new Set(['operations', 'reads', 'mutations']);
  const unknown = Object.keys(variables).filter((name) => !allowed.has(name));
  if (unknown.length) {
    throw new Error(`Unknown batch field "${unknown[0]}". Send { "operations": [...] } for reads or { "reads": [...], "mutations": [...] } for mixed work.`);
  }
  const flat = 'operations' in variables;
  if (flat && ('reads' in variables || 'mutations' in variables)) {
    throw new Error('Batch cannot combine "operations" with "reads" or "mutations". Use { "operations": [...] } for reads or { "reads": [...], "mutations": [...] } for mixed work.');
  }
  const reads = parsePhase(flat ? variables.operations : variables.reads, flat ? 'operations' : 'reads');
  const mutations = flat ? [] : parsePhase(variables.mutations, 'mutations');
  if (!reads.length && !mutations.length) {
    throw new Error('Batch requires a non-empty "operations", "reads", or "mutations" array.');
  }
  assignKeys([...reads, ...mutations]);
  if (flat) {
    const mutation = reads.find((entry) => getOperationDefinition(entry.operation).kind === 'mutation');
    if (mutation) {
      throw new Error(`Read-only batch "operations" cannot include mutation "${mutation.operation}". Use { "reads": [...], "mutations": [...] }.`);
    }
  }
  return { reads, mutations };
}

function compilePlanLookup(entryKey: string, lookup: LookupPlan): CompiledLookup {
  const prefix = `_lookup_${entryKey}_${lookup.key}`;
  const roots = new Map<string, string>();
  const aliases: string[] = [];
  const ast = visit(parse(lookup.document({})), {
    Variable(node) {
      return { kind: Kind.VARIABLE, name: { kind: Kind.NAME, value: `${prefix}_${node.name.value}` } };
    },
    OperationDefinition(node) {
      return {
        ...node,
        name: undefined,
        selectionSet: {
          ...node.selectionSet,
          selections: node.selectionSet.selections.map((selection, index) => {
            if (selection.kind !== Kind.FIELD) return selection;
            const original = selection.alias?.value ?? selection.name.value;
            const alias = index === 0 && node.selectionSet.selections.length === 1
              ? prefix
              : `${prefix}_${original}`;
            aliases.push(alias);
            roots.set(alias, original);
            return { ...selection, alias: { kind: Kind.NAME, value: alias } };
          }),
        },
      };
    },
  });
  return {
    key: lookup.key,
    aliases,
    ast,
    variables: Object.fromEntries(
      Object.entries(lookup.variables({})).map(([name, value]) => [`${prefix}_${name}`, value]),
    ),
    failureMessage: lookup.failureMessage,
    resolve(raw, pathErrors) {
      const scoped = pathErrors.filter((error) => aliases.includes(String(error.path[0])));
      if (scoped.length) throw new Error(lookup.failureMessage ?? scoped[0]!.message);
      return lookup.resolve(Object.fromEntries(aliases.map((alias) => [roots.get(alias)!, raw[alias]])), {});
    },
  };
}

export function compileLookupDocument(key: string, lookup: LookupPlan): string {
  const resolved = Object.fromEntries(
    (lookup.dependsOn ?? []).map((dependency) => [
      dependency,
      { id: '00000000-0000-4000-8000-000000000000' },
    ]),
  );
  return print(compilePlanLookup(key, {
    ...lookup,
    variables: () => lookup.variables(resolved),
  }).ast);
}

function prefixVariables(key: string, variables: CompatibilityObject): CompatibilityObject {
  const prefixed: CompatibilityObject = {};
  for (const [name, value] of Object.entries(variables)) {
    if (value !== undefined) prefixed[`${key}_${name}`] = value;
  }
  return prefixed;
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
): Promise<PlannedEntry> {
  const operation = assertNamedEntry(entry);
  const definition = getOperationDefinition(entry.operation);
  if (definition.kind !== expectedKind) {
    throw new Error(`Batch entry "${entry.key}" must be a ${expectedKind} operation.`);
  }
  assertOperationAllowed(operation, entry.variables, mode);
  validateVariables(operation, entry.operation, entry.variables);
  const factory = definition.preparation.plan;
  if (!factory) throw new Error(`Batch entry "${entry.key}" is missing its pure operation plan.`);
  let plan: OperationPlan;
  try {
    plan = await factory(entry.variables);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Batch entry "${entry.key}": ${message}`);
  }
  if (plan.kind !== expectedKind) throw new Error(`Batch entry "${entry.key}" produced the wrong operation plan kind.`);
  if ((expectedKind === 'query' && plan.lookups.length)
    || plan.lookups.some((lookup) => lookup.dependsOn?.length)) {
    throw new Error(`Batch entry "${entry.key}" requires a second lookup layer and cannot run in one read request.`);
  }
  if (plan.lookups.length) {
    const variant = operation.variants?.[0];
    const planned: PlannedEntry = {
      key: entry.key,
      root: variant?.root ?? '',
      document: '',
      variables: {},
      operationName: operation.name,
      variant,
      lookups: plan.lookups.map((lookup) => compilePlanLookup(entry.key, lookup)),
      batchFinish: plan.finish,
    };
    if (expectedKind === 'mutation') planned.deferredDocument = operation.document;
    return planned;
  }
  const prepared = plan.finish({});
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
    if (entry.prepared?.failureMessage) {
      errors.push({ key: entry.key, path: [entry.key], message: entry.prepared.failureMessage });
    } else {
      for (const error of scoped) {
        const owned: BatchError = { key: entry.key, path: error.path, message: error.message };
        if (partial) owned.partial = partial;
        errors.push(owned);
      }
    }
    return;
  }
  const value = raw[entry.key];
  const mapped = { [entry.root]: value };
  try {
    if (value == null) throw new Error(`Batch entry "${entry.key}" returned no data.`);
    if (entry.prepared) verifyOperationResult(entry.prepared, mapped);
    if (entry.variant?.mutationResult) validateMutationResult(entry.operationName, mapped, entry.variant);
  } catch (error) {
    const message = entry.prepared?.failureMessage
      ?? (error instanceof Error ? error.message : String(error));
    const failed: BatchError = { key: entry.key, path: [entry.key], message };
    if (value != null) failed.partial = mapped;
    errors.push(failed);
    return;
  }
  const acknowledgement = entry.prepared?.acknowledgement;
  data[entry.key] = acknowledgement ?? mapped;
}

export type BatchError = {
  key: string;
  path: ReadonlyArray<string | number>;
  message: string;
  causes?: Array<{ path: ReadonlyArray<string | number>; message: string }>;
  partial?: JsonObject;
};

function lookupFailureMessage(entry: PlannedEntry): string | undefined {
  return entry.lookups?.find((lookup) => lookup.failureMessage)?.failureMessage;
}

function attributableFailureMessage(entry: PlannedEntry): string | undefined {
  return entry.prepared?.failureMessage ?? lookupFailureMessage(entry);
}

type GraphQLFailureOwner = {
  entry: PlannedEntry;
  aliases: readonly string[];
  failureMessage?: string;
  partial?: JsonObject;
};

type StructuredGraphQLPhase = {
  raw: CompatibilityObject;
  errors: ReturnType<typeof linearGraphQLErrors>;
};

async function executeStructuredGraphQLPhase(
  network: LinearNetworkContext,
  query: string,
  variables: CompatibilityObject,
  phase: 'read' | 'mutation',
): Promise<StructuredGraphQLPhase> {
  try {
    return {
      raw: await linearGraphQLWithContext(network, query, variables, {
        throwResponseErrors: true,
        phase,
      }),
      errors: [],
    };
  } catch (error) {
    const failure = linearGraphQLResponseFailure(error);
    if (!failure) throw error;
    return { raw: failure.data, errors: failure.errors };
  }
}

function classifyStructuredGraphQLErrors(
  responseErrors: ReturnType<typeof linearGraphQLErrors>,
  owners: readonly GraphQLFailureOwner[],
  fallbackOwners: readonly GraphQLFailureOwner[],
  output: BatchError[],
): Set<string> {
  const grouped = new Map<string, {
    owner: GraphQLFailureOwner;
    errors: typeof responseErrors;
    fallback: boolean;
  }>();
  for (const responseError of responseErrors) {
    const root = responseError.path[0];
    const matched = root === undefined
      ? []
      : owners.filter((owner) => owner.aliases.includes(String(root)));
    const fallback = matched.length === 0;
    for (const owner of fallback ? fallbackOwners : matched) {
      const current = grouped.get(owner.entry.key);
      grouped.set(owner.entry.key, {
        owner,
        errors: [...(current?.errors ?? []), responseError],
        fallback: Boolean(current?.fallback || fallback),
      });
    }
  }
  for (const { owner, errors, fallback } of grouped.values()) {
    if (output.some((error) => error.key === owner.entry.key)) continue;
    const first = errors[0]!;
    const stable = owner.failureMessage;
    const owned: BatchError = {
      key: owner.entry.key,
      path: stable || fallback || !first.path.length ? [owner.entry.key] : first.path,
      message: stable ?? first.message,
    };
    if (errors.length > 1) {
      owned.causes = errors.map((error) => ({ path: error.path, message: error.message }));
    }
    if (owner.partial) owned.partial = owner.partial;
    output.push(owned);
  }
  return new Set(grouped.keys());
}

function consolidateBatchErrors(errors: readonly BatchError[]): BatchError[] {
  const grouped = new Map<string, BatchError[]>();
  for (const error of errors) grouped.set(error.key, [...(grouped.get(error.key) ?? []), error]);
  return [...grouped.entries()].map(([key, entries]) => {
    const first = entries[0]!;
    const causes = entries.flatMap((entry) => entry.causes ?? [{ path: entry.path, message: entry.message }]);
    const partial = entries.find((entry) => entry.partial)?.partial;
    const consolidated: BatchError = {
      key,
      path: first.path,
      message: first.message,
    };
    if (causes.length > 1) consolidated.causes = causes;
    if (partial) consolidated.partial = partial;
    return consolidated;
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
  telemetry: readonly LinearRateLimitSnapshot[],
  telemetryMode?: TelemetryMode,
): Promise<JsonObject> {
  const errors = consolidateBatchErrors(rawErrors);
  assertBatchAccounting(requestedKeys, data, errors, skipped);
  return routeLinearEnvelope({
    data,
    errors,
    skipped,
    meta: { requests, aliases, truncations: [], stringsClipped: 0 },
  }, { label: 'batch', category: 'batch', sink, secrets, telemetry, telemetryMode });
}

function failTransaction(keys: readonly string[], message: string): BatchError[] {
  return keys.map((key) => ({ key, path: ['issueBatchCreate'], message }));
}

function collectTransactionalCreates(
  plans: Array<{ key: string; uuid: string }>,
  raw: CompatibilityObject,
  pathErrors: ReturnType<typeof linearGraphQLErrors>,
  data: JsonObject,
  errors: BatchError[],
): void {
  const keys = plans.map((plan) => plan.key);
  const scoped = pathErrors.filter((error) => error.path[0] === 'issueBatchCreate');
  const rootErrors = scoped.filter((error) => error.path.length < 3
    || error.path[1] !== 'issues'
    || !isPathNumber(error.path[2]!));
  if (rootErrors.length) {
    for (const key of keys) {
      for (const error of rootErrors) errors.push({ key, path: error.path, message: error.message });
    }
    return;
  }
  const record = isCompatibilityObject(raw.issueBatchCreate) ? raw.issueBatchCreate : undefined;
  if (!record) {
    errors.push(...failTransaction(keys, 'Linear issueBatchCreate returned unusable transaction data.'));
    return;
  }
  if (record.success !== true) {
    errors.push(...failTransaction(keys, 'Linear issueBatchCreate failed mutation expectation: issueBatchCreate.success must be true.'));
    return;
  }
  if (!Array.isArray(record.issues)) {
    errors.push(...failTransaction(keys, 'Linear issueBatchCreate returned unusable transaction data.'));
    return;
  }
  const byId = new Map<string, CompatibilityObject>();
  for (const issue of record.issues) {
    if (!isCompatibilityObject(issue)) {
      errors.push(...failTransaction(keys, 'Linear issueBatchCreate returned unusable transaction data.'));
      return;
    }
    const id = issue.id;
    if (!isCompatibilityString(id) || !id) {
      errors.push(...failTransaction(keys, 'Linear issueBatchCreate returned unusable transaction data.'));
      return;
    }
    if (byId.has(id)) {
      errors.push(...failTransaction(keys, 'Linear issueBatchCreate returned duplicate issue ids.'));
      return;
    }
    byId.set(id, issue);
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
    const issue = record.issues[index];
    const key = isCompatibilityObject(issue) && isCompatibilityString(issue.id)
      ? keyById.get(issue.id)
      : undefined;
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
  raw: CompatibilityObject,
  pathErrors: ReturnType<typeof linearGraphQLErrors>,
  errors: BatchError[],
): void {
  for (const entry of mutations) {
    if (errors.some((error) => error.key === entry.key)) continue;
    if (!entry.lookups?.length || !entry.batchFinish) continue;
    const resolved: CompatibilityObject = {};
    let failed = false;
    for (const lookup of entry.lookups) {
      try {
        resolved[lookup.key] = lookup.resolve(raw, pathErrors);
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
      if (entry.deferredDocument) {
        const document = entry.prepared.variant?.document ?? entry.deferredDocument;
        const compiled = aliasDocument(entry.key, document);
        entry.document = print(compiled.ast);
        entry.root = compiled.root;
        entry.variant = entry.prepared.variant ?? entry.variant;
        entry.deferredDocument = undefined;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push({ key: entry.key, path: [entry.key], message });
    }
  }
}

export type BatchRequest = {
  variables?: JsonValue;
  workspace?: string;
  sink?: 'inline' | 'artifact';
  telemetryMode?: TelemetryMode;
};

async function executeBatchWithTelemetry(
  params: BatchRequest,
  mode: MutationMode,
  ctx: ExtensionContext,
  signal: AbortSignal | undefined,
  telemetry: LinearRateLimitSnapshot[],
): Promise<JsonObject> {
  const parsed = parseEntries(requireJsonObject(params.variables ?? {}, 'Batch variables'));
  const createFlags = parsed.mutations.map((entry) => isIssueCreateEntry(entry));
  const transactional = parsed.mutations.length > 1 && createFlags.every(Boolean);
  if (parsed.mutations.length > 1 && !transactional) {
    if (createFlags.some(Boolean)) {
      throw new Error('Batch rejects transactional creates mixed with other mutations.');
    }
    throw new Error('Batch permits one ordinary named mutation.');
  }

  let reads: PlannedEntry[];
  let mutations: PlannedEntry[];
  let lookups: CompiledLookup[];
  while (true) {
    reads = [];
    for (const entry of parsed.reads) reads.push(await planEntry(entry, 'query', mode));
    mutations = [];
    for (const entry of parsed.mutations) mutations.push(await planEntry(entry, 'mutation', mode));
    lookups = mutations.flatMap((entry) => entry.lookups ?? []);
    const rawEntries = [...parsed.reads, ...parsed.mutations];
    const callerByKey = new Map(rawEntries.map((entry) => [entry.key, entry]));
    let retry = false;
    for (const mutation of mutations) {
      for (const alias of mutation.lookups?.flatMap((lookup) => lookup.aliases) ?? []) {
        const caller = callerByKey.get(alias);
        if (!caller) continue;
        const owner = parsed.mutations.find((entry) => entry.key === mutation.key)!;
        const generated = caller.generated ? caller : owner.generated ? owner : undefined;
        if (!generated) {
          throw new Error(`Batch key "${alias}" is reserved by guarded mutation "${owner.key}". Choose another optional key in { "reads": [...], "mutations": [...] }.`);
        }
        const blocked = new Set([...callerByKey.keys(), ...lookups.flatMap((lookup) => lookup.aliases)]);
        blocked.delete(generated.key);
        let key = `${generated.keyBase}_${generated.nextSuffix++}`;
        while (blocked.has(key)) key = `${generated.keyBase}_${generated.nextSuffix++}`;
        generated.key = key;
        retry = true;
        break;
      }
      if (retry) break;
    }
    if (!retry) break;
  }

  const call = linearCallContext(mode, signal, ctx, params);
  const network = await networkExecutionContext(call, fetch, telemetry);
  const apiKey = network.credential.apiKey;
  const secrets = [...activeSecrets(), apiKey];
  const requestedKeys = [...reads, ...mutations].map(({ key }) => key);
  const data: JsonObject = {};
  const errors: BatchError[] = [];
  let readRequests = 0;
  let mutationRequests = 0;
  let readPhaseFailed = false;
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
    readRequests = 1;
    const phase = await executeStructuredGraphQLPhase(network, query, variables, 'read');
    const readOwners: GraphQLFailureOwner[] = reads.map((entry) => {
      const owner: GraphQLFailureOwner = { entry, aliases: [entry.key] };
      const alias = phase.raw[entry.key];
      if (alias != null) owner.partial = { [entry.root]: alias };
      return owner;
    });
    const lookupOwners: GraphQLFailureOwner[] = mutations
      .filter((entry) => entry.lookups?.length)
      .map((entry) => ({
        entry,
        aliases: entry.lookups!.flatMap((lookup) => lookup.aliases),
        failureMessage: lookupFailureMessage(entry),
      }));
    const failed = classifyStructuredGraphQLErrors(
      phase.errors,
      [...readOwners, ...lookupOwners],
      lookupOwners.length ? lookupOwners : readOwners,
      errors,
    );
    readPhaseFailed = phase.errors.length > 0;
    for (const entry of reads) {
      if (!failed.has(entry.key)) collectAlias(entry, phase.raw, [], data, errors);
    }
    applyIndependentLookups(mutations, phase.raw, [], errors);
  }

  if ((readPhaseFailed || errors.length) && mutations.length) {
    const failedMutationKeys = new Set(errors.map(({ key }) => key));
    return envelope(
      requestedKeys,
      data,
      errors,
      mutations.filter((entry) => !failedMutationKeys.has(entry.key)).map((entry) => entry.key),
      { read: readRequests, mutation: 0 },
      aliasCount,
      params.sink,
      secrets,
      network.telemetry,
      params.telemetryMode,
    );
  }

  if (transactional) {
    const stamped = mutations.map((entry) => {
      const input = entry.prepared?.variables.input;
      if (!isCompatibilityObject(input)) {
        throw new Error(`Batch entry "${entry.key}" is missing a prepared create input.`);
      }
      const uuid = randomUUID();
      return { key: entry.key, uuid, input: { ...input, id: uuid } };
    });
    assertMutationAllowed(ISSUE_BATCH_CREATE_DOCUMENT, mode, ['issueBatchCreate']);
    mutationRequests = 1;
    const phase = await executeStructuredGraphQLPhase(
      network,
      ISSUE_BATCH_CREATE_DOCUMENT,
      { input: { issues: stamped.map((entry) => entry.input) } },
      'mutation',
    );
    const scoped = phase.errors.filter((error) => error.path[0] === 'issueBatchCreate'
      && error.path[1] === 'issues'
      && isPathNumber(error.path[2]!));
    const responseWide = phase.errors.filter((error) => !scoped.includes(error));
    if (responseWide.length) {
      const owners: GraphQLFailureOwner[] = mutations.map((entry) => ({ entry, aliases: ['issueBatchCreate'] }));
      classifyStructuredGraphQLErrors(responseWide, owners, owners, errors);
    } else {
      collectTransactionalCreates(stamped, phase.raw, scoped, data, errors);
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
      network.telemetry,
      params.telemetryMode,
    );
  }

  if (mutations.length) {
    const mutation = mutations[0]!;
    const query = mergeDocuments(OperationTypeNode.MUTATION, 'BatchMutation', [parse(mutation.document)]);
    assertMutationAllowed(query, mode, [mutation.root]);
    mutationRequests = 1;
    const phase = await executeStructuredGraphQLPhase(network, query, mutation.variables, 'mutation');
    if (phase.errors.length) {
      const owner: GraphQLFailureOwner = {
        entry: mutation,
        aliases: [mutation.key],
        failureMessage: attributableFailureMessage(mutation),
      };
      const alias = phase.raw[mutation.key];
      if (alias != null) owner.partial = { [mutation.root]: alias };
      classifyStructuredGraphQLErrors(phase.errors, [owner], [owner], errors);
    } else {
      collectAlias(mutation, phase.raw, [], data, errors);
    }
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
    network.telemetry,
    params.telemetryMode,
  );
}

export async function executeBatch(
  params: BatchRequest,
  mode: MutationMode,
  ctx: ExtensionContext,
  signal: AbortSignal | undefined,
): Promise<JsonObject> {
  const telemetry: LinearRateLimitSnapshot[] = [];
  return withLinearRateLimitTelemetry(telemetry, () =>
    executeBatchWithTelemetry(params, mode, ctx, signal, telemetry));
}
