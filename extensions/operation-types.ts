import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CanonicalOperation } from "./canonical-schema";
import type { ResultView } from "./selections";

export type OperationDomain =
	| "issues"
	| "comments"
	| "users"
	| "teams"
	| "projects"
	| "cycles"
	| "milestones"
	| "initiatives"
	| "documents"
	| "views"
	| "labels"
	| "relations"
	| "workspace";
export type OperationParameter = {
	name: string;
	type: string;
	required: boolean;
};
export type OperationExample = {
	operation: string;
	variables: Record<string, unknown>;
};
export type MutationResultExpectation = {
	successPath: string;
	successValue: true;
	requiredEntityPaths: readonly string[];
};
export type GraphQLDocumentVariant = {
	when?: "create" | "update";
	document: string;
	root: string;
	mutationResult?: MutationResultExpectation;
};
/** What a local operation must return before its result is redacted or routed. */
export type LocalResultExpectation = {
	requiredStringPaths: readonly string[];
};
export type ExactIssueCheck = {
	requested: string;
	path: string;
};
export type ExactNamedCheck = {
	requested: string;
	path: string;
	kind: "project" | "cycle" | "document";
};
export type ResultCategory = "singular" | "collection" | "local";
export type NamedInputPolicy = "non-destructive" | "guarded-destructive";
export type OperationPreparation = {
	variables: Record<string, unknown>;
	resolution?: Record<string, unknown>;
	variant?: GraphQLDocumentVariant;
	exactIssue?: ExactIssueCheck;
	exactNamed?: ExactNamedCheck;
	resultView?: ResultView;
	resultCategory?: ResultCategory;
	/** Phase label for the prepared network request after any preparation reads. */
	telemetryPhase?: "read" | "mutation";
	/** Compact result synthesized only after the upstream request passes its checks. */
	acknowledgement?: Record<string, unknown>;
	/** Dependent mutations fail instead of acknowledging a partial GraphQL response. */
	requireNoGraphQLErrors?: boolean;
	/** Stable external error for an upstream mutation failure. */
	failureMessage?: string;
};
export type LookupPlan = {
	key: string;
	dependsOn?: readonly string[];
	document: (resolved: Readonly<Record<string, unknown>>) => string;
	variables: (resolved: Readonly<Record<string, unknown>>) => Record<string, unknown>;
	resolve: (
		data: Record<string, unknown>,
		resolved: Readonly<Record<string, unknown>>,
	) => unknown;
	/** Stable external error when the lookup request itself fails. */
	failureMessage?: string;
	/** Preserve an explicit phase label for guarded direct calls. */
	telemetryPhase?: "read";
};
export type OperationPlan = {
	kind: "query" | "mutation";
	lookups: readonly LookupPlan[];
	finish: (resolved: Readonly<Record<string, unknown>>) => OperationPreparation;
};
export type OperationPlanFactory = (
	variables: Record<string, unknown>,
) => OperationPlan | Promise<OperationPlan>;

export type PaginationMetadata = {
	defaultPageSize: number;
	filterType?: string;
	sortType?: string;
	sortKeys?: readonly string[];
};
export type LinearOperation = {
	name: string;
	resultCategory: ResultCategory;
	/** Safety class for named input. Ordinary operations use the default non-destructive class. */
	namedInputPolicy?: NamedInputPolicy;
	canonical: CanonicalOperation;
	aliases: readonly string[];
	domain: OperationDomain;
	purpose: string;
	parameters: readonly OperationParameter[];
	acceptedParameters?: readonly OperationParameter[];
	legacyParameters?: readonly (readonly OperationParameter[])[];
	aliasParameters?: Readonly<Record<string, readonly OperationParameter[]>>;
	example: OperationExample;
	document: string;
	variants?: readonly GraphQLDocumentVariant[];
	pagination?: PaginationMetadata;
	resolverPaths?: Readonly<Record<string, string>>;
	requiresVariables?: boolean;
	validateVariables?: (variables: Record<string, unknown>) => void;
	/** Pure operation planning for direct and batch execution. */
	plan?: OperationPlanFactory;
	executeLocal?: (
		variables: Record<string, unknown>,
		ctx: ExtensionContext,
	) => Promise<Record<string, unknown>>;
	/** Required whenever `executeLocal` is set. */
	localResult?: LocalResultExpectation;
	/**
	 * Compatibility and projection metadata that used to live in operation-keyed
	 * catalogs. It is authored here, beside the operation it describes, so one
	 * editable source owns every per-operation decision.
	 */
	compatibilityBranches?: readonly RequirementBranch[];
	/** Named semantic exception for checks branches cannot express. */
	semanticException?: string;
	/** Render kind override when the operation name does not project it. */
	renderKind?: string;
	renderTargetFields?: readonly string[];
	renderEmpty?: OperationEmptyState;
};

/** An authored operation: every per-operation decision is declared in one place. */
export type OperationSource = LinearOperation & {
	compatibilityBranches: readonly RequirementBranch[];
};

export type OperationKind = "query" | "mutation" | "local";

export type OperationDocumentDefinition = GraphQLDocumentVariant & {
	kind: "query" | "mutation";
};

export type OperationEmptyState = {
	fact: string;
	action: string;
	filteredFact: string;
	filteredAction: string;
};
export type RequirementBranch = {
	all: readonly string[];
	exactlyOneOf?: readonly (readonly string[])[];
	exactlyOneOfMessages?: readonly string[];
	atLeastOneOf?: readonly string[];
	atLeastOneOfMessage?: string;
	forbidden?: readonly string[];
	mode?: "create" | "update";
};

export type OperationCompatibilityDefinition = {
	operationAliases: readonly string[];
	fields: readonly OperationParameter[];
	branches: readonly RequirementBranch[];
	acceptedFields?: readonly OperationParameter[];
	legacyBranches?: readonly (readonly OperationParameter[])[];
	aliasFields?: Readonly<Record<string, readonly OperationParameter[]>>;
	example: OperationExample;
	document: string;
	pagination?: PaginationMetadata;
	resolverPaths?: Readonly<Record<string, string>>;
	/** Derived compatibility flag retained for stable v0.4 diagnostics. */
	requiresVariables?: boolean;
	/** Named semantic exception for checks branches cannot express, such as non-empty text. */
	semanticException?: string;
	semanticValidateVariables?: LinearOperation["validateVariables"];
	plan?: LinearOperation["plan"];
	executeLocal?: LinearOperation["executeLocal"];
	localResult?: LocalResultExpectation;
};

export type OperationDefinition = {
	name: string;
	toolName: `linear_${string}`;
	domain: OperationDomain;
	purpose: string;
	kind: OperationKind;
	compatibility: OperationCompatibilityDefinition;
	graphql?: { documents: readonly OperationDocumentDefinition[] };
	preparation: {
		resolverPaths: Readonly<Record<string, string>>;
		plan?: LinearOperation["plan"];
	};
	safety: {
		namedInputPolicy: NamedInputPolicy;
		mutation: boolean;
	};
	result: {
		category: ResultCategory;
		renderKind: string;
		dataPaths: readonly string[];
		/** Present for local operations; enforced before redaction and routing. */
		local?: LocalResultExpectation;
	};
	render: {
		entityKind: string;
		callFields: readonly string[];
		action: string;
		targetFields?: readonly string[];
		empty?: OperationEmptyState;
	};
	canonical: {
		fields: readonly OperationParameter[];
		branches: readonly RequirementBranch[];
		exclusiveBranches?: true;
		variants?: readonly {
			fields: readonly string[];
			branches: readonly RequirementBranch[];
		}[];
		strictRawArguments: true;
		example: Record<string, unknown>;
	};
};

export const p = (
	name: string,
	type = "String",
	required = false,
): OperationParameter => ({ name, type, required });

export function compactObject(
	value: Record<string, unknown>,
): Record<string, unknown> {
	return Object.fromEntries(
		Object.entries(value).filter(([, entry]) => entry !== undefined),
	);
}

export function mergedInput(
	variables: Record<string, unknown>,
	omitted: readonly string[],
): Record<string, unknown> {
	const raw =
		variables.input &&
		typeof variables.input === "object" &&
		!Array.isArray(variables.input)
			? (variables.input as Record<string, unknown>)
			: {};
	const skip = new Set([...omitted, "input"]);
	return {
		...raw,
		...compactObject(
			Object.fromEntries(
				Object.entries(variables).filter(([key]) => !skip.has(key)),
			),
		),
	};
}

export function paginationVariables(
	variables: Record<string, unknown>,
	defaultPageSize: number,
): Record<string, unknown> {
	const backward =
		variables.before !== undefined || variables.last !== undefined;
	const forward =
		variables.after !== undefined || variables.first !== undefined;
	if (backward && forward)
		throw new Error(
			"Use either forward pagination (first/after) or backward pagination (last/before), not both.",
		);
	return compactObject({
		after: backward ? undefined : variables.after,
		before: backward ? variables.before : undefined,
		first: backward ? undefined : (variables.first ?? defaultPageSize),
		last: backward ? (variables.last ?? defaultPageSize) : undefined,
		includeArchived: variables.includeArchived,
		orderBy: variables.orderBy,
	});
}

export function mergeFilters(
	...filters: Array<Record<string, unknown> | undefined>
): Record<string, unknown> | undefined {
	const present = filters.filter((filter): filter is Record<string, unknown> =>
		Boolean(filter && Object.keys(filter).length),
	);
	if (!present.length) return undefined;
	if (present.length === 1) return present[0];
	return { and: present };
}
