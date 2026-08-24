import { describe, expect, it } from 'vitest';
import { convertTools } from '../node_modules/@earendil-works/pi-ai/dist/api/google-shared.js';
import { typedLinearTools } from '../extensions/typed-tools';
import { linearGetResultTool } from '../extensions/api';

const typedTools = typedLinearTools();
const tools = [linearGetResultTool(), ...typedTools];

function declarations(useParameters: boolean) {
  const converted = convertTools(tools as any, useParameters, false);
  return converted?.[0]?.functionDeclarations ?? [];
}

function walk(value: unknown, visit: (node: Record<string, unknown>) => void): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit);
    return;
  }
  const node = value as Record<string, unknown>;
  visit(node);
  for (const child of Object.values(node)) walk(child, visit);
}

describe('Google schema conversion', () => {
  it('converts the direct result schema and all 49 typed schemas through both Google paths', () => {
    expect(typedTools).toHaveLength(49);
    expect(tools).toHaveLength(50);
    for (const useParameters of [false, true]) {
      const converted = declarations(useParameters);
      expect(converted, `useParameters=${useParameters}`).toHaveLength(50);
      for (const declaration of converted) {
        const parameters = (declaration.parametersJsonSchema ?? declaration.parameters) as Record<string, unknown>;
        expect(declaration.name).toMatch(/^linear_/);
        expect(parameters.type, String(declaration.name)).toBe('object');
        expect(parameters.properties, String(declaration.name)).toBeTypeOf('object');
      }
    }
  });

  it('keeps string enums, nullable dates, and required object roots representable', () => {
    const jsonSchema = declarations(false);
    const openApi = declarations(true);
    const list = jsonSchema.find((declaration) => declaration.name === 'linear_list_issues')!;
    const listParameters = (list.parametersJsonSchema ?? list.parameters) as any;
    expect(listParameters.properties.orderBy.enum).toEqual(['createdAt', 'updatedAt']);

    for (const converted of [jsonSchema, openApi]) {
      const save = converted.find((declaration) => declaration.name === 'linear_save_project')!;
      const parameters = (save.parametersJsonSchema ?? save.parameters) as any;
      expect(parameters.type).toBe('object');
      expect(parameters.properties.targetDate).toBeTruthy();
      let nullable = false;
      walk(parameters.properties.targetDate, (node) => {
        if (node.type === 'null' || node.enum && Array.isArray(node.enum) && node.enum.includes(null)) nullable = true;
        if (Array.isArray(node.type) && node.type.includes('null')) nullable = true;
        if (Array.isArray(node.anyOf) || Array.isArray(node.oneOf)) {
          const variants = [...(node.anyOf as unknown[] ?? []), ...(node.oneOf as unknown[] ?? [])];
          if (variants.some((variant) => variant && typeof variant === 'object' && (variant as any).type === 'null')) {
            nullable = true;
          }
        }
      });
      expect(nullable, 'save_project targetDate remains nullable').toBe(true);
    }
  });

  it('keeps local required and save-mode checks after conversion', () => {
    const comment = tools.find((tool) => tool.name === 'linear_create_comment')!;
    const save = tools.find((tool) => tool.name === 'linear_save_project')!;
    expect(() => comment.prepareArguments?.({})).toThrow(/Invalid arguments for "linear_create_comment"/);
    expect(() => save.prepareArguments?.({ projectId: '11111111-1111-4111-8111-111111111111' })).toThrow(
      /Invalid arguments for "linear_save_project"/,
    );
    expect(declarations(false).map((declaration) => declaration.name)).toEqual(tools.map((tool) => tool.name));
    expect(declarations(true).map((declaration) => declaration.name)).toEqual(tools.map((tool) => tool.name));
  });
});
