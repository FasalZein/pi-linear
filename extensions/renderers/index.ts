import type {
  AgentToolResult,
  Theme,
  ToolRenderResultOptions,
} from '@earendil-works/pi-coding-agent';
import { Text } from '@earendil-works/pi-tui';
import { getOperation, operationDefinitions, type LinearOperation } from '../operations';
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
  resultErrorMessage,
  renderTable,
  renderToolCall,
  truncate,
  wrapped,
  type ToolArgs,
} from './common';
import { specFor, specForKind, type Entity, type EntitySpec } from './entities';

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
  | { kind: 'not-found'; notes: string[] }
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
export function digestResult(result: AgentToolResult<any>, expectedRoots: readonly string[] = []): Digest {
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
  if (data && expectedRoots.some((root) => Object.prototype.hasOwnProperty.call(data, root) && data[root] === null)) {
    return { kind: 'not-found', notes };
  }
  const rootEntry = data ? Object.entries(data).find(([, value]) => asRecord(value)) : undefined;
  const root = rootEntry?.[1];
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
  if (/(?:create|update|delete|archive|unarchive)$/i.test(rootEntry?.[0] ?? '')) {
    return { kind: 'mutation', success: false, notes };
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

function entityBlock(
  theme: Theme,
  spec: EntitySpec,
  entity: Entity,
  verb: string,
  notes: string[],
): Array<string | ReturnType<typeof wrapped>> {
  const lines: Array<string | ReturnType<typeof wrapped>> = ['', statusLine(theme, spec, entity, verb)];
  const metadata = spec.metadata(entity);
  if (metadata.length) lines.push(`  ${theme.fg('dim', metadata.join(' · '))}`);
  const body = spec.body?.(entity);
  if (body) lines.push(`  ${theme.fg('muted', body)}`);
  const url = asString(entity.url);
  if (url) lines.push(`  ${theme.fg('dim', url)}`);
  for (const note of notes) lines.push(wrapped(theme.fg('dim', note), 2));
  return [...lines, '', wrapped(theme.fg('dim', jsonHint()))];
}

function pluralNoun(spec: EntitySpec): string {
  return spec.pluralNoun ?? `${spec.noun}s`;
}

function spillBlock(theme: Theme, digest: Extract<Digest, { kind: 'spill' }>): Array<string | ReturnType<typeof wrapped>> {
  const size = `${Math.max(1, Math.round(digest.bytes / 1024))} KB`;
  const lines: Array<string | ReturnType<typeof wrapped>> = [
    '',
    theme.fg('success', `✓ ${size} written to disk`),
    `  ${theme.fg('dim', digest.path)}`,
  ];
  for (const entry of digest.index.slice(0, 8)) {
    lines.push(`  ${theme.fg('muted', cleanOneLine(entry))}`);
  }
  if (digest.index.length > 8) {
    lines.push(`  ${theme.fg('dim', `… ${digest.index.length - 8} more entries in the file`)}`);
  }
  lines.push(wrapped(theme.fg('dim', 'Read the file for the full payload.'), 2));
  for (const note of digest.notes) lines.push(wrapped(theme.fg('dim', note), 2));
  return [...lines, '', wrapped(theme.fg('dim', jsonHint()))];
}

function contextArgs(context: LinearRenderContext): Record<string, unknown> {
  const args = asRecord(context.args) ?? {};
  return asRecord(args.variables) ?? args;
}

const TARGET_KEYS = [
  'issue', 'project', 'document', 'initiative', 'milestone', 'comment',
  'projectUpdate', 'initiativeUpdate', 'relation', 'id', 'identifier', 'name', 'title', 'team',
] as const;

function targetReference(result: AgentToolResult<any>, context: LinearRenderContext): string | undefined {
  const details = asRecord(result.details) ?? {};
  const target = asRecord(asRecord(details.resolution)?.target);
  const resolved = target && (
    asString(target.identifier) ?? asString(target.key) ?? asString(target.name)
    ?? asString(target.resolvedId) ?? asString(target.requested)
  );
  if (resolved) return resolved;
  const args = contextArgs(context);
  for (const key of TARGET_KEYS) {
    const value = asString(args[key]);
    if (value) return value;
  }
  return Object.values(args).map(asString).find((value): value is string => !!value);
}

function emptyState(operationName: string, spec: EntitySpec, context: LinearRenderContext): { fact: string; action: string } {
  if (operationName.startsWith('search_')) {
    return { fact: `No ${pluralNoun(spec)} matched the search.`, action: 'Change or broaden the search term.' };
  }
  if (operationName === 'list_comments') {
    return { fact: 'The target has no comments.', action: 'Check another target or add a comment.' };
  }
  if (operationName.includes('relations')) {
    return { fact: 'The target has no relations.', action: 'Check another target or relation type.' };
  }
  const routing = new Set(['after', 'first', 'workspace', 'sink']);
  const filtered = Object.keys(contextArgs(context)).some((key) => !routing.has(key));
  if (filtered) {
    return { fact: `No ${pluralNoun(spec)} matched the filters.`, action: 'Loosen or remove a filter.' };
  }
  return {
    fact: `No ${pluralNoun(spec)} exist in the selected workspace.`,
    action: 'Check another workspace or create the first record.',
  };
}

function errorRecovery(message: string, toolName: string, noun: string, rawGraphql = false): string {
  const normalized = message.toLowerCase();
  if (normalized.includes('read-only') || normalized.includes('readonly')) {
    return 'Use a read-only operation or restart through a mutation-enabled entry point.';
  }
  if (normalized.includes('destructive named input') || normalized.includes('trashed')) {
    return 'Named destructive input is unavailable. Use an authorized raw GraphQL mutation when that action is required.';
  }
  if (rawGraphql && normalized.includes('raw linear mutations')) {
    return 'Set LINEAR_MUTATIONS=all only when an authorized raw GraphQL mutation is required.';
  }
  if (normalized.includes('not allowed') || normalized.includes('blocked root') || normalized.includes('mutation root')) {
    return 'This mutation root is blocked by policy. Use a supported named operation.';
  }
  if (normalized.includes('configuration') || normalized.includes('manifest') || normalized.includes('filtered tool')) {
    return 'Check the generated tool manifest and the active tool policy, then load the operation again.';
  }
  if (normalized.includes('not found') || normalized.includes('was not found')) {
    return `Check the exact ${noun} reference and call ${toolName} again.`;
  }
  if (normalized.includes('unauthorized') || normalized.includes('authentication') || normalized.includes('api key')
    || normalized.includes('credential') || /\b(?:401|403)\b/.test(normalized)) {
    return 'Update Linear authentication with /linear-auth, then retry the request.';
  }
  if (normalized.includes('validation') || normalized.includes('invalid parameter') || normalized.includes('invalid value')
    || normalized.includes('missing ') || normalized.includes('must be') || normalized.includes('is required')
    || normalized.includes('expected type') || normalized.includes('exactly one')) {
    return `Open the ${toolName} parameter card, correct the validation error, and call ${toolName} again.`;
  }
  if (normalized.includes('network') || normalized.includes('fetch') || normalized.includes('connection')
    || normalized.includes('graphql') || normalized.includes('server') || normalized.includes('service unavailable')) {
    return 'Retry the same request. A transient network or Linear server failure can change on retry.';
  }
  return `Open the ${toolName} parameter card, correct the validation error, and call ${toolName} again.`;
}

function renderDigest(
  digest: Digest,
  result: AgentToolResult<any>,
  theme: Theme,
  spec: EntitySpec,
  verb: Verb,
  operationName: string,
  context: LinearRenderContext,
): Text | LinearBlockComponent | LinearListComponent<Entity> {
  if (digest.kind === 'spill') return new LinearBlockComponent(spillBlock(theme, digest));

  if (digest.kind === 'list') {
    const empty = emptyState(operationName, spec, context);
    return new LinearListComponent(digest.entities, theme, {
      headline: `${plural(digest.entities.length, spec.noun, spec.pluralNoun)} returned`,
      emptyLabel: empty.fact,
      emptyAction: empty.action,
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

  if (digest.kind === 'not-found') {
    const reference = targetReference(result, context);
    const title = `${spec.noun.charAt(0).toUpperCase()}${spec.noun.slice(1)} not found`;
    return new LinearBlockComponent([
      '',
      theme.fg('error', `✗ ${title}`),
      ...(reference ? [wrapped(theme.fg('accent', `Searched: ${reference}`), 2)] : []),
      wrapped(theme.fg('dim', `Check the exact ${spec.noun} reference and call the operation again.`), 2),
      ...digest.notes.map((note) => wrapped(theme.fg('dim', note), 2)),
      '',
      wrapped(theme.fg('dim', jsonHint())),
    ]);
  }

  if (digest.kind === 'mutation') {
    if (!digest.success) {
      const target = targetReference(result, context);
      return new LinearBlockComponent([
        '',
        theme.fg('warning', `! ${verb.past} ${spec.noun}${target ? ` ${target}` : ''}: status unknown`),
        wrapped(theme.fg('dim', 'Re-read the record to confirm the change.'), 2),
        '',
        wrapped(theme.fg('dim', jsonHint())),
      ]);
    }
    if (digest.entity) {
      return new LinearBlockComponent(entityBlock(theme, spec, digest.entity, verb.past, digest.notes));
    }
    const target = targetReference(result, context);
    return new LinearBlockComponent([
      '',
      theme.fg('success', `✓ ${verb.past} ${spec.noun}${target ? ` ${target}` : ''}`),
      ...digest.notes.map((note) => wrapped(theme.fg('dim', note), 2)),
      '',
      wrapped(theme.fg('dim', jsonHint())),
    ]);
  }

  const active = asString((asRecord(result.details) ?? {}).active);
  if (active) {
    return new LinearBlockComponent([
      '',
      `${theme.fg('success', `✓ ${verb.past} workspace`)} ${theme.fg('accent', active)}`,
      '',
      wrapped(theme.fg('dim', jsonHint())),
    ]);
  }

  const summary = cleanOneLine(JSON.stringify(result.details ?? {}));
  return new LinearBlockComponent([
    '',
    theme.fg('toolOutput', truncate(summary, 200)),
    '',
    wrapped(theme.fg('dim', jsonHint())),
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
  const definition = operationDefinitions.find(({ name }) => name === operation.name);
  const spec = definition ? specForKind(definition.result.renderKind) : specFor(operation.name);
  const verb = verbFor(operation.name);
  const keys = definition ? [...definition.canonical.fields.map(({ name }) => name), 'workspace'] : callKeys(operation);
  const toolName = typedToolName(operation.name);

  return {
    renderCall: (args, theme) => renderToolCall(toolName, args as ToolArgs, theme, keys),
    renderResult: (result, options, theme, context) => {
      if (options.isPartial) {
        const noun = operation.pagination ? pluralNoun(spec) : spec.noun;
        return new Text(theme.fg('warning', `${verb.present} ${noun}…`), 0, 0);
      }
      if (context.isError) {
        const message = resultErrorMessage(result);
        return renderErrorResult(result, theme, errorRecovery(message, toolName, spec.noun));
      }

      if (options.expanded) return expandedJson(result, theme);
      const roots = definition?.result.dataPaths.map((path) => path.split('.')[0]!).filter(Boolean) ?? [];
      return renderDigest(digestResult(result, roots), result, theme, spec, verb, operation.name, context);
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
  const lines: Array<string | ReturnType<typeof wrapped>> = [];

  if (Array.isArray(details.candidates)) {
    const candidates = details.candidates as Array<{ name?: string; signature?: string }>;
    lines.push(theme.fg('warning', `No tool loaded for "${asString(details.query) ?? ''}"`));
    lines.push(wrapped(theme.fg('dim', 'Name one operation, or pick a candidate below.'), 2));
    if (candidates.length) lines.push('');
    for (const candidate of candidates.slice(0, PREVIEW_LIMIT)) {
      lines.push(wrapped(theme.fg('muted', candidate.signature ?? candidate.name ?? ''), 2));
    }
    if (candidates.length > PREVIEW_LIMIT) {
      lines.push(`  ${theme.fg('dim', `… ${candidates.length - PREVIEW_LIMIT} more in the JSON`)}`);
    }
  } else if (Array.isArray(details.domains)) {
    lines.push(theme.fg('success', `✓ ${details.domains.length} domains`));
    lines.push(wrapped(theme.fg('muted', details.domains.join('  ')), 2));
    lines.push(wrapped(theme.fg('dim', 'Ask for one operation to load its typed tool.'), 2));
  } else if (Array.isArray(details.operations)) {
    const operations = details.operations as Array<{ name?: string; signature?: string }>;
    lines.push(theme.fg('success', `✓ ${plural(operations.length, 'operation')} in ${asString(details.domain) ?? 'domain'}`));
    lines.push('');
    for (const operation of operations.slice(0, PREVIEW_LIMIT)) {
      lines.push(wrapped(theme.fg('muted', operation.signature ?? operation.name ?? ''), 2));
    }
  } else if (asRecord(details.match)) {
    const match = asRecord(details.match)!;
    lines.push(theme.fg('success', `✓ ${asString(match.name) ?? 'match'}`));
    lines.push(wrapped(theme.fg('muted', asString(match.signature) ?? ''), 2));
    if (asString(match.purpose)) lines.push(wrapped(theme.fg('dim', asString(match.purpose)!), 2));
    const alternatives = Array.isArray(details.alternatives) ? details.alternatives : [];
    if (alternatives.length) lines.push('', theme.fg('muted', 'Alternatives'));
    for (const alternative of alternatives.slice(0, PREVIEW_LIMIT) as Array<{ signature?: string }>) {
      if (alternative.signature) lines.push(wrapped(theme.fg('dim', alternative.signature), 2));
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
      lines.push(wrapped(`${theme.fg('muted', label)}${theme.fg('dim', parameter.type)}`, 2));
    }
  } else {
    return undefined;
  }

  if (loaded.length) {
    lines.push('');
    lines.push(wrapped(theme.fg('success', `✓ loaded ${plural(loaded.length, 'tool')}`), 2));
    lines.push(wrapped(theme.fg('dim', loaded.join(', ')), 2));
  }
  lines.push('');
  lines.push(wrapped(theme.fg('dim', jsonHint())));
  return new LinearBlockComponent(['', ...lines]);
}

function rawGraphqlBlock(theme: Theme, result: AgentToolResult<any>, notes: string[]): LinearBlockComponent {
  const data = asRecord((asRecord(result.details) ?? {}).data) ?? {};
  const keys = Object.keys(data);
  const lines: Array<string | ReturnType<typeof wrapped>> = [
    '',
    theme.fg('success', '✓ GraphQL response'),
    wrapped(theme.fg('muted', `Keys: ${keys.length ? keys.join(', ') : '(none)'}`), 2),
  ];
  for (const [key, value] of Object.entries(data)) {
    const record = asRecord(value);
    const nodes = record && Array.isArray(record.nodes) ? record.nodes : undefined;
    if (nodes && record) {
      const pageInfo = asRecord(record.pageInfo);
      const cursor = pageInfo?.hasNextPage === true ? asString(pageInfo.endCursor) : undefined;
      const paging = cursor ? ` · next page after="${cursor}"` : '';
      lines.push(wrapped(theme.fg('toolOutput', `${key}: connection · ${plural(nodes.length, 'node')}${paging}`), 2));
    } else if (Array.isArray(value)) {
      lines.push(wrapped(theme.fg('toolOutput', `${key}: array · ${plural(value.length, 'item')}`), 2));
    } else if (record) {
      const childKeys = Object.keys(record);
      lines.push(wrapped(theme.fg('toolOutput', `${key}: object · ${plural(childKeys.length, 'key')}${childKeys.length ? ` (${childKeys.join(', ')})` : ''}`), 2));
    } else {
      const shape = value === null ? 'null' : typeof value;
      lines.push(wrapped(theme.fg('toolOutput', `${key}: ${shape}${typeof value === 'string' ? ` · ${value.length} chars` : ''}`), 2));
    }
  }
  for (const note of notes) lines.push(wrapped(theme.fg('dim', note), 2));
  return new LinearBlockComponent([...lines, '', wrapped(theme.fg('dim', jsonHint()))]);
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
    const message = resultErrorMessage(result);
    let recovery = errorRecovery(
      message,
      API_TOOL,
      operation ? spec.noun : 'operation',
      !operation && !!asString(args.query),
    );
    if (operation && recovery.startsWith(`Open the ${API_TOOL} parameter card`)) {
      recovery = `Send { "operation": "help", "variables": { "operation": "${operation.name}" } } for the parameter card.`;
    }
    return renderErrorResult(result, theme, recovery);
  }
  if (options.expanded) return expandedJson(result, theme);

  const help = helpBlock(theme, asRecord(result.details) ?? {});
  if (help) return help;

  const definition = operation
    ? operationDefinitions.find(({ name }) => name === operation.name)
    : undefined;
  const roots = definition?.result.dataPaths.map((path) => path.split('.')[0]!).filter(Boolean) ?? [];
  const digest = digestResult(result, roots);
  if (!operation && asString(args.operation) !== 'help' && digest.kind !== 'spill') {
    return rawGraphqlBlock(theme, result, digest.notes);
  }
  return renderDigest(digest, result, theme, spec, verb, operation?.name ?? 'raw_graphql', context);
}
