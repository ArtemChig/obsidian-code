// "Open" / "Reveal in Explorer" buttons for a file the agent touched (Changes panel rows, Read/Edit/Write cards).
// Electron only (preload openPath / showItemInFolder); renders nothing in browser mode. Owner: ui-chat.
import { ExternalLink, FolderOpen } from 'lucide-react';
import { IconButton } from '@renderer/components/ui/button';
import { canRevealFiles, openPath, showItemInFolder } from '@renderer/lib/bridge';
import { cn } from '@renderer/lib/cn';
import { absolutePath } from '../lib/session';

export function FileActions({ path, cwd, className }: { path: string; cwd: string; className?: string }) {
  if (!path || !canRevealFiles()) return null;
  const abs = absolutePath(path, cwd);
  return (
    <span className={cn('flex shrink-0 items-center', className)} data-testid="file-actions">
      <IconButton label="Open in default app" icon={ExternalLink} size="xs" onClick={() => openPath(abs)} />
      <IconButton label="Reveal in Explorer" icon={FolderOpen} size="xs" onClick={() => showItemInFolder(abs)} />
    </span>
  );
}
