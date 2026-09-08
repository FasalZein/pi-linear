import { afterEach, describe, expect, it, vi } from 'vitest';
import { linearBatchTool, resolveRequest } from '../extensions/api';
import type { CompatibilityObject } from '../extensions/operation-types';

async function batchValidationMessage(operation: string, variables: CompatibilityObject): Promise<string> {
  try {
    await (linearBatchTool() as any).execute(
      'validation-call',
      { operations: [{ key: 'entry', operation, variables }] },
      undefined,
      undefined,
      { hasUI: false },
    );
  } catch (error) {
    if (error instanceof Error) return error.message;
    throw error;
  }
  throw new Error('Expected batch validation to fail.');
}

function namedValidationMessage(operation: string, variables: CompatibilityObject): string {
  try {
    resolveRequest({ operation, variables });
  } catch (error) {
    if (error instanceof Error) return error.message;
    throw error;
  }
  throw new Error('Expected named-request validation to fail.');
}

describe('operation validation messages', () => {
  it('validates canonical relation identities without requiring advanced fields', () => {
    const variables = {
      relationId: '33333333-3333-4333-8333-333333333333',
      issue: '11111111-1111-4111-8111-111111111111',
      relatedIssue: '22222222-2222-4222-8222-222222222222',
      type: 'related',
    };
    expect(() => resolveRequest({ operation: 'delete_issue_relation', variables })).not.toThrow();
    expect(() => resolveRequest({
      operation: 'delete_issue_relation',
      variables: { ...variables, issueId: variables.issue },
    })).toThrow('Duplicate issue identity');
  });

  afterEach(() => vi.unstubAllGlobals());

  it('preserves structural failure messages on the named-request and batch paths', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const variables = { teamKey: 'AEO', extra: true };

    expect(namedValidationMessage('get_issue', variables)).toMatchInlineSnapshot(
      `"Invalid parameters for "get_issue": missing issue; unknown extra. Valid parameters: canonical fields issue, view. Example: { "operation": "get_issue", "variables": { "issue": "AEO-258" } }."`,
    );
    expect(await batchValidationMessage('get_issue', variables)).toMatchInlineSnapshot(
      `"Invalid parameters for "get_issue": missing issue; unknown extra. Valid parameters: issue: IssueReference (required), view: ResultView (optional). Example: { "operation": "get_issue", "variables": { "issue": "AEO-258" } }."`,
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it('preserves semantic failure messages on the named-request and batch paths', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const variables = { state: 'In Progress' };

    expect(namedValidationMessage('list_issues', variables)).toMatchInlineSnapshot(
      `"Invalid parameters for "list_issues": team is required when state is a name. For cross-team calls, use { "assignee": "me", "stateType": "started" }. Valid parameters: canonical fields issues, query, team, state, stateType, assignee, project, sort, first, after, includeArchived, orderBy, filter, view, advanced. Example: { "operation": "list_issues", "variables": { "assignee": "me", "stateType": "started" } }."`,
    );
    expect(await batchValidationMessage('list_issues', variables)).toMatchInlineSnapshot(
      `"Invalid parameters for "list_issues": team is required when state is a name. For cross-team calls, use { "assignee": "me", "stateType": "started" }. Valid parameters: issues: [IssueReference!] (optional), query: String (optional), team: TeamReference (optional), state: StateReference (optional), stateType: WorkflowStateType (optional), assignee: UserReference (optional), after: String (optional), before: String (optional), first: Int (optional), last: Int (optional), includeArchived: Boolean (optional), orderBy: PaginationOrderBy (optional), filter: Filter (optional), sort: [SortInput!] (optional), view: ResultView (optional). Example: { "operation": "list_issues", "variables": { "assignee": "me", "stateType": "started" } }."`,
    );
    expect(fetch).not.toHaveBeenCalled();
  });
});
