import { StringEnum } from '@earendil-works/pi-ai';
import { Type, type TSchema } from 'typebox';

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
  ProjectReference: 'Exact project name or slug, or a project UUID.',
  InitiativeReference: 'Exact initiative name, or an initiative UUID.',
  CycleReference: 'Exact cycle name, or a cycle UUID.',
  MilestoneReference: 'Exact milestone name, or a milestone UUID.',
  LabelReference: 'Exact label name, or a label UUID.',
  ProjectStatusReference: 'Exact project status name, or a project status UUID.',
  '[TeamReference!]': 'One or more exact team keys or team UUIDs.',
  '[UserReference!]': 'One or more exact user references.',
  '[LabelReference!]': 'One or more exact label names or label UUIDs.',
  NullableProjectReference: 'Exact project name or slug, or a project UUID; null clears it.',
  NullableCycleReference: 'Exact cycle name, or a cycle UUID; null clears it.',
  NullableMilestoneReference: 'Exact milestone name, or a milestone UUID; null clears it.',
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
export function schemaFor(type: string): TSchema {
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
    case 'NullableProjectReference':
    case 'NullableCycleReference':
    case 'NullableMilestoneReference':
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
    case '[TeamReference!]':
    case '[UserReference!]':
    case '[LabelReference!]':
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
