import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { credentialStore } from '../credential-store';
import type { MutationMode } from '../safety';
import {
  changeCredentialDocument,
  credentialFilePath,
  readCredentialDocument,
  replaceCredentialDocument,
  trimmedString,
  type AuthPreference,
  type CredentialDocument,
} from './document';

/** @deprecated Use credentialStore.resolve(), credentialStore.change(), and credentialStore.secrets(). */
export type WorkspaceCredentials = CredentialDocument;
/** @deprecated Use CredentialSnapshot.authPreference. */
export type { AuthPreference };

/** @deprecated The Credential store owns its document path. */
export function getCredentialFilePath(): string {
  return credentialFilePath();
}

/** @deprecated Use credentialStore.resolve().snapshot. */
export function readCredentials(): Promise<WorkspaceCredentials> {
  return readCredentialDocument();
}

/** @deprecated Use credentialStore.change(). */
export function writeCredentials(
  credentials: WorkspaceCredentials,
  mode: MutationMode = 'allowlist',
): Promise<void> {
  return replaceCredentialDocument(credentials, mode);
}

/** @deprecated Use credentialStore.change({ type: 'add', ... }). */
export function addWorkspace(
  name: string,
  apiKey: string,
  mode: MutationMode = 'allowlist',
): Promise<WorkspaceCredentials> {
  return changeCredentialDocument({ type: 'add', name, apiKey }, mode);
}

/** @deprecated Use credentialStore.change({ type: 'remove', ... }). */
export function removeWorkspace(
  name: string,
  mode: MutationMode = 'allowlist',
): Promise<WorkspaceCredentials> {
  return changeCredentialDocument({ type: 'remove', name }, mode);
}

/** @deprecated Use credentialStore.change({ type: 'switch', ... }). */
export function switchWorkspace(
  name: string,
  mode: MutationMode = 'allowlist',
): Promise<WorkspaceCredentials> {
  return changeCredentialDocument({ type: 'switch', name }, mode);
}

/** @deprecated Use credentialStore.change({ type: 'prefer', ... }). */
export function setAuthPreference(
  preference: AuthPreference,
  mode: MutationMode = 'allowlist',
): Promise<WorkspaceCredentials> {
  return changeCredentialDocument({ type: 'prefer', preference }, mode);
}

/** @deprecated Use CredentialSnapshot.workspaces. */
export function listWorkspaceNames(credentials: WorkspaceCredentials): string[] {
  return Object.keys(credentials.workspaces);
}

/** @deprecated Use CredentialSnapshot.activeWorkspace. */
export function getActiveWorkspaceName(credentials: WorkspaceCredentials): string | null {
  return credentials.activeWorkspace;
}

/** @deprecated Use credentialStore.resolve(). Prompting remains in this UI adapter. */
export async function resolveApiKey(
  ctx: ExtensionContext,
  options?: { promptIfMissing?: boolean; workspace?: string; mode?: MutationMode },
): Promise<{ apiKey?: string; source: 'env' | 'workspace' | 'none' }> {
  const resolved = await credentialStore.resolve({ workspace: options?.workspace });
  if (resolved.apiKey) return { apiKey: resolved.apiKey, source: resolved.source };

  if ((options?.promptIfMissing ?? true) && ctx.hasUI) {
    const shouldAdd = await ctx.ui.confirm(
      'Linear API key required',
      'No configured workspace or LINEAR_API_KEY found. Add one now?',
    );
    if (shouldAdd) {
      const name = trimmedString(await ctx.ui.input('Workspace name', 'my-workspace'));
      const apiKey = name ? trimmedString(await ctx.ui.input('Linear API key', 'lin_api_...')) : undefined;
      if (name && apiKey) {
        await credentialStore.change({ type: 'add', name, apiKey }, options?.mode ?? 'allowlist');
        ctx.ui.notify(`Workspace "${name}" saved and set as active`, 'info');
        return { apiKey, source: 'workspace' };
      }
    }
  }

  return { source: 'none' };
}
