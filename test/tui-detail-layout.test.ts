import { Text } from '@earendil-works/pi-tui';
import { describe, expect, it } from 'vitest';
import { getOperation } from '../extensions/operations';
import { operationRenderers, renderLinearApiResult } from '../extensions/renderers';
import { statusStyle } from '../extensions/renderers/entities';

const plainTheme = {
  fg: (_role: string, text: string) => text,
  bg: (_role: string, text: string) => text,
  bold: (text: string) => text,
  italic: (text: string) => text,
  underline: (text: string) => text,
} as any;

const taggedTheme = {
  ...plainTheme,
  fg: (role: string, text: string) => `<${role}>${text}</${role}>`,
} as any;

const meta = { truncations: [], stringsClipped: 0 };
const WIDTHS = [200, 120, 100, 80, 60, 40, 30, 26, 20, 12] as const;

function result(details: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(details) }], details } as any;
}

function typed(
  operation: string,
  details: unknown,
  args: Record<string, unknown> = {},
  theme = plainTheme,
  options: { expanded?: boolean; isPartial?: boolean } = {},
) {
  return operationRenderers(getOperation(operation)).renderResult(
    result(details),
    { expanded: options.expanded ?? false, isPartial: options.isPartial ?? false },
    theme,
    { args } as any,
  );
}

function api(details: unknown, args: Record<string, unknown>, theme = plainTheme) {
  return renderLinearApiResult(
    result(details),
    { expanded: false, isPartial: false },
    theme,
    { args } as any,
  );
}

function text(component: any, width = 120): string {
  return component.render(width).join('\n');
}

function dump(component: any, width: number): string[] {
  return component.render(width);
}

const CYCLE = {
  id: 'cycle-1',
  number: 14,
  name: 'Sprint 14',
  description: 'Ship the cycle board.',
  startsAt: '2026-01-06T00:00:00.000Z',
  endsAt: '2026-01-19T00:00:00.000Z',
  completedAt: null,
  archivedAt: '2026-02-01T00:00:00.000Z',
  autoArchivedAt: null,
  isActive: true,
  isFuture: false,
  isPast: false,
  isNext: false,
  isPrevious: false,
  progress: 0.42,
  team: { key: 'PLATFORM', name: 'Platform' },
};

const VIEW = {
  id: 'view-1',
  name: 'Blocked bugs',
  description: 'Open bugs that are blocked.',
  icon: 'Bug',
  shared: true,
  slugId: 'blocked-bugs',
  modelName: 'Issue',
  archivedAt: '2026-03-01T00:00:00.000Z',
  filterData: { state: { name: { eq: 'Blocked' } }, labels: { name: { eq: 'bug' } } },
  team: { key: 'AEO', name: 'Aeo' },
  owner: { name: 'Samantha Okonkwo' },
};

const PROJECT = {
  id: 'project-1',
  name: 'Launch board',
  description: 'Public launch work.',
  url: 'https://linear.app/aeo/project/launch',
  state: 'started',
  status: { name: 'In Progress' },
  priority: 2,
  priorityLabel: 'High',
  health: 'onTrack',
  progress: 0.5,
  startDate: '2026-01-01',
  targetDate: '2026-06-01',
  lead: { name: 'sam' },
  teams: { nodes: [{ key: 'AEO' }, { key: 'PLATFORM' }] },
};

describe('structured cycle and view details', () => {
  it('renders label-aligned cycle fields including every defining property', () => {
    const component = typed('get_cycle', { data: { cycle: CYCLE }, meta });
    expect(component).not.toBeInstanceOf(Text);
    const rendered = text(component, 80);
    expect(rendered).toContain('✓ Loaded');
    expect(rendered).toContain('#14');
    expect(rendered).toContain('Sprint 14');
    for (const label of ['Team', 'Status', 'Progress', 'Range', 'Archived', 'Description']) {
      expect(rendered).toMatch(new RegExp(`^\\s+${label}\\s+`, 'm'));
    }
    expect(rendered).toContain('PLATFORM');
    expect(rendered).toContain('active');
    expect(rendered).toContain('42%');
    expect(rendered).toContain('2026-01-06 → 2026-01-19');
    expect(rendered).toContain('2026-02-01');
    expect(rendered).toContain('Ship the cycle board.');
    expect(rendered).not.toContain('PLATFORM ·');
  });

  it('renders label-aligned custom-view fields including owner and filter', () => {
    const component = typed('get_view', { data: { customView: VIEW }, meta });
    expect(component).not.toBeInstanceOf(Text);
    const rendered = text(component, 80);
    for (const label of ['Type', 'Scope', 'Shared', 'Icon', 'Filter', 'Slug', 'Archived', 'Owner']) {
      expect(rendered).toMatch(new RegExp(`^\\s+${label}\\s+`, 'm'));
    }
    expect(rendered).toContain('issues');
    expect(rendered).toContain('team: AEO');
    expect(rendered).toContain('shared');
    expect(rendered).toContain('Bug');
    expect(rendered).toContain('state, labels');
    expect(rendered).toContain('blocked-bugs');
    expect(rendered).toContain('2026-03-01');
    expect(rendered).toContain('Samantha Okonkwo');
  });

  it('keeps structured details on both public surfaces and resizes without a fixed Text', () => {
    const details = { data: { cycle: CYCLE }, meta };
    for (const component of [
      typed('get_cycle', details),
      api(details, { operation: 'get_cycle', variables: { id: 'cycle-1' } }),
    ]) {
      expect(component).not.toBeInstanceOf(Text);
      expect(typeof component.render).toBe('function');
      for (const width of WIDTHS) {
        const rendered = text(component, width);
        expect(rendered.length).toBeGreaterThan(0);
        expect(rendered).toContain('Team');
        if (width >= 40) expect(rendered.replace(/\s/g, '')).toContain('PLATFORM');
      }
    }
  });
});

describe('cycle list status', () => {
  const cycles = [
    { ...CYCLE, id: 'c-active', name: 'Now', isActive: true, isFuture: false, isPast: false, completedAt: null },
    {
      ...CYCLE, id: 'c-next', number: 15, name: 'Next', isActive: false, isFuture: true, isPast: false,
      isNext: true, completedAt: null, team: { key: 'AEO' },
    },
    {
      ...CYCLE, id: 'c-done', number: 13, name: 'Done', isActive: false, isFuture: false, isPast: true,
      completedAt: '2025-12-20T00:00:00.000Z', team: { key: 'AEO' },
    },
  ];

  it('shows styled current, upcoming, and completed status and protects the column', () => {
    expect(statusStyle(taggedTheme, 'active')('active')).toContain('<warning>');
    expect(statusStyle(taggedTheme, 'upcoming')('upcoming')).toContain('<accent>');
    expect(statusStyle(taggedTheme, 'completed')('completed')).toContain('<success>');

    const component = typed('list_cycles', { data: { cycles: { nodes: cycles } }, meta }, {}, taggedTheme);
    for (const width of [200, 120, 80, 60, 40, 30]) {
      const rendered = text(component, width);
      expect(rendered).toContain('Status');
    }
    const wide = text(component, 120);
    expect(wide).toContain('<warning>active');
    expect(wide).toContain('<accent>upcoming');
    expect(wide).toContain('<success>completed');

    const fallback = text(typed('list_cycles', { data: { cycles: { nodes: cycles } }, meta }), 26);
    expect(fallback).not.toMatch(/^\s+Status\s+/m);
    expect(fallback).toContain('Now');
  });
});

describe('adaptive columns', () => {
  it('grows a long team key instead of clipping it while unused width remains', () => {
    const component = typed('list_teams', {
      data: { teams: { nodes: [
        { id: 't1', key: 'PLATFORM', name: 'Platform engineering' },
        { id: 't2', key: 'AEO', name: 'Aeo' },
      ] } },
      meta,
    });
    const wide = text(component, 200);
    expect(wide).toContain('PLATFORM');
    expect(wide).not.toContain('PLATF…');
    expect(wide).toContain('Platform engineering');
  });

  it('shrinks and drops by issue priority while keeping ID and title readable', () => {
    const component = typed('list_issues', {
      data: { issues: { nodes: [
        {
          id: 'i1', identifier: 'AEO-258', title: 'Fix login redirect after a long session timeout',
          priorityLabel: 'High', state: { name: 'In Progress' },
          assignee: { name: 'sam' }, labels: { nodes: [{ name: 'bug' }] },
        },
      ] } },
      meta,
    });
    const at200 = text(component, 200);
    expect(at200).toContain('Labels');
    expect(at200).toContain('Assignee');
    expect(at200).toContain('AEO-258');
    expect(at200).toContain('Fix login redirect');

    const at80 = text(component, 80);
    expect(at80).toContain('AEO-258');
    expect(at80).toContain('Fix login redirect');

    const at30 = text(component, 30);
    expect(at30).toContain('AEO-258');
    expect(at30).toMatch(/Title|Fix login/);

    const at26 = text(component, 26);
    expect(at26).toContain('AEO-258');
    expect(at26).not.toMatch(/^\s+ID\s+/m);
    expect(at26).not.toContain('...');
  });

  it('restores project Priority and Teams when width permits', () => {
    const component = typed('list_projects', { data: { projects: { nodes: [PROJECT] } }, meta });
    const wide = text(component, 200);
    expect(wide).toContain('Priority');
    expect(wide).toContain('Teams');
    expect(wide).toContain('High');
    expect(wide).toContain('AEO');
    expect(wide).toContain('PLATFORM');

    const mid = text(component, 80);
    expect(mid).toContain('Launch board');
    expect(mid).toContain('In Progress');

    const detail = text(typed('get_project', { data: { project: PROJECT }, meta }));
    expect(detail).toContain('In Progress · High ·');
    expect(detail).toContain('AEO, PLATFORM');
  });

  it('does not return a fixed Text for resizable entity lists or details', () => {
    for (const component of [
      typed('list_issues', { data: { issues: { nodes: [{ identifier: 'AEO-1', title: 'One' }] } }, meta }),
      typed('get_issue', { data: { issue: { identifier: 'AEO-1', title: 'One' } }, meta }),
      typed('list_projects', { data: { projects: { nodes: [PROJECT] } }, meta }),
      typed('get_cycle', { data: { cycle: CYCLE }, meta }),
    ]) {
      expect(component).not.toBeInstanceOf(Text);
      expect(component.render(200).join('\n').length).toBeGreaterThan(0);
      expect(component.render(12).join('\n').length).toBeGreaterThan(0);
    }
  });
});

describe('width-role dumps', () => {
  it('captures structured details and tables at every review width', () => {
    const fixtures = {
      cycle: typed('get_cycle', { data: { cycle: CYCLE }, meta }, {}, taggedTheme),
      view: typed('get_view', { data: { customView: VIEW }, meta }, {}, taggedTheme),
      cycles: typed('list_cycles', { data: { cycles: { nodes: [CYCLE] } }, meta }, {}, taggedTheme),
      projects: typed('list_projects', { data: { projects: { nodes: [PROJECT] } }, meta }, {}, taggedTheme),
      teams: typed('list_teams', {
        data: { teams: { nodes: [{ id: 't1', key: 'PLATFORM', name: 'Platform engineering' }] } },
        meta,
      }, {}, taggedTheme),
    };

    for (const [name, component] of Object.entries(fixtures)) {
      for (const width of WIDTHS) {
        const lines = dump(component, width);
        expect(lines.length, `${name}@${width}`).toBeGreaterThan(0);
        const joined = lines.join('\n');
        expect(joined, `${name}@${width}`).not.toContain('...');
        if (name === 'cycle' || name === 'view') {
          expect(joined, `${name}@${width}`).toMatch(/Team|Type|Scope/);
        }
      }
    }
  });
});
