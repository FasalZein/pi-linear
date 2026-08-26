/**
 * Local operations produce their result inside this process, so the declared local
 * result expectation is the only proof the result is real. It is enforced before
 * redaction and routing.
 */
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JsonObject, UnparsedJson } from '../extensions/json';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import contracts from '../extensions/generated/operation-contracts.json';
import { getOperationDefinition, operationDefinitions, operations } from '../extensions/operations';
import { executeOperation, validateLocalResult } from '../extensions/runtime';
import { typedLinearTools } from '../extensions/typed-tools';
import { operationRenderers } from '../extensions/renderers';

const originalEnvironment = { ...process.env };
let agentDirectory: string;

async function writeCredentialFile(value: UnparsedJson) {
  const directory = join(agentDirectory, 'extensions', 'linear');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'credentials.json'), JSON.stringify(value));
}

beforeEach(async () => {
  agentDirectory = await mkdtemp(join(tmpdir(), 'pi-linear-local-result-'));
  process.env.PI_CODING_AGENT_DIR = agentDirectory;
  delete process.env.LINEAR_API_KEY;
  await writeCredentialFile({
    activeWorkspace: 'first',
    authPreference: 'workspace',
    workspaces: { first: { apiKey: 'lin_api_first000000000' }, second: { apiKey: 'lin_api_second00000000' } },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  process.env = { ...originalEnvironment };
});

const localOperations = operationDefinitions.filter(({ kind }) => kind === 'local');

describe('generated local result expectation', () => {
  it('declares a local expectation for every local operation', () => {
    expect(localOperations.map(({ name }) => name)).toEqual(['switch_workspace']);
    for (const definition of localOperations) {
      expect(definition.result.local?.requiredStringPaths.length).toBeGreaterThan(0);
    }
  });

  it('publishes the switch_workspace expectation in the generated contract', () => {
    const contract = (contracts as any[]).find((entry: any) => entry.name === 'switch_workspace');
    expect(contract.result.local).toEqual({ requiredStringPaths: ['active'] });
    expect(contract.result.dataPaths).toEqual(['active']);
  });

  it('keeps the definition and the runtime operation in agreement', () => {
    expect(getOperationDefinition('switch_workspace').result.local)
      .toEqual(operations.switch_workspace!.localResult);
  });
});

describe('runtime local result validation', () => {
  const expectation = { requiredStringPaths: ['active'] };

  it.each([
    ['missing', {}],
    ['false', { active: false }],
    ['null', { active: null }],
    ['empty', { active: '   ' }],
    ['nested', { active: { name: 'work' } }],
  ])('rejects a %s expected field', (_label, result) => {
    expect(() => validateLocalResult('switch_workspace', result, expectation)).toThrow(
      'Linear operation "switch_workspace" failed local result expectation: active must be a non-empty string.',
    );
  });

  it('rejects a non-object local result', () => {
    expect(() => validateLocalResult('switch_workspace', [], expectation)).toThrow(
      'Linear operation "switch_workspace" failed local result expectation: result must be an object.',
    );
  });

  it('rejects a local operation with no declared expectation', () => {
    expect(() => validateLocalResult('switch_workspace', { active: 'work' }, undefined)).toThrow(
      'Linear operation "switch_workspace" ran locally without a result expectation.',
    );
  });

  it('accepts a valid local result', () => {
    expect(() => validateLocalResult('switch_workspace', { active: 'work' }, expectation)).not.toThrow();
  });

  it('fails the execution path before the result is routed', async () => {
    const operation = {
      ...operations.switch_workspace!,
      executeLocal: async () => ({ active: false }) as any,
    };
    await expect(executeOperation(operation, { variables: { name: 'second' } }, 'allowlist', { hasUI: false } as any, undefined))
      .rejects.toThrow('failed local result expectation: active must be a non-empty string.');
  });
});

describe('public surfaces', () => {
  const typed = new Map(typedLinearTools().map((entry) => [entry.name, entry]));

  function execute(entry: any, params: JsonObject) {
    return entry.execute('call-1', params, undefined, undefined, { hasUI: false });
  }

  it('switches a workspace through the activated typed tool', async () => {
    const result = await execute(typed.get('linear_switch_workspace')!, { name: 'second' });
    expect(result.details).toEqual({ active: 'second' });
    const stored = JSON.parse(await readFile(join(agentDirectory, 'extensions/linear/credentials.json'), 'utf8'));
    expect(stored.activeWorkspace).toBe('second');
  });

  it('switches a workspace through the typed tool', async () => {
    const result = await execute(typed.get('linear_switch_workspace')!, { name: 'second' });
    expect(result.details).toEqual({ active: 'second' });
  });

  it('rejects a workspace switch under the readonly entry mode before changing the file', async () => {
    const readonlyTool = typedLinearTools('readonly').find(({ name }) => name === 'linear_switch_workspace')!;
    const before = await readFile(join(agentDirectory, 'extensions/linear/credentials.json'));

    await expect(execute(readonlyTool, { name: 'second' })).rejects.toThrow('read-only mode');

    expect(await readFile(join(agentDirectory, 'extensions/linear/credentials.json'))).toEqual(before);
  });

  it('lets LINEAR_READONLY=1 override the normal typed entry mode', async () => {
    process.env.LINEAR_READONLY = '1';
    const before = await readFile(join(agentDirectory, 'extensions/linear/credentials.json'));

    await expect(execute(typed.get('linear_switch_workspace')!, { name: 'second' })).rejects.toThrow('read-only mode');

    expect(await readFile(join(agentDirectory, 'extensions/linear/credentials.json'))).toEqual(before);
  });

  it('rejects an unknown workspace with the stored-workspace error', async () => {
    await expect(execute(typed.get('linear_switch_workspace')!, { name: 'missing' }))
      .rejects.toThrow('Workspace "missing" does not exist.');
  });

  it('renders the switched workspace', () => {
    const renderers = operationRenderers(operations.switch_workspace!);
    const theme: any = { fg: (_name: string, text: string) => text, bold: (text: string) => text };
    const block = renderers.renderResult(
      { content: [{ type: 'text', text: '{"active":"second"}' }], details: { active: 'second' } } as any,
      { expanded: false, isPartial: false } as any,
      theme,
      { args: { name: 'second' } } as any,
    );
    expect(block.render(120).join('\n')).toContain('second');
  });
});
