// Right-click menu for a file or folder shown in the side panel (Changes rows, Files tree, file search): mention it in
// the message, copy its path, open / reveal it (desktop app). Owner: ui-chat.
import { AtSign, Copy, ExternalLink, FolderOpen } from 'lucide-react';
import type { ReactElement } from 'react';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '@renderer/components/ui/menu';
import { Tooltip, type TooltipProps } from '@renderer/components/ui/tooltip';
import { canRevealFiles, openPath, showItemInFolder } from '@renderer/lib/bridge';
import { mentionFor } from '../lib/composer';
import { absolutePath } from '../lib/session';
import { displayPath } from '../lib/tool-meta';
import { copyToClipboard } from '../session-actions';
import { insertIntoComposer } from '../state';

/**
 * `children` is the one element that gets the menu. Pass `tooltip` when it has a tooltip too: the two Radix triggers
 * must be nested in this order for both to work.
 */
export function FileMenu({
  sessionId,
  path,
  cwd,
  isDir = false,
  tooltip,
  children,
}: {
  sessionId: string;
  path: string;
  cwd: string;
  isDir?: boolean;
  tooltip?: Omit<TooltipProps, 'children'>;
  children: ReactElement;
}) {
  const rel = displayPath(path, cwd);
  const abs = absolutePath(path, cwd);
  const trigger = <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>;
  return (
    <ContextMenu>
      {tooltip ? <Tooltip {...tooltip}>{trigger}</Tooltip> : trigger}
      <ContextMenuContent data-testid="file-menu">
        {!isDir ? (
          <ContextMenuItem icon={AtSign} onSelect={() => insertIntoComposer(sessionId, mentionFor(rel))}>
            Mention in message
          </ContextMenuItem>
        ) : null}
        <ContextMenuItem icon={Copy} onSelect={() => void copyToClipboard(abs, 'Path')}>
          Copy path
        </ContextMenuItem>
        <ContextMenuItem icon={Copy} onSelect={() => void copyToClipboard(rel, 'Relative path')}>
          Copy relative path
        </ContextMenuItem>
        {canRevealFiles() ? (
          <>
            <ContextMenuSeparator />
            {!isDir ? (
              <ContextMenuItem icon={ExternalLink} onSelect={() => openPath(abs)}>
                Open in default app
              </ContextMenuItem>
            ) : null}
            <ContextMenuItem icon={FolderOpen} onSelect={() => showItemInFolder(abs)}>
              Reveal in Explorer
            </ContextMenuItem>
          </>
        ) : null}
      </ContextMenuContent>
    </ContextMenu>
  );
}
