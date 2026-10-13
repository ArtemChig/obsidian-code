// Context-window usage for the chat header meter. Owner: ui-chat (unit-tested).
import type { CatalogModel, ModelInfo, ModelRef } from '@shared/types';

/**
 * The context length to measure a session against: the listed model's, else (a Vast model while the GPU is off and the
 * model is not listed) the catalog's. null = unknown — the meter then shows "—" instead of guessing a size.
 */
export function knownContextLength(model: ModelInfo | undefined, ref: ModelRef | null | undefined, catalog: CatalogModel[] | null): number | null {
  if (model?.contextLength && model.contextLength > 0) return model.contextLength;
  if (ref?.provider === 'vast') {
    const c = catalog?.find((m) => m.id === ref.model)?.contextLength;
    if (c && c > 0) return c;
  }
  return null;
}

export interface ContextUsage {
  /** 0..100, or null when the context length is unknown. */
  pct: number | null;
  ratio: number;
  tone: 'normal' | 'warn' | 'error';
}

/** used = last request's prompt tokens; compactAt = auto-compact threshold as a fraction (0.8). */
export function contextUsage(used: number, total: number | null, compactAt: number): ContextUsage {
  if (!total || total <= 0) return { pct: null, ratio: 0, tone: 'normal' };
  const ratio = Math.min(1, Math.max(0, used) / total);
  const tone = ratio >= compactAt ? 'error' : ratio >= compactAt * 0.75 ? 'warn' : 'normal';
  return { pct: Math.round(ratio * 100), ratio, tone };
}
