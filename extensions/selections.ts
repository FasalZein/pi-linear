// Field sets ported from @alasano/pi-linear 0.4.1, with public summary/full
// views mapped onto the list/detail projection boundary for issue, project,
// and document reads.
export type ProjectionEntity =
  | "comment"
  | "cycle"
  | "document"
  | "initiative"
  | "issue"
  | "issueLabel"
  | "issueRelation"
  | "milestone"
  | "pageInfo"
  | "project"
  | "projectLabel"
  | "projectRelation"
  | "team"
  | "user"
  | "view"
  | "workflowState";

export type ProjectionView = "list" | "detail";
export type ResultView = "summary" | "full";
export type ResultViewEntity = "issue" | "project" | "document";

const PAGE_INFO = `pageInfo { hasNextPage hasPreviousPage startCursor endCursor }`;
const ISSUE_LABELS = `labels(first: 50) { nodes { id name } pageInfo { hasNextPage endCursor } }`;
const ISSUE_SUMMARY = `
  id identifier title url
`;
const ISSUE_FULL = `
  id identifier number title description priority url branchName dueDate createdAt updatedAt
  estimate priorityLabel completedAt startedAt archivedAt trashed
  state { id name type }
  team { id key name }
  assignee { id name email }
  ${ISSUE_LABELS}
  project { id name }
  parent { id identifier title }
  cycle { id name number }
  creator { id name email }
`;
const WORKFLOW_STATE = `
  id name type color position description createdAt updatedAt team { id key name }
`;
const ISSUE_LABEL = `
  id name description color isGroup createdAt updatedAt retiredAt
  team { id key name } parent { id name }
`;
const PROJECT_SUMMARY = `
  id name url
`;
const PROJECT_FULL = `
  id name description color icon state priority slugId startDate targetDate completedAt
  canceledAt health progress startedAt archivedAt trashed priorityLabel createdAt updatedAt url
  teams(first: 10) { nodes { id key name } pageInfo { hasNextPage endCursor } }
  lead { id name email } members(first: 10) { nodes { id name email } pageInfo { hasNextPage endCursor } } status { id name }
  content
`;
const PROJECT_LABEL = `
  id name description color isGroup createdAt updatedAt retiredAt parent { id name }
`;
const DOCUMENT_SUMMARY = `
  id title url
`;
const DOCUMENT_FULL = `
  id title content color icon slugId sortOrder hiddenAt trashed summary archivedAt createdAt updatedAt url
  team { id key name } project { id name } issue { id identifier title } initiative { id name }
`;
const COMMENT = `
  id body quotedText createdAt updatedAt editedAt resolvedAt url
  issue { id identifier title } parent { id } user { id name email }
`;
const INITIATIVE = `
  id name description content status color icon targetDate targetDateResolution sortOrder health
  completedAt startedAt archivedAt trashed createdAt updatedAt url owner { id name email }
`;
const MILESTONE = `
  id name description status progress targetDate sortOrder createdAt updatedAt project { id name url }
`;
const ISSUE_RELATION = `
  id createdAt updatedAt type issue { id identifier title } relatedIssue { id identifier title }
`;
const PROJECT_RELATION = `
  id createdAt updatedAt type anchorType relatedAnchorType project { id name }
  projectMilestone { id name } relatedProject { id name } relatedProjectMilestone { id name }
`;
const TEAM = `id key name description color icon private createdAt updatedAt`;
const USER = `id name displayName email active admin guest isAssignable createdAt updatedAt url`;
const VIEW = `
  id name description icon color filterData projectFilterData initiativeFilterData feedItemFilterData
  shared slugId archivedAt createdAt updatedAt modelName team { id key name } owner { id name email }
`;
const CYCLE = `
  id name number description startsAt endsAt completedAt archivedAt autoArchivedAt isActive isFuture
  isPast isNext isPrevious progress createdAt updatedAt team { id key name }
`;

const SELECTIONS: Record<ProjectionEntity, Record<ProjectionView, string>> = {
  comment: { list: COMMENT, detail: COMMENT },
  cycle: { list: CYCLE, detail: CYCLE },
  document: { list: DOCUMENT_SUMMARY, detail: DOCUMENT_FULL },
  initiative: { list: INITIATIVE, detail: INITIATIVE },
  issue: { list: ISSUE_SUMMARY, detail: ISSUE_FULL },
  issueLabel: { list: ISSUE_LABEL, detail: ISSUE_LABEL },
  issueRelation: { list: ISSUE_RELATION, detail: ISSUE_RELATION },
  milestone: { list: MILESTONE, detail: MILESTONE },
  pageInfo: { list: PAGE_INFO, detail: PAGE_INFO },
  project: { list: PROJECT_SUMMARY, detail: PROJECT_FULL },
  projectLabel: { list: PROJECT_LABEL, detail: PROJECT_LABEL },
  projectRelation: { list: PROJECT_RELATION, detail: PROJECT_RELATION },
  team: {
    list: `${TEAM} states(first: 50) { nodes { id name type } pageInfo { hasNextPage endCursor } }`,
    detail: TEAM,
  },
  user: { list: USER, detail: USER },
  view: { list: VIEW, detail: VIEW },
  workflowState: { list: WORKFLOW_STATE, detail: WORKFLOW_STATE },
};

export function projection(entity: ProjectionEntity, view: ProjectionView): string {
  return SELECTIONS[entity][view];
}

export function projectionViewFor(view: ResultView): ProjectionView {
  return view === "summary" ? "list" : "detail";
}

export function parseResultView(value: unknown, fallback: ResultView): ResultView {
  if (value === undefined) return fallback;
  if (value === "summary" || value === "full") return value;
  throw new Error('view must be "summary" or "full"');
}
