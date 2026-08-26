import { isJsonObject, parseJson, type JsonObject, type JsonValue } from '../json';
import { cleanOneLine } from './common';
import type { Entity } from './entities';

const NUMBER_TAG = '[object Number]';
const STRING_TAG = '[object String]';

function jsonTag(value: JsonValue | undefined): string {
  return Object.prototype.toString.call(value);
}

function isText(value: JsonValue | undefined): value is string {
  return jsonTag(value) === STRING_TAG;
}

function asString(value: JsonValue | undefined): string | undefined {
  if (!isText(value)) return undefined;
  const text = value.trim();
  return text || undefined;
}

function asNumber(value: JsonValue | undefined): number | undefined {
  return jsonTag(value) === NUMBER_TAG ? value as number : undefined;
}

function asObject(value: JsonValue | undefined): JsonObject | undefined {
  return isJsonObject(value) ? value : undefined;
}

function asEntity(value: JsonObject): Entity;
function asEntity(value: JsonValue | undefined): Entity | undefined;
function asEntity(value: JsonValue | undefined): Entity | undefined {
  return isJsonObject(value) ? value as Entity : undefined;
}

export type ResultSurface =
  | { kind: 'named'; expectedRoots: readonly string[] }
  | { kind: 'batch' }
  | { kind: 'retrieval' }
  | { kind: 'raw' }
  | { kind: 'help' };

export type ResultViewKind = 'summary' | 'full';

export type SpillResultDetails = {
  kind: 'spill';
  handle?: string;
  path: string;
  bytes: number;
  index: readonly string[];
  notes: readonly string[];
};

export type ListResultDetails = {
  kind: 'list';
  entities: readonly Entity[];
  notes: readonly string[];
  totalCount?: number;
  view?: ResultViewKind;
};

export type EntityResultDetails = {
  kind: 'entity';
  entity: Entity;
  notes: readonly string[];
  view?: ResultViewKind;
};

export type NotFoundResultDetails = {
  kind: 'not-found';
  notes: readonly string[];
  target?: string;
};

export type MutationResultDetails = {
  kind: 'mutation';
  success: boolean;
  entity?: Entity;
  notes: readonly string[];
  target?: string;
};

export type WorkspaceResultDetails = {
  kind: 'workspace';
  active: string;
};

export type UnknownResultDetails = {
  kind: 'unknown';
  summary: string;
};

export type NamedResultDetails =
  | SpillResultDetails
  | ListResultDetails
  | EntityResultDetails
  | NotFoundResultDetails
  | MutationResultDetails
  | WorkspaceResultDetails
  | UnknownResultDetails;

export type BatchCompleteDetails = {
  kind: 'batch';
  completed: readonly string[];
  failed: readonly string[];
  skipped: readonly string[];
  readRequests: number;
  mutationRequests: number;
};

export type BatchResultDetails = SpillResultDetails | BatchCompleteDetails;

export type RetrievalRange = {
  start: JsonValue | undefined;
  end: JsonValue | undefined;
  total: JsonValue | undefined;
  unit: string;
};

export type RetrievalResultDetails = {
  kind: 'retrieval';
  complete: boolean;
  range?: RetrievalRange;
  nextOffset?: number;
  value: JsonValue | undefined;
};

export type RawField =
  | { kind: 'connection'; key: string; nodeCount: number; nextCursor?: string }
  | { kind: 'array'; key: string; itemCount: number }
  | { kind: 'object'; key: string; keys: readonly string[] }
  | { kind: 'scalar'; key: string; valueKind: string; charCount?: number };

export type RawCompleteDetails = {
  kind: 'raw';
  keys: readonly string[];
  fields: readonly RawField[];
  notes: readonly string[];
};

export type RawResultDetails = SpillResultDetails | RawCompleteDetails;

export type HelpParameter = {
  name: string;
  type: string;
  required: boolean;
};

export type HelpOperationEntry = {
  name?: string;
  signature?: string;
};

export type HelpResultDetails =
  | { kind: 'help-domains'; domains: readonly string[]; loaded: readonly string[] }
  | { kind: 'help-operations'; domain?: string; operations: readonly HelpOperationEntry[]; loaded: readonly string[] }
  | { kind: 'help-operation'; name: string; purpose?: string; parameters: readonly HelpParameter[]; loaded: readonly string[] }
  | UnknownResultDetails;

export type ResultDetails =
  | NamedResultDetails
  | BatchResultDetails
  | RetrievalResultDetails
  | RawResultDetails
  | HelpResultDetails;

function asCount(value: JsonValue | undefined): number | undefined {
  const count = asNumber(value);
  return count !== undefined && Number.isFinite(count) && count >= 0 ? count : undefined;
}

function displayEntries(value: JsonValue | undefined): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => (isText(entry) ? entry : String(entry)));
}

function loadedTools(details: JsonObject): readonly string[] {
  return Array.isArray(details.loadedTools) ? details.loadedTools.filter(isText) : [];
}

function resultView(details: JsonObject): ResultViewKind | undefined {
  const view = asObject(details.meta)?.view;
  return view === 'summary' || view === 'full' ? view : undefined;
}

function resolutionTarget(details: JsonObject): string | undefined {
  const target = asObject(asObject(details.resolution)?.target);
  if (!target) return undefined;
  return asString(target.identifier) ?? asString(target.key) ?? asString(target.name)
    ?? asString(target.resolvedId) ?? asString(target.requested);
}

function metaNotes(details: JsonObject): string[] {
  const notes: string[] = [];
  const meta = asObject(details.meta) ?? {};
  const truncations = Array.isArray(meta.truncations) ? meta.truncations : [];
  for (const truncation of truncations) {
    const record = asObject(truncation) ?? {};
    notes.push(record.endCursor
      ? `kept ${record.kept} nodes — request the next page with after="${record.endCursor}"`
      : `kept ${record.kept} nodes — narrow the filter for the rest`);
  }
  if (asObject(meta.resultBudget)?.recoverable) {
    notes.push('complete result stored outside this inline result');
  }
  const clipped = asNumber(meta.stringsClipped);
  if (clipped !== undefined && clipped > 0) {
    notes.push(`${clipped === 1 ? '1 long field' : `${clipped} long fields`} clipped`);
  }
  const target = asObject(asObject(details.resolution)?.target);
  if (target) {
    const resolved = asString(target.identifier) ?? asString(target.key) ?? asString(target.name) ?? asString(target.resolvedId);
    const requested = asString(target.requested);
    if (requested && resolved && requested !== resolved) notes.push(`resolved ${requested} → ${resolved}`);
  }
  return notes;
}

function pageNote(connection: JsonObject, shown: number): string | undefined {
  const total = asCount(connection.totalCount);
  const pageInfo = asObject(connection.pageInfo);
  const cursor = asString(pageInfo?.endCursor);
  if (total !== undefined && shown < total) {
    return cursor ? `more pages — request after="${cursor}"` : undefined;
  }
  if (total !== undefined) return undefined;
  if (pageInfo?.hasNextPage !== true) return undefined;
  return cursor
    ? `more results exist; total count is unavailable — request after="${cursor}"`
    : 'more results exist; total count is unavailable';
}

function parseSpill(details: JsonObject): SpillResultDetails | undefined {
  const path = asString(details.path);
  if (!path) return undefined;
  return {
    kind: 'spill',
    handle: asString(details.handle),
    path,
    bytes: asNumber(details.bytes) ?? 0,
    index: Array.isArray(details.index) ? details.index.filter(isText) : [],
    notes: metaNotes(details),
  };
}

function fallbackSummary(value: JsonValue | undefined): string {
  return cleanOneLine(JSON.stringify(value ?? {}) ?? '{}');
}

function parseNamed(details: JsonObject, expectedRoots: readonly string[], fallback: JsonValue | undefined): NamedResultDetails {
  const notes = metaNotes(details);
  const view = resultView(details);
  const target = resolutionTarget(details);
  const data = asObject(details.data);
  if (data && expectedRoots.some((root) => Object.prototype.hasOwnProperty.call(data, root) && data[root] === null)) {
    return { kind: 'not-found', notes, target };
  }
  const rootEntry = data ? Object.entries(data).find(([, value]) => asObject(value)) : undefined;
  const record = asObject(rootEntry?.[1]);
  if (!record) {
    const active = asString(details.active);
    if (active) return { kind: 'workspace', active };
    return { kind: 'unknown', summary: fallbackSummary(fallback) };
  }
  if (Array.isArray(record.nodes)) {
    const entities = record.nodes.flatMap((node) => {
      const entity = asEntity(node);
      return entity ? [entity] : [];
    });
    const page = pageNote(record, entities.length);
    return {
      kind: 'list',
      entities,
      notes: page ? [...notes, page] : notes,
      totalCount: asCount(record.totalCount),
      view,
    };
  }
  if ('success' in record || 'deleted' in record) {
    const entity = Object.entries(record)
      .filter(([key]) => key !== 'success' && key !== 'deleted')
      .map(([, value]) => asEntity(value))
      .find((value): value is Entity => !!value);
    return { kind: 'mutation', success: record.success === true || record.deleted === true, entity, notes, target };
  }
  if (/(?:create|update|delete|archive|unarchive)$/i.test(rootEntry?.[0] ?? '')) {
    return { kind: 'mutation', success: false, notes, target };
  }
  return { kind: 'entity', entity: asEntity(record), notes, view };
}

function parseBatch(details: JsonObject): BatchCompleteDetails {
  const data = asObject(details.data) ?? {};
  const errors = Array.isArray(details.errors) ? details.errors : [];
  const skipped = Array.isArray(details.skipped) ? details.skipped.filter(isText) : [];
  const failed = [...new Set(errors.map((entry) => asString(asObject(entry)?.key)).filter((key): key is string => !!key))];
  const requests = asObject(asObject(details.meta)?.requests) ?? {};
  return {
    kind: 'batch',
    completed: Object.keys(data),
    failed,
    skipped,
    readRequests: asNumber(requests.read) ?? 0,
    mutationRequests: asNumber(requests.mutation) ?? 0,
  };
}

function parseRetrieval(details: JsonObject): RetrievalResultDetails {
  const data = asObject(details.data) ?? {};
  const retrieval = asObject(asObject(details.meta)?.retrieval) ?? {};
  const range = asObject(data.range);
  return {
    kind: 'retrieval',
    complete: retrieval.complete === true,
    range: range
      ? { start: range.start, end: range.end, total: range.total, unit: asString(range.unit) ?? 'values' }
      : undefined,
    nextOffset: asNumber(retrieval.nextOffset),
    value: data.value,
  };
}

function parseRawField(key: string, value: JsonValue | undefined): RawField {
  const record = asObject(value);
  const nodes = record && Array.isArray(record.nodes) ? record.nodes : undefined;
  if (nodes && record) {
    const pageInfo = asObject(record.pageInfo);
    const nextCursor = pageInfo?.hasNextPage === true ? asString(pageInfo.endCursor) : undefined;
    return { kind: 'connection', key, nodeCount: nodes.length, nextCursor };
  }
  if (Array.isArray(value)) return { kind: 'array', key, itemCount: value.length };
  if (record) return { kind: 'object', key, keys: Object.keys(record) };
  const valueKind = value === null ? 'null' : Object.prototype.toString.call(value).slice(8, -1).toLowerCase();
  return { kind: 'scalar', key, valueKind, charCount: isText(value) ? value.length : undefined };
}

function parseRaw(details: JsonObject): RawCompleteDetails {
  const data = asObject(details.data) ?? {};
  const keys = Object.keys(data);
  return {
    kind: 'raw',
    keys,
    fields: keys.map((key) => parseRawField(key, data[key])),
    notes: metaNotes(details),
  };
}

function parseHelp(details: JsonObject, fallback: JsonValue | undefined): HelpResultDetails {
  const loaded = loadedTools(details);
  if (Array.isArray(details.domains)) {
    return { kind: 'help-domains', domains: displayEntries(details.domains), loaded };
  }
  if (Array.isArray(details.operations)) {
    const operations = details.operations.map((entry) => {
      const record = asObject(entry);
      return { name: asString(record?.name), signature: asString(record?.signature) };
    });
    return { kind: 'help-operations', domain: asString(details.domain), operations, loaded };
  }
  if (asString(details.name) && Array.isArray(details.parameters)) {
    const parameters = details.parameters.map((entry) => {
      const record = asObject(entry) ?? {};
      return {
        name: 'name' in record ? String(record.name) : 'undefined',
        type: 'type' in record ? String(record.type) : 'undefined',
        required: record.required === true,
      };
    });
    return {
      kind: 'help-operation',
      name: asString(details.name) ?? '',
      purpose: asString(details.purpose),
      parameters,
      loaded,
    };
  }
  return { kind: 'unknown', summary: fallbackSummary(fallback) };
}

export function parseResultDetails(cause: unknown, surface: Extract<ResultSurface, { kind: 'named' }>): NamedResultDetails;
export function parseResultDetails(cause: unknown, surface: Extract<ResultSurface, { kind: 'batch' }>): BatchResultDetails;
export function parseResultDetails(cause: unknown, surface: Extract<ResultSurface, { kind: 'retrieval' }>): RetrievalResultDetails;
export function parseResultDetails(cause: unknown, surface: Extract<ResultSurface, { kind: 'raw' }>): RawResultDetails;
export function parseResultDetails(cause: unknown, surface: Extract<ResultSurface, { kind: 'help' }>): HelpResultDetails;
export function parseResultDetails(cause: unknown, surface: ResultSurface): ResultDetails {
  const parsed = parseJson(cause);
  const details = asObject(parsed) ?? {};
  if (surface.kind === 'retrieval') return parseRetrieval(details);
  if (surface.kind === 'help') return parseHelp(details, parsed);
  const spill = parseSpill(details);
  if (spill) return spill;
  if (surface.kind === 'batch') return parseBatch(details);
  if (surface.kind === 'raw') return parseRaw(details);
  return parseNamed(details, surface.expectedRoots, parsed);
}
