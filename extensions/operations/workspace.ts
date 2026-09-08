import { credentialStore } from "../credential-store";
import { projection } from "../selections";
import type {
	OperationSource,
	OperationDefinition,
} from "../operation-types";
import { defineOperation } from "../operation-definition";
import {
	workspaceEmpty,
	listOperation,
	operationParameterDecision,
	pageParameterFields,
} from "./shared";

export const issueStatuses: readonly OperationDefinition[] = ([
	listOperation({
		name: "list_issue_statuses",
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
		fields: [
			{ name: "name", canonical: "String", canonicalBranches: [0], compatibilityRequirements: [{"branch":0,"kind":"all","order":0}], card: { order: 0, required: true } },
		],
		requirements: {
			canonicalBranches: 1,
			compatibilityBranches: [{}],
		},
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
