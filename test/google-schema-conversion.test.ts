import { describe, expect, it } from 'vitest';
import { convertTools } from '../node_modules/@earendil-works/pi-ai/dist/api/google-shared.js';
import { typedLinearTools } from '../extensions/typed-tools';
import { linearGetResultTool } from '../extensions/api';
import { parseJsonObject, type JsonObject, type JsonValue } from '../extensions/json';
import { isCompatibilityObject } from '../extensions/operation-types';

const typedTools = typedLinearTools();
const tools = [linearGetResultTool(), ...typedTools];

function declarations(useParameters: boolean): JsonObject[] {
  return (convertTools(tools as any, useParameters, false)?.[0]?.functionDeclarations ?? [])
    .map((declaration) => parseJsonObject(declaration))
    .filter((declaration): declaration is JsonObject => declaration !== undefined);
}

function walk(value: JsonValue | undefined, visit: (node: JsonObject) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit);
    return;
  }
  if (!isCompatibilityObject(value)) return;
  visit(value);
  for (const child of Object.values(value)) walk(child, visit);
}

function parameters(declaration: JsonObject): JsonObject {
  const value = declaration.parametersJsonSchema ?? declaration.parameters;
  const parsed = isCompatibilityObject(value) ? value : undefined;
  if (!parsed) throw new Error(`Missing parameters for ${String(declaration.name)}.`);
  return parsed;
}

describe('Google schema conversion', () => {
  it('converts the direct result schema and all 49 typed schemas through both Google paths', () => {
    expect(typedTools).toHaveLength(49);
    expect(tools).toHaveLength(50);
    for (const useParameters of [false, true]) {
      const converted = declarations(useParameters);
      expect(converted, `useParameters=${useParameters}`).toHaveLength(50);
      for (const declaration of converted) {
        const schema = parameters(declaration);
        expect(declaration.name).toMatch(/^linear_/);
        expect(schema.type, String(declaration.name)).toBe('object');
        expect(schema.properties, String(declaration.name)).toBeTypeOf('object');
      }
    }
  });

  it('keeps string enums, nullable dates, and required object roots representable', () => {
    const jsonSchema = declarations(false);
    const openApi = declarations(true);
    const list = jsonSchema.find((declaration) => declaration.name === 'linear_list_issues')!;
    const listProperties = parameters(list).properties;
    expect(isCompatibilityObject(listProperties) && isCompatibilityObject(listProperties.orderBy)
      ? listProperties.orderBy.enum
      : undefined).toEqual(['createdAt', 'updatedAt']);

    for (const converted of [jsonSchema, openApi]) {
      const save = converted.find((declaration) => declaration.name === 'linear_save_project')!;
      const saveParameters = parameters(save);
      const properties = isCompatibilityObject(saveParameters.properties) ? saveParameters.properties : {};
      expect(saveParameters.type).toBe('object');
      expect(properties.targetDate).toBeTruthy();
      let nullable = false;
      walk(properties.targetDate, (node) => {
        if (node.type === 'null' || Array.isArray(node.enum) && node.enum.includes(null)) nullable = true;
        if (Array.isArray(node.type) && node.type.includes('null')) nullable = true;
        const variants = [node.anyOf, node.oneOf]
          .filter((value): value is readonly JsonValue[] => Array.isArray(value))
          .flat();
        if (variants.some((variant) => isCompatibilityObject(variant) && variant.type === 'null')) nullable = true;
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
