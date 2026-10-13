// Home (no session selected): quick-start composer, recent sessions, GPU + models status. Owner: ui-foundation.
// M13: no cards, no gradients. A hero (mono kicker + 23 px title), the quick-start input well, then a list of recent
// sessions separated by sub-hairlines and a status column of hairline-separated blocks (reference .sblk / .kv).
import { ArrowRight, ArrowUp, Box, CalendarClock, Check, ChevronDown, Cpu, Folder, MessageSquare, Power, RefreshCw } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import type { ModelRef, SessionSummary } from '@shared/types';
import { Badge } from '@renderer/components/ui/badge';
import { Button, IconButton } from '@renderer/components/ui/button';
import { EmptyState, ProgressBar, StatusDot } from '@renderer/components/ui/feedback';
import { Textarea } from '@renderer/components/ui/input';
import { SectionLabel } from '@renderer/components/ui/layout';
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

/** Quiet inline chip inside the quick-start well (folder, model). */
const CHIP =
  'ob-transition flex h-6 items-center gap-1.5 rounded-[2px] px-2 font-mono text-[10.5px] tracking-[-0.01em] text-t2 hover:bg-hov hover:text-t1 data-[state=open]:bg-s3 data-[state=open]:text-t1';

// ───────────────────────────── Quick start ─────────────────────────────

function ModelChip({ value, onChange }: { value: ModelRef | null; onChange: (m: ModelRef) => void }) {
  const groups = useModelGroups();
  const models = useModels((s) => s.models);
  const info = findModel(models, value);
  const label = info?.label ?? (value ? shortModelName(value.model) : 'Default model');
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" data-testid="home-model" className={cn(CHIP, 'max-w-[260px]')}>
          {info ? <StatusDot status={info.status} size={5} /> : <Box size={12} aria-hidden className="text-t3" />}
          <span className="truncate">{label}</span>
          <ChevronDown size={11} aria-hidden className="shrink-0 text-t3" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-[360px]">
        {groups.length === 0 ? <div className="px-2.5 py-3 text-[11.5px] text-t3">No models available</div> : null}
        {groups.map((g, gi) => (
          <div key={g.provider.id}>
            {gi > 0 ? <DropdownMenuSeparator /> : null}
            <DropdownMenuLabel>{g.provider.label}</DropdownMenuLabel>
            {g.models.map((m) => (
              <DropdownMenuItem
                key={`${m.ref.provider}::${m.ref.model}`}
                disabled={m.status === 'offline'}
                onSelect={() => onChange(m.ref)}
                leading={<StatusDot status={m.status} size={6} className="mx-[3px]" />}
                trailing={
                  <>
                    {m.variant ? <Badge tone={m.variant === 'uncensored' ? 'violet' : 'neutral'}>{m.variant}</Badge> : null}
                    {sameModel(m.ref, value) ? <Check size={13} aria-label="Selected" className="text-t1" /> : <span className="w-[13px]" />}
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
      <div data-testid="quick-start" className="@container ob-transition rounded-[2px] border border-line bg-s1 focus-within:border-acc">
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
          className="block px-4 pb-1 pt-3.5 text-[13.5px] leading-[22px] tracking-[-0.012em]"
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
              className={cn(CHIP, 'max-w-[300px]')}
            >
              <Folder size={12} aria-hidden className="shrink-0 text-t3" />
              <span className="truncate">{folder ? shortenPath(folder, homeDir, 2) : 'Choose folder'}</span>
            </button>
          </Tooltip>
          <span aria-hidden className="h-3 w-px bg-rule" />
          <ModelChip value={chosenModel} onChange={setModel} />
          <span className="flex-1" />
          <span className="mr-3 hidden font-mono text-[9px] uppercase tracking-[0.12em] text-t3 @min-[780px]:inline">
            <span className="text-t2">Enter</span> start · <span className="text-t2">Shift+Enter</span> new line
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

function SessionGlyph({ s, waiting, unread }: { s: SessionSummary; waiting: boolean; unread: boolean }) {
  if (s.status === 'running') return <StatusDot tone="violet" pulse glow label="Running" />;
  if (waiting || s.status === 'waiting') return <StatusDot tone="warning" pulse label="Waiting for you" />;
  if (s.status === 'error') return <StatusDot tone="danger" label="Error" />;
  if (unread) return <StatusDot tone="accent" label="Unread" />;
  if (s.kind === 'scheduled') return <CalendarClock size={12} aria-hidden className="text-t3" />;
  return <MessageSquare size={12} aria-hidden className="text-t3" />;
}

function SessionLine({ s, waiting }: { s: SessionSummary; waiting: boolean }) {
  const models = useModels((st) => st.models);
  const unread = useSessions((st) => !!st.unread[s.id]);
  const info = findModel(models, s.model);
  const modelName = info?.label ?? (s.model ? shortModelName(s.model.model) : null);
  const needsYou = waiting || s.status === 'waiting';
  return (
    <button
      type="button"
      onClick={() => openSession(s.id)}
      data-testid="home-session"
      className="ob-transition group flex w-full items-center gap-3 border-b border-rule2 px-2 py-2.5 text-left hover:bg-hov"
    >
      <span className="flex w-3 shrink-0 items-center justify-center">
        <SessionGlyph s={s} waiting={waiting} unread={unread} />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
        <div className="flex min-w-0 items-center gap-2">
          <span className={cn('truncate text-[12.5px] tracking-[-0.016em]', unread || needsYou ? 'font-medium text-t1' : 'text-t1')}>{s.title || 'Untitled'}</span>
          {needsYou ? (
            <Badge tone="warning" variant="outline">
              Needs you
            </Badge>
          ) : null}
        </div>
        <div className="flex min-w-0 items-center gap-1.5 font-mono text-[9.5px] tracking-[0.01em] text-t3">
          <span className="shrink-0 text-t2">{basename(s.cwd)}</span>
          {modelName ? (
            <>
              <span aria-hidden className="opacity-50">/</span>
              <span className="truncate">{modelName}</span>
            </>
          ) : null}
          {s.usage.requests ? (
            <>
              <span aria-hidden className="opacity-50">/</span>
              <span className="shrink-0">{pluralize(s.usage.requests, 'turn')}</span>
            </>
          ) : null}
        </div>
      </div>
      <RelativeTime ts={s.updatedAt} className="shrink-0 font-mono text-[9.5px] tracking-[0.02em] text-t3" />
      <ArrowRight size={12} aria-hidden className="-ml-1 shrink-0 text-t3 opacity-0 transition-opacity group-hover:opacity-100" />
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
      <SectionLabel rule action={total ? <span className="font-mono text-[9.5px] tracking-[0.02em] text-t3">{total}</span> : undefined}>
        Recent sessions
      </SectionLabel>
      <div className="mt-1.5 border-t border-rule">
        {!loaded && sessionsError ? (
          <SyncFailed what="sessions" error={sessionsError} compact />
        ) : !loaded ? (
          <div className="flex flex-col gap-4 px-2 py-4" aria-hidden>
            {[0, 1, 2].map((i) => (
              <div key={i} className="flex flex-col gap-1.5">
                <div className="ob-skeleton h-3 w-2/3" />
                <div className="ob-skeleton h-2 w-1/3" />
              </div>
            ))}
          </div>
        ) : recent.length ? (
          <div className="flex flex-col">
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

// ───────────────────────────── Status blocks ─────────────────────────────

/** Reference .kv: label in --t3, value in mono --t1. */
function Kv({ label, children, valueClassName }: { label: string; children: ReactNode; valueClassName?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2.5 py-[5px]">
      <span className="text-[11.5px] tracking-[-0.008em] text-t3">{label}</span>
      <b className={cn('ob-tabular truncate font-mono text-[11.5px] font-normal tracking-[-0.03em] text-t1', valueClassName)}>{children}</b>
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
  const month = (status?.monthCost ?? 0) + (on ? Math.max(0, cost - (status?.sessionCost ?? 0)) : 0);
  const ratio = budget > 0 ? month / budget : 0;
  return (
    <section aria-label="GPU" data-testid="home-gpu-card" className="border-b border-rule2 pb-4">
      <SectionLabel action={on && status?.clockedInAt ? <LiveDuration since={status.clockedInAt} className="font-mono text-[11px] normal-case tracking-[-0.02em] text-t1" /> : undefined}>
        Compute
      </SectionLabel>
      <div className="mt-2 flex items-center gap-2">
        <StatusDot tone={gpuTone(phase)} glow={phase === 'ready'} pulse={on && phase !== 'ready'} />
        <span className="text-[12.5px] font-medium tracking-[-0.016em] text-t1">GPU</span>
        <span className="text-[12px] text-t2">{GPU_PHASE_LABEL[phase]}</span>
      </div>
      <div className="mt-1 truncate pl-[14px] font-mono text-[9.5px] tracking-[0.01em] text-t3">
        {on
          ? [status?.gpuName && `${status.numGpus && status.numGpus > 1 ? `${status.numGpus}× ` : ''}${status.gpuName}`, modelLabel].filter(Boolean).join(' · ')
          : 'Rent an RTX 5090 or RTX PRO 6000 by the hour on Vast.ai.'}
      </div>
      <div className="mt-3">
        <Kv label="Rate">{on ? formatPerHour(status?.pricePerHour) : '—'}</Kv>
        <Kv label={on ? 'This session' : 'Credit'}>{on ? formatMoney(cost) : formatMoney(status?.creditBalance)}</Kv>
        <Kv label="This month" valueClassName={cn(ratio > 0.9 && 'text-err', ratio > 0.7 && ratio <= 0.9 && 'text-warn')}>
          {status ? (
            <>
              {formatMoney(month)} <span className="text-t3">/ {formatMoney(budget)}</span>
            </>
          ) : (
            '—'
          )}
        </Kv>
      </div>
      <ProgressBar
        variant="segments"
        segments={24}
        className="mb-1 mt-2.5"
        value={Math.min(1, ratio)}
        tone={ratio > 0.9 ? 'danger' : ratio > 0.7 ? 'warning' : 'neutral'}
        label="Monthly budget used"
      />
      <div className="mt-3.5 flex items-center gap-2">
        <Button size="sm" variant={on ? 'danger' : 'primary'} icon={Power} loading={busy || phase === 'stopping'} onClick={() => void gpuPrimaryAction(status, hasKey)}>
          {on ? 'Clock out' : 'Clock in'}
        </Button>
        <Button size="sm" variant="ghost" icon={Cpu} onClick={() => navigate('gpu')}>
          GPU view
        </Button>
      </div>
    </section>
  );
}

function ModelsCard() {
  const providers = useModels((s) => s.providers);
  const models = useModels((s) => s.models);
  const refreshing = useModels((s) => s.refreshing);
  return (
    <section aria-label="Model providers">
      <SectionLabel action={<IconButton label="Refresh models" icon={RefreshCw} size="xs" loading={refreshing} onClick={() => void refreshModels()} />}>Providers</SectionLabel>
      <div className="mt-1.5 flex flex-col">
        {providers.length === 0 ? <div className="py-3 text-[11.5px] text-t3">No providers configured</div> : null}
        {providers.map((p) => {
          const count = models.filter((m) => m.ref.provider === p.id).length;
          return (
            <div key={p.id} className="flex items-center gap-2.5 border-b border-rule2 py-2 last:border-b-0">
              <StatusDot status={p.status} glow={p.status === 'online'} />
              <div className="flex min-w-0 flex-1 flex-col gap-px">
                <span className="truncate text-[12px] tracking-[-0.012em] text-t1">{p.label}</span>
                <span className="truncate font-mono text-[9.5px] tracking-[0.01em] text-t3">{p.detail ?? p.baseUrl ?? p.status}</span>
              </div>
              <span className={cn('shrink-0 font-mono text-[9.5px] tracking-[0.02em]', p.status === 'online' ? 'text-t2' : 'uppercase tracking-[0.12em] text-t3')}>
                {p.status === 'online' ? pluralize(count, 'model') : p.status}
              </span>
            </div>
          );
        })}
      </div>
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
    <div className="@container h-full overflow-y-auto" data-testid="home">
      <div className="mx-auto flex w-full max-w-[1000px] flex-col px-8 pb-16 pt-[6vh] @min-[1000px]:px-10">
        <header className="flex flex-col gap-2.5">
          <div className="font-mono text-[9px] font-medium uppercase tracking-[0.22em] text-acc">
            Home <span className="text-t3">/ Obsidian Code</span>
          </div>
          <h1 className="text-display font-semibold text-t1">{hello}</h1>
          <p className="max-w-[58ch] text-[12.5px] leading-[1.62] text-t2">Start a session, or pick up where you left off.</p>
        </header>

        <div className="mt-6">
          <QuickStart />
        </div>

        <div className="mt-10 grid grid-cols-1 gap-10 @min-[760px]:grid-cols-[minmax(0,1fr)_288px]">
          <RecentSessions />
          <aside className="flex min-w-0 flex-col gap-6 @min-[760px]:border-l @min-[760px]:border-rule @min-[760px]:pl-6" aria-label="Status">
            <GpuCard />
            <ModelsCard />
          </aside>
        </div>
      </div>
    </div>
  );
}
