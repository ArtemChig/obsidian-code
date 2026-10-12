// Common implementation behind the Bash and PowerShell tools.

import type { ToolContext } from '../../contracts';
import type { ToolResultPayload } from '../../../shared/types';
import { fail, ok } from '../types';
import { runCommand, type RunResult, type ShellKind } from './shell';
import { oneLine, truncateMiddle } from './text';

export type ShellInput = { command: string; timeout?: number; description?: string; run_in_background?: boolean };

export const DEFAULT_TIMEOUT_MS = 120_000;
export const MAX_TIMEOUT_MS = 600_000;

export function clampTimeout(ms: number | undefined): number {
  if (ms === undefined || !Number.isFinite(ms)) return DEFAULT_TIMEOUT_MS;
  return Math.min(Math.max(Math.trunc(ms), 1000), MAX_TIMEOUT_MS);
}

export function maxOutput(ctx: Pick<ToolContext, 'settings'>): number {
  const n = ctx.settings?.maxToolOutputChars;
  return typeof n === 'number' && n > 1000 ? n : 30000;
}

export function describeCommand(command: string, description?: string): string {
  return description?.trim() ? `${description.trim()}: ${oneLine(command, 80)}` : oneLine(command, 100);
}

export function formatRun(command: string, r: RunResult, maxChars: number, timeoutMs: number): ToolResultPayload {
  if (r.error && !r.output) return fail(`Failed to run command: ${r.error}`);
  const out = truncateMiddle(r.output.replace(/\s+$/, ''), maxChars, 0.3);
  const display = { kind: 'bash' as const, command, output: out, exitCode: r.exitCode };
  if (r.timedOut) {
    return fail(`${out}${out ? '\n\n' : ''}[Command timed out after ${Math.round(timeoutMs / 1000)}s and was killed. Use run_in_background for long-running processes, or raise timeout (max ${MAX_TIMEOUT_MS} ms).]`, { display: { ...display, exitCode: null } });
  }
  if (r.aborted) return fail(`${out}${out ? '\n\n' : ''}[Command interrupted]`, { display: { ...display, exitCode: null } });
  if (r.exitCode !== 0 && r.exitCode !== null) return fail(`${out}${out ? '\n\n' : ''}Exit code: ${r.exitCode}`, { display });
  return ok(out || '(no output)', { display });
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function runShellTool(kind: ShellKind, input: ShellInput, ctx: ToolContext): Promise<ToolResultPayload> {
  const command = input.command;
  if (!command.trim()) return fail('command must not be empty.');
  const maxChars = maxOutput(ctx);

  if (input.run_in_background) {
    const id = ctx.shells.start({ command, cwd: ctx.cwd, shell: kind, sessionId: ctx.sessionId });
    await sleep(400); // surface immediate failures (command not found, port in use, …)
    const first = ctx.shells.output(id, { sinceLastRead: true });
    const out = truncateMiddle(first.output.replace(/\s+$/, ''), Math.min(maxChars, 4000), 0.3);
    const display = { kind: 'bash' as const, command, output: out, exitCode: first.exitCode, shellId: id, background: true };
    if (!first.running) {
      const ec = first.exitCode ?? 0;
      return (ec === 0 ? ok : fail)(`Background shell ${id} already finished (exit code ${ec}).${out ? `\n${out}` : ''}`, { display });
    }
    return ok(
      `Started background shell ${id}. Read its output with BashOutput (bash_id: "${id}") and stop it with KillShell.${out ? `\nOutput so far:\n${out}` : ''}`,
      { display },
    );
  }

  const timeoutMs = clampTimeout(input.timeout);
  const result = await runCommand({
    command,
    cwd: ctx.cwd,
    kind,
    timeoutMs,
    signal: ctx.signal,
    onProgress: (tail) => ctx.progress(tail),
  });
  return formatRun(command, result, maxChars, timeoutMs);
}
