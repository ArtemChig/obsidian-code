// Popover (Radix). M13 floating surface: --s0 + 1 px --line + separation shadow (ob-popover). Owner: ui-foundation.
import * as RP from '@radix-ui/react-popover';
import type { ComponentProps } from 'react';
import { cn } from '@renderer/lib/cn';

export const Popover = RP.Root;
export const PopoverTrigger = RP.Trigger;
export const PopoverAnchor = RP.Anchor;
export const PopoverClose = RP.Close;

export function PopoverContent({ className, sideOffset = 6, align = 'center', ...rest }: ComponentProps<typeof RP.Content>) {
  return (
    <RP.Portal>
      <RP.Content
        sideOffset={sideOffset}
        align={align}
        collisionPadding={8}
        className={cn('ob-popover z-[90] p-3 text-[12px] text-t2 animate-ob-pop-in focus-visible:outline-none', className)}
        {...rest}
      />
    </RP.Portal>
  );
}
