import { userLookup } from "../operation-plan";
import { projection } from "../selections";
import { p } from "../operation-types";
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
			compatibilityBranches: [
				{
					"all": []
				}
			],
			canonical: {
				"fields": {
					"includeDisabled": "Boolean",
					"sort": "[UserSort!]",
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
			parameters: [p("includeDisabled", "Boolean")],
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
			compatibilityBranches: [
				{
					"all": [
						"user"
					]
				},
				{
					"all": [
						"userId"
					]
				}
			],
			canonical: {
				"fields": {
					"user": "UserReference"
				},
				"branches": [
					[
						"user"
					]
				]
			},
			parameters: [p("user", "UserReference", true)],
			legacyParameters: [[p("userId", "String", true)]],
		}),
						aliases: [],
		domain: "users",
		purpose: "Get a user by me, UUID, email, name, or display name.",
						example: { operation: "get_user", variables: { user: "me" } },
		document: getDocument("GetUser", "user", projection("user", "detail")),
		resolverPaths: { user: "resolveUserReference" },
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
