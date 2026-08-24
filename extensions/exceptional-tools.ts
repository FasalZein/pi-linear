import { Type } from 'typebox';
import { GET_RESULT_PURPOSE } from './result-handles';

export const linearGetResultParameters = Type.Object({
  handle: Type.String({ minLength: 1, description: 'Opaque Linear result handle.' }),
  path: Type.Optional(Type.String({
    pattern: '^(?:/(?:[^~/]|~[01])*)*$',
    description: 'RFC 6901 JSON Pointer. Omit or use an empty string for the stored root.',
  })),
  offset: Type.Optional(Type.Integer({ minimum: 0, description: 'Continuation offset returned by an earlier retrieval.' })),
}, { additionalProperties: false });

/** Shipped public tools outside the generated named-operation catalog. */
export const exceptionalToolDefinitions = [
  {
    name: 'linear_get_result',
    helpName: 'get_result',
    purpose: GET_RESULT_PURPOSE,
    initialActive: true,
    deferred: false,
    schemaSource: 'linearGetResultParameters',
    renderer: 'linearGetResult',
    parameters: linearGetResultParameters,
  },
] as const;

export type ExceptionalToolDefinition = (typeof exceptionalToolDefinitions)[number];
