import { resolveUserReference } from "../client";
import { USER_SELECTION } from "../selections";
import { p } from "../operation-types";
import type {
	LinearOperation,
	OperationSource,
	OperationDefinition,
} from "../operation-types";
import { defineOperation } from "../operation-definition";
import {
	USER_SORT_KEYS,
	filter,
	sort,
	getDocument,
	listPrepare,
	workspaceEmpty,
	listOperation,
} from "./shared";

export const users: readonly OperationDefinition[] = ([
	listOperation({
		name: "list_users",
		compatibilityBranches: [
			{
				"all": []
			}
		],
		renderEmpty: workspaceEmpty("users", "user", false),
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
		domain: "users",
		root: "users",
		selection: USER_SELECTION,
		purpose: "List users.",
		pageSize: 50,
		filterType: "UserFilter",
		sortType: "UserSortInput",
		sortKeys: USER_SORT_KEYS,
		parameters: [p("includeDisabled", "Boolean")],
		extras: "$includeDisabled: Boolean",
		extraArgs: "includeDisabled: $includeDisabled",
		prepare: listPrepare(50, (v) => ({ includeDisabled: v.includeDisabled })),
	}),
	{
		name: "get_user",
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
		aliases: [],
		domain: "users",
		purpose: "Get a user by me, UUID, email, name, or display name.",
		parameters: [p("user", "UserReference", true)],
		legacyParameters: [[p("userId", "String", true)]],
		example: { operation: "get_user", variables: { user: "me" } },
		document: getDocument("GetUser", "user", USER_SELECTION),
		resolverPaths: { user: "resolveUserReference" },
		async prepare(k, v, s) {
			const x = await resolveUserReference(k, String(v.user ?? v.userId), s);
			return {
				variables: { id: x.id },
				resolution: {
					target: {
						requested: v.user ?? v.userId,
						resolvedId: x.id,
						name: x.name,
					},
				},
			};
		},
	},
] satisfies OperationSource[]).map((operation) =>
	defineOperation(operation as LinearOperation),
);
