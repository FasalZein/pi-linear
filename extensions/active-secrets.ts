/**
 * Active Linear secrets, collected without prompting and without network access.
 *
 * Redaction removes exact secret values, so every public output path — help results,
 * loader output, call rows, results, and errors — needs the current credentials before
 * it produces text. Reading is synchronous because renderers redact synchronously.
 */
import { readFileSync } from 'node:fs';
import { getCredentialFilePath } from './client';

function configuredWorkspaceKeys(): string[] {
  try {
    const parsed = JSON.parse(readFileSync(getCredentialFilePath(), 'utf8')) as Record<string, unknown>;
    const workspaces = parsed.workspaces;
    if (!workspaces || typeof workspaces !== 'object') return [];
    return Object.values(workspaces as Record<string, unknown>)
      .map((entry) => (entry as { apiKey?: unknown } | null)?.apiKey)
      .filter((key): key is string => typeof key === 'string' && key.trim().length > 0)
      .map((key) => key.trim());
  } catch {
    return [];
  }
}

/** Env key plus every configured workspace key. Never prompts, never returns partials. */
export function activeSecrets(): string[] {
  const secrets = new Set<string>();
  const env = process.env.LINEAR_API_KEY?.trim();
  if (env) secrets.add(env);
  for (const key of configuredWorkspaceKeys()) secrets.add(key);
  return [...secrets];
}
