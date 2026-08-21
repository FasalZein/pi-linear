import type {
	LinearOperation,
	OperationDefinition,
	OperationDomain,
	OperationParameter,
} from "../operation-types";
export type {
	LinearOperation,
	OperationDomain,
	OperationParameter,
} from "../operation-types";
import { projectCompatibilityOperation } from "../operation-definition";
export { projectCompatibilityOperation };
import { comments } from "./comments";
import { cycles } from "./cycles";
import { documents } from "./documents";
import { initiativeReads, initiativeSaves } from "./initiatives";
import { issues } from "./issues";
import { issueLabels, projectLabels } from "./labels";
import { milestoneReads, milestoneSaves } from "./milestones";
import { projectReads, projectSaves } from "./projects";
import { issueRelations, projectRelations } from "./relations";
import { teams } from "./teams";
import { users } from "./users";
import { views } from "./views";
import { issueStatuses, workspaceSwitch } from "./workspace";

export const BATCH_HELP_EXAMPLE = {
	operation: "batch",
	variables: {
		reads: [{ key: "issue", operation: "get_issue", variables: { issue: "AEO-258" } }],
		mutations: [{
			key: "remove",
			operation: "delete_issue_relation",
			variables: {
				relationId: "11111111-1111-4111-8111-111111111111",
				issueId: "22222222-2222-4222-8222-222222222222",
				relatedIssueId: "33333333-3333-4333-8333-333333333333",
				type: "related",
			},
		}],
	},
} as const;

export const DOMAINS = [
	"issues",
	"comments",
	"users",
	"teams",
	"projects",
	"cycles",
	"milestones",
	"initiatives",
	"documents",
	"views",
	"labels",
	"relations",
	"workspace",
] as const satisfies readonly OperationDomain[];

export const operationDefinitions: readonly OperationDefinition[] = [
	...comments,
	...views,
	...cycles,
	...documents,
	...initiativeReads,
	...issueLabels,
	...issueRelations,
	...issueStatuses,
	...issues,
	...milestoneReads,
	...projectLabels,
	...projectRelations,
	...projectReads,
	...teams,
	...users,
	...workspaceSwitch,
	...initiativeSaves,
	...milestoneSaves,
	...projectSaves,
];

export const operations = Object.fromEntries(
	operationDefinitions.map((definition) => [
		definition.name,
		projectCompatibilityOperation(definition),
	]),
) as Record<string, LinearOperation>;
export type OperationName = keyof typeof operations;
const aliases = new Map<string, LinearOperation>();
for (const definition of operationDefinitions) {
	const operation = operations[definition.name]!;
	for (const alias of definition.compatibility.operationAliases)
		aliases.set(alias, operation);
}

export function getOperation(name: string): LinearOperation {
	const operation = operations[name] ?? aliases.get(name);
	if (!operation)
		throw new Error(
			`Unknown Linear operation "${name}". Send { "operation": "help" }.`,
		);
	return operation;
}

export function getOperationDefinition(name: string): OperationDefinition {
	const operation = getOperation(name);
	const definition = operationDefinitions.find(({ name: canonicalName }) =>
		canonicalName === operation.name,
	);
	if (!definition) throw new Error(`Missing operation definition for "${operation.name}".`);
	return definition;
}

export function operationSignature(operation: LinearOperation): string {
	return `${operation.name}(${Object.entries(operation.canonical.fields)
		.map(([name, type]) => `${name}${operation.canonical.branches.every((branch) => branch.includes(name)) ? "" : "?"}: ${type}`)
		.join(", ")})`;
}
export function formatInvocation(value: unknown): string {
	if (Array.isArray(value))
		return `[${value.map(formatInvocation).join(", ")}]`;
	if (value && typeof value === "object")
		return `{ ${Object.entries(value as Record<string, unknown>)
			.map(
				([key, entry]) => `${JSON.stringify(key)}: ${formatInvocation(entry)}`,
			)
			.join(", ")} }`;
	return JSON.stringify(value);
}
export function parameterShapes(
	operation: LinearOperation,
	requestedName: string,
): readonly (readonly OperationParameter[])[] {
	const required = new Set(
		operation.parameters
			.filter((parameter) => parameter.required)
			.map(({ name }) => name),
	);
	const canonicalShape = (
		operation.acceptedParameters ?? operation.parameters
	).map((parameter) => ({
		...parameter,
		required: required.has(parameter.name),
	}));
	const aliasShape = operation.aliasParameters?.[requestedName];
	if (aliasShape) return [canonicalShape, aliasShape];
	const legacyShapes = (operation.legacyParameters ?? []).map((shape) => {
		if (shape.length !== 1 || shape[0]?.name !== "input" || !shape[0].required)
			return shape;
		const accepted = operation.acceptedParameters ?? operation.parameters;
		return accepted.map((parameter) => ({
			...parameter,
			required: parameter.name === "input",
		}));
	});
	return [canonicalShape, ...legacyShapes];
}
export function operationsForDomain(
	domain: OperationDomain,
): LinearOperation[] {
	return operationDefinitions
		.filter((definition) => definition.domain === domain)
		.map(projectCompatibilityOperation);
}
export function operationDocuments(
	operation: LinearOperation,
): readonly string[] {
	return operation.variants?.map(({ document }) => document) ?? [operation.document];
}

export const BATCH_MUTATION_ROOTS = ["issueBatchCreate"] as const;
export const SAFE_NAMED_MUTATION_ROOTS = new Set([
	...operationDefinitions.flatMap((definition) =>
		definition.graphql?.documents
			.filter(({ kind }) => kind === "mutation")
			.map(({ root }) => root) ?? [],
	),
	...BATCH_MUTATION_ROOTS,
]);
