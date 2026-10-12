// Shared plumbing for tool definitions: defineTool() wraps a typed ToolDef so that every entry point
// (permission/title/ruleFor/run) receives repaired, validated input and run() never throws.

import type { PermissionKind, ToolContext, ToolDef } from '../contracts';
import type { ToolResultPayload } from '../../shared/types';
import { normalizeInput, validateInput } from './lib/input';

export type { PermissionKind, ToolContext, ToolDef, ToolResultPayload };

export interface DefineOptions {
  /** Extra accepted names for a parameter, e.g. { file_path: ['path', 'file'] }. */
  aliases?: Record<string, string[]>;
  /** Extra repair step run after generic normalisation and before schema validation. */
  prepare?: (input: Record<string, unknown>) => Record<string, unknown>;
}

export function ok(content: string, extra: Partial<Omit<ToolResultPayload, 'content'>> = {}): ToolResultPayload {
  return { content, ...extra };
}

export function fail(content: string, extra: Partial<Omit<ToolResultPayload, 'content' | 'isError'>> = {}): ToolResultPayload {
  return { content, isError: true, ...extra };
}

export function errMessage(e: unknown): string {
  if (e instanceof Error) {
    const code = (e as NodeJS.ErrnoException).code;
    return code && !e.message.includes(code) ? `${code}: ${e.message}` : e.message;
  }
  return String(e);
}

export function defineTool<I extends Record<string, unknown>>(def: ToolDef<I>, opts: DefineOptions = {}): ToolDef {
  const schema = def.inputSchema;
  const prep = (raw: unknown): I => {
    const n = normalizeInput(schema, raw, opts.aliases);
    // re-normalise after the tool-specific repair so coercion also applies to the keys it introduced
    return (opts.prepare ? normalizeInput(schema, opts.prepare(n), opts.aliases) : n) as I;
  };
  const wrapped: ToolDef = {
    name: def.name,
    description: def.description,
    inputSchema: def.inputSchema,
    concurrencySafe: def.concurrencySafe,
    permission: (input, c) => def.permission(prep(input), c),
    title: (input) => {
      try { return def.title(prep(input)); } catch { return def.name; }
    },
    ruleFor: def.ruleFor ? (input) => def.ruleFor!(prep(input)) : undefined,
    normalize: (input) => prep(input),
    run: async (input, ctx) => {
      const normalized = prep(input);
      const problem = validateInput(schema, normalized);
      if (problem) return fail(`${def.name}: ${problem}`);
      try {
        return await def.run(normalized, ctx);
      } catch (e) {
        if (ctx.signal?.aborted) return fail('Interrupted by user.');
        return fail(`${def.name} failed: ${errMessage(e)}`);
      }
    },
  };
  return wrapped;
}
