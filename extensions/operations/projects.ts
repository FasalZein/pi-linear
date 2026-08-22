import { isLinearUrlSlug } from "../client";
import { namedEntityLookup, pureQueryPlan } from "../operation-plan";
import { projection } from "../selections";
import { p } from "../operation-types";
import type {
	LinearOperation,
	OperationSource,
	OperationDefinition,
} from "../operation-types";
import { defineOperation } from "../operation-definition";
import {
	PROJECT_SORT_KEYS,
	input,
	filter,
	sort,
	isUuid,
	getDocument,
	workspaceEmpty,
	listOperation,
	addSaveOperation,
	withGetResultView,
} from "./shared";

export const projectReads: readonly OperationDefinition[] = ([
	listOperation({
		name: "list_projects",
		compatibilityBranches: [
			{
				"all": []
			}
		],
		renderEmpty: workspaceEmpty("projects", "project"),
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
		compatibilityBranches: [
			{
				"all": [
					"project"
				]
			},
			{
				"all": [
					"projectId"
				]
			}
		],
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
		document: getDocument("GetProject", "project", projection("project", "detail")),
		resolverPaths: { project: "resolveNamedEntityReference" },
		plan(v) {
			const requested = String(v.project ?? v.projectId);
			const reference = requested.trim();
			if (isUuid(reference) || isLinearUrlSlug(reference)) {
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
	defineOperation(operation as LinearOperation),
);

export const projectSaves: readonly OperationDefinition[] = [
addSaveOperation({
	name: "save_project",
	compatibilityBranches: [
		{
			"all": [
				"name"
			],
			"atLeastOneOf": [
				"teamIds",
				"input.teamIds"
			],
			"forbidden": [
				"projectId",
				"canceledAt",
				"input.canceledAt",
				"completedAt",
				"input.completedAt",
				"frequencyResolution",
				"input.frequencyResolution",
				"projectUpdateRemindersPausedUntilAt",
				"input.projectUpdateRemindersPausedUntilAt",
				"slackIssueComments",
				"input.slackIssueComments",
				"slackIssueStatuses",
				"input.slackIssueStatuses",
				"slackNewIssue",
				"input.slackNewIssue",
				"trashed",
				"input.trashed",
				"updateReminderFrequency",
				"input.updateReminderFrequency",
				"updateReminderFrequencyInWeeks",
				"input.updateReminderFrequencyInWeeks",
				"updateRemindersDay",
				"input.updateRemindersDay",
				"updateRemindersHour",
				"input.updateRemindersHour"
			],
			"mode": "create"
		},
		{
			"all": [
				"input.name"
			],
			"atLeastOneOf": [
				"teamIds",
				"input.teamIds"
			],
			"forbidden": [
				"projectId",
				"canceledAt",
				"input.canceledAt",
				"completedAt",
				"input.completedAt",
				"frequencyResolution",
				"input.frequencyResolution",
				"projectUpdateRemindersPausedUntilAt",
				"input.projectUpdateRemindersPausedUntilAt",
				"slackIssueComments",
				"input.slackIssueComments",
				"slackIssueStatuses",
				"input.slackIssueStatuses",
				"slackNewIssue",
				"input.slackNewIssue",
				"trashed",
				"input.trashed",
				"updateReminderFrequency",
				"input.updateReminderFrequency",
				"updateReminderFrequencyInWeeks",
				"input.updateReminderFrequencyInWeeks",
				"updateRemindersDay",
				"input.updateRemindersDay",
				"updateRemindersHour",
				"input.updateRemindersHour"
			],
			"mode": "create"
		},
		{
			"all": [
				"projectId"
			],
			"atLeastOneOf": [
				"name",
				"input.name",
				"description",
				"input.description",
				"content",
				"input.content",
				"color",
				"input.color",
				"icon",
				"input.icon",
				"convertedFromIssueId",
				"input.convertedFromIssueId",
				"labelIds",
				"input.labelIds",
				"lastAppliedTemplateId",
				"input.lastAppliedTemplateId",
				"leadId",
				"input.leadId",
				"leadTeamId",
				"input.leadTeamId",
				"memberIds",
				"input.memberIds",
				"priority",
				"input.priority",
				"prioritySortOrder",
				"input.prioritySortOrder",
				"sortOrder",
				"input.sortOrder",
				"startDate",
				"input.startDate",
				"startDateResolution",
				"input.startDateResolution",
				"statusId",
				"input.statusId",
				"targetDate",
				"input.targetDate",
				"targetDateResolution",
				"input.targetDateResolution",
				"teamIds",
				"input.teamIds",
				"canceledAt",
				"input.canceledAt",
				"completedAt",
				"input.completedAt",
				"frequencyResolution",
				"input.frequencyResolution",
				"projectUpdateRemindersPausedUntilAt",
				"input.projectUpdateRemindersPausedUntilAt",
				"slackIssueComments",
				"input.slackIssueComments",
				"slackIssueStatuses",
				"input.slackIssueStatuses",
				"slackNewIssue",
				"input.slackNewIssue",
				"trashed",
				"input.trashed",
				"updateReminderFrequency",
				"input.updateReminderFrequency",
				"updateReminderFrequencyInWeeks",
				"input.updateReminderFrequencyInWeeks",
				"updateRemindersDay",
				"input.updateRemindersDay",
				"updateRemindersHour",
				"input.updateRemindersHour"
			],
			"atLeastOneOfMessage": "No project update fields were provided.",
			"forbidden": [
				"id",
				"input.id",
				"templateId",
				"input.templateId",
				"useDefaultTemplate",
				"input.useDefaultTemplate",
				"slackChannelName",
				"input.slackChannelName"
			],
			"mode": "update"
		}
	],
	semanticException: "save-value-types",
	renderTargetFields: [
		"projectId",
		"name"
	],
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
	noun: "project",
	entityKind: "project",
	documentName: "Project",
	selection: projection("project", "detail"),
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
}),
];
