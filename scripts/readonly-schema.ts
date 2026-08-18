import {
  buildClientSchema,
  getNamedType,
  isEnumType,
  isInputObjectType,
  isObjectType,
  isScalarType,
  parse,
  type GraphQLInputType,
  type GraphQLSchema,
  type IntrospectionQuery,
  type OperationDefinitionNode,
  type TypeNode,
} from 'graphql';
import type { LinearOperation } from '../extensions/operations';

export type RootKind = 'Query' | 'Mutation';
export type RootContract = {
  returns: string;
  arguments: Record<string, string>;
};
export type InputContract = {
  kind: 'INPUT_OBJECT';
  fields: Record<string, string>;
};
export type EnumContract = {
  kind: 'ENUM';
  values: string[];
};
export type ObjectContract = {
  kind: 'OBJECT';
  fields: Record<string, string>;
};
export type ScalarContract = { kind: 'SCALAR' };
export type ReadonlySchemaFixture = {
  schemaVersion: 1;
  capturedAt: string;
  roots: Record<RootKind, Record<string, RootContract>>;
  inputs: Record<string, InputContract>;
  enums: Record<string, EnumContract>;
  objects: Record<string, ObjectContract>;
  scalars: Record<string, ScalarContract>;
};

type CatalogRoot = { arguments: Record<string, string>; selectedFields: string[] };
export type CatalogSchemaUsage = {
  roots: Record<RootKind, Record<string, CatalogRoot>>;
  namedTypes: string[];
  mutationPayloadFields: Record<string, string[]>;
};

function typeSignature(type: GraphQLInputType): string {
  return String(type);
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
      const variableTypes = new Map(
        (definition.variableDefinitions ?? []).map((entry) => {
          namedTypes.add(terminalName(entry.type));
          return [entry.variable.name.value, astTypeSignature(entry.type)] as const;
        }),
      );

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

  return {
    roots,
    namedTypes: [...namedTypes].sort(),
    mutationPayloadFields,
  };
}

function schemaRoot(schema: GraphQLSchema, kind: RootKind) {
  return kind === 'Query' ? schema.getQueryType() : schema.getMutationType();
}

export function schemaFixtureFromIntrospection(
  introspection: IntrospectionQuery,
  usage: CatalogSchemaUsage,
  capturedAt: string,
): ReadonlySchemaFixture {
  const schema = buildClientSchema(introspection);
  const roots = { Query: {}, Mutation: {} } as ReadonlySchemaFixture['roots'];
  const referencedNames = new Set(usage.namedTypes);
  const payloadTypes = new Map<string, string[]>();

  for (const kind of ['Query', 'Mutation'] as const) {
    const root = schemaRoot(schema, kind);
    if (!root) throw new Error(`schema.${kind}: root type is missing`);
    for (const [fieldName, expected] of Object.entries(usage.roots[kind])) {
      const field = root.getFields()[fieldName];
      if (!field) throw new Error(`schema.${kind}.${fieldName}: root field is missing`);
      const args = Object.fromEntries(Object.keys(expected.arguments).map((name) => {
        const argument = field.args.find((entry) => entry.name === name);
        if (!argument) throw new Error(`schema.${kind}.${fieldName}.${name}: root argument is missing`);
        const named = getNamedType(argument.type);
        referencedNames.add(named.name);
        return [name, typeSignature(argument.type)];
      }));
      roots[kind][fieldName] = { returns: String(field.type), arguments: args };
      referencedNames.add(getNamedType(field.type).name);
      if (kind === 'Mutation') {
        payloadTypes.set(getNamedType(field.type).name, usage.mutationPayloadFields[fieldName] ?? []);
      }
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
      const fields = Object.fromEntries(Object.values(type.getFields()).map((field) => {
        queue.push(getNamedType(field.type).name);
        return [field.name, String(field.type)];
      }));
      inputs[name] = { kind: 'INPUT_OBJECT', fields };
    } else if (isEnumType(type)) {
      enums[name] = { kind: 'ENUM', values: type.getValues().map((value) => value.name).sort() };
    } else if (isScalarType(type)) {
      scalars[name] = { kind: 'SCALAR' };
    } else if (isObjectType(type)) {
      const requested = payloadTypes.get(name) ?? [];
      const fields = Object.fromEntries(requested.map((fieldName) => {
        const field = type.getFields()[fieldName];
        if (!field) throw new Error(`schema.objects.${name}.${fieldName}: payload field is missing`);
        queue.push(getNamedType(field.type).name);
        return [fieldName, String(field.type)];
      }));
      objects[name] = { kind: 'OBJECT', fields };
    }
  }

  return { schemaVersion: 1, capturedAt, roots, inputs, enums, objects, scalars };
}

function sameSet(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

function signatureError(path: string, expected: unknown, actual: unknown): Error {
  const show = (value: unknown) => value === undefined ? '<missing>' : JSON.stringify(value);
  return new Error(`${path}: expected ${show(expected)}, actual ${show(actual)}`);
}

export function compareReadonlySchema(
  introspection: IntrospectionQuery,
  fixture: ReadonlySchemaFixture,
  usage: CatalogSchemaUsage,
): void {
  for (const kind of ['Query', 'Mutation'] as const) {
    const catalogNames = Object.keys(usage.roots[kind]).sort();
    const fixtureNames = Object.keys(fixture.roots[kind]).sort();
    if (!sameSet(catalogNames, fixtureNames)) {
      throw signatureError(`catalog.${kind}.roots`, fixtureNames, catalogNames);
    }
    for (const name of catalogNames) {
      const catalogArguments = usage.roots[kind][name].arguments;
      const fixtureArguments = fixture.roots[kind][name].arguments;
      const catalogArgumentNames = Object.keys(catalogArguments).sort();
      const fixtureArgumentNames = Object.keys(fixtureArguments).sort();
      if (!sameSet(catalogArgumentNames, fixtureArgumentNames)) {
        throw signatureError(`catalog.${kind}.${name}.arguments`, fixtureArgumentNames, catalogArgumentNames);
      }
      for (const argument of catalogArgumentNames) {
        if (catalogArguments[argument] !== fixtureArguments[argument]) {
          throw signatureError(
            `catalog.${kind}.${name}.arguments.${argument}`,
            fixtureArguments[argument],
            catalogArguments[argument],
          );
        }
      }
    }
  }

  const fixtureNames = new Set([
    ...Object.keys(fixture.inputs),
    ...Object.keys(fixture.enums),
    ...Object.keys(fixture.objects),
    ...Object.keys(fixture.scalars),
  ]);
  for (const name of usage.namedTypes) {
    if (!fixtureNames.has(name)) throw signatureError(`catalog.types.${name}.kind`, 'fixture kind', undefined);
  }

  const actual = schemaFixtureFromIntrospection(introspection, usage, fixture.capturedAt);
  for (const kind of ['Query', 'Mutation'] as const) {
    for (const [rootName, expected] of Object.entries(fixture.roots[kind])) {
      const found = actual.roots[kind][rootName];
      if (!found) throw signatureError(`schema.${kind}.${rootName}`, expected, undefined);
      if (found.returns !== expected.returns) {
        throw signatureError(`schema.${kind}.${rootName}.returns`, expected.returns, found.returns);
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
    if (!sameSet(actualFields, expectedFields)) {
      throw signatureError(`schema.types.${name}.fields`, expectedFields, actualFields);
    }
    for (const [field, signature] of Object.entries(expected.fields)) {
      if (found.fields[field] !== signature) {
        throw signatureError(`schema.types.${name}.fields.${field}`, signature, found.fields[field]);
      }
    }
  }
  for (const [name, expected] of Object.entries(fixture.enums)) {
    const found = actual.enums[name];
    if (!found) throw signatureError(`schema.types.${name}.kind`, expected.kind, undefined);
    if (!sameSet(found.values, expected.values)) {
      throw signatureError(`schema.types.${name}.values`, expected.values, found.values);
    }
  }
  for (const [name, expected] of Object.entries(fixture.objects)) {
    const found = actual.objects[name];
    if (!found) throw signatureError(`schema.types.${name}.kind`, expected.kind, undefined);
    for (const [field, signature] of Object.entries(expected.fields)) {
      if (found.fields[field] !== signature) {
        throw signatureError(`schema.types.${name}.fields.${field}`, signature, found.fields[field]);
      }
    }
  }
  for (const name of Object.keys(fixture.scalars)) {
    if (!actual.scalars[name]) throw signatureError(`schema.types.${name}.kind`, 'SCALAR', undefined);
  }
}
