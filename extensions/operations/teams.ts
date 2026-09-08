import { teamLookup } from "../operation-plan";
import { projection } from "../selections";
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
	pageParameterFields,
} from "./shared";

export const teams: readonly OperationDefinition[] = ([
	listOperation({
		name: "list_teams",
		...operationParameterDecision({
		fields: [
			...pageParameterFields(),
			{ name: "filter", canonical: "Filter" },
		],
		requirements: {
			canonicalBranches: 1,
			compatibilityBranches: [{}],
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
		fields: [
			{ name: "team", canonical: "TeamReference", canonicalBranches: [0], compatibilityRequirements: [{"branch":0,"kind":"all","order":0}], card: { order: 0, required: true } },
			{ name: "teamId", compatibilityRequirements: [{"branch":1,"kind":"all","order":0}], legacy: [{ order: 0, required: true, branch: 0 }] },
		],
		requirements: {
			canonicalBranches: 1,
			compatibilityBranches: [{},{}],
		},
	}),
						aliases: [],
		domain: "teams",
		purpose: "Get a team by exact key or UUID.",
						example: { operation: "get_team", variables: { team: "AEO" } },
		document: getDocument("GetTeam", "team", projection("team", "detail")),
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
