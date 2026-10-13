// In-process MCP server "obsidian" for claude-code sessions: the app tools Claude Code lacks on a llama.cpp endpoint.
//   web_search            — replaces Claude Code's WebSearch (an Anthropic server-side tool that llama.cpp cannot run);
//                            uses the app's search providers (Settings → Search)
//   schedule_task / list_scheduled_tasks / delete_scheduled_task — the app's persistent scheduler (ctx.scheduler)
// Each tool runs the app's own ToolDef (same input schema, normalisation and output) through a minimal ToolContext.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { CoreContext, ToolContext, ToolDef } from '../../contracts';
import type { ToolDisplay } from '../../../shared/types';

/** MCP tool name → the app tool it runs. */
export const OBSIDIAN_MCP_TOOLS: Record<string, string> = {
  web_search: 'WebSearch',
  schedule_task: 'ScheduleTask',
  list_scheduled_tasks: 'ListScheduledTasks',
  delete_scheduled_task: 'DeleteScheduledTask',
};

export const OBSIDIAN_MCP_SERVER = 'obsidian';

export function stableKey(name: string, input: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, sort((v as Record<string, unknown>)[k])]));
    return v;
  };
  return `${name}\n${JSON.stringify(sort(input ?? {}))}`;
}

export interface ObsidianMcpHost {
  ctx: CoreContext;
  sessionId: string;
  cwd: string;
  /** Called with the app tool's rich display so the transcript can show it (keyed by mcp tool name + input). */
  onDisplay(key: string, display: ToolDisplay): void;
}

function minimalToolContext(host: ObsidianMcpHost, signal: AbortSignal): ToolContext {
  const { ctx } = host;
  const unsupported = (what: string) => () => { throw new Error(`${what} is not available inside an MCP tool.`); };
  return {
    sessionId: host.sessionId,
    cwd: host.cwd,
    toolUseId: '',
    signal,
    permissionMode: ctx.sessions.get(host.sessionId)?.permissionMode ?? 'default',
    settings: ctx.settings.get(),
    secret: (name) => { try { return ctx.secrets.get(name); } catch { return null; } },
    dataDir: ctx.dataDir,
    progress: () => {},
    readFiles: new Map(),
    checkpointFile: async () => {},
    recordChange: () => {},
    todos: { get: () => [], set: () => {} },
    askUser: unsupported('askUser'),
    requestPlanApproval: unsupported('requestPlanApproval'),
    runSubagent: unsupported('runSubagent'),
    shells: ctx.shells,
    scheduler: ctx.scheduler,
    ext: ctx.ext,
    complete: unsupported('complete'),
  } as ToolContext;
}

export function appToolFor(ctx: CoreContext, mcpName: string): ToolDef | undefined {
  const app = OBSIDIAN_MCP_TOOLS[mcpName];
  if (!app) return undefined;
  try { return ctx.tools.get(app); } catch { return undefined; }
}

/** Build the MCP server instance (one per Claude Code query: an instance connects to a single transport). */
export function createObsidianMcpServer(host: ObsidianMcpHost): { type: 'sdk'; name: string; instance: McpServer } {
  const server = new McpServer({ name: OBSIDIAN_MCP_SERVER, version: '1.0.0' }, { capabilities: { tools: {} } });
  const tools = () => Object.keys(OBSIDIAN_MCP_TOOLS).flatMap((name) => {
    const def = appToolFor(host.ctx, name);
    return def ? [{ name, def }] : [];
  });
  server.server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools().map(({ name, def }) => ({ name, description: def.description, inputSchema: def.inputSchema as { type: 'object'; [k: string]: unknown } })),
  }));
  server.server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    const name = req.params.name;
    const def = appToolFor(host.ctx, name);
    if (!def) return { content: [{ type: 'text' as const, text: `Unknown tool: ${name}` }], isError: true };
    const raw = (req.params.arguments ?? {}) as Record<string, unknown>;
    let input = raw;
    try { if (def.normalize) input = def.normalize(raw) ?? raw; } catch { input = raw; }
    const signal = (extra as { signal?: AbortSignal } | undefined)?.signal ?? new AbortController().signal;
    try {
      const res = await def.run(input, minimalToolContext(host, signal));
      if (res.display) { try { host.onDisplay(stableKey(`mcp__${OBSIDIAN_MCP_SERVER}__${name}`, raw), res.display); } catch { /* best effort */ } }
      return { content: [{ type: 'text' as const, text: String(res.content ?? '') }], isError: res.isError === true };
    } catch (e) {
      return { content: [{ type: 'text' as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
    }
  });
  return { type: 'sdk', name: OBSIDIAN_MCP_SERVER, instance: server };
}
