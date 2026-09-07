import type { CanonicalOperation, CanonicalVariant } from './canonical-schema';
import type { CompatibilityObject, CompatibilityValue, LookupPlan, OperationPlan } from './operation-types';
import { isCompatibilityObject, isCompatibilityString } from './operation-types';
import { issueLookup, namedEntityLookup, teamLookup, userLookup, type LookupNamedKind } from './operation-plan';

export type ReferenceResolver = 'issue' | 'team' | 'user' | LookupNamedKind;

type ReferenceRename = {
  name: string;
  type: string;
  resolver?: ReferenceResolver;
  many?: true;
  destination?: 'input' | 'id';
};

export type OperationReferenceRenames = Readonly<Record<string, ReferenceRename>>;

/** One authored rename table. Operation plans keep Linear's wire names behind this boundary. */
const referenceRenameCatalog = <T extends Readonly<Record<string, OperationReferenceRenames>>>(value: T): T => value;

const REFERENCE_RENAMES = referenceRenameCatalog({
  create_comment: {
    projectId: { name: 'project', type: 'ProjectReference', resolver: 'project', destination: 'input' },
    initiativeId: { name: 'initiative', type: 'InitiativeReference', resolver: 'initiative', destination: 'input' },
  },
  update_cycle: {
    id: { name: 'cycle', type: 'CycleReference', resolver: 'cycle', destination: 'id' },
  },
  create_document: {
    issueId: { name: 'issue', type: 'IssueReference' },
    teamId: { name: 'team', type: 'TeamReference' },
    projectId: { name: 'project', type: 'ProjectReference', resolver: 'project', destination: 'input' },
    initiativeId: { name: 'initiative', type: 'InitiativeReference', resolver: 'initiative', destination: 'input' },
    cycleId: { name: 'cycle', type: 'CycleReference', resolver: 'cycle', destination: 'input' },
    ownerId: { name: 'owner', type: 'UserReference', resolver: 'user', destination: 'input' },
    subscriberIds: { name: 'subscribers', type: '[UserReference!]', resolver: 'user', many: true, destination: 'input' },
  },
  update_document: {
    issueId: { name: 'issue', type: 'IssueReference' },
    teamId: { name: 'team', type: 'TeamReference' },
    projectId: { name: 'project', type: 'ProjectReference', resolver: 'project', destination: 'input' },
    initiativeId: { name: 'initiative', type: 'InitiativeReference', resolver: 'initiative', destination: 'input' },
    cycleId: { name: 'cycle', type: 'CycleReference', resolver: 'cycle', destination: 'input' },
    ownerId: { name: 'owner', type: 'UserReference', resolver: 'user', destination: 'input' },
    subscriberIds: { name: 'subscribers', type: '[UserReference!]', resolver: 'user', many: true, destination: 'input' },
  },
  update_issue_label: {
    id: { name: 'label', type: 'LabelReference', resolver: 'issueLabel', destination: 'id' },
  },
  update_issue_relation: {
    issueId: { name: 'issue', type: 'IssueReference' },
    relatedIssueId: { name: 'relatedIssue', type: 'IssueReference' },
  },
  delete_issue_relation: {
    issueId: { name: 'issue', type: 'UUID' },
    relatedIssueId: { name: 'relatedIssue', type: 'UUID' },
  },
  create_issue: {
    projectMilestoneId: { name: 'milestone', type: 'MilestoneReference', resolver: 'projectMilestone', destination: 'input' },
    cycleId: { name: 'cycle', type: 'CycleReference', resolver: 'cycle', destination: 'input' },
    labelIds: { name: 'labels', type: '[LabelReference!]', resolver: 'issueLabel', many: true, destination: 'input' },
    subscriberIds: { name: 'subscribers', type: '[UserReference!]', resolver: 'user', many: true, destination: 'input' },
    delegateId: { name: 'delegate', type: 'UserReference', resolver: 'user', destination: 'input' },
  },
  update_issue: {
    teamId: { name: 'team', type: 'TeamReference' },
    addedLabelIds: { name: 'addLabels', type: '[LabelReference!]', resolver: 'issueLabel', many: true, destination: 'input' },
    removedLabelIds: { name: 'removeLabels', type: '[LabelReference!]', resolver: 'issueLabel', many: true, destination: 'input' },
    projectMilestoneId: { name: 'milestone', type: 'NullableMilestoneReference', resolver: 'projectMilestone', destination: 'input' },
    cycleId: { name: 'cycle', type: 'NullableCycleReference', resolver: 'cycle', destination: 'input' },
    labelIds: { name: 'labels', type: '[LabelReference!]', resolver: 'issueLabel', many: true, destination: 'input' },
    subscriberIds: { name: 'subscribers', type: '[UserReference!]', resolver: 'user', many: true, destination: 'input' },
    delegateId: { name: 'delegate', type: 'UserReference', resolver: 'user', destination: 'input' },
    snoozedById: { name: 'snoozedBy', type: 'UserReference', resolver: 'user', destination: 'input' },
  },
  save_milestone: {
    milestoneId: { name: 'milestone', type: 'MilestoneReference' },
    projectId: { name: 'project', type: 'ProjectReference' },
  },
  update_project_label: {
    id: { name: 'label', type: 'LabelReference', resolver: 'projectLabel', destination: 'id' },
  },
  create_project_relation: {
    projectId: { name: 'project', type: 'ProjectReference', resolver: 'project', destination: 'input' },
    relatedProjectId: { name: 'relatedProject', type: 'ProjectReference', resolver: 'project', destination: 'input' },
    projectMilestoneId: { name: 'milestone', type: 'MilestoneReference', resolver: 'projectMilestone', destination: 'input' },
    relatedProjectMilestoneId: { name: 'relatedMilestone', type: 'MilestoneReference', resolver: 'projectMilestone', destination: 'input' },
  },
  update_project_relation: {
    projectId: { name: 'project', type: 'ProjectReference', resolver: 'project', destination: 'input' },
    relatedProjectId: { name: 'relatedProject', type: 'ProjectReference', resolver: 'project', destination: 'input' },
    projectMilestoneId: { name: 'milestone', type: 'MilestoneReference', resolver: 'projectMilestone', destination: 'input' },
    relatedProjectMilestoneId: { name: 'relatedMilestone', type: 'MilestoneReference', resolver: 'projectMilestone', destination: 'input' },
  },
  save_project: {
    projectId: { name: 'project', type: 'ProjectReference' },
    teamIds: { name: 'teams', type: '[TeamReference!]', resolver: 'team', many: true, destination: 'input' },
    convertedFromIssueId: { name: 'convertedFromIssue', type: 'IssueReference' },
    labelIds: { name: 'labels', type: '[LabelReference!]', resolver: 'projectLabel', many: true, destination: 'input' },
    leadId: { name: 'lead', type: 'UserReference', resolver: 'user', destination: 'input' },
    leadTeamId: { name: 'leadTeam', type: 'TeamReference', resolver: 'team', destination: 'input' },
    memberIds: { name: 'members', type: '[UserReference!]', resolver: 'user', many: true, destination: 'input' },
    statusId: { name: 'status', type: 'ProjectStatusReference', resolver: 'projectStatus', destination: 'input' },
  },
  save_initiative: {
    initiativeId: { name: 'initiative', type: 'InitiativeReference' },
    labelIds: { name: 'labels', type: '[LabelReference!]', resolver: 'initiativeLabel', many: true, destination: 'input' },
    leadTeamId: { name: 'leadTeam', type: 'TeamReference', resolver: 'team', destination: 'input' },
    ownerId: { name: 'owner', type: 'UserReference', resolver: 'user', destination: 'input' },
  },
});

export function operationReferenceRenames(name: string): OperationReferenceRenames {
  return name in REFERENCE_RENAMES
    ? REFERENCE_RENAMES[name as keyof typeof REFERENCE_RENAMES]
    : {};
}

function choices(name: string, renames: OperationReferenceRenames): readonly string[] {
  const rename = renames[name];
  return rename ? [name, rename.name] : [name];
}

function expandBranch(branch: readonly string[], renames: OperationReferenceRenames): string[][] {
  return branch.reduce<string[][]>((branches, field) =>
    branches.flatMap((candidate) => choices(field, renames).map((choice) => [...candidate, choice])), [[]]);
}

function expandedVariants(
  variants: readonly [CanonicalVariant, CanonicalVariant] | undefined,
  renames: OperationReferenceRenames,
): readonly [CanonicalVariant, CanonicalVariant] | undefined {
  if (!variants) return undefined;
  const project = (variant: CanonicalVariant): CanonicalVariant => ({
    fields: variant.fields.flatMap((field) => choices(field, renames)),
    branches: variant.branches.flatMap((branch) => expandBranch(branch, renames)),
  });
  return [project(variants[0]), project(variants[1])];
}

/** AEO-823 expand projection: new reference words and old wire spellings coexist. */
export function expandReferenceContract(name: string, canonical: CanonicalOperation): CanonicalOperation {
  const renames = operationReferenceRenames(name);
  const fields: Record<string, string> = {};
  for (const [field, type] of Object.entries(canonical.fields)) {
    fields[field] = type;
    const rename = renames[field];
    if (rename) fields[rename.name] = rename.type;
  }
  const projected: CanonicalOperation = {
    fields,
    branches: canonical.branches.flatMap((branch) => expandBranch(branch, renames)),
  };
  if (canonical.exclusiveBranches) projected.exclusiveBranches = true;
  const variants = expandedVariants(canonical.variants, renames);
  if (variants) projected.variants = variants;
  return projected;
}

export function canonicalReferenceExample(name: string, example: CompatibilityObject): CompatibilityObject {
  const renames = operationReferenceRenames(name);
  return Object.fromEntries(Object.entries(example).map(([field, value]) => [renames[field]?.name ?? field, value]));
}

export function canonicalReferenceResolverPaths(
  name: string,
  paths: Readonly<Record<string, string>>,
) {
  const projected = { ...paths };
  for (const [oldName, rename] of Object.entries(operationReferenceRenames(name))) {
    const resolver = paths[oldName];
    if (resolver) projected[rename.name] = resolver;
    else if (rename.resolver) projected[rename.name] = `resolve${rename.resolver[0]!.toUpperCase()}${rename.resolver.slice(1)}Reference`;
  }
  return projected;
}

export function normalizeReferenceArguments(
  name: string,
  variables: CompatibilityObject,
): CompatibilityObject {
  const normalized = { ...variables };
  for (const [oldName, rename] of Object.entries(operationReferenceRenames(name))) {
    const hasOld = Object.prototype.hasOwnProperty.call(variables, oldName) && variables[oldName] !== undefined;
    const hasNew = Object.prototype.hasOwnProperty.call(variables, rename.name) && variables[rename.name] !== undefined;
    if (hasOld && hasNew) {
      throw new Error(`Duplicate ${rename.name} identity: send only "${rename.name}".`);
    }
    if (!hasNew) continue;
    normalized[oldName] = variables[rename.name];
    delete normalized[rename.name];
  }
  return normalized;
}

function referenceValues(value: CompatibilityValue | undefined, many: boolean): string[] {
  if (many) {
    if (!Array.isArray(value) || value.length === 0 || value.some((entry) => !isCompatibilityString(entry) || !entry.trim())) {
      throw new Error('Reference lists must contain one or more non-empty strings.');
    }
    const values = value.map((entry) => String(entry).trim());
    const seen = new Set<string>();
    for (const entry of values) {
      const key = entry.toLowerCase();
      if (seen.has(key)) throw new Error(`Duplicate Linear reference "${entry}".`);
      seen.add(key);
    }
    return values;
  }
  if (!isCompatibilityString(value) || !value.trim()) throw new Error('Linear reference must be a non-empty string.');
  return [value.trim()];
}

function lookup(key: string, resolver: ReferenceResolver, value: string): LookupPlan {
  if (resolver === 'issue') return issueLookup(key, value);
  if (resolver === 'team') return teamLookup(key, value);
  if (resolver === 'user') return userLookup(key, value);
  return namedEntityLookup(key, resolver, value);
}

function setPreparedReference(
  prepared: CompatibilityObject,
  oldName: string,
  destination: 'input' | 'id',
  value: CompatibilityValue,
): void {
  if (destination === 'id') {
    prepared.id = value;
    return;
  }
  const input = isCompatibilityObject(prepared.input) ? prepared.input : {};
  input[oldName] = value;
  prepared.input = input;
}

/** Add only the resolution work required by the new typed spelling. */
export function resolveCanonicalReferences(
  name: string,
  original: CompatibilityObject,
  plan: OperationPlan,
): OperationPlan {
  const pending: Array<{ oldName: string; rename: ReferenceRename; requested: string[]; keys: string[] }> = [];
  const lookups = [...plan.lookups];
  for (const [oldName, rename] of Object.entries(operationReferenceRenames(name))) {
    if (!rename.resolver || original[rename.name] === undefined || original[rename.name] === null) continue;
    const requested = referenceValues(original[rename.name], rename.many === true);
    const keys = requested.map((value, index) => `canonical_${oldName.replace(/[^A-Za-z0-9_]/g, '_')}_${index}`);
    requested.forEach((value, index) => lookups.push(lookup(keys[index]!, rename.resolver!, value)));
    pending.push({ oldName, rename, requested, keys });
  }
  if (!pending.length) return plan;
  return {
    ...plan,
    lookups,
    finish(resolved) {
      const prepared = plan.finish(resolved);
      const resolution = isCompatibilityObject(prepared.resolution) ? prepared.resolution : {};
      for (const item of pending) {
        const entities = item.keys.map((key) => resolved[key]).filter(isCompatibilityObject);
        const ids = entities.map((entity) => entity.id).filter(isCompatibilityString);
        if (ids.length !== item.requested.length) throw new Error(`Linear ${item.rename.name} reference could not be resolved.`);
        setPreparedReference(prepared.variables, item.oldName, item.rename.destination ?? 'input', item.rename.many ? ids : ids[0]!);
        resolution[item.rename.name] = item.rename.many
          ? item.requested.map((requested, index) => ({ requested, resolvedId: ids[index] }))
          : { requested: item.requested[0], resolvedId: ids[0] };
      }
      prepared.resolution = resolution;
      return prepared;
    },
  };
}
