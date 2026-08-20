import { describe, expect, it } from "vitest";
import {
	projection,
	type ProjectionEntity,
	type ProjectionView,
} from "../extensions/selections";
import { operationDocuments, operations } from "../extensions/operations";

const SAME_FOR_BOTH_VIEWS = [
	"comment",
	"cycle",
	"initiative",
	"issueLabel",
	"issueRelation",
	"milestone",
	"pageInfo",
	"projectLabel",
	"projectRelation",
	"user",
	"view",
	"workflowState",
] as const satisfies readonly ProjectionEntity[];

const BASELINE: Record<ProjectionEntity, Record<ProjectionView, string>> = {
	pageInfo: {
		list: "pageInfo { hasNextPage hasPreviousPage startCursor endCursor }",
		detail: "pageInfo { hasNextPage hasPreviousPage startCursor endCursor }",
	},
	issue: {
		list: `
  id identifier number title priority url dueDate createdAt updatedAt priorityLabel
  state { id name type }
  team { id key name }
  assignee { id name }
  labels(first: 50) { nodes { id name } }
  project { id name }
`,
		detail: `
  id identifier number title description priority url branchName dueDate createdAt updatedAt
  estimate priorityLabel completedAt startedAt archivedAt trashed
  state { id name type }
  team { id key name }
  assignee { id name email }
  labels(first: 50) { nodes { id name } }
  project { id name }
  parent { id identifier title }
  cycle { id name number }
  creator { id name email }
`,
	},
	workflowState: {
		list: `
  id name type color position description createdAt updatedAt team { id key name }
`,
		detail: `
  id name type color position description createdAt updatedAt team { id key name }
`,
	},
	issueLabel: {
		list: `
  id name description color isGroup createdAt updatedAt retiredAt
  team { id key name } parent { id name }
`,
		detail: `
  id name description color isGroup createdAt updatedAt retiredAt
  team { id key name } parent { id name }
`,
	},
	project: {
		list: `
  id name state priority slugId startDate targetDate health progress priorityLabel url
  teams(first: 10) { nodes { id key name } }
  lead { id name } status { id name }
`,
		detail: `
  id name description color icon state priority slugId startDate targetDate completedAt
  canceledAt health progress startedAt archivedAt trashed priorityLabel createdAt updatedAt url
  teams(first: 10) { nodes { id key name } }
  lead { id name email } members(first: 10) { nodes { id name email } } status { id name }
  content
`,
	},
	projectLabel: {
		list: `
  id name description color isGroup createdAt updatedAt retiredAt parent { id name }
`,
		detail: `
  id name description color isGroup createdAt updatedAt retiredAt parent { id name }
`,
	},
	document: {
		list: `
  id title summary slugId url createdAt updatedAt
  team { id key name } project { id name } issue { id identifier title }
`,
		detail: `
  id title content color icon slugId sortOrder hiddenAt trashed summary archivedAt createdAt updatedAt url
  team { id key name } project { id name } issue { id identifier title } initiative { id name }
`,
	},
	comment: {
		list: `
  id body quotedText createdAt updatedAt editedAt resolvedAt url
  issue { id identifier title } parent { id } user { id name email }
`,
		detail: `
  id body quotedText createdAt updatedAt editedAt resolvedAt url
  issue { id identifier title } parent { id } user { id name email }
`,
	},
	initiative: {
		list: `
  id name description content status color icon targetDate targetDateResolution sortOrder health
  completedAt startedAt archivedAt trashed createdAt updatedAt url owner { id name email }
`,
		detail: `
  id name description content status color icon targetDate targetDateResolution sortOrder health
  completedAt startedAt archivedAt trashed createdAt updatedAt url owner { id name email }
`,
	},
	milestone: {
		list: `
  id name description status progress targetDate sortOrder createdAt updatedAt project { id name url }
`,
		detail: `
  id name description status progress targetDate sortOrder createdAt updatedAt project { id name url }
`,
	},
	issueRelation: {
		list: `
  id createdAt updatedAt type issue { id identifier title } relatedIssue { id identifier title }
`,
		detail: `
  id createdAt updatedAt type issue { id identifier title } relatedIssue { id identifier title }
`,
	},
	projectRelation: {
		list: `
  id createdAt updatedAt type anchorType relatedAnchorType project { id name }
  projectMilestone { id name } relatedProject { id name } relatedProjectMilestone { id name }
`,
		detail: `
  id createdAt updatedAt type anchorType relatedAnchorType project { id name }
  projectMilestone { id name } relatedProject { id name } relatedProjectMilestone { id name }
`,
	},
	team: {
		list: "id key name description color icon private createdAt updatedAt states(first: 50) { nodes { id name type } }",
		detail: "id key name description color icon private createdAt updatedAt",
	},
	user: {
		list: "id name displayName email active admin guest isAssignable createdAt updatedAt url",
		detail: "id name displayName email active admin guest isAssignable createdAt updatedAt url",
	},
	view: {
		list: `
  id name description icon color filterData projectFilterData initiativeFilterData feedItemFilterData
  shared slugId archivedAt createdAt updatedAt modelName team { id key name } owner { id name email }
`,
		detail: `
  id name description icon color filterData projectFilterData initiativeFilterData feedItemFilterData
  shared slugId archivedAt createdAt updatedAt modelName team { id key name } owner { id name email }
`,
	},
	cycle: {
		list: `
  id name number description startsAt endsAt completedAt archivedAt autoArchivedAt isActive isFuture
  isPast isNext isPrevious progress createdAt updatedAt team { id key name }
`,
		detail: `
  id name number description startsAt endsAt completedAt archivedAt autoArchivedAt isActive isFuture
  isPast isNext isPrevious progress createdAt updatedAt team { id key name }
`,
	},
};

function nestedPageSizes(selection: string): string[] {
	return [...selection.matchAll(/\w+\(first: \d+\)/g)].map(([match]) => match);
}

describe("projection hides field selection syntax", () => {
	it.each(Object.keys(BASELINE) as ProjectionEntity[])(
		"returns the current %s field set for list and detail",
		(entity) => {
			expect(projection(entity, "list")).toBe(BASELINE[entity].list);
			expect(projection(entity, "detail")).toBe(BASELINE[entity].detail);
		},
	);

	it("keeps nested connection page-size literals", () => {
		expect(nestedPageSizes(projection("issue", "list"))).toEqual([
			"labels(first: 50)",
		]);
		expect(nestedPageSizes(projection("issue", "detail"))).toEqual([
			"labels(first: 50)",
		]);
		expect(nestedPageSizes(projection("project", "list"))).toEqual([
			"teams(first: 10)",
		]);
		expect(nestedPageSizes(projection("project", "detail"))).toEqual([
			"teams(first: 10)",
			"members(first: 10)",
		]);
		expect(nestedPageSizes(projection("team", "list"))).toEqual([
			"states(first: 50)",
		]);
		expect(nestedPageSizes(projection("team", "detail"))).toEqual([]);
		for (const entity of SAME_FOR_BOTH_VIEWS) {
			expect(nestedPageSizes(projection(entity, "list"))).toEqual([]);
			expect(nestedPageSizes(projection(entity, "detail"))).toEqual([]);
		}
	});

	it("does not introduce extra list/detail field splits", () => {
		for (const entity of SAME_FOR_BOTH_VIEWS) {
			expect(projection(entity, "list")).toBe(projection(entity, "detail"));
		}
		expect(projection("issue", "list")).not.toContain("description");
		expect(projection("issue", "detail")).toContain("description");
		expect(projection("project", "list")).not.toContain("content");
		expect(projection("project", "detail")).toContain("content");
		expect(projection("document", "list")).not.toContain("content");
		expect(projection("document", "detail")).toContain("content");
		expect(projection("team", "list")).toBe(
			`${projection("team", "detail")} states(first: 50) { nodes { id name type } }`,
		);
	});

	it("embeds those field sets in every current operation document", () => {
		const expected: Record<string, string> = {
			list_comments: projection("comment", "list"),
			create_comment: projection("comment", "detail"),
			update_comment: projection("comment", "detail"),
			list_views: projection("view", "list"),
			get_view: projection("view", "detail"),
			create_view: projection("view", "detail"),
			update_view: projection("view", "detail"),
			list_cycles: projection("cycle", "list"),
			get_cycle: projection("cycle", "detail"),
			create_cycle: projection("cycle", "detail"),
			update_cycle: projection("cycle", "detail"),
			list_documents: projection("document", "list"),
			get_document: projection("document", "detail"),
			create_document: projection("document", "detail"),
			update_document: projection("document", "detail"),
			list_initiatives: projection("initiative", "list"),
			get_initiative: projection("initiative", "detail"),
			save_initiative: projection("initiative", "detail"),
			list_issue_labels: projection("issueLabel", "list"),
			create_issue_label: projection("issueLabel", "detail"),
			update_issue_label: projection("issueLabel", "detail"),
			list_issue_relations: projection("issueRelation", "list"),
			create_issue_relation: projection("issueRelation", "detail"),
			update_issue_relation: projection("issueRelation", "detail"),
			list_issue_statuses: projection("workflowState", "list"),
			list_issues: projection("issue", "list"),
			get_issue: projection("issue", "detail"),
			create_issue: projection("issue", "detail"),
			update_issue: projection("issue", "detail"),
			search_issues: projection("issue", "list"),
			list_milestones: projection("milestone", "list"),
			get_milestone: projection("milestone", "detail"),
			save_milestone: projection("milestone", "detail"),
			list_project_labels: projection("projectLabel", "list"),
			create_project_label: projection("projectLabel", "detail"),
			update_project_label: projection("projectLabel", "detail"),
			list_project_relations: projection("projectRelation", "list"),
			create_project_relation: projection("projectRelation", "detail"),
			update_project_relation: projection("projectRelation", "detail"),
			list_projects: projection("project", "list"),
			get_project: projection("project", "detail"),
			save_project: projection("project", "detail"),
			list_teams: projection("team", "list"),
			get_team: projection("team", "detail"),
			list_users: projection("user", "list"),
			get_user: projection("user", "detail"),
		};
		for (const [name, selection] of Object.entries(expected)) {
			for (const document of operationDocuments(operations[name]!)) {
				expect(document, name).toContain(selection);
			}
		}
		for (const document of operationDocuments(operations.list_issues!)) {
			expect(document).toContain(projection("pageInfo", "list"));
		}
	});
});
