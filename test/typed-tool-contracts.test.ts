import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TSchema } from 'typebox';
import { registerLinearExtension } from '../extensions/index';
import { linearApiTool } from '../extensions/api';
import { requirementBranches, typedLinearTools, typedToolNames } from '../extensions/typed-tools';
import { CANONICAL_OPERATIONS, canonicalFieldNames, missingCanonicalOperations } from '../extensions/canonical';
import { operations } from '../extensions/operations';
import type { JsonObject, JsonValue, UnparsedJson } from '../extensions/json';
// The validator Pi runs on every tool call, imported from the agent runtime itself.
import { validateToolArguments } from '../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/utils/validation.js';

const originalApiKey = process.env.LINEAR_API_KEY;
const originalPiDirectory = process.env.PI_CODING_AGENT_DIR;

beforeEach(async () => {
  // Never read the developer's stored Linear credentials during a test.
  process.env.PI_CODING_AGENT_DIR = await mkdtemp(join(tmpdir(), 'pi-linear-creds-'));
});

afterEach(() => {
  if (originalPiDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalPiDirectory;
  vi.unstubAllGlobals();
  if (originalApiKey === undefined) delete process.env.LINEAR_API_KEY;
  else process.env.LINEAR_API_KEY = originalApiKey;
});

type FakePi = ReturnType<typeof fakePi>;

function fakePi(builtIns: string[] = ['read', 'bash']) {
  const registered: any[] = [];
  const sessionHandlers: Array<() => void> = [];
  let active = [...builtIns];
  let blockedTool: string | undefined;
  const history: string[][] = [];
  const pi = {
    registerCommand: () => undefined,
    registerTool: (tool: any) => {
      registered.push(tool);
      active.push(tool.name);
    },
    getActiveTools: () => [...active],
    getAllTools: () => registered.map((tool) => ({ name: tool.name, parameters: tool.parameters })),
    setActiveTools: (names: string[]) => {
      active = blockedTool ? names.filter((name) => name !== blockedTool) : [...names];
      history.push([...names]);
    },
    on: (event: string, handler: () => void) => {
      if (event === 'session_start') sessionHandlers.push(handler);
    },
  };
  return {
    pi: pi as any,
    registered,
    history,
    startSession: () => sessionHandlers.forEach((handler) => handler()),
    activeTools: () => [...active],
    tool: (name: string) => registered.find((entry) => entry.name === name),
    removeRegistration: (name: string) => registered.splice(registered.findIndex((entry) => entry.name === name), 1),
    blockActivation: (name: string) => { blockedTool = name; },
  };
}

function execute(tool: any, params: JsonObject) {
  return tool.execute('call-1', params, undefined, undefined, { hasUI: false });
}

function setup(): FakePi {
  const harness = fakePi();
  registerLinearExtension(harness.pi);
  harness.startSession();
  return harness;
}

describe('typed tool registration', () => {
  it('registers linear, direct result retrieval, and one typed tool per catalog operation', () => {
    const harness = setup();
    const names = harness.registered.map((tool) => tool.name);
    expect(names.filter((name) => !['linear', 'linear_get_result', 'linear_graphql', 'linear_batch'].includes(name)).sort())
      .toEqual([...typedToolNames()].sort());
    expect(names).toContain('linear');
    expect(names).toContain('linear_get_result');
    expect(names).toContain('linear_graphql');
    expect(names).toContain('linear_batch');
    expect(typedToolNames()).toHaveLength(49);
  });

  it('uses upstream tool names', () => {
    const names = new Set(typedToolNames());
    for (const name of ['linear_get_issue', 'linear_list_issues', 'linear_search_issues', 'linear_create_comment', 'linear_save_project', 'linear_list_issue_statuses', 'linear_set_view_preferences', 'linear_switch_workspace']) {
      expect(names).toContain(name);
    }
  });

  it('registers only the guarded issue-relation delete as a destructive operation', () => {
    expect(typedToolNames().filter((name) => /^linear_(delete|archive|unarchive)_/.test(name)))
      .toEqual(['linear_delete_issue_relation']);
  });

  it('keeps every typed tool inactive at session start and preserves other tools', () => {
    const harness = setup();
    const active = harness.activeTools();
    expect(active).toContain('linear');
    expect(active).toContain('linear_get_result');
    expect(active).toContain('read');
    expect(active).toContain('bash');
    expect(active.filter((name) => typedToolNames().includes(name))).toEqual([]);
  });
});

describe('deterministic activation', () => {
  it('activates exactly the operation named by operation help', async () => {
    const harness = setup();
    const before = harness.activeTools();
    const result = await execute(harness.tool('linear'), {
      operation: 'help',
      variables: { operation: 'get_issue' },
    });

    expect(result.details.loadedTools).toEqual(['linear_get_issue']);
    const after = harness.activeTools();
    for (const name of before) expect(after).toContain(name);
    expect(after.length).toBe(before.length + 1);
  });

  it('reports a missing requested registration as a configuration error', async () => {
    const harness = setup();
    harness.removeRegistration('linear_get_issue');
    await expect(execute(harness.tool('linear'), {
      operation: 'help', variables: { operation: 'get_issue' },
    })).rejects.toThrow('manifest entries are not registered: linear_get_issue');
  });

  it('reports policy-blocked activation and does not claim the tool loaded', async () => {
    const harness = setup();
    harness.blockActivation('linear_get_issue');
    await expect(execute(harness.tool('linear'), {
      operation: 'help', variables: { operation: 'get_issue' },
    })).rejects.toThrow('policy blocked manifest entries: linear_get_issue');
    expect(harness.activeTools()).not.toContain('linear_get_issue');
  });

  it('activates nothing for a domain listing', async () => {
    const harness = setup();
    const before = harness.activeTools();
    const result = await execute(harness.tool('linear'), {
      operation: 'help',
      variables: { domain: 'issues' },
    });

    expect(result.details.loadedTools).toBeUndefined();
    expect(harness.activeTools()).toEqual(before);
  });

  it('never removes an active tool and never re-reports an already active tool', async () => {
    const harness = setup();
    await execute(harness.tool('linear'), { operation: 'help', variables: { operation: 'get_issue' } });
    const afterFirst = harness.activeTools();
    const second = await execute(harness.tool('linear'), {
      operation: 'help',
      variables: { operation: 'get_issue' },
    });

    expect(second.details.loadedTools).toBeUndefined();
    expect(harness.activeTools()).toEqual(afterFirst);
    for (const names of harness.history) {
      for (const name of afterFirst.filter((entry) => names.includes(entry))) {
        expect(names).toContain(name);
      }
    }
  });

  it('accumulates activation across successive requests', async () => {
    const harness = setup();
    await execute(harness.tool('linear'), { operation: 'help', variables: { operation: 'create_issue' } });
    await execute(harness.tool('linear'), { operation: 'help', variables: { operation: 'create_comment' } });
    const active = harness.activeTools();
    expect(active).toContain('linear_create_issue');
    expect(active).toContain('linear_create_comment');
    expect(active).toContain('linear');
  });
});

// ---------------------------------------------------------------------------
// Validation boundary: everything below runs arguments through the same
// validateToolArguments() call the agent loop makes before execute().
// ---------------------------------------------------------------------------

const tools = new Map(typedLinearTools().map((tool) => [tool.name, tool]));

function validate(toolName: string, args: JsonObject) {
  const tool = tools.get(toolName)!;
  return validateToolArguments(tool as any, { id: 'call-1', name: toolName, arguments: args } as any);
}

function accepts(toolName: string, args: JsonObject): boolean {
  try {
    validate(toolName, args);
    return true;
  } catch {
    return false;
  }
}

/** A value that satisfies the published schema for one canonical field. */
function sampleFor(type: string): JsonValue {
  switch (type) {
    case 'Int':
      return 5;
    case 'Float':
      return 1.5;
    case 'JsonString':
      return '{"type":"doc"}';
    case 'JsonObject':
      return { type: 'doc', content: [] };
    case 'Url':
      return 'https://example.com/icon.png';
    case 'NullableDateTime':
      return '2026-09-01T00:00:00.000Z';
    case 'NullableUserReference':
      return 'me';
    case 'NullableIssueReference':
      return 'AEO-258';
    case 'NullableUUID':
      return '11111111-1111-4111-8111-111111111111';
    case 'SlaDayCountType':
      return 'onlyBusinessDays';
    case 'DateResolutionType':
      return 'quarter';
    case 'FrequencyResolutionType':
      return 'weekly';
    case 'Day':
      return 'Monday';
    case 'InitiativeStatus':
      return 'Active';
    case '[IssueSort!]':
      return [{ key: 'priority', order: 'Ascending' }];
    case '[ProjectSort!]':
      return [{ key: 'targetDate' }];
    case '[InitiativeSort!]':
      return [{ key: 'targetDate' }];
    case '[UserSort!]':
      return [{ key: 'displayName' }];
    case '[DocumentSort!]':
      return [{ key: 'title' }];
    case 'Priority':
      return 2;
    case 'Boolean':
      return true;
    case 'Color':
      return '#ff0000';
    case 'Date':
      return '2026-09-01';
    case 'DateTime':
      return '2026-09-01T00:00:00.000Z';
    case '[ID!]':
    case '[UUID!]':
      return ['11111111-1111-4111-8111-111111111111'];
    case 'UUID':
      return '11111111-1111-4111-8111-111111111111';
    case 'NullableDate':
      return '2026-09-01';
    case 'Preferences':
      return { issueGrouping: 'status', showEmptyGroups: true };
    case '[SortInput!]':
      return [{ key: 'updatedAt', order: 'Descending' }];
    case 'Filter':
    case 'FilterData':
      return { name: { eq: 'x' } };
    case 'IssueRelationType':
      return 'blocks';
    case 'WorkflowStateType':
      return 'started';
    case 'PaginationOrderBy':
      return 'updatedAt';
    case 'ResultView':
      return 'summary';
    default:
      return 'sample';
  }
}

function sampleBranch(operationName: string, branch: readonly string[]): JsonObject {
  const { fields } = CANONICAL_OPERATIONS[operationName]!;
  return Object.fromEntries(branch.map((key) => [key, sampleFor(fields[key]!)]));
}

/**
 * An alias is a second name for a concept the same operation already names. The rule
 * is external to the contract: a tool may publish `issueId` (a document association)
 * only when it does not also publish `issue`, and never `teamKey`, `input`, or
 * `trashed`. Linear's own association fields (projectId, cycleId, labelIds, …) are
 * capabilities, not aliases, and the fixture below requires them.
 */
const ALIAS_OF = {
  issueId: 'issue',
  teamId: 'team',
  stateId: 'state',
  stateName: 'state',
  assigneeId: 'assignee',
  parentId: 'parent',
  relatedIssueId: 'relatedIssue',
} satisfies Readonly<Record<string, string>>;

/** Never published by a typed tool, whatever the operation. */
const ALWAYS_FORBIDDEN = ['input', 'trashed', 'teamKey'];

function forbiddenAliases(operationName: string): string[] {
  const published = new Set(Object.keys(CANONICAL_OPERATIONS[operationName]!.fields));
  return [
    ...ALWAYS_FORBIDDEN,
    ...Object.entries(ALIAS_OF)
      .filter(([alias, canonical]) => published.has(canonical) && !published.has(alias))
      .map(([alias]) => alias),
  ];
}

describe('canonical typed contract', () => {
  it('covers every catalog operation exactly once', () => {
    expect(missingCanonicalOperations()).toEqual([]);
    expect(Object.keys(CANONICAL_OPERATIONS)).toHaveLength(49);
  });

  it('publishes no v0.4 compatibility alias', () => {
    for (const [operationName, contract] of Object.entries(CANONICAL_OPERATIONS)) {
      const published = Object.keys(contract.fields);
      for (const alias of forbiddenAliases(operationName)) {
        expect(published, `${operationName}.${alias}`).not.toContain(alias);
      }
      // No operation publishes both a canonical name and its alias.
      for (const [alias, canonical] of Object.entries(ALIAS_OF)) {
        expect(published.includes(alias) && published.includes(canonical), `${operationName}.${alias}`)
          .toBe(false);
      }
    }
  });

  it('keeps every branch key inside the published fields', () => {
    for (const [operationName, contract] of Object.entries(CANONICAL_OPERATIONS)) {
      for (const branch of contract.branches) {
        for (const key of branch) {
          expect(Object.keys(contract.fields), `${operationName}.${key}`).toContain(key);
        }
      }
    }
  });

  it('publishes exactly the canonical fields, plus workspace, on every tool', () => {
    for (const [operationName, contract] of Object.entries(CANONICAL_OPERATIONS)) {
      const schema = tools.get(`linear_${operationName}`)!.parameters as any;
      const objects = schema.properties ? [schema] : schema.anyOf;
      const properties = [...new Set(objects.flatMap((object: any) => Object.keys(object.properties)))];
      expect(properties.sort()).toEqual([...Object.keys(contract.fields), 'workspace'].sort());
    }
  });
});

describe('typed schema validation across all 49 tools', () => {
  it('accepts one canonical sample for every valid branch', () => {
    for (const [operationName, contract] of Object.entries(CANONICAL_OPERATIONS)) {
      const toolName = `linear_${operationName}`;
      for (const branch of contract.branches) {
        const args = sampleBranch(operationName, branch);
        expect(accepts(toolName, args), `${toolName} ${JSON.stringify(branch)}`).toBe(true);
      }
    }
  });

  it('rejects each incomplete branch', () => {
    for (const [operationName, contract] of Object.entries(CANONICAL_OPERATIONS)) {
      const toolName = `linear_${operationName}`;
      for (const branch of contract.branches) {
        const args = sampleBranch(operationName, branch);
        for (const omitted of branch) {
          const partial = { ...args };
          delete partial[omitted];
          const satisfiedByAnother = contract.branches.some((other) =>
            other.every((key) => partial[key] !== undefined));
          if (!satisfiedByAnother) {
            expect(accepts(toolName, partial), `${toolName} without ${omitted}`).toBe(false);
          }
        }
      }
    }
  });

  it('rejects an unknown top-level field on every tool', () => {
    for (const [operationName, contract] of Object.entries(CANONICAL_OPERATIONS)) {
      const toolName = `linear_${operationName}`;
      const args = { ...sampleBranch(operationName, contract.branches[0]!), stale_field: 'x' };
      expect(accepts(toolName, args), toolName).toBe(false);
    }
  });

  it('rejects every known legacy alias on every tool', () => {
    for (const [operationName, contract] of Object.entries(CANONICAL_OPERATIONS)) {
      const toolName = `linear_${operationName}`;
      const base = sampleBranch(operationName, contract.branches[0]!);
      for (const alias of forbiddenAliases(operationName)) {
        expect(accepts(toolName, { ...base, [alias]: 'legacy' }), `${toolName} + ${alias}`).toBe(false);
      }
    }
  });

  it('rejects an empty argument object wherever the operation requires anything', () => {
    for (const [operationName, contract] of Object.entries(CANONICAL_OPERATIONS)) {
      const toolName = `linear_${operationName}`;
      const requiresNothing = contract.branches.some((branch) => branch.length === 0);
      expect(accepts(toolName, {}), toolName).toBe(requiresNothing);
    }
  });

  it('rejects identity-only update and save calls', () => {
    const identities: Array<[string, JsonObject]> = [
      ['linear_update_issue', { issue: 'AEO-258' }],
      ['linear_update_comment', { id: 'comment-1' }],
      ['linear_update_cycle', { id: 'cycle-1' }],
      ['linear_update_document', { document: 'Doc' }],
      ['linear_update_issue_label', { id: 'label-1' }],
      ['linear_update_project_label', { id: 'label-1' }],
      ['linear_update_issue_relation', { id: 'relation-1' }],
      ['linear_update_project_relation', { id: 'relation-1' }],
      ['linear_update_view', { id: 'view-1' }],
      ['linear_save_project', { projectId: 'Roadmap' }],
      ['linear_save_milestone', { milestoneId: 'Beta' }],
      ['linear_save_initiative', { initiativeId: 'Platform' }],
    ];
    for (const [toolName, args] of identities) {
      const operationName = toolName.replace('linear_', '');
      expect(accepts(toolName, args), toolName).toBe(false);
      // The same identity plus one content field is a valid update.
      const withContent = sampleBranch(operationName, requirementBranches(operations[operationName]!).at(-1)!);
      expect(accepts(toolName, withContent), `${toolName} with content`).toBe(true);
    }
  });

  it('rejects empty object and array values where the operation has a contract', () => {
    expect(accepts('linear_list_issues', { filter: {} })).toBe(false);
    expect(accepts('linear_list_issues', { filter: { state: { name: { eq: 'Todo' } } } })).toBe(true);
    expect(accepts('linear_set_view_preferences', { viewId: 'v1', preferences: {} })).toBe(false);
    expect(accepts('linear_list_issues', { sort: [] })).toBe(false);
    expect(accepts('linear_list_issues', { sort: [{ key: 'updatedAt', order: 'Sideways' }] })).toBe(false);
    expect(accepts('linear_list_issues', { sort: [{ key: 'updatedAt' }] })).toBe(true);
    expect(accepts('linear_save_project', { name: 'P', teamIds: [] })).toBe(false);
    expect(accepts('linear_get_issue', { issue: '' })).toBe(false);
  });

  it('enforces the value contracts it publishes', () => {
    expect(accepts('linear_create_issue', { title: 'T', team: 'AEO', priority: 9 })).toBe(false);
    expect(accepts('linear_create_issue', { title: 'T', team: 'AEO', priority: 2 })).toBe(true);
    expect(accepts('linear_create_issue', { title: 'T', team: 'AEO', dueDate: 'next friday' })).toBe(false);
    expect(accepts('linear_create_issue', { title: 'T', team: 'AEO', dueDate: '2026-09-01' })).toBe(true);
    expect(accepts('linear_create_issue_label', { name: 'bug', color: 'red' })).toBe(false);
    expect(accepts('linear_create_issue_label', { name: 'bug', color: '#ff0000' })).toBe(true);
    expect(accepts('linear_list_issues', { view: 'compact' })).toBe(false);
    expect(accepts('linear_list_issues', { view: 'summary' })).toBe(true);
    expect(accepts('linear_list_issues', { view: 'full' })).toBe(true);
    expect(accepts('linear_list_issues', { issues: [] })).toBe(false);
    expect(accepts('linear_list_issues', { issues: ['AEO-258', 'AEO-362'] })).toBe(true);
    expect(accepts('linear_get_issue', { issue: 'AEO-258', view: 'summary' })).toBe(true);
  });

  it('publishes branches as anyOf and single requirements as required', () => {
    expect((tools.get('linear_create_issue')!.parameters as any).anyOf)
      .toEqual([{ required: ['title', 'team'] }, { required: ['title', 'parent'] }]);
    expect((tools.get('linear_get_issue')!.parameters as any).required).toEqual(['issue']);
    expect((tools.get('linear_list_issues')!.parameters as any).required).toBeUndefined();
    for (const tool of tools.values()) {
      const schema = tool.parameters as any;
      const objects = schema.properties ? [schema] : schema.anyOf;
      for (const object of objects) expect(object.additionalProperties).toBe(false);
    }
  });

  it('uses prepareArguments only as a non-mutating strict gate', () => {
    for (const tool of typedLinearTools()) {
      expect(tool.prepareArguments).toBeTypeOf('function');
    }
    // Valid arguments come back as the identical object: no field is added, removed,
    // renamed, or reordered before Pi validates.
    const tool = tools.get('linear_create_issue')!;
    const args = { title: 'T', team: 'AEO', priority: 2, labelIds: [UUID_SAMPLE] };
    const prepared = tool.prepareArguments!(args);
    expect(prepared).toBe(args);
    expect(prepared).toEqual({ title: 'T', team: 'AEO', priority: 2, labelIds: [UUID_SAMPLE] });
  });

  it.each([
    ['top-level', 'linear_update_document', { document: 'Doc', trashed: true }, 'variables.trashed'],
    ['nested', 'linear_list_issues', { filter: { and: [{ trashed: true }] } }, 'variables.filter.and[0].trashed'],
    ['credential-keyed', 'linear_list_issues', { filter: { lin_api_secret123456789: { trashed: true } } }, 'variables.filter.[REDACTED].trashed'],
  ])('runs destructive-input policy before schema validation for %s input', (_case, toolName, args, path) => {
    expect(() => tools.get(toolName)!.prepareArguments!(args)).toThrow(
      `Destructive named input is unavailable at ${path}. Use an authorized raw GraphQL mutation with LINEAR_MUTATIONS=all.`,
    );
  });

  it('preserves read-only precedence in prepareArguments', () => {
    const tool = typedLinearTools('readonly').find(({ name }) => name === 'linear_update_document')!;
    expect(() => tool.prepareArguments!({ document: 'Doc', trashed: true })).toThrow('read-only mode');
  });

  it('does not expose credential-shaped keys in prepareArguments schema errors', () => {
    const failure = (() => {
      try {
        tools.get('linear_get_issue')!.prepareArguments!({ issue: 'AEO-258', lin_api_secret123456789: true });
      } catch (error) {
        return error as Error;
      }
    })();

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).not.toContain('secret123456789');
  });

  it('omits prompt metadata so lazy activation keeps the prompt prefix stable', () => {
    for (const tool of typedLinearTools()) {
      expect(tool.promptSnippet).toBeUndefined();
      expect(tool.promptGuidelines).toBeUndefined();
    }
  });
});

describe('typed execution delegates to the v0.4 operation pipeline', () => {
  const ISSUE_ID = '11111111-1111-4111-8111-111111111111';

  function installServer() {
    const requests: Array<{ query: string; variables: JsonObject }> = [];
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      const request = JSON.parse(String(init.body));
      requests.push(request);
      const { query, variables } = request;
      const data = query.includes('ResolveIssueByIdentifier')
        ? { issues: { nodes: [{ id: ISSUE_ID, identifier: 'AEO-258', team: { id: 'team-1', key: 'AEO' } }] } }
        : query.includes('mutation UpdateIssue')
          ? { issueUpdate: { success: true, issue: { id: variables.id, identifier: 'AEO-258', title: 'Fix login' } } }
          : { issue: { id: variables.id, identifier: 'AEO-258', title: 'Fix login' } };
      return { ok: true, status: 200, statusText: 'OK', headers: new Headers(), json: async () => ({ data }) };
    });
    vi.stubGlobal('fetch', fetch);
    process.env.LINEAR_API_KEY = 'test-key';
    return requests;
  }

  it('resolves references and emits the shared operation GraphQL', async () => {
    const requests = installServer();
    const typedResult = await execute(tools.get('linear_get_issue')!, { issue: 'AEO-258' });

    expect(requests.at(-1)).toMatchObject({
      query: operations.get_issue!.document,
      variables: { id: 'AEO-258' },
    });
    expect(typedResult.details.data.issue).toMatchObject({ id: 'AEO-258', identifier: 'AEO-258' });
  });

  it('reports resolution metadata for renderers', async () => {
    installServer();
    const result = await execute(tools.get('linear_get_issue')!, { issue: 'AEO-258' });
    expect(result.details.resolution.target).toMatchObject({ requested: 'AEO-258', identifier: 'AEO-258' });
  });

  it('enforces the mutation gate in read-only mode', async () => {
    installServer();
    const typed = typedLinearTools('readonly').find((tool) => tool.name === 'linear_update_issue')!;
    await expect(execute(typed, { issue: 'AEO-258', title: 'new' }))
      .rejects.toThrow('read-only mode');
  });
});

describe('execution boundary rejects non-canonical arguments before any network access', () => {
  function installServer() {
    const requests: unknown[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      requests.push(JSON.parse(String(init.body)));
      return { ok: true, status: 200, statusText: 'OK', headers: new Headers(), json: async () => ({ data: {} }) };
    }));
    process.env.LINEAR_API_KEY = 'test-key';
    return requests;
  }

  it('keeps typed tools strict when loader-style dispatch or compatibility aliases are sent', async () => {
    const requests = installServer();
    await expect(execute(tools.get('linear_get_document')!, { query: 'Dispatch doc' }))
      .rejects.toThrow(/query|document/);
    expect(accepts('linear_create_issue', { title: 'T', team: 'AEO', project: 'Dispatch' })).toBe(false);
    expect(accepts('linear_create_issue', { title: 'T', team: 'AEO', labels: [UUID_SAMPLE] })).toBe(false);
    expect(requests).toHaveLength(0);
  });

  it.each([
    ['linear_create_comment', { issue: 'AEO-258', body: 'hi', issueId: 'AEO-999' }, /issueId/],
    ['linear_create_issue', { title: 'T', team: 'AEO', teamId: 'team-9' }, /teamId/],
    ['linear_update_issue', { issue: 'AEO-258', state: 'Done', stateId: 'state-9' }, /stateId/],
    ['linear_create_issue', { title: 'T', parent: 'AEO-258', parentId: 'AEO-999' }, /parentId/],
    ['linear_save_milestone', { milestoneId: 'Beta', name: 'B', input: { projectId: 'p' } }, /input/],
  ])('rejects %s carrying a contradictory alias', async (toolName, args, pattern) => {
    const requests = installServer();
    // The published schema already refuses these; execute() refuses them again so no
    // path can reach credential lookup with two names for one thing.
    expect(accepts(toolName, args)).toBe(false);
    await expect(execute(tools.get(toolName)!, args))
      .rejects.toThrow(pattern as RegExp);
    expect(requests).toHaveLength(0);
  });

  it('states the accepted branches when required parameters are missing', async () => {
    const requests = installServer();
    await expect(execute(tools.get('linear_create_issue')!, { title: 'New' }))
      .rejects.toThrow(/supply \{ title, team \} or \{ title, parent \}/);
    expect(requests).toHaveLength(0);
  });

  it('rejects an identity-only save before any request', async () => {
    const requests = installServer();
    await expect(execute(tools.get('linear_save_project')!, { projectId: 'Roadmap' })).rejects.toThrow();
    expect(requests).toHaveLength(0);
  });

  it('rejects nested destructive semantic fields on typed tools before any request', async () => {
    const requests = installServer();
    await expect(execute(tools.get('linear_list_issues')!, {
      filter: { and: [{ title: { contains: 'trashed' } }, { trashed: true }] },
    })).rejects.toThrow('Destructive named input is unavailable at variables.filter.and[1].trashed');
    expect(requests).toHaveLength(0);
  });

  it('redacts credential-shaped keys from direct typed execution errors', async () => {
    const requests = installServer();
    const failure = await execute(tools.get('linear_get_issue')!, {
      issue: 'AEO-258',
      lin_api_secret123456789: true,
    }).catch((error: Error) => error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain('[REDACTED]');
    expect((failure as Error).message).not.toContain('secret123456789');
    expect(requests).toHaveLength(0);
  });
});

describe('schema cost', () => {
  it('measures the always-on and per-tool schema cost', () => {
    const bytes = (value: { name: string; description: string; parameters: TSchema }) => Buffer.byteLength(JSON.stringify(value), 'utf8');
    const api = linearApiTool() as any;
    const alwaysOn = bytes({ name: api.name, description: api.description, parameters: api.parameters });
    const typed = typedLinearTools().map((tool) => ({
      name: tool.name,
      bytes: bytes({ name: tool.name, description: tool.description, parameters: tool.parameters }),
    }));
    const total = typed.reduce((sum, tool) => sum + tool.bytes, 0);
    const sorted = [...typed].sort((left, right) => left.bytes - right.bytes);

    console.log(`always-on linear schema: ${alwaysOn} bytes`);
    console.log(`all 49 typed schemas: ${total} bytes (median ${sorted[Math.floor(sorted.length / 2)]!.bytes}, min ${sorted[0]!.bytes} ${sorted[0]!.name}, max ${sorted.at(-1)!.bytes} ${sorted.at(-1)!.name})`);
    for (const name of ['linear_get_issue', 'linear_list_issues', 'linear_create_issue', 'linear_create_comment', 'linear_update_issue']) {
      console.log(`  ${name}: ${typed.find((tool) => tool.name === name)!.bytes} bytes`);
    }

    // The point of lazy loading: the always-on cost is one schema, not 49.
    expect(alwaysOn).toBeLessThan(total);
    expect(typed).toHaveLength(Object.keys(operations).length);
  });
});

describe('package hygiene', () => {
  it('never imports from reference/', async () => {
    const files: string[] = [];
    const walk = async (directory: string) => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) await walk(path);
        else if (entry.name.endsWith('.ts')) files.push(path);
      }
    };
    await walk('extensions');
    await walk('test');

    for (const file of files) {
      const source = await readFile(file, 'utf8');
      expect(source, file).not.toMatch(/from\s+['"][^'"]*reference\//);
      expect(source, file).not.toMatch(/import\(['"][^'"]*reference\//);
    }
  });

  it('exposes the canonical field list to the renderers', () => {
    expect(canonicalFieldNames(operations.get_issue!)).toEqual(['issue', 'view']);
    const createIssueFields = canonicalFieldNames(operations.create_issue!);
    expect(createIssueFields.slice(0, 6))
      .toEqual(['title', 'team', 'parent', 'state', 'assignee', 'dueDate']);
    for (const field of ['labelIds', 'projectId', 'cycleId', 'slaType', 'templateId', 'id']) {
      expect(createIssueFields).toContain(field);
    }
  });
});

// ---------------------------------------------------------------------------
// Independent compatibility fixture. These expectations are hard-coded from
// upstream pi-linear 0.4.1 tool schemas and the v0.4 runtime's own accepted
// fields — never derived from CANONICAL_OPERATIONS — so an omission in the
// contract fails here.
// ---------------------------------------------------------------------------

const UUID = '11111111-1111-4111-8111-111111111111';

const COMPATIBILITY: ReadonlyArray<{
  tool: string;
  base: JsonObject;
  /** Whether the base call alone is a complete request. */
  baseAlone: 'accepted' | 'rejected';
  fields: ReadonlyArray<readonly [string, JsonValue]>;
  absent: readonly string[];
}> = [
  {
    tool: 'linear_create_issue',
    baseAlone: 'accepted',
    base: { title: 'Fix login', team: 'AEO' },
    fields: [
      ['description', 'why'],
      ['priority', 2],
      ['estimate', 3],
      ['dueDate', '2026-09-01'],
      ['state', 'Backlog'],
      ['assignee', 'me'],
      ['parent', 'AEO-258'],
      ['projectId', UUID],
      ['cycleId', UUID],
      ['labelIds', [UUID]],
      ['subscriberIds', [UUID]],
    ],
    absent: ['teamId', 'teamKey', 'stateId', 'assigneeId', 'parentId', 'input'],
  },
  {
    tool: 'linear_update_issue',
    baseAlone: 'rejected',
    base: { issue: 'AEO-258' },
    fields: [
      ['title', 'New title'],
      ['description', 'why'],
      ['priority', 0],
      ['estimate', 1],
      ['dueDate', '2026-09-01'],
      ['dueDate', null],
      ['state', 'Done'],
      ['assignee', 'sam@example.com'],
      ['parent', 'AEO-1'],
      ['projectId', UUID],
      ['cycleId', UUID],
      ['labelIds', [UUID]],
      ['addedLabelIds', [UUID]],
      ['removedLabelIds', [UUID]],
      ['subscriberIds', [UUID]],
    ],
    absent: ['issueId', 'stateId', 'assigneeId', 'parentId', 'input', 'trashed'],
  },
  {
    tool: 'linear_create_document',
    baseAlone: 'accepted',
    base: { title: 'Planning notes' },
    fields: [
      ['content', 'body'],
      ['icon', '📄'],
      ['color', '#ff0000'],
      ['issueId', 'AEO-258'],
      ['projectId', UUID],
      ['teamId', 'AEO'],
      ['initiativeId', UUID],
      ['cycleId', UUID],
      ['subscriberIds', [UUID]],
      ['sortOrder', 12.5],
    ],
    absent: ['teamKey', 'input'],
  },
  {
    tool: 'linear_update_document',
    baseAlone: 'rejected',
    base: { document: 'Planning notes' },
    fields: [
      ['title', 'Renamed'],
      ['content', 'body'],
      ['icon', '📄'],
      ['color', '#00ff00'],
      ['issueId', 'AEO-258'],
      ['projectId', UUID],
      ['teamId', 'AEO'],
      ['hiddenAt', null],
      ['sortOrder', 3],
    ],
    absent: ['teamKey', 'input', 'trashed'],
  },
  {
    tool: 'linear_create_comment',
    baseAlone: 'accepted',
    base: { issue: 'AEO-258', body: 'looks good' },
    fields: [],
    absent: ['issueId', 'input'],
  },
  {
    tool: 'linear_list_issues',
    baseAlone: 'accepted',
    base: {},
    fields: [
      ['query', 'login'],
      ['team', 'AEO'],
      ['state', 'Backlog'],
      ['stateType', 'started'],
      ['assignee', 'me'],
      ['first', 25],
      ['includeArchived', true],
      ['orderBy', 'updatedAt'],
      ['filter', { state: { name: { eq: 'Todo' } } }],
      ['sort', [{ key: 'priority', order: 'Ascending' }]],
      ['view', 'summary'],
      ['view', 'full'],
    ],
    absent: ['teamId', 'teamKey', 'stateName', 'assigneeId'],
  },
  {
    tool: 'linear_save_project',
    baseAlone: 'accepted',
    base: { name: 'Auth hardening', teamIds: [UUID] },
    fields: [
      ['description', 'summary'],
      ['content', 'body'],
      ['icon', '🔐'],
      ['color', '#ff0000'],
      ['startDate', '2026-09-01'],
      ['targetDate', '2026-12-01'],
    ],
    absent: ['id', 'templateId', 'input'],
  },
];

describe('upstream and runtime capability coverage', () => {
  it.each(COMPATIBILITY)('$tool accepts each common field', ({ tool, base, baseAlone, fields }) => {
    expect(accepts(tool, base), `${tool} base call`).toBe(baseAlone === 'accepted');
    for (const [field, value] of fields) {
      expect(accepts(tool, { ...base, [field]: value }), `${tool}.${field}`).toBe(true);
    }
  });

  it.each(COMPATIBILITY)('$tool publishes no alias or raw input', ({ tool, base, absent }) => {
    for (const field of absent) {
      expect(accepts(tool, { ...base, [field]: 'x' }), `${tool}.${field}`).toBe(false);
    }
  });

  it('lets an update change only a restored field', () => {
    for (const field of ['projectId', 'cycleId', 'labelIds', 'addedLabelIds', 'removedLabelIds', 'subscriberIds']) {
      const value = field.endsWith('Ids') ? [UUID] : UUID;
      expect(accepts('linear_update_issue', { issue: 'AEO-258', [field]: value }), field).toBe(true);
    }
    for (const field of ['assignee', 'parent', 'projectId', 'projectMilestoneId', 'cycleId', 'dueDate']) {
      expect(accepts('linear_update_issue', { issue: 'AEO-258', [field]: null }), field).toBe(true);
    }
  });

  it('publishes only team keys or UUIDs and rejects a human team name before credential access', async () => {
    const schema = tools.get('linear_create_issue')!.parameters.properties.team;
    expect(schema.description).toBe('Team key such as ABC, or a team UUID.');
    await expect(operations.create_issue.plan!({ title: 'T', team: 'AEO' })).resolves.toBeDefined();
    await expect(operations.create_issue.plan!({ title: 'T', team: UUID })).resolves.toBeDefined();
    await expect(operations.create_issue.plan!({ title: 'T', team: 'Core Team' }))
      .rejects.toThrow('Use a team key or UUID.');
  });

  it('rejects malformed values for the restored fields', () => {
    expect(accepts('linear_create_issue', { title: 'T', team: 'AEO', projectId: 'not-a-uuid' })).toBe(false);
    expect(accepts('linear_create_issue', { title: 'T', team: 'AEO', labelIds: [] })).toBe(false);
    expect(accepts('linear_create_issue', { title: 'T', team: 'AEO', labelIds: ['nope'] })).toBe(false);
    expect(accepts('linear_update_issue', { issue: 'AEO-1', dueDate: 'clear' })).toBe(false);
    // create_issue has no nullable due date: Pi drops the null instead of forwarding it.
    expect(validate('linear_create_issue', { title: 'T', team: 'AEO', dueDate: null }))
      .toEqual({ title: 'T', team: 'AEO' });
    // update_issue publishes it as nullable, so the null survives validation and clears.
    expect(validate('linear_update_issue', { issue: 'AEO-1', dueDate: null }))
      .toEqual({ issue: 'AEO-1', dueDate: null });
  });
});

describe('view preferences contract', () => {
  const base = { viewId: 'view-1' };
  const booleanKeys = [
    'showEmptyGroups', 'fieldEstimate', 'fieldPriority', 'fieldDueDate',
    'fieldStatus', 'fieldProject', 'fieldAssignee', 'fieldLabels',
  ];

  it('accepts each string key', () => {
    for (const key of ['issueGrouping', 'issueSubGrouping']) {
      expect(accepts('linear_set_view_preferences', { ...base, preferences: { [key]: 'status' } }), key).toBe(true);
      expect(accepts('linear_set_view_preferences', { ...base, preferences: { [key]: { nested: true } } }), `${key} wrong type`).toBe(false);
    }
  });

  it('accepts each boolean key and rejects wrong types', () => {
    for (const key of booleanKeys) {
      expect(accepts('linear_set_view_preferences', { ...base, preferences: { [key]: true } }), key).toBe(true);
      expect(accepts('linear_set_view_preferences', { ...base, preferences: { [key]: 'maybe' } }), `${key} wrong type`).toBe(false);
    }
  });

  it('rejects unknown keys and empty preferences', () => {
    expect(accepts('linear_set_view_preferences', { ...base, preferences: { foo: 'bar' } })).toBe(false);
    expect(accepts('linear_set_view_preferences', { ...base, preferences: { issueGrouping: 'status', foo: 1 } })).toBe(false);
    expect(accepts('linear_set_view_preferences', { ...base, preferences: {} })).toBe(false);
    expect(accepts('linear_set_view_preferences', base)).toBe(false);
  });

  it('publishes the finite preference schema', () => {
    const preferences = (tools.get('linear_set_view_preferences')!.parameters as any).properties.preferences;
    expect(Object.keys(preferences.properties).sort())
      .toEqual([...booleanKeys, 'issueGrouping', 'issueSubGrouping'].sort());
    expect(preferences.additionalProperties).toBe(false);
    expect(preferences.minProperties).toBe(1);
  });

  it('makes zero network calls for a rejected preferences payload', async () => {
    const requests: unknown[] = [];
    vi.stubGlobal('fetch', vi.fn(async () => {
      requests.push(1);
      return { ok: true, status: 200, statusText: 'OK', headers: new Headers(), json: async () => ({ data: {} }) };
    }));
    process.env.LINEAR_API_KEY = 'test-key';
    await expect(execute(tools.get('linear_set_view_preferences')!, { viewId: 'v1', preferences: { foo: 'bar' } }))
      .rejects.toThrow(/Invalid arguments for "linear_set_view_preferences"/);
    expect(requests).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Raw-argument strictness. prepareArguments runs before Pi's Value.Convert, so
// these checks describe what a typed tool accepts before any coercion.
// ---------------------------------------------------------------------------

const UUID_SAMPLE = '11111111-1111-4111-8111-111111111111';

function rawAccepts(toolName: string, args: UnparsedJson): boolean {
  try {
    tools.get(toolName)!.prepareArguments!(args);
    return true;
  } catch {
    return false;
  }
}

describe('strict raw arguments before Pi conversion', () => {
  it('rejects a raw number where the schema says string', () => {
    expect(rawAccepts('linear_get_issue', { issue: 123 })).toBe(false);
    expect(rawAccepts('linear_get_issue', { issue: 'AEO-258' })).toBe(true);
    expect(rawAccepts('linear_create_comment', { issue: 'AEO-1', body: 42 })).toBe(false);
  });

  it('rejects a string where the schema says boolean or integer', () => {
    expect(rawAccepts('linear_list_issues', { includeArchived: 'true' })).toBe(false);
    expect(rawAccepts('linear_list_issues', { includeArchived: true })).toBe(true);
    expect(rawAccepts('linear_list_issues', { first: '25' })).toBe(false);
    expect(rawAccepts('linear_list_issues', { first: 25 })).toBe(true);
    expect(rawAccepts('linear_create_issue', { title: 'T', team: 'AEO', priority: '2' })).toBe(false);
  });

  it('rejects an invalid null and keeps valid nullable updates', () => {
    expect(rawAccepts('linear_get_issue', { issue: null })).toBe(false);
    expect(rawAccepts('linear_create_issue', { title: 'T', team: 'AEO', dueDate: null })).toBe(false);
    for (const field of ['assignee', 'parent', 'projectId', 'projectMilestoneId', 'cycleId', 'dueDate']) {
      expect(rawAccepts('linear_update_issue', { issue: 'AEO-1', [field]: null }), field).toBe(true);
    }
    expect(rawAccepts('linear_update_issue', { issue: 'AEO-1', dueDate: '2026-09-01' })).toBe(true);
  });

  it('rejects unknown fields and bad nested values', () => {
    expect(rawAccepts('linear_get_issue', { issue: 'AEO-1', stale: 1 })).toBe(false);
    expect(rawAccepts('linear_set_view_preferences', { viewId: 'v', preferences: { fieldEstimate: 'true' } })).toBe(false);
    expect(rawAccepts('linear_set_view_preferences', { viewId: 'v', preferences: { fieldEstimate: true } })).toBe(true);
    expect(rawAccepts('linear_set_view_preferences', { viewId: 'v', preferences: { issueGrouping: 'nonsense' } })).toBe(false);
    expect(rawAccepts('linear_set_view_preferences', { viewId: 'v', preferences: { issueGrouping: 'cycle' } })).toBe(true);
    expect(rawAccepts('linear_list_issues', { sort: [{ key: 'nonsense' }] })).toBe(false);
    expect(rawAccepts('linear_list_issues', { sort: [{ key: 'priority' }] })).toBe(true);
    expect(rawAccepts('linear_list_issues', { issues: 'AEO-258' })).toBe(false);
    expect(rawAccepts('linear_list_issues', { issues: ['AEO-258'] })).toBe(true);
  });

  it('makes zero network calls for a coerced-scalar call', async () => {
    const requests: unknown[] = [];
    vi.stubGlobal('fetch', vi.fn(async () => {
      requests.push(1);
      return { ok: true, status: 200, statusText: 'OK', headers: new Headers(), json: async () => ({ data: {} }) };
    }));
    process.env.LINEAR_API_KEY = 'test-key';

    await expect(execute(tools.get('linear_list_issues')!, { first: '25' }))
      .rejects.toThrow(/Invalid arguments/);
    await expect(execute(tools.get('linear_get_issue')!, { issue: 123 }))
      .rejects.toThrow(/Invalid arguments/);
    expect(requests).toHaveLength(0);
  });

  it('leaves a valid call byte-equivalent through the whole gate', () => {
    const args = {
      issue: 'AEO-258',
      title: 'New title',
      priority: 0,
      dueDate: null,
      labelIds: [UUID_SAMPLE],
      sortOrder: 1.5,
    };
    const snapshot = JSON.stringify(args);
    const prepared = tools.get('linear_update_issue')!.prepareArguments!(args);
    expect(JSON.stringify(prepared)).toBe(snapshot);
    expect(JSON.stringify(validate('linear_update_issue', args))).toBe(snapshot);
  });
});
