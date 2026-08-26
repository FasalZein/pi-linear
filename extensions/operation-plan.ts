import {
  assertIssueNodeMatches,
  assertNamedNodeMatches,
  linearGraphQLErrors,
  linearGraphQLWithContext,
  requireIssueReference,
  linearGraphQL,
  type LinearGraphQLFn,
  type LinearNetworkContext,
  type ResolvedIssue,
} from './client';
import type { LookupPlan, OperationPlan, OperationPreparation } from './operation-types';
import {
  isCompatibilityObject,
  isCompatibilityString,
  type CompatibilityObject,
  type CompatibilityValue,
} from './operation-types';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TEAM_KEY = /^[A-Z][A-Z0-9]*$/i;

function required(value: string, kind: string): string {
  const reference = value.trim();
  if (!reference) throw new Error(`Linear ${kind} reference is required.`);
  return reference;
}

function one<T>(nodes: readonly T[], description: string): T {
  if (nodes.length !== 1) {
    throw new Error(`Linear ${description} resolved to ${nodes.length} matches; expected exactly one.`);
  }
  return nodes[0]!;
}

function presentRecord(value: CompatibilityValue | undefined): CompatibilityObject | undefined {
  if (value === undefined || value === null) return undefined;
  return isCompatibilityObject(value) ? value : {};
}

function lookupNodes(value: CompatibilityValue | undefined): readonly CompatibilityObject[] {
  const record = presentRecord(value);
  if (!record) return [];
  const nodes = record.nodes;
  if (!Array.isArray(nodes)) return [];
  return nodes.map((node) => (isCompatibilityObject(node) ? node : {}));
}

function recordAt(resolved: CompatibilityObject, key: string): CompatibilityObject {
  const value = resolved[key];
  return isCompatibilityObject(value) ? value : {};
}

function teamIdFromResolved(value: CompatibilityObject): string {
  const id = value.id;
  if (!isCompatibilityString(id)) throw new Error('Linear team is missing id.');
  return id;
}

function assignOptional<T extends object, K extends keyof T>(
  target: T,
  key: K,
  value: T[K] | undefined,
): void {
  if (value !== undefined) target[key] = value;
}

function objectAtPath(value: CompatibilityObject, path: string): CompatibilityObject | undefined {
  let current: CompatibilityValue = value;
  for (const part of path.split('.')) {
    if (!isCompatibilityObject(current)) return undefined;
    const next: CompatibilityValue | undefined = current[part];
    if (next === undefined) return undefined;
    current = next;
  }
  return isCompatibilityObject(current) ? current : undefined;
}

export function pureQueryPlan(prepared: OperationPreparation): OperationPlan {
  return { kind: 'query', lookups: [], finish: () => prepared };
}

export function pureMutationPlan(prepared: OperationPreparation): OperationPlan {
  return { kind: 'mutation', lookups: [], finish: () => prepared };
}

export function issueLookup(key: string, value: string): LookupPlan {
  const reference = requireIssueReference(value);
  return {
    key,
    document: () => `query ResolveIssueById($id: String!) {
  issue(id: $id) { id identifier team { id key } }
}`,
    variables: () => ({ id: reference }),
    resolve(data) {
      const issue = presentRecord(data.issue);
      const teamValue = issue?.team;
      assertIssueNodeMatches(reference, issue);
      const team = presentRecord(teamValue);
      if (!team || !isCompatibilityString(team.id) || !isCompatibilityString(team.key)) {
        throw new Error(`Linear issue "${reference}" has no team.`);
      }
      const identifier = reference.match(/^([A-Z][A-Z0-9]*)-(\d+)$/i);
      if (identifier && team.key.toLowerCase() !== identifier[1]!.toLowerCase()) {
        throw new Error(`Linear issue resolver returned a mismatched team for "${reference}".`);
      }
      return { id: issue.id, identifier: issue.identifier, teamId: team.id, teamKey: team.key } satisfies ResolvedIssue;
    },
  };
}

export function teamLookup(key: string, value: string): LookupPlan {
  const reference = required(value, 'team');
  if (UUID.test(reference)) {
    return {
      key,
      document: () => `query ResolveTeamById($id: String!) { team(id: $id) { id key } }`,
      variables: () => ({ id: reference }),
      resolve(data) {
        const team = presentRecord(data.team);
        if (!team) throw new Error(`Linear team "${reference}" was not found.`);
        if (team.id !== reference) throw new Error(`Linear team resolver returned mismatched id for "${reference}".`);
        return team;
      },
    };
  }
  if (!TEAM_KEY.test(reference)) {
    throw new Error(`Invalid Linear team reference "${reference}". Use a team key or UUID.`);
  }
  return {
    key,
    document: () => `query ResolveTeamByKey($key: String!) {
  teams(first: 2, filter: { key: { eq: $key } }) { nodes { id key } }
}`,
    variables: () => ({ key: reference.toUpperCase() }),
    resolve(data) {
      const team = one(lookupNodes(data.teams), `team "${reference}"`);
      if (!isCompatibilityString(team.key) || team.key.toLowerCase() !== reference.toLowerCase()) {
        throw new Error(`Linear team resolver returned mismatched key "${String(team.key)}" for "${reference}".`);
      }
      return team;
    },
  };
}

export function stateLookup(
  key: string,
  value: string,
  teamKey?: string,
  teamIdFrom: (value: CompatibilityObject) => string = teamIdFromResolved,
): LookupPlan {
  const reference = required(value, 'state');
  if (UUID.test(reference)) {
    const lookup: LookupPlan = {
      key,
      document: () => `query ResolveStateById($id: String!) {
  workflowState(id: $id) { id name team { id } }
}`,
      variables: () => ({ id: reference }),
      resolve(data) {
        const state = presentRecord(data.workflowState);
        if (!state || !isCompatibilityString(state.id) || !isCompatibilityString(state.name)) {
          throw new Error(`Linear state "${reference}" was not found.`);
        }
        if (state.id !== reference) throw new Error(`Linear state resolver returned mismatched id for "${reference}".`);
        const team = presentRecord(state.team);
        if (!team || !isCompatibilityString(team.id)) throw new Error(`Linear state "${reference}" has no team.`);
        return { id: state.id, name: state.name, teamId: team.id };
      },
    };
    assignOptional(lookup, 'dependsOn', teamKey ? [teamKey] : undefined);
    return lookup;
  }
  if (!teamKey) {
    throw new Error(`Invalid Linear state reference "${reference}". Use a state UUID, or provide team with an exact state name.`);
  }
  return {
    key,
    dependsOn: [teamKey],
    document: () => `query ResolveStateByName($teamId: ID!, $name: String!) {
  workflowStates(first: 2, filter: { team: { id: { eq: $teamId } }, name: { eqIgnoreCase: $name } }) {
    nodes { id name team { id } }
  }
}`,
    variables(resolved) {
      return { teamId: teamIdFrom(recordAt(resolved, teamKey)), name: reference };
    },
    resolve(data, resolved) {
      const teamId = teamIdFrom(recordAt(resolved, teamKey));
      const matches = lookupNodes(data.workflowStates).filter((state) => {
        const team = presentRecord(state.team);
        return team?.id === teamId
          && isCompatibilityString(state.name)
          && state.name.toLowerCase() === reference.toLowerCase();
      });
      const state = one(matches, `state "${reference}" in team "${teamId}"`);
      return { id: state.id, name: state.name, teamId };
    },
  };
}

export function stateLookupForTeamReference(key: string, value: string, teamValue: string): LookupPlan {
  const reference = required(value, 'state');
  const team = required(teamValue, 'team');
  if (UUID.test(reference)) return stateLookup(key, reference);
  const byId = UUID.test(team);
  return {
    key,
    document: () => byId
      ? `query ResolveStateByTeamId($teamId: ID!, $name: String!) {
  workflowStates(first: 2, filter: { team: { id: { eq: $teamId } }, name: { eqIgnoreCase: $name } }) {
    nodes { id name team { id key } }
  }
}`
      : `query ResolveStateByTeamKey($teamKey: String!, $name: String!) {
  workflowStates(first: 2, filter: { team: { key: { eq: $teamKey } }, name: { eqIgnoreCase: $name } }) {
    nodes { id name team { id key } }
  }
}`,
    variables: () => byId
      ? { teamId: team, name: reference }
      : { teamKey: team.toUpperCase(), name: reference },
    resolve(data) {
      const matches = lookupNodes(data.workflowStates).filter((state) => {
        const owner = presentRecord(state.team);
        if (!owner || !isCompatibilityString(state.name)) return false;
        if (state.name.toLowerCase() !== reference.toLowerCase()) return false;
        return byId
          ? owner.id === team
          : isCompatibilityString(owner.key) && owner.key.toLowerCase() === team.toLowerCase();
      });
      const state = one(matches, `state "${reference}" in team "${team}"`);
      const owner = presentRecord(state.team);
      if (!owner) throw new Error(`Linear state "${reference}" has no team.`);
      return { id: state.id, name: state.name, teamId: owner.id };
    },
  };
}

export function userLookup(key: string, value: string): LookupPlan {
  const reference = required(value, 'user');
  const selection = 'id name displayName email';
  if (reference.toLowerCase() === 'me') {
    return {
      key,
      document: () => `query ResolveViewer { viewer { ${selection} } }`,
      variables: () => ({}),
      resolve(data) {
        const viewer = presentRecord(data.viewer);
        if (!viewer?.id) throw new Error('Linear viewer could not be resolved.');
        return viewer;
      },
    };
  }
  if (UUID.test(reference)) {
    return {
      key,
      document: () => `query ResolveUserById($id: String!) { user(id: $id) { ${selection} } }`,
      variables: () => ({ id: reference }),
      resolve(data) {
        const user = presentRecord(data.user);
        if (!user) throw new Error(`Linear user "${reference}" was not found.`);
        if (user.id !== reference) throw new Error(`Linear user resolver returned mismatched id for "${reference}".`);
        return user;
      },
    };
  }
  return {
    key,
    document: () => `query ResolveUserByIdentity($reference: String!) {
  byEmail: users(first: 2, filter: { email: { eq: $reference } }) { nodes { ${selection} } }
  byName: users(first: 2, filter: { name: { eq: $reference } }) { nodes { ${selection} } }
  byDisplayName: users(first: 2, filter: { displayName: { eq: $reference } }) { nodes { ${selection} } }
}`,
    variables: () => ({ reference }),
    resolve(data) {
      const payload = data;
      const records = ['byEmail', 'byName', 'byDisplayName'].flatMap((name) => lookupNodes(payload[name]));
      const exact = records.filter((user) =>
        user.email === reference || user.name === reference || user.displayName === reference);
      return one([...new Map(exact.map((user) => [user.id, user])).values()], `user "${reference}"`);
    },
  };
}

export function documentLookup(key: string, value: string): LookupPlan {
  const reference = required(value, 'document');
  if (UUID.test(reference)) {
    return {
      key,
      document: () => `query ResolveDocumentById($id: String!) { document(id: $id) { id title } }`,
      variables: () => ({ id: reference }),
      resolve(data) {
        const document = presentRecord(data.document);
        if (!document) throw new Error(`Linear document "${reference}" was not found.`);
        if (document.id !== reference) throw new Error(`Linear document resolver returned mismatched id "${String(document.id)}" for "${reference}".`);
        return { id: document.id, name: document.title };
      },
    };
  }
  return {
    key,
    document: () => `query ResolveDocumentByTitle($title: String!) {
  documents(first: 2, filter: { title: { eq: $title } }) { nodes { id title } }
}`,
    variables: () => ({ title: reference }),
    resolve(data) {
      const nodes = lookupNodes(data.documents);
      if (nodes.length !== 1) throw new Error(`Linear document "${reference}" resolved to ${nodes.length} results; expected exactly one.`);
      if (nodes[0]!.title !== reference) throw new Error(`Linear document resolver returned mismatched title "${String(nodes[0]!.title)}" for "${reference}".`);
      return { id: nodes[0]!.id, name: nodes[0]!.title };
    },
  };
}

export function issueRelationLookup(key: string, value: string, failureMessage: string): LookupPlan {
  const reference = required(value, 'issue relation');
  return {
    key,
    failureMessage,
    telemetryPhase: 'read',
    document: () => `query VerifyIssueRelationDelete($id: String!) {
  issueRelation(id: $id) { id type issue { id } relatedIssue { id } }
}`,
    variables: () => ({ id: reference }),
    resolve(data) {
      const relation = presentRecord(data.issueRelation);
      const issue = presentRecord(relation?.issue);
      const related = presentRecord(relation?.relatedIssue);
      if (!relation || !isCompatibilityString(relation.id) || !isCompatibilityString(relation.type)
        || !issue || !isCompatibilityString(issue.id) || !related || !isCompatibilityString(related.id)) {
        throw new Error('Linear issue relation did not match the exact delete guard.');
      }
      return {
        id: relation.id,
        type: relation.type,
        issueId: issue.id,
        relatedIssueId: related.id,
      };
    },
  };
}

export type LookupNamedKind = 'project' | 'initiative' | 'cycle' | 'document' | 'projectMilestone' | 'customView';

export function namedEntityLookup(key: string, kind: LookupNamedKind, value: string): LookupPlan {
  const reference = required(value, kind);
  const plural = kind === 'projectMilestone' ? 'projectMilestones' : kind === 'customView' ? 'customViews' : `${kind}s`;
  const nameField = kind === 'document' ? 'title' : 'name';
  const nameSelection = kind === 'document' ? 'name: title' : 'name';
  if (UUID.test(reference)) {
    return {
      key,
      document: () => `query ResolveNamedEntityById($id: String!) {
  ${kind}(id: $id) { id ${nameSelection} }
}`,
      variables: () => ({ id: reference }),
      resolve(data) {
        const entity = presentRecord(data[kind]);
        if (!entity) throw new Error(`Linear ${kind} "${reference}" was not found.`);
        if (entity.id !== reference) throw new Error(`Linear ${kind} resolver returned mismatched id for "${reference}".`);
        return entity;
      },
    };
  }
  return {
    key,
    document: () => `query ResolveNamedEntityByName($name: String!) {
  ${plural}(first: 2, filter: { ${nameField}: { eq: $name } }) { nodes { id ${nameSelection} } }
}`,
    variables: () => ({ name: reference }),
    resolve(data) {
      const nodes = lookupNodes(data[plural]).filter((entity) => entity.name === reference);
      return one(nodes, `${kind} "${reference}"`);
    },
  };
}

async function resolvePlanLookups(
  plan: OperationPlan,
  execute: (lookup: LookupPlan, resolved: CompatibilityObject) => Promise<CompatibilityObject>,
): Promise<OperationPreparation> {
  const pending = [...plan.lookups];
  const resolved: CompatibilityObject = {};
  const keys = new Set<string>();
  for (const lookup of pending) {
    if (keys.has(lookup.key)) throw new Error(`Duplicate operation lookup key "${lookup.key}".`);
    keys.add(lookup.key);
  }
  while (pending.length) {
    const index = pending.findIndex((lookup) => (lookup.dependsOn ?? []).every((key) => key in resolved));
    if (index < 0) throw new Error('Operation lookup dependencies contain a cycle or missing key.');
    const lookup = pending.splice(index, 1)[0]!;
    const data = await execute(lookup, resolved);
    resolved[lookup.key] = lookup.resolve(data, resolved);
  }
  return plan.finish(resolved);
}

export async function resolveOperationPlan(
  context: LinearNetworkContext,
  plan: OperationPlan,
): Promise<OperationPreparation> {
  return resolvePlanLookups(plan, async (lookup, resolved) => {
    try {
      const options: { phase: 'read' } | undefined = lookup.telemetryPhase
        ? { phase: lookup.telemetryPhase }
        : undefined;
      const data = await linearGraphQLWithContext(
        context,
        lookup.document(resolved),
        lookup.variables(resolved),
        options,
      );
      if (linearGraphQLErrors(data).length) throw new Error(lookup.failureMessage ?? linearGraphQLErrors(data)[0]!.message);
      return data;
    } catch (error) {
      if (lookup.failureMessage) throw new Error(lookup.failureMessage);
      throw error;
    }
  });
}

export async function resolveOperationPlanWithGraphQL(
  apiKey: string,
  plan: OperationPlan,
  signal?: AbortSignal,
  graphql: LinearGraphQLFn = linearGraphQL,
): Promise<OperationPreparation> {
  return resolvePlanLookups(plan, async (lookup, resolved) => {
    try {
      const options: { phase: 'read' } | undefined = lookup.telemetryPhase
        ? { phase: lookup.telemetryPhase }
        : undefined;
      const data = await graphql(
        apiKey,
        lookup.document(resolved),
        lookup.variables(resolved),
        signal,
        options,
      );
      if (linearGraphQLErrors(data).length) throw new Error(lookup.failureMessage ?? linearGraphQLErrors(data)[0]!.message);
      return data;
    } catch (error) {
      if (lookup.failureMessage) throw new Error(lookup.failureMessage);
      throw error;
    }
  });
}

export function verifyOperationResult(prepared: OperationPreparation, data: CompatibilityObject): void {
  if (prepared.exactIssue) {
    const check = prepared.exactIssue;
    const issue = objectAtPath(data, check.path);
    assertIssueNodeMatches(check.requested, issue);
    const resolution = prepared.resolution ?? {};
    const existingTarget = isCompatibilityObject(resolution.target) ? resolution.target : {};
    prepared.resolution = {
      ...resolution,
      target: {
        ...existingTarget,
        requested: check.requested,
        resolvedId: issue.id,
        identifier: issue.identifier,
      },
    };
  }
  if (prepared.exactNamed) {
    const check = prepared.exactNamed;
    const node = objectAtPath(data, check.path);
    assertNamedNodeMatches(check.kind, check.requested, node);
    const resolution = prepared.resolution ?? {};
    const existingTarget = isCompatibilityObject(resolution.target) ? resolution.target : {};
    const target: CompatibilityObject = {
      ...existingTarget,
      requested: check.requested,
      resolvedId: node.id,
    };
    if (node.name !== undefined) target.name = node.name;
    if (node.title !== undefined) target.title = node.title;
    prepared.resolution = {
      ...resolution,
      target,
    };
  }
}
