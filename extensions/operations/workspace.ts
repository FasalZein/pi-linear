import { switchWorkspace } from "../client";
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
	workspaceEmpty,
	listOperation,
} from "./shared";

export const issueStatuses: readonly OperationDefinition[] = ([
	listOperation({
		name: "list_issue_statuses",
		compatibilityBranches: [
			{
				"all": []
			}
		],
		renderKind: "issue_status",
		renderEmpty: workspaceEmpty("issue statuses", "issue status", false),
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
		domain: "workspace",
		root: "workflowStates",
		selection: projection("workflowState", "list"),
		purpose: "List issue workflow states.",
		pageSize: 50,
		filterType: "WorkflowStateFilter",
		aliases: ["list_workflow_states"],
	}),
] satisfies OperationSource[]).map((operation) =>
	defineOperation(operation as LinearOperation),
);

export const workspaceSwitch: readonly OperationDefinition[] = ([
	{
		name: "switch_workspace",
		resultCategory: "local",
		compatibilityBranches: [
			{
				"all": [
					"name"
				]
			}
		],
		renderKind: "workspace",
		canonical: {
			"fields": {
				"name": "String"
			},
			"branches": [
				[
					"name"
				]
			]
		},
		aliases: [],
		domain: "workspace",
		purpose: "Switch the active stored workspace without exposing credentials.",
		parameters: [p("name", "String", true)],
		example: { operation: "switch_workspace", variables: { name: "work" } },
		document: "query SwitchWorkspaceLocal { viewer { id } }",
		localResult: { requiredStringPaths: ["active"] },
		async executeLocal(v, _ctx, mode) {
			const updated = await switchWorkspace(String(v.name), mode);
			return { active: updated.activeWorkspace };
		},
	},
] satisfies OperationSource[]).map((operation) =>
	defineOperation(operation as LinearOperation),
);
