import type {
  AgentToolResult,
  Theme,
  ToolRenderResultOptions,
} from '@earendil-works/pi-coding-agent';
import { Text } from '@earendil-works/pi-tui';
import { operationDefinitions, type LinearOperation } from '../operations';
import { canonicalFieldNames } from '../canonical';
import { typedToolName } from '../tool-names';
import type { OperationDefinition } from '../operation-types';
import type { JsonObject } from '../runtime';
import {
  asRecord,
  LinearBlockComponent,
  asString,
  cleanOneLine,
  detailLine,
  expandedJson,
  scrubCredentials,
  jsonHint,
  LinearListComponent,
  shouldShowJson,
  plural,
  renderErrorResult,
  resultErrorMessage,
  renderTable,
  renderToolCall,
  truncate,
  wrapped,
  type ToolArgs,
  type JsonRecord,
  type JsonValue,
} from './common';
import {
  parseResultDetails,
  type HelpResultDetails,
  type NamedResultDetails,
  type RawCompleteDetails,
  type SpillResultDetails,
} from './details';
import { specFor, specForKind, type Entity, type EntitySpec } from './entities';

const PREVIEW_LIMIT = 20;
export const SUMMARY_VIEW_NOTICE = 'Fields narrowed — use view="full" for complete fields.';

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

function listCountHeadline(
  shown: number,
  totalCount: number | undefined,
  noun: string,
  pluralNoun: string | undefined,
  summary: boolean,
): string {
  const count = totalCount !== undefined && shown < totalCount
    ? `showing ${shown} of ${totalCount}, more available`
    : `${plural(shown, noun, pluralNoun)} returned`;
  return summary ? `${count} · summary view` : count;
}

type Verb = { past: string; present: string };
type EmptyState = { fact: string; action: string };

function verbFor(operationName: string): Verb {
  if (operationName.startsWith('create_')) return { past: 'Created', present: 'Creating' };
  if (operationName.startsWith('update_') || operationName.startsWith('set_')) {
    return { past: 'Updated', present: 'Updating' };
  }
  if (operationName.startsWith('save_')) return { past: 'Saved', present: 'Saving' };
  if (operationName.startsWith('delete_')) return { past: 'Deleted', present: 'Deleting' };
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
  notes: readonly string[],
  disclosure?: string,
): Array<string | ReturnType<typeof wrapped>> {
  const lines: Array<string | ReturnType<typeof wrapped>> = ['', statusLine(theme, spec, entity, verb)];
  if (disclosure) lines.push(wrapped(theme.fg('dim', disclosure), 2));
  if (spec.details?.length) {
    for (const field of spec.details) {
      const value = field.value(entity);
      if (!value && field.optional) continue;
      const display = value ?? '—';
      const style = field.style?.(theme, display, entity);
      lines.push(detailLine(theme, field.label, display, style));
    }
  } else {
    const metadata = spec.metadata(entity);
    if (metadata.length) lines.push(`  ${theme.fg('dim', metadata.join(' · '))}`);
    const body = spec.body?.(entity);
    if (body) lines.push(`  ${theme.fg('muted', body)}`);
  }
  const url = asString(entity.url);
  if (url) lines.push(`  ${theme.fg('dim', url)}`);
  for (const note of notes) lines.push(wrapped(theme.fg('dim', note), 2));
  return [...lines, '', wrapped(theme.fg('dim', jsonHint()))];
}

function pluralNoun(spec: EntitySpec): string {
  return spec.pluralNoun ?? `${spec.noun}s`;
}

function spillBlock(theme: Theme, details: SpillResultDetails): Array<string | ReturnType<typeof wrapped>> {
  const size = `${Math.max(1, Math.round(details.bytes / 1024))} KB`;
  const lines: Array<string | ReturnType<typeof wrapped>> = [
    '',
    theme.fg('success', `✓ ${size} written to disk`),
    wrapped(theme.fg('dim', details.handle
      ? `Retrieve: linear_get_result({"handle":"${details.handle}"})`
      : 'This legacy artifact has no result handle.'), 2),
    `  ${theme.fg('dim', `Compatibility path: ${details.path}`)}`,
  ];
  for (const entry of details.index.slice(0, 8)) {
    lines.push(`  ${theme.fg('muted', cleanOneLine(entry))}`);
  }
  if (details.index.length > 8) {
    lines.push(`  ${theme.fg('dim', `… ${details.index.length - 8} more entries in the file`)}`);
  }
  for (const note of details.notes) lines.push(wrapped(theme.fg('dim', note), 2));
  return [...lines, '', wrapped(theme.fg('dim', jsonHint()))];
}

function contextArgs(context: LinearRenderContext): JsonRecord {
  const args = asRecord(context.args as JsonObject) ?? {};
  return asRecord(args.variables) ?? args;
}

function operationTargetFields(definition: OperationDefinition): readonly string[] {
  if (definition.render.targetFields) return definition.render.targetFields;
  const branches = definition.canonical.branches;
  const common = branches[0]?.all.filter((field) => branches.every((branch) => branch.all.includes(field))) ?? [];
  const references = common.filter((field) => {
    const type = definition.canonical.fields.find(({ name }) => name === field)?.type;
    return field === 'id' || field === definition.render.entityKind || field.endsWith('Id') || type?.includes('Reference');
  });
  if (references.length) return references;
  return common.filter((field) => field === 'name' || field === 'title').slice(0, 1);
}

function argumentTarget(
  context: LinearRenderContext,
  definition: OperationDefinition,
): string | undefined {
  const args = contextArgs(context);
  for (const key of operationTargetFields(definition)) {
    const value = asString(args[key]);
    if (value) return value;
  }
  return undefined;
}

function namedTarget(
  target: string | undefined,
  context: LinearRenderContext,
  definition: OperationDefinition,
): string | undefined {
  return target ?? argumentTarget(context, definition);
}

function emptyState(
  definition: OperationDefinition,
  spec: EntitySpec,
  context: LinearRenderContext,
): EmptyState {
  const metadata = definition.render;
  const routing = new Set([
    'after', 'before', 'first', 'last', 'workspace', 'sink', 'view', ...operationTargetFields(definition),
  ]);
  const filtered = Object.keys(contextArgs(context)).some((key) => !routing.has(key));
  if (metadata.empty) {
    return filtered
      ? { fact: metadata.empty.filteredFact, action: metadata.empty.filteredAction }
      : { fact: metadata.empty.fact, action: metadata.empty.action };
  }
  return {
    fact: `No ${pluralNoun(spec)} matched this request.`,
    action: 'Adjust the request or check another workspace.',
  };
}

function errorRecovery(message: string, toolName: string, noun: string, rawGraphql = false): string {
  const normalized = message.toLowerCase();
  const httpFailure = /^linear api request failed:\s*(?:(\d{3})\b)?/i.exec(message);
  if (httpFailure?.[1]) {
    const status = Number(httpFailure[1]);
    if (status === 401 || status === 403) {
      return 'Update Linear authentication with /linear-auth, then retry the request.';
    }
    if (status === 408 || status === 429 || (status >= 500 && status <= 599)) {
      return 'Retry the same request. A transient network or Linear server failure can change on retry.';
    }
    return 'Review the request and Linear server response before trying a corrected request.';
  }
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
  if (normalized.includes('unknown parameters')) {
    return `Remove the unaccepted parameters and call ${toolName} again with the accepted ones only.`;
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
    || normalized.includes('expected type') || normalized.includes('exactly one')
    || normalized.includes('was not provided') || normalized.includes('cannot query field')) {
    return `Open the ${toolName} parameter card, correct the validation error, and call ${toolName} again.`;
  }
  if (normalized.includes('network') || normalized.includes('fetch') || normalized.includes('connection')
    || normalized.includes('server') || normalized.includes('service unavailable')
    || normalized.includes('timeout') || normalized.includes('timed out') || normalized.includes('rate limit')
    || normalized.includes('rate-limit') || normalized.includes('too many requests') || normalized.includes('gateway')) {
    return 'Retry the same request. A transient network or Linear server failure can change on retry.';
  }
  if (httpFailure || normalized.includes('graphql')) {
    return 'Review the request and Linear server response before trying a corrected request.';
  }
  return `Open the ${toolName} parameter card, correct the validation error, and call ${toolName} again.`;
}

function renderDigest(
  details: NamedResultDetails,
  theme: Theme,
  spec: EntitySpec,
  verb: Verb,
  definition: OperationDefinition,
  context: LinearRenderContext,
): Text | LinearBlockComponent | LinearListComponent<Entity> {
  if (details.kind === 'spill') return new LinearBlockComponent(spillBlock(theme, details));

  if (details.kind === 'list') {
    const empty = emptyState(definition, spec, context);
    const summaryList = details.view === 'summary' && details.entities.length > 0;
    return new LinearListComponent([...details.entities], theme, {
      headline: listCountHeadline(
        details.entities.length,
        details.totalCount,
        spec.noun,
        spec.pluralNoun,
        summaryList,
      ),
      disclosure: summaryList ? SUMMARY_VIEW_NOTICE : undefined,
      emptyLabel: empty.fact,
      emptyAction: empty.action,
      footnotes: [...details.notes],
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

  if (details.kind === 'entity') {
    const disclosure = details.view === 'summary' ? SUMMARY_VIEW_NOTICE : undefined;
    return new LinearBlockComponent(entityBlock(theme, spec, details.entity, verb.past, details.notes, disclosure));
  }

  if (details.kind === 'not-found') {
    const reference = namedTarget(details.target, context, definition);
    const title = `${spec.noun.charAt(0).toUpperCase()}${spec.noun.slice(1)} not found`;
    return new LinearBlockComponent([
      '',
      theme.fg('error', `✗ ${title}`),
      ...(reference ? [wrapped(theme.fg('accent', `Searched: ${reference}`), 2)] : []),
      wrapped(theme.fg('dim', `Check the exact ${spec.noun} reference and call the operation again.`), 2),
      ...details.notes.map((note) => wrapped(theme.fg('dim', note), 2)),
      '',
      wrapped(theme.fg('dim', jsonHint())),
    ]);
  }

  if (details.kind === 'mutation') {
    if (!details.success) {
      const target = namedTarget(details.target, context, definition);
      return new LinearBlockComponent([
        '',
        theme.fg('warning', `! ${verb.past} ${spec.noun}${target ? ` ${target}` : ''}: status unknown`),
        wrapped(theme.fg('dim', 'Re-read the record to confirm the change.'), 2),
        '',
        wrapped(theme.fg('dim', jsonHint())),
      ]);
    }
    if (details.entity) {
      return new LinearBlockComponent(entityBlock(theme, spec, details.entity, verb.past, details.notes));
    }
    const target = namedTarget(details.target, context, definition);
    return new LinearBlockComponent([
      '',
      theme.fg('success', `✓ ${verb.past} ${spec.noun}${target ? ` ${target}` : ''}`),
      ...details.notes.map((note) => wrapped(theme.fg('dim', note), 2)),
      '',
      wrapped(theme.fg('dim', jsonHint())),
    ]);
  }

  if (details.kind === 'workspace') {
    return new LinearBlockComponent([
      '',
      `${theme.fg('success', `✓ ${verb.past} workspace`)} ${theme.fg('accent', details.active)}`,
      '',
      wrapped(theme.fg('dim', jsonHint())),
    ]);
  }

  return new LinearBlockComponent([
    '',
    theme.fg('toolOutput', truncate(details.summary, 200)),
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
    result: AgentToolResult<JsonObject>,
    options: ToolRenderResultOptions,
    theme: Theme,
    context: LinearRenderContext,
  ) => Text | LinearBlockComponent | LinearListComponent<Entity>;
  /**
   * The recovery sentence for one failure, exposed so the thrown message can carry it.
   * `renderResult` reaches only the human; a caller that must correct the call reads the
   * error text, so the guidance has to travel with the message rather than the display.
   */
  guidance: (message: string) => string;
};

/** Renderers for one typed tool, derived from the catalog entry. */
export function operationRenderers(operation: LinearOperation): OperationRenderers {
  const definition = operationDefinitions.find(({ name }) => name === operation.name);
  const spec = definition ? specForKind(definition.result.renderKind) : specFor(operation.name);
  const verb = verbFor(operation.name);
  const keys = definition ? [...definition.canonical.fields.map(({ name }) => name), 'workspace'] : callKeys(operation);
  const toolName = typedToolName(operation.name);

  const guidance = (message: string): string => errorRecovery(message, toolName, spec.noun);

  return {
    guidance,
    renderCall: (args, theme) => renderToolCall(toolName, args as ToolArgs, theme, keys),
    renderResult: (result, options, theme, context) => {
      if (options.isPartial) {
        const noun = operation.pagination ? pluralNoun(spec) : spec.noun;
        return new Text(theme.fg('warning', `${verb.present} ${noun}…`), 0, 0);
      }
      if (context.isError) {
        return renderErrorResult(result, theme, guidance(resultErrorMessage(result)));
      }

      if (shouldShowJson(options, context)) return expandedJson(result, theme);
      const roots = definition?.result.dataPaths.map((path) => path.split('.')[0]!).filter(Boolean) ?? [];
      return renderDigest(
        parseResultDetails(result.details, { kind: 'named', expectedRoots: roots }),
        theme,
        spec,
        verb,
        definition!,
        context,
      );
    },
  };
}

// ---------------------------------------------------------------------------
// linear: discovery only.
// ---------------------------------------------------------------------------

const API_TOOL = 'linear';

export function renderLinearApiCall(args: any, theme: Theme): LinearBlockComponent {
  const variables = asRecord(asRecord(args)?.variables) ?? {};
  const target = asString(variables.operation) ?? asString(variables.domain);
  return new LinearBlockComponent([
    target
      ? `${theme.fg('toolTitle', theme.bold(API_TOOL))} ${theme.fg('dim', 'help:')} ${theme.fg('accent', scrubCredentials(target))}`
      : `${theme.fg('toolTitle', theme.bold(API_TOOL))} ${theme.fg('accent', 'catalog')}`,
  ]);
}

function helpBlock(theme: Theme, details: HelpResultDetails): LinearBlockComponent | undefined {
  if (details.kind === 'unknown') return undefined;
  const lines: Array<string | ReturnType<typeof wrapped>> = [];

  if (details.kind === 'help-domains') {
    lines.push(theme.fg('success', `✓ ${details.domains.length} domains`));
    lines.push(wrapped(theme.fg('muted', details.domains.join('  ')), 2));
    lines.push(wrapped(theme.fg('dim', 'Ask for one operation to load its typed tool.'), 2));
  } else if (details.kind === 'help-operations') {
    lines.push(theme.fg('success', `✓ ${plural(details.operations.length, 'operation')} in ${details.domain ?? 'domain'}`));
    lines.push('');
    for (const operation of details.operations.slice(0, PREVIEW_LIMIT)) {
      lines.push(wrapped(theme.fg('muted', operation.signature ?? operation.name ?? ''), 2));
    }
  } else {
    lines.push(theme.fg('success', `✓ ${details.name}`));
    if (details.purpose) lines.push(`  ${theme.fg('dim', details.purpose)}`);
    lines.push('');
    for (const parameter of details.parameters) {
      const label = `${parameter.name}${parameter.required ? '' : '?'}`.padEnd(24);
      lines.push(wrapped(`${theme.fg('muted', label)}${theme.fg('dim', parameter.type)}`, 2));
    }
  }

  if (details.loaded.length) {
    lines.push('');
    lines.push(wrapped(theme.fg('success', `✓ loaded ${plural(details.loaded.length, 'tool')}`), 2));
    lines.push(wrapped(theme.fg('dim', details.loaded.join(', ')), 2));
  }
  lines.push('');
  lines.push(wrapped(theme.fg('dim', jsonHint())));
  return new LinearBlockComponent(['', ...lines]);
}

function rawGraphqlBlock(theme: Theme, details: RawCompleteDetails): LinearBlockComponent {
  const lines: Array<string | ReturnType<typeof wrapped>> = [
    '',
    theme.fg('success', '✓ GraphQL response'),
    wrapped(theme.fg('muted', `Keys: ${details.keys.length ? details.keys.join(', ') : '(none)'}`), 2),
  ];
  for (const field of details.fields) {
    if (field.kind === 'connection') {
      const paging = field.nextCursor ? ` · next page after="${field.nextCursor}"` : '';
      lines.push(wrapped(theme.fg('toolOutput', `${field.key}: connection · ${plural(field.nodeCount, 'node')}${paging}`), 2));
    } else if (field.kind === 'array') {
      lines.push(wrapped(theme.fg('toolOutput', `${field.key}: array · ${plural(field.itemCount, 'item')}`), 2));
    } else if (field.kind === 'object') {
      const childKeys = field.keys;
      lines.push(wrapped(theme.fg('toolOutput', `${field.key}: object · ${plural(childKeys.length, 'key')}${childKeys.length ? ` (${childKeys.join(', ')})` : ''}`), 2));
    } else {
      lines.push(wrapped(theme.fg('toolOutput', `${field.key}: ${field.valueKind}${field.charCount !== undefined ? ` · ${field.charCount} chars` : ''}`), 2));
    }
  }
  for (const note of details.notes) lines.push(wrapped(theme.fg('dim', note), 2));
  return new LinearBlockComponent([...lines, '', wrapped(theme.fg('dim', jsonHint()))]);
}

function batchOperations(value: JsonValue | undefined): string {
  if (!Array.isArray(value)) return '(none)';
  const names = value.map((entry) => asString(asRecord(entry)?.operation)).filter((name): name is string => !!name);
  return names.length ? names.join(', ') : '(none)';
}

export function renderLinearBatchCall(args: any, theme: Theme): LinearBlockComponent {
  const params = asRecord(args) ?? {};
  const flat = Array.isArray(params.operations);
  const lines = [
    `${theme.fg('toolTitle', theme.bold('linear_batch'))} ${theme.fg('accent', flat ? 'flat' : 'phased')}`,
  ];
  if (flat) lines.push(theme.fg('dim', `  operations: ${batchOperations(params.operations)}`));
  else {
    if (Array.isArray(params.reads)) lines.push(theme.fg('dim', `  reads: ${batchOperations(params.reads)}`));
    if (Array.isArray(params.mutations)) lines.push(theme.fg('dim', `  mutations: ${batchOperations(params.mutations)}`));
  }
  return new LinearBlockComponent(lines);
}

export function renderLinearBatchResult(
  result: AgentToolResult<JsonObject>,
  options: ToolRenderResultOptions,
  theme: Theme,
  context: LinearRenderContext,
): Text | LinearBlockComponent {
  if (options.isPartial) return new Text(theme.fg('warning', 'Running batch…'), 0, 0);
  if (context.isError) {
    const message = resultErrorMessage(result);
    let recovery = errorRecovery(message, 'linear_batch', 'batch');
    if (!recovery.includes('linear_batch')) recovery = `${recovery} Then call linear_batch again.`;
    return renderErrorResult(result, theme, recovery);
  }
  if (shouldShowJson(options, context)) return expandedJson(result, theme);

  const details = parseResultDetails(result.details, { kind: 'batch' });
  if (details.kind === 'spill') return new LinearBlockComponent(spillBlock(theme, details));
  const labels = (label: string, keys: readonly string[]) => `${label}: ${keys.length ? keys.join(', ') : '(none)'}`;
  return new LinearBlockComponent([
    '',
    theme.fg('success', '✓ Batch complete'),
    wrapped(theme.fg('success', labels('Completed', details.completed)), 2),
    wrapped(theme.fg('error', labels('Failed', details.failed)), 2),
    wrapped(theme.fg('warning', labels('Skipped', details.skipped)), 2),
    wrapped(theme.fg('dim', `Requests: ${details.readRequests} read, ${details.mutationRequests} mutation`), 2),
    '',
    wrapped(theme.fg('dim', jsonHint())),
  ]);
}

export function renderLinearGetResultCall(args: any, theme: Theme): LinearBlockComponent {
  return renderToolCall('linear_get_result', (args ?? {}) as ToolArgs, theme, ['handle', 'path', 'offset']);
}

export function renderLinearGraphqlCall(args: any, theme: Theme): LinearBlockComponent {
  return renderToolCall('linear_graphql', (args ?? {}) as ToolArgs, theme, ['workspace', 'sink']);
}

export function renderLinearGetResultResult(
  result: AgentToolResult<JsonObject>,
  options: ToolRenderResultOptions,
  theme: Theme,
  context: LinearRenderContext,
): Text | LinearBlockComponent {
  if (options.isPartial) return new Text(theme.fg('warning', 'Retrieving stored result…'), 0, 0);
  if (context.isError) {
    return renderErrorResult(result, theme, 'Check the result handle, JSON Pointer, and offset, then call linear_get_result again.');
  }
  if (shouldShowJson(options, context)) return expandedJson(result, theme);

  const details = parseResultDetails(result.details, { kind: 'retrieval' });
  const lines: Array<string | ReturnType<typeof wrapped>> = [
    '',
    theme.fg('success', details.complete ? '✓ Stored result complete' : '✓ Stored result segment'),
  ];
  if (details.range) {
    lines.push(wrapped(theme.fg('dim', `Range: ${details.range.start ?? '?'}–${details.range.end ?? '?'} of ${details.range.total ?? '?'} ${details.range.unit}`), 2));
  }
  if (details.nextOffset !== undefined) {
    lines.push(wrapped(theme.fg('dim', `Next offset: ${details.nextOffset}`), 2));
  }
  lines.push(wrapped(theme.fg('toolOutput', JSON.stringify(details.value)), 2));
  lines.push('', wrapped(theme.fg('dim', jsonHint())));
  return new LinearBlockComponent(lines);
}

export function renderLinearGraphqlResult(
  result: AgentToolResult<JsonObject>,
  options: ToolRenderResultOptions,
  theme: Theme,
  context: LinearRenderContext,
): Text | LinearBlockComponent | LinearListComponent<Entity> {
  if (options.isPartial) return new Text(theme.fg('warning', 'Running request…'), 0, 0);
  if (context.isError) {
    const message = resultErrorMessage(result);
    let recovery = errorRecovery(message, 'linear_graphql', 'operation', true);
    if (!recovery.includes('linear_graphql')) recovery = `${recovery} Then call linear_graphql again.`;
    return renderErrorResult(result, theme, recovery);
  }
  if (shouldShowJson(options, context)) return expandedJson(result, theme);
  const details = parseResultDetails(result.details, { kind: 'raw' });
  if (details.kind === 'spill') return new LinearBlockComponent(spillBlock(theme, details));
  return rawGraphqlBlock(theme, details);
}

export function renderLinearApiResult(
  result: AgentToolResult<JsonObject>,
  options: ToolRenderResultOptions,
  theme: Theme,
  context: LinearRenderContext,
): Text | LinearBlockComponent {
  if (options.isPartial) return new Text(theme.fg('warning', 'Loading Linear help…'), 0, 0);
  if (context.isError) {
    return renderErrorResult(result, theme, 'Send { "operation": "help" } or request exact domain or operation help.');
  }
  if (shouldShowJson(options, context)) return expandedJson(result, theme);
  return helpBlock(theme, parseResultDetails(result.details, { kind: 'help' })) ?? expandedJson(result, theme);
}
