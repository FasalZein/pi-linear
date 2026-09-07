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
	operationParameterDecision,
} from "./shared";



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
		...operationParameterDecision({
		fields: [
			{ name: "issues", canonical: "[IssueReference!]", card: { order: 0 }, accepted: { order: 0 } },
			{ name: "query", canonical: "String", card: { order: 1 }, accepted: { order: 1 } },
			{ name: "team", canonical: "TeamReference", card: { order: 2 }, accepted: { order: 2 } },
			{ name: "state", canonical: "StateReference", card: { order: 3 }, accepted: { order: 5 } },
			{ name: "stateType", canonical: "WorkflowStateType", card: { order: 4 }, accepted: { order: 7 } },
			{ name: "assignee", canonical: "UserReference", card: { order: 5 }, accepted: { order: 8 } },
			{ name: "sort", canonical: "[IssueSort!]", accepted: { order: 17, type: "[SortInput!]" } },
			{ name: "after", canonical: "String", accepted: { order: 10 } },
			{ name: "before", canonical: "String", accepted: { order: 11 } },
			{ name: "first", canonical: "Int", accepted: { order: 12, type: "Int" } },
			{ name: "last", canonical: "Int", accepted: { order: 13, type: "Int" } },
			{ name: "includeArchived", canonical: "Boolean", accepted: { order: 14, type: "Boolean" } },
			{ name: "orderBy", canonical: "PaginationOrderBy", accepted: { order: 15, type: "PaginationOrderBy" } },
			{ name: "filter", canonical: "Filter", accepted: { order: 16, type: "Filter" } },
			{ name: "view", canonical: "ResultView" },
			{ name: "teamId", accepted: { order: 3 } },
			{ name: "teamKey", accepted: { order: 4 } },
			{ name: "stateName", accepted: { order: 6 } },
			{ name: "assigneeId", accepted: { order: 9 } },
		],
		requirements: {
			canonicalBranches: 1,
			compatibilityBranches: [{}],
		},
	}),
				semanticException: "state-name-requires-team",
		renderEmpty: workspaceEmpty("issues", "issue"),
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
		...operationParameterDecision({
		fields: [
			{ name: "issue", canonical: "IssueReference", canonicalBranches: [0], compatibilityRequirements: [{"branch":0,"kind":"all","order":0}], card: { order: 0, required: true } },
			{ name: "view", canonical: "ResultView" },
			{ name: "teamKey", compatibilityRequirements: [{"branch":1,"kind":"all","order":0}], legacy: [{ order: 0, required: true, branch: 0 }] },
			{ name: "number", compatibilityRequirements: [{"branch":1,"kind":"all","order":1}], legacy: [{ order: 1, type: "Float", required: true, branch: 0 }] },
		],
		requirements: {
			canonicalBranches: 1,
			compatibilityBranches: [{},{}],
		},
	}),
						aliases: [],
		domain: "issues",
		purpose: "Get one issue by exact identifier or UUID.",
						example: { operation: "get_issue", variables: { issue: "AEO-258" } },
		document: getDocument("GetIssue", "issue", projection("issue", "detail")),
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
		...operationParameterDecision({
		fields: [
			{ name: "title", canonical: "String", canonicalBranches: [0,1], compatibilityRequirements: [{"branch":0,"kind":"all","order":0},{"branch":1,"kind":"all","order":0,"input":true}], card: { order: 0, required: true }, accepted: { order: 2 } },
			{ name: "team", canonical: "TeamReference", canonicalBranches: [0], compatibilityRequirements: [{"branch":0,"kind":"atLeastOne","order":0},{"branch":1,"kind":"atLeastOne","order":0}], card: { order: 2 }, accepted: { order: 36 }, reference: { order: 2 } },
			{ name: "parent", canonical: "IssueReference", canonicalBranches: [1], compatibilityRequirements: [{"branch":0,"kind":"atLeastOne","order":3},{"branch":1,"kind":"atLeastOne","order":3}], card: { order: 1 }, accepted: { order: 35 }, reference: { order: 0 } },
			{ name: "state", canonical: "StateReference", card: { order: 3 }, accepted: { order: 37 }, reference: { order: 5 } },
			{ name: "assignee", canonical: "UserReference", card: { order: 4 }, accepted: { order: 38 }, reference: { order: 7 } },
			{ name: "dueDate", canonical: "Date", accepted: { order: 12 } },
			{ name: "description", canonical: "String", accepted: { order: 3 } },
			{ name: "descriptionData", canonical: "JsonString", accepted: { order: 10 } },
			{ name: "priority", canonical: "Priority", accepted: { order: 19 } },
			{ name: "estimate", canonical: "Int", accepted: { order: 13 } },
			{ name: "projectId", canonical: "UUID", accepted: { order: 21 } },
			{ name: "projectMilestoneId", canonical: "UUID", accepted: { order: 22 } },
			{ name: "cycleId", canonical: "UUID", accepted: { order: 8 } },
			{ name: "labelIds", canonical: "[UUID!]", accepted: { order: 15 } },
			{ name: "subscriberIds", canonical: "[UUID!]", accepted: { order: 32 } },
			{ name: "delegateId", canonical: "UUID", accepted: { order: 9 } },
			{ name: "lastAppliedTemplateId", canonical: "UUID", accepted: { order: 16 } },
			{ name: "slaType", canonical: "SlaDayCountType", accepted: { order: 26 } },
			{ name: "slaBreachesAt", canonical: "NullableDateTime", accepted: { order: 24 } },
			{ name: "slaStartedAt", canonical: "NullableDateTime", accepted: { order: 25 } },
			{ name: "sortOrder", canonical: "Float", accepted: { order: 27 } },
			{ name: "subIssueSortOrder", canonical: "Float", accepted: { order: 31 } },
			{ name: "prioritySortOrder", canonical: "Float", accepted: { order: 20 } },
			{ name: "templateId", canonical: "UUID", accepted: { order: 33 } },
			{ name: "useDefaultTemplate", canonical: "Boolean", accepted: { order: 34 } },
			{ name: "preserveSortOrderOnCreate", canonical: "Boolean", accepted: { order: 18 } },
			{ name: "referenceCommentId", canonical: "UUID", accepted: { order: 23 } },
			{ name: "sourceCommentId", canonical: "UUID", accepted: { order: 28 } },
			{ name: "sourcePullRequestCommentId", canonical: "UUID", accepted: { order: 29 } },
			{ name: "createAsUser", canonical: "String", accepted: { order: 6 } },
			{ name: "displayIconUrl", canonical: "Url", accepted: { order: 11 } },
			{ name: "completedAt", canonical: "NullableDateTime", accepted: { order: 5 } },
			{ name: "createdAt", canonical: "DateTime", accepted: { order: 7 } },
			{ name: "id", canonical: "UUID", accepted: { order: 14 } },
			{ name: "input", card: { order: 5, type: "Input" }, accepted: { order: 41, type: "Input" }, legacy: [{ order: 0, type: "IssueCreateInput", required: true, branch: 0 }] },
			{ name: "teamId", compatibilityRequirements: [{"branch":0,"kind":"atLeastOne","order":2},{"branch":0,"kind":"atLeastOne","order":4,"input":true},{"branch":1,"kind":"atLeastOne","order":2},{"branch":1,"kind":"atLeastOne","order":4,"input":true}], accepted: { order: 0 }, reference: { type: "TeamReference", order: 4 } },
			{ name: "teamKey", compatibilityRequirements: [{"branch":0,"kind":"atLeastOne","order":1},{"branch":1,"kind":"atLeastOne","order":1}], accepted: { order: 1 }, reference: { type: "TeamReference", order: 3 } },
			{ name: "assigneeId", accepted: { order: 4 }, reference: { type: "UserReference", order: 8 } },
			{ name: "parentId", compatibilityRequirements: [{"branch":0,"kind":"atLeastOne","order":5,"input":true},{"branch":1,"kind":"atLeastOne","order":5,"input":true}], accepted: { order: 17 }, reference: { type: "IssueReference", order: 1 } },
			{ name: "stateId", accepted: { order: 30 }, reference: { type: "StateReference", order: 6 } },
			{ name: "project", accepted: { order: 39, type: "ProjectReference" } },
			{ name: "labels", accepted: { order: 40, type: "[UUID!]" } },
		],
		requirements: {
			canonicalBranches: 2,
			compatibilityBranches: [{},{}],
		},
	}),
				semanticException: "non-empty-title-and-team-or-parent",
				domain: "issues",
		purpose:
			"Create an issue. A parent reference supplies the team when team is omitted.",
		root: "issueCreate",
		inputType: "IssueCreateInput",
		selection: `issue { ${projection("issue", "detail")} }`,
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
		plan: createIssuePlan,
	}),
	simpleMutation({
		name: "update_issue",
		...operationParameterDecision({
		fields: [
			{ name: "issue", canonical: "IssueReference", canonicalBranches: [0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27], compatibilityRequirements: [{"branch":0,"kind":"all","order":0}], card: { order: 0, required: true }, accepted: { order: 0 }, reference: { order: 0 } },
			{ name: "title", canonical: "String", canonicalBranches: [0], accepted: { order: 5 } },
			{ name: "state", canonical: "StateReference", canonicalBranches: [1], card: { order: 1 }, accepted: { order: 2 }, reference: { order: 2 } },
			{ name: "assignee", canonical: "NullableUserReference", canonicalBranches: [2], card: { order: 2, type: "UserReference" }, accepted: { order: 3 }, reference: { order: 4 } },
			{ name: "parent", canonical: "NullableIssueReference", canonicalBranches: [3], card: { order: 3, type: "IssueReference" }, accepted: { order: 4 }, reference: { order: 6 } },
			{ name: "teamId", canonical: "TeamReference", canonicalBranches: [4], accepted: { order: 32 }, reference: { order: 8 } },
			{ name: "dueDate", canonical: "NullableDate", canonicalBranches: [5], accepted: { order: 10 } },
			{ name: "addedLabelIds", canonical: "[UUID!]", canonicalBranches: [6], accepted: { order: 11 } },
			{ name: "removedLabelIds", canonical: "[UUID!]", canonicalBranches: [7], accepted: { order: 23 } },
			{ name: "description", canonical: "String", canonicalBranches: [8], accepted: { order: 6 } },
			{ name: "descriptionData", canonical: "JsonString", canonicalBranches: [9], accepted: { order: 15 } },
			{ name: "priority", canonical: "Priority", canonicalBranches: [10], accepted: { order: 7 } },
			{ name: "estimate", canonical: "Int", canonicalBranches: [11], accepted: { order: 16 } },
			{ name: "projectId", canonical: "NullableUUID", canonicalBranches: [12], accepted: { order: 21 } },
			{ name: "projectMilestoneId", canonical: "NullableUUID", canonicalBranches: [13], accepted: { order: 22 } },
			{ name: "cycleId", canonical: "NullableUUID", canonicalBranches: [14], accepted: { order: 13 } },
			{ name: "labelIds", canonical: "[UUID!]", canonicalBranches: [15], accepted: { order: 17 } },
			{ name: "subscriberIds", canonical: "[UUID!]", canonicalBranches: [16], accepted: { order: 31 } },
			{ name: "delegateId", canonical: "UUID", canonicalBranches: [17], accepted: { order: 14 } },
			{ name: "lastAppliedTemplateId", canonical: "UUID", canonicalBranches: [18], accepted: { order: 18 } },
			{ name: "slaType", canonical: "SlaDayCountType", canonicalBranches: [19], accepted: { order: 26 } },
			{ name: "slaBreachesAt", canonical: "NullableDateTime", canonicalBranches: [20], accepted: { order: 24 } },
			{ name: "slaStartedAt", canonical: "NullableDateTime", canonicalBranches: [21], accepted: { order: 25 } },
			{ name: "sortOrder", canonical: "Float", canonicalBranches: [22], accepted: { order: 29 } },
			{ name: "subIssueSortOrder", canonical: "Float", canonicalBranches: [23], accepted: { order: 30 } },
			{ name: "prioritySortOrder", canonical: "Float", canonicalBranches: [24], accepted: { order: 20 } },
			{ name: "autoClosedByParentClosing", canonical: "Boolean", canonicalBranches: [25], accepted: { order: 12 } },
			{ name: "snoozedById", canonical: "UUID", canonicalBranches: [26], accepted: { order: 27 } },
			{ name: "snoozedUntilAt", canonical: "NullableDateTime", canonicalBranches: [27], accepted: { order: 28 } },
			{ name: "input", card: { order: 4, type: "Input" }, accepted: { order: 34, type: "Input" } },
			{ name: "issueId", compatibilityRequirements: [{"branch":1,"kind":"all","order":0}], accepted: { order: 1 }, aliases: [{ order: 0, required: true, operation: "update_issue_state" }], reference: { type: "IssueReference", order: 1 } },
			{ name: "stateId", compatibilityRequirements: [{"branch":1,"kind":"all","order":1}], accepted: { order: 8 }, aliases: [{ order: 1, required: true, operation: "update_issue_state" }], reference: { type: "StateReference", order: 3 } },
			{ name: "assigneeId", accepted: { order: 9 }, reference: { type: "UserReference", order: 5 } },
			{ name: "parentId", accepted: { order: 19 }, reference: { type: "IssueReference", order: 7 } },
			{ name: "trashed", accepted: { order: 33 } },
		],
		requirements: {
			canonicalBranches: 28,
			compatibilityBranches: [{},{}],
		},
	}),
						domain: "issues",
		purpose: "Update an issue by exact identifier or UUID.",
		root: "issueUpdate",
		inputType: "IssueUpdateInput",
		selection: `issue { ${projection("issue", "detail")} }`,
		idKey: "issue",
						example: { issue: "AEO-258", state: "Backlog" },
		aliases: ["update_issue_state"],
		plan: updateIssuePlan,
	}),
	listOperation({
		name: "search_issues",
		...operationParameterDecision({
		fields: [
			{ name: "term", canonical: "String", canonicalBranches: [0], compatibilityRequirements: [{"branch":0,"kind":"all","order":0}], card: { order: 0, required: true }, accepted: { order: 0, required: true } },
			{ name: "includeComments", canonical: "Boolean", card: { order: 1 }, accepted: { order: 1 } },
			{ name: "team", canonical: "TeamReference", card: { order: 2 }, accepted: { order: 2 } },
			{ name: "after", canonical: "String", accepted: { order: 4 } },
			{ name: "before", canonical: "String", accepted: { order: 5 } },
			{ name: "first", canonical: "Int", accepted: { order: 6, type: "Int" } },
			{ name: "last", canonical: "Int", accepted: { order: 7, type: "Int" } },
			{ name: "includeArchived", canonical: "Boolean", accepted: { order: 8, type: "Boolean" } },
			{ name: "orderBy", canonical: "PaginationOrderBy", accepted: { order: 9, type: "PaginationOrderBy" } },
			{ name: "filter", canonical: "Filter", accepted: { order: 10, type: "Filter" } },
			{ name: "view", canonical: "ResultView" },
			{ name: "teamId", accepted: { order: 3 } },
		],
		requirements: {
			canonicalBranches: 1,
			compatibilityBranches: [{}],
		},
	}),
				renderKind: "issue",
		renderEmpty: {
			"fact": "No issues matched the search.",
			"action": "Change or broaden the search term.",
			"filteredFact": "No issues matched the search.",
			"filteredAction": "Change or broaden the search term."
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
