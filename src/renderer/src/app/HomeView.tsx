// Home (no session selected): quick-start composer, recent sessions, GPU + models status. Owner: ui-foundation.
import { ArrowRight, ArrowUp, Box, CalendarClock, Check, ChevronDown, Cpu, Folder, MessageSquare, Power, RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { ModelRef, SessionSummary } from '@shared/types';
import { AppMark } from '@renderer/components/ui/app-mark';
import { Badge } from '@renderer/components/ui/badge';
import { Button, IconButton } from '@renderer/components/ui/button';
import { EmptyState, ProgressBar, Spinner, StatusDot } from '@renderer/components/ui/feedback';
import { Textarea } from '@renderer/components/ui/input';
import { Card, SectionLabel } from '@renderer/components/ui/layout';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@renderer/components/ui/menu';
import { LiveDuration, RelativeTime } from '@renderer/components/ui/time';
import { Tooltip } from '@renderer/components/ui/tooltip';
import { pickFolder } from '@renderer/lib/bridge';
import { cn } from '@renderer/lib/cn';
import { basename, formatMoney, formatPerHour, pluralize, shortModelName, shortenPath, sameModel } from '@renderer/lib/format';
import { ModelNotice } from '@renderer/features/chat/composer/ModelNotice';
import { SyncFailed, useSyncError } from '@renderer/features/settings/core-missing';
import { createSession, navigate, openSession, refreshModels, sendMessage } from '@renderer/state/actions';
import { useGpu } from '@renderer/state/gpu';
import { useModels } from '@renderer/state/models';
import { findModel, useModelGroups, useRecentSessions, useWaitingSessionIds } from '@renderer/state/selectors';
import { useSessions } from '@renderer/state/sessions';
import { useSettings } from '@renderer/state/settings';
import { GPU_PHASE_LABEL, gpuPrimaryAction, gpuTone, useLiveGpuCost, useModelLabel } from './GpuWidget';

function greeting(d = new Date()): string {
  const h = d.getHours();
  if (h < 5) return 'Working late';
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

// ───────────────────────────── Quick start ─────────────────────────────

function ModelChip({ value, onChange }: { value: ModelRef | null; onChange: (m: ModelRef) => void }) {
  const groups = useModelGroups();
  const models = useModels((s) => s.models);
  const info = findModel(models, value);
  const label = info?.label ?? (value ? shortModelName(value.model) : 'Default model');
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-testid="home-model"
          className="ob-transition flex h-7 max-w-[260px] items-center gap-1.5 rounded-[6px] px-2 text-small text-ob-text-2 hover:bg-ob-hover hover:text-ob-text data-[state=open]:bg-ob-hover"
        >
          {info ? <StatusDot status={info.status} size={6} /> : <Box size={13} aria-hidden className="text-ob-text-3" />}
          <span className="truncate">{label}</span>
          <ChevronDown size={12} aria-hidden className="shrink-0 text-ob-text-3" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-[360px]">
        {groups.length === 0 ? <div className="px-2 py-3 text-small text-ob-text-3">No models available</div> : null}
        {groups.map((g, gi) => (
          <div key={g.provider.id}>
            {gi > 0 ? <DropdownMenuSeparator /> : null}
            <DropdownMenuLabel>{g.provider.label}</DropdownMenuLabel>
            {g.models.map((m) => (
              <DropdownMenuItem
                key={`${m.ref.provider}::${m.ref.model}`}
                disabled={m.status === 'offline'}
                onSelect={() => onChange(m.ref)}
                leading={<StatusDot status={m.status} size={6} className="mx-1" />}
                trailing={
                  <>
                    {m.variant ? (
                      <Badge tone={m.variant === 'uncensored' ? 'violet' : 'neutral'} mono>
                        {m.variant}
                      </Badge>
                    ) : null}
                    {sameModel(m.ref, value) ? <Check size={14} aria-label="Selected" className="text-ob-accent" /> : <span className="w-3.5" />}
                  </>
                }
              >
                {m.label}
              </DropdownMenuItem>
            ))}
          </div>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function QuickStart() {
  const settings = useSettings((s) => s.settings);
  const homeDir = useSettings((s) => s.system?.homeDir ?? null);
  const [text, setText] = useState('');
  const [cwd, setCwd] = useState<string | null>(null);
  const [model, setModel] = useState<ModelRef | null>(null);
  const [busy, setBusy] = useState(false);
  const folder = cwd ?? settings?.defaultCwd ?? '';
  const chosenModel = model ?? settings?.defaultModel ?? null;

  const start = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const s = await createSession({ cwd: folder || undefined, model: chosenModel });
      if (s && text.trim()) {
        await sendMessage(s.id, text.trim());
        setText('');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
    <div
      data-testid="quick-start"
      className="@container ob-transition rounded-[12px] border border-ob-border bg-ob-surface-1 focus-within:border-[rgba(143,184,222,0.42)] focus-within:shadow-[0_0_0_4px_rgba(143,184,222,0.07)]"
    >
      <Textarea
        bare
        minRows={3}
        maxRows={12}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void start();
          }
        }}
        aria-label="Describe a task"
        placeholder="Describe a task — Obsidian Code will read, plan, edit and run it…"
        className="block px-4 pb-1 pt-3.5 text-[14.5px] leading-[22px]"
      />
      <div className="flex items-center gap-1 px-2 pb-2 pt-1">
        <Tooltip content={folder || 'Choose a folder'}>
          <button
            type="button"
            data-testid="home-folder"
            onClick={async () => {
              const picked = await pickFolder(folder || undefined);
              if (picked) setCwd(picked);
            }}
            className="ob-transition flex h-7 max-w-[300px] items-center gap-1.5 rounded-[6px] px-2 text-small text-ob-text-2 hover:bg-ob-hover hover:text-ob-text"
          >
            <Folder size={13} aria-hidden className="shrink-0 text-ob-text-3" />
            <span className="truncate font-mono text-[11.5px]">{folder ? shortenPath(folder, homeDir, 2) : 'Choose folder'}</span>
          </button>
        </Tooltip>
        <ModelChip value={chosenModel} onChange={setModel} />
        <span className="flex-1" />
        <span className="mr-2 hidden text-meta text-ob-text-3 @min-[780px]:inline">
          <span className="font-mono">Enter</span> to start · <span className="font-mono">Shift+Enter</span> new line
        </span>
        <Button variant="primary" size="md" loading={busy} icon={text.trim() ? ArrowUp : undefined} onClick={() => void start()} data-testid="home-start">
          {text.trim() ? 'Start' : 'New session'}
        </Button>
      </div>
    </div>
    <ModelNotice model={chosenModel} />
    </div>
  );
}

// ───────────────────────────── Recent sessions ─────────────────────────────

function SessionLine({ s, waiting }: { s: SessionSummary; waiting: boolean }) {
  const models = useModels((st) => st.models);
  const unread = useSessions((st) => !!st.unread[s.id]);
  const info = findModel(models, s.model);
  const modelName = info?.label ?? (s.model ? shortModelName(s.model.model) : null);
  return (
    <button
      type="button"
      onClick={() => openSession(s.id)}
      data-testid="home-session"
      className="ob-transition group flex w-full items-center gap-3 px-3.5 py-2.5 text-left hover:bg-[rgba(236,240,241,0.035)]"
    >
      <div
        className={cn(
          'flex size-8 shrink-0 items-center justify-center rounded-[8px] border',
          s.status === 'running'
            ? 'border-[rgba(143,184,222,0.3)] bg-ob-accent-soft text-ob-accent'
            : waiting || s.status === 'waiting'
              ? 'border-[rgba(232,184,92,0.3)] bg-ob-warning-soft text-ob-warning'
              : 'border-ob-border bg-ob-surface-2 text-ob-text-3',
        )}
      >
        {s.status === 'running' ? <Spinner size={14} /> : s.kind === 'scheduled' ? <CalendarClock size={14} aria-hidden /> : <MessageSquare size={14} aria-hidden />}
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex min-w-0 items-center gap-2">
          <span className={cn('truncate text-ui', unread ? 'font-medium text-ob-text' : 'text-ob-text')}>{s.title || 'Untitled'}</span>
          {unread ? <StatusDot tone="accent" size={6} label="Unread" /> : null}
          {waiting || s.status === 'waiting' ? (
            <Badge tone="warning" size="sm">
              Needs you
            </Badge>
          ) : null}
        </div>
        <div className="flex min-w-0 items-center gap-1.5 text-small text-ob-text-3">
          <span className="shrink-0">{basename(s.cwd)}</span>
          {modelName ? (
            <>
              <span aria-hidden>·</span>
              <span className="truncate">{modelName}</span>
            </>
          ) : null}
          {s.usage.requests ? (
            <>
              <span aria-hidden>·</span>
              <span className="shrink-0">{pluralize(s.usage.requests, 'turn')}</span>
            </>
          ) : null}
        </div>
      </div>
      <RelativeTime ts={s.updatedAt} className="shrink-0 font-mono text-[11px] text-ob-text-3" />
      <ArrowRight size={14} aria-hidden className="-ml-1 shrink-0 text-ob-text-3 opacity-0 transition-opacity group-hover:opacity-100" />
    </button>
  );
}

function RecentSessions() {
  const recent = useRecentSessions(7);
  const loaded = useSessions((s) => s.loaded);
  const sessionsError = useSyncError('sessions');
  const total = useSessions((s) => Object.values(s.sessions).filter((x) => x.kind !== 'subagent').length);
  const waiting = useWaitingSessionIds();
  return (
    <section aria-label="Recent sessions" className="min-w-0">
      <SectionLabel action={total ? <span className="font-mono text-[11px] text-ob-text-3">{total}</span> : undefined}>Recent sessions</SectionLabel>
      <div className="mt-2 overflow-hidden rounded-card border border-ob-border bg-ob-surface-1">
        {!loaded && sessionsError ? (
          <SyncFailed what="sessions" error={sessionsError} compact />
        ) : !loaded ? (
          <div className="flex flex-col gap-3 p-4" aria-hidden>
            {[0, 1, 2].map((i) => (
              <div key={i} className="flex items-center gap-3">
                <div className="ob-skeleton size-8" />
                <div className="flex flex-1 flex-col gap-1.5">
                  <div className="ob-skeleton h-3 w-2/3" />
                  <div className="ob-skeleton h-2.5 w-1/3" />
                </div>
              </div>
            ))}
          </div>
        ) : recent.length ? (
          <div className="flex flex-col divide-y divide-ob-border">
            {recent.map((s) => (
              <SessionLine key={s.id} s={s} waiting={waiting.has(s.id)} />
            ))}
          </div>
        ) : (
          <EmptyState size="sm" icon={MessageSquare} title="No sessions yet" description="Describe a task above to start your first session." />
        )}
      </div>
    </section>
  );
}

// ───────────────────────────── Status cards ─────────────────────────────

function Metric({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="ob-section-label text-[10px]">{label}</span>
      <span className="ob-tabular truncate font-mono text-[13px] text-ob-text">
        {value}
        {sub ? <span className="text-ob-text-3"> {sub}</span> : null}
      </span>
    </div>
  );
}

function GpuCard() {
  const status = useGpu((s) => s.status);
  const hasKey = useGpu((s) => s.hasApiKey);
  const busy = useGpu((s) => s.busy);
  const cost = useLiveGpuCost(status);
  const modelLabel = useModelLabel(status?.modelId);
  const phase = status?.phase ?? 'off';
  const on = phase !== 'off' && phase !== 'error';
  const budget = status?.monthlyBudget ?? 0;
  const month = (status?.monthCost ?? 0) + (on ? cost : 0);
  const ratio = budget > 0 ? month / budget : 0;
  return (
    <Card padding="none" data-testid="home-gpu-card" className="overflow-hidden">
      <div className="flex items-center gap-2 px-4 pt-3.5">
        <StatusDot tone={gpuTone(phase)} glow={phase === 'ready'} pulse={on && phase !== 'ready'} />
        <span className="text-ui font-medium text-ob-text">GPU</span>
        <span className="text-ui text-ob-text-3">{GPU_PHASE_LABEL[phase]}</span>
        <span className="flex-1" />
        {on && status?.clockedInAt ? <LiveDuration since={status.clockedInAt} className="font-mono text-[12px] text-ob-text-2" /> : null}
      </div>
      <div className="mt-1 truncate px-4 text-small text-ob-text-3">
        {on ? [status?.gpuName && `${status.numGpus && status.numGpus > 1 ? `${status.numGpus}× ` : ''}${status.gpuName}`, modelLabel].filter(Boolean).join(' · ') : 'Rent an RTX 5090 or RTX PRO 6000 by the hour on Vast.ai.'}
      </div>
      <div className="mt-3.5 grid grid-cols-2 gap-3 px-4">
        <Metric label="Rate" value={on ? formatPerHour(status?.pricePerHour) : '—'} />
        <Metric label={on ? 'This session' : 'Credit'} value={on ? formatMoney(cost) : formatMoney(status?.creditBalance)} />
      </div>
      <div className="mt-3.5 px-4">
        <div className="mb-1.5 flex items-center justify-between text-small">
          <span className="text-ob-text-3">This month</span>
          <span className="ob-tabular font-mono text-[11.5px] text-ob-text-2">
            {status ? (
              <>
                {formatMoney(month)} <span className="text-ob-text-3">/ {formatMoney(budget)}</span>
              </>
            ) : (
              '—'
            )}
          </span>
        </div>
        <ProgressBar value={Math.min(1, ratio)} tone={ratio > 0.9 ? 'danger' : ratio > 0.7 ? 'warning' : 'accent'} label="Monthly budget used" />
      </div>
      <div className="mt-4 flex items-center gap-2 border-t border-ob-border bg-[rgba(0,0,0,0.12)] px-3 py-2.5">
        <Button size="sm" variant={on ? 'danger' : 'primary'} icon={Power} loading={busy || phase === 'stopping'} onClick={() => void gpuPrimaryAction(status, hasKey)}>
          {on ? 'Clock out' : 'Clock in'}
        </Button>
        <Button size="sm" variant="ghost" icon={Cpu} onClick={() => navigate('gpu')}>
          GPU view
        </Button>
      </div>
    </Card>
  );
}

function ModelsCard() {
  const providers = useModels((s) => s.providers);
  const models = useModels((s) => s.models);
  const refreshing = useModels((s) => s.refreshing);
  return (
    <section aria-label="Model providers">
      <SectionLabel
        action={<IconButton label="Refresh models" icon={RefreshCw} size="xs" loading={refreshing} onClick={() => void refreshModels()} />}
      >
        Providers
      </SectionLabel>
      <Card padding="none" className="mt-2 divide-y divide-ob-border overflow-hidden">
        {providers.length === 0 ? <div className="px-4 py-3 text-small text-ob-text-3">No providers configured</div> : null}
        {providers.map((p) => {
          const count = models.filter((m) => m.ref.provider === p.id).length;
          return (
            <div key={p.id} className="flex items-center gap-2.5 px-4 py-2.5">
              <StatusDot status={p.status} glow={p.status === 'online'} />
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-ui text-ob-text">{p.label}</span>
                <span className="truncate text-small text-ob-text-3">{p.detail ?? p.baseUrl ?? p.status}</span>
              </div>
              <span className="shrink-0 font-mono text-[11px] text-ob-text-3">{p.status === 'online' ? pluralize(count, 'model') : p.status}</span>
            </div>
          );
        })}
      </Card>
    </section>
  );
}

// ───────────────────────────── View ─────────────────────────────

export function HomeView() {
  const [hello, setHello] = useState(() => greeting());
  useEffect(() => {
    const t = setInterval(() => setHello(greeting()), 60_000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="@container h-full overflow-y-auto bg-[radial-gradient(ellipse_70%_45%_at_50%_-8%,rgba(143,184,222,0.075),transparent_70%)]" data-testid="home">
      <div className="mx-auto flex w-full max-w-[960px] flex-col px-8 pb-16 pt-[7vh] @min-[1000px]:px-10">
        <div className="flex items-center gap-3.5">
          <div className="flex size-11 items-center justify-center rounded-[12px] border border-ob-border bg-[radial-gradient(circle_at_30%_20%,rgba(143,184,222,0.16),transparent_70%)]">
            <AppMark size={26} />
          </div>
          <div className="flex flex-col gap-0.5">
            <h1 className="text-title font-semibold tracking-[-0.015em] text-ob-text">{hello}</h1>
            <p className="text-ui text-ob-text-3">Start a session, or pick up where you left off.</p>
          </div>
        </div>

        <div className="mt-6">
          <QuickStart />
        </div>

        <div className="mt-10 grid grid-cols-1 gap-8 @min-[760px]:grid-cols-[minmax(0,1fr)_292px]">
          <RecentSessions />
          <aside className="flex min-w-0 flex-col gap-6" aria-label="Status">
            <section aria-label="GPU">
              <SectionLabel>Compute</SectionLabel>
              <div className="mt-2">
                <GpuCard />
              </div>
            </section>
            <ModelsCard />
          </aside>
        </div>
      </div>
    </div>
  );
}
