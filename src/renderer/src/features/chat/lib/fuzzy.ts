// Small fuzzy matcher for the slash-command palette. Owner: ui-chat. Pure (unit-tested).

/**
 * Score how well `query` matches `target` as a subsequence. Higher is better; null = no match.
 * Bonuses: exact prefix, word-start matches, consecutive runs. Case-insensitive.
 */
export function fuzzyScore(query: string, target: string): number | null {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  if (!q) return 0;
  if (t === q) return 1000;
  if (t.startsWith(q)) return 800 - Math.min(200, t.length - q.length);
  const idx = t.indexOf(q);
  if (idx >= 0) {
    const wordStart = idx === 0 || /[\s\-_/.:]/.test(t[idx - 1]);
    return (wordStart ? 600 : 450) - Math.min(150, idx);
  }
  let score = 0;
  let ti = 0;
  let run = 0;
  for (let qi = 0; qi < q.length; qi++) {
    const ch = q[qi];
    let found = -1;
    for (let k = ti; k < t.length; k++) {
      if (t[k] === ch) {
        found = k;
        break;
      }
    }
    if (found < 0) return null;
    const wordStart = found === 0 || /[\s\-_/.:]/.test(t[found - 1]);
    run = found === ti ? run + 1 : 1;
    score += 10 + (wordStart ? 12 : 0) + run * 4 - Math.min(8, found - ti);
    ti = found + 1;
  }
  return Math.max(1, Math.min(400, score));
}

export interface Ranked<T> {
  item: T;
  score: number;
}

/** Rank items by the best of their fields (primary field weighted fully, others at `secondaryWeight`). */
export function fuzzyRank<T>(items: T[], query: string, fields: (item: T) => [string, ...string[]], secondaryWeight = 0.35): T[] {
  if (!query.trim()) return items.slice();
  const out: Ranked<T>[] = [];
  items.forEach((item) => {
    const [primary, ...rest] = fields(item);
    let best = fuzzyScore(query, primary);
    for (const f of rest) {
      const s = fuzzyScore(query, f);
      if (s !== null) {
        const w = s * secondaryWeight;
        if (best === null || w > best) best = w;
      }
    }
    if (best !== null) out.push({ item, score: best });
  });
  // Stable: Array.prototype.sort is stable, so equal scores keep the input order.
  return out.sort((a, b) => b.score - a.score).map((r) => r.item);
}
