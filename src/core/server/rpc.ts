// JSON-RPC dispatch table (owner: platform): maps EVERY method of RpcMethods to the module that implements it.
// The mapped type below makes a missing method a compile error.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { RpcMethod, RpcMethods, RpcParams, RpcResult } from '../../shared/protocol';
import type { EngineId, ModelRef, PermissionMode, Session, SessionSummary, Settings, ToolUseBlock } from '../../shared/types';
import type { CoreContext } from '../contracts';
import { toSummary } from '../store/sessions';
import { listDir, readTextFile, searchFiles } from './files';

export type RpcHandler<M extends RpcMethod> = (params: RpcParams<M>) => Promise<RpcResult<M>> | RpcResult<M>;
export type RpcHandlers = { [M in RpcMethod]: RpcHandler<M> };

/** A Vast.ai instance exists that only the API key can stop: rented (any active phase), or parked. */
function gpuHoldsInstance(ctx: CoreContext): boolean {
  let st: ReturnType<CoreContext['gpu']['status']>;
  try {
    st = ctx.gpu.status();
  } catch {
    return false;
  }
  return st.instanceId != null || (st.phase !== 'off' && st.phase !== 'error') || !!st.parked;
}

export class RpcError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'RpcError';
  }
}

const PERMISSION_MODES: PermissionMode[] = ['default', 'acceptEdits', 'plan', 'bypassPermissions'];
const GIT_BASH = 'C:\\Program Files\\Git\\bin\\bash.exe';

// ── param validation helpers
type Obj = Record<string, unknown>;
function obj(p: unknown): Obj {
  if (p === undefined || p === null) return {};
  if (typeof p !== 'object' || Array.isArray(p)) throw new RpcError('Invalid params: expected an object', 'invalid_params');
  return p as Obj;
}
function reqStr(p: Obj, key: string, allowEmpty = false): string {
  const v = p[key];
  if (typeof v !== 'string' || (!allowEmpty && v.length === 0)) {
    throw new RpcError(`Invalid params: "${key}" must be a ${allowEmpty ? '' : 'non-empty '}string`, 'invalid_params');
  }
  return v;
}
function optStr(p: Obj, key: string): string | undefined {
  const v = p[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw new RpcError(`Invalid params: "${key}" must be a string`, 'invalid_params');
  return v;
}
function optNum(p: Obj, key: string): number | undefined {
  const v = p[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new RpcError(`Invalid params: "${key}" must be a number`, 'invalid_params');
  return v;
}
function reqBool(p: Obj, key: string): boolean {
  const v = p[key];
  if (typeof v !== 'boolean') throw new RpcError(`Invalid params: "${key}" must be a boolean`, 'invalid_params');
  return v;
}
function mode(v: unknown, key = 'mode'): PermissionMode {
  if (typeof v !== 'string' || !PERMISSION_MODES.includes(v as PermissionMode)) {
    throw new RpcError(`Invalid params: "${key}" must be one of ${PERMISSION_MODES.join(', ')}`, 'invalid_params');
  }
  return v as PermissionMode;
}
function engineId(v: unknown, key = 'engine'): EngineId {
  if (v !== 'builtin' && v !== 'claude-code') throw new RpcError(`Invalid params: "${key}" must be one of builtin, claude-code`, 'invalid_params');
  return v;
}
function modelRef(v: unknown, key = 'model'): ModelRef {
  const o = v as Obj | null;
  if (!o || typeof o !== 'object' || typeof o.provider !== 'string' || typeof o.model !== 'string') {
    throw new RpcError(`Invalid params: "${key}" must be { provider, model }`, 'invalid_params');
  }
  return { provider: o.provider as ModelRef['provider'], model: o.model };
}

export function appVersion(): string {
  if (process.env.OBSIDIAN_APP_VERSION) return process.env.OBSIDIAN_APP_VERSION;
  if (process.env.npm_package_version) return process.env.npm_package_version;
  try {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as { name?: string; version?: string };
    if (pkg.name === 'obsidian-code' && pkg.version) return pkg.version;
  } catch {
    /* ignore */
  }
  return '0.0.0';
}

export function detectShell(setting: Settings['shell']): string {
  if (setting !== 'auto') return setting;
  if (process.platform === 'win32') return existsSync(GIT_BASH) ? 'git-bash' : 'powershell';
  return process.env.SHELL ? (process.env.SHELL.split('/').pop() ?? 'bash') : 'bash';
}

const ACTIVE_TOOL: ToolUseBlock['status'][] = ['pending', 'awaiting_permission', 'running'];

export function createRpcHandlers(ctx: CoreContext): RpcHandlers {
  const getSession = (id: string): Session => {
    const s = ctx.sessions.get(id);
    if (!s) throw new RpcError(`Session not found: ${id}`, 'not_found');
    return s;
  };

  const mutate = (id: string, fn: (s: Session) => void, bump = false): SessionSummary => {
    const s = getSession(id);
    fn(s);
    if (bump) s.updatedAt = Date.now();
    ctx.sessions.save(s);
    const sum = toSummary(s);
    ctx.bus.emit('session.updated', sum);
    return sum;
  };

  const pickDefaultModel = (): ModelRef | null => {
    try {
      return ctx.models.pickDefault();
    } catch {
      return null;
    }
  };

  const ensureDir = (cwd: string): string => {
    let ok = false;
    try {
      ok = statSync(cwd).isDirectory();
    } catch {
      ok = false;
    }
    if (!ok) throw new RpcError(`Folder does not exist: ${cwd}`, 'invalid_params');
    return cwd;
  };

  const deleteSessionTree = (id: string, depth = 0): void => {
    if (depth > 8) return;
    try {
      if (ctx.agent.isRunning(id)) ctx.agent.interrupt(id);
    } catch (err) {
      console.error('[rpc] interrupt before delete failed:', err instanceof Error ? err.message : err);
    }
    for (const child of ctx.sessions.list({ includeSubagents: true })) {
      if (child.parentSessionId === id) deleteSessionTree(child.id, depth + 1);
    }
    ctx.sessions.delete(id);
    ctx.bus.emit('session.deleted', { sessionId: id });
  };

  const handlers: RpcHandlers = {
    // ── system
    'system.info': () => ({
      version: appVersion(),
      platform: process.platform,
      homeDir: homedir(),
      dataDir: ctx.dataDir,
      shell: detectShell(ctx.settings.get().shell),
      electron: Boolean(ctx.native.isElectron),
    }),

    // ── sessions
    'sessions.list': (params) => {
      const p = obj(params);
      return ctx.sessions.list({ includeSubagents: p.includeSubagents === true });
    },
    'sessions.get': (params) => getSession(reqStr(obj(params), 'id')),
    'sessions.create': (params) => {
      const p = obj(params);
      const settings = ctx.settings.get();
      const cwd = ensureDir(optStr(p, 'cwd') || settings.defaultCwd);
      const title = optStr(p, 'title')?.trim();
      const model = p.model === undefined || p.model === null ? pickDefaultModel() : modelRef(p.model);
      const permissionMode = p.permissionMode === undefined ? settings.defaultPermissionMode : mode(p.permissionMode, 'permissionMode');
      const engine = p.engine === undefined || p.engine === null ? (settings.engine?.default ?? 'builtin') : engineId(p.engine);
      const session = ctx.sessions.create({
        cwd,
        title: title || 'New session',
        kind: 'chat',
        model,
        permissionMode,
        thinking: settings.thinkingByDefault,
        engine,
      });
      const sum = toSummary(session);
      ctx.bus.emit('session.created', sum);
      return sum;
    },
    'sessions.rename': (params) => {
      const p = obj(params);
      const title = reqStr(p, 'title').trim();
      if (!title) throw new RpcError('Title must not be empty', 'invalid_params');
      return mutate(reqStr(p, 'id'), (s) => {
        s.title = title.slice(0, 200);
      });
    },
    'sessions.delete': (params) => {
      const id = reqStr(obj(params), 'id');
      getSession(id);
      deleteSessionTree(id);
      return { ok: true as const };
    },
    'sessions.fork': (params) => {
      const p = obj(params);
      const src = getSession(reqStr(p, 'id'));
      const at = optStr(p, 'atMessageId');
      let messages = src.messages;
      if (at) {
        const idx = messages.findIndex((m) => m.id === at);
        if (idx < 0) throw new RpcError(`Message not found: ${at}`, 'not_found');
        messages = messages.slice(0, idx + 1);
      }
      const fork = ctx.sessions.create({
        cwd: src.cwd,
        title: `${src.title} (fork)`.slice(0, 200),
        kind: 'chat',
        model: src.model,
        permissionMode: src.permissionMode,
        thinking: src.thinking,
        engine: src.engine,
        usage: { ...src.usage },
      });
      fork.messages = structuredClone(messages).map((m) => ({
        ...m,
        blocks: m.blocks.map((b) =>
          b.type === 'tool_use' && ACTIVE_TOOL.includes(b.status) ? { ...b, status: 'interrupted' as const } : b,
        ),
      }));
      fork.todos = structuredClone(src.todos);
      ctx.sessions.save(fork);
      const sum = toSummary(fork);
      ctx.bus.emit('session.created', sum);
      return sum;
    },
    'sessions.setPinned': (params) => {
      const p = obj(params);
      const pinned = reqBool(p, 'pinned');
      return mutate(reqStr(p, 'id'), (s) => {
        s.pinned = pinned;
      });
    },
    'sessions.search': (params) => {
      const q = reqStr(obj(params), 'query', true);
      return ctx.sessions.search(q);
    },

    // ── chat
    'chat.send': async (params) => {
      const p = obj(params);
      const sessionId = reqStr(p, 'sessionId');
      getSession(sessionId);
      const text = reqStr(p, 'text', true);
      const images = Array.isArray(p.images) ? (p.images as RpcParams<'chat.send'>['images']) : undefined;
      if (!text.trim() && !images?.length) throw new RpcError('Message is empty', 'invalid_params');
      return ctx.agent.send(sessionId, text, images);
    },
    'chat.interrupt': (params) => {
      ctx.agent.interrupt(reqStr(obj(params), 'sessionId'));
      return { ok: true as const };
    },
    'chat.dequeue': (params) => {
      const p = obj(params);
      return { removed: ctx.agent.dequeue(reqStr(p, 'sessionId'), optStr(p, 'messageId')) };
    },
    'chat.respondPermission': (params) => {
      const p = obj(params);
      const decision = p.decision;
      if (decision !== 'allow' && decision !== 'allow_always' && decision !== 'deny') {
        throw new RpcError('Invalid params: "decision" must be allow, allow_always or deny', 'invalid_params');
      }
      ctx.agent.respondPermission(reqStr(p, 'requestId'), decision, optStr(p, 'message'));
      return { ok: true as const };
    },
    'chat.answerQuestion': (params) => {
      const p = obj(params);
      const answers = p.answers;
      if (!answers || typeof answers !== 'object' || Array.isArray(answers)) {
        throw new RpcError('Invalid params: "answers" must be an object', 'invalid_params');
      }
      ctx.agent.answerQuestion(reqStr(p, 'requestId'), answers as Record<string, string>);
      return { ok: true as const };
    },
    'chat.respondPlan': (params) => {
      const p = obj(params);
      const approve = reqBool(p, 'approve');
      const m = p.mode === undefined || p.mode === null ? undefined : mode(p.mode);
      ctx.agent.respondPlan(reqStr(p, 'requestId'), approve, m, optStr(p, 'feedback'));
      return { ok: true as const };
    },
    'chat.setPermissionMode': (params) => {
      const p = obj(params);
      const m = mode(p.mode);
      return mutate(reqStr(p, 'sessionId'), (s) => {
        s.permissionMode = m;
      });
    },
    'chat.setModel': (params) => {
      const p = obj(params);
      const ref = modelRef(p.model);
      return mutate(reqStr(p, 'sessionId'), (s) => {
        s.model = ref;
      });
    },
    'chat.setEngine': (params) => {
      const p = obj(params);
      const sessionId = reqStr(p, 'sessionId');
      getSession(sessionId);
      const engine = engineId(p.engine);
      if (!ctx.agent.setEngine) {
        if (engine !== 'builtin') throw new RpcError('Only the built-in engine is available.', 'invalid_params');
        return mutate(sessionId, (s) => { s.engine = engine; });
      }
      try {
        return ctx.agent.setEngine(sessionId, engine);
      } catch (e) {
        throw new RpcError(e instanceof Error ? e.message : String(e), 'conflict');
      }
    },
    'chat.setThinking': (params) => {
      const p = obj(params);
      const thinking = reqBool(p, 'thinking');
      return mutate(reqStr(p, 'sessionId'), (s) => {
        s.thinking = thinking;
      });
    },
    'chat.rewind': async (params) => {
      const p = obj(params);
      const sessionId = reqStr(p, 'sessionId');
      getSession(sessionId);
      const restoredFiles = await ctx.agent.rewind(sessionId, reqStr(p, 'atMessageId'), p.restoreFiles === true);
      return { ok: true as const, restoredFiles };
    },
    'chat.pending': (params) => ctx.agent.pending(optStr(obj(params), 'sessionId')),

    // ── workspace helpers
    'commands.list': (params) => {
      const p = obj(params);
      const cwd = reqStr(p, 'cwd');
      const sessionId = optStr(p, 'sessionId');
      return ctx.agent.commands ? ctx.agent.commands(cwd, sessionId) : ctx.ext.slashCommands(cwd);
    },
    'skills.list': (params) => ctx.ext.skills(reqStr(obj(params), 'cwd')),
    'agents.list': (params) => ctx.ext.agentTypes(reqStr(obj(params), 'cwd')),
    'files.list': (params) => {
      const p = obj(params);
      return listDir(reqStr(p, 'cwd'), optStr(p, 'dir'));
    },
    'files.search': (params) => {
      const p = obj(params);
      return searchFiles(reqStr(p, 'cwd'), reqStr(p, 'query', true), optNum(p, 'limit') ?? 50);
    },
    'files.read': (params) => {
      const p = obj(params);
      return readTextFile(reqStr(p, 'path'), ctx.settings.get().defaultCwd, optNum(p, 'maxBytes') ?? 1_000_000);
    },
    'files.diff': (params) => {
      const p = obj(params);
      return ctx.agent.fileDiff(reqStr(p, 'sessionId'), reqStr(p, 'path'));
    },

    // ── models
    'models.list': () => ({ providers: ctx.models.providers(), models: ctx.models.models() }),
    'models.refresh': () => ctx.models.refresh(),
    'engines.list': async () => (ctx.agent.engines
      ? ctx.agent.engines()
      : [{ id: 'builtin' as const, label: 'Obsidian', available: true, detail: 'The app\'s own agent loop.' }]),

    // ── gpu
    'gpu.status': () => ctx.gpu.status(),
    'gpu.catalog': () => ctx.gpu.catalog(),
    'gpu.offers': (params) => {
      const p = obj(params);
      return ctx.gpu.offers(reqStr(p, 'profileId'), optNum(p, 'limit'));
    },
    'gpu.clockIn': (params) => {
      const p = obj(params);
      const opts: { profileId: string; modelId?: string; offerId?: number } = { profileId: reqStr(p, 'profileId') };
      const modelId = optStr(p, 'modelId');
      const offerId = optNum(p, 'offerId');
      if (modelId) opts.modelId = modelId;
      if (offerId !== undefined) opts.offerId = offerId;
      return ctx.gpu.clockIn(opts);
    },
    'gpu.clockOut': (params) => {
      const r = obj(params).reason;
      return ctx.gpu.clockOut(r === 'app_quit' ? 'app_quit' : 'clock_out');
    },
    'gpu.switchModel': (params) => ctx.gpu.switchModel(reqStr(obj(params), 'modelId')),
    'gpu.history': (params) => ctx.gpu.history(optNum(obj(params), 'limit')),
    'gpu.destroyOrphans': async () => ({ destroyed: await ctx.gpu.destroyOrphans() }),
    'gpu.serverLog': async (params) => ({ text: await ctx.gpu.serverLog(optNum(obj(params), 'lines')) }),
    'gpu.testKey': () => ctx.gpu.testKey(),

    // ── scheduler
    'schedules.list': () => ctx.scheduler.list(),
    'schedules.create': (params) => {
      const p = obj(params) as unknown as RpcParams<'schedules.create'>;
      return ctx.scheduler.create(p);
    },
    'schedules.update': (params) => {
      const p = obj(params);
      const patch = obj(p.patch) as Partial<RpcResult<'schedules.update'>>;
      return ctx.scheduler.update(reqStr(p, 'id'), patch);
    },
    'schedules.delete': (params) => {
      ctx.scheduler.delete(reqStr(obj(params), 'id'));
      return { ok: true as const };
    },
    'schedules.runNow': (params) => ctx.scheduler.runNow(reqStr(obj(params), 'id')),

    // ── activity
    'activity.list': () => ctx.activity.list(),
    'activity.stop': (params) => {
      const id = reqStr(obj(params), 'id');
      const item = ctx.activity.list().find((i) => i.id === id);
      ctx.activity.stop(id);
      if (item?.sessionId && (item.kind === 'session' || item.kind === 'subagent' || item.kind === 'schedule_run')) {
        try {
          if (ctx.agent.isRunning(item.sessionId)) ctx.agent.interrupt(item.sessionId);
        } catch {
          /* ignore */
        }
      }
      return { ok: true as const };
    },

    // ── settings & secrets
    'settings.get': () => ctx.settings.get(),
    'settings.update': (params) => {
      const p = obj(params);
      const patch = obj(p.patch) as Partial<Settings>;
      return ctx.settings.update(patch);
    },
    'secrets.set': (params) => {
      const p = obj(params);
      const name = reqStr(p, 'name');
      const value = p.value;
      if (value !== null && typeof value !== 'string') {
        throw new RpcError('Invalid params: "value" must be a string or null', 'invalid_params');
      }
      if (name === 'vast.apiKey' && value === null && gpuHoldsInstance(ctx)) {
        // Without the key the app can no longer destroy the instance: it would keep billing until the server watchdog.
        throw new RpcError(
          'Clock out first (and destroy any parked instance). Without the Vast.ai API key the app cannot stop the instance, so it would keep billing.',
          'gpu_active',
        );
      }
      ctx.secrets.set(name, value);
      if (name.startsWith('local.') || name.startsWith('custom.')) {
        // endpoint credentials changed → provider status may change
        Promise.resolve()
          .then(() => ctx.models.refresh())
          .catch(() => undefined);
      }
      return { ok: true as const };
    },
    'secrets.has': (params) => {
      const p = obj(params);
      if (!Array.isArray(p.names) || p.names.some((n) => typeof n !== 'string')) {
        throw new RpcError('Invalid params: "names" must be an array of strings', 'invalid_params');
      }
      const out: Record<string, boolean> = {};
      for (const n of p.names as string[]) out[n] = ctx.secrets.has(n);
      return out;
    },
  };
  return handlers;
}

/** Run one RPC call against the handler table. Throws RpcError for unknown methods. */
export async function dispatchRpc(handlers: RpcHandlers, method: string, params: unknown): Promise<unknown> {
  if (typeof method !== 'string' || !Object.prototype.hasOwnProperty.call(handlers, method)) {
    throw new RpcError(`Unknown method: ${String(method)}`, 'method_not_found');
  }
  const handler = handlers[method as RpcMethod] as (p: unknown) => unknown;
  return await handler(params ?? {});
}

/** Every RpcMethods key (compile-time checked via the handler table type). */
export type AllRpcMethods = keyof RpcMethods;
