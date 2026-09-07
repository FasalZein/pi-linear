import { projection } from "../selections";
import { pureMutationPlan, teamLookup } from "../operation-plan";
import {
	compactObject,
	isCompatibilityString,
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
	workspaceEmpty,
	listOperation,
	simpleMutation,
	operationParameterDecision,
} from "./shared";

const createIssueLabelDocument = `mutation CreateIssueLabel($input: IssueLabelCreateInput!, $replaceTeamLabels: Boolean) {
  issueLabelCreate(input: $input, replaceTeamLabels: $replaceTeamLabels) {
    success
    issueLabel { ${projection("issueLabel", "detail")} }
  }
}`;

const updateIssueLabelDocument = `mutation UpdateIssueLabel($id: String!, $input: IssueLabelUpdateInput!, $replaceTeamLabels: Boolean) {
  issueLabelUpdate(id: $id, input: $input, replaceTeamLabels: $replaceTeamLabels) {
    success
    issueLabel { ${projection("issueLabel", "detail")} }
  }
}`;

export const issueLabels: readonly OperationDefinition[] = ([
	listOperation({
		name: "list_issue_labels",
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
				renderKind: "label",
		renderEmpty: workspaceEmpty("issue labels", "issue label"),
				domain: "labels",
		root: "issueLabels",
		selection: projection("issueLabel", "list"),
		purpose: "List issue labels.",
		pageSize: 50,
		filterType: "IssueLabelFilter",
		plan: (v) => {
			const ref = v.team ?? v.teamKey ?? v.teamId;
			return {
				kind: "query",
				lookups: ref ? [teamLookup("team", String(ref))] : [],
				finish(resolved) {
					const team = resolved.team as { id: string; key: string } | undefined;
					return {
						variables: { ...paginationVariables(v, 50), filter: mergeFilters(object(v.filter), team ? { team: { id: { eq: team.id } } } : undefined) },
						resolution: team ? { team: { requested: ref, resolvedId: team.id, key: team.key } } : undefined,
					};
				},
			};
		},
	}),
	simpleMutation({
		name: "create_issue_label",
		...operationParameterDecision({
		fields: [
			{ name: "name", canonical: "String", canonicalBranches: [0], compatibilityRequirements: [{"branch":0,"kind":"atLeastOne","order":0},{"branch":0,"kind":"atLeastOne","order":1,"input":true}], card: { order: 0, required: true }, accepted: { order: 0 } },
			{ name: "team", canonical: "TeamReference", card: { order: 1 }, accepted: { order: 7 } },
			{ name: "description", canonical: "String", accepted: { order: 2 } },
			{ name: "color", canonical: "Color", accepted: { order: 1 } },
			{ name: "isGroup", canonical: "Boolean", accepted: { order: 4 } },
			{ name: "parentId", canonical: "UUID", accepted: { order: 5 } },
			{ name: "retiredAt", canonical: "DateTime", accepted: { order: 6 } },
			{ name: "replaceTeamLabels", canonical: "Boolean", accepted: { order: 10 } },
			{ name: "id", canonical: "UUID", accepted: { order: 3 } },
			{ name: "input", card: { order: 2, type: "Input" }, accepted: { order: 11 }, legacy: [{ order: 0, type: "IssueLabelCreateInput", required: true, branch: 0 }] },
			{ name: "teamId", accepted: { order: 8 } },
			{ name: "teamKey", accepted: { order: 9 } },
		],
		requirements: {
			canonicalBranches: 1,
			compatibilityBranches: [{}],
		},
	}),
				semanticException: "nested-name-type",
		renderKind: "label",
				domain: "labels",
		purpose: "Create an issue label.",
		root: "issueLabelCreate",
		inputType: "IssueLabelCreateInput",
		selection: `issueLabel { ${projection("issueLabel", "detail")} }`,
		document: createIssueLabelDocument,
								example: { name: "needs-review", color: "#ff0000" },
		validateVariables(variables) {
			if (
				variables.input &&
				!isCompatibilityString(variables.name ?? object(variables.input)?.name)
			) {
				throw new Error("canonical fields or nested input require name");
			}
		},
		plan(v) {
			const rawInput = object(v.input);
			const replaceTeamLabels = v.replaceTeamLabels ?? rawInput?.replaceTeamLabels;
			const input = mergedInput(v, ["team", "teamKey", "teamId", "replaceTeamLabels"]);
			delete input.replaceTeamLabels;
			const ref = v.team ?? v.teamKey ?? v.teamId ?? input.teamId;
			if (!isCompatibilityString(input.name) || !input.name.trim()) throw new Error("Issue label name is required (name).");
			return {
				kind: "mutation",
				lookups: ref ? [teamLookup("team", String(ref))] : [],
				finish(resolved) {
					const team = resolved.team as { id: string; key: string } | undefined;
					if (team) input.teamId = team.id;
					return {
						variables: compactObject({ input, replaceTeamLabels }),
						resolution: team ? { team: { requested: ref, resolvedId: team.id, key: team.key } } : undefined,
					};
				},
			};
		},
	}),
	simpleMutation({
		name: "update_issue_label",
		...operationParameterDecision({
		fields: [
			{ name: "id", canonical: "String", canonicalBranches: [0,1,2,3,4,5,6], compatibilityRequirements: [{"branch":0,"kind":"all","order":0}], card: { order: 0, required: true }, accepted: { order: 0 } },
			{ name: "name", canonical: "String", canonicalBranches: [0], accepted: { order: 1 } },
			{ name: "description", canonical: "String", canonicalBranches: [1], accepted: { order: 2 } },
			{ name: "color", canonical: "Color", canonicalBranches: [2], accepted: { order: 3 } },
			{ name: "isGroup", canonical: "Boolean", canonicalBranches: [3], accepted: { order: 5 } },
			{ name: "parentId", canonical: "UUID", canonicalBranches: [4], accepted: { order: 4 } },
			{ name: "retiredAt", canonical: "NullableDateTime", canonicalBranches: [5], accepted: { order: 6 } },
			{ name: "replaceTeamLabels", canonical: "Boolean", canonicalBranches: [6], accepted: { order: 7 } },
			{ name: "input", card: { order: 1, type: "Input" }, accepted: { order: 8 } },
		],
		requirements: {
			canonicalBranches: 7,
			compatibilityBranches: [{}],
		},
	}),
				renderKind: "label",
				domain: "labels",
		purpose: "Update an issue label.",
		root: "issueLabelUpdate",
		inputType: "IssueLabelUpdateInput",
		selection: `issueLabel { ${projection("issueLabel", "detail")} }`,
		document: updateIssueLabelDocument,
						example: { id: "label-id", name: "review" },
		idKey: "id",
		plan(v) {
			const rawInput = object(v.input);
			const replaceTeamLabels = v.replaceTeamLabels ?? rawInput?.replaceTeamLabels;
			const input = mergedInput(v, ["id", "replaceTeamLabels"]);
			delete input.replaceTeamLabels;
			if (!Object.keys(input).length) throw new Error("No update fields were provided.");
			return pureMutationPlan({ variables: compactObject({ id: v.id, input, replaceTeamLabels }) });
		},
	}),
] satisfies OperationSource[]).map((operation) =>
	defineOperation(operation),
);

export const projectLabels: readonly OperationDefinition[] = ([
	listOperation({
		name: "list_project_labels",
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
				renderKind: "label",
		renderEmpty: workspaceEmpty("project labels", "project label"),
				domain: "labels",
		root: "projectLabels",
		selection: projection("projectLabel", "list"),
		purpose: "List project labels.",
		pageSize: 50,
		filterType: "ProjectLabelFilter",
	}),
	simpleMutation({
		name: "create_project_label",
		...operationParameterDecision({
		fields: [
			{ name: "name", canonical: "String", canonicalBranches: [0], compatibilityRequirements: [{"branch":0,"kind":"atLeastOne","order":0},{"branch":0,"kind":"atLeastOne","order":1,"input":true}], card: { order: 0, required: true }, accepted: { order: 0 } },
			{ name: "description", canonical: "String", accepted: { order: 1 } },
			{ name: "color", canonical: "Color", accepted: { order: 2 } },
			{ name: "isGroup", canonical: "Boolean", accepted: { order: 4 } },
			{ name: "parentId", canonical: "UUID", accepted: { order: 3 } },
			{ name: "retiredAt", canonical: "DateTime", accepted: { order: 5 } },
			{ name: "input", card: { order: 1, type: "Input" }, accepted: { order: 6 }, legacy: [{ order: 0, type: "ProjectLabelCreateInput", required: true, branch: 0 }] },
		],
		requirements: {
			canonicalBranches: 1,
			compatibilityBranches: [{}],
		},
	}),
				semanticException: "nested-name-type",
		renderKind: "label",
				domain: "labels",
		purpose: "Create a project label.",
		root: "projectLabelCreate",
		inputType: "ProjectLabelCreateInput",
		selection: `projectLabel { ${projection("projectLabel", "detail")} }`,
								example: { name: "Strategic" },
		validateVariables(variables) {
			if (
				variables.input &&
				!isCompatibilityString(variables.name ?? object(variables.input)?.name)
			) {
				throw new Error("canonical fields or nested input require name");
			}
		},
	}),
	simpleMutation({
		name: "update_project_label",
		...operationParameterDecision({
		fields: [
			{ name: "id", canonical: "String", canonicalBranches: [0,1,2,3,4,5], compatibilityRequirements: [{"branch":0,"kind":"all","order":0}], card: { order: 0, required: true }, accepted: { order: 0 } },
			{ name: "name", canonical: "String", canonicalBranches: [0], accepted: { order: 1 } },
			{ name: "description", canonical: "String", canonicalBranches: [1], accepted: { order: 2 } },
			{ name: "color", canonical: "Color", canonicalBranches: [2], accepted: { order: 3 } },
			{ name: "isGroup", canonical: "Boolean", canonicalBranches: [3], accepted: { order: 5 } },
			{ name: "parentId", canonical: "UUID", canonicalBranches: [4], accepted: { order: 4 } },
			{ name: "retiredAt", canonical: "NullableDateTime", canonicalBranches: [5], accepted: { order: 6 } },
			{ name: "input", card: { order: 1, type: "Input" }, accepted: { order: 7 } },
		],
		requirements: {
			canonicalBranches: 6,
			compatibilityBranches: [{}],
		},
	}),
				renderKind: "label",
				domain: "labels",
		purpose: "Update a project label.",
		root: "projectLabelUpdate",
		inputType: "ProjectLabelUpdateInput",
		selection: `projectLabel { ${projection("projectLabel", "detail")} }`,
						example: { id: "label-id", name: "Strategy" },
		idKey: "id",
	}),
] satisfies OperationSource[]).map((operation) =>
	defineOperation(operation),
);
