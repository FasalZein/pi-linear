import type { ResolvedIssue } from "../client";
import {
	parseResultView,
	projection,
	type ResultView,
	type ResultViewEntity,
} from "../selections";
import {
	compactObject,
	isCompatibilityObject,
	isCompatibilityString,
	mergedInput,
	p,
	paginationVariables,
	type CompatibilityObject,
	type CompatibilityValue,
	type GraphQLDocumentVariant,
	type OperationPreparation,
	type OperationSource,
	type OperationEmptyState,
	type OperationDomain,
	type OperationParameter,
	type PaginationMetadata,
	type ParsedOperationPlanFactory,
	type RequirementBranch,
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
	variables: CompatibilityObject,
	key = "issue",
): string {
	const value = variables[key] ?? variables[`${key}Id`];
	if (isCompatibilityString(value)) return value;
	if (
		key === "issue" &&
		isCompatibilityString(variables.teamKey) &&
		variables.number !== undefined
	) {
		return `${variables.teamKey}-${variables.number}`;
	}
	return "";
}
export function isUuid(value: CompatibilityValue | undefined): value is string {
	return (
		isCompatibilityString(value) &&
		/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
			value,
		)
	);
}
export function object(value: CompatibilityValue | undefined): CompatibilityObject | undefined {
	return isCompatibilityObject(value) ? value : undefined;
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
	variables: CompatibilityObject,
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
	const documents = {
		summary: getDocument(queryName, root, projection(entity, "list")),
		full: getDocument(queryName, root, projection(entity, "detail")),
	} satisfies Record<ResultView, string>;
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
		inventoryDocuments: (["summary", "full"] as const).map((id) => ({ id, document: documents[id] })),
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
	const variant: GraphQLDocumentVariant = {
		document,
		root,
		mutationResult: {
			successPath: "success",
			successValue: true,
			requiredEntityPaths: [entityPath],
		},
	};
	if (when) variant.when = when;
	return variant;
}
export function linearSort(value: CompatibilityValue | undefined): CompatibilityValue[] | undefined {
	if (!Array.isArray(value)) return undefined;
	return value.map((clause) => {
		if (!isCompatibilityObject(clause)) return clause;
		const key = clause.key;
		const order = clause.order;
		if (isCompatibilityString(key)) return { [key]: compactObject({ order }) };
		const entries = Object.entries(clause);
		if (entries.length !== 1) return clause;
		const [field, legacyOrder] = entries[0]!;
		return legacyOrder === "Ascending" || legacyOrder === "Descending"
			? { [field]: { order: legacyOrder } }
			: clause;
	});
}

export function listPrepare(
	defaultPageSize: number,
	extra?: (
		variables: CompatibilityObject,
	) => Promise<CompatibilityObject> | CompatibilityObject,
): ParsedOperationPlanFactory {
	return async (variables) => {
		const extraVariables = extra ? await extra(variables) : undefined;
		return pureQueryPlan({
			variables: compactObject({
				...paginationVariables(variables, defaultPageSize),
				filter: object(variables.filter),
				sort: linearSort(variables.sort),
				...extraVariables,
			}),
		});
	};
}
function plainInputPlan(omitted: readonly string[] = []): ParsedOperationPlanFactory {
	return (variables) => pureMutationPlan({
		variables: { input: mergedInput(variables, omitted) },
	});
}
function updateInputPlan(idKey = "id", omitted: readonly string[] = []): ParsedOperationPlanFactory {
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

type ProjectedParameterDecision = Pick<
	OperationSource,
	"canonical" | "compatibilityBranches" | "parameters"
> & Partial<Pick<OperationSource, "acceptedParameters" | "legacyParameters" | "aliasParameters">>;

type ParameterCardRole = {
	order: number;
	type?: string;
	required?: true;
};

type CompatibilityRequirementRole =
	| { branch: number; kind: "all" | "atLeastOne" | "forbidden"; order: number; input?: true }
	| { branch: number; kind: "exactlyOne"; group: number; order: number; input?: true };

type ParameterFieldDecision = {
	name: string;
	/** Canonical fields follow declaration order. */
	canonical?: string;
	canonicalBranches?: readonly number[];
	compatibilityRequirements?: readonly CompatibilityRequirementRole[];
	card?: ParameterCardRole;
	accepted?: ParameterCardRole;
	legacy?: readonly (ParameterCardRole & { branch: number })[];
	aliases?: readonly (ParameterCardRole & { operation: string })[];
};

type CompatibilityRequirementMetadata = Pick<
	RequirementBranch,
	"atLeastOneOfMessage" | "exactlyOneOfMessages" | "mode"
> & { exactlyOneGroups?: number };

type OperationParameterDecision = {
	fields: readonly ParameterFieldDecision[];
	requirements: {
		canonicalBranches: number;
		compatibilityBranches: readonly CompatibilityRequirementMetadata[];
		exclusiveCanonical?: true;
	};
};

function parameterFromRole(
	field: ParameterFieldDecision,
	role: ParameterCardRole,
	inheritCanonical: boolean,
): OperationParameter {
	return p(field.name, role.type ?? (inheritCanonical ? field.canonical : undefined), role.required);
}

function orderedParameters(
	fields: readonly ParameterFieldDecision[],
	roleName: "card" | "accepted",
): OperationParameter[] {
	return fields
		.flatMap((field) => {
			const role = field[roleName];
			return role ? [{ field, role }] : [];
		})
		.sort((left, right) => left.role.order - right.role.order)
		.map(({ field, role }) => parameterFromRole(field, role, roleName === "card"));
}

function groupedParameters(
	fields: readonly ParameterFieldDecision[],
	roleName: "legacy" | "aliases",
): Readonly<Record<string, readonly OperationParameter[]>> {
	const grouped: Record<string, { order: number; parameter: OperationParameter }[]> = {};
	for (const field of fields) {
		for (const role of field[roleName] ?? []) {
			const key = "branch" in role ? String(role.branch) : role.operation;
			(grouped[key] ??= []).push({ order: role.order, parameter: parameterFromRole(field, role, false) });
		}
	}
	return Object.fromEntries(
		Object.entries(grouped).map(([key, values]) => [
			key,
			values.sort((left, right) => left.order - right.order).map(({ parameter }) => parameter),
		]),
	);
}

function canonicalBranches(
	fields: readonly ParameterFieldDecision[],
	count: number,
): string[][] {
	const branches = Array.from({ length: count }, () => [] as string[]);
	for (const field of fields) {
		for (const branch of field.canonicalBranches ?? []) branches[branch]!.push(field.name);
	}
	return branches;
}

function compatibilityPaths(
	fields: readonly ParameterFieldDecision[],
	branch: number,
	kind: CompatibilityRequirementRole["kind"],
	group?: number,
): string[] {
	return fields.flatMap((field) => (field.compatibilityRequirements ?? [])
		.filter((role) => role.branch === branch && role.kind === kind &&
			(role.kind !== "exactlyOne" || role.group === group))
		.map((role) => ({ order: role.order, path: role.input ? `input.${field.name}` : field.name })))
		.sort((left, right) => left.order - right.order)
		.map(({ path }) => path);
}

function addAtLeastOne(
	branch: RequirementBranch,
	paths: readonly string[],
	message: string | undefined,
): void {
	if (paths.length) branch.atLeastOneOf = paths;
	if (message) branch.atLeastOneOfMessage = message;
}

function addExactlyOne(
	branch: RequirementBranch,
	groups: readonly (readonly string[])[],
	messages: readonly string[] | undefined,
): void {
	if (groups.length) branch.exactlyOneOf = groups;
	if (messages) branch.exactlyOneOfMessages = messages;
}

function addForbidden(branch: RequirementBranch, paths: readonly string[]): void {
	if (paths.length) branch.forbidden = paths;
}

function compatibilityBranches(
	fields: readonly ParameterFieldDecision[],
	metadata: readonly CompatibilityRequirementMetadata[],
): RequirementBranch[] {
	return metadata.map((details, index) => {
		const branch: RequirementBranch = { all: compatibilityPaths(fields, index, "all") };
		addAtLeastOne(
			branch,
			compatibilityPaths(fields, index, "atLeastOne"),
			details.atLeastOneOfMessage,
		);
		const groups = Array.from({ length: details.exactlyOneGroups ?? 0 }, (_, group) =>
			compatibilityPaths(fields, index, "exactlyOne", group));
		addExactlyOne(branch, groups, details.exactlyOneOfMessages);
		addForbidden(branch, compatibilityPaths(fields, index, "forbidden"));
		if (details.mode) branch.mode = details.mode;
		return branch;
	});
}

/** Project every runtime parameter card and branch from one authored decision. */
export function operationParameterDecision(
	decision: OperationParameterDecision,
): ProjectedParameterDecision {
	const canonicalFields: Record<string, string> = {};
	for (const field of decision.fields) {
		if (field.canonical) canonicalFields[field.name] = field.canonical;
	}
	const acceptedParameters = orderedParameters(decision.fields, "accepted");
	const legacyByBranch = groupedParameters(decision.fields, "legacy");
	const aliasParameters = groupedParameters(decision.fields, "aliases");
	const legacyParameters = Object.keys(legacyByBranch)
		.sort((left, right) => Number(left) - Number(right))
		.map((key) => legacyByBranch[key]!);
	const canonical: CanonicalOperation = {
		fields: canonicalFields,
		branches: canonicalBranches(decision.fields, decision.requirements.canonicalBranches),
	};
	if (decision.requirements.exclusiveCanonical) canonical.exclusiveBranches = true;
	const projected: ProjectedParameterDecision = {
		canonical,
		compatibilityBranches: compatibilityBranches(
			decision.fields,
			decision.requirements.compatibilityBranches,
		),
		parameters: orderedParameters(decision.fields, "card"),
	};
	if (acceptedParameters.length) projected.acceptedParameters = acceptedParameters;
	if (legacyParameters.length) projected.legacyParameters = legacyParameters;
	if (Object.keys(aliasParameters).length) projected.aliasParameters = aliasParameters;
	return projected;
}

/** Per-operation authority carried by every source definition. */
type OperationSourceExtras = Pick<
	OperationSource,
	| "compatibilityBranches"
	| "canonicalExample"
	| "semanticException"
	| "renderKind"
	| "renderTargetFields"
	| "renderEmpty"
>;

function sourceExtras(config: OperationSourceExtras): OperationSourceExtras {
	return {
		compatibilityBranches: config.compatibilityBranches,
		canonicalExample: config.canonicalExample,
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
	plan?: ParsedOperationPlanFactory;
	aliases?: readonly string[];
	example?: CompatibilityObject;
	resolverPaths?: Readonly<{ [name: string]: string }>;
	acceptedParameters?: readonly OperationParameter[];
	validateVariables?: OperationSource["validateVariables"];
	resultView?: { entity: ResultViewEntity; defaultView: ResultView };
	inventoryDocuments?: readonly { id: string; document: string }[];
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
	const inventoryDocuments = [
		...(documents ? (["summary", "full"] as const).map((id) => ({ id, document: documents[id] })) : []),
		...(config.inventoryDocuments ?? []),
	];
	const paginationMetadata: PaginationMetadata = {
		defaultPageSize: config.pageSize,
	};
	if (config.filterType) paginationMetadata.filterType = config.filterType;
	if (config.sortType) paginationMetadata.sortType = config.sortType;
	if (config.sortKeys) paginationMetadata.sortKeys = config.sortKeys;
	const source: OperationSource = {
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
		example: { operation: config.name, variables: config.example ?? {} },
		document,
		pagination: paginationMetadata,
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
	if (config.acceptedParameters) {
		source.acceptedParameters = config.resultView
			? [...config.acceptedParameters, resultViewParam]
			: config.acceptedParameters;
	}
	if (inventoryDocuments.length) source.inventoryDocuments = inventoryDocuments;
	if (config.resolverPaths) source.resolverPaths = config.resolverPaths;
	if (innerValidate) {
		source.validateVariables = (variables) => {
			if (defaultView) parseResultView(variables.view, defaultView);
			innerValidate(variables);
		};
	}
	return source;
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
	example: CompatibilityObject;
	idKey?: string;
	plan?: ParsedOperationPlanFactory;
	aliases?: readonly string[];
	legacyParameters?: OperationSource["legacyParameters"];
	aliasParameters?: OperationSource["aliasParameters"];
	resolverPaths?: Readonly<{ [name: string]: string }>;
	validateVariables?: OperationSource["validateVariables"];
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
	};
}

type SaveParameterMode = "create" | "update" | "both";

type SaveIdentityParameter = {
	kind: "identity";
	name: string;
	type: string;
	canonicalOrder: number;
};

type TypedSaveParameterField = {
	kind: "typed";
	name: string;
	type: string;
	canonicalOrder: number;
	mode: SaveParameterMode;
	requiredOnCreate?: true;
	compatibilityCard?: true;
	renderTarget?: true;
};

type CompatibilitySaveParameterField = {
	kind: "compatibility";
	name: string;
	mode: SaveParameterMode;
};

export type SaveParameterDecision = {
	identity: SaveIdentityParameter;
	/** Fields stay in compatibility-card order. canonicalOrder projects typed field order. */
	fields: readonly (TypedSaveParameterField | CompatibilitySaveParameterField)[];
};

type SaveParameterProjections = {
	canonical: CanonicalOperation;
	compatibilityBranches: readonly RequirementBranch[];
	card: readonly OperationParameter[];
	accepted: readonly OperationParameter[];
	identity: string;
	renderTargetFields: readonly string[];
};

function validateSaveParameterFields(
	fields: readonly (SaveIdentityParameter | TypedSaveParameterField | CompatibilitySaveParameterField)[],
): void {
	const names = new Set<string>();
	const canonicalOrders = new Set<number>();
	for (const field of fields) {
		if (names.has(field.name)) throw new Error(`Duplicate save parameter ${field.name}.`);
		names.add(field.name);
		if (field.kind === "compatibility") continue;
		if (canonicalOrders.has(field.canonicalOrder)) {
			throw new Error(`Duplicate canonical save parameter order ${field.canonicalOrder}.`);
		}
		canonicalOrders.add(field.canonicalOrder);
	}
}

function saveParameterProjections(
	decision: SaveParameterDecision,
	noun: string,
): SaveParameterProjections {
	const compatibilityFields = [decision.identity, ...decision.fields];
	validateSaveParameterFields(compatibilityFields);
	const typed = compatibilityFields
		.filter((field): field is SaveIdentityParameter | TypedSaveParameterField =>
			field.kind !== "compatibility",
		)
		.slice()
		.sort((left, right) => left.canonicalOrder - right.canonicalOrder);
	const identity = decision.identity.name;
	const createRequired = typed.filter(
		(field): field is TypedSaveParameterField =>
			field.kind === "typed" && field.requiredOnCreate === true,
	);
	if (!createRequired.length) throw new Error(`Save ${noun} must declare a create requirement.`);
	const createFields = typed.filter((field) => field.kind === "typed" && field.mode !== "update");
	const updateFields = typed.filter((field) => field.kind === "identity" || field.mode !== "create");
	const updateContent = updateFields.filter((field) => field.kind === "typed");
	const fields: Record<string, string> = {};
	for (const field of typed) fields[field.name] = field.type;
	const createBranch = createRequired.map(({ name }) => name);
	const updateBranches = updateContent.map(({ name }) => [identity, name]);
	const pathVariants = (
		field: SaveIdentityParameter | TypedSaveParameterField | CompatibilitySaveParameterField,
	) => field.kind === "identity" ? [field.name] : [field.name, `input.${field.name}`];
	const createForbidden = [
		decision.identity,
		...decision.fields.filter((field) => field.mode === "update"),
	].flatMap(pathVariants);
	const updateForbidden = decision.fields
		.filter((field) => field.mode === "create")
		.flatMap(pathVariants);
	const primaryCreateField = createRequired[0]!;
	const additionalCreateRequirements = createRequired.slice(1).flatMap(pathVariants);
	const compatibilityCreateBranch = (all: readonly string[]): RequirementBranch => {
		const branch: RequirementBranch = { all };
		if (additionalCreateRequirements.length) branch.atLeastOneOf = additionalCreateRequirements;
		branch.forbidden = createForbidden;
		branch.mode = "create";
		return branch;
	};
	return {
		canonical: {
			fields,
			branches: [createBranch, ...updateBranches],
			variants: [
				{ fields: createFields.map(({ name }) => name), branches: [createBranch] },
				{ fields: updateFields.map(({ name }) => name), branches: updateBranches },
			],
		},
		compatibilityBranches: [
			compatibilityCreateBranch([primaryCreateField.name]),
			compatibilityCreateBranch([`input.${primaryCreateField.name}`]),
			{
				all: [identity],
				atLeastOneOf: decision.fields
					.filter((field) => field.mode !== "create")
					.flatMap(pathVariants),
				atLeastOneOfMessage: `No ${noun} update fields were provided.`,
				forbidden: updateForbidden,
				mode: "update",
			},
		],
		card: [
			p(decision.identity.name, decision.identity.type),
			...decision.fields
				.filter((field): field is TypedSaveParameterField =>
					field.kind === "typed" && field.compatibilityCard === true,
				)
				.map((field) => p(field.name, field.type)),
			input,
		],
		accepted: [...compatibilityFields.map(({ name }) => p(name)), p("input")],
		identity,
		renderTargetFields: [
			decision.identity.name,
			...decision.fields
				.filter((field): field is TypedSaveParameterField =>
					field.kind === "typed" && field.renderTarget === true,
				)
				.map(({ name }) => name),
		],
	};
}

// Save operations use one parameter decision and select the create or update document at runtime.
export function addSaveOperation(config: {
	name: string;
	parameterDecision: SaveParameterDecision;
	domain: OperationDomain;
	entity: string;
	noun: string;
	entityKind: "project" | "initiative" | "projectMilestone";
	documentName: string;
	selection: string;
	createRoot: string;
	updateRoot: string;
	createType: string;
	updateType: string;
	example: CompatibilityObject;
	resolverPaths?: Readonly<{ [name: string]: string }>;
} & Omit<OperationSourceExtras, "compatibilityBranches" | "renderTargetFields">) {
	const parameters = saveParameterProjections(config.parameterDecision, config.noun);
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
	const validateSaveSemantics = (v: CompatibilityObject) => {
		const reference = v[parameters.identity];
		const update = isCompatibilityString(reference) && reference.length > 0;
		if (update) return;
		const prepared = mergedInput(v, [parameters.identity]);
		if (!isCompatibilityString(prepared.name) || !prepared.name.trim())
			throw new Error(
				`${config.entity} name is required for ${config.createRoot} (name).`,
			);
		if (
			config.name === "save_milestone" &&
			!isCompatibilityString(prepared.projectId)
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
	return defineOperation({
		...sourceExtras({
			...config,
			compatibilityBranches: parameters.compatibilityBranches,
			renderTargetFields: parameters.renderTargetFields,
		}),
		name: config.name,
		resultCategory: "singular",
		canonical: parameters.canonical,
		aliases: [`create_${config.name.slice(5)}`, `update_${config.name.slice(5)}`],
		domain: config.domain,
		purpose: `Create or update ${/^[aeiou]/i.test(config.noun) ? "an" : "a"} ${config.noun}.`,
		parameters: parameters.card,
		acceptedParameters: parameters.accepted,
		example: { operation: config.name, variables: config.example },
		document: createDocument,
		variants: [createVariant, updateVariant],
		resolverPaths: config.resolverPaths,
		requiresVariables: true,
		validateVariables: validateSaveSemantics,
		plan(v) {
			validateSaveSemantics(v);
			const reference = v[parameters.identity];
			const update = isCompatibilityString(reference) && reference.length > 0;
			const prepared = mergedInput(v, [parameters.identity]);
			const projectReference = config.name === "save_milestone" && isCompatibilityString(prepared.projectId)
				? prepared.projectId
				: undefined;
			const issueReferenceValue = config.name === "save_project" && isCompatibilityString(prepared.convertedFromIssueId)
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
					const createVariables: CompatibilityObject = slackChannelName === undefined
						? { input: prepared }
						: { input: prepared, slackChannelName };
					return {
						variant: update ? updateVariant : createVariant,
						variables: update
							? { id: target?.id, input: prepared }
							: createVariables,
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
