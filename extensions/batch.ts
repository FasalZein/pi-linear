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
  type LinearGraphQLPathError,
  type LinearNetworkContext,
  type LinearRateLimitSnapshot,
} from './client';
import { requireJsonObject, type JsonValue } from './json';
import { mutationAcknowledgement } from './mutation-acknowledgement';
import {
  BATCH_HELP_EXAMPLE,
  BATCH_PHASED_HELP_EXAMPLE,
  getOperation,
  getOperationDefinition,
  type LinearOperation,
} from './operations';
import type {
  CompatibilityObject,
  CompatibilityValue,
  GraphQLDocumentVariant,
  LookupPlan,
  OperationDefinition,
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
import { validateOperationVariables } from './operation-validation';

export const BATCH_PURPOSE = 'Batch independent reads, or run several ordinary mutations sequentially after all-entry preflight. Stop at the first failure; grouped issue creates stay transactional.';

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

/**
 * `operations` is the read-only shorthand and cannot be combined with the phased pair.
 *
 * The published schema lists all three fields so the model can see them, so the rule that
 * separates them lives here. The tool's pre-call gate and the batch parser share this one
 * definition, which means a wrong combination is refused before any network request and
 * names both halves of the conflict.
 */
export function assertBatchPhaseCombination(variables: CompatibilityObject): void {
  if ('operations' in variables && ('reads' in variables || 'mutations' in variables)) {
    throw new Error('Batch cannot combine "operations" with "reads" or "mutations". Use { "operations": [...] } for reads or { "reads": [...], "mutations": [...] } for mixed work.');
  }
}

function parseEntries(variables: CompatibilityObject): ParsedBatchPhases {
  const allowed = new Set(['operations', 'reads', 'mutations']);
  const unknown = Object.keys(variables).filter((name) => !allowed.has(name));
  if (unknown.length) {
    throw new Error(`Unknown batch field "${unknown[0]}". Send { "operations": [...] } for reads or { "reads": [...], "mutations": [...] } for mixed work.`);
  }
  const flat = 'operations' in variables;
  assertBatchPhaseCombination(variables);
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

function assertSingleLookupLayer(
  entry: RawEntry,
  plan: OperationPlan,
  expectedKind: 'query' | 'mutation',
): void {
  const readWithLookups = expectedKind === 'query' && plan.lookups.length > 0;
  const dependentLookups = plan.lookups.some((lookup) => lookup.dependsOn?.length);
  if (readWithLookups || dependentLookups) {
    throw new Error(`Batch entry "${entry.key}" requires a second lookup layer and cannot run in one read request.`);
  }
}

async function batchEntryPlan(
  entry: RawEntry,
  definition: OperationDefinition,
  expectedKind: 'query' | 'mutation',
): Promise<OperationPlan> {
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
  assertSingleLookupLayer(entry, plan, expectedKind);
  return plan;
}

function deferredLookupEntry(
  entry: RawEntry,
  operation: LinearOperation,
  plan: OperationPlan,
  expectedKind: 'query' | 'mutation',
): PlannedEntry {
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

function preparedEntry(entry: RawEntry, operation: LinearOperation, plan: OperationPlan): PlannedEntry {
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
  validateOperationVariables(operation, entry.operation, entry.variables, 'parameter-card');
  const plan = await batchEntryPlan(entry, definition, expectedKind);
  if (plan.lookups.length) return deferredLookupEntry(entry, operation, plan, expectedKind);
  return preparedEntry(entry, operation, plan);
}

function batchEntryResult(entry: PlannedEntry, mapped: JsonObject): JsonObject {
  return entry.prepared?.acknowledgement
    ?? (entry.variant && entry.prepared?.resultView !== 'full'
      ? mutationAcknowledgement(entry.operationName, mapped, entry.variant)
      : mapped);
}

function aliasPartial(entry: PlannedEntry, value: CompatibilityValue | undefined): JsonObject | undefined {
  if (value == null) return undefined;
  return { [entry.root]: value };
}

function aliasPathError(
  entry: PlannedEntry,
  error: LinearGraphQLPathError,
  partial: JsonObject | undefined,
): BatchError {
  const owned: BatchError = { key: entry.key, path: error.path, message: error.message };
  if (partial) owned.partial = partial;
  return owned;
}

function scopedAliasErrors(
  entry: PlannedEntry,
  value: CompatibilityValue | undefined,
  scoped: readonly LinearGraphQLPathError[],
): BatchError[] {
  const stable = entry.prepared?.failureMessage;
  if (stable) return [{ key: entry.key, path: [entry.key], message: stable }];
  const partial = aliasPartial(entry, value);
  return scoped.map((error) => aliasPathError(entry, error, partial));
}

function assertAliasValue(entry: PlannedEntry, value: CompatibilityValue | undefined): void {
  if (value == null) throw new Error(`Batch entry "${entry.key}" returned no data.`);
}

function assertPreparedAlias(entry: PlannedEntry, mapped: JsonObject): void {
  if (entry.prepared) verifyOperationResult(entry.prepared, mapped);
}

function assertMutationAlias(entry: PlannedEntry, mapped: JsonObject): void {
  if (entry.variant?.mutationResult) validateMutationResult(entry.operationName, mapped, entry.variant);
}

function aliasResultFailure(
  entry: PlannedEntry,
  mapped: JsonObject,
  value: CompatibilityValue | undefined,
): BatchError | undefined {
  try {
    assertAliasValue(entry, value);
    assertPreparedAlias(entry, mapped);
    assertMutationAlias(entry, mapped);
    return undefined;
  } catch (error) {
    const failed: BatchError = {
      key: entry.key,
      path: [entry.key],
      message: entry.prepared?.failureMessage
        ?? (error instanceof Error ? error.message : String(error)),
    };
    if (value != null) failed.partial = mapped;
    return failed;
  }
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
    errors.push(...scopedAliasErrors(entry, raw[entry.key], scoped));
    return;
  }
  const value = raw[entry.key];
  const mapped = { [entry.root]: value };
  const failed = aliasResultFailure(entry, mapped, value);
  if (failed) {
    errors.push(failed);
    return;
  }
  data[entry.key] = batchEntryResult(entry, mapped);
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
  retryRateLimit = true,
): Promise<StructuredGraphQLPhase> {
  try {
    return {
      raw: await linearGraphQLWithContext(network, query, variables, {
        throwResponseErrors: true,
        phase,
        retryRateLimit,
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

type TransactionalCreatePlan = {
  key: string;
  uuid: string;
  view?: 'summary' | 'full';
  variant?: GraphQLDocumentVariant;
};

function transactionIssues(
  raw: CompatibilityObject,
  keys: readonly string[],
  errors: BatchError[],
): CompatibilityValue[] | undefined {
  const record = raw.issueBatchCreate;
  if (!isCompatibilityObject(record)) {
    errors.push(...failTransaction(keys, 'Linear issueBatchCreate returned unusable transaction data.'));
    return undefined;
  }
  if (record.success !== true) {
    errors.push(...failTransaction(keys, 'Linear issueBatchCreate failed mutation expectation: issueBatchCreate.success must be true.'));
    return undefined;
  }
  if (!Array.isArray(record.issues)) {
    errors.push(...failTransaction(keys, 'Linear issueBatchCreate returned unusable transaction data.'));
    return undefined;
  }
  return record.issues;
}

function indexTransactionIssues(
  issues: readonly CompatibilityValue[],
  keys: readonly string[],
  errors: BatchError[],
): Map<string, CompatibilityObject> | undefined {
  const byId = new Map<string, CompatibilityObject>();
  for (const issue of issues) {
    if (!isCompatibilityObject(issue)) {
      errors.push(...failTransaction(keys, 'Linear issueBatchCreate returned unusable transaction data.'));
      return undefined;
    }
    const id = issue.id;
    if (!isCompatibilityString(id) || !id) {
      errors.push(...failTransaction(keys, 'Linear issueBatchCreate returned unusable transaction data.'));
      return undefined;
    }
    if (byId.has(id)) {
      errors.push(...failTransaction(keys, 'Linear issueBatchCreate returned duplicate issue ids.'));
      return undefined;
    }
    byId.set(id, issue);
  }
  return byId;
}

function stampedIssuesMatch(
  plans: readonly TransactionalCreatePlan[],
  byId: ReadonlyMap<string, CompatibilityObject>,
): boolean {
  const stamped = new Set(plans.map((plan) => plan.uuid));
  if (byId.size !== stamped.size) return false;
  return [...byId.keys()].every((id) => stamped.has(id));
}

function transactionIssueIndex(error: LinearGraphQLPathError, count: number): number | undefined {
  const index = error.path[2];
  if (!isPathNumber(index) || !Number.isSafeInteger(index)) return undefined;
  return index >= 0 && index < count ? index : undefined;
}

function transactionErrorKey(
  error: LinearGraphQLPathError,
  issues: readonly CompatibilityValue[],
  keyById: ReadonlyMap<string, string>,
): string | undefined {
  const index = transactionIssueIndex(error, issues.length);
  if (index === undefined) return undefined;
  const issue = issues[index];
  if (!isCompatibilityObject(issue) || !isCompatibilityString(issue.id)) return undefined;
  return keyById.get(issue.id);
}

function affectedTransactionErrors(
  plans: readonly TransactionalCreatePlan[],
  issues: readonly CompatibilityValue[],
  scoped: ReturnType<typeof linearGraphQLErrors>,
  keys: readonly string[],
  errors: BatchError[],
): Map<string, LinearGraphQLPathError[]> | undefined {
  const keyById = new Map(plans.map((plan) => [plan.uuid, plan.key]));
  const affected = new Map<string, LinearGraphQLPathError[]>();
  for (const error of scoped) {
    const key = transactionErrorKey(error, issues, keyById);
    if (!key) {
      errors.push(...failTransaction(keys, 'Linear issueBatchCreate returned uncorrelatable transaction errors.'));
      return undefined;
    }
    affected.set(key, [...(affected.get(key) ?? []), error]);
  }
  return affected;
}

function transactionPlanResult(
  plan: TransactionalCreatePlan,
  issue: CompatibilityObject | undefined,
): JsonObject {
  const mapped = { issueCreate: { success: true, issue } };
  if (plan.view === 'full' || !plan.variant) return mapped;
  return mutationAcknowledgement('create_issue', mapped, plan.variant);
}

function collectTransactionResults(
  plans: readonly TransactionalCreatePlan[],
  byId: ReadonlyMap<string, CompatibilityObject>,
  affected: ReadonlyMap<string, readonly LinearGraphQLPathError[]>,
  data: JsonObject,
  errors: BatchError[],
): void {
  for (const plan of plans) {
    const result = transactionPlanResult(plan, byId.get(plan.uuid));
    const issueErrors = affected.get(plan.key);
    if (!issueErrors?.length) {
      data[plan.key] = result;
      continue;
    }
    for (const error of issueErrors) {
      errors.push({ key: plan.key, path: error.path, message: error.message, partial: result });
    }
  }
}

function collectTransactionalCreates(
  plans: TransactionalCreatePlan[],
  raw: CompatibilityObject,
  pathErrors: ReturnType<typeof linearGraphQLErrors>,
  data: JsonObject,
  errors: BatchError[],
): void {
  const keys = plans.map((plan) => plan.key);
  const scoped = pathErrors.filter((error) => error.path[0] === 'issueBatchCreate');
  const issues = transactionIssues(raw, keys, errors);
  if (!issues) return;
  const byId = indexTransactionIssues(issues, keys, errors);
  if (!byId) return;
  if (!stampedIssuesMatch(plans, byId)) {
    errors.push(...failTransaction(
      keys,
      'Linear issueBatchCreate returned issue ids that do not match the stamped create ids.',
    ));
    return;
  }
  const affected = affectedTransactionErrors(plans, issues, scoped, keys, errors);
  if (!affected) return;
  collectTransactionResults(plans, byId, affected, data, errors);
}

function lookupEntryPending(entry: PlannedEntry, errors: readonly BatchError[]): boolean {
  if (!entry.lookups?.length || !entry.batchFinish) return false;
  return !errors.some((error) => error.key === entry.key);
}

function resolveEntryLookups(
  entry: PlannedEntry,
  raw: CompatibilityObject,
  pathErrors: ReturnType<typeof linearGraphQLErrors>,
  errors: BatchError[],
): CompatibilityObject | undefined {
  const resolved: CompatibilityObject = {};
  let failed = false;
  for (const lookup of entry.lookups ?? []) {
    try {
      resolved[lookup.key] = lookup.resolve(raw, pathErrors);
    } catch (error) {
      failed = true;
      const message = error instanceof Error ? error.message : String(error);
      errors.push({ key: entry.key, path: lookup.aliases, message });
    }
  }
  return failed ? undefined : resolved;
}

function applyDeferredDocument(entry: PlannedEntry, prepared: OperationPreparation): void {
  if (!entry.deferredDocument) return;
  const compiled = aliasDocument(entry.key, prepared.variant?.document ?? entry.deferredDocument);
  entry.document = print(compiled.ast);
  entry.root = compiled.root;
  entry.variant = prepared.variant ?? entry.variant;
  entry.deferredDocument = undefined;
}

function finishLookupEntry(
  entry: PlannedEntry,
  resolved: CompatibilityObject,
  errors: BatchError[],
): void {
  const finish = entry.batchFinish;
  if (!finish) return;
  try {
    const prepared = finish(resolved);
    entry.prepared = prepared;
    entry.variables = prefixVariables(entry.key, prepared.variables);
    applyDeferredDocument(entry, prepared);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    errors.push({ key: entry.key, path: [entry.key], message });
  }
}

function applyIndependentLookups(
  mutations: PlannedEntry[],
  raw: CompatibilityObject,
  pathErrors: ReturnType<typeof linearGraphQLErrors>,
  errors: BatchError[],
): void {
  for (const entry of mutations) {
    if (!lookupEntryPending(entry, errors)) continue;
    const resolved = resolveEntryLookups(entry, raw, pathErrors, errors);
    if (resolved) finishLookupEntry(entry, resolved, errors);
  }
}

export type BatchRequest = {
  variables?: JsonValue;
  workspace?: string;
  sink?: 'inline' | 'artifact';
  telemetryMode?: TelemetryMode;
};

type PlannedBatch = {
  reads: PlannedEntry[];
  mutations: PlannedEntry[];
  lookups: CompiledLookup[];
  transactional: boolean;
};

type BatchRuntime = PlannedBatch & {
  params: BatchRequest;
  network: LinearNetworkContext;
  requestedKeys: string[];
  data: JsonObject;
  errors: BatchError[];
  secrets: string[];
  aliasCount: number;
};

type PreparedMutation = {
  mutation: PlannedEntry;
  query: string;
};

function transactionMode(parsed: ParsedBatchPhases): boolean {
  const createFlags = parsed.mutations.map((entry) => isIssueCreateEntry(entry));
  const transactional = parsed.mutations.length > 1 && createFlags.every(Boolean);
  if (parsed.mutations.length > 1 && !transactional && createFlags.some(Boolean)) {
    throw new Error('Batch rejects transactional creates mixed with other mutations.');
  }
  return transactional;
}

async function planBatchAttempt(
  parsed: ParsedBatchPhases,
  mode: MutationMode,
): Promise<Omit<PlannedBatch, 'transactional'>> {
  const reads: PlannedEntry[] = [];
  for (const entry of parsed.reads) reads.push(await planEntry(entry, 'query', mode));
  const mutations: PlannedEntry[] = [];
  for (const entry of parsed.mutations) mutations.push(await planEntry(entry, 'mutation', mode));
  return {
    reads,
    mutations,
    lookups: mutations.flatMap((entry) => entry.lookups ?? []),
  };
}

function generatedCollisionEntry(caller: RawEntry, owner: RawEntry, alias: string): RawEntry {
  if (caller.generated) return caller;
  if (owner.generated) return owner;
  throw new Error(`Batch key "${alias}" is reserved by guarded mutation "${owner.key}". Choose another optional key in { "reads": [...], "mutations": [...] }.`);
}

function lookupAliases(mutations: readonly PlannedEntry[]): Array<{ ownerKey: string; alias: string }> {
  return mutations.flatMap((mutation) => (mutation.lookups ?? []).flatMap((lookup) =>
    lookup.aliases.map((alias) => ({ ownerKey: mutation.key, alias }))));
}

function lookupAliasCollision(
  parsed: ParsedBatchPhases,
  mutations: readonly PlannedEntry[],
): RawEntry | undefined {
  const rawEntries = [...parsed.reads, ...parsed.mutations];
  const callerByKey = new Map(rawEntries.map((entry) => [entry.key, entry]));
  for (const { ownerKey, alias } of lookupAliases(mutations)) {
    const caller = callerByKey.get(alias);
    if (!caller) continue;
    const owner = parsed.mutations.find((entry) => entry.key === ownerKey)!;
    return generatedCollisionEntry(caller, owner, alias);
  }
  return undefined;
}

function blockedBatchKeys(parsed: ParsedBatchPhases, lookups: readonly CompiledLookup[]): Set<string> {
  return new Set([
    ...parsed.reads.map((entry) => entry.key),
    ...parsed.mutations.map((entry) => entry.key),
    ...lookups.flatMap((lookup) => lookup.aliases),
  ]);
}

function renameGeneratedEntry(entry: RawEntry, blocked: Set<string>): void {
  blocked.delete(entry.key);
  let key = `${entry.keyBase}_${entry.nextSuffix++}`;
  while (blocked.has(key)) key = `${entry.keyBase}_${entry.nextSuffix++}`;
  entry.key = key;
}

async function planBatch(parsed: ParsedBatchPhases, mode: MutationMode): Promise<PlannedBatch> {
  const transactional = transactionMode(parsed);
  while (true) {
    const planned = await planBatchAttempt(parsed, mode);
    const collision = lookupAliasCollision(parsed, planned.mutations);
    if (!collision) return { ...planned, transactional };
    renameGeneratedEntry(collision, blockedBatchKeys(parsed, planned.lookups));
  }
}

function readOwners(reads: readonly PlannedEntry[], raw: CompatibilityObject): GraphQLFailureOwner[] {
  return reads.map((entry) => {
    const owner: GraphQLFailureOwner = { entry, aliases: [entry.key] };
    const alias = raw[entry.key];
    if (alias != null) owner.partial = { [entry.root]: alias };
    return owner;
  });
}

function lookupOwners(mutations: readonly PlannedEntry[]): GraphQLFailureOwner[] {
  return mutations
    .filter((entry) => entry.lookups?.length)
    .map((entry) => ({
      entry,
      aliases: entry.lookups!.flatMap((lookup) => lookup.aliases),
      failureMessage: lookupFailureMessage(entry),
    }));
}

async function executeReadPhase(runtime: BatchRuntime): Promise<{ requests: number; failed: boolean }> {
  const readDocuments = [
    ...runtime.reads.map((entry) => parse(entry.document)),
    ...runtime.lookups.map((lookup) => lookup.ast),
  ];
  if (!readDocuments.length) return { requests: 0, failed: false };
  const query = mergeDocuments(OperationTypeNode.QUERY, 'BatchRead', readDocuments);
  const variables = Object.assign(
    {},
    ...runtime.reads.map((entry) => entry.variables),
    ...runtime.lookups.map((lookup) => lookup.variables),
  );
  const phase = await executeStructuredGraphQLPhase(runtime.network, query, variables, 'read');
  const directOwners = readOwners(runtime.reads, phase.raw);
  const guardedOwners = lookupOwners(runtime.mutations);
  const failed = classifyStructuredGraphQLErrors(
    phase.errors,
    [...directOwners, ...guardedOwners],
    guardedOwners.length ? guardedOwners : directOwners,
    runtime.errors,
  );
  for (const entry of runtime.reads) {
    if (!failed.has(entry.key)) collectAlias(entry, phase.raw, [], runtime.data, runtime.errors);
  }
  applyIndependentLookups(runtime.mutations, phase.raw, [], runtime.errors);
  return { requests: 1, failed: phase.errors.length > 0 };
}

function finishBatch(
  runtime: BatchRuntime,
  skipped: string[],
  requests: { read: number; mutation: number },
): Promise<JsonObject> {
  return envelope(
    runtime.requestedKeys,
    runtime.data,
    runtime.errors,
    skipped,
    requests,
    runtime.aliasCount,
    runtime.params.sink,
    runtime.secrets,
    runtime.network.telemetry,
    runtime.params.telemetryMode,
  );
}

function readFailureSkipped(runtime: BatchRuntime): string[] {
  const failedKeys = new Set(runtime.errors.map(({ key }) => key));
  return runtime.mutations.filter((entry) => !failedKeys.has(entry.key)).map((entry) => entry.key);
}

function stampCreatePlan(entry: PlannedEntry): TransactionalCreatePlan & { input: CompatibilityObject } {
  const input = entry.prepared?.variables.input;
  if (!isCompatibilityObject(input)) {
    throw new Error(`Batch entry "${entry.key}" is missing a prepared create input.`);
  }
  const uuid = randomUUID();
  return {
    key: entry.key,
    uuid,
    input: { ...input, id: uuid },
    view: entry.prepared?.resultView,
    variant: entry.variant,
  };
}

async function executeTransactionalBatch(
  runtime: BatchRuntime,
  mode: MutationMode,
  readRequests: number,
): Promise<JsonObject> {
  const stamped = runtime.mutations.map(stampCreatePlan);
  assertMutationAllowed(ISSUE_BATCH_CREATE_DOCUMENT, mode, ['issueBatchCreate']);
  const phase = await executeStructuredGraphQLPhase(
    runtime.network,
    ISSUE_BATCH_CREATE_DOCUMENT,
    { input: { issues: stamped.map((entry) => entry.input) } },
    'mutation',
  );
  const scoped = phase.errors.filter((error) => error.path[0] === 'issueBatchCreate'
    && error.path[1] === 'issues'
    && isPathNumber(error.path[2]!));
  const responseWide = phase.errors.filter((error) => !scoped.includes(error));
  if (responseWide.length) {
    const owners: GraphQLFailureOwner[] = runtime.mutations.map((entry) => ({ entry, aliases: ['issueBatchCreate'] }));
    classifyStructuredGraphQLErrors(responseWide, owners, owners, runtime.errors);
  } else {
    collectTransactionalCreates(stamped, phase.raw, scoped, runtime.data, runtime.errors);
  }
  return finishBatch(runtime, [], { read: readRequests, mutation: 1 });
}

function prepareSequentialMutations(mutations: readonly PlannedEntry[], mode: MutationMode): PreparedMutation[] {
  const prepared = mutations.map((mutation) => ({
    mutation,
    query: mergeDocuments(OperationTypeNode.MUTATION, 'BatchMutation', [parse(mutation.document)]),
  }));
  for (const { mutation, query } of prepared) assertMutationAllowed(query, mode, [mutation.root]);
  return prepared;
}

function remainingMutationKeys(prepared: readonly PreparedMutation[], index: number): string[] {
  return prepared.slice(index + 1).map(({ mutation }) => mutation.key);
}

function cancelledMutationError(mutation: PlannedEntry): BatchError {
  return {
    key: mutation.key,
    path: [mutation.key],
    message: 'Batch mutation phase was cancelled before this request was sent.',
  };
}

async function executeMutationRequest(
  runtime: BatchRuntime,
  prepared: PreparedMutation,
  signal: AbortSignal | undefined,
): Promise<{ phase: StructuredGraphQLPhase } | { error: BatchError }> {
  try {
    const phase = await executeStructuredGraphQLPhase(
      runtime.network,
      prepared.query,
      prepared.mutation.variables,
      'mutation',
      false,
    );
    return { phase };
  } catch (error) {
    const detail = error instanceof Error ? ` ${error.message}` : '';
    const outcome = signal?.aborted
      ? 'Batch mutation request was cancelled after it started.'
      : 'Batch mutation request failed after it started.';
    return {
      error: {
        key: prepared.mutation.key,
        path: [prepared.mutation.key],
        message: `${outcome} Its outcome is unknown because it may have reached Linear. Do not retry this mutation blindly.${detail}`,
      },
    };
  }
}

function verifiedMutationPartial(mutation: PlannedEntry, partial: JsonObject): JsonObject {
  try {
    assertPreparedAlias(mutation, partial);
    assertMutationAlias(mutation, partial);
    return batchEntryResult(mutation, partial);
  } catch {
    return partial;
  }
}

function mutationFailureOwner(mutation: PlannedEntry, raw: CompatibilityObject): GraphQLFailureOwner {
  const owner: GraphQLFailureOwner = {
    entry: mutation,
    aliases: [mutation.key],
    failureMessage: attributableFailureMessage(mutation),
  };
  const alias = raw[mutation.key];
  if (alias == null || mutation.prepared?.acknowledgement) return owner;
  const partial = { [mutation.root]: alias };
  owner.partial = verifiedMutationPartial(mutation, partial);
  return owner;
}

function collectMutationPhase(runtime: BatchRuntime, mutation: PlannedEntry, phase: StructuredGraphQLPhase): boolean {
  const before = runtime.errors.length;
  if (phase.errors.length) {
    const owner = mutationFailureOwner(mutation, phase.raw);
    classifyStructuredGraphQLErrors(phase.errors, [owner], [owner], runtime.errors);
  } else {
    collectAlias(mutation, phase.raw, [], runtime.data, runtime.errors);
  }
  return runtime.errors.length > before;
}

async function executeSequentialBatch(
  runtime: BatchRuntime,
  mode: MutationMode,
  signal: AbortSignal | undefined,
  readRequests: number,
): Promise<JsonObject> {
  const prepared = prepareSequentialMutations(runtime.mutations, mode);
  const skipped: string[] = [];
  let mutationRequests = 0;
  for (const [index, entry] of prepared.entries()) {
    if (signal?.aborted) {
      runtime.errors.push(cancelledMutationError(entry.mutation));
      skipped.push(...remainingMutationKeys(prepared, index));
      break;
    }
    mutationRequests += 1;
    const result = await executeMutationRequest(runtime, entry, signal);
    if ('error' in result) {
      runtime.errors.push(result.error);
      skipped.push(...remainingMutationKeys(prepared, index));
      break;
    }
    if (collectMutationPhase(runtime, entry.mutation, result.phase)) {
      skipped.push(...remainingMutationKeys(prepared, index));
      break;
    }
  }
  return finishBatch(runtime, skipped, { read: readRequests, mutation: mutationRequests });
}

async function createBatchRuntime(
  planned: PlannedBatch,
  params: BatchRequest,
  mode: MutationMode,
  ctx: ExtensionContext,
  signal: AbortSignal | undefined,
  telemetry: LinearRateLimitSnapshot[],
): Promise<BatchRuntime> {
  const call = linearCallContext(mode, signal, ctx, params);
  const network = await networkExecutionContext(call, fetch, telemetry);
  return {
    ...planned,
    params,
    network,
    requestedKeys: [...planned.reads, ...planned.mutations].map(({ key }) => key),
    data: {},
    errors: [],
    secrets: [...activeSecrets(), network.credential.apiKey],
    aliasCount: planned.reads.length + planned.mutations.length,
  };
}

async function executeBatchWithTelemetry(
  params: BatchRequest,
  mode: MutationMode,
  ctx: ExtensionContext,
  signal: AbortSignal | undefined,
  telemetry: LinearRateLimitSnapshot[],
): Promise<JsonObject> {
  const parsed = parseEntries(requireJsonObject(params.variables ?? {}, 'Batch variables'));
  const planned = await planBatch(parsed, mode);
  const runtime = await createBatchRuntime(planned, params, mode, ctx, signal, telemetry);
  const read = await executeReadPhase(runtime);
  if ((read.failed || runtime.errors.length) && runtime.mutations.length) {
    return finishBatch(runtime, readFailureSkipped(runtime), { read: read.requests, mutation: 0 });
  }
  if (runtime.transactional) return executeTransactionalBatch(runtime, mode, read.requests);
  return executeSequentialBatch(runtime, mode, signal, read.requests);
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
