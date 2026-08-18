/** Ordered activation contract owned by S7 operation discovery definitions. */
export const DEFINITION_ACTIONS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(?:list|show me|enumerate)\b/, 'list'],
  [/\b(?:add|post|leave|write)\s+(?:a\s+)?comment\b|\bcomment(?:ed|ing|s)?\b/, 'comment'],
  [/\b(?:read|get|show|open|view|fetch|inspect|lookup)\b/, 'get'],
  [/\bsearch\b/, 'search'],
  [/\b(?:create|add|new|make|file|open a new)\b/, 'create'],
  [/\b(?:set|change|update|move|rename|assign|close|reopen)\b/, 'update'],
  [/\b(?:switch|use)\b/, 'switch'],
  [/\b(?:save)\b/, 'save'],
];

export const DEFINITION_ENTITIES: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(?:child|children|sub-?issues?|subtasks?)\b/, 'issue'],
  [/\bissue statuses\b|\bworkflow states?\b|\bstatuses\b/, 'issue_status'],
  [/\bissue relations?\b|\bblocking relations?\b/, 'issue_relation'],
  [/\bproject relations?\b/, 'project_relation'],
  [/\bissue labels?\b/, 'issue_label'],
  [/\bproject labels?\b/, 'project_label'],
  [/\blabels?\b/, 'issue_label'],
  [/\bcomments?\b/, 'comment'],
  [/\bissues?\b|\btickets?\b|\bbugs?\b/, 'issue'],
  [/\bprojects?\b/, 'project'],
  [/\bmilestones?\b/, 'milestone'],
  [/\binitiatives?\b/, 'initiative'],
  [/\bcycles?\b|\bsprints?\b/, 'cycle'],
  [/\bdocuments?\b|\bdocs?\b/, 'document'],
  [/\bteams?\b/, 'team'],
  [/\busers?\b|\bmembers?\b|\bpeople\b/, 'user'],
  [/\bviews?\b/, 'view'],
  [/\bworkspaces?\b/, 'workspace'],
  [/\bview preferences?\b/, 'view_preference'],
  [/\b[A-Z][A-Z0-9]+-\d+\b/, 'issue'],
];

export const DEFINITION_OPERATION_BY_INTENT: Readonly<Record<string, string>> = {
  'get issue': 'get_issue', 'get project': 'get_project', 'get team': 'get_team',
  'get user': 'get_user', 'get cycle': 'get_cycle', 'get document': 'get_document',
  'get initiative': 'get_initiative', 'get milestone': 'get_milestone', 'get view': 'get_view',
  'list issue': 'list_issues', 'list comment': 'list_comments', 'list project': 'list_projects',
  'list team': 'list_teams', 'list user': 'list_users', 'list cycle': 'list_cycles',
  'list document': 'list_documents', 'list initiative': 'list_initiatives',
  'list milestone': 'list_milestones', 'list view': 'list_views',
  'list issue_label': 'list_issue_labels', 'list project_label': 'list_project_labels',
  'list issue_status': 'list_issue_statuses', 'list issue_relation': 'list_issue_relations',
  'list project_relation': 'list_project_relations', 'search issue': 'search_issues',
  'comment issue': 'create_comment', 'comment comment': 'create_comment',
  'create issue': 'create_issue', 'create comment': 'create_comment', 'create cycle': 'create_cycle',
  'create document': 'create_document', 'create view': 'create_view',
  'create issue_label': 'create_issue_label', 'create project_label': 'create_project_label',
  'create issue_relation': 'create_issue_relation', 'create project_relation': 'create_project_relation',
  'create project': 'save_project', 'create milestone': 'save_milestone',
  'create initiative': 'save_initiative', 'update issue': 'update_issue',
  'update comment': 'update_comment', 'update cycle': 'update_cycle',
  'update document': 'update_document', 'update view': 'update_view',
  'update issue_label': 'update_issue_label', 'update project_label': 'update_project_label',
  'update issue_relation': 'update_issue_relation', 'update project_relation': 'update_project_relation',
  'update project': 'save_project', 'update milestone': 'save_milestone',
  'update initiative': 'save_initiative', 'update view_preference': 'set_view_preferences',
  'save project': 'save_project', 'save milestone': 'save_milestone',
  'save initiative': 'save_initiative', 'switch workspace': 'switch_workspace',
};

export const DEFINITION_PLAN_PROBES: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['List comments on AEO-258', ['list_comments']],
  ['comment on AEO-258', ['create_comment']],
  ['create a child under AEO-258 in Backlog', ['create_issue']],
  ['read AEO-258 then update it', ['get_issue', 'update_issue']],
  ['list issue labels', ['list_issue_labels']],
  ['update view preferences', ['get_view']],
  ['switch workspace', ['switch_workspace']],
];

export function discoveryForOperation(name: string) {
  const intents = Object.entries(DEFINITION_OPERATION_BY_INTENT)
    .filter(([, operation]) => operation === name)
    .map(([intent]) => {
      const [action, ...entity] = intent.split(' ');
      return { action: action!, entity: entity.join(' ') };
    });
  const actions = [...new Set(intents.map(({ action }) => action))];
  const entities = [...new Set(intents.map(({ entity }) => entity))];
  const phrases = [
    ...DEFINITION_ACTIONS.filter(([, value]) => actions.includes(value)).map(([pattern]) => pattern.source),
    ...DEFINITION_ENTITIES.filter(([, value]) => entities.includes(value)).map(([pattern]) => pattern.source),
  ];
  return { actions, entities, intents, phrases };
}
