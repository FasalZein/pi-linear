import { namedEntityLookup, pureQueryPlan, teamLookup } from "../operation-plan";
import { projection } from "../selections";
import {
	mergeFilters,
	mergedInput,
	p,
	paginationVariables,
} from "../operation-types";
import type {
	OperationSource,
	OperationDefinition,
} from "../operation-types";
import { defineOperation } from "../operation-definition";
import {
	pagination,
	filter,
	object,
	isUuid,
	getDocument,
	workspaceEmpty,
	listOperation,
	simpleMutation,
	operationParameterDecision,
} from "./shared";

export const cycles: readonly OperationDefinition[] = ([
	listOperation({
		name: "list_cycles",
		...operationParameterDecision({
			compatibilityBranches: [
				{
					"all": []
				}
			],
			canonical: {
				"fields": {
					"team": "TeamReference",
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
			parameters: [p("team", "TeamReference")],
			acceptedParameters: [
				p("team"),
				p("teamId"),
				p("teamKey"),
				...pagination,
				filter,
			],
		}),
				renderEmpty: workspaceEmpty("cycles", "cycle"),
				domain: "cycles",
		root: "cycles",
		selection: projection("cycle", "list"),
		purpose: "List cycles.",
		pageSize: 50,
		filterType: "CycleFilter",
						resolverPaths: { team: "resolveTeamReference" },
		plan: (v) => {
			const ref = String(v.team ?? v.teamKey ?? v.teamId ?? "");
			const lookups = ref ? [teamLookup("team", ref)] : [];
			return {
				kind: "query",
				lookups,
				finish(resolved) {
					const team = resolved.team as { id: string } | undefined;
					return { variables: { ...paginationVariables(v, 50), filter: mergeFilters(object(v.filter), team ? { team: { id: { eq: team.id } } } : undefined) } };
				},
			};
		},
	}),
	{
		name: "get_cycle",
		resultCategory: "singular",
		...operationParameterDecision({
			compatibilityBranches: [
				{
					"all": [
						"cycle"
					]
				},
				{
					"all": [
						"id"
					]
				}
			],
			canonical: {
				"fields": {
					"cycle": "CycleReference"
				},
				"branches": [
					[
						"cycle"
					]
				]
			},
			parameters: [p("cycle", "CycleReference", true)],
			legacyParameters: [[p("id", "String", true)]],
		}),
						aliases: [],
		domain: "cycles",
		purpose: "Get a cycle by exact name or UUID.",
						example: { operation: "get_cycle", variables: { cycle: "Cycle 12" } },
		document: getDocument("GetCycle", "cycle", projection("cycle", "detail")),
		resolverPaths: { cycle: "resolveNamedEntityReference" },
		plan(v) {
			const requested = String(v.cycle ?? v.id);
			const reference = requested.trim();
			if (isUuid(reference)) {
				return pureQueryPlan({
					variables: { id: reference },
					exactNamed: { requested: reference, path: "cycle", kind: "cycle" },
					resolution: { target: { requested: reference } },
				});
			}
			return {
				kind: "query",
				lookups: [namedEntityLookup("cycle", "cycle", requested)],
				finish(resolved) {
					const x = resolved.cycle as { id: string; name: string };
					return { variables: { id: x.id }, resolution: { target: { requested: v.cycle, resolvedId: x.id, name: x.name } } };
				},
			};
		},
	},
	simpleMutation({
		name: "create_cycle",
		...operationParameterDecision({
			compatibilityBranches: [
				{
					"all": [
						"team",
						"startsAt",
						"endsAt"
					]
				},
				{
					"all": [
						"teamId",
						"startsAt",
						"endsAt"
					]
				},
				{
					"all": [
						"teamKey",
						"startsAt",
						"endsAt"
					]
				}
			],
			canonical: {
				"fields": {
					"team": "TeamReference",
					"startsAt": "DateTime",
					"endsAt": "DateTime",
					"name": "String",
					"description": "String"
				},
				"branches": [
					[
						"team",
						"startsAt",
						"endsAt"
					]
				]
			},
			parameters: [
				p("team", "TeamReference", true),
				p("startsAt", "DateTime", true),
				p("endsAt", "DateTime", true),
			],
			acceptedParameters: [
				"team",
				"name",
				"description",
				"startsAt",
				"endsAt",
			].map((n) => p(n)),
			legacyParameters: [
				[
					p("teamId", "String", true),
					p("startsAt", "DateTime", true),
					p("endsAt", "DateTime", true),
					p("name"),
					p("description"),
				],
				[
					p("teamKey", "String", true),
					p("startsAt", "DateTime", true),
					p("endsAt", "DateTime", true),
					p("name"),
					p("description"),
				],
			],
		}),
				renderTargetFields: [
			"team"
		],
				domain: "cycles",
		purpose: "Create a cycle.",
		root: "cycleCreate",
		inputType: "CycleCreateInput",
		selection: `cycle { ${projection("cycle", "detail")} }`,
								example: { team: "AEO", startsAt: "2026-08-17", endsAt: "2026-08-31" },
		resolverPaths: { team: "resolveTeamReference" },
		plan(v) {
			const teamRef = v.team ?? v.teamKey ?? v.teamId;
			return {
				kind: "mutation",
				lookups: [teamLookup("team", String(teamRef))],
				finish(resolved) {
					const team = resolved.team as { id: string; key: string };
					const input = mergedInput(v, ["team", "teamKey", "teamId"]);
					input.teamId = team.id;
					return { variables: { input }, resolution: { team: { requested: teamRef, resolvedId: team.id, key: team.key } } };
				},
			};
		},
	}),
	simpleMutation({
		name: "update_cycle",
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
					"startsAt": "DateTime",
					"endsAt": "DateTime",
					"completedAt": "DateTime"
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
						"startsAt"
					],
					[
						"id",
						"endsAt"
					],
					[
						"id",
						"completedAt"
					]
				]
			},
			parameters: [
				p("id", "String", true),
				p("name"),
				p("description"),
				p("startsAt"),
				p("endsAt"),
				p("completedAt"),
			],
		}),
						domain: "cycles",
		purpose: "Update a cycle.",
		root: "cycleUpdate",
		inputType: "CycleUpdateInput",
		selection: `cycle { ${projection("cycle", "detail")} }`,
				example: { id: "cycle-id", name: "Cycle 12" },
		idKey: "id",
	}),
] satisfies OperationSource[]).map((operation) =>
	defineOperation(operation),
);
