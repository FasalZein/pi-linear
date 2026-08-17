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
import { linearApiTool } from './api';
import type { MutationMode } from './safety';

function text(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

export function registerLinearExtension(pi: ExtensionAPI, mode: MutationMode = 'allowlist') {
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

  pi.registerTool(linearApiTool(mode));
}

export default function linearExtension(pi: ExtensionAPI) {
  registerLinearExtension(pi);
}
