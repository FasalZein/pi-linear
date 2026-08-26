import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { getAgentDir, getSettingsListTheme } from '@earendil-works/pi-coding-agent';
import { type SettingItem, SettingsList } from '@earendil-works/pi-tui';
import {
  HUMAN_READABLE,
  RESULT_OUTPUT_FORMATS,
  formatFromJsonView,
  getDefaultJsonView,
  invalidateLinearResultRenderers,
  jsonViewFromFormat,
  setDefaultJsonView,
  type ResultOutputFormat,
} from './renderers/state';

export {
  FULL_JSON,
  HUMAN_READABLE,
  getDefaultJsonView,
  invalidateLinearResultRenderers,
  registerLinearResultRenderer,
  resetLinearResultPreferenceForTests,
  setDefaultJsonView,
} from './renderers/state';

type SettingsDocument = {
  defaultOutputFormat?: string | boolean | null;
  defaultJsonView?: string | boolean | null;
};

export type ResultPreferenceLoad = {
  format: ResultOutputFormat;
  error?: string;
};

export function getResultPreferencePath(): string {
  return join(getAgentDir(), 'state', 'extensions', 'linear', 'settings.json');
}

function defaultPreference(): ResultPreferenceLoad {
  setDefaultJsonView(false);
  return { format: HUMAN_READABLE };
}

export async function loadResultPreference(): Promise<ResultPreferenceLoad> {
  try {
    const raw = JSON.parse(await fs.readFile(getResultPreferencePath(), 'utf8')) as SettingsDocument;
    const format = jsonViewFromFormat(raw.defaultOutputFormat ?? raw.defaultJsonView);
    if (format === undefined) {
      const fallback = defaultPreference();
      return { ...fallback, error: 'Linear settings are invalid. Default output format reset to Human readable.' };
    }
    setDefaultJsonView(format);
    return { format: formatFromJsonView(format) };
  } catch (error) {
    const fallback = defaultPreference();
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return fallback;
    return { ...fallback, error: 'Linear settings could not be read. Default output format is Human readable.' };
  }
}

export async function saveResultPreference(format: ResultOutputFormat): Promise<void> {
  const jsonView = jsonViewFromFormat(format);
  if (jsonView === undefined) throw new Error(`Unsupported Linear output format: ${String(format)}`);
  setDefaultJsonView(jsonView);
  const path = getResultPreferencePath();
  await fs.mkdir(dirname(path), { recursive: true });
  await fs.writeFile(path, `${JSON.stringify({ defaultOutputFormat: format }, null, 2)}\n`, 'utf8');
}

export async function applyDefaultOutputFormat(format: ResultOutputFormat): Promise<void> {
  const previous = getDefaultJsonView();
  await saveResultPreference(format);
  if (getDefaultJsonView() !== previous) invalidateLinearResultRenderers();
}

export function buildResultPreferenceItems(format: ResultOutputFormat = formatFromJsonView(getDefaultJsonView())): SettingItem[] {
  return [{
    id: 'defaultOutputFormat',
    label: 'Default output format',
    description: 'Controls Linear result display. Expand inverts the other view for one row.',
    currentValue: format,
    values: [...RESULT_OUTPUT_FORMATS],
  }];
}

async function notifyLoadError(ctx: ExtensionContext | undefined, error?: string): Promise<void> {
  if (!error || !ctx?.ui?.notify) return;
  ctx.ui.notify(error, 'warning');
}

function settingsListTheme() {
  try {
    return getSettingsListTheme();
  } catch {
    return {
      label: (text: string) => text,
      value: (text: string) => text,
      description: (text: string) => text,
      cursor: '→ ',
      hint: (text: string) => text,
    };
  }
}

export function registerLinearSettings(pi: ExtensionAPI): void {
  void loadResultPreference();

  pi.registerCommand('linear-settings', {
    description: 'Set Linear default output format: Human readable or Full JSON',
    handler: async (_args, ctx) => {
      const loaded = await loadResultPreference();
      await notifyLoadError(ctx, loaded.error);
      const items = buildResultPreferenceItems(loaded.format);
      await ctx.ui.custom((_tui, theme, _kb, done) => {
        const settingsList = new SettingsList(
          items,
          6,
          settingsListTheme(),
          async (id, value) => {
            if (id !== 'defaultOutputFormat') return;
            const format = jsonViewFromFormat(value);
            if (format === undefined) return;
            await applyDefaultOutputFormat(formatFromJsonView(format));
            settingsList.updateValue(id, formatFromJsonView(format));
          },
          () => done(undefined),
        );
        return {
          items,
          render: (width: number) => [
            theme.fg('accent', theme.bold('Linear settings')),
            theme.fg('muted', 'Default output format for Linear results'),
            '',
            ...settingsList.render(width),
          ],
          invalidate: () => settingsList.invalidate(),
          handleInput: (data: string) => settingsList.handleInput?.(data),
        };
      });
    },
  });

  pi.on('session_start', async (_event, ctx) => {
    const loaded = await loadResultPreference();
    await notifyLoadError(ctx, loaded.error);
  });

  pi.on('session_before_switch', async (_event, ctx) => {
    const loaded = await loadResultPreference();
    await notifyLoadError(ctx, loaded.error);
  });
}
