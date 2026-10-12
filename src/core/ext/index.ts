// Extensions (owner: extensions): memory files, skills, custom agents, slash commands, MCP servers, hooks.
// Nothing here touches other modules at construction time; everything reads `ctx` lazily.

import type { CoreContext, ExtensionsApi } from '../contracts';
import type { McpServerConfig } from '../../shared/types';
import { createAgentsIndex } from './agents';
import { createCommandsIndex } from './commands';
import { createHookRunner } from './hooks';
import { createMcpManager } from './mcp';
import type { McpServerStatus } from './mcp';
import { createMemoryReader } from './memory';
import { createSkillsIndex } from './skills';
import { createLogger, resolveHome } from './util';
import type { ExtLogger, ExtensionsOptions } from './util';

export type { ExtensionsOptions } from './util';
export type { McpServerStatus } from './mcp';

export interface Extensions extends ExtensionsApi {
  /** Connect MCP servers from settings and start watching settings for changes. */
  start(): Promise<void>;
  dispose(): Promise<void>;
  /** Additive helper (not part of ExtensionsApi): connection state of every configured MCP server. */
  mcpStatus(): McpServerStatus[];
  /** Additive helper: drop and re-establish one MCP server's connection (or all of them). */
  reconnectMcp(name?: string): Promise<void>;
}

export function createExtensions(ctx: CoreContext, opts: ExtensionsOptions = {}): Extensions {
  const home = resolveHome(opts);
  const importClaude = (): boolean => !!ctx.settings.get().importClaudeConfig;

  let logger: ExtLogger | undefined;
  const lazyLog = (): ExtLogger => (logger ??= createLogger(ctx.dataDir));
  const log: ExtLogger = {
    info: (m) => lazyLog().info(m),
    warn: (m) => lazyLog().warn(m),
    error: (m) => lazyLog().error(m),
    recent: () => lazyLog().recent(),
  };

  const memory = createMemoryReader({ home, importClaudeConfig: importClaude });
  const skills = createSkillsIndex({ home, importClaudeConfig: importClaude });
  const agents = createAgentsIndex({ home, importClaudeConfig: importClaude });
  const commands = createCommandsIndex({ home, importClaudeConfig: importClaude });
  const hooks = createHookRunner({
    settings: () => ctx.settings.get(),
    projectHooks: (cwd) => ctx.settings.forProject(cwd).hooks,
    log,
  });
  const mcp = createMcpManager({
    secret: (name) => ctx.secrets.get(name),
    log,
    connectTimeoutMs: opts.mcpConnectTimeoutMs,
    toolTimeoutMs: opts.mcpToolTimeoutMs,
  });

  let started = false;
  let unsubscribe: (() => void) | undefined;
  let debounce: ReturnType<typeof setTimeout> | undefined;
  let lastApplied = '';

  const servers = (): Record<string, McpServerConfig> => ctx.settings.get().mcpServers ?? {};

  function onSettingsChanged(): void {
    const sig = JSON.stringify(servers());
    if (sig === lastApplied) return;
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => {
      debounce = undefined;
      const now = servers();
      lastApplied = JSON.stringify(now);
      void mcp.reconcile(now).catch((e: unknown) => log.error(`mcp reconcile failed: ${(e as Error).message}`));
    }, opts.mcpReconcileDebounceMs ?? 300);
    debounce.unref?.();
  }

  return {
    memoryText: (cwd) => memory.memoryText(cwd),
    skills: (cwd) => skills.skills(cwd),
    loadSkill: (cwd, name) => skills.loadSkill(cwd, name),
    agentTypes: (cwd) => agents.agentTypes(cwd),
    agentDefinition: (cwd, name) => agents.agentDefinition(cwd, name),
    slashCommands: (cwd) => commands.slashCommands(cwd),
    expandCommand: (cwd, name, args) => commands.expandCommand(cwd, name, args),
    mcpTools: () => mcp.tools(),
    runHooks: (event, payload, cwd) => hooks.runHooks(event, payload, cwd),
    mcpStatus: () => mcp.status(),
    reconnectMcp: (name) => mcp.reconnect(name),

    async start() {
      if (started) return;
      started = true;
      unsubscribe = ctx.settings.onChange(onSettingsChanged);
      const initial = servers();
      lastApplied = JSON.stringify(initial);
      if (!Object.keys(initial).length) return;
      // Wait for the first connection attempts, but never hold up app startup for long: slow servers (first-run
      // `npx -y`) keep connecting in the background and their tools appear in mcpTools() once ready.
      const attempts = mcp.reconcile(initial).catch((e: unknown) => log.error(`mcp start failed: ${(e as Error).message}`));
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cap = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, opts.mcpStartupWaitMs ?? 10_000);
        timer.unref?.();
      });
      await Promise.race([attempts, cap]);
      if (timer) clearTimeout(timer);
    },

    async dispose() {
      started = false;
      unsubscribe?.();
      unsubscribe = undefined;
      if (debounce) clearTimeout(debounce);
      debounce = undefined;
      await mcp.dispose();
    },
  };
}
