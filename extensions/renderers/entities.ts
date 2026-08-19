import type { Theme } from '@earendil-works/pi-coding-agent';
import { getOperationDefinition } from '../operations';
import {
  accentStyle,
  asRecord,
  asString,
  cleanOneLine,
  dimStyle,
  mutedStyle,
  truncate,
  type CellStyle,
  type TableColumn,
} from './common';

export type Entity = Record<string, unknown>;

export type EntitySpec = {
  noun: string;
  pluralNoun?: string;
  /** Short stable identifier shown first: ABC-123, team key, cycle number. */
  lead?: (entity: Entity) => string | undefined;
  /** Human name of the record; the column that fills the row. */
  label: (entity: Entity) => string;
  /** Header for that filling column. */
  primaryLabel?: string;
  columns: TableColumn<Entity>[];
  dropOrder?: string[];
  metadata: (entity: Entity) => string[];
  body?: (entity: Entity) => string | undefined;
};

const NAME_LIMIT = 90;
const BODY_LIMIT = 180;

function field(entity: Entity, key: string): string | undefined {
  return asString(entity[key]);
}

function nested(entity: Entity, key: string, child = 'name'): string | undefined {
  return asString(asRecord(entity[key])?.[child]);
}

function nodeNames(entity: Entity, key: string, limit = 3): string | undefined {
  const nodes = asRecord(entity[key])?.nodes;
  if (!Array.isArray(nodes)) return undefined;
  const names = nodes.map((node) => asString(asRecord(node)?.name)).filter((name): name is string => !!name);
  if (!names.length) return undefined;
  const shown = names.slice(0, limit).join(', ');
  return names.length > limit ? `${shown}, +${names.length - limit}` : shown;
}

function date(entity: Entity, key: string): string | undefined {
  const value = field(entity, key);
  return value ? value.slice(0, 10) : undefined;
}

function percent(entity: Entity, key: string): string | undefined {
  const value = entity[key];
  if (typeof value !== 'number') return undefined;
  return `${Math.round(value <= 1 ? value * 100 : value)}%`;
}

function humanize(value: string): string {
  const spaced = value.replace(/[_-]+/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').trim();
  return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase() : value;
}

function name(entity: Entity, fallback: string): string {
  const value = field(entity, 'name') ?? field(entity, 'title');
  if (value) return truncate(cleanOneLine(value), NAME_LIMIT);
  const id = field(entity, 'id');
  if (id) return id.length > 12 ? `${id.slice(0, 8)}…` : id;
  return fallback;
}

function body(entity: Entity, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = field(entity, key);
    if (value) return truncate(cleanOneLine(value), BODY_LIMIT);
  }
  return undefined;
}

function parts(...values: Array<string | undefined>): string[] {
  return values.filter((value): value is string => !!value);
}

export function statusStyle(theme: Theme, value: string): CellStyle {
  const normalized = value.toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (['done', 'completed', 'on track', 'ontrack', 'healthy'].includes(normalized)) {
    return (text) => theme.fg('success', text);
  }
  if (['at risk', 'atrisk', 'active'].includes(normalized)) return (text) => theme.fg('warning', text);
  if (['off track', 'offtrack', 'blocked', 'canceled', 'cancelled', 'failed'].includes(normalized)) {
    return (text) => theme.fg('error', text);
  }
  if (['upcoming', 'next'].includes(normalized)) return accentStyle(theme);
  if (['planned', 'backlog', 'triage', 'past', 'unknown', '—'].includes(normalized)) return dimStyle(theme);
  return mutedStyle(theme);
}

export function priorityStyle(theme: Theme, value: string): CellStyle {
  const normalized = value.toLowerCase();
  if (['urgent', 'high'].includes(normalized)) return (text) => theme.fg('warning', text);
  if (['low', 'no priority', '—'].includes(normalized)) return dimStyle(theme);
  return mutedStyle(theme);
}

function priorityText(entity: Entity): string | undefined {
  const label = field(entity, 'priorityLabel');
  if (label) return label;
  const value = entity.priority;
  return typeof value === 'number' && value > 0 ? `P${value}` : undefined;
}

const column = (
  id: string,
  label: string,
  width: number,
  value: (entity: Entity) => string | undefined,
  options: {
    style?: (theme: Theme, value: string, entity: Entity) => CellStyle;
    align?: 'left' | 'right';
  } = {},
): TableColumn<Entity> => ({
  id,
  label,
  width,
  align: options.align,
  value: (entity) => value(entity) ?? '—',
  style: options.style,
});

const identifier = column('id', 'ID', 9, (entity) => field(entity, 'identifier'), {
  style: (theme) => accentStyle(theme),
});
const stateColumn = column('state', 'Status', 12, (entity) => nested(entity, 'state'), {
  style: statusStyle,
});
const priorityColumn = column('priority', 'Priority', 11, priorityText, { style: priorityStyle });
const teamColumn = column('team', 'Team', 6, (entity) => nested(entity, 'team', 'key'));
const updatedColumn = column('updated', 'Updated', 10, (entity) => date(entity, 'updatedAt'));

export const ENTITY_SPECS: Record<string, EntitySpec> = {
  issue: {
    noun: 'issue',
    primaryLabel: 'Title',
    lead: (entity) => field(entity, 'identifier'),
    label: (entity) => name(entity, '(untitled)'),
    columns: [
      identifier,
      stateColumn,
      priorityColumn,
      column('assignee', 'Assignee', 16, (entity) => nested(entity, 'assignee')),
      column('labels', 'Labels', 20, (entity) => nodeNames(entity, 'labels'), {
        style: (theme) => dimStyle(theme),
      }),
    ],
    dropOrder: ['labels', 'assignee', 'priority', 'state'],
    metadata: (entity) => parts(
      nested(entity, 'state'),
      priorityText(entity),
      nested(entity, 'assignee') ? `@${nested(entity, 'assignee')}` : undefined,
      nodeNames(entity, 'labels'),
      nested(entity, 'project') ? `project: ${nested(entity, 'project')}` : undefined,
      date(entity, 'dueDate') ? `due ${date(entity, 'dueDate')}` : undefined,
    ),
    body: (entity) => body(entity, 'description'),
  },
  project: {
    noun: 'project',
    label: (entity) => name(entity, '(untitled project)'),
    columns: [
      column('status', 'Status', 14, (entity) => nested(entity, 'status') ?? field(entity, 'state'), {
        style: statusStyle,
      }),
      column('health', 'Health', 10, (entity) => {
        const health = field(entity, 'health');
        return health ? humanize(health) : undefined;
      }, { style: statusStyle }),
      column('progress', '%', 5, (entity) => percent(entity, 'progress'), { align: 'right' }),
      column('lead', 'Lead', 16, (entity) => nested(entity, 'lead')),
      column('target', 'Target', 10, (entity) => date(entity, 'targetDate')),
    ],
    dropOrder: ['target', 'lead', 'health', 'progress'],
    metadata: (entity) => parts(
      nested(entity, 'status') ?? field(entity, 'state'),
      field(entity, 'health') ? humanize(field(entity, 'health')!) : undefined,
      percent(entity, 'progress') ? `${percent(entity, 'progress')} complete` : undefined,
      nested(entity, 'lead') ? `lead @${nested(entity, 'lead')}` : undefined,
      nodeNames(entity, 'teams'),
      date(entity, 'targetDate') ? `target ${date(entity, 'targetDate')}` : undefined,
    ),
    body: (entity) => body(entity, 'description'),
  },
  comment: {
    noun: 'comment',
    primaryLabel: 'Comment',
    lead: (entity) => nested(entity, 'issue', 'identifier'),
    label: (entity) => truncate(cleanOneLine(field(entity, 'body') ?? '(empty comment)'), NAME_LIMIT),
    columns: [
      column('issue', 'Issue', 9, (entity) => nested(entity, 'issue', 'identifier'), {
        style: (theme) => accentStyle(theme),
      }),
      column('author', 'Author', 16, (entity) => nested(entity, 'user')),
      column('created', 'Created', 10, (entity) => date(entity, 'createdAt')),
    ],
    dropOrder: ['created', 'author'],
    metadata: (entity) => parts(
      nested(entity, 'user') ? `@${nested(entity, 'user')}` : undefined,
      nested(entity, 'issue', 'identifier'),
      date(entity, 'createdAt'),
      field(entity, 'resolvedAt') ? 'resolved' : undefined,
    ),
    body: (entity) => body(entity, 'body'),
  },
  cycle: {
    noun: 'cycle',
    lead: (entity) => (typeof entity.number === 'number' ? `#${entity.number}` : undefined),
    label: (entity) => name(entity, '(unnamed cycle)'),
    columns: [
      column('number', '#', 4, (entity) => (typeof entity.number === 'number' ? String(entity.number) : undefined), {
        align: 'right',
        style: (theme) => accentStyle(theme),
      }),
      teamColumn,
      column('window', 'Window', 23, (entity) => {
        const start = date(entity, 'startsAt');
        const end = date(entity, 'endsAt');
        return start && end ? `${start} → ${end}` : start ?? end;
      }),
      column('progress', '%', 5, (entity) => percent(entity, 'progress'), { align: 'right' }),
    ],
    dropOrder: ['progress', 'window', 'team'],
    metadata: (entity) => parts(
      nested(entity, 'team', 'key'),
      date(entity, 'startsAt') && date(entity, 'endsAt')
        ? `${date(entity, 'startsAt')} → ${date(entity, 'endsAt')}`
        : undefined,
      entity.isActive === true ? 'active' : undefined,
      percent(entity, 'progress') ? `${percent(entity, 'progress')} complete` : undefined,
    ),
    body: (entity) => body(entity, 'description'),
  },
  document: {
    noun: 'document',
    primaryLabel: 'Title',
    label: (entity) => name(entity, '(untitled document)'),
    columns: [
      column('project', 'Project', 18, (entity) => nested(entity, 'project')),
      column('issue', 'Issue', 9, (entity) => nested(entity, 'issue', 'identifier'), {
        style: (theme) => accentStyle(theme),
      }),
      updatedColumn,
    ],
    dropOrder: ['updated', 'issue', 'project'],
    metadata: (entity) => parts(
      nested(entity, 'project') ? `project: ${nested(entity, 'project')}` : undefined,
      nested(entity, 'issue', 'identifier'),
      date(entity, 'updatedAt') ? `updated ${date(entity, 'updatedAt')}` : undefined,
    ),
    body: (entity) => body(entity, 'summary', 'content'),
  },
  initiative: {
    noun: 'initiative',
    label: (entity) => name(entity, '(untitled initiative)'),
    columns: [
      column('status', 'Status', 12, (entity) => {
        const status = field(entity, 'status');
        return status ? humanize(status) : undefined;
      }, { style: statusStyle }),
      column('health', 'Health', 10, (entity) => {
        const health = field(entity, 'health');
        return health ? humanize(health) : undefined;
      }, { style: statusStyle }),
      column('owner', 'Owner', 16, (entity) => nested(entity, 'owner')),
      column('target', 'Target', 10, (entity) => date(entity, 'targetDate')),
    ],
    dropOrder: ['target', 'owner', 'health'],
    metadata: (entity) => parts(
      field(entity, 'status') ? humanize(field(entity, 'status')!) : undefined,
      field(entity, 'health') ? humanize(field(entity, 'health')!) : undefined,
      nested(entity, 'owner') ? `owner @${nested(entity, 'owner')}` : undefined,
      date(entity, 'targetDate') ? `target ${date(entity, 'targetDate')}` : undefined,
    ),
    body: (entity) => body(entity, 'description'),
  },
  milestone: {
    noun: 'milestone',
    label: (entity) => name(entity, '(untitled milestone)'),
    columns: [
      column('status', 'Status', 12, (entity) => {
        const status = field(entity, 'status');
        return status ? humanize(status) : undefined;
      }, { style: statusStyle }),
      column('progress', '%', 5, (entity) => percent(entity, 'progress'), { align: 'right' }),
      column('project', 'Project', 18, (entity) => nested(entity, 'project')),
      column('target', 'Target', 10, (entity) => date(entity, 'targetDate')),
    ],
    dropOrder: ['target', 'project', 'progress'],
    metadata: (entity) => parts(
      field(entity, 'status') ? humanize(field(entity, 'status')!) : undefined,
      nested(entity, 'project') ? `project: ${nested(entity, 'project')}` : undefined,
      percent(entity, 'progress') ? `${percent(entity, 'progress')} complete` : undefined,
      date(entity, 'targetDate') ? `target ${date(entity, 'targetDate')}` : undefined,
    ),
    body: (entity) => body(entity, 'description'),
  },
  team: {
    noun: 'team',
    lead: (entity) => field(entity, 'key'),
    label: (entity) => name(entity, '(unnamed team)'),
    columns: [
      column('key', 'Key', 6, (entity) => field(entity, 'key'), { style: (theme) => accentStyle(theme) }),
      column('private', 'Access', 7, (entity) => (entity.private === true ? 'private' : 'open')),
      column('states', 'States', 6, (entity) => {
        const nodes = asRecord(entity.states)?.nodes;
        return Array.isArray(nodes) ? String(nodes.length) : undefined;
      }, { align: 'right' }),
    ],
    dropOrder: ['states', 'private'],
    metadata: (entity) => parts(
      field(entity, 'key'),
      entity.private === true ? 'private' : undefined,
    ),
    body: (entity) => body(entity, 'description'),
  },
  user: {
    noun: 'user',
    lead: (entity) => field(entity, 'displayName'),
    label: (entity) => name(entity, '(unnamed user)'),
    columns: [
      column('display', 'Handle', 16, (entity) => field(entity, 'displayName'), {
        style: (theme) => accentStyle(theme),
      }),
      column('email', 'Email', 26, (entity) => field(entity, 'email')),
      column('active', 'State', 8, (entity) => (entity.active === false ? 'disabled' : 'active'), {
        style: statusStyle,
      }),
    ],
    dropOrder: ['active', 'email'],
    metadata: (entity) => parts(
      field(entity, 'email'),
      entity.admin === true ? 'admin' : undefined,
      entity.guest === true ? 'guest' : undefined,
      entity.active === false ? 'disabled' : undefined,
    ),
  },
  label: {
    noun: 'label',
    label: (entity) => name(entity, '(unnamed label)'),
    columns: [
      teamColumn,
      column('group', 'Group', 6, (entity) => (entity.isGroup === true ? 'group' : undefined)),
      column('parent', 'Parent', 16, (entity) => nested(entity, 'parent')),
    ],
    dropOrder: ['parent', 'group', 'team'],
    metadata: (entity) => parts(
      nested(entity, 'team', 'key'),
      nested(entity, 'parent') ? `in ${nested(entity, 'parent')}` : undefined,
      entity.isGroup === true ? 'group' : undefined,
      field(entity, 'retiredAt') ? 'retired' : undefined,
    ),
    body: (entity) => body(entity, 'description'),
  },
  issue_status: {
    noun: 'status',
    pluralNoun: 'statuses',
    label: (entity) => name(entity, '(unnamed status)'),
    columns: [
      column('type', 'Type', 11, (entity) => field(entity, 'type'), { style: statusStyle }),
      teamColumn,
      column('position', 'Pos', 5, (entity) =>
        typeof entity.position === 'number' ? String(entity.position) : undefined, { align: 'right' }),
    ],
    dropOrder: ['position', 'team'],
    metadata: (entity) => parts(field(entity, 'type'), nested(entity, 'team', 'key')),
    body: (entity) => body(entity, 'description'),
  },
  issue_relation: {
    noun: 'relation',
    primaryLabel: 'Relation',
    lead: (entity) => nested(entity, 'issue', 'identifier'),
    label: (entity) => {
      const from = nested(entity, 'issue', 'identifier') ?? '—';
      const to = nested(entity, 'relatedIssue', 'identifier') ?? '—';
      const type = field(entity, 'type') ?? 'related';
      return `${from} ${type} ${to}`;
    },
    columns: [
      column('type', 'Type', 10, (entity) => field(entity, 'type')),
      column('issue', 'Issue', 9, (entity) => nested(entity, 'issue', 'identifier'), {
        style: (theme) => accentStyle(theme),
      }),
      column('related', 'Related', 9, (entity) => nested(entity, 'relatedIssue', 'identifier'), {
        style: (theme) => accentStyle(theme),
      }),
    ],
    dropOrder: ['related', 'issue'],
    metadata: (entity) => parts(
      field(entity, 'type'),
      nested(entity, 'relatedIssue', 'title'),
    ),
  },
  project_relation: {
    noun: 'relation',
    primaryLabel: 'Relation',
    label: (entity) => {
      const from = nested(entity, 'project') ?? '—';
      const to = nested(entity, 'relatedProject') ?? '—';
      return `${from} ${field(entity, 'type') ?? 'related'} ${to}`;
    },
    columns: [
      column('type', 'Type', 10, (entity) => field(entity, 'type')),
      column('anchor', 'Anchor', 10, (entity) => field(entity, 'anchorType')),
      column('project', 'Project', 20, (entity) => nested(entity, 'project')),
    ],
    dropOrder: ['anchor', 'project'],
    metadata: (entity) => parts(
      field(entity, 'type'),
      nested(entity, 'project'),
      nested(entity, 'relatedProject'),
    ),
  },
  view: {
    noun: 'view',
    label: (entity) => name(entity, '(unnamed view)'),
    columns: [
      teamColumn,
      column('shared', 'Shared', 6, (entity) => (entity.shared === true ? 'shared' : 'private')),
      column('owner', 'Owner', 16, (entity) => nested(entity, 'owner')),
      updatedColumn,
    ],
    dropOrder: ['updated', 'owner', 'shared', 'team'],
    metadata: (entity) => parts(
      nested(entity, 'team', 'key'),
      entity.shared === true ? 'shared' : 'private',
      nested(entity, 'owner') ? `owner @${nested(entity, 'owner')}` : undefined,
    ),
    body: (entity) => body(entity, 'description'),
  },
  workspace: {
    noun: 'workspace',
    label: (entity) => asString(entity.active) ?? name(entity, '(none)'),
    columns: [column('active', 'Active', 20, (entity) => asString(entity.active))],
    metadata: () => [],
  },
};

/** Entity kind projected from the operation definition. */
export function entityKind(operationName: string): string {
  try {
    const kind = getOperationDefinition(operationName).result.renderKind;
    return ENTITY_SPECS[kind] ? kind : 'issue';
  } catch {
    return 'issue';
  }
}

export function specFor(operationName: string): EntitySpec {
  return ENTITY_SPECS[entityKind(operationName)]!;
}

export function specForKind(kind: string): EntitySpec {
  return ENTITY_SPECS[kind] ?? ENTITY_SPECS.issue!;
}
