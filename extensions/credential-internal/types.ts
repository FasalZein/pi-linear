import type { MutationMode } from '../safety';

export type CredentialSnapshot = {
  activeWorkspace: string | null;
  authPreference: 'workspace' | 'env';
  workspaces: readonly string[];
};

export type ResolvedCredential = {
  apiKey?: string;
  source: 'env' | 'workspace' | 'none';
  snapshot: CredentialSnapshot;
};

export type CredentialChange =
  | { type: 'add'; name: string; apiKey: string }
  | { type: 'remove'; name: string }
  | { type: 'switch'; name: string }
  | { type: 'prefer'; preference: 'workspace' | 'env' };

export type CredentialStore = {
  resolve(query?: { workspace?: string }): Promise<ResolvedCredential>;
  change(change: CredentialChange, mode: MutationMode): Promise<CredentialSnapshot>;
  secrets(): string[];
};
