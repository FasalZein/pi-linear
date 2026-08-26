import { StringEnum } from '@earendil-works/pi-ai';
import { defineTool } from '@earendil-works/pi-coding-agent';
import { Type, type TSchema } from 'typebox';
import { Compile } from 'typebox/compile';
import { Kind, parse, type FragmentDefinitionNode, type SelectionSetNode } from 'graphql';
import {
  DOMAINS,
  formatInvocation,
  getOperation,
  getOperationDefinition,
  operationDefinitions,
  operationsForDomain,
  parameterShapes,
  operations,
  type LinearOperation,
  type OperationDomain,
} from './operations';
import {
  assertOperationAllowed,
  executeRawQuery,
  linearCallContext,
  type JsonObject,
  type TelemetryMode,
} from './runtime';
import { activeSecrets } from './active-secrets';
import { redactDeep, redactError, redactText, withRedactedErrors } from './redact';
import {
  renderLinearApiCall,
  renderLinearApiResult,
  renderLinearBatchCall,
  renderLinearBatchResult,
  renderLinearGetResultCall,
  renderLinearGetResultResult,
  renderLinearGraphqlCall,
  renderLinearGraphqlResult,
} from './renderers';
import { typedToolName } from './tool-names';
import { LINEAR_BATCH_HELP, LINEAR_GRAPHQL_HELP, exceptionalToolDefinitions } from './exceptional-tools';
import type { MutationMode } from './safety';
import { LINEAR_TOOL_DESCRIPTION } from './generated/operation-catalog';
import { executeBatch } from './batch';
import {
  GET_RESULT_HELP,
  childPointer,
  getResult,
  resultChildPointerRepresentable,
  resultPointerRepresentable,
} from './result-handles';

export {
  NODE_CAP,
  RESULT_BUDGET,
  STRING_CAP,
  compactLinearResult,
  routeLinearResult,
} from './runtime';

const REQUEST_SHAPES = 'Invalid request. Send exactly one of: { "operation": "get_issue", "variables": { "issue": "AEO-258" } }, { "operation": "help" }, or { "query": "query { viewer { id } }", "variables": {} }.';
const HELP_SHAPES = 'Send exactly one of: { "operation": "help" }, { "operation": "help", "variables": { "domain": "issues" } }, or { "operation": "help", "variables": { "operation": "get_issue" } }.';
const NATURAL_SEARCH_REMOVED = 'Natural search was removed. The operation catalog is in the `linear` tool description. Send `{ "operation": "help", "variables": { "operation": "get_issue" } }` for exact parameters and to load `linear_get_issue`.';
const definitionDomainSet = new Set(operationDefinitions.map(({ domain }) => domain));
const DEFINITION_DOMAINS = DOMAINS.filter((domain) => definitionDomainSet.has(domain));

function canonicalFieldList(operation: LinearOperation): string {
  return Object.keys(operation.canonical.fields).join(', ');
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
        `Invalid parameters for "${operation.name}": ${message}. Valid parameters: canonical fields ${canonicalFieldList(operation)}. Example: ${formatInvocation(operation.example)}.`,
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
    `Invalid parameters for "${operation.name}": ${problems}. Valid parameters: canonical fields ${canonicalFieldList(operation)}. Example: ${formatInvocation(operation.example)}.`,
  );
}

export function resolveRequest(params: {
  operation?: string;
  query?: string;
  variables?: Record<string, unknown>;
}, mode: MutationMode = 'allowlist'): { query: string; named: false } | { query: string; named: true; operation: LinearOperation } {
  try {
    if (Boolean(params.operation) === Boolean(params.query)) throw new Error(REQUEST_SHAPES);
    if (!params.operation) return { query: params.query!, named: false };

    const operation = getOperation(params.operation);
    assertOperationAllowed(operation, params.variables ?? {}, mode);
    validateVariables(operation, params.operation, params.variables ?? {});
    return { query: operation.document, named: true, operation };
  } catch (error) {
    throw redactError(error, activeSecrets());
  }
}

/**
 * Activates the typed tools that match a help request. Returns the tool names that
 * became newly available, so the model sees the schemas on the next turn.
 */
export type ToolActivator = (toolNames: string[]) => string[];

function activate(activator: ToolActivator | undefined, toolNames: string[]): JsonObject {
  if (!activator) return {};
  const added = activator(toolNames);
  return added.length ? { loadedTools: added } : {};
}

export function helpResult(variables: Record<string, unknown> = {}, activator?: ToolActivator): JsonObject {
  const keys = Object.keys(variables);
  if (!keys.length) {
    return {
      domains: DEFINITION_DOMAINS,
      domainHelp: { operation: 'help', variables: { domain: 'issues' } },
      operationHelp: { operation: 'help', variables: { operation: 'get_issue' } },
      graphqlHelp: { operation: 'help', variables: { operation: 'graphql' } },
      batchHelp: { operation: 'help', variables: { operation: 'batch' } },
      resultHelp: { operation: 'help', variables: { operation: 'get_result' } },
    };
  }

  if ('query' in variables || 'search' in variables) {
    throw new Error(NATURAL_SEARCH_REMOVED);
  }

  const domain = variables.domain;
  const operationName = variables.operation;
  if (keys.length !== 1) throw new Error(`Invalid help request. ${HELP_SHAPES}`);
  if (typeof domain === 'string' && DEFINITION_DOMAINS.includes(domain as OperationDomain)) {
    return {
      domain,
      operations: operationsForDomain(domain as OperationDomain).map(({ name }) => ({ name })),
    };
  }
  if (typeof operationName === 'string') {
    if (operationName === 'graphql') return { ...activate(activator, ['linear_graphql']), ...LINEAR_GRAPHQL_HELP };
    if (operationName === 'batch') return { ...activate(activator, ['linear_batch']), ...LINEAR_BATCH_HELP };
    if (operationName === 'get_result') return GET_RESULT_HELP;
    let operation: LinearOperation;
    try {
      operation = getOperation(operationName);
    } catch {
      const redactedName = redactText(operationName, activeSecrets());
      const failedName = redactedName === operationName ? ` "${operationName}"` : '';
      throw new Error(
        `Unknown Linear operation${failedName}. Check the catalog, then send `
        + '`{ "operation": "help", "variables": { "operation": "<canonical_name>" } }`.',
      );
    }
    const canonical = operation.canonical;
    const alwaysRequired = new Set(
      canonical.branches.length
        ? canonical.branches.reduce<string[]>((shared, branch) => shared.filter((field) => branch.includes(field)), [...canonical.branches[0]!])
        : [],
    );
    return {
      ...activate(activator, [typedToolName(operation.name)]),
      name: operation.name,
      domain: operation.domain,
      purpose: operation.purpose,
      parameters: Object.entries(canonical.fields).map(([name, type]) => ({ name, type, required: alwaysRequired.has(name) })),
      requirements: canonical.branches,
      ...(operation.pagination ? { pagination: { defaultPageSize: operation.pagination.defaultPageSize } } : {}),
      example: getOperationDefinition(operation.name).canonical.example,
    };
  }
  throw new Error(`Invalid help request. ${HELP_SHAPES}`);
}

function telemetryMode(value: unknown): TelemetryMode | undefined {
  if (value === undefined) return undefined;
  if (value === 'always') return value;
  throw new Error('Invalid telemetry override. Use "always" or omit telemetry.');
}

function toolResult(details: JsonObject, secrets: readonly string[] = []) {
  const redacted = redactDeep(details, secrets);
  return { content: [{ type: 'text' as const, text: JSON.stringify(redacted) }], details: redacted };
}

async function retrieveResult(variables: unknown, secrets: readonly string[]) {
  return toolResult(await getResult(variables), secrets);
}

function directSchemaGuard(toolName: string, schema: TSchema) {
  let validator: ReturnType<typeof Compile> | undefined;
  return (params: unknown): void => {
    validator ??= Compile(schema);
    if (validator.Check(params)) return;
    const problems = [...validator.Errors(params)]
      .slice(0, 3)
      .map((error) => {
        const path = 'path' in error && typeof error.path === 'string' ? error.path : '';
        return path ? `${path}: ${error.message}` : error.message;
      })
      .join('; ');
    throw new Error(`Invalid arguments for "${toolName}": ${problems}.`);
  };
}

export function linearGetResultTool(definition = exceptionalToolDefinitions[0]) {
  if (definition.renderer !== 'linearGetResult') {
    throw new Error(`Linear tool configuration error: unknown exceptional renderer ${definition.renderer}.`);
  }
  const assertSchema = directSchemaGuard(definition.name, definition.parameters);
  return defineTool({
    name: definition.name,
    label: 'Linear get result',
    description: definition.purpose,
    parameters: definition.parameters,
    prepareArguments: (args: unknown) => {
      try {
        assertSchema(args);
        return args as any;
      } catch (error) {
        throw redactError(error, activeSecrets());
      }
    },
    renderCall: renderLinearGetResultCall,
    renderResult: renderLinearGetResultResult,
    async execute(_toolCallId, params, signal) {
      if (signal?.aborted) throw new Error('Request cancelled.');
      try {
        assertSchema(params);
      } catch (error) {
        throw redactError(error, activeSecrets());
      }
      const secrets = [...activeSecrets()];
      return withRedactedErrors(() => retrieveResult(params, secrets), secrets);
    },
  });
}

function assertRawResultPointersRepresentable(query: string): void {
  const document = parse(query);
  const fragments = new Map(document.definitions
    .filter((definition): definition is FragmentDefinitionNode => definition.kind === Kind.FRAGMENT_DEFINITION)
    .map((fragment) => [fragment.name.value, fragment]));

  const walk = (selectionSet: SelectionSetNode, parent: string, stack: ReadonlySet<string>): void => {
    for (const selection of selectionSet.selections) {
      if (selection.kind === Kind.FIELD) {
        const child = childPointer(parent, selection.alias?.value ?? selection.name.value);
        if (!resultPointerRepresentable(child) || !resultChildPointerRepresentable(parent, child)) {
          throw new Error('Raw GraphQL response alias cannot be represented within the tool output boundary.');
        }
        if (selection.selectionSet) walk(selection.selectionSet, child, stack);
      } else if (selection.kind === Kind.INLINE_FRAGMENT) {
        walk(selection.selectionSet, parent, stack);
      } else if (!stack.has(selection.name.value)) {
        const fragment = fragments.get(selection.name.value);
        if (fragment) walk(fragment.selectionSet, parent, new Set([...stack, selection.name.value]));
      }
    }
  };

  for (const definition of document.definitions) {
    if (definition.kind === Kind.OPERATION_DEFINITION) walk(definition.selectionSet, '/data', new Set());
  }
}

async function executeRawGraphql(
  query: string,
  variables: JsonObject,
  call: ReturnType<typeof linearCallContext>,
): Promise<JsonObject> {
  assertRawResultPointersRepresentable(query);
  return executeRawQuery(query, variables, call);
}

export function linearGraphqlTool(
  mode: MutationMode = 'allowlist',
  definition = exceptionalToolDefinitions[1],
) {
  if (definition.renderer !== 'linearGraphql') {
    throw new Error(`Linear tool configuration error: unknown exceptional renderer ${definition.renderer}.`);
  }
  const assertSchema = directSchemaGuard(definition.name, definition.parameters);
  return defineTool({
    name: definition.name,
    label: 'Linear GraphQL',
    description: definition.purpose,
    parameters: definition.parameters,
    prepareArguments: (args: unknown) => {
      try {
        assertSchema(args);
        return args as any;
      } catch (error) {
        throw redactError(error, activeSecrets());
      }
    },
    renderCall: renderLinearGraphqlCall,
    renderResult: renderLinearGraphqlResult,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) throw new Error('Request cancelled.');
      try {
        assertSchema(params);
      } catch (error) {
        throw redactError(error, activeSecrets());
      }
      const secrets = [...activeSecrets()];
      return withRedactedErrors(async () => {
        const call = linearCallContext(mode, signal, ctx, {
          workspace: params.workspace,
          sink: params.sink,
          telemetryMode: telemetryMode(params.telemetry),
        });
        return toolResult(await executeRawGraphql(params.query, params.variables ?? {}, call), secrets);
      }, secrets);
    },
  });
}

export function linearBatchTool(
  mode: MutationMode = 'allowlist',
  definition = exceptionalToolDefinitions[2],
) {
  if (definition.renderer !== 'linearBatch') {
    throw new Error(`Linear tool configuration error: unknown exceptional renderer ${definition.renderer}.`);
  }
  const assertSchema = directSchemaGuard(definition.name, definition.parameters);
  return defineTool({
    name: definition.name,
    label: 'Linear batch',
    description: definition.purpose,
    parameters: definition.parameters,
    prepareArguments: (args: unknown) => {
      try {
        assertSchema(args);
        return args as any;
      } catch (error) {
        throw redactError(error, activeSecrets());
      }
    },
    renderCall: renderLinearBatchCall,
    renderResult: renderLinearBatchResult,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) throw new Error('Request cancelled.');
      try {
        assertSchema(params);
      } catch (error) {
        throw redactError(error, activeSecrets());
      }
      const secrets = [...activeSecrets()];
      return withRedactedErrors(async () => toolResult(await executeBatch(
        {
          variables: {
            ...('operations' in params ? { operations: params.operations } : {}),
            ...('reads' in params ? { reads: params.reads } : {}),
            ...('mutations' in params ? { mutations: params.mutations } : {}),
          },
          workspace: params.workspace,
          sink: params.sink,
          telemetryMode: telemetryMode(params.telemetry),
        },
        mode,
        ctx,
        signal,
      ), secrets), secrets);
    },
  });
}

function removedLoaderRouteError(params: unknown): Error | undefined {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return undefined;
  const request = params as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(request, 'query')) {
    return new Error('Raw GraphQL cannot run through linear. Call linear_graphql with direct arguments.');
  }
  if (request.operation === 'batch') {
    return new Error('Batch execution cannot run through linear. Call linear_batch with direct arguments.');
  }
  if (request.operation === 'get_result') {
    return new Error('Result retrieval cannot run through linear. Call linear_get_result with direct arguments.');
  }
  if (request.operation === 'help' || request.operation === undefined) return undefined;
  if (typeof request.operation === 'string') {
    try {
      const toolName = typedToolName(getOperation(request.operation).name);
      return new Error(`Named operations cannot run through linear. Call ${toolName} with direct arguments.`);
    } catch {
      return new Error('The linear tool accepts discovery help only. Send { "operation": "help" }.');
    }
  }
  return undefined;
}

export function linearApiTool(_mode: MutationMode = 'allowlist', activator?: ToolActivator) {
  const parameters = Type.Object({
    operation: Type.Literal('help', { description: 'Discover operations and activate an exact direct tool.' }),
    variables: Type.Optional(Type.Union([
      Type.Object({ domain: StringEnum(DEFINITION_DOMAINS) }, { additionalProperties: false }),
      Type.Object({ operation: Type.String() }, { additionalProperties: false }),
    ])),
  }, { additionalProperties: false });
  const assertSchema = directSchemaGuard('linear', parameters);
  const assertArguments = (params: unknown) => {
    const compatibilityError = removedLoaderRouteError(params);
    if (compatibilityError) throw compatibilityError;
    assertSchema(params);
  };

  return defineTool({
    name: 'linear',
    label: 'Linear',
    description: LINEAR_TOOL_DESCRIPTION,
    parameters,
    prepareArguments: (args: unknown) => {
      assertArguments(args);
      return args as any;
    },
    renderCall: renderLinearApiCall,
    renderResult: renderLinearApiResult,
    async execute(_toolCallId, params, signal) {
      if (signal?.aborted) throw new Error('Request cancelled.');
      assertArguments(params);
      return toolResult(helpResult(params.variables, activator));
    },
  });
}
