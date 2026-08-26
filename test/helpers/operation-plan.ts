import type { LinearGraphQLFn } from '../../extensions/client';
import { resolveOperationPlanWithGraphQL } from '../../extensions/operation-plan';
import type {
  LinearOperation,
  OperationPlanFactory,
  OperationPreparation,
} from '../../extensions/operation-types';

/** Plan input exactly as the production plan factory accepts it. */
type PlanVariables = Parameters<OperationPlanFactory>[0];

export async function prepareOperation(
  operation: LinearOperation,
  variables: PlanVariables,
  graphql?: LinearGraphQLFn,
): Promise<OperationPreparation> {
  if (!operation.plan) throw new Error(`${operation.name} has no operation plan.`);
  return resolveOperationPlanWithGraphQL('test-key', await operation.plan(variables), undefined, graphql);
}
