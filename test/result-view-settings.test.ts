import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getOperation } from '../extensions/operations';
import { operationRenderers, renderLinearApiResult } from '../extensions/renderers';

import {
  applyDefaultOutputFormat,
  getDefaultJsonView,
  getResultPreferencePath,
  invalidateLinearResultRenderers,
  loadResultPreference,
  registerLinearResultRenderer,
  registerLinearSettings,
  resetLinearResultPreferenceForTests,
  saveResultPreference,
} from '../extensions/settings';

const originalDirectory = process.env.PI_CODING_AGENT_DIR;
let directory: string | undefined;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'pi-linear-settings-'));
  process.env.PI_CODING_AGENT_DIR = directory;
  resetLinearResultPreferenceForTests();
});

afterEach(async () => {
  resetLinearResultPreferenceForTests();
  if (originalDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalDirectory;
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

const theme = {
  fg: (_role: string, text: string) => text,
  bg: (_role: string, text: string) => text,
  bold: (text: string) => text,
  italic: (text: string) => text,
  underline: (text: string) => text,
} as any;

const ISSUE = {
  id: 'issue-1',
  identifier: 'AEO-258',
  title: 'Fix login redirect',
  state: { name: 'In Progress' },
};

function result<T>(details: T) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(details) }], details } as any;
}

type RenderContext = { toolCallId?: string; invalidate?: () => void };

function render<T>(
  operation: string,
  details: T,
  options: { expanded?: boolean } = {},
  context: RenderContext = {},
) {
  return operationRenderers(getOperation(operation)).renderResult(
    result(details),
    { expanded: options.expanded ?? false, isPartial: false },
    theme,
    context as any,
  );
}

function text(component: any): string {
  return component.render(120).join('\n');
}

describe('persisted result preference', () => {
  it('defaults to Human readable and never writes credentials', async () => {
    const loaded = await loadResultPreference();
    expect(loaded.format).toBe('Human readable');
    expect(loaded.error).toBeUndefined();
    expect(getDefaultJsonView()).toBe(false);
    expect(getResultPreferencePath()).toContain(directory);
    expect(getResultPreferencePath()).toContain('/state/extensions/linear/');
    expect(getResultPreferencePath()).not.toContain('credentials');

    await saveResultPreference('Full JSON');
    const raw = await readFile(getResultPreferencePath(), 'utf8');
    expect(raw).toContain('Full JSON');
    expect(raw).not.toMatch(/lin_api_|apiKey|credential/i);

    const again = await loadResultPreference();
    expect(again.format).toBe('Full JSON');
    expect(getDefaultJsonView()).toBe(true);
  });

  it('falls back to Human readable for invalid config without blocking execution', async () => {
    await mkdir(join(directory!, 'state', 'extensions', 'linear'), { recursive: true });
    await writeFile(getResultPreferencePath(), '{not-json', 'utf8');
    const loaded = await loadResultPreference();
    expect(loaded.format).toBe('Human readable');
    expect(loaded.error).toMatch(/settings/i);
    expect(getDefaultJsonView()).toBe(false);

    await writeFile(getResultPreferencePath(), JSON.stringify({ defaultOutputFormat: 'xml' }), 'utf8');
    const invalid = await loadResultPreference();
    expect(invalid.format).toBe('Human readable');
    expect(invalid.error).toMatch(/settings/i);
  });

  it('uses isolated PI_CODING_AGENT_DIR storage', async () => {
    await saveResultPreference('Full JSON');
    const first = getResultPreferencePath();
    expect(first.startsWith(directory!)).toBe(true);

    const other = await mkdtemp(join(tmpdir(), 'pi-linear-settings-b-'));
    process.env.PI_CODING_AGENT_DIR = other;
    resetLinearResultPreferenceForTests();
    const loaded = await loadResultPreference();
    expect(loaded.format).toBe('Human readable');
    expect(getResultPreferencePath().startsWith(other)).toBe(true);
    await rm(other, { recursive: true, force: true });
  });
});

describe('default view and expand override', () => {
  const details = { data: { issue: ISSUE }, meta: { truncations: [], stringsClipped: 0 } };

  it('shows the human summary by default and Full JSON when expanded', () => {
    const human = text(render('get_issue', details));
    expect(human).toContain('✓ Loaded AEO-258 Fix login redirect');
    expect(human).toContain('show full JSON');
    expect(human).not.toContain('"identifier":"AEO-258"');

    const json = text(render('get_issue', details, { expanded: true }));
    expect(json).toContain('Full JSON response');
    expect(json).toContain('"identifier":"AEO-258"');
    expect(json).toContain('show summary');
  });

  it('inverts expand when the stored default is Full JSON', async () => {
    await saveResultPreference('Full JSON');
    const json = text(render('get_issue', details));
    expect(json).toContain('Full JSON response');
    expect(json).toContain('"identifier":"AEO-258"');
    expect(json).toContain('show summary');

    const human = text(render('get_issue', details, { expanded: true }));
    expect(human).toContain('✓ Loaded AEO-258 Fix login redirect');
    expect(human).not.toContain('"identifier":"AEO-258"');
    expect(human).toContain('show full JSON');
  });

  it('applies the same inverse on linear discovery help', async () => {
    await saveResultPreference('Full JSON');
    const help = { purpose: 'Get one issue.', example: { issue: 'AEO-258' } };
    const args = { operation: 'help', variables: { operation: 'get_issue' } };
    const json = text(renderLinearApiResult(result(help), { expanded: false, isPartial: false }, theme, { args } as any));
    expect(json).toContain('Full JSON response');

    const human = text(renderLinearApiResult(result(help), { expanded: true, isPartial: false }, theme, { args } as any));
    expect(human).toContain('✓ operation help');
  });
});

describe('invalidation', () => {
  it('registers visible invalidate hooks and re-renders after a preference change', async () => {
    const details = { data: { issue: ISSUE }, meta: { truncations: [], stringsClipped: 0 } };
    const invalidate = vi.fn();
    const first = render('get_issue', details, {}, { toolCallId: 'row-1', invalidate });
    expect(text(first)).toContain('✓ Loaded AEO-258');

    await applyDefaultOutputFormat('Full JSON');
    expect(invalidate).toHaveBeenCalledTimes(1);

    const second = render('get_issue', details, {}, { toolCallId: 'row-1', invalidate });
    expect(text(second)).toContain('Full JSON response');
  });

  it('ignores a stale invalidator and still updates later rows', () => {
    const stale = vi.fn(() => {
      throw new Error('stale row');
    });
    const next = vi.fn();
    registerLinearResultRenderer({ toolCallId: 'old', invalidate: stale });
    registerLinearResultRenderer({ toolCallId: 'new', invalidate: next });
    invalidateLinearResultRenderers();
    expect(stale).toHaveBeenCalled();
    expect(next).toHaveBeenCalled();
  });
});

describe('linear-settings command', () => {
  it('registers /linear-settings without per-tool activation controls', async () => {
    const commands = new Map<string, { description: string; handler: Function }>();
    const events: string[] = [];
    const notify = vi.fn();
    let customItems: Array<{ id: string; values?: string[] }> = [];
    const pi = {
      registerCommand: (name: string, spec: { description: string; handler: Function }) => {
        commands.set(name, spec);
      },
      on: (event: string) => {
        events.push(event);
      },
      getAllTools: () => [],
      getActiveTools: () => ['linear'],
      setActiveTools: vi.fn(),
      registerTool: () => undefined,
    };

    await registerLinearSettings(pi as any);
    expect(commands.has('linear-settings')).toBe(true);
    expect(commands.get('linear-settings')!.description.toLowerCase()).toContain('output');
    expect(events).toEqual(expect.arrayContaining(['session_start', 'session_before_switch']));

    await commands.get('linear-settings')!.handler('', {
      mode: 'tui',
      ui: {
        notify,
        custom: async (factory: any) => {
          const component = factory(undefined, theme, undefined, () => undefined);
          customItems = component.items ?? [];
          return undefined;
        },
      },
    });

    const ids = customItems.map((item) => item.id);
    expect(ids).toContain('defaultOutputFormat');
    expect(ids.some((id) => id.includes('linear_'))).toBe(false);
    expect(customItems.find((item) => item.id === 'defaultOutputFormat')?.values).toEqual([
      'Human readable',
      'Full JSON',
    ]);
  });
});
