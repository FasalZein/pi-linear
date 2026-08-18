import { operations, operationSignature, type LinearOperation } from './operations';

/**
 * Deterministic activation for natural help requests.
 *
 * A clause activates a typed tool only when one action and one entity together name
 * exactly one catalog operation. Anything vaguer — a bare noun, an unknown verb, two
 * possible entities — activates nothing and returns ranked candidates for discovery,
 * because loading a schema the task does not need costs context and invites the model
 * to call the wrong tool.
 */

/** Closed action map: phrase → catalog action prefix. */
const ACTIONS: ReadonlyArray<readonly [RegExp, string]> = [
  // A leading list verb wins over the entity noun "comments".
  [/\b(?:list|show me|enumerate)\b/, 'list'],
  [/\b(?:add|post|leave|write)\s+(?:a\s+)?comment\b|\bcomment(?:ed|ing|s)?\b/, 'comment'],
  // `lookup` is part of the closed map because the v0.4 blind contract uses it.
  [/\b(?:read|get|show|open|view|fetch|inspect|lookup)\b/, 'get'],
  [/\bsearch\b/, 'search'],
  [/\b(?:create|add|new|make|file|open a new)\b/, 'create'],
  [/\b(?:set|change|update|move|rename|assign|close|reopen)\b/, 'update'],
  [/\b(?:switch|use)\b/, 'switch'],
  [/\b(?:save)\b/, 'save'],
];

/** Closed entity map: phrase → catalog entity noun used in operation names. */
const ENTITIES: ReadonlyArray<readonly [RegExp, string]> = [
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
  // An identifier is a fallback entity. Explicit nouns such as "comments" win.
  [/\b[A-Z][A-Z0-9]+-\d+\b/, 'issue'],
];

/** action + entity → catalog operation, when exactly one operation implements it. */
const OPERATION_BY_INTENT: Record<string, string> = {
  'get issue': 'get_issue',
  'get project': 'get_project',
  'get team': 'get_team',
  'get user': 'get_user',
  'get cycle': 'get_cycle',
  'get document': 'get_document',
  'get initiative': 'get_initiative',
  'get milestone': 'get_milestone',
  'get view': 'get_view',
  'list issue': 'list_issues',
  'list comment': 'list_comments',
  'list project': 'list_projects',
  'list team': 'list_teams',
  'list user': 'list_users',
  'list cycle': 'list_cycles',
  'list document': 'list_documents',
  'list initiative': 'list_initiatives',
  'list milestone': 'list_milestones',
  'list view': 'list_views',
  'list issue_label': 'list_issue_labels',
  'list project_label': 'list_project_labels',
  'list issue_status': 'list_issue_statuses',
  'list issue_relation': 'list_issue_relations',
  'list project_relation': 'list_project_relations',
  'search issue': 'search_issues',
  'comment issue': 'create_comment',
  'comment comment': 'create_comment',
  'create issue': 'create_issue',
  'create comment': 'create_comment',
  'create cycle': 'create_cycle',
  'create document': 'create_document',
  'create view': 'create_view',
  'create issue_label': 'create_issue_label',
  'create project_label': 'create_project_label',
  'create issue_relation': 'create_issue_relation',
  'create project_relation': 'create_project_relation',
  'create project': 'save_project',
  'create milestone': 'save_milestone',
  'create initiative': 'save_initiative',
  'update issue': 'update_issue',
  'update comment': 'update_comment',
  'update cycle': 'update_cycle',
  'update document': 'update_document',
  'update view': 'update_view',
  'update issue_label': 'update_issue_label',
  'update project_label': 'update_project_label',
  'update issue_relation': 'update_issue_relation',
  'update project_relation': 'update_project_relation',
  'update project': 'save_project',
  'update milestone': 'save_milestone',
  'update initiative': 'save_initiative',
  'update view_preference': 'set_view_preferences',
  'save project': 'save_project',
  'save milestone': 'save_milestone',
  'save initiative': 'save_initiative',
  'switch workspace': 'switch_workspace',
};

/** Pronouns that carry the entity of the previous clause, and nothing else. */
const CARRIED_PRONOUN = /\b(?:it|them)\b/i;

export type ClauseResolution = {
  clause: string;
  action?: string;
  entity?: string;
  operation?: string;
};

/** Sentence boundaries, semicolons, and explicit sequencing words. */
export function splitClauses(query: string): string[] {
  return query
    .split(/(?:[.!?;\n]+|\band then\b|\bthen\b)/i)
    .map((clause) => clause.trim())
    .filter(Boolean);
}

function matchFirst(map: ReadonlyArray<readonly [RegExp, string]>, clause: string): string | undefined {
  for (const [pattern, value] of map) {
    const caseInsensitive = pattern.ignoreCase
      ? pattern
      : new RegExp(pattern.source, `${pattern.flags}i`);
    if (caseInsensitive.test(clause)) return value;
  }
  return undefined;
}

function entityOf(clause: string): string | undefined {
  // Longest-phrase entities first: the map is ordered, and a two-word entity such as
  // "issue labels" must win over the "labels" fallback in the same clause.
  return matchFirst(ENTITIES, clause);
}

/** Resolve one clause. `operation` is set only when the intent is unambiguous. */
export function resolveClause(clause: string, carriedEntity?: string): ClauseResolution {
  const action = matchFirst(ACTIONS, clause);
  const explicitEntity = entityOf(clause);
  const entity = explicitEntity ?? (CARRIED_PRONOUN.test(clause) ? carriedEntity : undefined);
  if (!action || !entity) return { clause, action, entity };
  const operation = OPERATION_BY_INTENT[`${action} ${entity}`];
  return { clause, action, entity, operation };
}

/** Ranked discovery candidates for a request that named no single operation. */
export function candidatesFor(query: string): LinearOperation[] {
  const words = new Set(
    query
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length > 2),
  );
  const score = (operation: LinearOperation): number => {
    const name = new Set(operation.name.split('_'));
    const purpose = new Set(operation.purpose.toLowerCase().split(/[^a-z0-9]+/));
    return [...words].reduce(
      (total, word) => total + (name.has(word) ? 8 : 0) + (operation.domain === word ? 4 : 0)
        + (purpose.has(word) ? 1 : 0),
      0,
    );
  };
  return Object.values(operations)
    .map((operation) => ({ operation, score: score(operation) }))
    .filter(({ score: value }) => value > 0)
    .sort((left, right) => right.score - left.score || (left.operation.name < right.operation.name ? -1 : 1))
    .map(({ operation }) => operation);
}

export type ActivationPlan = {
  clauses: ClauseResolution[];
  /** Catalog operation names to activate, in clause order, deduplicated. */
  operationNames: string[];
  candidates: LinearOperation[];
};

/**
 * Plan the activation for one natural help query: resolve every clause, union the
 * unambiguous winners in clause order, and offer candidates when nothing resolved.
 */
export function planActivation(query: string): ActivationPlan {
  const clauses: ClauseResolution[] = [];
  const operationNames: string[] = [];
  let carriedEntity: string | undefined;

  for (const clause of splitClauses(query)) {
    const resolution = resolveClause(clause, carriedEntity);
    clauses.push(resolution);
    if (resolution.entity) carriedEntity = resolution.entity;
    if (resolution.operation && !operationNames.includes(resolution.operation)) {
      operationNames.push(resolution.operation);
    }
  }

  return {
    clauses,
    operationNames,
    candidates: operationNames.length ? [] : candidatesFor(query),
  };
}

export function candidateSummary(operation: LinearOperation) {
  return { name: operation.name, signature: operationSignature(operation) };
}

/** S7 shadow assertion. The hand-written activation adapter remains until S8. */
export function assertActivationAdapterParity(): void {
  const unknown = [...new Set(Object.values(OPERATION_BY_INTENT))]
    .filter((name) => !operations[name]);
  if (unknown.length) {
    throw new Error(`Activation adapter references unknown operations: ${unknown.join(', ')}.`);
  }
}
