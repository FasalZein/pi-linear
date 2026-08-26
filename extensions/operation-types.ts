import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ExecutionResult } from "graphql";
import type { CanonicalOperation } from "./canonical-schema";
import type { ResultView } from "./selections";
import type { MutationMode } from "./safety";

/** Parsed compatibility JSON owned by OperationDefinition. */
export type CompatibilityValue =
	| string
	| number
	| boolean
	| null
	| readonly CompatibilityValue[]
	| CompatibilityObject;
export type CompatibilityObject = {
	[key: string]: CompatibilityValue | undefined;
};
/** Transport-supplied variables. Parse them at the Operation seam. */
export type UnparsedCompatibilityVariables = {};
/** GraphQL result maps that cross the operation-plan adapter. */
export type GraphQLResultData = NonNullable<ExecutionResult["data"]>;

const OBJECT_TAG = "[object Object]";
const ARRAY_TAG = "[object Array]";
const STRING_TAG = "[object String]";
const NUMBER_TAG = "[object Number]";
const BOOLEAN_TAG = "[object Boolean]";

function typeTag(value: UnparsedCompatibilityVariables | CompatibilityValue | null | undefined): string {
	return Object.prototype.toString.call(value);
}

export function isCompatibilityString(
	value: CompatibilityValue | undefined,
): value is string {
	return typeTag(value) === STRING_TAG;
}

export function isCompatibilityNumber(
	value: CompatibilityValue | undefined,
): value is number {
	return typeTag(value) === NUMBER_TAG;
}

export function isCompatibilityBoolean(
	value: CompatibilityValue | undefined,
): value is boolean {
	return typeTag(value) === BOOLEAN_TAG;
}

export function isCompatibilityObject(
	value: CompatibilityValue | undefined,
): value is CompatibilityObject {
	return typeTag(value) === OBJECT_TAG;
}

function parseCompatibilityValue(
	value: UnparsedCompatibilityVariables | null,
): CompatibilityValue {
	if (value === null) return null;
	const tag = typeTag(value);
	if (tag === STRING_TAG) return value as string;
	if (tag === NUMBER_TAG) return value as number;
	if (tag === BOOLEAN_TAG) return value as boolean;
	if (tag === ARRAY_TAG) {
		const list = value as readonly (UnparsedCompatibilityVariables | null)[];
		return list.map(parseCompatibilityValue);
	}
	if (tag === OBJECT_TAG) return parseCompatibilityObject(value);
	throw new Error(`Unsupported compatibility value: ${tag}`);
}

/** Parse transport or GraphQL maps into the Operation compatibility object. */
export function parseCompatibilityObject(
	value: UnparsedCompatibilityVariables | GraphQLResultData,
): CompatibilityObject {
	if (typeTag(value) !== OBJECT_TAG) return {};
	const parsed: CompatibilityObject = {};
	for (const key of Object.keys(value)) {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (descriptor === undefined || !("value" in descriptor)) continue;
		const entry = descriptor.value as UnparsedCompatibilityVariables | null | undefined;
		if (entry === undefined) continue;
		parsed[key] = parseCompatibilityValue(entry);
	}
	return parsed;
}

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
	variables: CompatibilityObject;
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
	variables: GraphQLResultData;
	resolution?: GraphQLResultData;
	variant?: GraphQLDocumentVariant;
	exactIssue?: ExactIssueCheck;
	exactNamed?: ExactNamedCheck;
	resultView?: ResultView;
	resultCategory?: ResultCategory;
	/** Phase label for the prepared network request after any preparation reads. */
	telemetryPhase?: "read" | "mutation";
	/** Compact result synthesized only after the upstream request passes its checks. */
	acknowledgement?: GraphQLResultData;
	/** Dependent mutations fail instead of acknowledging a partial GraphQL response. */
	requireNoGraphQLErrors?: boolean;
	/** Stable external error for an upstream mutation failure. */
	failureMessage?: string;
};
export type LookupPlan = {
	key: string;
	dependsOn?: readonly string[];
	document: (resolved: GraphQLResultData) => string;
	variables: (resolved: GraphQLResultData) => CompatibilityObject;
	resolve: (
		data: GraphQLResultData,
		resolved: GraphQLResultData,
	) => GraphQLResultData;
	/** Stable external error when the lookup request itself fails. */
	failureMessage?: string;
	/** Preserve an explicit phase label for guarded direct calls. */
	telemetryPhase?: "read";
};
export type OperationPlan = {
	kind: "query" | "mutation";
	lookups: readonly LookupPlan[];
	finish: (resolved: GraphQLResultData) => OperationPreparation;
};
export type ParsedOperationPlanFactory = (
	variables: CompatibilityObject,
) => OperationPlan | Promise<OperationPlan>;
export type OperationPlanFactory = (
	variables: UnparsedCompatibilityVariables,
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
	aliasParameters?: Readonly<{ [name: string]: readonly OperationParameter[] }>;
	example: OperationExample;
	/** Direct typed-tool example override when compatibility variables are not schema-valid. */
	canonicalExample?: CompatibilityObject;
	document: string;
	variants?: readonly GraphQLDocumentVariant[];
	/** Every finite document selected by this operation at runtime. */
	inventoryDocuments?: readonly { id: string; document: string }[];
	pagination?: PaginationMetadata;
	resolverPaths?: Readonly<{ [name: string]: string }>;
	requiresVariables?: boolean;
	validateVariables?: (variables: UnparsedCompatibilityVariables) => void;
	/** Pure operation planning for direct and batch execution. */
	plan?: OperationPlanFactory;
	executeLocal?: (
		variables: UnparsedCompatibilityVariables,
		ctx: ExtensionContext,
		mode: MutationMode,
	) => Promise<CompatibilityObject>;
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
export type OperationSource = Omit<
	LinearOperation,
	| "validateVariables"
	| "plan"
	| "executeLocal"
	| "canonicalExample"
	| "example"
	| "compatibilityBranches"
> & {
	example: OperationExample;
	canonicalExample?: CompatibilityObject;
	compatibilityBranches: readonly RequirementBranch[];
	validateVariables?: (variables: CompatibilityObject) => void;
	plan?: ParsedOperationPlanFactory;
	executeLocal?: (
		variables: CompatibilityObject,
		ctx: ExtensionContext,
		mode: MutationMode,
	) => Promise<CompatibilityObject>;
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
	aliasFields?: Readonly<{ [name: string]: readonly OperationParameter[] }>;
	example: OperationExample;
	document: string;
	inventoryDocuments?: readonly { id: string; document: string }[];
	pagination?: PaginationMetadata;
	resolverPaths?: Readonly<{ [name: string]: string }>;
	/** Derived compatibility flag retained for stable v0.4 diagnostics. */
	requiresVariables?: boolean;
	/** Named semantic exception for checks branches cannot express, such as non-empty text. */
	semanticException?: string;
	semanticValidateVariables?: (variables: CompatibilityObject) => void;
	plan?: ParsedOperationPlanFactory;
	executeLocal?: OperationSource["executeLocal"];
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
		resolverPaths: Readonly<{ [name: string]: string }>;
		plan?: OperationPlanFactory;
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
		example: CompatibilityObject;
	};
};

export const p = (
	name: string,
	type = "String",
	required = false,
): OperationParameter => ({ name, type, required });

export function compactObject(value: CompatibilityObject): CompatibilityObject {
	const compacted: CompatibilityObject = {};
	for (const [key, entry] of Object.entries(value)) {
		if (entry !== undefined) compacted[key] = entry;
	}
	return compacted;
}

export function mergedInput(
	variables: CompatibilityObject,
	omitted: readonly string[],
): CompatibilityObject {
	const raw = isCompatibilityObject(variables.input) ? variables.input : {};
	const skip = new Set([...omitted, "input"]);
	const merged: CompatibilityObject = { ...raw };
	for (const [key, entry] of Object.entries(variables)) {
		if (skip.has(key) || entry === undefined) continue;
		merged[key] = entry;
	}
	return merged;
}

export function paginationVariables(
	variables: CompatibilityObject,
	defaultPageSize: number,
): CompatibilityObject {
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
	...filters: Array<CompatibilityObject | undefined>
): CompatibilityObject | undefined {
	const present = filters.filter((filter): filter is CompatibilityObject =>
		Boolean(filter && Object.keys(filter).length),
	);
	if (!present.length) return undefined;
	if (present.length === 1) return present[0];
	return { and: present };
}
