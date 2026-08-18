import {
	resolveDocumentReference,
	resolveIssueReference,
	resolveNamedEntityReference,
	resolveStateIdReference,
	resolveStateReference,
	resolveTeamReference,
	resolveUserReference,
	switchWorkspace,
	type ResolvedIssue,
} from "./client";
import {
	COMMENT_SELECTION,
	CYCLE_SELECTION,
	DOCUMENT_SELECTION,
	INITIATIVE_SELECTION,
	ISSUE_LABEL_SELECTION,
	ISSUE_RELATION_SELECTION,
	ISSUE_SELECTION,
	MILESTONE_SELECTION,
	PAGE_INFO,
	PROJECT_DETAIL_SELECTION,
	PROJECT_LABEL_SELECTION,
	PROJECT_LIST_SELECTION,
	PROJECT_RELATION_SELECTION,
	TEAM_SELECTION,
	USER_SELECTION,
	VIEW_SELECTION,
	WORKFLOW_STATE_SELECTION,
} from "./selections";
import {
	compactObject,
	mergeFilters,
	mergedInput,
	p,
	paginationVariables,
	type GraphQLDocumentVariant,
	type LinearOperation,
	type OperationDefinition,
	type OperationDomain,
	type OperationParameter,
} from "./operation-types";
import type { CanonicalOperation } from "./canonical-schema";
import {
	defineOperation,
	projectCompatibilityOperation,
} from "./operation-definition";
export { projectCompatibilityOperation } from "./operation-definition";
export type {
	LinearOperation,
	OperationDomain,
	OperationParameter,
} from "./operation-types";

export const DOMAINS = [
	"issues",
	"comments",
	"users",
	"teams",
	"projects",
	"cycles",
	"milestones",
	"initiatives",
	"documents",
	"views",
	"labels",
	"relations",
	"workspace",
] as const satisfies readonly OperationDomain[];

const pagination = [
	p("after"),
	p("before"),
	p("first", "Int"),
	p("last", "Int"),
	p("includeArchived", "Boolean"),
	p("orderBy", "PaginationOrderBy"),
];
const input = p("input", "Input");
const filter = p("filter", "Filter");
const sort = p("sort", "[SortInput!]");
const ISSUE_SORT_KEYS = [
	"priority",
	"estimate",
	"title",
	"label",
	"labelGroup",
	"slaStatus",
	"createdAt",
	"updatedAt",
	"completedAt",
	"dueDate",
	"accumulatedStateUpdatedAt",
	"cycle",
	"milestone",
	"assignee",
	"delegate",
	"project",
	"team",
	"manual",
	"workflowState",
	"customer",
	"customerRevenue",
	"customerCount",
	"customerImportantCount",
	"rootIssue",
	"linkCount",
	"release",
] as const;
const PROJECT_SORT_KEYS = [
	"name",
	"status",
	"priority",
	"manual",
	"targetDate",
	"startDate",
	"createdAt",
	"updatedAt",
	"health",
	"lead",
] as const;
const INITIATIVE_SORT_KEYS = [
	"name",
	"manual",
	"updatedAt",
	"createdAt",
	"targetDate",
	"health",
	"healthUpdatedAt",
	"owner",
	"priority",
] as const;
const USER_SORT_KEYS = ["name", "displayName"] as const;
const DOCUMENT_SORT_KEYS = [
	"title",
	"creator",
	"project",
	"createdAt",
	"updatedAt",
] as const;

function issueTarget(requested: string, issue: ResolvedIssue) {
	return { requested, resolvedId: issue.id, identifier: issue.identifier };
}
function issueReference(
	variables: Record<string, unknown>,
	key = "issue",
): string {
	const value = variables[key] ?? variables[`${key}Id`];
	if (typeof value === "string") return value;
	if (
		key === "issue" &&
		typeof variables.teamKey === "string" &&
		variables.number !== undefined
	) {
		return `${variables.teamKey}-${variables.number}`;
	}
	return "";
}
function isUuid(value: unknown): value is string {
	return (
		typeof value === "string" &&
		/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
			value,
		)
	);
}
function object(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}
function listDocument(
	name: string,
	root: string,
	selection: string,
	options: {
		filterType?: string;
		sortType?: string;
		extras?: string;
		extraArgs?: string;
	} = {},
) {
	return `query ${name}(
    $after: String $before: String $first: Int $includeArchived: Boolean $last: Int $orderBy: PaginationOrderBy
    ${options.filterType ? `$filter: ${options.filterType}` : ""}
    ${options.sortType ? `$sort: [${options.sortType}!]` : ""}
    ${options.extras ?? ""}
  ) {
    ${root}(after: $after before: $before first: $first includeArchived: $includeArchived last: $last orderBy: $orderBy
      ${options.filterType ? "filter: $filter" : ""} ${options.sortType ? "sort: $sort" : ""} ${options.extraArgs ?? ""}) {
      nodes { ${selection} } ${PAGE_INFO}
    }
  }`;
}
function getDocument(name: string, root: string, selection: string) {
	return `query ${name}($id: String!) { ${root}(id: $id) { ${selection} } }`;
}
function mutationDocument(
	name: string,
	root: string,
	inputType: string,
	selection: string,
	id = false,
) {
	return `mutation ${name}(${id ? "$id: String! " : ""}$input: ${inputType}!) {
    ${root}(${id ? "id: $id, " : ""}input: $input) { success ${selection} }
  }`;
}
function mutationVariant(
	document: string,
	root: string,
	entityPath: string,
	when?: "create" | "update",
): GraphQLDocumentVariant {
	return {
		...(when ? { when } : {}),
		document,
		root,
		mutationResult: {
			successPath: "success",
			successValue: true,
			requiredEntityPaths: [entityPath],
		},
	};
}
function listPrepare(
	defaultPageSize: number,
	extra?: (
		variables: Record<string, unknown>,
	) => Promise<Record<string, unknown>> | Record<string, unknown>,
) {
	return async (_apiKey: string, variables: Record<string, unknown>) => ({
		variables: compactObject({
			...paginationVariables(variables, defaultPageSize),
			filter: object(variables.filter),
			sort: Array.isArray(variables.sort) ? variables.sort : undefined,
			...(extra ? await extra(variables) : {}),
		}),
	});
}
function plainInputPrepare(omitted: readonly string[] = []) {
	return async (_apiKey: string, variables: Record<string, unknown>) => ({
		variables: { input: mergedInput(variables, omitted) },
	});
}
function updateInputPrepare(idKey = "id", omitted: readonly string[] = []) {
	return async (_apiKey: string, variables: Record<string, unknown>) => {
		const update = mergedInput(variables, [idKey, ...omitted]);
		if (!Object.keys(update).length)
			throw new Error("No update fields were provided.");
		return { variables: { id: variables[idKey], input: update } };
	};
}
function listOperation(config: {
	name: string;
	canonical: CanonicalOperation;
	domain: OperationDomain;
	root: string;
	selection: string;
	purpose: string;
	pageSize: number;
	filterType?: string;
	sortType?: string;
	sortKeys?: readonly string[];
	parameters?: readonly OperationParameter[];
	extras?: string;
	extraArgs?: string;
	prepare?: LinearOperation["prepare"];
	aliases?: readonly string[];
	example?: Record<string, unknown>;
	resolverPaths?: Record<string, string>;
	acceptedParameters?: readonly OperationParameter[];
	validateVariables?: LinearOperation["validateVariables"];
}): LinearOperation {
	const parameters = config.parameters ?? [];
	const document = listDocument(
		config.name.replace(/(^|_)(\w)/g, (_, _a, c) => c.toUpperCase()),
		config.root,
		config.selection,
		config,
	);
	return {
		name: config.name,
		canonical: config.canonical,
		aliases: config.aliases ?? [],
		domain: config.domain,
		purpose: config.purpose,
		parameters: [
			...parameters,
			...pagination,
			...(config.filterType ? [filter] : []),
			...(config.sortType ? [sort] : []),
		],
		acceptedParameters: config.acceptedParameters,
		example: { operation: config.name, variables: config.example ?? {} },
		document,
		pagination: {
			defaultPageSize: config.pageSize,
			...(config.filterType ? { filterType: config.filterType } : {}),
			...(config.sortType ? { sortType: config.sortType } : {}),
			...(config.sortKeys ? { sortKeys: config.sortKeys } : {}),
		},
		resolverPaths: config.resolverPaths,
		validateVariables: config.validateVariables,
		prepare: config.prepare ?? listPrepare(config.pageSize),
	};
}
function simpleMutation(config: {
	name: string;
	canonical: CanonicalOperation;
	domain: OperationDomain;
	purpose: string;
	root: string;
	inputType: string;
	selection: string;
	parameters: readonly OperationParameter[];
	acceptedParameters?: readonly OperationParameter[];
	example: Record<string, unknown>;
	idKey?: string;
	prepare?: LinearOperation["prepare"];
	aliases?: readonly string[];
	legacyParameters?: LinearOperation["legacyParameters"];
	aliasParameters?: LinearOperation["aliasParameters"];
	resolverPaths?: Record<string, string>;
	validateVariables?: LinearOperation["validateVariables"];
	document?: string;
}): LinearOperation {
	const document =
		config.document ??
		mutationDocument(
			config.name.replace(/(^|_)(\w)/g, (_, _a, c) => c.toUpperCase()),
			config.root,
			config.inputType,
			config.selection,
			Boolean(config.idKey),
		);
	const entityPath = config.selection.trim().match(/^(\w+)\s*\{/)?.[1];
	if (!entityPath) throw new Error(`Mutation ${config.name} must select a result entity.`);
	return {
		name: config.name,
		canonical: config.canonical,
		aliases: config.aliases ?? [],
		domain: config.domain,
		purpose: config.purpose,
		parameters: config.parameters,
		acceptedParameters: config.acceptedParameters,
		legacyParameters: config.legacyParameters,
		aliasParameters: config.aliasParameters,
		example: { operation: config.name, variables: config.example },
		document,
		variants: [mutationVariant(document, config.root, entityPath)],
		resolverPaths: config.resolverPaths,
		validateVariables: config.validateVariables,
		prepare:
			config.prepare ??
			(config.idKey ? updateInputPrepare(config.idKey) : plainInputPrepare()),
	};
}

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
const issueCreateFields = [
	"teamId",
	"teamKey",
	"title",
	"description",
	"assigneeId",
	"completedAt",
	"createAsUser",
	"createdAt",
	"cycleId",
	"delegateId",
	"descriptionData",
	"displayIconUrl",
	"dueDate",
	"estimate",
	"id",
	"labelIds",
	"lastAppliedTemplateId",
	"parentId",
	"preserveSortOrderOnCreate",
	"priority",
	"prioritySortOrder",
	"projectId",
	"projectMilestoneId",
	"referenceCommentId",
	"slaBreachesAt",
	"slaStartedAt",
	"slaType",
	"sortOrder",
	"sourceCommentId",
	"sourcePullRequestCommentId",
	"stateId",
	"subIssueSortOrder",
	"subscriberIds",
	"templateId",
	"useDefaultTemplate",
].map((name) => p(name));
const createIssueLabelDocument = `mutation CreateIssueLabel($input: IssueLabelCreateInput!, $replaceTeamLabels: Boolean) {
  issueLabelCreate(input: $input, replaceTeamLabels: $replaceTeamLabels) {
    success
    issueLabel { ${ISSUE_LABEL_SELECTION} }
  }
}`;
const updateCommentDocument = `mutation UpdateComment($id: String!, $input: CommentUpdateInput!, $skipEditedAt: Boolean) {
  commentUpdate(id: $id, input: $input, skipEditedAt: $skipEditedAt) {
    success
    comment { ${COMMENT_SELECTION} }
  }
}`;
const updateIssueLabelDocument = `mutation UpdateIssueLabel($id: String!, $input: IssueLabelUpdateInput!, $replaceTeamLabels: Boolean) {
  issueLabelUpdate(id: $id, input: $input, replaceTeamLabels: $replaceTeamLabels) {
    success
    issueLabel { ${ISSUE_LABEL_SELECTION} }
  }
}`;

const issueUpdateFields = [
	"title",
	"description",
	"priority",
	"stateId",
	"assigneeId",
	"dueDate",
	"addedLabelIds",
	"autoClosedByParentClosing",
	"cycleId",
	"delegateId",
	"descriptionData",
	"estimate",
	"labelIds",
	"lastAppliedTemplateId",
	"parentId",
	"prioritySortOrder",
	"projectId",
	"projectMilestoneId",
	"removedLabelIds",
	"slaBreachesAt",
	"slaStartedAt",
	"slaType",
	"snoozedById",
	"snoozedUntilAt",
	"sortOrder",
	"subIssueSortOrder",
	"subscriberIds",
	"teamId",
	"trashed",
].map((name) => p(name));

const operationDefinitionsMutable: OperationDefinition[] = ([
	listOperation({
		name: "list_comments",
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

	listOperation({
		name: "list_views",
		canonical: {
			"fields": {
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
		domain: "views",
		root: "customViews",
		selection: VIEW_SELECTION,
		purpose: "List custom views.",
		pageSize: 50,
		filterType: "CustomViewFilter",
	}),
	{
		name: "get_view",
		canonical: {
			"fields": {
				"id": "String"
			},
			"branches": [
				[
					"id"
				]
			]
		},
		aliases: [],
		domain: "views",
		purpose: "Get a custom view.",
		parameters: [p("id", "String", true)],
		example: { operation: "get_view", variables: { id: "view-id" } },
		document: getDocument("GetView", "customView", VIEW_SELECTION),
		async prepare(_k, v) {
			return { variables: { id: v.id } };
		},
	},
	simpleMutation({
		name: "create_view",
		canonical: {
			"fields": {
				"name": "String",
				"team": "TeamReference",
				"description": "String",
				"icon": "String",
				"color": "Color",
				"shared": "Boolean",
				"filterData": "FilterData",
				"projectFilterData": "FilterData",
				"initiativeFilterData": "FilterData",
				"feedItemFilterData": "FilterData"
			},
			"branches": [
				[
					"name"
				]
			]
		},
		domain: "views",
		purpose:
			"Create a custom view using filterData, projectFilterData, initiativeFilterData, or feedItemFilterData.",
		root: "customViewCreate",
		inputType: "CustomViewCreateInput",
		selection: `customView { ${VIEW_SELECTION} }`,
		parameters: [
			p("name", "String", true),
			p("filterData", "Object"),
			p("projectFilterData", "Object"),
			p("initiativeFilterData", "Object"),
			p("feedItemFilterData", "Object"),
			p("team", "TeamReference"),
		],
		acceptedParameters: [
			p("name", "String", true),
			...[
				"filterData",
				"projectFilterData",
				"initiativeFilterData",
				"feedItemFilterData",
				"team",
				"teamId",
				"teamKey",
				"description",
				"icon",
				"color",
				"shared",
			].map((n) => p(n)),
		],
		example: { name: "My issues", filterData: {} },
		resolverPaths: {
			team: "resolveTeamReference",
			teamKey: "resolveTeamReference",
		},
		async prepare(apiKey, v, signal) {
			const x = mergedInput(v, ["team", "teamKey"]);
			const ref = String(v.team ?? v.teamKey ?? v.teamId ?? "");
			if (ref) x.teamId = (await resolveTeamReference(apiKey, ref, signal)).id;
			return { variables: { input: x } };
		},
	}),
	simpleMutation({
		name: "update_view",
		canonical: {
			"fields": {
				"id": "String",
				"name": "String",
				"description": "String",
				"icon": "String",
				"color": "Color",
				"shared": "Boolean",
				"filterData": "FilterData",
				"projectFilterData": "FilterData",
				"initiativeFilterData": "FilterData",
				"feedItemFilterData": "FilterData"
			},
			"branches": [
				[
					"id",
					"name"
				],
				[
					"id",
					"description"
				],
				[
					"id",
					"icon"
				],
				[
					"id",
					"color"
				],
				[
					"id",
					"shared"
				],
				[
					"id",
					"filterData"
				],
				[
					"id",
					"projectFilterData"
				],
				[
					"id",
					"initiativeFilterData"
				],
				[
					"id",
					"feedItemFilterData"
				]
			]
		},
		domain: "views",
		purpose: "Update a custom view.",
		root: "customViewUpdate",
		inputType: "CustomViewUpdateInput",
		selection: `customView { ${VIEW_SELECTION} }`,
		parameters: [p("id", "String", true), input],
		acceptedParameters: [
			"id",
			"name",
			"filterData",
			"projectFilterData",
			"initiativeFilterData",
			"feedItemFilterData",
			"description",
			"icon",
			"color",
			"shared",
			"input",
		].map((n) => p(n)),
		example: { id: "view-id", name: "New name" },
		idKey: "id",
	}),
	simpleMutation({
		name: "set_view_preferences",
		canonical: {
			"fields": {
				"viewId": "String",
				"preferences": "Preferences"
			},
			"branches": [
				[
					"viewId",
					"preferences"
				]
			]
		},
		domain: "views",
		purpose: "Set preferences for a custom view.",
		root: "viewPreferencesCreate",
		inputType: "ViewPreferencesCreateInput",
		selection: "viewPreferences { id type viewType }",
		parameters: [p("viewId", "String", true), p("preferences", "Object", true)],
		example: { viewId: "view-id", preferences: {} },
		async prepare(_k, v) {
			return {
				variables: {
					input: {
						type: "user",
						viewType: "customView",
						customViewId: v.viewId,
						preferences: v.preferences,
					},
				},
			};
		},
	}),

	listOperation({
		name: "list_cycles",
		canonical: {
			"fields": {
				"team": "TeamReference",
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
		domain: "cycles",
		root: "cycles",
		selection: CYCLE_SELECTION,
		purpose: "List cycles.",
		pageSize: 50,
		filterType: "CycleFilter",
		parameters: [p("team", "TeamReference")],
		acceptedParameters: [
			p("team"),
			p("teamId"),
			p("teamKey"),
			...pagination,
			filter,
		],
		resolverPaths: { team: "resolveTeamReference" },
		prepare: async (apiKey, v, signal) => {
			const ref = String(v.team ?? v.teamKey ?? v.teamId ?? "");
			const team = ref
				? await resolveTeamReference(apiKey, ref, signal)
				: undefined;
			return {
				variables: {
					...paginationVariables(v, 50),
					filter: mergeFilters(
						object(v.filter),
						team ? { team: { id: { eq: team.id } } } : undefined,
					),
				},
			};
		},
	}),
	{
		name: "get_cycle",
		canonical: {
			"fields": {
				"cycle": "CycleReference"
			},
			"branches": [
				[
					"cycle"
				]
			]
		},
		aliases: [],
		domain: "cycles",
		purpose: "Get a cycle by exact name or UUID.",
		parameters: [p("cycle", "CycleReference", true)],
		legacyParameters: [[p("id", "String", true)]],
		example: { operation: "get_cycle", variables: { cycle: "Cycle 12" } },
		document: getDocument("GetCycle", "cycle", CYCLE_SELECTION),
		resolverPaths: { cycle: "resolveNamedEntityReference" },
		async prepare(k, v, s) {
			const x = await resolveNamedEntityReference(
				k,
				"cycle",
				String(v.cycle ?? v.id),
				s,
			);
			return {
				variables: { id: x.id },
				resolution: {
					target: { requested: v.cycle, resolvedId: x.id, name: x.name },
				},
			};
		},
	},
	simpleMutation({
		name: "create_cycle",
		canonical: {
			"fields": {
				"team": "TeamReference",
				"startsAt": "DateTime",
				"endsAt": "DateTime",
				"name": "String",
				"description": "String"
			},
			"branches": [
				[
					"team",
					"startsAt",
					"endsAt"
				]
			]
		},
		domain: "cycles",
		purpose: "Create a cycle.",
		root: "cycleCreate",
		inputType: "CycleCreateInput",
		selection: `cycle { ${CYCLE_SELECTION} }`,
		parameters: [
			p("team", "TeamReference", true),
			p("startsAt", "DateTime", true),
			p("endsAt", "DateTime", true),
		],
		acceptedParameters: [
			"team",
			"name",
			"description",
			"startsAt",
			"endsAt",
		].map((n) => p(n)),
		legacyParameters: [
			[
				p("teamId", "String", true),
				p("startsAt", "DateTime", true),
				p("endsAt", "DateTime", true),
				p("name"),
				p("description"),
			],
			[
				p("teamKey", "String", true),
				p("startsAt", "DateTime", true),
				p("endsAt", "DateTime", true),
				p("name"),
				p("description"),
			],
		],
		example: { team: "AEO", startsAt: "2026-08-17", endsAt: "2026-08-31" },
		resolverPaths: { team: "resolveTeamReference" },
		async prepare(k, v, s) {
			const team = await resolveTeamReference(
				k,
				String(v.team ?? v.teamKey ?? v.teamId),
				s,
			);
			return {
				variables: {
					input: {
						...mergedInput(v, ["team", "teamKey", "teamId"]),
						teamId: team.id,
					},
				},
				resolution: {
					team: {
						requested: v.team ?? v.teamKey ?? v.teamId,
						resolvedId: team.id,
						key: team.key,
					},
				},
			};
		},
	}),
	simpleMutation({
		name: "update_cycle",
		canonical: {
			"fields": {
				"id": "String",
				"name": "String",
				"description": "String",
				"startsAt": "DateTime",
				"endsAt": "DateTime",
				"completedAt": "DateTime"
			},
			"branches": [
				[
					"id",
					"name"
				],
				[
					"id",
					"description"
				],
				[
					"id",
					"startsAt"
				],
				[
					"id",
					"endsAt"
				],
				[
					"id",
					"completedAt"
				]
			]
		},
		domain: "cycles",
		purpose: "Update a cycle.",
		root: "cycleUpdate",
		inputType: "CycleUpdateInput",
		selection: `cycle { ${CYCLE_SELECTION} }`,
		parameters: [
			p("id", "String", true),
			p("name"),
			p("description"),
			p("startsAt"),
			p("endsAt"),
			p("completedAt"),
		],
		example: { id: "cycle-id", name: "Cycle 12" },
		idKey: "id",
	}),

	listOperation({
		name: "list_documents",
		canonical: {
			"fields": {
				"sort": "[DocumentSort!]",
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
		domain: "documents",
		root: "documents",
		selection: DOCUMENT_SELECTION,
		purpose: "List documents.",
		pageSize: 20,
		filterType: "DocumentFilter",
		sortType: "DocumentSortInput",
		sortKeys: DOCUMENT_SORT_KEYS,
	}),
	{
		name: "get_document",
		canonical: {
			"fields": {
				"document": "DocumentReference"
			},
			"branches": [
				[
					"document"
				]
			]
		},
		aliases: [],
		domain: "documents",
		purpose: "Get a document by exact title or UUID.",
		parameters: [p("document", "DocumentReference", true)],
		legacyParameters: [[p("documentId", "String", true)]],
		example: {
			operation: "get_document",
			variables: { document: "Planning notes" },
		},
		document: getDocument("GetDocument", "document", DOCUMENT_SELECTION),
		resolverPaths: { document: "resolveNamedEntityReference" },
		async prepare(k, v, s) {
			const x = await resolveNamedEntityReference(
				k,
				"document",
				String(v.document ?? v.documentId),
				s,
			);
			return { variables: { id: x.id } };
		},
	},
	simpleMutation({
		name: "create_document",
		canonical: {
			"fields": {
				"title": "String",
				"content": "String",
				"icon": "String",
				"color": "Color",
				"issueId": "IssueReference",
				"teamId": "TeamReference",
				"projectId": "UUID",
				"initiativeId": "UUID",
				"cycleId": "UUID",
				"releaseId": "UUID",
				"resourceFolderId": "UUID",
				"lastAppliedTemplateId": "UUID",
				"ownerId": "UUID",
				"subscriberIds": "[UUID!]",
				"sortOrder": "Float",
				"id": "UUID"
			},
			"branches": [
				[
					"title"
				]
			]
		},
		domain: "documents",
		purpose: "Create a document.",
		root: "documentCreate",
		inputType: "DocumentCreateInput",
		selection: `document { ${DOCUMENT_SELECTION} }`,
		parameters: [p("title", "String", true), input],
		acceptedParameters: [
			"color",
			"content",
			"cycleId",
			"icon",
			"id",
			"initiativeId",
			"issueId",
			"lastAppliedTemplateId",
			"ownerId",
			"projectId",
			"releaseId",
			"resourceFolderId",
			"sortOrder",
			"subscriberIds",
			"teamId",
			"teamKey",
			"title",
			"input",
		].map((n) => p(n)),
		legacyParameters: [[p("input", "DocumentCreateInput", true)]],
		example: { title: "Planning notes", content: "Notes" },
		validateVariables(variables) {
			if (
				variables.input &&
				typeof (variables.title ?? object(variables.input)?.title) !== "string"
			) {
				throw new Error("canonical fields or nested input require title");
			}
		},
		resolverPaths: {
			issueId: "resolveIssueReference",
			teamKey: "resolveTeamReference",
			teamId: "resolveTeamReference",
		},
		async prepare(k, v, s) {
			const x = mergedInput(v, ["teamKey"]);
			const resolution: Record<string, unknown> = {};
			if (typeof x.issueId === "string") {
				const issue = await resolveIssueReference(k, x.issueId, s);
				resolution.issue = issueTarget(x.issueId, issue);
				x.issueId = issue.id;
			}
			const related = [
				"cycleId",
				"initiativeId",
				"issueId",
				"projectId",
				"releaseId",
				"resourceFolderId",
			].some((key) => typeof x[key] === "string" && x[key]);
			const teamRef = v.teamKey ?? x.teamId;
			if (related) delete x.teamId;
			else if (teamRef) {
				const team = await resolveTeamReference(k, String(teamRef), s);
				resolution.team = {
					requested: teamRef,
					resolvedId: team.id,
					key: team.key,
				};
				x.teamId = team.id;
			}
			if (typeof x.title !== "string" || !x.title.trim())
				throw new Error(
					"Document title is required for documentCreate (title).",
				);
			return { variables: { input: x }, resolution };
		},
	}),
	simpleMutation({
		name: "update_document",
		canonical: {
			"fields": {
				"documentId": "DocumentReference",
				"title": "String",
				"content": "String",
				"icon": "String",
				"color": "Color",
				"issueId": "IssueReference",
				"teamId": "TeamReference",
				"projectId": "UUID",
				"initiativeId": "UUID",
				"cycleId": "UUID",
				"releaseId": "UUID",
				"resourceFolderId": "UUID",
				"lastAppliedTemplateId": "UUID",
				"ownerId": "UUID",
				"subscriberIds": "[UUID!]",
				"sortOrder": "Float",
				"hiddenAt": "NullableDateTime"
			},
			"branches": [
				[
					"documentId",
					"title"
				],
				[
					"documentId",
					"content"
				],
				[
					"documentId",
					"icon"
				],
				[
					"documentId",
					"color"
				],
				[
					"documentId",
					"issueId"
				],
				[
					"documentId",
					"teamId"
				],
				[
					"documentId",
					"projectId"
				],
				[
					"documentId",
					"initiativeId"
				],
				[
					"documentId",
					"cycleId"
				],
				[
					"documentId",
					"releaseId"
				],
				[
					"documentId",
					"resourceFolderId"
				],
				[
					"documentId",
					"lastAppliedTemplateId"
				],
				[
					"documentId",
					"ownerId"
				],
				[
					"documentId",
					"subscriberIds"
				],
				[
					"documentId",
					"sortOrder"
				],
				[
					"documentId",
					"hiddenAt"
				]
			]
		},
		domain: "documents",
		purpose: "Update a document.",
		root: "documentUpdate",
		inputType: "DocumentUpdateInput",
		selection: `document { ${DOCUMENT_SELECTION} }`,
		parameters: [p("documentId", "DocumentReference", true), input],
		acceptedParameters: [
			"documentId",
			"color",
			"content",
			"cycleId",
			"hiddenAt",
			"icon",
			"initiativeId",
			"issueId",
			"lastAppliedTemplateId",
			"ownerId",
			"projectId",
			"releaseId",
			"resourceFolderId",
			"sortOrder",
			"subscriberIds",
			"teamId",
			"teamKey",
			"title",
			"trashed",
			"input",
		].map((n) => p(n)),
		example: { documentId: "document-id", title: "Updated notes" },
		idKey: "documentId",
		resolverPaths: {
			documentId: "resolveDocumentReference",
			issueId: "resolveIssueReference",
			teamKey: "resolveTeamReference",
			teamId: "resolveTeamReference",
		},
		async prepare(k, v, s) {
			const requested = String(v.documentId);
			const document = await resolveDocumentReference(k, requested, s);
			const x = mergedInput(v, ["documentId", "teamKey"]);
			const resolution: Record<string, unknown> = {
				target: { requested, resolvedId: document.id, title: document.title },
			};
			if (typeof x.issueId === "string") {
				const issue = await resolveIssueReference(k, x.issueId, s);
				resolution.issue = issueTarget(x.issueId, issue);
				x.issueId = issue.id;
			}
			const related = [
				"cycleId",
				"initiativeId",
				"issueId",
				"projectId",
				"releaseId",
				"resourceFolderId",
			].some((key) => typeof x[key] === "string" && x[key]);
			const teamRef = v.teamKey ?? x.teamId;
			if (related) delete x.teamId;
			else if (teamRef) {
				const team = await resolveTeamReference(k, String(teamRef), s);
				resolution.team = {
					requested: teamRef,
					resolvedId: team.id,
					key: team.key,
				};
				x.teamId = team.id;
			}
			if (!Object.keys(x).length)
				throw new Error("No update fields were provided.");
			return { variables: { id: document.id, input: x }, resolution };
		},
	}),

	listOperation({
		name: "list_initiatives",
		canonical: {
			"fields": {
				"sort": "[InitiativeSort!]",
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
		domain: "initiatives",
		root: "initiatives",
		selection: INITIATIVE_SELECTION,
		purpose: "List initiatives.",
		pageSize: 20,
		filterType: "InitiativeFilter",
		sortType: "InitiativeSortInput",
		sortKeys: INITIATIVE_SORT_KEYS,
	}),
	{
		name: "get_initiative",
		canonical: {
			"fields": {
				"initiative": "InitiativeReference"
			},
			"branches": [
				[
					"initiative"
				]
			]
		},
		aliases: [],
		domain: "initiatives",
		purpose: "Get an initiative by exact name or UUID.",
		parameters: [p("initiative", "InitiativeReference", true)],
		legacyParameters: [[p("initiativeId", "String", true)]],
		example: {
			operation: "get_initiative",
			variables: { initiative: "Platform" },
		},
		document: getDocument("GetInitiative", "initiative", INITIATIVE_SELECTION),
		resolverPaths: { initiative: "resolveNamedEntityReference" },
		async prepare(k, v, s) {
			const x = await resolveNamedEntityReference(
				k,
				"initiative",
				String(v.initiative ?? v.initiativeId),
				s,
			);
			return { variables: { id: x.id } };
		},
	},

	listOperation({
		name: "list_issue_labels",
		canonical: {
			"fields": {
				"team": "TeamReference",
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
		domain: "labels",
		root: "issueLabels",
		selection: ISSUE_LABEL_SELECTION,
		purpose: "List issue labels.",
		pageSize: 50,
		filterType: "IssueLabelFilter",
		parameters: [p("team", "TeamReference")],
		acceptedParameters: [
			p("team"),
			p("teamId"),
			p("teamKey"),
			...pagination,
			filter,
		],
		resolverPaths: { team: "resolveTeamReference" },
		prepare: async (k, v, s) => {
			const ref = v.team ?? v.teamKey ?? v.teamId;
			const team = ref
				? await resolveTeamReference(k, String(ref), s)
				: undefined;
			return {
				variables: {
					...paginationVariables(v, 50),
					filter: mergeFilters(
						object(v.filter),
						team ? { team: { id: { eq: team.id } } } : undefined,
					),
				},
				resolution: team
					? { team: { requested: ref, resolvedId: team.id, key: team.key } }
					: undefined,
			};
		},
	}),
	simpleMutation({
		name: "create_issue_label",
		canonical: {
			"fields": {
				"name": "String",
				"team": "TeamReference",
				"description": "String",
				"color": "Color",
				"isGroup": "Boolean",
				"parentId": "UUID",
				"retiredAt": "DateTime",
				"replaceTeamLabels": "Boolean",
				"id": "UUID"
			},
			"branches": [
				[
					"name"
				]
			]
		},
		domain: "labels",
		purpose: "Create an issue label.",
		root: "issueLabelCreate",
		inputType: "IssueLabelCreateInput",
		selection: `issueLabel { ${ISSUE_LABEL_SELECTION} }`,
		document: createIssueLabelDocument,
		parameters: [p("name", "String", true), p("team", "TeamReference"), input],
		acceptedParameters: [
			"name",
			"color",
			"description",
			"id",
			"isGroup",
			"parentId",
			"retiredAt",
			"team",
			"teamId",
			"teamKey",
			"replaceTeamLabels",
			"input",
		].map((n) => p(n)),
		legacyParameters: [[p("input", "IssueLabelCreateInput", true)]],
		example: { name: "needs-review", color: "#ff0000" },
		validateVariables(variables) {
			if (
				variables.input &&
				typeof (variables.name ?? object(variables.input)?.name) !== "string"
			) {
				throw new Error("canonical fields or nested input require name");
			}
		},
		resolverPaths: { team: "resolveTeamReference" },
		async prepare(k, v, s) {
			const rawInput = object(v.input);
			const replaceTeamLabels =
				v.replaceTeamLabels ?? rawInput?.replaceTeamLabels;
			const x = mergedInput(v, [
				"team",
				"teamKey",
				"teamId",
				"replaceTeamLabels",
			]);
			delete x.replaceTeamLabels;
			const ref = v.team ?? v.teamKey ?? v.teamId ?? x.teamId;
			if (typeof x.name !== "string" || !x.name.trim())
				throw new Error("Issue label name is required (name).");
			if (!ref) {
				return { variables: compactObject({ input: x, replaceTeamLabels }) };
			}
			const team = await resolveTeamReference(k, String(ref), s);
			x.teamId = team.id;
			return {
				variables: compactObject({ input: x, replaceTeamLabels }),
				resolution: {
					team: { requested: ref, resolvedId: team.id, key: team.key },
				},
			};
		},
	}),
	simpleMutation({
		name: "update_issue_label",
		canonical: {
			"fields": {
				"id": "String",
				"name": "String",
				"description": "String",
				"color": "Color",
				"isGroup": "Boolean",
				"parentId": "UUID",
				"retiredAt": "NullableDateTime",
				"replaceTeamLabels": "Boolean"
			},
			"branches": [
				[
					"id",
					"name"
				],
				[
					"id",
					"description"
				],
				[
					"id",
					"color"
				],
				[
					"id",
					"isGroup"
				],
				[
					"id",
					"parentId"
				],
				[
					"id",
					"retiredAt"
				],
				[
					"id",
					"replaceTeamLabels"
				]
			]
		},
		domain: "labels",
		purpose: "Update an issue label.",
		root: "issueLabelUpdate",
		inputType: "IssueLabelUpdateInput",
		selection: `issueLabel { ${ISSUE_LABEL_SELECTION} }`,
		document: updateIssueLabelDocument,
		parameters: [p("id", "String", true), input],
		acceptedParameters: [
			"id",
			"name",
			"description",
			"color",
			"parentId",
			"isGroup",
			"retiredAt",
			"replaceTeamLabels",
			"input",
		].map((n) => p(n)),
		example: { id: "label-id", name: "review" },
		idKey: "id",
		async prepare(_k, v) {
			const rawInput = object(v.input);
			const replaceTeamLabels =
				v.replaceTeamLabels ?? rawInput?.replaceTeamLabels;
			const x = mergedInput(v, ["id", "replaceTeamLabels"]);
			delete x.replaceTeamLabels;
			if (!Object.keys(x).length)
				throw new Error("No update fields were provided.");
			return {
				variables: compactObject({ id: v.id, input: x, replaceTeamLabels }),
			};
		},
	}),

	listOperation({
		name: "list_issue_relations",
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
		selection: ISSUE_RELATION_SELECTION,
		purpose: "List issue relations.",
		pageSize: 20,
	}),
	simpleMutation({
		name: "create_issue_relation",
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
		selection: `issueRelation { ${ISSUE_RELATION_SELECTION} }`,
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
		async prepare(k, v, s) {
			const a = issueReference(v);
			const b = String(v.relatedIssue ?? v.relatedIssueId);
			const [x, y] = await Promise.all([
				resolveIssueReference(k, a, s),
				resolveIssueReference(k, b, s),
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
		selection: `issueRelation { ${ISSUE_RELATION_SELECTION} }`,
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
		async prepare(k, v, s) {
			const x = mergedInput(v, ["id"]);
			const resolution: Record<string, unknown> = {};
			for (const key of ["issueId", "relatedIssueId"])
				if (typeof x[key] === "string") {
					const issue = await resolveIssueReference(k, String(x[key]), s);
					resolution[key] = issueTarget(String(x[key]), issue);
					x[key] = issue.id;
				}
			if (!Object.keys(x).length)
				throw new Error("No update fields were provided.");
			return { variables: { id: v.id, input: x }, resolution };
		},
	}),

	listOperation({
		name: "list_issue_statuses",
		canonical: {
			"fields": {
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
		domain: "workspace",
		root: "workflowStates",
		selection: WORKFLOW_STATE_SELECTION,
		purpose: "List issue workflow states.",
		pageSize: 50,
		filterType: "WorkflowStateFilter",
		aliases: ["list_workflow_states"],
	}),

	listOperation({
		name: "list_issues",
		canonical: {
			"fields": {
				"query": "String",
				"team": "TeamReference",
				"state": "StateReference",
				"stateType": "WorkflowStateType",
				"assignee": "UserReference",
				"sort": "[IssueSort!]",
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
		domain: "issues",
		root: "issues",
		selection: ISSUE_SELECTION,
		purpose: "List issues with exact convenience filters.",
		pageSize: 20,
		filterType: "IssueFilter",
		sortType: "IssueSortInput",
		sortKeys: ISSUE_SORT_KEYS,
		example: { assignee: "me", stateType: "started" },
		parameters: [
			p("query"),
			p("team", "TeamReference"),
			p("state", "StateReference"),
			p("stateType", "WorkflowStateType"),
			p("assignee", "UserReference"),
		],
		acceptedParameters: [
			p("query"),
			p("team"),
			p("teamId"),
			p("teamKey"),
			p("state"),
			p("stateName"),
			p("stateType"),
			p("assignee"),
			p("assigneeId"),
			...pagination,
			filter,
			sort,
		],
		resolverPaths: {
			team: "resolveTeamReference",
			state: "resolveStateReference",
			assignee: "resolveUserReference",
		},
		validateVariables(variables) {
			const state = variables.state ?? variables.stateName;
			if (state === undefined) return;
			if (typeof state !== "string" || !state.trim()) {
				throw new Error(
					'state must be a non-empty UUID, or an exact state name with team. For cross-team calls, use { "assignee": "me", "stateType": "started" }',
				);
			}
			const hasTeam =
				variables.team !== undefined ||
				variables.teamId !== undefined ||
				variables.teamKey !== undefined;
			if (!hasTeam && (variables.stateName !== undefined || !isUuid(state))) {
				throw new Error(
					'team is required when state is a name. For cross-team calls, use { "assignee": "me", "stateType": "started" }',
				);
			}
		},
		prepare: async (k, v, s) => {
			const teamRef = v.team ?? v.teamKey ?? v.teamId;
			const team = teamRef
				? await resolveTeamReference(k, String(teamRef), s)
				: undefined;
			const assigneeRef = v.assignee ?? v.assigneeId;
			const assignee = assigneeRef
				? await resolveUserReference(k, String(assigneeRef), s)
				: undefined;
			const stateReference = v.state ?? v.stateName;
			let stateId: string | undefined;
			if (stateReference && team) {
				stateId = (
					await resolveStateReference(k, team.id, String(stateReference), s)
				).id;
			} else if (stateReference) {
				stateId = (await resolveStateIdReference(k, String(stateReference), s))
					.id;
			}
			const convenience = compactObject({
				title: v.query ? { containsIgnoreCase: v.query } : undefined,
				team: team ? { id: { eq: team.id } } : undefined,
				state: stateId
					? { id: { eq: stateId } }
					: v.stateType
						? { type: { eq: String(v.stateType) } }
						: undefined,
				assignee: assignee ? { id: { eq: assignee.id } } : undefined,
			});
			return {
				variables: {
					...paginationVariables(v, 20),
					filter: mergeFilters(object(v.filter), convenience),
					sort: Array.isArray(v.sort) ? v.sort : undefined,
				},
				resolution: compactObject({
					team: team
						? { requested: teamRef, resolvedId: team.id, key: team.key }
						: undefined,
					assignee: assignee
						? {
								requested: assigneeRef,
								resolvedId: assignee.id,
								name: assignee.name,
							}
						: undefined,
					state: stateId
						? { requested: stateReference, resolvedId: stateId }
						: undefined,
				}),
			};
		},
	}),
	{
		name: "get_issue",
		canonical: {
			"fields": {
				"issue": "IssueReference"
			},
			"branches": [
				[
					"issue"
				]
			]
		},
		aliases: [],
		domain: "issues",
		purpose: "Get one issue by exact identifier or UUID.",
		parameters: [p("issue", "IssueReference", true)],
		legacyParameters: [
			[p("teamKey", "String", true), p("number", "Float", true)],
		],
		example: { operation: "get_issue", variables: { issue: "AEO-258" } },
		document: getDocument("GetIssue", "issue", ISSUE_SELECTION),
		resolverPaths: { issue: "resolveIssueReference" },
		async prepare(k, v, s) {
			const ref = issueReference(v);
			const x = await resolveIssueReference(k, ref, s);
			return {
				variables: { id: x.id },
				resolution: { target: issueTarget(ref, x) },
			};
		},
	},
	simpleMutation({
		name: "create_issue",
		canonical: {
			"fields": {
				"title": "String",
				"team": "TeamReference",
				"parent": "IssueReference",
				"state": "StateReference",
				"assignee": "UserReference",
				"dueDate": "Date",
				"description": "String",
				"descriptionData": "JsonString",
				"priority": "Priority",
				"estimate": "Int",
				"projectId": "UUID",
				"projectMilestoneId": "UUID",
				"cycleId": "UUID",
				"labelIds": "[UUID!]",
				"subscriberIds": "[UUID!]",
				"delegateId": "UUID",
				"lastAppliedTemplateId": "UUID",
				"slaType": "SlaDayCountType",
				"slaBreachesAt": "NullableDateTime",
				"slaStartedAt": "NullableDateTime",
				"sortOrder": "Float",
				"subIssueSortOrder": "Float",
				"prioritySortOrder": "Float",
				"templateId": "UUID",
				"useDefaultTemplate": "Boolean",
				"preserveSortOrderOnCreate": "Boolean",
				"referenceCommentId": "UUID",
				"sourceCommentId": "UUID",
				"sourcePullRequestCommentId": "UUID",
				"createAsUser": "String",
				"displayIconUrl": "Url",
				"completedAt": "NullableDateTime",
				"createdAt": "DateTime",
				"id": "UUID"
			},
			"branches": [
				[
					"title",
					"team"
				],
				[
					"title",
					"parent"
				]
			]
		},
		domain: "issues",
		purpose:
			"Create an issue. A parent reference supplies the team when team is omitted.",
		root: "issueCreate",
		inputType: "IssueCreateInput",
		selection: `issue { ${ISSUE_SELECTION} }`,
		parameters: [
			p("title", "String", true),
			p("parent", "IssueReference"),
			p("team", "TeamReference"),
			p("state", "StateReference"),
			p("assignee", "UserReference"),
			input,
		],
		acceptedParameters: [
			...issueCreateFields,
			p("parent"),
			p("team"),
			p("state"),
			p("assignee"),
			input,
		],
		legacyParameters: [[p("input", "IssueCreateInput", true)]],
		example: { title: "v0.4 trial child", parent: "AEO-258" },
		validateVariables(variables) {
			const raw = object(variables.input) ?? {};
			const title = variables.title ?? raw.title;
			if (typeof title !== "string" || !title.trim()) {
				throw new Error(
					"title is required in canonical fields or nested input",
				);
			}
			const teamOrParent =
				variables.team ??
				variables.teamKey ??
				variables.teamId ??
				variables.parent ??
				raw.teamId ??
				raw.parentId;
			if (typeof teamOrParent !== "string" || !teamOrParent.trim()) {
				throw new Error(
					"team or parent is required in canonical fields or nested input",
				);
			}
		},
		resolverPaths: {
			parent: "resolveIssueReference",
			parentId: "resolveIssueReference",
			team: "resolveTeamReference",
			teamKey: "resolveTeamReference",
			teamId: "resolveTeamReference",
			state: "resolveStateReference",
			stateId: "resolveStateReference",
			assignee: "resolveUserReference",
			assigneeId: "resolveUserReference",
		},
		async prepare(k, v, s) {
			const x = mergedInput(v, [
				"parent",
				"team",
				"teamKey",
				"state",
				"assignee",
			]);
			const parentRef = v.parent ?? x.parentId;
			const parent = parentRef
				? await resolveIssueReference(k, String(parentRef), s)
				: undefined;
			if (parent) x.parentId = parent.id;
			const teamRef = v.team ?? v.teamKey ?? x.teamId;
			const team = teamRef
				? await resolveTeamReference(k, String(teamRef), s)
				: undefined;
			if (team && parent && team.id !== parent.teamId) {
				throw new Error(
					`Linear parent "${parent.identifier}" does not belong to team "${team.key}".`,
				);
			}
			const teamId = team?.id ?? parent?.teamId;
			if (!teamId)
				throw new Error(
					"Issue team is required. Send team, teamKey, teamId, or parent.",
				);
			x.teamId = teamId;
			const stateRef = v.state ?? x.stateId;
			if (stateRef)
				x.stateId = (
					await resolveStateReference(k, teamId, String(stateRef), s)
				).id;
			const userRef = v.assignee ?? x.assigneeId;
			if (userRef)
				x.assigneeId = (await resolveUserReference(k, String(userRef), s)).id;
			if (typeof x.title !== "string" || !x.title.trim())
				throw new Error("Issue title is required for issueCreate (title).");
			return {
				variables: { input: x },
				resolution: compactObject({
					parent: parent ? issueTarget(String(parentRef), parent) : undefined,
					team: {
						requested: teamRef ?? parentRef,
						resolvedId: teamId,
						key: team?.key ?? parent?.teamKey,
					},
					state: stateRef
						? { requested: stateRef, resolvedId: x.stateId }
						: undefined,
					assignee: userRef
						? { requested: userRef, resolvedId: x.assigneeId }
						: undefined,
				}),
			};
		},
	}),
	simpleMutation({
		name: "update_issue",
		canonical: {
			"fields": {
				"issue": "IssueReference",
				"title": "String",
				"state": "StateReference",
				"assignee": "UserReference",
				"parent": "IssueReference",
				"teamId": "TeamReference",
				"dueDate": "NullableDate",
				"addedLabelIds": "[UUID!]",
				"removedLabelIds": "[UUID!]",
				"description": "String",
				"descriptionData": "JsonString",
				"priority": "Priority",
				"estimate": "Int",
				"projectId": "UUID",
				"projectMilestoneId": "UUID",
				"cycleId": "UUID",
				"labelIds": "[UUID!]",
				"subscriberIds": "[UUID!]",
				"delegateId": "UUID",
				"lastAppliedTemplateId": "UUID",
				"slaType": "SlaDayCountType",
				"slaBreachesAt": "NullableDateTime",
				"slaStartedAt": "NullableDateTime",
				"sortOrder": "Float",
				"subIssueSortOrder": "Float",
				"prioritySortOrder": "Float",
				"autoClosedByParentClosing": "Boolean",
				"snoozedById": "UUID",
				"snoozedUntilAt": "NullableDateTime"
			},
			"branches": [
				[
					"issue",
					"title"
				],
				[
					"issue",
					"state"
				],
				[
					"issue",
					"assignee"
				],
				[
					"issue",
					"parent"
				],
				[
					"issue",
					"teamId"
				],
				[
					"issue",
					"dueDate"
				],
				[
					"issue",
					"addedLabelIds"
				],
				[
					"issue",
					"removedLabelIds"
				],
				[
					"issue",
					"description"
				],
				[
					"issue",
					"descriptionData"
				],
				[
					"issue",
					"priority"
				],
				[
					"issue",
					"estimate"
				],
				[
					"issue",
					"projectId"
				],
				[
					"issue",
					"projectMilestoneId"
				],
				[
					"issue",
					"cycleId"
				],
				[
					"issue",
					"labelIds"
				],
				[
					"issue",
					"subscriberIds"
				],
				[
					"issue",
					"delegateId"
				],
				[
					"issue",
					"lastAppliedTemplateId"
				],
				[
					"issue",
					"slaType"
				],
				[
					"issue",
					"slaBreachesAt"
				],
				[
					"issue",
					"slaStartedAt"
				],
				[
					"issue",
					"sortOrder"
				],
				[
					"issue",
					"subIssueSortOrder"
				],
				[
					"issue",
					"prioritySortOrder"
				],
				[
					"issue",
					"autoClosedByParentClosing"
				],
				[
					"issue",
					"snoozedById"
				],
				[
					"issue",
					"snoozedUntilAt"
				]
			]
		},
		domain: "issues",
		purpose: "Update an issue by exact identifier or UUID.",
		root: "issueUpdate",
		inputType: "IssueUpdateInput",
		selection: `issue { ${ISSUE_SELECTION} }`,
		idKey: "issue",
		parameters: [
			p("issue", "IssueReference", true),
			p("state", "StateReference"),
			p("assignee", "UserReference"),
			p("parent", "IssueReference"),
			input,
		],
		acceptedParameters: [
			p("issue"),
			p("issueId"),
			p("state"),
			p("assignee"),
			p("parent"),
			...issueUpdateFields,
			input,
		],
		example: { issue: "AEO-258", state: "Backlog" },
		aliases: ["update_issue_state"],
		aliasParameters: {
			update_issue_state: [
				p("issueId", "String", true),
				p("stateId", "String", true),
			],
		},
		resolverPaths: {
			issue: "resolveIssueReference",
			issueId: "resolveIssueReference",
			state: "resolveStateReference",
			stateId: "resolveStateReference",
			assignee: "resolveUserReference",
			assigneeId: "resolveUserReference",
			parent: "resolveIssueReference",
			parentId: "resolveIssueReference",
			teamId: "resolveTeamReference",
		},
		async prepare(k, v, s) {
			const ref = issueReference(v);
			const issue = await resolveIssueReference(k, ref, s);
			const x = mergedInput(v, [
				"issue",
				"issueId",
				"state",
				"assignee",
				"parent",
			]);
			const teamRef = x.teamId;
			const targetTeam = teamRef
				? await resolveTeamReference(k, String(teamRef), s)
				: undefined;
			if (targetTeam) x.teamId = targetTeam.id;
			const stateRef = v.state ?? x.stateId;
			if (stateRef)
				x.stateId = (
					await resolveStateReference(
						k,
						targetTeam?.id ?? issue.teamId,
						String(stateRef),
						s,
					)
				).id;
			const userRef = v.assignee ?? x.assigneeId;
			if (userRef)
				x.assigneeId = (await resolveUserReference(k, String(userRef), s)).id;
			const parentRef = v.parent ?? x.parentId;
			if (parentRef) {
				const parent = await resolveIssueReference(k, String(parentRef), s);
				if (parent.teamId !== (targetTeam?.id ?? issue.teamId)) {
					throw new Error(
						`Linear parent "${parent.identifier}" does not belong to the issue team.`,
					);
				}
				x.parentId = parent.id;
			}
			if (!Object.keys(x).length)
				throw new Error("No update fields were provided.");
			return {
				variables: { id: issue.id, input: x },
				resolution: compactObject({
					target: issueTarget(ref, issue),
					state: stateRef
						? { requested: stateRef, resolvedId: x.stateId }
						: undefined,
					assignee: userRef
						? { requested: userRef, resolvedId: x.assigneeId }
						: undefined,
					parent: parentRef
						? { requested: parentRef, resolvedId: x.parentId }
						: undefined,
				}),
			};
		},
	}),
	listOperation({
		name: "search_issues",
		canonical: {
			"fields": {
				"term": "String",
				"includeComments": "Boolean",
				"team": "TeamReference",
				"after": "String",
				"before": "String",
				"first": "Int",
				"last": "Int",
				"includeArchived": "Boolean",
				"orderBy": "PaginationOrderBy",
				"filter": "Filter"
			},
			"branches": [
				[
					"term"
				]
			]
		},
		domain: "issues",
		root: "searchIssues",
		selection: ISSUE_SELECTION,
		purpose: "Search issues by text.",
		pageSize: 20,
		filterType: "IssueFilter",
		parameters: [
			p("term", "String", true),
			p("includeComments", "Boolean"),
			p("team", "TeamReference"),
		],
		acceptedParameters: [
			p("term", "String", true),
			p("includeComments"),
			p("team"),
			p("teamId"),
			...pagination,
			filter,
		],
		resolverPaths: { team: "resolveTeamReference" },
		example: { term: "authentication" },
		extras: "$term: String! $includeComments: Boolean $teamId: String",
		extraArgs: "term: $term includeComments: $includeComments teamId: $teamId",
		prepare: async (k, v, s) => {
			const teamRef = v.team ?? v.teamId;
			const team = teamRef
				? await resolveTeamReference(k, String(teamRef), s)
				: undefined;
			return {
				variables: {
					...paginationVariables(v, 20),
					term: v.term,
					includeComments: v.includeComments,
					teamId: team?.id,
					filter: object(v.filter),
				},
				resolution: team
					? { team: { requested: teamRef, resolvedId: team.id, key: team.key } }
					: undefined,
			};
		},
	}),

	listOperation({
		name: "list_milestones",
		canonical: {
			"fields": {
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
		domain: "milestones",
		root: "projectMilestones",
		selection: MILESTONE_SELECTION,
		purpose: "List project milestones.",
		pageSize: 20,
		filterType: "ProjectMilestoneFilter",
	}),
	{
		name: "get_milestone",
		canonical: {
			"fields": {
				"milestone": "MilestoneReference"
			},
			"branches": [
				[
					"milestone"
				]
			]
		},
		aliases: [],
		domain: "milestones",
		purpose: "Get a milestone by exact name or UUID.",
		parameters: [p("milestone", "MilestoneReference", true)],
		legacyParameters: [[p("milestoneId", "String", true)]],
		example: { operation: "get_milestone", variables: { milestone: "Beta" } },
		document: getDocument(
			"GetMilestone",
			"projectMilestone",
			MILESTONE_SELECTION,
		),
		resolverPaths: { milestone: "resolveNamedEntityReference" },
		async prepare(k, v, s) {
			const x = await resolveNamedEntityReference(
				k,
				"projectMilestone",
				String(v.milestone ?? v.milestoneId),
				s,
			);
			return { variables: { id: x.id } };
		},
	},

	listOperation({
		name: "list_project_labels",
		canonical: {
			"fields": {
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
		domain: "labels",
		root: "projectLabels",
		selection: PROJECT_LABEL_SELECTION,
		purpose: "List project labels.",
		pageSize: 50,
		filterType: "ProjectLabelFilter",
	}),
	simpleMutation({
		name: "create_project_label",
		canonical: {
			"fields": {
				"name": "String",
				"description": "String",
				"color": "Color",
				"isGroup": "Boolean",
				"parentId": "UUID",
				"retiredAt": "DateTime"
			},
			"branches": [
				[
					"name"
				]
			]
		},
		domain: "labels",
		purpose: "Create a project label.",
		root: "projectLabelCreate",
		inputType: "ProjectLabelCreateInput",
		selection: `projectLabel { ${PROJECT_LABEL_SELECTION} }`,
		parameters: [p("name", "String", true), input],
		acceptedParameters: [
			"name",
			"description",
			"color",
			"parentId",
			"isGroup",
			"retiredAt",
			"input",
		].map((n) => p(n)),
		legacyParameters: [[p("input", "ProjectLabelCreateInput", true)]],
		example: { name: "Strategic" },
		validateVariables(variables) {
			if (
				variables.input &&
				typeof (variables.name ?? object(variables.input)?.name) !== "string"
			) {
				throw new Error("canonical fields or nested input require name");
			}
		},
	}),
	simpleMutation({
		name: "update_project_label",
		canonical: {
			"fields": {
				"id": "String",
				"name": "String",
				"description": "String",
				"color": "Color",
				"isGroup": "Boolean",
				"parentId": "UUID",
				"retiredAt": "NullableDateTime"
			},
			"branches": [
				[
					"id",
					"name"
				],
				[
					"id",
					"description"
				],
				[
					"id",
					"color"
				],
				[
					"id",
					"isGroup"
				],
				[
					"id",
					"parentId"
				],
				[
					"id",
					"retiredAt"
				]
			]
		},
		domain: "labels",
		purpose: "Update a project label.",
		root: "projectLabelUpdate",
		inputType: "ProjectLabelUpdateInput",
		selection: `projectLabel { ${PROJECT_LABEL_SELECTION} }`,
		parameters: [p("id", "String", true), input],
		acceptedParameters: [
			"id",
			"name",
			"description",
			"color",
			"parentId",
			"isGroup",
			"retiredAt",
			"input",
		].map((n) => p(n)),
		example: { id: "label-id", name: "Strategy" },
		idKey: "id",
	}),

	listOperation({
		name: "list_project_relations",
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
		selection: PROJECT_RELATION_SELECTION,
		purpose: "List project relations.",
		pageSize: 20,
	}),
	simpleMutation({
		name: "create_project_relation",
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
		selection: `projectRelation { ${PROJECT_RELATION_SELECTION} }`,
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
		selection: `projectRelation { ${PROJECT_RELATION_SELECTION} }`,
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

	listOperation({
		name: "list_projects",
		canonical: {
			"fields": {
				"sort": "[ProjectSort!]",
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
		domain: "projects",
		root: "projects",
		selection: PROJECT_LIST_SELECTION,
		purpose: "List projects.",
		pageSize: 20,
		filterType: "ProjectFilter",
		sortType: "ProjectSortInput",
		sortKeys: PROJECT_SORT_KEYS,
	}),
	{
		name: "get_project",
		canonical: {
			"fields": {
				"project": "ProjectReference"
			},
			"branches": [
				[
					"project"
				]
			]
		},
		aliases: [],
		domain: "projects",
		purpose: "Get a project by exact name or UUID.",
		parameters: [p("project", "ProjectReference", true)],
		legacyParameters: [[p("projectId", "String", true)]],
		example: { operation: "get_project", variables: { project: "Platform" } },
		document: getDocument("GetProject", "project", PROJECT_DETAIL_SELECTION),
		resolverPaths: { project: "resolveNamedEntityReference" },
		async prepare(k, v, s) {
			const x = await resolveNamedEntityReference(
				k,
				"project",
				String(v.project ?? v.projectId),
				s,
			);
			return {
				variables: { id: x.id },
				resolution: {
					target: {
						requested: v.project ?? v.projectId,
						resolvedId: x.id,
						name: x.name,
					},
				},
			};
		},
	},

	listOperation({
		name: "list_teams",
		canonical: {
			"fields": {
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
		domain: "teams",
		root: "teams",
		selection: `${TEAM_SELECTION} states(first: 50) { nodes { id name type } }`,
		purpose: "List teams and workflow states.",
		pageSize: 50,
		filterType: "TeamFilter",
	}),
	{
		name: "get_team",
		canonical: {
			"fields": {
				"team": "TeamReference"
			},
			"branches": [
				[
					"team"
				]
			]
		},
		aliases: [],
		domain: "teams",
		purpose: "Get a team by exact key or UUID.",
		parameters: [p("team", "TeamReference", true)],
		legacyParameters: [[p("teamId", "String", true)]],
		example: { operation: "get_team", variables: { team: "AEO" } },
		document: getDocument("GetTeam", "team", TEAM_SELECTION),
		resolverPaths: { team: "resolveTeamReference" },
		async prepare(k, v, s) {
			const x = await resolveTeamReference(k, String(v.team ?? v.teamId), s);
			return {
				variables: { id: x.id },
				resolution: {
					target: {
						requested: v.team ?? v.teamId,
						resolvedId: x.id,
						key: x.key,
					},
				},
			};
		},
	},
	listOperation({
		name: "list_users",
		canonical: {
			"fields": {
				"includeDisabled": "Boolean",
				"sort": "[UserSort!]",
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
		domain: "users",
		root: "users",
		selection: USER_SELECTION,
		purpose: "List users.",
		pageSize: 50,
		filterType: "UserFilter",
		sortType: "UserSortInput",
		sortKeys: USER_SORT_KEYS,
		parameters: [p("includeDisabled", "Boolean")],
		extras: "$includeDisabled: Boolean",
		extraArgs: "includeDisabled: $includeDisabled",
		prepare: listPrepare(50, (v) => ({ includeDisabled: v.includeDisabled })),
	}),
	{
		name: "get_user",
		canonical: {
			"fields": {
				"user": "UserReference"
			},
			"branches": [
				[
					"user"
				]
			]
		},
		aliases: [],
		domain: "users",
		purpose: "Get a user by me, UUID, email, name, or display name.",
		parameters: [p("user", "UserReference", true)],
		legacyParameters: [[p("userId", "String", true)]],
		example: { operation: "get_user", variables: { user: "me" } },
		document: getDocument("GetUser", "user", USER_SELECTION),
		resolverPaths: { user: "resolveUserReference" },
		async prepare(k, v, s) {
			const x = await resolveUserReference(k, String(v.user ?? v.userId), s);
			return {
				variables: { id: x.id },
				resolution: {
					target: {
						requested: v.user ?? v.userId,
						resolvedId: x.id,
						name: x.name,
					},
				},
			};
		},
	},
	{
		name: "switch_workspace",
		canonical: {
			"fields": {
				"name": "String"
			},
			"branches": [
				[
					"name"
				]
			]
		},
		aliases: [],
		domain: "workspace",
		purpose: "Switch the active stored workspace without exposing credentials.",
		parameters: [p("name", "String", true)],
		example: { operation: "switch_workspace", variables: { name: "work" } },
		document: "query SwitchWorkspaceLocal { viewer { id } }",
		async executeLocal(v) {
			const updated = await switchWorkspace(String(v.name));
			return { active: updated.activeWorkspace };
		},
	},
] satisfies LinearOperation[]).map((operation) =>
	defineOperation(operation as LinearOperation),
);

// Save operations use one definition and select the create or update document at runtime.
function addSaveOperation(config: {
	name: string;
	canonical: CanonicalOperation;
	domain: OperationDomain;
	entity: string;
	entityKind: "project" | "initiative" | "projectMilestone";
	documentName: string;
	selection: string;
	idKey: string;
	createRoot: string;
	updateRoot: string;
	createType: string;
	updateType: string;
	parameters: readonly OperationParameter[];
	example: Record<string, unknown>;
	resolverPaths?: Record<string, string>;
}) {
	const entityPath = config.entity[0]!.toLowerCase() + config.entity.slice(1);
	const baseCreateDocument = mutationDocument(
		`Create${config.documentName}`,
		config.createRoot,
		config.createType,
		`${entityPath} { ${config.selection} }`,
	);
	const createDocument =
		config.name === "save_project"
			? baseCreateDocument
					.replace(
						`$input: ${config.createType}!`,
						`$input: ${config.createType}! $slackChannelName: String`,
					)
					.replace(
						`${config.createRoot}(input: $input)`,
						`${config.createRoot}(input: $input, slackChannelName: $slackChannelName)`,
					)
			: baseCreateDocument;
	const updateDocument = mutationDocument(
		`Update${config.documentName}`,
		config.updateRoot,
		config.updateType,
		`${entityPath} { ${config.selection} }`,
		true,
	);
	const createVariant = mutationVariant(createDocument, config.createRoot, entityPath, "create");
	const updateVariant = mutationVariant(updateDocument, config.updateRoot, entityPath, "update");
	// Requirement branches own save mode, required content, and forbidden fields.
	// This named exception checks non-empty and value-type semantics only.
	const validateSaveSemantics = (v: Record<string, unknown>) => {
		const reference = v[config.idKey];
		const update = typeof reference === "string" && reference.length > 0;
		if (update) return;
		const prepared = mergedInput(v, [config.idKey]);
		if (typeof prepared.name !== "string" || !prepared.name.trim())
			throw new Error(
				`${config.entity} name is required for ${config.createRoot} (name).`,
			);
		if (
			config.name === "save_milestone" &&
			typeof prepared.projectId !== "string"
		)
			throw new Error("projectId is required for projectMilestoneCreate.");
		if (
			config.name === "save_project" &&
			(!Array.isArray(prepared.teamIds) || prepared.teamIds.length === 0)
		)
			throw new Error(
				"teamIds is required for projectCreate and must be a non-empty array.",
			);
	};
	const cardParameters =
		config.name === "save_project"
			? [p("projectId", "ProjectReference"), p("name"), input]
			: config.name === "save_initiative"
				? [p("initiativeId", "InitiativeReference"), p("name"), input]
				: [
						p("milestoneId", "MilestoneReference"),
						p("name"),
						p("projectId", "ProjectReference"),
						input,
					];
	operationDefinitionsMutable.push(defineOperation({
		name: config.name,
		canonical: config.canonical,
		aliases: [],
		domain: config.domain,
		purpose: `Create or update a ${config.entity.toLowerCase()}.`,
		parameters: cardParameters,
		acceptedParameters: config.parameters,
		example: { operation: config.name, variables: config.example },
		document: createDocument,
		variants: [createVariant, updateVariant],
		resolverPaths: config.resolverPaths,
		requiresVariables: true,
		validateVariables: validateSaveSemantics,
		async prepare(k, v, s) {
			validateSaveSemantics(v);
			const reference = v[config.idKey];
			const update = typeof reference === "string" && reference.length > 0;
			const prepared = mergedInput(v, [config.idKey]);
			const resolution: Record<string, unknown> = {};
			let id: string | undefined;
			if (update) {
				const entity = await resolveNamedEntityReference(
					k,
					config.entityKind,
					String(reference),
					s,
				);
				id = entity.id;
				resolution.target = {
					requested: reference,
					resolvedId: id,
					name: entity.name,
				};
			}
			if (
				config.name === "save_milestone" &&
				typeof prepared.projectId === "string"
			) {
				const project = await resolveNamedEntityReference(
					k,
					"project",
					prepared.projectId,
					s,
				);
				resolution.project = {
					requested: prepared.projectId,
					resolvedId: project.id,
					name: project.name,
				};
				prepared.projectId = project.id;
			}
			if (
				config.name === "save_project" &&
				typeof prepared.convertedFromIssueId === "string"
			) {
				const issue = await resolveIssueReference(
					k,
					prepared.convertedFromIssueId,
					s,
				);
				resolution.convertedFromIssue = issueTarget(
					prepared.convertedFromIssueId,
					issue,
				);
				prepared.convertedFromIssueId = issue.id;
			}
			const slackChannelName =
				config.name === "save_project" ? prepared.slackChannelName : undefined;
			if (config.name === "save_project") delete prepared.slackChannelName;
			return {
				variant: update ? updateVariant : createVariant,
				variables: update
					? { id, input: prepared }
					: {
							input: prepared,
							...(slackChannelName === undefined ? {} : { slackChannelName }),
						},
				resolution,
			};
		},
	}));
}
addSaveOperation({
	name: "save_initiative",
	canonical: {
		"fields": {
			"initiativeId": "InitiativeReference",
			"name": "String",
			"description": "String",
			"content": "String",
			"icon": "String",
			"color": "Color",
			"status": "InitiativeStatus",
			"targetDate": "NullableDate",
			"targetDateResolution": "DateResolutionType",
			"ownerId": "UUID",
			"leadTeamId": "UUID",
			"sortOrder": "Float",
			"prioritySortOrder": "Float",
			"priority": "Priority",
			"labelIds": "[UUID!]",
			"id": "UUID",
			"customIdentifier": "String",
			"frequencyResolution": "FrequencyResolutionType",
			"updateReminderFrequency": "Float",
			"updateReminderFrequencyInWeeks": "Float",
			"updateRemindersDay": "Day",
			"updateRemindersHour": "Float"
		},
		"branches": [
			[
				"name"
			],
			[
				"initiativeId",
				"name"
			],
			[
				"initiativeId",
				"description"
			],
			[
				"initiativeId",
				"content"
			],
			[
				"initiativeId",
				"icon"
			],
			[
				"initiativeId",
				"color"
			],
			[
				"initiativeId",
				"status"
			],
			[
				"initiativeId",
				"targetDate"
			],
			[
				"initiativeId",
				"targetDateResolution"
			],
			[
				"initiativeId",
				"ownerId"
			],
			[
				"initiativeId",
				"leadTeamId"
			],
			[
				"initiativeId",
				"sortOrder"
			],
			[
				"initiativeId",
				"prioritySortOrder"
			],
			[
				"initiativeId",
				"priority"
			],
			[
				"initiativeId",
				"labelIds"
			],
			[
				"initiativeId",
				"customIdentifier"
			],
			[
				"initiativeId",
				"frequencyResolution"
			],
			[
				"initiativeId",
				"updateReminderFrequency"
			],
			[
				"initiativeId",
				"updateReminderFrequencyInWeeks"
			],
			[
				"initiativeId",
				"updateRemindersDay"
			],
			[
				"initiativeId",
				"updateRemindersHour"
			]
		],
		"variants": [
			{
				"fields": [
					"name",
					"description",
					"content",
					"icon",
					"color",
					"status",
					"targetDate",
					"targetDateResolution",
					"ownerId",
					"leadTeamId",
					"sortOrder",
					"prioritySortOrder",
					"priority",
					"labelIds",
					"id"
				],
				"branches": [
					[
						"name"
					]
				]
			},
			{
				"fields": [
					"initiativeId",
					"name",
					"description",
					"content",
					"icon",
					"color",
					"status",
					"targetDate",
					"targetDateResolution",
					"ownerId",
					"leadTeamId",
					"sortOrder",
					"prioritySortOrder",
					"priority",
					"labelIds",
					"customIdentifier",
					"frequencyResolution",
					"updateReminderFrequency",
					"updateReminderFrequencyInWeeks",
					"updateRemindersDay",
					"updateRemindersHour"
				],
				"branches": [
					[
						"initiativeId",
						"name"
					],
					[
						"initiativeId",
						"description"
					],
					[
						"initiativeId",
						"content"
					],
					[
						"initiativeId",
						"icon"
					],
					[
						"initiativeId",
						"color"
					],
					[
						"initiativeId",
						"status"
					],
					[
						"initiativeId",
						"targetDate"
					],
					[
						"initiativeId",
						"targetDateResolution"
					],
					[
						"initiativeId",
						"ownerId"
					],
					[
						"initiativeId",
						"leadTeamId"
					],
					[
						"initiativeId",
						"sortOrder"
					],
					[
						"initiativeId",
						"prioritySortOrder"
					],
					[
						"initiativeId",
						"priority"
					],
					[
						"initiativeId",
						"labelIds"
					],
					[
						"initiativeId",
						"customIdentifier"
					],
					[
						"initiativeId",
						"frequencyResolution"
					],
					[
						"initiativeId",
						"updateReminderFrequency"
					],
					[
						"initiativeId",
						"updateReminderFrequencyInWeeks"
					],
					[
						"initiativeId",
						"updateRemindersDay"
					],
					[
						"initiativeId",
						"updateRemindersHour"
					]
				]
			}
		]
	},
	domain: "initiatives",
	entity: "Initiative",
	entityKind: "initiative",
	documentName: "Initiative",
	selection: INITIATIVE_SELECTION,
	idKey: "initiativeId",
	createRoot: "initiativeCreate",
	updateRoot: "initiativeUpdate",
	createType: "InitiativeCreateInput",
	updateType: "InitiativeUpdateInput",
	resolverPaths: { initiativeId: "resolveNamedEntityReference" },
	parameters: [
		"initiativeId",
		"color",
		"content",
		"description",
		"icon",
		"id",
		"labelIds",
		"leadTeamId",
		"name",
		"ownerId",
		"priority",
		"prioritySortOrder",
		"sortOrder",
		"status",
		"targetDate",
		"targetDateResolution",
		"customIdentifier",
		"frequencyResolution",
		"trashed",
		"updateReminderFrequency",
		"updateReminderFrequencyInWeeks",
		"updateRemindersDay",
		"updateRemindersHour",
		"input",
	].map((n) => p(n)),
	example: { name: "Platform" },
});
addSaveOperation({
	name: "save_milestone",
	canonical: {
		"fields": {
			"milestoneId": "MilestoneReference",
			"name": "String",
			"projectId": "ProjectReference",
			"description": "String",
			"descriptionData": "JsonString",
			"targetDate": "NullableDate",
			"sortOrder": "Float",
			"id": "UUID"
		},
		"branches": [
			[
				"name",
				"projectId"
			],
			[
				"milestoneId",
				"name"
			],
			[
				"milestoneId",
				"projectId"
			],
			[
				"milestoneId",
				"description"
			],
			[
				"milestoneId",
				"descriptionData"
			],
			[
				"milestoneId",
				"targetDate"
			],
			[
				"milestoneId",
				"sortOrder"
			]
		],
		"variants": [
			{
				"fields": [
					"name",
					"projectId",
					"description",
					"descriptionData",
					"targetDate",
					"sortOrder",
					"id"
				],
				"branches": [
					[
						"name",
						"projectId"
					]
				]
			},
			{
				"fields": [
					"milestoneId",
					"name",
					"projectId",
					"description",
					"descriptionData",
					"targetDate",
					"sortOrder"
				],
				"branches": [
					[
						"milestoneId",
						"name"
					],
					[
						"milestoneId",
						"projectId"
					],
					[
						"milestoneId",
						"description"
					],
					[
						"milestoneId",
						"descriptionData"
					],
					[
						"milestoneId",
						"targetDate"
					],
					[
						"milestoneId",
						"sortOrder"
					]
				]
			}
		]
	},
	domain: "milestones",
	entity: "ProjectMilestone",
	entityKind: "projectMilestone",
	documentName: "Milestone",
	selection: MILESTONE_SELECTION,
	idKey: "milestoneId",
	createRoot: "projectMilestoneCreate",
	updateRoot: "projectMilestoneUpdate",
	createType: "ProjectMilestoneCreateInput",
	updateType: "ProjectMilestoneUpdateInput",
	resolverPaths: {
		milestoneId: "resolveNamedEntityReference",
		projectId: "resolveNamedEntityReference",
	},
	parameters: [
		"milestoneId",
		"description",
		"descriptionData",
		"id",
		"name",
		"projectId",
		"sortOrder",
		"targetDate",
		"input",
	].map((n) => p(n)),
	example: { name: "Beta", projectId: "project-id" },
});
addSaveOperation({
	name: "save_project",
	canonical: {
		"fields": {
			"projectId": "ProjectReference",
			"name": "String",
			"teamIds": "[ID!]",
			"description": "String",
			"content": "String",
			"icon": "String",
			"color": "Color",
			"priority": "Priority",
			"startDate": "Date",
			"startDateResolution": "DateResolutionType",
			"targetDate": "NullableDate",
			"targetDateResolution": "DateResolutionType",
			"statusId": "UUID",
			"leadId": "UUID",
			"leadTeamId": "UUID",
			"memberIds": "[UUID!]",
			"labelIds": "[UUID!]",
			"convertedFromIssueId": "IssueReference",
			"lastAppliedTemplateId": "UUID",
			"sortOrder": "Float",
			"prioritySortOrder": "Float",
			"canceledAt": "NullableDateTime",
			"completedAt": "NullableDateTime",
			"projectUpdateRemindersPausedUntilAt": "NullableDateTime",
			"slackIssueComments": "Boolean",
			"slackIssueStatuses": "Boolean",
			"slackNewIssue": "Boolean",
			"slackChannelName": "String",
			"templateId": "UUID",
			"useDefaultTemplate": "Boolean",
			"id": "UUID",
			"frequencyResolution": "FrequencyResolutionType",
			"updateReminderFrequency": "Float",
			"updateReminderFrequencyInWeeks": "Float",
			"updateRemindersDay": "Day",
			"updateRemindersHour": "Float"
		},
		"branches": [
			[
				"name",
				"teamIds"
			],
			[
				"projectId",
				"name"
			],
			[
				"projectId",
				"teamIds"
			],
			[
				"projectId",
				"description"
			],
			[
				"projectId",
				"content"
			],
			[
				"projectId",
				"icon"
			],
			[
				"projectId",
				"color"
			],
			[
				"projectId",
				"priority"
			],
			[
				"projectId",
				"startDate"
			],
			[
				"projectId",
				"startDateResolution"
			],
			[
				"projectId",
				"targetDate"
			],
			[
				"projectId",
				"targetDateResolution"
			],
			[
				"projectId",
				"statusId"
			],
			[
				"projectId",
				"leadId"
			],
			[
				"projectId",
				"leadTeamId"
			],
			[
				"projectId",
				"memberIds"
			],
			[
				"projectId",
				"labelIds"
			],
			[
				"projectId",
				"convertedFromIssueId"
			],
			[
				"projectId",
				"lastAppliedTemplateId"
			],
			[
				"projectId",
				"sortOrder"
			],
			[
				"projectId",
				"prioritySortOrder"
			],
			[
				"projectId",
				"canceledAt"
			],
			[
				"projectId",
				"completedAt"
			],
			[
				"projectId",
				"projectUpdateRemindersPausedUntilAt"
			],
			[
				"projectId",
				"slackIssueComments"
			],
			[
				"projectId",
				"slackIssueStatuses"
			],
			[
				"projectId",
				"slackNewIssue"
			],
			[
				"projectId",
				"frequencyResolution"
			],
			[
				"projectId",
				"updateReminderFrequency"
			],
			[
				"projectId",
				"updateReminderFrequencyInWeeks"
			],
			[
				"projectId",
				"updateRemindersDay"
			],
			[
				"projectId",
				"updateRemindersHour"
			]
		],
		"variants": [
			{
				"fields": [
					"name",
					"teamIds",
					"description",
					"content",
					"icon",
					"color",
					"priority",
					"startDate",
					"startDateResolution",
					"targetDate",
					"targetDateResolution",
					"statusId",
					"leadId",
					"leadTeamId",
					"memberIds",
					"labelIds",
					"convertedFromIssueId",
					"lastAppliedTemplateId",
					"sortOrder",
					"prioritySortOrder",
					"slackChannelName",
					"templateId",
					"useDefaultTemplate",
					"id"
				],
				"branches": [
					[
						"name",
						"teamIds"
					]
				]
			},
			{
				"fields": [
					"projectId",
					"name",
					"teamIds",
					"description",
					"content",
					"icon",
					"color",
					"priority",
					"startDate",
					"startDateResolution",
					"targetDate",
					"targetDateResolution",
					"statusId",
					"leadId",
					"leadTeamId",
					"memberIds",
					"labelIds",
					"convertedFromIssueId",
					"lastAppliedTemplateId",
					"sortOrder",
					"prioritySortOrder",
					"canceledAt",
					"completedAt",
					"projectUpdateRemindersPausedUntilAt",
					"slackIssueComments",
					"slackIssueStatuses",
					"slackNewIssue",
					"frequencyResolution",
					"updateReminderFrequency",
					"updateReminderFrequencyInWeeks",
					"updateRemindersDay",
					"updateRemindersHour"
				],
				"branches": [
					[
						"projectId",
						"name"
					],
					[
						"projectId",
						"teamIds"
					],
					[
						"projectId",
						"description"
					],
					[
						"projectId",
						"content"
					],
					[
						"projectId",
						"icon"
					],
					[
						"projectId",
						"color"
					],
					[
						"projectId",
						"priority"
					],
					[
						"projectId",
						"startDate"
					],
					[
						"projectId",
						"startDateResolution"
					],
					[
						"projectId",
						"targetDate"
					],
					[
						"projectId",
						"targetDateResolution"
					],
					[
						"projectId",
						"statusId"
					],
					[
						"projectId",
						"leadId"
					],
					[
						"projectId",
						"leadTeamId"
					],
					[
						"projectId",
						"memberIds"
					],
					[
						"projectId",
						"labelIds"
					],
					[
						"projectId",
						"convertedFromIssueId"
					],
					[
						"projectId",
						"lastAppliedTemplateId"
					],
					[
						"projectId",
						"sortOrder"
					],
					[
						"projectId",
						"prioritySortOrder"
					],
					[
						"projectId",
						"canceledAt"
					],
					[
						"projectId",
						"completedAt"
					],
					[
						"projectId",
						"projectUpdateRemindersPausedUntilAt"
					],
					[
						"projectId",
						"slackIssueComments"
					],
					[
						"projectId",
						"slackIssueStatuses"
					],
					[
						"projectId",
						"slackNewIssue"
					],
					[
						"projectId",
						"frequencyResolution"
					],
					[
						"projectId",
						"updateReminderFrequency"
					],
					[
						"projectId",
						"updateReminderFrequencyInWeeks"
					],
					[
						"projectId",
						"updateRemindersDay"
					],
					[
						"projectId",
						"updateRemindersHour"
					]
				]
			}
		]
	},
	domain: "projects",
	entity: "Project",
	entityKind: "project",
	documentName: "Project",
	selection: PROJECT_DETAIL_SELECTION,
	idKey: "projectId",
	createRoot: "projectCreate",
	updateRoot: "projectUpdate",
	createType: "ProjectCreateInput",
	updateType: "ProjectUpdateInput",
	resolverPaths: {
		projectId: "resolveNamedEntityReference",
		convertedFromIssueId: "resolveIssueReference",
	},
	parameters: [
		"projectId",
		"id",
		"name",
		"description",
		"content",
		"color",
		"icon",
		"convertedFromIssueId",
		"labelIds",
		"lastAppliedTemplateId",
		"leadId",
		"leadTeamId",
		"memberIds",
		"priority",
		"prioritySortOrder",
		"sortOrder",
		"startDate",
		"startDateResolution",
		"statusId",
		"targetDate",
		"targetDateResolution",
		"teamIds",
		"templateId",
		"useDefaultTemplate",
		"canceledAt",
		"completedAt",
		"frequencyResolution",
		"projectUpdateRemindersPausedUntilAt",
		"slackIssueComments",
		"slackIssueStatuses",
		"slackNewIssue",
		"trashed",
		"updateReminderFrequency",
		"updateReminderFrequencyInWeeks",
		"updateRemindersDay",
		"updateRemindersHour",
		"slackChannelName",
		"input",
	].map((n) => p(n)),
	example: { name: "Platform", teamIds: ["team-id"] },
});

export const operationDefinitions: readonly OperationDefinition[] =
	operationDefinitionsMutable;

export const operations = Object.fromEntries(
	operationDefinitions.map((definition) => [
		definition.name,
		projectCompatibilityOperation(definition),
	]),
) as Record<string, LinearOperation>;
export type OperationName = keyof typeof operations;
const aliases = new Map<string, LinearOperation>();
for (const definition of operationDefinitions) {
	const operation = operations[definition.name]!;
	for (const alias of definition.compatibility.operationAliases)
		aliases.set(alias, operation);
}

export function getOperation(name: string): LinearOperation {
	const operation = operations[name] ?? aliases.get(name);
	if (!operation)
		throw new Error(
			`Unknown Linear operation "${name}". Send { "operation": "help" }.`,
		);
	return operation;
}

export function getOperationDefinition(name: string): OperationDefinition {
	const operation = getOperation(name);
	const definition = operationDefinitions.find(({ name: canonicalName }) =>
		canonicalName === operation.name,
	);
	if (!definition) throw new Error(`Missing operation definition for "${operation.name}".`);
	return definition;
}

export function operationSignature(operation: LinearOperation): string {
	return `${operation.name}(${operation.parameters.map(({ name, type, required }) => `${name}${required ? "" : "?"}: ${type}`).join(", ")})`;
}
export function formatInvocation(value: unknown): string {
	if (Array.isArray(value))
		return `[${value.map(formatInvocation).join(", ")}]`;
	if (value && typeof value === "object")
		return `{ ${Object.entries(value as Record<string, unknown>)
			.map(
				([key, entry]) => `${JSON.stringify(key)}: ${formatInvocation(entry)}`,
			)
			.join(", ")} }`;
	return JSON.stringify(value);
}
export function parameterShapes(
	operation: LinearOperation,
	requestedName: string,
): readonly (readonly OperationParameter[])[] {
	const required = new Set(
		operation.parameters
			.filter((parameter) => parameter.required)
			.map(({ name }) => name),
	);
	const canonicalShape = (
		operation.acceptedParameters ?? operation.parameters
	).map((parameter) => ({
		...parameter,
		required: required.has(parameter.name),
	}));
	const aliasShape = operation.aliasParameters?.[requestedName];
	if (aliasShape) return [canonicalShape, aliasShape];
	const legacyShapes = (operation.legacyParameters ?? []).map((shape) => {
		if (shape.length !== 1 || shape[0]?.name !== "input" || !shape[0].required)
			return shape;
		const accepted = operation.acceptedParameters ?? operation.parameters;
		return accepted.map((parameter) => ({
			...parameter,
			required: parameter.name === "input",
		}));
	});
	return [canonicalShape, ...legacyShapes];
}
export function operationsForDomain(
	domain: OperationDomain,
): LinearOperation[] {
	return operationDefinitions
		.filter((definition) => definition.domain === domain)
		.map(projectCompatibilityOperation);
}
export function operationDocuments(
	operation: LinearOperation,
): readonly string[] {
	return operation.variants?.map(({ document }) => document) ?? [operation.document];
}

export const SAFE_NAMED_MUTATION_ROOTS = new Set(
	operationDefinitions.flatMap((definition) =>
		definition.graphql?.documents
			.filter(({ kind }) => kind === "mutation")
			.map(({ root }) => root) ?? [],
	),
);
