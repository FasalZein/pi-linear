import { StringEnum } from '@earendil-works/pi-ai';
import { Type, type TSchema } from 'typebox';
import { getOperationDefinition, type LinearOperation } from './operations';
import { canonicalOperation } from './canonical';
import { typedToolName } from './tool-names';

const REFERENCE_HINTS: Record<string, string> = {
  IssueReference: 'Issue identifier such as ABC-123, or an issue UUID.',
  '[IssueReference!]': 'One or more issue identifiers such as ABC-123, or issue UUIDs.',
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
  ResultView: 'summary or full. Lists default to summary. Single records default to full.',
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
  JsonObject: 'Linear document JSON object.',
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
  ResultView: ['summary', 'full'],
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
    case 'JsonObject':
      return Type.Record(Type.String(), Type.Any(), options);
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
    case '[IssueReference!]':
      return Type.Array(Type.String({ minLength: 1 }), { ...options, minItems: 1 });
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
  exclusive = false,
) {
  const properties: Record<string, TSchema> = Object.fromEntries(
    fieldNames.map((name) => [name, Type.Optional(schemaFor(fields[name]!))]),
  );
  properties.workspace = WORKSPACE;

  const options: Record<string, unknown> = { additionalProperties: false };
  if (branches.length === 1) {
    if (branches[0]!.length) options.required = [...branches[0]!];
  } else {
    options[exclusive ? 'oneOf' : 'anyOf'] = branches.map((branch) => ({ required: [...branch] }));
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
    return objectSchema(
      contract.fields,
      Object.keys(contract.fields),
      contract.branches,
      contract.exclusiveBranches,
    );
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

function toolDescription(operation: LinearOperation): string {
  return `${operation.purpose} Call with direct arguments ${JSON.stringify(getOperationDefinition(operation.name).canonical.example)}.`;
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
  return {
    name: typedToolName(operation.name),
    label: `Linear ${operation.name.replace(/_/g, ' ')}`,
    description: toolDescription(operation),
    parameters: parameterSchema(operation),
    ...(contract.variants || contract.exclusiveBranches || Object.values(contract.fields).includes('JsonObject')
      ? { constrainedSampling: false as const }
      : {}),
  };
}
