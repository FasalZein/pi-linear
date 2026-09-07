import { projection } from "../selections";
import { issueLookup, pureMutationPlan } from "../operation-plan";
import {
	compactObject,
	isCompatibilityString,
	mergeFilters,
	mergedInput,
	p,
	paginationVariables,
} from "../operation-types";
import type {
	CompatibilityObject,
	OperationSource,
	OperationDefinition,
} from "../operation-types";
import { defineOperation } from "../operation-definition";
import {
	input,
	issueTarget,
	issueReference,
	object,
	listOperation,
	simpleMutation,
	operationParameterDecision,
	operationFieldDecision,
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
const COMMENT_UPDATE_COMPATIBILITY_FIELDS = ["body", "bodyData", "quotedText"] as const;
const commentUpdateInput = [
	...COMMENT_UPDATE_COMPATIBILITY_FIELDS.map((name) => p(name)),
	p("skipEditedAt", "Boolean"),
];

const createCommentFields = operationFieldDecision([
	{ name: "issue", canonical: "IssueReference", card: {"order":0,"type":"IssueReference"}, accepted: {"order":0,"type":"String"} },
	{ name: "projectId", canonical: "UUID", accepted: {"order":13,"type":"String"} },
	{ name: "initiativeId", canonical: "UUID", accepted: {"order":8,"type":"String"} },
	{ name: "projectUpdateId", canonical: "UUID", accepted: {"order":14,"type":"String"} },
	{ name: "initiativeUpdateId", canonical: "UUID", accepted: {"order":9,"type":"String"} },
	{ name: "postId", canonical: "UUID", accepted: {"order":12,"type":"String"} },
	{ name: "documentContentId", canonical: "UUID", accepted: {"order":6,"type":"String"} },
	{ name: "parentId", canonical: "UUID", accepted: {"order":11,"type":"String"} },
	{ name: "body", canonical: "String", card: {"order":1,"type":"String"}, accepted: {"order":1,"type":"String"}, legacy: [{"branch":0,"order":1,"type":"String","required":true}], aliases: [{"operation":"add_comment","order":1,"type":"String","required":true}] },
	{ name: "bodyData", canonical: "JsonObject", accepted: {"order":2,"type":"String"} },
	{ name: "quotedText", canonical: "String", accepted: {"order":15,"type":"String"} },
	{ name: "doNotSubscribeToIssue", canonical: "Boolean", accepted: {"order":5,"type":"String"} },
	{ name: "createOnSyncedSlackThread", canonical: "Boolean", accepted: {"order":3,"type":"String"} },
	{ name: "createdAt", canonical: "DateTime", accepted: {"order":4,"type":"String"} },
	{ name: "id", canonical: "UUID", accepted: {"order":7,"type":"String"} },
	{ name: "issueId", accepted: {"order":10,"type":"String"}, legacy: [{"branch":0,"order":0,"type":"String","required":true}], aliases: [{"operation":"add_comment","order":0,"type":"String","required":true}] },
	{ name: "input", accepted: {"order":16,"type":"Input"}, legacy: [{"branch":1,"order":0,"type":"CommentCreateInput","required":true}] },
]);

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
			compatibilityBranches: [
				{
					"all": []
				}
			],
			canonical: {
				"fields": {
					"issue": "IssueReference",
					"after": "String",
					"before": "String",
					"first": "Int",
					"last": "Int",
					"includeArchived": "Boolean",
					"orderBy": "PaginationOrderBy",
					"filter": "Filter"
				},
				"branches": [
					[]
				]
			},
			parameters: [p("issue", "IssueReference")],
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
			compatibilityBranches: [
				{
					"all": [],
					"exactlyOneOf": [
						[
							"issue",
							"issueId",
							"projectId",
							"initiativeId",
							"projectUpdateId",
							"initiativeUpdateId",
							"postId",
							"documentContentId",
							"parentId",
							"input.issueId",
							"input.projectId",
							"input.initiativeId",
							"input.projectUpdateId",
							"input.initiativeUpdateId",
							"input.postId",
							"input.documentContentId",
							"input.parentId"
						],
						[
							"body",
							"bodyData",
							"input.body",
							"input.bodyData"
						]
					],
					"exactlyOneOfMessages": [
						"exactly one comment target is required",
						"exactly one of body or bodyData is required"
					]
				}
			],
			canonical: {
				"fields": createCommentFields.canonical,
				"branches": [
					[
						"issue",
						"body"
					],
					[
						"issue",
						"bodyData"
					],
					[
						"projectId",
						"body"
					],
					[
						"projectId",
						"bodyData"
					],
					[
						"initiativeId",
						"body"
					],
					[
						"initiativeId",
						"bodyData"
					],
					[
						"projectUpdateId",
						"body"
					],
					[
						"projectUpdateId",
						"bodyData"
					],
					[
						"initiativeUpdateId",
						"body"
					],
					[
						"initiativeUpdateId",
						"bodyData"
					],
					[
						"postId",
						"body"
					],
					[
						"postId",
						"bodyData"
					],
					[
						"documentContentId",
						"body"
					],
					[
						"documentContentId",
						"bodyData"
					],
					[
						"parentId",
						"body"
					],
					[
						"parentId",
						"bodyData"
					]
				],
				"exclusiveBranches": true
			},
			parameters: createCommentFields.card,
			acceptedParameters: createCommentFields.accepted,
			legacyParameters: createCommentFields.legacy,
			aliasParameters: createCommentFields.aliases,
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
			compatibilityBranches: [
				{
					"all": [
						"id"
					],
					"atLeastOneOf": [
						"body",
						"bodyData",
						"quotedText",
						"doNotSubscribeToIssue",
						"resolvingUserId",
						"resolvingCommentId",
						"subscriberIds",
						"input.body",
						"input.bodyData",
						"input.quotedText",
						"input.doNotSubscribeToIssue",
						"input.resolvingUserId",
						"input.resolvingCommentId",
						"input.subscriberIds"
					],
					"atLeastOneOfMessage": "at least one comment update field is required"
				}
			],
			canonical: {
				"fields": {
					"id": "String",
					"body": "String",
					"bodyData": "JsonObject",
					"quotedText": "String",
					"skipEditedAt": "Boolean"
				},
				"branches": [
					[
						"id",
						"body"
					],
					[
						"id",
						"bodyData"
					],
					[
						"id",
						"quotedText"
					]
				]
			},
			parameters: [p("id", "String", true), ...commentUpdateInput, input],
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
