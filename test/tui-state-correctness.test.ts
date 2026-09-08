import { afterEach, describe, expect, it, vi } from 'vitest';
import { linearGraphQL } from '../extensions/client';
import { getOperation } from '../extensions/operations';
import { operationRenderers, renderLinearApiResult, renderLinearGraphqlResult } from '../extensions/renderers';
import { priorityStyle, statusStyle } from '../extensions/renderers/entities';
import type { JsonObject } from '../extensions/runtime';

const plainTheme = {
  fg: (_role: string, text: string) => text,
  bg: (_role: string, text: string) => text,
  bold: (text: string) => text,
  italic: (text: string) => text,
  underline: (text: string) => text,
} as any;

const taggedTheme = {
  ...plainTheme,
  fg: (role: string, text: string) => `<${role}>${text}</${role}>`,
} as any;

const meta = { truncations: [], stringsClipped: 0 };
const widths = [200, 120, 100, 80, 60, 40, 30, 26, 20, 12];

afterEach(() => vi.unstubAllGlobals());

function result<T>(details: T) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(details) }], details } as any;
}

function typed<T>(
  operation: string,
  details: T,
  args: JsonObject = {},
  theme = plainTheme,
  isError = false,
) {
  return operationRenderers(getOperation(operation)).renderResult(
    result(details),
    { expanded: false, isPartial: false },
    theme,
    { args, isError } as any,
  );
}

function api<T>(details: T, args: JsonObject, theme = plainTheme, isError = false) {
  return renderLinearApiResult(
    result(details),
    { expanded: false, isPartial: false },
    theme,
    { args, isError } as any,
  );
}

function graphql<T>(details: T, args: JsonObject, theme = plainTheme, isError = false) {
  return renderLinearGraphqlResult(
    result(details),
    { expanded: false, isPartial: false },
    theme,
    { args, isError } as any,
  );
}

function text(component: any, width = 120): string {
  return component.render(width).join('\n');
}

function compact(component: any, width: number): string {
  return component.render(width).join('').replace(/\s/g, '');
}

describe('v0.6 state correctness', () => {
  it('renders a null single-entity root as a dedicated typed not-found state', () => {
    const details = { data: { issue: null }, meta };
    for (const component of [typed('get_issue', details, { issue: 'AEO-404' })]) {
      const rendered = text(component);
      expect(rendered).toContain('✗ Issue not found');
      expect(rendered).toContain('AEO-404');
      expect(rendered).toContain('exact issue reference');
      expect(rendered).not.toContain('"issue":null');
    }
  });

  it('uses exact semantic theme roles for health, lifecycle status, and urgent priority', () => {
    expect(statusStyle(taggedTheme, 'On track')('On track')).toContain('<success>');
    expect(statusStyle(taggedTheme, 'onTrack')('onTrack')).toContain('<success>');
    expect(statusStyle(taggedTheme, 'Healthy')('Healthy')).toContain('<success>');
    expect(statusStyle(taggedTheme, 'At risk')('At risk')).toContain('<warning>');
    expect(statusStyle(taggedTheme, 'atRisk')('atRisk')).toContain('<warning>');
    expect(statusStyle(taggedTheme, 'Active')('Active')).toContain('<warning>');
    for (const value of ['Off track', 'Blocked', 'Canceled', 'Cancelled']) {
      expect(statusStyle(taggedTheme, value)(value)).toContain('<error>');
    }
    expect(priorityStyle(taggedTheme, 'Urgent')('Urgent')).toContain('<warning>');
    expect(priorityStyle(taggedTheme, 'Urgent')('Urgent')).not.toContain('<error>');

    const projects = text(typed('list_projects', {
      data: { projects: { nodes: [
        { id: 'p1', name: 'Healthy project', health: 'onTrack' },
        { id: 'p2', name: 'Risk project', health: 'atRisk' },
        { id: 'p3', name: 'Failed project', health: 'offTrack' },
      ] } },
      meta,
    }, {}, taggedTheme), 200);
    expect(projects).toContain('<success>On track</success>');
    expect(projects).toContain('<warning>At risk</warning>');
    expect(projects).toContain('<error>Off track</error>');

    const issueComponent = typed('list_issues', {
      data: { issues: { nodes: [{
        id: 'i1', identifier: 'AEO-1', title: 'Urgent issue', priorityLabel: 'Urgent', state: { name: 'Blocked' },
      }] } },
      meta,
    }, {}, taggedTheme);
    for (const width of [200, 120]) {
      const issues = text(issueComponent, width);
      expect(issues).toContain('<warning>Urgent</warning>');
      expect(issues).toContain('<error>Blocked</error>');
      expect(issues).not.toContain('<error>Urgent</error>');
    }
  });

  it('echoes mutation targets without entities and marks unknown confirmation as warning', () => {
    const success = text(typed(
      'update_issue',
      { data: { issueUpdate: { success: true, issue: null } }, meta },
      { issue: 'AEO-258', title: 'Changed' },
    ));
    expect(success).toContain('✓ Updated issue AEO-258');

    const resolved = text(typed(
      'update_issue',
      {
        data: { issueUpdate: { success: true, issue: null } },
        resolution: { target: { requested: '258', identifier: 'AEO-258' } },
        meta,
      },
      { issue: '258' },
    ));
    expect(resolved).toContain('AEO-258');

    const unknown = text(typed('update_issue', { data: { issueUpdate: { success: false } }, meta }, {}, taggedTheme));
    expect(unknown).toContain('<warning>! Updated issue: status unknown</warning>');

    const missingConfirmation = text(typed(
      'update_issue',
      { data: { issueUpdate: {} }, meta },
      { issue: 'AEO-258' },
    ));
    expect(missingConfirmation).toContain('! Updated issue AEO-258: status unknown');
    expect(missingConfirmation).not.toContain('"issueUpdate"');

    const document = text(typed(
      'update_document',
      { data: { documentUpdate: { success: true, document: null } }, meta },
      { documentId: 'doc-123', title: 'Replacement title' },
    ));
    expect(document).toContain('✓ Updated document doc-123');
    expect(document).not.toContain('Replacement title');

    const cycle = text(typed(
      'update_cycle',
      { data: { cycleUpdate: { success: true, cycle: null } }, meta },
      { id: 'cycle-7', name: 'Renamed cycle' },
    ));
    expect(cycle).toContain('✓ Updated cycle cycle-7');
  });

  it('branches recovery by cause and never gives parameter advice for policy blocks', () => {
    const cases = [
      ['Linear mutations are disabled by read-only mode.', 'mutation-enabled entry point'],
      ['Destructive named input is unavailable at variables.trashed.', 'authorized raw GraphQL mutation'],
      ['Mutation root issueDelete is not allowed.', 'supported named operation'],
      ['Generated tool manifest configuration excluded a filtered tool.', 'generated tool manifest'],
      ['Unknown parameters for update_issue: icon', 'Remove the unaccepted parameters'],
      ['Linear issue "AEO-404" was not found.', 'exact issue reference'],
      ['Linear authentication failed: invalid credential', '/linear-auth'],
      ['Linear network error: connection reset', 'Retry'],
      ['Linear GraphQL error: service unavailable', 'Retry'],
      ['Linear request failed unexpectedly', 'parameter card'],
    ] as const;
    for (const [message, recovery] of cases) {
      const rendered = text(typed('update_issue', { error: message }, { issue: 'AEO-258' }, plainTheme, true));
      expect(rendered).toContain(recovery);
      if (message.includes('read-only') || message.includes('not allowed')) {
        expect(rendered).not.toContain('Fix the parameters');
      }
    }

    for (const status of ['429 Too Many Requests', '502 Bad Gateway', '408 Request Timeout']) {
      const rendered = text(typed('get_issue', { error: `Linear API request failed: ${status}` }, {}, plainTheme, true));
      expect(rendered).toContain('Retry the same request');
      expect(rendered).not.toContain('parameter card');
    }
    for (const status of ['401 Unauthorized', '403 Forbidden']) {
      const rendered = text(typed('get_issue', { error: `Linear API request failed: ${status}` }, {}, plainTheme, true));
      expect(rendered).toContain('/linear-auth');
      expect(rendered).not.toContain('parameter card');
    }
    const stableHttp = text(typed(
      'get_issue',
      { error: 'Linear API request failed: 422 service unavailable' },
      {},
      plainTheme,
      true,
    ));
    expect(stableHttp).toContain('Review the request and Linear server response');
    expect(stableHttp).not.toContain('Retry the same request');
    expect(stableHttp).not.toContain('parameter card');

    const typedRawMutation = text(typed(
      'get_issue',
      { error: 'Raw Linear mutations are disabled.' },
      {},
      plainTheme,
      true,
    ));
    expect(typedRawMutation).toContain('parameter card');
    expect(typedRawMutation).not.toContain('LINEAR_MUTATIONS=all');

    const rawMutation = text(graphql(
      { error: 'Raw Linear mutations are disabled.' },
      {},
      plainTheme,
      true,
    ));
    expect(rawMutation).toContain('LINEAR_MUTATIONS=all');
    expect(rawMutation).not.toContain('parameter card');

    for (const detail of ['service unavailable', 'gateway timeout', 'rate-limit exceeded']) {
      const rendered = text(typed(
        'get_issue',
        { error: `Linear API request failed: ${detail}` },
        {},
        plainTheme,
        true,
      ));
      expect(rendered).toContain('Retry the same request');
      expect(rendered).not.toContain('parameter card');
    }

    const validation = text(typed('update_issue', { error: 'missing issue' }, {}, plainTheme, true));
    expect(validation).toContain('linear_update_issue');
    expect(validation).toContain('parameter card');

    const missingVariable = text(typed(
      'get_issue',
      { error: 'Linear GraphQL error: Variable "$id" of required type "ID!" was not provided.' },
      {},
      plainTheme,
      true,
    ));
    expect(missingVariable).toContain('parameter card');
    expect(missingVariable).not.toContain('Retry the same request');

    const documentValidation = text(typed(
      'get_issue',
      { error: 'Linear GraphQL error: Cannot query field "unknownField" on type "Issue".' },
      {},
      plainTheme,
      true,
    ));
    expect(documentValidation).toContain('parameter card');
    expect(documentValidation).not.toContain('Retry the same request');

    const invalidIcon = text(typed(
      'create_document',
      { error: 'Linear GraphQL error: icon is not a valid icon.' },
      { title: 'Planning notes', icon: 'Target' },
      plainTheme,
      true,
    ));
    expect(invalidIcon).toContain('parameter card');
    expect(invalidIcon).not.toContain('Retry the same request');

    const unknownExecution = text(typed(
      'get_issue',
      { error: 'Linear GraphQL error: Cannot return null for non-nullable field Issue.assignee.' },
      {},
      plainTheme,
      true,
    ));
    expect(unknownExecution).toContain('Review the request and Linear server response');
    expect(unknownExecution).not.toContain('Retry the same request');
    expect(unknownExecution).not.toContain('parameter card');
  });

  it('renders a 502 response error body through client and renderer as transient', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      statusText: 'Bad Gateway',
      json: async () => ({ errors: [{ message: 'service unavailable' }] }),
    }));

    let message = '';
    try {
      await linearGraphQL('test-key', 'query { viewer { id } }', {});
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe('Linear API request failed: service unavailable');

    const rendered = text(typed('get_issue', { error: message }, {}, plainTheme, true));
    expect(rendered).toContain('Retry the same request');
    expect(rendered).not.toContain('parameter card');
  });

  it('classifies GraphQL request failures as validation and unknown execution as review', async () => {
    const cases = [
      {
        body: { errors: [{ message: 'Variable "$id" of required type "ID!" was not provided.' }] },
        thrown: 'Linear GraphQL error: Variable "$id" of required type "ID!" was not provided.',
        recovery: 'parameter card',
      },
      {
        body: { errors: [{ message: 'Cannot query field "unknownField" on type "Issue".' }] },
        thrown: 'Linear GraphQL error: Cannot query field "unknownField" on type "Issue".',
        recovery: 'parameter card',
      },
      {
        body: {
          data: { issue: { id: 'issue-1' } },
          errors: [{ message: 'Cannot return null for non-nullable field Issue.assignee.' }],
        },
        thrown: 'Linear GraphQL error: Cannot return null for non-nullable field Issue.assignee.',
        recovery: 'Review the request and Linear server response',
      },
    ] as const;

    for (const fixture of cases) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => fixture.body,
      }));
      let message = '';
      try {
        await linearGraphQL('test-key', 'query { viewer { id } }', {});
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toBe(fixture.thrown);
      const rendered = text(typed('get_issue', { error: message }, {}, plainTheme, true));
      expect(rendered).toContain(fixture.recovery);
      expect(rendered).not.toContain('Retry the same request');
      if (fixture.recovery !== 'parameter card') {
        expect(rendered).not.toContain('parameter card');
      }
      vi.unstubAllGlobals();
    }
  });

  it('wraps actionable notes without clipping cursor or recovery values at review widths', () => {
    const cursor = 'cursor-secret-shaped-but-not-a-token-1234567890';
    const component = typed('list_issues', {
      data: { issues: { nodes: [], pageInfo: { hasNextPage: true, endCursor: cursor } } },
      meta: { truncations: [{ path: 'issues.nodes', kept: 100, endCursor: cursor }], stringsClipped: 0 },
    });
    for (const width of widths) {
      const rendered = text(component, width);
      expect(rendered).not.toContain('...');
      expect(compact(component, width)).toContain(cursor);
    }
  });

  it('renders operation-aware empty states with the two-space result grid', () => {
    const search = text(typed('search_issues', { data: { issues: { nodes: [] } }, meta }, { query: 'needle' }));
    expect(search).toContain('  ○ No issues matched the search.');
    expect(search).toContain('Change or broaden the search term.');

    const filtered = text(typed('list_issues', { data: { issues: { nodes: [] } }, meta }, { team: 'AEO' }));
    expect(filtered).toContain('matched the filters');
    expect(filtered).toContain('Loosen or remove a filter.');

    const unfiltered = text(typed('list_issues', { data: { issues: { nodes: [] } }, meta }));
    expect(unfiltered).toContain('exist in the selected workspace');

    const comments = text(typed('list_comments', { data: { comments: { nodes: [] } }, meta }, { issue: 'AEO-258' }));
    expect(comments).toContain('target has no comments');

    const relations = text(typed('list_issue_relations', { data: { issueRelations: { nodes: [] } }, meta }));
    expect(relations).toContain('No issue relations exist in the selected workspace.');

    for (const [operation, root] of [
      ['list_users', 'users'],
      ['list_teams', 'teams'],
      ['list_issue_statuses', 'workflowStates'],
    ] as const) {
      const rendered = text(typed(operation, { data: { [root]: { nodes: [] } }, meta }));
      expect(rendered).toContain('Check another workspace or adjust the request.');
      expect(rendered).not.toContain('create the first');
    }
  });

  it('renders a compact structured raw GraphQL digest', () => {
    const rendered = text(graphql({
      data: {
        viewer: { id: 'user-1', name: 'Sam' },
        issues: { nodes: [{ id: '1' }, { id: '2' }], pageInfo: { hasNextPage: true, endCursor: 'next-1' } },
        count: 2,
      },
      meta,
    }, { query: 'query { viewer { id name } issues { nodes { id } } count }' }));
    expect(rendered).toContain('✓ GraphQL response');
    expect(rendered).toContain('Keys: viewer, issues, count');
    expect(rendered).toContain('issues: connection · 2 nodes');
    expect(rendered).toContain('next page after="next-1"');
    expect(rendered).toContain('viewer: object · 2 keys');
    expect(rendered).not.toContain('{"viewer"');
  });

  it('wraps all help domains', () => {
    const domains = ['issues', 'comments', 'users', 'teams', 'projects', 'cycles', 'milestones', 'initiatives', 'documents', 'views', 'labels', 'relations', 'workspace'];
    const domainComponent = api({ domains }, { operation: 'help' });
    for (const width of widths) {
      const rendered = compact(domainComponent, width);
      for (const domain of domains) expect(rendered).toContain(domain);
    }
  });

  it('falls back to an entity id, confirms tool loads, and scrubs secret-shaped data', () => {
    const nameless = text(typed('get_project', { data: { project: { id: '12345678-aaaa-bbbb-cccc-123456789012' } }, meta }));
    expect(nameless).toContain('12345678…');
    expect(nameless).not.toContain('(untitled project)');

    const loaded = text(api({
      loadedTools: ['linear_get_issue'],
      name: 'get_issue',
      parameters: [{ name: 'issue', type: 'IssueReference', required: true }],
    }, { operation: 'help', variables: { operation: 'get_issue' } }));
    expect(loaded).toContain('✓ loaded 1 tool');
    expect(loaded).not.toContain('+ loaded');

    const token = 'lin_api_secret123456789';
    const secret = text(graphql({ data: { viewer: { [token]: token } }, meta }, { query: 'query { viewer }' }));
    expect(secret).toContain('[REDACTED]');
    expect(secret).not.toContain('secret123456789');
  });
});
