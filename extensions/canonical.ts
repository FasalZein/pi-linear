import { operations, type LinearOperation } from './operations';

/**
 * The canonical public contract of the typed tools.
 *
 * This is deliberately NOT `acceptedParameters`: that list is v0.4 runtime
 * compatibility metadata and carries legacy aliases (`issueId`, `teamId`,
 * `teamKey`, `stateId`, `parentId`, …) plus raw `input` passthrough. Those stay
 * reachable through `linear_api`. A typed tool publishes one name per concept, so
 * two fields can never describe the same thing with different values.
 *
 * `fields` maps a public parameter to its type token (see typed-tools.ts for the
 * TypeBox mapping). `branches` lists the required-parameter sets that describe every
 * valid call; a call matching none of them fails Pi's validateToolArguments.
 */
export type CanonicalVariant = {
  fields: readonly string[];
  branches: readonly (readonly string[])[];
};

export type CanonicalOperation = {
  fields: Record<string, string>;
  branches: readonly (readonly string[])[];
  /** Closed, mutually exclusive object shapes for mode-sensitive operations. */
  variants?: readonly [CanonicalVariant, CanonicalVariant];
};

/** Fields excluded from every typed schema, with the reason. */
export const TYPED_EXCLUSIONS = {
  /**
   * Raw `input` cannot be strict or discoverable: it is an arbitrary Linear input
   * object, so no schema can state what it accepts. It stays on `linear_api`, which
   * is the explicit raw and compatibility surface.
   */
  rawInput: ['input'],
  /** Identity aliases: the same concept already has one canonical public name. */
  identityAliases: ['issueId', 'teamKey', 'stateId', 'stateName', 'assigneeId', 'parentId'],
  /** `trashed` is the delete path in field form, and no typed tool deletes. */
  destructive: ['trashed'],
} as const;

const PAGINATION: Record<string, string> = {
  after: 'String',
  before: 'String',
  first: 'Int',
  last: 'Int',
  includeArchived: 'Boolean',
  orderBy: 'PaginationOrderBy',
};

const listFields = (extra: Record<string, string> = {}): Record<string, string> => ({
  ...extra,
  ...PAGINATION,
  filter: 'Filter',
});

/**
 * Fields Linear accepts only when creating, or only when updating. They stay public —
 * the runtime rejects the wrong mode with a precise message — but a create-only field
 * never counts as the content of an update branch.
 */
const CREATE_ONLY: Record<string, readonly string[]> = {
  save_initiative: ['id'],
  save_milestone: ['id'],
  save_project: ['id', 'templateId', 'useDefaultTemplate', 'slackChannelName'],
};

const UPDATE_ONLY: Record<string, readonly string[]> = {
  save_initiative: [
    'customIdentifier', 'frequencyResolution', 'updateReminderFrequency',
    'updateReminderFrequencyInWeeks', 'updateRemindersDay', 'updateRemindersHour',
  ],
  save_project: [
    'canceledAt', 'completedAt', 'frequencyResolution', 'projectUpdateRemindersPausedUntilAt',
    'slackIssueComments', 'slackIssueStatuses', 'slackNewIssue', 'updateReminderFrequency',
    'updateReminderFrequencyInWeeks', 'updateRemindersDay', 'updateRemindersHour',
  ],
};

/** Every published field except the identity is valid update content. */
function contentOf(
  operationName: string,
  fields: Record<string, string>,
  identity: string,
): string[] {
  const createOnly = new Set(CREATE_ONLY[operationName] ?? []);
  return Object.keys(fields).filter((name) => name !== identity && !createOnly.has(name));
}

/** Fields carried by every issue mutation, create and update alike. */
const ISSUE_SHARED: Record<string, string> = {
  description: 'String',
  descriptionData: 'JsonString',
  priority: 'Priority',
  estimate: 'Int',
  projectId: 'UUID',
  projectMilestoneId: 'UUID',
  cycleId: 'UUID',
  labelIds: '[UUID!]',
  subscriberIds: '[UUID!]',
  delegateId: 'UUID',
  lastAppliedTemplateId: 'UUID',
  slaType: 'SlaDayCountType',
  slaBreachesAt: 'NullableDateTime',
  slaStartedAt: 'NullableDateTime',
  sortOrder: 'Float',
  subIssueSortOrder: 'Float',
  prioritySortOrder: 'Float',
};

/** Reminder cadence, shared by the initiative and project update paths. */
const UPDATE_REMINDERS: Record<string, string> = {
  frequencyResolution: 'FrequencyResolutionType',
  updateReminderFrequency: 'Float',
  updateReminderFrequencyInWeeks: 'Float',
  updateRemindersDay: 'Day',
  updateRemindersHour: 'Float',
};

/** Identity plus at least one content field: one branch per updatable field. */
function updateBranches(identity: string, contentFields: readonly string[]): readonly (readonly string[])[] {
  return contentFields.map((field) => [identity, field]);
}

/**
 * Ordinary issue fields both upstream 0.4.1 and this runtime support. The `*Id` names
 * here are Linear's own field names for associations that have no reference resolver
 * on issue operations, so they take UUIDs; they are not identity aliases.
 */
/** Document associations. `issueId` and `teamId` resolve references at runtime. */
const DOCUMENT_ASSOCIATION: Record<string, string> = {
  issueId: 'IssueReference',
  teamId: 'TeamReference',
  projectId: 'UUID',
  initiativeId: 'UUID',
  cycleId: 'UUID',
  releaseId: 'UUID',
  resourceFolderId: 'UUID',
  lastAppliedTemplateId: 'UUID',
  ownerId: 'UUID',
  subscriberIds: '[UUID!]',
  sortOrder: 'Float',
};

const LABEL_CONTENT: Record<string, string> = {
  description: 'String',
  color: 'Color',
  isGroup: 'Boolean',
  parentId: 'UUID',
};

const LABEL_CREATE_CONTENT: Record<string, string> = {
  ...LABEL_CONTENT,
  retiredAt: 'DateTime',
};

const LABEL_UPDATE_CONTENT: Record<string, string> = {
  ...LABEL_CONTENT,
  retiredAt: 'NullableDateTime',
};

const DOCUMENT_CONTENT: Record<string, string> = {
  content: 'String',
  icon: 'String',
  color: 'Color',
};

const VIEW_CONTENT: Record<string, string> = {
  description: 'String',
  icon: 'String',
  color: 'Color',
  shared: 'Boolean',
  filterData: 'FilterData',
  projectFilterData: 'FilterData',
  initiativeFilterData: 'FilterData',
  feedItemFilterData: 'FilterData',
};

export const CANONICAL_OPERATIONS: Record<string, CanonicalOperation> = {
  // ---- comments ----------------------------------------------------------
  list_comments: { fields: listFields({ issue: 'IssueReference' }), branches: [[]] },
  create_comment: {
    fields: {
      issue: 'IssueReference',
      body: 'String',
      bodyData: 'JsonString',
      quotedText: 'String',
      parentId: 'UUID',
      subscriberIds: '[UUID!]',
      doNotSubscribeToIssue: 'Boolean',
      createOnSyncedSlackThread: 'Boolean',
      createAsUser: 'String',
      displayIconUrl: 'Url',
      documentContentId: 'UUID',
      initiativeUpdateId: 'UUID',
      projectUpdateId: 'UUID',
      postId: 'UUID',
      createdAt: 'DateTime',
      id: 'UUID',
    },
    branches: [['issue', 'body'], ['issue', 'bodyData']],
  },
  update_comment: {
    fields: { id: 'String', body: 'String', bodyData: 'JsonString', quotedText: 'String' },
    branches: [],
  },

  // ---- views -------------------------------------------------------------
  list_views: { fields: listFields(), branches: [[]] },
  get_view: { fields: { id: 'String' }, branches: [['id']] },
  create_view: {
    fields: { name: 'String', team: 'TeamReference', ...VIEW_CONTENT },
    branches: [['name']],
  },
  update_view: {
    fields: { id: 'String', name: 'String', ...VIEW_CONTENT },
    branches: [],
  },
  set_view_preferences: {
    fields: { viewId: 'String', preferences: 'Preferences' },
    branches: [['viewId', 'preferences']],
  },

  // ---- cycles ------------------------------------------------------------
  list_cycles: { fields: listFields({ team: 'TeamReference' }), branches: [[]] },
  get_cycle: { fields: { cycle: 'CycleReference' }, branches: [['cycle']] },
  create_cycle: {
    fields: {
      team: 'TeamReference',
      startsAt: 'DateTime',
      endsAt: 'DateTime',
      name: 'String',
      description: 'String',
    },
    branches: [['team', 'startsAt', 'endsAt']],
  },
  update_cycle: {
    fields: {
      id: 'String',
      name: 'String',
      description: 'String',
      startsAt: 'DateTime',
      endsAt: 'DateTime',
      completedAt: 'DateTime',
    },
    branches: [],
  },

  // ---- documents ---------------------------------------------------------
  list_documents: { fields: listFields({ sort: '[DocumentSort!]' }), branches: [[]] },
  get_document: { fields: { document: 'DocumentReference' }, branches: [['document']] },
  create_document: {
    fields: { title: 'String', ...DOCUMENT_CONTENT, ...DOCUMENT_ASSOCIATION, id: 'UUID' },
    branches: [['title']],
  },
  update_document: {
    fields: {
      documentId: 'DocumentReference',
      title: 'String',
      ...DOCUMENT_CONTENT,
      ...DOCUMENT_ASSOCIATION,
      hiddenAt: 'NullableDateTime',
    },
    branches: updateBranches('documentId', [
      'title',
      ...Object.keys(DOCUMENT_CONTENT),
      ...Object.keys(DOCUMENT_ASSOCIATION),
    ]),
  },

  // ---- initiatives -------------------------------------------------------
  list_initiatives: { fields: listFields({ sort: '[InitiativeSort!]' }), branches: [[]] },
  get_initiative: { fields: { initiative: 'InitiativeReference' }, branches: [['initiative']] },
  save_initiative: {
    fields: {
      initiativeId: 'InitiativeReference',
      name: 'String',
      description: 'String',
      content: 'String',
      icon: 'String',
      color: 'Color',
      status: 'InitiativeStatus',
      targetDate: 'NullableDate',
      targetDateResolution: 'DateResolutionType',
      ownerId: 'UUID',
      leadTeamId: 'UUID',
      sortOrder: 'Float',
      prioritySortOrder: 'Float',
      priority: 'Priority',
      labelIds: '[UUID!]',
      id: 'UUID',
      customIdentifier: 'String',
      ...UPDATE_REMINDERS,
    },
    branches: [],
  },

  // ---- labels ------------------------------------------------------------
  list_issue_labels: { fields: listFields({ team: 'TeamReference' }), branches: [[]] },
  create_issue_label: {
    fields: {
      name: 'String',
      team: 'TeamReference',
      ...LABEL_CREATE_CONTENT,
      replaceTeamLabels: 'Boolean',
      id: 'UUID',
    },
    branches: [['name']],
  },
  update_issue_label: {
    fields: { id: 'String', name: 'String', ...LABEL_UPDATE_CONTENT, replaceTeamLabels: 'Boolean' },
    branches: [],
  },
  list_project_labels: { fields: listFields(), branches: [[]] },
  create_project_label: {
    fields: { name: 'String', ...LABEL_CREATE_CONTENT },
    branches: [['name']],
  },
  update_project_label: {
    fields: { id: 'String', name: 'String', ...LABEL_UPDATE_CONTENT },
    branches: [],
  },

  // ---- relations ---------------------------------------------------------
  list_issue_relations: { fields: PAGINATION, branches: [[]] },
  create_issue_relation: {
    fields: {
      issue: 'IssueReference',
      relatedIssue: 'IssueReference',
      type: 'IssueRelationType',
    },
    branches: [['issue', 'relatedIssue', 'type']],
  },
  update_issue_relation: {
    fields: {
      id: 'String',
      type: 'IssueRelationType',
      issueId: 'IssueReference',
      relatedIssueId: 'IssueReference',
    },
    branches: [],
  },
  list_project_relations: { fields: PAGINATION, branches: [[]] },
  create_project_relation: {
    fields: {
      projectId: 'String',
      relatedProjectId: 'String',
      type: 'String',
      anchorType: 'String',
      relatedAnchorType: 'String',
      projectMilestoneId: 'UUID',
      relatedProjectMilestoneId: 'UUID',
    },
    branches: [['projectId', 'relatedProjectId', 'type', 'anchorType', 'relatedAnchorType']],
  },
  update_project_relation: {
    fields: {
      id: 'String',
      type: 'String',
      anchorType: 'String',
      relatedAnchorType: 'String',
      projectId: 'UUID',
      relatedProjectId: 'UUID',
      projectMilestoneId: 'UUID',
      relatedProjectMilestoneId: 'UUID',
    },
    branches: updateBranches('id', [
      'type', 'anchorType', 'relatedAnchorType',
      'projectId', 'relatedProjectId', 'projectMilestoneId', 'relatedProjectMilestoneId',
    ]),
  },

  // ---- issues ------------------------------------------------------------
  list_issue_statuses: { fields: listFields(), branches: [[]] },
  list_issues: {
    fields: listFields({
      query: 'String',
      team: 'TeamReference',
      state: 'StateReference',
      stateType: 'WorkflowStateType',
      assignee: 'UserReference',
      sort: '[IssueSort!]',
    }),
    branches: [[]],
  },
  get_issue: { fields: { issue: 'IssueReference' }, branches: [['issue']] },
  create_issue: {
    fields: {
      title: 'String',
      team: 'TeamReference',
      parent: 'IssueReference',
      state: 'StateReference',
      assignee: 'UserReference',
      dueDate: 'Date',
      ...ISSUE_SHARED,
      templateId: 'UUID',
      useDefaultTemplate: 'Boolean',
      preserveSortOrderOnCreate: 'Boolean',
      referenceCommentId: 'UUID',
      sourceCommentId: 'UUID',
      sourcePullRequestCommentId: 'UUID',
      createAsUser: 'String',
      displayIconUrl: 'Url',
      completedAt: 'NullableDateTime',
      createdAt: 'DateTime',
      id: 'UUID',
    },
    branches: [['title', 'team'], ['title', 'parent']],
  },
  update_issue: {
    fields: {
      issue: 'IssueReference',
      title: 'String',
      state: 'StateReference',
      assignee: 'UserReference',
      parent: 'IssueReference',
      // The runtime resolves a team reference here, moving the issue between teams.
      teamId: 'TeamReference',
      // Linear clears a due date when it is set to null.
      dueDate: 'NullableDate',
      addedLabelIds: '[UUID!]',
      removedLabelIds: '[UUID!]',
      ...ISSUE_SHARED,
      autoClosedByParentClosing: 'Boolean',
      snoozedById: 'UUID',
      snoozedUntilAt: 'NullableDateTime',
    },
    branches: [],
  },
  search_issues: {
    fields: listFields({ term: 'String', includeComments: 'Boolean', team: 'TeamReference' }),
    branches: [['term']],
  },

  // ---- milestones --------------------------------------------------------
  list_milestones: { fields: listFields(), branches: [[]] },
  get_milestone: { fields: { milestone: 'MilestoneReference' }, branches: [['milestone']] },
  save_milestone: {
    fields: {
      milestoneId: 'MilestoneReference',
      name: 'String',
      projectId: 'ProjectReference',
      description: 'String',
      descriptionData: 'JsonString',
      targetDate: 'NullableDate',
      sortOrder: 'Float',
      id: 'UUID',
    },
    branches: [],
  },

  // ---- projects ----------------------------------------------------------
  list_projects: { fields: listFields({ sort: '[ProjectSort!]' }), branches: [[]] },
  get_project: { fields: { project: 'ProjectReference' }, branches: [['project']] },
  save_project: {
    fields: {
      projectId: 'ProjectReference',
      name: 'String',
      teamIds: '[ID!]',
      description: 'String',
      content: 'String',
      icon: 'String',
      color: 'Color',
      priority: 'Priority',
      startDate: 'Date',
      startDateResolution: 'DateResolutionType',
      targetDate: 'NullableDate',
      targetDateResolution: 'DateResolutionType',
      statusId: 'UUID',
      leadId: 'UUID',
      leadTeamId: 'UUID',
      memberIds: '[UUID!]',
      labelIds: '[UUID!]',
      convertedFromIssueId: 'IssueReference',
      lastAppliedTemplateId: 'UUID',
      sortOrder: 'Float',
      prioritySortOrder: 'Float',
      canceledAt: 'NullableDateTime',
      completedAt: 'NullableDateTime',
      projectUpdateRemindersPausedUntilAt: 'NullableDateTime',
      slackIssueComments: 'Boolean',
      slackIssueStatuses: 'Boolean',
      slackNewIssue: 'Boolean',
      slackChannelName: 'String',
      templateId: 'UUID',
      useDefaultTemplate: 'Boolean',
      id: 'UUID',
      ...UPDATE_REMINDERS,
    },
    branches: [],
  },

  // ---- teams, users, workspace -------------------------------------------
  list_teams: { fields: listFields(), branches: [[]] },
  get_team: { fields: { team: 'TeamReference' }, branches: [['team']] },
  list_users: { fields: listFields({ includeDisabled: 'Boolean', sort: '[UserSort!]' }), branches: [[]] },
  get_user: { fields: { user: 'UserReference' }, branches: [['user']] },
  switch_workspace: { fields: { name: 'String' }, branches: [['name']] },
};

/**
 * Operations whose branch list is derived from their published fields: the identity
 * plus any one content field is a valid update, and the create branches are listed
 * once here rather than repeated for every field.
 */
const DERIVED_BRANCHES: Record<string, { identity: string; create: readonly (readonly string[])[] }> = {
  update_comment: { identity: 'id', create: [] },
  update_view: { identity: 'id', create: [] },
  update_cycle: { identity: 'id', create: [] },
  update_document: { identity: 'documentId', create: [] },
  update_issue_label: { identity: 'id', create: [] },
  update_project_label: { identity: 'id', create: [] },
  update_issue_relation: { identity: 'id', create: [] },
  update_project_relation: { identity: 'id', create: [] },
  update_issue: { identity: 'issue', create: [] },
  save_initiative: { identity: 'initiativeId', create: [['name']] },
  save_milestone: { identity: 'milestoneId', create: [['name', 'projectId']] },
  save_project: { identity: 'projectId', create: [['name', 'teamIds']] },
};

for (const [operationName, rule] of Object.entries(DERIVED_BRANCHES)) {
  const contract = CANONICAL_OPERATIONS[operationName]!;
  const update = updateBranches(rule.identity, contentOf(operationName, contract.fields, rule.identity));
  contract.branches = [...rule.create, ...update];

  if (rule.create.length) {
    const createOnly = new Set(CREATE_ONLY[operationName] ?? []);
    const updateOnly = new Set(UPDATE_ONLY[operationName] ?? []);
    const allFields = Object.keys(contract.fields);
    contract.variants = [
      {
        fields: allFields.filter((field) => field !== rule.identity && !updateOnly.has(field)),
        branches: rule.create,
      },
      {
        fields: allFields.filter((field) => !createOnly.has(field)),
        branches: update,
      },
    ];
  }
}

export function canonicalOperation(operation: LinearOperation): CanonicalOperation {
  const contract = CANONICAL_OPERATIONS[operation.name];
  if (!contract) throw new Error(`No canonical typed contract for operation "${operation.name}".`);
  return contract;
}

/** Public parameter names, in declaration order. */
export function canonicalFieldNames(operation: LinearOperation): string[] {
  return Object.keys(canonicalOperation(operation).fields);
}

/** Every catalog operation must have exactly one canonical contract. */
export function missingCanonicalOperations(): string[] {
  const declared = new Set(Object.keys(CANONICAL_OPERATIONS));
  const catalog = Object.keys(operations);
  return [
    ...catalog.filter((name) => !declared.has(name)),
    ...[...declared].filter((name) => !catalog.includes(name)),
  ];
}
