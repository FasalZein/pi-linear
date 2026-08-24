import { createHash } from 'node:crypto';
import {
  buildClientSchema,
  getNamedType,
  isEnumType,
  isInputObjectType,
  isObjectType,
  isScalarType,
  parse,
  validate,
  type GraphQLSchema,
  type IntrospectionQuery,
  type OperationDefinitionNode,
  type TypeNode,
} from 'graphql';
import type { LinearOperation } from '../extensions/operations';

export type PackageGraphQLDocument = {
  id: string;
  sourceClass: string;
  operationType: 'query' | 'mutation' | 'subscription';
  operationName: string | null;
  rootFields: readonly string[];
  variables: Readonly<Record<string, string>>;
  document: string;
  sha256: string;
};
export type PackageGraphQLInventory = {
  schemaVersion: 1;
  exclusions: readonly { id: string; reason: string }[];
  documents: readonly PackageGraphQLDocument[];
};

export function validateDocumentsAgainstSchema(
  schema: GraphQLSchema,
  inventory: PackageGraphQLInventory,
): void {
  for (const descriptor of inventory.documents) {
    if (sha256(descriptor.document) !== descriptor.sha256) {
      throw new Error(`documents.${descriptor.id}: document hash does not match`);
    }
    const document = parse(descriptor.document);
    const errors = validate(schema, document);
    if (errors.length) {
      throw new Error(`documents.${descriptor.id}: ${errors.map(({ message }) => message).join('; ')}`);
    }
  }
}

export function validatePackageDocuments(
  introspection: IntrospectionQuery,
  inventory: PackageGraphQLInventory,
): void {
  validateDocumentsAgainstSchema(buildClientSchema(introspection), inventory);
}

export type RootKind = 'Query' | 'Mutation';
export type ReadonlySchemaScope = {
  schemaVersion: 1;
  endpoint: string;
  schemaIdentity: { queryType: string; mutationType: string };
  roots: Record<RootKind, string[]>;
  mutationPayloadFields: Record<string, string[]>;
};
export type RootContract = {
  returns: string;
  arguments: Record<string, string>;
  selectedPayloadFields?: string[];
};
export type ReadonlySchemaProvenance = {
  captureDate: string;
  endpoint: string;
  schemaIdentity: { queryType: string; mutationType: string };
  sourceQuery: string;
  sourceQuerySha256: string;
  scope: string;
  scopeSha256: string;
  normalizedSha256: string;
  requests?: import('./request-recorder').RequestEvidence;
};
export type ReadonlySchemaFixture = {
  schemaVersion: 1;
  provenance: ReadonlySchemaProvenance;
  roots: Record<RootKind, Record<string, RootContract>>;
  inputs: Record<string, { kind: 'INPUT_OBJECT'; fields: Record<string, string> }>;
  enums: Record<string, { kind: 'ENUM'; values: string[] }>;
  objects: Record<string, { kind: 'OBJECT'; fields: Record<string, string> }>;
  scalars: Record<string, { kind: 'SCALAR' }>;
};

type CatalogRoot = { arguments: Record<string, string>; selectedFields: string[] };
export type CatalogSchemaUsage = {
  roots: Record<RootKind, Record<string, CatalogRoot>>;
  namedTypes: string[];
  mutationPayloadFields: Record<string, string[]>;
};

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => [key, stableValue(child)]));
}

export function normalizedFixtureDigest(fixture: Omit<ReadonlySchemaFixture, 'provenance'>): string {
  return sha256(JSON.stringify(stableValue(fixture)));
}

function astTypeSignature(type: TypeNode): string {
  if (type.kind === 'NamedType') return type.name.value;
  if (type.kind === 'ListType') return `[${astTypeSignature(type.type)}]`;
  return `${astTypeSignature(type.type)}!`;
}

function terminalName(type: TypeNode): string {
  return type.kind === 'NamedType' ? type.name.value : terminalName(type.type);
}

function operationDocuments(operation: LinearOperation): string[] {
  return operation.variants?.map((variant) => variant.document) ?? [operation.document];
}

function recordSignature(value: Record<string, string>): string {
  return JSON.stringify(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)));
}

export function catalogSchemaUsage(operations: readonly LinearOperation[]): CatalogSchemaUsage {
  const roots: CatalogSchemaUsage['roots'] = { Query: {}, Mutation: {} };
  const namedTypes = new Set<string>();
  const mutationPayloadFields: Record<string, string[]> = {};

  for (const operation of operations) {
    if (operation.executeLocal) continue;
    for (const document of operationDocuments(operation)) {
      const definition = parse(document).definitions.find(
        (entry): entry is OperationDefinitionNode => entry.kind === 'OperationDefinition',
      );
      if (!definition) throw new Error(`catalog.${operation.name}: GraphQL operation definition is missing`);
      const rootKind: RootKind = definition.operation === 'mutation' ? 'Mutation' : 'Query';
      const variableTypes = new Map((definition.variableDefinitions ?? []).map((entry) => {
        namedTypes.add(terminalName(entry.type));
        return [entry.variable.name.value, astTypeSignature(entry.type)] as const;
      }));

      for (const selection of definition.selectionSet.selections) {
        if (selection.kind !== 'Field') continue;
        const fieldName = selection.name.value;
        const args: Record<string, string> = {};
        for (const argument of selection.arguments ?? []) {
          if (argument.value.kind !== 'Variable') {
            throw new Error(`catalog.${operation.name}.${fieldName}.${argument.name.value}: literal root arguments are unsupported`);
          }
          const signature = variableTypes.get(argument.value.name.value);
          if (!signature) throw new Error(`catalog.${operation.name}.${fieldName}.${argument.name.value}: variable type is missing`);
          args[argument.name.value] = signature;
        }
        const selectedFields = (selection.selectionSet?.selections ?? [])
          .filter((entry) => entry.kind === 'Field')
          .map((entry) => entry.name.value);
        const previous = roots[rootKind][fieldName];
        if (previous && recordSignature(previous.arguments) !== recordSignature(args)) {
          throw new Error(`catalog.${rootKind}.${fieldName}: inconsistent root arguments`);
        }
        roots[rootKind][fieldName] = { arguments: args, selectedFields };
        if (rootKind === 'Mutation') {
          mutationPayloadFields[fieldName] = [...new Set([
            ...(mutationPayloadFields[fieldName] ?? []),
            ...selectedFields,
          ])].sort();
        }
      }
    }
  }

  return { roots, namedTypes: [...namedTypes].sort(), mutationPayloadFields };
}

function schemaRoot(schema: GraphQLSchema, kind: RootKind) {
  return kind === 'Query' ? schema.getQueryType() : schema.getMutationType();
}

export function schemaFixtureFromIntrospection(
  introspection: IntrospectionQuery,
  scope: ReadonlySchemaScope,
  provenance: Omit<ReadonlySchemaProvenance, 'normalizedSha256'>,
): ReadonlySchemaFixture {
  const schema = buildClientSchema(introspection);
  const queryType = schema.getQueryType()?.name;
  const mutationType = schema.getMutationType()?.name;
  if (queryType !== scope.schemaIdentity.queryType || mutationType !== scope.schemaIdentity.mutationType) {
    throw new Error(`schema.identity: expected ${scope.schemaIdentity.queryType}/${scope.schemaIdentity.mutationType}, actual ${queryType ?? '<missing>'}/${mutationType ?? '<missing>'}`);
  }

  const roots = { Query: {}, Mutation: {} } as ReadonlySchemaFixture['roots'];
  const referencedNames = new Set<string>();
  const payloadTypes = new Map<string, string[]>();

  for (const kind of ['Query', 'Mutation'] as const) {
    const root = schemaRoot(schema, kind)!;
    for (const fieldName of scope.roots[kind]) {
      const field = root.getFields()[fieldName];
      if (!field) throw new Error(`schema.${kind}.${fieldName}: root field is missing`);
      const args = Object.fromEntries(field.args.map((argument) => {
        referencedNames.add(getNamedType(argument.type).name);
        return [argument.name, String(argument.type)];
      }));
      const selectedPayloadFields = kind === 'Mutation'
        ? [...(scope.mutationPayloadFields[fieldName] ?? [])].sort()
        : undefined;
      roots[kind][fieldName] = {
        returns: String(field.type),
        arguments: args,
        ...(selectedPayloadFields ? { selectedPayloadFields } : {}),
      };
      const returnName = getNamedType(field.type).name;
      referencedNames.add(returnName);
      if (selectedPayloadFields) payloadTypes.set(returnName, selectedPayloadFields);
    }
  }

  const inputs: ReadonlySchemaFixture['inputs'] = {};
  const enums: ReadonlySchemaFixture['enums'] = {};
  const objects: ReadonlySchemaFixture['objects'] = {};
  const scalars: ReadonlySchemaFixture['scalars'] = {};
  const queue = [...referencedNames];
  const visited = new Set<string>();

  while (queue.length) {
    const name = queue.shift()!;
    if (visited.has(name)) continue;
    visited.add(name);
    const type = schema.getType(name);
    if (!type) throw new Error(`schema.types.${name}: named type is missing`);
    if (isInputObjectType(type)) {
      inputs[name] = { kind: 'INPUT_OBJECT', fields: Object.fromEntries(Object.values(type.getFields()).map((field) => {
        queue.push(getNamedType(field.type).name);
        return [field.name, String(field.type)];
      })) };
    } else if (isEnumType(type)) {
      enums[name] = { kind: 'ENUM', values: type.getValues().map((value) => value.name).sort() };
    } else if (isScalarType(type)) {
      scalars[name] = { kind: 'SCALAR' };
    } else if (isObjectType(type)) {
      const requested = payloadTypes.get(name) ?? [];
      objects[name] = { kind: 'OBJECT', fields: Object.fromEntries(requested.map((fieldName) => {
        const field = type.getFields()[fieldName];
        if (!field) throw new Error(`schema.objects.${name}.${fieldName}: payload field is missing`);
        queue.push(getNamedType(field.type).name);
        return [fieldName, String(field.type)];
      })) };
    }
  }

  const contract = { schemaVersion: 1 as const, roots, inputs, enums, objects, scalars };
  return { ...contract, provenance: { ...provenance, normalizedSha256: normalizedFixtureDigest(contract) } };
}

function sameSet(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

function signatureError(path: string, expected: unknown, actual: unknown): Error {
  const show = (value: unknown) => value === undefined ? '<missing>' : JSON.stringify(value);
  return new Error(`${path}: expected ${show(expected)}, actual ${show(actual)}`);
}

function fixtureScope(fixture: ReadonlySchemaFixture): ReadonlySchemaScope {
  return {
    schemaVersion: 1,
    endpoint: fixture.provenance.endpoint,
    schemaIdentity: fixture.provenance.schemaIdentity,
    roots: {
      Query: Object.keys(fixture.roots.Query).sort(),
      Mutation: Object.keys(fixture.roots.Mutation).sort(),
    },
    mutationPayloadFields: Object.fromEntries(Object.entries(fixture.roots.Mutation)
      .map(([root, contract]) => [root, [...(contract.selectedPayloadFields ?? [])].sort()])),
  };
}

export function assertFixtureProvenance(
  fixture: ReadonlySchemaFixture,
  scope: ReadonlySchemaScope,
  sourceQuery: string,
  scopeSource: string,
): void {
  const contract = {
    schemaVersion: fixture.schemaVersion,
    roots: fixture.roots,
    inputs: fixture.inputs,
    enums: fixture.enums,
    objects: fixture.objects,
    scalars: fixture.scalars,
  };
  if (fixture.provenance.sourceQuerySha256 !== sha256(sourceQuery)) {
    throw signatureError('fixture.provenance.sourceQuerySha256', fixture.provenance.sourceQuerySha256, sha256(sourceQuery));
  }
  if (fixture.provenance.scopeSha256 !== sha256(scopeSource)) {
    throw signatureError('fixture.provenance.scopeSha256', fixture.provenance.scopeSha256, sha256(scopeSource));
  }
  if (fixture.provenance.normalizedSha256 !== normalizedFixtureDigest(contract)) {
    throw signatureError('fixture.provenance.normalizedSha256', fixture.provenance.normalizedSha256, normalizedFixtureDigest(contract));
  }
  if (JSON.stringify(stableValue(fixtureScope(fixture))) !== JSON.stringify(stableValue(scope))) {
    throw signatureError('fixture.provenance.scope', scope, fixtureScope(fixture));
  }
}

export function compareReadonlySchema(
  introspection: IntrospectionQuery,
  fixture: ReadonlySchemaFixture,
  usage: CatalogSchemaUsage,
  scope: ReadonlySchemaScope = fixtureScope(fixture),
): void {
  for (const kind of ['Query', 'Mutation'] as const) {
    const catalogNames = Object.keys(usage.roots[kind]).sort();
    const fixtureNames = Object.keys(fixture.roots[kind]).sort();
    if (!sameSet(catalogNames, fixtureNames)) throw signatureError(`catalog.${kind}.roots`, fixtureNames, catalogNames);
    for (const name of catalogNames) {
      const catalogArguments = usage.roots[kind][name].arguments;
      const fixtureArguments = fixture.roots[kind][name].arguments;
      const catalogArgumentNames = Object.keys(catalogArguments).sort();
      for (const argument of catalogArgumentNames) {
        if (catalogArguments[argument] !== fixtureArguments[argument]) {
          throw signatureError(`catalog.${kind}.${name}.arguments.${argument}`, fixtureArguments[argument], catalogArguments[argument]);
        }
      }
      if (kind === 'Mutation') {
        const expectedFields = [...(fixture.roots.Mutation[name].selectedPayloadFields ?? [])].sort();
        const actualFields = [...(usage.mutationPayloadFields[name] ?? [])].sort();
        if (!sameSet(actualFields, expectedFields)) {
          throw signatureError(`catalog.Mutation.${name}.payloadFields`, expectedFields, actualFields);
        }
      }
    }
  }

  const fixtureNames = new Set([
    ...Object.keys(fixture.inputs), ...Object.keys(fixture.enums),
    ...Object.keys(fixture.objects), ...Object.keys(fixture.scalars),
  ]);
  for (const name of usage.namedTypes) {
    if (!fixtureNames.has(name)) throw signatureError(`catalog.types.${name}.kind`, 'fixture kind', undefined);
  }

  const { normalizedSha256: _digest, ...provenance } = fixture.provenance;
  const actual = schemaFixtureFromIntrospection(introspection, scope, provenance);
  for (const kind of ['Query', 'Mutation'] as const) {
    for (const [rootName, expected] of Object.entries(fixture.roots[kind])) {
      const found = actual.roots[kind][rootName];
      if (!found) throw signatureError(`schema.${kind}.${rootName}`, expected, undefined);
      if (found.returns !== expected.returns) throw signatureError(`schema.${kind}.${rootName}.returns`, expected.returns, found.returns);
      const expectedArgumentNames = Object.keys(expected.arguments).sort();
      const actualArgumentNames = Object.keys(found.arguments).sort();
      if (!sameSet(actualArgumentNames, expectedArgumentNames)) {
        throw signatureError(`schema.${kind}.${rootName}.arguments`, expectedArgumentNames, actualArgumentNames);
      }
      for (const [argument, signature] of Object.entries(expected.arguments)) {
        if (found.arguments[argument] !== signature) {
          throw signatureError(`schema.${kind}.${rootName}.arguments.${argument}`, signature, found.arguments[argument]);
        }
      }
    }
  }
  for (const [name, expected] of Object.entries(fixture.inputs)) {
    const found = actual.inputs[name];
    if (!found) throw signatureError(`schema.types.${name}.kind`, expected.kind, undefined);
    const expectedFields = Object.keys(expected.fields).sort();
    const actualFields = Object.keys(found.fields).sort();
    if (!sameSet(actualFields, expectedFields)) throw signatureError(`schema.types.${name}.fields`, expectedFields, actualFields);
    for (const [field, signature] of Object.entries(expected.fields)) {
      if (found.fields[field] !== signature) throw signatureError(`schema.types.${name}.fields.${field}`, signature, found.fields[field]);
    }
  }
  for (const [name, expected] of Object.entries(fixture.enums)) {
    const found = actual.enums[name];
    if (!found) throw signatureError(`schema.types.${name}.kind`, expected.kind, undefined);
    if (!sameSet(found.values, expected.values)) throw signatureError(`schema.types.${name}.values`, expected.values, found.values);
  }
  for (const [name, expected] of Object.entries(fixture.objects)) {
    const found = actual.objects[name];
    if (!found) throw signatureError(`schema.types.${name}.kind`, expected.kind, undefined);
    const expectedFields = Object.keys(expected.fields).sort();
    const actualFields = Object.keys(found.fields).sort();
    if (!sameSet(actualFields, expectedFields)) throw signatureError(`schema.types.${name}.fields`, expectedFields, actualFields);
    for (const [field, signature] of Object.entries(expected.fields)) {
      if (found.fields[field] !== signature) throw signatureError(`schema.types.${name}.fields.${field}`, signature, found.fields[field]);
    }
  }
  for (const name of Object.keys(fixture.scalars)) {
    if (!actual.scalars[name]) throw signatureError(`schema.types.${name}.kind`, 'SCALAR', undefined);
  }
}
