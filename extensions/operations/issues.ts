import {
	isIssueIdentifier,
	parseIssueReferenceSet,
	requireIssueReference,
	resolveIssueReference,
	resolveStateIdReference,
	resolveStateReference,
	resolveTeamReference,
	resolveUserReference,
} from "../client";
import { parseResultView, projection } from "../selections";
import {
	compactObject,
	mergeFilters,
	mergedInput,
	p,
	paginationVariables,
} from "../operation-types";
import type {
	BatchLookup,
	BatchLookupValues,
	LinearOperation,
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

function createIssueRefs(v: Record<string, unknown>) {
	const input = mergedInput(v, [
		"parent",
		"team",
		"teamKey",
		"state",
		"assignee",
	]);
	return {
		input,
		parentRef: v.parent ?? input.parentId,
		teamRef: v.team ?? v.teamKey ?? input.teamId,
		stateRef: v.state ?? input.stateId,
		userRef: v.assignee ?? input.assigneeId,
	};
}

function applyCreateIssueLookups(
	v: Record<string, unknown>,
	resolved: BatchLookupValues,
): OperationPreparation {
	const { input, parentRef, teamRef, stateRef, userRef } = createIssueRefs(v);
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
	if (typeof input.title !== "string" || !input.title.trim()) {
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
		}),
	};
}

function createIssueBatchPrepare(
	v: Record<string, unknown>,
): { kind: "independent"; lookups: BatchLookup[]; finish: (resolved: BatchLookupValues) => OperationPreparation } {
	const { parentRef, teamRef, stateRef, userRef } = createIssueRefs(v);
	const stateIsName = typeof stateRef === "string" && stateRef.trim() && !isUuid(stateRef);
	if (stateIsName && parentRef && !teamRef) {
		throw new Error(
			"Batch cannot fold sequential preparation lookups into one GraphQL request. A state name requires an explicit team when only parent is provided.",
		);
	}
	const lookups: BatchLookup[] = [];
	if (parentRef) lookups.push({ field: "parent", requested: String(parentRef) });
	if (teamRef) lookups.push({ field: "team", requested: String(teamRef) });
	if (stateRef) {
		lookups.push(
			isUuid(stateRef) || !teamRef
				? { field: "state", requested: String(stateRef) }
				: { field: "state", requested: String(stateRef), team: String(teamRef) },
		);
	}
	if (userRef) lookups.push({ field: "assignee", requested: String(userRef) });
	return {
		kind: "independent",
		lookups,
		finish: (resolved) => applyCreateIssueLookups(v, resolved),
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
			const issueIds =
				v.issues !== undefined ? parseIssueReferenceSet(v.issues) : undefined;
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
				id: issueIds ? { in: issueIds } : undefined,
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
		async prepare(_k, v) {
			const ref = requireIssueReference(issueReference(v));
			return {
				variables: { id: ref },
				exactIssue: { requested: ref, path: "issue" },
				resolution: { target: { requested: ref } },
			};
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
		batchPrepare: createIssueBatchPrepare,
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
		async prepare(k, v, s) {
			const ref = requireIssueReference(issueReference(v));
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
			const parentRef = v.parent ?? x.parentId;
			const stateNeedsTeam =
				typeof stateRef === "string" &&
				stateRef.trim() !== "" &&
				!isUuid(stateRef);
			const issue =
				stateNeedsTeam || parentRef
					? await resolveIssueReference(k, ref, s)
					: undefined;
			if (stateRef) {
				const teamId = targetTeam?.id ?? issue?.teamId;
				x.stateId = teamId
					? (await resolveStateReference(k, teamId, String(stateRef), s)).id
					: (await resolveStateIdReference(k, String(stateRef), s)).id;
			}
			const userRef = v.assignee ?? x.assigneeId;
			if (userRef)
				x.assigneeId = (await resolveUserReference(k, String(userRef), s)).id;
			if (parentRef) {
				const parent = await resolveIssueReference(k, String(parentRef), s);
				if (parent.teamId !== (targetTeam?.id ?? issue?.teamId)) {
					throw new Error(
						`Linear parent "${parent.identifier}" does not belong to the issue team.`,
					);
				}
				x.parentId = parent.id;
			}
			if (!Object.keys(x).length)
				throw new Error("No update fields were provided.");
			return {
				variables: { id: ref, input: x },
				exactIssue: { requested: ref, path: "issueUpdate.issue" },
				resolution: compactObject({
					target: issue ? issueTarget(ref, issue) : { requested: ref },
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
		prepare: async (k, v, s) => {
			const term = typeof v.term === "string" ? v.term.trim() : "";
			if (isIssueIdentifier(term)) {
				const view = parseResultView(v.view, "summary");
				return {
					variables: { id: term },
					variant: {
						document: getDocument(
							"GetIssue",
							"issue",
							projection("issue", view === "summary" ? "list" : "detail"),
						),
						root: "issue",
					},
					exactIssue: { requested: term, path: "issue" },
					resolution: { target: { requested: term } },
					resultView: view,
					resultCategory: "singular",
				};
			}
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
] satisfies OperationSource[]).map((operation) =>
	defineOperation(operation as LinearOperation),
);
