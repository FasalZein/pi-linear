import { userLookup } from "../operation-plan";
import { projection } from "../selections";
import type {
	OperationSource,
	OperationDefinition,
} from "../operation-types";
import { defineOperation } from "../operation-definition";
import {
	USER_SORT_KEYS,
	getDocument,
	listPrepare,
	workspaceEmpty,
	listOperation,
	operationParameterDecision,
} from "./shared";

export const users: readonly OperationDefinition[] = ([
	listOperation({
		name: "list_users",
		...operationParameterDecision({
		fields: [
			{ name: "includeDisabled", canonical: "Boolean", card: { order: 0 } },
			{ name: "sort", canonical: "[UserSort!]" },
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
				renderEmpty: workspaceEmpty("users", "user", false),
				domain: "users",
		root: "users",
		selection: projection("user", "list"),
		purpose: "List users.",
		pageSize: 50,
		filterType: "UserFilter",
		sortType: "UserSortInput",
		sortKeys: USER_SORT_KEYS,
				extras: "$includeDisabled: Boolean",
		extraArgs: "includeDisabled: $includeDisabled",
		plan: listPrepare(50, (v) => ({ includeDisabled: v.includeDisabled })),
	}),
	{
		name: "get_user",
		resultCategory: "singular",
		...operationParameterDecision({
		fields: [
			{ name: "user", canonical: "UserReference", canonicalBranches: [0], compatibilityRequirements: [{"branch":0,"kind":"all","order":0}], card: { order: 0, required: true } },
			{ name: "userId", compatibilityRequirements: [{"branch":1,"kind":"all","order":0}], legacy: [{ order: 0, required: true, branch: 0 }] },
		],
		requirements: {
			canonicalBranches: 1,
			compatibilityBranches: [{},{}],
		},
	}),
						aliases: [],
		domain: "users",
		purpose: "Get a user by me, UUID, email, name, or display name.",
						example: { operation: "get_user", variables: { user: "me" } },
		document: getDocument("GetUser", "user", projection("user", "detail")),
		plan(v) {
			const requested = String(v.user ?? v.userId);
			return {
				kind: "query",
				lookups: [userLookup("user", requested)],
				finish(resolved) {
					const x = resolved.user as { id: string; name?: string };
					return {
						variables: { id: x.id },
						resolution: { target: { requested: v.user ?? v.userId, resolvedId: x.id, name: x.name } },
					};
				},
			};
		},
	},
] satisfies OperationSource[]).map((operation) =>
	defineOperation(operation),
);
