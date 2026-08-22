import { namedEntityLookup } from "../operation-plan";
import { projection } from "../selections";
import { p } from "../operation-types";
import type {
	LinearOperation,
	OperationSource,
	OperationDefinition,
} from "../operation-types";
import { defineOperation } from "../operation-definition";
import {
	input,
	filter,
	getDocument,
	workspaceEmpty,
	listOperation,
	addSaveOperation,
} from "./shared";

export const milestoneReads: readonly OperationDefinition[] = ([
	listOperation({
		name: "list_milestones",
		compatibilityBranches: [
			{
				"all": []
			}
		],
		renderEmpty: workspaceEmpty("milestones", "milestone"),
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
		selection: projection("milestone", "list"),
		purpose: "List project milestones.",
		pageSize: 20,
		filterType: "ProjectMilestoneFilter",
	}),
	{
		name: "get_milestone",
		resultCategory: "singular",
		compatibilityBranches: [
			{
				"all": [
					"milestone"
				]
			},
			{
				"all": [
					"milestoneId"
				]
			}
		],
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
			projection("milestone", "detail"),
		),
		resolverPaths: { milestone: "resolveNamedEntityReference" },
		plan(v) {
			const requested = String(v.milestone ?? v.milestoneId);
			return {
				kind: "query",
				lookups: [namedEntityLookup("milestone", "projectMilestone", requested)],
				finish: (resolved) => ({ variables: { id: (resolved.milestone as { id: string }).id } }),
			};
		},
	},
] satisfies OperationSource[]).map((operation) =>
	defineOperation(operation as LinearOperation),
);

export const milestoneSaves: readonly OperationDefinition[] = [
addSaveOperation({
	name: "save_milestone",
	compatibilityBranches: [
		{
			"all": [
				"name"
			],
			"atLeastOneOf": [
				"projectId",
				"input.projectId"
			],
			"forbidden": [
				"milestoneId"
			],
			"mode": "create"
		},
		{
			"all": [
				"input.name"
			],
			"atLeastOneOf": [
				"projectId",
				"input.projectId"
			],
			"forbidden": [
				"milestoneId"
			],
			"mode": "create"
		},
		{
			"all": [
				"milestoneId"
			],
			"atLeastOneOf": [
				"description",
				"input.description",
				"descriptionData",
				"input.descriptionData",
				"name",
				"input.name",
				"projectId",
				"input.projectId",
				"sortOrder",
				"input.sortOrder",
				"targetDate",
				"input.targetDate"
			],
			"atLeastOneOfMessage": "No milestone update fields were provided.",
			"forbidden": [
				"id",
				"input.id"
			],
			"mode": "update"
		}
	],
	semanticException: "save-value-types",
	renderTargetFields: [
		"milestoneId",
		"name",
		"projectId"
	],
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
	noun: "milestone",
	entityKind: "projectMilestone",
	documentName: "Milestone",
	selection: projection("milestone", "detail"),
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
}),
];
