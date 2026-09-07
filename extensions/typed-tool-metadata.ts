import { StringEnum } from '@earendil-works/pi-ai';
import { Type, type TSchema } from 'typebox';
import type { LinearOperation } from './operations';
import { canonicalOperation } from './canonical';
import { typedToolName } from './tool-names';

/**
 * Hints for values a caller cannot infer from the property name and type.
 *
 * A description earns its bytes only when it says something the name and the published
 * type do not. `projectId: string` needs no "Linear UUID."; `priority: number` cannot be
 * guessed. Enum members are published in the schema, so restating them here is duplication.
 */
const REFERENCE_HINTS = {
  IssueReference: 'Issue identifier such as ABC-123, or an issue UUID.',
  '[IssueReference!]': 'One or more issue identifiers such as ABC-123, or issue UUIDs.',
  TeamReference: 'Team key such as ABC, or a team UUID.',
  StateReference: 'Workflow state name, or a state UUID.',
  UserReference: 'User email, exact name, display name, "me", or a user UUID.',
  ProjectReference: 'Exact project name, or a project UUID.',
  InitiativeReference: 'Exact initiative name, or an initiative UUID.',
  CycleReference: 'Exact cycle name, or a cycle UUID.',
  MilestoneReference: 'Exact milestone name, or a milestone UUID.',
  DocumentReference: 'Exact document title, or a document UUID.',
  DateTime: 'ISO 8601 date-time.',
  Date: 'Calendar date, YYYY-MM-DD.',
  ResultView: 'Reads: lists default to summary and single records to full. Mutations default to summary.',
  Filter: 'Linear filter object.',
  FilterData: 'Linear view filter object.',
  Preferences: 'View preference object.',
  Color: 'Hex color such as #ff0000.',
  NullableDate: 'Calendar date YYYY-MM-DD; null clears it.',
  NullableUserReference: 'User email, exact name, display name, "me", or a user UUID; null clears it.',
  NullableIssueReference: 'Issue identifier such as ABC-123, or an issue UUID; null clears it.',
  NullableUUID: 'Null clears it.',
  NullableDateTime: 'Null clears it.',
  Priority: '0 none, 1 urgent, 2 high, 3 medium, 4 low.',
  JsonString: 'Serialized Linear document JSON.',
  JsonObject: 'Linear document JSON object.',
  Url: 'Absolute http(s) URL.',
} satisfies Readonly<Record<string, string>>;

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
const SORT_KEYS = {
  '[IssueSort!]': [
    'priority', 'estimate', 'title', 'label', 'slaStatus', 'createdAt',
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
} satisfies Readonly<Record<string, readonly string[]>>;

const ENUMS = {
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
} satisfies Readonly<Record<string, readonly string[]>>;

function ownedValue<T>(owner: Readonly<Record<string, T>>, key: string): T | undefined {
  return owner[key];
}

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
  const description = ownedValue(REFERENCE_HINTS, type);
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
    case 'NullableUserReference':
    case 'NullableIssueReference':
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
    case 'NullableUUID':
      return Type.Union([Type.String({ pattern: UUID_PATTERN }), Type.Null()], options);
    case '[UUID!]':
      return Type.Array(Type.String({ pattern: UUID_PATTERN }), { ...options, minItems: 1 });
    case '[IssueReference!]':
      return Type.Array(Type.String({ minLength: 1 }), { ...options, minItems: 1 });
    case 'Preferences':
      return description ? { ...PREFERENCES, description } : PREFERENCES;
    case '[ID!]':
      return Type.Array(Type.String({ minLength: 1 }), { ...options, minItems: 1 });
    case '[SortInput!]':
      return Type.Array(SORT_ITEM, { ...options, minItems: 1 });
    case 'Filter':
    case 'FilterData':
      return Type.Record(Type.String(), Type.Any(), { ...options, minProperties: 1 });
    default: {
      const sortKeys = ownedValue(SORT_KEYS, type);
      if (sortKeys) return Type.Array(sortItem(sortKeys), { ...options, minItems: 1 });
      const enumValues = ownedValue(ENUMS, type);
      // The members are published in the schema; a restating description adds only bytes.
      if (enumValues) return StringEnum(enumValues, options);
      return Type.String({ ...options, minLength: 1 });
    }
  }
}

/** The required-parameter sets that describe every valid canonical call. */
export function requirementBranches(operation: LinearOperation): readonly (readonly string[])[] {
  return canonicalOperation(operation).branches;
}

/**
 * Typed tools publish no `workspace` property.
 *
 * It was optional, absent from every help parameter card, and collided with pi's own
 * meaning of "workspace" (the working directory). Callers filled it with paths, and an
 * unrecognised name is a hard credential failure, so the call could not recover. Workspace
 * selection is session state: `/linear-auth switch` and `linear_switch_workspace` set it,
 * and `linear_graphql` / `linear_batch` still accept it for explicit cross-account work.
 */
function objectSchema(
  fields: Record<string, string>,
  fieldNames: readonly string[],
  branches: readonly (readonly string[])[],
  exclusive = false,
) {
  const properties: Record<string, TSchema> = Object.fromEntries(
    fieldNames.map((name) => [name, Type.Optional(schemaFor(fields[name]!))]),
  );

  if (branches.length === 1) {
    const required = branches[0]!;
    return Type.Object(properties, required.length
      ? { additionalProperties: false, required: [...required] }
      : { additionalProperties: false });
  }
  const requirements = branches.map((branch) => ({ required: [...branch] }));
  return exclusive
    ? Type.Object(properties, { additionalProperties: false, oneOf: requirements })
    : Type.Object(properties, { additionalProperties: false, anyOf: requirements });
}

function describePagination(schema: TSchema, operation: LinearOperation): TSchema {
  if (!operation.pagination) return schema;
  const properties = (schema as { properties: Record<string, TSchema> }).properties;
  if (properties.first) {
    properties.first = { ...properties.first, description: `Forward page size. Omit first to use the default ${operation.pagination.defaultPageSize}.` } as TSchema;
  }
  if (properties.last) {
    properties.last = { ...properties.last, description: `Backward page size. Omit last to use the default ${operation.pagination.defaultPageSize}.` } as TSchema;
  }
  return schema;
}

/** Publish one provider-safe object root, with mode rules as constraint fragments. */
export function parameterSchema(operation: LinearOperation) {
  const contract = canonicalOperation(operation);
  if (!contract.variants) {
    return describePagination(objectSchema(
      contract.fields,
      Object.keys(contract.fields),
      contract.branches,
      contract.exclusiveBranches,
    ), operation);
  }

  const [create, update] = contract.variants;
  const fieldNames = Object.keys(contract.fields);
  const properties: Record<string, TSchema> = Object.fromEntries(
    fieldNames.map((name) => [name, Type.Optional(schemaFor(contract.fields[name]!))]),
  );

  /**
   * Publish what each mode requires; enforce what each mode forbids at runtime.
   *
   * The required sets are information a caller needs and cost about 60 bytes. The forbidden
   * sets were an enumeration of every excluded field per mode, and when they tripped the
   * validator named no field and no fix. `assertVariant` in typed-tools.ts applies that
   * half, naming the mode, the offending field, and what the mode accepts.
   */
  return describePagination(Type.Object(properties, {
    additionalProperties: false,
    anyOf: [
      { required: [...create.branches[0]!] },
      // Every update branch is the identity plus one changed field, so `save_project`
      // enumerated 31 pairs to say this. `minProperties` states it in one clause.
      { required: [update.branches[0]![0]!], minProperties: 2 },
    ],
  }), operation);
}

/**
 * The published schema already states the call shape, so the description carries purpose
 * only. A repeated worked example cost 2,910 bytes across the tool set and said nothing
 * the parameter list did not.
 */
function toolDescription(operation: LinearOperation): string {
  return operation.purpose;
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
  const metadata: TypedToolMetadata = {
    name: typedToolName(operation.name),
    label: `Linear ${operation.name.replace(/_/g, ' ')}`,
    description: toolDescription(operation),
    parameters: parameterSchema(operation),
  };
  if (contract.variants || contract.exclusiveBranches || Object.values(contract.fields).includes('JsonObject')) {
    metadata.constrainedSampling = false;
  }
  return metadata;
}
