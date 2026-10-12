// Agent loop, prompts, permissions, compaction, subagents, checkpoints (owner: agent-core). Entry point per SPEC §2.1.

import type { AgentManager, CoreContext } from '../contracts';
import { AgentManagerImpl } from './manager';

export function createAgentManager(ctx: CoreContext): AgentManager {
  return new AgentManagerImpl(ctx);
}

export { AgentManagerImpl, HEADLESS_NO_ANSWER, MAX_STEPS } from './manager';
export { BUILTIN_COMMANDS, INIT_PROMPT, parseSlashCommand } from './commands';
export { BUILTIN_AGENTS, MAX_SUBAGENT_DEPTH, MAX_CONCURRENT_SUBAGENTS } from './subagents';
export { decidePermission, parseRule, ruleMatches, splitShellCommand } from './permissions';
export { buildSystemPrompt, gitSummary } from './prompt';
export { buildHistory } from './history';
export { CheckpointStore } from './checkpoints';
