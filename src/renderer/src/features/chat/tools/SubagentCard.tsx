// Task (subagent) card: live status + a nested mini transcript of the child session + Open. Owner: ui-chat.
import { ArrowUpRight, Bot, ChevronDown, ChevronRight } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { SessionSummary, ToolUseBlock } from '@shared/types';
import { Badge } from '@renderer/components/ui/badge';
import { Button } from '@renderer/components/ui/button';
import { Markdown } from '@renderer/components/ui/markdown';
import { cn } from '@renderer/lib/cn';
import { formatDuration } from '@renderer/lib/format';
import { openSession } from '@renderer/state/actions';
import { useTranscript } from '@renderer/state/selectors';
import { useSessions } from '@renderer/state/sessions';
import { previewItems } from '../lib/prompts';
import { toolSummary } from '../lib/tool-meta';
import { Clamp, Elapsed, ToolStatusIcon } from '../ui';

function useChildSession(tool: ToolUseBlock): SessionSummary | undefined {
  const d = tool.result?.display;
  const explicit = d?.kind === 'subagent' ? d.sessionId : undefined;
  const sessions = useSessions((s) => s.sessions);
  return useMemo(() => {
    if (explicit && sessions[explicit]) return sessions[explicit];
    return Object.values(sessions).find((s) => s.parentToolUseId === tool.id);
  }, [sessions, explicit, tool.id]);
}

function ToolLine({ tool, cwd }: { tool: ToolUseBlock; cwd: string }) {
  const s = toolSummary(tool, cwd);
  return (
    <li className="flex min-w-0 items-center gap-2 text-small">
      <ToolStatusIcon status={tool.status} size={12} className="shrink-0" />
      <span className="shrink-0 font-medium text-ob-text-2">{s.verb}</span>
      <span className="min-w-0 truncate font-mono text-[11.5px] text-ob-text-3">{s.target}</span>
      {s.meta ? <span className="shrink-0 font-mono text-[11px] text-ob-text-3">{s.meta}</span> : null}
    </li>
  );
}

function MiniTranscript({ childId, cwd }: { childId: string; cwd: string }) {
  const entry = useTranscript(childId);
  const items = useMemo(() => (entry ? previewItems(entry.session.messages) : []), [entry]);
  if (!entry) {
    return (
      <div className="flex flex-col gap-1.5 px-3.5 py-2.5" aria-hidden>
        <div className="ob-skeleton h-3 w-3/5" />
        <div className="ob-skeleton h-3 w-2/5" />
      </div>
    );
  }
  if (!items.length) return <div className="px-3.5 py-2.5 text-small text-ob-text-3">Starting…</div>;
  return (
    <ol className="relative flex flex-col gap-1 py-2 pl-[30px] pr-3.5" data-testid="subagent-preview">
      <span aria-hidden className="absolute bottom-3 left-[19px] top-3 w-px bg-[rgba(179,166,232,0.22)]" />
      {items.map((it) =>
        it.kind === 'text' ? (
          <li key={it.key} className="line-clamp-2 text-small text-ob-text-2">
            {it.text}
          </li>
        ) : (
          <ToolLine key={it.key} tool={it.tool} cwd={cwd} />
        ),
      )}
    </ol>
  );
}

export function SubagentCard({ tool, className }: { tool: ToolUseBlock; className?: string }) {
  const child = useChildSession(tool);
  const d = tool.result?.display;
  const agentType = d?.kind === 'subagent' ? d.agentType : String(tool.input.subagent_type ?? 'general-purpose');
  const description = d?.kind === 'subagent' ? d.description : String(tool.input.description ?? child?.title ?? 'Subagent');
  const prompt = typeof tool.input.prompt === 'string' ? tool.input.prompt : undefined;
  const running = tool.status === 'running' || child?.status === 'running';
  const waiting = child?.status === 'waiting';
  const finished = tool.status === 'done' || tool.status === 'error' || tool.status === 'interrupted' || tool.status === 'denied';
  const ms = tool.startedAt && tool.endedAt ? tool.endedAt - tool.startedAt : null;
  const result = finished ? (tool.result?.content ?? '').trim() : '';
  // The live mini transcript costs a full sessions.get of the child: only running/waiting children load it up front;
  // a finished one (its result is shown below) loads it when the user expands "Steps".
  const live = running || waiting || !finished;
  const [showSteps, setShowSteps] = useState(false);

  return (
    <div
      data-testid="subagent-card"
      data-status={tool.status}
      className={cn(
        'overflow-hidden rounded-[9px] border bg-ob-surface-1',
        running ? 'border-[rgba(179,166,232,0.34)]' : 'border-ob-border',
        className,
      )}
    >
      <div className="flex h-10 items-center gap-2.5 pl-3 pr-2">
        <span className={cn('flex size-[22px] shrink-0 items-center justify-center rounded-[6px] bg-ob-violet-soft text-ob-violet', running && 'animate-ob-pulse')}>
          <Bot size={13} aria-hidden />
        </span>
        <Badge tone="violet" mono>
          {agentType}
        </Badge>
        <span className="min-w-0 flex-1 truncate text-ui text-ob-text" title={prompt}>
          {description}
        </span>
        {waiting ? <span className="shrink-0 text-small text-ob-warning">Needs you</span> : null}
        {running && tool.startedAt ? <Elapsed since={tool.startedAt} className="shrink-0 font-mono text-[11px] text-ob-text-3" /> : null}
        {!running && ms !== null ? <span className="shrink-0 font-mono text-[11px] text-ob-text-3">{formatDuration(ms)}</span> : null}
        <ToolStatusIcon status={running ? 'running' : tool.status} size={13} className="shrink-0" />
        {child ? (
          <Button
            size="sm"
            variant="ghost"
            iconRight={ArrowUpRight}
            className="h-7 px-2 text-ob-text-2"
            onClick={() => openSession(child.id)}
            data-testid="subagent-open"
          >
            Open
          </Button>
        ) : null}
      </div>
      {child && live ? (
        <div className="border-t border-ob-border">
          <MiniTranscript childId={child.id} cwd={child.cwd} />
        </div>
      ) : null}
      {child && !live ? (
        <div className="border-t border-ob-border">
          <button
            type="button"
            onClick={() => setShowSteps((v) => !v)}
            aria-expanded={showSteps}
            data-testid="subagent-steps-toggle"
            className="ob-transition flex h-7 w-full items-center gap-1.5 px-3.5 text-left text-small text-ob-text-3 hover:bg-ob-hover hover:text-ob-text-2"
          >
            {showSteps ? <ChevronDown size={12} aria-hidden /> : <ChevronRight size={12} aria-hidden />}
            Steps
          </button>
          {showSteps ? <MiniTranscript childId={child.id} cwd={child.cwd} /> : null}
        </div>
      ) : null}
      {result ? (
        <div className="border-t border-ob-border bg-[rgba(0,0,0,0.12)]">
          <Clamp maxHeight={150} fadeFrom="#0e171b">
            <div className="px-3.5 py-2.5">
              <div className="ob-section-label mb-1 text-[10px]">Result</div>
              <Markdown text={result} compact />
            </div>
          </Clamp>
        </div>
      ) : null}
    </div>
  );
}
