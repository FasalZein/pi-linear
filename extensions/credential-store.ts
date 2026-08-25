import { redactText } from './redact';
import type { MutationMode } from './safety';
import {
  changeCredentialDocument,
  credentialSnapshot,
  readCredentialDocument,
  readCredentialSecrets,
  trimmedString,
} from './credential-internal/document';
import type { CredentialChange, CredentialStore, ResolvedCredential } from './credential-internal/types';

async function resolve(query?: { workspace?: string }): Promise<ResolvedCredential> {
  const document = await readCredentialDocument();
  const snapshot = credentialSnapshot(document);
  const workspaceAlias = query?.workspace === 'default' || query?.workspace === 'active';
  const requestedWorkspace = workspaceAlias ? undefined : trimmedString(query?.workspace);
  if (requestedWorkspace) {
    const apiKey = document.workspaces[requestedWorkspace]?.apiKey;
    if (!apiKey) throw new Error(`Workspace "${redactText(requestedWorkspace)}" does not exist.`);
    return { apiKey, source: 'workspace', snapshot };
  }

  const workspaceKey = document.activeWorkspace
    ? document.workspaces[document.activeWorkspace]?.apiKey
    : undefined;
  const envApiKey = trimmedString(process.env.LINEAR_API_KEY);
  const preferred = document.authPreference === 'env'
    ? [envApiKey, workspaceKey]
    : [workspaceKey, envApiKey];
  const apiKey = preferred.find(Boolean);
  if (!apiKey) return { source: 'none', snapshot };
  return { apiKey, source: apiKey === envApiKey ? 'env' : 'workspace', snapshot };
}

async function change(change: CredentialChange, mode: MutationMode) {
  return credentialSnapshot(await changeCredentialDocument(change, mode));
}

export const credentialStore: CredentialStore = {
  resolve,
  change,
  secrets: readCredentialSecrets,
};

export type { CredentialChange, CredentialSnapshot, ResolvedCredential } from './credential-internal/types';
