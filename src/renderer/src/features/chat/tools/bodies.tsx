// Rich tool-card bodies, one per ToolDisplay kind. Owner: ui-chat.
import { Check, ExternalLink, File, Folder, Globe, Layers } from 'lucide-react';
import type { ReactNode } from 'react';
import type { Question, Todo, ToolDisplay } from '@shared/types';
import { Badge } from '@renderer/components/ui/badge';
import { Button } from '@renderer/components/ui/button';
import { CodeBlock } from '@renderer/components/ui/code-block';
import { Markdown } from '@renderer/components/ui/markdown';
import { openExternal } from '@renderer/lib/bridge';
import { cn } from '@renderer/lib/cn';
import { formatBytes } from '@renderer/lib/format';
import { langFromPath } from '@renderer/lib/highlighter';
import { Clamp } from '../ui';
import { displayPath, lineCount } from '../lib/tool-meta';

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI, '');
}

/// ───────────────────────────── File excerpt ─────────────────────────────

export function FileBody({ display, cwd }: { display: Extract<ToolDisplay, { kind: 'file' }>; cwd: string }) {
  if (!display.content) {
    return <div className="px-3.5 py-2.5 text-[11.5px] text-t3">{display.totalLines === 0 ? 'Empty file' : 'No lines in range'}</div>;
  }
  return (
    <Clamp maxHeight={300} moreLabel={`${lineCount(display.content)} lines`}>
      <CodeBlock
        bare
        code={display.content}
        lang={langFromPath(display.path)}
        showLineNumbers
        startLine={display.startLine}
        className="!rounded-none !border-0"
        title={displayPath(display.path, cwd)}
      />
    </Clamp>
  );
}

// ───────────────────────────── Terminal ─────────────────────────────

export function TerminalBody({
  command,
  output,
  exitCode,
  background,
  shellId,
  running,
  shell,
  preview,
}: {
  command: string;
  output: string;
  exitCode?: number | null;
  background?: boolean;
  shellId?: string;
  running?: boolean;
  shell?: 'bash' | 'powershell';
  /** Command that has not run yet (permission prompt): no output area. */
  preview?: boolean;
}) {
  const out = stripAnsi(output).replace(/\s+$/, '');
  const failed = exitCode !== null && exitCode !== undefined && exitCode !== 0;
  return (
    <div className="bg-s1 font-mono text-[12px] leading-[1.6] tracking-[-0.01em]" data-testid="terminal">
      <Clamp maxHeight={300} moreLabel={`${lineCount(out)} lines`}>
        <div className="ob-selectable overflow-x-auto px-3.5 py-2.5">
          <div className="flex gap-2.5 whitespace-pre-wrap break-all text-t1">
            <span className="select-none text-t3" aria-hidden>
              {shell === 'powershell' ? 'PS>' : '$'}
            </span>
            <span className="min-w-0">{command}</span>
          </div>
          {out ? <pre className="mt-1.5 whitespace-pre-wrap break-words font-mono text-t2">{out}</pre> : null}
          {!out && !running && !preview ? <div className="mt-1 text-t3">(no output)</div> : null}
          {running ? <span className="mt-1 inline-block h-[13px] w-[7px] translate-y-[2px] animate-ob-pulse bg-live" aria-hidden /> : null}
        </div>
      </Clamp>
      {(exitCode !== undefined && exitCode !== null) || background || shellId ? (
        <div className="flex h-8 items-center gap-2 border-t border-rule2 px-3.5 font-sans">
          {exitCode !== undefined && exitCode !== null ? (
            <Badge tone={failed ? 'danger' : 'success'} variant="outline">
              exit {exitCode}
            </Badge>
          ) : null}
          {background ? (
            <Badge tone="violet" variant="outline" icon={Layers}>
              background
            </Badge>
          ) : null}
          {shellId ? (
            <span className="font-mono text-[9.5px] tracking-[0.01em] text-t3">
              shell <span className="text-t2">{shellId}</span>
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// ───────────────────────────── Lists (Grep / Glob / LS) ─────────────────────────────

/** "src/a.ts:12:  const x" → path + line + text. */
function splitMatch(item: string): { path: string; line?: string; text?: string } {
  const m = /^(.*?):(\d+)(?::(.*))?$/.exec(item);
  if (m && !/^[A-Za-z]$/.test(m[1])) return { path: m[1], line: m[2], text: m[3] };
  return { path: item };
}

export function ListBody({ display, cwd }: { display: Extract<ToolDisplay, { kind: 'list' }>; cwd: string }) {
  if (!display.items.length) return <div className="px-3.5 py-2.5 text-[11.5px] text-t3">No results</div>;
  return (
    <Clamp maxHeight={252} moreLabel={`${display.items.length} items`}>
      <ul className="ob-selectable flex flex-col font-mono text-[11.5px] tracking-[-0.02em]">
        {display.items.map((item, i) => {
          const isDir = /[\\/]$/.test(item);
          const m = splitMatch(item);
          const path = displayPath(m.path, cwd);
          return (
            <li key={i} className="flex h-7 min-w-0 shrink-0 items-center gap-2.5 border-b border-rule2 px-3.5 last:border-b-0 hover:bg-hov">
              {isDir ? <Folder size={12} aria-hidden className="shrink-0 text-t3" /> : <File size={12} aria-hidden className="shrink-0 text-t3" />}
              <span className="shrink-0 text-t1">{path}</span>
              {m.line ? <span className="shrink-0 text-t3">:{m.line}</span> : null}
              {m.text ? <span className="min-w-0 truncate text-t2">{m.text.trim()}</span> : null}
            </li>
          );
        })}
      </ul>
    </Clamp>
  );
}

// ───────────────────────────── Web ─────────────────────────────

function host(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return url;
  }
}

function LinkOut({ href, children, className }: { href: string; children: ReactNode; className?: string }) {
  return (
    <a
      href={href}
      onClick={(e) => {
        e.preventDefault();
        openExternal(href);
      }}
      className={cn('ob-transition text-t1 underline decoration-line underline-offset-[3px] hover:decoration-acc', className)}
      title={href}
    >
      {children}
    </a>
  );
}

export function SearchBody({ display }: { display: Extract<ToolDisplay, { kind: 'search' }> }) {
  if (!display.results.length) return <div className="px-3.5 py-2.5 text-[11.5px] text-t3">No results for “{display.query}”</div>;
  return (
    <Clamp maxHeight={300} moreLabel={`${display.results.length} results`}>
      <ol className="flex flex-col" data-testid="search-results">
        {display.results.map((r, i) => (
          <li key={i} className="flex gap-3 border-b border-rule2 px-3.5 py-2 last:border-b-0">
            <span className="w-4 shrink-0 pt-px text-right font-mono text-[10px] text-t3">{i + 1}</span>
            <div className="flex min-w-0 flex-col gap-0.5">
              <LinkOut href={r.url} className="truncate text-[12.5px] font-medium tracking-[-0.012em]">
                {r.title || r.url}
              </LinkOut>
              <span className="truncate font-mono text-[9.5px] tracking-[0.01em] text-t3">{host(r.url)}</span>
              {r.snippet ? <p className="line-clamp-2 text-[11.5px] text-t2">{r.snippet}</p> : null}
            </div>
          </li>
        ))}
      </ol>
    </Clamp>
  );
}

export function WebBody({ display }: { display: Extract<ToolDisplay, { kind: 'web' }> }) {
  return (
    <div className="flex items-center gap-3 px-3.5 py-2.5" data-testid="web-card">
      <Globe size={14} aria-hidden className="shrink-0 text-t3" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-[12.5px] font-medium tracking-[-0.012em] text-t1">{display.title || host(display.url)}</span>
        <span className="truncate font-mono text-[9.5px] tracking-[0.01em] text-t3">{display.url}</span>
      </div>
      {display.bytes ? <span className="shrink-0 font-mono text-[10px] text-t3">{formatBytes(display.bytes)}</span> : null}
      <Button size="sm" variant="secondary" iconRight={ExternalLink} onClick={() => openExternal(display.url)}>
        Open
      </Button>
    </div>
  );
}

// ───────────────────────────── Todos ─────────────────────────────

/** Square M13 checkbox mark (reference .chk): done = solid accent + black tick, in progress = live square, pending = outline. */
function TodoMark({ status }: { status: Todo['status'] }) {
  if (status === 'completed') {
    return (
      <span role="img" aria-label="Completed" className="flex size-[13px] shrink-0 items-center justify-center rounded-[1px] bg-acc text-acc-ink">
        <Check size={10} strokeWidth={3} aria-hidden />
      </span>
    );
  }
  if (status === 'in_progress') {
    return (
      <span role="img" aria-label="In progress" className="flex size-[13px] shrink-0 items-center justify-center rounded-[1px] shadow-[inset_0_0_0_1px_var(--live)]">
        <span className="size-[5px] animate-ob-pulse bg-live" />
      </span>
    );
  }
  return <span role="img" aria-label="Pending" className="size-[13px] shrink-0 rounded-[1px] shadow-[inset_0_0_0_1px_var(--line)]" />;
}

export function TodoChecklist({ todos, className, dense }: { todos: Todo[]; className?: string; dense?: boolean }) {
  if (!todos.length) return <div className={cn('text-[11.5px] text-t3', className)}>No todos</div>;
  return (
    <ul className={cn('flex flex-col', className)} data-testid="todo-list">
      {todos.map((t) => (
        <li key={t.id} className={cn('flex items-center gap-3 border-b border-rule2 last:border-b-0', dense ? 'min-h-7 py-1' : 'min-h-7 py-[5px]')} data-status={t.status}>
          <TodoMark status={t.status} />
          <span
            className={cn(
              'min-w-0 text-[12.5px] tracking-[-0.012em]',
              t.status === 'completed' && 'text-t3 line-through decoration-t3',
              t.status === 'in_progress' && 'font-medium text-t1',
              t.status === 'pending' && 'text-t2',
            )}
          >
            {t.status === 'in_progress' && t.activeForm ? t.activeForm : t.content}
          </span>
        </li>
      ))}
    </ul>
  );
}

// ───────────────────────────── Questions (answered) ─────────────────────────────

export function QuestionsBody({ questions, answers }: { questions: Question[]; answers?: Record<string, string> }) {
  return (
    <div className="flex flex-col gap-3.5 px-3.5 py-3">
      {questions.map((q, i) => {
        const a = answers?.[q.question] ?? answers?.[q.header];
        const picked = new Set((a ?? '').split(/,\s*/).filter(Boolean));
        return (
          <div key={i} className="flex flex-col gap-2">
            <div className="flex items-center gap-2.5">
              {q.header ? <Badge variant="outline">{q.header}</Badge> : null}
              <span className="text-[12.5px] tracking-[-0.012em] text-t1">{q.question}</span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {q.options.map((o) => (
                <span
                  key={o.label}
                  className={cn(
                    'rounded-[1px] px-2 py-[3px] text-[11px] tracking-[-0.008em]',
                    picked.has(o.label) ? 'bg-acc-wash text-t1 shadow-[inset_0_0_0_1px_var(--acc)]' : 'text-t3 shadow-[inset_0_0_0_1px_var(--rule)]',
                  )}
                >
                  {o.label}
                </span>
              ))}
            </div>
            {a ? (
              <div className="text-[11.5px] text-t2">
                <span className="mr-1.5 font-mono text-[9px] uppercase tracking-[0.16em] text-t3">Answer</span>
                {a}
              </div>
            ) : (
              <div className="font-mono text-[9px] uppercase tracking-[0.16em] text-t3">No answer</div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ───────────────────────────── Plan / markdown / raw ─────────────────────────────

export function PlanBody({ plan }: { plan: string }) {
  return (
    <Clamp maxHeight={360}>
      <div className="px-4 py-3">
        <Markdown text={plan} compact />
      </div>
    </Clamp>
  );
}

export function MarkdownBody({ markdown }: { markdown: string }) {
  return (
    <div className="px-3.5 py-2.5">
      <Markdown text={markdown} compact />
    </div>
  );
}

export function RawBody({ text, error }: { text: string; error?: boolean }) {
  const t = stripAnsi(text).replace(/\s+$/, '');
  if (!t) return <div className="px-3.5 py-2.5 font-mono text-[11px] text-t3">(no output)</div>;
  return (
    <Clamp maxHeight={260} moreLabel={`${lineCount(t)} lines`}>
      <pre
        className={cn(
          'ob-selectable whitespace-pre-wrap break-words bg-s1 px-3.5 py-2.5 font-mono text-[12px] leading-[1.6] tracking-[-0.01em]',
          error ? 'text-err' : 'text-t2',
        )}
      >
        {t}
      </pre>
    </Clamp>
  );
}

export function InputJson({ input }: { input: Record<string, unknown> }) {
  const text = JSON.stringify(input, null, 2);
  return (
    <Clamp maxHeight={200}>
      <CodeBlock bare code={text} lang="json" className="!rounded-none !border-0" />
    </Clamp>
  );
}
