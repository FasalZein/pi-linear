// Table engine and tool-row language adapted from @alasano/pi-linear 0.4.1
// renderers/common.ts. Rewritten against this package's result shapes.
import {
  keyHint,
  type AgentToolResult,
  type Theme,
} from '@earendil-works/pi-coding-agent';
import { Text, truncateToWidth, visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';
import { activeSecrets } from '../active-secrets';
import { redactText } from '../redact';
import {
  getDefaultJsonView,
  registerLinearResultRenderer,
  type ResultRendererContext,
} from './state';

export type ToolArgs = Record<string, unknown>;
export type CellStyle = (text: string) => string;

export type TableColumn<T> = {
  id: string;
  label: string;
  minWidth: number;
  maxWidth?: number;
  align?: 'left' | 'right';
  value: (item: T) => string;
  style?: (theme: Theme, value: string, item: T) => CellStyle;
};

export type PrimaryTableColumn<T> = {
  label: string;
  minWidth?: number;
  value: (item: T) => string;
};

const TABLE_SEPARATOR = '  ';
const TABLE_MIN_WIDTH = 28;
const PRIMARY_MIN_WIDTH = 24;
const FALLBACK_PRIMARY_MIN_WIDTH = 10;
const TOOL_ARG_STRING_LIMIT = 48;


export function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function cleanOneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

export function truncateLine(value: string, width: number): string {
  return truncateToWidth(value, width, '…');
}

/**
 * Last line of defence in the TUI; the data boundary redacts first (redact.ts).
 * Call rows render raw tool arguments, so exact active secrets are removed here too.
 */
export function scrubCredentials(value: string): string {
  return redactText(value, activeSecrets());
}

export function textContent(result: AgentToolResult<any>): string {
  const block = result.content.find((entry) => entry.type === 'text');
  if (block?.type === 'text' && block.text) return block.text;
  return JSON.stringify(result.details ?? null, null, 2);
}

export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

/** keyHint needs an initialised theme; fall back to plain wording when absent. */
function expandHint(description: string): string {
  try {
    return keyHint('app.tools.expand', description);
  } catch {
    return description;
  }
}

export function jsonHint(): string {
  return expandHint('show full JSON');
}

export function shouldShowJson(
  options: { expanded?: boolean },
  context?: ResultRendererContext,
): boolean {
  registerLinearResultRenderer(context);
  return options.expanded !== getDefaultJsonView();
}

export function expandedJson(result: AgentToolResult<any>, theme: Theme): Text {
  const body = scrubCredentials(textContent(result));
  return new Text(
    `\n${theme.fg('dim', 'Full JSON response')}\n${body}\n\n${expandHint('show summary')}`,
    0,
    0,
  );
}

const DETAIL_LABEL_WIDTH = 12;

export function detailLine(
  theme: Theme,
  label: string,
  value: string,
  style: CellStyle = (text) => theme.fg('toolOutput', text),
): string {
  return `  ${theme.fg('dim', label.padEnd(DETAIL_LABEL_WIDTH))}${style(value)}`;
}

/** Errors read as one sentence, never as a JSON envelope. */
export function resultErrorMessage(result: AgentToolResult<any>): string {
  const raw = cleanOneLine(textContent(result));
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === 'string') return parsed;
    const record = asRecord(parsed);
    const message = asString(record?.error) ?? asString(record?.message);
    if (message) return message;
  } catch {
    // Plain-text error message: use it as it is.
  }
  return raw;
}

export function renderErrorResult(result: AgentToolResult<any>, theme: Theme, nextAction?: string): Text {
  const message = scrubCredentials(resultErrorMessage(result)) || 'Linear request failed.';
  const recovery = nextAction ?? 'Check the parameters and call the operation again.';
  return new Text(`\n${theme.fg('error', `✗ ${message}`)}\n  ${theme.fg('dim', recovery)}`, 0, 0);
}

function truncatePlain(value: string, width: number): string {
  if (width <= 0) return '';
  if (visibleWidth(value) <= width) return value;
  const target = width - 1;
  let output = '';
  let outputWidth = 0;
  for (const character of Array.from(value)) {
    const characterWidth = visibleWidth(character);
    if (outputWidth + characterWidth > target) break;
    output += character;
    outputWidth += characterWidth;
  }
  return `${output.trimEnd()}…`;
}

export function formatCell(
  rawValue: string,
  width: number,
  style: CellStyle,
  align: 'left' | 'right' = 'left',
): string {
  const value = cleanOneLine(rawValue || '—');
  const text = truncatePlain(value, width);
  const padding = ' '.repeat(Math.max(0, width - visibleWidth(text)));
  return align === 'right' ? `${padding}${style(text)}` : `${style(text)}${padding}`;
}

export const accentStyle = (theme: Theme): CellStyle => (text) => theme.fg('accent', text);
export const dimStyle = (theme: Theme): CellStyle => (text) => theme.fg('dim', text);
export const mutedStyle = (theme: Theme): CellStyle => (text) => theme.fg('muted', text);
export const outputStyle = (theme: Theme): CellStyle => (text) => theme.fg('toolOutput', text);

type LaidOutColumn<T> = TableColumn<T> & { width: number };

function preferredWidth<T>(column: TableColumn<T>, items: T[]): number {
  let preferred = Math.max(column.minWidth, visibleWidth(column.label));
  for (const item of items) {
    preferred = Math.max(preferred, visibleWidth(cleanOneLine(column.value(item) || '—')));
  }
  return column.maxWidth == null ? preferred : Math.min(preferred, Math.max(column.minWidth, column.maxWidth));
}

function fitLayout<T>(
  width: number,
  columns: TableColumn<T>[],
  items: T[],
  dropOrder: string[] | undefined,
  primaryMinWidth = PRIMARY_MIN_WIDTH,
): { columns: LaidOutColumn<T>[]; primaryWidth: number } | undefined {
  if (width < TABLE_MIN_WIDTH) return undefined;
  const available = width - 2;
  const order = dropOrder ?? columns.map((column) => column.id).reverse();
  let visible = [...columns];
  const minCost = (candidates: TableColumn<T>[]) =>
    candidates.reduce((sum, column) => sum + column.minWidth, 0)
    + TABLE_SEPARATOR.length * candidates.length
    + primaryMinWidth;

  for (const id of order) {
    if (minCost(visible) <= available) break;
    visible = visible.filter((column) => column.id !== id);
  }
  if (minCost(visible) > available) {
    const fallbackCost = minCost(visible) - primaryMinWidth + FALLBACK_PRIMARY_MIN_WIDTH;
    if (fallbackCost > available) return undefined;
  }

  const allocated = visible.map((column) => column.minWidth);
  let extra = available
    - allocated.reduce((sum, value) => sum + value, 0)
    - TABLE_SEPARATOR.length * visible.length
    - primaryMinWidth;
  if (extra > 0) {
    visible.forEach((column, index) => {
      const grow = Math.min(Math.max(0, preferredWidth(column, items) - allocated[index]!), extra);
      allocated[index] += grow;
      extra -= grow;
    });
  }
  const primaryWidth = available
    - allocated.reduce((sum, value) => sum + value, 0)
    - TABLE_SEPARATOR.length * visible.length;
  if (primaryWidth < FALLBACK_PRIMARY_MIN_WIDTH) return undefined;
  return {
    columns: visible.map((column, index) => ({ ...column, width: allocated[index]! })),
    primaryWidth,
  };
}

/**
 * Dense aligned rows: metadata columns first, the naming column last.
 * Columns grow to measured content, shrink to a semantic minimum, then drop
 * by priority so identifiers and names survive every width.
 */
export function renderTable<T>(
  items: T[],
  theme: Theme,
  width: number,
  options: {
    columns: TableColumn<T>[];
    primary: PrimaryTableColumn<T>;
    dropOrder?: string[];
    fallback: (item: T, theme: Theme, width: number) => string;
  },
): string[] {
  const layout = fitLayout(
    width,
    options.columns,
    items,
    options.dropOrder,
    options.primary.minWidth ?? PRIMARY_MIN_WIDTH,
  );
  if (!layout) return items.map((item) => options.fallback(item, theme, width));

  const header = [
    ...layout.columns.map((column) =>
      formatCell(column.label, column.width, dimStyle(theme), column.align),
    ),
    formatCell(options.primary.label, layout.primaryWidth, dimStyle(theme)),
  ];
  const lines = [truncateToWidth(`  ${header.join(TABLE_SEPARATOR)}`, width, '…')];

  for (const item of items) {
    const cells = [
      ...layout.columns.map((column) => {
        const value = column.value(item);
        const style = column.style?.(theme, value, item) ?? mutedStyle(theme);
        return formatCell(value, column.width, style, column.align);
      }),
      formatCell(options.primary.value(item), layout.primaryWidth, outputStyle(theme)),
    ];
    lines.push(truncateToWidth(`  ${cells.join(TABLE_SEPARATOR)}`, width, '…'));
  }
  return lines;
}

export type WrappedLine = { text: string; indent?: number };

/** Mark prose that must wrap instead of losing recovery data at the terminal edge. */
export function wrapped(text: string, indent = 0): WrappedLine {
  return { text, indent };
}

function renderBlockLines(lines: Array<string | WrappedLine>, width: number): string[] {
  return lines.flatMap((line) => {
    if (typeof line === 'string') return truncateToWidth(scrubCredentials(line), width, '…');
    const indent = Math.min(line.indent ?? 0, Math.max(0, width - 1));
    return wrapTextWithAnsi(scrubCredentials(line.text), Math.max(1, width - indent))
      .map((part) => `${' '.repeat(indent)}${part}`);
  });
}

/**
 * A block of pre-composed lines. Data rows clip with one Unicode ellipsis.
 * Actionable prose uses `wrapped()` so identifiers and recovery values remain visible.
 */
export class LinearBlockComponent {
  constructor(private readonly lines: Array<string | WrappedLine>) {}

  render(width: number): string[] {
    return renderBlockLines(this.lines, width);
  }

  invalidate(): void {}
}

/** A list result that re-renders on terminal resize. */
export class LinearListComponent<T> {
  constructor(
    private readonly items: T[],
    private readonly theme: Theme,
    private readonly options: {
      headline: string;
      emptyLabel: string;
      emptyAction?: string;
      footnotes: string[];
      previewLimit?: number;
      noun: string;
      renderItems: (items: T[], theme: Theme, width: number) => string[];
    },
  ) {}

  render(width: number): string[] {
    const theme = this.theme;
    const lines: Array<string | WrappedLine> = [''];

    if (this.items.length === 0) {
      lines.push(wrapped(theme.fg('muted', `○ ${this.options.emptyLabel}`), 2));
      if (this.options.emptyAction) lines.push(wrapped(theme.fg('dim', this.options.emptyAction), 2));
    } else {
      const limit = this.options.previewLimit ?? 20;
      const shown = this.items.slice(0, limit);
      lines.push(theme.fg('success', `✓ ${this.options.headline}`));
      lines.push('');
      lines.push(...this.options.renderItems(shown, theme, width));
      if (shown.length < this.items.length) {
        lines.push(
          theme.fg('dim', `  … ${plural(this.items.length - shown.length, `more ${this.options.noun}`)} in the JSON`),
        );
      }
    }

    const rendered = renderBlockLines(lines, width);
    for (const note of this.options.footnotes) {
      rendered.push(...wrapTextWithAnsi(scrubCredentials(theme.fg('dim', note)), Math.max(1, width - 2))
        .map((part) => `  ${part}`));
    }
    rendered.push('');
    rendered.push(...wrapTextWithAnsi(scrubCredentials(theme.fg('dim', jsonHint())), Math.max(1, width)));
    return rendered;
  }

  invalidate(): void {}
}

export function formatToolArgValue(value: unknown): string | undefined {
  // null is a request to clear a field, not an absent argument: it must be visible.
  if (value === null) return 'null';
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    const clipped = truncate(scrubCredentials(trimmed), TOOL_ARG_STRING_LIMIT);
    return trimmed.includes(' ') ? `"${clipped}"` : clipped;
  }
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) return value.length ? `[${value.length}]` : undefined;
  if (value && typeof value === 'object') return '{…}';
  return undefined;
}

/**
 * One call row: bold tool name, then every supplied argument in declaration order,
 * so the same operation always reads the same. The row is clipped to the terminal
 * width rather than to an argument count, and stays one line.
 */
export function renderToolCall(
  toolName: string,
  args: ToolArgs | undefined,
  theme: Theme,
  keys: readonly string[],
): LinearBlockComponent {
  const parts = keys
    .map((key) => {
      const value = formatToolArgValue(args?.[key]);
      return value ? `${key}=${value}` : undefined;
    })
    .filter((part): part is string => !!part);
  const suffix = parts.length ? ` ${theme.fg('dim', parts.join('  '))}` : '';
  return new LinearBlockComponent([`${theme.fg('toolTitle', theme.bold(toolName))}${suffix}`]);
}
