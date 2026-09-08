import { namedEntityLookup, pureQueryPlan } from "../operation-plan";
import { projection } from "../selections";
import type {
	OperationSource,
	OperationDefinition,
} from "../operation-types";
import { defineOperation } from "../operation-definition";
import {
	PROJECT_SORT_KEYS,
	isUuid,
	getDocument,
	workspaceEmpty,
	listOperation,
	addSaveOperation,
	withGetResultView,
	operationParameterDecision,
} from "./shared";

export const projectReads: readonly OperationDefinition[] = ([
	listOperation({
		name: "list_projects",
		...operationParameterDecision({
		fields: [
			{ name: "sort", canonical: "[ProjectSort!]" },
			{ name: "after", canonical: "String" },
			{ name: "before", canonical: "String" },
			{ name: "first", canonical: "Int" },
			{ name: "last", canonical: "Int" },
			{ name: "includeArchived", canonical: "Boolean" },
			{ name: "orderBy", canonical: "PaginationOrderBy" },
			{ name: "filter", canonical: "Filter" },
			{ name: "view", canonical: "ResultView" },
		],
		requirements: {
			canonicalBranches: 1,
			compatibilityBranches: [{}],
		},
	}),
				renderEmpty: workspaceEmpty("projects", "project"),
				domain: "projects",
		root: "projects",
		selection: projection("project", "list"),
		resultView: { entity: "project", defaultView: "summary" },
		purpose: "List projects.",
		pageSize: 20,
		filterType: "ProjectFilter",
		sortType: "ProjectSortInput",
		sortKeys: PROJECT_SORT_KEYS,
	}),
	withGetResultView({
		name: "get_project",
		...operationParameterDecision({
		fields: [
			{ name: "project", canonical: "ProjectReference", canonicalBranches: [0], compatibilityRequirements: [{"branch":0,"kind":"all","order":0}], card: { order: 0, required: true } },
			{ name: "view", canonical: "ResultView" },
			{ name: "projectId", compatibilityRequirements: [{"branch":1,"kind":"all","order":0}], legacy: [{ order: 0, required: true, branch: 0 }] },
		],
		requirements: {
			canonicalBranches: 1,
			compatibilityBranches: [{},{}],
		},
	}),
						aliases: [],
		domain: "projects",
		purpose: "Get a project by exact name, slug, or UUID.",
						example: { operation: "get_project", variables: { project: "Platform" } },
		document: getDocument("GetProject", "project", projection("project", "detail")),
		plan(v) {
			const requested = String(v.project ?? v.projectId);
			const reference = requested.trim();
			if (isUuid(reference)) {
				return pureQueryPlan({
					variables: { id: reference },
					exactNamed: { requested: reference, path: "project", kind: "project" },
					resolution: { target: { requested: reference } },
				});
			}
			return {
				kind: "query",
				lookups: [namedEntityLookup("project", "project", requested)],
				finish(resolved) {
					const x = resolved.project as { id: string; name: string };
					return { variables: { id: x.id }, resolution: { target: { requested: v.project ?? v.projectId, resolvedId: x.id, name: x.name } } };
				},
			};
		},
	}, "project", "project", "GetProject"),
] satisfies OperationSource[]).map((operation) =>
	defineOperation(operation),
);

export const projectSaves: readonly OperationDefinition[] = [
addSaveOperation({
	name: "save_project",
	parameterDecision: {
		identity: { kind: "identity", name: "projectId", type: "ProjectReference", canonicalOrder: 0 },
		fields: [
			{ kind: "typed", name: "id", type: "UUID", canonicalOrder: 30, tier: "advanced", mode: "create" },
			{ kind: "typed", name: "name", type: "String", canonicalOrder: 1, mode: "both", requiredOnCreate: true, compatibilityCard: true, renderTarget: true },
			{ kind: "typed", name: "description", type: "String", canonicalOrder: 3, mode: "both" },
			{ kind: "typed", name: "content", type: "String", canonicalOrder: 4, mode: "both" },
			{ kind: "typed", name: "color", type: "Color", canonicalOrder: 6, mode: "both" },
			{ kind: "typed", name: "icon", type: "String", canonicalOrder: 5, mode: "both" },
			{ kind: "typed", name: "convertedFromIssueId", type: "IssueReference", canonicalOrder: 17, tier: "advanced", mode: "both" },
			{ kind: "typed", name: "labelIds", type: "[UUID!]", canonicalOrder: 16, mode: "both" },
			{ kind: "typed", name: "lastAppliedTemplateId", type: "UUID", canonicalOrder: 18, tier: "advanced", mode: "both" },
			{ kind: "typed", name: "leadId", type: "UUID", canonicalOrder: 13, mode: "both" },
			{ kind: "typed", name: "leadTeamId", type: "UUID", canonicalOrder: 14, tier: "advanced", mode: "both" },
			{ kind: "typed", name: "memberIds", type: "[UUID!]", canonicalOrder: 15, tier: "advanced", mode: "both" },
			{ kind: "typed", name: "priority", type: "Priority", canonicalOrder: 7, mode: "both" },
			{ kind: "typed", name: "prioritySortOrder", type: "Float", canonicalOrder: 20, tier: "advanced", mode: "both" },
			{ kind: "typed", name: "sortOrder", type: "Float", canonicalOrder: 19, tier: "advanced", mode: "both" },
			{ kind: "typed", name: "startDate", type: "Date", canonicalOrder: 8, mode: "both" },
			{ kind: "typed", name: "startDateResolution", type: "DateResolutionType", canonicalOrder: 9, tier: "advanced", mode: "both" },
			{ kind: "typed", name: "statusId", type: "UUID", canonicalOrder: 12, mode: "both" },
			{ kind: "typed", name: "targetDate", type: "NullableDate", canonicalOrder: 10, mode: "both" },
			{ kind: "typed", name: "targetDateResolution", type: "DateResolutionType", canonicalOrder: 11, tier: "advanced", mode: "both" },
			{ kind: "typed", name: "teamIds", type: "[ID!]", canonicalOrder: 2, mode: "both", requiredOnCreate: true },
			{ kind: "typed", name: "templateId", type: "UUID", canonicalOrder: 28, tier: "advanced", mode: "create" },
			{ kind: "typed", name: "useDefaultTemplate", type: "Boolean", canonicalOrder: 29, tier: "advanced", mode: "create" },
			{ kind: "typed", name: "canceledAt", type: "NullableDateTime", canonicalOrder: 21, tier: "advanced", mode: "update" },
			{ kind: "typed", name: "completedAt", type: "NullableDateTime", canonicalOrder: 22, tier: "advanced", mode: "update" },
			{ kind: "typed", name: "frequencyResolution", type: "FrequencyResolutionType", canonicalOrder: 31, tier: "advanced", mode: "update" },
			{ kind: "typed", name: "projectUpdateRemindersPausedUntilAt", type: "NullableDateTime", canonicalOrder: 23, tier: "advanced", mode: "update" },
			{ kind: "typed", name: "slackIssueComments", type: "Boolean", canonicalOrder: 24, tier: "advanced", mode: "update" },
			{ kind: "typed", name: "slackIssueStatuses", type: "Boolean", canonicalOrder: 25, tier: "advanced", mode: "update" },
			{ kind: "typed", name: "slackNewIssue", type: "Boolean", canonicalOrder: 26, tier: "advanced", mode: "update" },
			{ kind: "compatibility", name: "trashed", mode: "update" },
			{ kind: "typed", name: "updateReminderFrequency", type: "Float", canonicalOrder: 32, tier: "advanced", mode: "update" },
			{ kind: "typed", name: "updateReminderFrequencyInWeeks", type: "Float", canonicalOrder: 33, tier: "advanced", mode: "update" },
			{ kind: "typed", name: "updateRemindersDay", type: "Day", canonicalOrder: 34, tier: "advanced", mode: "update" },
			{ kind: "typed", name: "updateRemindersHour", type: "Float", canonicalOrder: 35, tier: "advanced", mode: "update" },
			{ kind: "typed", name: "slackChannelName", type: "String", canonicalOrder: 27, tier: "advanced", mode: "create" },
		],
	},
	semanticException: "save-value-types",
	domain: "projects",
	entity: "Project",
	noun: "project",
	entityKind: "project",
	documentName: "Project",
	selection: projection("project", "detail"),
	createRoot: "projectCreate",
	updateRoot: "projectUpdate",
	createType: "ProjectCreateInput",
	updateType: "ProjectUpdateInput",
	example: { name: "Platform", teamIds: ["AEO"] },
}),
];
