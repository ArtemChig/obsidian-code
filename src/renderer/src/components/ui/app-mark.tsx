// App mark (M13 brand): a rotated square — a diamond — in the cold-white accent. Owner: ui-foundation.
import { cn } from '@renderer/lib/cn';

/** `size` is the bounding box in px; the diamond is a square of size/√2 rotated 45°. */
export function AppMark({ size = 12, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" aria-hidden className={cn('shrink-0', className)}>
      <path d="M6 0.4 11.6 6 6 11.6 0.4 6Z" fill="var(--acc)" />
    </svg>
  );
}
