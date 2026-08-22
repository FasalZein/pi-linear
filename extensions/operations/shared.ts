import {
	resolveIssueReference,
	resolveNamedEntityReference,
	type ResolvedIssue,
} from "../client";
import {
	parseResultView,
	projection,
	type ResultView,
	type ResultViewEntity,
} from "../selections";
import {
	compactObject,
	mergedInput,
	p,
	paginationVariables,
	type GraphQLDocumentVariant,
	type LinearOperation,
	type OperationPreparation,
	type OperationSource,
	type OperationEmptyState,
	type OperationDefinition,
	type OperationDomain,
	type OperationParameter,
} from "../operation-types";
import type { CanonicalOperation } from "../canonical-schema";
import { defineOperation } from "../operation-definition";
import { issueLookup, namedEntityLookup, pureMutationPlan, pureQueryPlan } from "../operation-plan";

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
export function listQueryDocument(
	name: string,
	root: string,
	selection: string,
	options: {
		filterType?: string;
		sortType?: string;
		extras?: string;
		extraArgs?: string;
		totalCount?: boolean;
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
      nodes { ${selection} } ${projection("pageInfo", "list")}${options.totalCount ? " totalCount" : ""}
    }
  }`;
}
export function getDocument(name: string, root: string, selection: string) {
	return `query ${name}($id: String!) { ${root}(id: $id) { ${selection} } }`;
}

export const resultViewParam = p("view", "ResultView");

export function applyResultView(
	variables: Record<string, unknown>,
	defaultView: ResultView,
	prepared: OperationPreparation,
	documents: Record<ResultView, string>,
	root: string,
): OperationPreparation {
	const view = parseResultView(variables.view, defaultView);
	return {
		...prepared,
		variant: {
			...prepared.variant,
			document: documents[view],
			root: prepared.variant?.root ?? root,
		},
		resultView: view,
	};
}

export function withGetResultView(
	source: Omit<OperationSource, "resultCategory">,
	entity: ResultViewEntity,
	root: string,
	queryName: string,
	defaultView: ResultView = "full",
): OperationSource {
	const documents: Record<ResultView, string> = {
		summary: getDocument(queryName, root, projection(entity, "list")),
		full: getDocument(queryName, root, projection(entity, "detail")),
	};
	const innerPlan = source.plan;
	return {
		...source,
		resultCategory: "singular",
		canonical: {
			...source.canonical,
			fields: { ...source.canonical.fields, view: "ResultView" },
		},
		parameters: [...source.parameters, resultViewParam],
		document: documents[defaultView],
		plan: async (variables) => {
			const plan = innerPlan ? await innerPlan(variables) : pureQueryPlan({ variables });
			return {
				...plan,
				finish: (resolved) => applyResultView(
					variables,
					defaultView,
					plan.finish(resolved),
					documents,
					root,
				),
			};
		},
	};
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
): NonNullable<LinearOperation["plan"]> {
	return async (variables) => pureQueryPlan({
		variables: compactObject({
			...paginationVariables(variables, defaultPageSize),
			filter: object(variables.filter),
			sort: Array.isArray(variables.sort) ? variables.sort : undefined,
			...(extra ? await extra(variables) : {}),
		}),
	});
}
function plainInputPlan(omitted: readonly string[] = []): NonNullable<LinearOperation["plan"]> {
	return (variables) => pureMutationPlan({
		variables: { input: mergedInput(variables, omitted) },
	});
}
function updateInputPlan(idKey = "id", omitted: readonly string[] = []): NonNullable<LinearOperation["plan"]> {
	return (variables) => {
		const update = mergedInput(variables, [idKey, ...omitted]);
		if (!Object.keys(update).length)
			throw new Error("No update fields were provided.");
		return pureMutationPlan({ variables: { id: variables[idKey], input: update } });
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
	totalCount?: boolean;
	plan?: LinearOperation["plan"];
	aliases?: readonly string[];
	example?: Record<string, unknown>;
	resolverPaths?: Record<string, string>;
	acceptedParameters?: readonly OperationParameter[];
	validateVariables?: LinearOperation["validateVariables"];
	resultView?: { entity: ResultViewEntity; defaultView: ResultView };
} & OperationSourceExtras): OperationSource {
	const parameters = config.parameters ?? [];
	const queryName = config.name.replace(/(^|_)(\w)/g, (_, _a, c) => c.toUpperCase());
	const documents = config.resultView
		? {
				summary: listQueryDocument(
					queryName,
					config.root,
					projection(config.resultView.entity, "list"),
					config,
				),
				full: listQueryDocument(
					queryName,
					config.root,
					projection(config.resultView.entity, "detail"),
					config,
				),
		  }
		: undefined;
	const document = documents
		? documents[config.resultView!.defaultView]
		: listQueryDocument(queryName, config.root, config.selection, config);
	const innerPlan = config.plan ?? listPrepare(config.pageSize);
	const innerValidate = config.validateVariables;
	const defaultView = config.resultView?.defaultView;
	return {
		...sourceExtras(config),
		name: config.name,
		resultCategory: "collection",
		canonical: config.resultView
			? {
					...config.canonical,
					fields: { ...config.canonical.fields, view: "ResultView" },
			  }
			: config.canonical,
		aliases: config.aliases ?? [],
		domain: config.domain,
		purpose: config.purpose,
		parameters: [
			...parameters,
			...pagination,
			...(config.filterType ? [filter] : []),
			...(config.sortType ? [sort] : []),
			...(config.resultView ? [resultViewParam] : []),
		],
		acceptedParameters: config.acceptedParameters
			? config.resultView
				? [...config.acceptedParameters, resultViewParam]
				: config.acceptedParameters
			: undefined,
		example: { operation: config.name, variables: config.example ?? {} },
		document,
		pagination: {
			defaultPageSize: config.pageSize,
			...(config.filterType ? { filterType: config.filterType } : {}),
			...(config.sortType ? { sortType: config.sortType } : {}),
			...(config.sortKeys ? { sortKeys: config.sortKeys } : {}),
		},
		resolverPaths: config.resolverPaths,
		validateVariables: innerValidate
			? (variables) => {
					if (defaultView) parseResultView(variables.view, defaultView);
					innerValidate(variables);
			  }
			: innerValidate,
		plan: documents && defaultView
			? async (variables) => {
					const plan = await innerPlan(variables);
					return {
						...plan,
						finish: (resolved) => {
							const prepared = plan.finish(resolved);
							return prepared.resultView
								? prepared
								: applyResultView(variables, defaultView, prepared, documents, config.root);
						},
					};
			  }
			: innerPlan,
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
	plan?: LinearOperation["plan"];
	prepare?: LinearOperation["prepare"];
	batchPrepare?: LinearOperation["batchPrepare"];
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
		resultCategory: "singular",
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
		plan: config.plan ?? (config.idKey ? updateInputPlan(config.idKey) : plainInputPlan()),
		...(config.prepare ? { prepare: config.prepare } : {}),
		...(config.batchPrepare ? { batchPrepare: config.batchPrepare } : {}),
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
		resultCategory: "singular",
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
		plan(v) {
			validateSaveSemantics(v);
			const reference = v[config.idKey];
			const update = typeof reference === "string" && reference.length > 0;
			const prepared = mergedInput(v, [config.idKey]);
			const projectReference = config.name === "save_milestone" && typeof prepared.projectId === "string"
				? prepared.projectId
				: undefined;
			const issueReferenceValue = config.name === "save_project" && typeof prepared.convertedFromIssueId === "string"
				? prepared.convertedFromIssueId
				: undefined;
			return {
				kind: "mutation",
				lookups: [
					...(update ? [namedEntityLookup("target", config.entityKind, String(reference))] : []),
					...(projectReference ? [namedEntityLookup("project", "project", projectReference)] : []),
					...(issueReferenceValue ? [issueLookup("convertedFromIssue", issueReferenceValue)] : []),
				],
				finish(resolved) {
					const target = resolved.target as { id: string; name: string } | undefined;
					const project = resolved.project as { id: string; name: string } | undefined;
					const issue = resolved.convertedFromIssue as ResolvedIssue | undefined;
					if (project) prepared.projectId = project.id;
					if (issue) prepared.convertedFromIssueId = issue.id;
					const slackChannelName = config.name === "save_project" ? prepared.slackChannelName : undefined;
					if (config.name === "save_project") delete prepared.slackChannelName;
					return {
						variant: update ? updateVariant : createVariant,
						variables: update
							? { id: target?.id, input: prepared }
							: { input: prepared, ...(slackChannelName === undefined ? {} : { slackChannelName }) },
						resolution: compactObject({
							target: target ? { requested: reference, resolvedId: target.id, name: target.name } : undefined,
							project: project ? { requested: projectReference, resolvedId: project.id, name: project.name } : undefined,
							convertedFromIssue: issue && issueReferenceValue ? issueTarget(issueReferenceValue, issue) : undefined,
						}),
					};
				},
			};
		},
	});
}

