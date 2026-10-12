// Dialog (Radix) + ConfirmDialog. Owner: ui-foundation.
import * as RD from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { cn } from '@renderer/lib/cn';
import { Button } from './button';

export const Dialog = RD.Root;
export const DialogTrigger = RD.Trigger;
export const DialogClose = RD.Close;

const SIZES = { sm: 'w-[420px]', md: 'w-[540px]', lg: 'w-[720px]', xl: 'w-[920px]' } as const;

export interface DialogContentProps {
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  /** Footer actions (right-aligned). */
  footer?: ReactNode;
  size?: keyof typeof SIZES;
  className?: string;
  bodyClassName?: string;
  /** Hide the X button. */
  hideClose?: boolean;
  onOpenAutoFocus?: (e: Event) => void;
}

export function DialogContent({ title, description, children, footer, size = 'md', className, bodyClassName, hideClose, onOpenAutoFocus }: DialogContentProps) {
  return (
    <RD.Portal>
      <RD.Overlay className="fixed inset-0 z-[80] bg-[rgba(4,8,10,0.62)] backdrop-blur-[2px] animate-ob-fade-in" />
      <RD.Content
        onOpenAutoFocus={onOpenAutoFocus}
        className={cn(
          'fixed left-1/2 top-[12vh] z-[81] flex max-h-[76vh] max-w-[calc(100vw-32px)] -translate-x-1/2 flex-col',
          'rounded-[12px] border border-ob-border bg-ob-surface-1 shadow-pop animate-ob-pop-in focus-visible:outline-none',
          SIZES[size],
          className,
        )}
      >
        <div className="flex items-start justify-between gap-4 px-5 pb-1 pt-4">
          <div className="flex min-w-0 flex-col gap-1">
            <RD.Title className="text-[15px] font-semibold leading-6 text-ob-text">{title}</RD.Title>
            {description ? (
              <RD.Description className="text-ui text-ob-text-3">{description}</RD.Description>
            ) : (
              <RD.Description className="sr-only">{typeof title === 'string' ? title : 'Dialog'}</RD.Description>
            )}
          </div>
          {!hideClose ? (
            <RD.Close
              aria-label="Close"
              className="ob-transition -mr-1.5 -mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-ctl text-ob-text-3 hover:bg-ob-hover hover:text-ob-text"
            >
              <X size={16} aria-hidden />
            </RD.Close>
          ) : null}
        </div>
        {children ? <div className={cn('min-h-0 flex-1 overflow-y-auto px-5 py-3', bodyClassName)}>{children}</div> : null}
        {footer ? <div className="flex items-center justify-end gap-2 border-t border-ob-border px-5 py-3">{footer}</div> : null}
      </RD.Content>
    </RD.Portal>
  );
}

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void | Promise<unknown>;
}

export function ConfirmDialog({ open, onOpenChange, title, description, children, confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger, onConfirm }: ConfirmDialogProps) {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        size="sm"
        title={title}
        description={description}
        footer={
          <>
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              {cancelLabel}
            </Button>
            <Button
              variant={danger ? 'danger-solid' : 'primary'}
              loading={busy}
              autoFocus
              onClick={async () => {
                setBusy(true);
                try {
                  await onConfirm();
                  onOpenChange(false);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {confirmLabel}
            </Button>
          </>
        }
      >
        {children}
      </DialogContent>
    </Dialog>
  );
}
