import { projection } from "../selections";
import { issueLookup, pureMutationPlan } from "../operation-plan";
import {
	compactObject,
	isCompatibilityString,
	mergeFilters,
	mergedInput,
	paginationVariables,
} from "../operation-types";
import type {
	CompatibilityObject,
	OperationSource,
	OperationDefinition,
} from "../operation-types";
import { defineOperation } from "../operation-definition";
import {
	issueTarget,
	issueReference,
	object,
	listOperation,
	simpleMutation,
	operationParameterDecision,
} from "./shared";


const COMMENT_CREATE_INPUT_FIELDS = [
	"body",
	"bodyData",
	"createAsUser",
	"createOnSyncedSlackThread",
	"createdAt",
	"displayIconUrl",
	"doNotSubscribeToIssue",
	"documentContentId",
	"id",
	"initiativeId",
	"initiativeUpdateId",
	"issueId",
	"parentId",
	"postId",
	"projectId",
	"projectUpdateId",
	"quotedText",
	"subscriberIds",
] as const;
const COMMENT_UPDATE_INPUT_FIELDS = [
	"body",
	"bodyData",
	"doNotSubscribeToIssue",
	"quotedText",
	"resolvingCommentId",
	"resolvingUserId",
	"subscriberIds",
] as const;


function has(value: CompatibilityObject, key: string): boolean {
	return Object.prototype.hasOwnProperty.call(value, key) && value[key] !== undefined;
}

function commentInputObject(
	variables: CompatibilityObject,
	allowed: readonly string[],
): CompatibilityObject {
	if (!has(variables, "input")) return {};
	const raw = object(variables.input);
	if (!raw) throw new Error("input must be an object");
	const unknown = Object.keys(raw).filter((key) => !allowed.includes(key));
	if (unknown.length) throw new Error(`unknown input fields: ${unknown.join(", ")}`);
	return raw;
}

function assertCommentBodyData(sources: readonly CompatibilityObject[]): void {
	for (const source of sources) {
		if (has(source, "body") && (!isCompatibilityString(source.body) || !source.body.length))
			throw new Error("body must be non-empty text");
		if (has(source, "bodyData") && !object(source.bodyData))
			throw new Error("bodyData must be a JSON object");
	}
}

// Branch metadata owns comment target/content requirements. This exception checks value semantics only.
function validateCommentCreateSemantics(variables: CompatibilityObject): void {
	const raw = commentInputObject(variables, COMMENT_CREATE_INPUT_FIELDS);
	assertCommentBodyData([variables, raw]);
}

// Branch metadata owns the required update set. This exception checks value semantics only.
function validateCommentUpdateSemantics(variables: CompatibilityObject): void {
	const raw = commentInputObject(variables, COMMENT_UPDATE_INPUT_FIELDS);
	assertCommentBodyData([variables, raw]);
}

const updateCommentDocument = `mutation UpdateComment($id: String!, $input: CommentUpdateInput!, $skipEditedAt: Boolean) {
  commentUpdate(id: $id, input: $input, skipEditedAt: $skipEditedAt) {
    success
    comment { ${projection("comment", "detail")} }
  }
}`;

export const comments: readonly OperationDefinition[] = ([
	listOperation({
		name: "list_comments",
		...operationParameterDecision({
		fields: [
			{ name: "issue", canonical: "IssueReference", card: { order: 0 } },
			{ name: "after", canonical: "String" },
			{ name: "before", canonical: "String" },
			{ name: "first", canonical: "Int" },
			{ name: "last", canonical: "Int" },
			{ name: "includeArchived", canonical: "Boolean" },
			{ name: "orderBy", canonical: "PaginationOrderBy" },
			{ name: "filter", canonical: "Filter" },
		],
		requirements: {
			canonicalBranches: 1,
			compatibilityBranches: [{}],
		},
	}),
				renderTargetFields: [
			"issue"
		],
		renderEmpty: {
			"fact": "The target has no comments.",
			"action": "Check another target or add a comment.",
			"filteredFact": "The target has no comments.",
			"filteredAction": "Check another target or add a comment."
		},
				domain: "comments",
		root: "comments",
		selection: projection("comment", "list"),
		purpose: "List comments, optionally for one exact issue.",
		pageSize: 20,
		filterType: "CommentFilter",
				example: { issue: "AEO-258" },
		resolverPaths: { issue: "resolveIssueReference" },
		plan: (variables) => {
			const requested = issueReference(variables);
			return {
				kind: "query",
				lookups: requested ? [issueLookup("issue", requested)] : [],
				finish(resolved) {
					const issue = resolved.issue as import("../client").ResolvedIssue | undefined;
					return {
						variables: { ...paginationVariables(variables, 20), filter: mergeFilters(object(variables.filter), issue ? { issue: { id: { eq: issue.id } } } : undefined) },
						resolution: issue && requested ? { target: issueTarget(requested, issue) } : undefined,
					};
				},
			};
		},
	}),
	simpleMutation({
		name: "create_comment",
		...operationParameterDecision({
		fields: [
			{ name: "issue", canonical: "IssueReference", canonicalBranches: [0,1], compatibilityRequirements: [{"branch":0,"kind":"exactlyOne","group":0,"order":0}], card: { order: 0 }, accepted: { order: 0 } },
			{ name: "projectId", canonical: "UUID", canonicalBranches: [2,3], compatibilityRequirements: [{"branch":0,"kind":"exactlyOne","group":0,"order":2},{"branch":0,"kind":"exactlyOne","group":0,"order":10,"input":true}], accepted: { order: 13 } },
			{ name: "initiativeId", canonical: "UUID", canonicalBranches: [4,5], compatibilityRequirements: [{"branch":0,"kind":"exactlyOne","group":0,"order":3},{"branch":0,"kind":"exactlyOne","group":0,"order":11,"input":true}], accepted: { order: 8 } },
			{ name: "projectUpdateId", canonical: "UUID", canonicalBranches: [6,7], compatibilityRequirements: [{"branch":0,"kind":"exactlyOne","group":0,"order":4},{"branch":0,"kind":"exactlyOne","group":0,"order":12,"input":true}], accepted: { order: 14 } },
			{ name: "initiativeUpdateId", canonical: "UUID", canonicalBranches: [8,9], compatibilityRequirements: [{"branch":0,"kind":"exactlyOne","group":0,"order":5},{"branch":0,"kind":"exactlyOne","group":0,"order":13,"input":true}], accepted: { order: 9 } },
			{ name: "postId", canonical: "UUID", canonicalBranches: [10,11], compatibilityRequirements: [{"branch":0,"kind":"exactlyOne","group":0,"order":6},{"branch":0,"kind":"exactlyOne","group":0,"order":14,"input":true}], accepted: { order: 12 } },
			{ name: "documentContentId", canonical: "UUID", canonicalBranches: [12,13], compatibilityRequirements: [{"branch":0,"kind":"exactlyOne","group":0,"order":7},{"branch":0,"kind":"exactlyOne","group":0,"order":15,"input":true}], accepted: { order: 6 } },
			{ name: "parentId", canonical: "UUID", canonicalBranches: [14,15], compatibilityRequirements: [{"branch":0,"kind":"exactlyOne","group":0,"order":8},{"branch":0,"kind":"exactlyOne","group":0,"order":16,"input":true}], accepted: { order: 11 } },
			{ name: "body", canonical: "String", canonicalBranches: [0,2,4,6,8,10,12,14], compatibilityRequirements: [{"branch":0,"kind":"exactlyOne","group":1,"order":0},{"branch":0,"kind":"exactlyOne","group":1,"order":2,"input":true}], card: { order: 1 }, accepted: { order: 1 }, legacy: [{ order: 1, required: true, branch: 0 }], aliases: [{ order: 1, required: true, operation: "add_comment" }] },
			{ name: "bodyData", canonical: "JsonObject", canonicalBranches: [1,3,5,7,9,11,13,15], compatibilityRequirements: [{"branch":0,"kind":"exactlyOne","group":1,"order":1},{"branch":0,"kind":"exactlyOne","group":1,"order":3,"input":true}], accepted: { order: 2 } },
			{ name: "quotedText", canonical: "String", accepted: { order: 15 } },
			{ name: "doNotSubscribeToIssue", canonical: "Boolean", accepted: { order: 5 } },
			{ name: "createOnSyncedSlackThread", canonical: "Boolean", accepted: { order: 3 } },
			{ name: "createdAt", canonical: "DateTime", accepted: { order: 4 } },
			{ name: "id", canonical: "UUID", accepted: { order: 7 } },
			{ name: "issueId", compatibilityRequirements: [{"branch":0,"kind":"exactlyOne","group":0,"order":1},{"branch":0,"kind":"exactlyOne","group":0,"order":9,"input":true}], accepted: { order: 10 }, legacy: [{ order: 0, required: true, branch: 0 }], aliases: [{ order: 0, required: true, operation: "add_comment" }] },
			{ name: "input", accepted: { order: 16, type: "Input" }, legacy: [{ order: 0, type: "CommentCreateInput", required: true, branch: 1 }] },
		],
		requirements: {
			canonicalBranches: 16,
			compatibilityBranches: [{"exactlyOneGroups":2,"exactlyOneOfMessages":["exactly one comment target is required","exactly one of body or bodyData is required"]}],
			exclusiveCanonical: true,
		},
	}),
				semanticException: "comment-value-types",
		renderTargetFields: [
			"issue",
			"projectId",
			"initiativeId",
			"projectUpdateId",
			"initiativeUpdateId",
			"postId",
			"documentContentId",
			"parentId"
		],
				domain: "comments",
		purpose: "Create a comment on an issue or another supported target.",
		root: "commentCreate",
		inputType: "CommentCreateInput",
		selection: `comment { ${projection("comment", "detail")} }`,
						example: { issue: "AEO-258", body: "Comment text" },
		aliases: ["add_comment"],
						resolverPaths: {
			issue: "resolveIssueReference",
			issueId: "resolveIssueReference",
		},
		validateVariables: validateCommentCreateSemantics,
		plan(variables) {
			validateCommentCreateSemantics(variables);
			const requested = issueReference(variables) || String(object(variables.input)?.issueId ?? "");
			return {
				kind: "mutation",
				lookups: requested ? [issueLookup("issue", requested)] : [],
				finish(resolved) {
					const issue = resolved.issue as import("../client").ResolvedIssue | undefined;
					const prepared = mergedInput(variables, ["issue"]);
					if (issue) prepared.issueId = issue.id;
					return { variables: { input: prepared }, resolution: issue ? { target: issueTarget(requested, issue) } : undefined };
				},
			};
		},
	}),
	simpleMutation({
		name: "update_comment",
		...operationParameterDecision({
		fields: [
			{ name: "id", canonical: "String", canonicalBranches: [0,1,2], compatibilityRequirements: [{"branch":0,"kind":"all","order":0}], card: { order: 0, required: true } },
			{ name: "body", canonical: "String", canonicalBranches: [0], compatibilityRequirements: [{"branch":0,"kind":"atLeastOne","order":0},{"branch":0,"kind":"atLeastOne","order":7,"input":true}], card: { order: 1 } },
			{ name: "bodyData", canonical: "JsonObject", canonicalBranches: [1], compatibilityRequirements: [{"branch":0,"kind":"atLeastOne","order":1},{"branch":0,"kind":"atLeastOne","order":8,"input":true}], card: { order: 2, type: "String" } },
			{ name: "quotedText", canonical: "String", canonicalBranches: [2], compatibilityRequirements: [{"branch":0,"kind":"atLeastOne","order":2},{"branch":0,"kind":"atLeastOne","order":9,"input":true}], card: { order: 3 } },
			{ name: "skipEditedAt", canonical: "Boolean", card: { order: 4 } },
			{ name: "input", card: { order: 5, type: "Input" } },
			{ name: "doNotSubscribeToIssue", compatibilityRequirements: [{"branch":0,"kind":"atLeastOne","order":3},{"branch":0,"kind":"atLeastOne","order":10,"input":true}] },
			{ name: "resolvingUserId", compatibilityRequirements: [{"branch":0,"kind":"atLeastOne","order":4},{"branch":0,"kind":"atLeastOne","order":11,"input":true}] },
			{ name: "resolvingCommentId", compatibilityRequirements: [{"branch":0,"kind":"atLeastOne","order":5},{"branch":0,"kind":"atLeastOne","order":12,"input":true}] },
			{ name: "subscriberIds", compatibilityRequirements: [{"branch":0,"kind":"atLeastOne","order":6},{"branch":0,"kind":"atLeastOne","order":13,"input":true}] },
		],
		requirements: {
			canonicalBranches: 3,
			compatibilityBranches: [{"atLeastOneOfMessage":"at least one comment update field is required"}],
		},
	}),
				semanticException: "comment-value-types",
				domain: "comments",
		purpose: "Update a comment by id.",
		root: "commentUpdate",
		inputType: "CommentUpdateInput",
		selection: `comment { ${projection("comment", "detail")} }`,
		document: updateCommentDocument,
				example: { id: "comment-id", body: "Updated text" },
		idKey: "id",
		validateVariables: validateCommentUpdateSemantics,
		plan(variables) {
			validateCommentUpdateSemantics(variables);
			return pureMutationPlan({
				variables: compactObject({
					id: variables.id,
					input: mergedInput(variables, ["id", "skipEditedAt"]),
					skipEditedAt: variables.skipEditedAt,
				}),
			});
		},
	}),
] satisfies OperationSource[]).map((operation) =>
	defineOperation(operation),
);
