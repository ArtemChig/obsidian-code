// Tool layer entry points (SPEC §2.1): createShellRegistry(ctx), createToolRegistry(ctx).
// Factories only store the ctx reference; nothing here talks to other modules at construction time.

import type { CoreContext, ShellRegistry, ToolDef } from '../contracts';
import { askUserQuestionTool } from './ask-user-question';
import { bashOutputTool } from './bash-output';
import { bashTool } from './bash';
import { deleteScheduledTaskTool } from './delete-scheduled-task';
import { editTool } from './edit';
import { exitPlanModeTool } from './exit-plan-mode';
import { globTool } from './glob';
import { grepTool } from './grep';
import { killShellTool } from './kill-shell';
import { listScheduledTasksTool } from './list-scheduled-tasks';
import { lsTool } from './ls';
import { multiEditTool } from './multi-edit';
import { notebookEditTool } from './notebook-edit';
import { powershellTool } from './powershell';
import { readTool } from './read';
import { scheduleTaskTool } from './schedule-task';
import { createShellRegistry as createBackgroundShells } from './shells';
import { skillTool } from './skill';
import { taskTool } from './task';
import { todoWriteTool } from './todo-write';
import { webFetchTool } from './web-fetch';
import { webSearchTool } from './web-search';
import { writeTool } from './write';

/** Built-in tools in a fixed order (keeps the model's tool list byte-identical between turns). */
export function builtinTools(): ToolDef[] {
  return [
    readTool, writeTool, editTool, multiEditTool, globTool, grepTool, lsTool,
    bashTool, bashOutputTool, killShellTool, powershellTool,
    webFetchTool, webSearchTool,
    todoWriteTool, askUserQuestionTool, taskTool, exitPlanModeTool, skillTool, notebookEditTool,
    scheduleTaskTool, listScheduledTasksTool, deleteScheduledTaskTool,
  ];
}

export function createShellRegistry(ctx: CoreContext): ShellRegistry & { dispose(): void } {
  return createBackgroundShells(ctx);
}

export function createToolRegistry(ctx: CoreContext): { all(): ToolDef[]; get(name: string): ToolDef | undefined } {
  const builtins = builtinTools();
  const byName = new Map(builtins.map((t) => [t.name, t]));
  const byLower = new Map(builtins.map((t) => [t.name.toLowerCase(), t]));

  function mcpTools(): ToolDef[] {
    try {
      const tools = ctx.ext?.mcpTools?.() ?? [];
      return tools.filter((t) => !byName.has(t.name)).sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return []; // extensions not started yet
    }
  }

  return {
    all() {
      return [...builtins, ...mcpTools()];
    },
    get(name: string) {
      const hit = byName.get(name) ?? byLower.get(name.toLowerCase());
      if (hit) return hit;
      return mcpTools().find((t) => t.name === name);
    },
  };
}

export { readTool, writeTool, editTool, multiEditTool, globTool, grepTool, lsTool, bashTool, bashOutputTool, killShellTool, powershellTool };
export { webFetchTool, webSearchTool, todoWriteTool, askUserQuestionTool, taskTool, exitPlanModeTool, skillTool, notebookEditTool };
export { scheduleTaskTool, listScheduledTasksTool, deleteScheduledTaskTool };
