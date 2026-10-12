// Task (subagent) block: live status + the child session's steps on a hairline + Open. Owner: ui-chat.
import { ArrowUpRight, ChevronDown, ChevronRight } from 'lucide-react';
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
    <li className="flex h-6 min-w-0 items-center gap-2.5">
      <ToolStatusIcon status={tool.status} size={10} className="shrink-0" />
      <span className="min-w-[56px] shrink-0 font-mono text-[8.5px] font-medium uppercase tracking-[0.16em] text-t3">{s.verb}</span>
      <span className="min-w-0 truncate font-mono text-[11px] tracking-[-0.02em] text-t2">{s.target}</span>
      {s.meta ? <span className="shrink-0 font-mono text-[9.5px] text-t3">{s.meta}</span> : null}
    </li>
  );
}

function MiniTranscript({ childId, cwd }: { childId: string; cwd: string }) {
  const entry = useTranscript(childId);
  const items = useMemo(() => (entry ? previewItems(entry.session.messages) : []), [entry]);
  if (!entry) {
    return (
      <div className="flex flex-col gap-1.5 py-2 pl-4" aria-hidden>
        <div className="ob-skeleton h-3 w-3/5" />
        <div className="ob-skeleton h-3 w-2/5" />
      </div>
    );
  }
  if (!items.length) return <div className="py-1.5 pl-4 font-mono text-[9px] uppercase tracking-[0.16em] text-t3">Starting…</div>;
  return (
    <ol className="flex flex-col gap-0.5 py-1 pl-4" data-testid="subagent-preview">
      {items.map((it) =>
        it.kind === 'text' ? (
          <li key={it.key} className="line-clamp-2 py-0.5 text-[11.5px] tracking-[-0.008em] text-t2">
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

  // M13: subagents are not coloured. A hairline-separated block: a row like a tool row, then the child's steps and
  // result hanging off one --rule left hairline. A running child gets the --live dot.
  return (
    <div data-testid="subagent-card" data-status={tool.status} className={cn('min-w-0 border-b border-rule2 pb-2', className)}>
      <div className="flex h-8 min-w-0 items-center gap-2.5">
        <ToolStatusIcon status={waiting ? 'awaiting_permission' : running ? 'running' : tool.status} size={10} className="shrink-0" />
        <span className="min-w-[64px] shrink-0 font-mono text-[9px] font-medium uppercase leading-none tracking-[0.16em] text-t3">Agent</span>
        <Badge variant="outline" className="text-t2">
          {agentType}
        </Badge>
        <span className="min-w-0 flex-1 truncate text-[12.5px] tracking-[-0.012em] text-t1" title={prompt}>
          {description}
        </span>
        {waiting ? <span className="shrink-0 font-mono text-[8.5px] font-medium uppercase tracking-[0.14em] text-warn">Needs you</span> : null}
        {running && tool.startedAt ? <Elapsed since={tool.startedAt} className="shrink-0 font-mono text-[10px] text-live" /> : null}
        {!running && ms !== null ? <span className="ob-tabular shrink-0 font-mono text-[10px] text-t3">{formatDuration(ms)}</span> : null}
        {child ? (
          <Button size="sm" variant="ghost" iconRight={ArrowUpRight} className="-mr-2 px-2" onClick={() => openSession(child.id)} data-testid="subagent-open">
            Open
          </Button>
        ) : null}
      </div>
      <div className="ml-[4px] flex flex-col border-l border-rule">
        {child && live ? <MiniTranscript childId={child.id} cwd={child.cwd} /> : null}
        {child && !live ? (
          <>
            <button
              type="button"
              onClick={() => setShowSteps((v) => !v)}
              aria-expanded={showSteps}
              data-testid="subagent-steps-toggle"
              className="ob-transition flex h-6 w-full items-center gap-1.5 pl-4 text-left font-mono text-[9px] uppercase tracking-[0.16em] text-t3 hover:text-t1"
            >
              {showSteps ? <ChevronDown size={11} aria-hidden /> : <ChevronRight size={11} aria-hidden />}
              Steps
            </button>
            {showSteps ? <MiniTranscript childId={child.id} cwd={child.cwd} /> : null}
          </>
        ) : null}
        {result ? (
          <Clamp maxHeight={150}>
            <div className="py-1.5 pl-4">
              <div className="ob-cap mb-1">Result</div>
              <Markdown text={result} compact />
            </div>
          </Clamp>
        ) : null}
      </div>
    </div>
  );
}
