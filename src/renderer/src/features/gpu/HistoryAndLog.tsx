// History (a mono table) and the server log (an --s1 mono well) of the GPU view. Owner: ui-views.
import { ChevronDown, ChevronRight, History, RefreshCw } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { CatalogModel, GpuSessionRecord } from '@shared/types';
import { Badge } from '@renderer/components/ui/badge';
import { Button, IconButton } from '@renderer/components/ui/button';
import { EmptyState, Skeleton } from '@renderer/components/ui/feedback';
import { SectionLabel } from '@renderer/components/ui/layout';
import { cn } from '@renderer/lib/cn';
import { formatDateTime, formatDuration, formatMoney, formatPerHour, shortModelName } from '@renderer/lib/format';
import { TD, TH } from '../settings/view-kit';
import { END_REASON_LABEL, endReasonTone, splitModelLabel, sumCost } from './model';
import { useServerLog } from './hooks';

// ───────────────────────────── History ─────────────────────────────

export function HistoryTable({ records, error, catalog, pageSize = 8 }: { records: GpuSessionRecord[] | null; error: string | null; catalog: CatalogModel[] | null; pageSize?: number }) {
  const [all, setAll] = useState(false);
  const rows = useMemo(() => {
    const sorted = [...(records ?? [])].sort((a, b) => b.startedAt - a.startedAt);
    return all ? sorted : sorted.slice(0, pageSize);
  }, [records, all, pageSize]);
  const total = records?.length ?? 0;
  const modelName = (id: string) => {
    const m = catalog?.find((c) => c.id === id);
    return m ? splitModelLabel(m.label).name : shortModelName(id);
  };
  return (
    <section className="flex flex-col gap-1.5" data-testid="gpu-history" aria-label="History">
      <SectionLabel
        rule
        action={
          records ? (
            <span className="ob-tabular font-mono normal-case tracking-[0.01em] text-t3">
              <span className="text-t1">{formatMoney(sumCost(records))}</span> over {total} {total === 1 ? 'session' : 'sessions'}
            </span>
          ) : undefined
        }
      >
        History
      </SectionLabel>
      {records === null && !error ? (
        <div className="flex flex-col gap-2.5 py-2" aria-hidden>
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-3 w-full" />
          ))}
        </div>
      ) : error && records === null ? (
        <div className="border-b border-rule2 py-3 text-[11.5px] text-err">{error}</div>
      ) : total === 0 ? (
        <EmptyState size="sm" icon={History} title="No GPU sessions yet" description="Past clock-ins, their cost and why they ended show up here." />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[680px] border-collapse">
            <thead>
              <tr>
                {['Started', 'GPU', 'Model', 'Duration', 'Rate', 'Cost', 'Ended'].map((h, i) => (
                  <th key={h} className={cn(TH, i >= 3 && i <= 5 && 'text-right')}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="font-mono text-[10.5px] tracking-[-0.02em]">
              {rows.map((r) => (
                <tr key={r.id} data-testid="gpu-history-row" className="ob-transition hover:bg-hov">
                  <td className={cn(TD, 'ob-tabular text-t2')}>{formatDateTime(r.startedAt)}</td>
                  <td className={cn(TD, 'text-t1')}>
                    {r.numGpus > 1 ? `${r.numGpus}× ` : ''}
                    {r.gpuName}
                  </td>
                  <td className={cn(TD, 'max-w-[220px] truncate font-sans text-[11.5px] tracking-[-0.01em] text-t2')} title={r.modelId}>
                    {modelName(r.modelId)}
                  </td>
                  <td className={cn(TD, 'ob-tabular text-right text-t2')}>{r.endedAt ? formatDuration(r.endedAt - r.startedAt) : 'running'}</td>
                  <td className={cn(TD, 'ob-tabular text-right text-t3')}>{formatPerHour(r.pricePerHour)}</td>
                  <td className={cn(TD, 'ob-tabular text-right text-t1')}>{formatMoney(r.cost)}</td>
                  <td className={cn(TD, 'pl-4')}>
                    {r.endReason ? (
                      <Badge tone={endReasonTone(r.endReason)} variant="outline">
                        {END_REASON_LABEL[r.endReason]}
                      </Badge>
                    ) : (
                      <span className="text-t3">{r.endedAt ? '—' : 'in progress'}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {total > pageSize ? (
        <div className="py-1">
          <Button size="sm" variant="ghost" className="-ml-2.5" onClick={() => setAll((v) => !v)} data-testid="gpu-history-more">
            {all ? 'Show fewer' : `Show all ${total}`}
          </Button>
        </div>
      ) : null}
    </section>
  );
}

// ───────────────────────────── Server log ─────────────────────────────

export function ServerLog({ live }: { live: boolean }) {
  const [open, setOpen] = useState(false);
  const { text, loading, error, reload } = useServerLog(open, open && live ? 5000 : null);
  const ref = useRef<HTMLPreElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [text, open]);

  const lines = text ? text.split(/\r?\n/).length : 0;
  return (
    <section className="flex flex-col gap-1.5" data-testid="gpu-log" aria-label="Server log">
      <div className="flex min-h-7 items-center gap-2.5">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="ob-transition group -ml-1 flex min-w-0 flex-1 items-center gap-2 rounded-[2px] px-1 py-1 text-left hover:bg-hov"
          data-testid="gpu-log-toggle"
        >
          {open ? <ChevronDown size={12} aria-hidden className="shrink-0 text-t3" /> : <ChevronRight size={12} aria-hidden className="shrink-0 text-t3" />}
          <span className="ob-cap shrink-0 group-hover:text-t2">Server log</span>
          <span className="truncate font-mono text-[9.5px] tracking-[0.01em] text-t3">llama-server output on the rented machine</span>
          <span aria-hidden className="ml-1 h-px min-w-4 flex-1 bg-rule2" />
        </button>
        {open ? (
          <>
            {lines ? <span className="ob-tabular shrink-0 font-mono text-[9.5px] text-t3">{lines} lines</span> : null}
            <IconButton label="Refresh log" icon={RefreshCw} size="sm" loading={loading} onClick={() => void reload()} />
          </>
        ) : null}
      </div>
      {open ? (
        <div className="rounded-[2px] bg-s1 shadow-[inset_0_0_0_1px_var(--rule)]">
          {error ? (
            <div className="px-4 py-3 text-[11.5px] text-err">{error}</div>
          ) : text === null ? (
            <div className="px-4 py-3 font-mono text-[10.5px] text-t3">Loading…</div>
          ) : text.trim() === '' ? (
            <div className="px-4 py-3 text-[11.5px] text-t3">The log is empty. It fills once a GPU is clocked in and the server starts.</div>
          ) : (
            <pre
              ref={ref}
              data-testid="gpu-log-text"
              className="ob-selectable max-h-[280px] overflow-auto whitespace-pre-wrap break-words px-4 py-3 font-mono text-[10.5px] leading-[1.6] tracking-[-0.01em] text-t2"
            >
              {text}
            </pre>
          )}
        </div>
      ) : null}
    </section>
  );
}
