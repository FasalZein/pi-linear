import { visibleWidth } from '@earendil-works/pi-tui';
import { describe, expect, it } from 'vitest';
import { getOperation } from '../extensions/operations';
import { operationRenderers, renderLinearApiCall } from '../extensions/renderers';
import { formatToolArgValue, LinearBlockComponent } from '../extensions/renderers/common';
import type { JsonObject } from '../extensions/runtime';

const theme = {
  fg: (_role: string, text: string) => text,
  bg: (_role: string, text: string) => text,
  bold: (text: string) => text,
  italic: (text: string) => text,
  underline: (text: string) => text,
} as any;

const MARKDOWN = [
  '## Release notes',
  '',
  '- one fix',
  '- one regression guard',
].join('\n');

const COMMENT_ID = '11111111-1111-4111-8111-111111111111';

function callRow(args: JsonObject, width: number): string[] {
  const renderers = operationRenderers(getOperation('update_comment'));
  return renderers.renderCall(args, theme, {} as any).render(width);
}

function expectOneRowWithinWidth(lines: string[], width: number) {
  expect(lines).toHaveLength(1);
  for (const line of lines) {
    expect(line).not.toMatch(/[\r\n]/);
    expect(visibleWidth(line)).toBeLessThanOrEqual(width);
  }
}

describe('multiline tool arguments stay in one row', () => {
  it('renders update_comment with multiline Markdown as one row at narrow and wide widths', () => {
    for (const width of [40, 120]) {
      const row = callRow({ id: COMMENT_ID, body: MARKDOWN }, width);
      expectOneRowWithinWidth(row, width);
      expect(row[0]).toContain('linear_update_comment');
    }

    const wide = callRow({ id: COMMENT_ID, body: MARKDOWN }, 120);
    expect(wide[0]).toContain('Release notes');
    expect(wide[0]).toContain('one fix');

    const narrow = callRow({ body: MARKDOWN }, 40);
    expectOneRowWithinWidth(narrow, 40);
    expect(narrow[0]).toContain('body="## Releas');

    const mid = callRow({ body: MARKDOWN }, 80);
    expectOneRowWithinWidth(mid, 80);
    expect(mid[0]).toContain('Release notes - one fix');
  });

  it('keeps a short CRLF argument readable inside the row', () => {
    const row = callRow({ body: 'a\r\nb' }, 40);
    expectOneRowWithinWidth(row, 40);
    expect(row[0]).toContain('body="a b"');
  });

  it('collapses multiline whitespace in formatToolArgValue before quoting and truncation', () => {
    expect(formatToolArgValue('a\nb')).toBe('"a b"');
    expect(formatToolArgValue('a\r\n\rb')).toBe('"a b"');
    expect(formatToolArgValue('a\tb')).toBe('"a b"');
    expect(formatToolArgValue(' - \n one\n\n- two ')).toBe('"- one - two"');

    const clipped = formatToolArgValue(`first\n${'x'.repeat(60)}`)!;
    expect(clipped.endsWith('…"')).toBe(true);
    expect(clipped).not.toMatch(/[\r\n]/);
    expect(clipped.length - 2).toBeLessThanOrEqual(48);

    expect(formatToolArgValue('  \n\t ')).toBeUndefined();
  });

  it('keeps the block renderer free of embedded CR and LF as a final defence', () => {
    expect(new LinearBlockComponent(['a\nb']).render(40)).toEqual(['a b']);
    expect(new LinearBlockComponent(['a\rb']).render(40)).toEqual(['a b']);
    expect(new LinearBlockComponent(['a\r\nb']).render(40)).toEqual(['a b']);

    const clipped = new LinearBlockComponent(['ab\ncd']).render(2);
    for (const line of clipped) {
      expect(line).not.toMatch(/[\r\n]/);
      expect(visibleWidth(line)).toBeLessThanOrEqual(2);
    }
  });

  it('still scrubs credentials carried inside multiline arguments', () => {
    const token = 'lin_api_secret123456789';
    const typed = callRow({ body: `${token}\nnext line` }, 120);
    expectOneRowWithinWidth(typed, 120);
    expect(typed[0]).toContain('[REDACTED]');
    expect(typed[0]).not.toContain('secret123456789');

    const api = renderLinearApiCall(
      { operation: 'help', variables: { operation: token } },
      theme,
    ).render(120);
    expectOneRowWithinWidth(api, 120);
    expect(api[0]).toContain('[REDACTED]');
    expect(api[0]).not.toContain('secret123456789');
  });
});
