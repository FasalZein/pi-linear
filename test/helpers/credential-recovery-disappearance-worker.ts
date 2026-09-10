import { promises as fs } from 'node:fs';
import { join } from 'node:path';

const [agentDirectory, workspace] = process.argv.slice(2);
if (!agentDirectory || !workspace) throw new Error('Missing credential recovery worker argument.');

const credentialFile = join(agentDirectory, 'extensions', 'linear', 'credentials.json');
const recoveryPath = `${credentialFile}.lock/recovery.json`;
const originalLstat = fs.lstat.bind(fs);
let removedRecoveryClaim = false;
fs.lstat = (async (...args: Parameters<typeof fs.lstat>) => {
  const result = await originalLstat(...args as [any]);
  if (!removedRecoveryClaim && String(args[0]) === recoveryPath) {
    removedRecoveryClaim = true;
    await fs.rm(recoveryPath);
  }
  return result;
}) as typeof fs.lstat;

process.env.PI_CODING_AGENT_DIR = agentDirectory;
const { credentialStore } = await import('../../extensions/credential-store');
await credentialStore.change(
  { type: 'add', name: workspace, apiKey: `lin_api_${workspace}_secret_123456789` },
  'allowlist',
);
