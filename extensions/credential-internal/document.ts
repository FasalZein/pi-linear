import { randomUUID } from 'node:crypto';
import { promises as fs, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertLocalWriteAllowed } from '../local-write-policy';
import { redactError, redactText } from '../redact';
import type { MutationMode } from '../safety';
import { withCredentialLock } from './lock';
import type { CredentialChange, CredentialSnapshot } from './types';

export type AuthPreference = 'workspace' | 'env';

export type CredentialDocument = {
  activeWorkspace: string | null;
  authPreference: AuthPreference;
  workspaces: Record<string, { apiKey: string }>;
  [key: string]: unknown;
};

function asString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return text || undefined;
}

function emptyCredentialDocument(): CredentialDocument {
  return { activeWorkspace: null, authPreference: 'workspace', workspaces: {} };
}

export function credentialFilePath(): string {
  const piDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent');
  return path.join(piDir, 'extensions', 'linear', 'credentials.json');
}

function invalidCredentialFile(): never {
  throw new Error('Invalid Linear credential file. Repair or remove it before changing stored credentials.');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeCredentialDocument(parsed: unknown): CredentialDocument {
  if (!isRecord(parsed) || !isRecord(parsed.workspaces)) invalidCredentialFile();
  if (parsed.activeWorkspace !== undefined && parsed.activeWorkspace !== null && typeof parsed.activeWorkspace !== 'string') {
    invalidCredentialFile();
  }
  if (parsed.authPreference !== undefined && parsed.authPreference !== 'workspace' && parsed.authPreference !== 'env') {
    invalidCredentialFile();
  }

  const workspaces: CredentialDocument['workspaces'] = {};
  for (const [name, entry] of Object.entries(parsed.workspaces)) {
    if (!isRecord(entry)) invalidCredentialFile();
    const apiKey = asString(entry.apiKey);
    if (!apiKey) invalidCredentialFile();
    workspaces[name] = { apiKey };
  }

  return {
    ...parsed,
    activeWorkspace: typeof parsed.activeWorkspace === 'string' ? parsed.activeWorkspace : null,
    authPreference: parsed.authPreference === 'env' ? 'env' : 'workspace',
    workspaces,
  };
}

export async function readCredentialDocument(): Promise<CredentialDocument> {
  let source: string;
  try {
    source = await fs.readFile(credentialFilePath(), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyCredentialDocument();
    throw redactError(error);
  }

  try {
    return normalizeCredentialDocument(JSON.parse(source));
  } catch (error) {
    if (error instanceof SyntaxError) invalidCredentialFile();
    throw error;
  }
}

export function credentialSnapshot(document: CredentialDocument): CredentialSnapshot {
  return {
    activeWorkspace: document.activeWorkspace,
    authPreference: document.authPreference,
    workspaces: Object.keys(document.workspaces),
  };
}

async function writeCredentialDocumentUnlocked(document: CredentialDocument): Promise<void> {
  const filePath = credentialFilePath();
  const directory = path.dirname(filePath);
  const temporaryPath = path.join(directory, `.credentials-${process.pid}-${randomUUID()}.tmp`);
  try {
    const handle = await fs.open(temporaryPath, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify(document, null, 2));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporaryPath, filePath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    throw redactError(error);
  }
}

export async function replaceCredentialDocument(document: CredentialDocument, mode: MutationMode): Promise<void> {
  assertLocalWriteAllowed(mode);
  const filePath = credentialFilePath();
  await withCredentialLock(filePath, () => writeCredentialDocumentUnlocked(normalizeCredentialDocument(structuredClone(document))));
}

export async function changeCredentialDocument(change: CredentialChange, mode: MutationMode): Promise<CredentialDocument> {
  assertLocalWriteAllowed(mode);
  const filePath = credentialFilePath();
  return withCredentialLock(filePath, async () => {
    const document = structuredClone(await readCredentialDocument());
    switch (change.type) {
      case 'add':
        document.workspaces[change.name] = { apiKey: change.apiKey };
        document.activeWorkspace ??= change.name;
        break;
      case 'remove':
        delete document.workspaces[change.name];
        if (document.activeWorkspace === change.name) {
          document.activeWorkspace = Object.keys(document.workspaces)[0] ?? null;
        }
        break;
      case 'switch':
        if (!document.workspaces[change.name]) {
          throw new Error(`Workspace "${redactText(change.name)}" does not exist.`);
        }
        document.activeWorkspace = change.name;
        break;
      case 'prefer':
        document.authPreference = change.preference;
        break;
    }
    const validated = normalizeCredentialDocument(document);
    await writeCredentialDocumentUnlocked(validated);
    return validated;
  });
}

export function readCredentialSecrets(): string[] {
  const secrets = new Set<string>();
  const env = asString(process.env.LINEAR_API_KEY);
  if (env) secrets.add(env);

  let source: string;
  try {
    source = readFileSync(credentialFilePath(), 'utf8');
  } catch {
    return [...secrets];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    for (const match of source.matchAll(/"apiKey"\s*:\s*("(?:\\u[0-9a-fA-F]{4}|\\["\\/bfnrt]|[^"\\])*")/g)) {
      try {
        const apiKey = asString(JSON.parse(match[1]));
        if (apiKey) secrets.add(apiKey);
      } catch {
        // A complete-looking token can still contain JSON-invalid control characters.
      }
    }
    return [...secrets];
  }

  if (!isRecord(parsed) || !isRecord(parsed.workspaces)) return [...secrets];
  for (const entry of Object.values(parsed.workspaces)) {
    if (!isRecord(entry)) continue;
    const apiKey = asString(entry.apiKey);
    if (apiKey) secrets.add(apiKey);
  }
  return [...secrets];
}

export function trimmedString(value: unknown): string | undefined {
  return asString(value);
}
