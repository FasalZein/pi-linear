import { readFile } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { validateToolArguments } from '../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/utils/validation.js';
import { registerLinearExtension } from '../extensions/index';
import { operationDefinitions } from '../extensions/operations';
import { SAFE_NAMED_MUTATION_ROOTS } from '../extensions/safety';
import type { JsonObject } from '../extensions/json';
import { isolateLinearCredentials } from './helpers/credentials';
import {
  IDS,
  MUTATION_CASES,
  NamedMutationFixtureServer,
  type MutationFixtureCase,
} from './helpers/e2e-named-mutation-fixture';

isolateLinearCredentials();

const originalApiKey = process.env.LINEAR_API_KEY;
const nativeFetch = globalThis.fetch;
const fixture = new NamedMutationFixtureServer();

const E2E_BOUNDARY = {
  piHost: 'minimal fake ExtensionAPI host; production extension registration and tool definitions are real',
  provider: 'none; no model or provider call is made',
  transport: 'real Node fetch over TCP to a loopback HTTP GraphQL fixture server',
} as const;

type RegisteredTool = {
  name: string;
  parameters?: unknown;
  prepareArguments?: (args: JsonObject) => JsonObject;
  execute: (...args: any[]) => Promise<any>;
};

function fakePiHost() {
  const registered: RegisteredTool[] = [];
  const handlers = new Map<string, Array<(...args: any[]) => unknown>>();
  let active = ['read', 'bash'];
  const pi = {
    registerCommand: () => undefined,
    registerTool: (tool: RegisteredTool) => {
      registered.push(tool);
      active.push(tool.name);
    },
    getActiveTools: () => [...active],
    getAllTools: () => registered.map(({ name, parameters }) => ({ name, parameters })),
    setActiveTools: (names: string[]) => { active = [...names]; },
    on: (event: string, handler: (...args: any[]) => unknown) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
  };
  return {
    pi: pi as any,
    tool(name: string): RegisteredTool {
      const tool = registered.find((candidate) => candidate.name === name);
      if (!tool) throw new Error(`Test host has no registered tool ${name}.`);
      return tool;
    },
    activeTools: () => [...active],
    async startSession(): Promise<void> {
      for (const handler of handlers.get('session_start') ?? []) {
        await handler({}, { hasUI: false });
      }
    },
  };
}

type Harness = Awaited<ReturnType<typeof loadExtension>>;

async function loadExtension(mode: 'allowlist' | 'readonly' = 'allowlist') {
  const host = fakePiHost();
  registerLinearExtension(host.pi, mode);
  await host.startSession();
  return host;
}

async function activateAndExecute(harness: Harness, testCase: MutationFixtureCase, args: JsonObject = testCase.args) {
  const loader = harness.tool('linear');
  const help = await loader.execute(
    'help-call',
    { operation: 'help', variables: { operation: testCase.operation } },
    undefined,
    undefined,
    { hasUI: false },
  );
  const toolName = `linear_${testCase.operation}`;
  expect(help.details.loadedTools ?? []).toContain(toolName);
  expect(harness.activeTools()).toContain(toolName);

  const tool = harness.tool(toolName);
  const prepared = tool.prepareArguments ? tool.prepareArguments(args) : args;
  validateToolArguments(tool as any, {
    id: `call-${testCase.operation}-${testCase.root}`,
    name: toolName,
    arguments: prepared,
  } as any);
  return tool.execute(
    `call-${testCase.operation}-${testCase.root}`,
    prepared,
    undefined,
    undefined,
    { hasUI: false },
  );
}

function mutationRequests() {
  return fixture.requests().filter(({ kind }) => kind === 'mutation');
}

beforeAll(async () => {
  await fixture.start();
});

beforeEach(() => {
  process.env.LINEAR_API_KEY = 'lin_api_local_fixture_only_123456789';
  fixture.reset();
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    const attempted = String(input);
    if (attempted !== 'https://api.linear.app/graphql') {
      throw new Error(`Unexpected GraphQL destination ${attempted}.`);
    }
    return nativeFetch(fixture.url, init);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalApiKey === undefined) delete process.env.LINEAR_API_KEY;
  else process.env.LINEAR_API_KEY = originalApiKey;
});

afterAll(async () => {
  await fixture.stop();
});

describe.sequential('named mutation E2E inventory', () => {
  it('records the real and fake boundaries and derives exact manifest coverage', async () => {
    expect(E2E_BOUNDARY).toEqual({
      piHost: 'minimal fake ExtensionAPI host; production extension registration and tool definitions are real',
      provider: 'none; no model or provider call is made',
      transport: 'real Node fetch over TCP to a loopback HTTP GraphQL fixture server',
    });

    const manifest = JSON.parse(await readFile(
      new URL('../extensions/generated/linear-tools.manifest.json', import.meta.url),
      'utf8',
    )) as { lazyTools: Array<{ name: string; operation: string }> };
    const manifestOperations = new Set(manifest.lazyTools.map(({ operation }) => operation));
    const definitions = operationDefinitions.filter(({ kind }) => kind === 'mutation');
    const actualVariants = definitions.flatMap((definition) =>
      definition.graphql?.documents.map(({ root }) => `${definition.name}:${root}`) ?? []);
    const coveredVariants = MUTATION_CASES.map(({ operation, root }) => `${operation}:${root}`);

    expect(definitions).toHaveLength(23);
    expect(actualVariants).toHaveLength(26);
    expect(new Set(MUTATION_CASES.map(({ operation }) => operation))).toHaveLength(23);
    expect([...coveredVariants].sort()).toEqual([...actualVariants].sort());
    for (const definition of definitions) {
      expect(manifestOperations.has(definition.name), `manifest operation ${definition.name}`).toBe(true);
      expect(manifest.lazyTools.some(({ name }) => name === `linear_${definition.name}`)).toBe(true);
    }
  });
});

describe.sequential('all named mutation variants through loaded direct tools and loopback HTTP', () => {
  it.each(MUTATION_CASES)(
    '$operation sends $root with prepared variables and returns the server identity',
    async (testCase) => {
      fixture.reset(testCase);
      const harness = await loadExtension();
      const result = await activateAndExecute(harness, testCase);

      expect(fixture.fixtureErrors()).toEqual([]);
      expect(mutationRequests()).toHaveLength(1);
      expect(mutationRequests()[0]).toMatchObject({
        root: testCase.root,
        variables: testCase.expectedVariables,
      });
      expect(JSON.stringify(testCase.expectedVariables)).not.toContain('"view"');

      if (testCase.operation === 'delete_issue_relation') {
        expect(result.details.data.issueRelationDelete).toEqual({
          relationId: IDS.relation,
          issue: IDS.issue,
          relatedIssue: IDS.relatedIssue,
          type: 'related',
          deleted: true,
        });
      } else {
        const entity = result.details.data[testCase.root][testCase.entityPath!];
        expect(entity.id).toBe(testCase.serverId);
        expect(entity.name).toBe(`Server ${testCase.operation} ${testCase.root}`);
        expect(entity.privateFixtureDetails).toBeUndefined();
        expect(result.details.meta.view).toBe('summary');
      }
    },
  );

  it('keeps full result view out of GraphQL variables while returning the full server entity', async () => {
    const base = MUTATION_CASES.find(({ root }) => root === 'projectUpdate')!;
    const fullCase = { ...base, args: { ...base.args, view: 'full' } };
    fixture.reset(fullCase);
    const result = await activateAndExecute(await loadExtension(), fullCase, fullCase.args);

    expect(fixture.fixtureErrors()).toEqual([]);
    expect(mutationRequests()).toHaveLength(1);
    expect(mutationRequests()[0]!.variables).toEqual(base.expectedVariables);
    expect(JSON.stringify(mutationRequests()[0]!.variables)).not.toContain('"view"');
    expect(result.details.meta.view).toBe('full');
    expect(result.details.data.projectUpdate.project).toMatchObject({
      id: base.serverId,
      privateFixtureDetails: 'returned only for full result view',
    });
  });
});

describe.sequential('mutation safety and exact identity failures', () => {
  it('blocks every mutation operation in read-only mode before any network request', async () => {
    const casesByOperation = new Map(MUTATION_CASES.map((testCase) => [testCase.operation, testCase]));
    const harness = await loadExtension('readonly');
    for (const testCase of casesByOperation.values()) {
      const tool = harness.tool(`linear_${testCase.operation}`);
      expect(() => tool.prepareArguments?.(testCase.args), testCase.operation)
        .toThrow('Linear mutations are disabled by read-only mode.');
    }
    expect(fixture.requests()).toEqual([]);
  });

  it('checks every declared mutation root against the named allowlist before any network request', async () => {
    const harness = await loadExtension();
    for (const testCase of MUTATION_CASES) {
      SAFE_NAMED_MUTATION_ROOTS.delete(testCase.root);
      try {
        const tool = harness.tool(`linear_${testCase.operation}`);
        expect(() => tool.prepareArguments?.(testCase.args), `${testCase.operation}:${testCase.root}`)
          .toThrow(`${testCase.root} is not in the safe named-root set.`);
      } finally {
        SAFE_NAMED_MUTATION_ROOTS.add(testCase.root);
      }
    }
    expect(fixture.requests()).toEqual([]);
  });

  it.each(['document-missing', 'document-ambiguous'] as const)(
    'resolves a document title exactly and sends zero writes when identity is %s',
    async (behavior) => {
      const base = MUTATION_CASES.find(({ operation }) => operation === 'update_document')!;
      fixture.reset(undefined, behavior);
      const harness = await loadExtension();
      await expect(activateAndExecute(harness, base, {
        document: 'Fixture planning notes',
        title: 'Must not be written',
      })).rejects.toThrow(behavior === 'document-missing' ? 'resolved to 0 matches' : 'resolved to 2 matches');
      expect(mutationRequests()).toEqual([]);
      expect(fixture.requests()).toHaveLength(1);
      expect(fixture.requests()[0]).toMatchObject({ operationName: 'ResolveNamedEntityByReference', kind: 'query' });
    },
  );

  it('updates a document by its exact slug over loopback HTTP', async () => {
    const base = MUTATION_CASES.find(({ operation }) => operation === 'update_document')!;
    const bySlug: MutationFixtureCase = {
      ...base,
      args: { document: 'fixture-notes', title: 'Renamed by slug' },
      expectedVariables: { id: IDS.document, input: { title: 'Renamed by slug' } },
    };
    fixture.reset(bySlug);

    const result = await activateAndExecute(await loadExtension(), bySlug);

    expect(fixture.fixtureErrors()).toEqual([]);
    expect(fixture.requests()[0]).toMatchObject({ operationName: 'ResolveNamedEntityByReference', kind: 'query' });
    expect(fixture.requests()[0]!.query).toContain('slugId');
    expect(mutationRequests()).toHaveLength(1);
    expect(result.details.resolution.target).toMatchObject({ requested: 'fixture-notes', resolvedId: IDS.document });
  });

  it('creates an issue from exact label names over loopback HTTP', async () => {
    const base = MUTATION_CASES.find(({ operation }) => operation === 'create_issue')!;
    const byLabelName: MutationFixtureCase = {
      ...base,
      args: { title: 'Fixture issue', team: IDS.team, labels: ['fixture-needs-review'] },
      expectedVariables: { input: { title: 'Fixture issue', teamId: IDS.team, labelIds: [IDS.issueLabel] } },
    };
    fixture.reset(byLabelName);

    const result = await activateAndExecute(await loadExtension(), byLabelName);

    expect(fixture.fixtureErrors()).toEqual([]);
    expect(fixture.requests().map(({ operationName }) => operationName))
      .toEqual(['ResolveTeamById', 'ResolveNamedEntityByName', 'CreateIssue']);
    expect(mutationRequests()).toHaveLength(1);
    expect(result.details.resolution.labels).toEqual([
      { requested: 'fixture-needs-review', resolvedId: IDS.issueLabel },
    ]);
  });

  it.each(['label-missing', 'label-ambiguous'] as const)(
    'resolves a label name exactly and sends zero writes when identity is %s',
    async (behavior) => {
      const base = MUTATION_CASES.find(({ operation }) => operation === 'create_issue')!;
      fixture.reset(undefined, behavior);

      await expect(activateAndExecute(await loadExtension(), base, {
        title: 'Must not be written',
        team: IDS.team,
        labels: ['fixture-needs-review'],
      })).rejects.toThrow(behavior === 'label-missing' ? 'resolved to 0 matches' : 'resolved to 2 matches');
      expect(mutationRequests()).toEqual([]);
      expect(fixture.requests().map(({ operationName }) => operationName))
        .toEqual(['ResolveTeamById', 'ResolveNamedEntityByName']);
    },
  );

  it('requires all four guarded delete values before network access', async () => {
    const testCase = MUTATION_CASES.find(({ operation }) => operation === 'delete_issue_relation')!;
    const harness = await loadExtension();
    const tool = harness.tool('linear_delete_issue_relation');
    for (const missing of ['relationId', 'issue', 'relatedIssue', 'type']) {
      const invalid = { ...testCase.args };
      delete invalid[missing];
      expect(() => tool.prepareArguments?.(invalid), missing).toThrow();
    }
    expect(fixture.requests()).toEqual([]);
  });

  it('checks the relation identity and endpoints before guarded delete', async () => {
    const testCase = MUTATION_CASES.find(({ operation }) => operation === 'delete_issue_relation')!;
    fixture.reset(testCase, 'delete-mismatch');
    await expect(activateAndExecute(await loadExtension(), testCase))
      .rejects.toThrow('Linear issue relation did not match the exact delete guard.');
    expect(fixture.fixtureErrors()).toEqual([]);
    expect(mutationRequests()).toEqual([]);
    expect(fixture.requests()).toHaveLength(1);
    expect(fixture.requests()[0]).toMatchObject({ operationName: 'VerifyIssueRelationDelete', kind: 'query' });
  });
});
