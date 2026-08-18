import { StringEnum } from '@earendil-works/pi-ai';
import { defineTool } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { linearGraphQL } from './client';
import {
  DOMAINS,
  formatInvocation,
  getOperation,
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
} from './runtime';
import { candidateSummary, planActivation } from './activation';
import { withRedactedErrors } from './redact';
import { renderLinearApiCall, renderLinearApiResult } from './renderers';
import { typedToolName } from './tool-names';
import { assertMutationAllowed, type MutationMode } from './safety';

export {
  AUTO_SPILL_BYTES,
  NODE_CAP,
  RESULT_BUDGET,
  STRING_CAP,
  compactLinearResult,
  routeLinearResult,
} from './runtime';

const REQUEST_SHAPES = 'Invalid request. Send exactly one of: { "operation": "get_issue", "variables": { "issue": "AEO-258" } }, { "operation": "help" }, or { "query": "query { viewer { id } }", "variables": {} }.';
const HELP_SHAPES = 'Send exactly one of: { "operation": "help" }, { "operation": "help", "variables": { "domain": "issues" } }, or { "operation": "help", "variables": { "operation": "get_issue" } }. For natural search, send exactly one of: { "operation": "help", "variables": { "query": "issue lookup by identifier" } } or { "operation": "help", "variables": { "search": "comment issue create comment" } }.';

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
  const validShape = !operation.requiresVariables || Object.keys(variables).length > 0
    ? shapes.find((shape) => {
      const shapeKeys = new Set(shape.map(({ name }) => name));
      return shape.every(({ name, required }) => !required || name in variables)
        && Object.keys(variables).every((name) => shapeKeys.has(name));
    })
    : undefined;
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

export function resolveRequest(params: {
  operation?: string;
  query?: string;
  variables?: Record<string, unknown>;
}, mode: MutationMode = 'allowlist'): { query: string; named: false } | { query: string; named: true; operation: LinearOperation } {
  if (Boolean(params.operation) === Boolean(params.query)) throw new Error(REQUEST_SHAPES);
  if (!params.operation) return { query: params.query!, named: false };

  const operation = getOperation(params.operation);
  assertOperationAllowed(operation, params.variables ?? {}, mode);
  validateVariables(operation, params.operation, params.variables ?? {});
  return { query: operation.document, named: true, operation };
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

/**
 * Natural help resolves clauses deterministically (see activation.ts): each clause
 * that names exactly one operation activates that operation, in clause order. A
 * request that resolves nothing activates nothing and returns ranked candidates.
 */
function naturalHelp(search: string, activator?: ToolActivator): JsonObject {
  const plan = planActivation(search);
  const resolved = plan.operationNames.map((name) => getOperation(name));
  const best = resolved[0];

  return {
    ...activate(activator, plan.operationNames),
    query: search,
    ...(best
      ? {
        match: {
          name: best.name,
          domain: best.domain,
          purpose: best.purpose,
          signature: operationSignature(best),
          parameters: best.parameters,
          invocation: best.example,
        },
        alternatives: resolved.slice(1).map(candidateSummary),
      }
      : {
        match: undefined,
        note: 'No clause named exactly one operation, so no tool was loaded. Ask for one operation by name, or use one of these candidates.',
        candidates: plan.candidates.map(candidateSummary),
      }),
  };
}

export function helpResult(variables: Record<string, unknown> = {}, activator?: ToolActivator): JsonObject {
  const keys = Object.keys(variables);
  if (!keys.length) {
    return {
      domains: DOMAINS,
      domainHelp: { operation: 'help', variables: { domain: 'issues' } },
      operationHelp: { operation: 'help', variables: { operation: 'get_issue' } },
    };
  }

  const domain = variables.domain;
  const operationName = variables.operation;
  const naturalKeys = keys.filter((key) => key === 'query' || key === 'search');
  const schemaKeys = keys.filter((key) => key === 'includeSchema' || key === 'include_schema');
  const naturalQuery = variables.query ?? variables.search;
  const naturalMode = naturalKeys.length === 1
    && schemaKeys.length <= 1
    && keys.length === naturalKeys.length + schemaKeys.length
    && (schemaKeys.length === 0 || typeof variables[schemaKeys[0]!] === 'boolean');
  if (naturalMode && typeof naturalQuery === 'string' && naturalQuery.trim()) {
    return naturalHelp(naturalQuery.trim(), activator);
  }
  if (keys.length !== 1) throw new Error(`Invalid help request. ${HELP_SHAPES}`);
  if (typeof domain === 'string' && DOMAINS.includes(domain as OperationDomain)) {
    return {
      domain,
      operations: operationsForDomain(domain as OperationDomain).map((operation) => ({
        name: operation.name,
        signature: operationSignature(operation),
      })),
    };
  }
  if (typeof operationName === 'string') {
    const operation = getOperation(operationName);
    return {
      ...activate(activator, [operation.name]),
      name: operation.name,
      domain: operation.domain,
      purpose: operation.purpose,
      parameters: operation.parameters,
      example: operation.example,
    };
  }
  throw new Error(`Invalid help request. ${HELP_SHAPES}`);
}

function toolResult(details: JsonObject) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(details) }], details };
}

export function linearApiTool(mode: MutationMode = 'allowlist', activator?: ToolActivator) {
  return defineTool({
    name: 'linear_api',
    label: 'Linear API',
    description: 'Run a named Linear operation or raw GraphQL. Discover operations with { "operation": "help" }; help for one operation also loads its typed linear_* tool.',
    parameters: Type.Object({
      operation: Type.Optional(Type.String({ description: 'Bundled operation name.' })),
      query: Type.Optional(Type.String({ description: 'Raw GraphQL escape hatch.' })),
      variables: Type.Optional(Type.Record(Type.String(), Type.Any())),
      workspace: Type.Optional(Type.String({ description: 'Stored workspace name, or default/active for normal credential selection.' })),
      sink: Type.Optional(StringEnum(
        ['inline', 'artifact'] as const,
        { description: 'Choose inline output or an artifact file.' },
      )),
    }),
    renderCall: renderLinearApiCall,
    renderResult: renderLinearApiResult,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) throw new Error('Request cancelled.');
      if (params.operation === 'help' && !params.query) {
        return toolResult(helpResult(params.variables, activator));
      }

      const request = resolveRequest(params, mode);
      if (request.named) {
        return toolResult(await executeOperation(
          request.operation,
          { variables: params.variables ?? {}, workspace: params.workspace, sink: params.sink },
          mode,
          ctx,
          signal,
        ));
      }

      assertMutationAllowed(request.query, mode);
      const secrets: string[] = [];
      return toolResult(await withRedactedErrors(async () => {
        const apiKey = await apiKeyForWorkspace(ctx, params.workspace);
        secrets.push(apiKey);
        const data = await linearGraphQL<JsonObject>(apiKey, request.query, params.variables ?? {}, signal);
        return routeLinearResult(data, {
          label: 'query',
          sink: params.sink,
          nodeCap: NODE_CAP,
          secrets,
        });
      }, secrets));
    },
  });
}
