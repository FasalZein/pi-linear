import { promises as fs } from 'node:fs';
import { access, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const [agentDirectory, workspace, observedFile, readReleaseFile, movedFile, movedReleaseFile, writeReadyFile, writeReleaseFile, actionFile] = process.argv.slice(2);
const credentialFile = join(agentDirectory, 'extensions', 'linear', 'credentials.json');
const lockPath = `${credentialFile}.lock`;

async function waitFor(file: string | undefined): Promise<void> {
  if (!file) return;
  while (await access(file).then(() => false, () => true)) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

const originalReadFile = fs.readFile.bind(fs);
let sawRecovery = false;
let sawOwnerAfterRecovery = false;
let observed = false;
fs.readFile = (async (...args: Parameters<typeof fs.readFile>) => {
  const result = await originalReadFile(...args);
  const file = String(args[0]);
  if (file === join(lockPath, 'recovery.json')) sawRecovery = true;
  if (sawRecovery && file === join(lockPath, 'owner.json')) sawOwnerAfterRecovery = true;
  return result;
}) as typeof fs.readFile;

const originalLstat = fs.lstat.bind(fs);
fs.lstat = (async (...args: Parameters<typeof fs.lstat>) => {
  const result = await originalLstat(...args as [any]);
  if (!observed && sawOwnerAfterRecovery && String(args[0]) === lockPath && observedFile) {
    observed = true;
    await writeFile(observedFile, 'observed');
    await waitFor(readReleaseFile);
  }
  return result;
}) as typeof fs.lstat;

const originalRename = fs.rename.bind(fs);
let moved = false;
let writePaused = false;
let actionReported = false;
fs.rename = (async (source: any, destination: any) => {
  const from = String(source);
  const to = String(destination);
  const recoveryTakeover = from === join(lockPath, 'recovery.json');
  const wholeLockRemoval = from === lockPath && to.startsWith(`${lockPath}.remove-`);
  try {
    const result = await originalRename(source, destination);
    if (!moved && wholeLockRemoval && movedFile) {
      moved = true;
      await writeFile(movedFile, 'moved');
      await waitFor(movedReleaseFile);
    }
    if (!writePaused && from.includes('.credentials-') && to === credentialFile && writeReadyFile) {
      writePaused = true;
      await writeFile(writeReadyFile, 'ready');
      await waitFor(writeReleaseFile);
    }
    return result;
  } finally {
    if (!actionReported && actionFile && (recoveryTakeover || wholeLockRemoval)) {
      actionReported = true;
      await writeFile(actionFile, 'attempted');
    }
  }
}) as typeof fs.rename;

const { credentialStore } = await import('../../extensions/credential-store');
await credentialStore.change(
  { type: 'add', name: workspace, apiKey: `lin_api_${workspace}_secret_123456789` },
  'allowlist',
);
