import { projection } from "../selections";
import { pureMutationPlan, teamLookup } from "../operation-plan";
import {
	compactObject,
	mergeFilters,
	mergedInput,
	p,
	paginationVariables,
} from "../operation-types";
import type {
	LinearOperation,
	OperationSource,
	OperationDefinition,
} from "../operation-types";
import { defineOperation } from "../operation-definition";
import {
	pagination,
	input,
	filter,
	object,
	workspaceEmpty,
	listOperation,
	simpleMutation,
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
		compatibilityBranches: [
			{
				"all": []
			}
		],
		renderKind: "label",
		renderEmpty: workspaceEmpty("issue labels", "issue label"),
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
		domain: "labels",
		root: "issueLabels",
		selection: projection("issueLabel", "list"),
		purpose: "List issue labels.",
		pageSize: 50,
		filterType: "IssueLabelFilter",
		parameters: [p("team", "TeamReference")],
		acceptedParameters: [
			p("team"),
			p("teamId"),
			p("teamKey"),
			...pagination,
			filter,
		],
		resolverPaths: { team: "resolveTeamReference" },
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
		compatibilityBranches: [
			{
				"all": [],
				"atLeastOneOf": [
					"name",
					"input.name"
				]
			}
		],
		semanticException: "nested-name-type",
		renderKind: "label",
		canonical: {
			"fields": {
				"name": "String",
				"team": "TeamReference",
				"description": "String",
				"color": "Color",
				"isGroup": "Boolean",
				"parentId": "UUID",
				"retiredAt": "DateTime",
				"replaceTeamLabels": "Boolean",
				"id": "UUID"
			},
			"branches": [
				[
					"name"
				]
			]
		},
		domain: "labels",
		purpose: "Create an issue label.",
		root: "issueLabelCreate",
		inputType: "IssueLabelCreateInput",
		selection: `issueLabel { ${projection("issueLabel", "detail")} }`,
		document: createIssueLabelDocument,
		parameters: [p("name", "String", true), p("team", "TeamReference"), input],
		acceptedParameters: [
			"name",
			"color",
			"description",
			"id",
			"isGroup",
			"parentId",
			"retiredAt",
			"team",
			"teamId",
			"teamKey",
			"replaceTeamLabels",
			"input",
		].map((n) => p(n)),
		legacyParameters: [[p("input", "IssueLabelCreateInput", true)]],
		example: { name: "needs-review", color: "#ff0000" },
		validateVariables(variables) {
			if (
				variables.input &&
				typeof (variables.name ?? object(variables.input)?.name) !== "string"
			) {
				throw new Error("canonical fields or nested input require name");
			}
		},
		resolverPaths: { team: "resolveTeamReference" },
		plan(v) {
			const rawInput = object(v.input);
			const replaceTeamLabels = v.replaceTeamLabels ?? rawInput?.replaceTeamLabels;
			const input = mergedInput(v, ["team", "teamKey", "teamId", "replaceTeamLabels"]);
			delete input.replaceTeamLabels;
			const ref = v.team ?? v.teamKey ?? v.teamId ?? input.teamId;
			if (typeof input.name !== "string" || !input.name.trim()) throw new Error("Issue label name is required (name).");
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
		compatibilityBranches: [
			{
				"all": [
					"id"
				]
			}
		],
		renderKind: "label",
		canonical: {
			"fields": {
				"id": "String",
				"name": "String",
				"description": "String",
				"color": "Color",
				"isGroup": "Boolean",
				"parentId": "UUID",
				"retiredAt": "NullableDateTime",
				"replaceTeamLabels": "Boolean"
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
					"color"
				],
				[
					"id",
					"isGroup"
				],
				[
					"id",
					"parentId"
				],
				[
					"id",
					"retiredAt"
				],
				[
					"id",
					"replaceTeamLabels"
				]
			]
		},
		domain: "labels",
		purpose: "Update an issue label.",
		root: "issueLabelUpdate",
		inputType: "IssueLabelUpdateInput",
		selection: `issueLabel { ${projection("issueLabel", "detail")} }`,
		document: updateIssueLabelDocument,
		parameters: [p("id", "String", true), input],
		acceptedParameters: [
			"id",
			"name",
			"description",
			"color",
			"parentId",
			"isGroup",
			"retiredAt",
			"replaceTeamLabels",
			"input",
		].map((n) => p(n)),
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
	defineOperation(operation as LinearOperation),
);

export const projectLabels: readonly OperationDefinition[] = ([
	listOperation({
		name: "list_project_labels",
		compatibilityBranches: [
			{
				"all": []
			}
		],
		renderKind: "label",
		renderEmpty: workspaceEmpty("project labels", "project label"),
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
		domain: "labels",
		root: "projectLabels",
		selection: projection("projectLabel", "list"),
		purpose: "List project labels.",
		pageSize: 50,
		filterType: "ProjectLabelFilter",
	}),
	simpleMutation({
		name: "create_project_label",
		compatibilityBranches: [
			{
				"all": [],
				"atLeastOneOf": [
					"name",
					"input.name"
				]
			}
		],
		semanticException: "nested-name-type",
		renderKind: "label",
		canonical: {
			"fields": {
				"name": "String",
				"description": "String",
				"color": "Color",
				"isGroup": "Boolean",
				"parentId": "UUID",
				"retiredAt": "DateTime"
			},
			"branches": [
				[
					"name"
				]
			]
		},
		domain: "labels",
		purpose: "Create a project label.",
		root: "projectLabelCreate",
		inputType: "ProjectLabelCreateInput",
		selection: `projectLabel { ${projection("projectLabel", "detail")} }`,
		parameters: [p("name", "String", true), input],
		acceptedParameters: [
			"name",
			"description",
			"color",
			"parentId",
			"isGroup",
			"retiredAt",
			"input",
		].map((n) => p(n)),
		legacyParameters: [[p("input", "ProjectLabelCreateInput", true)]],
		example: { name: "Strategic" },
		validateVariables(variables) {
			if (
				variables.input &&
				typeof (variables.name ?? object(variables.input)?.name) !== "string"
			) {
				throw new Error("canonical fields or nested input require name");
			}
		},
	}),
	simpleMutation({
		name: "update_project_label",
		compatibilityBranches: [
			{
				"all": [
					"id"
				]
			}
		],
		renderKind: "label",
		canonical: {
			"fields": {
				"id": "String",
				"name": "String",
				"description": "String",
				"color": "Color",
				"isGroup": "Boolean",
				"parentId": "UUID",
				"retiredAt": "NullableDateTime"
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
					"color"
				],
				[
					"id",
					"isGroup"
				],
				[
					"id",
					"parentId"
				],
				[
					"id",
					"retiredAt"
				]
			]
		},
		domain: "labels",
		purpose: "Update a project label.",
		root: "projectLabelUpdate",
		inputType: "ProjectLabelUpdateInput",
		selection: `projectLabel { ${projection("projectLabel", "detail")} }`,
		parameters: [p("id", "String", true), input],
		acceptedParameters: [
			"id",
			"name",
			"description",
			"color",
			"parentId",
			"isGroup",
			"retiredAt",
			"input",
		].map((n) => p(n)),
		example: { id: "label-id", name: "Strategy" },
		idKey: "id",
	}),
] satisfies OperationSource[]).map((operation) =>
	defineOperation(operation as LinearOperation),
);
