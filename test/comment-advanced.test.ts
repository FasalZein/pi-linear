import { describe, expect, it } from 'vitest';
import type { TSchema } from 'typebox';
import { helpResult } from '../extensions/api';
import { operations } from '../extensions/operations';
import { validateOperationVariables } from '../extensions/operation-validation';
import { typedLinearTools } from '../extensions/typed-tools';

const UUID = '11111111-1111-4111-8111-111111111111';
const comment = typedLinearTools().find(({ name }) => name === 'linear_create_comment')!;
const properties = (comment.parameters as { properties: Record<string, TSchema> }).properties;

describe('create_comment advanced targets', () => {
  it('publishes issue and body as the only common write fields', () => {
    expect(Object.keys(properties)).toEqual(['issue', 'body', 'view', 'advanced']);
    expect((properties.advanced as { properties?: unknown }).properties ?? {}).toEqual({});
  });

  it('accepts exactly one common or advanced target and preserves the provider object', async () => {
    const args = { body: 'Project update', advanced: { project: UUID } };
    expect(comment.prepareArguments!(args)).toBe(args);
    expect(() => validateOperationVariables(
      operations.create_comment!,
      'create_comment',
      args,
      'parameter-card',
    )).not.toThrow();

    const plan = await operations.create_comment!.plan!(args);
    expect(plan.kind).toBe('mutation');
    if (plan.kind !== 'mutation') throw new Error('Expected a mutation plan.');
    const prepared = plan.finish({ canonical_projectId_0: { id: UUID, name: 'Roadmap' } });
    expect(prepared.variables).toEqual({ input: { projectId: UUID, body: 'Project update' } });
  });

  it('keeps bodyData usable in advanced and treats an empty advanced object as no change', () => {
    expect(() => comment.prepareArguments!({ issue: 'AEO-826', body: 'Common', advanced: {} })).not.toThrow();
    expect(() => comment.prepareArguments!({ advanced: { project: UUID, bodyData: { type: 'doc' } } })).not.toThrow();
  });

  it('rejects missing, duplicate, or multiple targets across both tiers', () => {
    expect(() => comment.prepareArguments!({ body: 'No target' })).toThrow(/exactly one comment target/);
    expect(() => comment.prepareArguments!({ issue: 'AEO-826', body: 'Two', advanced: { project: UUID } }))
      .toThrow(/exactly one comment target/);
    expect(() => comment.prepareArguments!({ body: 'Two', advanced: { project: UUID, initiative: UUID } }))
      .toThrow(/exactly one comment target/);
  });

  it('discovers every rare target and content field only through advanced help', () => {
    const common = helpResult({ operation: 'create_comment' });
    expect(common.parameters).toEqual([
      { name: 'issue', type: 'IssueReference', required: false },
      { name: 'body', type: 'String', required: false },
      { name: 'view', type: 'ResultView', required: false },
    ]);
    expect(common.advancedHelp).toEqual({
      operation: 'help',
      variables: { operation: 'create_comment:advanced' },
    });
    const detail = helpResult({ operation: 'create_comment:advanced' });
    for (const name of [
      'project', 'initiative', 'projectUpdateId', 'initiativeUpdateId', 'postId',
      'documentContentId', 'parentId', 'bodyData', 'quotedText', 'doNotSubscribeToIssue',
      'createOnSyncedSlackThread', 'createdAt', 'id',
    ]) {
      expect(detail.parameters).toContainEqual(expect.objectContaining({ name }));
    }
    expect(detail.parameters).not.toContainEqual(expect.objectContaining({ name: 'issue' }));
    expect(detail.parameters).not.toContainEqual(expect.objectContaining({ name: 'body' }));
  });
});
