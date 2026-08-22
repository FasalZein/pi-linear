import { linearGraphQL, linearGraphQLErrors, resolveIssueReference } from "../client";
import { projection } from "../selections";
import {
	mergedInput,
	p,
} from "../operation-types";
import type {
	BatchLookupValues,
	LinearOperation,
	OperationPreparation,
	OperationSource,
	OperationDefinition,
} from "../operation-types";
import { defineOperation } from "../operation-definition";
import {
	input,
	issueTarget,
	issueReference,
	workspaceEmpty,
	listOperation,
	simpleMutation,
} from "./shared";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISSUE_RELATION_TYPES = new Set(["blocks", "duplicate", "related", "similar"]);
const RELATION_GUARD_ERROR = "Linear issue relation did not match the exact delete guard.";
const RELATION_PREFLIGHT_ERROR = "Linear issue relation delete preflight failed.";
const RELATION_DELETE_ERROR = "Linear issue relation delete failed.";
const VERIFY_ISSUE_RELATION_DOCUMENT = `query VerifyIssueRelationDelete($id: String!) {
  issueRelation(id: $id) { id type issue { id } relatedIssue { id } }
}`;
const DELETE_ISSUE_RELATION_DOCUMENT = `mutation DeleteIssueRelation($id: String!) {
  issueRelationDelete(id: $id) { success }
}`;
const DELETE_ISSUE_RELATION_VARIANT = {
	document: DELETE_ISSUE_RELATION_DOCUMENT,
	root: "issueRelationDelete",
	mutationResult: {
		successPath: "success",
		successValue: true as const,
		requiredEntityPaths: [],
	},
};

type GuardedIssueRelation = {
	id: string;
	type: string;
	issueId: string;
	relatedIssueId: string;
};

function guardedDeletePreparation(
	variables: Record<string, unknown>,
	relation: GuardedIssueRelation,
): OperationPreparation {
	const relationId = String(variables.relationId);
	const issueId = String(variables.issueId);
	const relatedIssueId = String(variables.relatedIssueId);
	const type = String(variables.type);
	if (
		relation.id !== relationId
		|| relation.type !== type
		|| relation.issueId !== issueId
		|| relation.relatedIssueId !== relatedIssueId
	) throw new Error(RELATION_GUARD_ERROR);
	return {
		variant: DELETE_ISSUE_RELATION_VARIANT,
		variables: { id: relationId },
		telemetryPhase: "mutation",
		requireNoGraphQLErrors: true,
		failureMessage: RELATION_DELETE_ERROR,
		acknowledgement: {
			issueRelationDelete: { relationId, issueId, relatedIssueId, type, deleted: true },
		},
	};
}

export const issueRelations: readonly OperationDefinition[] = ([
	listOperation({
		name: "list_issue_relations",
		compatibilityBranches: [
			{
				"all": []
			}
		],
		renderEmpty: workspaceEmpty("issue relations", "issue relation"),
		canonical: {
			"fields": {
				"after": "String",
				"before": "String",
				"first": "Int",
				"last": "Int",
				"includeArchived": "Boolean",
				"orderBy": "PaginationOrderBy"
			},
			"branches": [
				[]
			]
		},
		domain: "relations",
		root: "issueRelations",
		selection: projection("issueRelation", "list"),
		purpose: "List issue relations.",
		pageSize: 20,
	}),
	simpleMutation({
		name: "create_issue_relation",
		compatibilityBranches: [
			{
				"all": [
					"issue",
					"relatedIssue",
					"type"
				]
			},
			{
				"all": [
					"issueId",
					"relatedIssueId",
					"type"
				]
			},
			{
				"all": [
					"issueId",
					"relatedIssueId",
					"type"
				]
			}
		],
		renderTargetFields: [
			"issue",
			"relatedIssue"
		],
		canonical: {
			"fields": {
				"issue": "IssueReference",
				"relatedIssue": "IssueReference",
				"type": "IssueRelationType"
			},
			"branches": [
				[
					"issue",
					"relatedIssue",
					"type"
				]
			]
		},
		domain: "relations",
		purpose: "Create a relation between two issues.",
		root: "issueRelationCreate",
		inputType: "IssueRelationCreateInput",
		selection: `issueRelation { ${projection("issueRelation", "detail")} }`,
		parameters: [
			p("issue", "IssueReference", true),
			p("relatedIssue", "IssueReference", true),
			p("type", "IssueRelationType", true),
		],
		example: { issue: "AEO-258", relatedIssue: "AEO-259", type: "related" },
		aliases: ["create_relation"],
		legacyParameters: [
			[
				p("issueId", "String", true),
				p("relatedIssueId", "String", true),
				p("type", "IssueRelationType", true),
			],
		],
		aliasParameters: {
			create_relation: [
				p("issueId", "String", true),
				p("relatedIssueId", "String", true),
				p("type", "IssueRelationType", true),
			],
		},
		resolverPaths: {
			issue: "resolveIssueReference",
			relatedIssue: "resolveIssueReference",
		},
		async prepare(k, v, s, g) {
			const a = issueReference(v);
			const b = String(v.relatedIssue ?? v.relatedIssueId);
			const [x, y] = await Promise.all([
				resolveIssueReference(k, a, s, g),
				resolveIssueReference(k, b, s, g),
			]);
			return {
				variables: {
					input: { issueId: x.id, relatedIssueId: y.id, type: v.type },
				},
				resolution: {
					target: issueTarget(a, x),
					relatedTarget: issueTarget(b, y),
				},
			};
		},
	}),
	simpleMutation({
		name: "update_issue_relation",
		compatibilityBranches: [
			{
				"all": [
					"id"
				]
			}
		],
		canonical: {
			"fields": {
				"id": "String",
				"type": "IssueRelationType",
				"issueId": "IssueReference",
				"relatedIssueId": "IssueReference"
			},
			"branches": [
				[
					"id",
					"type"
				],
				[
					"id",
					"issueId"
				],
				[
					"id",
					"relatedIssueId"
				]
			]
		},
		domain: "relations",
		purpose: "Update an issue relation.",
		root: "issueRelationUpdate",
		inputType: "IssueRelationUpdateInput",
		selection: `issueRelation { ${projection("issueRelation", "detail")} }`,
		parameters: [p("id", "String", true), input],
		acceptedParameters: [
			"id",
			"type",
			"issueId",
			"relatedIssueId",
			"input",
		].map((n) => p(n)),
		example: { id: "relation-id", type: "blocks" },
		idKey: "id",
		resolverPaths: {
			issueId: "resolveIssueReference",
			relatedIssueId: "resolveIssueReference",
		},
		async prepare(k, v, s, g) {
			const x = mergedInput(v, ["id"]);
			const resolution: Record<string, unknown> = {};
			for (const key of ["issueId", "relatedIssueId"])
				if (typeof x[key] === "string") {
					const issue = await resolveIssueReference(k, String(x[key]), s, g);
					resolution[key] = issueTarget(String(x[key]), issue);
					x[key] = issue.id;
				}
			if (!Object.keys(x).length)
				throw new Error("No update fields were provided.");
			return { variables: { id: v.id, input: x }, resolution };
		},
	}),
	{
		name: "delete_issue_relation",
		compatibilityBranches: [{ all: ["relationId", "issueId", "relatedIssueId", "type"] }],
		canonical: {
			fields: {
				relationId: "UUID",
				issueId: "UUID",
				relatedIssueId: "UUID",
				type: "IssueRelationType",
			},
			branches: [["relationId", "issueId", "relatedIssueId", "type"]],
		},
		aliases: [],
		domain: "relations",
		purpose: "Delete one issue relation after exact relation and endpoint verification.",
		resultCategory: "singular",
		namedInputPolicy: "guarded-destructive",
		parameters: [
			p("relationId", "UUID", true),
			p("issueId", "UUID", true),
			p("relatedIssueId", "UUID", true),
			p("type", "IssueRelationType", true),
		],
		example: {
			operation: "delete_issue_relation",
			variables: {
				relationId: "33333333-3333-4333-8333-333333333333",
				issueId: "11111111-1111-4111-8111-111111111111",
				relatedIssueId: "22222222-2222-4222-8222-222222222222",
				type: "related",
			},
		},
		document: DELETE_ISSUE_RELATION_DOCUMENT,
		variants: [DELETE_ISSUE_RELATION_VARIANT],
		renderKind: "issue_relation",
		renderTargetFields: ["relationId", "issueId", "relatedIssueId", "type"],
		semanticException: "All delete guards must be exact UUIDs and the relation type must be closed.",
		validateVariables(variables) {
			for (const name of ["relationId", "issueId", "relatedIssueId"])
				if (typeof variables[name] !== "string" || !UUID.test(variables[name]))
					throw new Error(`Invalid ${name}: expected a UUID.`);
			if (typeof variables.type !== "string" || !ISSUE_RELATION_TYPES.has(variables.type))
				throw new Error("Invalid type: expected blocks, duplicate, related, or similar.");
		},
		async prepare(apiKey, variables, signal, graphql = linearGraphQL) {
			const relationId = String(variables.relationId);
			let data: {
				issueRelation: {
					id?: unknown;
					type?: unknown;
					issue?: { id?: unknown } | null;
					relatedIssue?: { id?: unknown } | null;
				} | null;
			};
			try {
				data = await graphql(apiKey, VERIFY_ISSUE_RELATION_DOCUMENT, { id: relationId }, signal, { phase: "read" });
				if (linearGraphQLErrors(data).length) throw new Error(RELATION_PREFLIGHT_ERROR);
			} catch {
				throw new Error(RELATION_PREFLIGHT_ERROR);
			}
			const relation = data.issueRelation;
			if (
				!relation
				|| typeof relation.id !== "string"
				|| typeof relation.type !== "string"
				|| typeof relation.issue?.id !== "string"
				|| typeof relation.relatedIssue?.id !== "string"
			) throw new Error(RELATION_GUARD_ERROR);
			return guardedDeletePreparation(variables, {
				id: relation.id,
				type: relation.type,
				issueId: relation.issue.id,
				relatedIssueId: relation.relatedIssue.id,
			});
		},
		batchPrepare(variables) {
			return {
				kind: "independent" as const,
				deferDocument: true as const,
				lookups: [{
					field: "issueRelation" as const,
					requested: String(variables.relationId),
					failureMessage: RELATION_PREFLIGHT_ERROR,
				}],
				finish(resolved: BatchLookupValues) {
					if (!resolved.issueRelation) throw new Error(RELATION_PREFLIGHT_ERROR);
					return guardedDeletePreparation(variables, resolved.issueRelation);
				},
			};
		},
	},
] satisfies OperationSource[]).map((operation) =>
	defineOperation(operation as LinearOperation),
);

export const projectRelations: readonly OperationDefinition[] = ([
	listOperation({
		name: "list_project_relations",
		compatibilityBranches: [
			{
				"all": []
			}
		],
		renderEmpty: workspaceEmpty("project relations", "project relation"),
		canonical: {
			"fields": {
				"after": "String",
				"before": "String",
				"first": "Int",
				"last": "Int",
				"includeArchived": "Boolean",
				"orderBy": "PaginationOrderBy"
			},
			"branches": [
				[]
			]
		},
		domain: "relations",
		root: "projectRelations",
		selection: projection("projectRelation", "list"),
		purpose: "List project relations.",
		pageSize: 20,
	}),
	simpleMutation({
		name: "create_project_relation",
		compatibilityBranches: [
			{
				"all": [
					"projectId",
					"relatedProjectId",
					"type",
					"anchorType",
					"relatedAnchorType"
				]
			}
		],
		canonical: {
			"fields": {
				"projectId": "String",
				"relatedProjectId": "String",
				"type": "String",
				"anchorType": "String",
				"relatedAnchorType": "String",
				"projectMilestoneId": "UUID",
				"relatedProjectMilestoneId": "UUID"
			},
			"branches": [
				[
					"projectId",
					"relatedProjectId",
					"type",
					"anchorType",
					"relatedAnchorType"
				]
			]
		},
		domain: "relations",
		purpose: "Create a relation between two projects.",
		root: "projectRelationCreate",
		inputType: "ProjectRelationCreateInput",
		selection: `projectRelation { ${projection("projectRelation", "detail")} }`,
		parameters: [
			p("projectId", "String", true),
			p("relatedProjectId", "String", true),
			p("type", "String", true),
			p("anchorType", "String", true),
			p("relatedAnchorType", "String", true),
		],
		acceptedParameters: [
			"projectId",
			"relatedProjectId",
			"type",
			"anchorType",
			"relatedAnchorType",
			"projectMilestoneId",
			"relatedProjectMilestoneId",
			"input",
		].map((n) => p(n)),
		example: {
			projectId: "project-id",
			relatedProjectId: "other-project-id",
			type: "related",
			anchorType: "project",
			relatedAnchorType: "project",
		},
	}),
	simpleMutation({
		name: "update_project_relation",
		compatibilityBranches: [
			{
				"all": [
					"id"
				]
			}
		],
		canonical: {
			"fields": {
				"id": "String",
				"type": "String",
				"anchorType": "String",
				"relatedAnchorType": "String",
				"projectId": "UUID",
				"relatedProjectId": "UUID",
				"projectMilestoneId": "UUID",
				"relatedProjectMilestoneId": "UUID"
			},
			"branches": [
				[
					"id",
					"type"
				],
				[
					"id",
					"anchorType"
				],
				[
					"id",
					"relatedAnchorType"
				],
				[
					"id",
					"projectId"
				],
				[
					"id",
					"relatedProjectId"
				],
				[
					"id",
					"projectMilestoneId"
				],
				[
					"id",
					"relatedProjectMilestoneId"
				]
			]
		},
		domain: "relations",
		purpose: "Update a project relation.",
		root: "projectRelationUpdate",
		inputType: "ProjectRelationUpdateInput",
		selection: `projectRelation { ${projection("projectRelation", "detail")} }`,
		parameters: [p("id", "String", true), input],
		acceptedParameters: [
			"id",
			"type",
			"projectId",
			"relatedProjectId",
			"anchorType",
			"relatedAnchorType",
			"projectMilestoneId",
			"relatedProjectMilestoneId",
			"input",
		].map((n) => p(n)),
		example: { id: "relation-id", type: "related" },
		idKey: "id",
	}),
] satisfies OperationSource[]).map((operation) =>
	defineOperation(operation as LinearOperation),
);
