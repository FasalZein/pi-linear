import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { activeSecrets } from './active-secrets';
import { credentialStore } from './credential-store';
import { linearApiTool, linearBatchTool, linearGetResultTool, linearGraphqlTool } from './api';
import { exceptionalToolDefinitions } from './exceptional-tools';
import { assertLocalWriteAllowed } from './local-write-policy';
import { redactText } from './redact';
import { typedLinearTools, typedToolNames } from './typed-tools';
import type { MutationMode } from './safety';
import { registerLinearSettings } from './settings';

function text(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function displayWorkspace(name: string): string {
  return redactText(name, activeSecrets());
}

export function registerLinearExtension(pi: ExtensionAPI, mode: MutationMode = 'allowlist') {
  registerLinearSettings(pi);
  pi.registerCommand('linear-auth', {
    description: 'Manage Linear auth: /linear-auth [add|remove|switch|prefer|status]',
    handler: async (args, ctx) => {
      const [rawCommand = '', ...rest] = args.trim().split(/\s+/);
      const command = rawCommand.toLowerCase();
      const suppliedName = text(rest.join(' '));
      if (['add', 'remove', 'switch', 'prefer'].includes(command)) assertLocalWriteAllowed(mode);

      const selectWorkspace = async (title: string, names: string[]): Promise<string | undefined> => {
        const labels = names.map((name, index) => `${index + 1}. ${displayWorkspace(name)}`);
        const selectedLabel = text(await ctx.ui.select(title, labels));
        const selectedIndex = selectedLabel ? labels.indexOf(selectedLabel) : -1;
        return selectedIndex < 0 ? undefined : names[selectedIndex];
      };

      if (command === 'add') {
        const name = suppliedName ?? text(await ctx.ui.input('Workspace name', 'my-workspace'));
        if (!name) return ctx.ui.notify('No workspace name provided', 'warning');
        const apiKey = text(await ctx.ui.input('Linear API key', 'lin_api_...'));
        if (!apiKey) return ctx.ui.notify('No API key provided', 'warning');
        const before = (await credentialStore.resolve()).snapshot;
        await credentialStore.change({ type: 'add', name, apiKey }, mode);
        const displayedName = displayWorkspace(name);
        if (before.workspaces.length && (await ctx.ui.confirm('Switch workspace', `Switch to "${displayedName}" now?`))) {
          await credentialStore.change({ type: 'switch', name }, mode);
        }
        ctx.ui.notify(`Workspace "${displayedName}" saved`, 'info');
        return;
      }

      if (command === 'remove') {
        const names = (await credentialStore.resolve()).snapshot.workspaces;
        const selected = suppliedName ?? await selectWorkspace('Select workspace to remove', [...names]);
        if (!selected) return ctx.ui.notify('No workspace selected', 'warning');
        const displayedName = displayWorkspace(selected);
        if (!names.includes(selected)) return ctx.ui.notify(`Workspace "${displayedName}" not found`, 'warning');
        await credentialStore.change({ type: 'remove', name: selected }, mode);
        ctx.ui.notify(`Removed workspace "${displayedName}"`, 'info');
        return;
      }

      if (command === 'switch') {
        const names = (await credentialStore.resolve()).snapshot.workspaces;
        const selected = suppliedName ?? await selectWorkspace('Select workspace', [...names]);
        if (!selected) return ctx.ui.notify('No workspace selected', 'warning');
        try {
          await credentialStore.change({ type: 'switch', name: selected }, mode);
          ctx.ui.notify(`Active workspace: ${displayWorkspace(selected)}`, 'info');
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          ctx.ui.notify(redactText(message, activeSecrets()), 'warning');
        }
        return;
      }

      if (command === 'prefer') {
        if (suppliedName !== 'workspace' && suppliedName !== 'env') {
          return ctx.ui.notify('Usage: /linear-auth prefer [workspace|env]', 'warning');
        }
        await credentialStore.change({ type: 'prefer', preference: suppliedName }, mode);
        ctx.ui.notify(`Auth preference: ${suppliedName}`, 'info');
        return;
      }

      if (command === '' || command === 'status') {
        const { source, snapshot } = await credentialStore.resolve();
        const { activeWorkspace: active, authPreference, workspaces: names } = snapshot;
        ctx.ui.notify(
          [
            `Auth preference: ${authPreference}`,
            `Auth source: ${source === 'workspace' ? `workspace: ${active ? displayWorkspace(active) : 'none'}` : source === 'env' ? 'env: LINEAR_API_KEY' : 'none'}`,
            names.length ? `Workspaces: ${names.map((name) => name === active ? `${displayWorkspace(name)} (active)` : displayWorkspace(name)).join(', ')}` : 'No workspaces configured',
          ].join('\n'),
          source === 'none' ? 'warning' : 'info',
        );
        return;
      }

      ctx.ui.notify('Usage: /linear-auth [add|remove|switch|prefer|status]', 'warning');
    },
  });

  const typedNames = new Set(typedToolNames());
  const deferredExceptionalNames = new Set(
    exceptionalToolDefinitions.filter(({ deferred }) => deferred).map(({ name }) => name),
  );
  const lazyToolNames = new Set([...typedNames, ...deferredExceptionalNames]);
  const initialLinearToolNames = [
    'linear',
    ...exceptionalToolDefinitions.filter(({ initialActive }) => initialActive).map(({ name }) => name),
  ];
  const linearToolNames = new Set([...initialLinearToolNames, ...lazyToolNames]);
  let visibleLinearToolNames = new Set<string>();
  let rememberedActiveTools: string[] = [];
  let registrySignature = '';
  let registryRefreshPending = false;

  const currentRegistrySignature = (): string => pi.getAllTools().map(({ name }) => name).join(',');

  /**
   * Evidence of a registry refresh, not of a bulk active-tool value. Pi rebuilds the registry
   * by keeping the previous active list and appending every permitted tool, so a refresh keeps
   * the remembered active list as a prefix. A tool allowlist hides the newly registered tool
   * from `getAllTools`, so the registered-name change is the second, independent signal.
   * A deliberate selection replaces the active list and matches neither signal.
   */
  const looksLikeRegistryRefresh = (activeTools: readonly string[]): boolean => {
    if (![...lazyToolNames].every((name) => activeTools.includes(name))) return false;
    return activeTools.length > rememberedActiveTools.length
      && rememberedActiveTools.every((name, index) => activeTools[index] === name);
  };

  const observeRegistry = (): void => {
    const signature = currentRegistrySignature();
    const registryChanged = signature !== registrySignature;
    registrySignature = signature;
    if (registryChanged || looksLikeRegistryRefresh(pi.getActiveTools())) registryRefreshPending = true;
  };

  const rememberVisibleLinearTools = (): void => {
    rememberedActiveTools = pi.getActiveTools();
    visibleLinearToolNames = new Set(rememberedActiveTools.filter((name) => linearToolNames.has(name)));
  };

  const initializeDeferredSurface = (): void => {
    // Resume and parent loaders can leave registered tools inactive or keep only
    // one discovery tool. Place the startup pair in contract order; keep other
    // host tools in their relative order.
    const withoutLazy = pi.getActiveTools().filter((name) => !lazyToolNames.has(name));
    const initial = new Set(initialLinearToolNames);
    const firstInitialIndex = withoutLazy.findIndex((name) => initial.has(name));
    const rest = withoutLazy.filter((name) => !initial.has(name));
    if (firstInitialIndex < 0) {
      pi.setActiveTools([...rest, ...initialLinearToolNames]);
    } else {
      const prefixLength = withoutLazy.slice(0, firstInitialIndex).filter((name) => !initial.has(name)).length;
      pi.setActiveTools([
        ...rest.slice(0, prefixLength),
        ...initialLinearToolNames,
        ...rest.slice(prefixLength),
      ]);
    }
    registrySignature = currentRegistrySignature();
    registryRefreshPending = false;
    rememberVisibleLinearTools();
  };

  const repairRegistryRefresh = (): void => {
    observeRegistry();
    if (registryRefreshPending) {
      const before = pi.getActiveTools();
      const restored = before.filter((name) => !linearToolNames.has(name) || visibleLinearToolNames.has(name));
      if (restored.length !== before.length) pi.setActiveTools(restored);
      registryRefreshPending = false;
    }
    rememberVisibleLinearTools();
  };

  const assertManifestEntriesRegistered = (allTools: ReturnType<ExtensionAPI['getAllTools']>): void => {
    const registered = new Set(allTools.map(({ name }) => name));
    const missing = ['linear', ...exceptionalToolDefinitions.map(({ name }) => name), ...lazyToolNames]
      .filter((name) => !registered.has(name));
    if (missing.length) {
      throw new Error(`Linear tool configuration error: manifest entries are not registered: ${missing.join(', ')}.`);
    }
  };

  const assertGeneratedSchemas = (
    allTools: ReturnType<ExtensionAPI['getAllTools']>,
    expectedTools: ReturnType<typeof typedLinearTools>,
  ): void => {
    for (const expected of expectedTools) {
      const registeredTool = allTools.find(({ name }) => name === expected.name);
      if (registeredTool?.parameters && JSON.stringify(registeredTool.parameters) !== JSON.stringify(expected.parameters)) {
        throw new Error(`Linear tool configuration error: generated schema drift for manifest entry ${expected.name}.`);
      }
    }
  };

  const assertInitialLinearTools = (): void => {
    const activeLinearTools = pi.getActiveTools().filter((name) => name === 'linear' || name.startsWith('linear_'));
    if (activeLinearTools.join(',') !== initialLinearToolNames.join(',')) {
      throw new Error(`Linear tool configuration error: initial active tools are ${activeLinearTools.join(', ')}; expected ${initialLinearToolNames.join(', ')}.`);
    }
  };

  /**
   * Additive activation only: the loader never removes a tool in the same call, so
   * pi can record the added names on the result and defer the schemas.
   */
  const activate = (toolNames: string[]): string[] => {
    observeRegistry();
    const wanted = [...new Set(toolNames.filter((name) => lazyToolNames.has(name)))];
    const registered = new Set(pi.getAllTools().map(({ name }) => name));
    const missing = wanted.filter((name) => !registered.has(name));
    if (missing.length) {
      throw new Error(`Linear tool configuration error: manifest entries are not registered: ${missing.join(', ')}.`);
    }
    const before = pi.getActiveTools();
    const requested = wanted.filter((name) => !before.includes(name));
    if (requested.length) pi.setActiveTools([...new Set([...before, ...requested])]);
    const after = pi.getActiveTools();
    const removed = before.filter((name) => !after.includes(name));
    if (removed.length) {
      throw new Error(`Linear tool configuration error: activation policy removed active tools: ${removed.join(', ')}.`);
    }
    const blocked = requested.filter((name) => !after.includes(name));
    if (blocked.length) {
      throw new Error(`Linear tool configuration error: policy blocked manifest entries: ${blocked.join(', ')}.`);
    }
    if (registryRefreshPending) {
      // An unrepaired refresh state is not a selection. Keep the remembered selection and add
      // only what this call was asked to activate, so the loader promise survives the repair.
      for (const name of wanted) if (after.includes(name)) visibleLinearToolNames.add(name);
    } else {
      rememberVisibleLinearTools();
    }
    return requested.filter((name) => after.includes(name));
  };

  pi.registerTool(linearApiTool(mode, activate));
  const exceptionalTools = exceptionalToolDefinitions.map((definition) => {
    if (definition.name === 'linear_get_result') return linearGetResultTool(definition);
    if (definition.name === 'linear_graphql') return linearGraphqlTool(mode, definition);
    if (definition.name === 'linear_batch') return linearBatchTool(mode, definition);
    throw new Error('Linear tool configuration error: no runtime for exceptional tool.');
  });
  for (const tool of exceptionalTools) pi.registerTool(tool);
  const generatedTypedTools = typedLinearTools(mode);
  for (const tool of generatedTypedTools) pi.registerTool(tool);

  // Register all 49 typed tools with none active initially. Start with linear and
  // linear_get_result active; help loads only the typed tool the task needs.
  pi.on('session_start', () => {
    const allTools = pi.getAllTools();
    assertManifestEntriesRegistered(allTools);
    assertGeneratedSchemas(allTools, [...exceptionalTools, ...generatedTypedTools]);
    initializeDeferredSurface();
    assertInitialLinearTools();
  });

  // A registry refresh can activate the full permission list. Restore the last remembered selection at the next user-prompt boundary.
  pi.on('before_agent_start', () => repairRegistryRefresh());
  pi.on('agent_end', () => {
    observeRegistry();
    if (!registryRefreshPending) rememberVisibleLinearTools();
  });
}

export default function linearExtension(pi: ExtensionAPI) {
  registerLinearExtension(pi);
}
