// className helper: clsx + a compact Tailwind conflict resolver (later classes win), so
// <Button className="h-[26px] px-2"> reliably overrides the component's own h-7 / px-2.5.
// Covers the utility groups used in this codebase (sizing, spacing, colors, borders, radius, type, layout).
// Owner: ui-foundation. Unit-tested in tests/unit/ui-foundation/cn.test.ts.
import { clsx, type ClassValue } from 'clsx';

const TEXT_SIZES = new Set(['cap', 'micro', 'meta', 'small', 'ui', 'prose', 'lead', 'title', 'display', 'xs', 'sm', 'base', 'lg', 'xl', '2xl', '3xl', '4xl', '5xl']);
const DISPLAY = new Set(['block', 'inline-block', 'inline', 'flex', 'inline-flex', 'grid', 'inline-grid', 'hidden', 'contents', 'table', 'flow-root']);
const POSITION = new Set(['static', 'fixed', 'absolute', 'relative', 'sticky']);
const FONT_FAMILY = new Set(['mono', 'sans', 'serif', 'ui']);
const BORDER_STYLE = new Set(['solid', 'dashed', 'dotted', 'double', 'none', 'hidden']);

// Ordered so longer prefixes match first.
const PREFIXES = [
  'min-w', 'max-w', 'min-h', 'max-h', 'size', 'w', 'h',
  'px', 'py', 'pt', 'pr', 'pb', 'pl', 'ps', 'pe', 'p',
  'mx', 'my', 'mt', 'mr', 'mb', 'ml', 'ms', 'me', 'm',
  'gap-x', 'gap-y', 'gap', 'space-x', 'space-y',
  'inset-x', 'inset-y', 'inset', 'top', 'right', 'bottom', 'left', 'z',
  'opacity', 'leading', 'tracking', 'shadow', 'justify', 'items', 'self', 'content', 'place-items', 'place-content',
  'grow', 'shrink', 'basis', 'order', 'overflow-x', 'overflow-y', 'overflow', 'cursor', 'whitespace', 'animate',
  'duration', 'ease', 'delay', 'transition', 'col-span', 'row-span', 'grid-cols', 'grid-rows', 'outline-offset',
  'ring-offset', 'translate-x', 'translate-y', 'scale', 'rotate', 'line-clamp', 'select', 'pointer-events', 'resize',
  'aspect', 'object', 'decoration', 'underline-offset', 'fill', 'stroke', 'accent', 'caret', 'backdrop-blur', 'blur',
] as const;

const CONFLICTS: Record<string, string[]> = {
  p: ['px', 'py', 'pt', 'pr', 'pb', 'pl', 'ps', 'pe'],
  px: ['pl', 'pr', 'ps', 'pe'],
  py: ['pt', 'pb'],
  m: ['mx', 'my', 'mt', 'mr', 'mb', 'ml', 'ms', 'me'],
  mx: ['ml', 'mr', 'ms', 'me'],
  my: ['mt', 'mb'],
  size: ['w', 'h'],
  gap: ['gap-x', 'gap-y'],
  overflow: ['overflow-x', 'overflow-y'],
  inset: ['inset-x', 'inset-y', 'top', 'right', 'bottom', 'left'],
  'inset-x': ['left', 'right'],
  'inset-y': ['top', 'bottom'],
  rounded: ['rounded-t', 'rounded-b', 'rounded-l', 'rounded-r', 'rounded-tl', 'rounded-tr', 'rounded-bl', 'rounded-br', 'rounded-s', 'rounded-e'],
  'border-w': ['border-w-t', 'border-w-b', 'border-w-l', 'border-w-r', 'border-w-x', 'border-w-y'],
  'border-w-x': ['border-w-l', 'border-w-r'],
  'border-w-y': ['border-w-t', 'border-w-b'],
};

/** Split "hover:data-[x=y]:bg-red" into ["hover:data-[x=y]:", "bg-red"] (colons inside [] are ignored). */
function splitVariants(cls: string): [string, string] {
  let depth = 0;
  let last = -1;
  for (let i = 0; i < cls.length; i++) {
    const ch = cls[i];
    if (ch === '[' || ch === '(') depth++;
    else if (ch === ']' || ch === ')') depth--;
    else if (ch === ':' && depth === 0) last = i;
  }
  return last < 0 ? ['', cls] : [cls.slice(0, last + 1), cls.slice(last + 1)];
}

function isLengthArbitrary(v: string): boolean {
  return /^\[(\d|\.|length:|calc\(|var\(--[\w-]*(size|w|h|gap)\b)/.test(v);
}

/** Conflict group of a single (variant-free) utility, or null when unknown. */
export function utilityGroup(base: string): string | null {
  let u = base.replace(/^!/, '').replace(/!$/, '');
  if (u.startsWith('-')) u = u.slice(1);
  if (DISPLAY.has(u)) return 'display';
  if (POSITION.has(u)) return 'position';
  if (u === 'truncate') return null;
  if (u.startsWith('text-')) {
    const v = u.slice(5);
    if (v === 'left' || v === 'center' || v === 'right' || v === 'justify' || v === 'start' || v === 'end') return 'text-align';
    if (TEXT_SIZES.has(v) || isLengthArbitrary(v)) return 'text-size';
    return 'text-color';
  }
  if (u.startsWith('bg-')) {
    const v = u.slice(3);
    if (/^(clip|origin|repeat|no-repeat|fixed|local|scroll|cover|contain|center|top|bottom|left|right|blend)/.test(v)) return `bg-${v.split('-')[0]}`;
    return 'bg';
  }
  if (u === 'border' || u.startsWith('border-')) {
    if (u === 'border') return 'border-w';
    const v = u.slice(7);
    const side = /^(t|b|l|r|x|y|s|e)(-|$)/.exec(v);
    if (side) {
      const rest = v.slice(side[1].length + 1);
      if (rest === '' || /^\d+$/.test(rest) || isLengthArbitrary(rest)) return `border-w-${side[1]}`;
      return `border-color-${side[1]}`;
    }
    if (/^\d+$/.test(v) || isLengthArbitrary(v)) return 'border-w';
    if (BORDER_STYLE.has(v)) return 'border-style';
    if (v === 'collapse' || v === 'separate') return 'border-collapse';
    return 'border-color';
  }
  if (u === 'rounded' || u.startsWith('rounded-')) {
    const side = /^rounded-(tl|tr|bl|br|t|b|l|r|s|e)(-|$)/.exec(u);
    return side ? `rounded-${side[1]}` : 'rounded';
  }
  if (u.startsWith('font-')) {
    const v = u.slice(5);
    return FONT_FAMILY.has(v) ? 'font-family' : 'font-weight';
  }
  if (u === 'flex-row' || u === 'flex-col' || u === 'flex-row-reverse' || u === 'flex-col-reverse') return 'flex-dir';
  if (u === 'flex-wrap' || u === 'flex-nowrap' || u === 'flex-wrap-reverse') return 'flex-wrap';
  if (u.startsWith('flex-')) return 'flex';
  if (u === 'grow' || u === 'shrink') return u;
  if (u === 'outline' || u === 'outline-none' || u === 'outline-hidden' || /^outline-(\d|\[)/.test(u)) return 'outline-w';
  if (u.startsWith('outline-') && !u.startsWith('outline-offset')) return 'outline-color';
  if (u === 'ring' || /^ring-(\d|\[\d)/.test(u)) return 'ring-w';
  if (u.startsWith('ring-') && !u.startsWith('ring-offset')) return 'ring-color';
  if (u === 'shadow' || u.startsWith('shadow-')) return 'shadow';
  if (u === 'italic' || u === 'not-italic') return 'font-style';
  if (u === 'uppercase' || u === 'lowercase' || u === 'capitalize' || u === 'normal-case') return 'text-transform';
  for (const p of PREFIXES) {
    if (u === p || u.startsWith(`${p}-`)) return p;
  }
  return null;
}

/** Remove conflicting Tailwind utilities, keeping the LAST one per group (per variant chain). */
export function mergeClasses(str: string): string {
  const classes = str.split(/\s+/).filter(Boolean);
  const out: (string | null)[] = [];
  const seen = new Map<string, number>();
  for (const c of classes) {
    const [variants, base] = splitVariants(c);
    const group = utilityGroup(base);
    if (group) {
      const key = `${variants}|${group}`;
      const prev = seen.get(key);
      if (prev !== undefined) out[prev] = null;
      for (const sub of CONFLICTS[group] ?? []) {
        const k = `${variants}|${sub}`;
        const i = seen.get(k);
        if (i !== undefined) {
          out[i] = null;
          seen.delete(k);
        }
      }
      seen.set(key, out.length);
    }
    out.push(c);
  }
  return out.filter((x): x is string => x !== null).join(' ');
}

export function cn(...inputs: ClassValue[]): string {
  return mergeClasses(clsx(inputs));
}
