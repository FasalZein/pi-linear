import { Type } from 'typebox';
import { afterEach, describe, expect, it } from 'vitest';
import { fauxAssistantMessage, type Context } from '@earendil-works/pi-ai';
import manifest from '../extensions/generated/linear-tools.manifest.json';
import { registerLinearExtension } from '../extensions/index';
import {
  FIXTURE_KEY,
  createHostSession,
  executeActiveTool,
  issue,
  linearToolNames,
  resetHostFixtures,
  snapshotContext,
  startGraphQLServer,
  toolNames,
} from './helpers/pi-host-session';

/**
 * A mock host with the same visibility contract as Pi: tools register into a registry,
 * a registry refresh re-activates every permitted tool, and the extension may only
 * repair a refresh, never an explicit selection.
 */
function extensionVisibilityHarness(options: {
  omitRegistration?: string;
  driftSchema?: string;
  initialActive?: string[];
  deferSessionStart?: boolean;
  activateOnRegister?: boolean;
} = {}) {
  const allowed = new Set([...manifest.allowedTools, 'host_sentinel', ...(options.initialActive ?? [])]);
  const registered: Array<{ name: string; parameters?: unknown; execute?: (...args: any[]) => unknown }> = [];
  const handlers = new Map<string, Array<() => void>>();
  let active = options.initialActive ? [...options.initialActive] : ['host_sentinel'];
  let setActiveCalls = 0;
  const pi = {
    registerCommand: () => undefined,
    registerTool: (tool: { name: string; parameters?: unknown; execute?: (...args: any[]) => unknown }) => {
      if (tool.name !== options.omitRegistration) {
        registered.push(tool.name === options.driftSchema ? { ...tool, parameters: Type.Object({ drift: Type.String() }) } : tool);
      }
      if (options.activateOnRegister !== false && allowed.has(tool.name)) active.push(tool.name);
    },
    getActiveTools: () => [...active],
    getAllTools: () => registered.map(({ name, parameters }) => ({ name, parameters })),
    setActiveTools: (names: string[]) => {
      setActiveCalls += 1;
      active = names.filter((name) => allowed.has(name));
    },
    on: (event: string, handler: () => void) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
  };
  registerLinearExtension(pi as any);
  const emit = (event: string) => handlers.get(event)?.forEach((handler) => handler());
  if (!options.deferSessionStart) emit('session_start');
  const allLinear = () => registered.map(({ name }) => name).filter((name) => name === 'linear' || name.startsWith('linear_'));
  return {
    active: () => [...active],
    allLinear,
    emit,
    setActive: (names: string[]) => { active = [...names]; },
    setActiveCalls: () => setActiveCalls,
    tool: (name: string) => registered.find((tool) => tool.name === name),
    /**
     * Another extension registers a tool and the host rebuilds the registry: it keeps the
     * previous active list and appends every permitted tool. A tool allowlist hides the new
     * tool from the registry view, which `visible: false` reproduces.
     */
    refreshRegistry: (options: { visible?: boolean } = {}) => {
      const name = 'fixture_registry_refresh';
      if (options.visible) {
        registered.push({ name, parameters: Type.Object({}) });
        allowed.add(name);
      }
      active = [...new Set([...active, ...registered.map((tool) => tool.name).filter((tool) => allowed.has(tool))])];
    },
  };
}

afterEach(resetHostFixtures);

describe('Linear deferred tool visibility state', () => {
  it('rejects incomplete, drifted, and unexpectedly active startup tool registrations', () => {
    const missing = extensionVisibilityHarness({ omitRegistration: 'linear_get_issue', deferSessionStart: true });
    expect(() => missing.emit('session_start')).toThrow(
      'Linear tool configuration error: manifest entries are not registered: linear_get_issue.',
    );

    const drifted = extensionVisibilityHarness({ driftSchema: 'linear_get_issue', deferSessionStart: true });
    expect(() => drifted.emit('session_start')).toThrow(
      'Linear tool configuration error: generated schema drift for manifest entry linear_get_issue.',
    );

    const unexpected = extensionVisibilityHarness({
      initialActive: ['host_sentinel', 'linear_unexpected'],
      deferSessionStart: true,
    });
    expect(() => unexpected.emit('session_start')).toThrow(
      'Linear tool configuration error: initial active tools are linear_unexpected, linear, linear_get_result; expected linear, linear_get_result.',
    );
  });

  it('activates linear and linear_get_result when the host leaves registered tools inactive', () => {
    const cases = [
      ['host_sentinel'],
      ['host_sentinel', 'linear'],
      ['host_sentinel', 'linear_get_result'],
      ['host_sentinel', 'linear_get_result', 'linear'],
      ['linear_get_result', 'host_sentinel'],
    ];
    for (const initialActive of cases) {
      const harness = extensionVisibilityHarness({
        activateOnRegister: false,
        initialActive,
        deferSessionStart: true,
      });
      expect(() => harness.emit('session_start'), initialActive.join(',')).not.toThrow();
      expect(
        harness.active().filter((name) => name === 'linear' || name.startsWith('linear_')),
        initialActive.join(','),
      ).toEqual(['linear', 'linear_get_result']);
      expect(harness.active(), initialActive.join(',')).toContain('host_sentinel');
    }
  });

  it('does not reset the host tool selection when every permitted Linear tool was explicitly activated', async () => {
    const harness = extensionVisibilityHarness();
    const loader = harness.tool('linear');
    if (!loader?.execute) throw new Error('Missing Linear loader.');

    for (const operation of [
      ...manifest.lazyTools.map(({ operation }) => operation),
      ...manifest.exceptionalTools.filter(({ deferred }) => deferred).map(({ helpName }) => helpName),
    ]) {
      await loader.execute(`load-${operation}`, { operation: 'help', variables: { operation } });
    }

    const explicitlyActivated = harness.active();
    expect(new Set(explicitlyActivated)).toEqual(new Set(['host_sentinel', ...harness.allLinear()]));
    const callsBeforePrompt = harness.setActiveCalls();
    harness.emit('before_agent_start');
    expect(harness.setActiveCalls()).toBe(callsBeforePrompt);
    expect(harness.active()).toEqual(explicitlyActivated);
  });

  it('repairs a bulk registry refresh without undoing an explicit active-tool choice', async () => {
    const harness = extensionVisibilityHarness();
    expect(harness.active()).toEqual(['host_sentinel', 'linear', 'linear_get_result']);

    const loader = harness.tool('linear');
    if (!loader?.execute) throw new Error('Missing Linear loader.');
    await loader.execute('call-help', { operation: 'help', variables: { operation: 'get_issue' } });
    expect(harness.active()).toEqual(['host_sentinel', 'linear', 'linear_get_result', 'linear_get_issue']);

    harness.setActive(['host_sentinel', 'linear_get_result']);
    harness.emit('agent_end');
    harness.refreshRegistry({ visible: true });
    harness.emit('agent_end');
    harness.emit('before_agent_start');
    // The repair restores the remembered Linear selection and keeps every non-Linear tool.
    expect(harness.active()).toEqual(['host_sentinel', 'linear_get_result', 'fixture_registry_refresh']);

    harness.emit('before_agent_start');
    expect(harness.active()).toEqual(['host_sentinel', 'linear_get_result', 'fixture_registry_refresh']);
  });

  /**
   * Regression: exact help that activates nothing new used to record the refreshed bulk
   * state as a legitimate selection. `agent_end` then skipped it and the next prompt
   * boundary restored all 53 permitted Linear tools.
   */
  it('does not accept a bulk registry refresh as a selection through a no-op help call', async () => {
    const harness = extensionVisibilityHarness();
    const loader = harness.tool('linear');
    if (!loader?.execute) throw new Error('Missing Linear loader.');

    harness.refreshRegistry();
    expect(harness.active().length).toBe(1 + harness.allLinear().length);

    const help = await loader.execute('call-help', {
      operation: 'help', variables: { operation: 'get_issue' },
    }) as { addedToolNames?: string[] };
    expect(help.addedToolNames).toBeUndefined();
    harness.emit('agent_end');
    harness.emit('before_agent_start');

    expect(harness.active()).toEqual([
      'host_sentinel', 'linear', 'linear_get_result', 'linear_get_issue',
    ]);
  });

  /**
   * Regression: a deliberate host selection of every permitted Linear tool is not a
   * registry refresh. The prompt boundary used to replace it with the startup snapshot.
   */
  it('keeps a deliberate host selection of every permitted Linear tool across a prompt boundary', async () => {
    const contexts: Context[] = [];
    const { session } = await createHostSession({
      fullLinearAllowlist: true,
      sentinel: true,
      responses: [(context: Context) => {
        contexts.push(snapshotContext(context));
        return fauxAssistantMessage('done');
      }],
    });
    expect(session.getActiveToolNames()).toEqual(['linear', 'linear_get_result', 'host_sentinel']);

    session.setActiveToolsByName([...manifest.allowedTools, 'host_sentinel']);
    expect(linearToolNames(session.getActiveToolNames())).toHaveLength(53);

    await session.prompt('Use the fully activated Linear surface.');

    expect(linearToolNames(toolNames(contexts[0]!))).toHaveLength(53);
    expect(linearToolNames(session.getActiveToolNames())).toHaveLength(53);
    expect(session.getActiveToolNames()).toContain('host_sentinel');
  }, 30_000);

  it('keeps the full 53-tool permission gate deferred across activation, use, and reload', async () => {
    const { endpoint, requests } = await startGraphQLServer(() => ({
      body: { data: { issue: issue('AEO-1', 'Allowed issue') } },
    }));
    process.env.LINEAR_API_KEY = FIXTURE_KEY;
    process.env.LINEAR_READONLY = '1';
    process.env.LINEAR_SMOKE_GRAPHQL_ENDPOINT = endpoint;
    const { session } = await createHostSession({ fullLinearAllowlist: true });

    expect(manifest.allowedTools).toHaveLength(53);
    expect(session.getAllTools().filter(({ name }) => name === 'linear' || name.startsWith('linear_'))).toHaveLength(53);
    expect(session.getActiveToolNames()).toEqual(['linear', 'linear_get_result']);

    const firstLoad = await executeActiveTool(session, 'linear', {
      operation: 'help', variables: { operation: 'get_issue' },
    });
    expect(firstLoad.addedToolNames).toEqual(['linear_get_issue']);
    await expect(executeActiveTool(session, 'linear_get_issue', { issue: 'AEO-1' }))
      .resolves.toMatchObject({ details: { data: { issue: { identifier: 'AEO-1' } } } });
    expect(session.getActiveToolNames()).toEqual(['linear', 'linear_get_result', 'linear_get_issue']);

    await session.reload();
    expect(session.getActiveToolNames()).toEqual(['linear', 'linear_get_result']);
    const reloaded = await executeActiveTool(session, 'linear', {
      operation: 'help', variables: { operation: 'get_issue' },
    });
    expect(reloaded.addedToolNames).toEqual(['linear_get_issue']);
    await expect(executeActiveTool(session, 'linear_get_issue', { issue: 'AEO-1' }))
      .resolves.toMatchObject({ details: { data: { issue: { identifier: 'AEO-1' } } } });
    expect(requests).toHaveLength(2);
  }, 30_000);

  it('respects an explicit active-tool choice after exact help activation', async () => {
    const contexts: Context[] = [];
    const { session } = await createHostSession({
      fullLinearAllowlist: true,
      sentinel: true,
      registryRefreshExtension: true,
      responses: [
        (context: Context) => {
          contexts.push(snapshotContext(context));
          return fauxAssistantMessage('first');
        },
        (context: Context) => {
          contexts.push(snapshotContext(context));
          return fauxAssistantMessage('second');
        },
      ],
    });
    expect(session.getActiveToolNames()).toEqual(['linear', 'linear_get_result', 'host_sentinel']);
    await executeActiveTool(session, 'linear', {
      operation: 'help', variables: { operation: 'get_issue' },
    });
    expect(session.getActiveToolNames()).toEqual([
      'linear', 'linear_get_result', 'host_sentinel', 'linear_get_issue',
    ]);

    session.setActiveToolsByName(['linear_get_result', 'host_sentinel']);
    await session.prompt('Respect the selected profile.');
    expect(linearToolNames(session.getActiveToolNames())).toHaveLength(53);
    await session.prompt('Keep respecting the selected profile after refresh.');

    expect(toolNames(contexts[0]!)).toEqual(['linear_get_result', 'host_sentinel']);
    expect(toolNames(contexts[1]!)).toEqual(['linear_get_result', 'host_sentinel']);
    expect(session.getActiveToolNames()).toEqual(['linear_get_result', 'host_sentinel']);

    session.setActiveToolsByName(['linear_get_result', 'host_sentinel', 'linear']);
    const restored = await executeActiveTool(session, 'linear', {
      operation: 'help', variables: { operation: 'get_issue' },
    });
    expect(restored.addedToolNames).toEqual(['linear_get_issue']);
  }, 30_000);

  it('allows a parent loader to hide Linear tools on the first user-prompt boundary', async () => {
    const contexts: Context[] = [];
    const { session } = await createHostSession({
      fullLinearAllowlist: true,
      sentinel: true,
      hideLinearOnFirstPrompt: true,
      responses: [(context: Context) => {
        contexts.push(snapshotContext(context));
        return fauxAssistantMessage('done');
      }],
    });
    expect(session.getActiveToolNames()).toEqual(['linear', 'linear_get_result', 'host_sentinel']);

    await session.prompt('Run without the discovery loader.');

    expect(toolNames(contexts[0]!)).toEqual(['host_sentinel']);
    expect(session.getActiveToolNames()).toEqual(['host_sentinel']);
  }, 30_000);

  it('restores deferred visibility at the next user-prompt boundary after a registry refresh', async () => {
    const contexts: Context[] = [];
    const responses = [
      (context: Context) => {
        contexts.push(snapshotContext(context));
        return fauxAssistantMessage('first turn');
      },
      (context: Context) => {
        contexts.push(snapshotContext(context));
        return fauxAssistantMessage('second turn');
      },
    ];
    const { session } = await createHostSession({
      responses,
      fullLinearAllowlist: true,
      registryRefreshExtension: true,
    });

    expect(session.getActiveToolNames()).toEqual(['linear', 'linear_get_result']);
    await session.prompt('Run the first turn.');
    expect(linearToolNames(session.getActiveToolNames())).toHaveLength(53);
    await session.prompt('Run the second turn.');

    expect(toolNames(contexts[0]!)).toEqual(['linear', 'linear_get_result']);
    expect(toolNames(contexts[1]!)).toEqual(['linear', 'linear_get_result']);
  }, 30_000);
});
