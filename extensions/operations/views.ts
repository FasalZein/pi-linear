import { projection } from "../selections";
import { pureMutationPlan, pureQueryPlan, teamLookup } from "../operation-plan";
import {
	mergedInput,
	p,
} from "../operation-types";
import type {
	OperationSource,
	OperationDefinition,
} from "../operation-types";
import { defineOperation } from "../operation-definition";
import {
	input,
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
			compatibilityBranches: [
				{
					"all": [
						"id"
					]
				}
			],
			canonical: {
				"fields": {
					"id": "String"
				},
				"branches": [
					[
						"id"
					]
				]
			},
			parameters: [p("id", "String", true)],
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
			compatibilityBranches: [
				{
					"all": [
						"name"
					]
				}
			],
			canonical: {
				"fields": {
					"name": "String",
					"team": "TeamReference",
					"description": "String",
					"icon": "String",
					"color": "Color",
					"shared": "Boolean",
					"filterData": "FilterData",
					"projectFilterData": "FilterData",
					"initiativeFilterData": "FilterData",
					"feedItemFilterData": "FilterData"
				},
				"branches": [
					[
						"name"
					]
				]
			},
			parameters: [
				p("name", "String", true),
				p("filterData", "Object"),
				p("projectFilterData", "Object"),
				p("initiativeFilterData", "Object"),
				p("feedItemFilterData", "Object"),
				p("team", "TeamReference"),
			],
			acceptedParameters: [
				p("name", "String", true),
				...[
					"filterData",
					"projectFilterData",
					"initiativeFilterData",
					"feedItemFilterData",
					"team",
					"teamId",
					"teamKey",
					"description",
					"icon",
					"color",
					"shared",
				].map((n) => p(n)),
			],
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
			compatibilityBranches: [
				{
					"all": [
						"id"
					]
				}
			],
			canonical: {
				"fields": {
					"id": "String",
					"name": "String",
					"description": "String",
					"icon": "String",
					"color": "Color",
					"shared": "Boolean",
					"filterData": "FilterData",
					"projectFilterData": "FilterData",
					"initiativeFilterData": "FilterData",
					"feedItemFilterData": "FilterData"
				},
				"branches": [
					[
						"id",
						"name"
					],
					[
						"id",
						"description"
					],
					[
						"id",
						"icon"
					],
					[
						"id",
						"color"
					],
					[
						"id",
						"shared"
					],
					[
						"id",
						"filterData"
					],
					[
						"id",
						"projectFilterData"
					],
					[
						"id",
						"initiativeFilterData"
					],
					[
						"id",
						"feedItemFilterData"
					]
				]
			},
			parameters: [p("id", "String", true), input],
			acceptedParameters: [
				"id",
				"name",
				"filterData",
				"projectFilterData",
				"initiativeFilterData",
				"feedItemFilterData",
				"description",
				"icon",
				"color",
				"shared",
				"input",
			].map((n) => p(n)),
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
			compatibilityBranches: [
				{
					"all": [
						"viewId",
						"preferences"
					]
				}
			],
			canonical: {
				"fields": {
					"viewId": "String",
					"preferences": "Preferences"
				},
				"branches": [
					[
						"viewId",
						"preferences"
					]
				]
			},
			parameters: [p("viewId", "String", true), p("preferences", "Object", true)],
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
