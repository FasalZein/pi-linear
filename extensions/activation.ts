import { operationDefinitions, operations, operationSignature, type LinearOperation } from './operations';
import { DEFINITION_ACTIONS, DEFINITION_ENTITIES } from './definition-discovery';

/**
 * Deterministic activation for natural help requests.
 *
 * A clause activates a typed tool only when one action and one entity together name
 * exactly one catalog operation. Anything vaguer — a bare noun, an unknown verb, two
 * possible entities — activates nothing and returns ranked candidates for discovery,
 * because loading a schema the task does not need costs context and invites the model
 * to call the wrong tool.
 */

/** Ordered phrase precedence stays declarative and shared by all definitions. */
const ACTIONS = DEFINITION_ACTIONS;
const ENTITIES = DEFINITION_ENTITIES;

/** action + entity → operation, generated from OperationDefinition.discovery. */
const OPERATION_BY_INTENT: Record<string, string> = Object.fromEntries(
  operationDefinitions.flatMap((definition) => definition.discovery.intents.map(({ action, entity }) => [
    `${action} ${entity}`,
    definition.name,
  ])),
);

/** Pronouns that carry the entity of the previous clause, and nothing else. */
const CARRIED_PRONOUN = /\b(?:it|them)\b/i;

export type ClauseResolution = {
  clause: string;
  action?: string;
  entity?: string;
  operation?: string;
};

/** Sentence boundaries, semicolons, and explicit sequencing words. */
export function splitClauses(query: string): string[] {
  return query
    .split(/(?:[.!?;\n]+|\band then\b|\bthen\b)/i)
    .map((clause) => clause.trim())
    .filter(Boolean);
}

function matchFirst(map: ReadonlyArray<readonly [RegExp, string]>, clause: string): string | undefined {
  for (const [pattern, value] of map) {
    const caseInsensitive = pattern.ignoreCase
      ? pattern
      : new RegExp(pattern.source, `${pattern.flags}i`);
    if (caseInsensitive.test(clause)) return value;
  }
  return undefined;
}

function entityOf(clause: string): string | undefined {
  // Longest-phrase entities first: the map is ordered, and a two-word entity such as
  // "issue labels" must win over the "labels" fallback in the same clause.
  return matchFirst(ENTITIES, clause);
}

/** Resolve one clause. `operation` is set only when the intent is unambiguous. */
export function resolveClause(clause: string, carriedEntity?: string): ClauseResolution {
  const action = matchFirst(ACTIONS, clause);
  const explicitEntity = entityOf(clause);
  const entity = explicitEntity ?? (CARRIED_PRONOUN.test(clause) ? carriedEntity : undefined);
  if (!action || !entity) return { clause, action, entity };
  const operation = OPERATION_BY_INTENT[`${action} ${entity}`];
  return { clause, action, entity, operation };
}

/** Ranked discovery candidates for a request that named no single operation. */
export function candidatesFor(query: string): LinearOperation[] {
  const words = new Set(
    query
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length > 2),
  );
  const score = (operation: LinearOperation): number => {
    const name = new Set(operation.name.split('_'));
    const purpose = new Set(operation.purpose.toLowerCase().split(/[^a-z0-9]+/));
    return [...words].reduce(
      (total, word) => total + (name.has(word) ? 8 : 0) + (operation.domain === word ? 4 : 0)
        + (purpose.has(word) ? 1 : 0),
      0,
    );
  };
  return Object.values(operations)
    .map((operation) => ({ operation, score: score(operation) }))
    .filter(({ score: value }) => value > 0)
    .sort((left, right) => right.score - left.score || (left.operation.name < right.operation.name ? -1 : 1))
    .map(({ operation }) => operation);
}

export type ActivationPlan = {
  clauses: ClauseResolution[];
  /** Catalog operation names to activate, in clause order, deduplicated. */
  operationNames: string[];
  candidates: LinearOperation[];
};

/**
 * Plan the activation for one natural help query: resolve every clause, union the
 * unambiguous winners in clause order, and offer candidates when nothing resolved.
 */
export function planActivation(query: string): ActivationPlan {
  const clauses: ClauseResolution[] = [];
  const operationNames: string[] = [];
  let carriedEntity: string | undefined;

  for (const clause of splitClauses(query)) {
    const resolution = resolveClause(clause, carriedEntity);
    clauses.push(resolution);
    if (resolution.entity) carriedEntity = resolution.entity;
    if (resolution.operation && !operationNames.includes(resolution.operation)) {
      operationNames.push(resolution.operation);
    }
  }

  return {
    clauses,
    operationNames,
    candidates: operationNames.length ? [] : candidatesFor(query),
  };
}

export function candidateSummary(operation: LinearOperation) {
  return { name: operation.name, signature: operationSignature(operation) };
}
