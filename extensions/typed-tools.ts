import { defineTool, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { TSchema } from 'typebox';
import { Compile } from 'typebox/compile';
import { operationDefinitions, operations, type LinearOperation } from './operations';
import { canonicalFieldNames, canonicalOperation } from './canonical';
import {
  assertOperationAllowed,
  executeOperationInContext,
  linearCallContext,
  type JsonObject,
} from './runtime';
import { activeSecrets } from './active-secrets';
import { redactError } from './redact';
import { operationRenderers } from './renderers';
import { typedToolName } from './tool-names';
import { parseJsonObject } from './json';
import { withRecovery } from './failure-message';
import type { MutationMode } from './safety';
import { buildTypedToolMetadata, requirementBranches } from './typed-tool-metadata';

export { typedToolName, typedToolOperationName } from './tool-names';
export { canonicalFieldNames } from './canonical';
export { buildTypedToolMetadata, parameterSchema, requirementBranches } from './typed-tool-metadata';

function branchList(operation: LinearOperation): string {
  return requirementBranches(operation)
    .map((branch) => (branch.length ? `{ ${branch.join(', ')} }` : '{ }'))
    .join(' or ');
}

/**
 * Same gate as the schema, restated where an actionable message can be produced and
 * where it cannot depend on a validator keyword. Rejects nothing the schema accepts.
 */
function assertBranch(operation: LinearOperation, variables: JsonObject): void {
  const branches = requirementBranches(operation);
  const satisfied = branches.filter((branch) => branch.every((name) => variables[name] !== undefined));
  if (canonicalOperation(operation).exclusiveBranches ? satisfied.length === 1 : satisfied.length > 0) return;
  throw new Error(
    `Invalid parameters for "${typedToolName(operation.name)}": supply ${branchList(operation)}.`,
  );
}

/**
 * The canonical contract publishes one name per concept, so no two accepted fields can
 * describe the same entity. This restates that invariant at the execution boundary: a
 * compatibility alias reaching a typed tool is refused before credential lookup.
 */
function assertCanonicalOnly(operation: LinearOperation, variables: JsonObject): void {
  const allowed = new Set(canonicalFieldNames(operation));
  const foreign = Object.keys(variables).filter((key) => !allowed.has(key));
  if (foreign.length) {
    throw new Error(
      `Unknown parameters for "${typedToolName(operation.name)}": ${foreign.join(', ')}. `
      + `Accepted parameters: ${[...allowed].join(', ')}. Legacy aliases and raw input go through linear.`
      + (foreign.includes('workspace')
        ? ' Typed tools have no workspace parameter: the active workspace is used. Change it with /linear-auth switch.'
        : ''),
    );
  }
}

/**
 * Enforce the create/update field partition that the published schema no longer carries.
 *
 * A caller supplying the update identity is updating; anything else is creating. Naming
 * the mode, the offending field, and that mode's accepted fields tells the caller what to
 * change — which a `oneOf` rejection never did.
 */
function assertVariant(operation: LinearOperation, variables: JsonObject): void {
  const { variants } = canonicalOperation(operation);
  if (!variants) return;
  const [create, update] = variants;
  const supplied = Object.keys(variables).filter((name) => variables[name] !== undefined);
  const identity = update.branches[0]![0]!;
  const updating = supplied.includes(identity);
  const variant = updating ? update : create;
  const mode = updating ? 'update' : 'create';
  const toolName = typedToolName(operation.name);

  const foreign = supplied.filter((name) => !variant.fields.includes(name));
  if (foreign.length) {
    throw new Error(
      `"${toolName}" is in ${mode} mode because ${updating ? `${identity} was supplied` : `${identity} was omitted`}, `
      + `and ${mode} does not accept: ${foreign.join(', ')}. `
      + `${mode} accepts: ${variant.fields.join(', ')}.`,
    );
  }
  if (variant.branches.some((branch) => branch.every((name) => supplied.includes(name)))) return;
  // Update branches are the identity paired with each changeable field, so listing all 31
  // of them for save_project would bury the point. State the shape instead.
  const pairedWithIdentity = variant.branches.length > 1
    && variant.branches.every((branch) => branch.length === 2 && branch[0] === variant.branches[0]![0]);
  const required = pairedWithIdentity
    ? `${variant.branches[0]![0]} plus at least one field to change`
    : variant.branches.map((branch) => `{ ${branch.join(', ')} }`).join(' or ');
  throw new Error(`"${toolName}" in ${mode} mode requires ${required}.`);
}

/** Attach the recovery sentence to the failure itself. See extensions/failure-message.ts. */
function guidedError(cause: unknown, guidance: (message: string) => string): Error {
  // Extend the redacted error in place. A replacement Error would drop the properties
  // carried on it, including `linearTelemetry`, which callers read after a failure.
  const redacted = redactError(cause, activeSecrets());
  redacted.message = withRecovery(redacted.message, guidance(redacted.message));
  return redacted;
}

/**
 * Strict, non-converting check against the published schema, compiled lazily.
 *
 * Pi validates with `Value.Convert` first, which coerces raw scalars — `123` becomes
 * `"123"`, `"true"` becomes `true`. A typed Linear call must mean exactly what it says,
 * so the same schema is checked without conversion. The check never rewrites, drops,
 * normalizes, or reorders a field; it only accepts or rejects.
 */
function schemaGuard(operation: LinearOperation, schema: TSchema) {
  let validator: ReturnType<typeof Compile> | undefined;
  return (cause: unknown): void => {
    validator ??= Compile(schema);
    if (validator.Check(cause)) return;
    const problems = [...validator.Errors(cause)]
      .slice(0, 3)
      .map((error) => {
        const path = 'path' in error ? String(error.path) : '';
        return path ? `${path}: ${error.message}` : error.message;
      })
      .join('; ');
    throw new Error(`Invalid arguments for "${typedToolName(operation.name)}": ${problems}.`);
  };
}

function typedTool(operation: LinearOperation, mode: MutationMode) {
  const renderers = operationRenderers(operation);
  const guided = (cause: unknown): Error => guidedError(cause, renderers.guidance);
  const metadata = buildTypedToolMetadata(operation);
  const assertSchema = schemaGuard(operation, metadata.parameters);
  return defineTool({
    ...metadata,
    /**
     * `prepareArguments` is the only hook that runs before Pi's converting validation.
     * It applies the shared operation policy, then checks the raw arguments against the
     * published schema and returns the same object without changing any field.
     */
    prepareArguments: (args) => {
      try {
        const variables = parseJsonObject(args) ?? {};
        assertOperationAllowed(operation, variables, mode);
        // Runs before the schema check so a stray `workspace` gets the actionable message
        // rather than a bare additionalProperties rejection.
        assertCanonicalOnly(operation, variables);
        assertVariant(operation, variables);
        assertSchema(args);
        return args;
      } catch (error) {
        throw guided(error);
      }
    },
    renderCall: renderers.renderCall,
    renderResult: renderers.renderResult,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) throw new Error('Request cancelled.');
      const variables = parseJsonObject(params) ?? {};
      try {
        assertOperationAllowed(operation, variables, mode);
        assertCanonicalOnly(operation, variables);
        assertVariant(operation, variables);
        assertBranch(operation, variables);
        assertSchema(params);
        operation.validateVariables?.(variables);
      } catch (error) {
        throw guided(error);
      }
      // Typed tools always use the active workspace; only linear_graphql and linear_batch
      // select one explicitly.
      const call = linearCallContext(mode, signal, ctx, {});
      try {
        const details = await executeOperationInContext(operation, { variables }, call);
        return { content: [{ type: 'text' as const, text: JSON.stringify(details) }], details };
      } catch (error) {
        throw guided(error);
      }
    },
  });
}

/**
 * The 48 upstream-named typed tools, one per catalog operation. Registration is
 * always-on; activation is not (see extensions/index.ts).
 */
export function typedLinearTools(mode: MutationMode = 'allowlist'): ToolDefinition<any, any, any>[] {
  return operationDefinitions.map(({ name }) => typedTool(operations[name]!, mode));
}

export function typedToolNames(): string[] {
  return operationDefinitions.map(({ toolName }) => toolName);
}
