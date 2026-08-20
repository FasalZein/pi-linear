import { Kind, parse } from "graphql";
import { afterEach, describe, expect, it, vi } from "vitest";
import { linearApiTool, resolveRequest } from "../extensions/api";
import { operations } from "../extensions/operations";
import { isolateLinearCredentials } from "./helpers/credentials";

isolateLinearCredentials();

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const TEAM = "33333333-3333-4333-8333-333333333333";
const STATE = "44444444-4444-4444-8444-444444444444";

type Fixture = {
	name: string;
	variables: Record<string, unknown>;
	root: string;
	expectedVariables: Record<string, unknown>;
	rejectsEmpty: boolean;
	kind?: "local";
};
const f = (
	name: string,
	variables: Record<string, unknown>,
	root: string,
	expectedVariables: Record<string, unknown>,
	rejectsEmpty: boolean,
	kind?: "local",
): Fixture => ({
	name,
	variables,
	root,
	expectedVariables,
	rejectsEmpty,
	kind,
});

// Manually maintained from upstream 0.4.1 documents, defaults, and input merge behavior.
const UPSTREAM_MATRIX: Fixture[] = [
	f("list_comments", {}, "comments", { first: 20 }, false),
	f(
		"create_comment",
		{ issue: A, body: "Hi" },
		"commentCreate",
		{ input: { body: "Hi", issueId: A } },
		true,
	),
	f(
		"update_comment",
		{ id: A, body: "Hi" },
		"commentUpdate",
		{ id: A, input: { body: "Hi" } },
		true,
	),
	f("list_views", {}, "customViews", { first: 50 }, false),
	f("get_view", { id: A }, "customView", { id: A }, true),
	f(
		"create_view",
		{ name: "Mine", filterData: {} },
		"customViewCreate",
		{ input: { name: "Mine", filterData: {} } },
		true,
	),
	f(
		"update_view",
		{ id: A, name: "Mine" },
		"customViewUpdate",
		{ id: A, input: { name: "Mine" } },
		true,
	),
	f(
		"set_view_preferences",
		{ viewId: A, preferences: {} },
		"viewPreferencesCreate",
		{
			input: {
				type: "user",
				viewType: "customView",
				customViewId: A,
				preferences: {},
			},
		},
		true,
	),
	f("list_cycles", {}, "cycles", { first: 50 }, false),
	f("get_cycle", { cycle: A }, "cycle", { id: A }, true),
	f(
		"create_cycle",
		{ team: TEAM, startsAt: "2026-01-01", endsAt: "2026-01-15" },
		"cycleCreate",
		{ input: { startsAt: "2026-01-01", endsAt: "2026-01-15", teamId: TEAM } },
		true,
	),
	f(
		"update_cycle",
		{ id: A, name: "Cycle" },
		"cycleUpdate",
		{ id: A, input: { name: "Cycle" } },
		true,
	),
	f("list_documents", {}, "documents", { first: 20 }, false),
	f("get_document", { document: A }, "document", { id: A }, true),
	f(
		"create_document",
		{ title: "Notes" },
		"documentCreate",
		{ input: { title: "Notes" } },
		true,
	),
	f(
		"update_document",
		{ documentId: A, title: "Notes" },
		"documentUpdate",
		{ id: A, input: { title: "Notes" } },
		true,
	),
	f("list_initiatives", {}, "initiatives", { first: 20 }, false),
	f("get_initiative", { initiative: A }, "initiative", { id: A }, true),
	f(
		"save_initiative",
		{ name: "Initiative" },
		"initiativeCreate",
		{ input: { name: "Initiative" } },
		true,
	),
	f("list_issue_labels", {}, "issueLabels", { first: 50 }, false),
	f(
		"create_issue_label",
		{ name: "Label" },
		"issueLabelCreate",
		{ input: { name: "Label" } },
		true,
	),
	f(
		"update_issue_label",
		{ id: A, name: "Label" },
		"issueLabelUpdate",
		{ id: A, input: { name: "Label" } },
		true,
	),
	f("list_issue_relations", {}, "issueRelations", { first: 20 }, false),
	f(
		"create_issue_relation",
		{ issue: A, relatedIssue: B, type: "related" },
		"issueRelationCreate",
		{ input: { issueId: A, relatedIssueId: B, type: "related" } },
		true,
	),
	f(
		"update_issue_relation",
		{ id: A, type: "blocks" },
		"issueRelationUpdate",
		{ id: A, input: { type: "blocks" } },
		true,
	),
	f("list_issue_statuses", {}, "workflowStates", { first: 50 }, false),
	f(
		"list_issues",
		{ stateType: "started" },
		"issues",
		{ first: 20, filter: { state: { type: { eq: "started" } } } },
		false,
	),
	f("get_issue", { issue: A }, "issue", { id: A }, true),
	f(
		"create_issue",
		{ title: "Issue", team: TEAM },
		"issueCreate",
		{ input: { title: "Issue", teamId: TEAM } },
		true,
	),
	f(
		"update_issue",
		{ issue: A, title: "Issue" },
		"issueUpdate",
		{ id: A, input: { title: "Issue" } },
		true,
	),
	f(
		"search_issues",
		{ term: "issue" },
		"searchIssues",
		{ first: 20, term: "issue" },
		true,
	),
	f("list_milestones", {}, "projectMilestones", { first: 20 }, false),
	f("get_milestone", { milestone: A }, "projectMilestone", { id: A }, true),
	f(
		"save_milestone",
		{ name: "Beta", projectId: B },
		"projectMilestoneCreate",
		{ input: { name: "Beta", projectId: B } },
		true,
	),
	f("list_project_labels", {}, "projectLabels", { first: 50 }, false),
	f(
		"create_project_label",
		{ name: "Label" },
		"projectLabelCreate",
		{ input: { name: "Label" } },
		true,
	),
	f(
		"update_project_label",
		{ id: A, name: "Label" },
		"projectLabelUpdate",
		{ id: A, input: { name: "Label" } },
		true,
	),
	f("list_project_relations", {}, "projectRelations", { first: 20 }, false),
	f(
		"create_project_relation",
		{
			projectId: A,
			relatedProjectId: B,
			type: "related",
			anchorType: "project",
			relatedAnchorType: "project",
		},
		"projectRelationCreate",
		{
			input: {
				projectId: A,
				relatedProjectId: B,
				type: "related",
				anchorType: "project",
				relatedAnchorType: "project",
			},
		},
		true,
	),
	f(
		"update_project_relation",
		{ id: A, type: "related" },
		"projectRelationUpdate",
		{ id: A, input: { type: "related" } },
		true,
	),
	f("list_projects", {}, "projects", { first: 20 }, false),
	f("get_project", { project: A }, "project", { id: A }, true),
	f(
		"save_project",
		{ name: "Project", teamIds: [TEAM] },
		"projectCreate",
		{ input: { name: "Project", teamIds: [TEAM] } },
		true,
	),
	f("list_teams", {}, "teams", { first: 50 }, false),
	f("get_team", { team: TEAM }, "team", { id: TEAM }, true),
	f("list_users", {}, "users", { first: 50 }, false),
	f("get_user", { user: "me" }, "user", { id: A }, true),
	f(
		"switch_workspace",
		{ name: "work" },
		"local",
		{ name: "work" },
		true,
		"local",
	),
];

const BRANCH_AND_LEGACY_FIXTURES: Fixture[] = [
	f(
		"save_initiative",
		{ initiativeId: A, name: "Updated" },
		"initiativeUpdate",
		{ id: A, input: { name: "Updated" } },
		true,
	),
	f(
		"save_milestone",
		{ milestoneId: A, name: "Updated" },
		"projectMilestoneUpdate",
		{ id: A, input: { name: "Updated" } },
		true,
	),
	f(
		"save_project",
		{ projectId: A, name: "Updated" },
		"projectUpdate",
		{ id: A, input: { name: "Updated" } },
		true,
	),
	f(
		"add_comment",
		{ issueId: A, body: "Legacy" },
		"commentCreate",
		{ input: { issueId: A, body: "Legacy" } },
		true,
	),
	f(
		"create_relation",
		{ issueId: A, relatedIssueId: B, type: "related" },
		"issueRelationCreate",
		{ input: { issueId: A, relatedIssueId: B, type: "related" } },
		true,
	),
	f("list_workflow_states", {}, "workflowStates", { first: 50 }, false),
	f(
		"update_issue_state",
		{ issueId: A, stateId: STATE },
		"issueUpdate",
		{ id: A, input: { stateId: STATE } },
		true,
	),
	f("get_issue", { teamKey: "ENG", number: 7 }, "issue", { id: "ENG-7" }, true),
	f(
		"create_issue",
		{ input: { title: "Legacy", teamId: TEAM } },
		"issueCreate",
		{ input: { title: "Legacy", teamId: TEAM } },
		true,
	),
	f(
		"create_document",
		{ input: { title: "Legacy" } },
		"documentCreate",
		{ input: { title: "Legacy" } },
		true,
	),
	f(
		"create_issue_label",
		{ input: { name: "Legacy" } },
		"issueLabelCreate",
		{ input: { name: "Legacy" } },
		true,
	),
	f(
		"create_project_label",
		{ input: { name: "Legacy" } },
		"projectLabelCreate",
		{ input: { name: "Legacy" } },
		true,
	),
	f(
		"create_cycle",
		{ teamKey: "ENG", startsAt: "2026-01-01", endsAt: "2026-01-15" },
		"cycleCreate",
		{ input: { startsAt: "2026-01-01", endsAt: "2026-01-15", teamId: TEAM } },
		true,
	),
	f(
		"create_cycle",
		{ teamId: TEAM, startsAt: "2026-01-01", endsAt: "2026-01-15" },
		"cycleCreate",
		{ input: { startsAt: "2026-01-01", endsAt: "2026-01-15", teamId: TEAM } },
		true,
	),
	f(
		"create_comment",
		{ input: { issueId: A, body: "Raw" } },
		"commentCreate",
		{ input: { issueId: A, body: "Raw" } },
		true,
	),
	f("get_cycle", { id: A }, "cycle", { id: A }, true),
	f("get_document", { documentId: A }, "document", { id: A }, true),
	f("get_initiative", { initiativeId: A }, "initiative", { id: A }, true),
	f("get_milestone", { milestoneId: A }, "projectMilestone", { id: A }, true),
	f("get_project", { projectId: A }, "project", { id: A }, true),
	f("get_team", { teamId: TEAM }, "team", { id: TEAM }, true),
	f("get_user", { userId: A }, "user", { id: A }, true),
	f(
		"list_issues",
		{
			first: 10,
			filter: { priority: { eq: 1 } },
			sort: [{ priority: "Ascending" }],
		},
		"issues",
		{
			first: 10,
			filter: { priority: { eq: 1 } },
			sort: [{ priority: "Ascending" }],
		},
		false,
	),
	f(
		"search_issues",
		{ term: "legacy", first: 10, filter: { priority: { eq: 1 } } },
		"searchIssues",
		{ first: 10, term: "legacy", filter: { priority: { eq: 1 } } },
		true,
	),
];

function root(document: string): string {
	const definition = parse(document).definitions.find(
		(entry) => entry.kind === Kind.OPERATION_DEFINITION,
	);
	if (!definition || definition.kind !== Kind.OPERATION_DEFINITION)
		throw new Error("Missing operation.");
	const selection = definition.selectionSet.selections[0];
	if (!selection || selection.kind !== Kind.FIELD)
		throw new Error("Missing root field.");
	return selection.name.value;
}

function installResolvers() {
	const fetch = vi.fn(async (_url: string, init: RequestInit) => {
		const { query, variables } = JSON.parse(String(init.body));
		let data: Record<string, unknown>;
		if (query.includes("ResolveIssueByIdentifier"))
			data = {
				issues: {
					nodes: [
						{ id: A, identifier: "ENG-7", team: { id: TEAM, key: "ENG" } },
					],
				},
			};
		else if (query.includes("ResolveIssueById")) {
			const id = String(variables.id);
			const named = /^[A-Z]+-\d+$/i.test(id);
			data = {
				issue: {
					id: named ? A : id,
					identifier: named ? id.toUpperCase() : id === B ? "ENG-8" : "ENG-7",
					team: { id: TEAM, key: "ENG" },
				},
			};
		}
		else if (query.includes("ResolveTeamById"))
			data = { team: { id: variables.id, key: "ENG" } };
		else if (query.includes("ResolveTeamByKey"))
			data = { teams: { nodes: [{ id: TEAM, key: "ENG" }] } };
		else if (query.includes("ResolveViewer"))
			data = { viewer: { id: A, name: "Viewer" } };
		else if (query.includes("ResolveUserById"))
			data = { user: { id: variables.id, name: "User" } };
		else if (query.includes("ResolveStateById"))
			data = {
				workflowState: {
					id: variables.id,
					name: "Backlog",
					team: { id: TEAM },
				},
			};
		else if (query.includes("ResolveStateByName"))
			data = {
				workflowStates: {
					nodes: [{ id: STATE, name: variables.name, team: { id: TEAM } }],
				},
			};
		else if (query.includes("ResolveDocumentById"))
			data = { document: { id: variables.id, title: "Resolved" } };
		else if (query.includes("ResolveNamedEntityById")) {
			const key = query.includes("projectMilestone(")
				? "projectMilestone"
				: query.includes("initiative(")
					? "initiative"
					: query.includes("document(")
						? "document"
						: query.includes("cycle(")
							? "cycle"
							: "project";
			data = { [key]: { id: variables.id, name: "Resolved" } };
		} else throw new Error(`Unexpected resolver query: ${query}`);
		return {
			ok: true,
			status: 200,
			statusText: "OK",
			headers: new Headers(),
			json: async () => ({ data }),
		};
	});
	vi.stubGlobal("fetch", fetch);
	return fetch;
}

afterEach(() => vi.unstubAllGlobals());

describe("independent upstream operation matrix", () => {
	it("covers all 48 canonical operations exactly once", () => {
		expect(UPSTREAM_MATRIX.map(({ name }) => name).sort()).toEqual(
			Object.keys(operations).sort(),
		);
	});

	it.each([
		...UPSTREAM_MATRIX,
		...BRANCH_AND_LEGACY_FIXTURES,
	])("accepts $name and prepares the exact final request", async (fixture) => {
		installResolvers();
		const request = resolveRequest({
			operation: fixture.name,
			variables: fixture.variables,
		});
		if (!request.named) throw new Error("Expected named operation.");
		if (fixture.kind === "local") {
			expect(request.operation.executeLocal).toBeTypeOf("function");
			expect(fixture.variables).toEqual(fixture.expectedVariables);
			return;
		}
		const prepared = request.operation.prepare
			? await request.operation.prepare(
					"test-key",
					fixture.variables,
					undefined,
				)
			: { variables: fixture.variables };
		expect(root(prepared.variant?.document ?? request.query)).toBe(fixture.root);
		expect(prepared.variables).toEqual(fixture.expectedVariables);
	});

	it.each(
		UPSTREAM_MATRIX.filter(({ rejectsEmpty }) => rejectsEmpty),
	)("rejects an empty $name request before network access", async (fixture) => {
		const fetch = vi.fn();
		vi.stubGlobal("fetch", fetch);
		const tool = linearApiTool() as any;
		const error = await tool
			.execute(
				"call",
				{ operation: fixture.name, variables: {} },
				undefined,
				undefined,
				{ hasUI: false },
			)
			.then(
				() => new Error("Expected local validation failure."),
				(value: unknown) =>
					value instanceof Error ? value : new Error(String(value)),
			);
		expect(error.message).toContain(`Invalid parameters for "${fixture.name}"`);
		expect(error.message).toContain("Valid parameters:");
		expect(error.message).toContain("Example:");
		expect(fetch).not.toHaveBeenCalled();
	});

	it("rejects contradictory mixed shapes before network access", async () => {
		const fetch = vi.fn();
		vi.stubGlobal("fetch", fetch);
		const tool = linearApiTool() as any;
		for (const request of [
			{
				operation: "get_issue",
				variables: { issue: "ENG-7", teamKey: "ENG", number: 7 },
			},
			{
				operation: "create_cycle",
				variables: {
					team: "ENG",
					teamKey: "OPS",
					startsAt: "2026-01-01",
					endsAt: "2026-01-15",
				},
			},
		]) {
			await expect(
				tool.execute("call", request, undefined, undefined, { hasUI: false }),
			).rejects.toThrow("parameters do not match one accepted shape");
		}
		expect(fetch).not.toHaveBeenCalled();
	});

	it("keeps explicitly represented top-level plus raw input forms", () => {
		expect(() =>
			resolveRequest({
				operation: "create_document",
				variables: { title: "Top", input: { content: "Raw" } },
			}),
		).not.toThrow();
		expect(() =>
			resolveRequest({
				operation: "create_issue_label",
				variables: { name: "Top", input: { color: "#fff" } },
			}),
		).not.toThrow();
		expect(() =>
			resolveRequest({
				operation: "create_document",
				variables: { input: { title: "Raw" }, content: "Top" },
			}),
		).not.toThrow();
	});
});
