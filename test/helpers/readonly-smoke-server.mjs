import { createServer } from 'node:http';
import { writeFileSync, appendFileSync, readFileSync } from 'node:fs';
import { buildSchema, introspectionFromSchema, parse } from 'graphql';

const [readyPath, logPath, mode = 'pass'] = process.argv.slice(2);
const fixture = JSON.parse(readFileSync(new URL('../../scripts/fixtures/readonly-schema-contract.json', import.meta.url), 'utf8'));
const builtins = new Set(['String', 'ID', 'Int', 'Float', 'Boolean']);
const lines = [];
for (const name of Object.keys(fixture.scalars)) if (!builtins.has(name)) lines.push(`scalar ${name}`);
for (const [name, type] of Object.entries(fixture.enums)) lines.push(`enum ${name} { ${type.values.join(' ')} }`);
for (const [name, type] of Object.entries(fixture.inputs)) {
  lines.push(`input ${name} { ${Object.entries(type.fields).map(([field, signature]) => `${field}: ${signature}`).join(' ')} }`);
}
for (const [name, type] of Object.entries(fixture.objects)) {
  const fields = Object.entries(type.fields).map(([field, signature]) => `${field}: ${signature}`);
  lines.push(`type ${name} { ${fields.length ? fields.join(' ') : '_smoke: Boolean'} }`);
}
for (const kind of ['Query', 'Mutation']) {
  const fields = Object.entries(fixture.roots[kind]).map(([name, contract]) => {
    const args = Object.entries(contract.arguments).map(([argument, signature]) => `${argument}: ${signature}`).join(', ');
    return `${name}${args ? `(${args})` : ''}: ${contract.returns}`;
  });
  lines.push(`type ${kind} { ${fields.join(' ')} }`);
}
const introspection = introspectionFromSchema(buildSchema(lines.join('\n')));
const ids = {
  issue: '00000000-0000-4000-8000-000000000001',
  customView: '00000000-0000-4000-8000-000000000002',
  cycle: '00000000-0000-4000-8000-000000000003',
  document: '00000000-0000-4000-8000-000000000004',
  initiative: '00000000-0000-4000-8000-000000000005',
  projectMilestone: '00000000-0000-4000-8000-000000000006',
  project: '00000000-0000-4000-8000-000000000007',
  team: '00000000-0000-4000-8000-000000000008',
  user: '00000000-0000-4000-8000-000000000009',
};
const listEntities = {
  customViews: [{ id: ids.customView, name: 'Fake view' }],
  cycles: [{ id: ids.cycle, name: 'Fake cycle' }],
  documents: [{ id: ids.document, title: 'Fake document' }],
  initiatives: [],
  issues: [{ id: ids.issue, identifier: 'AEO-258', title: 'lin_api_server_secret_123456789', team: { id: ids.team, key: 'AEO' } }],
  projectMilestones: [{ id: ids.projectMilestone, name: 'Fake milestone' }],
  projects: [{ id: ids.project, name: 'Fake project' }],
  teams: [{ id: ids.team, key: 'AEO', name: 'Fake team' }],
  users: [{ id: ids.user, name: 'Fake user', displayName: 'Fake user', email: 'fake@example.test' }],
  comments: [], issueLabels: [], issueRelations: [], workflowStates: [], projectLabels: [], projectRelations: [],
};
const singularEntities = {
  issue: listEntities.issues[0], customView: listEntities.customViews[0], cycle: listEntities.cycles[0],
  document: listEntities.documents[0], initiative: { id: ids.initiative, name: 'Fake initiative' },
  projectMilestone: listEntities.projectMilestones[0], project: listEntities.projects[0],
  team: listEntities.teams[0], user: listEntities.users[0],
};

function pageInfo(hasNextPage) {
  return { hasNextPage, hasPreviousPage: false, startCursor: 'start-1', endCursor: hasNextPage ? 'next-1' : 'end-1' };
}

function responseFor(query, variables) {
  const definition = parse(query).definitions.find((entry) => entry.kind === 'OperationDefinition');
  const operationName = definition?.name?.value || 'anonymous';
  const selection = definition?.selectionSet.selections.find((entry) => entry.kind === 'Field');
  const root = selection?.kind === 'Field' ? selection.name.value : 'unknown';
  const kind = query.includes('__schema') ? 'introspection' : (definition?.operation || 'query');
  appendFileSync(logPath, `${JSON.stringify({ operationName, root, kind, variables })}\n`);
  if (kind === 'introspection') return { data: introspection };
  if (mode === 'fail' && operationName !== 'IntrospectionQuery') {
    return { errors: [{ message: `lin_api_server_secret_123456789 ${'workspace-record '.repeat(400)}` }] };
  }
  if (root in listEntities) {
    const hasNext = root === 'issues' && variables.first === 1 && !variables.after;
    return { data: { [selection.alias?.value || root]: { nodes: listEntities[root], pageInfo: pageInfo(hasNext) } } };
  }
  if (root === 'issue' && variables.id === '00000000-0000-4000-8000-000000000000') return { data: { issue: null } };
  if (root in singularEntities) return { data: { [selection.alias?.value || root]: singularEntities[root] } };
  if (root === 'viewer') return { data: { viewer: singularEntities.user } };
  return { data: { [selection?.alias?.value || root]: null } };
}

const server = createServer((request, response) => {
  let body = '';
  request.setEncoding('utf8');
  request.on('data', (chunk) => { body += chunk; });
  request.on('end', () => {
    try {
      const payload = JSON.parse(body);
      const result = responseFor(payload.query, payload.variables || {});
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(result));
    } catch (error) {
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ errors: [{ message: error instanceof Error ? error.message : String(error) }] }));
    }
  });
});
server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  writeFileSync(readyPath, JSON.stringify({ port: address.port }));
});
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => server.close(() => process.exit(0)));
