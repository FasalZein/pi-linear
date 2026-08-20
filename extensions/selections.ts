// Field sets ported from @alasano/pi-linear 0.4.1.
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

const PAGE_INFO = `pageInfo { hasNextPage hasPreviousPage startCursor endCursor }`;
const ISSUE = `
  id identifier number title description priority url branchName dueDate createdAt updatedAt
  estimate priorityLabel completedAt startedAt archivedAt trashed
  state { id name type }
  team { id key name }
  assignee { id name email }
  labels { nodes { id name } }
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
const PROJECT = `
  id name description color icon state priority slugId startDate targetDate completedAt
  canceledAt health progress startedAt archivedAt trashed priorityLabel createdAt updatedAt url
  teams(first: 10) { nodes { id key name } }
  lead { id name email } members(first: 10) { nodes { id name email } } status { id name }
`;
const PROJECT_LABEL = `
  id name description color isGroup createdAt updatedAt retiredAt parent { id name }
`;
const DOCUMENT = `
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
  document: { list: DOCUMENT, detail: DOCUMENT },
  initiative: { list: INITIATIVE, detail: INITIATIVE },
  issue: { list: ISSUE, detail: ISSUE },
  issueLabel: { list: ISSUE_LABEL, detail: ISSUE_LABEL },
  issueRelation: { list: ISSUE_RELATION, detail: ISSUE_RELATION },
  milestone: { list: MILESTONE, detail: MILESTONE },
  pageInfo: { list: PAGE_INFO, detail: PAGE_INFO },
  project: { list: PROJECT, detail: `${PROJECT} content` },
  projectLabel: { list: PROJECT_LABEL, detail: PROJECT_LABEL },
  projectRelation: { list: PROJECT_RELATION, detail: PROJECT_RELATION },
  team: {
    list: `${TEAM} states(first: 50) { nodes { id name type } }`,
    detail: TEAM,
  },
  user: { list: USER, detail: USER },
  view: { list: VIEW, detail: VIEW },
  workflowState: { list: WORKFLOW_STATE, detail: WORKFLOW_STATE },
};

export function projection(entity: ProjectionEntity, view: ProjectionView): string {
  return SELECTIONS[entity][view];
}
