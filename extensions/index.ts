import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import {
  addWorkspace,
  getActiveWorkspaceName,
  listWorkspaceNames,
  readCredentials,
  removeWorkspace,
  resolveApiKey,
  setAuthPreference,
  switchWorkspace,
} from './client';
import { linearApiTool, linearGetResultTool } from './api';
import { exceptionalToolDefinitions } from './exceptional-tools';
import { typedLinearTools, typedToolNames } from './typed-tools';
import type { MutationMode } from './safety';
import { registerLinearSettings } from './settings';

function text(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

export function registerLinearExtension(pi: ExtensionAPI, mode: MutationMode = 'allowlist') {
  registerLinearSettings(pi);
  pi.registerCommand('linear-auth', {
    description: 'Manage Linear auth: /linear-auth [add|remove|switch|prefer|status]',
    handler: async (args, ctx) => {
      const [rawCommand = '', ...rest] = args.trim().split(/\s+/);
      const command = rawCommand.toLowerCase();
      const suppliedName = text(rest.join(' '));

      if (command === 'add') {
        const name = suppliedName ?? text(await ctx.ui.input('Workspace name', 'my-workspace'));
        if (!name) return ctx.ui.notify('No workspace name provided', 'warning');
        const apiKey = text(await ctx.ui.input('Linear API key', 'lin_api_...'));
        if (!apiKey) return ctx.ui.notify('No API key provided', 'warning');
        const before = await readCredentials();
        await addWorkspace(name, apiKey);
        if (Object.keys(before.workspaces).length && (await ctx.ui.confirm('Switch workspace', `Switch to "${name}" now?`))) {
          await switchWorkspace(name);
        }
        ctx.ui.notify(`Workspace "${name}" saved`, 'info');
        return;
      }

      if (command === 'remove') {
        const creds = await readCredentials();
        const names = listWorkspaceNames(creds);
        const selected = suppliedName ?? text(await ctx.ui.select('Select workspace to remove', names));
        if (!selected) return ctx.ui.notify('No workspace selected', 'warning');
        if (!creds.workspaces[selected]) return ctx.ui.notify(`Workspace "${selected}" not found`, 'warning');
        await removeWorkspace(selected);
        ctx.ui.notify(`Removed workspace "${selected}"`, 'info');
        return;
      }

      if (command === 'switch') {
        const creds = await readCredentials();
        const selected = suppliedName ?? text(await ctx.ui.select('Select workspace', listWorkspaceNames(creds)));
        if (!selected) return ctx.ui.notify('No workspace selected', 'warning');
        try {
          await switchWorkspace(selected);
          ctx.ui.notify(`Active workspace: ${selected}`, 'info');
        } catch (error) {
          ctx.ui.notify(error instanceof Error ? error.message : String(error), 'warning');
        }
        return;
      }

      if (command === 'prefer') {
        if (suppliedName !== 'workspace' && suppliedName !== 'env') {
          return ctx.ui.notify('Usage: /linear-auth prefer [workspace|env]', 'warning');
        }
        await setAuthPreference(suppliedName);
        ctx.ui.notify(`Auth preference: ${suppliedName}`, 'info');
        return;
      }

      if (command === '' || command === 'status') {
        const creds = await readCredentials();
        const active = getActiveWorkspaceName(creds);
        const { source } = await resolveApiKey(ctx, { promptIfMissing: false });
        const names = listWorkspaceNames(creds);
        ctx.ui.notify(
          [
            `Auth preference: ${creds.authPreference}`,
            `Auth source: ${source === 'workspace' ? `workspace: ${active}` : source === 'env' ? 'env: LINEAR_API_KEY' : 'none'}`,
            names.length ? `Workspaces: ${names.map((name) => name === active ? `${name} (active)` : name).join(', ')}` : 'No workspaces configured',
          ].join('\n'),
          source === 'none' ? 'warning' : 'info',
        );
        return;
      }

      ctx.ui.notify('Usage: /linear-auth [add|remove|switch|prefer|status]', 'warning');
    },
  });

  const lazyToolNames = new Set(typedToolNames());

  /**
   * Additive activation only: the loader never removes a tool in the same call, so
   * pi can record the added names on the result and defer the schemas.
   */
  const activate = (toolNames: string[]): string[] => {
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
    return requested.filter((name) => after.includes(name));
  };

  pi.registerTool(linearApiTool(mode, activate));
  const exceptionalTools = exceptionalToolDefinitions.map((definition) => {
    if (definition.name !== 'linear_get_result') {
      throw new Error(`Linear tool configuration error: no runtime for exceptional tool ${definition.name}.`);
    }
    return linearGetResultTool(definition);
  });
  for (const tool of exceptionalTools) pi.registerTool(tool);
  const generatedTypedTools = typedLinearTools(mode);
  for (const tool of generatedTypedTools) pi.registerTool(tool);

  // Register all 48 typed tools, start with none of them active: linear alone
  // carries the always-on schema cost, and help loads only what the task needs.
  pi.on('session_start', () => {
    const allTools = pi.getAllTools();
    const registered = new Set(allTools.map(({ name }) => name));
    const missing = ['linear', ...exceptionalToolDefinitions.map(({ name }) => name), ...lazyToolNames]
      .filter((name) => !registered.has(name));
    if (missing.length) {
      throw new Error(`Linear tool configuration error: manifest entries are not registered: ${missing.join(', ')}.`);
    }
    for (const expected of [...exceptionalTools, ...generatedTypedTools]) {
      const registeredTool = allTools.find(({ name }) => name === expected.name);
      if (registeredTool?.parameters && JSON.stringify(registeredTool.parameters) !== JSON.stringify(expected.parameters)) {
        throw new Error(`Linear tool configuration error: generated schema drift for manifest entry ${expected.name}.`);
      }
    }
    const deferredExceptional = new Set<string>(exceptionalToolDefinitions.filter(({ deferred }) => deferred).map(({ name }) => name));
    pi.setActiveTools(pi.getActiveTools().filter((name) => !lazyToolNames.has(name) && !deferredExceptional.has(name)));
    const activeLinearTools = pi.getActiveTools().filter((name) => name === 'linear' || name.startsWith('linear_'));
    const expectedActive = ['linear', ...exceptionalToolDefinitions.filter(({ initialActive }) => initialActive).map(({ name }) => name)];
    if (activeLinearTools.join(',') !== expectedActive.join(',')) {
      throw new Error(`Linear tool configuration error: initial active tools are ${activeLinearTools.join(', ')}; expected ${expectedActive.join(', ')}.`);
    }
  });
}

export default function linearExtension(pi: ExtensionAPI) {
  registerLinearExtension(pi);
}
