import { namedEntityLookup } from "../operation-plan";
import { projection } from "../selections";
import type {
	OperationSource,
	OperationDefinition,
} from "../operation-types";
import { defineOperation } from "../operation-definition";
import {
	INITIATIVE_SORT_KEYS,
	getDocument,
	workspaceEmpty,
	listOperation,
	addSaveOperation,
	operationParameterDecision,
} from "./shared";

export const initiativeReads: readonly OperationDefinition[] = ([
	listOperation({
		name: "list_initiatives",
		...operationParameterDecision({
		fields: [
			{ name: "sort", canonical: "[InitiativeSort!]" },
			{ name: "after", canonical: "String" },
			{ name: "before", canonical: "String" },
			{ name: "first", canonical: "Int" },
			{ name: "last", canonical: "Int" },
			{ name: "includeArchived", canonical: "Boolean" },
			{ name: "orderBy", canonical: "PaginationOrderBy" },
			{ name: "filter", canonical: "Filter" },
		],
		requirements: {
			canonicalBranches: 1,
			compatibilityBranches: [{}],
		},
	}),
				renderEmpty: workspaceEmpty("initiatives", "initiative"),
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
		resultCategory: "singular",
		...operationParameterDecision({
		fields: [
			{ name: "initiative", canonical: "InitiativeReference", canonicalBranches: [0], compatibilityRequirements: [{"branch":0,"kind":"all","order":0}], card: { order: 0, required: true } },
			{ name: "initiativeId", compatibilityRequirements: [{"branch":1,"kind":"all","order":0}], legacy: [{ order: 0, required: true, branch: 0 }] },
		],
		requirements: {
			canonicalBranches: 1,
			compatibilityBranches: [{},{}],
		},
	}),
						aliases: [],
		domain: "initiatives",
		purpose: "Get an initiative by exact name or UUID.",
						example: {
			operation: "get_initiative",
			variables: { initiative: "Platform" },
		},
		document: getDocument("GetInitiative", "initiative", projection("initiative", "detail")),
		plan(v) {
			const requested = String(v.initiative ?? v.initiativeId);
			return {
				kind: "query",
				lookups: [namedEntityLookup("initiative", "initiative", requested)],
				finish: (resolved) => ({ variables: { id: (resolved.initiative as { id: string }).id } }),
			};
		},
	},
] satisfies OperationSource[]).map((operation) =>
	defineOperation(operation),
);

export const initiativeSaves: readonly OperationDefinition[] = [
addSaveOperation({
	name: "save_initiative",
	parameterDecision: {
		identity: { kind: "identity", name: "initiativeId", type: "InitiativeReference", canonicalOrder: 0 },
		fields: [
			{ kind: "typed", name: "color", type: "Color", canonicalOrder: 5, mode: "both" },
			{ kind: "typed", name: "content", type: "String", canonicalOrder: 3, mode: "both" },
			{ kind: "typed", name: "description", type: "String", canonicalOrder: 2, mode: "both" },
			{ kind: "typed", name: "icon", type: "String", canonicalOrder: 4, mode: "both" },
			{ kind: "typed", name: "id", type: "UUID", canonicalOrder: 15, tier: "advanced", mode: "create" },
			{ kind: "typed", name: "labelIds", type: "[UUID!]", canonicalOrder: 14, mode: "both" },
			{ kind: "typed", name: "leadTeamId", type: "UUID", canonicalOrder: 10, tier: "advanced", mode: "both" },
			{ kind: "typed", name: "name", type: "String", canonicalOrder: 1, mode: "both", requiredOnCreate: true, compatibilityCard: true, renderTarget: true },
			{ kind: "typed", name: "ownerId", type: "UUID", canonicalOrder: 9, mode: "both" },
			{ kind: "typed", name: "priority", type: "Priority", canonicalOrder: 13, mode: "both" },
			{ kind: "typed", name: "prioritySortOrder", type: "Float", canonicalOrder: 12, tier: "advanced", mode: "both" },
			{ kind: "typed", name: "sortOrder", type: "Float", canonicalOrder: 11, tier: "advanced", mode: "both" },
			{ kind: "typed", name: "status", type: "InitiativeStatus", canonicalOrder: 6, mode: "both" },
			{ kind: "typed", name: "targetDate", type: "NullableDate", canonicalOrder: 7, mode: "both" },
			{ kind: "typed", name: "targetDateResolution", type: "DateResolutionType", canonicalOrder: 8, tier: "advanced", mode: "both" },
			{ kind: "typed", name: "customIdentifier", type: "String", canonicalOrder: 16, tier: "advanced", mode: "update" },
			{ kind: "typed", name: "frequencyResolution", type: "FrequencyResolutionType", canonicalOrder: 17, tier: "advanced", mode: "update" },
			{ kind: "compatibility", name: "trashed", mode: "update" },
			{ kind: "typed", name: "updateReminderFrequency", type: "Float", canonicalOrder: 18, tier: "advanced", mode: "update" },
			{ kind: "typed", name: "updateReminderFrequencyInWeeks", type: "Float", canonicalOrder: 19, tier: "advanced", mode: "update" },
			{ kind: "typed", name: "updateRemindersDay", type: "Day", canonicalOrder: 20, tier: "advanced", mode: "update" },
			{ kind: "typed", name: "updateRemindersHour", type: "Float", canonicalOrder: 21, tier: "advanced", mode: "update" },
		],
	},
	semanticException: "save-value-types",
	domain: "initiatives",
	entity: "Initiative",
	noun: "initiative",
	entityKind: "initiative",
	documentName: "Initiative",
	selection: projection("initiative", "detail"),
	createRoot: "initiativeCreate",
	updateRoot: "initiativeUpdate",
	createType: "InitiativeCreateInput",
	updateType: "InitiativeUpdateInput",
	example: { name: "Platform" },
}),
];
