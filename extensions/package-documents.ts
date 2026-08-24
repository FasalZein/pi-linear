import { Kind, OperationTypeNode, parse, print, type OperationDefinitionNode } from 'graphql';
import { aliasDocument, compileLookupDocument, ISSUE_BATCH_CREATE_DOCUMENT, mergeDocuments } from './batch';
import {
  documentLookup,
  issueLookup,
  issueRelationLookup,
  namedEntityLookup,
  stateLookup,
  stateLookupForTeamReference,
  teamLookup,
  userLookup,
  type LookupNamedKind,
} from './operation-plan';
import { operationDefinitions, projectCompatibilityOperation } from './operations';
import type { LookupPlan } from './operation-types';

export type PackageDocumentAuthority = {
  id: string;
  sourceClass: 'named-operation' | 'lookup' | 'transaction' | 'introspection' | 'compiled-batch';
  document: string;
};

export const PACKAGE_DOCUMENT_EXCLUSIONS = [
  { id: 'caller.linear_graphql', reason: 'Caller-supplied documents are not package-created.' },
  { id: 'local.SwitchWorkspaceLocal', reason: 'The local workspace operation never reaches transport.' },
  { id: 'local.linear_get_result', reason: 'Result retrieval reads an artifact and creates no GraphQL request.' },
] as const;

function operationType(document: string): 'query' | 'mutation' {
  const definition = parse(document).definitions.find(
    (entry): entry is OperationDefinitionNode => entry.kind === Kind.OPERATION_DEFINITION,
  );
  if (!definition) throw new Error('Package document has no operation definition.');
  return definition.operation === 'mutation' ? 'mutation' : 'query';
}

function lookupAuthorities(): Array<{ id: string; lookup: LookupPlan }> {
  const namedKinds: LookupNamedKind[] = ['project', 'initiative', 'cycle', 'document', 'projectMilestone', 'customView'];
  return [
    { id: 'issue', lookup: issueLookup('issue', 'AEO-1') },
    { id: 'team.id', lookup: teamLookup('team', '00000000-0000-4000-8000-000000000001') },
    { id: 'team.key', lookup: teamLookup('team', 'AEO') },
    { id: 'state.id', lookup: stateLookup('state', '00000000-0000-4000-8000-000000000002') },
    { id: 'state.name', lookup: stateLookup('state', 'Todo', 'team') },
    { id: 'state.team-id', lookup: stateLookupForTeamReference('state', 'Todo', '00000000-0000-4000-8000-000000000003') },
    { id: 'state.team-key', lookup: stateLookupForTeamReference('state', 'Todo', 'AEO') },
    { id: 'user.viewer', lookup: userLookup('user', 'me') },
    { id: 'user.id', lookup: userLookup('user', '00000000-0000-4000-8000-000000000004') },
    { id: 'user.identity', lookup: userLookup('user', 'person@example.com') },
    { id: 'document.id', lookup: documentLookup('document', '00000000-0000-4000-8000-000000000005') },
    { id: 'document.title', lookup: documentLookup('document', 'Roadmap') },
    { id: 'issue-relation', lookup: issueRelationLookup('relation', '00000000-0000-4000-8000-000000000006', 'guard') },
    ...namedKinds.flatMap((kind, index) => [
      { id: `named.${kind}.id`, lookup: namedEntityLookup('named', kind, `00000000-0000-4000-8000-${String(index + 10).padStart(12, '0')}`) },
      { id: `named.${kind}.name`, lookup: namedEntityLookup('named', kind, 'Example') },
    ]),
  ];
}

export function runtimePackageDocuments(introspectionDocument: string): PackageDocumentAuthority[] {
  const authorities: PackageDocumentAuthority[] = [];
  for (const definition of operationDefinitions) {
    const operation = projectCompatibilityOperation(definition);
    if (operation.executeLocal) continue;
    const documents = operation.inventoryDocuments?.length
      ? operation.inventoryDocuments
      : operation.variants?.length
        ? operation.variants.map((variant) => ({ id: variant.when ?? variant.root, document: variant.document }))
        : [{ id: 'default', document: operation.document }];
    for (const entry of documents) authorities.push({
      id: `operation.${operation.name}.${entry.id}`,
      sourceClass: 'named-operation',
      document: entry.document,
    });
  }
  const lookups = lookupAuthorities();
  for (const { id, lookup } of lookups) authorities.push({
    id: `lookup.${id}`,
    sourceClass: 'lookup',
    document: lookup.document({}),
  });
  authorities.push({ id: 'transaction.issue-batch-create', sourceClass: 'transaction', document: ISSUE_BATCH_CREATE_DOCUMENT });
  authorities.push({ id: 'introspection.readonly-schema', sourceClass: 'introspection', document: introspectionDocument });

  const batchSources = authorities.filter((entry) => entry.sourceClass === 'named-operation');
  const aliased = batchSources.map((entry, index) => ({
    id: `batch.alias.${entry.id}`,
    sourceClass: 'compiled-batch' as const,
    operationType: operationType(entry.document),
    document: print(aliasDocument(`entry_${index}`, entry.document).ast),
  }));
  authorities.push(...aliased.map(({ operationType: _operationType, ...entry }) => entry));
  const aliasedReads = aliased.filter(({ operationType }) => operationType === 'query');
  if (aliasedReads.length) {
    authorities.push({
      id: 'batch.merged.all-reads',
      sourceClass: 'compiled-batch',
      document: mergeDocuments(OperationTypeNode.QUERY, 'ValidateAllBatchReads', aliasedReads.map(({ document }) => parse(document))),
    });
  }
  for (const [index, { id, lookup }] of lookups.entries()) authorities.push({
    id: `batch.lookup.${id}`,
    sourceClass: 'compiled-batch',
    document: compileLookupDocument(`mutation_${index}`, lookup),
  });
  return authorities.sort((left, right) => left.id.localeCompare(right.id));
}
