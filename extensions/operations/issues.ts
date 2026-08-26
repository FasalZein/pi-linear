import {
	isIssueIdentifier,
	parseIssueReferenceSet,
	requireIssueReference,
	type ResolvedIssue,
	type ResolvedNamedEntity,
	type ResolvedState,
	type ResolvedTeam,
	type ResolvedUser,
} from "../client";
import { parseResultView, projection } from "../selections";
import { issueLookup, namedEntityLookup, pureQueryPlan, stateLookup, stateLookupForTeamReference, teamLookup, userLookup } from "../operation-plan";
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
	OperationPlan,
	OperationPreparation,
	OperationSource,
	OperationDefinition,
} from "../operation-types";
import { defineOperation } from "../operation-definition";
import {
	ISSUE_SORT_KEYS,
	pagination,
	input,
	filter,
	sort,
	issueTarget,
	issueReference,
	isUuid,
	object,
	getDocument,
	workspaceEmpty,
	listOperation,
	linearSort,
	simpleMutation,
	withGetResultView,
} from "./shared";

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

function createIssueRefs(v: CompatibilityObject) {
	const input = mergedInput(v, [
		"parent",
		"team",
		"teamKey",
		"state",
		"assignee",
		"project",
		"labels",
	]);
	const projectRef = v.project;
	if (isUuid(projectRef)) input.projectId = projectRef;
	if (Array.isArray(v.labels)) input.labelIds = v.labels;
	return {
		input,
		parentRef: v.parent ?? input.parentId,
		teamRef: v.team ?? v.teamKey ?? input.teamId,
		stateRef: v.state ?? input.stateId,
		userRef: v.assignee ?? input.assigneeId,
		projectRef: isCompatibilityString(projectRef) && !isUuid(projectRef) ? projectRef : undefined,
	};
}

type CreateIssueLookups = {
	parent?: ResolvedIssue;
	team?: ResolvedTeam;
	state?: ResolvedState;
	assignee?: ResolvedUser;
	project?: ResolvedNamedEntity;
};

function applyCreateIssueLookups(
	v: CompatibilityObject,
	resolved: CreateIssueLookups,
): OperationPreparation {
	const { input, parentRef, teamRef, stateRef, userRef, projectRef } = createIssueRefs(v);
	const parent = resolved.parent;
	const team = resolved.team;
	if (team && parent && team.id !== parent.teamId) {
		throw new Error(
			`Linear parent "${parent.identifier}" does not belong to team "${team.key}".`,
		);
	}
	const teamId = team?.id ?? parent?.teamId;
	if (!teamId) {
		throw new Error(
			"Issue team is required. Send team, teamKey, teamId, or parent.",
		);
	}
	input.teamId = teamId;
	if (parent) input.parentId = parent.id;
	if (stateRef) {
		const state = resolved.state;
		if (!state) {
			throw new Error(`Linear state "${String(stateRef)}" was not found.`);
		}
		if (state.teamId !== teamId) {
			throw new Error(
				`Linear state "${String(stateRef)}" does not belong to team "${teamId}".`,
			);
		}
		input.stateId = state.id;
	}
	if (userRef) {
		const assignee = resolved.assignee;
		if (!assignee) {
			throw new Error(`Linear user "${String(userRef)}" was not found.`);
		}
		input.assigneeId = assignee.id;
	}
	if (projectRef) {
		const project = resolved.project;
		if (!project) throw new Error(`Linear project "${projectRef}" was not found.`);
		input.projectId = project.id;
	}
	if (!isCompatibilityString(input.title) || !input.title.trim()) {
		throw new Error("Issue title is required for issueCreate (title).");
	}
	return {
		variables: { input },
		resolution: compactObject({
			parent: parent ? issueTarget(String(parentRef), parent) : undefined,
			team: {
				requested: teamRef ?? parentRef,
				resolvedId: teamId,
				key: team?.key ?? parent?.teamKey,
			},
			state: stateRef
				? { requested: stateRef, resolvedId: input.stateId }
				: undefined,
			assignee: userRef
				? { requested: userRef, resolvedId: input.assigneeId }
				: undefined,
			project: projectRef
				? { requested: projectRef, resolvedId: input.projectId }
				: undefined,
		}),
	};
}

function createIssuePlan(v: CompatibilityObject): OperationPlan {
	const { parentRef, teamRef, stateRef, userRef, projectRef } = createIssueRefs(v);
	return {
		kind: "mutation",
		lookups: [
			...(parentRef ? [issueLookup("parent", String(parentRef))] : []),
			...(teamRef ? [teamLookup("team", String(teamRef))] : []),
			...(stateRef
				? [isCompatibilityString(stateRef) && !isUuid(stateRef) && teamRef
					? stateLookupForTeamReference("state", stateRef, String(teamRef))
					: stateLookup("state", String(stateRef), isCompatibilityString(stateRef) && !isUuid(stateRef) && parentRef ? "parent" : undefined, (value) => (value as { teamId: string }).teamId)]
				: []),
			...(userRef ? [userLookup("assignee", String(userRef))] : []),
			...(projectRef ? [namedEntityLookup("project", "project", projectRef)] : []),
		],
		finish: (resolved) => applyCreateIssueLookups(v, resolved as CreateIssueLookups),
	};
}

function updateIssuePlan(v: CompatibilityObject): OperationPlan {
	const ref = requireIssueReference(issueReference(v));
	const input = mergedInput(v, ["issue", "issueId", "state", "assignee", "parent"]);
	if (v.assignee === null) input.assigneeId = null;
	if (v.parent === null) input.parentId = null;
	const teamRef = input.teamId;
	const stateRef = v.state ?? input.stateId;
	const parentRef = v.parent ?? input.parentId;
	const userRef = v.assignee ?? input.assigneeId;
	const stateNeedsTeam = isCompatibilityString(stateRef) && stateRef.trim() !== "" && !isUuid(stateRef);
	const needsIssue = Boolean(parentRef) || Boolean(stateRef && !teamRef);
	return {
		kind: "mutation",
		lookups: [
			...(teamRef ? [teamLookup("team", String(teamRef))] : []),
			...(needsIssue ? [issueLookup("target", ref)] : []),
			...(stateRef ? [stateNeedsTeam && teamRef
				? stateLookupForTeamReference("state", String(stateRef), String(teamRef))
				: stateLookup("state", String(stateRef), stateNeedsTeam ? "target" : undefined, (value) => (value as { teamId: string }).teamId)] : []),
			...(userRef ? [userLookup("assignee", String(userRef))] : []),
			...(parentRef ? [issueLookup("parent", String(parentRef))] : []),
		],
		finish(resolved) {
			const team = resolved.team as { id: string; key: string } | undefined;
			const issue = resolved.target as { id: string; identifier: string; teamId: string; teamKey: string } | undefined;
			const state = resolved.state as { id: string; teamId: string } | undefined;
			const assignee = resolved.assignee as { id: string } | undefined;
			const parent = resolved.parent as { id: string; identifier: string; teamId: string } | undefined;
			if (team) input.teamId = team.id;
			if (state) {
				const expectedTeamId = team?.id ?? issue?.teamId;
				if (expectedTeamId && state.teamId !== expectedTeamId) {
					throw new Error(`Linear state "${String(stateRef)}" does not belong to team "${expectedTeamId}".`);
				}
				input.stateId = state.id;
			}
			if (assignee) input.assigneeId = assignee.id;
			if (parent) {
				if (parent.teamId !== (team?.id ?? issue?.teamId)) throw new Error(`Linear parent "${parent.identifier}" does not belong to the issue team.`);
				input.parentId = parent.id;
			}
			if (!Object.keys(input).length) throw new Error("No update fields were provided.");
			return {
				variables: { id: ref, input },
				exactIssue: { requested: ref, path: "issueUpdate.issue" },
				resolution: compactObject({
					target: issue ? issueTarget(ref, issue) : { requested: ref },
					state: stateRef ? { requested: stateRef, resolvedId: input.stateId } : undefined,
					assignee: userRef ? { requested: userRef, resolvedId: input.assigneeId } : undefined,
					parent: parentRef ? { requested: parentRef, resolvedId: input.parentId } : undefined,
				}),
			};
		},
	};
}

export const issues: readonly OperationDefinition[] = ([
	listOperation({
		name: "list_issues",
		compatibilityBranches: [
			{
				"all": []
			}
		],
		semanticException: "state-name-requires-team",
		renderEmpty: workspaceEmpty("issues", "issue"),
		canonical: {
			"fields": {
				"issues": "[IssueReference!]",
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
		selection: projection("issue", "list"),
		resultView: { entity: "issue", defaultView: "summary" },
		purpose: "List issues with exact convenience filters.",
		pageSize: 20,
		filterType: "IssueFilter",
		sortType: "IssueSortInput",
		sortKeys: ISSUE_SORT_KEYS,
		example: { assignee: "me", stateType: "started" },
		parameters: [
			p("issues", "[IssueReference!]"),
			p("query"),
			p("team", "TeamReference"),
			p("state", "StateReference"),
			p("stateType", "WorkflowStateType"),
			p("assignee", "UserReference"),
		],
		acceptedParameters: [
			p("issues"),
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
			if (variables.issues !== undefined) parseIssueReferenceSet(variables.issues);
			const state = variables.state ?? variables.stateName;
			if (state === undefined) return;
			if (!isCompatibilityString(state) || !state.trim()) {
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
		plan: (v) => {
			const issueIds = v.issues !== undefined ? parseIssueReferenceSet(v.issues) : undefined;
			const teamRef = v.team ?? v.teamKey ?? v.teamId;
			const assigneeRef = v.assignee ?? v.assigneeId;
			const stateReference = v.state ?? v.stateName;
			const lookups = [
				...(teamRef ? [teamLookup("team", String(teamRef))] : []),
				...(assigneeRef ? [userLookup("assignee", String(assigneeRef))] : []),
				...(stateReference ? [stateLookup("state", String(stateReference), teamRef ? "team" : undefined)] : []),
			];
			return {
				kind: "query",
				lookups,
				finish(resolved) {
					const team = resolved.team as { id: string; key: string } | undefined;
					const assignee = resolved.assignee as { id: string; name?: string } | undefined;
					const state = resolved.state as { id: string; teamId: string } | undefined;
					if (team && state && state.teamId !== team.id) throw new Error(`Linear state "${String(stateReference)}" does not belong to team "${team.id}".`);
					const convenience = compactObject({
						id: issueIds ? { in: issueIds } : undefined,
						title: v.query ? { containsIgnoreCase: v.query } : undefined,
						team: team ? { id: { eq: team.id } } : undefined,
						state: state ? { id: { eq: state.id } } : v.stateType ? { type: { eq: String(v.stateType) } } : undefined,
						assignee: assignee ? { id: { eq: assignee.id } } : undefined,
					});
					return {
						variables: { ...paginationVariables(v, 20), filter: mergeFilters(object(v.filter), convenience), sort: linearSort(v.sort) },
						resolution: compactObject({
							team: team ? { requested: teamRef, resolvedId: team.id, key: team.key } : undefined,
							assignee: assignee ? { requested: assigneeRef, resolvedId: assignee.id, name: assignee.name } : undefined,
							state: state ? { requested: stateReference, resolvedId: state.id } : undefined,
						}),
					};
				},
			};
		},
	}),
	withGetResultView({
		name: "get_issue",
		compatibilityBranches: [
			{
				"all": [
					"issue"
				]
			},
			{
				"all": [
					"teamKey",
					"number"
				]
			}
		],
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
		document: getDocument("GetIssue", "issue", projection("issue", "detail")),
		resolverPaths: { issue: "resolveIssueReference" },
		plan(v) {
			const ref = requireIssueReference(issueReference(v));
			return pureQueryPlan({
				variables: { id: ref },
				exactIssue: { requested: ref, path: "issue" },
				resolution: { target: { requested: ref } },
			});
		},
	}, "issue", "issue", "GetIssue"),
	simpleMutation({
		name: "create_issue",
		compatibilityBranches: [
			{
				"all": [
					"title"
				],
				"atLeastOneOf": [
					"team",
					"teamKey",
					"teamId",
					"parent",
					"input.teamId",
					"input.parentId"
				]
			},
			{
				"all": [
					"input.title"
				],
				"atLeastOneOf": [
					"team",
					"teamKey",
					"teamId",
					"parent",
					"input.teamId",
					"input.parentId"
				]
			}
		],
		semanticException: "non-empty-title-and-team-or-parent",
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
		selection: `issue { ${projection("issue", "detail")} }`,
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
			p("project", "ProjectReference"),
			p("labels", "[UUID!]"),
			input,
		],
		legacyParameters: [[p("input", "IssueCreateInput", true)]],
		example: { title: "v0.4 trial child", parent: "AEO-258" },
		validateVariables(variables) {
			const raw = object(variables.input) ?? {};
			const projectSources = [variables.project, variables.projectId, raw.projectId].filter((value) => value !== undefined);
			if (projectSources.length > 1) throw new Error("project, projectId, and input.projectId conflict; send exactly one");
			if (variables.project !== undefined && (!isCompatibilityString(variables.project) || !variables.project.trim())) {
				throw new Error("project must be an exact non-empty project name or UUID");
			}
			for (const projectId of [variables.projectId, raw.projectId].filter((value) => value !== undefined)) {
				if (!isUuid(projectId)) throw new Error("projectId must be a UUID");
			}
			const labelSources = [variables.labels, variables.labelIds, raw.labelIds].filter((value) => value !== undefined);
			if (labelSources.length > 1) throw new Error("labels, labelIds, and input.labelIds conflict; send exactly one");
			for (const labels of labelSources) {
				if (!Array.isArray(labels) || !labels.length || labels.some((label) => !isUuid(label))) {
					throw new Error("labels and labelIds must be a non-empty list of exact issue-label UUIDs");
				}
			}
			const title = variables.title ?? raw.title;
			if (!isCompatibilityString(title) || !title.trim()) {
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
			if (!isCompatibilityString(teamOrParent) || !teamOrParent.trim()) {
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
		plan: createIssuePlan,
	}),
	simpleMutation({
		name: "update_issue",
		compatibilityBranches: [
			{
				"all": [
					"issue"
				]
			},
			{
				"all": [
					"issueId",
					"stateId"
				]
			}
		],
		canonical: {
			"fields": {
				"issue": "IssueReference",
				"title": "String",
				"state": "StateReference",
				"assignee": "NullableUserReference",
				"parent": "NullableIssueReference",
				"teamId": "TeamReference",
				"dueDate": "NullableDate",
				"addedLabelIds": "[UUID!]",
				"removedLabelIds": "[UUID!]",
				"description": "String",
				"descriptionData": "JsonString",
				"priority": "Priority",
				"estimate": "Int",
				"projectId": "NullableUUID",
				"projectMilestoneId": "NullableUUID",
				"cycleId": "NullableUUID",
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
		selection: `issue { ${projection("issue", "detail")} }`,
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
		plan: updateIssuePlan,
	}),
	listOperation({
		name: "search_issues",
		compatibilityBranches: [
			{
				"all": [
					"term"
				]
			}
		],
		renderKind: "issue",
		renderEmpty: {
			"fact": "No issues matched the search.",
			"action": "Change or broaden the search term.",
			"filteredFact": "No issues matched the search.",
			"filteredAction": "Change or broaden the search term."
		},
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
		selection: projection("issue", "list"),
		resultView: { entity: "issue", defaultView: "summary" },
		inventoryDocuments: (["summary", "full"] as const).map((id) => ({
			id: `exact-${id}`,
			document: getDocument("GetIssue", "issue", projection("issue", id === "summary" ? "list" : "detail")),
		})),
		purpose: "Search issues by text.",
		pageSize: 20,
		filterType: "IssueFilter",
		totalCount: true,
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
		plan: (v) => {
			const term = isCompatibilityString(v.term) ? v.term.trim() : "";
			if (isIssueIdentifier(term)) {
				const view = parseResultView(v.view, "summary");
				return pureQueryPlan({
					variables: { id: term },
					variant: { document: getDocument("GetIssue", "issue", projection("issue", view === "summary" ? "list" : "detail")), root: "issue" },
					exactIssue: { requested: term, path: "issue" },
					resolution: { target: { requested: term } },
					resultView: view,
					resultCategory: "singular",
				});
			}
			const teamRef = v.team ?? v.teamId;
			return {
				kind: "query",
				lookups: teamRef ? [teamLookup("team", String(teamRef))] : [],
				finish(resolved) {
					const team = resolved.team as { id: string; key: string } | undefined;
					return {
						variables: { ...paginationVariables(v, 20), term: v.term, includeComments: v.includeComments, teamId: team?.id, filter: object(v.filter) },
						resolution: team ? { team: { requested: teamRef, resolvedId: team.id, key: team.key } } : undefined,
					};
				},
			};
		},
	}),
] satisfies OperationSource[]).map((operation) =>
	defineOperation(operation),
);
