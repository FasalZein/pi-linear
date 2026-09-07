import { isCompatibilityObject, isCompatibilityString } from './operation-types';
import type {
  CompatibilityObject,
  GraphQLDocumentVariant,
  OperationParameter,
  ParsedOperationPlanFactory,
} from './operation-types';
import { parseResultView } from './selections';

export const MUTATION_VIEW_PARAMETER: OperationParameter = {
  name: 'view',
  type: 'ResultView',
  required: false,
};

const ACKNOWLEDGEMENT_FIELDS = [
  'id',
  'key',
  'identifier',
  'slug',
  'slugId',
  'title',
  'name',
  'url',
  'type',
  'modelName',
  'createdAt',
  'updatedAt',
  'resolvedAt',
] as const;

const ACKNOWLEDGEMENT_RELATIONS = [
  'issue',
  'relatedIssue',
  'project',
  'relatedProject',
  'projectMilestone',
  'relatedProjectMilestone',
  'initiative',
  'cycle',
  'team',
  'parent',
  'user',
  'owner',
] as const;

function withoutMutationView(variables: CompatibilityObject): CompatibilityObject {
  const forwarded: CompatibilityObject = {};
  for (const [name, value] of Object.entries(variables)) {
    if (name !== 'view') forwarded[name] = value;
  }
  return forwarded;
}

/** Keep the result control outside GraphQL variables and attach it after all lookups finish. */
export function withMutationResultView(plan: ParsedOperationPlanFactory): ParsedOperationPlanFactory {
  return async (variables) => {
    const view = parseResultView(variables.view, 'summary');
    const preparedPlan = await plan(withoutMutationView(variables));
    return {
      ...preparedPlan,
      finish(resolved) {
        const prepared = preparedPlan.finish(resolved);
        return { ...prepared, resultView: prepared.resultView ?? view };
      },
    };
  };
}

function compactEntity(entity: CompatibilityObject): CompatibilityObject {
  const compact: CompatibilityObject = {};
  for (const key of ACKNOWLEDGEMENT_FIELDS) {
    const value = entity[key];
    if (value !== undefined) compact[key] = value;
  }
  for (const key of ACKNOWLEDGEMENT_RELATIONS) {
    const value = entity[key];
    if (!isCompatibilityObject(value)) continue;
    const related = compactEntity(value);
    if (Object.keys(related).length) compact[key] = related;
  }
  return compact;
}

function objectAtPath(value: CompatibilityObject, path: string): CompatibilityObject | undefined {
  let current: CompatibilityObject = value;
  for (const part of path.split('.')) {
    const next = current[part];
    if (!isCompatibilityObject(next)) return undefined;
    current = next;
  }
  return current;
}

/**
 * Build a short result only from a mutation payload that already passed its result contract.
 * Every required entity must still carry a server identity before this function acknowledges it.
 */
export function mutationAcknowledgement(
  operationName: string,
  data: CompatibilityObject,
  variant: GraphQLDocumentVariant,
): CompatibilityObject {
  const expectation = variant.mutationResult;
  if (!expectation) return data;
  const payload = objectAtPath(data, variant.root);
  if (!payload) return data;

  const acknowledgementPayload: CompatibilityObject = {
    [expectation.successPath]: expectation.successValue,
  };
  for (const entityPath of expectation.requiredEntityPaths) {
    const entity = objectAtPath(payload, entityPath);
    const id = entity?.id;
    if (!entity || !isCompatibilityString(id) || !id.trim()) {
      throw new Error(
        `Linear operation "${operationName}" failed acknowledgement expectation: `
        + `${variant.root}.${entityPath}.id must be a non-empty string.`,
      );
    }
    acknowledgementPayload[entityPath] = compactEntity(entity);
  }
  return { [variant.root]: acknowledgementPayload };
}
