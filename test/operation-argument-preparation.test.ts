import { afterEach, describe, expect, it, vi } from "vitest";
import { linearBatchTool, resolveRequest } from "../extensions/api";
import { operations } from "../extensions/operations";
import { isolateLinearCredentials } from "./helpers/credentials";
import { prepareOperation } from "./helpers/operation-plan";
import type { CompatibilityObject } from "../extensions/operation-types";

isolateLinearCredentials();

const INITIATIVE_ID = "11111111-1111-4111-8111-111111111111";
const PROJECT_ID = "22222222-2222-4222-8222-222222222222";
const MILESTONE_ID = "33333333-3333-4333-8333-333333333333";

async function prepare(name: string, variables: CompatibilityObject) {
	const operation = operations[name];
	if (!operation) throw new Error(`${name} has no operation.`);
	return prepareOperation(operation, variables);
}

function graphqlStub(
	responder: (
		query: string,
		variables: CompatibilityObject,
	) => CompatibilityObject,
) {
	const requests: Array<{ query: string; variables: CompatibilityObject }> =
		[];
	const fetch = vi.fn(async (_url: string, init: RequestInit) => {
		const request = JSON.parse(String(init.body));
		requests.push(request);
		return {
			ok: true,
			status: 200,
			statusText: "OK",
			headers: new Headers(),
			json: async () => ({ data: responder(request.query, request.variables) }),
		};
	});
	vi.stubGlobal("fetch", fetch);
	return { fetch, requests };
}

afterEach(() => vi.unstubAllGlobals());

describe("loader create_issue compatibility", () => {
	it("converts project and labels aliases into canonical mutation input", async () => {
		const { requests } = graphqlStub((query) => {
			if (query.includes("ResolveNamedEntityByReference")) {
				return { matches: { nodes: [{ id: PROJECT_ID, name: "Dispatch", slugId: "dispatch" }] } };
			}
			if (query.includes("issueLabel(id:")) return { issueLabel: { id: MILESTONE_ID, name: "Reference" } };
			return { teams: { nodes: [{ id: INITIATIVE_ID, key: "AEO" }] } };
		});
		resolveRequest({ operation: "create_issue", variables: {
			title: "Fix dispatch", team: "AEO", project: "Dispatch", labels: [MILESTONE_ID],
		} });
		const result = await prepare("create_issue", {
			title: "Fix dispatch", team: "AEO", project: "Dispatch", labels: [MILESTONE_ID],
		});
		expect(requests).toHaveLength(3);
		expect(result.variables.input).toMatchObject({ projectId: PROJECT_ID, labelIds: [MILESTONE_ID] });
		expect(result.variables.input).not.toHaveProperty("project");
		expect(result.variables.input).not.toHaveProperty("labels");
	});

	it("accepts UUID project alias without a project lookup and preserves nested canonical input", async () => {
		const { requests } = graphqlStub(() => ({ teams: { nodes: [{ id: INITIATIVE_ID, key: "AEO" }] } }));
		const alias = await prepare("create_issue", { title: "T", team: "AEO", project: PROJECT_ID });
		expect(alias.variables.input).toMatchObject({ projectId: PROJECT_ID });
		const nested = await prepare("create_issue", {
			title: "T", team: "AEO", input: { projectId: PROJECT_ID, labelIds: [MILESTONE_ID] },
		});
		expect(nested.variables.input).toMatchObject({ projectId: PROJECT_ID, labelIds: [MILESTONE_ID] });
		expect(requests).toHaveLength(2);
	});

	it("executes nested canonical projectId and labelIds through normal mutation preparation", async () => {
		const original = process.env.LINEAR_API_KEY;
		process.env.LINEAR_API_KEY = "test-key";
		const { requests } = graphqlStub((query) => {
			if (query.includes("issueCreate")) {
				const alias = query.match(/(\w+):\s*issueCreate/)?.[1] ?? "issueCreate";
				return { [alias]: { success: true, issue: { id: INITIATIVE_ID, identifier: "AEO-9", title: "T" } } };
			}
			const alias = query.match(/(\w+):\s*teams/)?.[1] ?? "teams";
			return { [alias]: { nodes: [{ id: INITIATIVE_ID, key: "AEO" }] } };
		});
		try {
			const result = await (linearBatchTool() as any).execute(
				"call", { mutations: [{
					operation: "create_issue",
					variables: { title: "T", team: "AEO", input: { projectId: PROJECT_ID, labelIds: [MILESTONE_ID] } },
				}] }, undefined, undefined, { hasUI: false },
			);
			expect(requests).toHaveLength(2);
			expect(result.details.data.create_issue.issueCreate.issue.identifier).toBe("AEO-9");
			expect(JSON.stringify(result)).not.toContain("Operation aborted");
		} finally {
			if (original === undefined) delete process.env.LINEAR_API_KEY;
			else process.env.LINEAR_API_KEY = original;
		}
	});

	it.each([
		[{ project: "Dispatch", projectId: PROJECT_ID }, /project/],
		[{ project: "Dispatch", input: { projectId: PROJECT_ID } }, /project/],
		[{ labels: [MILESTONE_ID], labelIds: [MILESTONE_ID] }, /labels/],
		[{ labels: [MILESTONE_ID], input: { labelIds: [MILESTONE_ID] } }, /labels/],
	])("rejects conflicting create aliases before mutation preparation", (extra, message) => {
		expect(() => resolveRequest({ operation: "create_issue", variables: { title: "T", team: "AEO", ...extra } }))
			.toThrow(message);
	});

	it.each([
		[{ project: "" }, /project/],
		[{ labels: [] }, /labels/],
		[{ labels: [" "] }, /labels/],
		[{ labelIds: ["bad"] }, /labelIds/],
	])("rejects malformed create aliases before any network request", async (extra, message) => {
		const fetch = vi.fn();
		vi.stubGlobal("fetch", fetch);
		expect(() => resolveRequest({
			operation: "create_issue", variables: { title: "T", team: "AEO", ...extra },
		})).toThrow(message);
		expect(fetch).not.toHaveBeenCalled();
	});
});

describe("comment list convenience preparation", () => {
	it("resolves an exact issue reference into a valid CommentFilter", async () => {
		const { requests } = graphqlStub((query) =>
			query.includes("ResolveIssueById")
				? {
					issue: {
						id: INITIATIVE_ID,
						identifier: "AEO-258",
						team: { id: PROJECT_ID, key: "AEO" },
					},
				}
				: {},
		);

		const result = await prepare("list_comments", {
			issue: "AEO-258",
			first: 10,
			orderBy: "createdAt",
		});

		expect(requests).toHaveLength(1);
		expect(result.variables).toEqual({
			first: 10,
			orderBy: "createdAt",
			filter: { issue: { id: { eq: INITIATIVE_ID } } },
		});
		expect(result.resolution).toEqual({
			target: {
				requested: "AEO-258",
				resolvedId: INITIATIVE_ID,
				identifier: "AEO-258",
			},
		});
	});
});

describe("upstream-equivalent issue label preparation", () => {
	it("passes replaceTeamLabels as a create root argument for top-level and raw input calls", async () => {
		const topLevel = await prepare("create_issue_label", {
			name: "Review",
			color: "#f00",
			replaceTeamLabels: true,
		});
		expect(topLevel.variant).toBeUndefined();
		expect(operations.create_issue_label.document).toContain(
			"mutation CreateIssueLabel($input: IssueLabelCreateInput!, $replaceTeamLabels: Boolean)",
		);
		expect(operations.create_issue_label.document).toContain(
			"issueLabelCreate(input: $input, replaceTeamLabels: $replaceTeamLabels)",
		);
		expect(topLevel.variables).toEqual({
			input: { name: "Review", color: "#f00" },
			replaceTeamLabels: true,
		});

		const raw = await prepare("create_issue_label", {
			input: { name: "Raw", replaceTeamLabels: false },
		});
		expect(raw.variables).toEqual({
			input: { name: "Raw" },
			replaceTeamLabels: false,
		});
	});

	it("passes replaceTeamLabels as an update root argument for top-level and raw input calls", async () => {
		const topLevel = await prepare("update_issue_label", {
			id: "label-id",
			name: "Updated",
			replaceTeamLabels: true,
		});
		expect(operations.update_issue_label.document).toContain(
			"mutation UpdateIssueLabel($id: String!, $input: IssueLabelUpdateInput!, $replaceTeamLabels: Boolean)",
		);
		expect(operations.update_issue_label.document).toContain(
			"issueLabelUpdate(id: $id, input: $input, replaceTeamLabels: $replaceTeamLabels)",
		);
		expect(topLevel.variables).toEqual({
			id: "label-id",
			input: { name: "Updated" },
			replaceTeamLabels: true,
		});

		const raw = await prepare("update_issue_label", {
			id: "label-id",
			input: { color: "#0f0", replaceTeamLabels: false },
		});
		expect(raw.variables).toEqual({
			id: "label-id",
			input: { color: "#0f0" },
			replaceTeamLabels: false,
		});
	});
});

describe("exact upstream pagination and create-view discovery", () => {
	it("uses 50 as the list_views and list_cycles default in metadata and final variables", async () => {
		for (const name of ["list_views", "list_cycles"] as const) {
			expect(operations[name].pagination?.defaultPageSize).toBe(50);
			expect((await prepare(name, {})).variables).toEqual({ first: 50 });
		}
	});

	it("resolves a cycle team key and keeps the 50-item default in final variables", async () => {
		const teamId = "44444444-4444-4444-8444-444444444444";
		const { requests } = graphqlStub((query, variables) => {
			expect(query).toContain("query ResolveTeamByKey($key: String!)");
			expect(variables).toEqual({ key: "ENG" });
			return { teams: { nodes: [{ id: teamId, key: "ENG" }] } };
		});
		const prepared = await prepare("list_cycles", { team: "eng" });
		expect(requests).toHaveLength(1);
		expect(prepared.variables).toEqual({
			first: 50,
			filter: { team: { id: { eq: teamId } } },
		});
	});

	it("shows and accepts each alternative create_view filter without advertising raw input", async () => {
		const operation = operations.create_view;
		expect(operation.purpose).toContain(
			"filterData, projectFilterData, initiativeFilterData, or feedItemFilterData",
		);
		expect(
			operation.parameters.find(({ name }) => name === "name")?.required,
		).toBe(true);
		expect(operation.parameters.map(({ name }) => name)).toEqual([
			"name",
			"filterData",
			"projectFilterData",
			"initiativeFilterData",
			"feedItemFilterData",
			"team",
			"view",
		]);
		for (const parameter of operation.parameters.filter(({ name }) =>
			name.endsWith("FilterData"),
		)) {
			expect(parameter.required).toBe(false);
			expect(() =>
				resolveRequest({
					operation: "create_view",
					variables: { name: "View", [parameter.name]: {} },
				}),
			).not.toThrow();
			expect(
				(
					await prepare("create_view", {
						name: "View",
						[parameter.name]: { foo: "bar" },
					})
				).variables,
			).toEqual({
				input: { name: "View", [parameter.name]: { foo: "bar" } },
			});
		}
		expect(operation.parameters.some(({ name }) => name === "input")).toBe(
			false,
		);
	});

	it("rejects create_view without a name before any network call", async () => {
		const fetch = vi.fn();
		vi.stubGlobal("fetch", fetch);
		expect(() => resolveRequest({
			operation: "create_view", variables: { filterData: {} },
		})).toThrow('Invalid parameters for "create_view": missing name');
		expect(fetch).not.toHaveBeenCalled();
	});
});

describe("fail-closed list_issues state preparation", () => {
	it("rejects a state name without team before credential or network access", async () => {
		const fetch = vi.fn();
		vi.stubGlobal("fetch", fetch);
		expect(() => resolveRequest({
			operation: "list_issues", variables: { state: "In Progress" },
		})).toThrow(
			'team is required when state is a name. For cross-team calls, use { "assignee": "me", "stateType": "started" }',
		);
		expect(() => resolveRequest({
			operation: "list_issues", variables: { state: 42 },
		})).toThrow("state must be a non-empty UUID");
		expect(fetch).not.toHaveBeenCalled();
	});

	it("verifies an exact state UUID without team before adding it to the filter", async () => {
		const stateId = "55555555-5555-4555-8555-555555555555";
		const teamId = "66666666-6666-4666-8666-666666666666";
		const { requests } = graphqlStub((query, variables) => {
			expect(query).toContain("query ResolveStateById($id: String!)");
			expect(variables).toEqual({ id: stateId });
			return {
				workflowState: { id: stateId, name: "Started", team: { id: teamId } },
			};
		});
		const prepared = await prepare("list_issues", { state: stateId });
		expect(requests).toHaveLength(1);
		expect(prepared.variables).toEqual({
			first: 20,
			filter: { state: { id: { eq: stateId } } },
		});
	});

	it("rejects a missing state UUID instead of forwarding it unchecked", async () => {
		const stateId = "55555555-5555-4555-8555-555555555555";
		graphqlStub(() => ({ workflowState: null }));
		await expect(prepare("list_issues", { state: stateId })).rejects.toThrow(
			`Linear state "${stateId}" was not found.`,
		);
	});

	it("resolves team plus exact state name in that team", async () => {
		const teamId = "66666666-6666-4666-8666-666666666666";
		const stateId = "55555555-5555-4555-8555-555555555555";
		const { requests } = graphqlStub((query, variables) => {
			if (query.includes("ResolveTeamByKey")) {
				expect(variables).toEqual({ key: "ENG" });
				return { teams: { nodes: [{ id: teamId, key: "ENG" }] } };
			}
			expect(query).toContain(
				"query ResolveStateByName($teamId: ID!, $name: String!)",
			);
			expect(variables).toEqual({ teamId, name: "In Progress" });
			return {
				workflowStates: {
					nodes: [{ id: stateId, name: "In Progress", team: { id: teamId } }],
				},
			};
		});
		const prepared = await prepare("list_issues", {
			team: "ENG",
			state: "In Progress",
		});
		expect(requests).toHaveLength(2);
		expect(prepared.variables).toEqual({
			first: 20,
			filter: { team: { id: { eq: teamId } }, state: { id: { eq: stateId } } },
		});
	});

	it("uses stateType started across teams without a state resolver", async () => {
		const fetch = vi.fn();
		vi.stubGlobal("fetch", fetch);
		const prepared = await prepare("list_issues", { stateType: "started" });
		expect(prepared.variables).toEqual({
			first: 20,
			filter: { state: { type: { eq: "started" } } },
		});
		expect(fetch).not.toHaveBeenCalled();
	});
});

describe("update_issue final request", () => {
	it.each([
		["identifier and state name", "AEO-266", "Backlog"],
		["identifier and state UUID", "AEO-266", MILESTONE_ID],
		["issue UUID and state name", INITIATIVE_ID, "Backlog"],
		["issue UUID and state UUID", INITIATIVE_ID, MILESTONE_ID],
	])("prepares exact id and input variables for %s", async (_label, issueReference, stateReference) => {
		const issueId = INITIATIVE_ID;
		const teamId = PROJECT_ID;
		const stateId = MILESTONE_ID;
		graphqlStub((query, variables) => {
			if (query.includes("ResolveIssueById")) {
				expect(variables).toEqual({ id: issueReference });
				return { issue: { id: issueId, identifier: "AEO-266", team: { id: teamId, key: "AEO" } } };
			}
			if (query.includes("ResolveStateByName")) {
				expect(variables).toEqual({ teamId, name: "Backlog" });
				return { workflowStates: { nodes: [{ id: stateId, name: "Backlog", team: { id: teamId } }] } };
			}
			expect(query).toContain("ResolveStateById");
			expect(variables).toEqual({ id: stateId });
			return { workflowState: { id: stateId, name: "Backlog", team: { id: teamId } } };
		});

		const prepared = await prepare("update_issue", { issue: issueReference, state: stateReference });
		expect(operations.update_issue.document).toContain(
			"mutation UpdateIssue($id: String! $input: IssueUpdateInput!)",
		);
		expect(operations.update_issue.document).toContain(
			"issueUpdate(id: $id, input: $input)",
		);
		expect(prepared.variables).toEqual({ id: issueReference, input: { stateId } });
		expect(prepared.resolution?.target).toEqual({
			requested: issueReference,
			resolvedId: issueId,
			identifier: "AEO-266",
		});
	});
});

describe("save operation mode validation and branch preparation", () => {
	it("prepares valid create branches from top-level and raw input fields", async () => {
		const initiative = await prepare("save_initiative", {
			name: "Platform",
			color: "#123",
		});
		expect(initiative.variant?.document).toContain(
			"mutation CreateInitiative($input: InitiativeCreateInput!)",
		);
		expect(initiative.variables).toEqual({
			input: { name: "Platform", color: "#123" },
		});

		const project = await prepare("save_project", {
			input: {
				name: "Platform",
				teamIds: ["team-id"],
				templateId: "template-id",
			},
			slackChannelName: "linear-platform",
		});
		expect(project.variant?.document).toContain(
			"mutation CreateProject($input: ProjectCreateInput! $slackChannelName: String)",
		);
		expect(project.variables).toEqual({
			input: {
				name: "Platform",
				teamIds: ["team-id"],
				templateId: "template-id",
			},
			slackChannelName: "linear-platform",
		});

		const { requests } = graphqlStub((query, variables) => {
			expect(query).toContain("query ResolveNamedEntityById($id: String!)");
			expect(query).toContain("project(id: $id) { id name }");
			expect(variables).toEqual({ id: PROJECT_ID });
			return { project: { id: PROJECT_ID, name: "Platform" } };
		});
		const milestone = await prepare("save_milestone", {
			input: { name: "Beta", projectId: PROJECT_ID, description: "Ready" },
		});
		expect(requests).toHaveLength(1);
		expect(milestone.variant?.document).toContain(
			"mutation CreateMilestone($input: ProjectMilestoneCreateInput!)",
		);
		expect(milestone.variables).toEqual({
			input: { name: "Beta", projectId: PROJECT_ID, description: "Ready" },
		});
	});

	it("prepares valid update branches and invokes exact target resolvers", async () => {
		const { requests } = graphqlStub((query, _variables) => {
			expect(query).toContain("query ResolveNamedEntityById($id: String!)");
			if (query.includes("initiative(id:"))
				return { initiative: { id: INITIATIVE_ID, name: "Initiative" } };
			if (query.includes("projectMilestone(id:"))
				return { projectMilestone: { id: MILESTONE_ID, name: "Beta" } };
			return { project: { id: PROJECT_ID, name: "Project" } };
		});

		const initiative = await prepare("save_initiative", {
			initiativeId: INITIATIVE_ID,
			input: { name: "Updated" },
		});
		expect(initiative.variant?.document).toContain(
			"mutation UpdateInitiative($id: String! $input: InitiativeUpdateInput!)",
		);
		expect(initiative.variables).toEqual({
			id: INITIATIVE_ID,
			input: { name: "Updated" },
		});

		const project = await prepare("save_project", {
			projectId: PROJECT_ID,
			name: "Updated",
		});
		expect(project.variant?.document).toContain(
			"mutation UpdateProject($id: String! $input: ProjectUpdateInput!)",
		);
		expect(project.variables).toEqual({
			id: PROJECT_ID,
			input: { name: "Updated" },
		});

		const milestone = await prepare("save_milestone", {
			milestoneId: MILESTONE_ID,
			input: { targetDate: "2026-12-01" },
		});
		expect(milestone.variant?.document).toContain(
			"mutation UpdateMilestone($id: String! $input: ProjectMilestoneUpdateInput!)",
		);
		expect(milestone.variables).toEqual({
			id: MILESTONE_ID,
			input: { targetDate: "2026-12-01" },
		});
		expect(requests.map(({ variables }) => variables)).toEqual([
			{ id: INITIATIVE_ID },
			{ id: PROJECT_ID },
			{ id: MILESTONE_ID },
		]);
	});

	it("rejects create-only fields in update mode before target resolution", async () => {
		const { fetch } = graphqlStub(() => ({}));
		await expect(
			prepare("save_initiative", {
				initiativeId: INITIATIVE_ID,
				input: { id: "new-id" },
			}),
		).rejects.toThrow("Params not valid in update mode: id.");
		await expect(
			prepare("save_project", {
				projectId: PROJECT_ID,
				templateId: "template",
			}),
		).rejects.toThrow("Params not valid in update mode: templateId.");
		await expect(
			prepare("save_milestone", { milestoneId: MILESTONE_ID, id: "new-id" }),
		).rejects.toThrow("Params not valid in update mode: id.");
		expect(fetch).not.toHaveBeenCalled();
	});

	it("rejects update-only fields in create mode before any resolver call", async () => {
		const { fetch } = graphqlStub(() => ({}));
		await expect(
			prepare("save_initiative", { name: "New", trashed: true }),
		).rejects.toThrow("Params not valid in create mode: trashed.");
		await expect(
			prepare("save_project", {
				name: "New",
				teamIds: ["team"],
				input: { completedAt: "2026-01-01" },
			}),
		).rejects.toThrow("Params not valid in create mode: completedAt.");
		expect(fetch).not.toHaveBeenCalled();
	});

	it("rejects empty updates before target resolution", async () => {
		const { fetch } = graphqlStub(() => ({}));
		await expect(
			prepare("save_initiative", { initiativeId: INITIATIVE_ID }),
		).rejects.toThrow("No initiative update fields were provided.");
		await expect(
			prepare("save_project", { projectId: PROJECT_ID, input: {} }),
		).rejects.toThrow("No project update fields were provided.");
		await expect(
			prepare("save_milestone", { milestoneId: MILESTONE_ID }),
		).rejects.toThrow("No milestone update fields were provided.");
		expect(fetch).not.toHaveBeenCalled();
	});
});
