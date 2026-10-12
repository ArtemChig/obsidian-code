// App mark: a faceted obsidian shard with an ice-blue → violet sheen. Owner: ui-foundation.
import { useId } from 'react';
import { cn } from '@renderer/lib/cn';

export function AppMark({ size = 18, className }: { size?: number; className?: string }) {
  const id = useId().replace(/:/g, '');
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden className={cn('shrink-0', className)}>
      <defs>
        <linearGradient id={`${id}-a`} x1="5" y1="3" x2="13" y2="13" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#C9DDF0" />
          <stop offset="1" stopColor="#8FB8DE" />
        </linearGradient>
        <linearGradient id={`${id}-b`} x1="19" y1="4" x2="11" y2="13" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#CFC6F2" />
          <stop offset="1" stopColor="#9384D6" />
        </linearGradient>
        <linearGradient id={`${id}-c`} x1="8" y1="10" x2="12" y2="22" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#4F7392" />
          <stop offset="1" stopColor="#24384A" />
        </linearGradient>
        <linearGradient id={`${id}-d`} x1="18" y1="10" x2="14" y2="22" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#6A5FA6" />
          <stop offset="1" stopColor="#2F2C55" />
        </linearGradient>
      </defs>
      <path d="M12.2 1.8 4.6 8.4l6.9 3.4z" fill={`url(#${id}-a)`} />
      <path d="m12.2 1.8 7.3 6.6-8 3.4z" fill={`url(#${id}-b)`} />
      <path d="m4.6 8.4 2.8 13.2 4.1-9.8z" fill={`url(#${id}-c)`} />
      <path d="m19.5 8.4-2.8 13.2-5.2-9.8z" fill={`url(#${id}-d)`} />
      <path d="m7.4 21.6 4.1-9.8 5.2 9.8z" fill="#1B2A36" />
      <path d="M12.2 1.8 4.6 8.4l2.8 13.2h9.3l2.8-13.2z" fill="none" stroke="rgba(236,240,241,0.18)" strokeWidth="0.6" strokeLinejoin="round" />
    </svg>
  );
}
