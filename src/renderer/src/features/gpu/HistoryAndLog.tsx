// History table and server log viewer of the GPU view. Owner: ui-views.
import { ChevronDown, ChevronRight, History, RefreshCw, ScrollText } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { CatalogModel, GpuSessionRecord } from '@shared/types';
import { Badge } from '@renderer/components/ui/badge';
import { Button, IconButton } from '@renderer/components/ui/button';
import { EmptyState, Skeleton } from '@renderer/components/ui/feedback';
import { cn } from '@renderer/lib/cn';
import { formatDateTime, formatDuration, formatMoney, formatPerHour, shortModelName } from '@renderer/lib/format';
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
    <section className="overflow-hidden rounded-card border border-ob-border bg-ob-surface-1" data-testid="gpu-history" aria-label="History">
      <header className="flex items-center gap-2 border-b border-ob-border px-4 py-3">
        <History size={15} aria-hidden className="text-ob-text-3" />
        <h3 className="text-ui font-medium text-ob-text">History</h3>
        <span className="flex-1" />
        {records ? <span className="ob-tabular font-mono text-[11.5px] text-ob-text-3">{formatMoney(sumCost(records))} over {total} {total === 1 ? 'session' : 'sessions'}</span> : null}
      </header>
      {records === null && !error ? (
        <div className="flex flex-col gap-3 p-4" aria-hidden>
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-4 w-full" />
          ))}
        </div>
      ) : error && records === null ? (
        <div className="px-4 py-6 text-center text-ui text-ob-danger">{error}</div>
      ) : total === 0 ? (
        <EmptyState size="sm" icon={History} title="No GPU sessions yet" description="Past clock-ins, their cost and why they ended show up here." />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] border-collapse text-ui">
            <thead>
              <tr className="border-b border-ob-border text-left">
                {['Started', 'GPU', 'Model', 'Duration', 'Rate', 'Cost', 'Ended'].map((h, i) => (
                  <th key={h} className={cn('ob-section-label px-4 py-2 font-normal', i >= 3 && i <= 5 && 'text-right')}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} data-testid="gpu-history-row" className="ob-transition border-b border-ob-border last:border-b-0 hover:bg-ob-hover">
                  <td className="whitespace-nowrap px-4 py-2 text-ob-text-2">{formatDateTime(r.startedAt)}</td>
                  <td className="whitespace-nowrap px-4 py-2 text-ob-text">
                    {r.numGpus > 1 ? `${r.numGpus}× ` : ''}
                    {r.gpuName}
                  </td>
                  <td className="max-w-[220px] truncate px-4 py-2 text-ob-text-2" title={r.modelId}>
                    {modelName(r.modelId)}
                  </td>
                  <td className="ob-tabular whitespace-nowrap px-4 py-2 text-right font-mono text-[12px] text-ob-text-2">{r.endedAt ? formatDuration(r.endedAt - r.startedAt) : 'running'}</td>
                  <td className="ob-tabular whitespace-nowrap px-4 py-2 text-right font-mono text-[12px] text-ob-text-3">{formatPerHour(r.pricePerHour)}</td>
                  <td className="ob-tabular whitespace-nowrap px-4 py-2 text-right font-mono text-[12px] text-ob-text">{formatMoney(r.cost)}</td>
                  <td className="whitespace-nowrap px-4 py-2">
                    {r.endReason ? (
                      <Badge tone={endReasonTone(r.endReason)} variant="soft">
                        {END_REASON_LABEL[r.endReason]}
                      </Badge>
                    ) : (
                      <span className="text-ob-text-3">{r.endedAt ? '—' : 'in progress'}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {total > pageSize ? (
        <div className="border-t border-ob-border px-4 py-2">
          <Button size="sm" variant="ghost" onClick={() => setAll((v) => !v)} data-testid="gpu-history-more">
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
    <section className="overflow-hidden rounded-card border border-ob-border bg-ob-surface-1" data-testid="gpu-log" aria-label="Server log">
      <header className="flex items-center gap-2 px-4 py-3">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="ob-transition -ml-1 flex flex-1 items-center gap-2 rounded-ctl px-1 py-0.5 text-left hover:bg-ob-hover"
          data-testid="gpu-log-toggle"
        >
          {open ? <ChevronDown size={14} aria-hidden className="text-ob-text-3" /> : <ChevronRight size={14} aria-hidden className="text-ob-text-3" />}
          <ScrollText size={15} aria-hidden className="text-ob-text-3" />
          <span className="text-ui font-medium text-ob-text">Server log</span>
          <span className="text-small text-ob-text-3">llama-server output on the rented machine</span>
        </button>
        {open ? (
          <>
            {lines ? <span className="ob-tabular font-mono text-[11.5px] text-ob-text-3">{lines} lines</span> : null}
            <IconButton label="Refresh log" icon={RefreshCw} size="md" loading={loading} onClick={() => void reload()} />
          </>
        ) : null}
      </header>
      {open ? (
        <div className="border-t border-ob-border bg-ob-code-bg">
          {error ? (
            <div className="px-4 py-4 text-ui text-ob-danger">{error}</div>
          ) : text === null ? (
            <div className="px-4 py-4 text-ui text-ob-text-3">Loading…</div>
          ) : text.trim() === '' ? (
            <div className="px-4 py-4 text-ui text-ob-text-3">The log is empty. It fills once a GPU is clocked in and the server starts.</div>
          ) : (
            <pre
              ref={ref}
              data-testid="gpu-log-text"
              className="ob-selectable max-h-[280px] overflow-auto whitespace-pre-wrap break-words px-4 py-3 font-mono text-[11.5px] leading-[1.6] text-ob-text-2"
            >
              {text}
            </pre>
          )}
        </div>
      ) : null}
    </section>
  );
}
