import { namedEntityLookup } from "../operation-plan";
import { projection } from "../selections";
import { p } from "../operation-types";
import type {
	OperationSource,
	OperationDefinition,
} from "../operation-types";
import { defineOperation } from "../operation-definition";
import {
	getDocument,
	workspaceEmpty,
	listOperation,
	addSaveOperation,
	operationParameterDecision,
} from "./shared";

export const milestoneReads: readonly OperationDefinition[] = ([
	listOperation({
		name: "list_milestones",
		...operationParameterDecision({
			compatibilityBranches: [
				{
					"all": []
				}
			],
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
		}),
				renderEmpty: workspaceEmpty("milestones", "milestone"),
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
		...operationParameterDecision({
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
			parameters: [p("milestone", "MilestoneReference", true)],
			legacyParameters: [[p("milestoneId", "String", true)]],
		}),
						aliases: [],
		domain: "milestones",
		purpose: "Get a milestone by exact name or UUID.",
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
	defineOperation(operation),
);

export const milestoneSaves: readonly OperationDefinition[] = [
addSaveOperation({
	name: "save_milestone",
	parameterDecision: {
		identity: { kind: "identity", name: "milestoneId", type: "MilestoneReference", canonicalOrder: 0 },
		fields: [
			{ kind: "typed", name: "description", type: "String", canonicalOrder: 3, mode: "both" },
			{ kind: "typed", name: "descriptionData", type: "JsonString", canonicalOrder: 4, mode: "both" },
			{ kind: "typed", name: "id", type: "UUID", canonicalOrder: 7, mode: "create" },
			{ kind: "typed", name: "name", type: "String", canonicalOrder: 1, mode: "both", requiredOnCreate: true, compatibilityCard: true, renderTarget: true },
			{ kind: "typed", name: "projectId", type: "ProjectReference", canonicalOrder: 2, mode: "both", requiredOnCreate: true, compatibilityCard: true, renderTarget: true },
			{ kind: "typed", name: "sortOrder", type: "Float", canonicalOrder: 6, mode: "both" },
			{ kind: "typed", name: "targetDate", type: "NullableDate", canonicalOrder: 5, mode: "both" },
		],
	},
	semanticException: "save-value-types",
	domain: "milestones",
	entity: "ProjectMilestone",
	noun: "milestone",
	entityKind: "projectMilestone",
	documentName: "Milestone",
	selection: projection("milestone", "detail"),
	createRoot: "projectMilestoneCreate",
	updateRoot: "projectMilestoneUpdate",
	createType: "ProjectMilestoneCreateInput",
	updateType: "ProjectMilestoneUpdateInput",
	resolverPaths: {
		milestoneId: "resolveNamedEntityReference",
		projectId: "resolveNamedEntityReference",
	},
	example: { name: "Beta", projectId: "project-id" },
}),
];
