import { defineTool } from './types';
import { commandRule, isReadOnlyCommand } from './lib/shell';
import { describeCommand, runShellTool, type ShellInput } from './lib/shellTool';

export const powershellTool = defineTool<ShellInput>(
  {
    name: 'PowerShell',
    description:
      'Run a Windows PowerShell 5.1 command (no &&; use ; and $?) in the working directory, for Windows-specific work (services, registry, Get-* cmdlets, .ps1). Fresh process every call. Same parameters as Bash.',
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
    permission: (i) => (isReadOnlyCommand(String(i.command ?? ''), 'powershell') ? 'read' : 'exec'),
    title: (i) => `PowerShell: ${describeCommand(String(i.command ?? ''), undefined)}`,
    ruleFor: (i) => commandRule('PowerShell', String(i.command ?? ''), 'powershell'),

    run: (input, ctx) => runShellTool('powershell', input, ctx),
  },
  { aliases: { command: ['cmd', 'script', 'powershell_command'], timeout: ['timeout_ms'], run_in_background: ['background'] } },
);
