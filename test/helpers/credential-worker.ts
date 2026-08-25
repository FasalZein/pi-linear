import { access, writeFile } from 'node:fs/promises';
import { credentialStore } from '../../extensions/credential-store';

const [agentDirectory, name, readyFile, startFile] = process.argv.slice(2);
if (!agentDirectory || !name || !readyFile || !startFile) throw new Error('Missing credential worker argument.');

process.env.PI_CODING_AGENT_DIR = agentDirectory;
await writeFile(readyFile, 'ready');
while (true) {
  try {
    await access(startFile);
    break;
  } catch {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}
await credentialStore.change({ type: 'add', name, apiKey: `unknown-key-${name}` }, 'allowlist');
