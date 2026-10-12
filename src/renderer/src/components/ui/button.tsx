// Button + IconButton (M13 recipes: reference .btn / .tbi). Owner: ui-foundation.
import type { ComponentProps, ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@renderer/lib/cn';
import { Spinner } from './feedback';
import { Tooltip } from './tooltip';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'danger-solid';
export type ButtonSize = 'sm' | 'md' | 'lg';

// primary = solid cold-white fill + black text · secondary = 1 px --line outline · ghost = text only ·
// danger = --err outline + text · danger-solid = --err fill (destructive confirms only).
const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'border border-transparent bg-acc font-semibold text-acc-ink hover:bg-acc-hi active:bg-acc-press',
  secondary: 'border border-line font-medium text-t2 hover:bg-hov hover:text-t1 active:bg-press',
  ghost: 'border border-transparent font-medium text-t2 hover:bg-hov hover:text-t1 active:bg-press',
  danger: 'border border-err font-medium text-err hover:bg-err-wash active:bg-err-wash2',
  'danger-solid': 'border border-transparent bg-err font-semibold text-black hover:bg-err-hi active:bg-err-press',
};

const SIZES: Record<ButtonSize, string> = {
  sm: 'h-6 gap-1.5 px-2.5 text-[11px]',
  md: 'h-7 gap-[7px] px-[13px] text-[11.5px]',
  lg: 'h-8 gap-2 px-4 text-[12px]',
};

const ICON_SIZES: Record<ButtonSize, number> = { sm: 11, md: 12, lg: 13 };

export interface ButtonProps extends ComponentProps<'button'> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  /** Lucide icon component or any node, shown before the label. */
  icon?: LucideIcon | ReactNode;
  /** Shown after the label. */
  iconRight?: LucideIcon | ReactNode;
  fullWidth?: boolean;
}

function renderIcon(icon: LucideIcon | ReactNode | undefined, size: number): ReactNode {
  if (!icon) return null;
  if (typeof icon === 'function' || (typeof icon === 'object' && icon !== null && '$$typeof' in icon && 'render' in (icon as object))) {
    const Icon = icon as LucideIcon;
    return <Icon size={size} aria-hidden />;
  }
  return icon as ReactNode;
}

export function Button({
  variant = 'secondary',
  size = 'md',
  loading,
  icon,
  iconRight,
  fullWidth,
  className,
  children,
  disabled,
  type = 'button',
  ...rest
}: ButtonProps) {
  const iconSize = ICON_SIZES[size];
  return (
    <button
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(
        'ob-transition relative inline-flex shrink-0 select-none items-center justify-center whitespace-nowrap rounded-[2px] tracking-[-0.008em]',
        'disabled:pointer-events-none disabled:opacity-40',
        VARIANTS[variant],
        SIZES[size],
        fullWidth && 'w-full',
        className,
      )}
      {...rest}
    >
      {loading ? <Spinner size={iconSize} /> : renderIcon(icon, iconSize)}
      {children}
      {renderIcon(iconRight, iconSize)}
    </button>
  );
}

export type IconButtonSize = 'xs' | 'sm' | 'md' | 'lg';

const ICON_BTN_SIZES: Record<IconButtonSize, string> = {
  xs: 'size-5',
  sm: 'size-6',
  md: 'size-7',
  lg: 'size-8',
};
const ICON_BTN_ICON: Record<IconButtonSize, number> = { xs: 12, sm: 14, md: 15, lg: 16 };

export interface IconButtonProps extends Omit<ComponentProps<'button'>, 'children'> {
  /** Required: used as aria-label and tooltip text. */
  label: string;
  icon: LucideIcon | ReactNode;
  size?: IconButtonSize;
  variant?: 'ghost' | 'secondary' | 'danger' | 'primary';
  /** Toggled-on look (lit: --t1 icon on an acc-wash with a hairline frame). */
  active?: boolean;
  shortcut?: string;
  tooltipSide?: 'top' | 'right' | 'bottom' | 'left';
  /** Hide the tooltip (aria-label is kept). */
  noTooltip?: boolean;
  loading?: boolean;
}

const ICON_BTN_VARIANTS: Record<NonNullable<IconButtonProps['variant']>, string> = {
  ghost: 'text-t3 hover:bg-hov hover:text-t1 active:bg-press',
  secondary: 'border border-line text-t2 hover:bg-hov hover:text-t1',
  danger: 'text-t3 hover:bg-err-wash hover:text-err',
  primary: 'bg-acc text-acc-ink hover:bg-white',
};

export function IconButton({
  label,
  icon,
  size = 'md',
  variant = 'ghost',
  active,
  shortcut,
  tooltipSide = 'top',
  noTooltip,
  loading,
  className,
  type = 'button',
  disabled,
  ...rest
}: IconButtonProps) {
  const btn = (
    <button
      type={type}
      aria-label={label}
      aria-pressed={active === undefined ? undefined : active}
      disabled={disabled || loading}
      className={cn(
        'ob-transition inline-flex shrink-0 select-none items-center justify-center rounded-[2px]',
        'disabled:pointer-events-none disabled:opacity-40',
        ICON_BTN_SIZES[size],
        ICON_BTN_VARIANTS[variant],
        active && 'bg-acc-wash text-t1 shadow-[inset_0_0_0_1px_var(--rule)] hover:bg-acc-wash hover:text-t1',
        className,
      )}
      {...rest}
    >
      {loading ? <Spinner size={ICON_BTN_ICON[size] - 2} /> : renderIcon(icon, ICON_BTN_ICON[size])}
    </button>
  );
  if (noTooltip) return btn;
  return (
    <Tooltip content={label} shortcut={shortcut} side={tooltipSide}>
      {btn}
    </Tooltip>
  );
}
