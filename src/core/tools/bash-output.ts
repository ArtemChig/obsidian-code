import { defineTool, fail, ok } from './types';
import { maxOutput } from './lib/shellTool';
import { truncateMiddle } from './lib/text';

type BashOutputInput = { bash_id: string; filter?: string };

export const bashOutputTool = defineTool<BashOutputInput>(
  {
    name: 'BashOutput',
    description: 'Get the output produced since the last call, and the running/exit status, of a background shell. filter: regex; keep only matching lines.',
    inputSchema: {
      type: 'object',
      properties: {
        bash_id: { type: 'string', description: 'Shell id, e.g. "bash_1"' },
        filter: { type: 'string', description: 'Regex for lines to keep' },
      },
      required: ['bash_id'],
    },
    concurrencySafe: true,
    permission: () => 'read',
    title: (i) => `Read output of ${i.bash_id ?? 'shell'}`,

    async run(input, ctx) {
      const info = ctx.shells.list().find((s) => s.id === input.bash_id);
      if (!info) {
        const known = ctx.shells.list().map((s) => s.id);
        return fail(`No background shell with id "${input.bash_id}".${known.length ? ` Known shells: ${known.join(', ')}.` : ' No background shells exist.'}`);
      }
      const r = ctx.shells.output(info.id, { sinceLastRead: true, filter: input.filter });
      const status = r.running ? 'running' : `exited with code ${r.exitCode ?? 'unknown'}`;
      const out = truncateMiddle(r.output.replace(/\s+$/, ''), maxOutput(ctx), 0.3);
      return ok(`[${info.id}: ${status}]\n${out || '(no new output)'}`, {
        display: { kind: 'bash', command: info.command, output: out, exitCode: r.exitCode, shellId: info.id, background: true },
      });
    },
  },
  { aliases: { bash_id: ['shell_id', 'id', 'bashId', 'shellId'] } },
);
