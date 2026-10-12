// Keyboard key caps (M13: reference .key — mono 9.5 px in a 1 px --line box on --s3). Owner: ui-foundation.
import type { ReactNode } from 'react';
import { cn } from '@renderer/lib/cn';

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        'inline-flex h-[17px] min-w-[17px] items-center justify-center rounded-[2px] border border-line bg-s3 px-[5px]',
        'font-mono text-[9.5px] font-normal leading-none tracking-[0.04em] text-t1',
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

/** "Ctrl+Shift+K" → ["Ctrl", "Shift", "K"]. */
export function shortcutParts(keys: string): string[] {
  return keys.split('+').map((k) => KEY_LABELS[k.trim().toLowerCase()] ?? (k.trim().length === 1 ? k.trim().toUpperCase() : k.trim()));
}

/** Splits "Ctrl+Shift+K" into key caps. `plain` renders quiet mono text instead (menus, tooltips). */
export function Shortcut({ keys, className, plain }: { keys: string; className?: string; plain?: boolean }) {
  const parts = shortcutParts(keys);
  if (plain) {
    return <span className={cn('whitespace-nowrap font-mono text-[9.5px] tracking-[0.04em] text-t3', className)}>{parts.join(' ')}</span>;
  }
  return (
    <span className={cn('inline-flex items-center gap-[3px]', className)}>
      {parts.map((p, i) => (
        <Kbd key={i}>{p}</Kbd>
      ))}
    </span>
  );
}
