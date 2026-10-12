// Keyboard key caps. Owner: ui-foundation.
import type { ReactNode } from 'react';
import { cn } from '@renderer/lib/cn';

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        'inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-[4px] border border-ob-border bg-ob-surface-2 px-1',
        'font-mono text-[10.5px] font-medium leading-none text-ob-text-2 shadow-[inset_0_-1px_0_rgba(0,0,0,0.35)]',
        className,
      )}
    >
      {children}
    </kbd>
  );
}

const KEY_LABELS: Record<string, string> = {
  ctrl: 'Ctrl',
  control: 'Ctrl',
  shift: 'Shift',
  alt: 'Alt',
  meta: 'Win',
  cmd: 'Ctrl',
  mod: 'Ctrl',
  enter: '↵',
  return: '↵',
  esc: 'Esc',
  escape: 'Esc',
  up: '↑',
  down: '↓',
  left: '←',
  right: '→',
  tab: 'Tab',
  backspace: '⌫',
  space: 'Space',
};

/** Splits "Ctrl+Shift+K" into key caps. */
export function Shortcut({ keys, className }: { keys: string; className?: string }) {
  const parts = keys.split('+').map((k) => KEY_LABELS[k.trim().toLowerCase()] ?? (k.trim().length === 1 ? k.trim().toUpperCase() : k.trim()));
  return (
    <span className={cn('inline-flex items-center gap-0.5', className)}>
      {parts.map((p, i) => (
        <Kbd key={i}>{p}</Kbd>
      ))}
    </span>
  );
}
