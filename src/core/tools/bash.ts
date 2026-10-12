import { defineTool } from './types';
import { commandRule, isReadOnlyCommand, resolveShellKind } from './lib/shell';
import { describeCommand, runShellTool, type ShellInput } from './lib/shellTool';

export const bashTool = defineTool<ShellInput>(
  {
    name: 'Bash',
    description:
      "Run a shell command in the working directory (Git Bash if installed, else PowerShell). Every call is a fresh shell: cd and variables don't persist. Quote paths with spaces. " +
      'Not for reading, searching or editing files (use Read, Grep, Glob, Edit). For long-running processes use run_in_background, then BashOutput.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        timeout: { type: 'integer', description: 'Milliseconds (default 120000, max 600000)' },
        description: { type: 'string', description: 'What it does, in 5-10 words' },
        run_in_background: { type: 'boolean', description: 'Return a shell id immediately' },
      },
      required: ['command'],
    },
    concurrencySafe: false,
    permission: (i, c) => (isReadOnlyCommand(String(i.command ?? ''), resolveShellKind(c.settings?.shell)) ? 'read' : 'exec'),
    title: (i) => `Run: ${describeCommand(String(i.command ?? ''), undefined)}`,
    ruleFor: (i) => commandRule('Bash', String(i.command ?? ''), 'bash'),

    run: (input, ctx) => runShellTool(resolveShellKind(ctx.settings?.shell), input, ctx),
  },
  { aliases: { command: ['cmd', 'script', 'bash_command', 'shell_command'], timeout: ['timeout_ms'], run_in_background: ['background'] } },
);
