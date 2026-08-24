import { StringEnum } from '@earendil-works/pi-ai';
import { Type } from 'typebox';
import { BATCH_HELP_EXAMPLE, BATCH_PHASED_HELP_EXAMPLE } from './operations';
import { GET_RESULT_PURPOSE } from './result-handles';

export const LINEAR_GRAPHQL_PURPOSE = 'Execute a caller-supplied Linear GraphQL document.';
export const LINEAR_BATCH_PURPOSE = 'Batch independent named Linear operations as flat reads or explicit read and mutation phases.';

export const linearGraphqlParameters = Type.Object({
  query: Type.String({ description: 'GraphQL document to execute.' }),
  variables: Type.Optional(Type.Record(Type.String(), Type.Any(), { description: 'GraphQL variables.' })),
  workspace: Type.Optional(Type.String({ description: 'Stored workspace name, or default/active for normal credential selection.' })),
  sink: Type.Optional(StringEnum(
    ['inline', 'artifact'] as const,
    { description: 'Choose inline output or an artifact file.' },
  )),
  telemetry: Type.Optional(StringEnum(
    ['always'] as const,
    { description: 'Explicitly include rate-limit diagnostics.' },
  )),
}, { additionalProperties: false });

export const LINEAR_GRAPHQL_HELP = {
  name: 'graphql',
  purpose: LINEAR_GRAPHQL_PURPOSE,
  parameters: [
    { name: 'query', type: 'string', required: true },
    { name: 'variables', type: 'Record<string, unknown>', required: false },
    { name: 'workspace', type: 'string', required: false },
    { name: 'sink', type: '"inline" | "artifact"', required: false },
    { name: 'telemetry', type: '"always"', required: false },
  ],
  example: { query: 'query Viewer { viewer { id name } }', variables: {} },
} as const;

const batchEntry = Type.Object({
  key: Type.Optional(Type.String({ pattern: '^[_A-Za-z][_0-9A-Za-z]*$', description: 'Optional unique result key.' })),
  operation: Type.String({ minLength: 1, description: 'Named Linear operation.' }),
  variables: Type.Optional(Type.Record(Type.String(), Type.Any(), { description: 'Arguments for the named operation.' })),
}, { additionalProperties: false });

const batchShared = {
  workspace: Type.Optional(Type.String({ description: 'Stored workspace name, or default/active for normal credential selection.' })),
  sink: Type.Optional(StringEnum(
    ['inline', 'artifact'] as const,
    { description: 'Choose inline output or an artifact file.' },
  )),
  telemetry: Type.Optional(StringEnum(
    ['always'] as const,
    { description: 'Explicitly include rate-limit diagnostics.' },
  )),
};

export const linearBatchParameters = Type.Union([
  Type.Object({
    operations: Type.Array(batchEntry, { minItems: 1, description: 'Independent read operations.' }),
    ...batchShared,
  }, { additionalProperties: false }),
  Type.Object({
    reads: Type.Optional(Type.Array(batchEntry, { minItems: 1, description: 'Read phase.' })),
    mutations: Type.Optional(Type.Array(batchEntry, { minItems: 1, description: 'Mutation phase.' })),
    ...batchShared,
  }, {
    additionalProperties: false,
    anyOf: [{ required: ['reads'] }, { required: ['mutations'] }],
  } as any),
]);

export const LINEAR_BATCH_HELP = {
  name: 'batch',
  purpose: LINEAR_BATCH_PURPOSE,
  entry: { key: 'string?', operation: 'string', variables: 'Record<string, unknown>?' },
  branches: [
    { operations: 'BatchEntry[]', workspace: 'string?', sink: '"inline" | "artifact"?', telemetry: '"always"?' },
    { reads: 'BatchEntry[]?', mutations: 'BatchEntry[]?', workspace: 'string?', sink: '"inline" | "artifact"?', telemetry: '"always"?' },
  ],
  flatExample: BATCH_HELP_EXAMPLE.variables,
  phasedExample: BATCH_PHASED_HELP_EXAMPLE.variables,
} as const;

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
  {
    name: 'linear_graphql',
    helpName: 'graphql',
    purpose: LINEAR_GRAPHQL_PURPOSE,
    initialActive: false,
    deferred: true,
    schemaSource: 'linearGraphqlParameters',
    renderer: 'linearGraphql',
    parameters: linearGraphqlParameters,
  },
  {
    name: 'linear_batch',
    helpName: 'batch',
    purpose: LINEAR_BATCH_PURPOSE,
    initialActive: false,
    deferred: true,
    schemaSource: 'linearBatchParameters',
    renderer: 'linearBatch',
    parameters: linearBatchParameters,
  },
] as const;

export type ExceptionalToolDefinition = (typeof exceptionalToolDefinitions)[number];
