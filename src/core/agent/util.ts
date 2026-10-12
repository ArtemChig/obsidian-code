// Small helpers for the agent loop.

import { nanoid } from 'nanoid';
import type { Session, SessionSummary } from '../../shared/types';

export function newId(): string {
  return nanoid(16);
}

export function toSummary(s: Session): SessionSummary {
  const { messages: _m, todos: _t, changedFiles: _c, ...rest } = s;
  return { ...rest };
}

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  try { return JSON.stringify(e); } catch { return String(e); }
}

export class Semaphore {
  private active = 0;
  private readonly waiters: (() => void)[] = [];
  constructor(private readonly max: number) {}

  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) throw new Error('Interrupted');
    if (this.active < this.max) { this.active++; return this.releaser(); }
    await new Promise<void>((resolve, reject) => {
      const go = () => { signal?.removeEventListener('abort', onAbort); this.active++; resolve(); };
      const onAbort = () => {
        const i = this.waiters.indexOf(go);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new Error('Interrupted'));
      };
      this.waiters.push(go);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
    return this.releaser();
  }

  private releaser(): () => void {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.active--;
      this.waiters.shift()?.();
    };
  }
}

export class AbortedError extends Error {
  constructor() { super('Interrupted by the user.'); this.name = 'AbortedError'; }
}

/** Resolve/reject with p, or reject as soon as the signal aborts (tools that ignore the signal can't hang the loop). */
export function raceAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { p.catch(() => {}); return Promise.reject(new AbortedError()); }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => { p.catch(() => {}); reject(new AbortedError()); };
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => { signal.removeEventListener('abort', onAbort); resolve(v); },
      (e) => { signal.removeEventListener('abort', onAbort); reject(e); },
    );
  });
}

export function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const t = setTimeout(() => resolve(fallback), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, () => { clearTimeout(t); resolve(fallback); });
  });
}

/** Truncate tool output to `max` chars, keeping head and tail, with a note for the model. */
export function truncateOutput(content: string, max: number): string {
  if (!max || content.length <= max) return content;
  const head = Math.floor(max * 0.7);
  const tail = Math.max(0, max - head);
  const omitted = content.length - head - tail;
  return `${content.slice(0, head)}\n\n[… output truncated: ${omitted} of ${content.length} characters omitted. Narrow the command/query or use offset/limit to see the rest …]\n\n${content.slice(content.length - tail)}`;
}

export function clipLine(s: string, n: number): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1).trimEnd()}…` : one;
}

const DEFAULT_TITLE_RE = /^(new (session|chat|conversation)|untitled( session)?|session)?$/i;
export function isDefaultTitle(t: string | undefined): boolean {
  return DEFAULT_TITLE_RE.test((t ?? '').trim());
}

export function sanitizeTitle(raw: string): string {
  let t = raw.replace(/<think>[\s\S]*?<\/think>/g, '').split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  t = t.replace(/^(title\s*:\s*)/i, '').replace(/^["'`*#\s]+|["'`*\s]+$/g, '').replace(/[.!?:;,]+$/, '').trim();
  const words = t.split(/\s+/).filter(Boolean).slice(0, 6);
  t = words.join(' ');
  return t.length > 60 ? t.slice(0, 60).trim() : t;
}
