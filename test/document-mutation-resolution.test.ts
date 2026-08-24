import { afterEach, describe, expect, it, vi } from 'vitest';
import { typedLinearTools } from '../extensions/typed-tools';
import { isolateLinearCredentials } from './helpers/credentials';

isolateLinearCredentials();

const DOCUMENT_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ID = '22222222-2222-4222-8222-222222222222';
const originalApiKey = process.env.LINEAR_API_KEY;

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalApiKey === undefined) delete process.env.LINEAR_API_KEY;
  else process.env.LINEAR_API_KEY = originalApiKey;
});

function execute(tool: any, params: Record<string, unknown>) {
  return tool.execute('call-1', params, undefined, undefined, { hasUI: false });
}

function updateTools(document = 'Planning notes') {
  return [
    ['typed', typedLinearTools().find(({ name }) => name === 'linear_update_document')!, { document, title: 'Updated notes' }],
    ['activated typed', typedLinearTools().find(({ name }) => name === 'linear_update_document')!, { document, title: 'Updated notes' }],
  ] as const;
}

function installServer(resolveData: unknown) {
  const requests: Array<{ query: string; variables: Record<string, unknown> }> = [];
  process.env.LINEAR_API_KEY = 'test-key';
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    const request = JSON.parse(String(init.body));
    requests.push(request);
    const data = request.query.includes('ResolveDocumentBy')
      ? resolveData
      : { documentUpdate: { success: true, document: { id: request.variables.id, title: 'Updated notes' } } };
    return new Response(JSON.stringify({ data }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }));
  return requests;
}

describe('exact document resolution on public mutation paths', () => {
  it.each(updateTools())('resolves an exact title before %s mutation', async (_surface, tool, params) => {
    const requests = installServer({ documents: { nodes: [{ id: DOCUMENT_ID, title: 'Planning notes' }] } });

    const result = await execute(tool, params);

    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({ variables: { title: 'Planning notes' } });
    expect(requests[1]!.query).toContain('mutation UpdateDocument');
    expect(requests[1]!.variables).toEqual({ id: DOCUMENT_ID, input: { title: 'Updated notes' } });
    expect(result.details.resolution.target).toEqual({
      requested: 'Planning notes',
      resolvedId: DOCUMENT_ID,
      title: 'Planning notes',
    });
  });

  it.each(updateTools(DOCUMENT_ID))('verifies an exact UUID before %s mutation', async (_surface, tool, params) => {
    const requests = installServer({ document: { id: DOCUMENT_ID, title: 'Planning notes' } });

    await execute(tool, params);

    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({ variables: { id: DOCUMENT_ID } });
    expect(requests[1]!.variables).toEqual({ id: DOCUMENT_ID, input: { title: 'Updated notes' } });
  });

  it.each(updateTools())('does not run a %s mutation when exact resolution is ambiguous', async (_surface, tool, params) => {
    const requests = installServer({ documents: { nodes: [
      { id: DOCUMENT_ID, title: 'Planning notes' },
      { id: OTHER_ID, title: 'Planning notes' },
    ] } });

    await expect(execute(tool, params)).rejects.toThrow(
      'Linear document "Planning notes" resolved to 2 results; expected exactly one.',
    );
    expect(requests).toHaveLength(1);
    expect(requests.every(({ query }) => !query.includes('mutation UpdateDocument'))).toBe(true);
  });

  it.each(updateTools())('does not run a %s mutation for mixed exact and mismatched results', async (_surface, tool, params) => {
    const requests = installServer({ documents: { nodes: [
      { id: DOCUMENT_ID, title: 'Planning notes' },
      { id: OTHER_ID, title: 'Planning note' },
    ] } });

    await expect(execute(tool, params)).rejects.toThrow(
      'Linear document "Planning notes" resolved to 2 results; expected exactly one.',
    );
    expect(requests.filter(({ query }) => query.includes('ResolveDocumentByTitle'))).toHaveLength(1);
    expect(requests.filter(({ query }) => query.includes('mutation UpdateDocument'))).toHaveLength(0);
  });

  it.each(updateTools())('does not run a %s mutation for missing or mismatched title results', async (_surface, tool, params) => {
    for (const [resolveData, message] of [
      [{ documents: { nodes: [] } }, 'resolved to 0 results'],
      [{ documents: { nodes: [{ id: DOCUMENT_ID, title: 'Planning note' }] } }, 'mismatched title "Planning note"'],
    ] as const) {
      const requests = installServer(resolveData);
      await expect(execute(tool, params)).rejects.toThrow(message);
      expect(requests).toHaveLength(1);
      expect(requests[0]!.query).not.toContain('mutation UpdateDocument');
    }
  });
});
