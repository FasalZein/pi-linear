/**
 * Exact active-secret redaction on public early-return paths.
 *
 * Help returns before credential resolution, and call rows render raw arguments, so an
 * active key in an unknown format (no `lin_api_` prefix, no Authorization wrapper) can
 * only be removed as an exact value. These tests use synthetic keys that no pattern
 * matches, so they fail whenever a path stops collecting active secrets.
 */
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { linearApiTool } from '../extensions/api';
import { activeSecrets } from '../extensions/active-secrets';
import { REDACTED } from '../extensions/redact';
import { renderLinearApiCall } from '../extensions/renderers';
import type { JsonObject } from '../extensions/runtime';

const ENV_SECRET = 'zzzz-unknown-format-env-secret-0001';
const WORKSPACE_SECRET = 'qqqq-unknown-format-workspace-secret-0002';

const originalEnvironment = { ...process.env };
let agentDirectory: string;

beforeEach(async () => {
  agentDirectory = await mkdtemp(join(tmpdir(), 'pi-linear-active-secret-'));
  process.env.PI_CODING_AGENT_DIR = agentDirectory;
  process.env.PI_ARTIFACT_PROJECT_ROOT = await mkdtemp(join(tmpdir(), 'pi-linear-active-artifacts-'));
  process.env.LINEAR_API_KEY = ENV_SECRET;
  const credentialDirectory = join(agentDirectory, 'extensions', 'linear');
  await mkdir(credentialDirectory, { recursive: true });
  await writeFile(
    join(credentialDirectory, 'credentials.json'),
    JSON.stringify({
      activeWorkspace: 'work',
      authPreference: 'workspace',
      workspaces: { work: { apiKey: WORKSPACE_SECRET } },
    }),
  );
});

afterEach(() => {
  process.env = { ...originalEnvironment };
});

const tool = linearApiTool('allowlist', (names) => names);

function execute(params: JsonObject) {
  return (tool as any).execute('call-1', params, undefined, undefined, { hasUI: false });
}

function surfaces(result: any): string {
  return `${JSON.stringify(result.details)}\n${result.content.map((entry: any) => entry.text).join('\n')}`;
}

describe('active secret collection', () => {
  it('collects the env key and every configured workspace key without prompting', () => {
    expect(activeSecrets().sort()).toEqual([ENV_SECRET, WORKSPACE_SECRET].sort());
  });

  it('returns no secrets when nothing is configured', async () => {
    delete process.env.LINEAR_API_KEY;
    process.env.PI_CODING_AGENT_DIR = await mkdtemp(join(tmpdir(), 'pi-linear-empty-creds-'));
    expect(activeSecrets()).toEqual([]);
  });
});

describe('help paths redact unknown-format active secrets', () => {
  it('does not echo an active secret from a failed help request', async () => {
    for (const secret of [ENV_SECRET, WORKSPACE_SECRET]) {
      const error = await execute({ operation: 'help', variables: { operation: `get_issue${secret}` } })
        .then(() => undefined, (cause: unknown) => cause as Error);
      expect(error?.message).toBe('Unknown Linear operation. Check the catalog, then send `{ "operation": "help", "variables": { "operation": "<canonical_name>" } }`.');
      expect(error?.message).not.toContain(secret);
    }
  });

  it('redacts an active secret echoed by a domain help request', async () => {
    const result = await execute({ operation: 'help', variables: { domain: `issues${ENV_SECRET}` } })
      .then((value: any) => value, (cause: unknown) => cause as Error);
    const text = result instanceof Error ? result.message : surfaces(result);
    expect(text).not.toContain(ENV_SECRET);
  });

  it('keeps loader output and exact operation help usable while redacting', async () => {
    const result = await execute({ operation: 'help', variables: { operation: 'get_issue' } });
    expect(result.details.name).toBe('get_issue');
    expect(result.details.loadedTools).toEqual(['linear_get_issue']);
    expect(surfaces(result)).not.toContain(ENV_SECRET);
  });

  it('returns the help index without network access or credentials prompts', async () => {
    const result = await execute({ operation: 'help' });
    expect(Array.isArray(result.details.domains)).toBe(true);
  });
});

describe('call rows redact unknown-format active secrets', () => {
  it('redacts an active secret in rendered linear call arguments', () => {
    const theme: any = { fg: (_name: string, text: string) => text, bold: (text: string) => text };
    const block = renderLinearApiCall(
      { operation: 'help', variables: { operation: ENV_SECRET } },
      theme,
    );
    const rendered = block.render(200).join('\n');
    expect(rendered).not.toContain(ENV_SECRET);
    expect(rendered).toContain(REDACTED);
  });

  it('redacts a complete apiKey recovered from a damaged Credential document', async () => {
    const recovered = 'recovered-unknown-format-secret-0003';
    delete process.env.LINEAR_API_KEY;
    await writeFile(
      join(agentDirectory, 'extensions', 'linear', 'credentials.json'),
      `{"workspaces":{"work":{"apiKey":"${recovered}"}},broken`,
    );
    const theme: any = { fg: (_name: string, text: string) => text, bold: (text: string) => text };

    const rendered = renderLinearApiCall(
      { operation: 'help', variables: { operation: recovered } },
      theme,
    ).render(200).join('\n');

    expect(rendered).not.toContain(recovered);
    expect(rendered).toContain(REDACTED);
  });
});
