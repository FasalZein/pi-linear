import { resolveTeamReference } from "../client";
import { projection } from "../selections";
import { pureMutationPlan, pureQueryPlan, teamLookup } from "../operation-plan";
import {
	mergedInput,
	p,
} from "../operation-types";
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
	simpleMutation,
} from "./shared";

export const views: readonly OperationDefinition[] = ([
	listOperation({
		name: "list_views",
		compatibilityBranches: [
			{
				"all": []
			}
		],
		renderEmpty: workspaceEmpty("views", "view"),
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
		aliases: [],
		domain: "views",
		purpose: "Get a custom view.",
		parameters: [p("id", "String", true)],
		example: { operation: "get_view", variables: { id: "view-id" } },
		document: getDocument("GetView", "customView", projection("view", "detail")),
		plan(v) {
			return pureQueryPlan({ variables: { id: v.id } });
		},
	},
	simpleMutation({
		name: "create_view",
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
		domain: "views",
		purpose:
			"Create a custom view using filterData, projectFilterData, initiativeFilterData, or feedItemFilterData.",
		root: "customViewCreate",
		inputType: "CustomViewCreateInput",
		selection: `customView { ${projection("view", "detail")} }`,
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
		example: { name: "My issues", filterData: {} },
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
					return { variables: { input }, resolution: team ? { team: { requested: teamRef, resolvedId: team.id, key: team.key } } : undefined };
				},
			};
		},
		async prepare(apiKey, v, signal, graphql) {
			const x = mergedInput(v, ["team", "teamKey"]);
			const ref = String(v.team ?? v.teamKey ?? v.teamId ?? "");
			if (ref) x.teamId = (await resolveTeamReference(apiKey, ref, signal, graphql)).id;
			return { variables: { input: x } };
		},
	}),
	simpleMutation({
		name: "update_view",
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
		domain: "views",
		purpose: "Update a custom view.",
		root: "customViewUpdate",
		inputType: "CustomViewUpdateInput",
		selection: `customView { ${projection("view", "detail")} }`,
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
		example: { id: "view-id", name: "New name" },
		idKey: "id",
	}),
	simpleMutation({
		name: "set_view_preferences",
		compatibilityBranches: [
			{
				"all": [
					"viewId",
					"preferences"
				]
			}
		],
		renderKind: "view",
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
		domain: "views",
		purpose: "Set preferences for a custom view.",
		root: "viewPreferencesCreate",
		inputType: "ViewPreferencesCreateInput",
		selection: "viewPreferences { id type viewType }",
		parameters: [p("viewId", "String", true), p("preferences", "Object", true)],
		example: { viewId: "view-id", preferences: {} },
		plan(v) {
			return pureMutationPlan({ variables: { input: { type: "user", viewType: "customView", customViewId: v.viewId, preferences: v.preferences } } });
		},
		async prepare(_k, v) {
			return {
				variables: {
					input: {
						type: "user",
						viewType: "customView",
						customViewId: v.viewId,
						preferences: v.preferences,
					},
				},
			};
		},
	}),
] satisfies OperationSource[]).map((operation) =>
	defineOperation(operation as LinearOperation),
);
