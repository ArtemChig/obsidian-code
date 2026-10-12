// Rich tool-card bodies, one per ToolDisplay kind. Owner: ui-chat.
import { Circle, CircleCheck, CircleDot, ExternalLink, File, Folder, Globe, Layers } from 'lucide-react';
import type { ReactNode } from 'react';
import type { Question, Todo, ToolDisplay } from '@shared/types';
import { Badge } from '@renderer/components/ui/badge';
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

// ───────────────────────────── File excerpt ─────────────────────────────

export function FileBody({ display, cwd }: { display: Extract<ToolDisplay, { kind: 'file' }>; cwd: string }) {
  if (!display.content) {
    return <div className="px-3.5 py-2.5 text-small text-ob-text-3">{display.totalLines === 0 ? 'Empty file' : 'No lines in range'}</div>;
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
    <div className="bg-ob-code-bg font-mono text-[12px] leading-[1.6]" data-testid="terminal">
      <Clamp maxHeight={300} moreLabel={`${lineCount(out)} lines`}>
        <div className="ob-selectable overflow-x-auto px-3.5 py-2.5">
          <div className="flex gap-2 whitespace-pre-wrap break-all text-ob-text">
            <span className={cn('select-none', shell === 'powershell' ? 'text-ob-accent' : 'text-ob-success')} aria-hidden>
              {shell === 'powershell' ? 'PS>' : '$'}
            </span>
            <span className="min-w-0">{command}</span>
          </div>
          {out ? <pre className="mt-1.5 whitespace-pre-wrap break-words font-mono text-ob-text-2">{out}</pre> : null}
          {!out && !running && !preview ? <div className="mt-1 text-ob-text-3">(no output)</div> : null}
          {running ? <span className="mt-1 inline-block h-[13px] w-[7px] translate-y-[2px] animate-ob-pulse bg-ob-text-2" aria-hidden /> : null}
        </div>
      </Clamp>
      {(exitCode !== undefined && exitCode !== null) || background || shellId ? (
        <div className="flex items-center gap-2 border-t border-ob-border px-3.5 py-1.5 font-sans">
          {exitCode !== undefined && exitCode !== null ? (
            <Badge tone={failed ? 'danger' : 'success'} mono>
              exit {exitCode}
            </Badge>
          ) : null}
          {background ? (
            <Badge tone="violet" mono icon={Layers}>
              background
            </Badge>
          ) : null}
          {shellId ? <span className="font-mono text-[11px] text-ob-text-3">shell {shellId}</span> : null}
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
  if (!display.items.length) return <div className="px-3.5 py-2.5 text-small text-ob-text-3">No results</div>;
  return (
    <Clamp maxHeight={240} fadeFrom="var(--ob-surface-1)" moreLabel={`${display.items.length} items`}>
      <ul className="ob-selectable flex flex-col py-1.5 font-mono text-[12px] leading-[1.65]">
        {display.items.map((item, i) => {
          const isDir = /[\\/]$/.test(item);
          const m = splitMatch(item);
          const path = displayPath(m.path, cwd);
          return (
            <li key={i} className="flex min-w-0 items-baseline gap-2 px-3.5 hover:bg-ob-hover">
              {isDir ? (
                <Folder size={12} aria-hidden className="shrink-0 translate-y-[1px] text-ob-text-3" />
              ) : (
                <File size={12} aria-hidden className="shrink-0 translate-y-[1px] text-ob-text-3" />
              )}
              <span className="shrink-0 text-ob-text-2">{path}</span>
              {m.line ? <span className="shrink-0 text-ob-accent">:{m.line}</span> : null}
              {m.text ? <span className="min-w-0 truncate text-ob-text-3">{m.text.trim()}</span> : null}
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
      className={cn('ob-transition text-ob-accent hover:text-ob-accent-hover hover:underline', className)}
      title={href}
    >
      {children}
    </a>
  );
}

export function SearchBody({ display }: { display: Extract<ToolDisplay, { kind: 'search' }> }) {
  if (!display.results.length) return <div className="px-3.5 py-2.5 text-small text-ob-text-3">No results for “{display.query}”</div>;
  return (
    <Clamp maxHeight={300} fadeFrom="var(--ob-surface-1)" moreLabel={`${display.results.length} results`}>
      <ol className="flex flex-col divide-y divide-ob-border" data-testid="search-results">
        {display.results.map((r, i) => (
          <li key={i} className="flex gap-3 px-3.5 py-2">
            <span className="mt-[3px] flex size-4 shrink-0 items-center justify-center rounded-[4px] bg-ob-surface-2 font-mono text-[9.5px] text-ob-text-3">{i + 1}</span>
            <div className="flex min-w-0 flex-col gap-0.5">
              <LinkOut href={r.url} className="truncate text-ui font-medium">
                {r.title || r.url}
              </LinkOut>
              <span className="truncate font-mono text-[11px] text-ob-text-3">{host(r.url)}</span>
              {r.snippet ? <p className="line-clamp-2 text-small text-ob-text-2">{r.snippet}</p> : null}
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
      <div className="flex size-9 shrink-0 items-center justify-center rounded-[8px] border border-ob-border bg-ob-surface-2 text-ob-text-3">
        <Globe size={16} aria-hidden />
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-ui font-medium text-ob-text">{display.title || host(display.url)}</span>
        <span className="truncate font-mono text-[11px] text-ob-text-3">{display.url}</span>
      </div>
      {display.bytes ? <span className="shrink-0 font-mono text-[11px] text-ob-text-3">{formatBytes(display.bytes)}</span> : null}
      <button
        type="button"
        onClick={() => openExternal(display.url)}
        className="ob-transition flex h-7 shrink-0 items-center gap-1.5 rounded-ctl px-2 text-small text-ob-text-2 hover:bg-ob-hover hover:text-ob-text"
      >
        <ExternalLink size={13} aria-hidden />
        Open
      </button>
    </div>
  );
}

// ───────────────────────────── Todos ─────────────────────────────

export function TodoChecklist({ todos, className, dense }: { todos: Todo[]; className?: string; dense?: boolean }) {
  if (!todos.length) return <div className={cn('text-small text-ob-text-3', className)}>No todos</div>;
  return (
    <ul className={cn('flex flex-col', dense ? 'gap-1' : 'gap-1.5', className)} data-testid="todo-list">
      {todos.map((t) => (
        <li key={t.id} className="flex items-start gap-2.5" data-status={t.status}>
          {t.status === 'completed' ? (
            <CircleCheck size={15} aria-label="Completed" className="mt-[2px] shrink-0 text-ob-success" />
          ) : t.status === 'in_progress' ? (
            <CircleDot size={15} aria-label="In progress" className="mt-[2px] shrink-0 text-ob-accent" />
          ) : (
            <Circle size={15} aria-label="Pending" className="mt-[2px] shrink-0 text-ob-text-3" />
          )}
          <span
            className={cn(
              'min-w-0 text-ui',
              t.status === 'completed' && 'text-ob-text-3 line-through decoration-ob-text-3/60',
              t.status === 'in_progress' && 'font-medium text-ob-text',
              t.status === 'pending' && 'text-ob-text-2',
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
    <div className="flex flex-col gap-3 px-3.5 py-3">
      {questions.map((q, i) => {
        const a = answers?.[q.question] ?? answers?.[q.header];
        const picked = new Set((a ?? '').split(/,\s*/).filter(Boolean));
        return (
          <div key={i} className="flex flex-col gap-1.5">
            <div className="flex items-center gap-2">
              {q.header ? (
                <Badge tone="accent" mono>
                  {q.header}
                </Badge>
              ) : null}
              <span className="text-ui text-ob-text">{q.question}</span>
            </div>
            <div className="flex flex-wrap gap-1.5 pl-0.5">
              {q.options.map((o) => (
                <span
                  key={o.label}
                  className={cn(
                    'rounded-pill border px-2 py-0.5 text-small',
                    picked.has(o.label) ? 'border-[rgba(143,184,222,0.45)] bg-ob-accent-soft text-ob-text' : 'border-ob-border text-ob-text-3',
                  )}
                >
                  {o.label}
                </span>
              ))}
            </div>
            {a ? (
              <div className="text-small text-ob-text-2">
                <span className="text-ob-text-3">Answer: </span>
                {a}
              </div>
            ) : (
              <div className="text-small text-ob-text-3">No answer</div>
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
    <Clamp maxHeight={360} fadeFrom="var(--ob-surface-1)">
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
  if (!t) return <div className="px-3.5 py-2.5 text-small text-ob-text-3">(no output)</div>;
  return (
    <Clamp maxHeight={260} moreLabel={`${lineCount(t)} lines`}>
      <pre
        className={cn(
          'ob-selectable whitespace-pre-wrap break-words bg-ob-code-bg px-3.5 py-2.5 font-mono text-[12px] leading-[1.6]',
          error ? 'text-ob-danger' : 'text-ob-text-2',
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
