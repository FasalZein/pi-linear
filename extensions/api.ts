import { StringEnum } from '@earendil-works/pi-ai';
import { defineTool } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { Kind, parse, type FragmentDefinitionNode, type SelectionSetNode } from 'graphql';
import { linearGraphQL, linearGraphQLErrors, linearRateLimitTelemetry } from './client';
import {
  DOMAINS,
  formatInvocation,
  getOperation,
  operationDefinitions,
  operationSignature,
  operationsForDomain,
  parameterShapes,
  operations,
  type LinearOperation,
  type OperationDomain,
} from './operations';
import {
  apiKeyForWorkspace,
  assertOperationAllowed,
  executeOperation,
  routeLinearResult,
  NODE_CAP,
  type JsonObject,
  type TelemetryMode,
} from './runtime';
import { activeSecrets } from './active-secrets';
import { redactDeep, redactError, withRedactedErrors } from './redact';
import { renderLinearApiCall, renderLinearApiResult } from './renderers';
import { typedToolName } from './tool-names';
import { assertMutationAllowed, type MutationMode } from './safety';
import { LINEAR_TOOL_DESCRIPTION } from './generated/operation-catalog';
import { batchHelp, executeBatch } from './batch';
import {
  GET_RESULT_HELP,
  childPointer,
  getResult,
  resultChildPointerRepresentable,
  resultPointerRepresentable,
} from './result-handles';

export {
  AUTO_SPILL_BYTES,
  NODE_CAP,
  RESULT_BUDGET,
  STRING_CAP,
  compactLinearResult,
  routeLinearResult,
} from './runtime';

const REQUEST_SHAPES = 'Invalid request. Send exactly one of: { "operation": "get_issue", "variables": { "issue": "AEO-258" } }, { "operation": "help" }, or { "query": "query { viewer { id } }", "variables": {} }.';
const HELP_SHAPES = 'Send exactly one of: { "operation": "help" }, { "operation": "help", "variables": { "domain": "issues" } }, or { "operation": "help", "variables": { "operation": "get_issue" } }.';
const NATURAL_SEARCH_REMOVED = 'Natural search was removed. The operation catalog is in the `linear` tool description. Send `{ "operation": "help", "variables": { "operation": "get_issue" } }` for exact parameters, or call the operation directly.';
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

function activate(activator: ToolActivator | undefined, operationNames: string[]): JsonObject {
  if (!activator) return {};
  const added = activator(operationNames.map(typedToolName));
  return added.length ? { loadedTools: added } : {};
}

export function helpResult(variables: Record<string, unknown> = {}, activator?: ToolActivator): JsonObject {
  const keys = Object.keys(variables);
  if (!keys.length) {
    return {
      domains: DEFINITION_DOMAINS,
      domainHelp: { operation: 'help', variables: { domain: 'issues' } },
      operationHelp: { operation: 'help', variables: { operation: 'get_issue' } },
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
      operations: operationsForDomain(domain as OperationDomain).map((operation) => ({
        name: operation.name,
        signature: operationSignature(operation),
      })),
    };
  }
  if (typeof operationName === 'string') {
    if (operationName === 'batch') return batchHelp();
    if (operationName === 'get_result') return GET_RESULT_HELP;
    const operation = getOperation(operationName);
    const canonical = operation.canonical;
    const alwaysRequired = new Set(
      canonical.branches.length
        ? canonical.branches.reduce<string[]>((shared, branch) => shared.filter((field) => branch.includes(field)), [...canonical.branches[0]!])
        : [],
    );
    return {
      ...activate(activator, [operation.name]),
      name: operation.name,
      domain: operation.domain,
      purpose: operation.purpose,
      parameters: Object.entries(canonical.fields).map(([name, type]) => ({ name, type, required: alwaysRequired.has(name) })),
      requirements: canonical.branches,
      example: operation.example,
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

export function linearApiTool(mode: MutationMode = 'allowlist', activator?: ToolActivator) {
  return defineTool({
    name: 'linear',
    label: 'Linear API',
    description: LINEAR_TOOL_DESCRIPTION,
    parameters: Type.Object({
      operation: Type.Optional(Type.String({ description: 'Bundled operation name.' })),
      query: Type.Optional(Type.String({ description: 'Raw GraphQL escape hatch.' })),
      variables: Type.Optional(Type.Record(Type.String(), Type.Any())),
      workspace: Type.Optional(Type.String({ description: 'Stored workspace name, or default/active for normal credential selection.' })),
      sink: Type.Optional(StringEnum(
        ['inline', 'artifact'] as const,
        { description: 'Choose inline output or an artifact file.' },
      )),
      telemetry: Type.Optional(StringEnum(
        ['always'] as const,
        { description: 'Explicitly include rate-limit diagnostics.' },
      )),
    }),
    renderCall: renderLinearApiCall,
    renderResult: renderLinearApiResult,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const explicitTelemetry = telemetryMode(params.telemetry);
      // Collected before any output path, including the help early return: an active key
      // in an unknown format is only removable as an exact value.
      const secrets: string[] = [...activeSecrets()];
      return withRedactedErrors(async () => {
        if (signal?.aborted) throw new Error('Request cancelled.');
        if (params.operation === 'help' && !params.query) {
          return toolResult(helpResult(params.variables, activator), secrets);
        }
        if (params.operation === 'batch' && !params.query) {
          return toolResult(await executeBatch(
            {
              variables: params.variables,
              workspace: params.workspace,
              sink: params.sink,
              telemetryMode: explicitTelemetry,
            },
            mode,
            ctx,
            signal,
          ), secrets);
        }
        if (params.operation === 'get_result' && !params.query) {
          if (params.sink !== undefined) throw new Error('get_result does not accept sink.');
          if (params.workspace !== undefined) throw new Error('get_result does not accept workspace.');
          return toolResult(await getResult(params.variables), secrets);
        }

        const request = resolveRequest(params, mode);
        if (request.named) {
          return toolResult(await executeOperation(
            request.operation,
            {
              variables: params.variables ?? {},
              workspace: params.workspace,
              sink: params.sink,
              telemetryMode: explicitTelemetry,
            },
            mode,
            ctx,
            signal,
          ), secrets);
        }

        assertRawResultPointersRepresentable(request.query);
        assertMutationAllowed(request.query, mode);
        const apiKey = await apiKeyForWorkspace(ctx, params.workspace);
        secrets.push(apiKey);
        const data = await linearGraphQL<JsonObject>(apiKey, request.query, params.variables ?? {}, signal);
        const errors = linearGraphQLErrors(data);
        return toolResult(await routeLinearResult(data, {
          label: 'query',
          category: 'composite',
          sink: params.sink,
          nodeCap: NODE_CAP,
          secrets,
          errors,
          telemetry: linearRateLimitTelemetry(data),
          telemetryMode: explicitTelemetry,
        }), secrets);
      }, secrets);
    },
  });
}
