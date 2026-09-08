import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isJsonObject, type JsonObject, type JsonValue } from "./json";
import type { CanonicalOperation } from "./canonical-schema";
import type { ResultView } from "./selections";
import type { MutationMode } from "./safety";

/** Parsed compatibility JSON owned by OperationDefinition. `json.ts` owns the parser. */
export type CompatibilityValue = JsonValue;
export type CompatibilityObject = JsonObject;

const STRING_TAG = "[object String]";
const NUMBER_TAG = "[object Number]";
const BOOLEAN_TAG = "[object Boolean]";

function typeTag(value: CompatibilityValue | undefined): string {
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
	return isJsonObject(value);
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
/** An authored preparation field whose type determines its generated resolver label. */
export type OperationReferenceField = {
	name: string;
	type: `${string}Reference`;
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
	variables: CompatibilityObject;
	resolution?: CompatibilityObject;
	variant?: GraphQLDocumentVariant;
	exactIssue?: ExactIssueCheck;
	exactNamed?: ExactNamedCheck;
	resultView?: ResultView;
	resultCategory?: ResultCategory;
	/** Phase label for the prepared network request after any preparation reads. */
	telemetryPhase?: "read" | "mutation";
	/** Compact result synthesized only after the upstream request passes its checks. */
	acknowledgement?: CompatibilityObject;
	/** Dependent mutations fail instead of acknowledging a partial GraphQL response. */
	requireNoGraphQLErrors?: boolean;
	/** Stable external error for an upstream mutation failure. */
	failureMessage?: string;
};
export type LookupPlan = {
	key: string;
	dependsOn?: readonly string[];
	document: (resolved: CompatibilityObject) => string;
	variables: (resolved: CompatibilityObject) => CompatibilityObject;
	resolve: (
		data: CompatibilityObject,
		resolved: CompatibilityObject,
	) => CompatibilityObject;
	/** Stable external error when the lookup request itself fails. */
	failureMessage?: string;
	/** Preserve an explicit phase label for guarded direct calls. */
	telemetryPhase?: "read";
};
export type OperationPlan = {
	kind: "query" | "mutation";
	lookups: readonly LookupPlan[];
	finish: (resolved: CompatibilityObject) => OperationPreparation;
};
export type ParsedOperationPlanFactory = (
	variables: CompatibilityObject,
) => OperationPlan | Promise<OperationPlan>;
export type OperationPlanFactory = (
	variables: JsonValue | undefined,
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
	validateVariables?: (variables: JsonValue | undefined) => void;
	/** Pure operation planning for direct and batch execution. */
	plan?: OperationPlanFactory;
	/** A declared result is not proof: the runtime parses it before it is redacted or routed. */
	executeLocal?: (
		variables: JsonValue | undefined,
		ctx: ExtensionContext,
		mode: MutationMode,
	) => Promise<JsonObject>;
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
	| "resolverPaths"
> & {
	example: OperationExample;
	referenceFields: readonly OperationReferenceField[];
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
		/** Authored field types retained so generation can prove resolver declarations. */
		referenceFields: readonly OperationReferenceField[];
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
		advancedFields: readonly OperationParameter[];
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
