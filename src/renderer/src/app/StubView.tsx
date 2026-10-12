// Placeholder used by STUB feature components until ui-chat / ui-views replace them. Owner: ui-foundation.
import type { LucideIcon } from 'lucide-react';
import { Construction } from 'lucide-react';
import { Badge } from '@renderer/components/ui/badge';
import { EmptyState } from '@renderer/components/ui/feedback';

export function StubView({ title, owner, icon = Construction, detail }: { title: string; owner: string; icon?: LucideIcon; detail?: string }) {
  return (
    <div className="flex h-full items-center justify-center">
      <EmptyState
        icon={icon}
        title={title}
        description={detail ?? `This view is being built by ${owner}.`}
        action={
          <Badge tone="warning" mono>
            stub
          </Badge>
        }
      />
    </div>
  );
}
