import { afterEach, describe, expect, it, vi } from "vitest";
import { linearApiTool, resolveRequest } from "../extensions/api";
import { operations } from "../extensions/operations";

const INITIATIVE_ID = "11111111-1111-4111-8111-111111111111";
const PROJECT_ID = "22222222-2222-4222-8222-222222222222";
const MILESTONE_ID = "33333333-3333-4333-8333-333333333333";

async function prepare(name: string, variables: Record<string, unknown>) {
	const operation = operations[name];
	if (!operation?.prepare) throw new Error(`${name} has no preparation.`);
	return operation.prepare("test-key", variables, undefined);
}

function graphqlStub(
	responder: (
		query: string,
		variables: Record<string, unknown>,
	) => Record<string, unknown>,
) {
	const requests: Array<{ query: string; variables: Record<string, unknown> }> =
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

describe("upstream-equivalent issue label preparation", () => {
	it("passes replaceTeamLabels as a create root argument for top-level and raw input calls", async () => {
		const topLevel = await prepare("create_issue_label", {
			name: "Review",
			color: "#f00",
			replaceTeamLabels: true,
		});
		expect(topLevel.document).toBeUndefined();
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
		const tool = linearApiTool() as any;
		await expect(
			tool.execute(
				"call",
				{ operation: "create_view", variables: { filterData: {} } },
				undefined,
				undefined,
				{ hasUI: false },
			),
		).rejects.toThrow('Invalid parameters for "create_view": missing name');
		expect(fetch).not.toHaveBeenCalled();
	});
});

describe("save operation mode validation and branch preparation", () => {
	it("prepares valid create branches from top-level and raw input fields", async () => {
		const initiative = await prepare("save_initiative", {
			name: "Platform",
			color: "#123",
		});
		expect(initiative.document).toContain(
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
		expect(project.document).toContain(
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
		expect(milestone.document).toContain(
			"mutation CreateMilestone($input: ProjectMilestoneCreateInput!)",
		);
		expect(milestone.variables).toEqual({
			input: { name: "Beta", projectId: PROJECT_ID, description: "Ready" },
		});
	});

	it("prepares valid update branches and invokes exact target resolvers", async () => {
		const { requests } = graphqlStub((query, variables) => {
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
		expect(initiative.document).toContain(
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
		expect(project.document).toContain(
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
		expect(milestone.document).toContain(
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
