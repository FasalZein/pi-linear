import { Kind, parse, type OperationDefinitionNode } from 'graphql';
import type { LinearTransport } from '../extensions/client';
import { sha256 } from './readonly-schema';

export type RecordedRequest = {
  operationType: 'query' | 'mutation' | 'subscription';
  operationName: string | null;
  documentSha256: string;
};

export type RequestEvidence = {
  total: number;
  query: number;
  mutation: number;
  documents: RecordedRequest[];
};

export type GraphQLRequestBody = {
  query: string;
};

export function requestEvidence(): RequestEvidence {
  return { total: 0, query: 0, mutation: 0, documents: [] };
}

function missingSerializedBody(): never {
  throw new Error('request-recorder: serialized GraphQL request body is missing');
}

function requestBodyText(body: BodyInit): string {
  if (body instanceof Blob) missingSerializedBody();
  if (body instanceof FormData) missingSerializedBody();
  if (body instanceof URLSearchParams) missingSerializedBody();
  if (body instanceof ReadableStream) missingSerializedBody();
  if (body instanceof ArrayBuffer) missingSerializedBody();
  if (ArrayBuffer.isView(body)) missingSerializedBody();
  return body;
}

async function serializedBody(input: RequestInfo | URL, init?: RequestInit): Promise<string> {
  if (init?.body != null) return requestBodyText(init.body);
  if (input instanceof Request) return await input.clone().text();
  missingSerializedBody();
}

function readGraphQLRequestBody(value: GraphQLRequestBody): GraphQLRequestBody {
  if (value.query === `${value.query}`) return { query: value.query };
  throw new Error('request-recorder: GraphQL query is missing');
}

export function parseGraphQLRequestBody(source: string): GraphQLRequestBody {
  return readGraphQLRequestBody(JSON.parse(source));
}

export function recordingTransport(
  delegate: LinearTransport,
  evidence: RequestEvidence,
): LinearTransport {
  return async (input, init) => {
    const body = parseGraphQLRequestBody(await serializedBody(input, init));
    const definitions = parse(body.query).definitions.filter(
      (entry): entry is OperationDefinitionNode => entry.kind === Kind.OPERATION_DEFINITION,
    );
    if (definitions.length !== 1) throw new Error('request-recorder: exactly one GraphQL operation is required');
    const definition = definitions[0]!;
    const operationType = definition.operation;
    const record = {
      operationType,
      operationName: definition.name?.value ?? null,
      documentSha256: sha256(body.query),
    } satisfies RecordedRequest;
    evidence.total++;
    if (operationType === 'query') evidence.query++;
    if (operationType === 'mutation') evidence.mutation++;
    evidence.documents.push(record);
    if (operationType === 'mutation') {
      throw new Error('request-recorder: mutation request rejected before network transmission');
    }
    if (operationType === 'subscription') {
      throw new Error('request-recorder: subscription request rejected before network transmission');
    }
    return delegate(input, init);
  };
}

export function assertReadOnlyEvidence(evidence: RequestEvidence): void {
  if (evidence.mutation !== 0) throw new Error(`request-recorder: expected zero mutation requests, actual ${evidence.mutation}`);
  if (evidence.total !== evidence.query || evidence.total !== evidence.documents.length) {
    throw new Error(`request-recorder: expected total ${evidence.total} to equal query ${evidence.query} and documents ${evidence.documents.length}`);
  }
  if (evidence.documents.some(({ operationType, documentSha256 }) =>
    !operationType || !/^[0-9a-f]{64}$/.test(documentSha256))) {
    throw new Error('request-recorder: incomplete request evidence');
  }
}
