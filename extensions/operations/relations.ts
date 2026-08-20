import { resolveIssueReference } from "../client";
import { projection } from "../selections";
import {
	mergedInput,
	p,
} from "../operation-types";
import type {
	LinearOperation,
	OperationSource,
	OperationDefinition,
} from "../operation-types";
import { defineOperation } from "../operation-definition";
import {
	input,
	issueTarget,
	issueReference,
	workspaceEmpty,
	listOperation,
	simpleMutation,
} from "./shared";

export const issueRelations: readonly OperationDefinition[] = ([
	listOperation({
		name: "list_issue_relations",
		compatibilityBranches: [
			{
				"all": []
			}
		],
		renderEmpty: workspaceEmpty("issue relations", "issue relation"),
		canonical: {
			"fields": {
				"after": "String",
				"before": "String",
				"first": "Int",
				"last": "Int",
				"includeArchived": "Boolean",
				"orderBy": "PaginationOrderBy"
			},
			"branches": [
				[]
			]
		},
		domain: "relations",
		root: "issueRelations",
		selection: projection("issueRelation", "list"),
		purpose: "List issue relations.",
		pageSize: 20,
	}),
	simpleMutation({
		name: "create_issue_relation",
		compatibilityBranches: [
			{
				"all": [
					"issue",
					"relatedIssue",
					"type"
				]
			},
			{
				"all": [
					"issueId",
					"relatedIssueId",
					"type"
				]
			},
			{
				"all": [
					"issueId",
					"relatedIssueId",
					"type"
				]
			}
		],
		renderTargetFields: [
			"issue",
			"relatedIssue"
		],
		canonical: {
			"fields": {
				"issue": "IssueReference",
				"relatedIssue": "IssueReference",
				"type": "IssueRelationType"
			},
			"branches": [
				[
					"issue",
					"relatedIssue",
					"type"
				]
			]
		},
		domain: "relations",
		purpose: "Create a relation between two issues.",
		root: "issueRelationCreate",
		inputType: "IssueRelationCreateInput",
		selection: `issueRelation { ${projection("issueRelation", "detail")} }`,
		parameters: [
			p("issue", "IssueReference", true),
			p("relatedIssue", "IssueReference", true),
			p("type", "IssueRelationType", true),
		],
		example: { issue: "AEO-258", relatedIssue: "AEO-259", type: "related" },
		aliases: ["create_relation"],
		legacyParameters: [
			[
				p("issueId", "String", true),
				p("relatedIssueId", "String", true),
				p("type", "IssueRelationType", true),
			],
		],
		aliasParameters: {
			create_relation: [
				p("issueId", "String", true),
				p("relatedIssueId", "String", true),
				p("type", "IssueRelationType", true),
			],
		},
		resolverPaths: {
			issue: "resolveIssueReference",
			relatedIssue: "resolveIssueReference",
		},
		async prepare(k, v, s) {
			const a = issueReference(v);
			const b = String(v.relatedIssue ?? v.relatedIssueId);
			const [x, y] = await Promise.all([
				resolveIssueReference(k, a, s),
				resolveIssueReference(k, b, s),
			]);
			return {
				variables: {
					input: { issueId: x.id, relatedIssueId: y.id, type: v.type },
				},
				resolution: {
					target: issueTarget(a, x),
					relatedTarget: issueTarget(b, y),
				},
			};
		},
	}),
	simpleMutation({
		name: "update_issue_relation",
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
				"type": "IssueRelationType",
				"issueId": "IssueReference",
				"relatedIssueId": "IssueReference"
			},
			"branches": [
				[
					"id",
					"type"
				],
				[
					"id",
					"issueId"
				],
				[
					"id",
					"relatedIssueId"
				]
			]
		},
		domain: "relations",
		purpose: "Update an issue relation.",
		root: "issueRelationUpdate",
		inputType: "IssueRelationUpdateInput",
		selection: `issueRelation { ${projection("issueRelation", "detail")} }`,
		parameters: [p("id", "String", true), input],
		acceptedParameters: [
			"id",
			"type",
			"issueId",
			"relatedIssueId",
			"input",
		].map((n) => p(n)),
		example: { id: "relation-id", type: "blocks" },
		idKey: "id",
		resolverPaths: {
			issueId: "resolveIssueReference",
			relatedIssueId: "resolveIssueReference",
		},
		async prepare(k, v, s) {
			const x = mergedInput(v, ["id"]);
			const resolution: Record<string, unknown> = {};
			for (const key of ["issueId", "relatedIssueId"])
				if (typeof x[key] === "string") {
					const issue = await resolveIssueReference(k, String(x[key]), s);
					resolution[key] = issueTarget(String(x[key]), issue);
					x[key] = issue.id;
				}
			if (!Object.keys(x).length)
				throw new Error("No update fields were provided.");
			return { variables: { id: v.id, input: x }, resolution };
		},
	}),
] satisfies OperationSource[]).map((operation) =>
	defineOperation(operation as LinearOperation),
);

export const projectRelations: readonly OperationDefinition[] = ([
	listOperation({
		name: "list_project_relations",
		compatibilityBranches: [
			{
				"all": []
			}
		],
		renderEmpty: workspaceEmpty("project relations", "project relation"),
		canonical: {
			"fields": {
				"after": "String",
				"before": "String",
				"first": "Int",
				"last": "Int",
				"includeArchived": "Boolean",
				"orderBy": "PaginationOrderBy"
			},
			"branches": [
				[]
			]
		},
		domain: "relations",
		root: "projectRelations",
		selection: projection("projectRelation", "list"),
		purpose: "List project relations.",
		pageSize: 20,
	}),
	simpleMutation({
		name: "create_project_relation",
		compatibilityBranches: [
			{
				"all": [
					"projectId",
					"relatedProjectId",
					"type",
					"anchorType",
					"relatedAnchorType"
				]
			}
		],
		canonical: {
			"fields": {
				"projectId": "String",
				"relatedProjectId": "String",
				"type": "String",
				"anchorType": "String",
				"relatedAnchorType": "String",
				"projectMilestoneId": "UUID",
				"relatedProjectMilestoneId": "UUID"
			},
			"branches": [
				[
					"projectId",
					"relatedProjectId",
					"type",
					"anchorType",
					"relatedAnchorType"
				]
			]
		},
		domain: "relations",
		purpose: "Create a relation between two projects.",
		root: "projectRelationCreate",
		inputType: "ProjectRelationCreateInput",
		selection: `projectRelation { ${projection("projectRelation", "detail")} }`,
		parameters: [
			p("projectId", "String", true),
			p("relatedProjectId", "String", true),
			p("type", "String", true),
			p("anchorType", "String", true),
			p("relatedAnchorType", "String", true),
		],
		acceptedParameters: [
			"projectId",
			"relatedProjectId",
			"type",
			"anchorType",
			"relatedAnchorType",
			"projectMilestoneId",
			"relatedProjectMilestoneId",
			"input",
		].map((n) => p(n)),
		example: {
			projectId: "project-id",
			relatedProjectId: "other-project-id",
			type: "related",
			anchorType: "project",
			relatedAnchorType: "project",
		},
	}),
	simpleMutation({
		name: "update_project_relation",
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
				"type": "String",
				"anchorType": "String",
				"relatedAnchorType": "String",
				"projectId": "UUID",
				"relatedProjectId": "UUID",
				"projectMilestoneId": "UUID",
				"relatedProjectMilestoneId": "UUID"
			},
			"branches": [
				[
					"id",
					"type"
				],
				[
					"id",
					"anchorType"
				],
				[
					"id",
					"relatedAnchorType"
				],
				[
					"id",
					"projectId"
				],
				[
					"id",
					"relatedProjectId"
				],
				[
					"id",
					"projectMilestoneId"
				],
				[
					"id",
					"relatedProjectMilestoneId"
				]
			]
		},
		domain: "relations",
		purpose: "Update a project relation.",
		root: "projectRelationUpdate",
		inputType: "ProjectRelationUpdateInput",
		selection: `projectRelation { ${projection("projectRelation", "detail")} }`,
		parameters: [p("id", "String", true), input],
		acceptedParameters: [
			"id",
			"type",
			"projectId",
			"relatedProjectId",
			"anchorType",
			"relatedAnchorType",
			"projectMilestoneId",
			"relatedProjectMilestoneId",
			"input",
		].map((n) => p(n)),
		example: { id: "relation-id", type: "related" },
		idKey: "id",
	}),
] satisfies OperationSource[]).map((operation) =>
	defineOperation(operation as LinearOperation),
);
