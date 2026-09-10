export const LINEAR_AGENT_TOOL_SURFACE_START = '<!-- pi-linear:tool-surface:start -->';
export const LINEAR_AGENT_TOOL_SURFACE_END = '<!-- pi-linear:tool-surface:end -->';
export const LINEAR_AGENT_QUERY_DISCIPLINE_START = '<!-- pi-linear:query-discipline:start -->';
export const LINEAR_AGENT_QUERY_DISCIPLINE_END = '<!-- pi-linear:query-discipline:end -->';

export const LINEAR_AGENT_TOOL_SURFACE = `${LINEAR_AGENT_TOOL_SURFACE_START}
- Use \`linear\` only for discovery. It requires \`operation: "help"\` and never executes Linear work.
- Use the matching typed tool and its visible schema as the parameter authority. If that tool is unavailable in this session, request exact help: \`{ "operation": "help", "variables": { "operation": "<name>" } }\`.
- Exact help is local and makes no Linear network request. It activates the matching typed tool and returns its purpose and example. Then call the activated tool with its declared direct fields.
- For advanced fields, request exact help for \`<name>:advanced\`, then put only the returned fields in \`advanced\`.
- Use the published reference names. No project or team default carries between calls.
- Send \`operation\` with help \`variables\` to \`linear\` only. Send \`query\` with optional \`variables\` to \`linear_graphql\`. Give every \`linear_batch\` entry an \`operation\` with optional \`variables\`. Send any other field, such as \`workspace\`, \`sink\`, or \`telemetry\`, only when the visible schema of the tool you call declares it. A typed tool can declare its own same-named business parameter.
- Load batch with exact \`batch\` help. Then call \`linear_batch\` directly. For independent reads, use \`{ "operations": [{ "key": "<label>", "operation": "<name>", "variables": { ... } }] }\`.
- Use explicit \`reads\` and \`mutations\` phases only when mutations exist. Batch entry keys are optional caller labels. Do not invent keys; the runtime assigns stable keys when absent.
- Ordinary batch mutations run in order after all entries pass preflight. The first failure stops later writes; inspect completed, failed, and skipped entries.
- Keep entries independent. Do not reference another entry's result. Do not retry an unknown write outcome before checking its target.
- Mutation replies default to a short acknowledgement. Use \`view: "full"\` only when you need the returned entity; retain partial-error warnings.
- After each write, read the target independently and verify the requested fields. A full mutation reply does not replace this readback.
- Use \`linear_get_result\` for lossless recovery from compact or spilled results. Pass \`{ "handle": "..." }\` directly. Preserve the handle exactly. Follow the returned JSON Pointer and \`nextOffset\` until \`complete\` is true.
- Use raw GraphQL only when no named operation supports the required capability or filter. Load it with exact \`graphql\` help, then call \`linear_graphql\` directly. Keep raw reads bounded. Send raw mutations only when the job explicitly authorizes them.
${LINEAR_AGENT_TOOL_SURFACE_END}`;

export const LINEAR_AGENT_QUERY_DISCIPLINE = `${LINEAR_AGENT_QUERY_DISCIPLINE_START}
- Apply task-sized filters and page sizes.
- Continue through pages only until the requested result is complete.
- Prefer exact issue, project, cycle, team, user, and document references when known.
- Use server-side filters before local filtering.
- Use batch only for independent operations. Keep guarded deletes in the mutation phase with all required identity guards.
${LINEAR_AGENT_QUERY_DISCIPLINE_END}`;
