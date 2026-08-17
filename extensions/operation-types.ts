import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

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
export type OperationPreparation = {
	variables: Record<string, unknown>;
	resolution?: Record<string, unknown>;
	document?: string;
};
export type PaginationMetadata = {
	defaultPageSize: number;
	filterType?: string;
	sortType?: string;
	sortKeys?: readonly string[];
};
export type LinearOperation = {
	name: string;
	aliases: readonly string[];
	domain: OperationDomain;
	purpose: string;
	parameters: readonly OperationParameter[];
	acceptedParameters?: readonly OperationParameter[];
	legacyParameters?: readonly (readonly OperationParameter[])[];
	aliasParameters?: Readonly<Record<string, readonly OperationParameter[]>>;
	example: OperationExample;
	document: string;
	documents?: readonly string[];
	mutationRoots: readonly string[];
	pagination?: PaginationMetadata;
	resolverPaths?: Readonly<Record<string, string>>;
	requiresVariables?: boolean;
	validateVariables?: (variables: Record<string, unknown>) => void;
	prepare?: (
		apiKey: string,
		variables: Record<string, unknown>,
		signal: AbortSignal | undefined,
	) => Promise<OperationPreparation>;
	executeLocal?: (
		variables: Record<string, unknown>,
		ctx: ExtensionContext,
	) => Promise<Record<string, unknown>>;
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
