import { randomUUID } from 'node:crypto';
import { promises as fs, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Type } from 'typebox';
import { Compile } from 'typebox/compile';
import { assertLocalWriteAllowed } from '../local-write-policy';
import { redactError, redactText } from '../redact';
import type { MutationMode } from '../safety';
import { withCredentialLock } from './lock';
import type { CredentialChange, CredentialSnapshot } from './types';

export type AuthPreference = 'workspace' | 'env';

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export type CredentialDocument = {
  activeWorkspace: string | null;
  authPreference: AuthPreference;
  workspaces: Record<string, { apiKey: string }>;
  [key: string]: JsonValue;
};

const storedDocument = Compile(
  Type.Object({
    activeWorkspace: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    authPreference: Type.Optional(Type.Union([Type.Literal('workspace'), Type.Literal('env')])),
    workspaces: Type.Record(Type.String(), Type.Object({ apiKey: Type.String({ pattern: '\\S' }) })),
  }),
);

const secretBearingDocument = Compile(
  Type.Object({ workspaces: Type.Record(Type.String(), Type.Unknown()) }),
);

const secretBearingEntry = Compile(Type.Object({ apiKey: Type.String() }));

const jsonString = Compile(Type.String());

function asString(value: string | undefined): string | undefined {
  const text = value?.trim();
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

/** Decode any candidate document, stored or supplied, into the owner type this module writes. */
function normalizeCredentialDocument(candidate: CredentialDocument): CredentialDocument {
  if (!storedDocument.Check(candidate)) invalidCredentialFile();

  const workspaces: CredentialDocument['workspaces'] = {};
  for (const [name, entry] of Object.entries(candidate.workspaces)) {
    workspaces[name] = { apiKey: entry.apiKey.trim() };
  }

  return {
    ...candidate,
    activeWorkspace: candidate.activeWorkspace ?? null,
    authPreference: candidate.authPreference ?? 'workspace',
    workspaces,
  };
}

function parseCredentialDocument(source: string): CredentialDocument {
  try {
    return normalizeCredentialDocument(JSON.parse(source));
  } catch (error) {
    if (error instanceof SyntaxError) invalidCredentialFile();
    throw error;
  }
}

export async function readCredentialDocument(): Promise<CredentialDocument> {
  let source: string;
  try {
    source = await fs.readFile(credentialFilePath(), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyCredentialDocument();
    throw redactError(error);
  }

  return parseCredentialDocument(source);
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

/** Recover complete apiKey strings from a document too damaged to parse as JSON. */
function damagedDocumentSecrets(source: string): string[] {
  const secrets: string[] = [];
  for (const match of source.matchAll(/"apiKey"\s*:\s*("(?:\\u[0-9a-fA-F]{4}|\\["\\/bfnrt]|[^"\\])*")/g)) {
    try {
      const token: unknown = JSON.parse(match[1]);
      const apiKey = jsonString.Check(token) ? asString(token) : undefined;
      if (apiKey) secrets.push(apiKey);
    } catch {
      // A complete-looking token can still contain JSON-invalid control characters.
    }
  }
  return secrets;
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
    for (const apiKey of damagedDocumentSecrets(source)) secrets.add(apiKey);
    return [...secrets];
  }

  if (!secretBearingDocument.Check(parsed)) return [...secrets];
  for (const entry of Object.values(parsed.workspaces)) {
    if (!secretBearingEntry.Check(entry)) continue;
    const apiKey = asString(entry.apiKey);
    if (apiKey) secrets.add(apiKey);
  }
  return [...secrets];
}

export function trimmedString(value: string | undefined): string | undefined {
  return asString(value);
}
