import { projection } from "../selections";
import { pureMutationPlan, pureQueryPlan, teamLookup } from "../operation-plan";
import {
	mergedInput,
} from "../operation-types";
import type {
	OperationSource,
	OperationDefinition,
} from "../operation-types";
import { defineOperation } from "../operation-definition";
import {
	getDocument,
	workspaceEmpty,
	listOperation,
	simpleMutation,
	operationParameterDecision,
} from "./shared";

export const views: readonly OperationDefinition[] = ([
	listOperation({
		name: "list_views",
		...operationParameterDecision({
		fields: [
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
				renderEmpty: workspaceEmpty("views", "view"),
				domain: "views",
		root: "customViews",
		selection: projection("view", "list"),
		purpose: "List custom views.",
		pageSize: 50,
		filterType: "CustomViewFilter",
	}),
	{
		name: "get_view",
		resultCategory: "singular",
		...operationParameterDecision({
		fields: [
			{ name: "id", canonical: "String", canonicalBranches: [0], compatibilityRequirements: [{"branch":0,"kind":"all","order":0}], card: { order: 0, required: true } },
		],
		requirements: {
			canonicalBranches: 1,
			compatibilityBranches: [{}],
		},
	}),
						aliases: [],
		domain: "views",
		purpose: "Get a custom view.",
				example: { operation: "get_view", variables: { id: "view-id" } },
		document: getDocument("GetView", "customView", projection("view", "detail")),
		plan(v) {
			return pureQueryPlan({ variables: { id: v.id } });
		},
	},
	simpleMutation({
		name: "create_view",
		...operationParameterDecision({
		fields: [
			{ name: "name", canonical: "String", canonicalBranches: [0], compatibilityRequirements: [{"branch":0,"kind":"all","order":0}], card: { order: 0, required: true }, accepted: { order: 0, required: true } },
			{ name: "team", canonical: "TeamReference", card: { order: 5 }, accepted: { order: 5 } },
			{ name: "description", canonical: "String", accepted: { order: 8 } },
			{ name: "icon", canonical: "String", accepted: { order: 9 } },
			{ name: "color", canonical: "Color", accepted: { order: 10 } },
			{ name: "shared", canonical: "Boolean", accepted: { order: 11 } },
			{ name: "filterData", canonical: "FilterData", card: { order: 1, type: "Object" }, accepted: { order: 1 } },
			{ name: "projectFilterData", canonical: "FilterData", card: { order: 2, type: "Object" }, accepted: { order: 2 } },
			{ name: "initiativeFilterData", canonical: "FilterData", card: { order: 3, type: "Object" }, accepted: { order: 3 } },
			{ name: "feedItemFilterData", canonical: "FilterData", card: { order: 4, type: "Object" }, accepted: { order: 4 } },
			{ name: "teamId", accepted: { order: 6 } },
			{ name: "teamKey", accepted: { order: 7 } },
		],
		requirements: {
			canonicalBranches: 1,
			compatibilityBranches: [{}],
		},
	}),
						domain: "views",
		purpose:
			"Create a custom view using filterData, projectFilterData, initiativeFilterData, or feedItemFilterData.",
		root: "customViewCreate",
		inputType: "CustomViewCreateInput",
		selection: `customView { ${projection("view", "detail")} }`,
						example: { name: "My issues", filterData: {} },
		canonicalExample: { name: "My issues", filterData: { assignee: { isMe: { eq: true } } } },
		resolverPaths: {
			team: "resolveTeamReference",
			teamKey: "resolveTeamReference",
		},
		plan(v) {
			const input = mergedInput(v, ["team", "teamKey"]);
			const teamRef = v.team ?? v.teamKey ?? v.teamId;
			return {
				kind: "mutation",
				lookups: teamRef ? [teamLookup("team", String(teamRef))] : [],
				finish(resolved) {
					const team = resolved.team as { id: string; key: string } | undefined;
					if (team) input.teamId = team.id;
					return { variables: { input } };
				},
			};
		},
	}),
	simpleMutation({
		name: "update_view",
		...operationParameterDecision({
		fields: [
			{ name: "id", canonical: "String", canonicalBranches: [0,1,2,3,4,5,6,7,8], compatibilityRequirements: [{"branch":0,"kind":"all","order":0}], card: { order: 0, required: true }, accepted: { order: 0 } },
			{ name: "name", canonical: "String", canonicalBranches: [0], accepted: { order: 1 } },
			{ name: "description", canonical: "String", canonicalBranches: [1], accepted: { order: 6 } },
			{ name: "icon", canonical: "String", canonicalBranches: [2], accepted: { order: 7 } },
			{ name: "color", canonical: "Color", canonicalBranches: [3], accepted: { order: 8 } },
			{ name: "shared", canonical: "Boolean", canonicalBranches: [4], accepted: { order: 9 } },
			{ name: "filterData", canonical: "FilterData", canonicalBranches: [5], accepted: { order: 2 } },
			{ name: "projectFilterData", canonical: "FilterData", canonicalBranches: [6], accepted: { order: 3 } },
			{ name: "initiativeFilterData", canonical: "FilterData", canonicalBranches: [7], accepted: { order: 4 } },
			{ name: "feedItemFilterData", canonical: "FilterData", canonicalBranches: [8], accepted: { order: 5 } },
			{ name: "input", card: { order: 1, type: "Input" }, accepted: { order: 10 } },
		],
		requirements: {
			canonicalBranches: 9,
			compatibilityBranches: [{}],
		},
	}),
						domain: "views",
		purpose: "Update a custom view.",
		root: "customViewUpdate",
		inputType: "CustomViewUpdateInput",
		selection: `customView { ${projection("view", "detail")} }`,
						example: { id: "view-id", name: "New name" },
		idKey: "id",
	}),
	simpleMutation({
		name: "set_view_preferences",
		...operationParameterDecision({
		fields: [
			{ name: "viewId", canonical: "String", canonicalBranches: [0], compatibilityRequirements: [{"branch":0,"kind":"all","order":0}], card: { order: 0, required: true } },
			{ name: "preferences", canonical: "Preferences", canonicalBranches: [0], compatibilityRequirements: [{"branch":0,"kind":"all","order":1}], card: { order: 1, type: "Object", required: true } },
		],
		requirements: {
			canonicalBranches: 1,
			compatibilityBranches: [{}],
		},
	}),
				renderKind: "view",
				domain: "views",
		purpose: "Set preferences for a custom view.",
		root: "viewPreferencesCreate",
		inputType: "ViewPreferencesCreateInput",
		selection: "viewPreferences { id type viewType }",
				example: { viewId: "view-id", preferences: {} },
		canonicalExample: { viewId: "view-id", preferences: { showEmptyGroups: true } },
		plan(v) {
			return pureMutationPlan({ variables: { input: { type: "user", viewType: "customView", customViewId: v.viewId, preferences: v.preferences } } });
		},
	}),
] satisfies OperationSource[]).map((operation) =>
	defineOperation(operation),
);
