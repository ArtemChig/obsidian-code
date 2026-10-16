// Right-click menu of the transcript: Copy, Copy as Markdown, Fork from here, Rewind to here. One menu for the whole
// list (not one per message): the message under the pointer is found from data-msg-id when the menu opens. Owner: ui-chat.
import { ClipboardCopy, Copy, ExternalLink, File, FileText, GitFork, Link, RotateCcw, SquareTerminal } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import type { Message, SessionSummary, ToolUseBlock } from '@shared/types';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '@renderer/components/ui/menu';
import { openExternal } from '@renderer/lib/bridge';
import { forkSession } from '@renderer/state/actions';
import { messageMarkdown } from '../lib/export';
import { copyToClipboard } from '../session-actions';
import { messageText } from './Messages';

/** Put this on the element that wraps one message; the menu reads it. */
export const MSG_ID_ATTR = 'data-msg-id';

interface Target {
  message: Message;
  /** Text selected inside the message when the menu opened. */
  selection: string;
  /** The web link under the pointer, if any. */
  link: string;
  /** The tool call under the pointer, if any. */
  tool?: ToolUseBlock;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

export function MessageMenu({
  session,
  messages,
  running,
  onRewind,
  children,
}: {
  session: SessionSummary;
  messages: Message[];
  running: boolean;
  onRewind: (m: Message) => void;
  children: ReactNode;
}) {
  const [target, setTarget] = useState<Target | null>(null);
  const m = target?.message;
  const text = m ? messageText(m) : '';
  const md = m ? messageMarkdown(m) : '';
  const real = !!m && m.tag !== 'hook' && m.tag !== 'command';
  const forkable = session.kind !== 'subagent' && real;
  // A tool card under the pointer: its command, path and output can be copied.
  const tool = target?.tool;
  const command = tool && (tool.name === 'Bash' || tool.name === 'PowerShell') ? str(tool.input.command) : '';
  const toolPath = tool ? str(tool.input.file_path ?? tool.input.notebook_path ?? tool.input.path) : '';
  const output = tool?.result?.content ?? '';
  return (
    <ContextMenu>
      <ContextMenuTrigger
        asChild
        onContextMenu={(e) => {
          const el = e.target instanceof Element ? e.target.closest<HTMLElement>(`[${MSG_ID_ATTR}]`) : null;
          const message = el ? messages.find((x) => x.id === el.getAttribute(MSG_ID_ATTR)) : undefined;
          // Not on a message, or inside a text field: not ours.
          if (!message || (e.target instanceof Element && e.target.closest('input, textarea'))) {
            e.preventDefault();
            return;
          }
          const sel = window.getSelection();
          const selection = sel && !sel.isCollapsed && el?.contains(sel.anchorNode) ? sel.toString() : '';
          const href = e.target instanceof Element ? (e.target.closest('a[href]')?.getAttribute('href') ?? '') : '';
          const toolId = e.target instanceof Element ? e.target.closest('[data-tool-id]')?.getAttribute('data-tool-id') : null;
          const tool = toolId ? message.blocks.find((b): b is ToolUseBlock => b.type === 'tool_use' && b.id === toolId) : undefined;
          setTarget({ message, selection, link: /^https?:/i.test(href) ? href : '', tool });
        }}
      >
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent data-testid="message-menu">
        {m ? (
          <>
            {target?.link ? (
              <>
                <ContextMenuItem icon={ExternalLink} onSelect={() => openExternal(target.link)}>
                  Open link in browser
                </ContextMenuItem>
                <ContextMenuItem icon={Link} onSelect={() => void copyToClipboard(target.link, 'Link')}>
                  Copy link address
                </ContextMenuItem>
                <ContextMenuSeparator />
              </>
            ) : null}
            {tool ? (
              <>
                {command ? (
                  <ContextMenuItem icon={SquareTerminal} onSelect={() => void copyToClipboard(command, 'Command')}>
                    Copy command
                  </ContextMenuItem>
                ) : null}
                {toolPath ? (
                  <ContextMenuItem icon={File} onSelect={() => void copyToClipboard(toolPath, 'Path')}>
                    Copy path
                  </ContextMenuItem>
                ) : null}
                {output ? (
                  <ContextMenuItem icon={ClipboardCopy} onSelect={() => void copyToClipboard(output, 'Output')}>
                    Copy output
                  </ContextMenuItem>
                ) : null}
                {command || toolPath || output ? <ContextMenuSeparator /> : null}
              </>
            ) : null}
            {target?.selection ? (
              <ContextMenuItem icon={Copy} shortcut="Ctrl+C" onSelect={() => void copyToClipboard(target.selection, 'Selection')}>
                Copy selection
              </ContextMenuItem>
            ) : null}
            <ContextMenuItem icon={ClipboardCopy} disabled={!text} onSelect={() => void copyToClipboard(text, 'Message')}>
              Copy text
            </ContextMenuItem>
            <ContextMenuItem icon={FileText} disabled={!md.trim()} onSelect={() => void copyToClipboard(md, 'Markdown')}>
              Copy as Markdown
            </ContextMenuItem>
            {forkable || (m.role === 'user' && real && session.kind !== 'subagent') ? <ContextMenuSeparator /> : null}
            {forkable ? (
              <ContextMenuItem icon={GitFork} onSelect={() => void forkSession(session.id, m.id)}>
                Fork from here
              </ContextMenuItem>
            ) : null}
            {m.role === 'user' && real && session.kind !== 'subagent' ? (
              <ContextMenuItem icon={RotateCcw} disabled={running} hint={running ? 'while it runs' : undefined} onSelect={() => onRewind(m)}>
                Rewind to here…
              </ContextMenuItem>
            ) : null}
          </>
        ) : null}
      </ContextMenuContent>
    </ContextMenu>
  );
}
