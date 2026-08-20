import { resolveIssueReference } from "../client";
import { COMMENT_SELECTION } from "../selections";
import {
	compactObject,
	mergeFilters,
	mergedInput,
	p,
	paginationVariables,
} from "../operation-types";
import type {
	LinearOperation,
	OperationSource,
	OperationDefinition,
} from "../operation-types";
import { defineOperation } from "../operation-definition";
import {
	input,
	filter,
	issueTarget,
	issueReference,
	object,
	listOperation,
	simpleMutation,
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
const COMMENT_CREATE_COMPATIBILITY_FIELDS = COMMENT_CREATE_INPUT_FIELDS.filter(
	(field) => !["createAsUser", "displayIconUrl", "subscriberIds"].includes(field),
);
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
const commentCreateInput = COMMENT_CREATE_COMPATIBILITY_FIELDS.map((name) => p(name));
const commentUpdateInput = [
	...COMMENT_UPDATE_COMPATIBILITY_FIELDS.map((name) => p(name)),
	p("skipEditedAt", "Boolean"),
];

function has(value: Record<string, unknown>, key: string): boolean {
	return Object.prototype.hasOwnProperty.call(value, key) && value[key] !== undefined;
}

function commentInputObject(
	variables: Record<string, unknown>,
	allowed: readonly string[],
): Record<string, unknown> {
	if (!has(variables, "input")) return {};
	const raw = object(variables.input);
	if (!raw) throw new Error("input must be an object");
	const unknown = Object.keys(raw).filter((key) => !allowed.includes(key));
	if (unknown.length) throw new Error(`unknown input fields: ${unknown.join(", ")}`);
	return raw;
}

function assertCommentBodyData(sources: readonly Record<string, unknown>[]): void {
	for (const source of sources) {
		if (has(source, "body") && (typeof source.body !== "string" || !source.body.length))
			throw new Error("body must be non-empty text");
		if (has(source, "bodyData") && !object(source.bodyData))
			throw new Error("bodyData must be a JSON object");
	}
}

// Branch metadata owns comment target/content requirements. This exception checks value semantics only.
function validateCommentCreateSemantics(variables: Record<string, unknown>): void {
	const raw = commentInputObject(variables, COMMENT_CREATE_INPUT_FIELDS);
	assertCommentBodyData([variables, raw]);
}

// Branch metadata owns the required update set. This exception checks value semantics only.
function validateCommentUpdateSemantics(variables: Record<string, unknown>): void {
	const raw = commentInputObject(variables, COMMENT_UPDATE_INPUT_FIELDS);
	assertCommentBodyData([variables, raw]);
}

const updateCommentDocument = `mutation UpdateComment($id: String!, $input: CommentUpdateInput!, $skipEditedAt: Boolean) {
  commentUpdate(id: $id, input: $input, skipEditedAt: $skipEditedAt) {
    success
    comment { ${COMMENT_SELECTION} }
  }
}`;

export const comments: readonly OperationDefinition[] = ([
	listOperation({
		name: "list_comments",
		compatibilityBranches: [
			{
				"all": []
			}
		],
		renderTargetFields: [
			"issue"
		],
		renderEmpty: {
			"fact": "The target has no comments.",
			"action": "Check another target or add a comment.",
			"filteredFact": "The target has no comments.",
			"filteredAction": "Check another target or add a comment."
		},
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
		domain: "comments",
		root: "comments",
		selection: COMMENT_SELECTION,
		purpose: "List comments, optionally for one exact issue.",
		pageSize: 20,
		filterType: "CommentFilter",
		parameters: [p("issue", "IssueReference")],
		example: { issue: "AEO-258" },
		resolverPaths: { issue: "resolveIssueReference" },
		prepare: async (apiKey, variables, signal) => {
			const requested = issueReference(variables);
			const issue = requested
				? await resolveIssueReference(apiKey, requested, signal)
				: undefined;
			return {
				variables: {
					...paginationVariables(variables, 20),
					filter: mergeFilters(
						object(variables.filter),
						issue ? { issue: { id: { eq: issue.id } } } : undefined,
					),
				},
				resolution: issue
					? { target: issueTarget(requested, issue) }
					: undefined,
			};
		},
	}),
	simpleMutation({
		name: "create_comment",
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
		canonical: {
			"fields": {
				"issue": "IssueReference",
				"projectId": "UUID",
				"initiativeId": "UUID",
				"projectUpdateId": "UUID",
				"initiativeUpdateId": "UUID",
				"postId": "UUID",
				"documentContentId": "UUID",
				"parentId": "UUID",
				"body": "String",
				"bodyData": "JsonObject",
				"quotedText": "String",
				"doNotSubscribeToIssue": "Boolean",
				"createOnSyncedSlackThread": "Boolean",
				"createdAt": "DateTime",
				"id": "UUID"
			},
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
		domain: "comments",
		purpose: "Create a comment on an issue or another supported target.",
		root: "commentCreate",
		inputType: "CommentCreateInput",
		selection: `comment { ${COMMENT_SELECTION} }`,
		parameters: [p("issue", "IssueReference"), p("body", "String")],
		acceptedParameters: [p("issue"), ...commentCreateInput, input],
		example: { issue: "AEO-258", body: "Comment text" },
		aliases: ["add_comment"],
		legacyParameters: [
			[p("issueId", "String", true), p("body", "String", true)],
			[p("input", "CommentCreateInput", true)],
		],
		aliasParameters: {
			add_comment: [p("issueId", "String", true), p("body", "String", true)],
		},
		resolverPaths: {
			issue: "resolveIssueReference",
			issueId: "resolveIssueReference",
		},
		validateVariables: validateCommentCreateSemantics,
		async prepare(apiKey, variables, signal) {
			validateCommentCreateSemantics(variables);
			const requested =
				issueReference(variables) ||
				String(object(variables.input)?.issueId ?? "");
			const issue = requested
				? await resolveIssueReference(apiKey, requested, signal)
				: undefined;
			const prepared = mergedInput(variables, ["issue"]);
			if (issue) prepared.issueId = issue.id;
			return {
				variables: { input: prepared },
				resolution: issue
					? { target: issueTarget(requested, issue) }
					: undefined,
			};
		},
	}),
	simpleMutation({
		name: "update_comment",
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
		semanticException: "comment-value-types",
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
		domain: "comments",
		purpose: "Update a comment by id.",
		root: "commentUpdate",
		inputType: "CommentUpdateInput",
		selection: `comment { ${COMMENT_SELECTION} }`,
		document: updateCommentDocument,
		parameters: [p("id", "String", true), ...commentUpdateInput, input],
		example: { id: "comment-id", body: "Updated text" },
		idKey: "id",
		validateVariables: validateCommentUpdateSemantics,
		async prepare(_apiKey, variables) {
			validateCommentUpdateSemantics(variables);
			return {
				variables: compactObject({
					id: variables.id,
					input: mergedInput(variables, ["id", "skipEditedAt"]),
					skipEditedAt: variables.skipEditedAt,
				}),
			};
		},
	}),
] satisfies OperationSource[]).map((operation) =>
	defineOperation(operation as LinearOperation),
);
