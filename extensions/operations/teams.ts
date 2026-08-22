import { resolveTeamReference } from "../client";
import { projection } from "../selections";
import { p } from "../operation-types";
import type {
	LinearOperation,
	OperationSource,
	OperationDefinition,
} from "../operation-types";
import { defineOperation } from "../operation-definition";
import {
	filter,
	getDocument,
	workspaceEmpty,
	listOperation,
} from "./shared";

export const teams: readonly OperationDefinition[] = ([
	listOperation({
		name: "list_teams",
		compatibilityBranches: [
			{
				"all": []
			}
		],
		renderEmpty: workspaceEmpty("teams", "team", false),
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
		domain: "teams",
		root: "teams",
		selection: projection("team", "list"),
		purpose: "List teams and workflow states.",
		pageSize: 50,
		filterType: "TeamFilter",
	}),
	{
		name: "get_team",
		resultCategory: "singular",
		compatibilityBranches: [
			{
				"all": [
					"team"
				]
			},
			{
				"all": [
					"teamId"
				]
			}
		],
		canonical: {
			"fields": {
				"team": "TeamReference"
			},
			"branches": [
				[
					"team"
				]
			]
		},
		aliases: [],
		domain: "teams",
		purpose: "Get a team by exact key or UUID.",
		parameters: [p("team", "TeamReference", true)],
		legacyParameters: [[p("teamId", "String", true)]],
		example: { operation: "get_team", variables: { team: "AEO" } },
		document: getDocument("GetTeam", "team", projection("team", "detail")),
		resolverPaths: { team: "resolveTeamReference" },
		async prepare(k, v, s, g) {
			const x = await resolveTeamReference(k, String(v.team ?? v.teamId), s, g);
			return {
				variables: { id: x.id },
				resolution: {
					target: {
						requested: v.team ?? v.teamId,
						resolvedId: x.id,
						key: x.key,
					},
				},
			};
		},
	},
] satisfies OperationSource[]).map((operation) =>
	defineOperation(operation as LinearOperation),
);
