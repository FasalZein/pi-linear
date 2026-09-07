import { Kind, parse } from "graphql";
import { describe, expect, it } from "vitest";
import { resolveRequest } from "../extensions/api";
import { BATCH_MUTATION_ROOTS, operationDefinitions, operationDocuments, operations } from "../extensions/operations";
import {
	SAFE_NAMED_MUTATION_ROOTS,
	getMutationFields,
} from "../extensions/safety";

const CANONICAL = [
	"list_comments",
	"create_comment",
	"update_comment",
	"list_views",
	"get_view",
	"create_view",
	"update_view",
	"set_view_preferences",
	"list_cycles",
	"get_cycle",
	"create_cycle",
	"update_cycle",
	"list_documents",
	"get_document",
	"create_document",
	"update_document",
	"list_initiatives",
	"get_initiative",
	"save_initiative",
	"list_issue_labels",
	"create_issue_label",
	"update_issue_label",
	"list_issue_relations",
	"create_issue_relation",
	"update_issue_relation",
	"delete_issue_relation",
	"list_issue_statuses",
	"list_issues",
	"get_issue",
	"create_issue",
	"update_issue",
	"search_issues",
	"list_milestones",
	"get_milestone",
	"save_milestone",
	"list_project_labels",
	"create_project_label",
	"update_project_label",
	"list_project_relations",
	"create_project_relation",
	"update_project_relation",
	"list_projects",
	"get_project",
	"save_project",
	"list_teams",
	"get_team",
	"list_users",
	"get_user",
	"switch_workspace",
] as const;

function operationType(document: string) {
	const definition = parse(document).definitions.find(
		(value) => value.kind === Kind.OPERATION_DEFINITION,
	);
	if (!definition || definition.kind !== Kind.OPERATION_DEFINITION)
		throw new Error("Missing operation definition.");
	return definition.operation;
}

describe("v0.4 operation inventory", () => {
	it("contains the 48 upstream names plus only the guarded relation delete", () => {
		expect(Object.keys(operations).sort()).toEqual([...CANONICAL].sort());
		expect(Object.keys(operations)).toHaveLength(49);
		expect(Object.values(operations)
			.flatMap((operation) => [operation.name, ...operation.aliases])
			.filter((name) => /^(delete|archive|unarchive)_/.test(name)))
			.toEqual(["delete_issue_relation"]);
	});

	it("provides executable, scoped discovery metadata for every operation", () => {
		for (const name of CANONICAL) {
			const operation = operations[name];
			expect(operation.domain).toBeTruthy();
			expect(operation.parameters).toBeDefined();
			expect(operation.example).toEqual(
				expect.objectContaining({
					operation: name,
					variables: expect.any(Object),
				}),
			);
			expect(operation.document || operation.executeLocal).toBeTruthy();
			expect(() => resolveRequest(operation.example)).not.toThrow();
		}
	});

	it("parses every document and exactly matches declared and authorized mutation roots", () => {
		const roots = new Set<string>();
		for (const operation of Object.values(operations)) {
			const actual = new Set<string>();
			for (const document of operationDocuments(operation)) {
				expect(() => parse(document)).not.toThrow();
				const fields = getMutationFields(document);
				if (operationType(document) === "query") expect(fields).toEqual([]);
				fields.forEach((field) => actual.add(field));
			}
			expect([...actual].sort()).toEqual(operation.variants?.map(({ root }) => root).sort() ?? []);
			actual.forEach((root) => roots.add(root));
		}
		expect([...SAFE_NAMED_MUTATION_ROOTS].sort()).toEqual([...roots, ...BATCH_MUTATION_ROOTS].sort());
	});

	it("keeps aliases hidden and accepts all v0.3 request shapes", () => {
		const calls = [
			{
				operation: "add_comment",
				variables: {
					issueId: "11111111-1111-4111-8111-111111111111",
					body: "text",
				},
			},
			{
				operation: "create_relation",
				variables: {
					issueId: "11111111-1111-4111-8111-111111111111",
					relatedIssueId: "22222222-2222-4222-8222-222222222222",
					type: "related",
				},
			},
			{ operation: "list_workflow_states", variables: {} },
			{
				operation: "update_issue_state",
				variables: {
					issueId: "11111111-1111-4111-8111-111111111111",
					stateId: "22222222-2222-4222-8222-222222222222",
				},
			},
			{ operation: "get_issue", variables: { teamKey: "AEO", number: 258 } },
			{
				operation: "create_issue",
				variables: {
					input: {
						teamId: "11111111-1111-4111-8111-111111111111",
						title: "legacy",
					},
				},
			},
			{
				operation: "list_issues",
				variables: {
					first: 10,
					filter: { priority: { eq: 1 } },
					sort: [{ priority: "Ascending" }],
				},
			},
			{
				operation: "search_issues",
				variables: {
					term: "legacy",
					first: 10,
					filter: { priority: { eq: 1 } },
				},
			},
		];
		calls.forEach((call) => expect(() => resolveRequest(call)).not.toThrow());
		expect(
			JSON.stringify(Object.values(operations).map(({ name }) => name)),
		).not.toMatch(
			/add_comment|create_relation|list_workflow_states|update_issue_state/,
		);
	});

	it("declares pagination and filter metadata for supported list operations", () => {
		for (const operation of Object.values(operations).filter(
			({ name }) => name.startsWith("list_") || name === "search_issues",
		)) {
			expect(operation.pagination?.defaultPageSize).toBeGreaterThan(0);
			expect(operation.document).toContain("$first: Int");
			expect(operation.document).toContain("pageInfo");
			expect(operation.plan).toBeTypeOf("function");
		}
	});

	it("declares the exact resolver label for every authored reference field", () => {
		const expectedLabel = (type: string): string => {
			const base = type.replace(/^Nullable/, "").replace(/Reference$/, "");
			if (["Issue", "Team", "State", "User"].includes(base)) {
				return `resolve${base}Reference`;
			}
			if (base === "DocumentId") return "resolveDocumentReference";
			return "resolveNamedEntityReference";
		};
		for (const operation of operationDefinitions) {
			const expected = Object.fromEntries(
				operation.preparation.referenceFields.map(({ name, type }) => [name, expectedLabel(type)]),
			);
			expect(operation.preparation.resolverPaths, operation.name).toEqual(expected);
		}
	});
});
