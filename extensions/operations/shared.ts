import {
	resolveIssueReference,
	resolveNamedEntityReference,
	type ResolvedIssue,
} from "../client";
import { PAGE_INFO } from "../selections";
import {
	compactObject,
	mergedInput,
	p,
	paginationVariables,
	type GraphQLDocumentVariant,
	type LinearOperation,
	type OperationSource,
	type OperationEmptyState,
	type OperationDefinition,
	type OperationDomain,
	type OperationParameter,
} from "../operation-types";
import type { CanonicalOperation } from "../canonical-schema";
import { defineOperation } from "../operation-definition";

export const pagination = [
	p("after"),
	p("before"),
	p("first", "Int"),
	p("last", "Int"),
	p("includeArchived", "Boolean"),
	p("orderBy", "PaginationOrderBy"),
];
export const input = p("input", "Input");
export const filter = p("filter", "Filter");
export const sort = p("sort", "[SortInput!]");
export const ISSUE_SORT_KEYS = [
	"priority",
	"estimate",
	"title",
	"label",
	"labelGroup",
	"slaStatus",
	"createdAt",
	"updatedAt",
	"completedAt",
	"dueDate",
	"accumulatedStateUpdatedAt",
	"cycle",
	"milestone",
	"assignee",
	"delegate",
	"project",
	"team",
	"manual",
	"workflowState",
	"customer",
	"customerRevenue",
	"customerCount",
	"customerImportantCount",
	"rootIssue",
	"linkCount",
	"release",
] as const;
export const PROJECT_SORT_KEYS = [
	"name",
	"status",
	"priority",
	"manual",
	"targetDate",
	"startDate",
	"createdAt",
	"updatedAt",
	"health",
	"lead",
] as const;
export const INITIATIVE_SORT_KEYS = [
	"name",
	"manual",
	"updatedAt",
	"createdAt",
	"targetDate",
	"health",
	"healthUpdatedAt",
	"owner",
	"priority",
] as const;
export const USER_SORT_KEYS = ["name", "displayName"] as const;
export const DOCUMENT_SORT_KEYS = [
	"title",
	"creator",
	"project",
	"createdAt",
	"updatedAt",
] as const;

export function issueTarget(requested: string, issue: ResolvedIssue) {
	return { requested, resolvedId: issue.id, identifier: issue.identifier };
}
export function issueReference(
	variables: Record<string, unknown>,
	key = "issue",
): string {
	const value = variables[key] ?? variables[`${key}Id`];
	if (typeof value === "string") return value;
	if (
		key === "issue" &&
		typeof variables.teamKey === "string" &&
		variables.number !== undefined
	) {
		return `${variables.teamKey}-${variables.number}`;
	}
	return "";
}
export function isUuid(value: unknown): value is string {
	return (
		typeof value === "string" &&
		/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
			value,
		)
	);
}
export function object(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}
function listDocument(
	name: string,
	root: string,
	selection: string,
	options: {
		filterType?: string;
		sortType?: string;
		extras?: string;
		extraArgs?: string;
	} = {},
) {
	return `query ${name}(
    $after: String $before: String $first: Int $includeArchived: Boolean $last: Int $orderBy: PaginationOrderBy
    ${options.filterType ? `$filter: ${options.filterType}` : ""}
    ${options.sortType ? `$sort: [${options.sortType}!]` : ""}
    ${options.extras ?? ""}
  ) {
    ${root}(after: $after before: $before first: $first includeArchived: $includeArchived last: $last orderBy: $orderBy
      ${options.filterType ? "filter: $filter" : ""} ${options.sortType ? "sort: $sort" : ""} ${options.extraArgs ?? ""}) {
      nodes { ${selection} } ${PAGE_INFO}
    }
  }`;
}
export function getDocument(name: string, root: string, selection: string) {
	return `query ${name}($id: String!) { ${root}(id: $id) { ${selection} } }`;
}
function mutationDocument(
	name: string,
	root: string,
	inputType: string,
	selection: string,
	id = false,
) {
	return `mutation ${name}(${id ? "$id: String! " : ""}$input: ${inputType}!) {
    ${root}(${id ? "id: $id, " : ""}input: $input) { success ${selection} }
  }`;
}
function mutationVariant(
	document: string,
	root: string,
	entityPath: string,
	when?: "create" | "update",
): GraphQLDocumentVariant {
	return {
		...(when ? { when } : {}),
		document,
		root,
		mutationResult: {
			successPath: "success",
			successValue: true,
			requiredEntityPaths: [entityPath],
		},
	};
}
export function listPrepare(
	defaultPageSize: number,
	extra?: (
		variables: Record<string, unknown>,
	) => Promise<Record<string, unknown>> | Record<string, unknown>,
) {
	return async (_apiKey: string, variables: Record<string, unknown>) => ({
		variables: compactObject({
			...paginationVariables(variables, defaultPageSize),
			filter: object(variables.filter),
			sort: Array.isArray(variables.sort) ? variables.sort : undefined,
			...(extra ? await extra(variables) : {}),
		}),
	});
}
function plainInputPrepare(omitted: readonly string[] = []) {
	return async (_apiKey: string, variables: Record<string, unknown>) => ({
		variables: { input: mergedInput(variables, omitted) },
	});
}
function updateInputPrepare(idKey = "id", omitted: readonly string[] = []) {
	return async (_apiKey: string, variables: Record<string, unknown>) => {
		const update = mergedInput(variables, [idKey, ...omitted]);
		if (!Object.keys(update).length)
			throw new Error("No update fields were provided.");
		return { variables: { id: variables[idKey], input: update } };
	};
}
/** Shared wording for list operations that return nothing in the selected workspace. */
export function workspaceEmpty(
	plural: string,
	singular: string,
	canCreate = true,
): OperationEmptyState {
	return {
		fact: `No ${plural} exist in the selected workspace.`,
		action: canCreate
			? `Create the first ${singular} or check another workspace.`
			: "Check another workspace or adjust the request.",
		filteredFact: `No ${plural} matched the filters.`,
		filteredAction: "Loosen or remove a filter.",
	};
}

/** Per-operation authority carried by every source definition. */
type OperationSourceExtras = Pick<
	OperationSource,
	"compatibilityBranches"
> & Pick<
	LinearOperation,
	"semanticException" | "renderKind" | "renderTargetFields" | "renderEmpty"
>;

function sourceExtras(config: OperationSourceExtras): OperationSourceExtras {
	return {
		compatibilityBranches: config.compatibilityBranches,
		semanticException: config.semanticException,
		renderKind: config.renderKind,
		renderTargetFields: config.renderTargetFields,
		renderEmpty: config.renderEmpty,
	};
}

export function listOperation(config: {
	name: string;
	canonical: CanonicalOperation;
	domain: OperationDomain;
	root: string;
	selection: string;
	purpose: string;
	pageSize: number;
	filterType?: string;
	sortType?: string;
	sortKeys?: readonly string[];
	parameters?: readonly OperationParameter[];
	extras?: string;
	extraArgs?: string;
	prepare?: LinearOperation["prepare"];
	aliases?: readonly string[];
	example?: Record<string, unknown>;
	resolverPaths?: Record<string, string>;
	acceptedParameters?: readonly OperationParameter[];
	validateVariables?: LinearOperation["validateVariables"];
} & OperationSourceExtras): OperationSource {
	const parameters = config.parameters ?? [];
	const document = listDocument(
		config.name.replace(/(^|_)(\w)/g, (_, _a, c) => c.toUpperCase()),
		config.root,
		config.selection,
		config,
	);
	return {
		...sourceExtras(config),
		name: config.name,
		canonical: config.canonical,
		aliases: config.aliases ?? [],
		domain: config.domain,
		purpose: config.purpose,
		parameters: [
			...parameters,
			...pagination,
			...(config.filterType ? [filter] : []),
			...(config.sortType ? [sort] : []),
		],
		acceptedParameters: config.acceptedParameters,
		example: { operation: config.name, variables: config.example ?? {} },
		document,
		pagination: {
			defaultPageSize: config.pageSize,
			...(config.filterType ? { filterType: config.filterType } : {}),
			...(config.sortType ? { sortType: config.sortType } : {}),
			...(config.sortKeys ? { sortKeys: config.sortKeys } : {}),
		},
		resolverPaths: config.resolverPaths,
		validateVariables: config.validateVariables,
		prepare: config.prepare ?? listPrepare(config.pageSize),
	};
}
export function simpleMutation(config: {
	name: string;
	canonical: CanonicalOperation;
	domain: OperationDomain;
	purpose: string;
	root: string;
	inputType: string;
	selection: string;
	parameters: readonly OperationParameter[];
	acceptedParameters?: readonly OperationParameter[];
	example: Record<string, unknown>;
	idKey?: string;
	prepare?: LinearOperation["prepare"];
	aliases?: readonly string[];
	legacyParameters?: LinearOperation["legacyParameters"];
	aliasParameters?: LinearOperation["aliasParameters"];
	resolverPaths?: Record<string, string>;
	validateVariables?: LinearOperation["validateVariables"];
	document?: string;
} & OperationSourceExtras): OperationSource {
	const document =
		config.document ??
		mutationDocument(
			config.name.replace(/(^|_)(\w)/g, (_, _a, c) => c.toUpperCase()),
			config.root,
			config.inputType,
			config.selection,
			Boolean(config.idKey),
		);
	const entityPath = config.selection.trim().match(/^(\w+)\s*\{/)?.[1];
	if (!entityPath) throw new Error(`Mutation ${config.name} must select a result entity.`);
	return {
		...sourceExtras(config),
		name: config.name,
		canonical: config.canonical,
		aliases: config.aliases ?? [],
		domain: config.domain,
		purpose: config.purpose,
		parameters: config.parameters,
		acceptedParameters: config.acceptedParameters,
		legacyParameters: config.legacyParameters,
		aliasParameters: config.aliasParameters,
		example: { operation: config.name, variables: config.example },
		document,
		variants: [mutationVariant(document, config.root, entityPath)],
		resolverPaths: config.resolverPaths,
		validateVariables: config.validateVariables,
		prepare:
			config.prepare ??
			(config.idKey ? updateInputPrepare(config.idKey) : plainInputPrepare()),
	};
}

// Save operations use one definition and select the create or update document at runtime.
export function addSaveOperation(config: {
	name: string;
	canonical: CanonicalOperation;
	domain: OperationDomain;
	entity: string;
	noun: string;
	entityKind: "project" | "initiative" | "projectMilestone";
	documentName: string;
	selection: string;
	idKey: string;
	createRoot: string;
	updateRoot: string;
	createType: string;
	updateType: string;
	parameters: readonly OperationParameter[];
	example: Record<string, unknown>;
	resolverPaths?: Record<string, string>;
} & OperationSourceExtras) {
	const entityPath = config.entity[0]!.toLowerCase() + config.entity.slice(1);
	const baseCreateDocument = mutationDocument(
		`Create${config.documentName}`,
		config.createRoot,
		config.createType,
		`${entityPath} { ${config.selection} }`,
	);
	const createDocument =
		config.name === "save_project"
			? baseCreateDocument
					.replace(
						`$input: ${config.createType}!`,
						`$input: ${config.createType}! $slackChannelName: String`,
					)
					.replace(
						`${config.createRoot}(input: $input)`,
						`${config.createRoot}(input: $input, slackChannelName: $slackChannelName)`,
					)
			: baseCreateDocument;
	const updateDocument = mutationDocument(
		`Update${config.documentName}`,
		config.updateRoot,
		config.updateType,
		`${entityPath} { ${config.selection} }`,
		true,
	);
	const createVariant = mutationVariant(createDocument, config.createRoot, entityPath, "create");
	const updateVariant = mutationVariant(updateDocument, config.updateRoot, entityPath, "update");
	// Requirement branches own save mode, required content, and forbidden fields.
	// This named exception checks non-empty and value-type semantics only.
	const validateSaveSemantics = (v: Record<string, unknown>) => {
		const reference = v[config.idKey];
		const update = typeof reference === "string" && reference.length > 0;
		if (update) return;
		const prepared = mergedInput(v, [config.idKey]);
		if (typeof prepared.name !== "string" || !prepared.name.trim())
			throw new Error(
				`${config.entity} name is required for ${config.createRoot} (name).`,
			);
		if (
			config.name === "save_milestone" &&
			typeof prepared.projectId !== "string"
		)
			throw new Error("projectId is required for projectMilestoneCreate.");
		if (
			config.name === "save_project" &&
			(!Array.isArray(prepared.teamIds) || prepared.teamIds.length === 0)
		)
			throw new Error(
				"teamIds is required for projectCreate and must be a non-empty array.",
			);
	};
	const cardParameters =
		config.name === "save_project"
			? [p("projectId", "ProjectReference"), p("name"), input]
			: config.name === "save_initiative"
				? [p("initiativeId", "InitiativeReference"), p("name"), input]
				: [
						p("milestoneId", "MilestoneReference"),
						p("name"),
						p("projectId", "ProjectReference"),
						input,
					];
	return defineOperation({
		...sourceExtras(config),
		name: config.name,
		canonical: config.canonical,
		aliases: [],
		domain: config.domain,
		purpose: `Create or update ${/^[aeiou]/i.test(config.noun) ? "an" : "a"} ${config.noun}.`,
		parameters: cardParameters,
		acceptedParameters: config.parameters,
		example: { operation: config.name, variables: config.example },
		document: createDocument,
		variants: [createVariant, updateVariant],
		resolverPaths: config.resolverPaths,
		requiresVariables: true,
		validateVariables: validateSaveSemantics,
		async prepare(k, v, s) {
			validateSaveSemantics(v);
			const reference = v[config.idKey];
			const update = typeof reference === "string" && reference.length > 0;
			const prepared = mergedInput(v, [config.idKey]);
			const resolution: Record<string, unknown> = {};
			let id: string | undefined;
			if (update) {
				const entity = await resolveNamedEntityReference(
					k,
					config.entityKind,
					String(reference),
					s,
				);
				id = entity.id;
				resolution.target = {
					requested: reference,
					resolvedId: id,
					name: entity.name,
				};
			}
			if (
				config.name === "save_milestone" &&
				typeof prepared.projectId === "string"
			) {
				const project = await resolveNamedEntityReference(
					k,
					"project",
					prepared.projectId,
					s,
				);
				resolution.project = {
					requested: prepared.projectId,
					resolvedId: project.id,
					name: project.name,
				};
				prepared.projectId = project.id;
			}
			if (
				config.name === "save_project" &&
				typeof prepared.convertedFromIssueId === "string"
			) {
				const issue = await resolveIssueReference(
					k,
					prepared.convertedFromIssueId,
					s,
				);
				resolution.convertedFromIssue = issueTarget(
					prepared.convertedFromIssueId,
					issue,
				);
				prepared.convertedFromIssueId = issue.id;
			}
			const slackChannelName =
				config.name === "save_project" ? prepared.slackChannelName : undefined;
			if (config.name === "save_project") delete prepared.slackChannelName;
			return {
				variant: update ? updateVariant : createVariant,
				variables: update
					? { id, input: prepared }
					: {
							input: prepared,
							...(slackChannelName === undefined ? {} : { slackChannelName }),
						},
				resolution,
			};
		},
	});
}

