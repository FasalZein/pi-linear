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

export function requestEvidence(): RequestEvidence {
  return { total: 0, query: 0, mutation: 0, documents: [] };
}

async function serializedBody(input: RequestInfo | URL, init?: RequestInit): Promise<string> {
  if (typeof init?.body === 'string') return init.body;
  if (typeof Request !== 'undefined' && input instanceof Request) return await input.clone().text();
  throw new Error('request-recorder: serialized GraphQL request body is missing');
}

export function recordingTransport(
  delegate: LinearTransport,
  evidence: RequestEvidence,
  rejectMutations = true,
): LinearTransport {
  return async (input, init) => {
    const body = JSON.parse(await serializedBody(input, init)) as { query?: unknown };
    if (typeof body.query !== 'string') throw new Error('request-recorder: GraphQL query is missing');
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
    evidence[operationType === 'mutation' ? 'mutation' : 'query']++;
    evidence.documents.push(record);
    if (rejectMutations && operationType === 'mutation') {
      throw new Error('request-recorder: mutation request rejected before network transmission');
    }
    return delegate(input, init);
  };
}

export function assertReadOnlyEvidence(evidence: RequestEvidence): void {
  if (evidence.mutation !== 0) throw new Error(`request-recorder: expected zero mutation requests, actual ${evidence.mutation}`);
  if (evidence.total !== evidence.query) {
    throw new Error(`request-recorder: expected total ${evidence.total} to equal query ${evidence.query}`);
  }
  if (evidence.documents.some(({ operationType, documentSha256 }) =>
    !operationType || !/^[0-9a-f]{64}$/.test(documentSha256))) {
    throw new Error('request-recorder: incomplete request evidence');
  }
}
