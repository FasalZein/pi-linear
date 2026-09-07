import { isLinearUrlSlug } from "../client";
import { projection } from "../selections";
import { documentLookup, issueLookup, namedEntityLookup, pureQueryPlan, teamLookup } from "../operation-plan";
import {
	isCompatibilityString,
	mergedInput,
	p,
} from "../operation-types";
import type {
	CompatibilityObject,
	OperationSource,
	OperationDefinition,
} from "../operation-types";
import { defineOperation } from "../operation-definition";
import {
	DOCUMENT_SORT_KEYS,
	input,
	issueTarget,
	object,
	isUuid,
	getDocument,
	workspaceEmpty,
	listOperation,
	simpleMutation,
	withGetResultView,
	operationParameterDecision,
} from "./shared";

export const documents: readonly OperationDefinition[] = ([
	listOperation({
		name: "list_documents",
		...operationParameterDecision({
			compatibilityBranches: [
				{
					"all": []
				}
			],
			canonical: {
				"fields": {
					"sort": "[DocumentSort!]",
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
				renderEmpty: workspaceEmpty("documents", "document"),
				domain: "documents",
		root: "documents",
		selection: projection("document", "list"),
		resultView: { entity: "document", defaultView: "summary" },
		purpose: "List documents.",
		pageSize: 20,
		filterType: "DocumentFilter",
		sortType: "DocumentSortInput",
		sortKeys: DOCUMENT_SORT_KEYS,
	}),
	withGetResultView({
		name: "get_document",
		...operationParameterDecision({
			compatibilityBranches: [
				{
					"all": [
						"document"
					]
				},
				{
					"all": [
						"documentId"
					]
				}
			],
			canonical: {
				"fields": {
					"document": "DocumentReference"
				},
				"branches": [
					[
						"document"
					]
				]
			},
			parameters: [p("document", "DocumentReference", true)],
			legacyParameters: [[p("documentId", "String", true)]],
		}),
						aliases: [],
		domain: "documents",
		purpose: "Get a document by exact title or UUID.",
						example: {
			operation: "get_document",
			variables: { document: "Planning notes" },
		},
		document: getDocument("GetDocument", "document", projection("document", "detail")),
		resolverPaths: { document: "resolveNamedEntityReference" },
		plan(v) {
			const requested = String(v.document ?? v.documentId);
			const reference = requested.trim();
			if (isUuid(reference) || isLinearUrlSlug(reference)) {
				return pureQueryPlan({
					variables: { id: reference },
					exactNamed: { requested: reference, path: "document", kind: "document" },
					resolution: { target: { requested: reference } },
				});
			}
			return {
				kind: "query",
				lookups: [namedEntityLookup("document", "document", requested)],
				finish: (resolved) => ({ variables: { id: (resolved.document as { id: string }).id } }),
			};
		},
	}, "document", "document", "GetDocument"),
	simpleMutation({
		name: "create_document",
		...operationParameterDecision({
			compatibilityBranches: [
				{
					"all": [],
					"atLeastOneOf": [
						"title",
						"input.title"
					]
				}
			],
			canonical: {
				"fields": {
					"title": "String",
					"content": "String",
					"icon": "String",
					"color": "Color",
					"issueId": "IssueReference",
					"teamId": "TeamReference",
					"projectId": "UUID",
					"initiativeId": "UUID",
					"cycleId": "UUID",
					"releaseId": "UUID",
					"resourceFolderId": "UUID",
					"lastAppliedTemplateId": "UUID",
					"ownerId": "UUID",
					"subscriberIds": "[UUID!]",
					"sortOrder": "Float",
					"id": "UUID"
				},
				"branches": [
					[
						"title"
					]
				]
			},
			parameters: [p("title", "String", true), input],
			acceptedParameters: [
				"color",
				"content",
				"cycleId",
				"icon",
				"id",
				"initiativeId",
				"issueId",
				"lastAppliedTemplateId",
				"ownerId",
				"projectId",
				"releaseId",
				"resourceFolderId",
				"sortOrder",
				"subscriberIds",
				"teamId",
				"teamKey",
				"title",
				"input",
			].map((n) => p(n)),
			legacyParameters: [[p("input", "DocumentCreateInput", true)]],
		}),
				semanticException: "nested-title-type",
				domain: "documents",
		purpose: "Create a document.",
		root: "documentCreate",
		inputType: "DocumentCreateInput",
		selection: `document { ${projection("document", "detail")} }`,
								example: { title: "Planning notes", content: "Notes" },
		validateVariables(variables) {
			if (
				variables.input &&
				!isCompatibilityString(variables.title ?? object(variables.input)?.title)
			) {
				throw new Error("canonical fields or nested input require title");
			}
		},
		resolverPaths: {
			issueId: "resolveIssueReference",
			teamKey: "resolveTeamReference",
			teamId: "resolveTeamReference",
		},
		plan(v) {
			const input = mergedInput(v, ["teamKey"]);
			const issueRef = isCompatibilityString(input.issueId) ? input.issueId : undefined;
			const related = ["cycleId", "initiativeId", "issueId", "projectId", "releaseId", "resourceFolderId"]
				.some((key) => isCompatibilityString(input[key]) && input[key]);
			const teamRef = related ? undefined : v.teamKey ?? input.teamId;
			return {
				kind: "mutation",
				lookups: [
					...(issueRef ? [issueLookup("issue", issueRef)] : []),
					...(teamRef ? [teamLookup("team", String(teamRef))] : []),
				],
				finish(resolved) {
					const issue = resolved.issue as import("../client").ResolvedIssue | undefined;
					const team = resolved.team as { id: string; key: string } | undefined;
					if (issue) input.issueId = issue.id;
					if (related) delete input.teamId;
					else if (team) input.teamId = team.id;
					if (!isCompatibilityString(input.title) || !input.title.trim()) throw new Error("Document title is required for documentCreate (title).");
					const resolution: CompatibilityObject = {};
					if (issue && issueRef) resolution.issue = issueTarget(issueRef, issue);
					if (team) resolution.team = { requested: teamRef, resolvedId: team.id, key: team.key };
					return {
						variables: { input },
						resolution,
					};
				},
			};
		},
	}),
	simpleMutation({
		name: "update_document",
		...operationParameterDecision({
			compatibilityBranches: [
				{
					"all": [
						"documentId"
					]
				}
			],
			canonical: {
				"fields": {
					"document": "DocumentReference",
					"title": "String",
					"content": "String",
					"icon": "String",
					"color": "Color",
					"issueId": "IssueReference",
					"teamId": "TeamReference",
					"projectId": "UUID",
					"initiativeId": "UUID",
					"cycleId": "UUID",
					"releaseId": "UUID",
					"resourceFolderId": "UUID",
					"lastAppliedTemplateId": "UUID",
					"ownerId": "UUID",
					"subscriberIds": "[UUID!]",
					"sortOrder": "Float",
					"hiddenAt": "NullableDateTime"
				},
				"branches": [
					[
						"document",
						"title"
					],
					[
						"document",
						"content"
					],
					[
						"document",
						"icon"
					],
					[
						"document",
						"color"
					],
					[
						"document",
						"issueId"
					],
					[
						"document",
						"teamId"
					],
					[
						"document",
						"projectId"
					],
					[
						"document",
						"initiativeId"
					],
					[
						"document",
						"cycleId"
					],
					[
						"document",
						"releaseId"
					],
					[
						"document",
						"resourceFolderId"
					],
					[
						"document",
						"lastAppliedTemplateId"
					],
					[
						"document",
						"ownerId"
					],
					[
						"document",
						"subscriberIds"
					],
					[
						"document",
						"sortOrder"
					],
					[
						"document",
						"hiddenAt"
					]
				]
			},
			parameters: [p("documentId", "DocumentReference", true), input],
			acceptedParameters: [
				"documentId",
				"color",
				"content",
				"cycleId",
				"hiddenAt",
				"icon",
				"initiativeId",
				"issueId",
				"lastAppliedTemplateId",
				"ownerId",
				"projectId",
				"releaseId",
				"resourceFolderId",
				"sortOrder",
				"subscriberIds",
				"teamId",
				"teamKey",
				"title",
				"trashed",
				"input",
			].map((n) => p(n)),
		}),
						renderTargetFields: ["document", "documentId"],
		domain: "documents",
		purpose: "Update a document.",
		root: "documentUpdate",
		inputType: "DocumentUpdateInput",
		selection: `document { ${projection("document", "detail")} }`,
						example: { documentId: "document-id", title: "Updated notes" },
		canonicalExample: { document: "document-id", title: "Updated notes" },
		idKey: "documentId",
		resolverPaths: {
			documentId: "resolveDocumentReference",
			issueId: "resolveIssueReference",
			teamKey: "resolveTeamReference",
			teamId: "resolveTeamReference",
		},
		plan(v) {
			const requested = String(v.document ?? v.documentId);
			const input = mergedInput(v, ["document", "documentId", "teamKey"]);
			const issueRef = isCompatibilityString(input.issueId) ? input.issueId : undefined;
			const related = ["cycleId", "initiativeId", "issueId", "projectId", "releaseId", "resourceFolderId"]
				.some((key) => isCompatibilityString(input[key]) && input[key]);
			const teamRef = related ? undefined : v.teamKey ?? input.teamId;
			return {
				kind: "mutation",
				lookups: [
					documentLookup("target", requested),
					...(issueRef ? [issueLookup("issue", issueRef)] : []),
					...(teamRef ? [teamLookup("team", String(teamRef))] : []),
				],
				finish(resolved) {
					const document = resolved.target as { id: string; name: string };
					const issue = resolved.issue as import("../client").ResolvedIssue | undefined;
					const team = resolved.team as { id: string; key: string } | undefined;
					if (issue) input.issueId = issue.id;
					if (related) delete input.teamId;
					else if (team) input.teamId = team.id;
					if (!Object.keys(input).length) throw new Error("No update fields were provided.");
					const resolution: CompatibilityObject = {
						target: { requested, resolvedId: document.id, title: document.name },
					};
					if (issue && issueRef) resolution.issue = issueTarget(issueRef, issue);
					if (team) resolution.team = { requested: teamRef, resolvedId: team.id, key: team.key };
					return {
						variables: { id: document.id, input },
						resolution,
					};
				},
			};
		},
	}),
] satisfies OperationSource[]).map((operation) =>
	defineOperation(operation),
);
