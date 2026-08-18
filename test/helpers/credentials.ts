import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach } from 'vitest';

/** Keep tests away from the developer's stored Linear credentials. */
export function isolateLinearCredentials(): void {
  const originalDirectory = process.env.PI_CODING_AGENT_DIR;
  let directory: string | undefined;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'pi-linear-agent-'));
    process.env.PI_CODING_AGENT_DIR = directory;
  });

  afterEach(async () => {
    if (originalDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalDirectory;
    if (directory) await rm(directory, { recursive: true, force: true });
    directory = undefined;
  });
}
