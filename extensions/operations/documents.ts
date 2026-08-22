import {
	isLinearUrlSlug,
	resolveDocumentReference,
	resolveIssueReference,
	resolveTeamReference,
} from "../client";
import { projection } from "../selections";
import { documentLookup, issueLookup, namedEntityLookup, pureQueryPlan, teamLookup } from "../operation-plan";
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
	DOCUMENT_SORT_KEYS,
	input,
	filter,
	sort,
	issueTarget,
	object,
	isUuid,
	getDocument,
	workspaceEmpty,
	listOperation,
	simpleMutation,
	withGetResultView,
} from "./shared";

export const documents: readonly OperationDefinition[] = ([
	listOperation({
		name: "list_documents",
		compatibilityBranches: [
			{
				"all": []
			}
		],
		renderEmpty: workspaceEmpty("documents", "document"),
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
		aliases: [],
		domain: "documents",
		purpose: "Get a document by exact title or UUID.",
		parameters: [p("document", "DocumentReference", true)],
		legacyParameters: [[p("documentId", "String", true)]],
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
		compatibilityBranches: [
			{
				"all": [],
				"atLeastOneOf": [
					"title",
					"input.title"
				]
			}
		],
		semanticException: "nested-title-type",
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
		domain: "documents",
		purpose: "Create a document.",
		root: "documentCreate",
		inputType: "DocumentCreateInput",
		selection: `document { ${projection("document", "detail")} }`,
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
		example: { title: "Planning notes", content: "Notes" },
		validateVariables(variables) {
			if (
				variables.input &&
				typeof (variables.title ?? object(variables.input)?.title) !== "string"
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
			const issueRef = typeof input.issueId === "string" ? input.issueId : undefined;
			const related = ["cycleId", "initiativeId", "issueId", "projectId", "releaseId", "resourceFolderId"]
				.some((key) => typeof input[key] === "string" && input[key]);
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
					if (typeof input.title !== "string" || !input.title.trim()) throw new Error("Document title is required for documentCreate (title).");
					return {
						variables: { input },
						resolution: {
							...(issue && issueRef ? { issue: issueTarget(issueRef, issue) } : {}),
							...(team ? { team: { requested: teamRef, resolvedId: team.id, key: team.key } } : {}),
						},
					};
				},
			};
		},
		async prepare(k, v, s, g) {
			const x = mergedInput(v, ["teamKey"]);
			const resolution: Record<string, unknown> = {};
			if (typeof x.issueId === "string") {
				const issue = await resolveIssueReference(k, x.issueId, s, g);
				resolution.issue = issueTarget(x.issueId, issue);
				x.issueId = issue.id;
			}
			const related = [
				"cycleId",
				"initiativeId",
				"issueId",
				"projectId",
				"releaseId",
				"resourceFolderId",
			].some((key) => typeof x[key] === "string" && x[key]);
			const teamRef = v.teamKey ?? x.teamId;
			if (related) delete x.teamId;
			else if (teamRef) {
				const team = await resolveTeamReference(k, String(teamRef), s, g);
				resolution.team = {
					requested: teamRef,
					resolvedId: team.id,
					key: team.key,
				};
				x.teamId = team.id;
			}
			if (typeof x.title !== "string" || !x.title.trim())
				throw new Error(
					"Document title is required for documentCreate (title).",
				);
			return { variables: { input: x }, resolution };
		},
	}),
	simpleMutation({
		name: "update_document",
		compatibilityBranches: [
			{
				"all": [
					"documentId"
				]
			}
		],
		canonical: {
			"fields": {
				"documentId": "DocumentReference",
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
					"documentId",
					"title"
				],
				[
					"documentId",
					"content"
				],
				[
					"documentId",
					"icon"
				],
				[
					"documentId",
					"color"
				],
				[
					"documentId",
					"issueId"
				],
				[
					"documentId",
					"teamId"
				],
				[
					"documentId",
					"projectId"
				],
				[
					"documentId",
					"initiativeId"
				],
				[
					"documentId",
					"cycleId"
				],
				[
					"documentId",
					"releaseId"
				],
				[
					"documentId",
					"resourceFolderId"
				],
				[
					"documentId",
					"lastAppliedTemplateId"
				],
				[
					"documentId",
					"ownerId"
				],
				[
					"documentId",
					"subscriberIds"
				],
				[
					"documentId",
					"sortOrder"
				],
				[
					"documentId",
					"hiddenAt"
				]
			]
		},
		domain: "documents",
		purpose: "Update a document.",
		root: "documentUpdate",
		inputType: "DocumentUpdateInput",
		selection: `document { ${projection("document", "detail")} }`,
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
		example: { documentId: "document-id", title: "Updated notes" },
		idKey: "documentId",
		resolverPaths: {
			documentId: "resolveDocumentReference",
			issueId: "resolveIssueReference",
			teamKey: "resolveTeamReference",
			teamId: "resolveTeamReference",
		},
		plan(v) {
			const requested = String(v.documentId);
			const input = mergedInput(v, ["documentId", "teamKey"]);
			const issueRef = typeof input.issueId === "string" ? input.issueId : undefined;
			const related = ["cycleId", "initiativeId", "issueId", "projectId", "releaseId", "resourceFolderId"]
				.some((key) => typeof input[key] === "string" && input[key]);
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
					return {
						variables: { id: document.id, input },
						resolution: {
							target: { requested, resolvedId: document.id, title: document.name },
							...(issue && issueRef ? { issue: issueTarget(issueRef, issue) } : {}),
							...(team ? { team: { requested: teamRef, resolvedId: team.id, key: team.key } } : {}),
						},
					};
				},
			};
		},
		async prepare(k, v, s, g) {
			const requested = String(v.documentId);
			const document = await resolveDocumentReference(k, requested, s, g);
			const x = mergedInput(v, ["documentId", "teamKey"]);
			const resolution: Record<string, unknown> = {
				target: { requested, resolvedId: document.id, title: document.title },
			};
			if (typeof x.issueId === "string") {
				const issue = await resolveIssueReference(k, x.issueId, s, g);
				resolution.issue = issueTarget(x.issueId, issue);
				x.issueId = issue.id;
			}
			const related = [
				"cycleId",
				"initiativeId",
				"issueId",
				"projectId",
				"releaseId",
				"resourceFolderId",
			].some((key) => typeof x[key] === "string" && x[key]);
			const teamRef = v.teamKey ?? x.teamId;
			if (related) delete x.teamId;
			else if (teamRef) {
				const team = await resolveTeamReference(k, String(teamRef), s, g);
				resolution.team = {
					requested: teamRef,
					resolvedId: team.id,
					key: team.key,
				};
				x.teamId = team.id;
			}
			if (!Object.keys(x).length)
				throw new Error("No update fields were provided.");
			return { variables: { id: document.id, input: x }, resolution };
		},
	}),
] satisfies OperationSource[]).map((operation) =>
	defineOperation(operation as LinearOperation),
);
