import type {
  AgentToolResult,
  Theme,
  ToolRenderResultOptions,
} from '@earendil-works/pi-coding-agent';
import { Text } from '@earendil-works/pi-tui';
import { operationDefinitions, type LinearOperation } from '../operations';
import { canonicalFieldNames } from '../canonical';
import type { JsonValue as ParsedJsonValue } from '../json';
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
  type EntityResultDetails,
  type HelpResultDetails,
  type ListResultDetails,
  type MutationResultDetails,
  type NamedResultDetails,
  type NotFoundResultDetails,
  type RawCompleteDetails,
  type RawField,
  type RetrievalResultDetails,
  type SpillResultDetails,
  type UnknownResultDetails,
  type WorkspaceResultDetails,
} from './details';
import { specFor, specForKind, type Entity, type EntitySpec } from './entities';

const PREVIEW_LIMIT = 20;
export const SUMMARY_VIEW_NOTICE = 'Fields narrowed — use view="full" for complete fields.';
type BlockLine = string | ReturnType<typeof wrapped>;

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

const DEFAULT_VERB: Verb = { past: 'Loaded', present: 'Loading' };
const VERB_RULES: readonly { prefixes: readonly string[]; verb: Verb }[] = [
  { prefixes: ['create_'], verb: { past: 'Created', present: 'Creating' } },
  { prefixes: ['update_', 'set_'], verb: { past: 'Updated', present: 'Updating' } },
  { prefixes: ['save_'], verb: { past: 'Saved', present: 'Saving' } },
  { prefixes: ['delete_'], verb: { past: 'Deleted', present: 'Deleting' } },
  { prefixes: ['switch_'], verb: { past: 'Switched', present: 'Switching' } },
  { prefixes: ['search_'], verb: { past: 'Searched', present: 'Searching' } },
];

function verbFor(operationName: string): Verb {
  return VERB_RULES.find(({ prefixes }) => prefixes.some((prefix) => operationName.startsWith(prefix)))?.verb
    ?? DEFAULT_VERB;
}

/**
 * The status line: outcome, identifier, name — in that order, on one row.
 * Everything else is one dim line below it.
 */
function statusLine(
  theme: Theme,
  spec: EntitySpec,
  entity: Entity,
  verb: string,
  warning = false,
): string {
  const lead = spec.lead?.(entity);
  const parts = [
    theme.fg(warning ? 'warning' : 'success', `${warning ? '!' : '✓'} ${verb}${warning ? ' with warnings' : ''}`),
    lead ? theme.fg('accent', lead) : undefined,
    theme.fg('toolOutput', spec.label(entity)),
  ].filter((part): part is string => !!part);
  return parts.join(' ');
}

function configuredEntityDetails(theme: Theme, spec: EntitySpec, entity: Entity): BlockLine[] {
  const lines: BlockLine[] = [];
  for (const field of spec.details ?? []) {
    const value = field.value(entity);
    if (field.optional && !value) continue;
    const display = value ?? '—';
    const style = field.style?.(theme, display, entity);
    lines.push(detailLine(theme, field.label, display, style));
  }
  return lines;
}

function fallbackEntityDetails(theme: Theme, spec: EntitySpec, entity: Entity): BlockLine[] {
  const lines: BlockLine[] = [];
  const metadata = spec.metadata(entity);
  if (metadata.length) lines.push(`  ${theme.fg('dim', metadata.join(' · '))}`);
  const body = spec.body?.(entity);
  if (body) lines.push(`  ${theme.fg('muted', body)}`);
  return lines;
}

function entityDetails(theme: Theme, spec: EntitySpec, entity: Entity): BlockLine[] {
  return spec.details?.length
    ? configuredEntityDetails(theme, spec, entity)
    : fallbackEntityDetails(theme, spec, entity);
}

function entityBlock(
  theme: Theme,
  spec: EntitySpec,
  entity: Entity,
  verb: string,
  notes: readonly string[],
  disclosure?: string,
  warnings: readonly string[] = [],
): BlockLine[] {
  const url = asString(entity.url);
  return [
    '',
    statusLine(theme, spec, entity, verb, warnings.length > 0),
    ...(disclosure ? [wrapped(theme.fg('dim', disclosure), 2)] : []),
    ...entityDetails(theme, spec, entity),
    ...(url ? [`  ${theme.fg('dim', url)}`] : []),
    ...warnings.map((warning) => wrapped(theme.fg('warning', warning), 2)),
    ...notes.map((note) => wrapped(theme.fg('dim', note), 2)),
    '',
    wrapped(theme.fg('dim', jsonHint())),
  ];
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
  const references = common.filter((field) => (
    field === 'id' || field === definition.render.entityKind || field.endsWith('Id')
  ));
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

const AUTH_RECOVERY = 'Update Linear authentication with /linear-auth, then retry the request.';
const RETRY_RECOVERY = 'Retry the same request. A transient network or Linear server failure can change on retry.';
const REVIEW_RECOVERY = 'Review the request and Linear server response before trying a corrected request.';
const HTTP_FAILURE = /^linear api request failed:\s*(?:(\d{3})\b)?/i;
const AUTH_HTTP_STATUSES = new Set([401, 403]);
const RETRY_HTTP_STATUSES = new Set([408, 429]);

type RecoveryText = (toolName: string, noun: string) => string;
type RecoveryRule = {
  phrases: readonly string[];
  pattern?: RegExp;
  rawGraphqlOnly?: boolean;
  recovery: RecoveryText;
};

function constantRecovery(message: string): RecoveryText {
  return () => message;
}

function unknownParametersRecovery(toolName: string): string {
  return `Remove the unaccepted parameters and call ${toolName} again with the accepted ones only.`;
}

function notFoundRecovery(toolName: string, noun: string): string {
  return `Check the exact ${noun} reference and call ${toolName} again.`;
}

function validationRecovery(toolName: string): string {
  return `Open the ${toolName} parameter card, correct the validation error, and call ${toolName} again.`;
}

const ERROR_RECOVERY_RULES: readonly RecoveryRule[] = [
  {
    phrases: ['read-only', 'readonly'],
    recovery: constantRecovery('Use a read-only operation or restart through a mutation-enabled entry point.'),
  },
  {
    phrases: ['destructive named input', 'trashed'],
    recovery: constantRecovery('Named destructive input is unavailable. Use an authorized raw GraphQL mutation when that action is required.'),
  },
  {
    phrases: ['raw linear mutations'],
    rawGraphqlOnly: true,
    recovery: constantRecovery('Set LINEAR_MUTATIONS=all only when an authorized raw GraphQL mutation is required.'),
  },
  {
    phrases: ['not allowed', 'blocked root', 'mutation root'],
    recovery: constantRecovery('This mutation root is blocked by policy. Use a supported named operation.'),
  },
  {
    phrases: ['configuration', 'manifest', 'filtered tool'],
    recovery: constantRecovery('Check the generated tool manifest and the active tool policy, then load the operation again.'),
  },
  { phrases: ['unknown parameters'], recovery: unknownParametersRecovery },
  { phrases: ['not found'], recovery: notFoundRecovery },
  {
    phrases: ['unauthorized', 'authentication', 'api key', 'credential'],
    pattern: /\b(?:401|403)\b/,
    recovery: constantRecovery(AUTH_RECOVERY),
  },
  {
    phrases: [
      'validation',
      'invalid parameter',
      'invalid value',
      'not a valid',
      'missing ',
      'must be',
      'is required',
      'expected type',
      'exactly one',
      'was not provided',
      'cannot query field',
    ],
    recovery: validationRecovery,
  },
  {
    phrases: [
      'network',
      'fetch',
      'connection',
      'server',
      'service unavailable',
      'timeout',
      'timed out',
      'rate limit',
      'rate-limit',
      'too many requests',
      'gateway',
    ],
    recovery: constantRecovery(RETRY_RECOVERY),
  },
  { phrases: ['graphql'], pattern: HTTP_FAILURE, recovery: constantRecovery(REVIEW_RECOVERY) },
];

function isRetryableHttpStatus(status: number): boolean {
  return RETRY_HTTP_STATUSES.has(status) || (status >= 500 && status <= 599);
}

function recoveryForHttpStatus(status: number): string {
  if (AUTH_HTTP_STATUSES.has(status)) return AUTH_RECOVERY;
  if (isRetryableHttpStatus(status)) return RETRY_RECOVERY;
  return REVIEW_RECOVERY;
}

function httpStatusRecovery(message: string): string | undefined {
  const status = HTTP_FAILURE.exec(message)?.[1];
  if (status === undefined) return undefined;
  return recoveryForHttpStatus(Number(status));
}

function ruleMatches(rule: RecoveryRule, normalized: string, rawGraphql: boolean): boolean {
  if (rule.rawGraphqlOnly && !rawGraphql) return false;
  if (rule.phrases.some((phrase) => normalized.includes(phrase))) return true;
  return rule.pattern?.test(normalized) ?? false;
}

function textRecovery(normalized: string, toolName: string, noun: string, rawGraphql: boolean): string {
  const recovery = ERROR_RECOVERY_RULES.find((rule) => ruleMatches(rule, normalized, rawGraphql))?.recovery
    ?? validationRecovery;
  return recovery(toolName, noun);
}

function errorRecovery(message: string, toolName: string, noun: string, rawGraphql = false): string {
  return httpStatusRecovery(message) ?? textRecovery(message.toLowerCase(), toolName, noun, rawGraphql);
}

function renderListDigest(
  details: ListResultDetails,
  theme: Theme,
  spec: EntitySpec,
  definition: OperationDefinition,
  context: LinearRenderContext,
): LinearListComponent<Entity> {
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

function renderEntityDigest(
  details: EntityResultDetails,
  theme: Theme,
  spec: EntitySpec,
  verb: Verb,
): LinearBlockComponent {
  const disclosure = details.view === 'summary' ? SUMMARY_VIEW_NOTICE : undefined;
  return new LinearBlockComponent(entityBlock(theme, spec, details.entity, verb.past, details.notes, disclosure));
}

function renderNotFoundDigest(
  details: NotFoundResultDetails,
  theme: Theme,
  spec: EntitySpec,
  definition: OperationDefinition,
  context: LinearRenderContext,
): LinearBlockComponent {
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

function renderMutationDigest(
  details: MutationResultDetails,
  theme: Theme,
  spec: EntitySpec,
  verb: Verb,
  definition: OperationDefinition,
  context: LinearRenderContext,
): LinearBlockComponent {
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
    return new LinearBlockComponent(entityBlock(
      theme,
      spec,
      details.entity,
      verb.past,
      details.notes,
      undefined,
      details.warnings,
    ));
  }
  const target = namedTarget(details.target, context, definition);
  const warning = details.warnings.length > 0;
  return new LinearBlockComponent([
    '',
    theme.fg(
      warning ? 'warning' : 'success',
      `${warning ? '!' : '✓'} ${verb.past} ${spec.noun}${target ? ` ${target}` : ''}${warning ? ' with warnings' : ''}`,
    ),
    ...details.warnings.map((message) => wrapped(theme.fg('warning', message), 2)),
    ...details.notes.map((note) => wrapped(theme.fg('dim', note), 2)),
    '',
    wrapped(theme.fg('dim', jsonHint())),
  ]);
}

function renderWorkspaceDigest(details: WorkspaceResultDetails, theme: Theme, verb: Verb): LinearBlockComponent {
  return new LinearBlockComponent([
    '',
    `${theme.fg('success', `✓ ${verb.past} workspace`)} ${theme.fg('accent', details.active)}`,
    '',
    wrapped(theme.fg('dim', jsonHint())),
  ]);
}

function renderUnknownDigest(details: UnknownResultDetails, theme: Theme): LinearBlockComponent {
  return new LinearBlockComponent([
    '',
    theme.fg('toolOutput', truncate(details.summary, 200)),
    '',
    wrapped(theme.fg('dim', jsonHint())),
  ]);
}

type NamedDataDetails = SpillResultDetails | ListResultDetails | EntityResultDetails | NotFoundResultDetails;

function renderNamedDataDigest(
  details: NamedDataDetails,
  theme: Theme,
  spec: EntitySpec,
  verb: Verb,
  definition: OperationDefinition,
  context: LinearRenderContext,
): LinearBlockComponent | LinearListComponent<Entity> {
  if (details.kind === 'spill') return new LinearBlockComponent(spillBlock(theme, details));
  if (details.kind === 'list') return renderListDigest(details, theme, spec, definition, context);
  if (details.kind === 'entity') return renderEntityDigest(details, theme, spec, verb);
  return renderNotFoundDigest(details, theme, spec, definition, context);
}

function renderDigest(
  details: NamedResultDetails,
  theme: Theme,
  spec: EntitySpec,
  verb: Verb,
  definition: OperationDefinition,
  context: LinearRenderContext,
): LinearBlockComponent | LinearListComponent<Entity> {
  if (details.kind === 'mutation') return renderMutationDigest(details, theme, spec, verb, definition, context);
  if (details.kind === 'workspace') return renderWorkspaceDigest(details, theme, verb);
  if (details.kind === 'unknown') return renderUnknownDigest(details, theme);
  return renderNamedDataDigest(details, theme, spec, verb, definition, context);
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

type HelpDomainsDetails = Extract<HelpResultDetails, { kind: 'help-domains' }>;
type HelpOperationsDetails = Extract<HelpResultDetails, { kind: 'help-operations' }>;
type HelpOperationDetails = Extract<HelpResultDetails, { kind: 'help-operation' }>;
type KnownHelpDetails = Exclude<HelpResultDetails, UnknownResultDetails>;

function helpDomainLines(theme: Theme, details: HelpDomainsDetails): BlockLine[] {
  return [
    theme.fg('success', `✓ ${details.domains.length} domains`),
    wrapped(theme.fg('muted', details.domains.join('  ')), 2),
    wrapped(theme.fg('dim', 'Ask for one operation to load its typed tool.'), 2),
  ];
}

function helpOperationsLines(theme: Theme, details: HelpOperationsDetails): BlockLine[] {
  const lines: BlockLine[] = [
    theme.fg('success', `✓ ${plural(details.operations.length, 'operation')} in ${details.domain ?? 'domain'}`),
    '',
  ];
  for (const operation of details.operations.slice(0, PREVIEW_LIMIT)) {
    lines.push(wrapped(theme.fg('muted', operation.signature ?? operation.name ?? ''), 2));
  }
  return lines;
}

function helpOperationLines(theme: Theme, details: HelpOperationDetails): BlockLine[] {
  const lines: BlockLine[] = [theme.fg('success', `✓ ${details.name}`)];
  if (details.purpose) lines.push(`  ${theme.fg('dim', details.purpose)}`);
  lines.push('');
  for (const parameter of details.parameters) {
    const label = `${parameter.name}${parameter.required ? '' : '?'}`.padEnd(24);
    lines.push(wrapped(`${theme.fg('muted', label)}${theme.fg('dim', parameter.type)}`, 2));
  }
  return lines;
}

function helpContentLines(theme: Theme, details: KnownHelpDetails): BlockLine[] {
  if (details.kind === 'help-domains') return helpDomainLines(theme, details);
  if (details.kind === 'help-operations') return helpOperationsLines(theme, details);
  return helpOperationLines(theme, details);
}

function loadedHelpLines(theme: Theme, details: KnownHelpDetails): BlockLine[] {
  if (!details.loaded.length) return [];
  return [
    '',
    wrapped(theme.fg('success', `✓ loaded ${plural(details.loaded.length, 'tool')}`), 2),
    wrapped(theme.fg('dim', details.loaded.join(', ')), 2),
  ];
}

function helpBlock(theme: Theme, details: HelpResultDetails): LinearBlockComponent | undefined {
  if (details.kind === 'unknown') return undefined;
  return new LinearBlockComponent([
    '',
    ...helpContentLines(theme, details),
    ...loadedHelpLines(theme, details),
    '',
    wrapped(theme.fg('dim', jsonHint())),
  ]);
}

function connectionFieldSummary(field: Extract<RawField, { kind: 'connection' }>): string {
  const paging = field.nextCursor ? ` · next page after="${field.nextCursor}"` : '';
  return `${field.key}: connection · ${plural(field.nodeCount, 'node')}${paging}`;
}

function arrayFieldSummary(field: Extract<RawField, { kind: 'array' }>): string {
  return `${field.key}: array · ${plural(field.itemCount, 'item')}`;
}

function objectFieldSummary(field: Extract<RawField, { kind: 'object' }>): string {
  const keys = field.keys.length ? ` (${field.keys.join(', ')})` : '';
  return `${field.key}: object · ${plural(field.keys.length, 'key')}${keys}`;
}

function scalarFieldSummary(field: Extract<RawField, { kind: 'scalar' }>): string {
  const size = field.charCount !== undefined ? ` · ${field.charCount} chars` : '';
  return `${field.key}: ${field.valueKind}${size}`;
}

function rawFieldSummary(field: RawField): string {
  if (field.kind === 'connection') return connectionFieldSummary(field);
  if (field.kind === 'array') return arrayFieldSummary(field);
  if (field.kind === 'object') return objectFieldSummary(field);
  return scalarFieldSummary(field);
}

function rawGraphqlBlock(theme: Theme, details: RawCompleteDetails): LinearBlockComponent {
  const lines: BlockLine[] = [
    '',
    theme.fg('success', '✓ GraphQL response'),
    wrapped(theme.fg('muted', `Keys: ${details.keys.length ? details.keys.join(', ') : '(none)'}`), 2),
    ...details.fields.map((field) => wrapped(theme.fg('toolOutput', rawFieldSummary(field)), 2)),
    ...details.notes.map((note) => wrapped(theme.fg('dim', note), 2)),
  ];
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

function directErrorResult(
  result: AgentToolResult<JsonObject>,
  theme: Theme,
  toolName: string,
  noun: string,
  rawGraphql = false,
): ReturnType<typeof renderErrorResult> {
  const message = resultErrorMessage(result);
  const recovery = errorRecovery(message, toolName, noun, rawGraphql);
  const guidance = recovery.includes(toolName) ? recovery : `${recovery} Then call ${toolName} again.`;
  return renderErrorResult(result, theme, guidance);
}

export function renderLinearBatchResult(
  result: AgentToolResult<JsonObject>,
  options: ToolRenderResultOptions,
  theme: Theme,
  context: LinearRenderContext,
): Text | LinearBlockComponent {
  if (options.isPartial) return new Text(theme.fg('warning', 'Running batch…'), 0, 0);
  if (context.isError) return directErrorResult(result, theme, 'linear_batch', 'batch');
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

function retrievalRangeValue(value: ParsedJsonValue | undefined): string {
  return String(value ?? '?');
}

function retrievalBlock(theme: Theme, details: RetrievalResultDetails): LinearBlockComponent {
  const lines: BlockLine[] = [
    '',
    theme.fg('success', details.complete ? '✓ Stored result complete' : '✓ Stored result segment'),
  ];
  if (details.range) {
    const start = retrievalRangeValue(details.range.start);
    const end = retrievalRangeValue(details.range.end);
    const total = retrievalRangeValue(details.range.total);
    lines.push(wrapped(theme.fg('dim', `Range: ${start}–${end} of ${total} ${details.range.unit}`), 2));
  }
  if (details.nextOffset !== undefined) {
    lines.push(wrapped(theme.fg('dim', `Next offset: ${details.nextOffset}`), 2));
  }
  lines.push(wrapped(theme.fg('toolOutput', JSON.stringify(details.value)), 2));
  lines.push('', wrapped(theme.fg('dim', jsonHint())));
  return new LinearBlockComponent(lines);
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
  return retrievalBlock(theme, details);
}

export function renderLinearGraphqlResult(
  result: AgentToolResult<JsonObject>,
  options: ToolRenderResultOptions,
  theme: Theme,
  context: LinearRenderContext,
): Text | LinearBlockComponent | LinearListComponent<Entity> {
  if (options.isPartial) return new Text(theme.fg('warning', 'Running request…'), 0, 0);
  if (context.isError) return directErrorResult(result, theme, 'linear_graphql', 'operation', true);
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
