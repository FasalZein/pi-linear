import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { linearApiTool } from "../extensions/api";
import { writeCredentials } from "../extensions/client";

const ISSUE_ID = "11111111-1111-4111-8111-111111111111";
const TEAM_ID = "22222222-2222-4222-8222-222222222222";
const STATE_ID = "33333333-3333-4333-8333-333333333333";
const originalKey = process.env.LINEAR_API_KEY;
const originalMutations = process.env.LINEAR_MUTATIONS;
const originalPiDir = process.env.PI_CODING_AGENT_DIR;
const temporaryDirectories: string[] = [];

function execute(params: Record<string, unknown>) {
	return (linearApiTool() as any).execute(
		"call",
		params,
		undefined,
		undefined,
		{ hasUI: false },
	);
}

afterEach(async () => {
	vi.unstubAllGlobals();
	if (originalKey === undefined) delete process.env.LINEAR_API_KEY;
	else process.env.LINEAR_API_KEY = originalKey;
	if (originalMutations === undefined) delete process.env.LINEAR_MUTATIONS;
	else process.env.LINEAR_MUTATIONS = originalMutations;
	if (originalPiDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalPiDir;
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("post-change blind regression replay", () => {
	it("replays named calls without weakening raw mutation safety", async () => {
		const fetch = vi.fn(async (_url: string, init: RequestInit) => {
			const request = JSON.parse(String(init.body)) as {
				query: string;
				variables: Record<string, unknown>;
			};
			const { query, variables } = request;
			let data: Record<string, unknown>;
			if (query.includes("ResolveIssueById")) {
				data = {
					issue: { id: ISSUE_ID, identifier: "AEO-266", team: { id: TEAM_ID, key: "AEO" } },
				};
			} else if (query.includes("ResolveStateByName")) {
				data = {
					workflowStates: {
						nodes: [{ id: STATE_ID, name: "Backlog", team: { id: TEAM_ID } }],
					},
				};
			} else if (query.includes("mutation UpdateIssue")) {
				data = { issueUpdate: { success: true, issue: { id: ISSUE_ID, identifier: "AEO-266" } } };
			} else {
				data = { issue: { id: ISSUE_ID, identifier: "AEO-266", team: { id: TEAM_ID, key: "AEO" } } };
			}
			return {
				ok: true,
				status: 200,
				statusText: "OK",
				headers: new Headers(),
				json: async () => ({ data }),
			};
		});
		vi.stubGlobal("fetch", fetch);

		const piDir = await mkdtemp(join(tmpdir(), "pi-linear-blind-fix-"));
		temporaryDirectories.push(piDir);
		process.env.PI_CODING_AGENT_DIR = piDir;
		await writeCredentials({
			activeWorkspace: "work",
			authPreference: "workspace",
			workspaces: { work: { apiKey: "active-key" } },
		});
		await execute({ operation: "get_issue", variables: { issue: "AEO-266" }, workspace: "default" });
		await execute({ operation: "update_issue", variables: { issue: "AEO-266", state: "Backlog" } });

		const requests = fetch.mock.calls.map(([, init]) => JSON.parse(String((init as RequestInit).body)));
		const update = requests.find(({ query }) => query.includes("mutation UpdateIssue"));
		expect(update.query).toContain("issueUpdate(id: $id, input: $input)");
		expect(update.variables).toEqual({ id: "AEO-266", input: { stateId: STATE_ID } });
		expect((fetch.mock.calls[0]?.[1] as RequestInit).headers).toMatchObject({ Authorization: "active-key" });

		delete process.env.LINEAR_MUTATIONS;
		await expect(execute({
			query: "mutation Raw($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }",
			variables: { id: ISSUE_ID, input: { title: "blocked" } },
		})).rejects.toThrow("Raw Linear mutations are disabled");
	});
});
