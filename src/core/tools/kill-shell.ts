import { defineTool, fail, ok } from './types';

type KillShellInput = { shell_id: string };

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export const killShellTool = defineTool<KillShellInput>(
  {
    name: 'KillShell',
    description: 'Stop a background shell and its child processes.',
    inputSchema: {
      type: 'object',
      properties: { shell_id: { type: 'string', description: 'e.g. "bash_1"' } },
      required: ['shell_id'],
    },
    concurrencySafe: false,
    permission: () => 'none', // only touches shells this agent started itself
    title: (i) => `Kill shell ${i.shell_id ?? ''}`.trim(),
    ruleFor: () => 'KillShell',

    async run(input, ctx) {
      const info = ctx.shells.list().find((s) => s.id === input.shell_id);
      if (!info) return fail(`No background shell with id "${input.shell_id}".`);
      if (!info.running) return ok(`Shell ${info.id} had already finished.`);
      ctx.shells.kill(info.id);
      for (let i = 0; i < 20; i++) {
        await sleep(100);
        if (!ctx.shells.list().find((s) => s.id === info.id)?.running) break;
      }
      return ok(`Killed shell ${info.id} (${info.command.length > 60 ? `${info.command.slice(0, 60)}…` : info.command}).`);
    },
  },
  { aliases: { shell_id: ['bash_id', 'id', 'shellId', 'bashId'] } },
);
