// Unified diff viewer (M13): --t3 line-number gutters, thin --ok/--err text on very faint washes, monochrome
// highlighting on context lines, collapsed unchanged hunks. Owner: ui-chat.
import { ChevronsUpDown } from 'lucide-react';
import { memo, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { cn } from '@renderer/lib/cn';
import { ensureLanguage, langFromPath, resolveLang, tokenizeSync, type ThemedToken } from '@renderer/lib/highlighter';
import { collapseDiff, computeDiff, parseExcerpt, type DiffRow } from '../lib/diff';

export interface DiffViewProps {
  before: string;
  after: string;
  /** Used to pick the highlighting language. */
  path?: string;
  isNewFile?: boolean;
  /** Max height before scrolling (px). */
  maxHeight?: number;
  /** Unchanged context lines kept around each change. */
  context?: number;
  className?: string;
}

function useTokenLines(code: string, lang: string | null): ThemedToken[][] | null {
  const [ready, setReady] = useState(() => (lang ? tokenizeSync('', lang) !== null : false));
  useEffect(() => {
    let alive = true;
    if (!lang || lang === 'plaintext') return;
    void ensureLanguage(lang).then((ok) => {
      if (alive && ok) setReady(true);
    });
    return () => {
      alive = false;
    };
  }, [lang]);
  return useMemo(() => (ready && lang && code ? tokenizeSync(code, lang) : null), [ready, lang, code]);
}

/** Token style; on added/deleted lines the status colour wins (thin --ok / --err text), weight and italics stay. */
function tokStyle(t: ThemedToken, plain?: boolean): CSSProperties | undefined {
  if ((plain || !t.color) && !t.fontStyle) return undefined;
  const s: CSSProperties = plain ? {} : { color: t.color };
  if (t.fontStyle && t.fontStyle & 1) s.fontStyle = 'italic';
  if (t.fontStyle && t.fontStyle & 2) s.fontWeight = 600;
  return s;
}

function Line({ row, tokens, single }: { row: DiffRow; tokens: ThemedToken[] | undefined; single: boolean }) {
  // A new file is all additions: there is no change to point at, so its code keeps the monochrome highlighting and only
  // the sign + a fainter wash carry the status. Real edits tint the changed lines' text (thin --ok / --err).
  const changed = !single && (row.type === 'add' || row.type === 'del');
  return (
    <div className={cn('flex min-w-full', row.type === 'add' && (single ? 'bg-ok/[0.035]' : 'bg-ok/[0.055]'), row.type === 'del' && 'bg-err/[0.065]')} data-diff={row.type}>
      {!single ? (
        <span className="w-[var(--dv-g)] shrink-0 select-none pr-2 text-right text-t3" aria-hidden>
          {row.oldNo ?? ''}
        </span>
      ) : null}
      <span className="w-[var(--dv-g)] shrink-0 select-none pr-2 text-right text-t3" aria-hidden>
        {row.newNo ?? ''}
      </span>
      <span aria-hidden className={cn('w-5 shrink-0 select-none text-center', row.type === 'add' ? 'text-ok' : row.type === 'del' ? 'text-err' : 'text-transparent')}>
        {row.type === 'add' ? '+' : row.type === 'del' ? '−' : ' '}
      </span>
      <span className={cn('whitespace-pre pr-4', changed ? (row.type === 'add' ? 'text-ok' : 'text-err') : !tokens && (single ? 'text-t1' : 'text-t2'))}>
        {tokens && tokens.length
          ? tokens.map((t, i) => (
              <span key={i} style={tokStyle(t, changed)}>
                {t.content}
              </span>
            ))
          : row.text || ' '}
      </span>
    </div>
  );
}

export const DiffView = memo(function DiffView({ before, after, path, isNewFile, maxHeight, context = 3, className }: DiffViewProps) {
  const model = useMemo(() => computeDiff(isNewFile ? '' : before, after), [before, after, isNewFile]);
  const items = useMemo(() => collapseDiff(model.rows, context), [model.rows, context]);
  const [open, setOpen] = useState<Record<string, boolean>>({});

  const lang = path ? (resolveLang(langFromPath(path)) ?? null) : null;
  const b = useMemo(() => parseExcerpt(before), [before]);
  const a = useMemo(() => parseExcerpt(after), [after]);
  const oldTokens = useTokenLines(isNewFile ? '' : b.text, lang);
  const newTokens = useTokenLines(a.text, lang);

  // New files have no "old" side: one line-number gutter is enough.
  const single = !!isNewFile || before === '';
  const maxNo = model.rows.reduce((m, r) => Math.max(m, r.oldNo ?? 0, r.newNo ?? 0), 0);
  const gutter = `${Math.max(2, String(maxNo).length) + 1.5}ch`;

  const tokensFor = (row: DiffRow): ThemedToken[] | undefined => {
    if (row.type === 'del') return row.oldNo !== null ? oldTokens?.[row.oldNo - b.offset - 1] : undefined;
    return row.newNo !== null ? newTokens?.[row.newNo - a.offset - 1] : undefined;
  };

  if (!model.rows.length) {
    return <div className={cn('px-3.5 py-3 font-mono text-[11px] text-t3', className)}>(empty file)</div>;
  }

  return (
    <div
      className={cn('ob-selectable overflow-auto bg-s1 py-1.5 font-mono text-[12px] leading-[1.6] tracking-[-0.01em] text-t2', className)}
      style={{ maxHeight, ['--dv-g' as string]: gutter }}
      data-testid="diff-view"
    >
      <div className="w-max min-w-full">
        {items.map((it) => {
          if (it.kind === 'row') return <Line key={`${it.row.oldNo}:${it.row.newNo}:${it.row.type}`} row={it.row} tokens={tokensFor(it.row)} single={single} />;
          if (open[it.id]) {
            return it.rows.map((row) => <Line key={`${row.oldNo}:${row.newNo}:ctx`} row={row} tokens={tokensFor(row)} single={single} />);
          }
          return (
            <button
              key={it.id}
              type="button"
              onClick={() => setOpen((o) => ({ ...o, [it.id]: true }))}
              className="ob-transition my-1 flex h-6 w-full min-w-full items-center gap-2 border-y border-rule2 pl-3 text-left font-mono text-[9px] uppercase tracking-[0.14em] text-t3 hover:bg-hov hover:text-t1"
              data-testid="diff-gap"
            >
              <ChevronsUpDown size={12} aria-hidden />
              {it.rows.length} unchanged line{it.rows.length === 1 ? '' : 's'}
            </button>
          );
        })}
      </div>
    </div>
  );
});

/** "+12 −3" stat pair. */
export function DiffStat({ additions, deletions, className }: { additions: number; deletions: number; className?: string }) {
  return (
    <span className={cn('ob-tabular inline-flex items-center gap-1.5 font-mono text-[10.5px] tracking-[-0.02em]', className)}>
      <span className="text-ok">+{additions}</span>
      <span className="text-err">−{deletions}</span>
    </span>
  );
}
