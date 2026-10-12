// Inline permission prompt: what the tool wants to do + Allow once / Always allow <rule> / Deny (+ feedback).
// Keys (when focus is on the card, not in a text field): 1 / 2 / 3, Esc = deny. Owner: ui-chat.
import { Globe, ShieldAlert } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { PermissionDecision, PermissionRequest } from '@shared/types';
import { Badge } from '@renderer/components/ui/badge';
import { Input } from '@renderer/components/ui/input';
import { Kbd } from '@renderer/components/ui/kbd';
import { cn } from '@renderer/lib/cn';
import { basename } from '@renderer/lib/format';
import { respondPermission } from '@renderer/state/actions';
import { previewFromInput } from '../lib/diff';
import { displayPath } from '../lib/tool-meta';
import { InputJson, TerminalBody } from '../tools/bodies';
import { DiffView } from '../tools/DiffView';
import { OptionRow } from '../ui';
import { digitOf, usePromptKeys } from './usePromptKeys';

function headline(req: PermissionRequest): string {
  const i = req.input ?? {};
  const path = String(i.file_path ?? i.notebook_path ?? i.path ?? '');
  switch (req.toolName) {
    case 'Bash':
    case 'PowerShell':
      return 'Run this command?';
    case 'Edit':
    case 'MultiEdit':
      return `Make this edit to ${basename(path) || 'the file'}?`;
    case 'Write':
      return `Write ${basename(path) || 'this file'}?`;
    case 'NotebookEdit':
      return `Edit notebook ${basename(path)}?`;
    case 'WebFetch': {
      try {
        return `Fetch ${new URL(String(i.url)).host}?`;
      } catch {
        return 'Fetch this page?';
      }
    }
    case 'WebSearch':
      return 'Search the web?';
    default:
      if (req.toolName.startsWith('mcp__')) {
        const [, server, ...tool] = req.toolName.split('__');
        return `Use ${tool.join('__')} from ${server}?`;
      }
      return `Allow ${req.toolName}?`;
  }
}

function Details({ req, cwd }: { req: PermissionRequest; cwd: string }) {
  const i = req.input ?? {};
  if (req.toolName === 'Bash' || req.toolName === 'PowerShell') {
    return (
      <div className="overflow-hidden rounded-[8px] border border-ob-border">
        <TerminalBody command={String(i.command ?? '')} output="" shell={req.toolName === 'PowerShell' ? 'powershell' : 'bash'} preview />
      </div>
    );
  }
  const preview = previewFromInput(req.toolName, i);
  if (preview) {
    return (
      <div className="overflow-hidden rounded-[8px] border border-ob-border">
        <div className="flex h-8 items-center gap-2 border-b border-ob-border bg-[#101b21] px-3 font-mono text-[11.5px] text-ob-text-2">
          <span className="min-w-0 truncate">{displayPath(preview.path, cwd)}</span>
          {preview.isNew ? (
            <Badge tone="success" mono>
              new
            </Badge>
          ) : null}
        </div>
        <DiffView before={preview.before} after={preview.after} path={preview.path} isNewFile={preview.isNew} maxHeight={280} />
      </div>
    );
  }
  if (req.toolName === 'WebFetch') {
    return (
      <div className="flex items-center gap-2.5 rounded-[8px] border border-ob-border bg-ob-code-bg px-3 py-2 font-mono text-[12px] text-ob-text-2">
        <Globe size={14} aria-hidden className="shrink-0 text-ob-text-3" />
        <span className="min-w-0 truncate">{String(i.url ?? '')}</span>
      </div>
    );
  }
  return (
    <div className="overflow-hidden rounded-[8px] border border-ob-border">
      <InputJson input={i} />
    </div>
  );
}

export interface PermissionPromptProps {
  request: PermissionRequest;
  cwd: string;
  /** Front-most prompt: owns the keyboard shortcuts. */
  active: boolean;
}

export function PermissionPrompt({ request, cwd, active }: PermissionPromptProps) {
  const root = useRef<HTMLDivElement | null>(null);
  const [feedback, setFeedback] = useState('');
  const [busy, setBusy] = useState<PermissionDecision | null>(null);
  const description = typeof request.input?.description === 'string' ? request.input.description : null;

  const decide = (decision: PermissionDecision) => {
    if (busy) return;
    setBusy(decision);
    void respondPermission(request.requestId, decision, decision === 'deny' && feedback.trim() ? feedback.trim() : undefined).then((ok) => {
      if (!ok) setBusy(null);
    });
  };

  usePromptKeys(active && !busy, root, (e) => {
    const n = digitOf(e);
    if (n === 1) decide('allow');
    else if (n === 2 && request.suggestedRule) decide('allow_always');
    else if (n === (request.suggestedRule ? 3 : 2)) decide('deny');
    else if (e.key === 'Escape') decide('deny');
    else return false;
    return true;
  });

  // Bring the prompt into view when it appears.
  useEffect(() => {
    root.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, []);

  const denyIndex = request.suggestedRule ? 3 : 2;

  return (
    <div
      ref={root}
      data-testid="permission-prompt"
      data-request-id={request.requestId}
      role="group"
      aria-label={`Permission request: ${request.title}`}
      tabIndex={-1}
      className={cn(
        'overflow-hidden rounded-[12px] border bg-ob-surface-1 outline-none animate-ob-slide-up focus:shadow-[0_0_0_4px_rgba(232,184,92,0.16)]',
        active ? 'border-[rgba(232,184,92,0.45)] shadow-[0_0_0_4px_rgba(232,184,92,0.06)]' : 'border-ob-border',
      )}
    >
      <div className="flex items-start gap-3 px-4 pt-3.5">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-[7px] bg-ob-warning-soft text-ob-warning">
          <ShieldAlert size={15} aria-hidden />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="text-[13.5px] font-medium text-ob-text">{headline(request)}</div>
          {/* the real call is always shown; the model's own description is only a labelled note (it can be misleading) */}
          <div className="truncate text-small text-ob-text-3" title={request.title}>
            {request.title}
          </div>
          {description ? (
            <div className="truncate text-small italic text-ob-text-3" title={description} data-testid="perm-agent-note">
              Agent says: {description}
            </div>
          ) : null}
        </div>
        <Badge mono className="mt-1 shrink-0">
          {request.toolName.startsWith('mcp__') ? 'MCP' : request.toolName}
        </Badge>
      </div>

      <div className="px-4 pt-3">
        <Details req={request} cwd={cwd} />
      </div>

      <div className="flex flex-col gap-1.5 px-4 pt-3" role="radiogroup" aria-label="Decision">
        <OptionRow compact index={1} title="Allow once" description="Only this call" onSelect={() => decide('allow')} selected={busy === 'allow'} testId="perm-allow" />
        {request.suggestedRule ? (
          <OptionRow
            compact
            index={2}
            title={
              <span className="flex flex-wrap items-center gap-1.5">
                Always allow
                <code className="rounded-[4px] border border-ob-border bg-ob-code-bg px-1.5 py-px font-mono text-[11.5px] text-ob-text">{request.suggestedRule}</code>
              </span>
            }
            description="Saved to this project's allow rules"
            onSelect={() => decide('allow_always')}
            selected={busy === 'allow_always'}
            testId="perm-always"
          />
        ) : null}
        <OptionRow
          compact
          index={denyIndex}
          title="Deny"
          description={feedback.trim() ? 'Sends your note to the agent' : 'The agent is told the call was refused'}
          tone="danger"
          onSelect={() => decide('deny')}
          selected={busy === 'deny'}
          testId="perm-deny"
        />
      </div>

      <div className="px-4 pt-2">
        <Input
          size="sm"
          value={feedback}
          onChange={(e) => setFeedback(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
              e.preventDefault();
              decide('deny');
            } else if (e.key === 'Escape') {
              e.preventDefault();
              e.currentTarget.blur();
            }
          }}
          placeholder="Or tell the agent what to do instead (Enter denies with this note)"
          aria-label="Feedback for the agent"
          data-testid="perm-feedback"
        />
      </div>

      <div className="flex items-center gap-1.5 px-4 pb-3 pt-2.5 text-meta text-ob-text-3">
        <Kbd>1</Kbd>
        {request.suggestedRule ? <Kbd>2</Kbd> : null}
        <Kbd>{denyIndex}</Kbd>
        <span>to choose</span>
        <span aria-hidden>·</span>
        <Kbd>Esc</Kbd>
        <span>to deny</span>
      </div>
    </div>
  );
}
