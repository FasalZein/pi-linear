import { namedEntityLookup, pureQueryPlan, teamLookup } from "../operation-plan";
import { projection } from "../selections";
import {
	mergeFilters,
	mergedInput,
	paginationVariables,
} from "../operation-types";
import type {
	OperationSource,
	OperationDefinition,
} from "../operation-types";
import { defineOperation } from "../operation-definition";
import {
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
		fields: [
			{ name: "team", canonical: "TeamReference", card: { order: 0 }, accepted: { order: 0 } },
			{ name: "after", canonical: "String", accepted: { order: 3 } },
			{ name: "before", canonical: "String", accepted: { order: 4 } },
			{ name: "first", canonical: "Int", accepted: { order: 5, type: "Int" } },
			{ name: "last", canonical: "Int", accepted: { order: 6, type: "Int" } },
			{ name: "includeArchived", canonical: "Boolean", accepted: { order: 7, type: "Boolean" } },
			{ name: "orderBy", canonical: "PaginationOrderBy", accepted: { order: 8, type: "PaginationOrderBy" } },
			{ name: "filter", canonical: "Filter", accepted: { order: 9, type: "Filter" } },
			{ name: "teamId", accepted: { order: 1 } },
			{ name: "teamKey", accepted: { order: 2 } },
		],
		requirements: {
			canonicalBranches: 1,
			compatibilityBranches: [{}],
		},
	}),
				renderEmpty: workspaceEmpty("cycles", "cycle"),
				domain: "cycles",
		root: "cycles",
		selection: projection("cycle", "list"),
		purpose: "List cycles.",
		pageSize: 50,
		filterType: "CycleFilter",
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
		fields: [
			{ name: "cycle", canonical: "CycleReference", canonicalBranches: [0], compatibilityRequirements: [{"branch":0,"kind":"all","order":0}], card: { order: 0, required: true } },
			{ name: "id", compatibilityRequirements: [{"branch":1,"kind":"all","order":0}], legacy: [{ order: 0, required: true, branch: 0 }] },
		],
		requirements: {
			canonicalBranches: 1,
			compatibilityBranches: [{},{}],
		},
	}),
						aliases: [],
		domain: "cycles",
		purpose: "Get a cycle by exact name or UUID.",
						example: { operation: "get_cycle", variables: { cycle: "Cycle 12" } },
		document: getDocument("GetCycle", "cycle", projection("cycle", "detail")),
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
		fields: [
			{ name: "team", canonical: "TeamReference", canonicalBranches: [0], compatibilityRequirements: [{"branch":0,"kind":"all","order":0}], card: { order: 0, required: true }, accepted: { order: 0 } },
			{ name: "startsAt", canonical: "DateTime", canonicalBranches: [0], compatibilityRequirements: [{"branch":0,"kind":"all","order":1},{"branch":1,"kind":"all","order":1},{"branch":2,"kind":"all","order":1}], card: { order: 1, required: true }, accepted: { order: 3 }, legacy: [{ order: 1, type: "DateTime", required: true, branch: 0 }, { order: 1, type: "DateTime", required: true, branch: 1 }] },
			{ name: "endsAt", canonical: "DateTime", canonicalBranches: [0], compatibilityRequirements: [{"branch":0,"kind":"all","order":2},{"branch":1,"kind":"all","order":2},{"branch":2,"kind":"all","order":2}], card: { order: 2, required: true }, accepted: { order: 4 }, legacy: [{ order: 2, type: "DateTime", required: true, branch: 0 }, { order: 2, type: "DateTime", required: true, branch: 1 }] },
			{ name: "name", canonical: "String", accepted: { order: 1 }, legacy: [{ order: 3, branch: 0 }, { order: 3, branch: 1 }] },
			{ name: "description", canonical: "String", accepted: { order: 2 }, legacy: [{ order: 4, branch: 0 }, { order: 4, branch: 1 }] },
			{ name: "teamId", compatibilityRequirements: [{"branch":1,"kind":"all","order":0}], legacy: [{ order: 0, required: true, branch: 0 }] },
			{ name: "teamKey", compatibilityRequirements: [{"branch":2,"kind":"all","order":0}], legacy: [{ order: 0, required: true, branch: 1 }] },
		],
		requirements: {
			canonicalBranches: 1,
			compatibilityBranches: [{},{},{}],
		},
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
		fields: [
			{ name: "id", canonical: "String", canonicalBranches: [0,1,2,3,4], compatibilityRequirements: [{"branch":0,"kind":"all","order":0}], card: { order: 0, required: true } },
			{ name: "name", canonical: "String", canonicalBranches: [0], card: { order: 1 } },
			{ name: "description", canonical: "String", canonicalBranches: [1], card: { order: 2 } },
			{ name: "startsAt", canonical: "DateTime", canonicalBranches: [2], card: { order: 3, type: "String" } },
			{ name: "endsAt", canonical: "DateTime", canonicalBranches: [3], card: { order: 4, type: "String" } },
			{ name: "completedAt", canonical: "DateTime", canonicalBranches: [4], card: { order: 5, type: "String" } },
		],
		requirements: {
			canonicalBranches: 5,
			compatibilityBranches: [{}],
		},
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
