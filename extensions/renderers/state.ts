export type ResultRendererContext = {
  toolCallId?: string;
  invalidate?: () => void;
};

export const HUMAN_READABLE = 'Human readable';
export const FULL_JSON = 'Full JSON';
export const RESULT_OUTPUT_FORMATS = [HUMAN_READABLE, FULL_JSON] as const;
export type ResultOutputFormat = (typeof RESULT_OUTPUT_FORMATS)[number];

let defaultJsonView = false;
const invalidators = new Map<string, () => void>();

export function getDefaultJsonView(): boolean {
  return defaultJsonView;
}

export function setDefaultJsonView(value: boolean): void {
  defaultJsonView = value;
}

export function formatFromJsonView(value: boolean): ResultOutputFormat {
  return value ? FULL_JSON : HUMAN_READABLE;
}

export function jsonViewFromFormat(value: string | boolean | null | undefined): boolean | undefined {
  if (value === FULL_JSON || value === true) return true;
  if (value === HUMAN_READABLE || value === false) return false;
  return undefined;
}

export function registerLinearResultRenderer(context?: ResultRendererContext): void {
  if (!context?.invalidate || !context.toolCallId) return;
  invalidators.set(context.toolCallId, context.invalidate);
}

export function invalidateLinearResultRenderers(): void {
  for (const invalidate of invalidators.values()) {
    try {
      invalidate();
    } catch {
      // Stale rows are best-effort refresh hooks.
    }
  }
}

export function resetLinearResultPreferenceForTests(): void {
  defaultJsonView = false;
  invalidators.clear();
}
