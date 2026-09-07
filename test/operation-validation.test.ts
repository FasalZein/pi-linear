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
      `"Invalid parameters for "list_issues": team is required when state is a name. For cross-team calls, use { "assignee": "me", "stateType": "started" }. Valid parameters: canonical fields issues, query, team, state, stateType, assignee, sort, after, before, first, last, includeArchived, orderBy, filter, view. Example: { "operation": "list_issues", "variables": { "assignee": "me", "stateType": "started" } }."`,
    );
    expect(await batchValidationMessage('list_issues', variables)).toMatchInlineSnapshot(
      `"Invalid parameters for "list_issues": team is required when state is a name. For cross-team calls, use { "assignee": "me", "stateType": "started" }. Valid parameters: issues: [IssueReference!] (optional), query: String (optional), team: TeamReference (optional), state: StateReference (optional), stateType: WorkflowStateType (optional), assignee: UserReference (optional), after: String (optional), before: String (optional), first: Int (optional), last: Int (optional), includeArchived: Boolean (optional), orderBy: PaginationOrderBy (optional), filter: Filter (optional), sort: [SortInput!] (optional), view: ResultView (optional). Example: { "operation": "list_issues", "variables": { "assignee": "me", "stateType": "started" } }."`,
    );
    expect(fetch).not.toHaveBeenCalled();
  });
});
