import { StringEnum } from '@earendil-works/pi-ai';
import { defineTool, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import { Type, type TSchema } from 'typebox';
import { Compile } from 'typebox/compile';
import { formatInvocation, operations, type LinearOperation } from './operations';
import { canonicalFieldNames, canonicalOperation } from './canonical';
import { executeOperation, type JsonObject } from './runtime';
import { operationRenderers } from './renderers';
import { typedToolName } from './tool-names';
import type { MutationMode } from './safety';

export { typedToolName, typedToolOperationName } from './tool-names';
export { canonicalFieldNames } from './canonical';

const REFERENCE_HINTS: Record<string, string> = {
  IssueReference: 'Issue identifier such as ABC-123, or an issue UUID.',
  TeamReference: 'Team key such as ABC, exact team name, or a team UUID.',
  StateReference: 'Workflow state name, or a state UUID.',
  UserReference: 'User email, exact name, display name, "me", or a user UUID.',
  ProjectReference: 'Exact project name, or a project UUID.',
  InitiativeReference: 'Exact initiative name, or an initiative UUID.',
  CycleReference: 'Exact cycle name, or a cycle UUID.',
  MilestoneReference: 'Exact milestone name, or a milestone UUID.',
  DocumentReference: 'Exact document title, or a document UUID.',
  DateTime: 'ISO 8601 date-time.',
  Date: 'Calendar date, YYYY-MM-DD.',
  PaginationOrderBy: 'createdAt or updatedAt.',
  WorkflowStateType: 'triage, backlog, unstarted, started, completed, or canceled.',
  IssueRelationType: 'blocks, duplicate, related, or similar.',
  Filter: 'Linear filter object for this entity; must name at least one field.',
  FilterData: 'Linear view filter object; must name at least one field.',
  Preferences: 'View preference object; must name at least one field.',
  Color: 'Hex color such as #ff0000.',
  UUID: 'Linear UUID.',
  '[UUID!]': 'One or more Linear UUIDs.',
  NullableDate: 'Calendar date YYYY-MM-DD, or null to clear it.',
  Priority: '0 none, 1 urgent, 2 high, 3 medium, 4 low.',
  '[ID!]': 'One or more UUIDs.',
  '[SortInput!]': 'Sort clauses, each { key, order }.',
  Float: 'Number.',
  JsonString: 'Serialized Linear document JSON.',
  Url: 'Absolute http(s) URL.',
  NullableDateTime: 'ISO 8601 date-time, or null to clear it.',
};

const UUID_PATTERN = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
const DATE_PATTERN = '^\\d{4}-\\d{2}-\\d{2}$';

/** The finite view preference contract, matching upstream 0.4.1. */
const PREFERENCES = Type.Object(
  {
    issueGrouping: Type.Optional(StringEnum(
      ['assignee', 'status', 'priority', 'cycle', 'project', 'labels', 'none'],
      { description: 'Primary grouping.' },
    )),
    issueSubGrouping: Type.Optional(StringEnum(
      ['assignee', 'status', 'priority', 'cycle', 'project', 'labels', 'none'],
      { description: 'Secondary grouping.' },
    )),
    showEmptyGroups: Type.Optional(Type.Boolean()),
    fieldEstimate: Type.Optional(Type.Boolean()),
    fieldPriority: Type.Optional(Type.Boolean()),
    fieldDueDate: Type.Optional(Type.Boolean()),
    fieldStatus: Type.Optional(Type.Boolean()),
    fieldProject: Type.Optional(Type.Boolean()),
    fieldAssignee: Type.Optional(Type.Boolean()),
    fieldLabels: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false, minProperties: 1 },
);

// Sort keys, enums, and reminder vocabularies are the upstream 0.4.1 closed sets.
const SORT_KEYS: Record<string, readonly string[]> = {
  '[IssueSort!]': [
    'priority', 'estimate', 'title', 'label', 'labelGroup', 'slaStatus', 'createdAt',
    'updatedAt', 'completedAt', 'dueDate', 'accumulatedStateUpdatedAt', 'cycle', 'milestone',
    'assignee', 'delegate', 'project', 'team', 'manual', 'workflowState', 'customer',
    'customerRevenue', 'customerCount', 'customerImportantCount', 'rootIssue', 'linkCount',
    'release',
  ],
  '[ProjectSort!]': [
    'name', 'status', 'priority', 'manual', 'targetDate', 'startDate', 'createdAt',
    'updatedAt', 'health', 'lead',
  ],
  '[InitiativeSort!]': [
    'name', 'manual', 'updatedAt', 'createdAt', 'targetDate', 'health', 'healthUpdatedAt',
    'owner', 'priority',
  ],
  '[UserSort!]': ['name', 'displayName'],
  '[DocumentSort!]': ['title', 'creator', 'project', 'createdAt', 'updatedAt'],
};

const ENUMS: Record<string, readonly string[]> = {
  SlaDayCountType: ['all', 'onlyBusinessDays'],
  DateResolutionType: ['month', 'quarter', 'halfYear', 'year'],
  FrequencyResolutionType: ['daily', 'weekly'],
  Day: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
  InitiativeStatus: ['Proposed', 'Planned', 'Active', 'Completed', 'Canceled'],
  IssueRelationType: ['blocks', 'duplicate', 'related', 'similar'],
  WorkflowStateType: ['triage', 'backlog', 'unstarted', 'started', 'completed', 'canceled'],
  PaginationOrderBy: ['createdAt', 'updatedAt'],
  IssueGrouping: ['assignee', 'status', 'priority', 'cycle', 'project', 'labels', 'none'],
};

const sortItem = (keys: readonly string[]) => Type.Object(
  {
    key: StringEnum(keys, { description: 'Sort key.' }),
    order: Type.Optional(StringEnum(['Ascending', 'Descending'])),
  },
  { additionalProperties: false },
);

const SORT_ITEM = Type.Object(
  {
    key: Type.String({ minLength: 1 }),
    order: Type.Optional(StringEnum(['Ascending', 'Descending'])),
  },
  { additionalProperties: false },
);

/**
 * Type token to schema. Object-valued parameters carry the strictest shape the
 * operation actually contracts: sort clauses are fully specified, and the filter and
 * preference objects must name at least one field, so an empty object cannot stand in
 * for a real request. Their inner field names stay open because Linear owns that
 * vocabulary and validates it server-side.
 */
function schemaFor(type: string): TSchema {
  const description = REFERENCE_HINTS[type];
  const options = description ? { description } : {};
  switch (type) {
    case 'Int':
      return Type.Integer(options);
    case 'Float':
      return Type.Number(options);
    case 'JsonString':
      return Type.String({ ...options, minLength: 1 });
    case 'Url':
      return Type.String({ ...options, minLength: 1, pattern: '^https?://' });
    case 'NullableDateTime':
      return Type.Union([Type.String({ minLength: 1 }), Type.Null()], options);
    case 'Priority':
      return Type.Integer({ ...options, minimum: 0, maximum: 4 });
    case 'Boolean':
      return Type.Boolean(options);
    case 'Color':
      return Type.String({ ...options, pattern: '^#[0-9a-fA-F]{6}$' });
    case 'Date':
      return Type.String({ ...options, pattern: DATE_PATTERN });
    case 'NullableDate':
      return Type.Union([Type.String({ pattern: DATE_PATTERN }), Type.Null()], options);
    case 'UUID':
      return Type.String({ ...options, pattern: UUID_PATTERN });
    case '[UUID!]':
      return Type.Array(Type.String({ pattern: UUID_PATTERN }), { ...options, minItems: 1 });
    case 'Preferences':
      return { ...PREFERENCES, ...options } as TSchema;
    case '[ID!]':
      return Type.Array(Type.String({ minLength: 1 }), { ...options, minItems: 1 });
    case '[SortInput!]':
      return Type.Array(SORT_ITEM, { ...options, minItems: 1 });
    case 'Filter':
    case 'FilterData':
      return Type.Record(Type.String(), Type.Any(), { ...options, minProperties: 1 });
    default:
      if (SORT_KEYS[type]) {
        return Type.Array(sortItem(SORT_KEYS[type]!), { ...options, minItems: 1 });
      }
      if (ENUMS[type]) return StringEnum(ENUMS[type]!, { description: description ?? `${type} value.` });
      return Type.String({ ...options, minLength: 1 });
  }
}

/** The required-parameter sets that describe every valid canonical call. */
export function requirementBranches(operation: LinearOperation): readonly (readonly string[])[] {
  return canonicalOperation(operation).branches;
}

const WORKSPACE = Type.Optional(
  Type.String({ minLength: 1, description: 'Stored workspace name. Omit for the active workspace.' }),
);

function objectSchema(
  fields: Record<string, string>,
  fieldNames: readonly string[],
  branches: readonly (readonly string[])[],
) {
  const properties: Record<string, TSchema> = Object.fromEntries(
    fieldNames.map((name) => [name, Type.Optional(schemaFor(fields[name]!))]),
  );
  properties.workspace = WORKSPACE;

  const options: Record<string, unknown> = { additionalProperties: false };
  if (branches.length === 1) {
    if (branches[0]!.length) options.required = [...branches[0]!];
  } else {
    options.anyOf = branches.map((branch) => ({ required: [...branch] }));
  }
  return Type.Object(properties, options as any);
}

function forbiddenFields(fields: readonly string[]): Record<string, unknown> {
  return { not: { anyOf: fields.map((field) => ({ required: [field] })) } };
}

/** Publish one provider-safe object root, with mode rules as constraint fragments. */
export function parameterSchema(operation: LinearOperation) {
  const contract = canonicalOperation(operation);
  if (!contract.variants) {
    return objectSchema(contract.fields, Object.keys(contract.fields), contract.branches);
  }

  const [create, update] = contract.variants;
  const fieldNames = Object.keys(contract.fields);
  const createForbidden = fieldNames.filter((field) => !create.fields.includes(field));
  const updateForbidden = fieldNames.filter((field) => !update.fields.includes(field));
  const properties: Record<string, TSchema> = Object.fromEntries(
    fieldNames.map((name) => [name, Type.Optional(schemaFor(contract.fields[name]!))]),
  );
  properties.workspace = WORKSPACE;

  const createClause = {
    required: [...create.branches[0]!],
    ...forbiddenFields(createForbidden),
  };
  const updateClause = {
    required: [update.branches[0]![0]!],
    anyOf: update.branches.map((branch) => ({ required: [...branch] })),
    ...forbiddenFields(updateForbidden),
  };
  return Type.Object(properties, {
    additionalProperties: false,
    oneOf: [createClause, updateClause],
  } as any);
}

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
  const satisfied = branches.some((branch) => branch.every((name) => variables[name] !== undefined));
  if (satisfied) return;
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
      + `Accepted parameters: ${[...allowed].join(', ')}. Legacy aliases and raw input go through linear_api.`,
    );
  }
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
    throw new Error(`Invalid arguments for "${typedToolName(operation.name)}": ${problems}.`);
  };
}

function toolDescription(operation: LinearOperation): string {
  return `${operation.purpose} Equivalent to linear_api ${formatInvocation(operation.example)}.`;
}

function typedTool(operation: LinearOperation, mode: MutationMode) {
  const renderers = operationRenderers(operation);
  const schema = parameterSchema(operation);
  const assertSchema = schemaGuard(operation, schema);
  return defineTool({
    name: typedToolName(operation.name),
    label: `Linear ${operation.name.replace(/_/g, ' ')}`,
    description: toolDescription(operation),
    parameters: schema,
    ...(canonicalOperation(operation).variants ? { constrainedSampling: false as const } : {}),
    /**
     * `prepareArguments` is the only hook that runs before Pi's converting validation,
     * so it is used purely as a strict gate: it checks the raw arguments against the
     * published schema and returns the very same object. It performs no compatibility
     * transform, and it never adds, removes, or rewrites a field.
     */
    prepareArguments: (args: unknown) => {
      assertSchema(args);
      return args as any;
    },
    renderCall: renderers.renderCall,
    renderResult: renderers.renderResult,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) throw new Error('Request cancelled.');
      const { workspace, ...variables } = params as JsonObject;
      assertCanonicalOnly(operation, variables);
      assertBranch(operation, variables);
      assertSchema(params);
      operation.validateVariables?.(variables);
      const details = await executeOperation(
        operation,
        { variables, workspace: typeof workspace === 'string' ? workspace : undefined },
        mode,
        ctx,
        signal,
      );
      return { content: [{ type: 'text' as const, text: JSON.stringify(details) }], details };
    },
  });
}

/**
 * The 48 upstream-named typed tools, one per catalog operation. Registration is
 * always-on; activation is not (see extensions/index.ts).
 */
export function typedLinearTools(mode: MutationMode = 'allowlist'): ToolDefinition<any, any, any>[] {
  return Object.values(operations).map((operation) => typedTool(operation, mode));
}

export function typedToolNames(): string[] {
  return Object.values(operations).map((operation) => typedToolName(operation.name));
}
