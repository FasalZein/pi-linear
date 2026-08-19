/** Ordered phrase precedence used to project natural discovery metadata. */
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

function singular(value: string): string {
  if (value.endsWith('statuses')) return `${value.slice(0, -8)}status`;
  if (value.endsWith('ies')) return `${value.slice(0, -3)}y`;
  return value.endsWith('s') ? value.slice(0, -1) : value;
}

function intentsFor(name: string): Array<{ action: string; entity: string }> {
  const [operationAction, ...parts] = name.split('_');
  const entity = singular(parts.join('_'));
  if (operationAction === 'save') {
    return ['create', 'update', 'save'].map((action) => ({ action, entity }));
  }
  return [{ action: operationAction!, entity }];
}

/** Project exact intents and phrases from the operation name, or from declared intents. */
export function discoveryForOperation(
  name: string,
  declaredIntents?: readonly { action: string; entity: string }[],
) {
  const intents = declaredIntents?.length ? [...declaredIntents] : intentsFor(name);
  const actions = [...new Set(intents.map(({ action }) => action))];
  const entities = [...new Set(intents.map(({ entity }) => entity))];
  const phrases = [
    ...DEFINITION_ACTIONS.filter(([, value]) => actions.includes(value)).map(([pattern]) => pattern.source),
    ...DEFINITION_ENTITIES.filter(([, value]) => entities.includes(value)).map(([pattern]) => pattern.source),
  ];
  return { actions, entities, intents, phrases };
}
