import { requireIssueReference } from "../client";
import { projection } from "../selections";
import { issueLookup, issueRelationLookup } from "../operation-plan";
import {
	isCompatibilityString,
	mergedInput,
} from "../operation-types";
import type {
	CompatibilityObject,
	OperationPreparation,
	OperationSource,
	OperationDefinition,
} from "../operation-types";
import { defineOperation } from "../operation-definition";
import {
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
			issueRelationDelete: { relationId, issue: issueId, relatedIssue: relatedIssueId, type, deleted: true },
		},
	};
}

export const issueRelations: readonly OperationDefinition[] = ([
	listOperation({
		name: "list_issue_relations",
		...operationParameterDecision({
		fields: [
			{ name: "after", canonical: "String" },
			{ name: "before", canonical: "String" },
			{ name: "first", canonical: "Int" },
			{ name: "last", canonical: "Int" },
			{ name: "includeArchived", canonical: "Boolean" },
			{ name: "orderBy", canonical: "PaginationOrderBy" },
		],
		requirements: {
			canonicalBranches: 1,
			compatibilityBranches: [{}],
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
		fields: [
			{ name: "issue", canonical: "IssueReference", canonicalBranches: [0], compatibilityRequirements: [{"branch":0,"kind":"all","order":0}], card: { order: 0, required: true } },
			{ name: "relatedIssue", canonical: "IssueReference", canonicalBranches: [0], compatibilityRequirements: [{"branch":0,"kind":"all","order":1}], card: { order: 1, required: true } },
			{ name: "type", canonical: "IssueRelationType", canonicalBranches: [0], compatibilityRequirements: [{"branch":0,"kind":"all","order":2},{"branch":1,"kind":"all","order":2},{"branch":2,"kind":"all","order":2}], card: { order: 2, required: true }, legacy: [{ order: 2, type: "IssueRelationType", required: true, branch: 0 }], aliases: [{ order: 2, type: "IssueRelationType", required: true, operation: "create_relation" }] },
			{ name: "issueId", compatibilityRequirements: [{"branch":1,"kind":"all","order":0},{"branch":2,"kind":"all","order":0}], legacy: [{ order: 0, required: true, branch: 0 }], aliases: [{ order: 0, required: true, operation: "create_relation" }] },
			{ name: "relatedIssueId", compatibilityRequirements: [{"branch":1,"kind":"all","order":1},{"branch":2,"kind":"all","order":1}], legacy: [{ order: 1, required: true, branch: 0 }], aliases: [{ order: 1, required: true, operation: "create_relation" }] },
		],
		requirements: {
			canonicalBranches: 1,
			compatibilityBranches: [{},{},{}],
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
		fields: [
			{ name: "id", canonical: "String", canonicalBranches: [0,1,2], compatibilityRequirements: [{"branch":0,"kind":"all","order":0}], card: { order: 0, required: true }, accepted: { order: 0 } },
			{ name: "type", canonical: "IssueRelationType", canonicalBranches: [0], accepted: { order: 1 } },
			{ name: "issueId", canonical: "IssueReference", canonicalBranches: [1], accepted: { order: 2 } },
			{ name: "relatedIssueId", canonical: "IssueReference", canonicalBranches: [2], accepted: { order: 3 } },
			{ name: "input", card: { order: 1, type: "Input" }, accepted: { order: 4 } },
		],
		requirements: {
			canonicalBranches: 3,
			compatibilityBranches: [{}],
		},
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
		fields: [
			{ name: "relationId", canonical: "UUID", canonicalBranches: [0], compatibilityRequirements: [{"branch":0,"kind":"all","order":0}], card: { order: 0, required: true } },
			{ name: "issueId", canonical: "UUID", canonicalBranches: [0], compatibilityRequirements: [{"branch":0,"kind":"all","order":1}], card: { order: 1, required: true } },
			{ name: "relatedIssueId", canonical: "UUID", canonicalBranches: [0], compatibilityRequirements: [{"branch":0,"kind":"all","order":2}], card: { order: 2, required: true } },
			{ name: "type", canonical: "IssueRelationType", canonicalBranches: [0], compatibilityRequirements: [{"branch":0,"kind":"all","order":3}], card: { order: 3, required: true } },
		],
		requirements: {
			canonicalBranches: 1,
			compatibilityBranches: [{}],
		},
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
		semanticException: "The relation guard must be an exact UUID; issue endpoints accept exact issue references.",
		validateVariables(variables) {
			const relationId = variables.relationId;
			if (!isCompatibilityString(relationId) || !UUID.test(relationId)) {
				throw new Error("Invalid relationId: expected a UUID.");
			}
			requireIssueReference(String(variables.issueId));
			requireIssueReference(String(variables.relatedIssueId));
			const relationType = variables.type;
			if (!isCompatibilityString(relationType) || !ISSUE_RELATION_TYPES.has(relationType))
				throw new Error("Invalid type: expected blocks, duplicate, related, or similar.");
		},
		plan(variables) {
			const issueRef = String(variables.issueId);
			const relatedIssueRef = String(variables.relatedIssueId);
			return {
				kind: "mutation",
				lookups: [
					...(!UUID.test(issueRef) ? [issueLookup("issue", issueRef)] : []),
					...(!UUID.test(relatedIssueRef) ? [issueLookup("relatedIssue", relatedIssueRef)] : []),
					issueRelationLookup("issueRelation", String(variables.relationId), RELATION_PREFLIGHT_ERROR),
				],
				finish(resolved) {
					const issue = resolved.issue as import("../client").ResolvedIssue | undefined;
					const relatedIssue = resolved.relatedIssue as import("../client").ResolvedIssue | undefined;
					const prepared = guardedDeletePreparation({
						...variables,
						issueId: issue?.id ?? issueRef,
						relatedIssueId: relatedIssue?.id ?? relatedIssueRef,
					}, resolved.issueRelation as GuardedIssueRelation);
					prepared.resolution = {
						issue: issue ? issueTarget(issueRef, issue) : { requested: issueRef, resolvedId: issueRef },
						relatedIssue: relatedIssue ? issueTarget(relatedIssueRef, relatedIssue) : { requested: relatedIssueRef, resolvedId: relatedIssueRef },
					};
					return prepared;
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
		fields: [
			{ name: "after", canonical: "String" },
			{ name: "before", canonical: "String" },
			{ name: "first", canonical: "Int" },
			{ name: "last", canonical: "Int" },
			{ name: "includeArchived", canonical: "Boolean" },
			{ name: "orderBy", canonical: "PaginationOrderBy" },
		],
		requirements: {
			canonicalBranches: 1,
			compatibilityBranches: [{}],
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
		fields: [
			{ name: "projectId", canonical: "String", canonicalBranches: [0], compatibilityRequirements: [{"branch":0,"kind":"all","order":0}], card: { order: 0, required: true }, accepted: { order: 0 } },
			{ name: "relatedProjectId", canonical: "String", canonicalBranches: [0], compatibilityRequirements: [{"branch":0,"kind":"all","order":1}], card: { order: 1, required: true }, accepted: { order: 1 } },
			{ name: "type", canonical: "String", canonicalBranches: [0], compatibilityRequirements: [{"branch":0,"kind":"all","order":2}], card: { order: 2, required: true }, accepted: { order: 2 } },
			{ name: "anchorType", canonical: "String", canonicalBranches: [0], compatibilityRequirements: [{"branch":0,"kind":"all","order":3}], card: { order: 3, required: true }, accepted: { order: 3 } },
			{ name: "relatedAnchorType", canonical: "String", canonicalBranches: [0], compatibilityRequirements: [{"branch":0,"kind":"all","order":4}], card: { order: 4, required: true }, accepted: { order: 4 } },
			{ name: "projectMilestoneId", canonical: "UUID", accepted: { order: 5 } },
			{ name: "relatedProjectMilestoneId", canonical: "UUID", accepted: { order: 6 } },
			{ name: "input", accepted: { order: 7 } },
		],
		requirements: {
			canonicalBranches: 1,
			compatibilityBranches: [{}],
		},
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
		fields: [
			{ name: "id", canonical: "String", canonicalBranches: [0,1,2,3,4,5,6], compatibilityRequirements: [{"branch":0,"kind":"all","order":0}], card: { order: 0, required: true }, accepted: { order: 0 } },
			{ name: "type", canonical: "String", canonicalBranches: [0], accepted: { order: 1 } },
			{ name: "anchorType", canonical: "String", canonicalBranches: [1], accepted: { order: 4 } },
			{ name: "relatedAnchorType", canonical: "String", canonicalBranches: [2], accepted: { order: 5 } },
			{ name: "projectId", canonical: "UUID", canonicalBranches: [3], accepted: { order: 2 } },
			{ name: "relatedProjectId", canonical: "UUID", canonicalBranches: [4], accepted: { order: 3 } },
			{ name: "projectMilestoneId", canonical: "UUID", canonicalBranches: [5], accepted: { order: 6 } },
			{ name: "relatedProjectMilestoneId", canonical: "UUID", canonicalBranches: [6], accepted: { order: 7 } },
			{ name: "input", card: { order: 1, type: "Input" }, accepted: { order: 8 } },
		],
		requirements: {
			canonicalBranches: 7,
			compatibilityBranches: [{}],
		},
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
