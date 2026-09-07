import { credentialStore } from "../credential-store";
import { projection } from "../selections";
import { p } from "../operation-types";
import type {
	OperationSource,
	OperationDefinition,
} from "../operation-types";
import { defineOperation } from "../operation-definition";
import {
	workspaceEmpty,
	listOperation,
	operationParameterDecision,
} from "./shared";

export const issueStatuses: readonly OperationDefinition[] = ([
	listOperation({
		name: "list_issue_statuses",
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
				renderKind: "issue_status",
		renderEmpty: workspaceEmpty("issue statuses", "issue status", false),
				domain: "workspace",
		root: "workflowStates",
		selection: projection("workflowState", "list"),
		purpose: "List issue workflow states.",
		pageSize: 50,
		filterType: "WorkflowStateFilter",
		aliases: ["list_workflow_states"],
	}),
] satisfies OperationSource[]).map((operation) =>
	defineOperation(operation),
);

export const workspaceSwitch: readonly OperationDefinition[] = ([
	{
		name: "switch_workspace",
		resultCategory: "local",
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
					"name": "String"
				},
				"branches": [
					[
						"name"
					]
				]
			},
			parameters: [p("name", "String", true)],
		}),
				renderKind: "workspace",
				aliases: [],
		domain: "workspace",
		purpose: "Switch the active stored workspace without exposing credentials.",
				example: { operation: "switch_workspace", variables: { name: "work" } },
		document: "query SwitchWorkspaceLocal { viewer { id } }",
		localResult: { requiredStringPaths: ["active"] },
		async executeLocal(v, _ctx, mode) {
			const updated = await credentialStore.change({ type: "switch", name: String(v.name) }, mode);
			return { active: updated.activeWorkspace };
		},
	},
] satisfies OperationSource[]).map((operation) =>
	defineOperation(operation),
);
