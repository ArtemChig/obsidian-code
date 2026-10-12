import { describe, expect, it } from 'vitest';
import { cn, utilityGroup } from '@renderer/lib/cn';

describe('cn (clsx + tailwind conflict resolution)', () => {
  it('keeps the last utility of a group', () => {
    expect(cn('h-7 px-2.5 text-ui', 'h-[26px] px-2')).toBe('text-ui h-[26px] px-2');
    expect(cn('text-ob-text-3', 'text-ob-accent')).toBe('text-ob-accent');
    expect(cn('bg-ob-surface-2', false, 'bg-ob-accent-soft')).toBe('bg-ob-accent-soft');
  });

  it('separates text size from text color and border width from color', () => {
    expect(cn('text-meta text-ob-text-2', 'text-[10px]')).toBe('text-ob-text-2 text-[10px]');
    expect(cn('border border-ob-border', 'border-[rgba(240,113,120,0.6)]')).toBe('border border-[rgba(240,113,120,0.6)]');
    expect(cn('border-b-2 border-transparent', 'border-ob-accent')).toBe('border-b-2 border-ob-accent');
  });

  it('respects variants independently', () => {
    expect(cn('hover:bg-ob-hover bg-ob-bg', 'hover:bg-ob-accent-soft')).toBe('bg-ob-bg hover:bg-ob-accent-soft');
    expect(cn('data-[state=open]:bg-a', 'bg-b')).toBe('data-[state=open]:bg-a bg-b');
  });

  it('handles shorthand conflicts', () => {
    expect(cn('px-2 py-1', 'p-3')).toBe('p-3');
    expect(cn('w-4 h-4', 'size-6')).toBe('size-6');
    expect(cn('overflow-y-auto', 'overflow-hidden')).toBe('overflow-hidden');
  });

  it('leaves unknown/custom classes alone', () => {
    expect(cn('ob-transition group ob-section-label')).toBe('ob-transition group ob-section-label');
    expect(utilityGroup('font-mono')).toBe('font-family');
    expect(utilityGroup('font-medium')).toBe('font-weight');
    expect(utilityGroup('flex')).toBe('display');
    expect(utilityGroup('flex-1')).toBe('flex');
    expect(utilityGroup('flex-col')).toBe('flex-dir');
    expect(utilityGroup('-mb-px')).toBe('mb');
    expect(utilityGroup('outline-offset-1')).toBe('outline-offset');
    expect(utilityGroup('text-[#abc]')).toBe('text-color');
    expect(utilityGroup('text-[10.5px]')).toBe('text-size');
  });
});
