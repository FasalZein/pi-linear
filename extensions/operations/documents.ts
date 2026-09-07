import { projection } from "../selections";
import { documentLookup, issueLookup, namedEntityLookup, pureQueryPlan, teamLookup } from "../operation-plan";
import {
	isCompatibilityString,
	mergedInput,
} from "../operation-types";
import type {
	CompatibilityObject,
	OperationSource,
	OperationDefinition,
} from "../operation-types";
import { defineOperation } from "../operation-definition";
import {
	DOCUMENT_SORT_KEYS,
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
		fields: [
			{ name: "sort", canonical: "[DocumentSort!]" },
			{ name: "after", canonical: "String" },
			{ name: "before", canonical: "String" },
			{ name: "first", canonical: "Int" },
			{ name: "last", canonical: "Int" },
			{ name: "includeArchived", canonical: "Boolean" },
			{ name: "orderBy", canonical: "PaginationOrderBy" },
			{ name: "filter", canonical: "Filter" },
			{ name: "view", canonical: "ResultView" },
		],
		requirements: {
			canonicalBranches: 1,
			compatibilityBranches: [{}],
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
		fields: [
			{ name: "document", canonical: "DocumentReference", canonicalBranches: [0], compatibilityRequirements: [{"branch":0,"kind":"all","order":0}], card: { order: 0, required: true } },
			{ name: "view", canonical: "ResultView" },
			{ name: "documentId", compatibilityRequirements: [{"branch":1,"kind":"all","order":0}], legacy: [{ order: 0, required: true, branch: 0 }] },
		],
		requirements: {
			canonicalBranches: 1,
			compatibilityBranches: [{},{}],
		},
	}),
						aliases: [],
		domain: "documents",
		purpose: "Get a document by exact title, slug, or UUID.",
						example: {
			operation: "get_document",
			variables: { document: "Planning notes" },
		},
		document: getDocument("GetDocument", "document", projection("document", "detail")),
		resolverPaths: { document: "resolveNamedEntityReference" },
		plan(v) {
			const requested = String(v.document ?? v.documentId);
			const reference = requested.trim();
			if (isUuid(reference)) {
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
		fields: [
			{ name: "title", canonical: "String", canonicalBranches: [0], compatibilityRequirements: [{"branch":0,"kind":"atLeastOne","order":0},{"branch":0,"kind":"atLeastOne","order":1,"input":true}], card: { order: 0, required: true }, accepted: { order: 16 } },
			{ name: "content", canonical: "String", accepted: { order: 1 } },
			{ name: "icon", canonical: "String", accepted: { order: 3 } },
			{ name: "color", canonical: "Color", accepted: { order: 0 } },
			{ name: "issueId", canonical: "IssueReference", accepted: { order: 6 } },
			{ name: "teamId", canonical: "TeamReference", accepted: { order: 14 } },
			{ name: "projectId", canonical: "UUID", accepted: { order: 9 } },
			{ name: "initiativeId", canonical: "UUID", accepted: { order: 5 } },
			{ name: "cycleId", canonical: "UUID", accepted: { order: 2 } },
			{ name: "releaseId", canonical: "UUID", accepted: { order: 10 } },
			{ name: "resourceFolderId", canonical: "UUID", accepted: { order: 11 } },
			{ name: "lastAppliedTemplateId", canonical: "UUID", accepted: { order: 7 } },
			{ name: "ownerId", canonical: "UUID", accepted: { order: 8 } },
			{ name: "subscriberIds", canonical: "[UUID!]", accepted: { order: 13 } },
			{ name: "sortOrder", canonical: "Float", accepted: { order: 12 } },
			{ name: "id", canonical: "UUID", accepted: { order: 4 } },
			{ name: "input", card: { order: 1, type: "Input" }, accepted: { order: 17 }, legacy: [{ order: 0, type: "DocumentCreateInput", required: true, branch: 0 }] },
			{ name: "teamKey", accepted: { order: 15 } },
		],
		requirements: {
			canonicalBranches: 1,
			compatibilityBranches: [{}],
		},
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
		fields: [
			{ name: "document", canonical: "DocumentReference", canonicalBranches: [0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15] },
			{ name: "title", canonical: "String", canonicalBranches: [0], accepted: { order: 17 } },
			{ name: "content", canonical: "String", canonicalBranches: [1], accepted: { order: 2 } },
			{ name: "icon", canonical: "String", canonicalBranches: [2], accepted: { order: 5 } },
			{ name: "color", canonical: "Color", canonicalBranches: [3], accepted: { order: 1 } },
			{ name: "issueId", canonical: "IssueReference", canonicalBranches: [4], accepted: { order: 7 } },
			{ name: "teamId", canonical: "TeamReference", canonicalBranches: [5], accepted: { order: 15 } },
			{ name: "projectId", canonical: "UUID", canonicalBranches: [6], accepted: { order: 10 } },
			{ name: "initiativeId", canonical: "UUID", canonicalBranches: [7], accepted: { order: 6 } },
			{ name: "cycleId", canonical: "UUID", canonicalBranches: [8], accepted: { order: 3 } },
			{ name: "releaseId", canonical: "UUID", canonicalBranches: [9], accepted: { order: 11 } },
			{ name: "resourceFolderId", canonical: "UUID", canonicalBranches: [10], accepted: { order: 12 } },
			{ name: "lastAppliedTemplateId", canonical: "UUID", canonicalBranches: [11], accepted: { order: 8 } },
			{ name: "ownerId", canonical: "UUID", canonicalBranches: [12], accepted: { order: 9 } },
			{ name: "subscriberIds", canonical: "[UUID!]", canonicalBranches: [13], accepted: { order: 14 } },
			{ name: "sortOrder", canonical: "Float", canonicalBranches: [14], accepted: { order: 13 } },
			{ name: "hiddenAt", canonical: "NullableDateTime", canonicalBranches: [15], accepted: { order: 4 } },
			{ name: "documentId", compatibilityRequirements: [{"branch":0,"kind":"all","order":0}], card: { order: 0, type: "DocumentReference", required: true }, accepted: { order: 0 } },
			{ name: "input", card: { order: 1, type: "Input" }, accepted: { order: 19 } },
			{ name: "teamKey", accepted: { order: 16 } },
			{ name: "trashed", accepted: { order: 18 } },
		],
		requirements: {
			canonicalBranches: 16,
			compatibilityBranches: [{}],
		},
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
