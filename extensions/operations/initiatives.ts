import { resolveNamedEntityReference } from "../client";
import { projection } from "../selections";
import { p } from "../operation-types";
import type {
	LinearOperation,
	OperationSource,
	OperationDefinition,
} from "../operation-types";
import { defineOperation } from "../operation-definition";
import {
	INITIATIVE_SORT_KEYS,
	input,
	filter,
	sort,
	getDocument,
	workspaceEmpty,
	listOperation,
	addSaveOperation,
} from "./shared";

export const initiativeReads: readonly OperationDefinition[] = ([
	listOperation({
		name: "list_initiatives",
		compatibilityBranches: [
			{
				"all": []
			}
		],
		renderEmpty: workspaceEmpty("initiatives", "initiative"),
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
		selection: projection("initiative", "list"),
		purpose: "List initiatives.",
		pageSize: 20,
		filterType: "InitiativeFilter",
		sortType: "InitiativeSortInput",
		sortKeys: INITIATIVE_SORT_KEYS,
	}),
	{
		name: "get_initiative",
		compatibilityBranches: [
			{
				"all": [
					"initiative"
				]
			},
			{
				"all": [
					"initiativeId"
				]
			}
		],
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
		document: getDocument("GetInitiative", "initiative", projection("initiative", "detail")),
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
] satisfies OperationSource[]).map((operation) =>
	defineOperation(operation as LinearOperation),
);

export const initiativeSaves: readonly OperationDefinition[] = [
addSaveOperation({
	name: "save_initiative",
	compatibilityBranches: [
		{
			"all": [
				"name"
			],
			"forbidden": [
				"initiativeId",
				"customIdentifier",
				"input.customIdentifier",
				"frequencyResolution",
				"input.frequencyResolution",
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
			"forbidden": [
				"initiativeId",
				"customIdentifier",
				"input.customIdentifier",
				"frequencyResolution",
				"input.frequencyResolution",
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
				"initiativeId"
			],
			"atLeastOneOf": [
				"color",
				"input.color",
				"content",
				"input.content",
				"description",
				"input.description",
				"icon",
				"input.icon",
				"labelIds",
				"input.labelIds",
				"leadTeamId",
				"input.leadTeamId",
				"name",
				"input.name",
				"ownerId",
				"input.ownerId",
				"priority",
				"input.priority",
				"prioritySortOrder",
				"input.prioritySortOrder",
				"sortOrder",
				"input.sortOrder",
				"status",
				"input.status",
				"targetDate",
				"input.targetDate",
				"targetDateResolution",
				"input.targetDateResolution",
				"customIdentifier",
				"input.customIdentifier",
				"frequencyResolution",
				"input.frequencyResolution",
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
			"atLeastOneOfMessage": "No initiative update fields were provided.",
			"forbidden": [
				"id",
				"input.id"
			],
			"mode": "update"
		}
	],
	semanticException: "save-value-types",
	renderTargetFields: [
		"initiativeId",
		"name"
	],
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
	noun: "initiative",
	entityKind: "initiative",
	documentName: "Initiative",
	selection: projection("initiative", "detail"),
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
}),
];
