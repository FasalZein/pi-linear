import { afterEach, describe, expect, it, vi } from "vitest";
import { linearApiTool } from "../extensions/api";

const ISSUE_ID = "11111111-1111-4111-8111-111111111111";
const CHILD_ID = "22222222-2222-4222-8222-222222222222";
const TEAM_ID = "33333333-3333-4333-8333-333333333333";
const USER_ID = "44444444-4444-4444-8444-444444444444";
const STATE_ID = "55555555-5555-4555-8555-555555555555";
const originalKey = process.env.LINEAR_API_KEY;

afterEach(() => {
	vi.unstubAllGlobals();
	if (originalKey === undefined) delete process.env.LINEAR_API_KEY;
	else process.env.LINEAR_API_KEY = originalKey;
});

function execute(params: Record<string, unknown>) {
	return (linearApiTool() as any).execute(
		"call",
		params,
		undefined,
		undefined,
		{ hasUI: false },
	);
}

describe("v0.4 blind-task first calls", () => {
	it("normalizes all documented first-call shapes without a discovery failure", async () => {
		process.env.LINEAR_API_KEY = "test-key";
		const requests: Array<{
			query: string;
			variables: Record<string, unknown>;
		}> = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: string, init: RequestInit) => {
				const request = JSON.parse(String(init.body));
				requests.push(request);
				const { query, variables } = request;
				let data: Record<string, unknown>;
				if (query.includes("ResolveIssueByIdentifier")) {
					const number = Number(variables.number);
					const child = number === 300;
					data = {
						issues: {
							nodes: [
								{
									id: child ? CHILD_ID : ISSUE_ID,
									identifier: `AEO-${number}`,
									team: { id: TEAM_ID, key: "AEO" },
								},
							],
						},
					};
				} else if (query.includes("ResolveViewer"))
					data = { viewer: { id: USER_ID, name: "Me" } };
				else if (query.includes("ResolveStateByName"))
					data = {
						workflowStates: {
							nodes: [{ id: STATE_ID, name: "Backlog", team: { id: TEAM_ID } }],
						},
					};
				else if (query.includes("query ListIssues"))
					data = { issues: { nodes: [], pageInfo: { hasNextPage: false } } };
				else if (query.includes("mutation CreateComment"))
					data = {
						commentCreate: {
							success: true,
							comment: { id: "comment", body: "v0.4 blind trial" },
						},
					};
				else if (query.includes("mutation CreateIssue"))
					data = {
						issueCreate: {
							success: true,
							issue: {
								id: CHILD_ID,
								identifier: "AEO-300",
								team: { id: TEAM_ID, key: "AEO" },
							},
						},
					};
				else if (query.includes("mutation UpdateIssue"))
					data = {
						issueUpdate: {
							success: true,
							issue: { id: CHILD_ID, identifier: "AEO-300" },
						},
					};
				else
					data = {
						issue: {
							id: ISSUE_ID,
							identifier: "AEO-258",
							team: { id: TEAM_ID, key: "AEO" },
						},
					};
				return {
					ok: true,
					status: 200,
					statusText: "OK",
					headers: new Headers(),
					json: async () => ({ data }),
				};
			}),
		);

		await execute({ operation: "get_issue", variables: { issue: "AEO-258" } });
		await execute({
			operation: "create_comment",
			variables: { issue: "AEO-258", body: "v0.4 blind trial" },
		});
		await execute({
			operation: "list_issues",
			variables: { assignee: "me", state: "In Progress" },
		});
		await execute({
			operation: "list_issues",
			variables: { assignee: "me", stateType: "started" },
		});
		await execute({
			operation: "create_issue",
			variables: { title: "v0.4 trial child", parent: "AEO-258" },
		});
		await execute({
			operation: "update_issue",
			variables: { issue: "AEO-300", state: "Backlog" },
		});

		const final = requests.filter(({ query }) => !query.includes("Resolve"));
		expect(
			final.find(({ query }) => query.includes("CreateComment"))?.variables,
		).toEqual({ input: { body: "v0.4 blind trial", issueId: ISSUE_ID } });
		expect(
			final
				.filter(({ query }) => query.includes("ListIssues"))
				.map(({ variables }) => variables),
		).toEqual([
			{
				first: 20,
				filter: {
					state: { name: { eq: "In Progress" } },
					assignee: { id: { eq: USER_ID } },
				},
			},
			{
				first: 20,
				filter: {
					state: { type: { eq: "started" } },
					assignee: { id: { eq: USER_ID } },
				},
			},
		]);
		expect(
			final.find(({ query }) => query.includes("CreateIssue"))?.variables,
		).toEqual({
			input: { title: "v0.4 trial child", parentId: ISSUE_ID, teamId: TEAM_ID },
		});
		expect(
			final.find(({ query }) => query.includes("UpdateIssue"))?.variables,
		).toEqual({ id: CHILD_ID, input: { stateId: STATE_ID } });
	});
});
