import type { LinearGraphQLFn } from '../../extensions/client';
import { resolveOperationPlanWithGraphQL } from '../../extensions/operation-plan';
import type { LinearOperation, OperationPreparation } from '../../extensions/operation-types';

export async function prepareOperation(
  operation: LinearOperation,
  variables: Record<string, unknown>,
  graphql?: LinearGraphQLFn,
): Promise<OperationPreparation> {
  if (!operation.plan) throw new Error(`${operation.name} has no operation plan.`);
  return resolveOperationPlanWithGraphQL('test-key', await operation.plan(variables), undefined, graphql);
}
