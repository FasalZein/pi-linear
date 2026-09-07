import { teamLookup } from "../operation-plan";
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
	operationParameterDecision,
} from "./shared";

export const teams: readonly OperationDefinition[] = ([
	listOperation({
		name: "list_teams",
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
				renderEmpty: workspaceEmpty("teams", "team", false),
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
		...operationParameterDecision({
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
			parameters: [p("team", "TeamReference", true)],
			legacyParameters: [[p("teamId", "String", true)]],
		}),
						aliases: [],
		domain: "teams",
		purpose: "Get a team by exact key or UUID.",
						example: { operation: "get_team", variables: { team: "AEO" } },
		document: getDocument("GetTeam", "team", projection("team", "detail")),
		resolverPaths: { team: "resolveTeamReference" },
		plan(v) {
			const requested = String(v.team ?? v.teamId);
			return {
				kind: "query",
				lookups: [teamLookup("team", requested)],
				finish(resolved) {
					const x = resolved.team as { id: string; key: string };
					return {
						variables: { id: x.id },
						resolution: { target: { requested: v.team ?? v.teamId, resolvedId: x.id, key: x.key } },
					};
				},
			};
		},
	},
] satisfies OperationSource[]).map((operation) =>
	defineOperation(operation),
);
