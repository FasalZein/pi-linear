import { describe, expect, it } from 'vitest';
import type { JsonObject, JsonValue } from '../extensions/json';
import { getOperation } from '../extensions/operations';
import {
  operationRenderers,
  SUMMARY_VIEW_NOTICE,
  renderLinearApiCall,
  renderLinearApiResult,
  renderLinearBatchCall,
  renderLinearBatchResult,
  renderLinearGetResultCall,
  renderLinearGetResultResult,
  renderLinearGraphqlCall,
  renderLinearGraphqlResult,
} from '../extensions/renderers';

const meta = { truncations: [], stringsClipped: 0 };

function result<T>(details: T, message = JSON.stringify(details)) {
  return { content: [{ type: 'text' as const, text: message }], details } as any;
}

function recordingTheme() {
  const roles: string[] = [];
  return {
    roles,
    theme: {
      fg: (role: string, text: string) => {
        roles.push(role);
        return text;
      },
      bg: (_role: string, text: string) => text,
      bold: (text: string) => text,
      italic: (text: string) => text,
      underline: (text: string) => text,
    } as any,
  };
}

function text(component: any, width = 200): string {
  return component.render(width).join('\n');
}

function typed(
  operation: string,
  details: JsonValue | undefined,
  theme: any,
  args: JsonObject = {},
  options = { expanded: false, isPartial: false },
  context: JsonObject = {},
) {
  return operationRenderers(getOperation(operation)).renderResult(
    result(details),
    options,
    theme,
    { args, ...context } as any,
  );
}

describe('renderer output hardening', () => {
  it('keeps every visible segment attached to a named semantic style role', () => {
    const { theme, roles } = recordingTheme();
    const outputs = [
      text(typed('get_issue', {
        data: {
          issue: {
            id: 'issue-1',
            identifier: 'AEO-1',
            title: 'Urgent blocked issue',
            url: 'https://linear.app/acme/issue/AEO-1',
            priorityLabel: 'Urgent',
            state: { name: 'Blocked' },
            assignee: { name: 'Ada' },
            project: { name: 'Renderer hardening' },
            cycle: { name: 'Cycle 7' },
          },
        },
        meta: { view: 'full', truncations: [], stringsClipped: 1 },
      }, theme)),
      text(typed('get_document', {
        data: {
          document: {
            id: 'document-1',
            title: 'Planning notes',
            creator: { name: 'Ada' },
            updatedAt: '2026-09-08T00:00:00.000Z',
            content: 'Public planning content',
            url: 'https://linear.app/acme/document/planning-notes',
          },
        },
        meta,
      }, theme)),
      text(typed('list_issues', {
        data: {
          issues: {
            nodes: [{ id: 'issue-1', identifier: 'AEO-1', title: 'One issue' }],
            totalCount: 3,
            pageInfo: { hasNextPage: true, endCursor: 'cursor-1' },
          },
        },
        meta: { view: 'summary', truncations: [], stringsClipped: 0 },
      }, theme, { first: 1 })),
      text(typed('get_issue', { data: { issue: null }, meta }, theme, { issue: 'AEO-404' })),
      text(typed('create_issue', {
        data: { issueCreate: { success: true, issue: { id: 'issue-2', identifier: 'AEO-2', title: 'Created issue' } } },
        meta,
      }, theme)),
      text(typed('update_issue', { data: { issueUpdate: { success: false } }, meta }, theme, { issue: 'AEO-1' })),
      text(typed('save_project', { data: { projectCreate: { success: true, project: null } }, meta }, theme, { name: 'Launch' })),
      text(typed('delete_issue_relation', {
        data: { issueRelationDelete: { deleted: true, relationId: 'relation-1' } },
        meta,
      }, theme, { relationId: 'relation-1' })),
      text(typed('switch_workspace', { active: 'secondary' }, theme)),
      text(typed('get_issue', 'No result details', theme)),
      text(typed('list_issues', {
        path: '/tmp/linear/result.json',
        bytes: 1536,
        index: Array.from({ length: 10 }, (_, index) => `entry ${index + 1}`),
        meta: { truncations: [{ kept: 8 }], stringsClipped: 1 },
      }, theme)),
      text(renderLinearApiCall({}, theme)),
      text(renderLinearApiCall({ variables: { operation: 'get_issue' } }, theme)),
      text(renderLinearApiResult(
        result({ domains: ['issues', 'projects'], loadedTools: ['linear_get_issue'] }),
        { expanded: false, isPartial: false },
        theme,
        { args: {} } as any,
      )),
      text(renderLinearApiResult(
        result({ domain: 'issues', operations: [{ signature: 'get_issue(issue: IssueReference)' }] }),
        { expanded: false, isPartial: false },
        theme,
        { args: {} } as any,
      )),
      text(renderLinearApiResult(
        result({
          name: 'get_issue',
          purpose: 'Get an issue.',
          parameters: [
            { name: 'issue', type: 'IssueReference', required: true },
            { name: 'view', type: 'ResultView', required: false },
          ],
          loadedTools: ['linear_get_issue', 'linear_get_result'],
        }),
        { expanded: false, isPartial: false },
        theme,
        { args: {} } as any,
      )),
      text(renderLinearGraphqlResult(
        result({
          data: {
            issues: { nodes: [], pageInfo: { hasNextPage: true, endCursor: 'next-1' } },
            labels: ['bug', 'security'],
            viewer: { id: 'viewer-1', name: 'Ada' },
            empty: {},
            title: 'abc',
            enabled: true,
          },
          meta: { truncations: [{ kept: 2, endCursor: 'next-2' }], stringsClipped: 2 },
        }),
        { expanded: false, isPartial: false },
        theme,
        { args: { query: 'query Viewer { viewer { id } }' } } as any,
      )),
      text(renderLinearBatchCall({ operations: [{ operation: 'get_issue' }, {}] }, theme)),
      text(renderLinearBatchCall({ reads: [{ operation: 'get_issue' }], mutations: [{ operation: 'update_issue' }] }, theme)),
      text(renderLinearBatchResult(
        result({ data: { one: {} }, errors: [{ key: 'two' }], skipped: ['three'], meta: { requests: { read: 2, mutation: 1 } } }),
        { expanded: false, isPartial: false },
        theme,
        {} as any,
      )),
      text(renderLinearGetResultCall({ handle: 'linear-result:v1:one', path: '/data', offset: 2 }, theme)),
      text(renderLinearGetResultResult(
        result({ data: { value: 'segment', range: { start: 2, end: 3, total: 5, unit: 'items' } }, meta: { retrieval: { complete: false, nextOffset: 3 } } }),
        { expanded: false, isPartial: false },
        theme,
        {} as any,
      )),
      text(renderLinearGraphqlCall({ workspace: 'default', sink: 'inline' }, theme)),
    ];

    expect(roles).not.toContain('');
    expect(new Set(roles)).toEqual(new Set([
      'success', 'accent', 'toolOutput', 'muted', 'dim', 'warning', 'error', 'toolTitle',
    ]));
    expect(outputs.join('\n')).not.toContain('Stryker was here');
  });

  it('keeps the exact facts and recovery actions on every compact result surface', () => {
    const { theme, roles } = recordingTheme();
    const outputs = {
      list: text(typed('list_issues', {
        data: { issues: { nodes: [{ id: 'i1', identifier: 'AEO-1', title: 'One' }], totalCount: 3 } },
        meta: { view: 'summary', truncations: [], stringsClipped: 0 },
      }, theme)),
      listWithExactTotal: text(typed('list_issues', {
        data: { issues: { nodes: [{ id: 'i1', identifier: 'AEO-1', title: 'One' }], totalCount: 1 } },
        meta,
      }, theme)),
      listWithoutTotal: text(typed('list_issues', {
        data: { issues: { nodes: [{ id: 'i1', identifier: 'AEO-1', title: 'One' }] } },
        meta,
      }, theme)),
      fullList: text(typed('list_issues', {
        data: { issues: { nodes: [{ id: 'i1', identifier: 'AEO-1', title: 'One' }] } },
        meta: { view: 'full', truncations: [], stringsClipped: 0 },
      }, theme)),
      summaryEntity: text(typed('get_issue', {
        data: { issue: { id: 'i1', identifier: 'AEO-1', title: 'One' } },
        meta: { view: 'summary', truncations: [], stringsClipped: 0 },
      }, theme)),
      fullEntity: text(typed('get_issue', {
        data: { issue: { id: 'i1', identifier: 'AEO-1', title: 'One' } },
        meta: { view: 'full', truncations: [], stringsClipped: 0 },
      }, theme)),
      filteredEmpty: text(typed('list_issues', { data: { issues: { nodes: [] } }, meta }, theme, { filter: { state: 'done' } })),
      unfilteredEmpty: text(typed('list_issues', { data: { issues: { nodes: [] } }, meta }, theme)),
      notFound: text(typed('get_issue', { data: { issue: null }, meta }, theme, { issue: 'AEO-404' })),
      notFoundWithoutTarget: text(typed('get_issue', {
        data: { issue: null },
        meta: { truncations: [{ kept: 1 }], stringsClipped: 0 },
      }, theme)),
      unknownMutation: text(typed('update_issue', { data: { issueUpdate: { success: false } }, meta }, theme, { issue: 'AEO-1' })),
      workspace: text(typed('switch_workspace', { active: 'secondary' }, theme)),
      unknown: text(typed('get_issue', 'No result details', theme)),
      cycle: text(typed('get_cycle', {
        data: { cycle: { id: 'cycle-1', number: 7, name: 'Cycle 7', status: 'active', progress: 0.5 } },
        meta,
      }, theme)),
      view: text(typed('get_view', {
        data: { view: { id: 'view-1', name: 'My view', type: 'issues', shared: false, slugId: 'my-view' } },
        meta,
      }, theme)),
      document: text(typed('get_document', {
        data: { document: { id: 'document-1', title: 'Notes', content: 'Body text' } },
        meta,
      }, theme)),
      minimalLabel: text(typed('update_issue_label', {
        data: { issueLabelUpdate: { success: true, issueLabel: { id: 'label-1', name: 'Bug' } } },
        meta,
      }, theme, { id: 'label-1', name: 'Bug' })),
      minimalRelation: text(typed('update_project_relation', {
        data: {
          projectRelationUpdate: {
            success: true,
            projectRelation: { id: 'relation-1', type: 'related' },
          },
        },
        meta,
      }, theme, { id: 'relation-1', type: 'related' })),
      created: text(typed('create_issue', {
        data: { issueCreate: { success: true, issue: null } }, meta,
      }, theme, { title: 'New issue' })),
      createdWithoutTarget: text(typed('create_issue', {
        data: { issueCreate: { success: true, issue: null } },
        meta: { truncations: [{ kept: 1 }], stringsClipped: 0 },
      }, theme)),
      saved: text(typed('save_project', {
        data: { projectCreate: { success: true, project: null } }, meta,
      }, theme, { name: 'Launch' })),
      deleted: text(typed('delete_issue_relation', {
        data: { issueRelationDelete: { deleted: true, relationId: 'relation-1' } }, meta,
      }, theme, { relationId: 'relation-1' })),
      helpDomains: text(renderLinearApiResult(
        result({ domains: ['issues'], loadedTools: [] }),
        { expanded: false, isPartial: false }, theme, {} as any,
      )),
      helpOperationsWithoutDomain: text(renderLinearApiResult(
        result({ operations: [{ name: 'get_issue' }], loadedTools: [] }),
        { expanded: false, isPartial: false }, theme, {} as any,
      )),
      helpOperation: text(renderLinearApiResult(
        result({ name: 'get_issue', parameters: [{ name: 'issue', type: 'IssueReference', required: true }], loadedTools: [] }),
        { expanded: false, isPartial: false }, theme, {} as any,
      )),
      helpLoaded: text(renderLinearApiResult(
        result({
          name: 'get_issue',
          purpose: 'Get an issue.',
          parameters: [{ name: 'view', type: 'ResultView', required: false }],
          loadedTools: ['linear_get_issue', 'linear_get_result'],
        }),
        { expanded: false, isPartial: false }, theme, {} as any,
      )),
      raw: text(renderLinearGraphqlResult(
        result({
          data: {
            issues: { nodes: [], pageInfo: { hasNextPage: true, endCursor: 'next-1' } },
            labels: ['bug', 'security'],
            viewer: { id: 'viewer-1', name: 'Ada' },
            empty: {},
            title: 'abc',
            enabled: true,
          },
          meta,
        }),
        { expanded: false, isPartial: false }, theme, {} as any,
      )),
      batch: text(renderLinearBatchResult(
        result({ data: { one: {} }, errors: [{ key: 'two' }], skipped: ['three'], meta: { requests: { read: 2, mutation: 1 } } }),
        { expanded: false, isPartial: false }, theme, {} as any,
      )),
      retrieval: text(renderLinearGetResultResult(
        result({ data: { value: 'segment', range: { unit: 'characters' } }, meta: { retrieval: { complete: true } } }),
        { expanded: false, isPartial: false }, theme, {} as any,
      )),
      retrievalWithoutRange: text(renderLinearGetResultResult(
        result({ data: { value: 'complete' }, meta: { retrieval: { complete: true } } }),
        { expanded: false, isPartial: false }, theme, {} as any,
      )),
      flatCall: text(renderLinearBatchCall({
        operations: [{ operation: 'get_issue' }, { operation: 'get_project' }, {}, 'bad'],
      }, theme)),
      emptyFlatCall: text(renderLinearBatchCall({ operations: [] }, theme)),
      invalidFlatCall: text(renderLinearBatchCall({ operations: 'bad' }, theme)),
      phasedCall: text(renderLinearBatchCall({
        reads: [{ operation: 'get_issue' }],
        mutations: [{ operation: 'update_issue' }],
      }, theme)),
      emptyBatchCall: text(renderLinearBatchCall({}, theme)),
      retrievalCall: text(renderLinearGetResultCall({
        handle: 'linear-result:v1:one', path: '/data', offset: 2,
      }, theme)),
      graphqlCall: text(renderLinearGraphqlCall({ workspace: 'default', sink: 'inline' }, theme)),
      typedCall: text(operationRenderers(getOperation('get_issue')).renderCall(
        { issue: 'AEO-1', workspace: 'secondary' }, theme, {} as any,
      )),
      eightEntrySpill: text(typed('list_issues', {
        path: '/tmp/linear/eight.json',
        bytes: 1024,
        index: Array.from({ length: 8 }, (_, index) => `entry ${index + 1}`),
        meta,
      }, theme)),
      rawWithoutCursor: text(renderLinearGraphqlResult(
        result({
          data: { issues: { nodes: [], pageInfo: { hasNextPage: false } } },
          meta,
        }),
        { expanded: false, isPartial: false }, theme, {} as any,
      )),
      batchWithMultipleAndNone: text(renderLinearBatchResult(
        result({
          data: { one: {}, two: {} }, errors: [], skipped: [],
          meta: { requests: { read: 2, mutation: 0 } },
        }),
        { expanded: false, isPartial: false }, theme, {} as any,
      )),
    };

    expect(SUMMARY_VIEW_NOTICE).toBe('Fields narrowed — use view="full" for complete fields.');
    expect(outputs.list).toContain('showing 1 of 3, more available');
    expect(outputs.listWithExactTotal).toContain('1 issue');
    expect(outputs.listWithExactTotal).not.toContain('more available');
    expect(outputs.listWithoutTotal).toContain('1 issue');
    expect(outputs.listWithoutTotal).not.toContain('more available');
    expect(outputs.list).toContain(SUMMARY_VIEW_NOTICE);
    expect(outputs.fullList).not.toContain(SUMMARY_VIEW_NOTICE);
    expect(outputs.summaryEntity).toContain(SUMMARY_VIEW_NOTICE);
    expect(outputs.fullEntity).not.toContain(SUMMARY_VIEW_NOTICE);
    expect(outputs.filteredEmpty).toContain('No issues matched the filters.');
    expect(outputs.filteredEmpty).toContain('Loosen or remove a filter.');
    expect(outputs.unfilteredEmpty).toContain('No issues exist in the selected workspace.');
    expect(outputs.unfilteredEmpty).toContain('Create the first issue or check another workspace.');
    expect(outputs.notFound).toContain('✗ Issue not found');
    expect(outputs.notFound).toContain('Searched: AEO-404');
    expect(outputs.notFound).toContain('Check the exact issue reference and call the operation again.');
    expect(outputs.notFoundWithoutTarget).not.toContain('Stryker was here');
    expect(outputs.notFoundWithoutTarget).toContain('kept 1 nodes');
    expect(outputs.unknownMutation).toContain('! Updated issue AEO-1: status unknown');
    expect(outputs.unknownMutation).toContain('Re-read the record to confirm the change.');
    expect(outputs.workspace).toContain('✓ Switched workspace secondary');
    expect(outputs.unknown).toContain('No result details');
    expect(outputs.cycle).toContain('Team        —');
    expect(outputs.cycle).toContain('Status      unknown');
    expect(outputs.cycle).toContain('Progress    50%');
    expect(outputs.cycle).toContain('Description —');
    expect(outputs.view).not.toContain('Description');
    expect(outputs.document).toContain('Body text');
    expect(outputs.document).toContain('✓ Loaded Notes');
    expect(outputs.document).not.toContain('✓ Loaded  Notes');
    expect(outputs.document).not.toContain('undefined');
    expect(outputs.minimalLabel).toContain('✓ Updated Bug');
    expect(outputs.minimalLabel.split('\n')).not.toContain('  ');
    expect(outputs.minimalLabel).not.toContain('undefined');
    expect(outputs.minimalRelation).toContain('✓ Updated — related —');
    expect(outputs.minimalRelation).not.toContain('undefined');
    expect(outputs.created).toContain('✓ Created issue New issue');
    expect(outputs.createdWithoutTarget).toContain('✓ Created issue');
    expect(outputs.createdWithoutTarget).not.toContain('Stryker was here');
    expect(outputs.createdWithoutTarget).toContain('kept 1 nodes');
    expect(outputs.saved).toContain('✓ Saved project Launch');
    expect(outputs.deleted).toContain('✓ Deleted relation relation-1');
    expect(outputs.helpDomains).toContain('Ask for one operation to load its typed tool.');
    expect(outputs.helpDomains).not.toContain('loaded 0 tools');
    expect(outputs.helpOperationsWithoutDomain).toContain('1 operation in domain');
    expect(outputs.helpOperation).toContain('issue                   IssueReference');
    expect(outputs.helpOperation).not.toContain('Get an issue.');
    expect(outputs.helpLoaded).toContain('Get an issue.');
    expect(outputs.helpLoaded).toContain('view?                   ResultView');
    expect(outputs.helpLoaded).toContain('✓ loaded 2 tools');
    expect(outputs.helpLoaded).toContain('linear_get_issue, linear_get_result');
    expect(outputs.raw).toContain('issues: connection · 0 nodes · next page after="next-1"');
    expect(outputs.raw).toContain('Keys: issues, labels, viewer, empty, title, enabled');
    expect(outputs.raw).toContain('labels: array · 2 items');
    expect(outputs.raw).toContain('viewer: object · 2 keys (id, name)');
    expect(outputs.raw).toContain('empty: object · 0 keys');
    expect(outputs.raw).toContain('title: string · 3 chars');
    expect(outputs.raw).toContain('enabled: boolean');
    expect(outputs.raw).not.toContain('undefined chars');
    expect(outputs.raw).not.toContain('Stryker was here');
    expect(outputs.batch).toContain('Completed: one');
    expect(outputs.batch).toContain('✓ Batch complete');
    expect(outputs.batch).toContain('Failed: two');
    expect(outputs.batch).toContain('Skipped: three');
    expect(outputs.batch).toContain('Requests: 2 read, 1 mutation');
    expect(outputs.retrieval).toContain('Range: ?–? of ? characters');
    expect(outputs.retrievalWithoutRange).not.toContain('Range:');
    expect(outputs.flatCall).toContain('linear_batch flat');
    expect(outputs.flatCall).toContain('operations: get_issue, get_project');
    expect(outputs.flatCall).not.toContain(', ,');
    expect(outputs.emptyFlatCall).toContain('operations: (none)');
    expect(outputs.invalidFlatCall).toContain('linear_batch phased');
    expect(outputs.invalidFlatCall).not.toContain('operations:');
    expect(outputs.phasedCall).toContain('linear_batch phased');
    expect(outputs.phasedCall).toContain('reads: get_issue');
    expect(outputs.phasedCall).toContain('mutations: update_issue');
    expect(outputs.emptyBatchCall).toContain('linear_batch phased');
    expect(outputs.emptyBatchCall).not.toContain('reads:');
    expect(outputs.emptyBatchCall).not.toContain('mutations:');
    expect(outputs.retrievalCall).toContain('handle=linear-result:v1:one');
    expect(outputs.retrievalCall).toContain('path=/data');
    expect(outputs.retrievalCall).toContain('offset=2');
    expect(outputs.graphqlCall).toContain('workspace=default');
    expect(outputs.graphqlCall).toContain('sink=inline');
    expect(outputs.typedCall).toContain('issue=AEO-1');
    expect(outputs.typedCall).toContain('workspace=secondary');
    expect(outputs.eightEntrySpill).toContain('entry 8');
    expect(outputs.eightEntrySpill).not.toContain('more entries in the file');
    expect(outputs.rawWithoutCursor).toContain('issues: connection · 0 nodes');
    expect(outputs.rawWithoutCursor).not.toContain('next page after=');
    expect(outputs.rawWithoutCursor).not.toContain('Stryker was here');
    expect(outputs.batchWithMultipleAndNone).toContain('Completed: one, two');
    expect(outputs.batchWithMultipleAndNone).toContain('Failed: (none)');
    expect(outputs.batchWithMultipleAndNone).toContain('Skipped: (none)');
    expect(Object.values(outputs).join('\n')).not.toContain('Stryker was here');
    expect(Object.values(outputs).join('\n')).not.toContain('undefined');
    expect(roles).not.toContain('');
  });

  it('does not treat routing-only list arguments as user filters', () => {
    const { theme } = recordingTheme();
    const details = { data: { issues: { nodes: [] } }, meta };
    for (const args of [
      { after: 'cursor' }, { before: 'cursor' }, { first: 10 }, { last: 10 },
      { workspace: 'default' }, { sink: 'inline' }, { view: 'summary' },
    ]) {
      const rendered = text(typed('list_issues', details, theme, args));
      expect(rendered, JSON.stringify(args)).toContain('No issues exist in the selected workspace.');
      expect(rendered, JSON.stringify(args)).not.toContain('No issues matched the filters.');
    }

    const search = text(typed(
      'search_issues',
      { data: { searchIssues: { nodes: [] } }, meta },
      theme,
      { term: 'renderer' },
    ));
    expect(search).toContain('No issues matched the search.');
  });

  it('uses each operation family target that can identify a failed mutation', () => {
    const { theme } = recordingTheme();
    const failure = (operation: string, root: string, args: JsonObject) => text(typed(
      operation,
      { data: { [root]: { success: false } }, meta },
      theme,
      args,
    ));

    expect(failure('update_view', 'viewUpdate', { id: 'view-1' })).toContain('view view-1');
    expect(failure('create_view', 'viewCreate', { name: 'My view' })).toContain('view My view');
    expect(failure('create_project_relation', 'projectRelationCreate', {
      project: 'project-1', relatedProject: 'project-2', type: 'related',
      anchorType: 'project', relatedAnchorType: 'project',
    })).toContain('relation project-1');
  });

  it('keeps wide headers and narrow fallback rows readable with and without short identifiers', () => {
    const { theme, roles } = recordingTheme();
    const issue = typed('list_issues', {
      data: { issues: { nodes: [{ id: 'i1', identifier: 'AEO-1', title: 'One issue' }] } }, meta,
    }, theme);
    const document = typed('list_documents', {
      data: { documents: { nodes: [{ id: 'd1', title: 'Planning notes' }] } }, meta,
    }, theme);
    const cycle = typed('list_cycles', {
      data: { cycles: { nodes: [{ id: 'c1', number: 7, name: 'Cycle 7' }] } }, meta,
    }, theme);

    expect(text(issue, 200)).toContain('Title');
    expect(text(document, 200)).toContain('Title');
    expect(text(cycle, 200)).toContain('Name');
    expect(text(issue, 18)).toContain('AEO-1 One issue');
    expect(text(document, 18)).toContain('Planning notes');
    expect(text(document, 18)).not.toContain('undefined');
    expect(roles).not.toContain('');
  });

  it('keeps partial, error, and expanded branches distinct for every direct tool', () => {
    const { theme, roles } = recordingTheme();
    const partial = { expanded: false, isPartial: true };
    const compact = { expanded: false, isPartial: false };
    const expanded = { expanded: true, isPartial: false };
    const failure = result({}, 'Linear network error: connection reset');
    const details = result({ data: { value: 'ok' }, meta: { retrieval: { complete: true } } });

    expect(text(renderLinearBatchResult(details, partial, theme, {} as any))).toContain('Running batch…');
    expect(text(renderLinearGetResultResult(details, partial, theme, {} as any))).toContain('Retrieving stored result…');
    expect(text(renderLinearGraphqlResult(details, partial, theme, {} as any))).toContain('Running request…');
    expect(text(renderLinearApiResult(details, partial, theme, {} as any))).toContain('Loading Linear help…');

    expect(text(renderLinearBatchResult(failure, compact, theme, { isError: true } as any))).toContain('linear_batch');
    expect(text(renderLinearGetResultResult(failure, compact, theme, { isError: true } as any)))
      .toContain('Check the result handle, JSON Pointer, and offset');
    expect(text(renderLinearGraphqlResult(failure, compact, theme, { isError: true } as any))).toContain('linear_graphql');

    expect(text(renderLinearBatchResult(details, expanded, theme, {} as any))).toContain('"retrieval"');
    expect(text(renderLinearGetResultResult(details, expanded, theme, {} as any))).toContain('"retrieval"');
    expect(text(renderLinearGraphqlResult(details, expanded, theme, {} as any))).toContain('"retrieval"');
    expect(text(renderLinearApiResult(
      result({ domains: ['issues'], loadedTools: [] }), expanded, theme, {} as any,
    ))).toContain('"domains"');
    expect(text(operationRenderers(getOperation('list_issues')).renderResult(
      result(undefined), partial, theme, {} as any,
    ))).toContain('Loading issues…');
    expect(text(renderLinearApiCall(null, theme))).toContain('linear catalog');
    expect(roles).not.toContain('');
  });

  it('maps every failure class to its exact caller recovery action', () => {
    const guidance = operationRenderers(getOperation('get_issue')).guidance;
    const validation = 'Open the linear_get_issue parameter card, correct the validation error, and call linear_get_issue again.';
    const retry = 'Retry the same request. A transient network or Linear server failure can change on retry.';
    const auth = 'Update Linear authentication with /linear-auth, then retry the request.';
    const review = 'Review the request and Linear server response before trying a corrected request.';

    for (const message of ['read-only', 'readonly']) {
      expect(guidance(message), message).toBe('Use a read-only operation or restart through a mutation-enabled entry point.');
    }
    for (const message of ['destructive named input', 'trashed']) {
      expect(guidance(message), message).toBe('Named destructive input is unavailable. Use an authorized raw GraphQL mutation when that action is required.');
    }
    for (const message of ['not allowed', 'blocked root', 'mutation root']) {
      expect(guidance(message), message).toBe('This mutation root is blocked by policy. Use a supported named operation.');
    }
    for (const message of ['configuration', 'manifest', 'filtered tool']) {
      expect(guidance(message), message).toBe('Check the generated tool manifest and the active tool policy, then load the operation again.');
    }
    expect(guidance('unknown parameters')).toBe(
      'Remove the unaccepted parameters and call linear_get_issue again with the accepted ones only.',
    );
    expect(guidance('issue not found')).toBe('Check the exact issue reference and call linear_get_issue again.');

    for (const message of ['unauthorized', 'authentication', 'api key', 'credential']) {
      expect(guidance(message), message).toBe(auth);
    }
    for (const message of [
      'validation', 'invalid parameter', 'invalid value', 'not a valid', 'missing value', 'must be',
      'is required', 'expected type', 'exactly one', 'was not provided', 'cannot query field',
    ]) {
      expect(guidance(`${message} and network failure`), message).toBe(validation);
    }
    for (const message of [
      'network', 'fetch', 'connection', 'server', 'service unavailable', 'timeout', 'timed out',
      'rate limit', 'rate-limit', 'too many requests', 'gateway',
    ]) {
      expect(guidance(message), message).toBe(retry);
    }
    expect(guidance('graphql failure')).toBe(review);

    for (const status of [401, 403]) {
      expect(guidance(`linear api request failed: ${status}`), String(status)).toBe(auth);
    }
    for (const status of [408, 429, 500, 599]) {
      expect(guidance(`linear api request failed: ${status}`), String(status)).toBe(retry);
    }
    expect(guidance('linear api request failed: 400')).toBe(review);
    expect(guidance('linear api request failed: 600')).toBe(review);
    expect(guidance('prefix linear api request failed: 400')).toBe(validation);
    expect(guidance('linear api request failed:    500')).toBe(retry);
    expect(guidance('linear api request failed: 4')).toBe(review);
    expect(guidance('RAW LINEAR MUTATIONS are disabled')).toBe(validation);

    const { theme } = recordingTheme();
    const failure = result({}, 'raw linear mutations are disabled');
    const networkFailure = result({}, 'network connection failed');
    const notFoundFailure = result({}, 'record not found');
    const compact = { expanded: false, isPartial: false };
    expect(text(renderLinearBatchResult(failure, compact, theme, { isError: true } as any)))
      .toContain(validation.replaceAll('linear_get_issue', 'linear_batch'));
    expect(text(renderLinearGraphqlResult(failure, compact, theme, { isError: true } as any)))
      .toContain('Set LINEAR_MUTATIONS=all only when an authorized raw GraphQL mutation is required.');
    expect(text(renderLinearGraphqlResult(networkFailure, compact, theme, { isError: true } as any)))
      .toContain(retry);
    expect(text(renderLinearBatchResult(notFoundFailure, compact, theme, { isError: true } as any)))
      .toContain('Check the exact batch reference and call linear_batch again.');
    expect(text(renderLinearGraphqlResult(notFoundFailure, compact, theme, { isError: true } as any)))
      .toContain('Check the exact operation reference and call linear_graphql again.');
  });
});
