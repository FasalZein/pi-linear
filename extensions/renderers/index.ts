import type {
  AgentToolResult,
  Theme,
  ToolRenderResultOptions,
} from '@earendil-works/pi-coding-agent';
import { Text } from '@earendil-works/pi-tui';
import { getOperation, type LinearOperation } from '../operations';
import { canonicalFieldNames } from '../canonical';
import { typedToolName } from '../tool-names';
import {
  asRecord,
  LinearBlockComponent,
  asString,
  cleanOneLine,
  expandedJson,
  formatToolArgValue,
  scrubCredentials,
  jsonHint,
  LinearListComponent,
  plural,
  renderErrorResult,
  renderTable,
  renderToolCall,
  truncate,
  type ToolArgs,
} from './common';
import { specFor, type Entity, type EntitySpec } from './entities';

const PREVIEW_LIMIT = 20;

/**
 * Structural view of pi's ToolRenderContext (not exported by the package).
 * Every field is optional so the concrete context stays assignable.
 */
export type LinearRenderContext = {
  args?: unknown;
  isError?: boolean;
  toolCallId?: string;
  invalidate?: () => void;
};

type Meta = {
  truncations?: Array<{ path: string; kept: number; endCursor?: string }>;
  stringsClipped?: number;
  resultBudget?: { maxBytes: number; truncated: true };
};

type Digest =
  | { kind: 'spill'; path: string; bytes: number; index: string[]; notes: string[] }
  | { kind: 'list'; entities: Entity[]; notes: string[] }
  | { kind: 'entity'; entity: Entity; notes: string[] }
  | { kind: 'mutation'; success: boolean; entity?: Entity; notes: string[] }
  | { kind: 'unknown'; notes: string[] };

function metaNotes(details: Record<string, unknown>): string[] {
  const notes: string[] = [];
  const meta = (asRecord(details.meta) ?? {}) as Meta;
  for (const truncation of meta.truncations ?? []) {
    notes.push(truncation.endCursor
      ? `kept ${truncation.kept} nodes — request the next page with after="${truncation.endCursor}"`
      : `kept ${truncation.kept} nodes — narrow the filter for the rest`);
  }
  if (meta.resultBudget?.truncated) {
    notes.push(`result trimmed to ${Math.round(meta.resultBudget.maxBytes / 1024)} KB — request fewer fields or fewer nodes`);
  }
  if (typeof meta.stringsClipped === 'number' && meta.stringsClipped > 0) {
    notes.push(`${plural(meta.stringsClipped, 'long field')} clipped`);
  }
  const target = asRecord(asRecord(details.resolution)?.target);
  if (target) {
    const resolved = asString(target.identifier) ?? asString(target.key) ?? asString(target.name) ?? asString(target.resolvedId);
    const requested = asString(target.requested);
    if (requested && resolved && requested !== resolved) notes.push(`resolved ${requested} → ${resolved}`);
  }
  return notes;
}

function pageNote(connection: Record<string, unknown>): string | undefined {
  const pageInfo = asRecord(connection.pageInfo);
  if (pageInfo?.hasNextPage !== true) return undefined;
  const cursor = asString(pageInfo.endCursor);
  return cursor ? `more pages — request after="${cursor}"` : 'more pages available';
}

/** Reduce one tool result to the smallest shape the TUI needs. */
export function digestResult(result: AgentToolResult<any>): Digest {
  const details = asRecord(result.details) ?? {};
  const notes = metaNotes(details);

  const path = asString(details.path);
  if (path) {
    return {
      kind: 'spill',
      path,
      bytes: typeof details.bytes === 'number' ? details.bytes : 0,
      index: Array.isArray(details.index) ? details.index.filter((entry): entry is string => typeof entry === 'string') : [],
      notes,
    };
  }

  const data = asRecord(details.data);
  const root = data ? Object.values(data).find((value) => asRecord(value)) : undefined;
  const record = asRecord(root);
  if (!record) return { kind: 'unknown', notes };

  if (Array.isArray(record.nodes)) {
    const page = pageNote(record);
    return {
      kind: 'list',
      entities: record.nodes.filter((node): node is Entity => !!asRecord(node)),
      notes: page ? [...notes, page] : notes,
    };
  }
  if ('success' in record) {
    const entity = Object.entries(record)
      .filter(([key]) => key !== 'success')
      .map(([, value]) => asRecord(value))
      .find((value): value is Entity => !!value);
    return { kind: 'mutation', success: record.success === true, entity, notes };
  }
  return { kind: 'entity', entity: record as Entity, notes };
}

type Verb = { past: string; present: string };

function verbFor(operationName: string): Verb {
  if (operationName.startsWith('create_')) return { past: 'Created', present: 'Creating' };
  if (operationName.startsWith('update_') || operationName.startsWith('set_')) {
    return { past: 'Updated', present: 'Updating' };
  }
  if (operationName.startsWith('save_')) return { past: 'Saved', present: 'Saving' };
  if (operationName.startsWith('switch_')) return { past: 'Switched', present: 'Switching' };
  if (operationName.startsWith('search_')) return { past: 'Searched', present: 'Searching' };
  return { past: 'Loaded', present: 'Loading' };
}

/**
 * The status line: outcome, identifier, name — in that order, on one row.
 * Everything else is one dim line below it.
 */
function statusLine(theme: Theme, spec: EntitySpec, entity: Entity, verb: string): string {
  const lead = spec.lead?.(entity);
  const parts = [
    theme.fg('success', `✓ ${verb}`),
    lead ? theme.fg('accent', lead) : undefined,
    theme.fg('toolOutput', spec.label(entity)),
  ].filter((part): part is string => !!part);
  return parts.join(' ');
}

function entityBlock(theme: Theme, spec: EntitySpec, entity: Entity, verb: string, notes: string[]): string[] {
  const lines = ['', statusLine(theme, spec, entity, verb)];
  const metadata = spec.metadata(entity);
  if (metadata.length) lines.push(`  ${theme.fg('dim', metadata.join(' · '))}`);
  const body = spec.body?.(entity);
  if (body) lines.push(`  ${theme.fg('muted', body)}`);
  const url = asString(entity.url);
  if (url) lines.push(`  ${theme.fg('dim', url)}`);
  for (const note of notes) lines.push(`  ${theme.fg('dim', note)}`);
  return [...lines, '', theme.fg('dim', jsonHint())];
}

function pluralNoun(spec: EntitySpec): string {
  return spec.pluralNoun ?? `${spec.noun}s`;
}

function spillBlock(theme: Theme, digest: Extract<Digest, { kind: 'spill' }>): string[] {
  const size = `${Math.max(1, Math.round(digest.bytes / 1024))} KB`;
  const lines = ['', theme.fg('success', `✓ ${size} written to disk`), `  ${theme.fg('dim', digest.path)}`];
  for (const entry of digest.index.slice(0, 8)) {
    lines.push(`  ${theme.fg('muted', cleanOneLine(entry))}`);
  }
  if (digest.index.length > 8) {
    lines.push(`  ${theme.fg('dim', `… ${digest.index.length - 8} more entries in the file`)}`);
  }
  lines.push(`  ${theme.fg('dim', 'Read the file for the full payload.')}`);
  for (const note of digest.notes) lines.push(`  ${theme.fg('dim', note)}`);
  return [...lines, '', theme.fg('dim', jsonHint())];
}

function renderDigest(
  digest: Digest,
  result: AgentToolResult<any>,
  theme: Theme,
  spec: EntitySpec,
  verb: Verb,
): Text | LinearBlockComponent | LinearListComponent<Entity> {
  if (digest.kind === 'spill') return new LinearBlockComponent(spillBlock(theme, digest));

  if (digest.kind === 'list') {
    return new LinearListComponent(digest.entities, theme, {
      headline: `${plural(digest.entities.length, spec.noun, spec.pluralNoun)} returned`,
      emptyLabel: `No ${pluralNoun(spec)} matched this request.`,
      emptyAction: 'Loosen a filter or widen the page.',
      footnotes: digest.notes,
      previewLimit: PREVIEW_LIMIT,
      noun: spec.noun,
      renderItems: (items, itemTheme, width) => renderTable(items, itemTheme, width, {
        columns: spec.columns,
        primary: { label: spec.primaryLabel ?? 'Name', value: spec.label },
        dropOrder: spec.dropOrder,
        fallback: (item, fallbackTheme, fallbackWidth) => {
          const lead = spec.lead?.(item);
          const label = fallbackTheme.fg('toolOutput', spec.label(item));
          return truncate(`  ${lead ? `${fallbackTheme.fg('accent', lead)} ` : ''}${label}`, fallbackWidth);
        },
      }),
    });
  }

  if (digest.kind === 'entity') {
    return new LinearBlockComponent(entityBlock(theme, spec, digest.entity, verb.past, digest.notes));
  }

  if (digest.kind === 'mutation') {
    if (!digest.success) {
      return new LinearBlockComponent([
        '',
        theme.fg('warning', `${verb.past} ${spec.noun}: status unknown`),
        `  ${theme.fg('dim', 'Re-read the record to confirm the change.')}`,
        '',
        theme.fg('dim', jsonHint()),
      ]);
    }
    if (digest.entity) {
      return new LinearBlockComponent(entityBlock(theme, spec, digest.entity, verb.past, digest.notes));
    }
    return new LinearBlockComponent([
      '',
      theme.fg('success', `✓ ${verb.past} ${spec.noun}`),
      '',
      theme.fg('dim', jsonHint()),
    ]);
  }

  const active = asString((asRecord(result.details) ?? {}).active);
  if (active) {
    return new LinearBlockComponent([
      '',
      `${theme.fg('success', `✓ ${verb.past} workspace`)} ${theme.fg('accent', active)}`,
      '',
      theme.fg('dim', jsonHint()),
    ]);
  }

  const summary = cleanOneLine(JSON.stringify(result.details ?? {}));
  return new LinearBlockComponent([
    '',
    theme.fg('toolOutput', truncate(summary, 200)),
    '',
    theme.fg('dim', jsonHint()),
  ]);
}

function callKeys(operation: LinearOperation): string[] {
  return [...canonicalFieldNames(operation), 'workspace'];
}

export type OperationRenderers = {
  renderCall: (args: any, theme: Theme, context: LinearRenderContext) => LinearBlockComponent;
  renderResult: (
    result: AgentToolResult<any>,
    options: ToolRenderResultOptions,
    theme: Theme,
    context: LinearRenderContext,
  ) => Text | LinearBlockComponent | LinearListComponent<Entity>;
};

/** Renderers for one typed tool, derived from the catalog entry. */
export function operationRenderers(operation: LinearOperation): OperationRenderers {
  const spec = specFor(operation.name);
  const verb = verbFor(operation.name);
  const keys = callKeys(operation);
  const toolName = typedToolName(operation.name);

  return {
    renderCall: (args, theme) => renderToolCall(toolName, args as ToolArgs, theme, keys),
    renderResult: (result, options, theme, context) => {
      if (options.isPartial) {
        const noun = operation.pagination ? pluralNoun(spec) : spec.noun;
        return new Text(theme.fg('warning', `${verb.present} ${noun}…`), 0, 0);
      }
      if (context.isError) {
        return renderErrorResult(result, theme, `Fix the parameters and call ${toolName} again.`);
      }

      if (options.expanded) return expandedJson(result, theme);
      return renderDigest(digestResult(result), result, theme, spec, verb);
    },
  };
}

// ---------------------------------------------------------------------------
// linear_api: the loader keeps the same visual language as the typed tools.
// ---------------------------------------------------------------------------

const API_TOOL = 'linear_api';

function apiOperation(args: ToolArgs | undefined): LinearOperation | undefined {
  const name = asString(args?.operation);
  if (!name || name === 'help') return undefined;
  try {
    return getOperation(name);
  } catch {
    return undefined;
  }
}

export function renderLinearApiCall(args: any, theme: Theme): LinearBlockComponent {
  const toolArgs = (args ?? {}) as ToolArgs;
  const variables = asRecord(toolArgs.variables) ?? {};
  const operation = asString(toolArgs.operation);
  // Every rendered value passes the credential scrubber, including nested objects,
  // because a caller can put a token anywhere in `variables`.
  const summary = Object.entries(variables)
    .map(([key, value]) => `${key}=${scrubCredentials(formatToolArgValue(value) ?? String(value))}`)
    .join('  ');

  let text = theme.fg('toolTitle', theme.bold(API_TOOL));
  if (operation) text += ` ${theme.fg('accent', scrubCredentials(operation))}`;
  else if (asString(toolArgs.query)) text += ` ${theme.fg('accent', 'graphql')}`;
  if (summary) text += ` ${theme.fg('dim', summary)}`;
  return new LinearBlockComponent([text]);
}

function helpBlock(theme: Theme, details: Record<string, unknown>): LinearBlockComponent | undefined {
  const loaded = Array.isArray(details.loadedTools)
    ? details.loadedTools.filter((entry): entry is string => typeof entry === 'string')
    : [];
  const lines: string[] = [];

  if (Array.isArray(details.candidates)) {
    const candidates = details.candidates as Array<{ name?: string; signature?: string }>;
    lines.push(theme.fg('warning', `No tool loaded for "${asString(details.query) ?? ''}"`));
    lines.push(`  ${theme.fg('dim', 'Name one operation, or pick a candidate below.')}`);
    if (candidates.length) lines.push('');
    for (const candidate of candidates.slice(0, PREVIEW_LIMIT)) {
      lines.push(`  ${theme.fg('muted', candidate.signature ?? candidate.name ?? '')}`);
    }
    if (candidates.length > PREVIEW_LIMIT) {
      lines.push(`  ${theme.fg('dim', `… ${candidates.length - PREVIEW_LIMIT} more in the JSON`)}`);
    }
  } else if (Array.isArray(details.domains)) {
    lines.push(theme.fg('success', `✓ ${details.domains.length} domains`));
    lines.push(`  ${theme.fg('muted', details.domains.join('  '))}`);
    lines.push(`  ${theme.fg('dim', 'Ask for one operation to load its typed tool.')}`);
  } else if (Array.isArray(details.operations)) {
    const operations = details.operations as Array<{ name?: string; signature?: string }>;
    lines.push(theme.fg('success', `✓ ${plural(operations.length, 'operation')} in ${asString(details.domain) ?? 'domain'}`));
    lines.push('');
    for (const operation of operations.slice(0, PREVIEW_LIMIT)) {
      lines.push(`  ${theme.fg('muted', operation.signature ?? operation.name ?? '')}`);
    }
  } else if (asRecord(details.match)) {
    const match = asRecord(details.match)!;
    lines.push(theme.fg('success', `✓ ${asString(match.name) ?? 'match'}`));
    lines.push(`  ${theme.fg('muted', asString(match.signature) ?? '')}`);
    if (asString(match.purpose)) lines.push(`  ${theme.fg('dim', asString(match.purpose)!)}`);
    const alternatives = Array.isArray(details.alternatives) ? details.alternatives : [];
    for (const alternative of alternatives.slice(0, PREVIEW_LIMIT) as Array<{ signature?: string }>) {
      if (alternative.signature) lines.push(`  ${theme.fg('dim', alternative.signature)}`);
    }
    if (alternatives.length > PREVIEW_LIMIT) {
      lines.push(`  ${theme.fg('dim', `… ${alternatives.length - PREVIEW_LIMIT} more in the JSON`)}`);
    }
  } else if (asString(details.name) && Array.isArray(details.parameters)) {
    const parameters = details.parameters as Array<{ name: string; type: string; required: boolean }>;
    lines.push(theme.fg('success', `✓ ${asString(details.name)}`));
    if (asString(details.purpose)) lines.push(`  ${theme.fg('dim', asString(details.purpose)!)}`);
    lines.push('');
    for (const parameter of parameters) {
      const label = `${parameter.name}${parameter.required ? '' : '?'}`.padEnd(24);
      lines.push(`  ${theme.fg('muted', label)}${theme.fg('dim', parameter.type)}`);
    }
  } else {
    return undefined;
  }

  if (loaded.length) {
    // Count first: the row is clipped to the terminal width, and the count must survive.
    lines.push('');
    lines.push(`  ${theme.fg('success', `+ loaded ${plural(loaded.length, 'tool')}`)}`);
    lines.push(`  ${theme.fg('dim', loaded.join(', '))}`);
  }
  lines.push('');
  lines.push(theme.fg('dim', jsonHint()));
  return new LinearBlockComponent(['', ...lines]);
}

export function renderLinearApiResult(
  result: AgentToolResult<any>,
  options: ToolRenderResultOptions,
  theme: Theme,
  context: LinearRenderContext,
): Text | LinearBlockComponent | LinearListComponent<Entity> {
  const args = (context.args ?? {}) as ToolArgs;
  const operation = apiOperation(args);
  const spec = operation ? specFor(operation.name) : specFor('list_issues');
  const verb = verbFor(operation?.name ?? 'get');

  if (options.isPartial) {
    const label = asString(args.operation) ?? 'request';
    return new Text(theme.fg('warning', `Running ${label}…`), 0, 0);
  }
  if (context.isError) {
    const recovery = operation
      ? `Send { "operation": "help", "variables": { "operation": "${operation.name}" } } for the parameter card.`
      : 'Send { "operation": "help" } to list the operations.';
    return renderErrorResult(result, theme, recovery);
  }
  if (options.expanded) return expandedJson(result, theme);

  const help = helpBlock(theme, asRecord(result.details) ?? {});
  if (help) return help;

  const digest = digestResult(result);
  if (!operation && asString(args.operation) !== 'help' && digest.kind !== 'spill') {
    // Raw GraphQL: no catalog entry, so no entity language to borrow.
    const summary = cleanOneLine(JSON.stringify((asRecord(result.details) ?? {}).data ?? {}));
    return new LinearBlockComponent([
      '',
      theme.fg('success', '✓ GraphQL response'),
      `  ${theme.fg('toolOutput', truncate(summary, 240))}`,
      ...digest.notes.map((note) => `  ${theme.fg('dim', note)}`),
      '',
      theme.fg('dim', jsonHint()),
    ]);
  }
  return renderDigest(digest, result, theme, spec, verb);
}
