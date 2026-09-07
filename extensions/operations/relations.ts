import { projection } from "../selections";
import { issueLookup, issueRelationLookup } from "../operation-plan";
import {
	isCompatibilityString,
	mergedInput,
	p,
} from "../operation-types";
import type {
	CompatibilityObject,
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
	operationParameterDecision,
} from "./shared";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISSUE_RELATION_TYPES = new Set(["blocks", "duplicate", "related", "similar"]);
const RELATION_GUARD_ERROR = "Linear issue relation did not match the exact delete guard.";
const RELATION_PREFLIGHT_ERROR = "Linear issue relation delete preflight failed.";
const RELATION_DELETE_ERROR = "Linear issue relation delete failed.";
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
	variables: CompatibilityObject,
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
		...operationParameterDecision({
			compatibilityBranches: [
				{
					"all": []
				}
			],
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
		}),
				renderEmpty: workspaceEmpty("issue relations", "issue relation"),
				domain: "relations",
		root: "issueRelations",
		selection: projection("issueRelation", "list"),
		purpose: "List issue relations.",
		pageSize: 20,
	}),
	simpleMutation({
		name: "create_issue_relation",
		...operationParameterDecision({
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
			parameters: [
				p("issue", "IssueReference", true),
				p("relatedIssue", "IssueReference", true),
				p("type", "IssueRelationType", true),
			],
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
		}),
				renderTargetFields: [
			"issue",
			"relatedIssue"
		],
				domain: "relations",
		purpose: "Create a relation between two issues.",
		root: "issueRelationCreate",
		inputType: "IssueRelationCreateInput",
		selection: `issueRelation { ${projection("issueRelation", "detail")} }`,
				example: { issue: "AEO-258", relatedIssue: "AEO-259", type: "related" },
		aliases: ["create_relation"],
						resolverPaths: {
			issue: "resolveIssueReference",
			relatedIssue: "resolveIssueReference",
		},
		plan(v) {
			const a = issueReference(v);
			const b = String(v.relatedIssue ?? v.relatedIssueId);
			return {
				kind: "mutation",
				lookups: [issueLookup("target", a), issueLookup("relatedTarget", b)],
				finish(resolved) {
					const x = resolved.target as import("../client").ResolvedIssue;
					const y = resolved.relatedTarget as import("../client").ResolvedIssue;
					return { variables: { input: { issueId: x.id, relatedIssueId: y.id, type: v.type } }, resolution: { target: issueTarget(a, x), relatedTarget: issueTarget(b, y) } };
				},
			};
		},
	}),
	simpleMutation({
		name: "update_issue_relation",
		...operationParameterDecision({
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
			parameters: [p("id", "String", true), input],
			acceptedParameters: [
				"id",
				"type",
				"issueId",
				"relatedIssueId",
				"input",
			].map((n) => p(n)),
		}),
						domain: "relations",
		purpose: "Update an issue relation.",
		root: "issueRelationUpdate",
		inputType: "IssueRelationUpdateInput",
		selection: `issueRelation { ${projection("issueRelation", "detail")} }`,
						example: { id: "relation-id", type: "blocks" },
		idKey: "id",
		resolverPaths: {
			issueId: "resolveIssueReference",
			relatedIssueId: "resolveIssueReference",
		},
		plan(v) {
			const input = mergedInput(v, ["id"]);
			const issueRef = isCompatibilityString(input.issueId) ? input.issueId : undefined;
			const relatedRef = isCompatibilityString(input.relatedIssueId) ? input.relatedIssueId : undefined;
			return {
				kind: "mutation",
				lookups: [
					...(issueRef ? [issueLookup("issueId", issueRef)] : []),
					...(relatedRef ? [issueLookup("relatedIssueId", relatedRef)] : []),
				],
				finish(resolved) {
					const issue = resolved.issueId as import("../client").ResolvedIssue | undefined;
					const related = resolved.relatedIssueId as import("../client").ResolvedIssue | undefined;
					if (issue) input.issueId = issue.id;
					if (related) input.relatedIssueId = related.id;
					if (!Object.keys(input).length) throw new Error("No update fields were provided.");
					const resolution: CompatibilityObject = {};
					if (issue && issueRef) resolution.issueId = issueTarget(issueRef, issue);
					if (related && relatedRef) resolution.relatedIssueId = issueTarget(relatedRef, related);
					return { variables: { id: v.id, input }, resolution };
				},
			};
		},
	}),
	{
		name: "delete_issue_relation",
		...operationParameterDecision({
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
			parameters: [
				p("relationId", "UUID", true),
				p("issueId", "UUID", true),
				p("relatedIssueId", "UUID", true),
				p("type", "IssueRelationType", true),
			],
		}),
						aliases: [],
		domain: "relations",
		purpose: "Delete one issue relation after exact relation and endpoint verification.",
		resultCategory: "singular",
		namedInputPolicy: "guarded-destructive",
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
			for (const name of ["relationId", "issueId", "relatedIssueId"]) {
				const value = variables[name];
				if (!isCompatibilityString(value) || !UUID.test(value))
					throw new Error(`Invalid ${name}: expected a UUID.`);
			}
			const relationType = variables.type;
			if (!isCompatibilityString(relationType) || !ISSUE_RELATION_TYPES.has(relationType))
				throw new Error("Invalid type: expected blocks, duplicate, related, or similar.");
		},
		plan(variables) {
			return {
				kind: "mutation",
				lookups: [issueRelationLookup("issueRelation", String(variables.relationId), RELATION_PREFLIGHT_ERROR)],
				finish(resolved) {
					return guardedDeletePreparation(variables, resolved.issueRelation as GuardedIssueRelation);
				},
			};
		},
	},
] satisfies OperationSource[]).map((operation) =>
	defineOperation(operation),
);

export const projectRelations: readonly OperationDefinition[] = ([
	listOperation({
		name: "list_project_relations",
		...operationParameterDecision({
			compatibilityBranches: [
				{
					"all": []
				}
			],
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
		}),
				renderEmpty: workspaceEmpty("project relations", "project relation"),
				domain: "relations",
		root: "projectRelations",
		selection: projection("projectRelation", "list"),
		purpose: "List project relations.",
		pageSize: 20,
	}),
	simpleMutation({
		name: "create_project_relation",
		...operationParameterDecision({
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
		}),
						domain: "relations",
		purpose: "Create a relation between two projects.",
		root: "projectRelationCreate",
		inputType: "ProjectRelationCreateInput",
		selection: `projectRelation { ${projection("projectRelation", "detail")} }`,
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
		...operationParameterDecision({
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
		}),
						domain: "relations",
		purpose: "Update a project relation.",
		root: "projectRelationUpdate",
		inputType: "ProjectRelationUpdateInput",
		selection: `projectRelation { ${projection("projectRelation", "detail")} }`,
						example: { id: "relation-id", type: "related" },
		idKey: "id",
	}),
] satisfies OperationSource[]).map((operation) =>
	defineOperation(operation),
);
